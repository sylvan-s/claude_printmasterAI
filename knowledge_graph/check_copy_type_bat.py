"""
PrintMasterAI — regression guard for Impression.copyType BAT detection.

Exists because the BAT keyword was once the bare substring "bon": 353 of 512 BAT impressions
were Bonnard, bonnet, Dibond, ribbon... (found 2026-09-16, see copy_type.py and
repair_copy_type_bat.py). Nothing failed loudly — BAT is a rare but honest value.

  CODE   `copy_type.detect_copy_type` classifies the fixtures below correctly, and none of the
         four auction ingests defines its own COPY_TYPE_KEYWORDS again. The same fixtures are
         asserted against price_attrs.ts detectCopyType in tests/appraisal/valuation_evidence_tests.ts.
  GRAPH  No impression still carries the old detector's copyType where the current detector
         disagrees on the same ingest input (i.e. repair_copy_type_bat.py has nothing to do).

    set -a; source knowledge_graph/.env; set +a
    python3 knowledge_graph/check_copy_type_bat.py          # exits 1 on regression
"""

import os
import sys

from neo4j import GraphDatabase

from copy_type import detect_copy_type
from repair_copy_type_bat import (NEO4J_DATABASE, NEO4J_PASSWORD, NEO4J_URI, NEO4J_USER, PREFIXES,
                                  SELECT, load_csv_index, plan)

HERE = os.path.dirname(os.path.abspath(__file__))

# Keep identical to the list in tests/appraisal/valuation_evidence_tests.ts.
FIXTURES = [
    ("on carbon paper", "numbered"), ("PIERRE BONNARD Scène de famille", "numbered"),
    ("Le Bon Samaritain", "numbered"), ("printed on Dibond", "numbered"), ("The Bat", "numbered"),
    ("BATTLE", "numbered"), ("published by B. A. T. Suisse SA, Geneva", "numbered"),
    ("annotated 'BaT.' (a bon á tirer)", "BAT"), ("inscribed BAT in pencil", "BAT"),
    ("annotated 'B.A.T.'", "BAT"), ("inscribed 'B.A.T 1' in pencil", "BAT"), ("bon-a-tirer", "BAT"),
    ("annotated 'Bon a tiré'", "BAT"), ('Inscribed "Bon à Tirer"', "BAT"),
    ("artist's proof, bon à tirer", "AP"), ("Bonnard trial proof", "TP"),
]
INGESTS = ["bonhams_ingest.py", "forum_ingest.py", "roseberys_ingest.py", "swann_ingest.py"]


def main():
    failures = []

    for text, want in FIXTURES:
        got = detect_copy_type(text)
        if got != want:
            failures.append(f"detect_copy_type({text!r}) = {got!r}, expected {want!r}")
    for name in INGESTS:
        src = open(os.path.join(HERE, name), encoding="utf-8").read()
        if "COPY_TYPE_KEYWORDS" in src or "def detect_copy_type" in src:
            failures.append(f"{name} defines its own copy-type table again — import it from copy_type.py")
    print(f"[CHECK] {len(FIXTURES)} detector fixtures, {len(INGESTS)} ingests scanned")

    index = load_csv_index()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            graph_rows = session.run(SELECT, prefixes=list(PREFIXES)).data()
    finally:
        driver.close()
    todo, _, _ = plan(graph_rows, index)
    print(f"[CHECK] {len(graph_rows)} auction impressions scanned")
    if todo:
        bat_out = sum(1 for t in todo if t["oldCopyType"] == "BAT")
        failures.append(f"{len(todo)} impressions still carry the pre-1.1 copyType ({bat_out} false BAT), "
                        f"e.g. {todo[0]['sourceId']} — run repair_copy_type_bat.py")

    if failures:
        print(f"\n[FAIL] {len(failures)} regression(s):", file=sys.stderr)
        for f in failures:
            print(f"   {f}", file=sys.stderr)
        return 1
    print("[OK] copy-type checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
