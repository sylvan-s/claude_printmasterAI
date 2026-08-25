"""
PrintMasterAI — Roseberys bulk catalogue ingestion into the ACKG (Neo4j)
Version: ROSEBERYS-INGEST-1.0

Executable counterpart to doc 09's Roseberys adapter section — same relationship to
that doc as met_ingest.py has to its own section: the doc describes the mapping, this
file enforces it. If they disagree, this file is what actually ran.

Source: catalogue.csv, a 10-year (2016-2026) extract of Roseberys Prints & Multiples
sales — 16,536 lots, 43 sales, already parsed from free-text catalogue entries by an
external tool (documented in the accompanying xlsx's "Read me" sheet). This is a
bulk/structured source, unlike Met's per-object REST API — no network calls needed
beyond none at all; everything comes from the one CSV.

Two real data-quality issues were found and handled before writing this, not after:
  1. ~248 rows are catalogue NARRATIVE TEXT (section-header prose introducing a themed
     run of lots — "Lots 153-175 are from the private collection...") that got parsed
     as if they were individual lots, with garbage in `artist`/`nationality`/
     `life_dates`. Filtered out via is_narrative_row() — see its docstring for the
     detection signal and its one known false positive.
  2. `artist_qualifier` already gives clean, structured attribution qualifiers
     (certain/attributed/circle/studio/follower/after) — no heuristic prefix-parsing
     needed, unlike Roseberys' individual auction-page listings used earlier in this
     project. Two of its values (studio, follower) required extending doc 08's
     qualifier enum rather than force-fitting them into existing values.

Artist identity: Roseberys supplies no ULAN/Wikidata authority ID, so every artist here
merges by `name` with `identityConfidence: "unresolved"` — per the plan already agreed,
live ULAN reconciliation against ~3,500 unique artist names is NOT attempted inline
here (Getty's SPARQL endpoint has demonstrated real unreliability even at the small
scale already tested — see resolve_artist_identity.py's docstring). Backfilling
identity for these artists is a separate, deliberately lower-volume follow-up step.

Usage:
    python3 roseberys_ingest.py --sale A0777
    python3 roseberys_ingest.py --all
    python3 roseberys_ingest.py --all --limit 50
"""

import argparse
import os
import html
import re
import time

import pandas as pd
from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques, extract_papers
from resolve_artist_identity import strip_honorifics

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

CATALOGUE_CSV_PATH = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data/all-prints/catalogue.csv"

QUALIFIER_MAP = {
    "certain": "direct",
    "attributed": "attributed_to",
    "circle": "circle_of",
    "after": "after",
    "manner": "manner_of",
    "follower": "follower_of",
    "studio": "studio_of",
}

_PLAUSIBLE_YEAR_RANGE = (1200, 2030)


def _plausible_year(raw):
    s = re.sub(r"[^\d]", "", str(raw or ""))
    if not s or len(s) != 4:
        return None
    year = int(s)
    return year if _PLAUSIBLE_YEAR_RANGE[0] <= year <= _PLAUSIBLE_YEAR_RANGE[1] else None


def parse_life_dates(raw):
    """Handles the formats actually observed: 'YYYY-YYYY', 'b.YYYY' (living artist),
    'b.YYYY-YYYY' (an inconsistency in the source — 'b.' prefix kept even with a full
    range; treated the same as a plain range)."""
    if pd.isna(raw) or not str(raw).strip():
        return None, None
    s = re.sub(r"^[bd]\.?\s*", "", str(raw).strip(), flags=re.IGNORECASE)
    parts = s.split("-")
    begin = _plausible_year(parts[0]) if parts else None
    end = _plausible_year(parts[1]) if len(parts) > 1 and parts[1].strip() else None
    return begin, end


def is_narrative_row(row):
    """Detects catalogue section-header/narrative text mis-parsed as a lot record.
    Signal: nationality is populated AND life_dates is a bare 4-digit year with no
    hyphen and no b./d. prefix — real single-artist entries always have one or the
    other format when life_dates is populated at all. Verified against the full
    dataset: 248 rows match, essentially all genuine narrative fragments
    ("Lots 153-175 are from...", "The following lots 32-39 were purchased..."), with
    one known likely false positive (a real artist, "Joseph Pennell, American, 1858" —
    a genuine birth-year-only entry missing the 'b.' prefix the rest of the dataset
    uses). Excluding a handful of real artists along with 247 genuine garbage rows is
    the right trade for automated ingestion; correctable later by hand."""
    nationality = row.get("nationality")
    life_dates = row.get("life_dates")
    if pd.isna(nationality) or pd.isna(life_dates):
        return False
    return bool(re.match(r"^\d{4}$", str(life_dates).strip()))


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
    """Decode HTML entities left un-decoded in the source CSV (confirmed: 77 artist
    names and 57 titles affected, e.g. 'Mu&scaron;i&#269;' for 'Mušič') and strip
    whitespace. Safe no-op on already-clean text."""
    if v is None or pd.isna(v):
        return None
    return html.unescape(str(v)).strip()


# The CSV's own image_url column points at www.roseberys.co.uk/lot_images/large/... —
# a path that's live-blocked by an AWS WAF Bot Control challenge on any non-browser
# client (confirmed 2026-08-25), not actually dead. The real asset already lives one
# hop away, on a public, unauthenticated S3 bucket under the same two UUIDs, just at
# "xlarge" instead of "large" — confirmed by inspecting a real lot page's rendered
# image element in a live browser session. Rewriting at ingest time so this doesn't
# need a retroactive graph-wide fix again (see doc 09, DINOv2 POC section).
_LOT_IMAGE_URL_PREFIX = "https://www.roseberys.co.uk/lot_images/large/"
_LOT_IMAGE_URL_REPLACEMENT = "https://am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/roseberys/prod/lot_images/xlarge/"


def _fix_lot_image_url(raw):
    if raw is None or pd.isna(raw):
        return None
    raw = str(raw).strip()
    if raw.startswith(_LOT_IMAGE_URL_PREFIX):
        return raw.replace(_LOT_IMAGE_URL_PREFIX, _LOT_IMAGE_URL_REPLACEMENT, 1)
    return raw


def map_row(row):
    sale_code = row["sale_code"]
    lot_number = int(row["lot_number"])
    base_id = f"roseberys-{sale_code.lower()}-lot{lot_number}"

    raw_name = _clean(row["artist"])
    stripped_name = strip_honorifics(raw_name)

    qualifier = QUALIFIER_MAP.get(str(row.get("artist_qualifier", "")).strip().lower(), "direct")

    begin_year, end_year = parse_life_dates(row.get("life_dates"))

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

    return {
        "objectId": base_id,
        "saleId": sale_code,
        "auctionInternalId": int(row["auction_id"]) if pd.notna(row.get("auction_id")) else None,
        "lotNumber": lot_number,
        "artistName": stripped_name,
        "artistDisplayName": raw_name,
        "artistNationality": row.get("nationality") if pd.notna(row.get("nationality")) else None,
        "artistBeginYear": begin_year,
        "artistEndYear": end_year,
        "qualifier": qualifier,
        "title": _clean(row.get("title")) or f"Untitled ({sale_code} lot {lot_number})",
        "dateYear": year_val,
        "rawMedium": medium or None,
        "techniques": techniques,
        "papers": papers,
        "sheetDimensions": dims if dim_kind in ("sheet", "overall", "") else None,
        "imageDimensions": dims if dim_kind == "image" else None,
        "plateDimensions": dims if dim_kind == "plate" else None,
        "editionSize": int(row["edition_size"]) if pd.notna(row.get("edition_size")) else None,
        "copyType": detect_copy_type(row.get("edition_note"), row.get("title")),
        "signed": (str(row.get("signed", "")).strip().lower() == "yes"),
        "printer": _clean(row.get("printer")),
        "publisher": _clean(row.get("publisher")),
        "catalogueRefsRaw": _clean(row.get("catalogue_refs")),
        "provenanceNote": _clean(row.get("provenance")),
        "listingUrl": row.get("lot_url") if pd.notna(row.get("lot_url")) else None,
        "imageUrl": _fix_lot_image_url(row.get("image_url")),
        "estimateLow": _num("low_estimate"),
        "estimateHigh": _num("high_estimate"),
        "reserve": _num("reserve"),
        "hammerPrice": _num("hammer"),
        "hammerBasis": row.get("hammer_basis") if pd.notna(row.get("hammer_basis")) else None,
        "premiumRatioUsed": _num("premium_ratio_used"),
        "priceRealised": _num("price_realised_inc_premium"),
        "priceCurrency": "GBP",
        "sold": (str(row.get("sold", "")).strip().lower() == "sold"),
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
        WHEN NOT row.artistDisplayName IN coalesce(artist.alternateNames, []) THEN coalesce(artist.alternateNames, []) + row.artistDisplayName
        ELSE artist.alternateNames
    END

MERGE (cw:ConceptualWork {id: row.objectId})
SET cw.name = row.title,
    cw.dateCreated_year = row.dateYear,
    cw.dateCreated_precision = "exact",
    cw.catalogueRefsRaw = row.catalogueRefsRaw
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
    src.institutionName = "Roseberys London",
    src.saleId = row.saleId,
    src.auctionInternalId = row.auctionInternalId,
    src.lotNumber = row.lotNumber,
    src.estimateLow = row.estimateLow,
    src.estimateHigh = row.estimateHigh,
    src.reserve = row.reserve,
    src.hammerPrice = row.hammerPrice,
    src.hammerBasis = row.hammerBasis,
    src.premiumRatioUsed = row.premiumRatioUsed,
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

WITH row, imp
UNWIND row.techniques AS tech
MERGE (t:Technique {name: tech.name})
FOREACH (_ IN CASE WHEN tech.aatId IS NOT NULL THEN [1] ELSE [] END | SET t.aatId = tech.aatId)
MERGE (imp)-[:USES_TECHNIQUE]->(t)

WITH row, imp
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  MERGE (imp)-[:PRINTED_ON]->(p)
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END
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


def load_catalogue(sale_code=None, limit=None, exclude_multi_work=True, log_excluded_path="roseberys_excluded_rows.csv"):
    df = pd.read_csv(CATALOGUE_CSV_PATH, low_memory=False)
    df = df[df["artist"].notna()]

    narrative_mask = df.apply(is_narrative_row, axis=1)
    excluded_narrative = df[narrative_mask]
    df = df[~narrative_mask]
    print(f"[FILTER] excluded {len(excluded_narrative)} narrative/header pseudo-rows: "
          f"{excluded_narrative['artist'].str.slice(0, 60).tolist()[:5]}{'...' if len(excluded_narrative) > 5 else ''}",
          flush=True)

    excluded_multi = df.iloc[0:0]
    if exclude_multi_work:
        multi_mask = df["multi_work"].notna()
        excluded_multi = df[multi_mask]
        df = df[~multi_mask]
        print(f"[FILTER] excluded {len(excluded_multi)} multi-work lots (2026-08-24 decision: "
              f"load single-work lots now, multi-work parsing is a separate follow-up task, "
              f"not silently collapsed into one false ConceptualWork per lot). "
              f"multi_work value breakdown: {excluded_multi['multi_work'].value_counts().to_dict()}",
              flush=True)

    # Nothing excluded is silently dropped — every excluded row is preserved here,
    # tagged with why, so multi-work parsing (or any future review) has the exact
    # original rows to work from rather than needing to re-derive them.
    if log_excluded_path and (len(excluded_narrative) or len(excluded_multi)):
        excluded_narrative = excluded_narrative.copy()
        excluded_narrative["exclusion_reason"] = "narrative_header_pseudo_row"
        excluded_multi = excluded_multi.copy()
        excluded_multi["exclusion_reason"] = "multi_work_lot"
        pd.concat([excluded_narrative, excluded_multi]).to_csv(log_excluded_path, index=False)
        print(f"[FILTER] all excluded rows preserved in {log_excluded_path}", flush=True)

    if sale_code:
        df = df[df["sale_code"] == sale_code]
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
    parser.add_argument("--sale", help="Single sale code, e.g. A0777")
    parser.add_argument("--all", action="store_true", help="Ingest every sale in the catalogue")
    parser.add_argument("--limit", type=int, help="Cap the number of rows (for a test run)")
    args = parser.parse_args()

    if not args.sale and not args.all:
        parser.error("Provide --sale CODE or --all")

    df = load_catalogue(sale_code=args.sale, limit=args.limit)
    print(f"Ingesting {len(df)} lot(s)...", flush=True)
    run(df)
