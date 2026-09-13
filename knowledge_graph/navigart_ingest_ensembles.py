"""
PrintMasterAI — Navigart ensembles as `Portfolio` nodes
Version: NAVIGART-ENSEMBLES-0.1

Adds the one node type doc 08 never had: the published set a print belongs to.

Navigart carries this properly structured, not as free text. Every member of a set shares
an `ensemble_id`, carries a `related` list of its siblings' artwork ids, and repeats the
set's own metadata in `recap_*` fields — `recap_title`, `recap_nature`, `recap_number`.
Across the loaded public-domain tier that is **150 ensembles over 1,355 records**, and
`recap_title` is populated on 100% of them.

They are real print suites, not a filing artefact:

    124  Album collection Cacault - Piranesi              Musée d'arts de Nantes
     79  Fêtes du 75e anniversaire de l'indépendance…     Cnap
     61  Illustration pour Notre-Dame de Paris de V. Hugo Musée d'arts de Nantes
     46  Zelt, Opus XIV, 1915                             MAMC Strasbourg   (Klinger)

## Schema addition

    (:Portfolio {id, name, nature, sourceNumber, institutionName, memberCount})
    (:Portfolio)-[:COMPRISES {plateNumber}]->(:ConceptualWork)

Recorded in `08_ackg_schema_definition.md` §9, following the precedent of §7
(`DigitalImage.embedding`) and §8 (`Period`/`Region`). `Portfolio` is a Work-layer node
like `EditionRun`, so it carries no AAT id — the controlled-vocabulary labels
(`Technique`, `Paper`, `Subject`) are the ones that do.

`COMPRISES` rather than reusing `INCLUDES`: `EditionRun -[:INCLUDES]-> Impression` already
means "this edition run contains this physical sheet", and a portfolio containing a
*work* is a different relation at a different layer. One verb, one meaning.

## Three things this does NOT flatten

1. **`nature` is carried verbatim.** The values are `Ensemble` (868), `Portfolio` (277),
   `Album factice` (124), `Recueil` (61), `Série` (23), `Diptyque` (1). An *album factice*
   is a collector's made-up album — sheets bound together after the fact by an owner, not
   published as a set. Calling that the same thing as a Klinger opus would assert a
   publication event that never happened, and the Piranesi case (124 sheets from the
   Cacault collection) is exactly one of those. The distinction is preserved rather than
   normalised away.
2. **The key is (vault, ensemble_id), never ensemble_id alone.** The ids collide across
   institutions — 142 distinct raw ids for 150 distinct ensembles in this tier.
3. **Title is not an identifier.** Vault 15 has two different ensembles both titled
   "Poèmes du Pont des Faisans" (numbers 4969 and 4970). Grouping on title would merge
   them.

## Membership, and why these portfolios are PARTIAL

Membership comes from `ensemble_id`. `related` (which includes the record itself) is the
cross-check, but the correct invariant is **containment, not equality**: every member we
hold must appear in `related`, while `related` is free to be larger. It usually is, and for
a structural reason — the cache is the public-domain-plus-image tier, so an ensemble whose
other sheets are in copyright or unillustrated arrives here with only some of its members.
The first version of this script tested equality and would have refused to build 77 of 150
ensembles on that basis, which was the check being wrong rather than the data.

That makes `memberCount` a count of what this graph holds, not of the set. **`sourceMemberCount`
records the true size from `related`**, and `complete` says whether they match. Klinger's
*Zelt, Opus XIV* arrives with 46 of its sheets; a query that reads 46 as the size of the
suite would be wrong, and now cannot be.

Members not present in the graph are skipped, not created — a handful were excluded at
ingest for an unresolved artist or a placeholder accession, and this script does not
second-guess those gates.

Usage:
    python knowledge_graph/navigart_ingest_ensembles.py --dry-run
    python knowledge_graph/navigart_ingest_ensembles.py --apply
"""

import argparse
import glob
import json
import os
import re
import time
from collections import defaultdict

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_GLOB = os.path.join(os.path.dirname(HERE), "benchmark", "data", "navigart", "*.json")

_PLATE_RE = re.compile(r"\bplanche\s+(\d+)", re.IGNORECASE)


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — see knowledge_graph/.env.example")
    return value


def _object_id(vault, inventory):
    """Must match navigart_ingest.map_record exactly — with no catalogue refs the
    ConceptualWork id IS the object id, so this is how a member is found in the graph."""
    return f"navigart{vault}-{re.sub(r'[^A-Za-z0-9.-]', '_', inventory.strip())}"


def _ensemble_key(vault, raw_id):
    number = str(raw_id).strip()
    if number.endswith(".0"):
        number = number[:-2]
    return f"navigart{vault}-ens-{number}", number


def collect():
    ensembles = defaultdict(lambda: {"members": [], "titles": set(), "natures": set(),
                                     "numbers": set(), "related": set(), "ids": set()})
    for path in sorted(glob.glob(CACHE_GLOB)):
        cache = json.load(open(path, encoding="utf-8"))
        if not isinstance(cache, dict) or "records" not in cache:
            continue
        for record in cache["records"]:
            artwork = record.get("artwork") or {}
            raw_id = artwork.get("ensemble_id")
            inventory = (artwork.get("inventory") or "").strip()
            if not raw_id or not inventory:
                continue
            key, number = _ensemble_key(cache["vault"], raw_id)
            bucket = ensembles[key]
            bucket["institution"] = cache["institution"]
            bucket["sourceNumber"] = number
            if artwork.get("recap_title"):
                bucket["titles"].add(artwork["recap_title"].strip())
            if artwork.get("recap_nature"):
                bucket["natures"].add(artwork["recap_nature"].strip())
            bucket["ids"].add(artwork.get("_id"))
            bucket["related"] |= set(artwork.get("related") or [])
            plate = _PLATE_RE.search(artwork.get("title_list") or "")
            bucket["members"].append({
                "conceptualWorkId": _object_id(cache["vault"], inventory),
                "plateNumber": int(plate.group(1)) if plate else None,
            })
    return ensembles


READ_QUERY = "MATCH (cw:ConceptualWork) WHERE cw.id IN $ids RETURN cw.id AS id"

WRITE_QUERY = """
UNWIND $rows AS row
MERGE (p:Portfolio {id: row.id})
SET p.name = row.name,
    p.nature = row.nature,
    p.sourceNumber = row.sourceNumber,
    p.institutionName = row.institution,
    p.memberCount = row.memberCount,
    p.sourceMemberCount = row.sourceMemberCount,
    p.complete = row.complete
WITH p, row
UNWIND row.members AS member
MATCH (cw:ConceptualWork {id: member.conceptualWorkId})
MERGE (p)-[r:COMPRISES]->(cw)
SET r.plateNumber = member.plateNumber
"""


def main(apply_changes):
    ensembles = collect()
    print(f"[SOURCE] {len(ensembles)} ensemble(s), "
          f"{sum(len(e['members']) for e in ensembles.values())} member record(s)", flush=True)

    driver = GraphDatabase.driver(_require_env("NEO4J_URI"),
                                  auth=(_require_env("NEO4J_USER"),
                                        _require_env("NEO4J_PASSWORD")))
    try:
        with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
            wanted = sorted({m["conceptualWorkId"] for e in ensembles.values()
                             for m in e["members"]})
            present = {r["id"] for r in session.run(READ_QUERY, ids=wanted)}
            print(f"[GRAPH]  {len(present)}/{len(wanted)} member work(s) exist "
                  f"({len(wanted) - len(present)} were excluded at ingest — not created here)",
                  flush=True)

            rows, skipped = [], defaultdict(int)
            for key, e in sorted(ensembles.items()):
                # Containment, not equality — see the module docstring. A member we hold
                # that the set does not list is a real contradiction; a member the set
                # lists that we do not hold is just the tier filter.
                if e["related"] and not e["ids"] <= e["related"]:
                    skipped["member_not_listed_in_related"] += 1
                    print(f"[SKIP] {key}: {len(e['ids'] - e['related'])} member(s) carry this "
                          f"ensemble_id but are absent from `related` — not built", flush=True)
                    continue
                members = [m for m in e["members"] if m["conceptualWorkId"] in present]
                if not members:
                    skipped["no_member_in_graph"] += 1
                    continue
                if len(e["titles"]) != 1:
                    skipped["ambiguous_title"] += 1
                    print(f"[SKIP] {key}: {len(e['titles'])} distinct recap_title values "
                          f"{sorted(e['titles'])[:2]} — not built", flush=True)
                    continue
                source_count = len(e["related"]) or len(e["ids"])
                rows.append({
                    "id": key, "name": next(iter(e["titles"])),
                    "nature": next(iter(e["natures"])) if len(e["natures"]) == 1 else None,
                    "sourceNumber": e["sourceNumber"], "institution": e["institution"],
                    "memberCount": len(members), "sourceMemberCount": source_count,
                    "complete": len(members) == source_count, "members": members,
                })

            plates = sum(1 for r in rows for m in r["members"] if m["plateNumber"])
            natures = defaultdict(int)
            for r in rows:
                natures[r["nature"]] += 1
            print(f"[ROWS]   {len(rows)} Portfolio node(s), "
                  f"{sum(r['memberCount'] for r in rows)} COMPRISES edge(s), "
                  f"{plates} with a plate number", flush=True)
            print(f"    natures: {dict(natures)}", flush=True)
            if skipped:
                print(f"    skipped: {dict(skipped)}", flush=True)
            partial = sum(1 for r in rows if not r["complete"])
            print(f"    {partial}/{len(rows)} portfolios are PARTIAL — this tier holds only "
                  f"some of the set (sourceMemberCount records the real size)", flush=True)
            for r in sorted(rows, key=lambda x: -x["memberCount"])[:8]:
                print(f"    {r['memberCount']:>4}/{r['sourceMemberCount']:<4} "
                      f"{r['nature'] or '-':<14} {r['name'][:50]}", flush=True)

            if not apply_changes:
                print("[DRY RUN] nothing written", flush=True)
                return
            start = time.time()
            for i in range(0, len(rows), 50):
                session.run(WRITE_QUERY, rows=rows[i:i + 50]).consume()
                print(f"[PROGRESS] {min(i + 50, len(rows))}/{len(rows)}", flush=True)
            print(f"[DONE] elapsed={time.time() - start:.0f}s", flush=True)
    finally:
        driver.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write to Neo4j")
    parser.add_argument("--dry-run", action="store_true", help="Report only (default)")
    args = parser.parse_args()
    if not args.apply and not args.dry_run:
        parser.error("Provide --apply or --dry-run")
    main(apply_changes=args.apply)
