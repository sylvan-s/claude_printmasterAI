"""
PrintMasterAI — Forum Auctions bulk catalogue ingestion into the ACKG (Neo4j)
Version: FORUM-INGEST-1.0

Same relationship to doc 09 as roseberys_ingest.py: doc 09 describes the mapping, this
file enforces it. Structurally this source is very close to Roseberys' — same bulk-CSV
shape, same artist_qualifier/multi_work/is_print_medium pre-structuring — but three
real differences drove design choices here, found and handled before writing this, not
after:

  1. `sale_code` + `lot_number` is NOT a reliable key — 54 rows collide on it (some are
     genuine distinct lots that share a lot number due to an upstream scraping quirk,
     one is an internal auction-house note ("Picasso Vollard Suite - lower to 7£ if no
     interest agreed 10/12") mis-captured as its own pseudo-row). `lot_url` IS unique
     across all 11,391 rows (verified) and every row's URL ends in a unique numeric
     listing ID, so that numeric suffix is the actual primary key used here.
  2. `catalogue_refs` ("Delteil 2", "Bloch 822", "Corlett III.10") is a new field
     Roseberys' extract never populated — this is the first adapter to instantiate
     doc 08's CatalogueRaisonne/CatalogueEntry types (previously "reasoned about, not
     yet instantiated with a real value" per doc 08 §CatalogueEntry). Parsed as
     "<numbering-system prefix> <entry number>"; a handful of rows carry several
     semicolon-separated refs (e.g. "Lugt 3439; De Vesme 732") and each becomes its own
     CatalogueEntry. Values with no discernible cataloguer name ("Set of 8") don't
     match the parse and are silently skipped rather than mis-parsed.
  3. ~8% of artist names carry life dates (and sometimes a stray "by <name>" fragment)
     baked directly into the name string — "Marc Chagall (1887-1985) ()", "Henri
     Matisse (1869-1954) () by Jacques Villon" — where the separate `life_dates` column
     is often blank for exactly these rows. `_clean_artist_name()` strips parentheticals
     and a trailing "by ..." fragment for the merge key; `_extract_embedded_dates()`
     recovers life dates from that parenthetical as a fallback only when the
     `life_dates` column itself is empty, so a real value there is never overridden by
     a heuristic. This does lose the "by Jacques Villon" detail (a reproducing
     printmaker distinct from the qualifier's plain "after") — a known, accepted
     information loss rather than a wrong extraction; doc 09 §3.2 flags it for future
     revisit if it matters at analysis time.

`nationality` and `price_realised_inc_premium`/`premium_ratio_used` are 100% empty in
this extract (confirmed, not assumed) — left null throughout rather than fabricated
from a ratio Forum's own data doesn't supply. Only hammer price is known.

Artist identity: same policy as Roseberys — no ULAN/Wikidata authority ID supplied, so
every artist merges by (cleaned) name with identityConfidence "unresolved".

**`ConceptualWork` identity keying, corrected 2026-09-06 (doc 09 §7.6/§7.7)**: multiple
lots citing the identical catalogue entry share one `ConceptualWork` instead of each
creating their own — the original bug this replaces let re-sold lots of the identical
print sit as separate `ConceptualWork` nodes forever. The actual key logic (artist +
catalogue + entry + normalized title, `NON_CATALOGUE_NAMES` exclusions) now lives in
`catalogue_matching.py`, shared with `roseberys_ingest.py` — see that module's own
docstring for the two real corruption incidents (a cross-artist catalogue-name
collision, and a portfolio-level citation covering several genuinely different plates)
that make every part of that key strict, not just artist+catalogue+entry as first
shipped. A live backfill of this graph's already-loaded data needed a real repair after
the first, looser version of this fix — re-verify with a live query after ever
extending or re-running this adapter, don't trust a clean exit.

Usage:
    python3 forum_ingest.py --sale 1012
    python3 forum_ingest.py --all
    python3 forum_ingest.py --all --limit 50
"""

import argparse
import os
import html
import re
import time

import pandas as pd
from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques, extract_papers
from catalogue_matching import parse_catalogue_refs, build_conceptual_work_id

def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real AuraDB values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

CATALOGUE_CSV_PATH = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data/forum/catalogue.csv"

QUALIFIER_MAP = {
    "certain": "direct",
    "attributed": "attributed_to",
    "circle": "circle_of",
    "after": "after",
    "follower": "follower_of",
}

_PLAUSIBLE_YEAR_RANGE = (1200, 2030)


def _plausible_year(raw):
    s = re.sub(r"[^\d]", "", str(raw or ""))
    if not s or len(s) != 4:
        return None
    year = int(s)
    return year if _PLAUSIBLE_YEAR_RANGE[0] <= year <= _PLAUSIBLE_YEAR_RANGE[1] else None


def parse_life_dates(raw):
    """Same formats as Roseberys' extract: 'YYYY-YYYY', 'b.YYYY' (living artist). A
    two-person '&'-joined form ("b.1962 & 1966") falls through to (None, None) rather
    than a wrong guess — _plausible_year rejects the concatenated non-4-digit result."""
    if pd.isna(raw) or not str(raw).strip():
        return None, None
    s = re.sub(r"^[bd]\.?\s*", "", str(raw).strip(), flags=re.IGNORECASE)
    parts = s.split("-")
    begin = _plausible_year(parts[0]) if parts else None
    end = _plausible_year(parts[1]) if len(parts) > 1 and parts[1].strip() else None
    return begin, end


COPY_TYPE_KEYWORDS = [
    ("AP", ["artist's proof", "artists proof", " ap ", "'ap'", "inscribed ap"]),
    ("HC", ["hors commerce", " hc ", "'hc'", "inscribed hc"]),
    ("PP", ["printer's proof", "printers proof", " pp "]),
    ("BAT", ["bon", " bat "]),
    ("TP", ["trial proof", " tp "]),
]


def detect_copy_type(edition_note, medium_or_context=""):
    text = f" {(edition_note or '')} {(medium_or_context or '')} ".lower()
    for label, keywords in COPY_TYPE_KEYWORDS:
        if any(kw in text for kw in keywords):
            return label
    return "numbered"


def _clean(v):
    if v is None or pd.isna(v):
        return None
    return html.unescape(str(v)).strip()


# See roseberys_ingest.py's _fix_lot_image_url for the full explanation — same CDN,
# same WAF-blocked-not-dead finding (confirmed 2026-08-25), same fix: the real asset
# lives on a public S3 bucket one hop away, under "forum/prod/..." instead of
# "roseberys/prod/...".
_LOT_IMAGE_URL_PREFIX = "https://www.forumauctions.co.uk/lot_images/large/"
_LOT_IMAGE_URL_REPLACEMENT = "https://am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/forum/prod/lot_images/xlarge/"


def _fix_lot_image_url(raw):
    if raw is None or pd.isna(raw):
        return None
    raw = str(raw).strip()
    if raw.startswith(_LOT_IMAGE_URL_PREFIX):
        return raw.replace(_LOT_IMAGE_URL_PREFIX, _LOT_IMAGE_URL_REPLACEMENT, 1)
    return raw


_PAREN_RE = re.compile(r"\s*\([^)]*\)")
_TRAILING_BY_RE = re.compile(r"\s+by\s+.+$", re.IGNORECASE)
_PAREN_DATES_RE = re.compile(r"\(([^)]*\d{4}[^)]*)\)")
# Matches a lone trailing "." left behind once life-date parens are stripped from
# e.g. "Pablo Picasso (1881-1973) ." — requires whitespace before the period so a
# real abbreviation glued to a letter ("Jr.") is never touched.
_TRAILING_LONE_PERIOD_RE = re.compile(r"\s+\.\s*$")


def _clean_artist_name(raw):
    """Strips embedded life-date/attribution parentheticals — see module docstring
    point 3. 'Henri Matisse (1869-1954) () by Jacques Villon' -> 'Henri Matisse'.
    Confirmed by a real post-ingest check: paren-stripping alone left a dangling
    " ." behind for 542 rows ("Pablo Picasso (1881-1973) ." -> "Pablo Picasso ."),
    fragmenting Picasso/Chagall/Warhol/etc. into a second Artist node — fixed here,
    not patched after the fact, so a re-run produces the correct merge directly."""
    if raw is None:
        return None
    s = _PAREN_RE.sub("", raw)
    s = _TRAILING_BY_RE.sub("", s)
    s = _TRAILING_LONE_PERIOD_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def _extract_embedded_dates(raw):
    """Fallback only — used when the separate life_dates column is empty."""
    if not raw:
        return None
    m = _PAREN_DATES_RE.search(raw)
    return m.group(1) if m else None


_LOT_ID_RE = re.compile(r"-(\d+)$")


def _lot_id_from_url(url):
    """sale_code+lot_number collides 54 times (see module docstring point 1); every
    lot_url is unique and ends in a unique numeric listing ID — verified against the
    full 11,391-row extract, zero collisions."""
    m = _LOT_ID_RE.search(str(url).rstrip("/"))
    return m.group(1) if m else None


# 16 rows, all in sale 4510, have the real title text conflated directly into the
# artist field ("Enea Vico (1523-1567). Pannello ornamentale con trofei...") instead
# of a separate title column — confirmed isolated to these exact rows, not sale-wide
# (the other 110 rows in sale 4510 are cleanly split). Excluded rather than guessed at.
_ARTIST_TITLE_CONFLATED_RE = re.compile(r"\)\.\s+\S")

_SHEET_DIM_KINDS = {"sheet", "overall", "size", "the full sheet", ""}
_PLATE_DIM_KINDS = {"plate", "block"}


def map_row(row):
    lot_id = _lot_id_from_url(row["lot_url"])
    base_id = f"forum-{lot_id}"

    raw_name = _clean(row["artist"])
    clean_name = _clean_artist_name(raw_name)

    qualifier = QUALIFIER_MAP.get(str(row.get("artist_qualifier", "")).strip().lower(), "direct")

    life_dates_raw = row.get("life_dates") if pd.notna(row.get("life_dates")) else _extract_embedded_dates(raw_name)
    begin_year, end_year = parse_life_dates(life_dates_raw)

    medium = row.get("medium") if pd.notna(row.get("medium")) else ""
    support = row.get("support") if pd.notna(row.get("support")) else ""
    techniques = extract_techniques(medium)
    papers = extract_papers(f"{medium} {support}")

    dims = None
    if pd.notna(row.get("width_cm")) and pd.notna(row.get("height_cm")):
        dims = f"{row['width_cm']}x{row['height_cm']}cm"
    dim_kind = str(row.get("dim_kind") or "").strip().lower()

    year_val = _plausible_year(row.get("year")) if pd.notna(row.get("year")) else None

    def _num(field):
        v = row.get(field)
        return float(v) if pd.notna(v) else None

    title = _clean(row.get("title")) or f"Untitled ({row['sale_code']} lot {row.get('lot_number')})"
    catalogue_refs = parse_catalogue_refs(_clean(row.get("catalogue_refs")))
    # Identity keying delegated to catalogue_matching.build_conceptual_work_id() — see
    # that module's own docstring for why artist+catalogue+entry alone is unsafe (two
    # confirmed real corruption incidents during this fix's own backfill: a cross-artist
    # catalogue-name collision, and a portfolio-level citation covering several
    # genuinely different plates) and why the normalized title is part of the key
    # itself, not a post-hoc similarity check.
    conceptual_work_id = build_conceptual_work_id(
        source_prefix="forum",
        artist_name=clean_name,
        title=title,
        catalogue_refs=catalogue_refs,
        fallback_id=base_id,
    )

    return {
        "objectId": base_id,
        "conceptualWorkId": conceptual_work_id,
        "saleId": str(row["sale_code"]),
        "auctionInternalId": int(row["auction_id"]) if pd.notna(row.get("auction_id")) else None,
        "lotNumber": int(row["lot_number"]) if pd.notna(row.get("lot_number")) else None,
        "artistName": clean_name,
        "artistDisplayName": raw_name,
        "artistBeginYear": begin_year,
        "artistEndYear": end_year,
        "qualifier": qualifier,
        "title": title,
        "dateYear": year_val,
        "rawMedium": medium or None,
        "techniques": techniques,
        "papers": papers,
        "sheetDimensions": dims if dim_kind in _SHEET_DIM_KINDS else None,
        "imageDimensions": dims if dim_kind == "image" else None,
        "plateDimensions": dims if dim_kind in _PLATE_DIM_KINDS else None,
        "editionSize": int(row["edition_size"]) if pd.notna(row.get("edition_size")) else None,
        "copyType": detect_copy_type(row.get("edition_note"), row.get("title")),
        "signed": (str(row.get("signed", "")).strip().lower() == "yes"),
        "framed": (str(row.get("framed", "")).strip().lower() == "yes"),
        "printer": _clean(row.get("printer")),
        "publisher": _clean(row.get("publisher")),
        "catalogueRefs": catalogue_refs,
        "provenanceNote": _clean(row.get("provenance")),
        "listingUrl": row.get("lot_url") if pd.notna(row.get("lot_url")) else None,
        "imageUrl": _fix_lot_image_url(row.get("image_url")),
        "estimateLow": _num("low_estimate"),
        "estimateHigh": _num("high_estimate"),
        "reserve": _num("reserve"),
        "hammerPrice": _num("hammer"),
        "hammerBasis": row.get("hammer_basis") if pd.notna(row.get("hammer_basis")) else None,
        "priceCurrency": "GBP",
        "sold": (str(row.get("sold", "")).strip().lower() == "sold"),
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
        WHEN row.artistDisplayName IS NOT NULL AND NOT row.artistDisplayName IN coalesce(artist.alternateNames, [])
        THEN coalesce(artist.alternateNames, []) + row.artistDisplayName
        ELSE artist.alternateNames
    END

// row.conceptualWorkId is shared across multiple lots that cite the same catalogue-
// raisonné entry (see map_row's comment) — coalesce() on every SET so a second lot
// merging into an already-created node doesn't clobber it with its own (equivalent,
// but not necessarily identically-worded) title/date.
MERGE (cw:ConceptualWork {id: row.conceptualWorkId})
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
    imp.framed = row.framed,
    imp.provenanceNote = row.provenanceNote
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "auction",
    src.institutionName = "Forum Auctions",
    src.saleId = row.saleId,
    src.auctionInternalId = row.auctionInternalId,
    src.lotNumber = row.lotNumber,
    src.estimateLow = row.estimateLow,
    src.estimateHigh = row.estimateHigh,
    src.reserve = row.reserve,
    src.hammerPrice = row.hammerPrice,
    src.hammerBasis = row.hammerBasis,
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
UNWIND row.techniques AS tech
MERGE (t:Technique {name: tech.name})
FOREACH (_ IN CASE WHEN tech.aatId IS NOT NULL THEN [1] ELSE [] END | SET t.aatId = tech.aatId)
MERGE (imp)-[:USES_TECHNIQUE]->(t)

WITH row, imp, cw
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  MERGE (imp)-[:PRINTED_ON]->(p)
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END
)

WITH row, cw
UNWIND row.catalogueRefs AS ref
MERGE (cr:CatalogueRaisonne {numberingPrefix: ref.catalogueName})
MERGE (ce:CatalogueEntry {id: ref.catalogueName + "-" + ref.entryNumber})
SET ce.number = ref.entryNumber
MERGE (cr)-[:CONTAINS]->(ce)
MERGE (ce)-[:DOCUMENTS]->(cw)
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


def load_catalogue(sale_code=None, limit=None, exclude_multi_work=True, log_excluded_path="forum_excluded_rows.csv"):
    df = pd.read_csv(CATALOGUE_CSV_PATH, low_memory=False)

    title_mask = df["title"].isna()
    excluded_no_title = df[title_mask]
    df = df[~title_mask]
    print(f"[FILTER] excluded {len(excluded_no_title)} rows with no title (blank/junk pseudo-rows "
          f"and internal auction-house notes mis-captured as lots — see module docstring)", flush=True)

    conflated_mask = df["artist"].astype(str).str.contains(_ARTIST_TITLE_CONFLATED_RE, na=False)
    excluded_conflated = df[conflated_mask]
    df = df[~conflated_mask]
    print(f"[FILTER] excluded {len(excluded_conflated)} rows with title text conflated into the "
          f"artist field (isolated to sale 4510 — see module docstring)", flush=True)

    print_mask = df["is_print_medium"] != "yes"
    excluded_non_print = df[print_mask]
    df = df[~print_mask]
    print(f"[FILTER] excluded {len(excluded_non_print)} non-print-medium lots (sculpture, drawing, "
          f"gouache, etc. — this graph scopes to prints)", flush=True)

    excluded_multi = df.iloc[0:0]
    if exclude_multi_work:
        multi_mask = df["multi_work"].notna()
        excluded_multi = df[multi_mask]
        df = df[~multi_mask]
        print(f"[FILTER] excluded {len(excluded_multi)} multi-work lots (same policy as Roseberys: "
              f"load single-work lots now, multi-work parsing is a separate follow-up task). "
              f"multi_work value breakdown: {excluded_multi['multi_work'].value_counts().to_dict()}",
              flush=True)

    if log_excluded_path and (len(excluded_no_title) or len(excluded_conflated) or len(excluded_non_print) or len(excluded_multi)):
        excluded_no_title = excluded_no_title.copy()
        excluded_no_title["exclusion_reason"] = "no_title"
        excluded_conflated = excluded_conflated.copy()
        excluded_conflated["exclusion_reason"] = "artist_title_conflated"
        excluded_non_print = excluded_non_print.copy()
        excluded_non_print["exclusion_reason"] = "non_print_medium"
        excluded_multi = excluded_multi.copy()
        excluded_multi["exclusion_reason"] = "multi_work_lot"
        pd.concat([excluded_no_title, excluded_conflated, excluded_non_print, excluded_multi]).to_csv(log_excluded_path, index=False)
        print(f"[FILTER] all excluded rows preserved in {log_excluded_path}", flush=True)

    if sale_code:
        df = df[df["sale_code"].astype(str) == str(sale_code)]
    if limit:
        df = df.head(limit)
    return df


def run(df, chunk_size=200):
    total = len(df)
    start = time.time()
    records = df.to_dict("records")
    for chunk_start in range(0, total, chunk_size):
        chunk = records[chunk_start:chunk_start + chunk_size]
        rows = [map_row(r) for r in chunk]
        _write_chunk_with_retry(rows)
        done = chunk_start + len(chunk)
        elapsed = time.time() - start
        print(f"[PROGRESS] {done}/{total} done | elapsed={elapsed:.0f}s "
              f"| est_remaining={(elapsed/done)*(total-done):.0f}s", flush=True)
    print(f"[DONE] total={total} elapsed={time.time()-start:.0f}s", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sale", help="Single sale code, e.g. 1012")
    parser.add_argument("--all", action="store_true", help="Ingest every sale in the catalogue")
    parser.add_argument("--limit", type=int, help="Cap the number of rows (for a test run)")
    args = parser.parse_args()

    if not args.sale and not args.all:
        parser.error("Provide --sale CODE or --all")

    df = load_catalogue(sale_code=args.sale, limit=args.limit)
    print(f"Ingesting {len(df)} lot(s)...", flush=True)
    run(df)
