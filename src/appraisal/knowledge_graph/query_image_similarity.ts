/**
 * queryImageEmbeddingMatches — Stage 1d's nearest-neighbour lookup against the ACKG's
 * own DINOv2/CLIP image index (docs/adr/0013-stage1d-image-embedding-evidence.md).
 *
 * Split out from query.ts (artist/work text search — an unrelated concern) the same
 * way embed_text.ts already is. Uses Neo4j's native vector index
 * (`db.index.vector.queryNodes` against the `digitalImageDinov2Embedding` /
 * `digitalImageClipEmbedding` indexes created by knowledge_graph/setup_vector_index.py)
 * rather than client-side cosine — the ad hoc precedent this replaces
 * (knowledge_graph/query_tate_image_similarity.py) explicitly flagged that as a
 * Stage-0-pilot shortcut that doesn't scale past a few dozen vectors.
 *
 * Traversal note (verified live 2026-09-06): every embedded DigitalImage today reaches
 * an Impression via (img)-[:SHOWS]->(imp:Impression); a small subset (British Museum's
 * pilot ingest) *also* carries a direct (img)-[:SHOWS]->(cw:ConceptualWork) edge. Both
 * shapes are queried defensively with OPTIONAL MATCH + coalesce() — there's no
 * OPTIONAL-MATCH-then-WHERE bug risk here (the mistake already found twice elsewhere in
 * this codebase, bm_embed_images.py / embed_tate_images.py) since there's no WHERE filter
 * on top of the optional patterns.
 */
import neo4j from "neo4j-driver";
import { getDriver, getDatabase } from "./client.js";
import type { EmbeddingMatchCandidate } from "../../types.js";

const DINOV2_INDEX = "digitalImageDinov2Embedding";
const CLIP_INDEX = "digitalImageClipEmbedding";

// All OPTIONAL — a candidate with a partial traversal (e.g. Impression but no
// resolvable Artist) is filtered out afterward in TS, not excluded here.
const VECTOR_QUERY = `
CALL db.index.vector.queryNodes($indexName, $k, $vector) YIELD node AS img, score
OPTIONAL MATCH (img)-[:SHOWS]->(imp:Impression)
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(imp)
OPTIONAL MATCH (cw1:ConceptualWork)-[:PRINTED_AS]->(er)
OPTIONAL MATCH (img)-[:SHOWS]->(cw2:ConceptualWork)
WITH img, score, imp, coalesce(cw1, cw2) AS cw
OPTIONAL MATCH (a:Artist)-[:CREATED]->(cw)
OPTIONAL MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp)
WITH img, score, imp, cw, a, src,
     // Sale-level self-match guard. Once an upcoming sale is ingested, its own lots are in
     // the image index, so a lot would match ITSELF at dino ~1.0 and "confirm" its own
     // identity. queryAuctionComparables already guards the price side by listingUrl and
     // sale/lot; this is the same guard on the image side, at sale granularity because a
     // whole catalogue is ingested at once. Collected before the row is dropped so the
     // caller can see how many were suppressed rather than wondering where they went.
     [x IN collect(src.saleId) WHERE x IS NOT NULL] AS saleIds
WHERE $excludeSaleId IS NULL OR NOT $excludeSaleId IN saleIds
RETURN img.id AS imgId, coalesce(imp.id, cw.id, img.id) AS matchKey,
       a.name AS artistName, cw.name AS workTitle, src.sourceType AS sourceType, score
ORDER BY score DESC
`;

interface RawRow {
  imgId: string;
  matchKey: string;
  artistName: string | null;
  workTitle: string | null;
  sourceType: string | null;
  score: number;
}

async function runVectorQuery(indexName: string, vector: number[], k: number, excludeSaleId?: string | null): Promise<RawRow[]> {
  const driver = getDriver();
  const session = driver.session({ database: getDatabase() });
  try {
    const result = await session.run(VECTOR_QUERY, { indexName, vector, k: neo4j.int(k), excludeSaleId: excludeSaleId ?? null });
    return result.records.map((r) => ({
      imgId: r.get("imgId"),
      matchKey: r.get("matchKey"),
      artistName: r.get("artistName") ?? null,
      workTitle: r.get("workTitle") ?? null,
      sourceType: r.get("sourceType") ?? null,
      score: r.get("score"),
    }));
  } finally {
    await session.close();
  }
}

function provenanceLayerFor(sourceType: string | null): "institutional" | "auction_history" {
  return sourceType === "auction" ? "auction_history" : "institutional";
}

/**
 * Merge DINOv2 and CLIP nearest-neighbour results (each independently optional — a
 * caller whose embedding service only produced one model's vector still gets partial
 * results) by resolved artwork identity (matchKey), not by DigitalImage id: two
 * DigitalImage rows can point at the same Impression/ConceptualWork.
 */
export async function queryImageEmbeddingMatches(
  dinov2Vector: number[] | null,
  clipVector: number[] | null,
  opts: { topKPerIndex?: number; limit?: number; excludeSaleId?: string | null } = {},
): Promise<EmbeddingMatchCandidate[]> {
  const topK = opts.topKPerIndex ?? 25;
  const limit = opts.limit ?? 10;

  const [dinoRows, clipRows] = await Promise.all([
    dinov2Vector ? runVectorQuery(DINOV2_INDEX, dinov2Vector, topK, opts.excludeSaleId) : Promise.resolve([]),
    clipVector ? runVectorQuery(CLIP_INDEX, clipVector, topK, opts.excludeSaleId) : Promise.resolve([]),
  ]);

  const byKey = new Map<string, EmbeddingMatchCandidate>();
  for (const row of dinoRows) {
    if (!row.artistName) continue; // unresolved candidate — skip rather than return half-populated
    byKey.set(row.matchKey, {
      artistName: row.artistName,
      conceptualWorkTitle: row.workTitle ?? null,
      impressionId: row.matchKey,
      dinov2Similarity: row.score,
      clipSimilarity: null,
      provenanceLayer: provenanceLayerFor(row.sourceType),
    });
  }
  for (const row of clipRows) {
    if (!row.artistName) continue;
    const existing = byKey.get(row.matchKey);
    if (existing) {
      existing.clipSimilarity = row.score;
    } else {
      byKey.set(row.matchKey, {
        artistName: row.artistName,
        conceptualWorkTitle: row.workTitle ?? null,
        impressionId: row.matchKey,
        dinov2Similarity: null,
        clipSimilarity: row.score,
        provenanceLayer: provenanceLayerFor(row.sourceType),
      });
    }
  }

  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    const bothA = a.dinov2Similarity != null && a.clipSimilarity != null;
    const bothB = b.dinov2Similarity != null && b.clipSimilarity != null;
    if (bothA !== bothB) return bothA ? -1 : 1;
    const maxA = Math.max(a.dinov2Similarity ?? 0, a.clipSimilarity ?? 0);
    const maxB = Math.max(b.dinov2Similarity ?? 0, b.clipSimilarity ?? 0);
    return maxB - maxA;
  });
  return merged.slice(0, limit);
}

/** Manual-verification helper (see image_similarity_cli.ts): fetch one DigitalImage's own
 *  stored vectors, so its self-match can be queried through this same code path. */
export async function getStoredImageVectors(
  imageId: string,
): Promise<{ dinov2: number[] | null; clip: number[] | null } | null> {
  const driver = getDriver();
  const session = driver.session({ database: getDatabase() });
  try {
    const result = await session.run(
      "MATCH (img:DigitalImage {id: $imageId}) RETURN img.embedding AS dinov2, img.clipImageEmbedding AS clip",
      { imageId },
    );
    if (result.records.length === 0) return null;
    const rec = result.records[0];
    return {
      dinov2: (rec.get("dinov2") as number[] | null) ?? null,
      clip: (rec.get("clip") as number[] | null) ?? null,
    };
  } finally {
    await session.close();
  }
}
