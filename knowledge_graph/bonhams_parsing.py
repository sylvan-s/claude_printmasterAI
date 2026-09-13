"""
PrintMasterAI — free-text/HTML parsing helpers for the Bonhams Group 'Prints &
Multiples' export (bonhams_ingest.py)
Version: BONHAMS-PARSING-1.1

Unlike Roseberys/Forum (already parsed into columns by an external tool before this
project ever saw them), this source is raw per-lot catalog HTML — much closer to the
original Roseberys *live-page* pilot adapter (doc 09 section 3, all HEURISTIC_EXTRACTION)
than to roseberys_ingest.py/forum_ingest.py's bulk CSV adapters. Every extraction here is
best-effort free-text parsing verified against real sampled records (see doc 09's new
Bonhams section for the specific cases checked), not a verified crosswalk — treat every
field this module derives as HEURISTIC_EXTRACTION per doc 09 §1, same trust tier as the
original Roseberys live-page adapter's "printed by X" phrase-finding.

Two fields are DIRECT, not derived here at all, because the source JSON already supplies
them cleanly: the artist's bare name (`artist` field, confirmed identical to the text
preceding LotName's own parenthetical) and the catalogue-refs/ConceptualWork identity
keying itself (delegated entirely to catalogue_matching.py, shared with Roseberys/Forum,
so a Bonhams citation like "Cramer 717" or "V. 206; C. bk. 30" gets the exact same
artist+catalogue+entry+title identity-keying discipline, including the same NON_CATALOGUE_
NAMES guard and no-fuzzy-matching rule).
"""

import re

_TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(s):
    return _TAG_RE.sub("", s or "").strip()


def _extract_div(html, class_name):
    m = re.search(
        rf'<div\s+class=["\']?{class_name}["\']?[^>]*>(.*?)</div>',
        html or "", re.IGNORECASE | re.DOTALL,
    )
    return m.group(1) if m else None


def extract_lot_heading(html):
    v = _extract_div(html, "LotHeading")
    return strip_tags(v) or None if v is not None else None


def extract_lot_name_html(html):
    return _extract_div(html, "LotName")


def extract_lot_desc_html(html):
    return _extract_div(html, "LotDesc")


# ---- Artist qualifier prefix (HEURISTIC_EXTRACTION, mirrors doc 09 section 3's
# original Roseberys single-lot adapter, not the bulk-CSV one) ----
# "attr. to "/"attr. "/"attributed " (abbreviated/bare forms) found missing 2026-09-06
# — 7 live Bonhams Artist nodes ended up as "Attr. Marc Chagall"/"Attr. to Pablo
# Picasso"/"Attributed Edith Catlin Phelps"/etc., the full qualifier text swallowed
# into the artist NAME with `qualifier` silently left at the wrong default ("direct"),
# because only the spelled-out "attributed to " was recognized before this fix.
QUALIFIER_PREFIX_MAP = [
    ("attributed to ", "attributed_to"),
    ("attr. to ", "attributed_to"),
    ("attr. ", "attributed_to"),
    ("attributed ", "attributed_to"),
    ("in the manner of ", "manner_of"),
    ("manner of ", "manner_of"),
    ("circle of ", "circle_of"),
    ("follower of ", "follower_of"),
    ("studio of ", "studio_of"),
    ("school of ", "school_of"),
    ("after ", "after"),
]

_TRAILING_BY_RE = re.compile(r"\s+by\s+.+$", re.IGNORECASE)


def strip_qualifier_prefix(raw_artist):
    """Returns (qualifier, remainder). remainder still needs clean_artist_name()."""
    s = (raw_artist or "").strip()
    low = s.lower()
    for prefix, qualifier in QUALIFIER_PREFIX_MAP:
        if low.startswith(prefix):
            return qualifier, s[len(prefix):].strip()
    return "direct", s


# ---- Leading parenthetical (BONHAMS-PARSING-1.1) ----
# Bonhams has a SECOND, rarer house convention for artist names: a LEADING parenthetical
# holding the artist's real/birth name, or the literal placeholder "(n/a)" where no such
# name is recorded — "(n/a) Andy Warhol", "(Jules Isnard) Dransy", "(Lucien) Alton
# Pickens", "(MIODRAG DURIC) DADO". Everything else in this module was written for the
# usual TRAILING "(nationality, dates)" parenthetical, and both parsers got this wrong
# in a way confirmed live on 2026-09-11, not hypothetically:
#
#   * clean_artist_name() truncates at the FIRST "(", which for these is index 0 — it
#     returned "". Because bonhams_ingest.py keys on `MERGE (artist:Artist {name: ...})`,
#     all 18 loaded lots of this shape collapsed onto ONE nameless Artist node carrying
#     17 alternateNames ("(n/a) Banksy", "(n/a) Georges Braque", ...) and 18 CREATED
#     edges. Repaired in-graph 2026-09-11; this is the source-level fix.
#   * parse_lot_name() reads the FIRST parenthetical for nationality/life-dates, so it
#     returned nationality="n/a" / "Jules Isnard" and silently lost the real values
#     ("American", 1952-2001). In the LotName text the same slot is also used for lot
#     COUNTS on grouped lots — "(Two) David Klein, ...", "(6) FROM THE SOCIETY OF
#     AMERICAN ETCHERS" — which previously yielded nationality="Two"/"6". 61 LotName
#     texts in the export begin with a parenthetical; none of them is the nationality.
#
# The one shape deliberately NOT stripped is a leading parenthetical that itself holds
# life dates ("(1933-2010)"), since there the parenthetical IS the dates slot and
# removing it would destroy the very data this function exists to extract.
_LEADING_PAREN_RE = re.compile(r"^\s*\([^)]*\)\s*")


def strip_leading_parenthetical(s):
    """Removes a LEADING "(...)" group — a real/birth name, an "(n/a)" placeholder, or a
    grouped-lot count — so the trailing "(nationality, dates)" parenthetical is the one
    the rest of this module sees. Leaves the string alone when the leading parenthetical
    carries life dates (it is then the dates slot itself, not a prefix), when there is no
    leading parenthetical, or when stripping would empty the string outright — that last
    guard exists because an empty artist name is exactly the failure this fix removes, so
    this function must never be the thing that produces one."""
    s = (s or "").strip()
    m = _LEADING_PAREN_RE.match(s)
    if not m:
        return s
    inner = m.group(0)
    if _YEAR_RANGE_RE.search(inner) or _BORN_RE.search(inner):
        return s
    remainder = s[m.end():].strip()
    return remainder or s


_LOWERCASE_CONNECTORS = {"de", "van", "der", "den", "la", "le", "di", "du", "von", "y", "of"}


def normalize_all_caps_name(name):
    """Bonhams' own catalogue data formats some lots' artist names in ALL CAPS (a real
    house-style inconsistency, confirmed live: every ALL-CAPS Artist node created by an
    early version of this adapter was attributed ONLY to Bonhams/Skinner SourceRecords —
    a fresh duplicate of an already-known artist, e.g. 'PABLO PICASSO' alongside the
    existing 'Pablo Picasso' — never a genuinely different, coincidentally-caps-only
    name). Only touches a name that is ALL CAPS (no lowercase letters at all); a mixed-
    case name is returned unchanged. Not a general-purpose title-caser — doesn't handle
    Mc/Mac-prefixed surnames or apostrophed names perfectly, just enough to avoid
    recreating the ALL-CAPS duplication bug found and fixed live 2026-09-06 (182 nodes
    merged via merge_case_duplicate_artists.py) on any future re-run of this adapter."""
    if not name or name != name.upper() or name == name.lower():
        return name
    words = name.split(" ")
    out = []
    for i, w in enumerate(words):
        if i > 0 and w.lower() in _LOWERCASE_CONNECTORS:
            out.append(w.lower())
        else:
            out.append(w[:1] + w[1:].lower() if w else w)
    return " ".join(out)


def clean_artist_name(remainder):
    """Handles two confirmed real messes in the `artist` field (found by direct
    sampling, not assumed): a reproducing-printmaker fragment ('After Marc Chagall, by
    Charles Sorlier' -> drop ', by Charles Sorlier', same shape as Forum's own
    _TRAILING_BY_RE case, reused here) and a rarer case where title text leaked into the
    artist field itself ('After Pablo Picasso (Spanish, 1881-1973) Alanceando a un
    toro,' -> truncate at the first '(' the same way nationality/dates would be
    stripped, since here it's a leaked title fragment instead)."""
    s = _TRAILING_BY_RE.sub("", remainder or "").strip()
    paren_idx = s.find("(")
    if paren_idx != -1:
        s = s[:paren_idx].strip()
    return s.rstrip(",.").strip()


# ---- LotName parenthetical: nationality + life dates ----
# "(British, 1898-1986)" / "(1881-1973)" / "(French, born 1919)" / "(born 1926)"
_LOTNAME_PAREN_RE = re.compile(r"\(([^)]*)\)")
_YEAR_RANGE_RE = re.compile(r"\b(\d{4})\s*-\s*(\d{4})\b")
_BORN_RE = re.compile(r"\bborn\s+(\d{4})\b", re.IGNORECASE)
_BARE_YEAR_RANGE_RE = re.compile(r"^(\d{4})-(\d{4})$")
_NON_NATIONALITY_VALUES = {"n/a", "na", "n.a.", "unknown", "-"}


def parse_lot_name(lot_name_html):
    """Returns (nationality, begin_year, end_year). Name itself is NOT re-derived here
    -- the source's own `artist` JSON field is already the clean DIRECT value (confirmed
    by sampling: identical to the text preceding this parenthetical), so re-parsing it
    from HTML would just risk introducing a second, possibly-diverging copy.

    A LEADING parenthetical is dropped first (see strip_leading_parenthetical): on this
    source that slot holds a real/birth name, an "(n/a)" placeholder or a grouped-lot
    count, never the nationality, and reading it as the nationality produced confirmed
    garbage values ("n/a", "Jules Isnard", "Two", "6") while silently losing the real
    nationality and life dates sitting in the trailing parenthetical."""
    text = strip_leading_parenthetical(strip_tags(lot_name_html or ""))
    m = _LOTNAME_PAREN_RE.search(text)
    if not m:
        return None, None, None
    inner = m.group(1)
    parts = [p.strip() for p in inner.split(",")]
    nationality = None
    begin_year = end_year = None

    range_m = _YEAR_RANGE_RE.search(inner)
    born_m = _BORN_RE.search(inner)
    if range_m:
        begin_year, end_year = int(range_m.group(1)), int(range_m.group(2))
    elif born_m:
        begin_year = int(born_m.group(1))

    # nationality = the first comma-part that isn't itself a dates/born fragment, a bare
    # number (grouped-lot counts like "(2)"/"(6)" reach here when the count is the ONLY
    # parenthetical, so stripping it would have emptied the text) or the source's own
    # "n/a" placeholder — all three were confirmed live as nationality values.
    for p in parts:
        if _YEAR_RANGE_RE.search(p) or _BORN_RE.search(p) or p.strip().isdigit():
            continue
        if p.strip().lower() in _NON_NATIONALITY_VALUES:
            continue
        nationality = p or None
        break
    return nationality, begin_year, end_year


# ---- LotDesc: title line + catalogue refs + year, then free-text detail ----
_BR_SPLIT_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TRAILING_YEAR_RE = re.compile(r",?\s*(\d{4}(?:[-/]\d{2,4})?|n\.?d\.?)\s*$", re.IGNORECASE)
_LAST_PAREN_RE = re.compile(r"\(([^()]+)\)\s*$")


def parse_lot_desc_title_line(line_text):
    """line_text is already tag-stripped. Returns (title, raw_catalogue_ref_text, year_str).
    Heuristic ordering: strip a trailing year/n.d. token first, then check whether what's
    left ends in a parenthetical that CONTAINS A DIGIT (a real catalogue citation
    ('Cramer 717', 'V. 206; C. bk. 30') always does; a bare descriptive aside like
    '(Figure)' never does -- confirmed against every sample pulled) -- catalogue_refs
    parsing itself is deliberately delegated to catalogue_matching.parse_catalogue_refs,
    not reimplemented here, so both adapters share one parsing+identity-keying rule."""
    s = line_text.strip()
    year = None
    ym = _TRAILING_YEAR_RE.search(s)
    if ym:
        year = ym.group(1)
        s = s[:ym.start()].strip()

    ref_text = None
    pm = _LAST_PAREN_RE.search(s)
    if pm and re.search(r"\d", pm.group(1)):
        ref_text = pm.group(1)
        s = s[:pm.start()].strip()

    title = s.strip().rstrip(",").strip() or None
    return title, ref_text, year


def parse_lot_desc(lot_desc_html):
    """Returns dict: title, catalogueRefText, year, detailText (remaining lines joined,
    used for technique/paper/signed/edition/printer/publisher/dimension extraction)."""
    raw = lot_desc_html or ""
    lines = [strip_tags(chunk) for chunk in _BR_SPLIT_RE.split(raw)]
    lines = [l for l in lines if l.strip()]
    if not lines:
        return {"title": None, "catalogueRefText": None, "year": None, "detailText": ""}
    title, ref_text, year = parse_lot_desc_title_line(lines[0])
    detail_text = " ".join(lines[1:])
    return {"title": title, "catalogueRefText": ref_text, "year": year, "detailText": detail_text}


# ---- Signed ----
def detect_signed(detail_text):
    if re.search(r"\bunsigned\b", detail_text, re.IGNORECASE):
        return False
    return bool(re.search(r"\bsigned\b", detail_text, re.IGNORECASE))


# ---- Edition size ----
_NUMBERED_FRACTION_RE = re.compile(r"number(?:ed)?\s+['\"]?[ivxlcdm\d]+\s*/\s*(\d+)", re.IGNORECASE)
_EDITION_OF_RE = re.compile(r"edition of\s+(\d+)", re.IGNORECASE)


def extract_edition_size(detail_text):
    m = _NUMBERED_FRACTION_RE.search(detail_text)
    if m:
        return int(m.group(1))
    m = _EDITION_OF_RE.search(detail_text)
    if m:
        return int(m.group(1))
    return None


# ---- Printer / publisher ----
_PRINTED_BY_RE = re.compile(r"printed by\s+([^,;.]+)", re.IGNORECASE)
_PUBLISHED_BY_RE = re.compile(r"published(?:/printed)?\s+by\s+([^,;.]+)", re.IGNORECASE)
_BLINDSTAMP_CONFLATED_RE = re.compile(
    r"blindstamp of the publisher/printer,?\s*([^,;.]+)", re.IGNORECASE
)


def extract_printer_publisher(detail_text):
    printer = None
    publisher = None
    m = _PRINTED_BY_RE.search(detail_text)
    if m:
        printer = m.group(1).strip()
    m = _PUBLISHED_BY_RE.search(detail_text)
    if m:
        publisher = m.group(1).strip()
    if printer is None and publisher is None:
        m = _BLINDSTAMP_CONFLATED_RE.search(detail_text)
        if m:
            printer = publisher = m.group(1).strip()
    return printer, publisher


# ---- Dimensions ----
# Prefers an explicit metric (cm/mm) pair; falls back to converting an inches pair when
# no metric is given. Labels sheet/plate/image when the line names one; unlabelled
# defaults to sheet, same convention roseberys_ingest.py/forum_ingest.py already use for
# an unlabelled dim_kind.
_DIM_LABEL_RE = re.compile(r"\b(sheet|plate|image|diameter)\b", re.IGNORECASE)
_METRIC_PAIR_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(cm|mm)\b")
_INCH_PAIR_RE = re.compile(r"(\d+(?:[\s\d/.]*))\s*[xX]\s*(\d+(?:[\s\d/.]*))\s*in\b", re.IGNORECASE)


def _mixed_fraction_to_float(s):
    s = s.strip()
    m = re.match(r"^(\d+)\s+(\d+)\s*/\s*(\d+)$", s)
    if m:
        whole, num, den = map(int, m.groups())
        return whole + num / den
    m = re.match(r"^(\d+)\s*/\s*(\d+)$", s)
    if m:
        num, den = map(int, m.groups())
        return num / den
    try:
        return float(s)
    except ValueError:
        return None


def extract_dimensions(detail_text):
    """Returns dict: sheetDimensions/imageDimensions/plateDimensions -> 'WxHcm' string
    or None. Scans line-by-line (dimension lines are usually distinct sentences/lines
    in the original HTML, but detail_text here is already joined with spaces -- so this
    scans the whole text for every dimension-shaped occurrence instead, tagging each by
    whatever label word appears in the ~20 chars immediately before it)."""
    out = {"sheetDimensions": None, "imageDimensions": None, "plateDimensions": None}
    for m in _METRIC_PAIR_RE.finditer(detail_text):
        w, h, unit = m.group(1), m.group(2), m.group(3).lower()
        if unit == "mm":
            w, h = float(w) / 10, float(h) / 10
        else:
            w, h = float(w), float(h)
        dims = f"{w:g}x{h:g}cm"
        _assign_dim(out, detail_text, m.start(), dims)
    if not any(out.values()):
        for m in _INCH_PAIR_RE.finditer(detail_text):
            w = _mixed_fraction_to_float(m.group(1))
            h = _mixed_fraction_to_float(m.group(2))
            if w is None or h is None:
                continue
            dims = f"{w * 2.54:g}x{h * 2.54:g}cm"
            _assign_dim(out, detail_text, m.start(), dims)
    return out


def _assign_dim(out, text, match_start, dims):
    window = text[max(0, match_start - 20):match_start].lower()
    lm = _DIM_LABEL_RE.search(window)
    label = lm.group(1).lower() if lm else None
    if label in ("plate",):
        key = "plateDimensions"
    elif label in ("image", "diameter"):
        key = "imageDimensions"
    else:
        key = "sheetDimensions"
    if out.get(key) is None:
        out[key] = dims


# ---- Multi-work lot detection (no pre-supplied column, unlike Roseberys/Forum -- this
# is a from-scratch heuristic, documented as such, not a re-implementation of a known-
# good signal) ----
_TRAILING_COUNT_RE = re.compile(r"\((\d+)\)\s*(?:\((?:box|portfolio|framed|unframed)\))?\s*$")
# "Two works: ..."/"Three works: ..." -- a Skinner house-style convention grouping N
# distinct prints under one shared lot description (confirmed real case: Elizabeth
# Catlett "Two works: Cabeza Indígena and Rebozos" -- detail text literally says "Two
# lithographs ... each signed", not one work with a compound title).
_NUMBER_WORDS = "two|three|four|five|six|seven|eight|nine|ten|\\d+"
_LEADING_WORKS_COUNT_RE = re.compile(rf"^(?:{_NUMBER_WORDS})\s+works?\s*:", re.IGNORECASE)
_MULTI_PHRASES = [
    "comprising", "the complete set of", "a set of", "a group of",
    "the complete portfolio of", "the complete boxed set", "together with",
    "and another by", "and one by", "a collection",
]

# "After X, and After Y" / "attributed to X, and attributed to Y" -- a second qualified
# attribution joined onto the first by "and". Confirmed real and MISSED by every check
# above (2026-09-07 incident): Bonhams lot 19117-7139, "After René  Magritte, and After
# Paul Wunderlich, Two Exhibition Posters" -- a 2-item, 2-artist lot. Its "(2)" markers
# are followed by medium/dimension text so _TRAILING_COUNT_RE's end-anchor never matched;
# its raw `title` field uses ";" as the separator but the semicolon check runs against
# the *parsed* title (derived from catalog_description's LotName, which phrases the join
# with a comma, not ";"), so that never fired either. Bonhams' own structured `artist`
# field only kept the first name ("After René Magritte"), and its `primary_image_url`
# happened to be the SECOND item -- so the lot was ingested as one Magritte-attributed
# ConceptualWork whose DigitalImage was actually the Wunderlich poster. Checks for "and "
# immediately followed by any qualifier prefix from QUALIFIER_PREFIX_MAP, not just
# "after", since the same construction plausibly recurs with "attributed to"/"in the
# manner of"/etc.
#
# Re-run against the full raw corpus (2026-09-07): 28 matches, of which 2 more were
# already-ingested bad data fixed alongside this incident (Bonhams lots 10248-114 --
# "George Townly Stubbs after George Stubbs, Godolphin Arabian... With one other by and
# after the same hand... and small collection of various sporting images" -- and
# 15203-103 -- Samuel Prout's genuine 29-view portfolio with "a small quantity of prints
# by and after various hands" tacked onto the same lot). Two of the 28 are KNOWN,
# ACCEPTED false positives, confirmed already-correct in the graph and deliberately not
# worked around: lot 18833-154 ("after the reworking by Captain Ballie and after the
# plate was divided" -- "after" used in its plain temporal sense, not as a second
# attribution) and lot 17089-9 (Patrick Procktor's real print title is literally "Cobra
# and After"). Both are single legitimate works this heuristic would now flag for
# exclusion on a fresh ingestion run -- an over-exclusion, not a corruption, which is the
# direction of error this heuristic (like every other one in this function) is meant to
# fail toward.
_AND_QUALIFIER_RE = re.compile(
    r"\band\s+(?:" + "|".join(re.escape(p.strip()) for p, _ in QUALIFIER_PREFIX_MAP) + r")\b",
    re.IGNORECASE,
)


def detect_multi_work(catalog_description_raw, title_raw, parsed_title=None):
    text = strip_tags(catalog_description_raw or "")
    if _LEADING_WORKS_COUNT_RE.match(text.strip()):
        return True, "leading_works_count"
    m = _TRAILING_COUNT_RE.search(text)
    if m and int(m.group(1)) > 1:
        return True, f"trailing_count_{m.group(1)}"
    low = text.lower()
    for phrase in _MULTI_PHRASES:
        if phrase in low:
            return True, f"phrase:{phrase}"
    if _AND_QUALIFIER_RE.search(low):
        return True, "and_qualifier_second_artist"
    # Confirmed real case (found by direct sampling): several distinct titles joined by
    # ";" on one title line with no trailing count marker at all ("Untitled (Reclining
    # Nude); Ostend; French Horn" -- three separate Auguste Brouet etchings in one lot,
    # confirmed by its own detail text literally saying "third title"). Requires 2+
    # segments each with more than one word, so a single title that merely contains one
    # incidental ";" isn't falsely flagged.
    if parsed_title:
        segments = [s.strip() for s in parsed_title.split(";")]
        substantial = [s for s in segments if len(s.split()) >= 2]
        if len(substantial) >= 2:
            return True, "semicolon_joined_titles"
    return False, None
