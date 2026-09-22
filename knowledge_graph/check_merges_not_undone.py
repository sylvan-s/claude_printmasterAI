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

ARTISTS, SINCE 2026-09-22. Every ingest keys on `MERGE (a:Artist {name: ...})`, so the same
defect held for Artist nodes: a merged-away name arriving in the next load was recreated as a
fresh node. On 2026-09-22, 22 live Artists carried a name another live Artist lists as an
alias. `merge_artists.merge_pair` now writes a MergeEvent (mergedFromId = the absorbed NAME)
and the ingests resolve through `catalogue_matching.resolved_artist_name_cypher`, spliced in
with the `RESOLVED_ARTIST_NAME(...)` marker.

Two layers, cheapest first:
  1. Every script that MERGEs a ConceptualWork routes through the resolver, and every
     name-keyed Artist MERGE uses the artist marker in a file that splices it.
  2. If the graph is reachable: no live ConceptualWork or Artist sits at an id/name a
     MergeEvent says was folded away, no absorbed artist name resolves two ways, and the index
     the resolvers depend on is ONLINE.
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

# A name-keyed Artist MERGE in code, not in prose: a backtick-quoted mention in a docstring or
# comment is not a query.
ARTIST_MERGE_RE = re.compile(r"(?<!`)MERGE\s*\(\s*\w*\s*:Artist\s*\{\{?\s*name:\s*([^{}]+?)\s*\}")

# Repair tools that create an Artist by a name a PERSON chose in a reviewed plan, and then MATCH
# it by that same name: resolving it to a survivor under another name would break the rest of
# the plan. Neither runs on source data.
ARTIST_EXEMPT = {
    "fix_malformed_artist_names.py",   # ARTIST-NAME-REPAIR: ENSURE the repaired target name
    "repair_km_artist_identity.py",    # KM split: the true artist a pooled work belongs to
}


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


def check_artist_sources(root):
    bad = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".py") or name in ARTIST_EXEMPT or name == os.path.basename(__file__):
            continue
        try:
            text = open(os.path.join(root, name), encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        keys = [m.group(1) for m in ARTIST_MERGE_RE.finditer(text)]
        # `...` is prose ("keys on MERGE (artist:Artist {name: ...})" in a log message).
        raw = [k for k in keys if not k.startswith("RESOLVED_ARTIST_NAME(") and k != "..."]
        if raw:
            bad.append(f"{name}: MERGEs an Artist by name without RESOLVED_ARTIST_NAME(...) "
                       f"({', '.join(sorted(set(raw)))}) — a re-run will recreate artists that "
                       f"were merged away")
        if "RESOLVED_ARTIST_NAME(" in text and "splice_artist_resolver(" not in text:
            bad.append(f"{name}: uses RESOLVED_ARTIST_NAME(...) but never calls "
                       f"splice_artist_resolver — the marker would reach Neo4j unexpanded")
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
            art = s.run("""
                MATCH (m:MergeEvent {subject: 'Artist'})
                MATCH (live:Artist {name: m.mergedFromId})
                WHERE NOT (m)-[:MERGED_INTO]->(live)
                RETURN count(m) AS n, collect(m.mergedFromId)[0..5] AS sample""").single()
            if art["n"]:
                bad.append(f"{art['n']} artist merge(s) have been UNDONE — a live Artist carries "
                           f"a name MergeEvent records as folded into another node, e.g. "
                           f"{', '.join(art['sample'])}")
            amb = s.run("""
                MATCH (m:MergeEvent {subject: 'Artist'})-[:MERGED_INTO]->(a:Artist)
                WITH m.mergedFromId AS name, collect(DISTINCT a.name) AS targets
                WHERE size(targets) > 1
                RETURN count(*) AS n, collect(name)[0..5] AS sample""").single()
            if amb["n"]:
                bad.append(f"{amb['n']} absorbed artist name(s) resolve to more than one live "
                           f"Artist, e.g. {', '.join(amb['sample'])} — the resolver takes the "
                           f"first, so which one an ingest attaches to is arbitrary")
            orphan = s.run("""
                MATCH (m:MergeEvent {subject: 'Artist'})
                WHERE NOT (m)-[:MERGED_INTO]->(:Artist)
                RETURN count(m) AS n""").single()["n"]
            if orphan:
                bad.append(f"{orphan} Artist MergeEvent(s) point at no Artist — a fold deleted a "
                           f"survivor without carrying its events forward")
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
    art = check_artist_sources(root)
    print(f"{'FAIL' if art else 'ok  '}  every name-keyed Artist MERGE routes through the resolver")
    failures += art

    if a.no_db:
        print("skip  live graph (--no-db)")
    else:
        bad = check_graph()
        print(f"{'FAIL' if bad else 'ok  '}  live graph: no work or artist merge undone, "
              f"resolver index online")
        failures += bad

    if failures:
        print("\n" + "\n".join(failures))
        print(f"\n{len(failures)} problem(s)")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
