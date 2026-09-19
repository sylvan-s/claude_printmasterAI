"""
PrintMasterAI — regression guard: ConceptualWork titles live in `name`, never `title`.

Exists because of a silent gap, not for coverage's sake. `king_mcgaw_ingest.py` 1.0 wrote the
work title to `ConceptualWork.title` while every other ingest writes `name`. Nothing failed:
the ingest exited cleanly and the counts looked right. But `backfill_title_embeddings.ts`
filters on `cw.name IS NOT NULL`, so all 545 King & McGaw works went without a title
embedding, and any query keyed on `name` skipped them. My own first three duplicate-hunting
passes returned "zero matches" for exactly that reason. Repaired 2026-09-19 by
`repair_km_work_names.py`.

NEO4J CANNOT ENFORCE THIS (self-hosted CE; no property-existence constraints), so the
invariant lives here.

    python3 check_conceptual_work_title_property.py            # exits 1 on regression
    python3 check_conceptual_work_title_property.py --no-db    # skip the live-graph check

Two layers:
  1. No ingest/repair script writes `cw.title` / `ConceptualWork ... title` as a SET target.
  2. If the graph is reachable: no ConceptualWork carries a `title` property.
"""
import argparse
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# A SET (or a continuation line of one) on the ConceptualWork alias targeting `.title`. `sr.title`, `img.title` etc. are
# other node types and are fine. The repair script legitimately mentions the pattern in its own
# queries, so it is exempt.
WRITE_RE = re.compile(r"(?:\bSET\s+|^\s*)(?:cw|w|work)\.title\s*=(?!=)")
EXEMPT = {"repair_km_work_names.py", "check_conceptual_work_title_property.py"}


def check_static():
    bad = []
    for path in sorted(glob.glob(os.path.join(HERE, "*.py"))):
        if os.path.basename(path) in EXEMPT:
            continue
        for i, line in enumerate(open(path, encoding="utf-8", errors="ignore"), 1):
            if WRITE_RE.search(line):
                bad.append(f"{os.path.basename(path)}:{i}: {line.strip()}")
    return bad


def check_live():
    from neo4j import GraphDatabase
    sys.path.insert(0, HERE)
    from repair_km_work_names import NEO4J_URI, NEO4J_USER, get_neo4j_password
    d = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, get_neo4j_password()))
    with d.session(database="neo4j") as s:
        r = s.run("MATCH (cw:ConceptualWork) WHERE cw.title IS NOT NULL "
                  "RETURN count(cw) AS n, collect(cw.id)[..5] AS sample").single()
    return r["n"], r["sample"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()
    failed = False

    bad = check_static()
    if bad:
        failed = True
        print("FAIL static: scripts write ConceptualWork.title (use .name):")
        for b in bad:
            print("  ", b)
    else:
        print("ok static: no script writes ConceptualWork.title")

    if not args.no_db:
        try:
            n, sample = check_live()
        except Exception as e:  # unreachable graph is not a regression
            print(f"skip live: graph unreachable ({type(e).__name__})")
        else:
            if n:
                failed = True
                print(f"FAIL live: {n} ConceptualWork nodes carry `title` (e.g. {sample}); run repair_km_work_names.py")
            else:
                print("ok live: no ConceptualWork carries `title`")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
