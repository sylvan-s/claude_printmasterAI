"""
PrintMasterAI — derived hammer prices for Swann Auction Galleries records.
Version: SWANN-HAMMER-DERIVED-1.0

    python3 backfill_swann_hammer.py              # dry run: counts and a sample, nothing written
    python3 backfill_swann_hammer.py --apply

WHY. Swann publishes one post-sale figure, the price including buyer's premium, in USD, and
swann_ingest.py deliberately leaves `hammerPrice` unmapped rather than guess the premium. Every
consumer of comparables filters on `hammerPriceGBP > 0`, so all 10,392 sold Swann records were
invisible to Stage 3a: A0793 lot 2 (Villon, Le Petit Équilibriste) matched three Swann sales of the
same print and gave them 0% weight.

WHAT. User decision 2026-09-17: derive hammer = priceRealised / 1.26 (a flat 26% premium). Written the
way Roseberys derived hammers already are — `hammerBasis = 'derived'`, `premiumRatioUsed` — so a
reader can always tell a derived hammer from a reported one. GBP values use the ECB reference rate on
the nearest publication day at or before the sale (backfill_fx_gbp.RateBook, the same rate book as
every other GBP value in the graph), and the estimates get GBP values on that date too.

A flat ratio is an approximation: Swann's premium schedule has tiers and has changed over the years.
It is stored as a property so a later, schedule-aware pass can recompute exactly these rows
(`hammerDerivedBy = 'SWANN-HAMMER-DERIVED-1.0'`).

NOT TOUCHED. Records that already carry a hammer price from any other source. Unsold records get GBP
estimates only. Re-run after a Swann ingest: new records arrive without a hammer.

KNOCK-ON, not done here: blend/house_offsets.json has no measured Swann level (it was fitted when
Swann had no hammers), so Swann comps are re-based with the pooled fallback and a widened range until
house_offsets.py is re-run.
"""
import argparse
import datetime
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backfill_fx_gbp import RateBook, load_rates  # noqa: E402

VERSION = "SWANN-HAMMER-DERIVED-1.0"
PREMIUM_RATIO = 1.26
FX_SOURCE = "ECB daily reference (frankfurter.app), base GBP"

SELECT = """
MATCH (s:SourceRecord {institutionName: 'Swann Auction Galleries'})
WHERE s.sourceType = 'auction' AND s.saleDate IS NOT NULL
  AND (s.hammerPrice IS NULL OR s.hammerDerivedBy = $version)
RETURN s.id AS id, s.sold AS sold, s.priceCurrency AS cur, left(s.saleDate, 10) AS day,
       s.priceRealised AS realised, s.estimateLow AS estLow, s.estimateHigh AS estHigh
"""

WRITE = """
UNWIND $rows AS row
MATCH (s:SourceRecord {id: row.id})
SET s.fxRateToGBP = row.rate, s.fxRateDate = row.rateDate, s.fxSource = $fxSource,
    s.estimateLowGBP = row.estLowGBP, s.estimateHighGBP = row.estHighGBP,
    s.hammerDerivedBy = $version, s.hammerDerivedAt = datetime()
FOREACH (_ IN CASE WHEN row.hammer IS NULL THEN [] ELSE [1] END |
    SET s.hammerPrice = row.hammer, s.hammerPriceGBP = row.hammerGBP, s.priceRealisedGBP = row.realisedGBP,
        s.hammerBasis = 'derived', s.premiumRatioUsed = $ratio)
RETURN count(s) AS n
"""


def main():
    ap = argparse.ArgumentParser(description="Derive Swann hammer prices at a flat 26% premium.")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    book = RateBook(load_rates(False))
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with drv.session(database=os.environ.get("NEO4J_DATABASE") or "neo4j") as s:
        recs = [dict(r) for r in s.run(SELECT, version=VERSION)]
        rows, skipped = [], {}
        for r in recs:
            cur = r["cur"] or "USD"
            rate, rate_day = (1.0, r["day"]) if cur == "GBP" else book.lookup(r["day"], cur)
            if not rate:
                skipped["no ECB rate for sale date"] = skipped.get("no ECB rate for sale date", 0) + 1
                continue
            hammer = round(r["realised"] / PREMIUM_RATIO, 2) if r["sold"] and r["realised"] and r["realised"] > 0 else None
            if r["sold"] and hammer is None:
                skipped["sold without a price"] = skipped.get("sold without a price", 0) + 1
            rows.append({
                "id": r["id"], "rate": rate, "rateDate": rate_day,
                "estLowGBP": round(r["estLow"] / rate, 2) if r["estLow"] else None,
                "estHighGBP": round(r["estHigh"] / rate, 2) if r["estHigh"] else None,
                "hammer": hammer, "hammerGBP": round(hammer / rate, 2) if hammer else None,
                "realisedGBP": round(r["realised"] / rate, 2) if hammer else None,
            })
        derived = [x for x in rows if x["hammer"]]
        print(f"{len(recs)} Swann records selected; {len(derived)} get a derived hammer, "
              f"{len(rows) - len(derived)} (unsold) get GBP estimates only; skipped {skipped or 'none'}")
        for x in derived[:3]:
            print(f"  {x['id']}: realised -> hammer {x['hammer']} USD = £{x['hammerGBP']} at {x['rate']} ({x['rateDate']})")
        if not args.apply:
            print("dry run: nothing written. Re-run with --apply.")
            return
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        snap = f"swann_hammer_presnapshot_{stamp}.json"
        before = [dict(r) for r in s.run(
            "MATCH (s:SourceRecord) WHERE s.id IN $ids RETURN s.id AS id, s.hammerPrice AS hammerPrice, s.hammerPriceGBP AS hammerPriceGBP, "
            "s.priceRealisedGBP AS priceRealisedGBP, s.estimateLowGBP AS estimateLowGBP, s.estimateHighGBP AS estimateHighGBP, "
            "s.fxRateToGBP AS fxRateToGBP, s.fxRateDate AS fxRateDate, s.fxSource AS fxSource, s.hammerBasis AS hammerBasis",
            ids=[x["id"] for x in rows])]
        json.dump(before, open(snap, "w"), indent=1, default=str)
        n = 0
        for i in range(0, len(rows), 1000):
            n += s.run(WRITE, rows=rows[i:i + 1000], version=VERSION, ratio=PREMIUM_RATIO, fxSource=FX_SOURCE).single()["n"]
        print(f"snapshot -> {snap}; {n} records written")
    drv.close()


if __name__ == "__main__":
    main()
