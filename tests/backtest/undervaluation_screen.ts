/**
 * Plan step 9 — does the four-driver model's RESIDUAL identify genuine mispricing, or just noise?
 *
 * The user's actual goal: spot a Roseberys/Forum lot that is BOTH distressed (recently unsold,
 * ~30% mechanical re-listing discount already applied — see relist_discount_report.ts) AND
 * mispriced beyond that known, mechanical discount — because the 30% alone is not enough margin
 * once round-trip costs are counted, and other buyers likely already know about and price in the
 * mechanical relisting pattern too.
 *
 * `estimate_driver_weights.ts` fit log(estimate mid) ~ priors + comps + house + relisting on
 * pooled Roseberys+Bonhams data (R²=0.571). The RESIDUAL of that fit — actual estimate minus what
 * the model, already knowing this lot's priors level, comps, house, and relisting status, would
 * predict — is the natural "genuinely mispriced" score this asks for: a lot priced even lower
 * than an already-distress-adjusted expectation.
 *
 * A residual is only useful if it predicts something real. This script tests the one thing that
 * settles it: does a large negative residual (looks underpriced vs the model) correlate with the
 * market later paying UP relative to the estimate (hammer/estimate ratio), on lots where we
 * already know the outcome? If yes, the screen has genuine predictive power. If the correlation
 * is flat or the wrong sign, the residual is noise (missing condition/rarity/state information
 * the model can't see) and should not be traded on.
 *
 *   npx tsx tests/backtest/undervaluation_screen.ts
 */
import { readFileSync } from "node:fs";
import { estimateFeaturesOf, ESTIMATE_MODEL_COLUMNS, type BlendInputs } from "../../src/appraisal/knowledge_graph/index";

const ln = Math.log;
const ALPHA = 1.0;

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

const HOUSE_COL = "house_is_roseberys";
const ALL_COLUMNS = [...ESTIMATE_MODEL_COLUMNS, HOUSE_COL];

interface Row {
  key: string; artist: string; title: string; source: string; house: number; sold: boolean; hammer: number | null;
  lowEst: number; highEst: number; distressed: boolean; X: number[]; logEstimateMid: number;
}

function load(path: string, house: 0 | 1, source: string): Row[] {
  const out: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.error || !r.blend?.inputs?.estimate) continue;
    const inputs = r.blend.inputs as BlendInputs;
    const f = estimateFeaturesOf(inputs);
    const distressed = !!(inputs.recentSameHouseAppearance && !inputs.recentSameHouseAppearance.sold);
    out.push({
      key: r.key, artist: r.canonicalArtist ?? r.artist, title: r.title, source, house, sold: r.sold, hammer: r.hammer,
      lowEst: inputs.estimate!.lowGBP, highEst: inputs.estimate!.highGBP, distressed,
      X: [...f.row, house], logEstimateMid: ln((inputs.estimate!.lowGBP + inputs.estimate!.highGBP) / 2),
    });
  }
  return out;
}

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
}
function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return NaN;
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const ma = ra.reduce((t, x) => t + x, 0) / n, mb = rb.reduce((t, x) => t + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
function bootstrapCI(rows: { artist: string }[], stat: (rs: any[]) => number, draws = 500): [number, number] {
  const byArtist = new Map<string, any[]>();
  for (const r of rows) (byArtist.get(r.artist) ?? byArtist.set(r.artist, []).get(r.artist)!).push(r);
  const clusters = [...byArtist.values()];
  let seed = 53; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const vals: number[] = [];
  for (let b = 0; b < draws; b++) { const sample: any[] = []; for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rnd() * clusters.length)]); vals.push(stat(sample)); }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * (vals.length - 1))], vals[Math.floor(0.975 * (vals.length - 1))]];
}

function main() {
  const rows = [
    ...load("tests/backtest/comps_hammer/roseberys_n2500_blend_recency.jsonl", 1, "roseberys"),
    ...load("tests/backtest/comps_hammer/bonhams_n2500_blend_recency.jsonl", 0, "bonhams"),
  ];
  console.log(`${rows.length} lots with an estimate; ${rows.filter((r) => r.distressed).length} currently distressed (recent same-house failure)`);

  // Fit the model, then compute each row's residual: actual - predicted log(estimate mid).
  const X = rows.map((r) => r.X), y = rows.map((r) => r.logEstimateMid);
  const coef = ridgeFit(X, y);
  const residual = rows.map((r, i) => r.logEstimateMid - X[i].reduce((t, x, j) => t + x * coef[j], 0));

  // Validation: does the residual predict hammer/estimate on SOLD lots — the direct test of
  // whether "looks underpriced vs the model" corresponds to the market later paying up.
  const sold = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.sold && r.hammer && r.hammer > 0);
  const hammerRatio = (i: number) => ln(rows[i].hammer! / Math.exp(rows[i].logEstimateMid));
  console.log(`\n── Does the model residual predict hammer/estimate on lots we already know the outcome for? ──`);
  for (const [label, pool] of [["ALL sold lots", sold], ["DISTRESSED sold lots only", sold.filter(({ r }) => r.distressed)]] as const) {
    if (pool.length < 10) { console.log(`  ${label}: n=${pool.length} (too few)`); continue; }
    const res = pool.map(({ i }) => residual[i]);
    const out = pool.map(({ i }) => hammerRatio(i));
    const rho = spearman(res, out);
    // Bootstrap CI on the Spearman correlation, artist-clustered.
    const withArtist = pool.map(({ r, i }) => ({ artist: r.artist, res: residual[i], out: hammerRatio(i) }));
    const [lo, hi] = bootstrapCI(withArtist, (xs) => spearman(xs.map((x) => x.res), xs.map((x) => x.out)));
    console.log(`  ${label} (n=${pool.length}): Spearman(residual, hammer/estimate) = ${rho.toFixed(3)}  95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  }
  console.log(`  Reading: residual is NEGATIVE when a lot looks underpriced vs the model; hammer/estimate is POSITIVE`);
  console.log(`  when hammer beats the estimate. "Screen works" (underpriced lots later outperform) therefore shows as a`);
  console.log(`  NEGATIVE Spearman correlation here (low residual pairing with high hammer/estimate). A correlation near`);
  console.log(`  zero or POSITIVE would mean the discount is justified, not a bargain -- the model residual is just noise.`);

  // Illustrative screen: among currently-distressed, UNSOLD-outcome-pending lots is the wrong
  // set to demo (no outcome yet, by construction of this backtest) -- use the distressed SOLD
  // lots with the most negative residual as "would this screen have caught something real."
  const distressedSold = sold.filter(({ r }) => r.distressed).map(({ r, i }) => ({ r, residual: residual[i], hammerRatio: hammerRatio(i) }));
  distressedSold.sort((a, b) => a.residual - b.residual);
  console.log(`\n── Top 10 most-underpriced-vs-model DISTRESSED lots that later sold (illustrative, not a live screen) ──`);
  console.log(`  ${"artist / title".padEnd(45)} ${"residual".padStart(9)}  ${"low est".padStart(8)}  ${"hammer".padStart(8)}  ${"hammer/est".padStart(10)}`);
  for (const d of distressedSold.slice(0, 10)) {
    console.log(`  ${(d.r.artist.slice(0, 22) + " / " + d.r.title.slice(0, 20)).padEnd(45)} ${d.residual.toFixed(2).padStart(9)}  £${d.r.lowEst.toFixed(0).padStart(7)}  £${d.r.hammer!.toFixed(0).padStart(7)}  ${Math.exp(d.hammerRatio).toFixed(2).padStart(9)}x`);
  }
}

main();
