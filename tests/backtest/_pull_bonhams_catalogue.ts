/**
 * One-off pull: Bonhams sold + unsold dated lots with a valid estimate, straight from the
 * graph, into the same shape comps_hammer_backtest.ts's other loaders expect — so `--source
 * bonhams` can run the identical harness Roseberys and Forum already use. Bonhams has no
 * separate pre-ingest catalogue CSV (benchmark/data/bonhams/ is empty); this IS the catalogue,
 * read back out of what was already ingested. Not committed (matches the other catalogue.csv
 * files, present locally, not tracked).
 *
 *   npx tsx tests/backtest/_pull_bonhams_catalogue.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import neo4j from "neo4j-driver";
import { getDriver, getDatabase, closeDriver } from "../../src/appraisal/knowledge_graph/client";

const QUERY = `
MATCH (s:SourceRecord {institutionName:'Bonhams'})-[:DOCUMENTS]->(i:Impression)<-[:INCLUDES]-(er:EditionRun)<-[:PRINTED_AS]-(cw:ConceptualWork)<-[:CREATED]-(a:Artist)
WHERE s.sourceType='auction' AND s.saleDate IS NOT NULL AND s.estimateLowGBP IS NOT NULL AND s.estimateHighGBP IS NOT NULL AND s.estimateLowGBP > 0
RETURN a.name AS artist, coalesce(i.sourceTitle, cw.name) AS title, i.rawMedium AS rawMedium,
  s.saleId AS saleId, s.lotNumber AS lotNumber, substring(s.saleDate,0,10) AS saleDate,
  s.estimateLowGBP AS lowEst, s.estimateHighGBP AS highEst, coalesce(s.sold, false) AS sold,
  s.hammerPriceGBP AS hammer, s.priceRealisedGBP AS realised, s.listingUrl AS listingUrl,
  i.signed AS signed, coalesce(er.declaredSize, er.editionSize) AS editionSize,
  i.plateDimensions AS plateDims, i.imageDimensions AS imageDims, i.sheetDimensions AS sheetDims
SKIP $skip LIMIT $limit
`;
const PAGE = 8000;

const num = (v: any): number | null => (v == null ? null : typeof v === "number" ? v : v.toNumber?.() ?? Number(v));

async function main() {
  const session = getDriver().session({ database: getDatabase() });
  const rows: any[] = [];
  try {
    let skip = 0;
    for (;;) {
      const res = await session.run(QUERY, { skip: neo4j.int(skip), limit: neo4j.int(PAGE) });
      if (!res.records.length) break;
      for (const r of res.records) {
        rows.push({
          artist: r.get("artist"), title: r.get("title"), rawMedium: r.get("rawMedium"),
          saleId: r.get("saleId"), lotNumber: num(r.get("lotNumber")), saleDate: r.get("saleDate"),
          lowEst: num(r.get("lowEst")), highEst: num(r.get("highEst")), sold: r.get("sold"),
          hammer: num(r.get("hammer")), realised: num(r.get("realised")), listingUrl: r.get("listingUrl"),
          signed: r.get("signed"), editionSize: num(r.get("editionSize")),
          plateDims: r.get("plateDims"), imageDims: r.get("imageDims"), sheetDims: r.get("sheetDims"),
        });
      }
      console.log(`  pulled ${rows.length} rows so far...`);
      if (res.records.length < PAGE) break;
      skip += PAGE;
    }
  } finally {
    await session.close();
  }
  mkdirSync("benchmark/data/bonhams", { recursive: true });
  writeFileSync("benchmark/data/bonhams/catalogue.json", JSON.stringify(rows));
  console.log(`wrote ${rows.length} rows to benchmark/data/bonhams/catalogue.json`);
}

main().then(() => closeDriver()).catch(async (e) => { console.error(e); await closeDriver(); process.exit(1); });
