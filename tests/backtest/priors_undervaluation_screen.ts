/**
 * Plan step 9 — "underpriced" defined precisely: hammer at Roseberys below what the priors
 * model implies a fair price to be, net of the Roseberys relative price factor. How many of
 * those went on to sell much higher (either house) within a year?
 *
 * Two stages, deliberately kept separate because they need different data:
 *
 * 1. FLAG: fit log(hammer) ~ priors_mu (present+value) + house_is_roseberys on the pooled
 *    Roseberys+Bonhams `--blend` sample (2,500 lots per house, has priors_mu from the artist
 *    elasticity model — Bonhams-referenced by construction, since that's build_priors.py's
 *    reference house). This is deliberately only TWO factors, matching the user's definition
 *    exactly — no comps, no relisting term, unlike estimate_driver_weights.ts's 4-driver model.
 *    A Roseberys lot is "underpriced" when its actual hammer sits below this fit's prediction
 *    (which already has the Roseberys house discount subtracted in).
 *    Simplification worth stating: priors_mu as stored already carries a PER-ARTIST house
 *    adjustment for the small minority of artists whose profile has a fitted house_Roseberys
 *    coefficient with enough support (see artist_price_profile.ts) — this script does not undo
 *    that before applying its own aggregate Roseberys factor on top, so for those few artists
 *    the "Roseberys factor" is counted at both a per-artist and an aggregate level. Flagged, not
 *    corrected, for a session-scope reason: undoing it needs re-querying each artist's raw
 *    profile with the house forced to Bonhams, not just reading the stored blend inputs.
 *
 * 2. OUTCOME: for every flagged lot, search the FULL Roseberys+Bonhams catalogue (not just the
 *    2,500-lot blend sample — the same appearance data repeat_sale_correction_report.ts uses)
 *    for a LATER sold appearance of the same nominal work, at EITHER house, within 365 days, and
 *    report how many sold for much higher. Control: the same search on Roseberys lots NOT
 *    flagged, to see whether the flag predicts anything beyond the base rate any Roseberys lot
 *    has of reappearing higher.
 *
 * SAME CAVEAT AS EVERY REPEAT-SALE CHECK THIS SESSION: "same nominal work" is very likely a
 * different physical impression of one edition, not the identical sheet re-consigned.
 *
 *   npx tsx tests/backtest/priors_undervaluation_screen.ts
 */
import { readFileSync } from "node:fs";
import { normalizeTitleKey, isLowInformationTitle, type BlendInputs } from "../../src/appraisal/knowledge_graph/index";

const ln = Math.log;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "n/a");
const argv = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const WITHIN_DAYS = Number(arg("within-days", "365"));

// ── stage 1: fit the 2-factor (priors, house) fair-value model on the blend sample ────────────
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
function ridgeFit(X: number[][], y: number[], alpha = 1.0, penalizedFrom = 1): number[] {
  const p = X[0].length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty: number[] = new Array(p).fill(0);
  for (let r = 0; r < X.length; r++) for (let i = 0; i < p; i++) { Xty[i] += X[r][i] * y[r]; for (let j = 0; j < p; j++) XtX[i][j] += X[r][i] * X[r][j]; }
  for (let i = penalizedFrom; i < p; i++) XtX[i][i] += alpha;
  return solve(XtX, Xty);
}

interface FlagRow {
  key: string; artist: string; title: string; saleDate: string; hammer: number; residual: number; flaggedUnderpriced: boolean;
  technique: string | null; signed: boolean | null; editionSize: number | null; areaCm2: number | null; bestTier: string; house: string;
}

function loadBlendRows(path: string, house: 0 | 1): { X: number[]; y: number; key: string; artist: string; title: string; saleDate: string; hammer: number; technique: string | null; signed: boolean | null; editionSize: number | null; areaCm2: number | null; bestTier: string; house: string }[] {
  const out: ReturnType<typeof loadBlendRows> = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.error || !r.sold || !r.hammer || r.hammer <= 0 || !r.blend?.inputs?.priors) continue;
    const inputs = r.blend.inputs as BlendInputs;
    const priorsMu = inputs.priors!.mu;
    const area = r.widthCm && r.heightCm ? r.widthCm * r.heightCm : null;
    out.push({
      X: [1, priorsMu, house], y: ln(r.hammer), key: `${(r.canonicalArtist ?? r.artist).trim().toLowerCase()}|${normalizeTitleKey(r.title ?? "")}`,
      artist: r.canonicalArtist ?? r.artist, title: r.title, saleDate: r.saleDate, hammer: r.hammer,
      technique: r.technique ?? null, signed: r.signed ?? null, editionSize: r.editionSize ?? null, areaCm2: area,
      bestTier: r.bestTier ?? "none", house: house ? "Roseberys London" : "Bonhams",
    });
  }
  return out;
}

// ── stage 2: full-catalogue appearance data for the outcome search ────────────────────────────
interface Appearance { key: string; date: string; house: "Roseberys London" | "Bonhams"; sold: boolean; hammer: number | null }
function parseCsv(t: string): string[][] {
  const rows: string[][] = []; let f = "", row: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function readCsv(path: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  const h = rows[0];
  return rows.slice(1).filter((r) => r.length >= h.length - 2).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
}
const keyOf = (artist: string, title: string): string | null => {
  const t = title.trim();
  if (!t || isLowInformationTitle(t)) return null;
  return `${artist.trim().toLowerCase()}|${normalizeTitleKey(t)}`;
};
function loadRoseberysAppearances(): Appearance[] {
  const dates = JSON.parse(readFileSync("knowledge_graph/roseberys_sale_dates.json", "utf8")).sales as Record<string, { saleDate: string }>;
  const out: Appearance[] = [];
  for (const r of readCsv("benchmark/data/all-prints/catalogue.csv")) {
    const saleDate = dates[r.sale_code]?.saleDate;
    if (!saleDate || r.multi_work.trim()) continue;
    const key = keyOf(r.artist, r.title);
    if (!key) continue;
    const hammer = Number(r.hammer);
    out.push({ key, date: saleDate, house: "Roseberys London", sold: r.sold === "sold", hammer: hammer > 0 ? hammer : null });
  }
  return out;
}
function loadBonhamsAppearances(): Appearance[] {
  const rows = JSON.parse(readFileSync("benchmark/data/bonhams/catalogue.json", "utf8")) as { artist: string; title: string | null; saleDate: string; sold: boolean; hammer: number | null }[];
  const out: Appearance[] = [];
  for (const r of rows) {
    if (!r.artist || !r.title) continue;
    const key = keyOf(r.artist, r.title);
    if (!key) continue;
    out.push({ key, date: r.saleDate, house: "Bonhams", sold: r.sold, hammer: r.hammer && r.hammer > 0 ? r.hammer : null });
  }
  return out;
}

function bootstrapCI(items: { key: string; v: number }[], draws = 1000): [number, number] {
  const byWork = new Map<string, number[]>();
  for (const c of items) (byWork.get(c.key) ?? byWork.set(c.key, []).get(c.key)!).push(c.v);
  const clusters = [...byWork.values()];
  let seed = 79; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const vals: number[] = [];
  for (let b = 0; b < draws; b++) { const sample: number[] = []; for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rnd() * clusters.length)]); vals.push(median(sample)); }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * (vals.length - 1))], vals[Math.floor(0.975 * (vals.length - 1))]];
}

function main() {
  // Stage 1: fit and flag.
  const blendRows = [...loadBlendRows("tests/backtest/comps_hammer/roseberys_n2500_blend_recency.jsonl", 1), ...loadBlendRows("tests/backtest/comps_hammer/bonhams_n2500_blend_recency.jsonl", 0)];
  const coef = ridgeFit(blendRows.map((r) => r.X), blendRows.map((r) => r.y));
  console.log(`fit: log(hammer) = ${coef[0].toFixed(3)} + ${coef[1].toFixed(3)}*priors_mu + ${coef[2].toFixed(3)}*house_is_roseberys  (n=${blendRows.length})`);
  console.log(`Roseberys relative price factor on HAMMER: x${Math.exp(coef[2]).toFixed(2)}`);

  const roseberysRows = blendRows.filter((r) => r.X[2] === 1);
  const flagged: FlagRow[] = roseberysRows.map((r) => {
    const predicted = coef[0] + coef[1] * r.X[1] + coef[2] * 1;
    const residual = r.y - predicted;
    return {
      key: r.key, artist: r.artist, title: r.title, saleDate: r.saleDate, hammer: r.hammer, residual, flaggedUnderpriced: residual < 0,
      technique: r.technique, signed: r.signed, editionSize: r.editionSize, areaCm2: r.areaCm2, bestTier: r.bestTier, house: r.house,
    };
  });
  const underpriced = flagged.filter((f) => f.flaggedUnderpriced);
  console.log(`\nRoseberys sold lots with a priors profile: ${flagged.length}; flagged underpriced (hammer < Roseberys-adjusted fair price): ${underpriced.length} (${pct(underpriced.length, flagged.length)})`);

  // Stage 2: search the full catalogue for a later, higher sale.
  const appearances = [...loadRoseberysAppearances(), ...loadBonhamsAppearances()];
  const byKey = new Map<string, Appearance[]>();
  for (const a of appearances) (byKey.get(a.key) ?? byKey.set(a.key, []).get(a.key)!).push(a);
  for (const list of byKey.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  function outcomeFor(f: FlagRow): { found: boolean; ratio: number | null; house: string | null; gapDays: number | null } {
    const list = byKey.get(f.key);
    if (!list) return { found: false, ratio: null, house: null, gapDays: null };
    for (const a of list) {
      if (!a.sold || !a.hammer) continue;
      const gap = (new Date(a.date).getTime() - new Date(f.saleDate).getTime()) / 86400000;
      if (gap <= 0 || gap > WITHIN_DAYS) continue;
      return { found: true, ratio: a.hammer / f.hammer, house: a.house, gapDays: gap };
    }
    return { found: false, ratio: null, house: null, gapDays: null };
  }

  function report(label: string, rows: FlagRow[]) {
    const outcomes = rows.map((r) => ({ r, o: outcomeFor(r) }));
    const withNext = outcomes.filter((x) => x.o.found);
    console.log(`\n── ${label} (n=${rows.length}) ──`);
    console.log(`  had a later sold appearance (either house) within ${WITHIN_DAYS} days: ${withNext.length} (${pct(withNext.length, rows.length)})`);
    if (!withNext.length) return;
    const ratios = withNext.map((x) => x.o.ratio!);
    const logRatios = ratios.map((r) => ln(r));
    const m = median(logRatios);
    const [lo, hi] = bootstrapCI(withNext.map((x) => ({ key: x.r.key, v: ln(x.o.ratio!) })));
    console.log(`  median next-sale/flagged-hammer: ${Math.exp(m).toFixed(2)}x   95% CI [${Math.exp(lo).toFixed(2)}x, ${Math.exp(hi).toFixed(2)}x]`);
    console.log(`  sold >=1.5x higher: ${pct(withNext.filter((x) => x.o.ratio! >= 1.5).length, withNext.length)}   >=2x: ${pct(withNext.filter((x) => x.o.ratio! >= 2).length, withNext.length)}   went DOWN: ${pct(withNext.filter((x) => x.o.ratio! < 1).length, withNext.length)}`);
    const toBonhams = withNext.filter((x) => x.o.house === "Bonhams");
    console.log(`  of those, next sale was at Bonhams: ${toBonhams.length} (${pct(toBonhams.length, withNext.length)})`);
  }

  report("FLAGGED underpriced (hammer < priors fair price, less the Roseberys factor)", underpriced);
  report("NOT flagged (control)", flagged.filter((f) => !f.flaggedUnderpriced));

  const sortedUnder = [...underpriced].map((f) => ({ f, o: outcomeFor(f) })).filter((x) => x.o.found).sort((a, b) => (b.o.ratio ?? 0) - (a.o.ratio ?? 0));
  console.log(`\n── Top 10 flagged-underpriced lots with the biggest later jump (illustrative) ──`);
  for (const { f, o } of sortedUnder.slice(0, 10)) {
    console.log(`  ${f.artist.slice(0, 22).padEnd(23)} / ${f.title.slice(0, 26).padEnd(27)} £${f.hammer.toFixed(0).padStart(7)} -> ${o.house?.slice(0, 4)} ${o.ratio!.toFixed(2)}x  (${o.gapDays?.toFixed(0)}d later, model said x${Math.exp(-f.residual).toFixed(2)} more than it hammered for)`);
  }

  // ── does anything characterise the >=2x winners vs. the rest of the flagged, checkable pool? ──
  const checkable = underpriced.map((f) => ({ f, o: outcomeFor(f) })).filter((x) => x.o.found);
  const bigWin = checkable.filter((x) => x.o.ratio! >= 2);
  const rest = checkable.filter((x) => x.o.ratio! < 2);
  console.log(`\n── What distinguishes the >=2x winners (n=${bigWin.length}) from the rest of the flagged, checkable pool (n=${rest.length})? ──`);
  const med = (xs: number[]) => median(xs);
  const compare = (label: string, pick: (x: (typeof checkable)[number]) => number | null) => {
    const w = bigWin.map(pick).filter((v): v is number => v != null), r = rest.map(pick).filter((v): v is number => v != null);
    if (!w.length || !r.length) { console.log(`  ${label}: insufficient data`); return; }
    console.log(`  ${label.padEnd(28)} winners median ${med(w).toFixed(2).padStart(8)}   rest median ${med(r).toFixed(2).padStart(8)}   (n=${w.length} vs ${r.length})`);
  };
  compare("flagged hammer (£, log)", (x) => ln(x.f.hammer));
  compare("model mispricing (log x)", (x) => -x.f.residual);
  compare("gap to next sale (days)", (x) => x.o.gapDays);
  compare("edition size", (x) => x.f.editionSize);
  compare("sheet area (cm²)", (x) => x.f.areaCm2);
  const share = (label: string, pick: (x: (typeof checkable)[number]) => boolean) => {
    const w = bigWin.filter(pick).length, r = rest.filter(pick).length;
    console.log(`  ${label.padEnd(28)} winners ${pct(w, bigWin.length).padStart(4)}   rest ${pct(r, rest.length).padStart(4)}`);
  };
  share("signed", (x) => x.f.signed === true);
  share("had a same-work comp (tier 1)", (x) => x.f.bestTier === "same_work");
  share("next sale at Bonhams", (x) => x.o.house === "Bonhams");
  share("next sale within 180 days", (x) => (x.o.gapDays ?? 9999) <= 180);
  console.log(`\n  Artists among the >=2x winners: ${[...new Set(bigWin.map((x) => x.f.artist))].join(", ")}`);
  console.log(`  Techniques among the >=2x winners: ${[...new Set(bigWin.map((x) => x.f.technique).filter(Boolean))].join(", ") || "not captured for these rows"}`);

  console.log(`\nNB: "same nominal work" across appearances is very likely a DIFFERENT physical impression`);
  console.log(`    of one edition, not the identical sheet re-consigned.`);
}

main();
