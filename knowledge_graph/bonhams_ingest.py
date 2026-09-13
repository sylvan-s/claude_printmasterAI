"""
PrintMasterAI — Bonhams Group bulk catalogue ingestion into the ACKG (Neo4j)
Version: BONHAMS-INGEST-1.0

Executable counterpart to doc 09's Bonhams adapter section, same relationship as every
other adapter in this project: the doc describes the mapping, this file enforces it.

Source: `bonhams_prints_and_multiples_full_history.json`, a full-history export of one
Google-Drive-supplied file, 85,847 lot records, one flat JSON list, no CSV pre-parsing by
an external tool this time (unlike Roseberys/Forum). Confirmed by direct inspection before
writing a single line of mapping code, not assumed from the filename:

  1. **This is not single-institution data.** `auction.brand` splits as bonhams (78,857),
     cornette [Cornette de Saint Cyr, French] (4,983), skinner [Bonhams Skinner] (1,890),
     bukowskis [Swedish] (89), bruun_rasmussen [Danish] (28) — five real, distinct auction
     houses under one corporate export, not one house's data mislabeled. Scoped here to
     English-language brands only: `bonhams` + `skinner` (80,747 records, 94% of the file).
     The other three carry catalogue text in French/Swedish/Danish, which this adapter's
     English free-text regexes (signed/edition/printer/publisher phrasing, technique
     keywords) would silently mis-parse or under-match rather than genuinely handle — a
     real follow-up adapter, not attempted speculatively here. Every non-eligible-brand
     row is preserved in the excluded-rows CSV (reason `non_english_brand_deferred`), not
     silently dropped, same discipline as every other filter below.
  2. **No pre-parsed columns at all** — `title`/`catalog_description` are raw per-lot HTML
     (LotHeading/LotName/LotDesc divs), much closer to doc 09 §3's original Roseberys
     *live-page* pilot (all HEURISTIC_EXTRACTION) than to this project's other bulk-CSV
     adapters. All of signed/edition-size/printer/publisher/dimensions/catalogue-ref/year
     extraction is done here via `bonhams_parsing.py`'s regexes, verified against real
     sampled records (see that module's own docstring and doc 09's Bonhams section for the
     specific cases checked) — not a verified crosswalk, and not expected to be perfect.
  3. **No multi-work column** — Roseberys/Forum's external parser flagged multi-work lots
     for us; this source doesn't, so `bonhams_parsing.detect_multi_work()` is a from-
     scratch heuristic (trailing count markers, "comprising"/"a collection"/"together
     with"-style phrases, and semicolon-joined multiple titles on one line). Same policy
     as Roseberys/Forum once flagged: excluded from this load, not mismodeled, preserved
     in the excluded-rows CSV, real follow-up if multi-work parsing is ever wanted.
  4. **Genuinely multi-currency** — unlike Roseberys/Forum (GBP-native), Bonhams' export
     carries USD/GBP/SEK/DKK etc. per lot (`estimates.currency`). `priceCurrency` is set
     from the row's own actual currency, not hardcoded "GBP" — hardcoding it would have
     been a real, silent correctness bug for every non-UK sale. Bonhams' own already-
     computed GBP-equivalent estimates (`pricing.gbp_low_estimate/gbp_high_estimate`) are
     additionally stored as `estimateLowGBP`/`estimateHighGBP` for cross-currency
     comparison, since that conversion is the source's own DIRECT data, not derived here.
     No equivalent GBP conversion is supplied for the realised hammer price — `hammerPrice`/
     `priceRealised` stay in the row's native currency rather than being approximated from
     the estimate-time FX rate, which could easily be stale relative to the sale date.
  5. **`status` determines `sold`/`hammerPrice`, and WD is excluded outright.** SOLD ->
     sold=True, hammerPrice = `pricing.hammer_price` (the hammer), priceRealised =
     `pricing.hammer_premium` (both native-currency). Despite its name, `hammer_premium`
     is NOT the premium amount to be added to the hammer — it is the premium-INCLUSIVE
     TOTAL, the figure Bonhams' own lot pages print as "Sold for X inc. premium".
     Confirmed three ways rather than inferred from the field name: (a) against live
     Bonhams pages in two currencies — sale 26785 lot 179 (hammer 700.0, hammer_premium
     892.5) reads "Sold for GBP892.50 inc. premium", and sale 15403 lot 330 (hammer
     1800.0, hammer_premium 2160.0) reads "Sold for US$2,160 inc. premium"; (b) by sign
     test across all 59,824 eligible SOLD rows — not one has hammer_premium <
     hammer_price, which a genuine premium amount would have to be in every single case;
     (c) by the ratio distribution, which clusters on the real Bonhams schedules
     (1.175/1.195/1.20/1.22/1.25/1.275/1.28 by era and currency) rather than on the
     absurd 117%-128% premium rates the additive reading implies. An earlier version of
     this adapter read the field additively, inflating priceRealised by one whole hammer
     on every sold row; `migrations/2026-09-08_bonhams_price_realised_premium_basis.py`
     repairs graph data written by it. BI
     (bought in / reserve not met), NEW (future/pending lot), CS, WR -> sold=False,
     hammerPrice=None (their raw `pricing.hammer_price` is a literal 0.0 placeholder, not
     a real sale total — storing it as-is would fabricate a "sold for 0" fact). WD
     (withdrawn, 530 of 80,747) -> excluded entirely: a withdrawn lot never actually went
     under the hammer and may reflect a stale/duplicate future re-listing, not a fact
     about a real transaction.
  6. **No `reserve` value supplied** — Bonhams gives `pricing.starting_bid` (the
     auctioneer's opening call), a genuinely different concept from Roseberys/Forum's
     `reserve` (the confidential minimum). Left UNMAPPED (doc 09 §1) rather than force-fit
     into the `reserve` field, which would misrepresent what the number actually means.
  7. **Non-print-medium filter reused as-is** (same convention as the BM/Tate adapters,
     not a new invention): a record whose free text yields zero recognized printmaking/
     photographic technique after `crosswalk_matching.extract_techniques()` is excluded.
     "Prints & Multiples" as a department genuinely includes ceramics (e.g. Picasso Madoura
     plates), bronze/painted multiples, and works on paper with no print process at all —
     real objects, just outside this graph's `Impression` model, same reasoning as BM's
     `Matrix`-vs-`Impression` split (doc 09 §7.2), just excluded rather than routed to a
     new node type here since these aren't printing plates/matrices either.
  8. **Photographic-print vocabulary gap found and fixed before this load, not after** —
     a systematic scan of ~3,000 sampled single-work Bonhams/Skinner lots found ~17% had
     no recognized technique at all, and "gelatin silver print" alone accounted for most
     of that gap: none of this project's prior sources (Met/Tate/Roseberys/Forum/BM)
     carried meaningful photography volume, so `crosswalk_matching.TECHNIQUE_KEYWORDS`
     never needed photographic-process terms before. Added (Gelatin silver/Platinum/
     Chromogenic/Cibachrome/Pigment print) with AAT ids left explicitly null/unverified in
     `aat_crosswalk.json` — a deliberate departure from this project's usual "verify live
     before adding" discipline, flagged there rather than silently skipped or guessed.
     Brought the unmatched rate down to ~11% on the same sample; the residue is
     predominantly genuine non-print objects (bronze/ceramic multiples, drawings,
     paintings) correctly caught by the filter above, plus a small residual gap (a few
     more photographic processes, a different Skinner-house-style "Printer:/Condition:"
     labelled format) logged here rather than exhaustively chased.

Artist identity: same policy as Roseberys/Forum — no ULAN/Wikidata supplied, merges by
(cleaned, honorific-stripped, qualifier-prefix-stripped) name with identityConfidence
"unresolved". Qualifier itself IS recoverable here, unlike Roseberys/Forum's bulk CSVs
which needed a pre-supplied column — Bonhams bakes it as a literal text prefix on the
`artist` field ("After Pablo Picasso", "Attributed to X", "Circle of X", "School of X"),
parsed via `bonhams_parsing.strip_qualifier_prefix()`. `school_of` is a new qualifier
value this adapter adds to doc 08's enum, following the exact precedent Roseberys already
set for `studio_of`/`follower_of` — extending the enum for a confirmed real value rather
than force-fitting it into an existing one.

`ConceptualWork` identity keying: delegated entirely to the shared `catalogue_matching.py`
(also used by roseberys_ingest.py/forum_ingest.py) — same artist+catalogue+entry+exact-
normalized-title key, same NON_CATALOGUE_NAMES guard, same no-fuzzy-matching rule. Bonhams'
own catalogue abbreviations are often terser than Forum's ("V. 206", "B. 26", "D. 483")
but the shared module never needs to know what a cataloguer abbreviation actually stands
for — only that citations agreeing on catalogueName+entryNumber+artist+exact title are the
same work — so this is safe by the same logic already established there.

Usage:
    python3 bonhams_ingest.py --limit 50 --dry-run     # sanity-check mapping, no DB writes
    python3 bonhams_ingest.py --all                     # full bonhams+skinner load
    python3 bonhams_ingest.py --brands bonhams --all
"""

import argparse
import csv
import json
import os
import time

from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques, extract_papers
from resolve_artist_identity import strip_honorifics
from catalogue_matching import parse_catalogue_refs, genuine_refs, build_conceptual_work_id, sanitize_id_part, resolve_merged_work_cypher
from bonhams_parsing import (
    strip_tags, extract_lot_heading, extract_lot_name_html, extract_lot_desc_html,
    strip_qualifier_prefix, clean_artist_name, normalize_all_caps_name, parse_lot_name,
    strip_leading_parenthetical,
    parse_lot_desc, detect_signed, extract_edition_size, extract_printer_publisher,
    extract_dimensions, detect_multi_work,
)
from embed_titles_hook import embed_new_titles


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real Neo4j values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

BONHAMS_JSON_PATH = (
    "/Users/sylvansitkey/Library/CloudStorage/GoogleDrive-sylvansitkey07@gmail.com/"
    "My Drive/02 Personal Projects/Printmaster AI/Catalogs/"
    "bonhams_prints_and_multiples_full_history.json"
)

# See module docstring point 1 — five real, distinct auction houses in one export.
BRAND_INSTITUTION_MAP = {
    "bonhams": "Bonhams",
    "skinner": "Skinner",
    "cornette": "Cornette de Saint Cyr",
    "bukowskis": "Bukowskis",
    "bruun_rasmussen": "Bruun Rasmussen",
}
DEFAULT_ELIGIBLE_BRANDS = {"bonhams", "skinner"}

# Placeholder "artist" values confirmed present in the source (825 rows across bonhams+
# skinner) that aren't a real, individually-attributable person/entity — same reasoning
# tate_ingest.py already applied to Tate's literal "Anonymous" placeholder (doc 09 §4.2):
# merging these as if they were one real identity would fabricate a false shared
# attribution across otherwise-unrelated lots, and "various artists" specifically means
# the lot spans MULTIPLE different real artists, which a single-Artist merge key can't
# represent at all.
PLACEHOLDER_ARTIST_NAMES = {"various artists", "artist unknown", "anonymous", "unknown artist", "unknown"}


def resolve_artist_fields(raw_artist):
    """The ONE artist-name assembly chain for this adapter — `map_record()` maps with it
    and `load_records()` filters with it, so the "two divergent lists problem" that
    crosswalk_matching.py/catalogue_matching.py both warn about cannot open up between
    the filter and the mapper. Returns (qualifier, name); `name` is "" when the source
    value cleans away to nothing, which the caller MUST treat as unusable rather than
    pass to the `MERGE (artist:Artist {name: ...})` key.

    strip_leading_parenthetical() runs FIRST, before strip_qualifier_prefix(): on
    "(n/a) After John James Audubon" the qualifier is hidden behind the parenthetical,
    so the old order matched no prefix and recorded a print Audubon did not make as a
    `direct` attribution (confirmed live, repaired 2026-09-11)."""
    fixed = strip_leading_parenthetical(raw_artist)
    qualifier, remainder = strip_qualifier_prefix(fixed)
    name = strip_honorifics(normalize_all_caps_name(clean_artist_name(remainder)))
    return qualifier, (name or "").strip()


_PLAUSIBLE_YEAR_RANGE = (1200, 2030)


def _plausible_year(raw):
    if raw is None:
        return None
    s = "".join(ch for ch in str(raw) if ch.isdigit())
    if len(s) != 4:
        return None
    year = int(s)
    return year if _PLAUSIBLE_YEAR_RANGE[0] <= year <= _PLAUSIBLE_YEAR_RANGE[1] else None


COPY_TYPE_KEYWORDS = [
    ("AP", ["artist's proof", "artists proof", " ap ", "'ap'", "inscribed ap"]),
    ("HC", ["hors commerce", " hc ", "'hc'", "inscribed hc"]),
    ("PP", ["printer's proof", "printers proof", " pp "]),
    ("BAT", ["bon", " bat "]),
    ("TP", ["trial proof", " tp "]),
]


def detect_copy_type(text):
    t = f" {(text or '')} ".lower()
    for label, keywords in COPY_TYPE_KEYWORDS:
        if any(kw in t for kw in keywords):
            return label
    return "numbered"


def map_record(record):
    lot_id = str(record["lot_id"])
    base_id = f"bonhams-{sanitize_id_part(lot_id)}"
    brand = record["auction"]["brand"]
    institution = BRAND_INSTITUTION_MAP.get(brand, brand)

    raw_artist = record["artist"]
    qualifier, stripped_name = resolve_artist_fields(raw_artist)

    catalog_html = record.get("catalog_description") or ""
    lot_name_html = extract_lot_name_html(catalog_html)
    nationality, begin_year, end_year = parse_lot_name(lot_name_html or "")

    lot_desc_html = extract_lot_desc_html(catalog_html)
    desc = parse_lot_desc(lot_desc_html or "")
    detail_text = desc["detailText"]

    techniques = extract_techniques(detail_text)
    papers = extract_papers(detail_text)
    dims = extract_dimensions(detail_text)
    signed = detect_signed(detail_text)
    edition_size = extract_edition_size(detail_text)
    printer, publisher = extract_printer_publisher(detail_text)
    copy_type = detect_copy_type(detail_text)

    title = desc["title"] or strip_tags(record.get("title") or "") or f"Untitled ({base_id})"
    catalogue_refs = genuine_refs(parse_catalogue_refs(desc["catalogueRefText"]))
    year_val = _plausible_year(desc["year"])

    conceptual_work_id = build_conceptual_work_id(
        source_prefix="bonhams",
        artist_name=stripped_name,
        title=title,
        catalogue_refs=catalogue_refs,
        fallback_id=base_id,
    )

    status = record.get("status")
    sold = (status == "SOLD")
    pricing = record.get("pricing") or {}
    estimates = record.get("estimates") or {}
    currency = estimates.get("currency") or None

    raw_hammer = pricing.get("hammer_price")
    # `pricing.hammer_premium` is the premium-INCLUSIVE TOTAL, not the premium amount:
    # it is the exact figure Bonhams' own lot pages print as "Sold for X inc. premium"
    # (see docstring item 5). It is therefore `priceRealised` as-is, never an addend.
    raw_realised = pricing.get("hammer_premium")
    hammer_price = raw_hammer if (sold and raw_hammer) else None
    price_realised = raw_realised if (sold and raw_hammer and raw_realised) else None

    auction_id = record.get("auction", {}).get("id")
    try:
        auction_internal_id = int(auction_id) if auction_id else None
    except (TypeError, ValueError):
        auction_internal_id = None

    lot_number_raw = record.get("lot_number")
    try:
        lot_number = int(lot_number_raw) if lot_number_raw not in (None, "") else None
    except (TypeError, ValueError):
        lot_number = None

    provenance = extract_lot_heading(catalog_html)

    return {
        "objectId": base_id,
        "conceptualWorkId": conceptual_work_id,
        "institutionName": institution,
        "saleId": str(auction_id) if auction_id else None,
        "auctionInternalId": auction_internal_id,
        "lotNumber": lot_number,
        "saleDate": record.get("auction", {}).get("sale_date"),
        "artistName": stripped_name,
        "artistDisplayName": raw_artist,
        "artistNationality": nationality,
        "artistBeginYear": begin_year,
        "artistEndYear": end_year,
        "qualifier": qualifier,
        "title": title,
        "dateYear": year_val,
        "rawMedium": detail_text or None,
        "techniques": techniques,
        "papers": papers,
        "sheetDimensions": dims["sheetDimensions"],
        "imageDimensions": dims["imageDimensions"],
        "plateDimensions": dims["plateDimensions"],
        "editionSize": edition_size,
        "copyType": copy_type,
        "signed": signed,
        "printer": printer,
        "publisher": publisher,
        "catalogueRefs": catalogue_refs,
        "provenanceNote": provenance,
        "listingUrl": record.get("url"),
        "imageUrl": record.get("primary_image_url"),
        "estimateLow": estimates.get("low"),
        "estimateHigh": estimates.get("high"),
        "estimateLowGBP": pricing.get("gbp_low_estimate"),
        "estimateHighGBP": pricing.get("gbp_high_estimate"),
        "hammerPrice": hammer_price,
        "priceRealised": price_realised,
        "priceCurrency": currency,
        "sold": sold,
        "status": status,
    }


LOAD_QUERY = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.nationality = coalesce(row.artistNationality, artist.nationality),
    artist.dateBorn_year = coalesce(row.artistBeginYear, artist.dateBorn_year),
    artist.dateBorn_precision = CASE WHEN row.artistBeginYear IS NOT NULL THEN "exact" ELSE artist.dateBorn_precision END,
    artist.dateDied_year = coalesce(row.artistEndYear, artist.dateDied_year),
    artist.dateDied_precision = CASE WHEN row.artistEndYear IS NOT NULL THEN "exact" ELSE artist.dateDied_precision END,
    artist.identityConfidence = coalesce(artist.identityConfidence, "unresolved"),
    artist.alternateNames = CASE
        WHEN row.artistDisplayName IS NOT NULL AND NOT row.artistDisplayName IN coalesce(artist.alternateNames, [])
        THEN coalesce(artist.alternateNames, []) + row.artistDisplayName
        ELSE artist.alternateNames
    END

""" + resolve_merged_work_cypher('row.conceptualWorkId', ['row', 'artist']) + """
SET cw.name = coalesce(cw.name, row.title),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, "exact")
MERGE (artist)-[:CREATED]->(cw)

MERGE (er:EditionRun {id: row.objectId + "-er"})
SET er.dateRange_year = row.dateYear,
    er.dateRange_precision = "exact",
    er.declaredSize = row.editionSize
MERGE (cw)-[:PRINTED_AS]->(er)

FOREACH (_ IN CASE WHEN row.printer IS NOT NULL THEN [1] ELSE [] END |
  MERGE (printer:Publisher {name: row.printer})
  MERGE (er)-[:PRINTED_BY]->(printer)
)
FOREACH (_ IN CASE WHEN row.publisher IS NOT NULL THEN [1] ELSE [] END |
  MERGE (publisher:Publisher {name: row.publisher})
  MERGE (er)-[:PUBLISHED_BY]->(publisher)
)

MERGE (imp:Impression {id: row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.imageDimensions = row.imageDimensions,
    imp.plateDimensions = row.plateDimensions,
    imp.rawMedium = row.rawMedium,
    imp.copyType = row.copyType,
    imp.signed = row.signed,
    imp.provenanceNote = row.provenanceNote
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "auction",
    src.institutionName = row.institutionName,
    src.saleId = row.saleId,
    src.auctionInternalId = row.auctionInternalId,
    src.lotNumber = row.lotNumber,
    src.saleDate = row.saleDate,
    src.estimateLow = row.estimateLow,
    src.estimateHigh = row.estimateHigh,
    src.estimateLowGBP = row.estimateLowGBP,
    src.estimateHighGBP = row.estimateHighGBP,
    src.hammerPrice = row.hammerPrice,
    src.priceRealised = row.priceRealised,
    src.priceCurrency = row.priceCurrency,
    src.sold = row.sold,
    src.status = row.status,
    src.listingUrl = row.listingUrl
MERGE (src)-[:DOCUMENTS]->(imp)
MERGE (src)-[att:ATTRIBUTED_TO]->(artist)
SET att.qualifier = row.qualifier

FOREACH (_ IN CASE WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END |
  MERGE (img:DigitalImage {id: row.objectId + "-image"})
  SET img.sourceUrl = row.imageUrl, img.imageType = "listing_photo"
  MERGE (img)-[:SHOWS]->(imp)
)

WITH row, imp, cw
UNWIND (CASE WHEN size(row.techniques) = 0 THEN [null] ELSE row.techniques END) AS tech
FOREACH (_ IN CASE WHEN tech IS NOT NULL THEN [1] ELSE [] END |
  MERGE (t:Technique {name: tech.name})
  FOREACH (_ IN CASE WHEN tech.aatId IS NOT NULL THEN [1] ELSE [] END | SET t.aatId = tech.aatId)
  MERGE (imp)-[:USES_TECHNIQUE]->(t)
)

WITH row, imp, cw
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  MERGE (imp)-[:PRINTED_ON]->(p)
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END
)

WITH row, cw
UNWIND (CASE WHEN size(row.catalogueRefs) = 0 THEN [null] ELSE row.catalogueRefs END) AS ref
FOREACH (_ IN CASE WHEN ref IS NOT NULL THEN [1] ELSE [] END |
  MERGE (cr:CatalogueRaisonne {numberingPrefix: ref.catalogueName})
  MERGE (ce:CatalogueEntry {id: ref.catalogueName + "-" + ref.entryNumber})
  SET ce.number = ref.entryNumber
  MERGE (cr)-[:CONTAINS]->(ce)
  MERGE (ce)-[:DOCUMENTS]->(cw)
)
"""


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        try:
            with driver.session(database=NEO4J_DATABASE) as session:
                session.run(LOAD_QUERY, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def load_records(brands=None, limit=None, exclude_multi_work=True,
                  log_excluded_path="bonhams_excluded_rows.csv"):
    with open(BONHAMS_JSON_PATH) as fh:
        all_records = json.load(fh)

    eligible_brands = set(brands) if brands else set(DEFAULT_ELIGIBLE_BRANDS)

    excluded = []
    kept = []
    for r in all_records:
        brand = r.get("auction", {}).get("brand")
        if brand not in eligible_brands:
            excluded.append((r, "non_english_brand_deferred"))
            continue
        if not r.get("artist"):
            excluded.append((r, "no_artist"))
            continue
        if r["artist"].strip().lower() in PLACEHOLDER_ARTIST_NAMES:
            excluded.append((r, "placeholder_artist_name"))
            continue
        if not resolve_artist_fields(r["artist"])[1]:
            excluded.append((r, "artist_name_empty_after_cleaning"))
            continue
        if r.get("status") == "WD":
            excluded.append((r, "withdrawn"))
            continue
        kept.append(r)

    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'non_english_brand_deferred')} "
          f"non-English-brand rows (cornette/bukowskis/bruun_rasmussen — deferred, see module docstring)",
          flush=True)
    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'no_artist')} rows with no artist field",
          flush=True)
    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'placeholder_artist_name')} rows with a "
          f"placeholder artist value (various artists/anonymous/unknown — see PLACEHOLDER_ARTIST_NAMES)", flush=True)
    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'artist_name_empty_after_cleaning')} "
          f"rows whose artist value cleans away to an empty string — these must never reach the "
          f"MERGE (artist:Artist {{name: ...}}) key, see resolve_artist_fields()", flush=True)
    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'withdrawn')} withdrawn (status=WD) lots",
          flush=True)

    if exclude_multi_work:
        still_kept = []
        multi_count = 0
        for r in kept:
            lot_desc_html = extract_lot_desc_html(r.get("catalog_description") or "")
            desc = parse_lot_desc(lot_desc_html or "")
            is_multi, reason = detect_multi_work(r.get("catalog_description"), r.get("title"), desc["title"])
            if is_multi:
                excluded.append((r, f"multi_work:{reason}"))
                multi_count += 1
            else:
                still_kept.append(r)
        kept = still_kept
        print(f"[FILTER] excluded {multi_count} multi-work lots (heuristic detection — no pre-supplied "
              f"column for this source, see module docstring point 3)", flush=True)

    non_print = []
    print_kept = []
    for r in kept:
        lot_desc_html = extract_lot_desc_html(r.get("catalog_description") or "")
        desc = parse_lot_desc(lot_desc_html or "")
        techs = extract_techniques(desc["detailText"])
        if techs:
            print_kept.append(r)
        else:
            non_print.append(r)
            excluded.append((r, "non_print_medium"))
    kept = print_kept
    print(f"[FILTER] excluded {len(non_print)} non-print-medium lots (ceramics, bronze/painted multiples, "
          f"drawings, paintings — this graph scopes to prints; see module docstring point 7)", flush=True)

    if log_excluded_path and excluded:
        with open(log_excluded_path, "w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["lot_id", "brand", "artist", "title", "status", "exclusion_reason"])
            for r, reason in excluded:
                writer.writerow([
                    r.get("lot_id"), r.get("auction", {}).get("brand"), r.get("artist"),
                    r.get("title"), r.get("status"), reason,
                ])
        print(f"[FILTER] all {len(excluded)} excluded rows preserved in {log_excluded_path}", flush=True)

    if limit:
        kept = kept[:limit]
    return kept


def run(records, chunk_size=200, dry_run=False):
    total = len(records)
    start = time.time()
    for chunk_start in range(0, total, chunk_size):
        chunk = records[chunk_start:chunk_start + chunk_size]
        rows = [map_record(r) for r in chunk]
        if dry_run:
            for row in rows[:3]:
                print(json.dumps(row, indent=2, ensure_ascii=False, default=str))
        else:
            _write_chunk_with_retry(rows)
        done = chunk_start + len(chunk)
        elapsed = time.time() - start
        print(f"[PROGRESS] {done}/{total} done | elapsed={elapsed:.0f}s "
              f"| est_remaining={(elapsed/done)*(total-done):.0f}s", flush=True)
        if dry_run:
            break
    print(f"[DONE] total={total} elapsed={time.time()-start:.0f}s", flush=True)
    embed_new_titles(total, dry_run=dry_run)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--brands", help="Comma-separated brand list, e.g. bonhams,skinner (default: bonhams,skinner)")
    parser.add_argument("--all", action="store_true", help="Ingest every eligible lot")
    parser.add_argument("--limit", type=int, help="Cap the number of rows (for a test run)")
    parser.add_argument("--dry-run", action="store_true", help="Map and print rows, no DB writes")
    args = parser.parse_args()

    if not args.all and not args.limit:
        parser.error("Provide --all or --limit N")

    brands = set(args.brands.split(",")) if args.brands else None
    records = load_records(brands=brands, limit=args.limit)
    print(f"Ingesting {len(records)} lot(s)...", flush=True)
    run(records, dry_run=args.dry_run)
