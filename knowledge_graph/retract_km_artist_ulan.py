"""
PrintMasterAI — retract wrong Getty ULAN urls from King & McGaw-only Artist nodes, with a restorable snapshot.
Version: KM-ULAN-RETRACT-1.0

Why: the King & McGaw ingest wrote `resolve_artist()`'s top candidate as Artist.ulanUrl at every confidence
tier, and `ulanUrl` is an equality key (the artist_ulanurl constraint, every dedup pass, merge_artists.py's
`coalesce(canon.ulanUrl, dup.ulanUrl)`). Audit: docs/audits/2026-09-19-km-artist-ulan-audit.md.

Removes `ulanUrl` and keeps the node. Per node it also records what it took away, under properties that are
NOT identity keys, so the decision is auditable and reversible:
    ulanUrlRetracted, ulanUrlRetractedReason, ulanUrlRetractedAt, identityConfidencePrior
and sets identityConfidence = 'unresolved' (what a node with no ULAN carries elsewhere, e.g. Mirrorpix).
A missing ulanUrl is canonical for check_ulan_url_canonical.py (`is_canonical(None)` is True) and the
constraint permits it; this script builds no ULAN url, it only deletes.

REFUSES a node unless ALL of these hold at write time (the plan was made from an earlier read):
  * exactly one Artist has that name
  * its ulanUrl is still the audited value
  * every work it created is a `km-cw-` node (it is King & McGaw-only) and it created at least one

The plan file carries the 65 audited nodes; it deliberately leaves out the 46 confirmed ones.

    python3 retract_km_artist_ulan.py                          # verify every node + write a snapshot, no writes
    python3 retract_km_artist_ulan.py --apply
    python3 retract_km_artist_ulan.py --rollback SNAPSHOT.json

NOT durable on its own: king_mcgaw_ingest.py still does `SET a.ulanUrl = coalesce(a.ulanUrl, row.artist.ulanUrl)`
from an unguarded resolver result, so a re-ingest of these artists writes the wrong ULAN back.
"""
import argparse
import json
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
PLAN = os.path.join(HERE, "km_ulan_retraction_plan_2026-09-19.json")
load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))

# Label-scoped on purpose: an unlabelled MATCH would silently skip the name index.
STATE = """
MATCH (a:Artist {name: $name})
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
RETURN elementId(a) AS eid, a.ulanUrl AS ulanUrl, a.identityConfidence AS identityConfidence,
       a.wikidataUrl AS wikidataUrl, count(w) AS works,
       sum(CASE WHEN w.id STARTS WITH 'km-cw-' THEN 1 ELSE 0 END) AS kmWorks
"""

RETRACT = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name}) WHERE elementId(a) = row.eid AND a.ulanUrl = row.ulanUrl
SET a.ulanUrlRetracted = a.ulanUrl,
    a.ulanUrlRetractedReason = row.reason,
    a.ulanUrlRetractedAt = $now,
    a.identityConfidencePrior = a.identityConfidence,
    a.identityConfidence = 'unresolved'
REMOVE a.ulanUrl
RETURN count(a) AS n
"""

RESTORE = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name}) WHERE a.ulanUrl IS NULL AND a.ulanUrlRetracted = row.ulanUrl
SET a.ulanUrl = row.ulanUrl, a.identityConfidence = row.identityConfidence
REMOVE a.ulanUrlRetracted, a.ulanUrlRetractedReason, a.ulanUrlRetractedAt, a.identityConfidencePrior
RETURN count(a) AS n
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rollback", metavar="SNAPSHOT")
    args = ap.parse_args()
    driver = GraphDatabase.driver(os.getenv("NEO4J_URI"), auth=(os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")))
    with driver.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        if args.rollback:
            rows = json.load(open(args.rollback))["rows"]
            n = s.run(RESTORE, rows=rows).single()["n"]
            print(f"restored {n} of {len(rows)} nodes")
            return

        plan = json.load(open(PLAN))["rows"]
        ok, refused = [], []
        for p in plan:
            got = s.run(STATE, name=p["name"]).data()
            why = None
            if len(got) != 1:
                why = f"{len(got)} nodes named this (expected 1)"
            else:
                g = got[0]
                if g["ulanUrl"] != p["ulanUrl"]:
                    why = f"ulanUrl is now {g['ulanUrl']!r}, audited {p['ulanUrl']!r}"
                elif g["works"] == 0 or g["works"] != g["kmWorks"]:
                    why = f"not King & McGaw-only ({g['kmWorks']} km of {g['works']} works)"
            if why:
                refused.append((p["name"], why))
            else:
                ok.append({**p, "eid": g["eid"], "identityConfidence": g["identityConfidence"],
                           "wikidataUrl": g["wikidataUrl"], "worksNow": g["works"]})

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        snap = os.path.join(HERE, f"km_ulan_retraction_presnapshot_{ts}.json")
        json.dump({"version": "KM-ULAN-RETRACT-1.0", "takenAt": ts, "rows": ok}, open(snap, "w"), indent=1, ensure_ascii=False)
        print(f"plan {len(plan)} | verified {len(ok)} | refused {len(refused)}")
        for name, why in refused:
            print(f"   REFUSED {name!r}: {why}")
        print("snapshot ->", snap)
        if not args.apply:
            print("\n(dry run: no writes made)")
            return
        if refused:
            raise SystemExit("REFUSED to apply while any node is refused; resolve the drift and re-plan")
        n = s.run(RETRACT, rows=ok, now=ts).single()["n"]
        print(f"retracted ulanUrl on {n} of {len(ok)} nodes")
        if n != len(ok):
            raise SystemExit("count mismatch — check the graph, then --rollback the snapshot if needed")


if __name__ == "__main__":
    main()
