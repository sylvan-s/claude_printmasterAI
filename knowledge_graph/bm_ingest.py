"""
PrintMasterAI — British Museum Collection Online pilot ingestion into the ACKG (Neo4j)
Version: BM-INGEST-PILOT-0.1

Pilot-scale adapter, not a bulk loader — see doc 09 §7 for the full write-up. Two things
make this source structurally different from every other adapter in this toolkit (Met/
Roseberys/Forum/Tate), found and confirmed before writing a line of loading code:

  1. **No scriptable bulk access.** britishmuseum.org sits behind a Cloudflare managed
     challenge ("Just a moment..." interstitial) that returns HTTP 403 to a plain
     `requests`/`curl` client AND to `cloudscraper` (TLS-impersonation didn't clear it
     either — confirmed by direct test, not assumed). A real browser session solves the
     challenge and reads the site's own internal `/api/_search` + `/api/_object`
     endpoints and server-rendered object pages fine, same as any human visitor. This
     script therefore does NOT fetch live — it loads from a local JSON cache
     (`benchmark/data/bm/rembrandt_pilot.json`) captured by hand-driving a browser
     session against the real site, the same "load from a local file, not a live
     endpoint" shape `met_ingest.py` already uses for MetObjects.csv, just captured via
     a browser instead of a bulk download link. Scaling this past a hand-curated pilot
     would need real browser automation (Playwright solving the same challenge
     unattended) — a materially bigger lift than any other adapter here, and a heavier
     sustained automated footprint against a bot-management wall specifically designed
     to stop that, worth a deliberate decision rather than just adding a dependency.
  2. **Licensing is non-commercial.** The British Museum publishes collection content
     under CC BY-NC-SA 4.0, not CC0 like Met/Tate. Decision (2026-09-05, this session):
     proceed for this project's current personal/research status, revisit before any
     commercial launch. Not re-litigated per-adapter-run — logged once here and in doc 09.

Field mapping (doc 09 §1 taxonomy) — the object detail page's `dt`/`dd` pairs are
DIRECT/STRUCTURED_TRANSFORM for almost everything, better-structured than Met's free
text and closer to V&A's institutional-record quality:

  - `Producer name` — role-prefixed ("Print made by: Rembrandt", "After: Jan Lievens")
    — STRUCTURED_TRANSFORM via ROLE_QUALIFIER_MAP. A role with no confident mapping
    (e.g. "Drawn by: ... (calligraphy)" for a secondary hand adding calligraphy to a
    Rembrandt print — not printmaker, not publisher, no slot in doc 08's qualifier enum)
    is logged and skipped rather than force-fit — UNMAPPED, not silently dropped
    (`skipped_producer_roles` in the run summary).
  - `Technique` — arrives PRE-SEGMENTED ("etching", "drypoint") unlike Met's paragraph
    medium string. Still routed through the shared `crosswalk_matching.extract_techniques`
    (not trusted as pre-verified AAT) for consistency with every other adapter — a
    keyword hit against an already-clean term is a formality here, not a real heuristic
    risk the way it is against Met's free text.
  - `Title` — not a single string but a small label-prefixed list ("Object: Salts",
    "Series: A Tribute to Birgit Skiöld") — STRUCTURED_TRANSFORM via `parse_title`.
    `ConceptualWork.seriesTitle` has no other home in doc 08's schema (only
    `dateCreated` is documented there) so it's added as a plain string property rather
    than a new node type, matching how `dateDisplayLabel`-style fields are already
    carried directly on `ConceptualWork`.
  - `Subjects` — also pre-segmented, DIRECT — no SEMANTIC_SPLIT needed the way Met's
    flat `tags` field needed one; BM's Subjects field is already iconographic-only.
  - `Dimensions` — "Height: N millimetres" / "Width: N millimetres", STRUCTURED_TRANSFORM.
    BM does not label WHICH dimension this is (plate/sheet/image) the way Roseberys'
    `dim_kind` column does — defaulted to `sheetDimensions` (same fallback Forum uses
    for an unlabelled dim_kind) but this is a real, flagged assumption for Old Master
    intaglio prints, where a plate-mark measurement is at least as common a convention.
    Not verified per-record; a future revisit should check BM's own measurement-type
    documentation rather than trust this default at scale.
  - `Bibliographic references` — "<Catalogue name> / <Catalogue title> (<entry number>)
    [(<note>)]" — STRUCTURED_TRANSFORM via `parse_bibliographic_ref`. Confirms doc 08
    principle 4 with real data for the first time: single records here carry FOUR or
    FIVE distinct catalogue raisonné entries at once (New Hollstein, Hind 1923, White &
    Boon 1969, Hinterding et al. 2000, sometimes also Muller for portrait sitters) —
    doc 08 reasoned about this from a design perspective (Rembrandt: White & Boon vs.
    New Hollstein) before any adapter actually populated more than one raisonné per work.
  - Artist identity — BM's own producer strings are bare names ("Rembrandt", not
    "Rembrandt van Rijn"). A blind `MERGE (Artist {name: ...})` would create a FIFTH
    distinct Rembrandt node in this graph (confirmed live: the canonical node is
    `Artist{name:"Rembrandt van Rijn", ulanUrl:.../500011051}`, 241 works; three other
    orphaned name-string nodes already exist from other sources' contaminated rows).
    `PILOT_ARTIST_RESOLUTION` hand-resolves the small set of names this pilot actually
    needs to their canonical `ulanUrl`, checked against the live graph before writing
    this script — NOT a general name-resolution mechanism. A full-scale BM ingest would
    need to run new names through `resolve_artist_identity.py`'s real ULAN/Wikidata
    pipeline instead of a hardcoded map.
  - `ogImage` — a record's `{url, width, height}` or `null`, captured at catalogue-
    scrape time alongside the `dt`/`dd` fields (a `<meta property="og:image">` tag on
    the same object-detail-page fetch answers "does an image exist, and where" for
    free — folded in 2026-09-06, making a separate `/api/_object`-based discovery pass
    redundant; see doc 09 §7.3). **This script — not `bm_embed_images.py` — creates the
    `DigitalImage` node**, matching the exact pattern `forum_ingest.py`'s own
    `LOAD_QUERY` already uses (a `FOREACH`-guarded `MERGE` in the same pass as the
    catalogue data, only when a URL exists) rather than deferring it to the embedding
    script. Corrected 2026-09-06: an earlier version of this script left `DigitalImage`
    creation to `bm_embed_images.py`, which re-opened the same cache file a second time
    — inconsistent with every other adapter in this toolkit, where the *graph* is the
    handoff between ingest and embed (`embed_images_dinov2.py`'s `FETCH_QUERY` reads
    `DigitalImage.sourceUrl` straight from Neo4j, never touching Forum/Roseberys' CSV
    again). `bm_embed_images.py` now does the same — see its own docstring.
    `og:image`'s URL is always the `preview_` size; `_upsize_og_image_url()` swaps in
    `large_` before it's ever written to the graph, so `DigitalImage.sourceUrl` is
    immediately usable, not a placeholder needing a second transform downstream.

Four issues found and fixed 2026-09-06, using a 29-record Julian Trevelyan test pull
(`benchmark/data/bm/trevelyan_test.json` — Trevelyan is this project's own doc 08 §4.1/
4.2 worked example) as the regression case before the real Trevelyan load:

  1. **"Made by" producer role was unmapped**, silently dropping the artist's own
     attribution to their physical printing plate (BM catalogues the plate/matrix as
     its own object, "Made by: <artist>", distinct from "Print made by:" for the
     impressions pulled from it). Added to `ROLE_QUALIFIER_MAP` as `direct`.
  2. **No print-type prefilter** — a loose drawing sheet (`Technique: drawn`) came back
     from BM's own `object_type=print` search facet and would have loaded as a bare,
     technique-less `Impression`. `classify_record()` now excludes any record whose
     `Technique` field, after the AAT crosswalk, yields zero recognized printmaking
     techniques — logged as `[EXCLUDED]`, never silently dropped (same discipline as
     Forum's `is_print_medium` filter).
  3. **No `Matrix` routing** — Trevelyan's own cancelled zinc plate and its plaster
     cast (materials `zinc alloy`/`plaster`, no printmaking technique at all — they
     aren't printed, they're the physical object a print is pulled from) were the same
     root cause as #2 surfacing a second, distinct case: these aren't drawings to
     exclude, they're genuine `Matrix` nodes (doc 08 §2) that were never being created.
     `classify_record()` now checks `Materials` against `PLATE_MATERIALS` (non-paper
     plate/block substrates) *before* the technique check, and routes matched records
     through `LOAD_QUERY_MATRIX` (`Artist -[:MADE_MATRIX]-> Matrix`, `SourceRecord
     -[:DOCUMENTS]-> Matrix`) instead of the print pipeline.
  4. **No entity resolution across accession records for the same work.** BM holds two
     separate accession numbers for two impressions of the identical Trevelyan plate
     ("The Tenements of Mind" / "Dream city series", both citing the identical Turner
     1998 catalogue number 47, confirmed by BM's own curatorial note that these are two
     impressions of one plate) — `map_record` previously keyed `ConceptualWork` off the
     per-accession `objectId`, creating two separate `ConceptualWork` nodes for one
     actual composition, the same failure mode doc 08 §4.2 already documents for
     Roseberys/V&A entity resolution. Fixed: when `catalogueRefs` is non-empty,
     `ConceptualWork.id` is now keyed off the *first* catalogue entry
     (`catalogueName`+`entryNumber` — a verified, literal identity match, not a
     similarity heuristic) instead of the accession number, so multiple BM records
     citing the same catalogue number correctly share one `ConceptualWork`. Falls back
     to the accession-keyed id when no catalogue reference exists (V&A-style
     graceful degradation, doc 08 §4.1). `EditionRun`/`Impression` stay keyed per
     accession record regardless — each physical impression is still its own node;
     only the abstract-work identity is deduplicated.

Usage:
    python3 bm_ingest.py --dry-run                                    # print mapped rows, write nothing
    python3 bm_ingest.py                                              # load the cached Rembrandt pilot batch into Neo4j
    python3 bm_ingest.py --cache-path ../benchmark/data/bm/trevelyan_test.json   # load a different cache

Building a new cache file (no checked-in script — this is manual, browser-driven, per
point 1 above). Run inside a `javascript_tool` call against a `britishmuseum.org` page
already past the Cloudflare challenge, once per artist/search. `parseFields()` below
captures the `dt`/`dd` catalogue fields AND `og:image` (image discovery, folded in
2026-09-06 — see the Producer-name-adjacent note above and `bm_embed_images.py`'s
docstring) in the same page fetch:

    function parseFields(doc) {
      const fields = {};
      doc.querySelectorAll('.object-detail__data-item').forEach(item => {
        const dt = item.querySelector('.object-detail__data-term');
        if (!dt) return;
        const label = dt.textContent.trim();
        fields[label] = [...item.querySelectorAll('.object-detail__data-description')]
          .map(dd => dd.textContent.replace(/\\s+/g, ' ').trim());
      });
      return fields;
    }
    async function scrapeObject(id) {
      const html = await (await fetch('/collection/object/' + id)).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ogImg = doc.querySelector('meta[property="og:image"]');
      const ogW = doc.querySelector('meta[property="og:image:width"]');
      const ogH = doc.querySelector('meta[property="og:image:height"]');
      const url = ogImg && ogImg.content ? ogImg.content : null;
      return {
        id,
        title: null,
        fields: parseFields(doc),
        ogImage: url ? { url, width: ogW?.content, height: ogH?.content } : null,
      };
    }

Then save the resulting array as `benchmark/data/bm/<artist>_test.json` and point
`--cache-path` at it. `bm_embed_images.py` reads `ogImage` straight from this same file
— no separate image-discovery pass or cache file needed any more.
"""

import argparse
import json
import os
import re
import time

import requests
from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques
from catalogue_matching import build_conceptual_work_id


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

PILOT_CACHE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "benchmark", "data", "bm", "rembrandt_pilot.json"
)

# See module docstring point on Artist identity — verified live against this graph
# 2026-09-05 before writing this map, not guessed.
PILOT_ARTIST_RESOLUTION = {
    "rembrandt": {"canonicalName": "Rembrandt van Rijn", "ulanUrl": "http://vocab.getty.edu/ulan/500011051"},
    # Confirmed live 2026-09-06, before writing a single Sidney Nolan row: this artist is
    # fragmented across EIGHT Artist nodes in this graph already ("Sidney Nolan"/"Sydney
    # Nolan" spelling variants crossed with every combination of "Sir"/OM/AC/CBE/RA/
    # Hon.RE honorifics Forum/Roseberys' free-text artist fields happened to carry) —
    # known, pre-existing debt from those sources, not touched here per
    # [[feedback_defer_broad_sweeps]]. Only ONE of the eight, "Sir Sidney Nolan", carries
    # the correct ULAN (500028209 — the same id the resolve_artist_identity.py false-
    # confidence bug this project already fixed once resolved him to, see
    # project_ackg_status.md) and by far the most works (159 vs. the next-largest
    # fragment's 25) — checked per-node work counts before assuming this, not just
    # "has an id" (the lesson from that same prior dedupe pass). BM's own producer field
    # gives the bare name "Sidney Nolan", which would otherwise MERGE onto a DIFFERENT,
    # already-existing, ULAN-less 4-work fragment — a ninth split, not a consolidation.
    "sidney nolan": {"canonicalName": "Sir Sidney Nolan", "ulanUrl": "http://vocab.getty.edu/ulan/500028209"},
    # Confirmed live 2026-09-06, before writing a single R.B. Kitaj row (10-artist BM
    # priority-list run): this artist is fragmented across FIVE Artist nodes already
    # ("R.B. Kitaj"/"R. B. Kitaj"/"R B Kitaj"/"Ronald Brooks Kitaj"/"Roland Brooks Kitaj"
    # — punctuation variants crossed with one full-name form and one misspelling of it).
    # "R.B. Kitaj" carries by far the most works (206) and the correct ULAN
    # (500007852 — the same id "Ronald Brooks Kitaj"'s 10-work fragment also carries,
    # cross-checked per-node work count, not just "has an id"). BM's own bare producer
    # string is "R B Kitaj" (no periods) — a pre-existing 1-work "R B Kitaj" node exists
    # too, which a blind MERGE would have grown into a SIXTH fragment instead of
    # consolidating onto the 206-work canonical node.
    "r b kitaj": {"canonicalName": "R.B. Kitaj", "ulanUrl": "http://vocab.getty.edu/page/ulan/500007852"},
    # Confirmed live 2026-09-06, before writing a single Stanley Anderson row (10-artist
    # BM priority-list run): this artist is split across a bare "Stanley Anderson" node
    # (10 works, no ulanUrl) and an honorific "Stanley Anderson RA RE" node (also 10
    # works, but WITH the correct ULAN 500119555) — a tie on work count, broken by which
    # node actually carries a real authority id, not just "has an id" (also two obviously
    # corrupted junk-data nodes from a prior Roseberys/Forum ingest — literal quoted
    # lot-title text baked into the Artist.name string, e.g. 'Stanley Anderson RA RE
    # British 1884-1966- "Windswept Corn"" — left untouched, out of scope per
    # [[feedback_defer_broad_sweeps]]). BM's own bare producer string "Stanley Anderson"
    # would otherwise grow the null-ulan duplicate instead of consolidating onto the
    # ULAN-bearing canonical node.
    "stanley anderson": {"canonicalName": "Stanley Anderson RA RE", "ulanUrl": "http://vocab.getty.edu/ulan/500119555"},
}

# `CatalogueRaisonne.numberingPrefix` is a raw string key (parse_bibliographic_ref's
# `catalogueName`) — a genuinely different citation FORMAT of the same real catalogue
# (e.g. one source's "Author Year" vs. another's bare "Author") creates a distinct
# fragment, the same identity-fragmentation failure mode as unresolved Artist name
# strings, just never centrally deduplicated the way Artist is (no ulanUrl-equivalent
# authority id for catalogues raisonnés). Confirmed live 2026-09-06, before writing a
# single Hayter row: the graph already carries FIVE spelling variants of Stanley
# William Hayter's own catalogue raisonné from prior Forum/Roseberys loads
# ("Black & Moorehead", "Black and Moorehead", "Black & Moorhead" [13 entries — the
# de facto canonical spelling already in use], "Black & Moorheard", "Moorehead") —
# known, pre-existing debt, not touched here per [[feedback_defer_broad_sweeps]]. BM's
# own citation format ("Black & Moorhead 1992 / The Prints of Stanley William Hayter")
# would add a SIXTH fragment purely because BM bakes the year into the name where
# Forum/Roseberys didn't — caught before writing, not after, so resolved onto the
# existing 13-entry node instead. Narrow and specific, NOT a general year-stripping
# rule (Rembrandt's own catalogue citations — "Hind 1923", "White & Boon 1969" — embed
# a year in the name too, and changing that key retroactively would fragment the
# already-loaded nodes against a differently-keyed future run; out of scope here).
CATALOGUE_NAME_RESOLUTION = {
    "black & moorhead 1992": "Black & Moorhead",
}

ROLE_QUALIFIER_MAP = {
    "print made by": "direct",
    "made by": "direct",
    "etched by": "direct",
    "engraved by": "direct",
    "after": "after",
    "attributed to": "attributed_to",
    "circle of": "circle_of",
    "manner of": "manner_of",
    "school of": "school_of",
    "studio of": "studio_of",
    "follower of": "follower_of",
}

# Non-paper substrates that mean "this is the physical plate/block itself" (doc 08's
# Matrix node), not an Impression — checked BEFORE the technique check below, since a
# plate genuinely has no printmaking technique of its own (it's what a technique is
# applied TO). Heuristic, same discipline as crosswalk_matching's technique/paper
# lists — a plate material not in this list falls through to the technique check
# instead, which would just exclude it as non-print rather than mis-load it as one.
PLATE_MATERIALS = {"zinc alloy", "copper alloy", "wood", "stone", "plaster", "metal", "copper", "steel", "zinc"}

# A tempting-looking but WRONG fix was tried and reverted here, 2026-09-06 — worth
# keeping the story rather than deleting it, so it isn't re-attempted: `Object Type`'s
# secondary entries ("postcard", "advertisement", "invitation", "christmas-card",
# "letter", "bookplate", "almanac") looked, from their labels alone, like personal/
# commercial ephemera riding along on Sir Muirhead Bone's 487-record BM holding (a
# single 1949 bulk studio-archive donation). Excluding records with any of those tags
# regardless of technique immediately regressed THREE already-loaded, already-verified
# artists when regression-tested: Eric Gill (31 wrongly excluded — he is specifically
# celebrated for his wood-engraved bookplates and Christmas cards as original
# artworks), Paul Nash (6), Stanley Anderson (8). Checking the actual `Description` text
# behind Bone's own "ephemera"-tagged records (not just trusting the tag name) showed
# the same thing: "Text for Bone's art classes. 1900 Etching", "Exhibition postcard...
# 1901 Etching" — these are genuine original etchings/drypoints that merely served a
# postcard/invitation/advertisement/bookplate FUNCTION, a real and common historical
# practice (hand-etched exhibition souvenir cards were routine), not evidence the
# record isn't a real print. The secondary object-type tag encodes FUNCTION, which is
# orthogonal to whether original printmaking technique was used — it is not a usable
# fine-art/ephemera signal on its own, at least not without per-tag content
# verification this session didn't have time to do properly before reverting.
# The one genuine case behind Bone's contamination (an almanac page, "Collotype with
# letterpress", a photomechanical REPRODUCTION of a drawing for Oxford University
# Press) is already correctly caught by the ordinary technique gate whenever the
# reproduction technique alone (without a co-occurring real printmaking term) fails
# `resolve_techniques()` — see the 4 "Collotype reproduction of drawing" records this
# session already found dropped that way, no extra code needed. A cheap heuristic that
# reliably separates "used for X" from "IS an original print" was not found this
# session; if revisited, verify content per confirmed case the way this note now
# documents doing for the first attempt, don't re-apply a tag-name-only exclusion.

CREDIT_LINE = "© The Trustees of the British Museum"
LICENSE = "CC BY-NC-SA 4.0"
_PREVIEW_SIZE_RE = re.compile(r"/preview_")


def _upsize_og_image_url(url):
    """`og:image` always links the `preview_` size — swap in `large_` for a real
    working image, same folder/filename otherwise (verified live 2026-09-06 against
    Rembrandt's images: same UUID folder + base filename `/api/_object`'s `multimedia`
    field also returns, one size prefix apart).

    **This does NOT hold for every image in BM's repository — confirmed 2026-09-06
    against Agathe Sorel's images**: `large_` 404s for all 28 of her images, across
    every folder-date prefix her records span (`2026_5/...` and `2015_1/...` alike) —
    only `preview_`/`small_` resolve. Since `media.britishmuseum.org` isn't behind
    Cloudflare (doc 09 §7.1), verified with a live HEAD request rather than assumed;
    falls back to the original `preview_` URL — still a real, working image, just
    lower-resolution — on anything other than a 200, so a DigitalImage.sourceUrl
    written to the graph is always immediately usable, never a placeholder that
    silently 404s downstream at embed time."""
    upsized = _PREVIEW_SIZE_RE.sub("/large_", url, count=1)
    if upsized == url:
        return url
    try:
        r = requests.head(upsized, timeout=10, allow_redirects=True)
        if r.status_code == 200:
            return upsized
    except Exception:
        pass
    return url


def resolve_techniques(fields):
    """Techniques recognized from the structured `Technique` field, falling back to the
    free-text `Description` when that yields nothing — found necessary against real
    Agathe Sorel data (2026-09-06): her 3 "Catalana Blanca" digital-lithograph prints
    all carry `Technique: ["digitally generated"]`, a genuine BM process descriptor with
    no AAT crosswalk entry, while the real printmaking technique ("Lithograph from
    computer-generated image") sits only in `Description`'s free text — confirmed via
    a direct `extract_techniques()` check against the raw description before adding this
    fallback, not guessed. The fallback only fires when the Technique field alone is
    uninformative, so a record with a real-but-unrecognized Technique value and an
    unrelated Description won't pick up spurious matches from curatorial prose."""
    from_technique = extract_techniques(" ".join(fields.get("Technique", [])))
    if from_technique:
        return from_technique
    return extract_techniques((fields.get("Description") or [""])[0])


def classify_record(fields, techniques=None):
    """Returns 'matrix' (route to LOAD_QUERY_MATRIX), 'excluded' (not a print — logged,
    never silently dropped), or 'print' (normal Impression/ConceptualWork pipeline).
    Found necessary against real data: BM's own object_type=print search facet returns
    both loose drawing sheets (Technique: drawn) and physical printing plates/casts
    (Materials: zinc alloy/plaster, no Technique field at all) alongside genuine prints
    — see module docstring points 2/3. `techniques` should be `resolve_techniques(fields)`
    (computed once and passed in by the caller, so classification and the stored
    `techniques` list can never drift apart) — recomputed here only if omitted."""
    materials = {m.strip().lower() for m in fields.get("Materials", [])}
    if materials and "paper" not in materials and (materials & PLATE_MATERIALS):
        return "matrix"
    if techniques is None:
        techniques = resolve_techniques(fields)
    if techniques:
        return "print"
    return "excluded"

_PRODUCER_RE = re.compile(r"^\s*([^:]+):\s*(.+?)\s*$")
# Strips a trailing parenthetical role note ("(calligraphy)") before matching a bare name.
_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")


def parse_producer(raw):
    """'Print made by: Rembrandt' -> ('print made by', 'Rembrandt'). A bare name with
    no 'Role: ' prefix (rare — seen on some BM records with a single unambiguous maker)
    is treated as 'print made by' since that's what an unqualified Producer name entry
    means in BM's own convention."""
    m = _PRODUCER_RE.match(raw)
    if not m:
        return "print made by", _TRAILING_PAREN_RE.sub("", raw).strip()
    role, name = m.group(1).strip().lower(), m.group(2).strip()
    return role, _TRAILING_PAREN_RE.sub("", name).strip()


def resolve_artist(name):
    key = name.strip().lower()
    if key in PILOT_ARTIST_RESOLUTION:
        return PILOT_ARTIST_RESOLUTION[key]
    return {"canonicalName": name, "ulanUrl": None}


_DATE_RE = re.compile(r"^(\d{4})(?:\s*\((circa)\))?$")


def parse_production_date(raw):
    if not raw:
        return None, None, None
    m = _DATE_RE.match(raw.strip())
    if not m:
        return None, None, raw
    year = int(m.group(1))
    precision = "circa" if m.group(2) else "exact"
    return year, precision, raw


_DIM_RE = re.compile(r"(Height|Width):\s*([\d.]+)\s*millimetres", re.IGNORECASE)


def parse_dimensions(dim_list):
    """['Height: 346 millimetres', 'Width: 292 millimetres'] -> '292x346mm'. BM doesn't
    label plate/sheet/image (see module docstring) — always routed to sheetDimensions."""
    if not dim_list:
        return None
    values = {}
    for entry in dim_list:
        m = _DIM_RE.search(entry)
        if m:
            values[m.group(1).lower()] = m.group(2)
    if "height" in values and "width" in values:
        return f"{values['width']}x{values['height']}mm"
    return None


_BIBLIO_RE = re.compile(r"^(.+?)\s*/\s*(.+)$")
_PAREN_GROUP_RE = re.compile(r"\(([^()]+)\)")
_TRAILING_YEAR_RE = re.compile(r"(\d{4})\s*$")
# A parenthetical like "(p.105-9)"/"(pp.184-5)" is a PAGE LOCATOR into the cited
# publication, not a per-work catalogue entry number — found live 2026-09-06 (10-artist
# BM priority-list batch #3, Antony Gormley's "Body & Soul" portfolio): all 9 plates
# cite "Booth-Clibborn 1995 / ... (p.105-9)", the identical page range, and (unlike
# Edward Bawden's same-class bug, fixed the same day) ALSO share an identical title —
# BM gives these 9 genuinely different engravings no per-plate "Object:" title at all,
# only a shared "Series: Body & Soul" — so the title-inclusive key in
# build_conceptual_work_id() didn't save this case the way it saved Bawden's. Confirmed
# live in a --dry-run before any write: without this filter, all 9 plates collapse into
# one ConceptualWork. Same class of "confident-looking garbage from a fragile regex"
# problem catalogue_matching.py's own NON_CATALOGUE_NAMES list already excludes for
# Forum/Roseberys (see that module's docstring) — extended here to BM's citation shape.
_PAGE_LOCATOR_RE = re.compile(r"^pp?\.?\s*\d", re.IGNORECASE)

# Catalogue-name prefixes that are confirmed general collection-survey/exhibition books
# (cataloguing the WHOLE bequest/collection by item number, not a catalogue raisonné of
# one artist's work) rather than genuine per-work catalogue raisonnés — the same
# "portfolio/collection-level citation covering several genuinely different works"
# failure mode catalogue_matching.py's own docstring documents for Forum's "Cramer 30"
# (point 2), just for a citation NAME here rather than a suspicious entry-number SHAPE
# (_PAGE_LOCATOR_RE above catches the shape-based cases; this catches ones that look
# like an ordinary bare number and would pass that check). Confirmed live, same Gormley
# case: "Daunt 2020 / Living with art: the Alexander Walker collection (123)" — a bare
# numeric entry, but shared identically across all 9 "Body & Soul" plates, since "123"
# is the WHOLE PORTFOLIO's item number in that general collection-survey book, not a
# per-plate number. Extend only from a confirmed case, never speculatively, matching
# NON_CATALOGUE_NAMES's own stated discipline.
BM_NON_CATALOGUE_NAMES = {"daunt 2020"}


def parse_bibliographic_ref(raw):
    """'New Hollstein (Dutch & Flemish) / The New Hollstein: ... (306.VI) (Rembrandt)'
    -> {catalogueName, catalogueTitle, entryNumber, year}. Skipped (returns None) if the
    '<name> / <title> (<number>)' shape doesn't match, if the parenthetical is a page
    locator rather than a genuine per-work entry number (see _PAGE_LOCATOR_RE), or if
    the catalogue name itself is a confirmed collection-survey book rather than a real
    catalogue raisonné (see BM_NON_CATALOGUE_NAMES) — any of the three logged as
    unmapped, not guessed."""
    m = _BIBLIO_RE.match(raw)
    if not m:
        return None
    catalogue_name, rest = m.group(1).strip(), m.group(2).strip()
    catalogue_name = CATALOGUE_NAME_RESOLUTION.get(catalogue_name.lower(), catalogue_name)
    if catalogue_name.lower() in BM_NON_CATALOGUE_NAMES:
        return None
    parens = _PAREN_GROUP_RE.findall(rest)
    if not parens:
        return None
    entry_number = parens[0]
    if _PAGE_LOCATOR_RE.match(entry_number.strip()):
        return None
    title = _PAREN_GROUP_RE.sub("", rest).strip()
    year_match = _TRAILING_YEAR_RE.search(catalogue_name)
    return {
        "catalogueName": catalogue_name,
        "catalogueTitle": title,
        "entryNumber": entry_number,
        "year": int(year_match.group(1)) if year_match else None,
    }


def _sanitize_id_part(s):
    return re.sub(r"\s+", "_", s.strip())


_TITLE_LABEL_RE = re.compile(r"^(Object|Series)\s*:\s*(.*)$", re.IGNORECASE)


def parse_title(title_list):
    """BM's 'Title' dt/dd item is itself multi-part, not a single string — most records
    carry an 'Object: <title>' entry plus, for prints from a named series/portfolio, a
    sibling 'Series: <name>' entry (e.g. ['Object: Salts', 'Series: A Tribute to Birgit
    Skiöld']). The 'Object:'/'Series:' text is BM's own sub-label, not part of the real
    title — confirmed live 2026-09-05, every previously-loaded `ConceptualWork.name` in
    the graph reading literally 'Object: <title>' because this was never stripped.
    Returns (title, series); an entry with neither recognized label falls back to being
    treated as a bare title (unprefixed dt/dd shape, same as before this function
    existed), so this doesn't regress any record that isn't split this way.

    A minority of records (confirmed live in the Trevelyan/Hayter test pulls) repeat
    the 'Object:' label — either a bilingual title pair ("Jeux d'eau" / "Water Play")
    or, for "The tenements of mind" (module docstring point 4), two genuinely different
    object titles for what BM's own curatorial note treats as one work. The FIRST
    'Object:'/'Series:' entry wins in either case, matching the position the old,
    unstripped `[0]`-indexing already always picked — this fix only strips the label,
    it doesn't change which entry is authoritative."""
    title = None
    series = None
    for raw in title_list or []:
        m = _TITLE_LABEL_RE.match(raw.strip())
        if not m:
            if title is None:
                title = raw.strip()
            continue
        label, value = m.group(1).lower(), m.group(2).strip()
        if not value:
            continue
        if label == "object" and title is None:
            title = value
        elif label == "series" and series is None:
            series = value
    return title, series


def map_record(record):
    fields = record["fields"]
    object_id = f"bm-{record['id']}"
    techniques = resolve_techniques(fields)
    record_type = classify_record(fields, techniques=techniques)

    producers = []
    skipped_roles = []
    for raw in fields.get("Producer name", []):
        role, name = parse_producer(raw)
        qualifier = ROLE_QUALIFIER_MAP.get(role)
        if qualifier is None:
            skipped_roles.append(raw)
            continue
        resolved = resolve_artist(name)
        producers.append({"role": role, "qualifier": qualifier, "rawName": name, **resolved})

    year, precision, display_label = parse_production_date(
        (fields.get("Production date") or [None])[0]
    )

    dims = parse_dimensions(fields.get("Dimensions"))
    title, series = parse_title(fields.get("Title"))
    description = (fields.get("Description") or [None])[0]
    museum_number = (fields.get("Museum number") or fields.get("Registration number") or [None])[0]

    catalogue_refs = []
    for raw in fields.get("Bibliographic references", []):
        parsed = parse_bibliographic_ref(raw)
        if parsed:
            catalogue_refs.append(parsed)

    og_image = record.get("ogImage")
    image_url = _upsize_og_image_url(og_image["url"]) if og_image and og_image.get("url") else None

    common = {
        "objectId": object_id,
        "recordType": record_type,
        "museumNumber": museum_number,
        "producers": producers,
        "skippedProducerRoles": skipped_roles,
        # Fallback chain: Object: title -> Series: title -> truncated free-text Description
        # -> generic placeholder. Series inserted 2026-09-06 (Josef Albers, 10-artist BM
        # priority-list batch #2): "Formulation: Articulation I"/"II" — a genuine two-part
        # portfolio pair — both carry ONLY a "Series:" Title entry (no "Object:" entry) and
        # near-identical boilerplate Descriptions that are byte-identical for their first
        # 120 characters (only diverging past that point, in text the truncation cut off).
        # Falling straight to the truncated-description fallback produced the SAME title
        # for both, which — combined with both records also citing the same catalogue
        # appendix reference ("Danilowitz 2001 ... (Appx.C)") — fed an identical key into
        # catalogue_matching.build_conceptual_work_id(), wrongly merging two different
        # portfolios into one ConceptualWork (confirmed live in a --dry-run before any
        # write). Series is real structured data (not free text) and IS the distinguishing
        # name for exactly this case, so it belongs before the description fallback, not
        # after it.
        "title": title or series or (description[:120] + "..." if description and len(description) > 120 else description) or f"Untitled ({object_id})",
        "seriesTitle": series,
        "rawDescription": description,
        "dateYear": year,
        "datePrecision": precision,
        "dateDisplayLabel": display_label,
        "catalogueRefs": catalogue_refs,
        "department": (fields.get("Department") or [None])[0],
        "imageUrl": image_url,
        "imageLicense": LICENSE if image_url else None,
        "imageCredit": CREDIT_LINE if image_url else None,
        "imageWidth": (og_image or {}).get("width") if image_url else None,
        "imageHeight": (og_image or {}).get("height") if image_url else None,
    }

    if record_type == "matrix":
        common["material"] = ", ".join(fields.get("Materials", [])) or None
        return common

    if record_type == "excluded":
        return common

    # record_type == "print"
    # See module docstring point 4: same catalogue-entry number == same ConceptualWork
    # — but identity-keying is delegated to catalogue_matching.build_conceptual_work_id()
    # rather than a bare catalogueName+entryNumber concat (fixed 2026-09-06, 10-artist
    # BM priority-list batch #2, Edward Bawden): BM's own "Howes 1988 / Edward Bawden: A
    # Retrospective Survey (p.10)" citation cites a PAGE number, not a per-work entry
    # number — 10 genuinely distinct engravings from the "Fifteen Engravings 1927-29"
    # portfolio (Kew Gardens, Reverie, Southcliffe Beach, Liverpool Street Station,
    # Tortoise, The Jetty Beach, Lane in Moonlight, Marine Parade, Round Trip, The Pagoda
    # Kew) all cite "(p.10)" and would have wrongly collapsed into ONE ConceptualWork —
    # confirmed live in a --dry-run before any write, not caught by chance. Exactly the
    # same failure mode already found and fixed for forum_ingest.py/roseberys_ingest.py
    # (doc 09 §7.6/§7.7: a portfolio/page-level citation can legitimately cover several
    # different plates) — every earlier BM artist's catalogue system (New Hollstein,
    # Hind, White & Boon, Hinterding, Turner, Black & Moorhead) happened to number
    # per-work already, so this bare-concat approach was never actually wrong before,
    # just never actually safe. build_conceptual_work_id() folds the normalized TITLE
    # into the key alongside artist+catalogue+entry, so same-page citations for
    # different-titled works now correctly stay separate; falls back to the
    # accession-keyed object_id (graceful degradation, doc 08 §4.1) when no genuine
    # catalogue ref exists, same as before.
    direct_producer = next((p for p in producers if p["qualifier"] == "direct"), None)
    conceptual_work_id = build_conceptual_work_id(
        source_prefix="bm",
        artist_name=(direct_producer or {}).get("canonicalName", "unknown"),
        title=common["title"],
        catalogue_refs=catalogue_refs,
        fallback_id=object_id,
    )

    common.update({
        "conceptualWorkId": conceptual_work_id,
        "techniques": techniques,
        "sheetDimensions": dims,
        "subjects": [{"name": s} for s in fields.get("Subjects", [])],
    })
    return common


LOAD_QUERY = """
UNWIND $rows AS row

// row.conceptualWorkId is shared across multiple accession records that cite the same
// catalogue-raisonné entry (module docstring point 4) — coalesce() on every SET so the
// second record merging into an already-created node doesn't clobber it with its own
// (equivalent, but not necessarily identically-worded) title/date.
MERGE (cw:ConceptualWork {id: row.conceptualWorkId})
SET cw.name = coalesce(cw.name, row.title),
    cw.seriesTitle = coalesce(cw.seriesTitle, row.seriesTitle),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, row.datePrecision),
    cw.dateCreated_displayLabel = coalesce(cw.dateCreated_displayLabel, row.dateDisplayLabel)

MERGE (er:EditionRun {id: row.objectId + "-er"})
SET er.dateRange_year = row.dateYear,
    er.dateRange_precision = row.datePrecision
MERGE (cw)-[:PRINTED_AS]->(er)

MERGE (imp:Impression {id: row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.rawMedium = row.rawDescription
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "institutional",
    src.institutionName = "British Museum",
    src.accessionNumber = row.museumNumber
MERGE (src)-[:DOCUMENTS]->(imp)

FOREACH (_ IN CASE WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END |
  MERGE (img:DigitalImage {id: row.objectId + "-image"})
  SET img.sourceUrl = row.imageUrl,
      img.imageType = "primary",
      img.license = row.imageLicense,
      img.credit = row.imageCredit,
      img.widthPixels = row.imageWidth,
      img.heightPixels = row.imageHeight
  MERGE (img)-[:SHOWS]->(imp)
)

WITH row, imp, cw, src
UNWIND (CASE WHEN size(row.producers) = 0 THEN [null] ELSE row.producers END) AS producer
FOREACH (_ IN CASE WHEN producer IS NOT NULL THEN [1] ELSE [] END |
  MERGE (artist:Artist {name: producer.canonicalName})
  SET artist.ulanUrl = coalesce(artist.ulanUrl, producer.ulanUrl),
      artist.identityConfidence = coalesce(artist.identityConfidence,
          CASE WHEN producer.ulanUrl IS NOT NULL THEN "single_source" ELSE "unresolved" END),
      artist.alternateNames = CASE
          WHEN producer.rawName IS NOT NULL AND NOT producer.rawName IN coalesce(artist.alternateNames, [])
          THEN coalesce(artist.alternateNames, []) + producer.rawName
          ELSE artist.alternateNames
      END
  MERGE (src)-[att:ATTRIBUTED_TO]->(artist)
  SET att.qualifier = producer.qualifier
)
FOREACH (_ IN CASE WHEN producer IS NOT NULL AND producer.qualifier = "direct" THEN [1] ELSE [] END |
  MERGE (creator:Artist {name: producer.canonicalName})
  MERGE (creator)-[:CREATED]->(cw)
)

WITH row, imp, cw
UNWIND (CASE WHEN size(row.techniques) = 0 THEN [null] ELSE row.techniques END) AS tech
FOREACH (_ IN CASE WHEN tech IS NOT NULL THEN [1] ELSE [] END |
  MERGE (t:Technique {name: tech.name})
  SET t.aatId = CASE WHEN tech.aatId IS NOT NULL THEN tech.aatId ELSE t.aatId END
  MERGE (imp)-[:USES_TECHNIQUE]->(t)
)

WITH row, imp, cw
UNWIND (CASE WHEN size(row.subjects) = 0 THEN [null] ELSE row.subjects END) AS subject
FOREACH (_ IN CASE WHEN subject IS NOT NULL THEN [1] ELSE [] END |
  MERGE (s:Subject {name: subject.name})
  MERGE (imp)-[:DEPICTS]->(s)
)

WITH row, cw
UNWIND (CASE WHEN size(row.catalogueRefs) = 0 THEN [null] ELSE row.catalogueRefs END) AS ref
WITH row, cw, ref WHERE ref IS NOT NULL
MERGE (cr:CatalogueRaisonne {numberingPrefix: ref.catalogueName})
SET cr.title = coalesce(cr.title, ref.catalogueTitle),
    cr.year = coalesce(cr.year, ref.year)
MERGE (ce:CatalogueEntry {id: ref.catalogueName + "-" + ref.entryNumber})
SET ce.number = ref.entryNumber
MERGE (cr)-[:CONTAINS]->(ce)
MERGE (ce)-[:DOCUMENTS]->(cw)
"""

# Matrix records (module docstring point 3) skip ConceptualWork/EditionRun/Impression
# entirely — a plate is not an impression pulled from itself. Attribution still goes
# through a SourceRecord, same ATTRIBUTED_TO shape as the print pipeline, so a plate
# with an unresolved/uncertain maker is recorded the same evidential way a print's
# attribution would be, per doc 08 principle 7.
LOAD_QUERY_MATRIX = """
UNWIND $rows AS row

MERGE (m:Matrix {id: row.objectId})
SET m.material = row.material,
    m.description = row.rawDescription

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "institutional",
    src.institutionName = "British Museum",
    src.accessionNumber = row.museumNumber
MERGE (src)-[:DOCUMENTS]->(m)

FOREACH (_ IN CASE WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END |
  MERGE (img:DigitalImage {id: row.objectId + "-image"})
  SET img.sourceUrl = row.imageUrl,
      img.imageType = "primary",
      img.license = row.imageLicense,
      img.credit = row.imageCredit,
      img.widthPixels = row.imageWidth,
      img.heightPixels = row.imageHeight
  MERGE (img)-[:SHOWS]->(m)
)

WITH row, m, src
UNWIND (CASE WHEN size(row.producers) = 0 THEN [null] ELSE row.producers END) AS producer
FOREACH (_ IN CASE WHEN producer IS NOT NULL THEN [1] ELSE [] END |
  MERGE (artist:Artist {name: producer.canonicalName})
  SET artist.ulanUrl = coalesce(artist.ulanUrl, producer.ulanUrl),
      artist.identityConfidence = coalesce(artist.identityConfidence,
          CASE WHEN producer.ulanUrl IS NOT NULL THEN "single_source" ELSE "unresolved" END),
      artist.alternateNames = CASE
          WHEN producer.rawName IS NOT NULL AND NOT producer.rawName IN coalesce(artist.alternateNames, [])
          THEN coalesce(artist.alternateNames, []) + producer.rawName
          ELSE artist.alternateNames
      END
  MERGE (src)-[att:ATTRIBUTED_TO]->(artist)
  SET att.qualifier = producer.qualifier
)
FOREACH (_ IN CASE WHEN producer IS NOT NULL AND producer.qualifier = "direct" THEN [1] ELSE [] END |
  MERGE (maker:Artist {name: producer.canonicalName})
  MERGE (maker)-[:MADE_MATRIX]->(m)
)
"""


def load_cache(path=PILOT_CACHE_PATH):
    with open(path) as f:
        return json.load(f)


def run(records, dry_run=False):
    rows = [map_record(r) for r in records]

    excluded = [r for r in rows if r["recordType"] == "excluded"]
    if excluded:
        print(f"[EXCLUDED] {len(excluded)} record(s) have no recognized printmaking technique (drawings, sketchbooks, etc.):", flush=True)
        for r in excluded:
            print(f"  {r['objectId']}: {r['title'][:70]!r}", flush=True)

    print_rows = [r for r in rows if r["recordType"] == "print"]
    matrix_rows = [r for r in rows if r["recordType"] == "matrix"]

    all_skipped = [(r["objectId"], role) for r in rows for role in r["skippedProducerRoles"]]
    if all_skipped:
        print(f"[UNMAPPED] {len(all_skipped)} producer role(s) skipped (no qualifier mapping):", flush=True)
        for object_id, role in all_skipped:
            print(f"  {object_id}: {role!r}", flush=True)

    no_direct = [r["objectId"] for r in (print_rows + matrix_rows) if not any(p["qualifier"] == "direct" for p in r["producers"])]
    if no_direct:
        print(f"[WARN] {len(no_direct)} record(s) have no 'direct' producer (no CREATED/MADE_MATRIX edge will be written): {no_direct}", flush=True)

    shared_work_ids = {}
    for r in print_rows:
        shared_work_ids.setdefault(r["conceptualWorkId"], []).append(r["objectId"])
    shared = {k: v for k, v in shared_work_ids.items() if len(v) > 1}
    if shared:
        print(f"[MERGED] {len(shared)} ConceptualWork(s) shared across multiple accession records (same catalogue entry):", flush=True)
        for cw_id, object_ids in shared.items():
            print(f"  {cw_id}: {object_ids}", flush=True)

    with_image = [r["objectId"] for r in (print_rows + matrix_rows) if r.get("imageUrl")]
    print(f"[IMAGES] {len(with_image)}/{len(print_rows) + len(matrix_rows)} record(s) have an image "
          f"(DigitalImage will be created for these)", flush=True)

    if dry_run:
        print(json.dumps(rows, indent=2, default=str))
        print(f"[DRY RUN] {len(print_rows)} print(s), {len(matrix_rows)} matrix object(s), "
              f"{len(excluded)} excluded — nothing written.", flush=True)
        return

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if print_rows:
                session.run(LOAD_QUERY, rows=print_rows).consume()
            if matrix_rows:
                session.run(LOAD_QUERY_MATRIX, rows=matrix_rows).consume()
    finally:
        driver.close()
    print(f"[DONE] loaded {len(print_rows)} print(s) + {len(matrix_rows)} matrix object(s), "
          f"skipped {len(excluded)} excluded record(s)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print mapped rows, write nothing")
    parser.add_argument("--cache-path", default=PILOT_CACHE_PATH, help="Path to a cached JSON record list (default: the Rembrandt pilot cache)")
    args = parser.parse_args()

    records = load_cache(args.cache_path)
    print(f"Loaded {len(records)} cached record(s) from {args.cache_path}", flush=True)
    run(records, dry_run=args.dry_run)
