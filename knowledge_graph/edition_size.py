"""
PrintMasterAI — declared edition size, read out of free-form catalogue prose.
Version: EDITION-SIZE-1.0

One question — "how large was the run this impression belongs to?" — that had four separate
implementations, each patched on its own. See docs/adr/0020-shared-parsing-rule-modules.md for
the measured divergence table; the short version is that they disagreed on 8 of 24 corpus cases
and on 1,342 real Bonhams/Skinner/Swann impressions.

Three bugs have been fixed in this family, each in one implementation at a time:

  * Forum read the first imperial fraction in "510 x 647mm (20 x 25 3/8in)" as an edition of 8,
    putting 1,442 priced sales in the <=30 band (2026-09-17). Guarded by
    check_forum_edition_fractions.py.
  * The price model's text fallback did the same to 6,257 Bonhams training rows.
  * "edition of 1,000" stopped at the comma and stored an edition of 1, in both the ingest and
    the model (229 EditionRuns, 2026-09-17). Guarded by check_edition_thousands.py.

EDITION-SIZE-1.0 IS A MOVE, NOT A FIX. The two functions below are byte-faithful copies of the
two Python implementations as they stood on 2026-09-20, kept separate and separately named
precisely because they do not agree. Reconciling them is a later, separately measured change —
a move and a behaviour change in one commit can be neither reviewed nor bisected.

`src/shared/text_extraction.ts` detectEditionSize mirrors `size_from_text_model` and must change
with it: live lots are classified the way training lots were, so a rule that moves here without
moving there silently splits the two.

Precedence is the same in both: a `numbered n/N` fraction beats an `edition of N` elsewhere in
the sentence, because the fraction names the run THIS impression belongs to and the other number
may be a different run ("numbered 12/50 ... there was also an unsigned edition of 500").
"""

import re

# "1,000" is one number, not 1 — the 2026-09-17 thousands-separator defect.
_EDITION_NUMBER = r"(\d{1,3}(?:,\d{3})+|\d+)"
_EDITION_NUMBER_CAPPED = r"(\d{1,3}(?:,\d{3})+|\d{1,5})"
_APPROX = r"(?:approximately\s+|approx\.\s*|about\s+|circa\s+|c\.\s*|ca\.\s*)?"
# Without this, "(20 x 25 3/8in)" reads as an edition of 8.
_NOT_A_DIMENSION = r'(?!\s*(?:mm\b|cm\b|["”]))'

# ---- Ingest rule: bonhams_parsing.extract_edition_size, serving bonhams_ingest + swann_ingest.
# Accepts roman impression numbers ("numbered XII/50"), which the model rule does not. Carries no
# mm/cm/inch lookahead: it is shielded instead by requiring the literal "number(ed)" prefix
# immediately before the fraction, so a bare dimension fraction can never reach it. Does NOT
# accept "No. 45/250" or "numbered in pencil 3/8" — 343 real impressions, 318 of them with no
# stored size (ADR-0020).
_INGEST_NUMBERED_FRACTION_RE = re.compile(
    r"number(?:ed)?\s+['\"]?[ivxlcdm\d]+\s*/\s*" + _EDITION_NUMBER, re.IGNORECASE)
_INGEST_EDITION_OF_RE = re.compile(r"edition of\s+" + _EDITION_NUMBER, re.IGNORECASE)

# ---- Model rule: train_price_model's text fallback, used only when the graph has no declared
# size. Accepts "No."/"in pencil", the approximately/circa qualifiers and "one of N impressions";
# rejects roman numerals; caps the number at five digits.
_MODEL_NUMBERED_RE = re.compile(
    r"\b(?:numbered|no\.)\s*(?:in pencil\s*)?['\"‘’“”]?\d+\s*/\s*"
    + _EDITION_NUMBER_CAPPED + r"\b" + _NOT_A_DIMENSION, re.I)
_MODEL_EDITION_OF_RE = re.compile(r"\bedition of\s+" + _APPROX + _EDITION_NUMBER_CAPPED + r"\b", re.I)
_MODEL_ONE_OF_RE = re.compile(
    r"\bone of\s+" + _APPROX + _EDITION_NUMBER_CAPPED
    + r"\s+(?:impressions|copies|examples)\b", re.I)

_MODEL_RULES = (_MODEL_NUMBERED_RE, _MODEL_EDITION_OF_RE, _MODEL_ONE_OF_RE)


def _first(text, *patterns, positive_only):
    """`positive_only` is the one place the two rules differ mechanically: the model rule
    treats a parsed 0 as no answer and tries the next pattern, the ingest rule returns it.
    Preserved rather than unified, so EDITION-SIZE-1.0 stays a pure move."""
    for rx in patterns:
        m = rx.search(text or "")
        if m:
            n = int(m.group(1).replace(",", ""))
            if not positive_only or n > 0:
                return n
    return None


def size_from_text_ingest(text):
    """The ingest rule, as bonhams_ingest and swann_ingest have always applied it."""
    return _first(text, _INGEST_NUMBERED_FRACTION_RE, _INGEST_EDITION_OF_RE,
                  positive_only=False)


def size_from_text_model(text):
    """The price model's text fallback, as train_price_model has always applied it."""
    return _first(text, *_MODEL_RULES, positive_only=True)
