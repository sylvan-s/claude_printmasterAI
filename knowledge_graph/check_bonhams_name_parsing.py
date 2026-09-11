"""
PrintMasterAI — regression guard for bonhams_parsing.py's artist-name assembly.

Exists because of a silent data-corruption bug, not for coverage's sake. Bonhams has a
rarer house convention where the `artist` field LEADS with a parenthetical holding the
artist's real/birth name, or the literal placeholder "(n/a)":

    "(n/a) Andy Warhol"   "(Jules Isnard) Dransy"   "(Lucien) Alton Pickens"

`clean_artist_name()` truncates at the first "(", so for these it returned "" — and
because bonhams_ingest.py keys on `MERGE (artist:Artist {name: row.artistName})`, every
such lot collapsed onto ONE nameless Artist node. It carried 17 alternateNames and 18
CREATED edges before being found and repaired on 2026-09-11. Nothing about that failure
was loud: the ingest exited cleanly and the row counts looked right.

Run it after any change to bonhams_parsing.py's name handling:

    python3 check_bonhams_name_parsing.py          # exits 1 on regression

It checks the fixed shapes inline, then — if the real export is present — asserts the
invariant that actually matters across every record in it: no row that survives
load_records()' filters may produce an empty artist name.
"""

import os
import sys

from bonhams_parsing import strip_leading_parenthetical, parse_lot_name

# (raw artist value, expected qualifier, expected cleaned name)
NAME_CASES = [
    ("(n/a) Andy Warhol", "direct", "Andy Warhol"),
    ("(Jules Isnard) Dransy", "direct", "Dransy"),
    ("(Lucien) Alton Pickens", "direct", "Alton Pickens"),
    ("(MIODRAG DURIC) DADO", "direct", "Dado"),
    ("(James) Blanding Sloan", "direct", "Blanding Sloan"),
    # the qualifier hides BEHIND the parenthetical — the old order missed it entirely and
    # recorded a print Audubon did not make as a `direct` attribution
    ("(n/a) After John James Audubon", "after", "John James Audubon"),
    # unchanged shapes must stay unchanged
    ("Andy Warhol", "direct", "Andy Warhol"),
    ("After Pablo Picasso", "after", "Pablo Picasso"),
    ("PABLO PICASSO", "direct", "Pablo Picasso"),
    # a leading parenthetical that IS the life-dates slot must survive untouched
    ("(1933-2010)", "direct", ""),
]

# (LotName text, expected (nationality, begin, end))
LOTNAME_CASES = [
    ("(Jules Isnard) Dransy (French, 1883-1945)", ("French", 1883, 1945)),
    ("(n/a) Richard Lorenz (American, 1952-2001)", ("American", 1952, 2001)),
    ("(MIODRAG DURIC) DADO (1933-2010)", (None, 1933, 2010)),
    ("Andy Warhol (American, 1928-1987)", ("American", 1928, 1987)),
    ("Someone (French, born 1919)", ("French", 1919, None)),
    # grouped-lot counts used to surface as the nationality ("Two", "6", "2")
    ('(Two), Van Amthor, "Birds and Insects", 1900', (None, None, None)),
    ("(2)", (None, None, None)),
    ("JOSEF EIDENBERGER PRINTS (5)", (None, None, None)),
]


def main():
    from bonhams_ingest import resolve_artist_fields

    failures = []

    for raw, want_q, want_name in NAME_CASES:
        got_q, got_name = resolve_artist_fields(raw)
        if (got_q, got_name) != (want_q, want_name):
            failures.append(f"name  {raw!r}: expected {(want_q, want_name)}, got {(got_q, got_name)}")

    for text, want in LOTNAME_CASES:
        got = parse_lot_name(text)
        if got != want:
            failures.append(f"lot   {text!r}: expected {want}, got {got}")

    # never strip a string down to nothing — an empty artist name is the whole bug
    for raw in ["(n/a)", "(2)", "(unclosed", "Andy Warhol", ""]:
        if raw.strip() and not strip_leading_parenthetical(raw).strip():
            failures.append(f"strip_leading_parenthetical({raw!r}) emptied a non-empty string")

    checked = len(NAME_CASES) + len(LOTNAME_CASES)

    # the invariant, over the real export when it is available
    from bonhams_ingest import BONHAMS_JSON_PATH, load_records
    if os.path.exists(BONHAMS_JSON_PATH):
        kept = load_records(log_excluded_path=None)
        empties = [r["lot_id"] for r in kept if not resolve_artist_fields(r["artist"])[1]]
        checked += len(kept)
        if empties:
            failures.append(
                f"{len(empties)} kept rows still clean to an EMPTY artist name — these would all "
                f"collapse onto one nameless Artist node: {empties[:10]}"
            )
        print(f"[CHECK] {len(kept)} kept rows scanned from the real export")
    else:
        print(f"[CHECK] export not present at {BONHAMS_JSON_PATH} — inline cases only")

    if failures:
        print(f"\n[FAIL] {len(failures)} regression(s):", file=sys.stderr)
        for f in failures:
            print(f"   {f}", file=sys.stderr)
        return 1
    print(f"[OK] {checked} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
