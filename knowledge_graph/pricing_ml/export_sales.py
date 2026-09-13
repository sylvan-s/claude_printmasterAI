"""
PrintMasterAI — export one artist's sold auction records from the ACKG for price modelling.
Version: PRICING-EXPORT-1.0

NB estimateLowGBP/estimateHighGBP are NOT estimates on Bonhams records: Bonhams' API field
`gbp_low_estimate` holds the sold price in GBP once a lot has sold (found 2026-09-13: both
equal the hammer on every row). Use the NATIVE estimateLow/estimateHigh divided by
fxRateToGBP (native units per GBP at the sale date), which train_price_model.py does.

Writes one row per SOLD auction SourceRecord with a hammer price, joined to the impression,
edition run, work, techniques and catalogue citations it documents. Nothing is parsed here —
the raw medium/condition text is exported verbatim so feature extraction in
train_price_model.py stays testable against the strings it was written from.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/export_sales.py \
        --artist "Pablo Picasso" --out knowledge_graph/pricing_ml/data/picasso_sales.csv

Reads NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD from the environment, falling back to
knowledge_graph/.env (same convention as the other knowledge_graph scripts).
"""
import argparse
import csv
import json
import os

from neo4j import GraphDatabase

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    for path in (os.path.join(HERE, "..", ".env"), os.path.join(HERE, "..", "..", ".env")):
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


QUERY = """
MATCH (a:Artist {name: $artist})-[:CREATED]->(cw:ConceptualWork)
      -[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.sourceType = 'auction' AND s.sold = true AND s.hammerPriceGBP > 0 AND s.saleDate IS NOT NULL
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (i)-[:PRINTED_ON]->(p:Paper)
OPTIONAL MATCH (cw)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
WITH s, i, er, cw,
     collect(DISTINCT t.name) AS techniques,
     collect(DISTINCT p.name) AS papers,
     collect(DISTINCT CASE WHEN ce IS NULL THEN null ELSE cr.numberingPrefix + ' ' + ce.number END) AS citations
RETURN s.id AS sourceId, s.institutionName AS house, s.saleId AS saleId, s.lotNumber AS lotNumber,
       substring(s.saleDate, 0, 10) AS saleDate, s.listingUrl AS listingUrl,
       s.hammerPriceGBP AS hammerGBP, s.priceRealisedGBP AS realisedGBP,
       s.estimateLow AS estimateLow, s.estimateHigh AS estimateHigh, s.fxRateToGBP AS fxRateToGBP,
       s.estimateLowGBP AS estimateLowGBP, s.estimateHighGBP AS estimateHighGBP,
       s.priceCurrency AS currency,
       cw.id AS workId, cw.name AS workName, cw.dateCreated_year AS workYear,
       i.id AS impressionId, i.sourceTitle AS sourceTitle, i.rawMedium AS rawMedium,
       i.signed AS signed, i.copyType AS copyType,
       er.declaredSize AS editionSize,
       i.plateDimensions AS plateDims, i.imageDimensions AS imageDims, i.sheetDimensions AS sheetDims,
       techniques, papers, [c IN citations WHERE c IS NOT NULL] AS citations
ORDER BY saleDate
"""

FIELDS = [
    "sourceId", "house", "saleId", "lotNumber", "saleDate", "listingUrl", "hammerGBP", "realisedGBP",
    "estimateLow", "estimateHigh", "fxRateToGBP", "estimateLowGBP", "estimateHighGBP", "currency", "workId", "workName", "workYear", "impressionId",
    "sourceTitle", "rawMedium", "signed", "copyType", "editionSize", "plateDims", "imageDims", "sheetDims",
    "techniques", "papers", "citations",
]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    load_env()
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    n = 0
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session, open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for rec in session.run(QUERY, artist=args.artist):
            row = {k: rec.get(k) for k in FIELDS}
            for k in ("techniques", "papers", "citations"):
                row[k] = json.dumps(row[k] or [])
            w.writerow(row)
            n += 1
    driver.close()
    print(f"{n} sold records for {args.artist!r} -> {args.out}")


if __name__ == "__main__":
    main()
