"""
PrintMasterAI — backfill `estimateLowGBP`/`estimateHighGBP` on Roseberys SourceRecords missing it.
Version: ROSEBERYS-ESTIMATE-GBP-BACKFILL-1.0

`roseberys_ingest.py` (through ROSEBERYS-INGEST-1.0) never wrote `estimateLowGBP`/
`estimateHighGBP` at all — only the native `estimateLow`/`estimateHigh`. Sold rows ended up
with the GBP fields anyway, but only as a side effect of `repair_bonhams_estimate_gbp.py`,
which fills `estimateLowGBP = estimateLow / fxRateToGBP` for every auction row (not just
Bonhams') that has both a positive `estimateLow` and a positive `fxRateToGBP`. `fxRateToGBP`
is only ever set by `backfill_fx_gbp.py`, and only on rows with a hammer or realised price —
i.e. sold rows with a recorded price. Unsold rows never got one, so the repair silently
skipped every unsold Roseberys `SourceRecord`: confirmed 2026-09-14, all 3,846 had NULL
estimateLowGBP/HighGBP while `catalogue.csv` has the estimate for 5,164/5,170 (99.9%) of the
matching unsold rows. The same gap also hit 92 `sold=true` rows that carry no hammer/realised
price despite being marked sold, for the identical reason (no price -> no `fxRateToGBP`) — this
script backfills both subsets, matched purely on "missing the GBP estimate", not on `sold`.

Fixed at the source in `roseberys_ingest.py` (ROSEBERYS-INGEST-1.1): `estimateLowGBP`/
`estimateHighGBP` are now written directly from `estimateLow`/`estimateHigh` at ingest time,
regardless of `sold`, because Roseberys' `priceCurrency` is always "GBP" — no FX lookup is
needed or correct here, unlike Bonhams' mixed-currency source. This script is the one-off
backfill for the rows already in the graph from before that fix, reading the exact same
`catalogue.csv` the ingest reads. `SourceRecord.id` is `roseberys-<sale_code lower>-lot<lot_number>-record`,
deterministic from two CSV columns — matched EXACTLY, no fuzzy join (see
`catalogue_matching.py`'s docstring on why fuzzy matching on this project has twice corrupted
the graph). No name/title matching happens here at all.

Same discipline as `repair_bonhams_estimate_gbp.py`: pre-repair values (expected NULL here)
are kept under `estimateLowGBPBeforeBackfill`/`estimateHighGBPBeforeBackfill`, every touched
row gets a durable `estimateGBPBackfillAt` marker (excluded from later runs unless --force),
and the full set of affected rows is snapshotted to JSON before the first write.

  python3 knowledge_graph/backfill_roseberys_estimate_gbp.py --dry-run     # report + snapshot, no writes
  python3 knowledge_graph/backfill_roseberys_estimate_gbp.py               # snapshot, apply, verify
  python3 knowledge_graph/backfill_roseberys_estimate_gbp.py --verify      # post-hoc audit only
  python3 knowledge_graph/backfill_roseberys_estimate_gbp.py --force       # recompute already-backfilled rows

Requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD (set -a; source knowledge_graph/.env; set +a).
"""

import argparse
import json
import os
from datetime import datetime, timezone

import pandas as pd
from neo4j import GraphDatabase

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE_CSV_PATH = os.path.join(HERE, "..", "benchmark", "data", "all-prints", "catalogue.csv")
INSTITUTION = "Roseberys London"
BACKFILL_TAG = "estimate-gbp-from-catalogue-1.0"
BATCH = 5000


def source_rows():
    """Every Roseberys lot with a real (positive) native estimate, keyed by the exact
    SourceRecord.id the ingest derives — no fuzzy matching. Not restricted to unsold: 92
    `sold=true` rows have the identical gap (no hammer/realised price recorded despite
    `sold=true`, so `fxRateToGBP` was never set and `repair_bonhams_estimate_gbp.py` skipped
    them too) — same field, same institution, same cause, so the SELECT below (which only
    touches rows still missing a backfill marker) covers both."""
    df = pd.read_csv(CATALOGUE_CSV_PATH, low_memory=False)
    out = []
    for _, row in df.iterrows():
        low = row.get("low_estimate")
        high = row.get("high_estimate")
        if pd.isna(low) or not low > 0:
            continue
        sale_code = str(row["sale_code"])
        lot_number = int(row["lot_number"])
        out.append({
            "id": f"roseberys-{sale_code.lower()}-lot{lot_number}-record",
            "low": float(low),
            "high": float(high) if pd.notna(high) and high > 0 else None,
        })
    return out


# Label-scoped: `:SourceRecord` must stay on the MATCH or no property index is used.
SELECT = """
UNWIND $candidates AS c
MATCH (s:SourceRecord {id: c.id})
WHERE s.institutionName = $institution
  AND ($force OR s.estimateGBPBackfillAt IS NULL)
  AND ($force OR s.estimateLowGBP IS NULL OR s.estimateHighGBP IS NULL)
RETURN s.id AS id, s.estimateLow AS graphLow, s.estimateHigh AS graphHigh,
       s.estimateLowGBP AS lowGBP, s.estimateHighGBP AS highGBP,
       c.low AS csvLow, c.high AS csvHigh
"""

WRITE = """
UNWIND $rows AS row
MATCH (s:SourceRecord {id: row.id})
WITH s, row,
     CASE WHEN s.estimateGBPBackfillAt IS NULL THEN s.estimateLowGBP  ELSE s.estimateLowGBPBeforeBackfill  END AS lowBefore,
     CASE WHEN s.estimateGBPBackfillAt IS NULL THEN s.estimateHighGBP ELSE s.estimateHighGBPBeforeBackfill END AS highBefore
SET s.estimateLowGBPBeforeBackfill = lowBefore,
    s.estimateHighGBPBeforeBackfill = highBefore,
    s.estimateLowGBP = row.low,
    s.estimateHighGBP = row.high,
    s.estimateGBPBackfillAt = $now,
    s.estimateGBPBackfill = $tag
RETURN count(s) AS n
"""


def plan(session, force):
    candidates = source_rows()
    rows = session.run(SELECT, candidates=candidates, institution=INSTITUTION, force=force).data()
    mismatched = [r for r in rows if r["graphLow"] is not None and r["graphLow"] != r["csvLow"]]
    return rows, mismatched, len(candidates)


def snapshot(rows, path):
    payload = {
        "version": BACKFILL_TAG,
        "takenAt": datetime.now(timezone.utc).isoformat(),
        "rowCount": len(rows),
        "properties": ["estimateLow", "estimateHigh", "estimateLowGBP", "estimateHighGBP",
                       "estimateGBPBackfillAt"],
        "rows": rows,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"\npre-backfill snapshot of {len(rows)} rows -> {path}")


def apply(session, rows):
    todo = [{"id": r["id"], "low": r["csvLow"], "high": r["csvHigh"]} for r in rows]
    now = datetime.now(timezone.utc).isoformat()
    written = 0
    for i in range(0, len(todo), BATCH):
        written += session.run(WRITE, rows=todo[i:i + BATCH], now=now, tag=BACKFILL_TAG).single()["n"]
        print(f"  written {written}/{len(todo)}", end="\r")
    print(f"\nbackfilled {written} SourceRecord(s).")
    return written


def verify(session):
    rows = session.run(
        """
        MATCH (s:SourceRecord {institutionName: $institution})
        WHERE s.sourceType = 'auction' AND s.saleDate IS NOT NULL AND s.estimateLow > 0
        RETURN s.sold AS sold, count(*) AS n,
               sum(CASE WHEN s.estimateLowGBP IS NOT NULL AND s.estimateHighGBP IS NOT NULL
                         THEN 1 ELSE 0 END) AS withEst,
               sum(CASE WHEN s.estimateLowGBP IS NOT NULL AND s.estimateLowGBP <> s.estimateLow
                         THEN 1 ELSE 0 END) AS gbpNativeMismatch
        """, institution=INSTITUTION).data()
    bad = 0
    for r in sorted(rows, key=lambda r: r["sold"]):
        print(f"sold={r['sold']!s:<5} dated Roseberys auction rows with a native estimate : {r['n']}")
        print(f"  now carrying a GBP estimate                                  : {r['withEst']}")
        print(f"  estimateLowGBP <> estimateLow (GBP-native mismatch)          : {r['gbpNativeMismatch']}  (expected 0)")
        bad += r["gbpNativeMismatch"]
    return bad == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report and snapshot only, no writes")
    ap.add_argument("--verify", action="store_true", help="post-hoc audit, no writes")
    ap.add_argument("--force", action="store_true", help="recompute rows already carrying the backfill marker")
    ap.add_argument("--backup", help="snapshot path (default: knowledge_graph/roseberys_estimate_gbp_backfill_presnapshot_<ts>.json)")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                ok = verify(session)
                raise SystemExit(0 if ok else 1)

            rows, mismatched, n_candidates = plan(session, args.force)
            print(f"candidates from catalogue.csv (positive low_estimate): {n_candidates}")
            print(f"eligible graph rows (matched, not yet backfilled): {len(rows)}")
            if mismatched:
                print(f"\n  WARNING: {len(mismatched)} row(s) have a graph estimateLow that disagrees "
                      f"with catalogue.csv's low_estimate — skipping those, not overwriting a native "
                      f"value that may have been corrected since ingest:")
                for m in mismatched[:10]:
                    print(f"    {m['id']}: graph={m['graphLow']} csv={m['csvLow']}")
                rows = [r for r in rows if r["graphLow"] is None or r["graphLow"] == r["csvLow"]]
                print(f"  proceeding with {len(rows)} row(s).")

            if not rows:
                print("\nnothing to do.")
                return

            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
            path = args.backup or os.path.join(HERE, f"roseberys_estimate_gbp_backfill_presnapshot_{ts}.json")
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
