"""
PrintMasterAI — repair King & McGaw ConceptualWork titles stored under the wrong property.
Version: KM-WORK-NAME-REPAIR-1.0

`king_mcgaw_ingest.py` (through KING-MCGAW-INGEST-1.0) wrote the work title to
`ConceptualWork.title`. Every other ingest writes `ConceptualWork.name`, and every reader
looks there: `backfill_title_embeddings.ts` filters on `cw.name IS NOT NULL`, so no King &
McGaw work ever got a `titleEmbedding` and Stage 2a title similarity cannot see them. Measured
2026-09-19: 545 works carry `title` and no `name`; the other 110,200 carry `name` and no
`title`. The two sets are disjoint and the 545 are exactly the `km-cw-` nodes.

The fix is pure copy: `name = title`, then drop `title` so the graph has one spelling. Only
rows with `name IS NULL` are touched, so a re-run is a no-op and an existing work that a King &
McGaw record was attached to is never overwritten.

After applying, the 545 still need title embeddings (`backfill_title_embeddings.ts`, which
picks up `titleEmbedding IS NULL` rows on its own). That is a separate step and is NOT run here.

    python3 knowledge_graph/repair_km_work_names.py --dry-run    # report + snapshot, no writes
    python3 knowledge_graph/repair_km_work_names.py              # apply
    python3 knowledge_graph/repair_km_work_names.py --verify     # audit only, exits 1 on residue
    python3 knowledge_graph/repair_km_work_names.py --rollback <snapshot.json>
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")


def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""


# Label-scoped on purpose: an unlabelled MATCH would silently skip the id index.
TARGET_QUERY = """
MATCH (cw:ConceptualWork)
WHERE cw.title IS NOT NULL AND cw.name IS NULL
RETURN cw.id AS id, cw.title AS title
ORDER BY id
"""

COUNTS_QUERY = """
MATCH (cw:ConceptualWork)
RETURN count(cw) AS total,
       sum(CASE WHEN cw.title IS NOT NULL THEN 1 ELSE 0 END) AS withTitle,
       sum(CASE WHEN cw.title IS NOT NULL AND cw.name IS NULL THEN 1 ELSE 0 END) AS titleOnly,
       sum(CASE WHEN cw.title IS NOT NULL AND cw.name IS NOT NULL THEN 1 ELSE 0 END) AS both,
       sum(CASE WHEN cw.name IS NULL THEN 1 ELSE 0 END) AS noName,
       sum(CASE WHEN cw.title IS NOT NULL AND cw.name IS NULL
                 AND NOT cw.id STARTS WITH 'km-cw-' THEN 1 ELSE 0 END) AS titleOnlyNonKm
"""

APPLY_QUERY = """
UNWIND $ids AS id
MATCH (cw:ConceptualWork {id: id})
WHERE cw.title IS NOT NULL AND cw.name IS NULL
SET cw.name = cw.title
REMOVE cw.title
RETURN count(cw) AS n
"""

ROLLBACK_QUERY = """
UNWIND $rows AS row
MATCH (cw:ConceptualWork {id: row.id})
WHERE cw.title IS NULL AND cw.name = row.title
SET cw.title = row.title
REMOVE cw.name
RETURN count(cw) AS n
"""


def counts(s):
    return s.run(COUNTS_QUERY).single().data()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report and snapshot only, no writes")
    ap.add_argument("--verify", action="store_true", help="audit only, no writes; exits 1 on residue")
    ap.add_argument("--rollback", metavar="SNAPSHOT", help="restore title from a snapshot, no other writes")
    ap.add_argument("--backup", help="snapshot path (default: knowledge_graph/km_work_name_repair_presnapshot_<ts>.json)")
    args = ap.parse_args()

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, get_neo4j_password()))
    with driver.session(database="neo4j") as s:
        before = counts(s)
        print("graph before:", before)

        if args.verify:
            bad = before["titleOnly"] + before["both"]
            print("RESIDUE" if bad else "OK: no ConceptualWork carries a `title` property.", f"({bad} rows)" if bad else "")
            sys.exit(1 if bad else 0)

        if args.rollback:
            rows = json.load(open(args.rollback))["rows"]
            n = s.run(ROLLBACK_QUERY, rows=rows).single()["n"]
            print(f"rolled back {n} of {len(rows)} rows")
            return

        rows = s.run(TARGET_QUERY).data()
        non_km = [r["id"] for r in rows if not r["id"].startswith("km-cw-")]
        print(f"{len(rows)} works to repair ({len(non_km)} outside the km-cw- namespace)")
        for r in rows[:5]:
            print("  e.g.", r["id"], "|", r["title"])
        if non_km:
            print("ABORT: `title`-only works exist outside King & McGaw; that is a different defect. First few:",
                  non_km[:5])
            sys.exit(2)
        if not rows:
            print("nothing to do.")
            return

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        path = args.backup or os.path.join(HERE, f"km_work_name_repair_presnapshot_{ts}.json")
        with open(path, "w") as f:
            json.dump({"version": "KM-WORK-NAME-REPAIR-1.0", "takenAt": ts, "before": before, "rows": rows}, f, indent=1)
        print("snapshot ->", path)

        if args.dry_run:
            print("\n--dry-run: no writes made.")
            return

        n = s.run(APPLY_QUERY, ids=[r["id"] for r in rows]).single()["n"]
        after = counts(s)
        print(f"repaired {n} works")
        print("graph after:", after)
        if n != len(rows) or after["titleOnly"] or after["both"]:
            print("MISMATCH: expected every target repaired and no residue.")
            sys.exit(1)


if __name__ == "__main__":
    main()
