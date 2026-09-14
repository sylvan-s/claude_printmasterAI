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
  liquidityLimb,
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
const inputs = (over: Partial<BlendInputs> = {}): BlendInputs => ({
  saleDate: "2024-03-01", house: "roseberys", estimate: { lowGBP: 800, highGBP: 1200 },
  sameWork: [], sameArtistTechnique: null, sameArtist: null, priors: null, sellThrough: null, ...over,
});

// ── estimateFeaturesOf ───────────────────────────────────────────────────────
{
  eq("no evidence, no sell-through: intercept only, everything else 0", estimateFeaturesOf(inputs()).row, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const f = estimateFeaturesOf(inputs({ sameWork: [{ hammerGBP: 500, saleDate: null }], priors: { mu: LN(600), basis: "shrunk", earlierSales: 20, contributions: [] } }));
  eq("columns line up with ESTIMATE_MODEL_COLUMNS", ESTIMATE_MODEL_COLUMNS, ["intercept", "same_work_present", "same_work_value", "same_artist_technique_present", "same_artist_technique_value", "same_artist_present", "same_artist_value", "priors_model_present", "priors_model_value", "liquidity_never_sold", "liquidity_thin_record", "liquidity_sold_before_healthy"]);
  close("same_work value is the log of the (single) comp", f.row[2], LN(500));
  eq("same_work present flag set", f.row[1], 1);
  eq("tier 2/3 absent", [f.row[3], f.row[5]], [0, 0]);
  close("priors value is its raw mu", f.row[8], LN(600));
  eq("no sell-through data: all liquidity dummies 0 (reference level)", f.row.slice(9), [0, 0, 0]);
}

// ── liquidityLimb ────────────────────────────────────────────────────────────
{
  eq("no history", liquidityLimb(null), "no_history");
  eq("zero appearances", liquidityLimb({ sold: 0, unsold: 0 }), "no_history");
  eq("never sold, one attempt", liquidityLimb({ sold: 0, unsold: 1 }), "never_sold");
  eq("never sold, several attempts", liquidityLimb({ sold: 0, unsold: 5 }), "never_sold");
  eq("thin record: 3+ appearances, under 50%", liquidityLimb({ sold: 1, unsold: 3 }), "thin_record");
  eq("sold before, only 2 appearances (below the thin-record threshold)", liquidityLimb({ sold: 1, unsold: 1 }), "sold_before_healthy");
  eq("sold before, healthy rate", liquidityLimb({ sold: 3, unsold: 1 }), "sold_before_healthy");
  const g = estimateFeaturesOf(inputs({ sellThrough: { sold: 0, unsold: 2 } }));
  eq("estimateFeaturesOf sets the never_sold dummy", g.row.slice(9), [1, 0, 0]);
  const h = estimateFeaturesOf(inputs({ sellThrough: { sold: 1, unsold: 4 } }));
  eq("estimateFeaturesOf sets the thin_record dummy", h.row.slice(9), [0, 1, 0]);
  const k = estimateFeaturesOf(inputs({ sellThrough: { sold: 5, unsold: 1 } }));
  eq("estimateFeaturesOf sets the sold_before_healthy dummy", k.row.slice(9), [0, 0, 1]);
}

// ── does the fit recover a planted liquidity effect on the ESTIMATE? ───────────────────────────
{
  let seed = 23; const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
  // Planted truth: log(estimate) = 5 + 0.5*priors_value, MINUS 0.2 when never_sold, MINUS 0.1
  // when thin_record, no effect for sold_before_healthy or no_history (both reference-equivalent
  // here since sold_before_healthy's coefficient should come out near 0 too).
  const rows: { features: ReturnType<typeof estimateFeaturesOf>; logEstimateMid: number }[] = [];
  const limbs: ("no_history" | "never_sold" | "thin_record" | "sold_before_healthy")[] = ["no_history", "never_sold", "thin_record", "sold_before_healthy"];
  for (let i = 0; i < 600; i++) {
    const prVal = 5 + (i % 17) * 0.1;
    const limb = limbs[i % 4];
    const sellThrough = limb === "no_history" ? null : limb === "never_sold" ? { sold: 0, unsold: 1 + (i % 3) } : limb === "thin_record" ? { sold: 1, unsold: 3 + (i % 3) } : { sold: 4 + (i % 3), unsold: 1 };
    const inp = inputs({ priors: { mu: prVal, basis: "shrunk", earlierSales: 20, contributions: [] }, sellThrough });
    const features = estimateFeaturesOf(inp);
    const penalty = limb === "never_sold" ? -0.2 : limb === "thin_record" ? -0.1 : 0;
    const y = 5 + 0.5 * prVal + penalty + 0.03 * noise();
    rows.push({ features, logEstimateMid: y });
  }
  const model = fitEstimateModel(rows, 0.01);
  const nsCol = ESTIMATE_MODEL_COLUMNS.indexOf("liquidity_never_sold"), trCol = ESTIMATE_MODEL_COLUMNS.indexOf("liquidity_thin_record"), shCol = ESTIMATE_MODEL_COLUMNS.indexOf("liquidity_sold_before_healthy");
  close("recovers the planted never_sold penalty", model.coef[nsCol], -0.2, 0.1);
  close("recovers the planted thin_record penalty", model.coef[trCol], -0.1, 0.1);
  close("sold_before_healthy comes out near 0 (same as the reference)", model.coef[shCol], 0, 0.08);
  ok("never_sold is a bigger discount than thin_record, as planted", model.coef[nsCol] < model.coef[trCol]);
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
