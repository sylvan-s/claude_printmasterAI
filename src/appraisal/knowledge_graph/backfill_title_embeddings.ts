/**
 * One-time (then incremental) backfill: write a gemini-embedding-001 vector onto every
 * ConceptualWork.name in the ACKG. ADR-0010 Decision 9.1, Part B.
 *
 *   npx tsx src/appraisal/knowledge_graph/backfill_title_embeddings.ts --limit 200   # smoke
 *   npx tsx src/appraisal/knowledge_graph/backfill_title_embeddings.ts               # all missing
 *   npx tsx src/appraisal/knowledge_graph/backfill_title_embeddings.ts --force       # re-embed all
 *
 * Writes four flat properties, mirroring the DINOv2 image-embedding pattern (doc 08 §7):
 *   titleEmbedding: LIST<FLOAT>   (L2-normalized, 768-d)
 *   titleEmbeddingModel: STRING   ("gemini-embedding-001")
 *   titleEmbeddingNorm: STRING    (the normalized text that was actually embedded)
 *   titleEmbeddedAt: STRING       (ISO date — lets a future re-embed target stale rows)
 *
 * Not run by CI. ~40.5k works; on the Gemini free tier this fits in RPD but is
 * paced under the RPM/TPM limits (see BATCH / SLEEP_MS below).
 */
import neo4j from "neo4j-driver";
import { getDriver, getDatabase, closeDriver } from "./client.js";
import { embedTexts, TITLE_EMBED_MODEL } from "./embed_text.js";
import { normalizeTitleForEmbedding } from "./title_normalize.js";

const FORCE = process.argv.includes("--force");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();
const BATCH = 48; // texts per embedContent call
const SLEEP_MS = 1300; // between batches — keeps well under the free-tier RPM ceiling

async function main() {
  const driver = getDriver();
  const session = driver.session({ database: getDatabase() });
  try {
    const countRes = await session.run(
      FORCE
        ? "MATCH (cw:ConceptualWork) WHERE cw.name IS NOT NULL RETURN count(cw) AS n"
        : "MATCH (cw:ConceptualWork) WHERE cw.name IS NOT NULL AND cw.titleEmbedding IS NULL RETURN count(cw) AS n",
    );
    const todo = Math.min(countRes.records[0].get("n").toNumber(), LIMIT);
    console.log(`${TITLE_EMBED_MODEL}: ${todo} ConceptualWork title(s) to embed (force=${FORCE})\n`);
    if (todo === 0) return;

    let done = 0;
    const started = Date.now();
    while (done < todo) {
      const take = Math.min(BATCH, todo - done);
      const rows = await session.run(
        `MATCH (cw:ConceptualWork)
         WHERE cw.name IS NOT NULL ${FORCE ? "" : "AND cw.titleEmbedding IS NULL"}
         RETURN elementId(cw) AS eid, cw.name AS name
         ORDER BY eid
         SKIP $skip LIMIT $take`,
        { skip: neo4j.int(FORCE ? done : 0), take: neo4j.int(take) },
      );
      if (rows.records.length === 0) break;

      const items = rows.records.map((r) => ({
        eid: r.get("eid") as string,
        name: r.get("name") as string,
        norm: normalizeTitleForEmbedding(r.get("name") as string),
      }));
      const vectors = await embedTexts(items.map((i) => i.norm));

      await session.run(
        `UNWIND $updates AS u
         MATCH (cw:ConceptualWork) WHERE elementId(cw) = u.eid
         SET cw.titleEmbedding = u.vec,
             cw.titleEmbeddingModel = $model,
             cw.titleEmbeddingNorm = u.norm,
             cw.titleEmbeddedAt = $now`,
        {
          updates: items.map((it, k) => ({ eid: it.eid, vec: vectors[k], norm: it.norm })),
          model: TITLE_EMBED_MODEL,
          now: new Date().toISOString(),
        },
      );

      done += items.length;
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  ${done}/${todo}  (${rate.toFixed(1)}/s, eta ${Math.round((todo - done) / rate)}s)   `,
      );
      if (done < todo) await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
    console.log(`\n\ndone — ${done} embedded in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
