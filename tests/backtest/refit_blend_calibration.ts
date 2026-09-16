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

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VERSION = arg("version", "BLEND-1.3")!;
const SPLIT = arg("split", "2024-07-01")!;
const OUT = arg("out", "knowledge_graph/pricing_ml/blend/calibration.json")!;
const D = "tests/backtest/comps_hammer";

async function main() {
  const build = loadPriorsBuild()!;
  const means = JSON.parse(readFileSync(`${STAGE3A_PRIORS_DIR}/column_means.json`, "utf8"));
  const offsets: HouseOffsets = { ...JSON.parse(readFileSync("knowledge_graph/pricing_ml/blend/house_offsets.json", "utf8")), timeAdjust: "prior_year" };
  const policy = { columnMeans: means.columns, premium: DEFAULT_PROOF_PREMIUM };
  const profiles = new Map<string, ArtistPriceProfile | null>();
  const rows: { r: any; fit: FitRow; area: number | null; proof: string }[] = [];
  for (const f of ["forum", "roseberys", "bonhams"]) for (const l of readFileSync(`${D}/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (!(r.sold && r.hammer > 0 && r.blend && r.canonicalArtist && !r.error)) continue;
    if (!profiles.has(r.canonicalArtist)) profiles.set(r.canonicalArtist, await queryArtistPriceProfileFromFile(r.canonicalArtist));
    const profile = profiles.get(r.canonicalArtist)!;
    const claim: any = { artist: r.artist, title: r.title, medium: r.medium, editionNote: r.editionNote, editionSize: r.editionSize, signed: r.signed, dimensions: r.widthCm && r.heightCm ? [{ kind: "sheet", widthCm: r.widthCm, heightCm: r.heightCm }] : null };
    const attrs = attrsValues(lotAttrsWithSources({ claim }));
    const pred = profile ? priorsModelPrediction(attrs, profile, { saleDate: r.saleDate, house: r.blend.inputs.targetHouse, proofPolicy: policy }) : null;
    const inputs: BlendInputs = { ...r.blend.inputs, estimate: null, priors: pred && profile ? { mu: pred.mu, basis: profile.basis, earlierSales: profile.earlierSales, contributions: pred.contributions } : null };
    rows.push({ r, fit: { inputs, hammerGBP: r.hammer }, area: attrs.areaCm2 ?? null, proof: attrs.proof ?? "unknown" });
  }
  const basis = [...profiles.values()].reduce((t, p) => { const k = p?.basis ?? "none"; t[k] = (t[k] ?? 0) + 1; return t; }, {} as Record<string, number>);
  console.log(`model file ${build.version} (${build.built_at}); ${rows.length} sold lots, ${profiles.size} artists by basis ${JSON.stringify(basis)}`);

  // 1. temporal gate
  const early = rows.filter((x) => x.r.saleDate < SPLIT), late = rows.filter((x) => x.r.saleDate >= SPLIT);
  const gateCal = fitBlendCalibration(early.map((x) => x.fit), { version: `${VERSION}-gate`, fittedOn: `lots before ${SPLIT}`, df: 5, houseOffsets: offsets });
  const score = (sub: typeof rows) => {
    let n = 0, mae = 0, geo = 0, cover = 0;
    for (const x of sub) {
      const b = blendPrices(x.fit.inputs, gateCal, "no_estimate"); if (!b) continue;
      const y = Math.log(x.r.hammer), e = Math.log(b.medianGBP) - y;
      n++; mae += Math.abs(e); geo += e; if (y >= Math.log(b.p10GBP) && y <= Math.log(b.p90GBP)) cover++;
    }
    return `n=${String(n).padStart(4)}  MAE(log) ${(mae / n).toFixed(3)}  80% cover ${(100 * cover / n).toFixed(0)}%  geo x${Math.exp(geo / n).toFixed(2)}`;
  };
  const size = (a: number | null) => a == null ? "size unknown" : a < 400 ? "under 400 cm²" : a < 1800 ? "400-1,800 cm²" : a < 7500 ? "1,800-7,500 cm²" : "over 7,500 cm²";
  console.log(`\nTemporal gate: fit on ${early.length} lots before ${SPLIT}, score ${late.length} after`);
  console.log(`  all                     ${score(late)}`);
  for (const h of [...new Set(late.map((x) => x.r.blend.inputs.targetHouse))].sort()) console.log(`  ${h.padEnd(24)}${score(late.filter((x) => x.r.blend.inputs.targetHouse === h))}`);
  for (const s of ["under 400 cm²", "400-1,800 cm²", "1,800-7,500 cm²", "over 7,500 cm²", "size unknown"]) console.log(`  ${s.padEnd(24)}${score(late.filter((x) => size(x.area) === s))}`);
  console.log(`  ${"proofs (AP/HC/trial)".padEnd(24)}${score(late.filter((x) => isPolicyProof(x.proof)))}`);

  // 2. production fit on every lot
  const cal = fitBlendCalibration(rows.map((x) => x.fit), { version: VERSION, fittedOn: `all ${rows.length} sold lots (forum, roseberys, bonhams), priors ${build.version}@${build.built_at}, offline refit`, df: 5, houseOffsets: offsets });
  writeFileSync(OUT, JSON.stringify(cal, null, 2) + "\n");
  const r = cal.regimes.no_estimate;
  console.log(`\n${VERSION} written to ${OUT}: weights ${JSON.stringify(r.weights)}, temperature ${r.temperature} by tier ${JSON.stringify(r.temperatureByTier)}, fit MAE ${r.fitMaeLog.toFixed(3)}, cover ${(100 * r.fitCoverage80).toFixed(0)}%`);
  await closeDriver();
}
main();
