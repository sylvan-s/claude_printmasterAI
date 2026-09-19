"""
PrintMasterAI — King & McGaw Catalog Ingestion Pipeline (Step 1)
Version: KING-MCGAW-INGEST-1.1

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
   documenting retail availability, price range (min/max GBP), and POD features.
5. DigitalImage: High-res product thumbnail, tagged with imageType: "poster_catalog",
   ready for subsequent DINOv2 / CLIP embedding generation (Step 2).

Usage:
    python king_mcgaw_ingest.py --seed             # Run with embedded sample seed items
    python king_mcgaw_ingest.py --file items.json   # Ingest from a JSON file
    python king_mcgaw_ingest.py --dry-run          # Parse & reconcile without writing to Neo4j
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


# Sample seed items representing the 3 tiers (Warhol, Hockney, Van Gogh, Mourlot vintage litho)
SAMPLE_SEED_ITEMS = [
    {
        "km_product_id": "KM-WARHOL-MARILYN-1967",
        "artist_name": "Andy Warhol",
        "artwork_title": "Marilyn Monroe 1967 (Shot Blue Marilyn)",
        "creation_year": 1967,
        "category": "Modern Art",
        "medium_description": "Fine Art Screenprint Poster Reproduction",
        "listing_url": "https://www.kingandmcgaw.com/prints/andy-warhol/marilyn-monroe-1967-410293",
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/4/4e/Andy_Warhol_%281975%29.jpg",
        "retail_price_min_gbp": 35.00,
        "retail_price_max_gbp": 220.00,
        "is_limited_edition": False,
        "in_institutional_pod_archive": True,
        "publisher_name": "King & McGaw"
    },
    {
        "km_product_id": "KM-HOCKNEY-GARROWBY-1998",
        "artist_name": "David Hockney",
        "artwork_title": "Garrowby Hill",
        "creation_year": 1998,
        "category": "Modern Art",
        "medium_description": "Fine Art Paper Poster",
        "listing_url": "https://www.kingandmcgaw.com/prints/david-hockney/garrowby-hill-1998-309481",
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/a/a2/David_Hockney_2017.jpg",
        "retail_price_min_gbp": 40.00,
        "retail_price_max_gbp": 250.00,
        "is_limited_edition": False,
        "in_institutional_pod_archive": True,
        "publisher_name": "King & McGaw"
    },
    {
        "km_product_id": "KM-VANGOGH-SUNFLOWERS-1888",
        "artist_name": "Vincent van Gogh",
        "artwork_title": "Sunflowers",
        "creation_year": 1888,
        "category": "Iconic Artists Pre-1900",
        "medium_description": "250gsm Fine Art Rag Print",
        "listing_url": "https://www.kingandmcgaw.com/prints/vincent-van-gogh/sunflowers-1888-102938",
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/4/46/Vincent_Willem_van_Gogh_127.jpg",
        "retail_price_min_gbp": 25.00,
        "retail_price_max_gbp": 180.00,
        "is_limited_edition": False,
        "in_institutional_pod_archive": True,
        "publisher_name": "King & McGaw"
    },
    {
        "km_product_id": "KM-RARE-MOURLOT-PICASSO-1955",
        "artist_name": "Pablo Picasso",
        "artwork_title": "Exposition Vallauris 1955",
        "creation_year": 1955,
        "category": "Rare & Limited Division",
        "medium_description": "Original Vintage Exhibition Lithograph",
        "listing_url": "https://www.kingandmcgaw.com/rare-limited/pablo-picasso-exposition-vallauris-1955",
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/9/98/Pablo_picasso_1962.jpg",
        "retail_price_min_gbp": 850.00,
        "retail_price_max_gbp": 850.00,
        "is_limited_edition": True,
        "declared_edition_size": 500,
        "in_institutional_pod_archive": False,
        "publisher_name": "Atelier Mourlot"
    }
]


_RESOLVED_ARTISTS_CACHE = {}

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
            "editionType": "limited_edition" if raw_item.get("is_limited_edition") else "open_edition_poster",
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
            "retailPriceMinGBP": float(raw_item.get("retail_price_min_gbp", 0.0)),
            "retailPriceMaxGBP": float(raw_item.get("retail_price_max_gbp", 0.0)),
            "inInstitutionalPODArchive": bool(raw_item.get("in_institutional_pod_archive", False))
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
        sr.retailPriceMaxGBP = row.source_record.retailPriceMaxGBP,
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
    parser.add_argument("--seed", action="store_true", help="Run ingestion with sample seed dataset.")
    parser.add_argument("--file", type=str, help="Path to JSON file containing catalog items.")
    parser.add_argument("--dry-run", action="store_true", help="Prepare items and test reconciliation without writing to DB.")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch size for Neo4j Cypher execution.")

    args = parser.parse_args()

    items = []
    if args.seed:
        items = SAMPLE_SEED_ITEMS
    elif args.file:
        with open(args.file) as f:
            items = json.load(f)
    else:
        logging.warning("No input specified. Defaulting to --seed items.")
        items = SAMPLE_SEED_ITEMS

    run_ingestion(items, dry_run=args.dry_run, batch_size=args.batch_size)


if __name__ == "__main__":
    main()
