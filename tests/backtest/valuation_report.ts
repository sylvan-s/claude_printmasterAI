/**
 * Valuation accuracy across stored backtest results.
 *
 *   npx tsx tests/backtest/valuation_report.ts [--dir tests/backtest/output] [--suffix _attr]
 *
 * NB the suffix uses underscores: lot ids are slugified into directory names, so an
 * --attributed run of A0793 lot 113 lands in A0793_113_1c1d_attr, not ...-attr.
 *
 * The blind runs answer "can the pipeline identify this?". Once attribution is supplied
 * (--attributed), the remaining question is whether the NUMBER is defensible, and a single
 * lot cannot answer that — an estimate range either overlaps or it doesn't. What matters is
 * the distribution: does the pipeline sit systematically low or high, and by how much.
 *
 * The catalogue estimate is the yardstick here, NOT ground truth. It is the auction house's
 * pre-sale opinion, and houses estimate conservatively to attract bidding. Reading a
 * midpoint ratio below 1.0 as "the pipeline undervalues" assumes the house is right.
 * Hammer prices after the sale are the real test.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DIR = arg("dir", "tests/backtest/output");
const SUFFIX = arg("suffix", "");

interface Row {
  lot: string;
  artist: string;
  attributed: boolean;
  appLow: number; appHigh: number;
  gtLow: number; gtHigh: number;
  ratio: number; overlaps: boolean; midInRange: boolean;
}

const rows: Row[] = [];
for (const d of readdirSync(DIR)) {
  const p = `${DIR}/${d}/result.json`;
  if (!statSync(`${DIR}/${d}`).isDirectory() || !existsSync(p)) continue;
  if (SUFFIX && !d.endsWith(SUFFIX)) continue;
  const j = JSON.parse(readFileSync(p, "utf8"));
  const est = j.report?.auctionEstimate;
  const gtLow = j.rawLot?.low_estimate, gtHigh = j.rawLot?.high_estimate;
  if (!est || gtLow == null || gtHigh == null || !est.lowEstimate) continue;
  const appMid = (est.lowEstimate + est.highEstimate) / 2;
  const gtMid = (gtLow + gtHigh) / 2;
  rows.push({
    lot: d, artist: j.groundTruth?.artist ?? "?", attributed: !!j.attributionProvided,
    appLow: est.lowEstimate, appHigh: est.highEstimate, gtLow, gtHigh,
    ratio: gtMid > 0 ? appMid / gtMid : 0,
    overlaps: est.lowEstimate <= gtHigh && est.highEstimate >= gtLow,
    midInRange: appMid >= gtLow && appMid <= gtHigh,
  });
}

if (!rows.length) { console.log(`No valued results under ${DIR}${SUFFIX ? ` matching "${SUFFIX}"` : ""}.`); process.exit(0); }

rows.sort((a, b) => a.ratio - b.ratio);
const money = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
console.log(`\nValuation vs catalogue estimate — ${rows.length} lot(s) from ${DIR}${SUFFIX ? ` (${SUFFIX})` : ""}\n`);
console.log(`${"lot".padEnd(22)} ${"artist".padEnd(22)} ${"pipeline".padStart(16)} ${"catalogue".padStart(16)} ${"ratio".padStart(6)}  flags`);
for (const r of rows) {
  const flags = [r.overlaps ? "overlap" : "DISJOINT", r.midInRange ? "mid-in" : "mid-out", r.attributed ? "attr" : "blind"].join(" ");
  console.log(
    `${r.lot.slice(0, 22).padEnd(22)} ${r.artist.slice(0, 22).padEnd(22)} ` +
      `${`${money(r.appLow)}-${money(r.appHigh)}`.padStart(16)} ${`${money(r.gtLow)}-${money(r.gtHigh)}`.padStart(16)} ` +
      `${r.ratio.toFixed(2).padStart(6)}  ${flags}`,
  );
}

const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
const median = ratios[Math.floor(ratios.length / 2)];
// Geometric mean: valuation error is multiplicative — 0.5x and 2x are equally wrong, and an
// arithmetic mean would call that pair a 1.25x average bias rather than none.
const geo = Math.exp(ratios.reduce((t, r) => t + Math.log(Math.max(r, 1e-6)), 0) / ratios.length);
console.log(`\n  ranges overlapping      : ${rows.filter((r) => r.overlaps).length}/${rows.length}`);
console.log(`  midpoint inside range   : ${rows.filter((r) => r.midInRange).length}/${rows.length}`);
console.log(`  midpoint ratio median   : ${median.toFixed(2)}`);
console.log(`  midpoint ratio geo-mean : ${geo.toFixed(2)}   ${geo < 0.8 ? "(systematically LOW)" : geo > 1.25 ? "(systematically HIGH)" : "(no strong bias)"}`);
console.log(`  spread                  : ${ratios[0].toFixed(2)} - ${ratios[ratios.length - 1].toFixed(2)}`);
console.log(`\n  NB the catalogue estimate is the house's pre-sale opinion, not ground truth.`);
console.log(`  Houses estimate to attract bidding. Hammer prices after 23 Sept are the real test.\n`);
