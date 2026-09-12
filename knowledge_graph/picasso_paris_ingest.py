"""
PrintMasterAI — Musée national Picasso-Paris ingestion into the ACKG (Neo4j)
Version: PICASSO-PARIS-INGEST-0.1

Full write-up, including the survey of the other three Picasso museums and the legal
position: `knowledge_graph/picasso_museum_source_survey_2026-09-11.md`. Read §5 and §9
of that note before changing anything in this file — several rules here look like
over-engineering until you know which real record produced them.

Reads the local cache written by `picasso_paris_fetch.py`, never the live API.

Four things make this source structurally different from every adapter already in this
toolkit, all confirmed against the full 2,223-record print catalogue before any code was
written:

  1. **It is the first non-English source.** `mst` ("Aquatinte, grattoir et pointe sèche
     sur quatre cuivres... Epreuve tirée par Lacourière") is French free text, and
     `crosswalk_matching`'s keyword lists are English. The French terms are NOT added to
     that shared module — its own docstring warns about "the two divergent lists
     problem", and five adapters share those lists. Instead this adapter pre-translates
     its French into the English terms the crosswalk already knows (`_FR_TECHNIQUES`,
     `_FR_PAPERS`) and then calls `extract_techniques`/`extract_papers` unchanged. One
     vocabulary; the adapter that has a language problem carries it.

     **`vélin` is not "vellum".** French `vélin` is WOVE paper (`vélin d'Arches`,
     `vélin de Montval`) — 250 records use it — while English "vellum" in
     `PAPER_KEYWORDS` is calfskin. Translating it across would mislabel the single most
     common paper in the collection. `vélin` → `wove`, `vergé` → `laid`. (`japon`
     already matches the shared list as-is.)

  2. **"Geiser-Baer" and "Baer" are one numbering system, spelled two ways by the museum
     itself** — 1,143 records say the first, 355 the second, across overlapping number
     ranges. Confirmed, not assumed: 15 numbers are cited under BOTH prefixes inside
     this one source, and for 14 of them the records under each prefix carry an
     identical title and an identical creation date (e.g. #647 "Femme au fauteuil et au
     chapeau", mars 1939 — 11 impressions filed under "Baer", 30 under "Geiser-Baer").
     Left unnormalized, 1,143 of this source's 1,498 intaglio citations would never join
     the graph's existing `Baer` entries.

     `CATALOGUE_PREFIX_ALIAS` folds the two. It is an exact-string alias on a
     hand-verified pair — the same shape as `bm_ingest.py`'s `PILOT_ARTIST_RESOLUTION`,
     NOT a similarity match. `catalogue_matching.py`'s no-fuzzy-matching rule is not
     relaxed anywhere in this file.

     **The one real counter-example is excluded by inventory number.** MP3414
     "La Colombe" (9 janvier 1949) cites "Baer 141" but is a lithograph — `lavis sur
     zinc`, printed by Mourlot — so it cannot be in the Geiser-Baer intaglio sequence,
     which already contains a different work at 141 (MP2115 "La Pique", 1929, etching on
     copper printed by Fort). `Mourlot 141` exists in the live graph. This is a museum
     data-entry error; it gets a named exclusion rather than a silent pass, and its
     citation is dropped rather than guessed at.

  3. **The museum cites multiple catalogues COMMA-separated**, not semicolon-separated:
     "Geiser-Baer 35, Bloch 34". `catalogue_matching.parse_catalogue_refs` splits on ";"
     only, so its "last token = entry number" regex would produce the prefix
     "Geiser-Baer 35, Bloch" — confident-looking garbage of exactly the kind
     `NON_CATALOGUE_NAMES` exists to catch. `_split_multi_refs` splits on "," and " et "
     locally and hands each fragment to the shared parser intact.

     This same failure is ALREADY IN THE LIVE GRAPH from the auction adapters —
     `CatalogueRaisonne` nodes named "Bloch 182, Baer", "Vollard 140, Cramer bk.",
     "974, Cramer bk." and ~17 others. **Not fixed here.** Changing the shared parser
     means re-verifying a backfill across Forum/Roseberys/Bonhams; that is its own task
     with its own validation, not a side effect of onboarding a new source. Logged in
     the survey note §3.3.

  4. **187 of the 2,223 records are the plates themselves** (`domain_denomination:
     "Estampe, Matrice"`) — Picasso's own coppers (151), zinc (26), wood, linoleum,
     stone, celluloid, from the studio estate. These route through `LOAD_QUERY_MATRIX`
     (`Artist -[:MADE_MATRIX]-> Matrix`, `ConceptualWork -[:REALIZED_AS]-> Matrix`)
     instead of the impression pipeline, reusing the routing `bm_ingest.py` added for
     Trevelyan's cancelled zinc plate — where it covered 2 records. Here it is 187, and
     `Matrix.material` gets populated meaningfully for the first time.

A fifth difference, in the other direction — **this adapter does NOT apply a
zero-technique exclusion gate**, and that is a deliberate divergence from
`bm_ingest.py`. The BM gate exists because BM's `object_type=print` SEARCH FACET returns
drawings, so a record with no printmaking technique is evidence the facet was wrong.
Here `domain: Estampe` is the museum's own classification of its own holdings, which is
a much stronger claim than a search facet. A record whose technique string this adapter
cannot resolve (Picasso's one-off "erwinographie sur verre"; González's "gravure sur
tôle de fer") is a vocabulary gap on our side, not a misclassified drawing. Those
records load with `Impression.techniqueResolved = false` and are written to
`picasso_paris_unresolved_techniques.csv` for review — recorded, not dropped, and not
silently accepted either.

Field mapping, SEMANTIC_SPLIT rules for `mst` and `tirage`, and the UNMAPPED list
(exhibition history at 76% coverage, bibliography at 50%, ensemble membership at 10%)
are in the survey note §4–§7 rather than repeated here.

Usage:
    python knowledge_graph/picasso_paris_ingest.py --dry-run          # map + report, no writes
    python knowledge_graph/picasso_paris_ingest.py --limit 50         # small real load
    python knowledge_graph/picasso_paris_ingest.py --all
"""

import argparse
import csv
import html
import json
import os
import re
import time

from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques, extract_papers
from catalogue_matching import parse_catalogue_refs, genuine_refs, build_conceptual_work_id
from ulan_url import canonical_ulan_url


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in the "
            f"real Neo4j values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


CACHE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "benchmark", "data", "picasso_paris", "estampe.json",
)

INSTITUTION_NAME = "Musée national Picasso-Paris"
SOURCE_PREFIX = "picasso_paris"

# Every image in this source is rights-restricted (§9 of the survey note). Both values
# are written onto every DigitalImage node so nothing downstream can consume one without
# seeing the restriction — there is deliberately no companion embed script.
IMAGE_LICENSE = "© Succession Picasso"
IMAGE_RIGHTS_RESERVATION = "EU DSM Art.4 reserved (museepicassoparis.fr)"
IMAGE_SIZE_PX = 1000  # 2000 returns HTTP 415 — 1000 is the long-edge ceiling

# Hand-resolved against the live graph, covering only the names these 2,223 records
# actually contain. NOT a general name-resolution mechanism — a wider load must run new
# names through resolve_artist_identity.py instead. Picasso's canonical node already
# holds 1,996 works; a blind MERGE on "PICASSO Pablo" would create a second one.
ARTIST_RESOLUTION = {
    "picasso pablo": {"canonicalName": "Pablo Picasso",
                      "ulanId": "500009666"},
    "degas edgar (gas hilaire germain edgar de, dit)": {"canonicalName": "Edgar Degas",
                      "ulanId": "500115460"},
    "gonzález julio": {"canonicalName": "Julio González", "ulanUrl": None},
    "tobey mark": {"canonicalName": "Mark Tobey", "ulanUrl": None},
    "bissier julius": {"canonicalName": "Julius Bissier", "ulanUrl": None},
}

# Module docstring point 2.
CATALOGUE_PREFIX_ALIAS = {"geiser-baer": "Baer"}
# Museum data-entry error, confirmed record-by-record — see module docstring point 2.
CATALOGUE_ALIAS_EXCLUDED_INVENTORIES = {"MP3414"}
# NOT aliased: this source also spells Czwiklitzer's Picasso-poster catalogue both "CZW"
# (5 records) and "Czwiklitzer" (2). They are almost certainly the same catalogue, but
# unlike Geiser-Baer/Baer there is no overlapping number anywhere in the data to confirm
# it against — the two spellings cite 41/55/47/27/25 and 50/4, which are disjoint. An
# alias asserted on plausibility rather than evidence is the thing this project has been
# burned by twice; 7 poster records are not worth being the third. Left as two nodes and
# logged in the survey note.

# Module docstring point 1. Substring -> a term the shared English crosswalk matches.
# Ordered longest-first at build time so "crayon lithographique" is consumed before
# "lithographi" and "aquatinte au sucre" before "aquatinte".
_FR_TECHNIQUES = {
    "eau-forte": "etching", "eau forte": "etching", "vernis mou": "etching",
    "pointe sèche": "drypoint",
    "aquatinte": "aquatint",
    "burin": "engraving",
    "manière noire": "mezzotint",
    "héliogravure": "photogravure",
    "crayon lithographique": "lithograph", "lithographie": "lithograph",
    "lithographique": "lithograph", "report lithographique": "lithograph",
    "monotype": "monotype",
    "pochoir": "stencil printing",
    "sérigraphie": "screenprint",
    "gaufrage": "embossing",
    "linogravure": "linocut", "linoléum": "linocut", "linoleum": "linocut",
    "gravure sur bois": "woodcut", "bois de fil": "woodcut", "bois gravé": "woodcut",
    "xylographie": "woodcut",
    "typographie": "letterpress",
}
# `vélin` -> wove, NOT vellum. See module docstring point 1.
_FR_PAPERS = {"vélin": "wove", "velin": "wove", "vergé": "laid", "verge": "laid"}

# 78 records describe a lithograph purely by its MARK and its MATRIX ("lavis sur
# pierre", "plume et lavis sur zinc", "lavis et grattages sur pierre" — all printed by
# Mourlot) with no word containing "lithograph" anywhere in the string. Stone and zinc
# are lithographic matrices, so the matrix noun is what disambiguates; this is an exact
# two-token co-occurrence rule, not a similarity judgement. Bare "lavis" with no
# lithographic matrix is left alone — in an intaglio record it means aquatint wash, a
# different process entirely.
_LITHO_MARKS = ("lavis", "crayon", "plume", "grattage", "gouache")
_LITHO_MATRICES = ("sur pierre", "sur zinc")

_MATRIX_MATERIALS = {
    "cuivre": "copper", "zinc": "zinc", "pierre": "stone", "bois": "wood",
    "linoléum": "linoleum", "linoleum": "linoleum", "celluloïd": "celluloid",
}

# Both forms occur and both are common — matching only Roman numerals would miss a large
# minority of the 1,027 records that carry a state. Ordinal word -> state number.
_FR_ORDINALS = {
    "premier": 1, "première": 1, "second": 2, "seconde": 2, "deuxième": 2,
    "troisième": 3, "quatrième": 4, "cinquième": 5, "sixième": 6, "septième": 7,
    "huitième": 8, "neuvième": 9, "dixième": 10, "onzième": 11, "douzième": 12,
    "treizième": 13, "quatorzième": 14, "quinzième": 15,
}
_ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50}
_STATE_ROMAN_RE = re.compile(r"\b([IVXL]+)(?:è|e)?(?:me|r|er)?\s+état\b", re.IGNORECASE)
_STATE_WORD_RE = re.compile(
    r"\b(" + "|".join(_FR_ORDINALS) + r")\s+état\b", re.IGNORECASE)
_STATE_DIGIT_RE = re.compile(r"\b(\d{1,2})\s*(?:è|e)?me?\s+état\b", re.IGNORECASE)

_EDITION_RE = re.compile(r"(?:^|[\s(])(\d+)?\s*/\s*(\d+)(?:$|[\s).,])")
# `inscriptions` is populated on 987 records but is overwhelmingly NOT about signatures —
# it records annotations of every kind ('annotée en bas à droite au crayon "II E"',
# '"Bon à tirer"', a date, a printer's tally mark). Treating the field's mere presence as
# `signed` would have marked 987 impressions signed when 35 are, and signed-vs-unsigned
# materially moves a print's value, so that error would have propagated straight into
# Stage 3 comparables. Matches the French cataloguing abbreviations too — `S.B.D.` is
# `signé en bas à droite`, and the abbreviated form alone accounts for half the real hits.
_SIGNATURE_RE = re.compile(r"\bsign[ée]|\bsignature\b|\bS\.\s*[BH]\.\s*[DG]\.", re.IGNORECASE)
_PRINTER_RE = re.compile(r"tir(?:ée?|é|age)\s+(?:en\s+\d{4}\s+)?par\s+([^.,;]+)", re.IGNORECASE)
_WATERMARK_RE = re.compile(r"filigrane\s+([^.,;]+)", re.IGNORECASE)
_HORS_MARGE_RE = re.compile(r"\(hors marge\)")
_DIM_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*cm")
_TAG_RE = re.compile(r"<[^>]+>")
_YEAR_RE = re.compile(r"\b(1[5-9]\d{2}|20[0-2]\d)\b")

_FR_MONTHS = {
    "janvier": 1, "février": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "août": 8, "septembre": 9, "octobre": 10, "novembre": 11,
    "décembre": 12,
}


def _clean(v):
    """Strips the HTML the API embeds in several fields (old_owners, expositions) and
    normalizes whitespace. Returns None for empties so coalesce() in Cypher behaves."""
    if v is None:
        return None
    s = _TAG_RE.sub(" ", str(v))
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def _roman_to_int(s):
    total, prev = 0, 0
    for ch in reversed(s.upper()):
        val = _ROMAN.get(ch)
        if val is None:
            return None
        total = total - val if val < prev else total + val
        prev = max(prev, val)
    return total or None


# ---------------------------------------------------------------- dates

def parse_date_creation(raw):
    """`date_creation` is often day-precise ('15 août 1937') but also carries
    's.d.' (sans date), bracketed cataloguer inferences ('[1er mai 1939]'), and — the
    one that bites — ranges separated by ' . ' rather than a dash ('fin 1936 . début
    1937'). A dash-only range parser silently returns a single year on those.

    Returns the doc 08 §3.1 fuzzy-date shape; displayLabel always keeps the source's
    own wording verbatim."""
    raw = _clean(raw)
    if not raw or raw.lower().startswith("s.d"):
        return {"year": None, "endYear": None, "precision": None, "displayLabel": raw}

    bracketed = raw.strip().startswith("[")
    years = [int(y) for y in _YEAR_RE.findall(raw)]
    if not years:
        return {"year": None, "endYear": None, "precision": None, "displayLabel": raw}

    year, end_year = years[0], (years[-1] if years[-1] != years[0] else None)
    if end_year is not None:
        precision = "range"
    elif bracketed or re.search(r"\b(vers|circa|fin|début|automne|printemps|été|hiver)\b",
                                raw, re.IGNORECASE):
        precision = "circa"
    else:
        precision = "exact"

    month = day = None
    if precision == "exact":
        m = re.search(r"\b(\d{1,2})(?:er)?\s+(" + "|".join(_FR_MONTHS) + r")\b",
                      raw, re.IGNORECASE)
        if m:
            day, month = int(m.group(1)), _FR_MONTHS[m.group(2).lower()]

    return {"year": year, "endYear": end_year, "precision": precision,
            "displayLabel": raw, "month": month, "day": day}


# ---------------------------------------------------------------- dimensions

def parse_dimensions(raw):
    """Two lines when both are known — sheet first, then the plate/image measurement
    marked '(hors marge)'. 1,745 of 2,223 records carry both; 478 carry a single
    unlabelled line, which is the sheet.

    Split on the RAW newline before `_clean` touches it: `_clean` collapses all
    whitespace, which silently merges the two measurements into one line and made the
    first (sheet) match the 'hors marge' marker belonging to the second. Caught in the
    first dry run — the mapped output had 468 sheet / 1,742 plate, exactly inverted.

    This is a real improvement on every other adapter's dimension handling: BM does not
    label which dimension it measured at all (doc 09 §7, defaulted to sheet and flagged),
    and Forum/Roseberys depend on a `dim_kind` column that is often blank."""
    if raw is None:
        return None, None
    sheet = plate = None
    for line in str(raw).split("\n"):
        line = _clean(line)
        if not line:
            continue
        m = _DIM_RE.search(line)
        if not m:
            continue
        value = f"{m.group(1).replace(',', '.')}x{m.group(2).replace(',', '.')}cm"
        if _HORS_MARGE_RE.search(line):
            if plate is None:
                plate = value
        elif sheet is None:
            sheet = value
    return sheet, plate


# ---------------------------------------------------------------- mst / tirage splits

def _fr_normalize(text, table):
    """Rewrites French terms to the English ones the shared crosswalk matches. Longest
    key first so compound terms are consumed before their own substrings."""
    if not text:
        return ""
    out = text.lower()
    for fr in sorted(table, key=len, reverse=True):
        out = out.replace(fr, f" {table[fr]} ")
    return out


def extract_printer(fields):
    """SEMANTIC_SPLIT rule 1 on `mst`/`tirage` — 'tirée par Lacourière' is a printer,
    'tirée par l'artiste' (537 records) is Picasso himself and must NOT become a
    Publisher node named "l'artiste".

    Takes the fields SEPARATELY rather than one concatenated blob. Joining them first
    created run-on names across the seam — MP2820's mst ends "...tirée par Lacourière"
    and its tirage begins "Quatrième cuivre", which concatenated yielded the printer
    "Lacourière Quatrième cuivre". Caught in the first dry run. A trailing
    " en <year>" clause ("tirée par Lacourière en 1937 ou 1938") is trimmed for the
    same reason: it is printing date, not part of the name."""
    for text in fields:
        if not text:
            continue
        m = _PRINTER_RE.search(text)
        if not m:
            continue
        name = _clean(re.sub(r"\s+en\s+\d{4}.*$", "", m.group(1)))
        if not name or re.match(r"^l['\u2019]artiste$", name, re.IGNORECASE):
            continue
        return name
    return None


def extract_state(text):
    """SEMANTIC_SPLIT rule on `tirage`/`mst`. Roman ('IIème état'), French ordinal word
    ('Second état', 'Sixième état') and bare digit ('7ème état') forms all occur.
    Returns (number, source's own wording) — the label is kept verbatim, same
    observe-don't-fabricate discipline as displayLabel on dates."""
    if not text:
        return None, None
    m = _STATE_ROMAN_RE.search(text)
    if m:
        n = _roman_to_int(m.group(1))
        if n:
            return n, _clean(m.group(0))
    m = _STATE_WORD_RE.search(text)
    if m:
        return _FR_ORDINALS[m.group(1).lower()], _clean(m.group(0))
    m = _STATE_DIGIT_RE.search(text)
    if m:
        return int(m.group(1)), _clean(m.group(0))
    return None, None


def extract_edition(tirage):
    """`tirage` also carries bare edition fractions with no other text ('/3', '1/30',
    '1/2'). A leading number is the impression number, the trailing one the declared
    size; '/30' means the size is known and the number isn't."""
    if not tirage:
        return None, None
    m = _EDITION_RE.search(tirage)
    if not m:
        return None, None
    number = int(m.group(1)) if m.group(1) else None
    size = int(m.group(2))
    return number, size


def extract_watermark(text):
    if not text:
        return None
    m = _WATERMARK_RE.search(text)
    return _clean(m.group(1)) if m else None


def resolve_techniques(mst):
    """SEMANTIC_SPLIT rule 3 on `mst`: strip the printer clause (rule 1) so
    'tirée par Fort' can't contribute vocabulary, translate, then delegate to the
    single shared crosswalk. Returns (techniques, resolved_flag)."""
    if not mst:
        return [], False
    body = _PRINTER_RE.sub(" ", mst.lower())
    normalized = _fr_normalize(body, _FR_TECHNIQUES)
    if (any(mark in body for mark in _LITHO_MARKS)
            and any(mx in body for mx in _LITHO_MATRICES)):
        normalized += " lithograph "
    techniques = extract_techniques(normalized)
    return techniques, bool(techniques)


def resolve_papers(mst, tirage):
    return extract_papers(_fr_normalize(f"{mst or ''} {tirage or ''}".lower(), _FR_PAPERS))


def extract_matrix_material(mst):
    """Only meaningful on a `Estampe, Matrice` record. On an `Epreuve` the same nouns
    describe the plate the impression came FROM, not the impression itself, and are
    deliberately not mapped there — see survey note §5.1 rule 2."""
    low = (mst or "").lower()
    for fr, en in _MATRIX_MATERIALS.items():
        if fr in low:
            return en
    return None


# ---------------------------------------------------------------- catalogue refs

_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")
_BIS_TER_RE = re.compile(r"(\d)\s+(bis|ter)\b", re.IGNORECASE)
# "Baer 1523 à 1779" (MP3053, La Célestine — a 66-plate suite) is a RANGE covering a
# whole portfolio, not a citation to one print. This is exactly the portfolio-level
# citation `catalogue_matching.py`'s docstring point 2 warns about, and the real Chagall
# "Cramer 30" corruption it describes came from treating one such citation as a single
# entry. Dropped outright rather than resolved to either endpoint.
_RANGE_REF_RE = re.compile(r"\d\s*(?:à|-|–)\s*\d")


def _split_multi_refs(raw):
    """Module docstring point 3 — this source separates multiple citations with commas
    and ' et ', which the shared semicolon-only parser turns into garbage prefixes.
    Split locally, then hand each fragment to the shared parser unchanged so the
    NON_CATALOGUE_NAMES guard and the prefix model still apply.

    Two fragment-level cleanups, both from confirmed records in the first dry run, not
    added defensively:

      - **Trailing parenthetical titles.** "P.i.F., 1041 (Femme d'arlequin se
        coiffant)" made the parser read the prefix as "1041 (Femme d'arlequin se" and
        the entry number as "coiffant)".
      - **Space-separated bis/ter.** "Geiser-Baer 111 bis" and "Mourlot 133 bis" gave
        prefix "Geiser-Baer 111" / entry "bis". The same convention appears glued
        elsewhere in this source ("Baer 211bis") and parses correctly there, so the
        fix is to glue it rather than to special-case the suffix.
      - **Portfolio ranges** — see `_RANGE_REF_RE`."""
    if not raw:
        return []
    refs = []
    for fragment in re.split(r",|\bet\b", raw):
        fragment = _TRAILING_PAREN_RE.sub("", fragment.strip())
        fragment = _BIS_TER_RE.sub(r"\1\2", fragment)
        if _RANGE_REF_RE.search(fragment):
            continue
        refs.extend(parse_catalogue_refs(fragment))
    return refs


def normalize_catalogue_refs(raw, inventory):
    """Applies CATALOGUE_PREFIX_ALIAS (docstring point 2), honouring the single
    confirmed exception by inventory number — MP3414's citation is dropped entirely
    rather than filed under either prefix, since we know it is wrong and do not know
    what it was meant to be.

    An entry number that does not START WITH A DIGIT is dropped. Within this source
    every legitimate number does, and the ones that don't are all volume-style citations
    to catalogues that don't number prints individually: "Z. VI, 282" is Zervos volume VI
    no. 282 (Zervos catalogues the paintings and drawings, not the prints) and
    "Bloch I, 16" is the same shape. The comma split cannot recover a volume+number pair,
    and a prefix of "Z." with an entry of "VI" is precisely the confident-looking garbage
    `catalogue_matching.NON_CATALOGUE_NAMES` exists to keep out of the graph. Structural
    rule on the number's own shape, not a name blocklist — nothing fuzzy about it."""
    refs = genuine_refs(_split_multi_refs(raw))
    if inventory in CATALOGUE_ALIAS_EXCLUDED_INVENTORIES:
        return []
    out = []
    for ref in refs:
        if not ref["entryNumber"][:1].isdigit():
            continue
        alias = CATALOGUE_PREFIX_ALIAS.get(ref["catalogueName"].strip().lower())
        out.append({"catalogueName": alias or ref["catalogueName"],
                    "entryNumber": ref["entryNumber"]})
    return out


# ---------------------------------------------------------------- record mapping

def resolve_artist(authors_list):
    key = (authors_list or "").strip().lower()
    if key in ARTIST_RESOLUTION:
        hit = ARTIST_RESOLUTION[key]
        # Bare id in the table, URL built here — see bm_ingest.resolve_artist. The "picasso
        # pablo" entry held a page-form URL until 2026-09-12.
        resolved = {"canonicalName": hit["canonicalName"],
                    "ulanUrl": canonical_ulan_url(hit.get("ulanId"))}
        resolved["rawName"] = authors_list
        return resolved
    return {"canonicalName": _clean(authors_list) or "unknown", "ulanUrl": None,
            "rawName": authors_list}


def classify(record):
    """`Estampe, Matrice` -> the physical plate (Matrix). Everything else under
    `domain: Estampe` is an impression. Checked BEFORE technique resolution, since a
    plate has no printing technique of its own to find."""
    artwork = record.get("artwork") or {}
    if not artwork.get("inventory"):
        return "excluded_no_inventory"
    if (artwork.get("domain_denomination") or "").strip() == "Estampe, Matrice":
        return "matrix"
    return "impression"


def map_record(record):
    artwork = record["artwork"]
    inventory = _clean(artwork.get("inventory"))
    object_id = f"{SOURCE_PREFIX}-{re.sub(r'[^A-Za-z0-9.-]', '_', inventory)}"

    artist = resolve_artist(artwork.get("authors_list"))
    title = _clean(artwork.get("title_list")) or f"Untitled ({inventory})"
    mst = _clean(artwork.get("mst"))
    tirage = _clean(artwork.get("tirage"))

    date = parse_date_creation(artwork.get("date_creation"))
    sheet_dims, plate_dims = parse_dimensions(artwork.get("dimensions"))
    techniques, technique_resolved = resolve_techniques(mst)
    state_number, state_label = extract_state(f"{mst or ''} {tirage or ''}")
    edition_number, edition_size = extract_edition(tirage)

    catalogue_refs = normalize_catalogue_refs(artwork.get("number_catalogue"), inventory)
    conceptual_work_id = build_conceptual_work_id(
        source_prefix=SOURCE_PREFIX,
        artist_name=artist["canonicalName"],
        title=title,
        catalogue_refs=catalogue_refs,
        fallback_id=object_id,
    )

    medias = record.get("medias") or []
    image_url = None
    if medias and medias[0].get("file_name"):
        image_url = (medias[0]["url_template"]
                     .replace("{size}", str(IMAGE_SIZE_PX))
                     .replace("{file_name}", medias[0]["file_name"]))

    # `collaborators` is the structured printer field ("Imprimeur : Atelier Lacourière
    # et Frélaut, Paris (France)"); `mst`'s "tirée par X" is the free-text fallback.
    printer = None
    collaborators = _clean(artwork.get("collaborators"))
    if collaborators and collaborators.lower().startswith("imprimeur"):
        printer = _clean(collaborators.split(":", 1)[1]) if ":" in collaborators else None
    printer = printer or extract_printer((mst, tirage))

    return {
        "objectId": object_id,
        "conceptualWorkId": conceptual_work_id,
        "navigartId": artwork.get("_id"),
        "accessionNumber": inventory,
        "artistName": artist["canonicalName"],
        "artistRawName": artist["rawName"],
        "artistUlanUrl": canonical_ulan_url(artist["ulanUrl"]),
        "title": title,
        "dateYear": date["year"],
        "dateEndYear": date["endYear"],
        "datePrecision": date["precision"],
        "dateDisplayLabel": date["displayLabel"],
        "rawMedium": mst,
        "techniques": techniques,
        "techniqueResolved": technique_resolved,
        "papers": resolve_papers(mst, tirage),
        "watermarkNote": extract_watermark(f"{mst or ''} {tirage or ''}"),
        "sheetDimensions": sheet_dims,
        "plateDimensions": plate_dims,
        "stateNumber": state_number,
        "stateLabel": state_label,
        "stateId": (f"{conceptual_work_id}-state-{state_number}"
                    if state_number is not None else None),
        "editionNumber": edition_number,
        "editionSize": edition_size,
        "printer": printer,
        "matrixMaterial": extract_matrix_material(mst),
        "provenanceNote": _clean(artwork.get("old_owners")),
        "inscriptionNote": _clean(artwork.get("inscriptions")),
        "signed": bool(_SIGNATURE_RE.search(_clean(artwork.get("inscriptions")) or "")),
        "acquisition": _clean(artwork.get("acquisition")),
        "realisationLocation": _clean(artwork.get("realisation_location")),
        "catalogueRefs": catalogue_refs,
        "imageUrl": image_url,
        "imageLicense": IMAGE_LICENSE,
        "imageRightsReservation": IMAGE_RIGHTS_RESERVATION,
        "listingUrl": f"https://www.navigart.fr/picassoparis/#/artwork/{artwork.get('_id')}",
    }


# ---------------------------------------------------------------- Cypher

_COMMON_TAIL = """
FOREACH (_ IN CASE WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END |
  MERGE (img:DigitalImage {id: row.objectId + "-image"})
  SET img.sourceUrl = row.imageUrl,
      img.imageType = "primary",
      img.license = row.imageLicense,
      img.rightsReservation = row.imageRightsReservation
  MERGE (img)-[:SHOWS]->(target)
)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "institutional",
    src.institutionName = $institutionName,
    src.accessionNumber = row.accessionNumber,
    src.listingUrl = row.listingUrl
MERGE (src)-[:DOCUMENTS]->(target)
MERGE (src)-[att:ATTRIBUTED_TO]->(artist)
SET att.qualifier = "direct"

WITH DISTINCT row, cw
UNWIND row.catalogueRefs AS ref
MERGE (cr:CatalogueRaisonne {numberingPrefix: ref.catalogueName})
MERGE (ce:CatalogueEntry {id: ref.catalogueName + "-" + ref.entryNumber})
SET ce.number = ref.entryNumber
MERGE (cr)-[:CONTAINS]->(ce)
MERGE (ce)-[:DOCUMENTS]->(cw)
"""

# Impressions. row.conceptualWorkId is shared by every impression citing the same
# catalogue entry with the same title — Baer 651 alone has 38 impressions in this one
# collection — so every SET coalesces, exactly as forum_ingest.py and bm_ingest.py do.
LOAD_QUERY_IMPRESSION = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.ulanUrl = coalesce(artist.ulanUrl, row.artistUlanUrl),
    artist.identityConfidence = coalesce(artist.identityConfidence,
        CASE WHEN row.artistUlanUrl IS NOT NULL THEN "institutional" ELSE "unresolved" END),
    artist.alternateNames = CASE
        WHEN row.artistRawName IS NOT NULL AND NOT row.artistRawName IN coalesce(artist.alternateNames, [])
        THEN coalesce(artist.alternateNames, []) + row.artistRawName
        ELSE artist.alternateNames
    END

MERGE (cw:ConceptualWork {id: row.conceptualWorkId})
SET cw.name = coalesce(cw.name, row.title),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_endYear = coalesce(cw.dateCreated_endYear, row.dateEndYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, row.datePrecision),
    cw.dateCreated_displayLabel = coalesce(cw.dateCreated_displayLabel, row.dateDisplayLabel)
MERGE (artist)-[:CREATED]->(cw)

MERGE (er:EditionRun {id: row.objectId + "-er"})
SET er.dateRange_year = row.dateYear,
    er.dateRange_precision = row.datePrecision,
    er.declaredSize = row.editionSize
MERGE (cw)-[:PRINTED_AS]->(er)

// doc 08 §2's State node, populated properly for the first time — 1,027 of these
// records carry an explicit state. Keyed per (work, state number) so the 38 impressions
// of one state share one node. The Matrix -[:HAS_STATE]-> State link is NOT made here:
// an impression record does not identify WHICH plate accession it came from, and the
// ensemble/related data that would connect them is currently UNMAPPED (survey §7).
// State -[:PRINTED_AS]-> EditionRun is doc 08 §3's own documented shape.
FOREACH (_ IN CASE WHEN row.stateId IS NOT NULL THEN [1] ELSE [] END |
  MERGE (st:State {id: row.stateId})
  SET st.stateNumber = row.stateNumber,
      st.displayLabel = coalesce(st.displayLabel, row.stateLabel),
      st.traditionType = "western_plate_state"
  MERGE (st)-[:PRINTED_AS]->(er)
)

FOREACH (_ IN CASE WHEN row.printer IS NOT NULL THEN [1] ELSE [] END |
  MERGE (printer:Publisher {name: row.printer})
  MERGE (er)-[:PRINTED_BY]->(printer)
)

MERGE (imp:Impression {id: row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.plateDimensions = row.plateDimensions,
    imp.rawMedium = row.rawMedium,
    imp.techniqueResolved = row.techniqueResolved,
    imp.stateLabel = row.stateLabel,
    imp.editionNumber = row.editionNumber,
    imp.copyType = "numbered",
    imp.signed = row.signed,
    imp.inscriptionNote = row.inscriptionNote,
    imp.provenanceNote = row.provenanceNote
MERGE (er)-[:INCLUDES]->(imp)

WITH row, artist, cw, imp AS target

UNWIND (CASE WHEN size(row.techniques) = 0 THEN [null] ELSE row.techniques END) AS tech
FOREACH (_ IN CASE WHEN tech IS NOT NULL THEN [1] ELSE [] END |
  MERGE (t:Technique {name: tech.name})
  SET t.aatId = CASE WHEN tech.aatId IS NOT NULL THEN tech.aatId ELSE t.aatId END
  MERGE (target)-[:USES_TECHNIQUE]->(t)
)

WITH DISTINCT row, artist, cw, target
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END,
      p.watermarkNote = coalesce(row.watermarkNote, p.watermarkNote)
  MERGE (target)-[:PRINTED_ON]->(p)
)

WITH DISTINCT row, artist, cw, target
""" + _COMMON_TAIL

# The 187 plate accessions (module docstring point 4). Same routing bm_ingest.py added
# for Trevelyan's cancelled zinc plate: a matrix is not printed, so it skips
# EditionRun/Impression entirely.
LOAD_QUERY_MATRIX = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.ulanUrl = coalesce(artist.ulanUrl, row.artistUlanUrl),
    artist.identityConfidence = coalesce(artist.identityConfidence,
        CASE WHEN row.artistUlanUrl IS NOT NULL THEN "institutional" ELSE "unresolved" END)

MERGE (cw:ConceptualWork {id: row.conceptualWorkId})
SET cw.name = coalesce(cw.name, row.title),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, row.datePrecision),
    cw.dateCreated_displayLabel = coalesce(cw.dateCreated_displayLabel, row.dateDisplayLabel)
MERGE (artist)-[:CREATED]->(cw)

MERGE (mx:Matrix {id: row.objectId})
SET mx.material = row.matrixMaterial,
    mx.rawMedium = row.rawMedium,
    mx.provenanceNote = row.provenanceNote
MERGE (artist)-[:MADE_MATRIX]->(mx)
MERGE (cw)-[:REALIZED_AS]->(mx)

// Here the state DOES belong to a plate we actually hold, so the doc 08
// Matrix -[:HAS_STATE]-> State edge is the correct one to write.
FOREACH (_ IN CASE WHEN row.stateId IS NOT NULL THEN [1] ELSE [] END |
  MERGE (st:State {id: row.stateId})
  SET st.stateNumber = row.stateNumber,
      st.displayLabel = coalesce(st.displayLabel, row.stateLabel),
      st.traditionType = "western_plate_state"
  MERGE (mx)-[:HAS_STATE]->(st)
)

WITH row, artist, cw, mx AS target
""" + _COMMON_TAIL


def _write_chunk_with_retry(query, rows, retries=4, backoff_seconds=5.0):
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(
            _require_env("NEO4J_URI"),
            auth=(_require_env("NEO4J_USER"), _require_env("NEO4J_PASSWORD")))
        try:
            with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
                session.run(query, rows=rows, institutionName=INSTITUTION_NAME).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def load_cache(path=CACHE_PATH, limit=None):
    if not os.path.exists(path):
        raise RuntimeError(
            f"Cache not found at {path}. Run `python knowledge_graph/picasso_paris_fetch.py` first.")
    with open(path, encoding="utf-8") as f:
        records = json.load(f)
    return records[:limit] if limit else records


def run(records, chunk_size=200, dry_run=False,
        unresolved_path="picasso_paris_unresolved_techniques.csv"):
    buckets = {"impression": [], "matrix": [], "excluded_no_inventory": []}
    for record in records:
        buckets[classify(record)].append(record)

    print(f"[CLASSIFY] impressions={len(buckets['impression'])} "
          f"matrices={len(buckets['matrix'])} "
          f"excluded_no_inventory={len(buckets['excluded_no_inventory'])}", flush=True)

    mapped = {kind: [map_record(r) for r in rows]
              for kind, rows in buckets.items() if kind != "excluded_no_inventory"}

    # Recorded, not dropped — see the module docstring on why this is NOT an exclusion
    # gate the way bm_ingest.py's is.
    unresolved = [r for r in mapped["impression"] if not r["techniqueResolved"]]
    if unresolved:
        with open(unresolved_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["accessionNumber", "title", "rawMedium"])
            for r in unresolved:
                writer.writerow([r["accessionNumber"], r["title"], r["rawMedium"]])
        print(f"[TECHNIQUE] {len(unresolved)}/{len(mapped['impression'])} impressions have no "
              f"resolvable technique — loaded with techniqueResolved=false, listed in "
              f"{unresolved_path}", flush=True)

    with_state = sum(1 for r in mapped["impression"] + mapped["matrix"] if r["stateId"])
    with_cat = sum(1 for r in mapped["impression"] + mapped["matrix"] if r["catalogueRefs"])
    with_img = sum(1 for r in mapped["impression"] + mapped["matrix"] if r["imageUrl"])
    print(f"[MAPPED] states={with_state} catalogue_refs={with_cat} images={with_img}", flush=True)

    if dry_run:
        print("[DRY RUN] nothing written", flush=True)
        return mapped

    for kind, query in (("impression", LOAD_QUERY_IMPRESSION), ("matrix", LOAD_QUERY_MATRIX)):
        rows = mapped[kind]
        start = time.time()
        for chunk_start in range(0, len(rows), chunk_size):
            chunk = rows[chunk_start:chunk_start + chunk_size]
            _write_chunk_with_retry(query, chunk)
            done = chunk_start + len(chunk)
            elapsed = time.time() - start
            print(f"[PROGRESS] {kind} {done}/{len(rows)} | elapsed={elapsed:.0f}s", flush=True)
    print("[DONE]", flush=True)
    return mapped


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Ingest the whole cache")
    parser.add_argument("--limit", type=int, help="Cap the number of records")
    parser.add_argument("--dry-run", action="store_true",
                        help="Map and report without writing to Neo4j")
    args = parser.parse_args()

    if not args.all and not args.limit and not args.dry_run:
        parser.error("Provide --all, --limit N, or --dry-run")

    recs = load_cache(limit=args.limit)
    print(f"Loaded {len(recs)} cached record(s)...", flush=True)
    run(recs, dry_run=args.dry_run)
