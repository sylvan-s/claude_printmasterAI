/**
 * estimate_model — does the house's printed estimate follow from provenance and comps alone,
 * and what's left over once it does: a per-house residual as the measurable proxy for "house
 * incentives" in the causal chain
 *
 *     provenance/priors ─┐
 *                        ├──→ house estimate ──→ hammer
 *     market comps ───────┘         ↑
 *     house incentives (latent) ────┘
 *
 * Plan docs/plans/2026-09-13-attributed-lot-valuation.md, step 9. `price_blend.ts` (step 8)
 * treats the estimate as one witness among several and found that, once it is present, comps
 * and the priors model add almost nothing further to HAMMER — near-total mediation through the
 * estimate. This module asks the upstream question price_blend never modelled: what predicts
 * the ESTIMATE itself? Fit `log(estimate midpoint) ~ same-work comps + tier comps + priors
 * model` (the same witnesses `rawWitnesses` derives for price_blend, reused here as predictors
 * instead of alternatives to combine), WITHOUT a house term. The residual, grouped by house, is
 * how far that house's estimates sit from what a valuer with only provenance and comps would
 * have written — the closest available proxy for house-specific estimate-setting behaviour
 * (deliberate shading to draw bidders, segment specialism, or genuine skill; this residual
 * cannot separate those from each other, only from the mechanical effect of having stronger or
 * weaker comps to work from, which is a real identification limit, not a modelling one).
 *
 * Ridge fit via normal equations, hand-rolled (Gaussian elimination) — no new dependency, and
 * the design is under 15 columns, so a manual solve is exact and fast. Pure: no I/O.
 *
 * Liquidity / track record: `liquidityVerdict` (attributed_lot.ts) established that never-sold
 * and thin-record works carry a measured, real effect on whether a lot SELLS and, weakly, on
 * what it makes WHEN it sells — but nobody has checked whether that history shows up in the
 * house's printed ESTIMATE at all, as opposed to only in the outcome. `liquidityLimb` below is a
 * local copy of that same classification (never_sold / thin_record / sold_before_healthy /
 * no_history), added here as three reference-coded dummies alongside the evidence predictors —
 * so the fit can say whether a house writes a lower number for a work with a bad track record,
 * net of the same provenance and comps every other lot is judged on.
 */
import { rawWitnesses, type BlendInputs, type WitnessSource } from "./price_blend.js";

export const ESTIMATE_PREDICTOR_SOURCES: Exclude<WitnessSource, "estimate">[] = ["same_work", "same_artist_technique", "same_artist", "priors_model"];

/** Mirrors `liquidityVerdict` in attributed_lot.ts, collapsed to one label. Kept as a local copy
 *  rather than an import: attributed_lot.ts sits above knowledge_graph/ in the dependency
 *  layering (it imports FROM here), so importing it back would invert that. The threshold
 *  (LIQUIDITY_MIN_APPEARANCES = 3, rate < 0.5 for "thin") is the same constant, named the same
 *  way, in both files — change both together if it ever moves. */
export type LiquidityLimb = "no_history" | "never_sold" | "thin_record" | "sold_before_healthy";
export const LIQUIDITY_MIN_APPEARANCES = 3;
export function liquidityLimb(sellThrough: { sold: number; unsold: number } | null | undefined): LiquidityLimb {
  const n = sellThrough ? sellThrough.sold + sellThrough.unsold : 0;
  if (!sellThrough || n === 0) return "no_history";
  if (sellThrough.sold === 0) return "never_sold";
  if (n >= LIQUIDITY_MIN_APPEARANCES && sellThrough.sold / n < 0.5) return "thin_record";
  return "sold_before_healthy";
}
const LIQUIDITY_LEVELS: Exclude<LiquidityLimb, "no_history">[] = ["never_sold", "thin_record", "sold_before_healthy"];

export interface EstimateFeatures {
  /** column order: intercept, [present_i, value_i] pairs per ESTIMATE_PREDICTOR_SOURCES, then
   *  one dummy per LIQUIDITY_LEVELS (reference level "no_history" = all three dummies 0) */
  row: number[];
}
export const ESTIMATE_MODEL_COLUMNS: string[] = [
  "intercept",
  ...ESTIMATE_PREDICTOR_SOURCES.flatMap((s) => [`${s}_present`, `${s}_value`]),
  ...LIQUIDITY_LEVELS.map((l) => `liquidity_${l}`),
];

const ln = Math.log;

/** Reuses price_blend's own witness derivation so the predictors here are IDENTICAL numbers to
 *  what price_blend would combine as alternatives to the estimate — this model asks whether
 *  they instead EXPLAIN it. Returns null when the lot has no comps/priors evidence at all (an
 *  all-zero row would just fit the intercept, which is legitimate but not informative to include
 *  repeatedly; callers may still choose to keep such rows). */
export function estimateFeaturesOf(inputs: BlendInputs): EstimateFeatures {
  const raw = new Map(rawWitnesses(inputs).map((w) => [w.source, w.rawMu]));
  const row = [1];
  for (const s of ESTIMATE_PREDICTOR_SOURCES) {
    const v = raw.get(s);
    row.push(v != null ? 1 : 0, v ?? 0);
  }
  const limb = liquidityLimb(inputs.sellThrough);
  for (const l of LIQUIDITY_LEVELS) row.push(limb === l ? 1 : 0);
  return { row };
}

export interface EstimateFitRow { inputs: BlendInputs; house: string }
export interface EstimateModel {
  columns: string[];
  coef: number[];
  alpha: number;
  n: number;
}

// ── small linear algebra: (X'X + alpha I) coef = X'y, solved by Gaussian elimination ──────────
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) continue; // singular direction (e.g. a predictor never present) — leave its coefficient at 0
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** Ridge on `log(estimate midpoint)`. `alpha` regularises every column except the intercept. */
export function fitEstimateModel(rows: { features: EstimateFeatures; logEstimateMid: number }[], alpha = 1.0): EstimateModel {
  const p = ESTIMATE_MODEL_COLUMNS.length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty: number[] = new Array(p).fill(0);
  for (const r of rows) {
    const x = r.features.row;
    for (let i = 0; i < p; i++) {
      Xty[i] += x[i] * r.logEstimateMid;
      for (let j = 0; j < p; j++) XtX[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < p; i++) XtX[i][i] += alpha; // ridge penalty, intercept (col 0) unpenalised
  const coef = solve(XtX, Xty);
  return { columns: ESTIMATE_MODEL_COLUMNS, coef, alpha, n: rows.length };
}

export function predictLogEstimate(features: EstimateFeatures, model: EstimateModel): number {
  return features.row.reduce((t, x, i) => t + x * model.coef[i], 0);
}

export interface HouseResidual { house: string; n: number; meanResidual: number; medianResidual: number; madResidual: number }

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** residual = actual log(estimate mid) - predicted, grouped by house. Positive = this house's
 *  estimates run higher than provenance+comps alone would predict; negative = lower. */
export function residualsByHouse(rows: { features: EstimateFeatures; logEstimateMid: number; house: string }[], model: EstimateModel): HouseResidual[] {
  const byHouse = new Map<string, number[]>();
  for (const r of rows) {
    const e = r.logEstimateMid - predictLogEstimate(r.features, model);
    (byHouse.get(r.house) ?? byHouse.set(r.house, []).get(r.house)!).push(e);
  }
  return [...byHouse.entries()].map(([house, es]) => {
    const m = median(es);
    return { house, n: es.length, meanResidual: es.reduce((t, x) => t + x, 0) / es.length, medianResidual: m, madResidual: median(es.map((x) => Math.abs(x - m))) };
  });
}
