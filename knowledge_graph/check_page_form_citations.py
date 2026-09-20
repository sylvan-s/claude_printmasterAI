"""
Guard: page-cited catalogues keep their own name, and the page marker lives on the entry number.
Version: PAGE-CITATION-GUARD-1.0

    python3 check_page_form_citations.py        # exits non-zero on a regression

Two things are asserted, matching the two defects PAGE-CITATION-REPAIR-1.0 fixed (2026-09-17):

  1. `catalogue_matching.parse_catalogue_refs` moves a trailing page marker onto the entry number
     ("Littmann p. 93" -> Littmann / p.93) and still refuses the cases that must not change:
     an author's initial ("A. & P."), an appendix ("App."), and a bare page fragment ("p. 258").
  2. No CatalogueRaisonne in the graph is named "<catalogue> p." — that is one node per page-cited
     catalogue instead of one per catalogue, and it hides every entry from a citation lookup.
"""
import os
import re
import sys

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalogue_matching import genuine_refs, parse_catalogue_refs  # noqa: E402
from neo4j import GraphDatabase  # noqa: E402

CASES = [
    ("Czwiklitzer p.437", [("Czwiklitzer", "p.437")]),
    ("Littmann p. 93", [("Littmann", "p.93")]),
    ("Sorlier pp. 12", [("Sorlier", "pp.12")]),
    ("Bloch 1300", [("Bloch", "1300")]),
    ("V. 182, p. 258", [("V.", "182")]),
    ("p. 258", []),
    ("Cramer, Grant & Mitchinson 1973 45", [("Cramer, Grant & Mitchinson 1973", "45")]),
]
# A prefix that is a catalogue name plus a lowercase page marker; "App." and "A. & P." are neither.
BAD_PREFIX = ".*[^\\\\w][\\\\s,]*(pp?\\\\.|[Pp]age)$"
QUERY = f"MATCH (cr:CatalogueRaisonne) WHERE cr.numberingPrefix =~ '{BAD_PREFIX}' RETURN collect(cr.numberingPrefix) AS bad"


def main():
    failures = []
    for raw, want in CASES:
        got = [(r["catalogueName"], r["entryNumber"]) for r in genuine_refs(parse_catalogue_refs(raw))]
        if got != want:
            failures.append(f"parse {raw!r}: got {got}, want {want}")
    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with drv.session(database=os.environ.get("NEO4J_DATABASE") or "neo4j") as s:
        bad = [b for b in s.run(QUERY).single()["bad"] if not re.search(r"\d[.,]?\s*(pp?\.|page)$", b, re.I)]
    drv.close()
    if bad:
        failures.append(f"{len(bad)} CatalogueRaisonne named with a page marker: {bad[:8]}")
    for f in failures:
        print(f"FAIL {f}")
    print("page-form citations: OK" if not failures else f"{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
