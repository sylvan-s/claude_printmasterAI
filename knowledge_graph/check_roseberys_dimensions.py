"""
PrintMasterAI — regression guard for Roseberys dimensions.

Exists because of a silent data-loss bug: through ROSEBERYS-INGEST-1.0 the ingest only
recognised five `dim_kind` values, so 519 lots labelled "each sheet", "size" or "block"
landed with sheet/image/plateDimensions all null while the CSV carried their width and
height (found 2026-09-16, repaired by repair_roseberys_dimensions.py). Nothing failed: a
null dimension is an ordinary state for a lot the cataloguer didn't measure.

  CODE   Every dim_kind value present in the Roseberys CSVs, on a row with dimensions, must
         map to exactly one slot in `roseberys_ingest.dimension_slots`. A new value in a
         future extract fails here before it can be ingested blank.
  GRAPH  No Roseberys Impression may have all three dimension properties null when its
         single matching CSV row has dimensions.

    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/check_roseberys_dimensions.py          # exits 1 on regression
"""

import sys

from neo4j import GraphDatabase

from repair_roseberys_dimensions import (NEO4J_DATABASE, NEO4J_PASSWORD, NEO4J_URI, NEO4J_USER,
                                         SELECT, load_csv_index, plan)
from roseberys_ingest import dimension_slots


def main():
    failures = []
    index = load_csv_index()

    # CODE invariant
    kinds = set()
    for recs in index.values():
        for rec in recs:
            slots = dimension_slots(rec)
            has_dims = rec.get("width_cm") == rec.get("width_cm") and rec.get("height_cm") == rec.get("height_cm")
            filled = sum(v is not None for v in slots.values())
            kinds.add(str(rec.get("dim_kind")).strip().lower())
            if has_dims and filled != 1:
                failures.append(f"dim_kind={rec.get('dim_kind')!r} ({rec['sale_code']} lot {rec['lot_number']}) "
                                f"maps to {filled} dimension slots — add it to roseberys_ingest's *_DIM_KINDS")
    print(f"[CHECK] {sum(len(v) for v in index.values())} CSV rows, dim_kind values: {sorted(kinds)}")

    # GRAPH invariant
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            graph_rows = session.run(SELECT).data()
    finally:
        driver.close()
    todo, _ = plan(graph_rows, index)
    print(f"[CHECK] {len(graph_rows)} Roseberys impressions scanned")
    if todo:
        failures.append(f"{len(todo)} Roseberys impressions have no dimensions but their CSV row does "
                        f"(e.g. {todo[0]['sourceId']}) — run repair_roseberys_dimensions.py")

    if failures:
        shown = failures[:10]
        print(f"\n[FAIL] {len(failures)} regression(s):", file=sys.stderr)
        for f in shown:
            print(f"   {f}", file=sys.stderr)
        return 1
    print("[OK] Roseberys dimension checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
