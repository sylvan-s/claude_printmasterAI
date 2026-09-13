"""
PrintMasterAI — regression guard for `estimateLowGBP`/`estimateHighGBP` on Bonhams-adapter rows.

Exists because of a silent data-corruption bug, same reason as check_bonhams_name_parsing.py.
Bonhams' API fields `pricing.gbp_low_estimate`/`gbp_high_estimate` are overwritten with the
SOLD price in GBP once a lot sells, so storing them as the GBP estimate put the hammer into both
estimate slots on every one of 39,851 sold Bonhams/Skinner rows (found and repaired 2026-09-13;
see repair_bonhams_estimate_gbp.py). Nothing about that was loud: the values were plausible
numbers in the right currency, and `hammer == low estimate` is a real auction outcome.

Two invariants, both checked here:

  CODE   `bonhams_ingest.map_record()` must never emit a GBP estimate taken from the API, and
         LOAD_QUERY must not write one. The GBP forms are derived from native x sale-date FX by
         `backfill_fx_gbp.py`, the single place every GBP conversion in the graph comes from.
  GRAPH  No sold Bonhams-adapter row may have estimateLowGBP == hammerPriceGBP while the native
         low != high UNLESS that GBP value is consistent with estimateLow / fxRateToGBP — the
         "unless" is what separates the bug from a lot that genuinely sold at its low estimate
         (a common result). The collapsed shape (GBP low == GBP high with a real native spread)
         is checked outright: that never has an honest explanation.

    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/check_bonhams_estimate_gbp.py          # exits 1 on regression
"""

import os
import sys

from neo4j import GraphDatabase

# Same tolerance as the repair: hammerPriceGBP and the estimates are rounded to 2 dp.
TOL = 0.011

# A sold lot in the shape the API returns it post-sale: gbp_low == gbp_high == hammer in GBP.
SOLD_RECORD = {
    "lot_id": "999999",
    "auction": {"id": "12345", "brand": "bonhams", "sale_date": "2020-03-04T10:00:00+00:00"},
    "artist": "Andy Warhol",
    "title": "Test Lot",
    "catalog_description": (
        '<div class="LotName">Andy Warhol (American, 1928-1987)</div>'
        '<div class="LotDesc">Marilyn<br/>Screenprint in colours, 1967, signed in pencil, '
        "from the edition of 250, sheet 914 x 914mm.</div>"
    ),
    "status": "SOLD",
    "estimates": {"currency": "GBP", "low": 1000.0, "high": 1500.0},
    "pricing": {"hammer_price": 1000.0, "hammer_premium": 1250.0,
                "gbp_low_estimate": 1000.0, "gbp_high_estimate": 1000.0},
    "lot_number": "12",
    "url": "https://www.bonhams.com/auction/12345/lot/12/",
    "primary_image_url": None,
}

GRAPH_CHECK = """
MATCH (s:SourceRecord)
WHERE s.id STARTS WITH 'bonhams-' AND s.sold = true
  AND s.estimateLow IS NOT NULL AND s.estimateHigh IS NOT NULL AND s.estimateLow <> s.estimateHigh
RETURN count(*) AS soldWithSpread,
       sum(CASE WHEN s.estimateLowGBP IS NOT NULL AND s.estimateLowGBP = s.estimateHighGBP THEN 1 ELSE 0 END) AS collapsed,
       sum(CASE WHEN s.hammerPriceGBP IS NOT NULL AND abs(s.estimateLowGBP - s.hammerPriceGBP) < 0.01
                 THEN 1 ELSE 0 END) AS lowEqHammer,
       sum(CASE WHEN s.hammerPriceGBP IS NOT NULL AND abs(s.estimateLowGBP - s.hammerPriceGBP) < 0.01
                 AND s.fxRateToGBP > 0 AND abs(s.estimateLowGBP - s.estimateLow / s.fxRateToGBP) > $tol
                 THEN 1 ELSE 0 END) AS lowEqHammerAndWrong,
       sum(CASE WHEN s.fxRateToGBP > 0 AND s.estimateLowGBP IS NOT NULL
                 AND abs(s.estimateLowGBP - s.estimateLow / s.fxRateToGBP) > $tol THEN 1 ELSE 0 END) AS lowInconsistent,
       sum(CASE WHEN s.fxRateToGBP > 0 AND s.estimateHighGBP IS NOT NULL
                 AND abs(s.estimateHighGBP - s.estimateHigh / s.fxRateToGBP) > $tol THEN 1 ELSE 0 END) AS highInconsistent
"""


def main():
    from bonhams_ingest import LOAD_QUERY, map_record

    failures = []
    checked = 0

    # CODE invariant
    row = map_record(SOLD_RECORD)
    checked += 1
    for key in ("estimateLowGBP", "estimateHighGBP"):
        if row.get(key) is not None:
            failures.append(f"map_record() emits {key}={row[key]!r} for a sold lot — the API's GBP "
                            f"estimate is the sold price post-sale and must not be stored")
    if row["estimateLow"] != 1000.0 or row["estimateHigh"] != 1500.0:
        failures.append(f"map_record() lost the native estimate: {row['estimateLow']}/{row['estimateHigh']}")
    if row["hammerPrice"] != 1000.0:
        failures.append(f"map_record() hammerPrice changed: {row['hammerPrice']}")
    for token in ("row.estimateLowGBP", "row.estimateHighGBP", "gbp_low_estimate", "gbp_high_estimate"):
        checked += 1
        if token in LOAD_QUERY:
            failures.append(f"LOAD_QUERY writes {token} — GBP estimates must come from backfill_fx_gbp.py")

    # GRAPH invariant
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    try:
        with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
            r = session.run(GRAPH_CHECK, tol=TOL).single()
    finally:
        driver.close()
    checked += r["soldWithSpread"]
    print(f"[CHECK] {r['soldWithSpread']} sold Bonhams/Skinner rows with a real native spread scanned")
    print(f"        estimateLowGBP == hammerPriceGBP on {r['lowEqHammer']} "
          f"(genuine hammer-at-low-estimate sales; the bug made this every GBP-native row)")
    if r["collapsed"]:
        failures.append(f"{r['collapsed']} sold rows have estimateLowGBP == estimateHighGBP while native low != high "
                        f"(the sold-price-as-estimate signature) — run repair_bonhams_estimate_gbp.py")
    if r["lowEqHammerAndWrong"]:
        failures.append(f"{r['lowEqHammerAndWrong']} sold rows have estimateLowGBP == hammerPriceGBP AND that value "
                        f"is not estimateLow / fxRateToGBP")
    if r["lowInconsistent"] or r["highInconsistent"]:
        failures.append(f"{r['lowInconsistent']} low / {r['highInconsistent']} high GBP estimates disagree with "
                        f"native / fxRateToGBP by more than {TOL}")

    if failures:
        print(f"\n[FAIL] {len(failures)} regression(s):", file=sys.stderr)
        for f in failures:
            print(f"   {f}", file=sys.stderr)
        return 1
    print(f"[OK] {checked} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
