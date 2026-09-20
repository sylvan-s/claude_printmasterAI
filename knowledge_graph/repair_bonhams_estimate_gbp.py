"""
PrintMasterAI — repair `estimateLowGBP`/`estimateHighGBP` on auction SourceRecords.
Version: ESTIMATE-GBP-REPAIR-1.0

`bonhams_ingest.py` (through BONHAMS-INGEST-1.0) stored Bonhams' own `pricing.gbp_low_estimate`
/ `gbp_high_estimate` as `estimateLowGBP`/`estimateHighGBP`, on the reasoning that the source's
own conversion was DIRECT data. It is not an estimate once a lot has sold: Bonhams' API
overwrites both fields with the SOLD price in GBP, so on every sold row the two are equal to
each other and — for GBP-native sales — exactly equal to the hammer. Measured 2026-09-13 across
the whole graph, not one artist:

    Bonhams  sold  38,602 rows with a real native spread -> 38,602 have GBP low == GBP high
    Skinner  sold   1,249                                ->  1,249
    GBP-native subset: 15,386 rows, all with estimateLowGBP == hammerPriceGBP exactly
    USD subset:        24,437 rows, GBP value = hammer at ~1.35 (a 2026 rate, not the sale date's)

The native `estimateLow`/`estimateHigh` are real and distinct on those same rows, and every
sold row already carries `fxRateToGBP` — native units per GBP on the sale date, written by
`backfill_fx_gbp.py`. So the correct value is pure arithmetic on data already in the graph:

    estimateLowGBP  = estimateLow  / fxRateToGBP
    estimateHighGBP = estimateHigh / fxRateToGBP        (rounded to 2 dp, as the backfill rounds)

Scope is every auction SourceRecord with `estimateLow > 0` and `fxRateToGBP > 0`, not just the
Bonhams adapter. Roseberys and Forum never had GBP estimate properties at all (GBP-native, so
the ingests never wrote one); for them this is a FILL from null rather than a repair, and it is
what lets `query_comparables.ts` read the stored property for every house instead of deriving
native / FX per request. Unsold rows carry no `fxRateToGBP` (the backfill only converts priced
rows) and are left untouched — their Bonhams-supplied values are genuine estimates, at
Bonhams' rate, and nothing downstream reads estimates on unsold rows.

Same discipline as `repair_bonhams_price_realised.py`: the pre-repair values are kept on the
node under `estimateLowGBPBeforeRepair`/`estimateHighGBPBeforeRepair`, every touched row gets a
durable `estimateGBPRepairedAt` marker (which excludes it from later runs unless --force), and
the FULL set of affected properties is written to a JSON snapshot BEFORE the first write.
`priceRealised`/`hammerPrice` and their GBP forms are never touched.

  python3 knowledge_graph/repair_bonhams_estimate_gbp.py --dry-run     # report + snapshot, no writes
  python3 knowledge_graph/repair_bonhams_estimate_gbp.py               # snapshot, apply, verify
  python3 knowledge_graph/repair_bonhams_estimate_gbp.py --verify      # post-hoc audit only
  python3 knowledge_graph/repair_bonhams_estimate_gbp.py --force       # recompute already-repaired rows

Requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD (set -a; source knowledge_graph/.env; set +a).
"""

import argparse
import json
import os
from datetime import datetime, timezone

from neo4j import GraphDatabase

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

HERE = os.path.dirname(os.path.abspath(__file__))
REPAIR_TAG = "estimate-gbp-from-native-fx-1.0"
BATCH = 5000
# hammerPriceGBP is round(native / rate, 2); a 2-dp value can differ from the unrounded
# quotient by at most 0.005, so 0.011 separates "consistent" from "wrong" with margin.
TOL = 0.011

# Label-scoped: `:SourceRecord` must stay on the MATCH or no property index is used.
SELECT = """
MATCH (s:SourceRecord)
WHERE s.sourceType = 'auction'
  AND s.estimateLow > 0
  AND s.fxRateToGBP > 0
  AND ($force OR s.estimateGBPRepairedAt IS NULL)
RETURN s.id AS id, s.institutionName AS inst, s.priceCurrency AS cur, s.sold AS sold,
       s.estimateLow AS low, s.estimateHigh AS high, s.fxRateToGBP AS fx,
       s.estimateLowGBP AS lowGBP, s.estimateHighGBP AS highGBP,
       s.hammerPriceGBP AS hammerGBP, s.estimateGBPRepairedAt AS repairedAt,
       s.estimateLowGBPBeforeRepair AS lowBefore, s.estimateHighGBPBeforeRepair AS highBefore
"""

# The old values are captured in a WITH before the SET so no SET item can observe another's
# write. On a --force re-run the BeforeRepair fields keep the ORIGINAL pre-repair values —
# overwriting them with the already-repaired value would destroy the audit trail.
WRITE = """
UNWIND $rows AS row
MATCH (s:SourceRecord {id: row.id})
WITH s, row,
     CASE WHEN s.estimateGBPRepairedAt IS NULL THEN s.estimateLowGBP  ELSE s.estimateLowGBPBeforeRepair  END AS lowBefore,
     CASE WHEN s.estimateGBPRepairedAt IS NULL THEN s.estimateHighGBP ELSE s.estimateHighGBPBeforeRepair END AS highBefore
SET s.estimateLowGBPBeforeRepair = lowBefore,
    s.estimateHighGBPBeforeRepair = highBefore,
    s.estimateLowGBP = row.lowGBP,
    s.estimateHighGBP = row.highGBP,
    s.estimateGBPRepairedAt = $now,
    s.estimateGBPRepair = $tag
RETURN count(s) AS n
"""


def to_gbp(native, fx):
    if native is None or not native > 0:
        return None
    return round(native / fx, 2)


def plan(rows):
    out = []
    for r in rows:
        out.append({"id": r["id"], "lowGBP": to_gbp(r["low"], r["fx"]), "highGBP": to_gbp(r["high"], r["fx"])})
    return out


def classify(r):
    """What the stored value looks like BEFORE the repair, for the per-house report."""
    if r["lowGBP"] is None and r["highGBP"] is None:
        return "null (fill)"
    native_distinct = r["high"] is not None and r["low"] != r["high"]
    if native_distinct and r["lowGBP"] == r["highGBP"]:
        return "collapsed (GBP low == GBP high)"
    new_low = to_gbp(r["low"], r["fx"])
    if new_low is not None and r["lowGBP"] is not None and abs(r["lowGBP"] - new_low) <= TOL:
        return "already consistent"
    return "other mismatch"


def report(rows):
    print(f"eligible rows (estimateLow > 0 AND fxRateToGBP > 0): {len(rows)}")
    by = {}
    for r in rows:
        key = (r["inst"], classify(r))
        by[key] = by.get(key, 0) + 1
    for (inst, cls), n in sorted(by.items()):
        print(f"  {inst:<18} {cls:<34} n={n:>6}")
    no_high = sum(1 for r in rows if r["high"] is None or not r["high"] > 0)
    if no_high:
        print(f"\n  NOTE: {no_high} row(s) have a native low but no positive native high — "
              f"their estimateHighGBP will be cleared, not invented.")
    eq_hammer = sum(1 for r in rows if r["hammerGBP"] is not None and r["lowGBP"] is not None
                    and abs(r["lowGBP"] - r["hammerGBP"]) < 0.01
                    and r["high"] is not None and r["low"] != r["high"])
    print(f"\n  rows whose stored estimateLowGBP == hammerPriceGBP (native spread real): {eq_hammer}")
    print("  (bug signature on GBP-native sales; after repair only genuine hammer-at-low-estimate sales remain)")


def snapshot(rows, path):
    payload = {
        "version": REPAIR_TAG,
        "takenAt": datetime.now(timezone.utc).isoformat(),
        "rowCount": len(rows),
        "properties": ["estimateLow", "estimateHigh", "fxRateToGBP", "estimateLowGBP", "estimateHighGBP",
                       "hammerPriceGBP", "estimateGBPRepairedAt",
                       "estimateLowGBPBeforeRepair", "estimateHighGBPBeforeRepair"],
        "rows": rows,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"\npre-repair snapshot of {len(rows)} rows -> {path}")


def apply(session, rows):
    now = datetime.now(timezone.utc).isoformat()
    todo = plan(rows)
    written = 0
    for i in range(0, len(todo), BATCH):
        written += session.run(WRITE, rows=todo[i:i + BATCH], now=now, tag=REPAIR_TAG).single()["n"]
        print(f"  written {written}/{len(todo)}", end="\r")
    print(f"\nrepaired {written} SourceRecord(s).")
    return written


def verify(session):
    r = session.run(
        """
        MATCH (s:SourceRecord)
        WHERE s.sourceType = 'auction' AND s.sold = true
          AND s.estimateLow > 0 AND s.fxRateToGBP > 0
        WITH s, (s.estimateHigh IS NOT NULL AND s.estimateLow <> s.estimateHigh) AS nativeDistinct
        RETURN count(*) AS eligible,
               sum(CASE WHEN s.estimateGBPRepairedAt IS NOT NULL THEN 1 ELSE 0 END) AS marked,
               sum(CASE WHEN s.estimateLowGBP IS NULL THEN 1 ELSE 0 END) AS lowNull,
               sum(CASE WHEN nativeDistinct AND s.estimateLowGBP = s.estimateHighGBP THEN 1 ELSE 0 END) AS collapsed,
               sum(CASE WHEN abs(s.estimateLowGBP - s.estimateLow / s.fxRateToGBP) > $tol THEN 1 ELSE 0 END) AS lowInconsistent,
               sum(CASE WHEN s.estimateHigh > 0 AND abs(s.estimateHighGBP - s.estimateHigh / s.fxRateToGBP) > $tol THEN 1 ELSE 0 END) AS highInconsistent,
               sum(CASE WHEN s.priceCurrency = 'GBP' AND s.estimateLowGBP <> s.estimateLow THEN 1 ELSE 0 END) AS gbpNativeMismatch,
               sum(CASE WHEN nativeDistinct AND s.hammerPriceGBP IS NOT NULL
                             AND abs(s.estimateLowGBP - s.hammerPriceGBP) < 0.01 THEN 1 ELSE 0 END) AS lowEqHammer
        """,
        tol=TOL,
    ).single()
    print(f"sold auction rows with native estimate + FX : {r['eligible']}")
    print(f"  carrying estimateGBPRepairedAt            : {r['marked']}")
    print(f"  estimateLowGBP still null                 : {r['lowNull']}  (expected 0)")
    print(f"  GBP low == GBP high with real native spread: {r['collapsed']}  (expected 0 — the bug signature)")
    print(f"  estimateLowGBP  <> estimateLow  / fx      : {r['lowInconsistent']}  (expected 0)")
    print(f"  estimateHighGBP <> estimateHigh / fx      : {r['highInconsistent']}  (expected 0)")
    print(f"  GBP-native rows where GBP <> native       : {r['gbpNativeMismatch']}  (expected 0)")
    print(f"  estimateLowGBP == hammerPriceGBP          : {r['lowEqHammer']}  "
          f"(all houses; genuine hammer-at-low-estimate sales only — the Bonhams-adapter subset was "
          f"15,386 before repair and 5,132 after)")
    bad = r["collapsed"] + r["lowInconsistent"] + r["highInconsistent"] + r["gbpNativeMismatch"] + r["lowNull"]
    return bad == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report and snapshot only, no writes")
    ap.add_argument("--verify", action="store_true", help="post-hoc audit, no writes")
    ap.add_argument("--force", action="store_true", help="recompute rows already carrying the repair marker")
    ap.add_argument("--backup", help="snapshot path (default: knowledge_graph/estimate_gbp_repair_presnapshot_<ts>.json)")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                ok = verify(session)
                raise SystemExit(0 if ok else 1)
            rows = session.run(SELECT, force=args.force).data()
            report(rows)
            if not rows:
                print("\nnothing to do — already repaired.")
                return
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
            path = args.backup or os.path.join(HERE, f"estimate_gbp_repair_presnapshot_{ts}.json")
            snapshot(rows, path)
            if args.dry_run:
                print("\n--dry-run: no writes made.")
                return
            apply(session, rows)
            print()
            ok = verify(session)
            raise SystemExit(0 if ok else 1)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
