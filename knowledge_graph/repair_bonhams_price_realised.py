"""
PrintMasterAI — repair inflated `priceRealised` on Bonhams-adapter SourceRecords.
Version: BONHAMS-PRICE-REALISED-REPAIR-1.0

`bonhams_ingest.py` originally read `pricing.hammer_premium` as the buyer's-premium
AMOUNT and wrote `priceRealised = hammer_price + hammer_premium`. The field is actually
the premium-INCLUSIVE TOTAL — the figure Bonhams' own lot pages print as "Sold for X
inc. premium" — so every sold row was inflated by one whole hammer price:

    stored priceRealised = hammer + true_realised     ->  true_realised = stored - hammer

Confirmed against live Bonhams pages in two currencies (sale 26785 lot 179 -> "Sold for
GBP892.50 inc. premium" against hammer 700.0; sale 15403 lot 330 -> "Sold for US$2,160
inc. premium" against hammer 1800.0) and by sign test over all 59,824 eligible SOLD rows
in the export, not one of which has hammer_premium < hammer_price. See
`bonhams_ingest.py` docstring item 5.

The correction is pure arithmetic on data already in the graph — no re-scrape needed.

Scope. Only SourceRecords written by THIS adapter, identified by their `id` prefix
(`bonhams-<sale>-<lot>-record`), which covers both brands it loads — Bonhams AND Skinner.
Scoping by `institutionName = 'Bonhams'` alone would silently miss Skinner's 1,251 rows.
Roseberys/Forum are deliberately untouched: they are different adapters with different
price semantics, and a handful of Roseberys rows independently exceed the ratio guard for
unrelated reasons (logged, not corrected here).

Idempotency is enforced TWO ways, deliberately belt-and-braces:
  1. the ratio guard `priceRealised > hammerPrice * 1.35` — no real buyer's premium
     reaches 35%, so an uncorrected row always trips it (its ratio is 1 + true_ratio,
     i.e. >= 2.0) and a corrected row normally does not; and
  2. a durable `premiumBasisCorrectedAt` marker, which corrected rows carry and which
     this script excludes on every subsequent run.

The marker is what actually makes this safe rather than the ratio: two rows in the source
(sale 30860 lots 81 and 120) have genuine inclusive ratios of 1.455 and 3.328 — bad
source data, a 233% "premium" is not real — and a ratio-only guard would re-correct those
on a second run, driving them negative. The marker prevents that. They are corrected once
like everything else and then flagged for review rather than silently normalised.

  python3 knowledge_graph/repair_bonhams_price_realised.py --dry-run   # report only
  python3 knowledge_graph/repair_bonhams_price_realised.py             # apply
  python3 knowledge_graph/repair_bonhams_price_realised.py --verify    # post-hoc audit
"""

import argparse
import os
from datetime import datetime, timezone

from neo4j import GraphDatabase

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

CORRECTION_TAG = "bonhams-premium-basis-1.0"
GUARD_RATIO = 1.35

# Label-scoped and prefix-scoped. The :SourceRecord label must stay on the MATCH or a
# property index cannot be used for it at all (see the ULAN backfill's notes).
TARGET = """
MATCH (s:SourceRecord)
WHERE s.id STARTS WITH 'bonhams-'
  AND s.sold = true
  AND s.hammerPrice IS NOT NULL
  AND s.priceRealised IS NOT NULL
  AND s.priceRealised > s.hammerPrice * $guard
  AND s.premiumBasisCorrectedAt IS NULL
"""


def report(session, guard):
    rows = session.run(
        TARGET + """
        RETURN s.institutionName AS inst, count(*) AS n,
               sum(s.priceRealised) AS storedTotal,
               sum(s.priceRealised - s.hammerPrice) AS correctedTotal
        ORDER BY n DESC
        """,
        guard=guard,
    ).data()
    total = sum(r["n"] for r in rows)
    print(f"eligible for correction: {total}")
    for r in rows:
        print(
            f"  {r['inst']:<10} n={r['n']:>6}  "
            f"sum(stored)={r['storedTotal']:,.0f} -> sum(corrected)={r['correctedTotal']:,.0f}"
        )

    # Anything that would still look wrong AFTER correction is bad source data, not a
    # failure of this repair. Surface it; do not quietly normalise it.
    odd = session.run(
        TARGET + """
        WITH s, (s.priceRealised - s.hammerPrice) / s.hammerPrice AS trueRatio
        WHERE trueRatio > $guard OR trueRatio < 1.0
        RETURN s.id AS id, s.institutionName AS inst, s.hammerPrice AS hammer,
               s.priceRealised AS stored, round(trueRatio, 3) AS trueRatio
        ORDER BY trueRatio DESC LIMIT 25
        """,
        guard=guard,
    ).data()
    if odd:
        print(f"\n  NOTE: {len(odd)} row(s) have an implausible ratio even after correction")
        print("  (bad source data — corrected once, then flagged; NOT re-corrected on rerun):")
        for r in odd:
            print(
                f"    {r['id']:<28} {r['inst']:<8} hammer={r['hammer']:>10,.0f} "
                f"stored={r['stored']:>11,.0f} trueRatio={r['trueRatio']}"
            )
    return total


def apply(session, guard):
    now = datetime.now(timezone.utc).isoformat()
    res = session.run(
        TARGET + """
        WITH s, s.priceRealised AS stored
        SET s.priceRealised = stored - s.hammerPrice,
            s.priceRealisedBeforeCorrection = stored,
            s.premiumBasisCorrectedAt = $now,
            s.premiumBasisCorrection = $tag
        RETURN count(s) AS changed
        """,
        guard=guard, now=now, tag=CORRECTION_TAG,
    ).single()
    return res["changed"]


def verify(session, guard):
    r = session.run(
        """
        MATCH (s:SourceRecord)
        WHERE s.id STARTS WITH 'bonhams-' AND s.sold = true
          AND s.hammerPrice IS NOT NULL AND s.priceRealised IS NOT NULL
        RETURN count(*) AS soldBoth,
               sum(CASE WHEN s.priceRealised > s.hammerPrice * $guard THEN 1 ELSE 0 END) AS stillOverGuard,
               sum(CASE WHEN s.priceRealised < s.hammerPrice THEN 1 ELSE 0 END) AS belowHammer,
               sum(CASE WHEN s.premiumBasisCorrectedAt IS NOT NULL THEN 1 ELSE 0 END) AS corrected
        """,
        guard=guard,
    ).single()
    print(f"sold rows with both prices : {r['soldBoth']}")
    print(f"  carrying correction marker : {r['corrected']}")
    print(f"  still above {guard}x guard     : {r['stillOverGuard']}  (expected: only bad-source rows)")
    print(f"  priceRealised < hammerPrice: {r['belowHammer']}  (expected 0 — would mean over-correction)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, no writes")
    ap.add_argument("--verify", action="store_true", help="post-hoc audit, no writes")
    ap.add_argument("--guard", type=float, default=GUARD_RATIO)
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                verify(session, args.guard)
                return
            eligible = report(session, args.guard)
            if args.dry_run:
                print("\n--dry-run: no writes made.")
                return
            if not eligible:
                print("\nnothing to do — already corrected.")
                return
            changed = apply(session, args.guard)
            print(f"\ncorrected {changed} SourceRecord(s).\n")
            verify(session, args.guard)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
