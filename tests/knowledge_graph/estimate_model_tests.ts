/**
 * Pure-function tests for estimate_model.ts. No graph, no randomness.
 *
 *   npm run test:estimate-model
 */
import {
  estimateFeaturesOf,
  fitEstimateModel,
  predictLogEstimate,
  residualsByHouse,
  ESTIMATE_MODEL_COLUMNS,
  type EstimateFitRow,
} from "../../src/appraisal/knowledge_graph/estimate_model";
import type { BlendInputs } from "../../src/appraisal/knowledge_graph/price_blend";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
function close(label: string, got: number, want: number, tol = 1e-6) {
  if (Math.abs(got - want) <= tol * Math.max(1, Math.abs(want))) passed++;
  else { failed++; console.log(`  FAIL ${label}\n       got  ${got}\n       want ${want}`); }
}
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }

const LN = Math.log;
const ln = Math.log;
const inputs = (over: Partial<BlendInputs> = {}): BlendInputs => ({
  saleDate: "2024-03-01", house: "roseberys", estimate: { lowGBP: 800, highGBP: 1200 },
  sameWork: [], sameArtistTechnique: null, sameArtist: null, priors: null, sellThrough: null, recentSameHouseAppearance: null, ...over,
});

// ── estimateFeaturesOf ───────────────────────────────────────────────────────
{
  eq("no evidence, no recent appearance: intercept only, everything else 0", estimateFeaturesOf(inputs()).row, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const f = estimateFeaturesOf(inputs({ sameWork: [{ hammerGBP: 500, saleDate: null }], priors: { mu: LN(600), basis: "shrunk", earlierSales: 20, contributions: [] } }));
  eq("columns line up with ESTIMATE_MODEL_COLUMNS", ESTIMATE_MODEL_COLUMNS, ["intercept", "same_work_present", "same_work_value", "same_artist_technique_present", "same_artist_technique_value", "same_artist_present", "same_artist_value", "priors_model_present", "priors_model_value", "recent_unsold_present", "recent_unsold_log_days", "recent_sold_present", "recent_sold_log_days"]);
  close("same_work value is the log of the (single) comp", f.row[2], LN(500));
  eq("same_work present flag set", f.row[1], 1);
  eq("tier 2/3 absent", [f.row[3], f.row[5]], [0, 0]);
  close("priors value is its raw mu", f.row[8], LN(600));
  eq("no recent-appearance data: all four recency columns 0 (reference level)", f.row.slice(9), [0, 0, 0, 0]);
}

// ── recentSameHouseAppearance -> the recency present/value pairs ───────────────────────────────
{
  const u = estimateFeaturesOf(inputs({ recentSameHouseAppearance: { sold: false, daysAgo: 90 } }));
  eq("unsold recent appearance sets recent_unsold_present, not recent_sold_present", [u.row[9], u.row[11]], [1, 0]);
  close("recent_unsold_log_days is log(daysAgo+1)", u.row[10], LN(91));
  eq("recent_sold_log_days is 0 when the appearance was unsold", u.row[12], 0);
  const s = estimateFeaturesOf(inputs({ recentSameHouseAppearance: { sold: true, daysAgo: 400 } }));
  eq("sold recent appearance sets recent_sold_present, not recent_unsold_present", [s.row[9], s.row[11]], [0, 1]);
  close("recent_sold_log_days is log(daysAgo+1)", s.row[12], LN(401));
  eq("recent_unsold_log_days is 0 when the appearance sold", s.row[10], 0);
  const zero = estimateFeaturesOf(inputs({ recentSameHouseAppearance: { sold: false, daysAgo: 0 } }));
  close("daysAgo=0 (sold same day, edge case) still gives a finite log", zero.row[10], LN(1));
}

// ── does the fit recover a planted recency effect on the ESTIMATE? ─────────────────────────────
{
  let seed = 23; const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
  // Planted truth: log(estimate) = 5 + 0.5*priors_value, MINUS a discount that fades with time
  // since an unsold same-house appearance: -0.5 at daysAgo=0 decaying toward 0 as ln(days+1)
  // grows (coefficient +0.08 on recent_unsold_log_days, i.e. recovers roughly -0.36 at 180 days
  // and -0.15 at 365 — the shape relist_discount_report.ts measured). No effect planted for a
  // recent SOLD appearance (both its coefficients should come out near 0).
  const rows: { features: ReturnType<typeof estimateFeaturesOf>; logEstimateMid: number }[] = [];
  for (let i = 0; i < 900; i++) {
    const prVal = 5 + (i % 17) * 0.1;
    const kind = i % 3; // 0 = no history, 1 = recent unsold, 2 = recent sold
    const daysAgo = 5 + (i % 12) * 60; // spread from ~5 to ~665 days
    const recentSameHouseAppearance = kind === 0 ? null : kind === 1 ? { sold: false, daysAgo } : { sold: true, daysAgo };
    const inp = inputs({ priors: { mu: prVal, basis: "shrunk", earlierSales: 20, contributions: [] }, recentSameHouseAppearance });
    const features = estimateFeaturesOf(inp);
    const penalty = kind === 1 ? -0.5 + 0.08 * ln(daysAgo + 1) : 0;
    const y = 5 + 0.5 * prVal + penalty + 0.03 * noise();
    rows.push({ features, logEstimateMid: y });
  }
  const model = fitEstimateModel(rows, 0.01);
  const upCol = ESTIMATE_MODEL_COLUMNS.indexOf("recent_unsold_present"), udCol = ESTIMATE_MODEL_COLUMNS.indexOf("recent_unsold_log_days");
  const spCol = ESTIMATE_MODEL_COLUMNS.indexOf("recent_sold_present"), sdCol = ESTIMATE_MODEL_COLUMNS.indexOf("recent_sold_log_days");
  close("recovers the planted recent_unsold level shift", model.coef[upCol], -0.5, 0.1);
  close("recovers the planted recent_unsold decay-with-time slope", model.coef[udCol], 0.08, 0.03);
  close("recent_sold_present comes out near 0 (no effect planted)", model.coef[spCol], 0, 0.1);
  close("recent_sold_log_days comes out near 0 (no effect planted)", model.coef[sdCol], 0, 0.03);
  const predAt = (days: number) => model.coef[upCol] + model.coef[udCol] * ln(days + 1);
  ok("the recovered discount shrinks toward 0 as days-ago grows, as planted", predAt(5) < predAt(180) && predAt(180) < predAt(665));
}

// ── fitEstimateModel / predictLogEstimate: recovers a known linear relationship ───────────────
{
  let seed = 3; const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
  // Planted truth: log(estimate) = 4 + 0.6*same_work_value (when present) + 0.3*priors_value (when present) + small noise.
  const rows: { features: ReturnType<typeof estimateFeaturesOf>; logEstimateMid: number }[] = [];
  for (let i = 0; i < 400; i++) {
    const hasSW = i % 2 === 0, hasPriors = i % 3 !== 0;
    const swVal = 5 + (i % 20) * 0.1, prVal = 4.5 + (i % 13) * 0.1;
    const inp = inputs({ sameWork: hasSW ? [{ hammerGBP: Math.exp(swVal), saleDate: null }] : [], priors: hasPriors ? { mu: prVal, basis: "shrunk", earlierSales: 20, contributions: [] } : null });
    const features = estimateFeaturesOf(inp);
    const y = 4 + (hasSW ? 0.6 * swVal : 0) + (hasPriors ? 0.3 * prVal : 0) + 0.05 * noise();
    rows.push({ features, logEstimateMid: y });
  }
  const model = fitEstimateModel(rows, 0.01);
  const iCol = ESTIMATE_MODEL_COLUMNS.indexOf("intercept"), swCol = ESTIMATE_MODEL_COLUMNS.indexOf("same_work_value"), prCol = ESTIMATE_MODEL_COLUMNS.indexOf("priors_model_value");
  close("recovers the planted intercept", model.coef[iCol], 4, 0.05);
  close("recovers the planted same_work coefficient", model.coef[swCol], 0.6, 0.05);
  close("recovers the planted priors coefficient", model.coef[prCol], 0.3, 0.05);
  const pred = rows.map((r) => predictLogEstimate(r.features, model));
  const mae = pred.reduce((t, p, i) => t + Math.abs(p - rows[i].logEstimateMid), 0) / rows.length;
  ok("prediction error is close to the noise floor", mae < 0.06);
}

// ── residualsByHouse ─────────────────────────────────────────────────────────
{
  // Same generative model for both houses, but house B's estimates run systematically +0.4 high.
  let seed = 11; const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
  const model = fitEstimateModel([{ features: estimateFeaturesOf(inputs({ priors: { mu: 5, basis: "shrunk", earlierSales: 10, contributions: [] } })), logEstimateMid: 5 }], 0.01);
  // Force a simple, known model instead of fitting: predict = priors value directly.
  const known = { ...model, coef: model.columns.map((c) => (c === "priors_model_value" ? 1 : 0)) };
  const fitRows: { features: ReturnType<typeof estimateFeaturesOf>; logEstimateMid: number; house: string }[] = [];
  for (let i = 0; i < 200; i++) {
    const prVal = 5 + 0.02 * i;
    const inpA = inputs({ house: "A", priors: { mu: prVal, basis: "shrunk", earlierSales: 10, contributions: [] } });
    const inpB = inputs({ house: "B", priors: { mu: prVal, basis: "shrunk", earlierSales: 10, contributions: [] } });
    fitRows.push({ features: estimateFeaturesOf(inpA), logEstimateMid: prVal + 0.02 * noise(), house: "A" });
    fitRows.push({ features: estimateFeaturesOf(inpB), logEstimateMid: prVal + 0.4 + 0.02 * noise(), house: "B" });
  }
  const res = residualsByHouse(fitRows, known);
  const byHouse = Object.fromEntries(res.map((r) => [r.house, r]));
  close("house A residual near 0", byHouse.A.medianResidual, 0, 0.05);
  close("house B residual recovers the planted +0.4 offset", byHouse.B.medianResidual, 0.4, 0.05);
  eq("n per house", [byHouse.A.n, byHouse.B.n], [200, 200]);
  ok("MAD is small relative to the planted gap (a real signal, not noise)", byHouse.B.madResidual < 0.1);
}

console.log(`\nestimate_model tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
