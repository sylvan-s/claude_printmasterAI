"""
PrintMasterAI — backfill ULAN / Wikidata authority ids onto ACKG Artist nodes.
Version: ARTIST-ULAN-BACKFILL-1.0

Only ~18% of the 5,056 Artist nodes carry a ULAN id (see ADR-0010 "Not addressed").
ADR-0010's identity-level agreement check ("ULAN id match first, else normalized name")
therefore falls back to string matching for ~80% of artists, and query_ackg's support
counts fragment across name-duplicate nodes for the same person.

This runs resolve_artist() (Wikidata-first, ULAN luc:term to fill) over the artists that
lack a ULAN and writes the id ONLY on a "high_confidence_auto" result. Everything else
goes to a report CSV for a human / the ACKG Curator (ADR-0008). Never auto-merges nodes.

  python3 knowledge_graph/backfill_artist_ulan.py --min-works 2               # the ~1,970 that matter
  python3 knowledge_graph/backfill_artist_ulan.py --min-works 2 --limit 25    # smoke
  python3 knowledge_graph/backfill_artist_ulan.py --dedup-scan                # merge-candidate report only, no writes
  python3 knowledge_graph/backfill_artist_ulan.py --resume                    # skip already-processed

Getty's SPARQL endpoint is flaky under load (see resolve_artist_identity.py). This paces
requests and the resolver retries; a full run of ~2,000 artists takes ~1.5-2 h.
"""

import argparse
import csv
import os
import re
import time
import unicodedata
from datetime import datetime, timezone

from neo4j import GraphDatabase

from resolve_artist_identity import resolve_artist, strip_honorifics

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

RESOLVER_TAG = "ulan-wd-resolver-1.0"
REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artist_ulan_report.csv")
DEDUP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artist_dedup_candidates.csv")


def _norm_key(name):
    s = unicodedata.normalize("NFD", strip_honorifics(name or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def dedup_scan(session):
    rows = session.run(
        "MATCH (a:Artist) OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork) "
        "RETURN elementId(a) AS eid, a.name AS name, a.ulanUrl AS ulan, count(DISTINCT w) AS works"
    ).data()
    groups = {}
    for r in rows:
        groups.setdefault(_norm_key(r["name"]), []).append(r)
    dupes = {k: v for k, v in groups.items() if len(v) > 1 and k}
    with open(DEDUP_PATH, "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["normKey", "nodeCount", "names", "ulanUrls", "totalWorks"])
        for k, v in sorted(dupes.items(), key=lambda kv: -sum(x["works"] for x in kv[1])):
            wr.writerow([
                k, len(v),
                " | ".join(x["name"] for x in v),
                " | ".join(x["ulan"] or "-" for x in v),
                sum(x["works"] for x in v),
            ])
    print(f"{len(dupes)} name-collision group(s) ({sum(len(v) for v in dupes.values())} nodes) -> {DEDUP_PATH}")


def backfill(session, min_works, limit, resume, dry_run):
    q = (
        "MATCH (a:Artist) WHERE a.ulanUrl IS NULL "
        + ("AND a.identityResolvedAt IS NULL " if resume else "")
        + "OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork) "
        "WITH a, count(DISTINCT w) AS works WHERE works >= $minWorks "
        "RETURN elementId(a) AS eid, a.name AS name, a.wikidataUrl AS wd, works "
        "ORDER BY works DESC"
        + (" LIMIT $limit" if limit else "")
    )
    params = {"minWorks": min_works}
    if limit:
        params["limit"] = limit
    artists = session.run(q, **params).data()
    print(f"{len(artists)} artist(s) to resolve (min_works={min_works}, resume={resume}, dry_run={dry_run})\n")

    report_new = not os.path.exists(REPORT_PATH)
    rf = open(REPORT_PATH, "a", newline="", encoding="utf-8")
    rw = csv.writer(rf)
    if report_new:
        rw.writerow(["name", "confidence", "topUlan", "topUlanName", "topScore",
                     "runnerScore", "wikidata", "note", "ts"])

    counts = {"written": 0, "collision": 0, "reported": 0}
    for i, a in enumerate(artists, 1):
        name = a["name"]
        try:
            r = resolve_artist(name)
        except Exception as e:
            print(f"  [{i}/{len(artists)}] {name!r}: resolver error {e}")
            rw.writerow([name, "resolver_error", "", "", "", "", "", str(e)[:200],
                         datetime.now(timezone.utc).isoformat()])
            rf.flush()
            time.sleep(3)
            continue

        cands = r["candidates"]
        top = cands[0] if cands else None
        runner_score = cands[1]["matchScore"] if len(cands) > 1 else ""
        wd_top = r["wikidata"][0] if r.get("wikidata") else None

        if r["confidence"] == "high_confidence_auto" and r.get("resolvedUlanUrl"):
            uid = r["resolvedUlanUrl"]
            wd_new = r.get("resolvedWikidataUrl")
            clash = session.run(
                "MATCH (o:Artist {ulanUrl: $u}) RETURN o.name AS name LIMIT 1", u=uid
            ).single()
            wd_clash = None
            if not clash and wd_new:
                wd_clash = session.run(
                    "MATCH (o:Artist {wikidataUrl: $wd}) WHERE elementId(o) <> $eid "
                    "RETURN o.name AS name LIMIT 1",
                    wd=wd_new, eid=a["eid"],
                ).single()
            if clash or wd_clash:
                other = clash or wd_clash
                reason = "ulan" if clash else "wikidata"
                counts["collision"] += 1
                print(f"  [{i}/{len(artists)}] {name!r}: -> {uid} but already on {other['name']!r} ({reason}) — MERGE CANDIDATE")
                rw.writerow([name, "collision", uid, r["resolvedUlanName"], top["matchScore"],
                             runner_score, wd_new or "",
                             f"{reason} already on node '{other['name']}'",
                             datetime.now(timezone.utc).isoformat()])
            elif dry_run:
                counts["written"] += 1
                print(f"  [{i}/{len(artists)}] {name!r}: WOULD write {uid}  ({r['resolvedUlanName']}, {top['matchScore']})")
            else:
                session.run(
                    "MATCH (a:Artist) WHERE elementId(a) = $eid "
                    "SET a.ulanUrl = $ulan, a.ulanNameResolved = $ulanName, "
                    "    a.wikidataUrl = coalesce(a.wikidataUrl, $wd), "
                    "    a.identityResolvedBy = $tag, a.identityResolvedAt = $now",
                    eid=a["eid"], ulan=uid, ulanName=r["resolvedUlanName"],
                    wd=r.get("resolvedWikidataUrl"), tag=RESOLVER_TAG,
                    now=datetime.now(timezone.utc).isoformat(),
                )
                counts["written"] += 1
                print(f"  [{i}/{len(artists)}] {name!r}: wrote {uid}  ({r['resolvedUlanName']})")
        else:
            counts["reported"] += 1
            if not dry_run and not resume:
                # record that we looked, so --resume skips it next time
                session.run(
                    "MATCH (a:Artist) WHERE elementId(a) = $eid "
                    "SET a.identityResolvedBy = $tag, a.identityResolvedAt = $now",
                    eid=a["eid"], tag=f"{RESOLVER_TAG}:{r['confidence']}",
                    now=datetime.now(timezone.utc).isoformat(),
                )
            print(f"  [{i}/{len(artists)}] {name!r}: {r['confidence']}"
                  + (f"  (top {top['ulanName']!r} {top['matchScore']})" if top else ""))
            rw.writerow([name, r["confidence"], top["ulanUrl"] if top else "",
                         top["ulanName"] if top else "", top["matchScore"] if top else "",
                         runner_score,
                         f"{wd_top['qid']} {wd_top['label']}" if wd_top else "",
                         "", datetime.now(timezone.utc).isoformat()])
        rf.flush()
        time.sleep(2.0)

    rf.close()
    print(f"\ndone — {counts['written']} written, {counts['collision']} merge-candidates, "
          f"{counts['reported']} reported ({REPORT_PATH})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-works", type=int, default=2)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--dedup-scan", action="store_true")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.dedup_scan:
                dedup_scan(session)
            else:
                backfill(session, args.min_works, args.limit, args.resume, args.dry_run)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
