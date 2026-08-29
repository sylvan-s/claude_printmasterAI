"""
PrintMasterAI — stratified backtest pool builder
Version: TESTPOOL-1.0

Builds a reusable, stratified sample of real Roseberys/Forum lots from the ACKG for
backtesting Stage 2a/2b, per the user's explicit stratification design (2026-08-26):

  - Single-artist lots only (confirmed via the ACKG: 22,725 of 22,727 auction
    ConceptualWorks already have exactly one Artist via CREATED — multi-work/multi-artist
    lots were already filtered out during Roseberys/Forum ingestion, see doc09 §3.1).
  - Stratified by technique: the 7 most frequent technique classes in the ACKG by real
    count (Screenprint/Serigraphy, Lithograph, Etching, Offset lithograph, Aquatint,
    Giclée, Drypoint), plus an "Other" bucket for everything else (including no
    technique recorded).
  - Stratified by auction house: Roseberys London, Forum Auctions.
  - Stratified by lower estimate bracket: 0-299, 300-499, 500-999, 1000-5000, over5000.

That's 8 techniques x 2 houses x 5 brackets = 80 strata. Every cell has real data
(confirmed via direct query before writing this — thinnest cell is Roseberys
Drypoint/over5000 with exactly 1 real lot). Sampling: 1 lot per cell (80), plus a second
lot drawn from 20 randomly chosen cells to reach ~100 total, per a fixed random seed for
reproducibility — re-running this script produces the identical pool.

Usage:
    python3 build_test_pool.py
    (requires NEO4J_* env vars — see knowledge_graph/.env.example)
"""

import csv
import json
import os
import random

from neo4j import GraphDatabase


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

RANDOM_SEED = 20260826  # fixed — re-running this script reproduces the identical pool
TOP_TECHNIQUES = [
    "Screenprint / Serigraphy", "Lithograph", "Etching", "Offset lithograph",
    "Aquatint", "Giclée", "Drypoint",
]
HOUSES = ["Roseberys London", "Forum Auctions"]
BRACKETS = ["0-299", "300-499", "500-999", "1000-5000", "over5000"]
CELLS_TO_DOUBLE = 20  # random cells that get a 2nd lot, to reach ~100 total from 80 cells

QUERY = """
MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp:Impression)<-[:INCLUDES]-(er:EditionRun)
      <-[:PRINTED_AS]-(cw:ConceptualWork)<-[:CREATED]-(a:Artist)
WHERE src.sourceType = 'auction' AND src.institutionName IN $houses
WITH src, imp, cw, a, count { (cw)<-[:CREATED]-(:Artist) } AS artistCount
WHERE artistCount = 1
OPTIONAL MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
WITH src, cw, a, collect(DISTINCT t.name) AS techniques
WITH src, cw, a,
     CASE
       WHEN size(techniques) = 1 AND techniques[0] IN $topTechniques THEN techniques[0]
       ELSE 'Other'
     END AS techBucket,
     CASE
       WHEN src.estimateLow < 300 THEN '0-299'
       WHEN src.estimateLow < 500 THEN '300-499'
       WHEN src.estimateLow < 1000 THEN '500-999'
       WHEN src.estimateLow <= 5000 THEN '1000-5000'
       ELSE 'over5000'
     END AS bracket
RETURN src.institutionName AS house, techBucket, bracket,
       src.saleId AS saleId, src.lotNumber AS lotNumber, src.listingUrl AS listingUrl,
       src.estimateLow AS estimateLow, src.estimateHigh AS estimateHigh,
       a.name AS artistName, cw.name AS title
"""


def fetch_population():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(QUERY, houses=HOUSES, topTechniques=TOP_TECHNIQUES)
            return [dict(r) for r in result]
    finally:
        driver.close()


def build_pool(rows):
    rng = random.Random(RANDOM_SEED)

    cells = {}
    for row in rows:
        key = (row["house"], row["techBucket"], row["bracket"])
        cells.setdefault(key, []).append(row)

    all_cell_keys = [(h, t, b) for h in HOUSES for t in (TOP_TECHNIQUES + ["Other"]) for b in BRACKETS]
    missing = [k for k in all_cell_keys if k not in cells or not cells[k]]
    if missing:
        print(f"[WARN] {len(missing)} of {len(all_cell_keys)} cells have zero real lots: {missing}")

    pool = []
    used_ids = set()

    def draw(key):
        candidates = [r for r in cells.get(key, []) if r["listingUrl"] not in used_ids]
        if not candidates:
            return None
        chosen = rng.choice(candidates)
        used_ids.add(chosen["listingUrl"])
        return chosen

    # Pass 1: one lot per cell.
    for key in all_cell_keys:
        chosen = draw(key)
        if chosen:
            pool.append(chosen)

    # Pass 2: a second lot from a random subset of cells, to reach ~100 total.
    doublable = [k for k in all_cell_keys if k in cells and len(cells[k]) >= 2]
    extra_cells = rng.sample(doublable, min(CELLS_TO_DOUBLE, len(doublable)))
    for key in extra_cells:
        chosen = draw(key)
        if chosen:
            pool.append(chosen)

    return pool


def write_outputs(pool, csv_path, json_path):
    fieldnames = ["house", "techBucket", "bracket", "saleId", "lotNumber", "artistName",
                  "title", "estimateLow", "estimateHigh", "listingUrl"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in pool:
            writer.writerow({k: row.get(k) for k in fieldnames})

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(pool, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    print("Fetching eligible population from ACKG...")
    rows = fetch_population()
    print(f"Eligible single-artist auction lots: {len(rows)}")

    pool = build_pool(rows)
    print(f"Pool built: {len(pool)} lots")

    out_dir = os.path.join(os.path.dirname(__file__), "..", "tests", "backtest")
    csv_path = os.path.join(out_dir, "test_pool_100.csv")
    json_path = os.path.join(out_dir, "test_pool_100.json")
    write_outputs(pool, csv_path, json_path)
    print(f"Wrote {csv_path}")
    print(f"Wrote {json_path}")

    # Summary tables for a quick sanity check.
    from collections import Counter
    print("\nBy house:", dict(Counter(r["house"] for r in pool)))
    print("By technique bucket:", dict(Counter(r["techBucket"] for r in pool)))
    print("By bracket:", dict(Counter(r["bracket"] for r in pool)))
