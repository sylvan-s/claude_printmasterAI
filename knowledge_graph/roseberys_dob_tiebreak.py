"""
Roseberys ULAN resolution — free DOB tie-break pass.

Runs resolve_artist_with_dob() (see resolve_artist_identity.py) over a population of
Roseberys-attributed unresolved artists, using each Artist node's own dateBorn_year to
disambiguate "multiple_candidates" cases that are really just several ULAN records
sharing one exact full name (e.g. 11 different "Taylor, John" entries) rather than
genuine ambiguity about who the source record means. Writes only on the new
"dob_tiebreak_auto" confidence, with the same collision check used throughout this
project (never overwrite another node's claim on a ULAN id).

  python3 roseberys_dob_tiebreak.py --population-file pass2_population_v3.json
"""
import argparse
import csv
import json
import os
from datetime import datetime, timezone

from neo4j import GraphDatabase

from resolve_artist_identity import resolve_artist_with_dob
from ulan_url import canonical_ulan_url

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

RESOLVER_TAG = "ulan-dob-tiebreak-1.0"
REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roseberys_dob_tiebreak_report.csv")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--population-file", default="pass2_population_v3.json")
    ap.add_argument("--report-path", default=REPORT_PATH)
    args = ap.parse_args()

    names = json.load(open(args.population_file))
    print(f"{len(names)} artists to check, population={args.population_file}\n")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    rf = open(args.report_path, "w", newline="", encoding="utf-8")
    rw = csv.writer(rf)
    rw.writerow(["name", "dobYear", "tiedCandidates", "resolvedUlanId", "resolvedUlanName",
                 "action", "note", "ts"])

    written_names = []
    counts = {"written": 0, "collision": 0, "no_dob_or_no_tiebreak": 0}

    with driver.session(database=NEO4J_DATABASE) as session:
        for i, name in enumerate(names, 1):
            row = session.run(
                "MATCH (a:Artist {name: $name}) RETURN a.dateBorn_year AS dob, "
                "a.ulanUrl IS NOT NULL AS has_ulan",
                name=name,
            ).single()
            if not row or row["has_ulan"] or not row["dob"]:
                counts["no_dob_or_no_tiebreak"] += 1
                continue

            # resolve_artist_with_dob() wraps resolve_artist() unchanged when the DOB
            # tie-break doesn't apply — so a plain "high_confidence_auto" (e.g. a fresh
            # Wikidata singleton match that has nothing to do with DOB tie-breaking) can
            # come back too. Write on either: this pass should catch every free win in
            # the population, not just the DOB-specific ones.
            r = resolve_artist_with_dob(name, row["dob"])
            if r["confidence"] not in ("dob_tiebreak_auto", "high_confidence_auto"):
                counts["no_dob_or_no_tiebreak"] += 1
                continue

            uid = canonical_ulan_url(r["resolvedUlanUrl"])
            ev = r.get("dobTiebreakEvidence", {"tiedCandidates": ""})
            tag = RESOLVER_TAG if r["confidence"] == "dob_tiebreak_auto" else "ulan-wd-resolver-1.0-recheck"
            clash = session.run(
                "MATCH (o:Artist {ulanUrl: $u}) RETURN o.name AS name LIMIT 1", u=uid
            ).single()
            if clash:
                counts["collision"] += 1
                print(f"  [{i}/{len(names)}] {name!r}: -> {uid} but already on {clash['name']!r}")
                rw.writerow([name, row["dob"], ev["tiedCandidates"], r["resolvedUlanName"], "",
                             "collision", f"ulan already on node '{clash['name']}'",
                             datetime.now(timezone.utc).isoformat()])
            else:
                session.run("""
                    MATCH (a:Artist {name: $name})
                    SET a.ulanUrl = $ulan, a.ulanNameResolved = $ulanName,
                        a.identityResolvedBy = $tag, a.identityResolvedAt = $now
                """, name=name, ulan=uid, ulanName=r["resolvedUlanName"],
                    tag=tag, now=datetime.now(timezone.utc).isoformat())
                counts["written"] += 1
                written_names.append(name)
                print(f"  [{i}/{len(names)}] {name!r}: WROTE {uid} ({r['resolvedUlanName']}) "
                      f"dob={row['dob']} tied={ev['tiedCandidates']}")
                rw.writerow([name, row["dob"], ev["tiedCandidates"], uid.rsplit("/", 1)[-1],
                             r["resolvedUlanName"], "written", "",
                             datetime.now(timezone.utc).isoformat()])
            rf.flush()

    rf.close()
    driver.close()
    print(f"\ndone — {counts}")
    print(f"report -> {args.report_path}")

    remaining = [n for n in names if n not in written_names]
    out_path = args.population_file.replace(".json", "_postdob.json")
    json.dump(remaining, open(out_path, "w"), indent=2)
    print(f"{len(remaining)} remaining -> {out_path}  ({len(written_names)} newly resolved)")


if __name__ == "__main__":
    main()
