/**
 * Report ConceptualWork title-embedding coverage. Read-only; no API calls.
 *
 *   npx tsx src/appraisal/knowledge_graph/title_embedding_coverage.ts
 *
 * Coverage matters because query_ackg_work ranks candidate works by title similarity, and
 * a work with no titleEmbedding is scored by token overlap instead — which loses to any
 * embedded rival regardless of which title actually matches better. So a work that is in
 * the graph but unembedded is, in practice, unfindable by title.
 *
 * Coverage silently drifted to 43.8% between the 2026-08-31 backfill and 2026-09-09 as
 * later ingests more than doubled the graph. The daily workflow
 * (.github/workflows/embed-titles-daily.yml) runs this after each pass so the number is
 * visible in the log rather than something a human has to remember to check.
 *
 * Exits 1 when coverage is below THRESHOLD_PCT, so the workflow step goes red if a run
 * failed to close the gap.
 */
import { getDriver, getDatabase, closeDriver } from "./client.js";

const THRESHOLD_PCT = 99;

async function main() {
  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(
      `MATCH (cw:ConceptualWork)
       WITH count(cw) AS total,
            sum(CASE WHEN cw.titleEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
            sum(CASE WHEN cw.name IS NULL THEN 1 ELSE 0 END) AS unnamed
       RETURN total, embedded, unnamed`,
    );
    const r = res.records[0];
    const total = r.get("total").toNumber();
    const embedded = r.get("embedded").toNumber();
    const unnamed = r.get("unnamed").toNumber();
    const missing = total - embedded;
    // A work with no name can never be embedded, so it is not a coverage failure.
    const embeddable = total - unnamed;
    const pct = embeddable > 0 ? (100 * embedded) / embeddable : 100;

    console.log(`ConceptualWork title embeddings`);
    console.log(`  total works        : ${total.toLocaleString()}`);
    console.log(`  embedded           : ${embedded.toLocaleString()}`);
    console.log(`  missing            : ${missing.toLocaleString()}`);
    console.log(`  unnamed (can't be) : ${unnamed.toLocaleString()}`);
    console.log(`  coverage           : ${pct.toFixed(1)}% of embeddable works`);

    if (pct < THRESHOLD_PCT) {
      console.error(
        `\nCoverage ${pct.toFixed(1)}% is below the ${THRESHOLD_PCT}% threshold — ` +
          `${missing.toLocaleString()} work(s) cannot be matched by title. ` +
          `Run: npm run kg:embed-titles`,
      );
      process.exitCode = 1;
    }
  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
