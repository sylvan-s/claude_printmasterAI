/**
 * Stage 3b live check (plan phase 5): narrate Stage 3a prices for a few trial lots and report how
 * often the figure guard rejected a draft. Rebuilds evidence in code; one Haiku call per attempt.
 *
 *   npx tsx tests/backtest/stage3b_narration_check.ts --n 5 [--currency USD]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { AttributedLotAppraiser, appraiserConfigs, usageSummary, resetUsage } from "../../src/appraisal/appraiser";
import { readLotGraphEvidence, assembleValuationEvidence } from "../../src/appraisal/valuation_evidence";
import { stage3aValuation, stage3aAuctionEstimate, loadBlendCalibration } from "../../src/appraisal/stage3a_blend";
import { loadColumnMeans } from "../../src/appraisal/stage3a_waterfall";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const N = Number(arg("n", "5"));
const CURRENCY = arg("currency", "GBP")!;
class T extends AttributedLotAppraiser { narrate(...a: Parameters<AttributedLotAppraiser["runStage3bNarration"]>) { return this.runStage3bNarration(...a); } }

async function main() {
  const src: Record<string, any> = {};
  for (const f of ["roseberys", "forum"]) for (const l of readFileSync(`tests/backtest/comps_hammer/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); src[r.key] = r; }
  const trial = readFileSync("tests/backtest/comps_hammer/stage3_trial.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const picks = [...trial.filter((t) => t.C?.tier?.startsWith("same_work")).slice(0, Math.ceil(N / 2)), ...trial.filter((t) => !t.C?.tier?.startsWith("same_work")).slice(0, Math.floor(N / 2))];
  const cal = loadBlendCalibration()!, means = loadColumnMeans()!;
  const app = new T(appraiserConfigs.find((c) => c.id === "claude-4stage-attributed")!);
  resetUsage();
  let accepted = 0, retried = 0;
  for (const t of picks) {
    const row = src[t.key];
    const claim: any = { artist: row.artist, title: row.title, medium: row.medium, editionNote: row.editionNote, editionSize: row.editionSize, signed: row.signed, dimensions: row.widthCm && row.heightCm ? [{ kind: "sheet", widthCm: row.widthCm, heightCm: row.heightCm }] : null, catalogueRefs: row.catalogueRefs ? [row.catalogueRefs] : null, estimateLow: row.lowEst, estimateHigh: row.highEst, estimateCurrency: "GBP", house: row.blend.inputs.targetHouse, saleId: String(row.saleId), lotNumber: Number(row.lotNumber), saleDate: row.saleDate };
    const graph = await readLotGraphEvidence({ canonicalArtist: row.canonicalArtist, workTitle: claim.title, catalogueRefs: row.catalogueRefs ?? null, techniqueText: claim.medium, valuationDate: row.saleDate, excludeSaleLot: { saleId: claim.saleId, lotNumber: claim.lotNumber }, via: "claim" });
    const ev = assembleValuationEvidence({ builtAt: "check", reportedArtist: row.artist, canonicalArtist: row.canonicalArtist, claim, graph, targetHouse: { value: claim.house, source: "catalogue" }, valuationDate: { value: row.saleDate, source: "catalogue" } });
    const r = stage3aValuation(ev, cal, means)!;
    const est = stage3aAuctionEstimate(r, CURRENCY, row.saleDate)!;
    const n = await app.narrate(r, est, { valuationEvidence: ev } as any);
    console.log(`\n═══ ${t.key} ${row.artist} — ${row.title} (hammer £${row.hammer}); estimate ${est.formattedEstimate}; ${r.evidenceTier}`);
    if (!n) { console.log("  NARRATION DROPPED (figure guard failed twice)"); continue; }
    accepted++; if (n.guard.attempts > 1) retried++;
    console.log(`  [attempts ${n.guard.attempts}${n.guard.rejected.length ? `; rejected ${n.guard.rejected.join(", ")}` : ""}]`);
    console.log(`  HEADLINE: ${n.headline}`);
    for (const d of n.keyDrivers) console.log(`  - ${d.factor} (${d.direction}): ${d.explanation}`);
    console.log(`  NARRATIVE: ${n.narrative}`);
    if (n.caveats.length) console.log(`  CAVEATS: ${n.caveats.join(" | ")}`);
  }
  console.log(`\naccepted ${accepted}/${picks.length} (${retried} needed the retry); spend $${usageSummary().totalUsd.toFixed(3)}`);
  await closeDriver();
}
main();
