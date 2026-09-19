"""
PrintMasterAI — record that 17 King & McGaw Artist ULANs were checked by hand, with a restorable snapshot.
Version: KM-ULAN-VERIFY-1.0

The 2026-09-19 audit (docs/audits/2026-09-19-km-artist-ulan-audit.md, group A3) found 17 King & McGaw-only
Artist nodes whose ULAN the resolver had labelled 'multiple_candidates' but which are the right person:
every work title is a recognisable work by the named artist and the ULAN dates fit. The label was
untrue, so this sets identityConfidence = 'manual_verified' and leaves ulanUrl exactly as it is.

Records, per node, so the change is auditable and reversible:
    identityConfidencePrior, identityVerifiedAt, identityVerifiedBasis

REFUSES a node unless ALL hold at write time:
  * exactly one Artist has that name
  * its ulanUrl is still the audited value (this script never writes or changes a ulanUrl)
  * its identityConfidence is still 'multiple_candidates'
  * every work it created is a `km-cw-` node, and it created at least one

Later ingests write identityConfidence with coalesce(), so they do not overwrite this value.
This does NOT stop a re-ingest from re-resolving these names to a different ULAN candidate; that needs the
ingest confidence gate described in the audit (§6 step 0), with these 17 names as its override table.

    python3 verify_km_artist_ulan.py                          # verify every node + write a snapshot, no writes
    python3 verify_km_artist_ulan.py --apply
    python3 verify_km_artist_ulan.py --rollback SNAPSHOT.json
"""
import argparse
import json
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
PLAN = os.path.join(HERE, "km_ulan_verify_plan_2026-09-19.json")
BASIS = "name, ULAN dates and every work title reviewed by hand 2026-09-19 (KM-ULAN-AUDIT, group A3)"
load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))

# Label-scoped on purpose: an unlabelled MATCH would silently skip the name index.
STATE = """
MATCH (a:Artist {name: $name})
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
RETURN elementId(a) AS eid, a.ulanUrl AS ulanUrl, a.identityConfidence AS identityConfidence,
       count(w) AS works, sum(CASE WHEN w.id STARTS WITH 'km-cw-' THEN 1 ELSE 0 END) AS kmWorks
"""

VERIFY = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name})
WHERE elementId(a) = row.eid AND a.ulanUrl = row.ulanUrl AND a.identityConfidence = 'multiple_candidates'
SET a.identityConfidencePrior = a.identityConfidence,
    a.identityConfidence = 'manual_verified',
    a.identityVerifiedAt = $now,
    a.identityVerifiedBasis = $basis
RETURN count(a) AS n
"""

RESTORE = """
UNWIND $rows AS row
MATCH (a:Artist {name: row.name}) WHERE a.ulanUrl = row.ulanUrl AND a.identityConfidence = 'manual_verified'
SET a.identityConfidence = row.identityConfidence
REMOVE a.identityConfidencePrior, a.identityVerifiedAt, a.identityVerifiedBasis
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
                elif g["identityConfidence"] != "multiple_candidates":
                    why = f"identityConfidence is now {g['identityConfidence']!r}"
                elif g["works"] == 0 or g["works"] != g["kmWorks"]:
                    why = f"not King & McGaw-only ({g['kmWorks']} km of {g['works']} works)"
            if why:
                refused.append((p["name"], why))
            else:
                ok.append({**p, "eid": g["eid"], "identityConfidence": g["identityConfidence"], "worksNow": g["works"]})

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        snap = os.path.join(HERE, f"km_ulan_verify_presnapshot_{ts}.json")
        json.dump({"version": "KM-ULAN-VERIFY-1.0", "takenAt": ts, "rows": ok}, open(snap, "w"), indent=1, ensure_ascii=False)
        print(f"plan {len(plan)} | verified {len(ok)} | refused {len(refused)}")
        for name, why in refused:
            print(f"   REFUSED {name!r}: {why}")
        print("snapshot ->", snap)
        if not args.apply:
            print("\n(dry run: no writes made)")
            return
        if refused:
            raise SystemExit("REFUSED to apply while any node is refused; resolve the drift and re-plan")
        n = s.run(VERIFY, rows=ok, now=ts, basis=BASIS).single()["n"]
        print(f"marked manual_verified on {n} of {len(ok)} nodes")
        if n != len(ok):
            raise SystemExit("count mismatch — check the graph, then --rollback the snapshot if needed")


if __name__ == "__main__":
    main()
