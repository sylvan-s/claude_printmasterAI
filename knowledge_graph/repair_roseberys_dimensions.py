"""
PrintMasterAI — fill dimensions dropped by the Roseberys ingest.
Version: ROSEBERYS-DIMS-REPAIR-1.0

`roseberys_ingest.py` (through ROSEBERYS-INGEST-1.0) routed the CSV's width_cm/height_cm into
sheet/image/plateDimensions by `dim_kind`, but only recognised sheet, overall, blank, image and
plate. The CSV also uses "each sheet", "size" and "block", and for those the ingest wrote all
three properties null. Measured 2026-09-16 across every Roseberys SourceRecord (13,109), joined
by saleId + lotNumber to the all-prints corpus plus the separately ingested A0793 extract:

    dim_kind "each sheet"  370 lots   (358 corpus + 12 A0793)
             "size"        148        (147 + 1)
             "block"         1
    total                  519 lots with CSV dimensions and no graph dimensions (348 sold)

Every one of the 519 is explained by the dim_kind mapping; no Roseberys lot with a mapped
dim_kind is missing its dimensions. The fix is in ROSEBERYS-INGEST-1.1 (`dimension_slots`),
and this script applies exactly that function to the graph rather than re-running the ingest,
which rewrites every property on the lot.

Scope: a Roseberys Impression is written ONLY if all three dimension properties are null now
and `dimension_slots` yields a value — it never overwrites an existing dimension. A lot whose
(saleId, lotNumber) matches more than one CSV row is skipped (A0503 lot 7 is duplicated in the
corpus; its graph lot already has dimensions, but the rule is kept general). Every written node
gets `dimensionsRepairedAt` / `dimensionsRepair`, and the full pre-write state is snapshotted
before the first write. The pre-write value is null on every target by construction, so undo
is `SET imp.sheetDimensions = null, imp.imageDimensions = null, imp.plateDimensions = null`
on nodes carrying the marker.

Dimensions feed the pricing model's size feature (pricing_ml/export_sales.py reads all three),
so a write changes the next sales export — re-export and rebuild priors deliberately, not as a
side effect.

  python3 knowledge_graph/repair_roseberys_dimensions.py --dry-run   # report + snapshot, no writes
  python3 knowledge_graph/repair_roseberys_dimensions.py             # snapshot, apply, verify
  python3 knowledge_graph/repair_roseberys_dimensions.py --verify    # post-hoc audit only

Requires NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / NEO4J_DATABASE (set -a; source knowledge_graph/.env; set +a).
"""

import argparse
import json
import os
from collections import Counter
from datetime import datetime, timezone

import pandas as pd
from neo4j import GraphDatabase

from roseberys_ingest import CATALOGUE_CSV_PATH, dimension_slots

NEO4J_URI = os.environ["NEO4J_URI"]
NEO4J_USER = os.environ["NEO4J_USER"]
NEO4J_PASSWORD = os.environ["NEO4J_PASSWORD"]
NEO4J_DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

HERE = os.path.dirname(os.path.abspath(__file__))
REPAIR_TAG = "roseberys-dim-kind-1.0"
BATCH = 500
DIM_PROPS = ("sheetDimensions", "imageDimensions", "plateDimensions")

# The all-prints corpus plus any single-sale extract ingested with `roseberys_ingest.py --csv`.
CATALOGUE_CSVS = [
    CATALOGUE_CSV_PATH,
    os.path.join(os.path.dirname(os.path.dirname(CATALOGUE_CSV_PATH)), "A0793", "catalogue.csv"),
]

# Label-scoped on both nodes so the id/institution indexes are used.
SELECT = """
MATCH (s:SourceRecord {institutionName: 'Roseberys London'})-[:DOCUMENTS]-(imp:Impression)
RETURN s.id AS sourceId, s.saleId AS saleId, s.lotNumber AS lotNumber, s.sold AS sold,
       imp.id AS impressionId, imp.sheetDimensions AS sheetDimensions,
       imp.imageDimensions AS imageDimensions, imp.plateDimensions AS plateDimensions,
       imp.dimensionsRepairedAt AS repairedAt
"""

# The null guard is repeated in the WRITE so a concurrent ingest that filled a lot between
# SELECT and WRITE is never overwritten.
WRITE = """
UNWIND $rows AS row
MATCH (imp:Impression {id: row.impressionId})
WHERE imp.sheetDimensions IS NULL AND imp.imageDimensions IS NULL AND imp.plateDimensions IS NULL
SET imp.sheetDimensions = row.sheetDimensions,
    imp.imageDimensions = row.imageDimensions,
    imp.plateDimensions = row.plateDimensions,
    imp.dimensionsRepairedAt = $now,
    imp.dimensionsRepair = $tag
RETURN count(imp) AS n
"""


def load_csv_index():
    frames = [pd.read_csv(p, low_memory=False) for p in CATALOGUE_CSVS if os.path.exists(p)]
    df = pd.concat(frames, ignore_index=True)
    df = df[df["lot_number"].notna()]
    index = {}
    for rec in df.to_dict("records"):
        index.setdefault((str(rec["sale_code"]), int(rec["lot_number"])), []).append(rec)
    return index


def plan(graph_rows, index):
    todo, counts = [], Counter()
    for g in graph_rows:
        if any(g[p] is not None for p in DIM_PROPS):
            counts["already has dimensions"] += 1
            continue
        matches = index.get((str(g["saleId"]), int(g["lotNumber"])), [])
        if not matches:
            counts["no CSV row"] += 1
            continue
        if len(matches) > 1:
            counts["ambiguous CSV key (skipped)"] += 1
            continue
        slots = dimension_slots(matches[0])
        if all(v is None for v in slots.values()):
            counts["CSV has no dimensions"] += 1
            continue
        kind = str(matches[0].get("dim_kind")).strip().lower()
        counts[f"FILL dim_kind={kind!r}"] += 1
        todo.append({"impressionId": g["impressionId"], "sourceId": g["sourceId"],
                     "sold": g["sold"], "dimKind": kind, **slots})
    return todo, counts


def report(graph_rows, todo, counts):
    print(f"Roseberys impressions scanned: {len(graph_rows)}")
    for k, n in sorted(counts.items()):
        print(f"  {k:<40} {n:>6}")
    print(f"\nto fill: {len(todo)} ({sum(1 for t in todo if t['sold'])} sold)")
    for t in todo[:5]:
        print(f"  {t['sourceId']:<36} {t['dimKind']:<11} "
              f"sheet={t['sheetDimensions']} image={t['imageDimensions']} plate={t['plateDimensions']}")


def snapshot(graph_rows, todo, path):
    targets = {t["impressionId"] for t in todo}
    payload = {
        "version": REPAIR_TAG,
        "takenAt": datetime.now(timezone.utc).isoformat(),
        "rowCount": len(targets),
        "properties": list(DIM_PROPS) + ["dimensionsRepairedAt"],
        "rows": [g for g in graph_rows if g["impressionId"] in targets],
        "planned": todo,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"\npre-repair snapshot of {len(targets)} impressions -> {path}")


def apply(session, todo):
    now = datetime.now(timezone.utc).isoformat()
    written = 0
    for i in range(0, len(todo), BATCH):
        written += session.run(WRITE, rows=todo[i:i + BATCH], now=now, tag=REPAIR_TAG).single()["n"]
        print(f"  written {written}/{len(todo)}", end="\r")
    print(f"\nfilled {written} Impression(s).")
    return written


def verify(session, index):
    graph_rows = session.run(SELECT).data()
    todo, counts = plan(graph_rows, index)
    marked = sum(1 for g in graph_rows if g["repairedAt"] is not None)
    mismatched = 0
    for g in graph_rows:
        if g["repairedAt"] is None:
            continue
        matches = index.get((str(g["saleId"]), int(g["lotNumber"])), [])
        if len(matches) != 1 or dimension_slots(matches[0]) != {p: g[p] for p in DIM_PROPS}:
            mismatched += 1
    print(f"Roseberys impressions                         : {len(graph_rows)}")
    print(f"  carrying dimensionsRepairedAt               : {marked}")
    print(f"  CSV has dimensions, graph still has none    : {len(todo)}  (expected 0)")
    print(f"  repaired value differs from dimension_slots : {mismatched}  (expected 0)")
    return len(todo) == 0 and mismatched == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report and snapshot only, no writes")
    ap.add_argument("--verify", action="store_true", help="post-hoc audit, no writes")
    ap.add_argument("--backup", help="snapshot path (default: knowledge_graph/roseberys_dims_repair_presnapshot_<ts>.json)")
    args = ap.parse_args()

    index = load_csv_index()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.verify:
                raise SystemExit(0 if verify(session, index) else 1)
            graph_rows = session.run(SELECT).data()
            todo, counts = plan(graph_rows, index)
            report(graph_rows, todo, counts)
            if not todo:
                print("\nnothing to do — already repaired.")
                return
            ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
            path = args.backup or os.path.join(HERE, f"roseberys_dims_repair_presnapshot_{ts}.json")
            snapshot(graph_rows, todo, path)
            if args.dry_run:
                print("\n--dry-run: no writes made.")
                return
            apply(session, todo)
            print()
            raise SystemExit(0 if verify(session, index) else 1)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
