/**
 * Plan step 9 — a weight for each driver of a Roseberys estimate: the Bonhams-calibrated
 * priors model, the Roseberys-vs-Bonhams house discount, the re-listing penalty, and market
 * comparisons.
 *
 * Every earlier addendum in this step measured one driver at a time, in different regressions
 * with different specs, so their sizes aren't directly comparable. This script puts all four in
 * ONE pooled Roseberys+Bonhams model — priors and market comps exactly as `estimate_model.ts`
 * derives them, the re-listing penalty exactly as the recency rebuild derives it, and (new) an
 * explicit `house_is_roseberys` dummy so the house discount is a first-class term instead of an
 * unexplained residual — then decomposes R² across the four groups with the LMG/Shapley method:
 * average each group's incremental R² over every one of the 4! = 24 orderings in which the
 * groups could be added. That is the standard, fair way to split credit for R² among predictors
 * that are themselves correlated (a recently-unsold lot may also have thinner comps coverage,
 * for instance) — a plain "biggest coefficient wins" reading would not account for that.
 *
 * Forum excluded (no saleDate — task_7cae1bb7 — so it can't inform the house or relisting terms
 * and would just add noise to both).
 *
 *   npx tsx tests/backtest/estimate_driver_weights.ts
 */
import { readFileSync } from "node:fs";
import { estimateFeaturesOf, ESTIMATE_MODEL_COLUMNS, type BlendInputs } from "../../src/appraisal/knowledge_graph/index";

const ln = Math.log;
const ALPHA = 1.0;

// ── small ridge fit (mirrors estimate_model.ts's solve(), kept self-contained here since this
//    script's design matrix — an added house column — differs from the module's own contract) ──
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) { if (r === col) continue; const f = M[r][col]; if (f === 0) continue; for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]; }
  }
  return M.map((row) => row[n]);
}
function ridgeFit(X: number[][], y: number[], penalizedFrom = 1): number[] {
  const p = X[0].length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty: number[] = new Array(p).fill(0);
  for (let r = 0; r < X.length; r++) for (let i = 0; i < p; i++) { Xty[i] += X[r][i] * y[r]; for (let j = 0; j < p; j++) XtX[i][j] += X[r][i] * X[r][j]; }
  for (let i = penalizedFrom; i < p; i++) XtX[i][i] += ALPHA;
  return solve(XtX, Xty);
}
function r2(X: number[][], y: number[], coef: number[]): number {
  const yMean = y.reduce((t, v) => t + v, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  for (let r = 0; r < X.length; r++) {
    const pred = X[r].reduce((t, x, i) => t + x * coef[i], 0);
    ssRes += (y[r] - pred) ** 2; ssTot += (y[r] - yMean) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

// ── groups: which columns belong to each named driver ────────────────────────────────────────
const PRIORS_COLS = ["priors_model_present", "priors_model_value"];
const COMPS_COLS = ["same_work_present", "same_work_value", "same_artist_technique_present", "same_artist_technique_value", "same_artist_present", "same_artist_value"];
const RELIST_COLS = ["recent_unsold_present", "recent_unsold_log_days", "recent_sold_present", "recent_sold_log_days"];
const HOUSE_COL = "house_is_roseberys";
const ALL_COLUMNS = [...ESTIMATE_MODEL_COLUMNS, HOUSE_COL]; // intercept is column 0, always included
const GROUPS: Record<string, number[]> = {
  priors: PRIORS_COLS.map((c) => ALL_COLUMNS.indexOf(c)),
  comps: COMPS_COLS.map((c) => ALL_COLUMNS.indexOf(c)),
  relisting: RELIST_COLS.map((c) => ALL_COLUMNS.indexOf(c)),
  house_discount: [ALL_COLUMNS.indexOf(HOUSE_COL)],
};
const GROUP_NAMES = Object.keys(GROUPS);

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

function load(path: string, house: 0 | 1): { X: number[]; y: number }[] {
  const out: { X: number[]; y: number }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.error || !r.blend?.inputs?.estimate) continue;
    const inputs = r.blend.inputs as BlendInputs;
    const f = estimateFeaturesOf(inputs);
    out.push({ X: [...f.row, house], y: ln((inputs.estimate!.lowGBP + inputs.estimate!.highGBP) / 2) });
  }
  return out;
}

function main() {
  const rows = [...load("tests/backtest/comps_hammer/roseberys_n2500_blend_recency.jsonl", 1), ...load("tests/backtest/comps_hammer/bonhams_n2500_blend_recency.jsonl", 0)];
  console.log(`pooled Roseberys+Bonhams: ${rows.length} lots with an estimate + blend inputs (columns: ${ALL_COLUMNS.join(", ")})`);
  const X = rows.map((r) => r.X), y = rows.map((r) => r.y);

  const full = ridgeFit(X, y);
  const fullR2 = r2(X, y, full);
  console.log(`\nfull model (all 4 drivers): R² = ${fullR2.toFixed(3)}`);
  console.log(`  coefficients: ${ALL_COLUMNS.map((c, i) => `${c}=${full[i].toFixed(3)}`).join("  ")}`);
  console.log(`  house_is_roseberys = ${full[ALL_COLUMNS.length - 1].toFixed(3)}  (x${Math.exp(full[ALL_COLUMNS.length - 1]).toFixed(2)}) — the house discount, net of priors/comps/relisting`);

  // R² of a model using only the given column indices (plus the intercept, column 0, always kept).
  const r2With = (cols: number[]): number => {
    const idx = [0, ...new Set(cols)].sort((a, b) => a - b);
    const Xs = X.map((row) => idx.map((i) => row[i]));
    const coef = ridgeFit(Xs, y, 1);
    let ssRes = 0, ssTot = 0;
    const yMean = y.reduce((t, v) => t + v, 0) / y.length;
    for (let r = 0; r < Xs.length; r++) { const pred = Xs[r].reduce((t, x, i) => t + x * coef[i], 0); ssRes += (y[r] - pred) ** 2; ssTot += (y[r] - yMean) ** 2; }
    return ssTot > 0 ? 1 - ssRes / ssTot : 0;
  };

  // LMG / Shapley decomposition of R² across the 4 named groups.
  const contributions: Record<string, number[]> = {}; for (const g of GROUP_NAMES) contributions[g] = [];
  for (const order of permutations(GROUP_NAMES)) {
    let cols: number[] = [];
    let prevR2 = 0;
    for (const g of order) {
      cols = [...cols, ...GROUPS[g]];
      const newR2 = r2With(cols);
      contributions[g].push(newR2 - prevR2);
      prevR2 = newR2;
    }
  }
  const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
  const weights = Object.fromEntries(GROUP_NAMES.map((g) => [g, mean(contributions[g])]));
  const totalAttributed = Object.values(weights).reduce((t, v) => t + v, 0);

  console.log(`\n── LMG / Shapley decomposition of R² across the 4 drivers (averaged over all 24 orderings) ──`);
  for (const g of GROUP_NAMES.sort((a, b) => weights[b] - weights[a])) {
    console.log(`  ${g.padEnd(16)} ΔR² = ${weights[g].toFixed(4)}   share of explained variance: ${(100 * weights[g] / totalAttributed).toFixed(0)}%`);
  }
  console.log(`  sum of the four ΔR² ≈ full-model R² (${totalAttributed.toFixed(3)} vs ${fullR2.toFixed(3)}) — LMG shares are exact for a linear model`);

  console.log(`\n── For scale: how much each driver moves a TYPICAL log-estimate (not variance, magnitude) ──`);
  console.log(`  priors_model_value=${full[ALL_COLUMNS.indexOf("priors_model_value")].toFixed(2)}  (≈1:1 with the artist's log price level — this is the anchor, not a small nudge)`);
  console.log(`  house_is_roseberys=${full[ALL_COLUMNS.indexOf(HOUSE_COL)].toFixed(2)}  (x${Math.exp(full[ALL_COLUMNS.indexOf(HOUSE_COL)]).toFixed(2)}, applies to EVERY Roseberys lot, not conditional on evidence)`);
  console.log(`  recent_unsold_present=${full[ALL_COLUMNS.indexOf("recent_unsold_present")].toFixed(2)}  (fires on ~5% of lots, large when it does)`);
  console.log(`  same_work_value=${full[ALL_COLUMNS.indexOf("same_work_value")].toFixed(2)}  (fires when a tier-1 comp exists — minority of lots, strong evidence when present)`);
}

main();
