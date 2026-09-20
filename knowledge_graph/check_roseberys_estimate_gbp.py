"""
PrintMasterAI — regression guard for `estimateLowGBP`/`estimateHighGBP` on Roseberys rows.

Exists because of a silent ingest defect, found 2026-09-14 via `relist_discount_report.ts`'s
Roseberys section unexpectedly returning zero "previous unsold" pairs. `roseberys_ingest.py`
(through ROSEBERYS-INGEST-1.0) never wrote `estimateLowGBP`/`estimateHighGBP` at all — only
the native `estimateLow`/`estimateHigh`. Sold rows got the GBP fields anyway, but only as a
side effect of `repair_bonhams_estimate_gbp.py`, which fills them in from `estimateLow /
fxRateToGBP` for ANY auction row (not just Bonhams'); `fxRateToGBP` is only set by
`backfill_fx_gbp.py`, and only on rows with a hammer or realised price. Unsold rows never got
a `fxRateToGBP`, so the repair silently skipped every one of them — 3,846 unsold Roseberys
`SourceRecord`s had NULL `estimateLowGBP`/`HighGBP` while `catalogue.csv` had the real estimate
for 99.9% of the matching rows. Nothing about the failure was loud: sold rows looked complete,
and an unsold lot with no estimate just looks like a lot the ingest never got pricing for.

Fixed in ROSEBERYS-INGEST-1.1: `estimateLowGBP`/`estimateHighGBP` are now written directly
from `estimateLow`/`estimateHigh` at ingest time, regardless of `sold` — Roseberys is always
GBP-native (`priceCurrency` is always "GBP"), so no FX lookup is needed or correct here. The
pre-existing rows (3,846 unsold + 92 sold-but-unpriced) were backfilled by
`backfill_roseberys_estimate_gbp.py`.

Two invariants, both checked here:

  CODE   `roseberys_ingest.map_row()` must emit `estimateLowGBP == estimateLow` and
         `estimateHighGBP == estimateHigh` for BOTH sold and unsold rows, and LOAD_QUERY must
         write both.
  GRAPH  No dated Roseberys `SourceRecord` with a positive native `estimateLow` may have a
         NULL `estimateLowGBP`/`HighGBP` (the regression signature — this is what the sold-only
         write looked like), and every Roseberys row carrying both must have
         `estimateLowGBP == estimateLow` exactly (GBP-native, no FX rounding involved).

    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/check_roseberys_estimate_gbp.py          # exits 1 on regression
    python3 knowledge_graph/check_roseberys_estimate_gbp.py --no-db  # code checks only
"""

import argparse
import os
import sys

import pandas as pd
from neo4j import GraphDatabase

INSTITUTION = "Roseberys London"

GRAPH_CHECK = """
MATCH (s:SourceRecord {institutionName: $institution})
WHERE s.sourceType = 'auction' AND s.saleDate IS NOT NULL AND s.estimateLow > 0
RETURN s.sold AS sold,
       count(*) AS n,
       sum(CASE WHEN s.estimateLowGBP IS NULL OR s.estimateHighGBP IS NULL THEN 1 ELSE 0 END) AS missingGBP,
       sum(CASE WHEN s.estimateLowGBP IS NOT NULL AND s.estimateLowGBP <> s.estimateLow
                 THEN 1 ELSE 0 END) AS lowMismatch,
       sum(CASE WHEN s.estimateHighGBP IS NOT NULL AND s.estimateHighGBP <> s.estimateHigh
                 THEN 1 ELSE 0 END) AS highMismatch
"""


def check_code():
    from roseberys_ingest import LOAD_QUERY, map_row

    failures = []
    base = {"sale_code": "A9999", "lot_number": 1, "artist": "Test Artist",
            "low_estimate": 100.0, "high_estimate": 200.0}
    for sold_val, sold_expected in (("sold", True), ("unsold", False)):
        row = map_row(pd.Series({**base, "sold": sold_val}))
        if row["sold"] != sold_expected:
            failures.append(f"map_row() sold={sold_val!r} -> {row['sold']!r}, expected {sold_expected!r}")
        if row.get("estimateLowGBP") != 100.0 or row.get("estimateHighGBP") != 200.0:
            failures.append(
                f"map_row() sold={sold_val!r}: estimateLowGBP/HighGBP = "
                f"{row.get('estimateLowGBP')!r}/{row.get('estimateHighGBP')!r}, expected 100.0/200.0 "
                f"— the regression this guards against writes these only when sold")

    for token in ("row.estimateLowGBP", "row.estimateHighGBP"):
        if token not in LOAD_QUERY:
            failures.append(f"LOAD_QUERY does not write {token}")
    return failures


def check_graph():
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    failures = []
    try:
        with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
            rows = session.run(GRAPH_CHECK, institution=INSTITUTION).data()
    finally:
        driver.close()
    for r in rows:
        print(f"[CHECK] sold={r['sold']!s:<5} n={r['n']:>6}  missingGBP={r['missingGBP']:>5}  "
              f"lowMismatch={r['lowMismatch']:>3}  highMismatch={r['highMismatch']:>3}")
        if r["missingGBP"]:
            failures.append(
                f"{r['missingGBP']} Roseberys SourceRecord(s) with sold={r['sold']} have a positive "
                f"native estimate but NULL estimateLowGBP/HighGBP — run backfill_roseberys_estimate_gbp.py")
        if r["lowMismatch"] or r["highMismatch"]:
            failures.append(
                f"{r['lowMismatch']} low / {r['highMismatch']} high GBP estimate(s) with sold={r['sold']} "
                f"disagree with the native value — Roseberys is GBP-native, they must be exactly equal")
    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()

    failures = check_code()
    print(f"{'FAIL' if failures else 'ok  '}  code: map_row()/LOAD_QUERY write estimateLowGBP/HighGBP "
          f"for sold and unsold rows alike")

    if args.no_db:
        print("skip  live graph (--no-db)")
    else:
        graph_failures = check_graph()
        print(f"{'FAIL' if graph_failures else 'ok  '}  live graph: no dated, priced Roseberys row missing "
              f"a GBP estimate")
        failures += graph_failures

    if failures:
        print(f"\n[FAIL] {len(failures)} regression(s):", file=sys.stderr)
        for f in failures:
            print(f"   {f}", file=sys.stderr)
        return 1
    print("\n[OK] all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
