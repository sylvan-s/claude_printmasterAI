"""
PrintMasterAI — merge Artist nodes that differ only by letter case
Version: CASE-DEDUP-1.1

Root cause: bonhams_ingest.py originally merged Artist by exact-string `name`, and
Bonhams' own catalogue data formats some lots' artist names in ALL CAPS (a real
house-style inconsistency in the source, confirmed live: every ALL-CAPS variant found
is attributed ONLY to Bonhams/Skinner SourceRecords, zero overlap with any pre-existing
source) — so the full Bonhams+Skinner load created a same-person duplicate node for
every artist whose name happened to appear in caps on at least one lot. 183 groups /
182 duplicate nodes were confirmed and merged live on 2026-09-06 (via the equivalent
Cypher inlined below, run directly), found while building the Bonhams catalogue
artifact and needed a fix before that artifact's own artist-revenue table could be
trusted (same precedent as forum_ingest.py's Picasso/Rembrandt identity fixes before
"The Forum Catalogue" was built — see doc 09's Bonhams section).

This is deterministic case-folding, NOT fuzzy/similarity matching — the two names are
identical except for letter case, so there is no risk of conflating two different real
people the way a fuzzy threshold could (see catalogue_matching.py's own docstring for
why this project avoids fuzzy matching elsewhere). Two groups found by the same
case-insensitive scan ("no lot"/"NO LOT", "amendment: please note"/its 3 case variants)
are NOT artist case-duplicates at all — they're Roseberys auction-admin notes
miscaptured into the `artist` field, the same failure mode as the already-documented
2026-08-31 "No lot"/"PLEASE NOTE" junk cleanup, just a different exact string. Excluded
from this script's scope via `SKIP_GROUPS` — a separate, pre-existing issue, not
Bonhams-caused, not fixed here.

No APOC on this self-hosted Neo4j CE instance (see project_ackg_oracle_migration
memory) — merges are done via plain MATCH/MERGE/DETACH DELETE per relationship type,
same pattern as the manual Sidney Nolan/Henry Moore/Joan Miro post-migration cleanups.
`MERGE` (not plain relationship creation) is used for every redirected edge because the
same double-attribution overcounting pattern already seen in those cleanups recurs here
too (a SourceRecord/ConceptualWork already attributed to both the canonical and the
duplicate node) — confirmed via the created-vs-deleted relationship-count delta the
live run returned, not assumed absent.

Canonical choice per case-insensitive name group: highest score wins, where
score = 1,000,000 if ulanUrl set, plus 100,000 if wikidataUrl set, plus 10x CREATED-work
count, plus 1 if the name is not ALL CAPS. Ties keep whichever node Neo4j's own
(unspecified) node-scan order returns first — harmless, since every candidate in a
group is by definition the same real person.

CASE-DEDUP-1.1 (2026-09-22): the fold is `merge_artists.merge_pair`, not the inlined Cypher
this file used to carry. That query moved three of the six Artist relationship types, dropped
ATTRIBUTED_TO.qualifier, and left no MergeEvent, so the ingests' merged-name resolver could not
stop the next Bonhams load recreating the ALL-CAPS node it had just removed.

Usage:
    python3 merge_case_duplicate_artists.py --dry-run   # count groups, no writes
    python3 merge_case_duplicate_artists.py             # execute
"""

import argparse
import os

from neo4j import GraphDatabase

SKIP_GROUPS = ["no lot", "amendment: please note"]


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — source .env first.")
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

COUNT_QUERY = """
MATCH (a:Artist)
WHERE NOT toLower(a.name) IN $skip
WITH toLower(a.name) AS lowerName, count(a) AS nodeCount
WHERE nodeCount > 1
RETURN count(*) AS groups, sum(nodeCount) AS nodes
"""

PLAN_QUERY = """
MATCH (a:Artist)
WHERE NOT toLower(a.name) IN $skip
OPTIONAL MATCH (a)-[:CREATED]->(cw)
WITH a, count(DISTINCT cw) AS works
WITH toLower(a.name) AS lowerName, a, works,
     (CASE WHEN a.ulanUrl IS NOT NULL THEN 1000000 ELSE 0 END)
     + (CASE WHEN a.wikidataUrl IS NOT NULL THEN 100000 ELSE 0 END)
     + works * 10
     + (CASE WHEN a.name = toUpper(a.name) THEN 0 ELSE 1 END) AS score
WITH lowerName, collect({name: a.name, score: score}) AS cands
WHERE size(cands) > 1
WITH cands,
     reduce(best = cands[0], c IN cands | CASE WHEN c.score > best.score THEN c ELSE best END) AS canon
UNWIND cands AS c
WITH canon.name AS canon, c.name AS dup
WHERE canon <> dup
RETURN canon, dup ORDER BY canon, dup
"""


def run(dry_run=False):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if dry_run:
                result = session.run(COUNT_QUERY, skip=SKIP_GROUPS).single()
                print(f"[PLAN] {result['groups']} duplicate groups, "
                      f"{result['nodes'] - result['groups']} nodes would be merged away.")
                return
            from merge_artists import merge_pair
            merged = 0
            for r in session.run(PLAN_QUERY, skip=SKIP_GROUPS).data():
                got = merge_pair(session, r["canon"], r["dup"], provenance={
                    "rule": "caseFold", "ruleVersion": "CASE-DEDUP-1.1", "decidedBy": "rule",
                    "evidence": f"names identical except for letter case: {r['dup']!r}"})
                merged += got is not None
            print(f"[DONE] {merged} duplicate node(s) merged away")
    finally:
        driver.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
