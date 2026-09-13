"""
PrintMasterAI — ADR-0019 Phase 2: export the extraction manifest.
Version: TECHML-PHASE2-MANIFEST-1.0

Writes one JSON line per DigitalImage the tile-extraction job should process, so the
job (extract_tile_embeddings.py, run on a rented GPU box) needs no Neo4j credentials —
only this file and an HF token. Selection follows ADR-0019 Phase 2: technique-labelled
images at a usable resolution tier, capped per (artist, technique) so no single hand
dominates, with everything the extractor needs to compute physical scale.

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/export_phase2_manifest.py \
        --out knowledge_graph/technique_ml/data/phase2_manifest.jsonl \
        --techniques Etching,Aquatint,Drypoint,Engraving,Mezzotint --min-tier process --artist-cap 40

Fields per line: imageId, hiresUrl, sourceUrl, institution, techniques (list), artistId,
artistName, workId, sheet, plate, image (catalogue dimension strings), pxPerMm,
pxPerMmBasis, resolutionTier, hiresWidthPixels, hiresHeightPixels.
"""

import argparse
import json
import os
import random

from neo4j import GraphDatabase

QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(imp:Impression)
WHERE img.hiresUrl IS NOT NULL AND img.hiresFailed IS NULL
  AND img.resolutionTier IN $tiers
MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
WITH img, imp, collect(DISTINCT t.name) AS techniques
WHERE $techniques IS NULL OR any(x IN techniques WHERE x IN $techniques)
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp)
OPTIONAL MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp)
WITH img, imp, techniques, collect(DISTINCT a)[0] AS a, collect(DISTINCT cw)[0] AS cw,
     collect(DISTINCT src.institutionName)[0] AS institution
RETURN elementId(img) AS imageId, img.hiresUrl AS hiresUrl, img.sourceUrl AS sourceUrl,
       institution, techniques, elementId(a) AS artistId, a.name AS artistName,
       elementId(cw) AS workId, imp.sheetDimensions AS sheet, imp.plateDimensions AS plate,
       imp.imageDimensions AS image, img.pxPerMm AS pxPerMm, img.pxPerMmBasis AS pxPerMmBasis,
       img.resolutionTier AS resolutionTier, img.hiresWidthPixels AS hiresWidthPixels,
       img.hiresHeightPixels AS hiresHeightPixels
"""

TIER_ORDER = ["family", "process", "fine"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--techniques", help="comma-separated; an image qualifies if ANY of its techniques is listed (default: all)")
    ap.add_argument("--min-tier", choices=TIER_ORDER, default="process")
    ap.add_argument("--artist-cap", type=int, default=40, help="max images per (artist, technique-set)")
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args()

    tiers = TIER_ORDER[TIER_ORDER.index(args.min_tier):]
    techniques = [t.strip() for t in args.techniques.split(",")] if args.techniques else None
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
        rows = [dict(r) for r in s.run(QUERY, tiers=tiers, techniques=techniques)]
    driver.close()
    print(f"{len(rows)} candidate images (tiers {tiers}, techniques {techniques or 'all'})")

    rng = random.Random(args.seed)
    rng.shuffle(rows)
    seen, kept = {}, []
    for r in rows:
        key = (r["artistId"], "|".join(sorted(r["techniques"])))
        if seen.get(key, 0) >= args.artist_cap:
            continue
        seen[key] = seen.get(key, 0) + 1
        kept.append(r)
    kept.sort(key=lambda r: r["imageId"])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    by_tier, by_tech, by_inst = {}, {}, {}
    for r in kept:
        by_tier[r["resolutionTier"]] = by_tier.get(r["resolutionTier"], 0) + 1
        by_inst[r["institution"]] = by_inst.get(r["institution"], 0) + 1
        for t in r["techniques"]:
            by_tech[t] = by_tech.get(t, 0) + 1
    print(f"kept {len(kept)} after artist cap {args.artist_cap}; {len({r['artistId'] for r in kept})} artists")
    print("  by tier:", by_tier)
    print("  by institution:", by_inst)
    print("  by technique:", dict(sorted(by_tech.items(), key=lambda kv: -kv[1])))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
