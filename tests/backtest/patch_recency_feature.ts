/**
 * Patches `blend.inputs.recentSameHouseAppearance` onto an existing comps_hammer_backtest.ts
 * `--blend` output file, without re-running the expensive comps/priors pipeline that produced
 * it. One-off: `comps_hammer_backtest.ts` now computes this field natively for any FUTURE run
 * (see `recentSameHouseAppearance()` / `RECENT_SAME_HOUSE` there — this script's query is a
 * copy, kept in sync with that one); this script exists only to bring the three files already
 * on disk from step 8/9 up to date without a ~12-minute re-run each.
 *
 *   npx tsx tests/backtest/patch_recency_feature.ts tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDriver, getDatabase, closeDriver } from "../../src/appraisal/knowledge_graph/client";
import { normalizeTitleKey, isLowInformationTitle } from "../../src/appraisal/knowledge_graph/index";

const RECENT_SAME_HOUSE = `
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE a.name = $artist AND s.institutionName = $house AND s.sourceType = 'auction'
  AND s.saleDate IS NOT NULL AND substring(s.saleDate, 0, 10) < $untilDate
  AND NOT (s.saleId = $saleId AND s.lotNumber = $lotNumber)
WITH cw, s
WHERE replace(replace(replace(toLower(trim(cw.name)),'(',' '),')',' '),'-',' ') CONTAINS $titleKey
RETURN substring(s.saleDate, 0, 10) AS date, s.sold AS sold
ORDER BY s.saleDate DESC
LIMIT 1
`;
const HOUSE_NAME: Record<string, string> = { roseberys: "Roseberys London", forum: "Forum Auctions", bonhams: "Bonhams" };
const CONCURRENCY = 8;

async function recent(artist: string, titleKey: string, house: string, untilDate: string, saleId: string, lotNumber: number) {
  const s = getDriver().session({ database: getDatabase() });
  try {
    const r = await s.run(RECENT_SAME_HOUSE, { artist, titleKey, house, untilDate, saleId, lotNumber });
    const rec = r.records[0];
    if (!rec) return null;
    const days = (new Date(untilDate).getTime() - new Date(String(rec.get("date"))).getTime()) / 86400000;
    if (!Number.isFinite(days) || days < 0) return null;
    return { sold: !!rec.get("sold"), daysAgo: days };
  } finally { await s.close(); }
}

async function main() {
  const IN = process.argv[2];
  if (!IN) { console.error("usage: patch_recency_feature.ts <path-to-blend.jsonl>"); process.exit(1); }
  const OUT = IN.replace(/\.jsonl$/, "_recency.jsonl");
  const lines = readFileSync(IN, "utf8").split("\n").filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));
  const withBlend = rows.filter((r) => r.blend && !r.error);
  console.log(`${rows.length} rows (${withBlend.length} with blend inputs) -> ${OUT}`);

  let i = 0, n = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (i < withBlend.length) {
      const r = withBlend[i++];
      const artist = r.canonicalArtist ?? r.artist;
      const house = HOUSE_NAME[r.blend.inputs.house as string];
      const titleKey = r.titleUsable && r.title && !isLowInformationTitle(r.title) ? normalizeTitleKey(r.title).slice(0, 24) : "";
      r.blend.inputs.recentSameHouseAppearance = titleKey && artist && house
        ? await recent(artist, titleKey, house, r.saleDate, r.saleId, r.lotNumber)
        : null;
      if (++n % 500 === 0) console.log(`  …${n}/${withBlend.length}  ${((Date.now() - t0) / 1000 / n).toFixed(3)}s/row`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const withAppearance = withBlend.filter((r) => r.blend.inputs.recentSameHouseAppearance).length;
  console.log(`done: ${n} rows patched in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${withAppearance} had a recent same-house appearance -> ${OUT}`);
}

main().then(() => closeDriver()).catch(async (e) => { console.error(e); await closeDriver(); process.exit(1); });
