"""
PrintMasterAI — which Forum edition sizes are really imperial dimension fractions.
Version: FORUM-EDITION-SIZE-1.0

Forum's catalogue extract (benchmark/src/forum/parse.ts) fell back to a bare `\\d+/(\\d+)`
when a description had no "edition of N". Forum prints dimensions as
"510 x 647mm (20 x 25 3/8in)", so the first inch fraction became the edition size: 2, 4, 8
or 16. Found 2026-09-17 (Hockney *Self-Portrait* priced with a x0.51 "edition of 30" step,
because Hockney's <=30 band held 70 offset lithographs with editions of 2/4/8).

The parser is fixed, but catalogue.csv was written by the old one and does not keep the
description, so the value cannot be re-derived. The rule used by the ingest, the graph
repair and the guard check is therefore one function, here:

    an edition size of 2, 4, 8 or 16 is kept only when the row's edition note states
    "edition of <that number>"

Cost, accepted: a genuine "numbered 3/8" with no "edition of" phrase is also dropped (to
unknown, not to a wrong value). In the 2026-09-17 extract only 60 of ~2,800 such rows had a
note that confirmed the size.
"""

import re

FRACTION_DENOMINATORS = {2, 4, 8, 16}


def is_fraction_edition(edition_size, edition_note):
    """True when an edition size is probably an inch-fraction denominator, not an edition."""
    try:
        size = int(edition_size)
    except (TypeError, ValueError):
        return False
    if size != edition_size and not (isinstance(edition_size, float) and edition_size.is_integer()):
        return False
    if size not in FRACTION_DENOMINATORS:
        return False
    note = edition_note if isinstance(edition_note, str) else ""
    return not re.search(rf"\bedition of\s+{size}\b", note, re.IGNORECASE)
