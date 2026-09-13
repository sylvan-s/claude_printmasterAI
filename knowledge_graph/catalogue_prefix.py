"""
PrintMasterAI — one definition of a catalogue's canonical numbering prefix.

WHY THIS EXISTS. `CatalogueRaisonne.numberingPrefix` is free text as the sources print it, and
the same catalogue arrives under many spellings: 2,319 prefixes on 2026-09-13, 1,486 of them
carrying a single entry. Feldmann & Schellmann appears as at least eight (`F./S.`, `F. & S.`,
`Feldman & Schellman`, `1966 Feldman & Schellmann`, ...), Baer as `Baer` and `Ba.`, Bloch as
`Bloch` and `B.`.

That matters because the prefix is half of the catalogue key. Dropping it let `Baer 623` match
`Bloch 623` for +5.33 log2 on a numbering coincidence — the bug fixed on 2026-09-12. Keeping it
raw costs the opposite error: `Baer 623` no longer matches `Ba. 623`, and `entry` is the
strongest comparison in the model.

TWO TIERS, and only the first is mechanical.

  1. FOLDING to lowercase alphanumerics. `F. & S.`, `F./S.`, `F.&S.` and `F&S` are one token
     written four ways; `Coppel  LT` and `Coppel LT` differ by a space. This asserts nothing and
     is done by `entry_exact_keys` already.

  2. ABBREVIATION, which is an INFERENCE and is therefore table-driven, per artist, and
     evidence-backed. `catalogue_prefix_aliases.csv` is generated from pairs of prefixes that
     document THE SAME WORK under THE SAME ENTRY NUMBER for THE SAME ARTIST, kept only where one
     prefix is an initialism or literal prefix of the other AND one target dominates (at least 3
     shared works and at least 5x the runner-up).

WHY PER ARTIST, AND WHY DOMINANCE. A catalogue raisonné is artist-specific — 2,083 of 2,319
document exactly one artist — so "Coppel" means Coppel CEP for Cyril Power and Coppel SA for
Sybil Andrews, and nothing outside an artist may be joined. Dominance exists because initials
are ambiguous WITHIN one artist too: Picasso's `B.` links to both Bloch (82 shared works) and
Baer (8), and Miró's `M.` to both Mourlot and Maeght. Taking the transitive closure of
abbreviation links merges Baer into Bloch through `B.` — measured, not hypothesised — which is
the Cramer 30 corruption again. Where no target dominates, the alias is LEFT ALONE: Henry Moore's
`C.` (Cramer 21 / Cramer, Grant & Mitchinson 13) and Rembrandt's `B.` (Bartsch 19 / B., Holl. 9)
resolve to nothing and stay as they are.

NOTHING IS WRITTEN TO THE GRAPH. This is a lookup applied where keys are built, so the mapping
is reversible by editing a CSV, and a person can read all 84 rows.
"""

import csv
import os
import re

_ALNUM = re.compile(r"[^a-z0-9]")
_ALIAS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "catalogue_prefix_aliases.csv")
_ALIASES = None


def fold_prefix(prefix):
    """Tier 1. Lowercase alphanumerics, asserting nothing."""
    return _ALNUM.sub("", str(prefix or "").lower())


def _aliases():
    global _ALIASES
    if _ALIASES is None:
        _ALIASES = {}
        try:
            with open(_ALIAS_FILE, encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    _ALIASES[(row["artist"], row["alias"])] = row["canonical"]
        except FileNotFoundError:
            pass
    return _ALIASES


def canonical_prefix(prefix, artist=None):
    """Tier 1 always; tier 2 only when the artist is known and the alias is in the table."""
    folded = fold_prefix(prefix)
    if not folded or not artist:
        return folded
    return _aliases().get((artist, folded), folded)
