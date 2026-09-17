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
import sys
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
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)
      -[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE ($artist IS NULL OR a.name = $artist)
  AND s.sourceType = 'auction' AND s.saleDate IS NOT NULL
  AND CASE WHEN $lots THEN s.estimateLow > 0 ELSE s.sold = true AND s.hammerPriceGBP > 0 END
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (i)-[:PRINTED_ON]->(p:Paper)
OPTIONAL MATCH (cw)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
OPTIONAL MATCH (img:DigitalImage)-[:SHOWS]->(i)
// The house's attribution of THIS sale to the artist ("after", "attributed_to", ...), which the
// ingests write on ATTRIBUTED_TO, not on CREATED (2026-09-17: "after Warhol" posters were
// being counted as Warhol's own sales).
OPTIONAL MATCH (s)-[att:ATTRIBUTED_TO]->(a)
WITH a, s, i, er, cw, collect(DISTINCT att.qualifier) AS qualifiers,
     collect(DISTINCT t.name) AS techniques,
     collect(DISTINCT p.name) AS papers,
     collect(DISTINCT CASE WHEN ce IS NULL THEN null ELSE cr.numberingPrefix + ' ' + ce.number END) AS citations,
     collect(img)[0] AS img
RETURN a.name AS artist, a.ulanUrl AS artistUlan, a.nationality AS artistNationality,
       a.dateBorn_year AS artistBorn, a.dateDied_year AS artistDied, s.id AS sourceId, s.institutionName AS house, s.saleId AS saleId, s.lotNumber AS lotNumber,
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
       techniques, papers, [c IN citations WHERE c IS NOT NULL] AS citations,
       img.clipSubject AS clipSubject, img.clipSubjectMargin AS clipSubjectMargin, img.clipSubjectConfident AS clipSubjectConfident,
       [q IN qualifiers WHERE q IS NOT NULL][0] AS qualifier,
       coalesce(s.sold, false) AS sold
ORDER BY saleDate
"""

FIELDS = [
    "artist", "artistUlan", "artistNationality", "artistBorn", "artistDied", "sourceId", "house", "saleId", "lotNumber", "saleDate", "listingUrl", "hammerGBP", "realisedGBP",
    "estimateLow", "estimateHigh", "fxRateToGBP", "estimateLowGBP", "estimateHighGBP", "currency", "workId", "workName", "workYear", "impressionId",
    "sourceTitle", "rawMedium", "signed", "copyType", "editionSize", "plateDims", "imageDims", "sheetDims",
    "techniques", "papers", "citations", "clipSubject", "clipSubjectMargin", "clipSubjectConfident",
    "qualifier",
]
# --lots adds: the sold flag and the house estimate in GBP at the SALE-DATE ECB rate, computed here
# with backfill_fx_gbp's rate book (the stored GBP estimates cover sold rows only; unsold Bonhams rows
# hold Bonhams' own current-rate conversion and Swann has none).
LOT_FIELDS = ["sold", "estimateLowGBPSaleDate", "estimateHighGBPSaleDate", "estimateMidGBP", "fxRateSaleDate", "fxRateDateSaleDate"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artist", default=None, help="one artist; omit for every artist in the graph")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lots", action="store_true",
                    help="every dated auction lot with an estimate, sold or not, any house (2026-09-17 estimate-target model); "
                         "default: sold records with a hammer, as before")
    args = ap.parse_args()
    load_env()
    book = None
    if args.lots:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from backfill_fx_gbp import RateBook, load_rates
        book = RateBook(load_rates(False))
    unconvertible = 0
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    n = 0
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session, open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS + (LOT_FIELDS if args.lots else []))
        w.writeheader()
        for rec in session.run(QUERY, artist=args.artist, lots=args.lots):
            row = {k: rec.get(k) for k in FIELDS}
            if args.lots:
                row["sold"] = bool(rec.get("sold"))
                cur = (rec.get("currency") or "GBP").upper()
                day = str(rec.get("saleDate"))[:10]
                rate, rate_day = (1.0, day) if cur == "GBP" else book.lookup(day, cur)
                lo, hi = rec.get("estimateLow"), rec.get("estimateHigh")
                if rate:
                    lo_g = round(lo / rate, 2) if lo and lo > 0 else None
                    hi_g = round(hi / rate, 2) if hi and hi > 0 else None
                    row.update(estimateLowGBPSaleDate=lo_g, estimateHighGBPSaleDate=hi_g, fxRateSaleDate=rate, fxRateDateSaleDate=rate_day,
                               estimateMidGBP=round((lo_g + (hi_g or lo_g)) / 2, 2) if lo_g else None)
                else:
                    unconvertible += 1
            for k in ("techniques", "papers", "citations"):
                row[k] = json.dumps(row[k] or [])
            w.writerow(row)
            n += 1
    driver.close()
    who = repr(args.artist) if args.artist else "all artists"
    kind = "lots with an estimate (sold and unsold)" if args.lots else "sold records"
    print(f"{n} {kind} for {who} -> {args.out}" + (f"; {unconvertible} with no ECB rate for their currency/date" if args.lots else ""))


if __name__ == "__main__":
    main()
