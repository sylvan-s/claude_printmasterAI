"""
PrintMasterAI — King & McGaw Catalog Ingestion Pipeline (Step 1)
Version: KING-MCGAW-INGEST-1.2

1.2: an absent value is written as null, not 0.0/False. `retailPriceMinGBP` and
    `inInstitutionalPODArchive` used to be coerced with `float(... or 0.0)` / `bool(...)`, so "the
    page did not say" became a stored 0.0 or False. Records must now come from a
    KING-MCGAW-FETCH-3.1+ catalog (which stops synthesising those values); `main` rejects older ones.
    `retailPriceMaxGBP` is no longer written at all (it was `min * 2.5`; removed from the graph by
    `repair_km_retail_fields.py` 2026-09-19).
    Removed `SAMPLE_SEED_ITEMS` and `--seed`: four invented records (their listing URLs are dead),
    and running with no arguments fell through to them against the live graph. `--file` is now
    required. Repair for records already in the graph: `repair_km_retail_fields.py`.

1.1: writes the work title to `ConceptualWork.name`, the property every other ingest uses and every
    reader (title embeddings, Stage 2a title similarity, reconcile/Splink) looks at. 1.0 wrote
    `title`, which left all 545 King & McGaw works invisible to those readers. Repaired in the
    graph by `repair_km_work_names.py`; guarded by `check_conceptual_work_title_property.py`.

Ingests fine art poster & print catalog records from King & McGaw into the ACKG
(Art Context Knowledge Graph) in Neo4j, following the schema specified in Doc 08.

Schema Mapping Strategy:
------------------------
1. Artist: Reconciled via resolve_artist_identity.py against ULAN / Wikidata.
   Sets property `hasPosterCatalog: true` and updates artist poster catalog counters.
2. ConceptualWork: The underlying artwork design. Matched against existing ACKG
   works or created as a new ConceptualWork using catalogue_matching logic.
3. EditionRun: Open-edition poster run or limited-edition vintage print run,
   linked to Publisher("King & McGaw") or historical printers (e.g. Mourlot).
4. SourceRecord: Unified evidence node with sourceType: "online_marketplace",
   documenting retail availability, the listing price (the default variant's, not the cheapest),
   and the institutional print-on-demand flag where the page names an institutional partner.
5. DigitalImage: High-res product thumbnail, tagged with imageType: "poster_catalog",
   ready for subsequent DINOv2 / CLIP embedding generation (Step 2).

Usage:
    python king_mcgaw_ingest.py --file catalog.json             # Ingest from a king_mcgaw_fetch.py catalog
    python king_mcgaw_ingest.py --file catalog.json --dry-run   # Parse & reconcile without writing to Neo4j
"""

import argparse
import json
import logging
import os
import re
import sys
from typing import Any, Dict, List, Optional

# Ensure knowledge_graph directory is on python path for helper imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from catalogue_matching import build_conceptual_work_id, resolve_merged_work_cypher, sanitize_id_part, normalize_title
from resolve_artist_identity import resolve_artist

try:
    from neo4j import GraphDatabase, Driver
    HAS_NEO4J = True
except ImportError:
    HAS_NEO4J = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# Default connection environment variables
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")

def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""


_RESOLVED_ARTISTS_CACHE = {}

def _optional_float(value: Any) -> Optional[float]:
    """None stays None: 0.0 would say the page showed a price of zero."""
    return None if value is None else float(value)


def _optional_bool(value: Any) -> Optional[bool]:
    """None stays None: False would assert a negative the page never stated."""
    return None if value is None else bool(value)


def prepare_item_record(raw_item: Dict[str, Any]) -> Dict[str, Any]:
    """Reconciles artist identity and constructs ACKG node property payloads."""
    artist_name = raw_item.get("artist_name", "").strip()
    artwork_title = raw_item.get("artwork_title", "").strip()
    km_id = raw_item.get("km_product_id", "").strip()
    
    # 1. Resolve Artist Identity against ULAN / Wikidata (with in-memory caching)
    if artist_name in _RESOLVED_ARTISTS_CACHE:
        resolution = _RESOLVED_ARTISTS_CACHE[artist_name]
    else:
        resolution = resolve_artist(artist_name)
        _RESOLVED_ARTISTS_CACHE[artist_name] = resolution

    resolved_ulan = resolution.get("resolvedUlanUrl")
    resolved_wikidata = resolution.get("resolvedWikidataUrl")
    confidence = resolution.get("confidence", "unresolved")

    # Artist primary key priority: ulanUrl -> wikidataUrl -> sanitized name
    if resolved_ulan:
        artist_key = resolved_ulan
    elif resolved_wikidata:
        artist_key = resolved_wikidata
    else:
        artist_key = f"name:{sanitize_id_part(artist_name.lower())}"

    # 2. Build ConceptualWork ID
    fallback_cw_id = f"km-cw-{sanitize_id_part(artist_name.lower())}-{sanitize_id_part(normalize_title(artwork_title))}"
    conceptual_work_id = build_conceptual_work_id("km", artist_name, artwork_title, [], fallback_cw_id)

    # 3. Build SourceRecord ID & Payload
    source_record_id = f"km-sr-{km_id.lower()}"
    edition_run_id = f"km-ed-{km_id.lower()}"
    image_id = f"km-img-{km_id.lower()}"
    publisher_name = raw_item.get("publisher_name", "King & McGaw").strip()

    creation_year = raw_item.get("creation_year")
    
    return {
        "artist": {
            "key": artist_key,
            "name": artist_name,
            "ulanUrl": resolved_ulan,
            "wikidataUrl": resolved_wikidata,
            "identityConfidence": confidence,
            "strippedName": resolution.get("strippedName", artist_name)
        },
        "conceptual_work": {
            "id": conceptual_work_id,
            "name": artwork_title,
            "dateCreated_year": int(creation_year) if creation_year else None,
            "dateCreated_precision": "exact" if creation_year else "unknown",
            "dateCreated_displayLabel": str(creation_year) if creation_year else None,
            "category": raw_item.get("category", "")
        },
        "publisher": {
            "name": publisher_name
        },
        "edition_run": {
            "id": edition_run_id,
            # 'limited_edition_poster' = sold in King & McGaw's Rare & Limited section (was
            # 'limited_edition' until 2026-09-19). It says WHERE King & McGaw files the item,
            # not that the item is an original: that is decided per item and recorded on the
            # EditionRun as `originalVerified`, which is what evidence queries key on.
            "editionType": "limited_edition_poster" if raw_item.get("is_limited_edition") else "open_edition_poster",
            "declaredSize": raw_item.get("declared_edition_size"),
            "medium": raw_item.get("medium_description", "Poster Print")
        },
        "source_record": {
            "id": source_record_id,
            "sourceType": "online_marketplace",
            "reliabilityTier": "commercial_retail",
            "publisher": publisher_name,
            "listingUrl": raw_item.get("listing_url", ""),
            "isMassProductionPoster": not raw_item.get("is_limited_edition", False),
            "isLimitedEdition": bool(raw_item.get("is_limited_edition", False)),
            "retailPriceMinGBP": _optional_float(raw_item.get("retail_price_min_gbp")),
            "inInstitutionalPODArchive": _optional_bool(raw_item.get("in_institutional_pod_archive"))
        },
        "digital_image": {
            "id": image_id,
            "sourceUrl": raw_item.get("image_url", ""),
            "imageType": "poster_catalog",
            "license": "Copyright King & McGaw / Estate"
        }
    }
def cypher_ingest_batch(driver: Driver, batch: List[Dict[str, Any]]):
    """Executes atomic Cypher batch transaction to merge items into Neo4j."""
    
    merged_work_clause = resolve_merged_work_cypher("row.conceptual_work.id", ["row", "a"])

    cypher_query = f"""
    UNWIND $batch AS row

    // 1. Safe Match / Merge Artist Node
    CALL {{
      WITH row
      OPTIONAL MATCH (byUlan:Artist {{ulanUrl: row.artist.ulanUrl}}) WHERE row.artist.ulanUrl IS NOT NULL
      OPTIONAL MATCH (byWiki:Artist {{wikidataUrl: row.artist.wikidataUrl}}) WHERE row.artist.wikidataUrl IS NOT NULL
      OPTIONAL MATCH (byName:Artist {{name: row.artist.name}})
      WITH row, coalesce(byUlan, byWiki, byName) AS found
      CALL {{
        WITH row, found
        WITH row, found WHERE found IS NOT NULL
        RETURN found AS a
        UNION
        WITH row, found
        WITH row, found WHERE found IS NULL AND row.artist.ulanUrl IS NOT NULL
        MERGE (a1:Artist {{ulanUrl: row.artist.ulanUrl}})
        RETURN a1 AS a
        UNION
        WITH row, found
        WITH row, found WHERE found IS NULL AND row.artist.ulanUrl IS NULL AND row.artist.wikidataUrl IS NOT NULL
        MERGE (a2:Artist {{wikidataUrl: row.artist.wikidataUrl}})
        RETURN a2 AS a
        UNION
        WITH row, found
        WITH row, found WHERE found IS NULL AND row.artist.ulanUrl IS NULL AND row.artist.wikidataUrl IS NULL
        MERGE (a3:Artist {{name: row.artist.name}})
        RETURN a3 AS a
      }}
      RETURN a
    }}
    SET a.name = coalesce(a.name, row.artist.name),
        a.ulanUrl = coalesce(a.ulanUrl, row.artist.ulanUrl),
        a.wikidataUrl = coalesce(a.wikidataUrl, row.artist.wikidataUrl),
        a.identityConfidence = coalesce(a.identityConfidence, row.artist.identityConfidence),
        a.hasPosterCatalog = true,
        a.posterWorkCount = coalesce(a.posterWorkCount, 0) + 1

    WITH row, a

    // 2. Resolve ConceptualWork via MergeEvent / catalogue_matching logic
    {merged_work_clause}
    
    SET cw.name = coalesce(cw.name, row.conceptual_work.name),
        cw.dateCreated_year = coalesce(cw.dateCreated_year, row.conceptual_work.dateCreated_year),
        cw.dateCreated_precision = coalesce(cw.dateCreated_precision, row.conceptual_work.dateCreated_precision),
        cw.dateCreated_displayLabel = coalesce(cw.dateCreated_displayLabel, row.conceptual_work.dateCreated_displayLabel),
        cw.category = coalesce(cw.category, row.conceptual_work.category)

    MERGE (a)-[:CREATED]->(cw)

    WITH row, a, cw

    // 3. Merge Publisher
    MERGE (pub:Publisher {{name: row.publisher.name}})

    // 4. Merge EditionRun
    MERGE (ed:EditionRun {{id: row.edition_run.id}})
    ON CREATE SET
        ed.editionType = row.edition_run.editionType,
        ed.declaredSize = row.edition_run.declaredSize,
        ed.medium = row.edition_run.medium
    
    MERGE (cw)-[:PRINTED_AS]->(ed)
    MERGE (ed)-[:PUBLISHED_BY]->(pub)

    WITH row, a, cw, ed

    // 5. Merge SourceRecord
    MERGE (sr:SourceRecord {{id: row.source_record.id}})
    ON CREATE SET
        sr.sourceType = row.source_record.sourceType,
        sr.reliabilityTier = row.source_record.reliabilityTier,
        sr.publisher = row.source_record.publisher,
        sr.listingUrl = row.source_record.listingUrl,
        sr.isMassProductionPoster = row.source_record.isMassProductionPoster,
        sr.isLimitedEdition = row.source_record.isLimitedEdition,
        sr.retailPriceMinGBP = row.source_record.retailPriceMinGBP,
        sr.inInstitutionalPODArchive = row.source_record.inInstitutionalPODArchive

    MERGE (sr)-[:DOCUMENTS]->(cw)
    MERGE (sr)-[:ATTRIBUTED_TO {{qualifier: "direct"}}]->(a)

    // 6. Merge DigitalImage (if sourceUrl present)
    FOREACH (_ IN CASE WHEN row.digital_image.sourceUrl <> "" THEN [1] ELSE [] END |
        MERGE (img:DigitalImage {{id: row.digital_image.id}})
        SET img.sourceUrl = row.digital_image.sourceUrl,
            img.imageType = row.digital_image.imageType,
            img.license = row.digital_image.license
        MERGE (img)-[:SHOWS]->(cw)
    )
    """""

    with driver.session(database="neo4j") as session:
        session.run(cypher_query, batch=batch)


def run_ingestion(items: List[Dict[str, Any]], dry_run: bool = False, batch_size: int = 50):
    logging.info(f"Preparing {len(items)} King & McGaw items for ingestion...")
    
    prepared_batch = []
    for raw in items:
        rec = prepare_item_record(raw)
        prepared_batch.append(rec)
        logging.info(
            f"Prepared: '{rec['conceptual_work']['name']}' by {rec['artist']['name']} "
            f"(Artist Key: {rec['artist']['key']}, CW ID: {rec['conceptual_work']['id']})"
        )

    if dry_run:
        logging.info("[DRY RUN COMPLETE] Prepared records successfully without writing to Neo4j.")
        return

    if not HAS_NEO4J:
        logging.error("neo4j package not installed. Install with `pip install neo4j`.")
        sys.exit(1)

    password = get_neo4j_password()
    if not password:
        logging.error("Neo4j password not found.")
        sys.exit(1)

    logging.info(f"Connecting to Neo4j at {NEO4J_URI}...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, password))

    try:
        total = len(prepared_batch)
        for i in range(0, total, batch_size):
            chunk = prepared_batch[i : i + batch_size]
            logging.info(f"Ingesting batch {i // batch_size + 1} ({len(chunk)} records)...")
            cypher_ingest_batch(driver, chunk)
        logging.info("Ingestion completed successfully!")
    finally:
        driver.close()


def main():
    parser = argparse.ArgumentParser(description="Ingest King & McGaw catalog items into ACKG Neo4j graph.")
    parser.add_argument("--file", type=str, required=True, help="Path to a king_mcgaw_fetch.py catalog JSON.")
    parser.add_argument("--dry-run", action="store_true", help="Prepare items and test reconciliation without writing to DB.")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch size for Neo4j Cypher execution.")

    args = parser.parse_args()

    with open(args.file) as f:
        items = json.load(f)

    stale = [i.get("km_product_id") for i in items if "print_on_demand" not in i]
    if stale:
        parser.error(
            f"{len(stale)} of {len(items)} records predate KING-MCGAW-FETCH-3.1 (no `print_on_demand` key), "
            f"so their retail min / institutional-POD values are synthesised, not scraped "
            f"(first: {stale[:3]}). Re-run king_mcgaw_fetch.py and ingest its output."
        )

    run_ingestion(items, dry_run=args.dry_run, batch_size=args.batch_size)


if __name__ == "__main__":
    main()
