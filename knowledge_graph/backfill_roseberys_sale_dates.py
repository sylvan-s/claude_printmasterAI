"""
PrintMasterAI — recover the missing `saleDate` on Roseberys ACKG SourceRecords.
Version: ROSEBERYS-SALEDATE-BACKFILL-1.0

`roseberys_ingest.py` never mapped a sale date: `catalogue.csv` has `sale_code` and
`auction_id` but no date column at all, so `SourceRecord.saleDate` was left null on
12,743 of 12,745 Roseberys rows. (The two exceptions are A0777 lots 42/43, written by the
earlier live-page pilot; they carry 2026-04-16 and are used below as a correctness check
on the whole fetch.)

That gap is why ADR-0016 excludes Roseberys from Stage 3 comparables entirely: comps are
selected and weighted by recency, so an undated record cannot be used at all. Roseberys'
8,164 realised prices are otherwise good data — this is the highest-value repair available
to the comps corpus, and it needs no re-ingest of anything else.

The date is not in the CSV, so it comes from Roseberys' own sale pages — 43 of them, one
per sale, not one per lot. Each `/bidding/<slug>` page carries the date twice:
  - in `<title>`, as `Roseberys London | <sale name> (YYYY-MM-DD)`, and
  - in the body, as prose ("Saturday 4 October 2014").
Both are parsed and required to AGREE before a date is accepted. A sale whose two sources
disagree is reported and skipped, never guessed — a wrong sale date is worse than a null
one here, because a null is visibly excluded from comps whereas a wrong date silently
mis-weights them.

Fetched dates are cached to `roseberys_sale_dates.json` so the graph write is reproducible
offline and the exact dates used stay auditable.

Note the sales actually span 2014-2026, not the 2016-2026 the ingest docstring claims.

  python3 knowledge_graph/backfill_roseberys_sale_dates.py --fetch      # fetch + cache only
  python3 knowledge_graph/backfill_roseberys_sale_dates.py --dry-run
  python3 knowledge_graph/backfill_roseberys_sale_dates.py
  python3 knowledge_graph/backfill_roseberys_sale_dates.py --verify
"""

import argparse
import html
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone

import pandas as pd
from neo4j import GraphDatabase

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE_CSV_PATH = os.path.join(HERE, "..", "benchmark", "data", "all-prints", "catalogue.csv")
CACHE_PATH = os.path.join(HERE, "roseberys_sale_dates.json")
BIDDING_BASE = "https://www.roseberys.co.uk/bidding"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
INSTITUTION = "Roseberys London"
THROTTLE_S = 1.5

# The pilot ingest already established this one independently; treat a mismatch as a
# parser failure rather than trusting 43 freshly-scraped dates on no evidence.
KNOWN_GOOD = {"A0777": "2026-04-16"}

TITLE_DATE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
ISO_IN_TITLE = re.compile(r"\((\d{4})-(\d{2})-(\d{2})\)")
PROSE_DATE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(\d{4})\b", re.I)
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], start=1)}


def sales_from_csv():
    df = pd.read_csv(CATALOGUE_CSV_PATH, low_memory=False)
    out = []
    for (code, auction_id), g in df.groupby(["sale_code", "auction_id"]):
        slug = None
        for u in g["lot_url"].dropna():
            m = re.match(r"https?://www\.roseberys\.co\.uk/bidding/([^/]+)/", str(u))
            if m:
                slug = m.group(1)
                break
        out.append({"saleCode": str(code), "auctionId": int(auction_id),
                    "slug": slug, "lots": int(len(g))})
    return sorted(out, key=lambda r: r["saleCode"])


def parse_page(text):
    """Return (isoFromTitle, isoFromProse). Both must agree to be trusted."""
    iso_title = None
    tm = TITLE_DATE.search(text)
    if tm:
        im = ISO_IN_TITLE.search(html.unescape(tm.group(1)))
        if im:
            iso_title = f"{im.group(1)}-{im.group(2)}-{im.group(3)}"
    iso_prose = None
    pm = PROSE_DATE.search(re.sub(r"<[^>]+>", " ", text[:200000]))
    if pm:
        iso_prose = f"{int(pm.group(3)):04d}-{MONTHS[pm.group(2).lower()]:02d}-{int(pm.group(1)):02d}"
    return iso_title, iso_prose


def fetch_all(sales):
    results, problems = {}, []
    for i, s in enumerate(sales, 1):
        if not s["slug"]:
            problems.append((s["saleCode"], "no slug in any lot_url"))
            continue
        url = f"{BIDDING_BASE}/{s['slug']}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode("utf-8", errors="replace")
        except Exception as e:
            problems.append((s["saleCode"], f"fetch failed: {e}"))
            continue
        iso_title, iso_prose = parse_page(text)
        if not iso_title and not iso_prose:
            problems.append((s["saleCode"], "no date found on page"))
        elif iso_title and iso_prose and iso_title != iso_prose:
            problems.append((s["saleCode"], f"title {iso_title} != prose {iso_prose} — SKIPPED"))
        else:
            iso = iso_title or iso_prose
            results[s["saleCode"]] = {"saleDate": iso, "auctionId": s["auctionId"],
                                      "slug": s["slug"], "lots": s["lots"],
                                      "confirmedBy": "title+prose" if (iso_title and iso_prose) else "single-source"}
        print(f"  [{i}/{len(sales)}] {s['saleCode']} -> {results.get(s['saleCode'], {}).get('saleDate', 'FAILED')}")
        time.sleep(THROTTLE_S)
    return results, problems


def check_known(results):
    bad = []
    for code, expected in KNOWN_GOOD.items():
        got = results.get(code, {}).get("saleDate")
        if got and got != expected:
            bad.append(f"{code}: fetched {got}, but the pilot ingest recorded {expected}")
    return bad


def load_cache():
    if not os.path.exists(CACHE_PATH):
        return None
    with open(CACHE_PATH, encoding="utf-8") as f:
        return json.load(f)["sales"]


def save_cache(results):
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump({"source": BIDDING_BASE, "fetchedAt": datetime.now(timezone.utc).isoformat(),
                   "sales": results}, f, indent=2, sort_keys=True)
    print(f"\ncached {len(results)} sale date(s) -> {CACHE_PATH}")


WRITE = """
UNWIND $rows AS row
MATCH (s:SourceRecord)
WHERE s.institutionName = $institution AND s.saleId = row.saleCode
SET s.saleDate = row.saleDate,
    s.saleDateSource = $source,
    s.saleDateBackfillAt = $now
RETURN count(s) AS n
"""


def apply(session, results, dry_run):
    rows = [{"saleCode": c, "saleDate": v["saleDate"]} for c, v in sorted(results.items())]
    counts = session.run(
        """
        UNWIND $rows AS row
        MATCH (s:SourceRecord)
        WHERE s.institutionName = $institution AND s.saleId = row.saleCode
        RETURN row.saleCode AS saleCode, row.saleDate AS saleDate, count(s) AS n
        ORDER BY saleCode
        """, rows=rows, institution=INSTITUTION).data()
    total = sum(c["n"] for c in counts)
    print(f"\n{len(rows)} sale(s) -> {total} SourceRecord(s) will be dated")
    unmatched = [c for c in counts if c["n"] == 0]
    if unmatched:
        print(f"  NOTE: {len(unmatched)} sale code(s) match no graph records: "
              f"{', '.join(c['saleCode'] for c in unmatched)}")
    if dry_run:
        print("\n--dry-run: no writes made.")
        return 0
    res = session.run(WRITE, rows=rows, institution=INSTITUTION,
                      source=f"roseberys.co.uk/bidding page ({BIDDING_BASE})",
                      now=datetime.now(timezone.utc).isoformat()).single()
    return res["n"]


def verify(session):
    r = session.run(
        """
        MATCH (s:SourceRecord) WHERE s.institutionName = $institution
        RETURN count(*) AS total,
               sum(CASE WHEN s.saleDate IS NOT NULL THEN 1 ELSE 0 END) AS dated,
               count(DISTINCT s.saleDate) AS distinctDates,
               min(s.saleDate) AS earliest, max(s.saleDate) AS latest
        """, institution=INSTITUTION).single()
    print(f"Roseberys SourceRecords : {r['total']}")
    print(f"  with a saleDate       : {r['dated']}")
    print(f"  distinct sale dates   : {r['distinctDates']}  (expect ~43, one per sale)")
    print(f"  range                 : {r['earliest']} .. {r['latest']}")
    comps = session.run(
        """
        MATCH (s:SourceRecord)
        WHERE s.sourceType='auction' AND s.sold=true
          AND s.priceRealisedGBP IS NOT NULL AND s.saleDate IS NOT NULL
        RETURN count(*) AS n,
               sum(CASE WHEN s.institutionName=$institution THEN 1 ELSE 0 END) AS fromRoseberys
        """, institution=INSTITUTION).single()
    print(f"\nStage 3 usable dated comparables: {comps['n']} (+{comps['fromRoseberys']} now from Roseberys)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="fetch + cache sale dates, no graph write")
    ap.add_argument("--refetch", action="store_true", help="ignore the cache and re-fetch")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                verify(session)
                return
            results = None if args.refetch else load_cache()
            if results is None:
                sales = sales_from_csv()
                print(f"fetching sale dates for {len(sales)} Roseberys sale(s)...\n")
                results, problems = fetch_all(sales)
                if problems:
                    print(f"\n{len(problems)} sale(s) could NOT be dated (left null, not guessed):")
                    for code, why in problems:
                        print(f"    {code}: {why}")
                bad = check_known(results)
                if bad:
                    print("\nABORTING — fetched date contradicts a known-good date:")
                    for b in bad:
                        print(f"    {b}")
                    return
                save_cache(results)
            else:
                print(f"using cached dates for {len(results)} sale(s) ({CACHE_PATH})")
            if args.fetch:
                return
            written = apply(session, results, args.dry_run)
            if written:
                print(f"\ndated {written} SourceRecord(s).\n")
                verify(session)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
