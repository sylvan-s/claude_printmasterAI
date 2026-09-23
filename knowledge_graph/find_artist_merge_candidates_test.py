"""
Offline tests (no network, no Neo4j) for ARTIST-IDENTITY-RESOLVER-1.2 — the TOKEN side of
the dotted post-nominal defect.

    python3 -m pytest knowledge_graph/find_artist_merge_candidates_test.py

1.1 fixed `resolve_artist_identity.strip_honorifics`, which sees the raw string. This module's
`strip_honorifics` sees tokens from `normalize`, where punctuation is already gone, so the same
catalogue string arrives as single letters instead: "Laurence Stephen Lowry, R.A." ->
["laurence","stephen","lowry","r","a"], and "r"/"a" match nothing in HONORIFICS.

Measured cost before the fix: Sotheby's writes the dotted form on ~60% of their Lowry and
Terry Frost lots, and both artists scored a 0% name match in the comps pilot (ADR-0021).

The guard that matters: leading initials are real name content. "D.R. Wakefield" must not
become "Wakefield" — the regression that made a naive all-dots fix unacceptable in 1.1.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("NEO4J_URI", "bolt://unused-by-these-tests")
os.environ.setdefault("NEO4J_USER", "unused")
os.environ.setdefault("NEO4J_PASSWORD", "unused")
os.environ.setdefault("NEO4J_DATABASE", "unused")

from find_artist_merge_candidates import strip_honorifics, tokens


def clean(raw):
    return strip_honorifics(tokens(raw))


# ── the regression: dotted post-nominals arrive as single letters ────────────
@pytest.mark.parametrize("raw,expected", [
    ("Laurence Stephen Lowry, R.A.", ["laurence", "stephen", "lowry"]),
    ("Sir Terry Frost, R.A.", ["terry", "frost"]),
    ("Dame Elisabeth Frink, R.A.", ["elisabeth", "frink"]),
    ("David Hockney, R.A.", ["david", "hockney"]),
    ("John Piper, C.H.", ["john", "piper"]),
    ("Edward Duncan R.W.S", ["edward", "duncan"]),
    ("David Shepherd O.B.E", ["david", "shepherd"]),
])
def test_dotted_postnominals_are_dropped(raw, expected):
    assert clean(raw) == expected


# ── stacked post-nominals need more than one pass ────────────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("Henry Moore, O.M., C.H.", ["henry", "moore"]),
    ("Elizabeth Blackadder O.B.E. R.A. R.S.A. R.S.W. R.W.A", ["elizabeth", "blackadder"]),
])
def test_stacked_postnominals(raw, expected):
    assert clean(raw) == expected


# ── the guard: leading initials are name content, not honorifics ─────────────
@pytest.mark.parametrize("raw", [
    "D.R. Wakefield",        # "dr" would be a plausible honorific; position forbids it
    "J.M.W. Turner",
    "R. A. Bloomfield",      # the same letters as R.A., but leading
    "L.S. Lowry",            # initialism rule's job, not this one's
])
def test_leading_initials_survive(raw):
    assert clean(raw) == tokens(raw)


# ── a run that is not a known post-nominal is left alone ─────────────────────
def test_unknown_trailing_run_is_left_alone():
    assert clean("Peter Blake X Y") == ["peter", "blake", "x", "y"]


# ── undotted behaviour is unchanged (the 1.0 contract) ───────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("Sir Frank Short", ["frank", "short"]),
    ("RTO Jonas Wood", ["jonas", "wood"]),
    ("Henry, OM, CH Moore", ["henry", "moore"]),
    ("Andy Warhol 1928-1987", ["andy", "warhol"]),
])
def test_existing_behaviour_unchanged(raw, expected):
    assert clean(raw) == expected


def test_never_reduces_below_two_tokens():
    assert clean("Christo") == ["christo"]
    # stripping would leave one token, so the original is returned intact
    assert clean("Moore R.A.") == ["moore", "r", "a"]
