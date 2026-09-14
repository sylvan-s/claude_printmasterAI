/**
 * Plan step 9 — does the house's printed estimate follow from provenance and comps alone, and
 * what's left over: the "house incentives" node in the causal chain
 *
 *     provenance/priors ─┐
 *                        ├──→ house estimate ──→ hammer
 *     market comps ───────┘         ↑
 *     house incentives (latent) ────┘
 *
 * Fits `log(estimate midpoint) ~ same-work comps + tier comps + priors model` — no house term —
 * on the `--blend` runs from comps_hammer_backtest.ts (all lots with an estimate, sold or not:
 * the target here is the estimate, which exists pre-sale), then reads the residual by house.
 * That residual is the closest measurable proxy for house-specific estimate-setting behaviour,
 * net of the mechanical effect of one house's lots having stronger or weaker comps to work
 * from. It cannot separate "deliberate shading to draw bidders" from "genuine difference in
 * segment skill" — that is a real identification limit, named here rather than papered over.
 *
 * Three checks:
 *   1. Fit pooled (no house term), residual by house — the headline number.
 *   2. Fit on one house, score residual-by-house on both — does the SAME estimate-setting
 *      relationship (the coefficients, not just the level) transfer across houses, or does the
 *      house reweight the same evidence differently?
 *   3. Compare the estimate-side residual to the already-known hammer/estimate ratio by house,
 *      computed here directly from the same sold lots — are these the same signal (the house
 *      shades every estimate down by a flat amount) or different ones (the house's estimate
 *      already reflects provenance+comps correctly, and the hammer/estimate gap is bidder
 *      behaviour, not estimate-setting behaviour)?
 *
 *   npm run backtest:estimate-residual -- --a tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl --b tests/backtest/comps_hammer/forum_n2500_blend.jsonl
 */
import { readFileSync } from "node:fs";
import {
  estimateFeaturesOf,
  fitEstimateModel,
  predictLogEstimate,
  residualsByHouse,
  ESTIMATE_MODEL_COLUMNS,
  type EstimateFeatures,
} from "../../src/appraisal/knowledge_graph/estimate_model";
import type { BlendInputs } from "../../src/appraisal/knowledge_graph/price_blend";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const FILE_A = arg("a", "tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl");
const FILE_B = arg("b", "tests/backtest/comps_hammer/forum_n2500_blend.jsonl");
const ALPHA = Number(arg("alpha", "1.0"));

const ln = Math.log;
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "  n/a");
const mult = (x: number) => (Number.isFinite(x) ? `x${Math.exp(x).toFixed(2)}` : "n/a");

interface Row { key: string; sold: boolean; hammer: number | null; lowEst: number; highEst: number; error?: string; blend?: { inputs: BlendInputs } | null; canonicalArtist?: string | null; artist: string }
interface Rich { features: EstimateFeatures; logEstimateMid: number; house: string; artist: string; hammer: number | null; sold: boolean }

function load(path: string, house: string): Rich[] {
  const out: Rich[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as Row;
    if (r.error || !r.blend) continue;
    const i = r.blend.inputs;
    if (!i.estimate || i.estimate.lowGBP <= 0 || i.estimate.highGBP <= 0) continue;
    out.push({
      features: estimateFeaturesOf(i), logEstimateMid: ln((i.estimate.lowGBP + i.estimate.highGBP) / 2),
      house, artist: r.canonicalArtist ?? r.artist, hammer: r.hammer, sold: r.sold,
    });
  }
  return out;
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Artist-clustered bootstrap CI on a scalar computed by `stat` over a row set. */
function bootstrapCI(rows: Rich[], stat: (rs: Rich[]) => number, draws = 500): [number, number] {
  const byArtist = new Map<string, Rich[]>();
  for (const r of rows) (byArtist.get(r.artist) ?? byArtist.set(r.artist, []).get(r.artist)!).push(r);
  const clusters = [...byArtist.values()];
  let seed = 17; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const vals: number[] = [];
  for (let b = 0; b < draws; b++) {
    const sample: Rich[] = []; for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rnd() * clusters.length)]);
    vals.push(stat(sample));
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * (vals.length - 1))], vals[Math.floor(0.975 * (vals.length - 1))]];
}

function reportResiduals(label: string, rows: Rich[], model: ReturnType<typeof fitEstimateModel>) {
  console.log(`\n── ${label} ──`);
  console.log(`  columns: ${model.columns.map((c, i) => `${c}=${model.coef[i].toFixed(3)}`).join("  ")}`);
  const res = residualsByHouse(rows, model);
  for (const r of res) {
    const rowsForHouse = rows.filter((x) => x.house === r.house);
    const [lo, hi] = bootstrapCI(rowsForHouse, (rs) => median(rs.map((x) => x.logEstimateMid - predictLogEstimate(x.features, model))));
    console.log(`  ${r.house.padEnd(12)} n=${String(r.n).padStart(5)}  median residual ${r.medianResidual >= 0 ? "+" : ""}${f3(r.medianResidual)} (${mult(r.medianResidual)})  95% CI [${f3(lo)}, ${f3(hi)}]  MAD ${f3(r.madResidual)}`);
  }
}

function main() {
  const rows = [...load(FILE_A, "A"), ...load(FILE_B, "B")];
  console.log(`loaded ${rows.length} lots with an estimate + blend inputs (A=${FILE_A}: ${rows.filter((r) => r.house === "A").length}, B=${FILE_B}: ${rows.filter((r) => r.house === "B").length})`);
  const withEvidence = rows.filter((r) => r.features.row.slice(1).some((x) => x !== 0));
  console.log(`  of these, ${withEvidence.length} have at least one non-estimate witness (comps or priors) to explain the estimate from`);

  // 1. Pooled fit, no house term -> residual by house (the headline number).
  const pooled = fitEstimateModel(rows, ALPHA);
  reportResiduals("1. Pooled fit (no house term) — residual by house", rows, pooled);

  // 2. Cross-house transfer: does the SAME coefficient vector explain the other house's estimates?
  const A = rows.filter((r) => r.house === "A"), B = rows.filter((r) => r.house === "B");
  const modelA = fitEstimateModel(A, ALPHA), modelB = fitEstimateModel(B, ALPHA);
  console.log(`\n── 2. Cross-house transfer: fit on one house, read the coefficients and the other house's residual ──`);
  console.log(`  fit on A: ${modelA.columns.map((c, i) => `${c}=${modelA.coef[i].toFixed(3)}`).join("  ")}`);
  console.log(`  fit on B: ${modelB.columns.map((c, i) => `${c}=${modelB.coef[i].toFixed(3)}`).join("  ")}`);
  reportResiduals("   model fit on A, scored on both", rows, modelA);
  reportResiduals("   model fit on B, scored on both", rows, modelB);

  // 3. Compare to the already-known hammer/estimate ratio by house, computed here directly.
  console.log(`\n── 3. Estimate-side residual vs the hammer/estimate gap (sold lots, same rows) ──`);
  for (const [label, rs] of [["A", A], ["B", B]] as const) {
    const sold = rs.filter((r) => r.sold && r.hammer && r.hammer > 0);
    const hammerRatio = median(sold.map((r) => ln(r.hammer! / Math.exp(r.logEstimateMid))));
    const res = residualsByHouse(rs, pooled)[0];
    console.log(`  house ${label}: hammer/estimate-mid median ${f3(hammerRatio)} (${mult(hammerRatio)}, n=${sold.length} sold)   |   estimate-side residual (pooled model) ${res.medianResidual >= 0 ? "+" : ""}${f3(res.medianResidual)} (${mult(res.medianResidual)})`);
  }
  console.log(`\n  If these two numbers per house point the same direction and are similar in size, the hammer/estimate`);
  console.log(`  gap is mostly explained by how the house sets its estimate (estimate-setting behaviour). If they diverge`);
  console.log(`  or point opposite ways, the hammer/estimate gap is coming from bidder behaviour at auction instead —`);
  console.log(`  a house whose estimates track provenance+comps correctly (residual near 0) can still see hammer land`);
  console.log(`  well above or below its own estimate, and that gap belongs to buyers, not to the house.`);
}

main();
