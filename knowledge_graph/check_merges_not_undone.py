"""
PrintMasterAI — regression guard: a re-ingest must not undo a recorded merge.

WHY THIS EXISTS. A source with no catalogue citation keys its ConceptualWork on its own
object id — `build_conceptual_work_id`'s fallback — so every accession is its own work. That
is deliberate and correct: without an exact citation there is nothing to join impressions on,
and joining them on title alone is the fuzzy identity matching `catalogue_matching` exists to
forbid.

The defect was that re-ingest ignored decisions already taken. Merging DETACH DELETEs the
folded node, so the next load MERGEd its id straight back into existence as a fresh
ConceptualWork and the work was split again. 4,226 merges made on 2026-09-12/13 across six
rules would have been undone by one re-run of navigart_ingest or tate_ingest, silently and
with a clean exit.

The fix is `catalogue_matching.resolve_merged_work_cypher`, spliced into every ingest that
MERGEs a ConceptualWork. It is an EXACT id lookup against `MergeEvent.mergedFromId` — a
decision some rule, model or person already made and recorded — so it does not weaken the
prohibition on similarity matching in any way. It resolves chains for free, because
`merge_duplicate_work_clusters.py` re-points a chained event's MERGED_INTO onto the final
survivor.

Run after any change to an ingest that writes ConceptualWork:

    python3 check_merges_not_undone.py            # exits 1 on regression
    python3 check_merges_not_undone.py --no-db    # source checks only

Two layers, cheapest first:
  1. Every script that MERGEs a ConceptualWork routes through the resolver.
  2. If the graph is reachable: no live ConceptualWork carries an id that a MergeEvent says
     was folded away, and the index the resolver depends on is ONLINE.
"""

import argparse
import os
import re
import sys

MERGE_RE = re.compile(r"MERGE\s*\(\s*\w*\s*:ConceptualWork\s*\{")

# Written by the merger itself, and by the tools that repair or report on merges. These are
# allowed to MERGE a ConceptualWork directly: the merger creates the survivor it is folding
# onto, and a resolver call there would be circular.
EXEMPT = {"merge_duplicate_work_clusters.py"}


def check_sources(root):
    bad = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".py") or name in EXEMPT or name == os.path.basename(__file__):
            continue
        path = os.path.join(root, name)
        try:
            text = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        if not MERGE_RE.search(text):
            continue
        if "resolve_merged_work_cypher" not in text:
            bad.append(f"{name}: MERGEs a ConceptualWork without resolve_merged_work_cypher — "
                       f"a re-run will recreate nodes that were merged away")
    return bad


def check_graph():
    from neo4j import GraphDatabase
    missing = [v for v in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE")
               if not os.environ.get(v)]
    if missing:
        return [f"cannot check the graph: {', '.join(missing)} not set"]
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    bad = []
    try:
        with driver.session(database=os.environ["NEO4J_DATABASE"]) as s:
            undone = s.run("""
                MATCH (m:MergeEvent)
                WHERE EXISTS { MATCH (w:ConceptualWork {id: m.mergedFromId}) }
                RETURN count(m) AS n, collect(m.mergedFromId)[0..5] AS sample""").single()
            if undone["n"]:
                bad.append(f"{undone['n']} merge(s) have been UNDONE — a ConceptualWork exists "
                           f"at an id MergeEvent records as folded away, e.g. "
                           f"{', '.join(undone['sample'])}")
            idx = [r for r in s.run("SHOW INDEXES").data()
                   if "MergeEvent" in (r.get("labelsOrTypes") or [])
                   and "mergedFromId" in (r.get("properties") or [])]
            if not idx:
                bad.append("no index on MergeEvent.mergedFromId — the resolver falls back to a "
                           "full label scan on EVERY ingest row")
            elif idx[0]["state"] != "ONLINE":
                bad.append(f"index {idx[0]['name']} is {idx[0]['state']}, not ONLINE")
    finally:
        driver.close()
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--no-db", action="store_true")
    a = ap.parse_args()
    root = os.path.dirname(os.path.abspath(__file__))

    failures = check_sources(root)
    print(f"{'FAIL' if failures else 'ok  '}  every ConceptualWork MERGE routes through the resolver")

    if a.no_db:
        print("skip  live graph (--no-db)")
    else:
        bad = check_graph()
        print(f"{'FAIL' if bad else 'ok  '}  live graph: no merge undone, resolver index online")
        failures += bad

    if failures:
        print("\n" + "\n".join(failures))
        print(f"\n{len(failures)} problem(s)")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
