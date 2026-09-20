"""
PrintMasterAI — regression guard: an edition number with a thousands separator is one number.

Exists because of a silent data defect: bonhams_parsing.extract_edition_size (and the price
model's text rule) stopped at the comma, so "aside from the edition of 1,000" was stored as an
edition of 1 and priced in the <=30 band (229 EditionRuns; found 2026-09-17).

    python3 check_edition_thousands.py           # exits 1 on regression
    python3 check_edition_thousands.py --no-db   # skip the live-graph invariant

Checks: (1) bonhams_parsing on fixed cases; (2) the price model's edition_size on the same;
(3) the live graph: no unrepaired EditionRun whose description's separated number truncates to
its stored size.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "pricing_ml"))
from bonhams_parsing import extract_edition_size  # noqa: E402

CASES = [
    ("an artist's proof, aside from the edition of 1,000", 1000),
    ("signed and numbered 441/1,000 in pencil", 1000),
    ("from the edition of 12,500, published by", 12500),
    ("from the edition of 50, printed by Mourlot", 50),
    ("signed and numbered 12/50 (there was also an unsigned edition of 5,000)", 50),
    ("numbered 21/30", 30),
    ("lithograph in colours", None),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()
    import train_price_model as tpm
    failures = []
    for text, want in CASES:
        got = extract_edition_size(text)
        if got != want:
            failures.append(f"  bonhams_parsing {text!r}: expected {want}, got {got}")
        m = tpm.edition_size(None, text)
        m = None if m != m else int(m)
        if m != want:
            failures.append(f"  train_price_model {text!r}: expected {want}, got {m}")
    print(f"  parser cases: {2 * len(CASES) - len(failures)} of {2 * len(CASES)} pass")
    if not args.no_db:
        from dotenv import load_dotenv
        load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
        from neo4j import GraphDatabase
        import repair_edition_thousands as rep
        drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
        try:
            with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
                plan = rep.plan_rows([dict(r) for r in s.run(rep.READ)])
        finally:
            drv.close()
        fix = [p for p in plan if p["action"] == "fix"]
        print(f"  graph: {len(fix)} EditionRuns still truncated at a thousands separator")
        if fix:
            failures.append(f"  live graph holds {len(fix)} truncated edition sizes (run repair_edition_thousands.py)")
    if failures:
        print("FAIL\n" + "\n".join(failures))
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
