"""
PrintMasterAI — canonicalise Artist.ulanUrl, then merge the duplicates it was hiding.
Version: ULAN-CANON-MERGE-1.0

`Artist.ulanUrl` is written in two incompatible forms by two resolvers —
`ulan-wd-resolver-1.0` emits http://vocab.getty.edu/ulan/500115467 and
`ulan-local-mirror-0.1` emits http://vocab.getty.edu/page/ulan/500115467 — so every exact
match on the URL silently missed the pairs split across the two. It hid twelve duplicate
Artist pairs from every prior dedup pass, Renoir and Toulouse-Lautrec and Ed Ruscha among
them. The plain form is kept because it is Getty's RDF resource URI; `/page/` addresses the
HTML page about that resource, which is a different thing.

THE ORDER IS FORCED BY A CONSTRAINT AND IS NOT THE OBVIOUS ONE. `artist_ulanurl` is a
UNIQUENESS constraint, so rewriting a page-form URL onto an id another node already holds is
REJECTED, and those rejections are exactly the twelve pairs this is meant to fix. Hence:

    phase 1  canonicalise the 1,248 page-form nodes that collide with nothing
    phase 2  merge the 12 colliding pairs, which deletes one side and frees the id
    phase 3  canonicalise the 12 survivors, now unopposed

Running phase 1 alone is safe and leaves the graph consistent. Phase 3 without phase 2 is a
no-op that raises.

THE HOUSE MERGE QUERY IS NOT REUSED, AND THE REASON IS DATA LOSS. `MERGE_QUERY` in
`find_artist_merge_candidates.py` moves CREATED, FROM_REGION and ATTRIBUTED_TO and then
DETACH DELETEs. Artist nodes also carry MADE_MATRIX (1,050 edges) and CATALOGUES (6), and
those would be destroyed silently. One node in scope here, Giorgio de Chirico, holds a
CATALOGUES edge. The query below moves all five, and asserts the deleted node has no
remaining relationships before deleting it.

Canonical node and surviving name string come from `pick_canonical` and `preferred_name` in
that same script, unchanged, so this pass makes the same choices every prior merge made.

Usage:
    python3 canonicalise_ulan_and_merge.py --dry-run
    python3 canonicalise_ulan_and_merge.py --execute
    python3 canonicalise_ulan_and_merge.py --execute --phase 1
"""
import argparse, json, os, sys
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase                                    # noqa: E402
from find_artist_merge_candidates import pick_canonical, preferred_name   # noqa: E402

CANON_PREFIX = "http://vocab.getty.edu/ulan/"

SNAPSHOT = """
MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL
RETURN elementId(a) AS id, a.name AS name, a.ulanUrl AS ulanUrl,
       a.wikidataUrl AS wikidataUrl, a.identityResolvedBy AS resolvedBy
"""

DUP_PAIRS = """
MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL
WITH a, reverse(split(reverse(a.ulanUrl), '/')[0]) AS uid
WITH uid, collect(a) AS nodes WHERE size(nodes) > 1
UNWIND nodes AS a
OPTIONAL MATCH (a)-[:CREATED]->(cw:ConceptualWork)
WITH uid, a, count(DISTINCT cw) AS works
RETURN uid, collect({name: a.name, works: works,
                     ulan: a.ulanUrl, wikidata: a.wikidataUrl,
                     pageForm: a.ulanUrl CONTAINS '/page/'}) AS side
ORDER BY uid
"""

SAFE_TO_CANON = """
MATCH (a:Artist) WHERE a.ulanUrl CONTAINS '/page/ulan/'
WITH a, reverse(split(reverse(a.ulanUrl), '/')[0]) AS uid
WHERE NOT EXISTS {
    MATCH (b:Artist) WHERE b.ulanUrl = $prefix + uid AND elementId(b) <> elementId(a)
}
RETURN elementId(a) AS id, a.name AS name, a.ulanUrl AS old, $prefix + uid AS new
"""

APPLY_CANON = """
UNWIND $rows AS row
MATCH (a:Artist) WHERE elementId(a) = row.id
SET a.ulanUrl = row.new, a.ulanUrlCanonicalisedAt = $now
RETURN count(*) AS n
"""

# Every relationship type an Artist carries, verified against the live graph before writing
# this. ATTRIBUTED_TO and CATALOGUES are INCOMING; the other three outgoing.
MERGE_PAIR = """
MATCH (canon:Artist {name: $canonName})
MATCH (dup:Artist   {name: $dupName})
WITH canon, dup,
     coalesce(canon.alternateNames, []) + coalesce(dup.alternateNames, [])
     + [dup.name, canon.name] AS combined
UNWIND combined AS x
WITH canon, dup, collect(DISTINCT x) AS deduped
SET canon.alternateNames = deduped
WITH canon, dup
CALL {
    WITH canon, dup
    OPTIONAL MATCH (dup)-[:CREATED]->(n) 
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (canon)-[:CREATED]->(x))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (dup)-[:MADE_MATRIX]->(n)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (canon)-[:MADE_MATRIX]->(x))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (dup)-[:FROM_REGION]->(n)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (canon)-[:FROM_REGION]->(x))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (n)-[:ATTRIBUTED_TO]->(dup)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (x)-[:ATTRIBUTED_TO]->(canon))
}
CALL {
    WITH canon, dup
    OPTIONAL MATCH (n)-[:CATALOGUES]->(dup)
    FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | MERGE (x)-[:CATALOGUES]->(canon))
}
WITH canon, dup
// Inherit any identity field the survivor lacks, so a merge never loses an identifier.
SET canon.dateBorn_year   = coalesce(canon.dateBorn_year,   dup.dateBorn_year),
    canon.dateDied_year   = coalesce(canon.dateDied_year,   dup.dateDied_year),
    canon.nationality     = coalesce(canon.nationality,     dup.nationality),
    canon.birthPlace      = coalesce(canon.birthPlace,      dup.birthPlace),
    canon.deathPlace      = coalesce(canon.deathPlace,      dup.deathPlace),
    canon.wikidataUrl     = coalesce(canon.wikidataUrl,     dup.wikidataUrl)
WITH canon, dup
DETACH DELETE dup
RETURN canon.name AS survivor
"""

RENAME = "MATCH (a:Artist {name: $from}) SET a.name = $to RETURN a.name AS name"

# The guard that keeps DETACH DELETE honest, run in Python because THIS INSTANCE HAS NO APOC
# — the Oracle Cloud self-hosted Neo4j CE does not ship it, and `apoc.util.validate` (the
# obvious way to assert this inside the write query) fails with Unknown function. Checked
# per pair immediately before the merge rather than once up front, so a relationship added
# between planning and writing cannot slip through.
HANDLED_TYPES = {"CREATED", "MADE_MATRIX", "FROM_REGION", "ATTRIBUTED_TO", "CATALOGUES"}

REL_TYPES = """
MATCH (dup:Artist {name: $dupName})-[r]-()
RETURN DISTINCT type(r) AS t
"""


def assert_transferable(session, dup_name):
    """Refuse to delete a node carrying a relationship type the merge does not transfer.
    Silent loss of an untransferred type is the exact failure this file exists to avoid —
    the house `MERGE_QUERY` moves three of the five types Artist nodes actually carry."""
    types = {r["t"] for r in session.run(REL_TYPES, dupName=dup_name)}
    unhandled = types - HANDLED_TYPES
    if unhandled:
        raise RuntimeError(
            f"'{dup_name}' carries relationship types this merge does not transfer: "
            f"{sorted(unhandled)}. Extend MERGE_PAIR before rerunning.")


def connect():
    uri, user, pw = (os.getenv("NEO4J_URI"), os.getenv("NEO4J_USER"),
                     os.getenv("NEO4J_PASSWORD"))
    if not all([uri, user, pw]):
        sys.exit("NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD must be set")
    return GraphDatabase.driver(uri, auth=(user, pw))


def plan_merges(session):
    """Resolve each colliding id to (canonical node, node to delete, name to keep)."""
    out = []
    for r in session.run(DUP_PAIRS):
        sides = r["side"]
        if len(sides) != 2:
            print(f"  !! ulan {r['uid']} has {len(sides)} nodes, not 2 — skipped, "
                  f"needs manual review: {[s['name'] for s in sides]}")
            continue
        a, b = sides[0]["name"], sides[1]["name"]
        info = {s["name"]: {"ulan": s["ulan"], "wikidata": s["wikidata"],
                            "works": s["works"]} for s in sides}
        canon, dup = pick_canonical(info, a, b)
        out.append({"uid": r["uid"], "canon": canon, "dup": dup,
                    "keepName": preferred_name(info, a, b),
                    "works": {a: info[a]["works"], b: info[b]["works"]}})
    return out


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--execute", action="store_true")
    ap.add_argument("--phase", type=int, choices=[1, 2, 3], action="append")
    ap.add_argument("--snapshot-dir", default=".")
    a = ap.parse_args()
    phases = set(a.phase or [1, 2, 3])
    now = datetime.now(timezone.utc).isoformat()

    drv = connect()
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        snap = [dict(r) for r in s.run(SNAPSHOT)]
        merges = plan_merges(s)
        safe = [dict(r) for r in s.run(SAFE_TO_CANON, prefix=CANON_PREFIX)]

        stamp = now[:10]
        path = os.path.join(a.snapshot_dir, f"ulan_canon_presnapshot_{stamp}.json")
        if a.execute:
            with open(path, "w") as fh:
                json.dump({"takenAt": now, "artistsWithUlan": snap,
                           "plannedMerges": merges}, fh, indent=2)
            print(f"pre-snapshot: {len(snap):,} ULAN-bearing artists -> {path}\n")

        print(f"PHASE 1  canonicalise {len(safe):,} non-colliding page-form URLs")
        if 1 in phases and a.execute:
            n = s.run(APPLY_CANON, rows=safe, now=now).single()["n"]
            print(f"         {n:,} updated")
        elif 1 in phases:
            for r in safe[:3]:
                print(f"         e.g. {r['name']}: {r['old']} -> {r['new']}")
            print(f"         ... and {max(len(safe)-3,0):,} more")

        print(f"\nPHASE 2  merge {len(merges)} duplicate pairs")
        for m in merges:
            wc, wd = m["works"][m["canon"]], m["works"][m["dup"]]
            rename = "" if m["keepName"] == m["canon"] else f"  then rename -> '{m['keepName']}'"
            print(f"         ulan {m['uid']}: keep '{m['canon']}' (w{wc})"
                  f"  <- absorb '{m['dup']}' (w{wd}){rename}")
            if 2 in phases and a.execute:
                assert_transferable(s, m["dup"])
                s.run(MERGE_PAIR, canonName=m["canon"], dupName=m["dup"]).consume()
                if m["keepName"] != m["canon"]:
                    s.run(RENAME, **{"from": m["canon"], "to": m["keepName"]}).consume()

        if 3 in phases:
            rest = [dict(r) for r in s.run(SAFE_TO_CANON, prefix=CANON_PREFIX)] if a.execute else []
            print(f"\nPHASE 3  canonicalise the merge survivors still on the page form"
                  + (f": {len(rest)}" if a.execute else
                     " (at most 12; not enumerable until phases 1-2 have run)"))
            if a.execute:
                n = s.run(APPLY_CANON, rows=rest, now=now).single()["n"] if rest else 0
                print(f"         {n} updated")

        if a.execute:
            left = s.run("MATCH (a:Artist) WHERE a.ulanUrl CONTAINS '/page/' "
                         "RETURN count(*) AS n").single()["n"]
            dups = s.run("MATCH (a:Artist) WHERE a.ulanUrl IS NOT NULL "
                         "WITH reverse(split(reverse(a.ulanUrl),'/')[0]) AS uid, count(*) AS n "
                         "WHERE n > 1 RETURN count(*) AS n").single()["n"]
            tot = s.run("MATCH (a:Artist) RETURN count(*) AS n").single()["n"]
            print(f"\nVERIFY   page-form URLs remaining: {left}   "
                  f"duplicate ULAN ids remaining: {dups}   Artist nodes: {tot:,}")
    drv.close()
    if a.dry_run:
        print("\n(dry run — nothing written)")


if __name__ == "__main__":
    main()
