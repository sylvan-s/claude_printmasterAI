"""
PrintMasterAI — Impression.copyType detection, shared by every auction ingest.
Version: COPY-TYPE-1.1

Through COPY-TYPE-1.0 each ingest (bonhams, forum, roseberys, swann) carried its own identical
copy of COPY_TYPE_KEYWORDS, whose BAT entry was the bare substring "bon". Any text containing
Bonnard, bonnet, Dibond, bone, ribbon, carbon, "Le Bon Samaritain"... was typed as a bon à tirer
proof. Measured 2026-09-16: 353 of the graph's 512 BAT impressions were false (Forum 28/28,
Roseberys 44/49, Swann 182/199, Bonhams 99/232, Skinner 1/4). Repaired by
repair_copy_type_bat.py; `src/appraisal/knowledge_graph/price_attrs.ts` detectCopyType mirrors
this module and must change with it, because live lots are classified the way training lots were.

Only the BAT rule changed. AP/HC/PP/TP keep their substring rules and the first-match order, so
the fix moves lots out of BAT (and a few in) without reshuffling any other type.

BAT now requires one of:
  * "bon à tirer" in any accent/hyphen spelling, including the "bon a tiré" typo;
  * "B.A.T." with the dots (any case), except the publisher "B.A.T. Suisse SA";
  * "BAT" or "BaT" as a whole word, case-sensitive — lowercase "bat" is the animal.
"""

import math
import re

COPY_TYPE_KEYWORDS = [
    ("AP", ["artist's proof", "artists proof", " ap ", "'ap'", "inscribed ap"]),
    ("HC", ["hors commerce", " hc ", "'hc'", "inscribed hc"]),
    ("PP", ["printer's proof", "printers proof", " pp "]),
    ("BAT", None),  # regex rule below, applied to the original-case text
    ("TP", ["trial proof", " tp "]),
]

BAT_PATTERNS = [
    re.compile(r"(?<!\w)bon[\s-]*[àáâa][\s-]*tir(?:er|é|e)(?!\w)", re.IGNORECASE),
    # "B.A.T. Suisse SA" is a Geneva publisher (2 Bonhams lots), not an annotation.
    re.compile(r"(?<!\w)B\.\s?A\.\s?T(?!\w)(?!\.?\s*Suisse)\.?", re.IGNORECASE),
    re.compile(r"(?<!\w)(?:BAT|BaT)(?!\w)"),
]

# The pre-1.1 table, kept only so repair_copy_type_bat.py can confirm a stored copyType is
# still exactly what the old ingest produced before replacing it.
LEGACY_COPY_TYPE_KEYWORDS = [
    ("AP", ["artist's proof", "artists proof", " ap ", "'ap'", "inscribed ap"]),
    ("HC", ["hors commerce", " hc ", "'hc'", "inscribed hc"]),
    ("PP", ["printer's proof", "printers proof", " pp "]),
    ("BAT", ["bon", " bat "]),
    ("TP", ["trial proof", " tp "]),
]


def _present(v):
    return v is not None and not (isinstance(v, float) and math.isnan(v)) and str(v) != ""


def is_bat(text):
    return any(p.search(text or "") for p in BAT_PATTERNS)


def detect_copy_type(*texts):
    raw = " ".join(str(t) for t in texts if _present(t))
    lower = f" {raw} ".lower()
    for label, keywords in COPY_TYPE_KEYWORDS:
        if label == "BAT":
            if is_bat(raw):
                return label
        elif any(kw in lower for kw in keywords):
            return label
    return "numbered"


def legacy_detect_copy_type(*texts):
    """Byte-for-byte the old per-ingest behaviour, including roseberys/forum's
    f" {edition_note or ''} {title or ''} " (a NaN cell rendered as "nan")."""
    t = f" {' '.join(str(x or '') for x in texts)} ".lower()
    for label, keywords in LEGACY_COPY_TYPE_KEYWORDS:
        if any(kw in t for kw in keywords):
            return label
    return "numbered"
