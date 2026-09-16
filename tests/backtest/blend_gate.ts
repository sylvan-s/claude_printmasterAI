/**
 * Plan step 8 gate — fit the deterministic price blend on one house's hammer lots, score it on
 * the other's. Zero LLM spend, zero graph reads: everything comes from two comps_hammer
 * `--blend` runs.
 *
 *   npm run backtest:comps-hammer -- --source roseberys --limit 2500 --seed 11 --resolve-work --blend --out tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl
 *   npm run backtest:comps-hammer -- --source forum     --limit 2500 --seed 11 --resolve-work --blend --out tests/backtest/comps_hammer/forum_n2500_blend.jsonl
 *   npm run backtest:blend-gate -- --fit tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl --test tests/backtest/comps_hammer/forum_n2500_blend.jsonl
 *
 * Two regimes, as the plan states them:
 *   with_estimate   baseline = catalogue midpoint x 0.82; the blend must not lose on MAE(log) or
 *                   within-2x, and its 80% interval must cover 75-85% of hammers.
 *   no_estimate     the estimate witness is withheld; baseline = the best single de-biased
 *                   witness the lot has; the blend must beat it on MAE(log).
 * Plus the marginal value of the priors witness (blend with its weight forced to 0), the split
 * by best tier reached, and whether the divergence flag points at the lots the blend gets wrong.
 *
 * Writes the calibration JSON (default knowledge_graph/pricing_ml/blend/calibration.json) —
 * the committed artefact Stage 3 would read once the gate passes. Nothing else is written.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blendPrices,
  calibratedWitnesses,
  fitBlendCalibration,
  crpsOnGrid,
  type BlendCalibration,
  type BlendInputs,
  type BlendRegime,
  type FitRow,
  type HouseOffsets,
  type WitnessSource,
} from "../../src/appraisal/knowledge_graph/price_blend";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const FIT = arg("fit", "tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl")!;
const TEST = arg("test", "tests/backtest/comps_hammer/forum_n2500_blend.jsonl")!;
const OUT = arg("out", join("knowledge_graph/pricing_ml/blend", "calibration.json"))!;
const VERSION = arg("version", "BLEND-1.0")!;
const DRIFT = Number(arg("drift", "0.82"));
const DF = arg("df", "5") === "gauss" ? null : Number(arg("df", "5"));
/** Plan 2026-09-16 phase 1: knowledge_graph/pricing_ml/blend/house_offsets.json. Re-bases every comp to
 *  the lot's house and swaps the priors house term. Needs harness runs that record comp houses
 *  (targetHouse + per-comp house, 2026-09-16 onwards); older runs pass through un-rebased. */
const HOUSE_OFFSETS = arg("house-offsets");
/** Phase 1b: none | prior_year | sale_year (leaky upper bound). Uses house_offsets.json yearEffects. */
const TIME_ADJUST = arg("time-adjust", "none") as "none" | "prior_year" | "sale_year";

interface Row { key: string; source: string; sold: boolean; hammer: number | null; lowEst: number; highEst: number; error?: string; blend?: { inputs: BlendInputs; lotAttrsSource: string } | null; tiers: { same_work: { n: number } } }

function load(path: string): { rows: FitRow[]; raw: Row[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = { error: 0, unsold: 0, noBlend: 0 };
  const rows: FitRow[] = [], raw: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as Row;
    if (r.error) { skipped.error++; continue; }
    if (!r.sold || !r.hammer || r.hammer <= 0) { skipped.unsold++; continue; }
    if (!r.blend) { skipped.noBlend++; continue; }
    rows.push({ inputs: r.blend.inputs, hammerGBP: r.hammer });
    raw.push(r);
  }
  return { rows, raw, skipped };
}

const ln = Math.log;
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "  n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "n/a");

interface Score { n: number; mae: number; geo: number; within2x: number; coverage80: number; crps: number }
function scoreOf(errs: number[], cover: boolean[], crps: number[]): Score {
  const n = errs.length;
  if (!n) return { n: 0, mae: NaN, geo: NaN, within2x: NaN, coverage80: NaN, crps: NaN };
  return {
    n,
    mae: errs.reduce((t, e) => t + Math.abs(e), 0) / n,
    geo: Math.exp(errs.reduce((t, e) => t + e, 0) / n),
    within2x: errs.filter((e) => Math.abs(e) <= ln(2)).length / n,
    coverage80: cover.length ? cover.filter(Boolean).length / cover.length : NaN,
    crps: crps.length ? crps.reduce((t, c) => t + c, 0) / crps.length : NaN,
  };
}
const line = (label: string, s: Score) =>
  `     ${label.padEnd(46)} n=${String(s.n).padStart(4)}  MAE(log)=${f3(s.mae)}  geo=${f3(s.geo)}  within 2x: ${pct(s.within2x).padStart(4)}  80% cover: ${pct(s.coverage80).padStart(4)}  CRPS=${f3(s.crps)}`;

/** Blend score with optional weight overrides (e.g. priors_model: 0). */
function scoreBlend(rows: FitRow[], cal: BlendCalibration, regime: BlendRegime, overrides: Partial<Record<WitnessSource, number>> = {}): Score {
  const c: BlendCalibration = JSON.parse(JSON.stringify(cal));
  Object.assign(c.regimes[regime].weights, overrides);
  const errs: number[] = [], cover: boolean[] = [], crps: number[] = [];
  for (const r of rows) {
    const b = blendPrices(r.inputs, c, regime);
    if (!b) continue;
    const y = ln(r.hammerGBP);
    errs.push(ln(b.medianGBP) - y);
    cover.push(y >= ln(b.p10GBP) && y <= ln(b.p90GBP));
    crps.push(crpsOnGrid(b, y));
  }
  return scoreOf(errs, cover, crps);
}

/** A point predictor scored on the lots where it exists. */
function scorePoint(rows: FitRow[], pred: (r: FitRow) => number | null): Score {
  const errs: number[] = [];
  for (const r of rows) { const p = pred(r); if (p != null && Number.isFinite(p)) errs.push(p - ln(r.hammerGBP)); }
  return scoreOf(errs, [], []);
}

/** The best single de-biased witness a lot has, in the plan's order: same_work > tier 2 > tier 3 > priors. */
function bestSingle(cal: BlendCalibration, regime: BlendRegime) {
  const order: WitnessSource[] = regime === "with_estimate" ? ["estimate", "same_work", "same_artist_technique", "same_artist", "priors_model"] : ["same_work", "same_artist_technique", "same_artist", "priors_model"];
  return (r: FitRow): number | null => {
    const ws = calibratedWitnesses(r.inputs, cal, regime).witnesses;
    for (const src of order) { const w = ws.find((x) => x.source === src); if (w) return w.mu; }
    return null;
  };
}
function singleWitness(cal: BlendCalibration, regime: BlendRegime, src: WitnessSource) {
  return (r: FitRow): number | null => calibratedWitnesses(r.inputs, cal, regime).witnesses.find((x) => x.source === src)?.mu ?? null;
}

function tierLabel(r: FitRow): string {
  const i = r.inputs;
  if (i.sameWork.length >= 3) return "same_work n>=3";
  if (i.sameWork.length >= 1) return "same_work n=1-2";
  if (i.sameArtistTechnique) return "tier 2 only";
  if (i.sameArtist) return "tier 3 only";
  if (i.priors) return "priors model only";
  return "no witness";
}

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

function report(title: string, rows: FitRow[], cal: BlendCalibration) {
  console.log(`\n══ ${title} ═══════════════════════════════════════════════════════════════════`);
  const withEst = rows.filter((r) => r.inputs.estimate);
  const est = (r: FitRow) => (r.inputs.estimate ? ln(((r.inputs.estimate.lowGBP + r.inputs.estimate.highGBP) / 2) * DRIFT) : null);

  console.log(`\n── Regime: WITH estimate (n=${withEst.length} sold lots with an estimate) ──`);
  console.log(line(`catalogue midpoint x ${DRIFT} (baseline)`, scorePoint(withEst, est)));
  console.log(line("BLEND", scoreBlend(withEst, cal, "with_estimate")));
  console.log(line("blend without the priors witness", scoreBlend(withEst, cal, "with_estimate", { priors_model: 0 })));
  console.log(line("blend without any comps witness", scoreBlend(withEst, cal, "with_estimate", { same_work: 0, same_artist_technique: 0, same_artist: 0 })));
  console.log(line("best single de-biased witness", scorePoint(withEst, bestSingle(cal, "with_estimate"))));

  console.log(`\n── Regime: NO estimate (estimate witness withheld; n=${rows.length}) ──`);
  console.log(line("best single de-biased witness (baseline)", scorePoint(rows, bestSingle(cal, "no_estimate"))));
  console.log(line("BLEND", scoreBlend(rows, cal, "no_estimate")));
  console.log(line("blend without the priors witness", scoreBlend(rows, cal, "no_estimate", { priors_model: 0 })));
  console.log(line("blend, same-work witness only", scoreBlend(rows, cal, "no_estimate", { same_artist_technique: 0, same_artist: 0, priors_model: 0 })));
  for (const src of ["same_work", "same_artist_technique", "same_artist", "priors_model"] as WitnessSource[]) {
    console.log(line(`  ${src} alone, de-biased (its own lots)`, scorePoint(rows, singleWitness(cal, "no_estimate", src))));
  }
  console.log(line(`  catalogue midpoint x ${DRIFT}, for reference`, scorePoint(rows, est)));

  console.log(`\n── NO-estimate blend vs best single witness, by the best evidence the lot has ──`);
  const groups = ["same_work n>=3", "same_work n=1-2", "tier 2 only", "tier 3 only", "priors model only", "no witness"];
  for (const g of groups) {
    const sub = rows.filter((r) => tierLabel(r) === g);
    if (!sub.length) continue;
    console.log(`  ${g} (n=${sub.length})`);
    console.log(line("best single witness", scorePoint(sub, bestSingle(cal, "no_estimate"))));
    console.log(line("blend", scoreBlend(sub, cal, "no_estimate")));
    console.log(line("blend without priors", scoreBlend(sub, cal, "no_estimate", { priors_model: 0 })));
  }

  console.log(`\n── Divergence flag (with-estimate regime): does a >${cal.divergenceThreshold} log gap between witnesses point at the misses? ──`);
  const gaps: number[] = [], errs: number[] = [], flaggedErr: number[] = [], quietErr: number[] = [];
  for (const r of withEst) {
    const b = blendPrices(r.inputs, cal, "with_estimate");
    if (!b || b.witnesses.filter((w) => w.weight > 0).length < 2) continue;
    const gap = b.divergence.reduce((m, d) => Math.max(m, Math.abs(d.logGap)), 0);
    const e = Math.abs(ln(b.medianGBP) - ln(r.hammerGBP));
    gaps.push(gap); errs.push(e);
    (b.divergence.length ? flaggedErr : quietErr).push(e);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : NaN);
  console.log(`  lots with >=2 active witnesses: ${gaps.length}; flagged ${flaggedErr.length} (MAE(log) ${f3(mean(flaggedErr))}), not flagged ${quietErr.length} (MAE(log) ${f3(mean(quietErr))}); Spearman(max gap, |error|) = ${f3(spearman(gaps, errs))}`);
}

function main() {
  const fit = load(FIT), test = load(TEST);
  console.log(`fit  ${FIT}: ${fit.rows.length} sold lots with blend inputs (skipped: ${JSON.stringify(fit.skipped)})`);
  console.log(`test ${TEST}: ${test.rows.length} sold lots with blend inputs (skipped: ${JSON.stringify(test.skipped)})`);
  const cover = (rows: FitRow[]) => { const c: Record<string, number> = {}; for (const r of rows) c[tierLabel(r)] = (c[tierLabel(r)] ?? 0) + 1; return c; };
  console.log(`fit  best evidence: ${JSON.stringify(cover(fit.rows))}`);
  console.log(`test best evidence: ${JSON.stringify(cover(test.rows))}`);

  const houseOffsets: HouseOffsets | null = HOUSE_OFFSETS ? { ...JSON.parse(readFileSync(HOUSE_OFFSETS, "utf8")), timeAdjust: TIME_ADJUST } : null;
  if (TIME_ADJUST !== "none" && !houseOffsets?.yearEffects) throw new Error("--time-adjust needs --house-offsets with yearEffects");
  console.log(`time adjustment: ${TIME_ADJUST}`);
  if (houseOffsets) {
    const rebaseable = (rows: FitRow[]) => rows.filter((r) => r.inputs.targetHouse && [...r.inputs.sameWork, ...(r.inputs.sameArtistTechnique?.comps ?? []), ...(r.inputs.sameArtist?.comps ?? [])].some((c) => c.house)).length;
    console.log(`house offsets ${houseOffsets.version} (${HOUSE_OFFSETS}): ${Object.entries(houseOffsets.houses).map(([h, v]) => `${h} x${Math.exp(v.log).toFixed(2)}`).join(", ")}; re-baseable lots fit ${rebaseable(fit.rows)}/${fit.rows.length}, test ${rebaseable(test.rows)}/${test.rows.length}`);
  }
  const cal = fitBlendCalibration(fit.rows, { version: VERSION, fittedOn: `${FIT} (${fit.rows.length} sold lots)`, df: DF, houseOffsets });
  console.log(`\n── Calibration ${cal.version} (df=${DF ?? "gauss"}) ──`);
  for (const [src, w] of Object.entries(cal.witnesses)) {
    const keys = Object.entries(w.byKey).map(([k, v]) => `${k}: bias ${v.bias >= 0 ? "+" : ""}${v.bias.toFixed(2)} (x${Math.exp(v.bias).toFixed(2)}) sigma ${v.sigma.toFixed(2)} n=${v.n}`).join(" | ");
    console.log(`  ${src.padEnd(22)} ${keys || "(no fit lots)"}`);
  }
  for (const [regime, r] of Object.entries(cal.regimes)) {
    console.log(`  ${regime.padEnd(22)} weights ${JSON.stringify(r.weights)}  temperature ${r.temperature} by tier ${JSON.stringify(r.temperatureByTier ?? {})}  fit: n=${r.fitLots} MAE(log)=${f3(r.fitMaeLog)} 80% cover ${pct(r.fitCoverage80)}`);
  }

  report(`IN-SAMPLE (fit set, ${FIT})`, fit.rows, cal);
  report(`OUT-OF-SAMPLE (test set, ${TEST}) — the gate`, test.rows, cal);

  // Phase-1 gate (plan 2026-09-16): no-estimate regime, out of sample.
  const base = scorePoint(test.rows, bestSingle(cal, "no_estimate"));
  const bl = scoreBlend(test.rows, cal, "no_estimate");
  const coverOk = bl.coverage80 >= 0.75 && bl.coverage80 <= 0.85, maeOk = bl.mae < base.mae;
  console.log(`\n══ PHASE-1 GATE (no estimate, out of sample) ══`);
  console.log(`  80% interval coverage ${pct(bl.coverage80)} (must be 75-85%): ${coverOk ? "PASS" : "FAIL"}`);
  console.log(`  MAE(log) blend ${f3(bl.mae)} vs best single witness ${f3(base.mae)}: ${maeOk ? "PASS" : "FAIL"}   geo bias blend ${f3(bl.geo)}`);
  console.log(`  GATE ${coverOk && maeOk ? "PASSES" : "FAILS"}`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(cal, null, 2) + "\n");
  console.log(`\ncalibration written to ${OUT}`);
}

main();
