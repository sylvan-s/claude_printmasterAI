/**
 * Phase 4 comparison (plan docs/plans/2026-09-16-stage3-blend-valuation.md): Stage 3a's
 * deterministic range vs the LLM Stage 3 estimate, on the realised hammer.
 *
 * Reads attributed-lot run outputs (tests/backtest/output/<sale>_<lot>_attrpath/result.json, as
 * run_attributed_lot.ts writes them). Uses report.stage3a when the run recorded one;
 * with --recompute it rebuilds the evidence from the run's own saved Stage 1c / 2 outputs and
 * catalogue claim (graph reads only, zero LLM), so older runs can be scored too. The hammer is
 * read from the graph by house + sale + lot.
 *
 *   npx tsx tests/backtest/stage3a_shadow_report.ts --dir tests/backtest/output --suffix _attrpath [--recompute]
 */
import "dotenv/config";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index";
import { getDriver, getDatabase } from "../../src/appraisal/knowledge_graph/client";
import { readLotGraphEvidence, assembleValuationEvidence, type Sourced } from "../../src/appraisal/valuation_evidence";
import { stage3aValuation, loadBlendCalibration, type Stage3aResult } from "../../src/appraisal/stage3a_blend";
import type { CatalogueAttribution } from "../../src/appraisal/attributed_lot";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DIR = arg("dir", "tests/backtest/output")!;
const SUFFIX = arg("suffix", "_attrpath")!;
const RECOMPUTE = argv.includes("--recompute");
const DRIFT = 0.82;

async function hammerOf(house: string | null | undefined, saleId: string | null | undefined, lot: number | null | undefined) {
  if (!house || !saleId || lot == null) return null;
  const s = getDriver().session({ database: getDatabase() });
  try {
    const r = await s.run(`MATCH (src:SourceRecord) WHERE src.institutionName = $house AND src.saleId = $saleId AND src.lotNumber = $lot RETURN src.sold AS sold, src.hammerPriceGBP AS hammer, src.saleDate AS date LIMIT 1`, { house, saleId, lot });
    const rec = r.records[0];
    return rec ? { sold: rec.get("sold") === true, hammer: rec.get("hammer") as number | null, date: rec.get("date") as string | null } : null;
  } finally { await s.close(); }
}

async function recompute(res: any): Promise<Stage3aResult | null> {
  const cal = loadBlendCalibration();
  const claim: CatalogueAttribution = res.catalogueAttribution;
  const rep = res.report ?? {};
  if (!cal || !claim) return null;
  const canonical = rep.attributedLot?.verification?.artist?.canonical ?? res.attributedLot?.verification?.artist?.canonical ?? null;
  const valuationDate: Sourced<string> = claim.saleDate ? { value: claim.saleDate.slice(0, 10), source: "catalogue" } : { value: new Date().toISOString().slice(0, 10), source: "default" };
  const graph = await readLotGraphEvidence({
    canonicalArtist: canonical ?? claim.artist, workTitle: claim.title ?? null,
    catalogueRefs: claim.catalogueRefs?.length ? claim.catalogueRefs.join("; ") : null,
    techniqueText: claim.medium ?? null, valuationDate: valuationDate.value,
    excludeSaleLot: claim.saleId && claim.lotNumber != null ? { saleId: claim.saleId, lotNumber: claim.lotNumber } : null,
    excludeListingUrl: claim.lotUrl ?? null, via: "claim",
  });
  const ev = assembleValuationEvidence({
    builtAt: "recompute", reportedArtist: claim.artist, canonicalArtist: canonical, claim,
    appraiserInput: rep.stage1cResult, attr: rep.stage2Result, vea: rep.stage1Result, graph,
    targetHouse: { value: claim.house ?? null, source: "catalogue" }, valuationDate,
  });
  return stage3aValuation(ev, cal);
}

const ln = Math.log;
async function main() {
  const dirs = readdirSync(DIR).filter((d) => d.endsWith(SUFFIX) && existsSync(join(DIR, d, "result.json")));
  const rows: any[] = [];
  for (const d of dirs) {
    const res = JSON.parse(readFileSync(join(DIR, d, "result.json"), "utf8"));
    const claim: CatalogueAttribution = res.catalogueAttribution;
    const shadow: Stage3aResult | null = res.report?.stage3a ?? (RECOMPUTE ? await recompute(res) : null);
    // Since 2026-09-16 auctionEstimate IS Stage 3a when it priced; the LLM's own lives in llmAuctionEstimate.
    const llm = res.report?.llmAuctionEstimate ?? res.report?.auctionEstimate;
    const out = await hammerOf(claim?.house, claim?.saleId, claim?.lotNumber);
    rows.push({ d, claim, shadow, llm, out, source: res.report?.stage3a ? "recorded" : RECOMPUTE ? "recomputed" : "none" });
  }
  const sold = rows.filter((r) => r.out?.sold && r.out.hammer > 0);
  console.log(`${rows.length} runs in ${DIR} (*${SUFFIX}); Stage 3a ${rows.filter((r) => r.shadow).length} (${rows.filter((r) => r.source === "recorded").length} recorded, ${rows.filter((r) => r.source === "recomputed" && r.shadow).length} recomputed); sold with a hammer ${sold.length}; unsold ${rows.filter((r) => r.out && !r.out.sold && r.out.date).length}; not yet sold ${rows.filter((r) => r.out && !r.out.sold && !r.out.date).length}; no graph record ${rows.filter((r) => !r.out).length}`);

  const score = (label: string, pts: { pred: number; lo?: number; hi?: number; y: number }[]) => {
    if (!pts.length) return console.log(`  ${label.padEnd(34)} n=0`);
    const e = pts.map((p) => ln(p.pred) - ln(p.y));
    const mae = e.reduce((t, x) => t + Math.abs(x), 0) / e.length;
    const geo = Math.exp(e.reduce((t, x) => t + x, 0) / e.length);
    const w2 = e.filter((x) => Math.abs(x) <= ln(2)).length / e.length;
    const ranged = pts.filter((p) => p.lo && p.hi);
    const cover = ranged.length ? ranged.filter((p) => p.y >= p.lo! && p.y <= p.hi!).length / ranged.length : NaN;
    const width = ranged.length ? ranged.map((p) => p.hi! / p.lo!).sort((a, b) => a - b)[ranged.length >> 1] : NaN;
    console.log(`  ${label.padEnd(34)} n=${String(pts.length).padStart(3)}  MAE(log) ${mae.toFixed(3)}  geo ${geo.toFixed(2)}  within 2x ${(100 * w2).toFixed(0)}%  hammer in range ${Number.isFinite(cover) ? (100 * cover).toFixed(0) + "%" : "n/a"}  median high/low ${Number.isFinite(width) ? width.toFixed(2) + "x" : "n/a"}`);
  };
  const both = sold.filter((r) => r.shadow && r.llm?.lowEstimate > 0);
  console.log(`\n── On ${both.length} sold lots with both a Stage 3a range and an LLM estimate (GBP, hammer basis) ──`);
  score("LLM Stage 3 (midpoint, its range)", both.map((r) => ({ pred: Math.sqrt(r.llm.lowEstimate * r.llm.highEstimate), lo: r.llm.lowEstimate, hi: r.llm.highEstimate, y: r.out.hammer })));
  score("Stage 3a (median, 80% range)", both.map((r) => ({ pred: r.shadow.medianGBP, lo: r.shadow.lowGBP, hi: r.shadow.highGBP, y: r.out.hammer })));
  score("printed estimate x0.82 (reference)", both.filter((r) => r.claim.estimateLow > 0).map((r) => ({ pred: ((r.claim.estimateLow + r.claim.estimateHigh) / 2) * DRIFT, lo: r.claim.estimateLow, hi: r.claim.estimateHigh, y: r.out.hammer })));
  const tiers = [...new Set(both.map((r) => r.shadow.evidenceTier))];
  for (const t of tiers) {
    const sub = both.filter((r) => r.shadow.evidenceTier === t);
    console.log(`  ${t} (n=${sub.length})`);
    score("  LLM Stage 3", sub.map((r) => ({ pred: Math.sqrt(r.llm.lowEstimate * r.llm.highEstimate), lo: r.llm.lowEstimate, hi: r.llm.highEstimate, y: r.out.hammer })));
    score("  Stage 3a", sub.map((r) => ({ pred: r.shadow.medianGBP, lo: r.shadow.lowGBP, hi: r.shadow.highGBP, y: r.out.hammer })));
  }
  console.log(`\n── Every run ──`);
  for (const r of rows) {
    const h = r.out?.sold ? `hammer ${r.out.hammer}` : r.out ? (r.out.date ? "unsold" : "not yet sold") : "no graph record";
    const s = r.shadow ? `3a ${r.shadow.lowGBP}-${r.shadow.highGBP} (med ${r.shadow.medianGBP}, ${r.shadow.evidenceTier})` : "3a none";
    const l = r.llm ? `LLM ${r.llm.lowEstimate}-${r.llm.highEstimate}` : "LLM none";
    console.log(`  ${r.d.padEnd(34)} ${h.padEnd(16)} ${l.padEnd(16)} ${s.padEnd(52)} printed ${r.claim?.estimateLow ?? "?"}-${r.claim?.estimateHigh ?? "?"}  ${r.claim?.artist ?? ""} — ${(r.claim?.title ?? "").slice(0, 40)}`);
  }
  await closeDriver();
}
main();
