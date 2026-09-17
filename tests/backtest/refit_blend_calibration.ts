/**
 * Refit the Stage 3a blend calibration from the committed model file (2026-09-16: Stage 3a adopted
 * the shape-bands + extra-large size model, read from knowledge_graph/pricing_ml/priors_stage3a,
 * with no graph write). Zero LLM. The graph is only READ, for artist names, nationality and birth
 * year when an artist has no own entry in the model file.
 *
 * Each backtest lot's pricing-model witness is rebuilt the way live Stage 3a builds it: attributes
 * from the catalogue fields through lotAttrsWithSources (the ingests' copy type, text dimensions,
 * graph technique vocabulary), the file-based artist profile, the proof policy. The comps
 * witnesses are the harness's recorded ones. Then:
 *   1. the temporal gate: fit on lots sold before --split, score after (overall, per house, per size);
 *   2. the production fit on every lot, written to --out (default blend/calibration.json).
 *
 *   npx tsx tests/backtest/refit_blend_calibration.ts --version BLEND-1.3
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDriver, priorsModelPrediction, fitBlendCalibration, blendPrices, isPolicyProof, DEFAULT_PROOF_PREMIUM, type BlendInputs, type FitRow } from "../../src/appraisal/knowledge_graph/index";
import type { HouseOffsets } from "../../src/appraisal/knowledge_graph/price_blend";
import type { ArtistPriceProfile } from "../../src/appraisal/knowledge_graph/artist_price_profile";
import { queryArtistPriceProfileFromFile, loadPriorsBuild, STAGE3A_PRIORS_DIR } from "../../src/appraisal/knowledge_graph/file_price_profile";
import { lotAttrsWithSources, attrsValues } from "../../src/appraisal/valuation_evidence";
import { fxLogShift } from "../../src/appraisal/knowledge_graph/fx_series";
import { compCurrencyKey } from "./extract_comp_currency";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VERSION = arg("version", "BLEND-1.3")!;
const SPLIT = arg("split", "2024-07-01")!;
const OUT = arg("out", "knowledge_graph/pricing_ml/blend/calibration.json")!;
const D = "tests/backtest/comps_hammer";
/** Same-suite comps per lot (extract_suite_comps.ts). Given: the blend gets a same_suite witness. */
const SUITE = arg("suite");
/** House offsets and year index (house_offsets.py output). */
const OFFSETS = arg("offsets", "knowledge_graph/pricing_ml/blend/house_offsets.json")!;
/** Re-price non-sterling comps at the lot's sale-date rate (currency from extract_comp_currency.ts). */
const FX = argv.includes("--fx-reconvert");
/** Calibrate the pricing-model witness against the house mid estimate (fair-price scale) instead of the hammer; comps stay on hammers. */
const PRIORS_OUTCOME = (arg("priors-outcome", "estimate") as "hammer" | "estimate");
/** Report only; write no calibration. */
const DRY = argv.includes("--dry");

async function main() {
  const build = loadPriorsBuild()!;
  const means = JSON.parse(readFileSync(`${STAGE3A_PRIORS_DIR}/column_means.json`, "utf8"));
  const offsets: HouseOffsets = { ...JSON.parse(readFileSync(OFFSETS, "utf8")), timeAdjust: "prior_year", ...(FX ? { fxReconvert: true } : {}) };
  // Currency is always annotated (so reports can group by it); only --fx-reconvert applies the shift.
  const currencyOf: Record<string, string> = JSON.parse(readFileSync("tests/backtest/comps_hammer/comp_currency.json", "utf8")).keys;
  const fxCount = { comps: 0, foreign: 0, shiftAbs: 0 };
  const withFx = <T extends { hammerGBP: number; saleDate: string | null; house?: string | null }>(cs: T[] | undefined, valuationDate: string): T[] | undefined => {
    if (!cs) return cs;
    return cs.map((c) => {
      const currency = currencyOf[compCurrencyKey(c.house, c.saleDate, c.hammerGBP)] ?? "GBP";
      const shift = fxLogShift(currency, c.saleDate, valuationDate);
      fxCount.comps++; if (currency !== "GBP") { fxCount.foreign++; fxCount.shiftAbs += Math.abs(shift); }
      return { ...c, currency, fxLogShift: shift };
    });
  };
  console.log(`house offsets ${OFFSETS} (year index: ${(offsets as any).yearIndexCurrency ?? "all"})`);
  const policy = { columnMeans: means.columns, premium: DEFAULT_PROOF_PREMIUM };
  const profiles = new Map<string, ArtistPriceProfile | null>();
  const rows: { r: any; fit: FitRow; area: number | null; proof: string; suite: number }[] = [];
  const suiteByKey = new Map<string, any[]>(SUITE ? readFileSync(SUITE, "utf8").split("\n").filter(Boolean).map((l) => { const x = JSON.parse(l); return [x.key, x.comps] as [string, any[]]; }) : []);
  for (const f of ["forum", "roseberys", "bonhams"]) for (const l of readFileSync(`${D}/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (!(r.sold && r.hammer > 0 && r.blend && r.canonicalArtist && !r.error)) continue;
    if (!profiles.has(r.canonicalArtist)) profiles.set(r.canonicalArtist, await queryArtistPriceProfileFromFile(r.canonicalArtist));
    const profile = profiles.get(r.canonicalArtist)!;
    const claim: any = { artist: r.artist, title: r.title, medium: r.medium, editionNote: r.editionNote, editionSize: r.editionSize, signed: r.signed, dimensions: r.widthCm && r.heightCm ? [{ kind: "sheet", widthCm: r.widthCm, heightCm: r.heightCm }] : null };
    const attrs = attrsValues(lotAttrsWithSources({ claim }));
    const pred = profile ? priorsModelPrediction(attrs, profile, { saleDate: r.saleDate, house: r.blend.inputs.targetHouse, proofPolicy: policy }) : null;
    const suite = (suiteByKey.get(r.key) ?? []).map((c: any) => ({ hammerGBP: c.hammerGBP, saleDate: c.saleDate, house: c.house }));
    const bi = r.blend.inputs;
    const fxInputs = {
      sameWork: withFx(bi.sameWork, r.saleDate)!,
      sameArtistTechnique: bi.sameArtistTechnique ? { ...bi.sameArtistTechnique, comps: withFx(bi.sameArtistTechnique.comps, r.saleDate) } : null,
      sameArtist: bi.sameArtist ? { ...bi.sameArtist, comps: withFx(bi.sameArtist.comps, r.saleDate) } : null,
    };
    const inputs: BlendInputs = { ...bi, ...fxInputs, estimate: null, priors: pred && profile ? { mu: pred.mu, basis: profile.basis, earlierSales: profile.earlierSales, contributions: pred.contributions } : null, ...(SUITE ? { sameSuite: withFx(suite, r.saleDate) } : {}) };
    const est = bi.estimate;
    const mid = est && est.lowGBP > 0 && est.highGBP > 0 ? (est.lowGBP + est.highGBP) / 2 : null;
    rows.push({ r, fit: { inputs, hammerGBP: r.hammer, estimateMidGBP: mid }, area: attrs.areaCm2 ?? null, proof: attrs.proof ?? "unknown", suite: suite.length });
  }
  const basis = [...profiles.values()].reduce((t, p) => { const k = p?.basis ?? "none"; t[k] = (t[k] ?? 0) + 1; return t; }, {} as Record<string, number>);
  console.log(`fx re-pricing ${FX ? "ON" : "off"}: ${fxCount.foreign} of ${fxCount.comps} comps non-sterling, mean |shift| ${(fxCount.shiftAbs / Math.max(fxCount.foreign, 1)).toFixed(3)} log`);
  console.log(`model file ${build.version} (${build.built_at}); ${rows.length} sold lots, ${profiles.size} artists by basis ${JSON.stringify(basis)}`);

  // 1. temporal gate
  const early = rows.filter((x) => x.r.saleDate < SPLIT), late = rows.filter((x) => x.r.saleDate >= SPLIT);
  const gateCal = fitBlendCalibration(early.map((x) => x.fit), { version: `${VERSION}-gate`, fittedOn: `lots before ${SPLIT}`, df: 5, houseOffsets: offsets, priorsOutcome: PRIORS_OUTCOME });
  console.log(`pricing-model witness calibrated against: ${PRIORS_OUTCOME === "estimate" ? "house mid estimate" : "hammer"}; comps against hammer`);
  const score = (sub: typeof rows) => {
    let n = 0, mae = 0, geo = 0, cover = 0, ne = 0, maeE = 0, geoE = 0, coverE = 0;
    for (const x of sub) {
      const b = blendPrices(x.fit.inputs, gateCal, "no_estimate"); if (!b) continue;
      const y = Math.log(x.r.hammer), e = Math.log(b.medianGBP) - y;
      n++; mae += Math.abs(e); geo += e; if (y >= Math.log(b.p10GBP) && y <= Math.log(b.p90GBP)) cover++;
      if (x.fit.estimateMidGBP) {
        const ye = Math.log(x.fit.estimateMidGBP), ee = Math.log(b.medianGBP) - ye;
        ne++; maeE += Math.abs(ee); geoE += ee; if (ye >= Math.log(b.p10GBP) && ye <= Math.log(b.p90GBP)) coverE++;
      }
    }
    return `n=${String(n).padStart(4)}  hammer: MAE(log) ${(mae / n).toFixed(3)} cover ${(100 * cover / n).toFixed(0)}% geo x${Math.exp(geo / n).toFixed(2)}  | mid estimate: MAE(log) ${(maeE / ne).toFixed(3)} cover ${(100 * coverE / ne).toFixed(0)}% geo x${Math.exp(geoE / ne).toFixed(2)}`;
  };
  const size = (a: number | null) => a == null ? "size unknown" : a < 400 ? "under 400 cm²" : a < 1800 ? "400-1,800 cm²" : a < 7500 ? "1,800-7,500 cm²" : "over 7,500 cm²";
  console.log(`\nTemporal gate: fit on ${early.length} lots before ${SPLIT}, score ${late.length} after`);
  console.log(`  all                     ${score(late)}`);
  for (const h of [...new Set(late.map((x) => x.r.blend.inputs.targetHouse))].sort()) console.log(`  ${h.padEnd(24)}${score(late.filter((x) => x.r.blend.inputs.targetHouse === h))}`);
  for (const s of ["under 400 cm²", "400-1,800 cm²", "1,800-7,500 cm²", "over 7,500 cm²", "size unknown"]) console.log(`  ${s.padEnd(24)}${score(late.filter((x) => size(x.area) === s))}`);
  console.log(`  ${"proofs (AP/HC/trial)".padEnd(24)}${score(late.filter((x) => isPolicyProof(x.proof)))}`);
  // Comp age drives how much the year index moves a lot's comps.
  const compAge = (x: (typeof rows)[number]) => {
    const i = x.fit.inputs, ages = [...i.sameWork, ...(i.sameSuite ?? []), ...(i.sameArtistTechnique?.comps ?? []), ...(i.sameArtist?.comps ?? [])]
      .filter((c) => c.saleDate).map((c) => Number(x.r.saleDate.slice(0, 4)) - Number(c.saleDate!.slice(0, 4))).sort((a, b) => a - b);
    return ages.length ? ages[ages.length >> 1] : null;
  };
  console.log(`  ${"median comp age <3y".padEnd(24)}${score(late.filter((x) => (compAge(x) ?? -1) >= 0 && compAge(x)! < 3))}`);
  console.log(`  ${"median comp age 3-5y".padEnd(24)}${score(late.filter((x) => (compAge(x) ?? -1) >= 3 && compAge(x)! < 6))}`);
  console.log(`  ${"median comp age 6y+".padEnd(24)}${score(late.filter((x) => (compAge(x) ?? -1) >= 6))}`);
  {
    const foreign = (x: (typeof rows)[number]) => {
      const i = x.fit.inputs, cs = [...i.sameWork, ...(i.sameSuite ?? []), ...(i.sameArtistTechnique?.comps ?? []), ...(i.sameArtist?.comps ?? [])];
      return cs.length ? cs.filter((c) => c.currency && c.currency !== "GBP").length / cs.length : 0;
    };
    console.log(`  ${"comps 25%+ non-sterling".padEnd(24)}${score(late.filter((x) => foreign(x) >= 0.25))}`);
    console.log(`  ${"  ...and median age 3y+".padEnd(24)}${score(late.filter((x) => foreign(x) >= 0.25 && (compAge(x) ?? -1) >= 3))}`);
  }
  if (suiteByKey.size || argv.includes("--suite-groups")) {
    const suiteKeys = new Set([...(suiteByKey.size ? suiteByKey : new Map(readFileSync(arg("suite-groups")!, "utf8").split("\n").filter(Boolean).map((l) => { const x = JSON.parse(l); return [x.key, x.comps]; }))).entries()].filter(([, c]) => (c as any[]).length).map(([k]) => k));
    console.log(`  ${"lots with suite comps".padEnd(24)}${score(late.filter((x) => suiteKeys.has(x.r.key)))}`);
    console.log(`  ${"  ...and no same-work".padEnd(24)}${score(late.filter((x) => suiteKeys.has(x.r.key) && !x.fit.inputs.sameWork.length))}`);
  }

  // 2. production fit on every lot
  if (DRY) { console.log(`\n--dry: no calibration written; gate weights ${JSON.stringify(gateCal.regimes.no_estimate.weights)}, same_suite keys ${JSON.stringify(gateCal.witnesses.same_suite?.byKey ?? {})}`); await closeDriver(); return; }
  const cal = fitBlendCalibration(rows.map((x) => x.fit), { version: VERSION, fittedOn: `all ${rows.length} sold lots (forum, roseberys, bonhams), priors ${build.version}@${build.built_at}, offline refit; pricing-model witness calibrated to ${PRIORS_OUTCOME === "estimate" ? "house mid estimates" : "hammers"}, comps to hammers`, df: 5, houseOffsets: offsets, priorsOutcome: PRIORS_OUTCOME });
  writeFileSync(OUT, JSON.stringify(cal, null, 2) + "\n");
  const r = cal.regimes.no_estimate;
  console.log(`\n${VERSION} written to ${OUT}: weights ${JSON.stringify(r.weights)}, temperature ${r.temperature} by tier ${JSON.stringify(r.temperatureByTier)}, fit MAE ${r.fitMaeLog.toFixed(3)}, cover ${(100 * r.fitCoverage80).toFixed(0)}%`);
  await closeDriver();
}
main();
