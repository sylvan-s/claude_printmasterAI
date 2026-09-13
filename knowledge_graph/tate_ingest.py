"""
PrintMasterAI — Tate Collection bulk ingestion into the ACKG (Neo4j)
Version: TATE-INGEST-1.0

Institutional-layer adapter, same relationship to doc 09 as met_ingest.py: doc 09
describes the mapping, this file enforces it.

Source: tategallery/collection on GitHub (CC0, images not included but a real
thumbnail URL per row is) — artwork_data.csv (69,201 rows) + artist_data.csv (3,532
artists). NOT actively maintained since October 2014 (confirmed via the repo's own
README, not assumed) — this is a frozen decade-old snapshot, same category of
limitation as the Met's own point-in-time CSV extract, not a live feed.
    wget https://raw.githubusercontent.com/tategallery/collection/master/artwork_data.csv
    wget https://raw.githubusercontent.com/tategallery/collection/master/artist_data.csv

Unlike Forum/Roseberys, this source is genuinely simple: `id` and `accession_number`
are both confirmed unique across all 69,201 rows — one row is one artwork with one
(artist, role) pair, no multi-constituent parsing needed. Three real adaptations
were required, found and handled before writing this, not after:

  1. No classification flag. Met has `Classification` containing "Print"; Tate's
     `medium` is free text only ("Etching and aquatint on paper"). Filtered using
     the SAME extract_techniques() crosswalk every other adapter already uses — no
     new vocabulary, and the result (12,473 of 69,201 rows) is a similar scale to
     the Met ingest. This does mean coverage depends on the existing technique
     keyword list; a genuinely novel print technique with no keyword match would
     be silently excluded, not misclassified — an accepted limitation of the same
     shape doc 09 already documents for HEURISTIC_EXTRACTION mappings.
  2. Artist names are "Surname, Firstname" ("Blake, Robert") — the opposite
     convention from every other source in this graph. Reversed via
     _parse_tate_artist_name() before merging, or this source would silently
     fragment every artist already in the graph under a second, differently-
     formatted node. 65 of 3,532 artists have no comma (single names — "Matta",
     "Absalon", and a literal "Anonymous" placeholder, which is excluded rather
     than merged as if it were a real person).
  3. `artistRole` needed reconciling against the existing qualifier vocabulary
     (QUALIFIER_MAP below). One value is deliberately NOT mapped and excluded
     outright: "formerly attributed to" (14 rows) — this means Tate itself no
     longer holds this attribution, so ingesting it as a live attribution would
     insert a fact the source institution has already disavowed. Three more
     tiny, structurally ambiguous roles ("and other artists", "and a pupil", "and
     assistants" — 19 rows combined) name no specific second party and are
     excluded rather than guessed at.

Tate's institutional-layer position in the ACKG per doc 09/ADR-0003: strong for
British and Western artists generally, but this is still one Western institution's
holdings — it does not close the non-Western coverage gap already documented for
Met/ULAN (Japan ~1.3% of ULAN records), since Tate's own collection has the same
skew.

Artist identity: no ULAN/Wikidata ID in this source (confirmed — artist_data.csv
has no such column), so every artist merges by (reversed, cleaned) name with
identityConfidence "unresolved", same policy as Roseberys/Forum.

Usage:
    python3 tate_ingest.py --all
    python3 tate_ingest.py --all --limit 50
    python3 tate_ingest.py --accession-numbers A00005,N01234
"""

import argparse
import os
import re
import time

import pandas as pd
from neo4j import GraphDatabase

from catalogue_matching import resolve_merged_work_cypher
from crosswalk_matching import extract_techniques, extract_papers
from embed_titles_hook import embed_new_titles


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

ARTWORK_CSV_PATH = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data/tate/artwork_data.csv"
ARTIST_CSV_PATH = "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/benchmark/data/tate/artist_data.csv"

QUALIFIER_MAP = {
    "artist": "direct",
    "after": "after",
    "prints after": "after",
    "attributed to": "attributed_to",
    "manner of": "manner_of",
    "imitator of": "manner_of",
    "pseudo": "manner_of",
    "pupil of": "follower_of",
    "follower of": "follower_of",
    "studio of": "studio_of",
    "school of": "circle_of",
}
# Deliberately excluded, not mapped — see module docstring point 3.
EXCLUDED_ROLES = {"formerly attributed to", "and other artists", "and a pupil", "and assistants"}

# Generic period/nationality attribution placeholders ("British (?) School", "British
# School 18th century") — not an individually-attributable artist, so can never be the
# answer to "who made this." Confirmed 159 such rows in the full print-qualifying set
# (154 "British (?) School" + 4/1 "British School Nth century"); excluded rather than
# merged as if a real person, same discipline as excluding the literal "Anonymous"
# placeholder in _parse_tate_artist_name (though "Anonymous" itself never actually
# occurs in this CSV — confirmed by direct check, zero rows).
_GENERIC_SCHOOL_RE = re.compile(r"^[A-Za-z]+(?:\s*\(\?\))?\s+School(?:\s+\d+\w*\s+century)?$", re.IGNORECASE)

# Deliberately excluded per an explicit ingestion-priority decision (not a data-quality
# issue) — see doc 09 §4.2 "Known deliberate exclusion — J.M.W. Turner" for the full
# writeup. Summary: Turner's 908 loaded Tate works were 100% institutional/Tate with
# zero auction-history presence — his own source-layer was fully saturated, so each
# further row was low marginal value against AuraDB Free's 200,000-node ceiling versus
# ~566 rows for other artists with zero existing coverage of any kind. The 908 already-
# loaded records were pruned from the graph entirely (2026-08-25), not just blocked from
# further growth — freed 4,539 nodes. Revisit once AuraDB headroom stops being the
# binding constraint, or if a future need specifically requires Turner population data.
_DEPRIORITIZED_ARTISTS_RAW = {"Turner, Joseph Mallord William"}

_PLAUSIBLE_YEAR_RANGE = (1200, 2030)


def _plausible_year(raw):
    if pd.isna(raw):
        return None
    s = re.sub(r"[^\d]", "", str(raw))
    if not s or len(s) not in (4,):
        return None
    year = int(s)
    return year if _PLAUSIBLE_YEAR_RANGE[0] <= year <= _PLAUSIBLE_YEAR_RANGE[1] else None


def _parse_tate_artist_name(raw):
    """'Blake, Robert' -> 'Robert Blake'. Single names ('Matta') pass through
    unchanged. 'Anonymous' returns None — see module docstring point 2."""
    if pd.isna(raw):
        return None
    raw = str(raw).strip()
    if not raw or raw.lower() == "anonymous":
        return None
    if "," not in raw:
        return raw
    surname, _, rest = raw.partition(",")
    name = f"{rest.strip()} {surname.strip()}".strip()
    return name or None


# Dimension-kind prefixes observed in the `dimensions` free-text column (e.g.
# "support: 394 x 419 mm"). "frame" and "duration" are deliberately excluded —
# a framed measurement overstates the actual sheet, and duration is time-based
# (irrelevant to a print). Everything else maps onto the same sheet/image bucket
# convention the other three adapters already use.
_SHEET_DIM_PREFIXES = {"support", "object", "unconfirmed", "displayed", "support, each",
                        "object, each", "support & image", "unconfirmed, each", "support, secondary"}
_IMAGE_DIM_PREFIXES = {"image", "image, each"}


def _dimension_kind(raw_dimensions):
    if pd.isna(raw_dimensions) or ":" not in str(raw_dimensions):
        return None
    return str(raw_dimensions).split(":")[0].strip().lower()


def load_artists():
    """Returns a dict keyed by Tate's numeric artist id -> {beginYear, endYear}."""
    df = pd.read_csv(ARTIST_CSV_PATH, low_memory=False)
    out = {}
    for r in df.to_dict("records"):
        out[r["id"]] = {
            "beginYear": _plausible_year(r.get("yearOfBirth")),
            "endYear": _plausible_year(r.get("yearOfDeath")),
        }
    return out


def map_row(row, artists_by_id):
    accession = str(row["accession_number"]).strip()
    object_id = f"tate-{accession}"

    raw_name = row.get("artist")
    artist_name = _parse_tate_artist_name(raw_name)

    role = str(row.get("artistRole", "")).strip().lower()
    qualifier = QUALIFIER_MAP.get(role, "direct")

    artist_meta = artists_by_id.get(row.get("artistId"), {})

    medium = row.get("medium") if pd.notna(row.get("medium")) else ""
    techniques = extract_techniques(medium)
    papers = extract_papers(medium)

    width, height, units = row.get("width"), row.get("height"), row.get("units")
    dims = None
    if pd.notna(width) and pd.notna(height):
        unit_label = units if pd.notna(units) else "mm"
        dims = f"{width}x{height}{unit_label}"
    dim_kind = _dimension_kind(row.get("dimensions"))

    year_val = _plausible_year(row.get("year"))

    return {
        "objectId": object_id,
        "accessionNumber": accession,
        "artistName": artist_name,
        "artistDisplayName": str(raw_name).strip() if pd.notna(raw_name) else None,
        "artistBeginYear": artist_meta.get("beginYear"),
        "artistEndYear": artist_meta.get("endYear"),
        "qualifier": qualifier,
        "title": row.get("title") if pd.notna(row.get("title")) else f"Untitled (Tate {accession})",
        "dateYear": year_val,
        "rawMedium": medium or None,
        "techniques": techniques,
        "papers": papers,
        "sheetDimensions": dims if dim_kind in _SHEET_DIM_PREFIXES else None,
        "imageDimensions": dims if dim_kind in _IMAGE_DIM_PREFIXES else None,
        "provenanceNote": row.get("creditLine") if pd.notna(row.get("creditLine")) else None,
        "listingUrl": row.get("url") if pd.notna(row.get("url")) else None,
        "imageUrl": row.get("thumbnailUrl") if pd.notna(row.get("thumbnailUrl")) else None,
    }


LOAD_QUERY = """
UNWIND $rows AS row

WITH row
CALL {
  WITH row
  UNWIND (CASE WHEN row.artistName IS NULL THEN [] ELSE [row.artistName] END) AS name
  MERGE (a:Artist {name: name})
  SET a.dateBorn_year = coalesce(row.artistBeginYear, a.dateBorn_year),
      a.dateBorn_precision = CASE WHEN row.artistBeginYear IS NOT NULL THEN "exact" ELSE a.dateBorn_precision END,
      a.dateDied_year = coalesce(row.artistEndYear, a.dateDied_year),
      a.dateDied_precision = CASE WHEN row.artistEndYear IS NOT NULL THEN "exact" ELSE a.dateDied_precision END,
      a.identityConfidence = coalesce(a.identityConfidence, "unresolved"),
      a.alternateNames = CASE
          WHEN row.artistDisplayName IS NOT NULL AND NOT row.artistDisplayName IN coalesce(a.alternateNames, [])
          THEN coalesce(a.alternateNames, []) + row.artistDisplayName
          ELSE a.alternateNames
      END
  RETURN count(*) AS artistWritten
}

""" + resolve_merged_work_cypher("row.objectId", ["row"]) + """
SET cw.name = row.title,
    cw.dateCreated_year = row.dateYear,
    cw.dateCreated_precision = "exact"

WITH row, cw
CALL {
  WITH row, cw
  UNWIND (CASE WHEN row.artistName IS NULL THEN [] ELSE [row.artistName] END) AS name
  MATCH (a:Artist {name: name})
  MERGE (a)-[:CREATED]->(cw)
  RETURN count(*) AS createdWritten
}

MERGE (er:EditionRun {id: row.objectId + "-er"})
SET er.dateRange_year = row.dateYear, er.dateRange_precision = "exact"
MERGE (cw)-[:PRINTED_AS]->(er)

MERGE (imp:Impression {id: row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.imageDimensions = row.imageDimensions,
    imp.rawMedium = row.rawMedium,
    imp.provenanceNote = row.provenanceNote
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "institutional",
    src.institutionName = "Tate",
    src.accessionNumber = row.accessionNumber,
    src.listingUrl = row.listingUrl
MERGE (src)-[:DOCUMENTS]->(imp)

WITH row, cw, src, imp
CALL {
  WITH row, src
  UNWIND (CASE WHEN row.artistName IS NULL THEN [] ELSE [row.artistName] END) AS name
  MATCH (a:Artist {name: name})
  MERGE (src)-[att:ATTRIBUTED_TO]->(a)
  SET att.qualifier = row.qualifier
  RETURN count(*) AS attWritten
}

// DigitalImage creation deliberately removed (2026-08-25) — see doc 09 §4.2 "Known
// deliberate exclusion — dead thumbnailUrl values". The tategallery/collection CSV's
// thumbnailUrl values are all confirmed dead (Tate has since restructured its site),
// so every DigitalImage node this used to create pointed nowhere. A future correct
// re-fetch would key off SourceRecord.accessionNumber (already stored, unaffected by
// this change), not off this dead URL, so nothing is lost by not materializing it.

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


def load_catalogue(limit=None, accession_numbers=None):
    df = pd.read_csv(ARTWORK_CSV_PATH, low_memory=False)

    excluded_role_mask = df["artistRole"].astype(str).str.strip().str.lower().isin(EXCLUDED_ROLES)
    excluded_roles = df[excluded_role_mask]
    df = df[~excluded_role_mask]
    print(f"[FILTER] excluded {len(excluded_roles)} rows with a disavowed/ambiguous attribution role "
          f"(e.g. 'formerly attributed to') — see module docstring point 3. "
          f"breakdown: {excluded_roles['artistRole'].value_counts().to_dict()}", flush=True)

    def has_print_technique(medium):
        return len(extract_techniques(medium)) > 0 if pd.notna(medium) else False

    print_mask = df["medium"].apply(has_print_technique)
    excluded_non_print = df[~print_mask]
    df = df[print_mask]
    print(f"[FILTER] excluded {len(excluded_non_print)} non-print-medium works "
          f"(paintings, sculpture, drawings, etc. — this graph scopes to prints)", flush=True)

    school_mask = df["artist"].astype(str).str.match(_GENERIC_SCHOOL_RE)
    excluded_school = df[school_mask]
    df = df[~school_mask]
    print(f"[FILTER] excluded {len(excluded_school)} generic period/nationality attribution "
          f"placeholders (e.g. 'British (?) School') — not an individually-attributable artist. "
          f"breakdown: {excluded_school['artist'].value_counts().to_dict()}", flush=True)

    deprioritized_mask = df["artist"].isin(_DEPRIORITIZED_ARTISTS_RAW)
    excluded_deprioritized = df[deprioritized_mask]
    df = df[~deprioritized_mask]
    print(f"[FILTER] excluded {len(excluded_deprioritized)} rows for deprioritized artists "
          f"(source-layer already saturated — see _DEPRIORITIZED_ARTISTS_RAW comment)", flush=True)

    if accession_numbers:
        df = df[df["accession_number"].isin(accession_numbers)]
    if limit:
        df = df.head(limit)
    return df


def run(df, artists_by_id, chunk_size=200):
    total = len(df)
    start = time.time()
    records = df.to_dict("records")
    for chunk_start in range(0, total, chunk_size):
        chunk = records[chunk_start:chunk_start + chunk_size]
        rows = [map_row(r, artists_by_id) for r in chunk]
        _write_chunk_with_retry(rows)
        done = chunk_start + len(chunk)
        elapsed = time.time() - start
        print(f"[PROGRESS] {done}/{total} done | elapsed={elapsed:.0f}s "
              f"| est_remaining={(elapsed/done)*(total-done):.0f}s", flush=True)
    print(f"[DONE] total={total} elapsed={time.time()-start:.0f}s", flush=True)
    embed_new_titles(total)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Ingest every qualifying print in the Tate catalogue")
    parser.add_argument("--accession-numbers", help="Comma-separated Tate accession numbers, e.g. A00005,N01234")
    parser.add_argument("--limit", type=int, help="Cap the number of rows (for a test run)")
    args = parser.parse_args()

    if not args.all and not args.accession_numbers:
        parser.error("Provide --all or --accession-numbers")

    accession_numbers = args.accession_numbers.split(",") if args.accession_numbers else None
    df = load_catalogue(limit=args.limit, accession_numbers=accession_numbers)
    artists_by_id = load_artists()
    print(f"Ingesting {len(df)} lot(s)...", flush=True)
    run(df, artists_by_id)
