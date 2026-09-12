"""
Roseberys ULAN resolution — Pass 1: local ULAN mirror, printmaker-tagged candidates only.

Population: every Roseberys-attributed Artist with ulanUrl IS NULL (full 1,707, no
works-count restriction — this pass is free/local, no reason to narrow it).

Writes ulanUrl only on "auto" (best>=0.92, gap>=0.15) matches, with the same collision
check backfill_artist_ulan.py uses (never overwrite an existing node's claim on a ULAN
id — log as collision instead). "strong" tier is reported, not written, per this
project's standing never-blind-auto-merge policy.
"""
import csv
import json
import os
import sqlite3
from datetime import datetime, timezone

from neo4j import GraphDatabase

from resolve_artist_identity import strip_honorifics, _name_match_score
from ulan_url import canonical_ulan_url

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ulan_local.sqlite")
REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roseberys_pass1_report.csv")
RESOLVER_TAG = "ulan-local-printmaker-filter-1.0"


def fts_query(name):
    toks = [t for t in name.replace('"', ' ').split() if len(t) > 1]
    return " OR ".join(f'"{t}"' for t in toks[:8]) if toks else None


def search_printmakers(conn, raw_name):
    stripped = strip_honorifics(raw_name)
    q = fts_query(stripped)
    if not q:
        return stripped, []
    try:
        rows = conn.execute("""
            SELECT DISTINCT p.ulan_id, p.pref_name, p.bio, p.wikidata_qid
            FROM ulan_name_fts f JOIN ulan_person p ON p.ulan_id = f.ulan_id
            WHERE ulan_name_fts MATCH ? AND p.is_printmaker = 1
            ORDER BY bm25(ulan_name_fts)
            LIMIT 60
        """, (q,)).fetchall()
    except sqlite3.OperationalError:
        return stripped, []
    scored = []
    for uid, pname, bio, qid in rows:
        score = _name_match_score(stripped, pname or "")
        scored.append({"ulan_id": uid, "pref_name": pname, "bio": bio, "qid": qid, "score": score})
    scored.sort(key=lambda r: -r["score"])
    return stripped, scored


def classify(scored):
    if not scored:
        return "no_candidates"
    best = scored[0]["score"]
    runner = scored[1]["score"] if len(scored) > 1 else 0.0
    if best >= 0.92 and best - runner >= 0.15:
        return "auto"
    if best >= 0.82 and best - runner >= 0.10:
        return "strong"
    if best >= 0.55:
        return "multiple"
    return "no_candidates"


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    conn = sqlite3.connect(DB_PATH)

    with driver.session(database=NEO4J_DATABASE) as session:
        artists = session.run("""
            MATCH (a:Artist)<-[:ATTRIBUTED_TO]-(:SourceRecord {institutionName: 'Roseberys London'})
            WITH DISTINCT a WHERE a.ulanUrl IS NULL
            RETURN a.name AS name
        """).data()

    print(f"{len(artists)} Roseberys artists to check\n")

    rf = open(REPORT_PATH, "w", newline="", encoding="utf-8")
    rw = csv.writer(rf)
    rw.writerow(["name", "classification", "topUlanId", "topUlanName", "topScore",
                 "runnerScore", "action", "note", "ts"])

    counts = {"auto_written": 0, "auto_collision": 0, "strong": 0, "multiple": 0, "no_candidates": 0}

    with driver.session(database=NEO4J_DATABASE) as session:
        for i, a in enumerate(artists, 1):
            name = a["name"]
            stripped, scored = search_printmakers(conn, name)
            cls = classify(scored)
            top = scored[0] if scored else None
            runner_score = scored[1]["score"] if len(scored) > 1 else ""

            if cls != "auto":
                counts[cls] += 1
                rw.writerow([name, cls, top["ulan_id"] if top else "", top["pref_name"] if top else "",
                             top["score"] if top else "", runner_score, "not_written", "",
                             datetime.now(timezone.utc).isoformat()])
                if i % 300 == 0:
                    print(f"  ...{i}/{len(artists)}", flush=True)
                continue

            ulan_url = canonical_ulan_url(top["ulan_id"])
            wikidata_url = f"http://www.wikidata.org/entity/{top['qid']}" if top["qid"] else None

            clash = session.run(
                "MATCH (o:Artist {ulanUrl: $u}) RETURN o.name AS name LIMIT 1", u=ulan_url
            ).single()
            if clash:
                counts["auto_collision"] += 1
                rw.writerow([name, "collision", top["ulan_id"], top["pref_name"], top["score"],
                             runner_score, "not_written",
                             f"ulan already on node '{clash['name']}'",
                             datetime.now(timezone.utc).isoformat()])
                if i % 300 == 0:
                    print(f"  ...{i}/{len(artists)}", flush=True)
                continue

            session.run("""
                MATCH (a:Artist {name: $name})
                SET a.ulanUrl = $ulanUrl,
                    a.ulanNameResolved = $ulanName,
                    a.wikidataUrl = coalesce(a.wikidataUrl, $wikidataUrl),
                    a.identityResolvedBy = $tag,
                    a.identityResolvedAt = $now
            """, name=name, ulanUrl=ulan_url, ulanName=top["pref_name"],
                wikidataUrl=wikidata_url, tag=RESOLVER_TAG,
                now=datetime.now(timezone.utc).isoformat())
            counts["auto_written"] += 1
            print(f"  [{i}/{len(artists)}] {name!r}: WROTE {ulan_url} ({top['pref_name']})")
            rw.writerow([name, "auto", top["ulan_id"], top["pref_name"], top["score"],
                         runner_score, "written", "",
                         datetime.now(timezone.utc).isoformat()])

            if i % 300 == 0:
                print(f"  ...{i}/{len(artists)}", flush=True)

    rf.close()
    conn.close()
    driver.close()
    print(f"\ndone — {counts}")
    print(f"report -> {REPORT_PATH}")


if __name__ == "__main__":
    main()
