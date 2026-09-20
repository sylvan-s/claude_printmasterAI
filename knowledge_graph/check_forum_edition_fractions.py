"""
PrintMasterAI — regression guard: Forum edition sizes must not be inch fractions.

Exists because of a silent data defect, not for coverage's sake. Forum's extract read the
first imperial fraction in "510 x 647mm (20 x 25 3/8in)" as the edition size, so ~2,300
Forum EditionRuns carried editions of 2, 4, 8 or 16 and 1,442 priced sales sat in the
pricing model's <=30 edition band (found 2026-09-17; see forum_edition_size.py).

    python3 check_forum_edition_fractions.py           # exits 1 on regression
    python3 check_forum_edition_fractions.py --no-db   # skip the live-graph invariant

It checks, in order:
  1. the rule on fixed cases;
  2. the ingest: every row forum_ingest.py would write from the real catalogue.csv
     passes the rule (skipped when the CSV is absent);
  3. the parser: the TypeScript edition-size tests (benchmark/src/forum/parse.ts and
     src/shared/text_extraction.ts) pass;
  4. the live graph: no Forum EditionRun holds a size the rule rejects.
"""

import argparse
import os
import subprocess
import sys

from forum_edition_size import is_fraction_edition

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

# (edition size, edition note, expected is_fraction_edition)
CASES = [
    (8, None, True),
    (8.0, float("nan"), True),
    (4, "a proof before the edition", True),
    (2, "numbered from the edition of 20", True),      # "of 20" must not confirm 2
    (8, "numbered from the edition of 8", False),
    (16, "a printer's proof aside from the edition of 16", False),
    (30, None, False),
    (75, "numbered", False),
    (None, None, False),
]


def check_cases():
    return [f"  is_fraction_edition({s!r}, {n!r}) expected {w}, got {is_fraction_edition(s, n)}"
            for s, n, w in CASES if is_fraction_edition(s, n) != w]


def check_ingest():
    """Every row load_catalogue() keeps, through the ingest's own map_row()."""
    from forum_ingest import CATALOGUE_CSV_PATH, load_catalogue, map_row
    if not os.path.exists(CATALOGUE_CSV_PATH):
        print(f"  (catalogue CSV absent at {CATALOGUE_CSV_PATH}; ingest check skipped)")
        return []
    df = load_catalogue(log_excluded_path=os.devnull)
    bad, kept = [], 0
    for _, row in df.iterrows():
        size = map_row(row)["editionSize"]
        if size is None:
            continue
        kept += 1
        if is_fraction_edition(size, row.get("edition_note")):
            bad.append(row["lot_url"])
    print(f"  ingest: {kept:,} edition sizes written from {len(df):,} rows")
    return [f"  map_row still writes {len(bad)} fraction edition sizes, e.g. {bad[:3]}"] if bad else []


def check_parser():
    r = subprocess.run(["npx", "tsx", "tests/benchmark_parse/edition_size_tests.ts"], cwd=REPO,
                       capture_output=True, text=True)
    last = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
    print(f"  parser tests: {last}")
    return [] if r.returncode == 0 else ["  TypeScript edition-size tests failed:\n" + r.stdout[-2000:] + r.stderr[-1000:]]


def check_graph():
    from neo4j import GraphDatabase
    uri, user, pw = os.getenv("NEO4J_URI"), os.getenv("NEO4J_USER"), os.getenv("NEO4J_PASSWORD")
    if not uri:
        return ["  NEO4J_* not set — cannot check the live graph (use --no-db to skip)"]
    drv = GraphDatabase.driver(uri, auth=(user, pw))
    try:
        with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
            # Repaired runs carry declaredSize = null; a confirmed small edition carries the
            # marker editionSizeConfirmed (set by the repair from the note). Anything else is a regression.
            n = s.run("""
                MATCH (er:EditionRun)
                WHERE er.id STARTS WITH 'forum-' AND er.declaredSize IN [2, 4, 8, 16]
                  AND coalesce(er.editionSizeConfirmed, false) = false
                RETURN count(er) AS n""").single()["n"]
    finally:
        drv.close()
    print(f"  graph: {n:,} unconfirmed Forum EditionRuns sized 2/4/8/16")
    return [f"  live graph holds {n:,} Forum edition sizes the rule rejects "
            f"(run repair_forum_edition_fractions.py)"] if n else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()
    from dotenv import load_dotenv   # forum_ingest reads NEO4J_* at import time
    load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
    failures = check_cases() + check_ingest() + check_parser()
    if not args.no_db:
        failures += check_graph()
    if failures:
        print("FAIL\n" + "\n".join(failures))
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
