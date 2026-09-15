"""
PrintMasterAI — free-text parsing helpers for the Swann Auction Galleries pull
(swann_ingest.py)
Version: SWANN-PARSING-1.0

Source: benchmark/data/swann/catalogue.json (16,336 rows, pulled 2026-09-15 by
benchmark/src/swann/pull.ts from Swann's own public getAlgoliaResults endpoint — see that
tool's docstring for how the data was obtained). Unlike Roseberys/Forum (pre-parsed into
columns by an external tool) but LIKE Bonhams, this source gives no structured artist/title
split at all: `lotTitle` bundles both ("Albrecht Dürer (1471-1528), The Holy Family with the
Butterfly, circa 1495.") and `artistName` — despite being a real, requestable Algolia field
— is empty on every single row of this pull (confirmed: 0/16,336; not just sparse on older
sales the way first guessed, see benchmark/src/swann/api.ts's own corrected docstring note).
Every extraction below is HEURISTIC_EXTRACTION (doc 09 §1), verified against real sampled
records, not a verified crosswalk — same trust tier as bonhams_parsing.py.

Swann's own cataloguing text is internally inconsistent in a way neither Roseberys nor
Bonhams is, confirmed by direct inspection, not assumed:
  - the name/dates parenthetical is SOMETIMES followed by a comma before the title
    ("Dürer (1471-1528), The Holy Family...") and sometimes not ("Dürer (1471-1528) Jan
    Uytenbogaert..." — same Rembrandt work, two different catalogues). A name-boundary
    heuristic that relies on the comma silently swallows the whole title into the "name"
    whenever it's absent.
  - a large minority of records (older sales especially, but not exclusively) carry NO
    parenthetical at all — just an ALL-CAPS name run followed directly by a mixed-case
    title ("MILTON AVERY Flight.", "ALBRECHT DÜRER The Lamentation.").
  - a bare single-letter word ("A Hurdy-Gurdy Player...") looks like an initial to a naive
    all-caps-token scanner but is almost always the article "A" starting the title, not an
    initial — a real initial in this corpus is always followed by a period ("A.", "J. M.").
  - a parenthetical elsewhere in the title that ISN'T the name/qualifier slot ("Le Chapeau
    Épinglé (2e planche)") looks identical in shape to the real one at a glance.

extract_artist_and_title() below is the result of iterating against all four of those
confirmed failure modes on the real 16,336-row corpus (see the conversation this module
was built in for the before/after match-rate numbers), not a one-shot design.
"""

import re

QUALIFIER_WORDS = [
    ("after", "after"),
    ("attributed to", "attributed_to"),
    ("attr. to", "attributed_to"),
    ("attr.", "attributed_to"),
    ("circle of", "circle_of"),
    ("manner of", "manner_of"),
    ("in the manner of", "manner_of"),
    ("school of", "school_of"),
    ("follower of", "follower_of"),
    ("studio of", "studio_of"),
    ("workshop of", "studio_of"),
]
# Longest phrase first so "attributed to" is tried before a hypothetical shorter overlap.
QUALIFIER_WORDS.sort(key=lambda p: -len(p[0]))

_YEAR_RANGE_RE = re.compile(r"\b(\d{4})\s*-\s*(\d{2,4})\b")
_BARE_YEAR_RE = re.compile(r"\b(\d{4})\b")
_BORN_RE = re.compile(r"\bb\.?\s*(\d{4})\b", re.IGNORECASE)
_DIED_RE = re.compile(r"\bd\.?\s*(\d{4})\b", re.IGNORECASE)
# Trailing date clause on a title line: ", circa 1495.", ",1496-98.", " 1645." — comma
# before it optional (confirmed both forms occur), "circa"/"c." prefix optional.
_TRAILING_DATE_RE = re.compile(
    r",?\s*(?:circa\s+|c\.\s*)?(\d{4})(?:[-/]\d{2,4})?\s*\.?\s*$", re.IGNORECASE
)
_PLAUSIBLE_YEAR_RANGE = (1200, 2030)


def _plausible_year(y):
    try:
        y = int(y)
    except (TypeError, ValueError):
        return None
    return y if _PLAUSIBLE_YEAR_RANGE[0] <= y <= _PLAUSIBLE_YEAR_RANGE[1] else None


def _parse_paren_content(inner):
    """inner = the text INSIDE one '(...)' group, already stripped. Returns
    (qualifier_or_None, begin_year_or_None, end_year_or_None) — whichever this
    parenthetical actually carries; a given parenthetical is either a qualifier OR a
    dates slot in this corpus, never both at once (unlike Bonhams' combined
    "(French, 1928-1987)" nationality+dates form — Swann never puts nationality here at
    all, confirmed by sampling)."""
    low = inner.lower().strip()
    for phrase, qualifier in QUALIFIER_WORDS:
        if low == phrase or low.rstrip(".") == phrase:
            return qualifier, None, None
    m = _YEAR_RANGE_RE.search(inner)
    if m:
        begin = _plausible_year(m.group(1))
        end_raw = m.group(2)
        end = _plausible_year(end_raw if len(end_raw) == 4 else m.group(1)[:2] + end_raw)
        return None, begin, end
    m = _BORN_RE.search(inner)
    if m:
        return None, _plausible_year(m.group(1)), None
    m = _DIED_RE.search(inner)
    if m:
        return None, None, _plausible_year(m.group(1))
    return None, None, None


_ACTIVITY_PAREN_RE = re.compile(r"\b(\d{1,2}(?:st|nd|rd|th)\s+century|active\b|fl\.|contemporary)\b", re.IGNORECASE)


def _is_activity_paren(inner):
    """A handful of records (5/16,336, all minor 20th-c. American printmakers) use
    "(20th Century)" as the name-boundary slot instead of real dates — no qualifier or
    year to extract from it, but it still marks the name boundary, so it must count as
    "recognized" the same way a real qualifier/dates match does, or the whole title
    after it gets swallowed into the artist name (confirmed real: "Katherina Larson
    (20th Century) Flowers in Blue Vase." parsed with artistName = the entire string,
    title = None, before this check)."""
    return bool(_ACTIVITY_PAREN_RE.search(inner))


def _is_all_caps_token(tok):
    stripped = tok.strip(".,")
    if not stripped or re.search(r"[a-zà-ÿ]", stripped):
        return False
    if not re.search(r"[A-ZÀ-Ý]", stripped):
        return False
    # A bare single uppercase letter ("A", "I") is almost always the article "A ..."
    # starting the title, not an initial — a real initial here is always followed by a
    # period ("A.", "J."). See module docstring.
    if len(stripped) == 1 and "." not in tok:
        return False
    return True


def _all_caps_name_run(text):
    """Returns (name, rest_start_index) for a leading run of ALL-CAPS tokens, or
    (None, 0) if the text doesn't start with one."""
    tokens = text.split(" ")
    i = 0
    while i < len(tokens) and _is_all_caps_token(tokens[i]):
        i += 1
    if i == 0:
        return None, 0
    name = " ".join(tokens[:i]).strip(" .,")
    rest_start = len(" ".join(tokens[:i]))
    return name, rest_start


def extract_artist_and_title(lot_title):
    """Splits one lotTitle into (artistName, qualifier, artistBeginYear, artistEndYear,
    title, titleYear). `title` still has trailing punctuation stripped but is otherwise
    the free-text remainder — extract_year_from_description() below is the primary year
    source in practice (see its own docstring); titleYear here is a same-string fallback
    for the cases where the title line itself carries one ("circa 1495.", "1645.")."""
    text = (lot_title or "").strip()

    name = None
    qualifier = "direct"
    begin_year = end_year = None
    rest = text

    m = re.match(r"^([^(]{1,80}?)\s*\(", text)
    if m and len(m.group(1).split()) <= 6:
        name_candidate = m.group(1).strip().rstrip(",")
        pos = m.end() - 1  # index of the '('
        # Consume up to two consecutive "(...)" groups right after the name — Swann's
        # rarer double-parenthetical form is a qualifier followed by the real artist's
        # own life dates ("Anne Allen (after Jean-Baptiste Pillement) (c. 1750-1808)
        # Chinoiserie") — see module docstring; only the qualifier/dates content is
        # consumed, so this deliberately does not attempt to record the secondary
        # "after [other artist]" relationship (no relationship for it in this schema —
        # doc 09 §1 UNMAPPED, not silently mismodeled).
        consumed_any = False
        cursor = pos
        for _ in range(2):
            pm = re.match(r"\(([^()]*)\)", text[cursor:])
            if not pm:
                break
            q, b, e = _parse_paren_content(pm.group(1))
            # Only treat this parenthetical as the name-boundary marker if it actually
            # looks like a qualifier or dates slot — otherwise it's an aside INSIDE the
            # title ("(2e planche)", "(Jacob and Laban?)") that merely happens to be the
            # first "(" in the string, and consuming it swallows the whole title into
            # "name" (confirmed real: "REMBRANDT VAN RIJN Three Oriental Figures (Jacob
            # and Laban?)." parsed as name="...Figures", title=None before this check).
            if not (q or b or e) and not _is_activity_paren(pm.group(1)):
                break
            if q:
                qualifier = q
            if b:
                begin_year = begin_year or b
            if e:
                end_year = end_year or e
            consumed_any = True
            cursor += pm.end()
            if not re.match(r"^\s*\(", text[cursor:]):
                break
        if consumed_any:
            name = name_candidate
            rest = text[cursor:].strip()
            rest = re.sub(r"^,\s*", "", rest)

    if name is None:
        caps_name, rest_start = _all_caps_name_run(text)
        if caps_name:
            name = caps_name
            rest = text[rest_start:].strip(" .,")
        elif "," in text:
            name, _, rest = text.partition(",")
            name = name.strip()
            rest = rest.strip()
        else:
            name = text
            rest = ""

    # A trailing date clause ("circa 1495.", ",1496-98.", "1645.") is part of the title
    # STRING but not part of the title itself — strip it the same way
    # bonhams_parsing.parse_lot_desc_title_line() strips a trailing year, so `title`
    # comes out clean ("The Holy Family with the Butterfly", not "...Butterfly, circa
    # 1495"). Anchored to the END only, so a year that's genuinely part of the title's
    # own content elsewhere isn't touched.
    title_year = None
    tm = _TRAILING_DATE_RE.search(rest)
    if tm:
        title_year = _plausible_year(tm.group(1))
        rest = rest[: tm.start()]

    title = rest.strip().rstrip(",.").strip()
    return {
        "artistName": name,
        "qualifier": qualifier,
        "artistBeginYear": begin_year,
        "artistEndYear": end_year,
        "title": title or None,
        "titleYear": title_year,
    }


def extract_year_from_description(lot_description, artist_name):
    """The medium+year clause is reliably the SECOND '. '-delimited sentence of
    lotDescription ("Rembrandt van Rijn (1606-1669) Abraham and Isaac. Etching, 1645."
    -> sentence[1] = "Etching, 1645") — confirmed across sampled records spanning
    2004-2026. Falls back to scanning the whole description (capped to the first 300
    chars, so a year mentioned in condition/provenance prose late in a long description
    is never mistaken for the creation date) if that sentence doesn't parse."""
    text = lot_description or ""
    sentences = re.split(r"\.\s+(?=[A-Z])", text.strip())
    sentences = [s for s in sentences if s.strip()]
    if len(sentences) >= 2:
        m = _YEAR_RANGE_RE.search(sentences[1]) or _BARE_YEAR_RE.search(sentences[1])
        if m:
            return _plausible_year(m.group(1))
    m = _YEAR_RANGE_RE.search(text[:300]) or _BARE_YEAR_RE.search(text[:300])
    return _plausible_year(m.group(1)) if m else None


# ---- Catalogue-raisonné citation text (fed to the shared catalogue_matching.py, not
# re-parsed here — same discipline as bonhams_parsing.parse_lot_desc_title_line) ----
#
# The citation clause is USUALLY the last sentence of lotDescription ("... Bartsch 44;
# Meder 42."), but not always: a real minority of records append a provenance/condition
# sentence AFTER it ("... Bartsch 44; Meder 42. Property from the Eric Carlson Irrevocable
# Trust."). A naive "take the last sentence" reading of those specific rows misses the
# real citation entirely, and a naive "take whichever sentence has a trailing digit-ish
# token" reading produces real garbage (catalogue_matching.parse_catalogue_refs() has no
# digit requirement on the entry-number token at all — only on whether a COMMA is safe to
# split on — so "Provenance: Private collection, New York" parses as a "citation" naming
# catalogue "Provenance: Private collection, New" entry "York" without an extra check).
# Both confirmed on this corpus, not hypothetical (see the conversation this module was
# built in for the measured before/after junk-rate).
#
# So this scans backward through the trailing few sentences and additionally requires,
# on top of genuine_refs()'s own filtering, that the entry-number token actually look
# like one (leading digit, optional short suffix, or a roman numeral) and that the
# catalogue-name side stays short (a real citation is 1-4 words; a provenance/condition
# sentence that happens to satisfy the bare regex is not). Recall on this corpus: 71.9%
# of rows produce a plausible citation this way; the remainder mostly have no formal
# catalogue-raisonné reference at all (minor/uncatalogued prints) rather than a parsing
# miss — ConceptualWork identity then falls back to the per-lot id, same graceful
# degradation catalogue_matching.build_conceptual_work_id() already does for every
# adapter when no genuine ref is present.
_ENTRY_NUMBER_RE = re.compile(r"^(?:[ivxlcdm]+|\d+[a-zA-Z\-]{0,4})$", re.IGNORECASE)
_CITATION_REJECT_FIRST_WORDS = {
    "a", "we", "he", "she", "it", "they", "property", "provenance", "thence",
    "ex-collection", "very", "the", "signed", "edition", "published", "printed",
    "each", "trimmed", "university",
}


def _looks_like_citation_sentence(sentence, genuine_refs_fn, parse_refs_fn):
    refs = genuine_refs_fn(parse_refs_fn(sentence))
    if not refs:
        return None
    for r in refs:
        words = r["catalogueName"].split()
        if len(words) > 5:
            return None
        if words and words[0].lower().strip("(") in _CITATION_REJECT_FIRST_WORDS:
            return None
        if not _ENTRY_NUMBER_RE.match(r["entryNumber"]):
            return None
    return sentence


def extract_catalogue_ref_text(lot_description, genuine_refs_fn, parse_refs_fn):
    """Returns the raw text of the best-guess citation sentence (still needs
    genuine_refs_fn(parse_refs_fn(...)) applied by the caller for the real parse — this
    just picks WHICH sentence to hand it, same "return raw text, let catalogue_matching
    parse it" contract bonhams_parsing.parse_lot_desc_title_line() uses), or None."""
    text = lot_description or ""
    sentences = re.split(r"\.\s+(?=[A-Z])", text.strip())
    sentences = [s.rstrip(".").strip() for s in sentences if s.strip()]
    for s in reversed(sentences[-3:]):
        if _looks_like_citation_sentence(s, genuine_refs_fn, parse_refs_fn):
            return s
    return None


# ---- Multi-work lot detection (no pre-supplied column, same situation Bonhams was in —
# a from-scratch heuristic, documented as such) ----
_NUMBER_WORDS = "two|three|four|five|six|seven|eight|nine|ten|\\d+"
_LEADING_COUNT_RE = re.compile(
    rf"^(?:{_NUMBER_WORDS})\s+(?:works?|prints?|lithographs?|etchings?|woodcuts?|"
    rf"engravings?|photographs?|posters?|drawings?|color\s+\w+s?)\b",
    re.IGNORECASE,
)
_GROUP_OF_RE = re.compile(r"^group of\s+\d+", re.IGNORECASE)
_MULTI_PHRASES = [
    "comprising", "a set of", "a group of", "the complete set of",
    "the complete portfolio of", "together with", "a collection of",
]
# "(i) ... (ii) ..." — an itemized enumeration within one lot description, confirmed
# real (the Hans Neumann "Two color woodcuts" example this module's docstring cites).
_ROMAN_ITEM_RE = re.compile(r"\((?:i{1,3}|iv|v)\)", re.IGNORECASE)


def detect_multi_work(title, lot_description):
    """`title` should be the ALREADY-EXTRACTED title (extract_artist_and_title()'s
    output), not the raw lotTitle — the leading count phrase this looks for sits after
    the artist-name prefix, not at the start of the raw string."""
    title = (title or "").strip()
    desc = lot_description or ""
    if _LEADING_COUNT_RE.search(title) or _GROUP_OF_RE.search(title):
        return True, "leading_count_in_title"
    low_title = title.lower()
    for phrase in _MULTI_PHRASES:
        if phrase in low_title:
            return True, f"phrase_in_title:{phrase}"
    if len(_ROMAN_ITEM_RE.findall(desc)) >= 2:
        return True, "roman_numeral_enumeration"
    return False, None
