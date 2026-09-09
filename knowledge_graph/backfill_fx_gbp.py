"""
PrintMasterAI — sale-date GBP normalisation for ACKG auction prices.
Version: FX-GBP-BACKFILL-1.0

Stage 3 valuation is moving to ACKG auction records as its PRIMARY comparables source
(ADR-0016), with Stage 2b web research as fallback. That needs every comp on one
currency, because 24,469 of the ~39.9k dated sold records are USD/EUR/CAD/AUD, not GBP —
restricting comps to GBP would throw away roughly 60% of the corpus, and for many print
artists the US market is the deeper one.

Conversion is done at the SALE DATE, not at query time and not at an estimate-time rate.
Two reasons this matters:

  - `bonhams_ingest.py` docstring item 4 already refused to derive realised-price GBP from
    Bonhams' own `gbp_low_estimate`/`gbp_high_estimate`, on the grounds that an
    estimate-time rate can be stale relative to the sale. That objection was correct and is
    now measurable: sale 15403 (2007-11-06, hammer US$1,800) carries `gbp_low_estimate`
    1331.01, which is US$1,800 at ~1.35 — a rate from 2026, not from 2007, when GBP/USD was
    2.0875. Those fields are unusable for this purpose; we compute our own.
  - Doing it as a backfill rather than at query time keeps valuation deterministic and
    offline-testable, and matches how `estimateLowGBP`/`estimateHighGBP` already sit on the
    node rather than being derived per request.

Rates are the ECB daily reference set via frankfurter.app (no API key, series back to
1999, covers USD/EUR/CAD/AUD). The whole series is pulled in ONE request and cached to
`fx_gbp_ecb.json` next to this file, so re-runs and CI need no network and the exact rates
used stay auditable. The ECB publishes nothing on weekends or TARGET holidays, so a sale
on a non-publication day takes the nearest PRECEDING publication day — the rate that was
actually standing when the lot sold. Frankfurter does this server-side too; we do it
locally against the cache so cached and live paths agree.

Writes `priceRealisedGBP`, `hammerPriceGBP`, `fxRateToGBP` (units of native currency per
GBP, i.e. native / rate = GBP), `fxRateDate` (the publication day actually used),
`fxSource`, `fxBackfillAt`. GBP-native rows get rate 1.0 and `fxSource='native'` so a comp
query can treat every row uniformly instead of special-casing currency.

Rows with a price but NO `saleDate` cannot be dated and are skipped, reported, not guessed:
that is all 10,050 Forum Auctions rows and 12,743 of 12,745 Roseberys rows. They are GBP
natively, so they still get GBP values with `fxSource='native'` — the skip only concerns
the dated-FX path, which they do not need.

  python3 knowledge_graph/backfill_fx_gbp.py --refresh-rates   # re-pull the ECB series
  python3 knowledge_graph/backfill_fx_gbp.py --dry-run
  python3 knowledge_graph/backfill_fx_gbp.py
  python3 knowledge_graph/backfill_fx_gbp.py --verify
"""

import argparse
import bisect
import json
import os
import urllib.request
from datetime import datetime, timezone

from neo4j import GraphDatabase

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

HERE = os.path.dirname(os.path.abspath(__file__))
RATES_PATH = os.path.join(HERE, "fx_gbp_ecb.json")
FX_SOURCE = "ECB daily reference (frankfurter.app), base GBP"
SERIES_START = "2003-01-01"
USER_AGENT = "PrintMasterAI-ACKG/1.0 (+fx backfill)"
CURRENCIES = ["USD", "EUR", "CAD", "AUD"]
BATCH = 5000


def fetch_rates():
    end = datetime.now(timezone.utc).date().isoformat()
    url = (f"https://api.frankfurter.app/{SERIES_START}..{end}"
           f"?base=GBP&symbols={','.join(CURRENCIES)}")
    print(f"fetching ECB series {SERIES_START}..{end} ...")
    # frankfurter.app sits behind Cloudflare, which 403s urllib's default User-Agent.
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = json.loads(r.read().decode("utf-8"))
    rates = payload["rates"]
    with open(RATES_PATH, "w", encoding="utf-8") as f:
        json.dump({"base": "GBP", "source": FX_SOURCE, "fetchedAt": end, "rates": rates}, f)
    print(f"  cached {len(rates)} publication days -> {RATES_PATH}")
    return rates


def load_rates(refresh):
    if refresh or not os.path.exists(RATES_PATH):
        return fetch_rates()
    with open(RATES_PATH, encoding="utf-8") as f:
        return json.load(f)["rates"]


class RateBook:
    """Nearest-preceding-publication-day lookup. The ECB publishes on TARGET business days
    only; a Saturday sale must use Friday's rate, not the next Monday's (which had not
    happened yet when the lot sold)."""

    def __init__(self, rates):
        self.days = sorted(rates)
        self.rates = rates
        self.earliest = self.days[0]

    def lookup(self, day, currency):
        if day < self.earliest:
            return None, None
        i = bisect.bisect_right(self.days, day) - 1
        while i >= 0:
            d = self.days[i]
            rate = self.rates[d].get(currency)
            if rate:
                return rate, d
            i -= 1
        return None, None


SELECT = """
MATCH (s:SourceRecord)
WHERE s.sourceType = 'auction'
  AND (s.hammerPrice IS NOT NULL OR s.priceRealised IS NOT NULL)
  AND ($force OR s.fxBackfillAt IS NULL)
RETURN s.id AS id, s.priceCurrency AS cur, s.saleDate AS saleDate,
       s.hammerPrice AS hammer, s.priceRealised AS realised
"""

WRITE = """
UNWIND $rows AS row
MATCH (s:SourceRecord {id: row.id})
SET s.hammerPriceGBP = row.hammerGBP,
    s.priceRealisedGBP = row.realisedGBP,
    s.fxRateToGBP = row.rate,
    s.fxRateDate = row.rateDate,
    s.fxSource = row.source,
    s.fxBackfillAt = $now
RETURN count(s) AS n
"""


def convert(rows, book):
    out, skipped, unconvertible = [], [], []
    for r in rows:
        cur = r["cur"] or "GBP"
        if cur == "GBP":
            out.append({"id": r["id"], "hammerGBP": r["hammer"], "realisedGBP": r["realised"],
                        "rate": 1.0, "rateDate": None, "source": "native"})
            continue
        if not r["saleDate"]:
            skipped.append((r["id"], cur, "no saleDate"))
            continue
        day = r["saleDate"][:10]
        rate, rate_day = book.lookup(day, cur)
        if not rate:
            unconvertible.append((r["id"], cur, day))
            continue
        out.append({
            "id": r["id"],
            "hammerGBP": round(r["hammer"] / rate, 2) if r["hammer"] is not None else None,
            "realisedGBP": round(r["realised"] / rate, 2) if r["realised"] is not None else None,
            "rate": rate, "rateDate": rate_day, "source": FX_SOURCE,
        })
    return out, skipped, unconvertible


def run(session, book, force, dry_run):
    rows = session.run(SELECT, force=force).data()
    print(f"candidate priced auction rows: {len(rows)}")
    out, skipped, unconvertible = convert(rows, book)

    native = sum(1 for o in out if o["source"] == "native")
    print(f"  GBP-native (rate 1.0)      : {native}")
    print(f"  converted at sale date     : {len(out) - native}")
    if skipped:
        by = {}
        for _, cur, why in skipped:
            by[(cur, why)] = by.get((cur, why), 0) + 1
        print(f"  skipped (cannot date)      : {len(skipped)} -> {by}")
    if unconvertible:
        print(f"  NO RATE for date           : {len(unconvertible)} (earliest ECB day {book.earliest})")
        for x in unconvertible[:5]:
            print(f"      {x[0]} {x[1]} {x[2]}")

    if dry_run:
        print("\n--dry-run: no writes made.")
        return 0
    now = datetime.now(timezone.utc).isoformat()
    written = 0
    for i in range(0, len(out), BATCH):
        written += session.run(WRITE, rows=out[i:i + BATCH], now=now).single()["n"]
        print(f"  written {written}/{len(out)}", end="\r")
    print(f"\nwrote GBP values on {written} SourceRecord(s).")
    return written


def verify(session):
    r = session.run(
        """
        MATCH (s:SourceRecord)
        WHERE s.sourceType='auction' AND s.sold=true AND s.priceRealised IS NOT NULL
        RETURN count(*) AS soldRealised,
               sum(CASE WHEN s.priceRealisedGBP IS NOT NULL THEN 1 ELSE 0 END) AS withGBP,
               sum(CASE WHEN s.priceCurrency='GBP' AND s.priceRealisedGBP <> s.priceRealised
                        THEN 1 ELSE 0 END) AS gbpMismatch,
               sum(CASE WHEN s.priceRealisedGBP IS NOT NULL AND s.priceRealisedGBP <= 0
                        THEN 1 ELSE 0 END) AS nonPositive
        """
    ).single()
    print(f"sold rows with a realised price : {r['soldRealised']}")
    print(f"  now carrying priceRealisedGBP : {r['withGBP']}")
    print(f"  GBP rows where GBP <> native  : {r['gbpMismatch']}  (expected 0)")
    print(f"  non-positive GBP values       : {r['nonPositive']}  (expected 0)")
    comps = session.run(
        """
        MATCH (s:SourceRecord)
        WHERE s.sourceType='auction' AND s.sold=true AND s.priceRealisedGBP IS NOT NULL
          AND s.saleDate IS NOT NULL
        RETURN count(*) AS datedComps
        """
    ).single()
    print(f"\nusable dated GBP comparables    : {comps['datedComps']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--refresh-rates", action="store_true")
    ap.add_argument("--force", action="store_true", help="recompute rows already backfilled")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                verify(session)
                return
            book = RateBook(load_rates(args.refresh_rates))
            print(f"rate book: {len(book.days)} publication days from {book.earliest}\n")
            if run(session, book, args.force, args.dry_run) and not args.dry_run:
                print()
                verify(session)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
