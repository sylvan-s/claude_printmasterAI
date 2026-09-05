/**
 * Manual smoke test for queryImageEmbeddingMatches — no pipeline involvement.
 *
 * Usage: npm run query:image-match -- --image-id tate-P02159-img
 *
 * Self-match sanity check: fetches the given DigitalImage's own stored vectors and
 * queries the vector indexes with them — the image should come back as its own
 * top match with score ~= 1.0. This is what actually proves the raw number[] ->
 * LIST<FLOAT> Cypher parameter marshals correctly (a genuinely new parameter shape
 * for this codebase — see query_image_similarity.ts's module docstring).
 */
import { queryImageEmbeddingMatches, getStoredImageVectors } from "./query_image_similarity.js";
import { closeDriver } from "./client.js";

function parseArgs(argv: string[]): { imageId?: string } {
  const out: { imageId?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--image-id") out.imageId = argv[i + 1];
  }
  return out;
}

async function main() {
  const { imageId } = parseArgs(process.argv.slice(2));
  if (!imageId) {
    console.error("Usage: npm run query:image-match -- --image-id <DigitalImage.id>");
    process.exit(1);
  }

  const vectors = await getStoredImageVectors(imageId);
  if (!vectors) {
    console.error(`No DigitalImage found with id ${JSON.stringify(imageId)}`);
    await closeDriver();
    process.exit(1);
  }
  console.log(
    `${imageId}: dinov2=${vectors.dinov2 ? `${vectors.dinov2.length}-dim` : "none"}, ` +
    `clip=${vectors.clip ? `${vectors.clip.length}-dim` : "none"}`
  );

  const candidates = await queryImageEmbeddingMatches(vectors.dinov2, vectors.clip, { limit: 5 });
  if (candidates.length === 0) {
    console.log("(no candidates returned)");
  } else {
    console.log(`\nTop ${candidates.length} match(es):`);
    for (const c of candidates) {
      console.log(
        `  ${c.artistName} — "${c.conceptualWorkTitle ?? "?"}" ` +
        `(dino=${c.dinov2Similarity?.toFixed(4) ?? "—"}, clip=${c.clipSimilarity?.toFixed(4) ?? "—"}, ` +
        `${c.provenanceLayer}, impressionId=${c.impressionId})`
      );
    }
    const top = candidates[0];
    const selfMatch = top.dinov2Similarity != null && top.dinov2Similarity > 0.999;
    console.log(selfMatch
      ? "\nSelf-match check: PASS (top DINOv2 score ~= 1.0)"
      : "\nSelf-match check: top result is not a near-1.0 self-match — inspect above.");
  }

  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
