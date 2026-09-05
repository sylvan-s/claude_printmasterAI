"""
Roseberys ULAN resolution — Pass 2: Haiku 4.5 bio + web-search verification, writing
confirmed matches to the graph. Population: roseberys_pass1_population.json (the
remaining unresolved Roseberys artists after Pass 1's printmaker-filter sweep, with
1-work and junk-pattern names excluded — see roseberys_pass1_printmaker.py and the
exclusion query that produced pass2_population.json).

Reuses verify_ambiguous_artists.py's prompt/parsing/model logic unchanged. Adds: a
fixed input name list (instead of top-N by works), and a write step — only on
"CONFIRM", with the same collision check used throughout this session (never overwrite
another node's claim on a ULAN id).
"""
import csv
import json
import os
import time
from datetime import datetime, timezone

import anthropic
from neo4j import GraphDatabase

from resolve_artist_identity import resolve_artist
from verify_ambiguous_artists import verify_one, DEFAULT_MODEL

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roseberys_pass2_report.csv")
RESOLVER_TAG = "haiku-agentic-verification-1.0"


def fetch_node_context(session, name):
    row = session.run("""
        MATCH (a:Artist {name: $name})
        OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
        WITH a, count(DISTINCT w) AS works
        RETURN a.nationality AS nationality, a.dateBorn_year AS dateBorn_year,
               a.dateDied_year AS dateDied_year, works
    """, name=name).single()
    return dict(row) if row else {"works": None}


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--population-file", default="pass2_population.json")
    ap.add_argument("--report-path", default=REPORT_PATH)
    args = ap.parse_args()

    names = json.load(open(args.population_file))
    print(f"{len(names)} artists for Pass 2 (Haiku), population={args.population_file}, "
          f"report={args.report_path}\n")

    client = anthropic.Anthropic()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    report_new = not os.path.exists(args.report_path)
    rf = open(args.report_path, "a", newline="", encoding="utf-8")
    rw = csv.writer(rf)
    if report_new:
        rw.writerow([
            "name", "priorConfidence", "verdict", "matchedUlanId", "matchedUlanName",
            "rationale", "action", "elapsedSeconds", "ts",
        ])

    counts = {"written": 0, "collision": 0, "REJECT": 0, "UNCERTAIN": 0,
              "no_candidates": 0, "parse_error": 0}

    with driver.session(database=NEO4J_DATABASE) as session:
        for i, name in enumerate(names, 1):
            node_context = fetch_node_context(session, name)
            # Resume-skip: if a prior partial run (or Pass 1, or a merge) already gave
            # this artist a ulanUrl, don't re-spend an API call on it.
            already = session.run(
                "MATCH (a:Artist {name: $name}) RETURN a.ulanUrl IS NOT NULL AS has_ulan",
                name=name,
            ).single()
            if already and already["has_ulan"]:
                counts["already_resolved"] = counts.get("already_resolved", 0) + 1
                if i % 50 == 0:
                    print(f"  ...{i}/{len(names)}", flush=True)
                continue

            r = resolve_artist(name)
            candidates = r["candidates"]
            if not candidates:
                counts["no_candidates"] += 1
                rw.writerow([name, r["confidence"], "no_candidates", "", "", "", "skipped", 0,
                             datetime.now(timezone.utc).isoformat()])
                rf.flush()
                if i % 50 == 0:
                    print(f"  ...{i}/{len(names)}", flush=True)
                continue

            verdict, full_text, candidates_with_bio, usage = verify_one(
                client, DEFAULT_MODEL, name, node_context, candidates, r.get("wikidata")
            )
            print(f"      usage: {usage}")

            if verdict is None:
                counts["parse_error"] += 1
                print(f"  [{i}/{len(names)}] {name!r}: PARSE_ERROR (no JSON verdict block found)")
                print(f"      raw tail: {full_text[-300:]!r}")
                rw.writerow([name, r["confidence"], "parse_error", "", "", full_text[:300],
                             "skipped", usage.get("elapsed_s", 0),
                             datetime.now(timezone.utc).isoformat()])
                rf.flush()
                time.sleep(1.0)
                continue

            v = verdict.get("verdict", "UNCERTAIN")
            matched_id = verdict.get("matchedUlanId")
            matched = next((c for c in candidates_with_bio if c["ulanId"] == matched_id), None)

            if v == "CONFIRM" and matched:
                ulan_url = matched["ulanUrl"]
                clash = session.run(
                    "MATCH (o:Artist {ulanUrl: $u}) RETURN o.name AS name LIMIT 1", u=ulan_url
                ).single()
                if clash:
                    counts["collision"] += 1
                    action = "collision"
                    note = f"ulan already on node '{clash['name']}'"
                    print(f"  [{i}/{len(names)}] {name!r}: CONFIRM but COLLISION with {clash['name']!r}")
                else:
                    session.run("""
                        MATCH (a:Artist {name: $name})
                        SET a.ulanUrl = $ulanUrl,
                            a.ulanNameResolved = $ulanName,
                            a.identityResolvedBy = $tag,
                            a.identityResolvedAt = $now
                    """, name=name, ulanUrl=ulan_url, ulanName=matched["ulanName"],
                        tag=RESOLVER_TAG, now=datetime.now(timezone.utc).isoformat())
                    counts["written"] += 1
                    action = "written"
                    note = ""
                    print(f"  [{i}/{len(names)}] {name!r}: CONFIRM -> WROTE {ulan_url} ({matched['ulanName']})")
            else:
                counts[v] = counts.get(v, 0) + 1
                action = "not_written"
                note = ""
                print(f"  [{i}/{len(names)}] {name!r}: {v}")

            rw.writerow([name, r["confidence"], v, matched_id or "",
                         matched["ulanName"] if matched else "",
                         (verdict.get("rationale", "") + (" | " + note if note else "")),
                         action, usage.get("elapsed_s", 0),
                         datetime.now(timezone.utc).isoformat()])
            rf.flush()
            time.sleep(1.0)

            if i % 50 == 0:
                print(f"  ...{i}/{len(names)} — running counts: {counts}", flush=True)

    rf.close()
    driver.close()
    print(f"\ndone — {counts}")
    print(f"report -> {args.report_path}")


if __name__ == "__main__":
    main()
