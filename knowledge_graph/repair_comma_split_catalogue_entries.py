"""
PrintMasterAI — repair CatalogueRaisonne nodes whose prefix swallowed a second citation.
Version: COMMA-REPAIR-1.0

`catalogue_matching.parse_catalogue_refs` split on ";" only until 2026-09-11, so a source
separating citations with a COMMA ("Bloch 182, Baer 340") produced a CatalogueRaisonne
named "Bloch 182, Baer" with a CatalogueEntry numbered "340" — one mangled node where
there should be two clean ones. ~20 such nodes exist, all from Bonhams.

The parser is fixed, but re-running the three auction ingests does NOT repair these: the
inputs that produced them are not reproducible from the current Bonhams file (checked —
the 107 distinct catalogueRefText values extractable from it today contain none of the
malformed strings). So the damaged nodes are repaired directly here instead.

This is not cosmetic. A malformed entry BLOCKS REAL MERGES, measured: Bonhams' *Portrait
de Vollard III* carries the entry "Bloch 233, Baer"/"619" instead of a clean "Baer-619",
so it never joins the Picasso-Paris work that holds "Baer-619" — a join
find_museum_anchored_work_clusters.py would otherwise propose.

METHOD, and why it is safe

For each CatalogueEntry, the original source string is reconstructed as
`prefix + " " + number` and re-parsed through the NEW parser. A node is only touched when
that yields MORE THAN ONE genuine ref — i.e. the new parser positively disagrees with what
is stored. Everything else is left alone, so a legitimate multi-author prefix
("Cramer, Grant & Mitchinson 1973", 75 entries) is never reconstructed into something else:
re-parsing "Cramer, Grant & Mitchinson 1973 45" returns a single ref, so it is skipped.

Edges are re-pointed, never recreated from assumption: every `(:CatalogueEntry)-[:DOCUMENTS]->`
target of the malformed entry is attached to each replacement entry. The malformed entry
and its CatalogueRaisonne are deleted only once nothing points at them.

Usage:
    python3 repair_comma_split_catalogue_entries.py                 # dry run (default)
    python3 repair_comma_split_catalogue_entries.py --apply --backup repair.json
"""

import argparse
import json
import os

from neo4j import GraphDatabase

from catalogue_matching import parse_catalogue_refs, genuine_refs


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source knowledge_graph/.env first.")
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

# Batched rather than one transaction — the whole-set write is long enough that a single
# transaction is hard to observe and hard to interrupt safely.
CHUNK_SIZE = 50

SCAN_QUERY = """
MATCH (cr:CatalogueRaisonne)-[:CONTAINS]->(ce:CatalogueEntry)
WHERE cr.numberingPrefix CONTAINS ','
OPTIONAL MATCH (ce)-[:DOCUMENTS]->(t)
RETURN cr.numberingPrefix AS prefix, ce.id AS entryId, ce.number AS number,
       collect(DISTINCT {id: t.id, labels: labels(t)}) AS targets
"""

# The targets are reached by TRAVERSING from the bad entry, not by re-matching them on
# id. An earlier version did `UNWIND row.targetIds AS tid MATCH (t {id: tid})`, which is
# unlabelled — so none of this graph's three id indexes applies and each lookup becomes a
# full node scan. Across 697 rows that ran past 10 minutes without committing and had to
# be killed. Same trap the ACKG migration hit: a property index is silently unused unless
# the MATCH carries the label. Traversing sidesteps the question entirely, since `bad` is
# already bound through catalogueentry_id.
REPAIR_QUERY = """
UNWIND $rows AS row
MATCH (bad:CatalogueEntry {id: row.entryId})
OPTIONAL MATCH (badCr:CatalogueRaisonne {numberingPrefix: row.oldPrefix})
WITH row, bad, badCr, [(bad)-[:DOCUMENTS]->(x) | x] AS targets
UNWIND row.refs AS ref
MERGE (cr:CatalogueRaisonne {numberingPrefix: ref.catalogueName})
MERGE (ce:CatalogueEntry {id: ref.catalogueName + "-" + ref.entryNumber})
SET ce.number = ref.entryNumber
MERGE (cr)-[:CONTAINS]->(ce)
WITH bad, badCr, targets, ce
UNWIND targets AS t
MERGE (ce)-[:DOCUMENTS]->(t)
WITH DISTINCT bad, badCr
DETACH DELETE bad
WITH DISTINCT badCr
WHERE badCr IS NOT NULL AND NOT (badCr)-[:CONTAINS]->(:CatalogueEntry)
DELETE badCr
"""


def plan(session):
    rows = [dict(r) for r in session.run(SCAN_QUERY)]
    out = []
    for r in rows:
        reconstructed = f"{r['prefix']} {r['number']}".strip()
        refs = genuine_refs(parse_catalogue_refs(reconstructed))
        if len(refs) > 1:
            out.append({
                "entryId": r["entryId"],
                "oldPrefix": r["prefix"],
                "reconstructed": reconstructed,
                "refs": refs,
                "targetIds": [t["id"] for t in r["targets"] if t and t.get("id")],
                "targets": r["targets"],
            })
    return rows, out


def main(apply_changes=False, backup_path=None):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            scanned, plans = plan(session)
            print(f"scanned {len(scanned)} CatalogueEntry node(s) under a comma-bearing prefix")
            print(f"{len(plans)} need repair (the new parser yields >1 genuine ref)\n")
            for p in plans:
                new = " + ".join(f"{r['catalogueName']}-{r['entryNumber']}" for r in p["refs"])
                print(f"  {p['reconstructed'][:52]:52s}")
                print(f"      {p['entryId']}  ->  {new}   ({len(p['targetIds'])} target(s))")

            if backup_path:
                json.dump({"scannedCount": len(scanned), "plans": plans},
                          open(backup_path, "w"), indent=1, ensure_ascii=False)
                print(f"\nPlan saved to {backup_path}")

            if not apply_changes:
                print("\nDry run — nothing written. Re-run with --apply to repair.")
                return plans

            payload = [{k: p[k] for k in ("entryId", "oldPrefix", "refs")} for p in plans]
            done = 0
            for start in range(0, len(payload), CHUNK_SIZE):
                session.run(REPAIR_QUERY, rows=payload[start:start + CHUNK_SIZE]).consume()
                done += len(payload[start:start + CHUNK_SIZE])
                print(f"[PROGRESS] {done}/{len(payload)}", flush=True)
            print(f"\n[DONE] repaired {len(plans)} entry node(s)")
    finally:
        driver.close()
    return plans


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write the repair (default is a dry run)")
    parser.add_argument("--backup", help="Save the plan to this path")
    args = parser.parse_args()
    main(apply_changes=args.apply, backup_path=args.backup)
