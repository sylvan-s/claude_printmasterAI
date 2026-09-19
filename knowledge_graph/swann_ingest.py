"""
PrintMasterAI — Swann Auction Galleries bulk catalogue ingestion into the ACKG (Neo4j)
Version: SWANN-INGEST-1.1

Executable counterpart to doc 09's Swann adapter section, same relationship as every
other adapter in this project: the doc describes the mapping, this file enforces it.

Source: benchmark/data/swann/catalogue.json — 16,336 lots across 35 sales (2016-09-21 to
2026-04-15), pulled by benchmark/src/swann/pull.ts from Swann's own public
getAlgoliaResults endpoint (no login, no robots.txt restriction — see that tool's
docstring). Filtered at pull time to sale titles/departments matching the word-bounded
`\\bprints?\\b` (catches "Old Master Through Modern Prints" and "19th & 20th Century
Prints & Drawings", not Swann's unrelated "Printed & Manuscript Americana" book
department — see pull.ts's own fixed bug for why the plain substring match was wrong).

Like Bonhams, not like Roseberys/Forum: no pre-parsed artist/title columns at all.
`lotTitle` bundles artist name and work title in one string, and — confirmed by direct
inspection, not assumed from a docs promise — the source's own `artistName` field
(genuinely requestable from the underlying Algolia index; see benchmark/src/swann/api.ts)
is empty on all 16,336 rows of this pull, at every era, not just on older sales as first
guessed. All of artist/title/qualifier/year/catalogue-ref/technique/paper/
signed/edition/printer/publisher/dimensions extraction is done here via `swann_parsing.py`
(new) plus reused text-heuristics from `bonhams_parsing.py` (see below) — HEURISTIC_
EXTRACTION per doc 09 §1, verified against real sampled records and the full 16,336-row
corpus's aggregate match rates (see swann_parsing.py's own docstring), not a verified
crosswalk.

Four real data-quality issues, found and handled before writing this, not after:

  1. **Inconsistent name/title punctuation across sales.** Some catalogues comma-separate
     the name's dates-parenthetical from the title ("Dürer (1471-1528), The Holy
     Family..."), some don't ("Dürer (1471-1528) Jan Uytenbogaert..." — same Rembrandt
     work, two different sale catalogues), and a large minority carry no parenthetical at
     all — just an ALL-CAPS name run directly followed by a mixed-case title
     ("MILTON AVERY Flight."). `swann_parsing.extract_artist_and_title()` handles all
     three; see its own docstring for the specific before/after fixes this took (a first,
     more naive version of it inflated "unmatched-to-ACKG" artist-name analysis 5x by
     fragmenting single artists into dozens of near-duplicate strings, caught before this
     script existed).
  2. **`normalize_all_caps_name()` is needed here too, not just for Bonhams** — Swann has
     the identical ALL-CAPS/mixed-case duplication risk Bonhams had (confirmed: this pull
     alone would otherwise create "REMBRANDT VAN RIJN" as a fresh Artist node alongside
     ACKG's existing "Rembrandt van Rijn" — 1,184 lots' worth). Reused directly from
     bonhams_parsing.py rather than re-implemented — it is a generic name-casing
     normalizer, not actually Bonhams-specific despite living in that module.
  3. **Catalogue-raisonné citation text is USUALLY but not always the last sentence** of
     `lotDescription` — a real minority of records append a provenance/condition sentence
     AFTER the citation ("... Bartsch 44; Meder 42. Property from the Eric Carlson
     Irrevocable Trust."). `swann_parsing.extract_catalogue_ref_text()` scans backward
     through the last few sentences rather than assuming the citation is always exactly
     last — see its own docstring for the measured junk-rate this fixed (naive last-
     sentence-only: ~36% of extracted "catalogue names" were provenance-sentence garbage;
     after the fix, ~0%, at the cost of dropping to 71.0% recall on genuine citations —
     the majority of the remainder are lots with no formal catalogue-raisonné reference
     at all, not a parsing miss).
  4. **No pre-supplied multi-work column** (same situation Bonhams was in) —
     `swann_parsing.detect_multi_work()` is a from-scratch heuristic (leading count
     phrase in the title — "Two color lithographs.", "Group of 6 Portrait Prints." —
     and roman-numeral item enumeration inside the description — "(i) ... (ii) ..." —
     confirmed real, a Hans Neumann "Two color woodcuts" lot literally itemizes two
     distinct prints this way). Same policy as every other adapter once flagged:
     excluded from this load, not mismodeled, preserved in the excluded-rows CSV.

**Non-print-medium filter reused as-is** (same convention as Bonhams/BM/Tate — see
bonhams_ingest.py's own docstring point 7): a record whose `lotDescription` yields zero
recognized printmaking technique via `crosswalk_matching.extract_techniques()` is
excluded. This is also what resolves a real scope question raised while building the
pull: Swann's "Prints & Drawings" department genuinely includes two sales titled "Master
Drawings"/"Old Master Drawings" (unique works, not editions) alongside the print sales —
486 lots. No special-casing was needed for them; they simply carry no recognized print
technique and fall out through this same filter, logged as `non_print_medium` like every
other genuinely non-print lot this adapter excludes.

**Currency**: Swann's own export is USD-native on every row of this pull (confirmed:
100% `currencyCode: "USD"`, unlike Bonhams' genuinely multi-currency export) — but
`priceCurrency` is still set from the row's own `currencyCode` field, not hardcoded,
should a future pull ever include a non-US sale. No GBP figure is written by this
adapter, same reasoning as `bonhams_ingest.py` docstring item 4: `backfill_fx_gbp.py`
derives every GBP form at the ECB sale-date rate, and it is already institution-agnostic
(matches every `SourceRecord {sourceType:'auction'}` in the graph, confirmed by reading
it before writing this) — no change needed there for this source to be picked up.

**No separate hammer price.** Unlike Bonhams/Roseberys, this source's Algolia index
exposes only one post-sale price field (`priceResult`, confirmed premium-inclusive by
comparison against Swann's own live "Sold for $X" lot-page text) — no distinct pre-
premium hammer figure. `hammerPrice` is therefore left UNMAPPED (doc 09 §1) rather than
guessed or set equal to `priceRealised`, which would misrepresent it as the same kind of
figure Bonhams'/Roseberys' `hammerPrice` field actually is.

Artist identity: same policy as Bonhams/Roseberys/Forum — no ULAN/Wikidata supplied,
merges by (cleaned, honorific-stripped, ALL-CAPS-normalized) name with
identityConfidence "unresolved". `ConceptualWork` identity keying delegated entirely to
the shared `catalogue_matching.py` (also used by roseberys_ingest.py/bonhams_ingest.py/
forum_ingest.py) — same artist+catalogue+entry+exact-normalized-title key, same
NON_CATALOGUE_NAMES guard, same no-fuzzy-matching rule.

Usage:
    python3 swann_ingest.py --limit 50 --dry-run     # sanity-check mapping, no DB writes
    python3 swann_ingest.py --all                     # full 16,336-row load
"""

import argparse
import csv
import json
import os
import re
import time

from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques, extract_papers
from resolve_artist_identity import strip_honorifics
from catalogue_matching import parse_catalogue_refs, genuine_refs, build_conceptual_work_id, sanitize_id_part, resolve_merged_work_cypher
from bonhams_parsing import (
    normalize_all_caps_name, detect_signed, extract_edition_size,
    extract_printer_publisher, extract_dimensions,
)
from swann_parsing import (
    extract_artist_and_title, extract_year_from_description,
    extract_catalogue_ref_text, detect_multi_work,
)
from embed_titles_hook import embed_new_titles
from copy_type import detect_copy_type


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

SWANN_JSON_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "benchmark", "data", "swann", "catalogue.json"
)

INSTITUTION_NAME = "Swann Auction Galleries"

# Placeholder/non-individual "artist" values a from-scratch extractor can plausibly
# produce, same reasoning as bonhams_ingest.py's PLACEHOLDER_ARTIST_NAMES /
# tate_ingest.py's "Anonymous" handling — merging these as if they were one real
# identity would fabricate a false shared attribution across unrelated lots. Includes
# Swann's own attribution-qualifier PREFIX words (a name of just "After"/"Attributed
# To"/etc. means extract_artist_and_title() found a qualifier but no real name after
# it — a genuinely different lot shape from the qualifier+real-name case this adapter
# does handle, e.g. "Albrecht Dürer (After)," where the artist name is fine and only the
# qualifier came from the parenthetical) and Swann's "X School"/collective-lot phrasing.
PLACEHOLDER_ARTIST_RE = re.compile(
    r"^(after|attributed to|attr\.?( to)?|circle of|manner of|in the manner of|"
    r"school of|follower of|studio of|workshop of|various artists?|unknown( artist)?|"
    r"artist unknown|anonymous|a group|a collection|a set|a pair|group of|lot of|"
    r"collection of|\S+ school)\b",
    re.IGNORECASE,
)



def resolve_artist_fields(lot_title):
    """The ONE artist-name assembly chain for this adapter, same discipline
    resolve_artist_fields() establishes in bonhams_ingest.py: map_record() maps with it
    and load_records() filters with it, so the two can never diverge. Returns
    (qualifier, displayName, cleanedName, beginYear, endYear, title, titleYear).
    `cleanedName` is "" when the source value cleans away to nothing, which the caller
    MUST treat as unusable rather than pass to the `MERGE (artist:Artist {name: ...})`
    key."""
    parsed = extract_artist_and_title(lot_title)
    display_name = (parsed["artistName"] or "").strip()
    cleaned = strip_honorifics(normalize_all_caps_name(display_name))
    return (
        parsed["qualifier"], display_name, (cleaned or "").strip(),
        parsed["artistBeginYear"], parsed["artistEndYear"],
        parsed["title"], parsed["titleYear"],
    )


def map_record(record):
    lot_ref = record["lotRef"]
    base_id = f"swann-{sanitize_id_part(lot_ref).lower()}"

    qualifier, display_name, stripped_name, begin_year, end_year, title, title_year = (
        resolve_artist_fields(record["lotTitle"])
    )

    desc = record.get("lotDescription") or ""
    techniques = extract_techniques(desc)
    papers = extract_papers(desc)
    dims = extract_dimensions(desc)
    signed = detect_signed(desc)
    edition_size = extract_edition_size(desc)
    printer, publisher = extract_printer_publisher(desc)
    copy_type = detect_copy_type(desc)

    year_val = extract_year_from_description(desc, stripped_name) or title_year

    title = title or f"Untitled ({base_id})"
    ref_text = extract_catalogue_ref_text(desc, genuine_refs, parse_catalogue_refs)
    catalogue_refs = genuine_refs(parse_catalogue_refs(ref_text)) if ref_text else []

    conceptual_work_id = build_conceptual_work_id(
        source_prefix="swann",
        artist_name=stripped_name,
        title=title,
        catalogue_refs=catalogue_refs,
        fallback_id=base_id,
    )

    try:
        lot_number = int(record["lotNumber"])
    except (TypeError, ValueError):
        lot_number = None

    return {
        "objectId": base_id,
        "conceptualWorkId": conceptual_work_id,
        "institutionName": INSTITUTION_NAME,
        "saleId": str(record["saleNumber"]) if record.get("saleNumber") is not None else record.get("saleCatalogRef"),
        "lotNumber": lot_number,
        "saleDate": record.get("saleDate"),
        "artistName": stripped_name,
        "artistDisplayName": display_name,
        "artistBeginYear": begin_year,
        "artistEndYear": end_year,
        "qualifier": qualifier,
        "title": title,
        "dateYear": year_val,
        "rawMedium": desc or None,
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
        "listingUrl": record.get("lotUrl"),
        "imageUrl": record.get("photoUrl"),
        "estimateLow": record.get("estimateLow"),
        "estimateHigh": record.get("estimateHigh"),
        # No hammerPrice — see module docstring. priceRealised = priceResult, already
        # premium-inclusive (confirmed against Swann's own live lot-page "Sold for $X").
        "priceRealised": record.get("priceResult") if record.get("sold") else None,
        "priceCurrency": record.get("currencyCode"),
        "sold": bool(record.get("sold")),
        "closed": bool(record.get("closed")),
    }


LOAD_QUERY = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.dateBorn_year = coalesce(row.artistBeginYear, artist.dateBorn_year),
    artist.dateBorn_precision = CASE WHEN row.artistBeginYear IS NOT NULL THEN "exact" ELSE artist.dateBorn_precision END,
    artist.dateDied_year = coalesce(row.artistEndYear, artist.dateDied_year),
    artist.dateDied_precision = CASE WHEN row.artistEndYear IS NOT NULL THEN "exact" ELSE artist.dateDied_precision END,
    artist.identityConfidence = coalesce(artist.identityConfidence, "unresolved"),
    artist.alternateNames = CASE
        WHEN row.artistDisplayName IS NOT NULL AND row.artistDisplayName <> row.artistName
             AND NOT row.artistDisplayName IN coalesce(artist.alternateNames, [])
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
    imp.signed = row.signed
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "auction",
    src.institutionName = row.institutionName,
    src.saleId = row.saleId,
    src.lotNumber = row.lotNumber,
    src.saleDate = row.saleDate,
    src.estimateLow = row.estimateLow,
    src.estimateHigh = row.estimateHigh,
    src.priceRealised = row.priceRealised,
    src.priceCurrency = row.priceCurrency,
    src.sold = row.sold,
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


def load_records(limit=None, exclude_multi_work=True, json_path=None,
                  log_excluded_path="swann_excluded_rows.csv"):
    with open(json_path or SWANN_JSON_PATH) as fh:
        all_records = json.load(fh)

    excluded = []
    kept = []
    for r in all_records:
        qualifier, display_name, stripped_name, *_rest = resolve_artist_fields(r["lotTitle"])
        if not stripped_name:
            excluded.append((r, "artist_name_empty_after_cleaning"))
            continue
        if PLACEHOLDER_ARTIST_RE.match(stripped_name):
            excluded.append((r, "placeholder_or_qualifier_only_artist_name"))
            continue
        kept.append(r)

    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'artist_name_empty_after_cleaning')} "
          f"rows whose artist name cleans away to an empty string", flush=True)
    print(f"[FILTER] excluded {sum(1 for _, reason in excluded if reason == 'placeholder_or_qualifier_only_artist_name')} "
          f"rows with a placeholder/qualifier-only/collective-lot artist value "
          f"(see PLACEHOLDER_ARTIST_RE)", flush=True)

    if exclude_multi_work:
        still_kept = []
        multi_count = 0
        for r in kept:
            title = extract_artist_and_title(r["lotTitle"])["title"]
            is_multi, reason = detect_multi_work(title, r.get("lotDescription"))
            if is_multi:
                excluded.append((r, f"multi_work:{reason}"))
                multi_count += 1
            else:
                still_kept.append(r)
        kept = still_kept
        print(f"[FILTER] excluded {multi_count} multi-work lots (heuristic detection — no "
              f"pre-supplied column for this source, see swann_parsing.detect_multi_work)",
              flush=True)

    non_print = []
    print_kept = []
    for r in kept:
        if extract_techniques(r.get("lotDescription") or ""):
            print_kept.append(r)
        else:
            non_print.append(r)
            excluded.append((r, "non_print_medium"))
    kept = print_kept
    print(f"[FILTER] excluded {len(non_print)} non-print-medium lots (this includes the two "
          f"'Master Drawings'/'Old Master Drawings' sales' 486 lots — unique drawings, not "
          f"editioned prints; see module docstring)", flush=True)

    if log_excluded_path and excluded:
        with open(log_excluded_path, "w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["lotRef", "saleNumber", "lotTitle", "exclusion_reason"])
            for r, reason in excluded:
                writer.writerow([r.get("lotRef"), r.get("saleNumber"), r.get("lotTitle"), reason])
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
    parser.add_argument("--all", action="store_true", help="Ingest every eligible lot")
    parser.add_argument("--limit", type=int, help="Cap the number of rows (for a test run)")
    parser.add_argument("--dry-run", action="store_true", help="Map and print rows, no DB writes")
    args = parser.parse_args()

    if not args.all and not args.limit:
        parser.error("Provide --all or --limit N")

    records = load_records(limit=args.limit)
    print(f"Ingesting {len(records)} lot(s)...", flush=True)
    run(records, dry_run=args.dry_run)
