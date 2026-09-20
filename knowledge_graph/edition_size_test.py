"""
EDITION-SIZE-1.1 fixture runner (Python side). No network, no Neo4j, no LLM.

Reads tests/fixtures/edition_size.jsonl — the SAME file the TypeScript runner reads
(tests/benchmark_parse/edition_size_tests.ts). That shared file is the only thing holding the
Python rules and their TypeScript mirrors together; there is no codegen, by ADR-0020.

Cases whose id starts with DIVERGENCE- are the known, deliberate disagreements between the
ingest rule and the model rule. They are asserted per-rule against the table in ADR-0020, not
against `expect`, so this file passes while the divergences stand and must be updated
deliberately when one is reconciled.

    python3 knowledge_graph/edition_size_test.py        # exits 1 on regression
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from edition_size import size_from_text_ingest, size_from_text_model  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "tests", "fixtures", "edition_size.jsonl")

# The ADR-0020 divergence table, as measured 2026-09-20: what each rule returns for the cases
# where they do not agree. Anything not listed must match the fixture's `expect` in both.
DIVERGENT = {
    "DIVERGENCE-one-of-impressions":          {"ingest": None,   "model": 50},
    "DIVERGENCE-one-of-copies":               {"ingest": None,   "model": 200},
    "DIVERGENCE-edition-of-approximately":    {"ingest": None,   "model": 200},
    "DIVERGENCE-edition-of-circa":            {"ingest": None,   "model": 75},
    "DIVERGENCE-roman-numerator-arabic-denom": {"ingest": 50,    "model": None},
    "DIVERGENCE-six-figure":                  {"ingest": 250000, "model": None},

    # The model rule's trailing \b rejects suffixed edition numbers that the ingest rule reads.
    # Measured over all 89,451 auction rows on 2026-09-20 and DELIBERATELY NOT FIXED: the better
    # candidate moves 15 rows, only 4 of which reach the model (it consults text only when the
    # graph has no size, and the ingest rule already stores the rest), and one of those 4 is a
    # regression on a malformed "200/4" transcription. A retrain and a gate cost more. ADR-0020.
    "suffix-quoted-20-25":                    {"ingest": 25,     "model": None},
    "suffix-letter-50A":                      {"ingest": 50,     "model": None},
    "suffix-letter-250P":                     {"ingest": 250,    "model": None},
}

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print(f"  ok  - {name}")
    else:
        failed += 1
        print(f"  FAIL - {name}\n         got {got!r}, want {want!r}")


with open(FIXTURES) as fh:
    for line in fh:
        c = json.loads(line)
        cid, text = c["id"], c["text"]
        want = DIVERGENT.get(cid, {"ingest": c["expect"], "model": c["expect"]})
        check(f"ingest: {cid}", size_from_text_ingest(text), want["ingest"])
        check(f"model:  {cid}", size_from_text_model(text), want["model"])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
