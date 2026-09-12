"""
Roseberys ULAN resolution — free re-check before Pass 2 (Haiku).

The general local resolver (resolve_artist(), unrestricted to printmakers) occasionally
turns up "high_confidence_auto" matches for names that were multiple_candidates/unresolved
at the last full backfill — the local ULAN mirror and graph state have both moved since
then (see roseberys_pass2_check10b_report.csv: Rebecca Horn and Horst P Horst both came
back high_confidence_auto here despite being in the paid Pass 2 population). This re-runs
resolve_artist() over just the current Pass 2 population and writes only "auto" matches,
with the same collision check used throughout — so the paid Haiku pass never spends money
on a case the free resolver could already close.

  python3 roseberys_pass2_free_recheck.py --population-file pass2_population_v2.json
"""
import argparse
import csv
import json
import os
import time
from datetime import datetime, timezone

from neo4j import GraphDatabase

from resolve_artist_identity import resolve_artist
from ulan_url import canonical_ulan_url

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

RESOLVER_TAG = "ulan-wd-resolver-1.0-recheck"
REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roseberys_pass2_free_recheck_report.csv")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--population-file", default="pass2_population_v2.json")
    ap.add_argument("--report-path", default=REPORT_PATH)
    args = ap.parse_args()

    names = json.load(open(args.population_file))
    print(f"{len(names)} artists to re-check (free, local resolver), population={args.population_file}\n")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    rf = open(args.report_path, "w", newline="", encoding="utf-8")
    rw = csv.writer(rf)
    rw.writerow(["name", "confidence", "topUlan", "topUlanName", "topScore", "action", "note", "ts"])

    written_names = []
    counts = {"written": 0, "collision": 0, "unchanged": 0}

    with driver.session(database=NEO4J_DATABASE) as session:
        for i, name in enumerate(names, 1):
            already = session.run(
                "MATCH (a:Artist {name: $name}) RETURN a.ulanUrl IS NOT NULL AS has_ulan",
                name=name,
            ).single()
            if already and already["has_ulan"]:
                counts["unchanged"] += 1
                continue

            try:
                r = resolve_artist(name)
            except Exception as e:
                print(f"  [{i}/{len(names)}] {name!r}: resolver error {e}")
                rw.writerow([name, "resolver_error", "", "", "", "not_written", str(e)[:200],
                             datetime.now(timezone.utc).isoformat()])
                rf.flush()
                time.sleep(2)
                continue

            if r["confidence"] != "high_confidence_auto" or not r.get("resolvedUlanUrl"):
                counts["unchanged"] += 1
                rw.writerow([name, r["confidence"], "", "", "", "not_written", "",
                             datetime.now(timezone.utc).isoformat()])
                rf.flush()
                continue

            uid = canonical_ulan_url(r["resolvedUlanUrl"])
            wd_new = r.get("resolvedWikidataUrl")
            clash = session.run(
                "MATCH (o:Artist {ulanUrl: $u}) RETURN o.name AS name LIMIT 1", u=uid
            ).single()
            wd_clash = None
            if not clash and wd_new:
                wd_clash = session.run(
                    "MATCH (o:Artist {wikidataUrl: $wd}) WHERE o.name <> $name RETURN o.name AS name LIMIT 1",
                    wd=wd_new, name=name,
                ).single()

            if clash or wd_clash:
                other = clash or wd_clash
                reason = "ulan" if clash else "wikidata"
                counts["collision"] += 1
                print(f"  [{i}/{len(names)}] {name!r}: -> {uid} but already on {other['name']!r} ({reason})")
                rw.writerow([name, "collision", uid, r["resolvedUlanName"], "", "not_written",
                             f"{reason} already on node '{other['name']}'",
                             datetime.now(timezone.utc).isoformat()])
            else:
                session.run("""
                    MATCH (a:Artist {name: $name})
                    SET a.ulanUrl = $ulan, a.ulanNameResolved = $ulanName,
                        a.wikidataUrl = coalesce(a.wikidataUrl, $wd),
                        a.identityResolvedBy = $tag, a.identityResolvedAt = $now
                """, name=name, ulan=uid, ulanName=r["resolvedUlanName"], wd=wd_new,
                    tag=RESOLVER_TAG, now=datetime.now(timezone.utc).isoformat())
                counts["written"] += 1
                written_names.append(name)
                print(f"  [{i}/{len(names)}] {name!r}: WROTE {uid}  ({r['resolvedUlanName']})")
                rw.writerow([name, "high_confidence_auto", uid, r["resolvedUlanName"], "", "written", "",
                             datetime.now(timezone.utc).isoformat()])
            rf.flush()

            if i % 50 == 0:
                print(f"  ...{i}/{len(names)} — running counts: {counts}", flush=True)

    rf.close()
    driver.close()
    print(f"\ndone — {counts}")
    print(f"report -> {args.report_path}")

    remaining = [n for n in names if n not in written_names]
    out_path = args.population_file.replace(".json", "_postfree.json")
    json.dump(remaining, open(out_path, "w"), indent=2)
    print(f"{len(remaining)} remaining -> {out_path}  ({len(written_names)} newly free-resolved)")


if __name__ == "__main__":
    main()
