"""
PrintMasterAI — regression guard for catalogue-prefix canonicalisation.

`catalogue_prefix_aliases.csv` says that one printed catalogue prefix means another, per artist.
That is an INFERENCE about identity, and this repo has been corrupted twice by inferred identity,
so two invariants are checked on every run.

  1. THE TABLE IS UNAMBIGUOUS AND ACYCLIC. One alias may not resolve to two catalogues for one
     artist, and following a chain must terminate. Picasso's `B.` links by evidence to BOTH Bloch
     (82 shared works) and Baer (8); Miró's `M.` to both Mourlot and Maeght. Taking the transitive
     closure of such links merges Baer into Bloch — measured, not hypothesised — which is the
     Cramer 30 corruption again.

  2. CANONICALISATION IS ADDITIVE. `entry_exact_keys` must never return FEWER keys with the
     artist than without: a source that splits prefix and number differently ("Coppel" + "CEP.16"
     against "Coppel  CEP" + "16") already agrees under plain folding, and mapping the short
     prefix doubles the designator on one side. Emitting only the canonical key turned 5 agreeing
     pairs into conflicts while fixing 57. A canonicalisation that destroys evidence is not one.

Run after editing the alias table or either key builder:

    python3 check_catalogue_prefix_aliases.py
"""

import csv
import os
import sys

from catalogue_prefix import canonical_prefix, fold_prefix, _ALIAS_FILE
from fit_splink_work_identity import entry_exact_keys


def check_table():
    bad = []
    rows = list(csv.DictReader(open(_ALIAS_FILE, encoding="utf-8")))
    seen = {}
    for r in rows:
        key = (r["artist"], r["alias"])
        if r["alias"] == r["canonical"]:
            bad.append(f"{key}: alias equals canonical")
        if key in seen and seen[key] != r["canonical"]:
            bad.append(f"{key}: resolves to both {seen[key]!r} and {r['canonical']!r}")
        seen[key] = r["canonical"]
    for (artist, alias), canon in seen.items():
        hops, cur = 0, canon
        while (artist, cur) in seen and hops < 20:
            cur = seen[(artist, cur)]
            hops += 1
        if hops >= 20:
            bad.append(f"({artist}, {alias}): alias chain does not terminate")
    return bad, len(rows)


def check_additive():
    """Every alias, exercised through the real key builder."""
    bad = []
    for r in csv.DictReader(open(_ALIAS_FILE, encoding="utf-8")):
        printed = r["aliasAsPrinted"] or r["alias"]
        for number in ("1", "12.03", "II.4a", printed + "16"):
            plain = set(entry_exact_keys([[printed, number]]))
            withart = set(entry_exact_keys([[printed, number]], r["artist"]))
            if not plain <= withart:
                bad.append(f"{r['artist']} / {printed!r} + {number!r}: canonicalisation DROPPED "
                           f"{sorted(plain - withart)}")
    return bad


def main():
    failures, n = check_table()
    print(f"{'FAIL' if failures else 'ok  '}  alias table unambiguous and acyclic ({n} rows)")
    bad = check_additive()
    print(f"{'FAIL' if bad else 'ok  '}  canonicalisation is additive, never subtractive")
    failures += bad
    if failures:
        print("\n" + "\n".join(failures[:20]))
        print(f"\n{len(failures)} problem(s)")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
