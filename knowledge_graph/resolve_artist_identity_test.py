"""
Offline tests (no network, no Neo4j) for ARTIST-IDENTITY-RESOLVER-1.1 — dotted
post-nominals in strip_honorifics().

    python3 -m pytest knowledge_graph/resolve_artist_identity_test.py

The defect: the 1.0 membership test did `t.lower().rstrip(".")`, which turns "R.A." into
"r.a" — never a member of _POSTNOMINAL_SUFFIXES, so the token survived. Dotted forms are
the norm in British auction catalogues (R.A., R.W.S., O.B.E., A.R.A.), and the measured
cost was matching Sotheby's names against the graph: 25 Frink lots found instead of 304.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from resolve_artist_identity import strip_honorifics


# ── the regression: dotted post-nominals ─────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("Dame Elisabeth Frink, R.A.", "Elisabeth Frink"),
    ("Julian Trevelyan, R.A.", "Julian Trevelyan"),
    ("Sir Terry Frost R.A.", "Terry Frost"),
    ("Edward Duncan R.W.S", "Edward Duncan"),
    ("David Shepherd O.B.E", "David Shepherd"),
    ("John Craxton R.A", "John Craxton"),
    ("Henry Moore, O.M., C.H.", "Henry Moore"),
    ("L.S. Lowry, R.A., R.B.A.", "L.S. Lowry"),
    # A.R.A. needs "ara", which 1.0 lacked entirely; R.W.A. needs "rwa". Both came over
    # from find_artist_merge_candidates.HONORIFICS, which had drifted ahead of this set.
    ("Walter Sickert, A.R.A.", "Walter Sickert"),
    ("Elizabeth Blackadder O.B.E. R.A. R.S.A. R.S.W. R.W.A", "Elizabeth Blackadder"),
])
def test_dotted_postnominals_are_stripped(raw, expected):
    assert strip_honorifics(raw) == expected


# ── the guard: a LEADING dotted token is initials, not a post-nominal ────────
# Without the positional rule, a blanket replace(".", "") turns "D.R. Wakefield" into
# "Wakefield" — "d.r." normalizes onto the "dr" honorific. Confirmed on a real node.
@pytest.mark.parametrize("raw", [
    "D.R. Wakefield",
    "R.C. Gorman",
    "H.C. Westermann",
    "T.L. Solien",
    "George L.K. Morris",
    "James A. M. Whistler",
    "Bror J. O. Nordfeldt",
])
def test_leading_initials_are_never_stripped(raw):
    assert strip_honorifics(raw) == raw


# ── unchanged 1.0 behaviour ─────────────────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("Dame Elisabeth Frink", "Elisabeth Frink"),
    ("Dame Elizabeth Frink CH DBE RA", "Elizabeth Frink"),
    ("Henry, OM, CH Moore", "Henry Moore"),
    ("Roy Lichtenstein,", "Roy Lichtenstein"),
    ("Dr. Someone", "Someone"),
    ("Christo", "Christo"),
])
def test_undotted_behaviour_is_preserved(raw, expected):
    assert strip_honorifics(raw) == expected


def test_empty_and_all_honorific_input_falls_back_to_raw():
    assert strip_honorifics("") == ""
    assert strip_honorifics(None) == ""
    # stripping everything must not return an empty name
    assert strip_honorifics("R.A.") == "R.A."
