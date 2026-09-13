/**
 * Pipeline valuation vs HAMMER — for stored backtest results whose lot has since sold.
 *
 *   npx tsx tests/backtest/hammer_report.ts [--dir tests/backtest/output] [--suffix _attr]
 *
 * valuation_report.ts scores the pipeline against the catalogue estimate and says in its
 * own header that this is not ground truth. This report scores it against what the lot
 * actually made. Hammer and the premium-inclusive realised price come from the benchmark
 * catalogue CSVs (all-prints + the per-sale files), joined on sale code + lot number, with
 * the run's own rawLot (rostrum_hammer / hammer_price / sold) as fallback.
 *
 * Two ratios are shown because the pipeline's number is on an ambiguous basis: its prompt
 * asks for an auction ESTIMATE (hammer basis) but since ADR-0016 it anchors on graph comps
 * that are PREMIUM-INCLUSIVE. If the pipeline sits ~1.25-1.3x above hammer and ~1.0x on
 * realised, that is a basis mismatch, not a valuation error, and it is fixable in the prompt.
 *
 * Lots from upcoming sales (no hammer yet) are listed but not scored. Unsold lots are
 * reported separately: an unsold lot says the market would not clear the reserve, which is
 * normally at or near the low estimate — a pipeline range whose LOW sits above the catalogue
 * low on an unsold lot was pointing the wrong way.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DIR = arg("dir", "tests/backtest/output");
const SUFFIX = arg("suffix", "");

// ── catalogue join ────────────────────────────────────────────────────────────
function parseCsv(t: string): string[][] {
  const rows: string[][] = [];
  let f = "", row: string[] = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
interface Outcome { sold: boolean; hammer: number | null; realised: number | null; lowEst: number; highEst: number; source: string }
const outcomes = new Map<string, Outcome>();
for (const p of ["benchmark/data/all-prints/catalogue.csv", "benchmark/data/catalogue.csv", "benchmark/data/A0793/catalogue.csv", "benchmark/data/forum/catalogue.csv"]) {
  if (!existsSync(p)) continue;
  const rows = parseCsv(readFileSync(p, "utf8").replace(/^﻿/, ""));
  const h = rows[0], ix = (n: string) => h.indexOf(n);
  for (const r of rows.slice(1)) {
    if (r.length < h.length - 2) continue;
    const key = `${r[ix("sale_code")]}_${r[ix("lot_number")]}`;
    if (outcomes.has(key) && outcomes.get(key)!.hammer) continue;
    const hammer = Number(r[ix("hammer")] || 0), realised = Number(r[ix("price_realised_inc_premium")] || 0);
    outcomes.set(key, {
      sold: r[ix("sold")] === "sold", hammer: hammer > 0 ? hammer : null, realised: realised > 0 ? realised : null,
      lowEst: Number(r[ix("low_estimate")] || 0), highEst: Number(r[ix("high_estimate")] || 0), source: p,
    });
  }
}

// ── stored results ────────────────────────────────────────────────────────────
interface Row {
  dir: string; artist: string; attributed: boolean; method: string;
  appLow: number; appHigh: number; catLow: number; catHigh: number;
  sold: boolean | null; hammer: number | null; realised: number | null;
}
const rows: Row[] = [];
for (const d of readdirSync(DIR)) {
  const p = `${DIR}/${d}/result.json`;
  if (!statSync(`${DIR}/${d}`).isDirectory() || !existsSync(p)) continue;
  if (SUFFIX && !d.endsWith(SUFFIX)) continue;
  const j = JSON.parse(readFileSync(p, "utf8"));
  const est = j.report?.auctionEstimate;
  if (!est?.lowEstimate) continue;
  const raw = j.rawLot ?? {};
  const saleCode: string = j.sale?.saleCode ?? d.split("_")[0];
  const lotNumber = raw.lot_number ?? d.split("_")[1];
  const o = outcomes.get(`${saleCode}_${lotNumber}`);
  const rawSold = raw.sold === 1 || raw.sold === true;
  const rawRealised = Number(String(raw.hammer_price ?? "").replace(/[^0-9.]/g, "")) || null;
  const rawHammer = Number(raw.rostrum_hammer) || null;
  rows.push({
    dir: d, artist: j.groundTruth?.artist ?? "?", attributed: !!j.attributionProvided, method: j.method ?? "?",
    appLow: est.lowEstimate, appHigh: est.highEstimate,
    catLow: o?.lowEst ?? raw.low_estimate ?? 0, catHigh: o?.highEst ?? raw.high_estimate ?? 0,
    sold: o ? o.sold : raw.sold == null ? null : rawSold,
    hammer: o?.hammer ?? (rawSold ? rawHammer : null),
    realised: o?.realised ?? (rawSold ? rawRealised : null),
  });
}
if (!rows.length) { console.log(`No valued results under ${DIR}${SUFFIX ? ` matching "${SUFFIX}"` : ""}.`); process.exit(0); }

const money = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
const ln = Math.log, f2 = (x: number) => x.toFixed(2);
const geo = (xs: number[]) => Math.exp(xs.reduce((t, x) => t + x, 0) / xs.length);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "-");

const soldRows = rows.filter((r) => r.sold && r.hammer);
const unsoldRows = rows.filter((r) => r.sold === false);
const pending = rows.filter((r) => r.sold == null || (r.sold && !r.hammer));

console.log(`\nPipeline valuation vs HAMMER — ${rows.length} stored result(s) under ${DIR}${SUFFIX ? ` (${SUFFIX})` : ""}`);
console.log(`  sold with hammer: ${soldRows.length}   unsold: ${unsoldRows.length}   no outcome yet: ${pending.length}\n`);

if (soldRows.length) {
  console.log(`${"lot".padEnd(22)} ${"artist".padEnd(20)} ${"pipeline".padStart(15)} ${"catalogue".padStart(13)} ${"hammer".padStart(7)} ${"realised".padStart(8)} ${"mid/ham".padStart(7)} ${"mid/real".padStart(8)}  flags`);
  for (const r of soldRows.sort((a, b) => (a.appLow + a.appHigh) / 2 / a.hammer! - (b.appLow + b.appHigh) / 2 / b.hammer!)) {
    const mid = (r.appLow + r.appHigh) / 2;
    const flags = [
      r.hammer! >= r.appLow && r.hammer! <= r.appHigh ? "ham-in-app" : "ham-OUT-app",
      r.hammer! >= r.catLow && r.hammer! <= r.catHigh ? "ham-in-cat" : "ham-out-cat",
      r.attributed ? "attr" : "blind",
    ].join(" ");
    console.log(
      `${r.dir.slice(0, 22).padEnd(22)} ${r.artist.slice(0, 20).padEnd(20)} ${`${money(r.appLow)}-${money(r.appHigh)}`.padStart(15)} ` +
      `${`${money(r.catLow)}-${money(r.catHigh)}`.padStart(13)} ${money(r.hammer!).padStart(7)} ${(r.realised ? money(r.realised) : "-").padStart(8)} ` +
      `${f2(mid / r.hammer!).padStart(7)} ${(r.realised ? f2(mid / r.realised) : "-").padStart(8)}  ${flags}`,
    );
  }
  const toHam = soldRows.map((r) => ln((r.appLow + r.appHigh) / 2 / r.hammer!));
  const withReal = soldRows.filter((r) => r.realised);
  const toReal = withReal.map((r) => ln((r.appLow + r.appHigh) / 2 / r.realised!));
  const hamInApp = soldRows.filter((r) => r.hammer! >= r.appLow && r.hammer! <= r.appHigh).length;
  const hamInCat = soldRows.filter((r) => r.hammer! >= r.catLow && r.hammer! <= r.catHigh).length;
  const catToHam = soldRows.filter((r) => r.catLow && r.catHigh).map((r) => ln((r.catLow + r.catHigh) / 2 / r.hammer!));
  console.log(`\n  hammer inside PIPELINE range   : ${hamInApp}/${soldRows.length} (${pct(hamInApp, soldRows.length)})`);
  console.log(`  hammer inside CATALOGUE range  : ${hamInCat}/${soldRows.length} (${pct(hamInCat, soldRows.length)})   <- the house's own hit rate on these lots`);
  console.log(`  pipeline mid / hammer          : median ${f2(Math.exp(med(toHam)))}  geo-mean ${f2(geo(toHam))}`);
  if (toReal.length) console.log(`  pipeline mid / realised        : median ${f2(Math.exp(med(toReal)))}  geo-mean ${f2(geo(toReal))}   (n=${toReal.length})`);
  if (catToHam.length) console.log(`  catalogue mid / hammer         : median ${f2(Math.exp(med(catToHam)))}  geo-mean ${f2(geo(catToHam))}`);
  for (const [label, sel] of [["blind", (r: Row) => !r.attributed], ["attributed", (r: Row) => r.attributed]] as const) {
    const g = soldRows.filter(sel);
    if (!g.length) continue;
    const xs = g.map((r) => ln((r.appLow + r.appHigh) / 2 / r.hammer!));
    const inApp = g.filter((r) => r.hammer! >= r.appLow && r.hammer! <= r.appHigh).length;
    console.log(`    ${label.padEnd(11)} n=${g.length}  mid/hammer geo-mean ${f2(geo(xs))}  hammer inside pipeline range ${pct(inApp, g.length)}`);
  }
}

if (unsoldRows.length) {
  console.log(`\nUnsold lots (no hammer; the market would not clear the reserve, normally at or near the catalogue low):`);
  for (const r of unsoldRows) {
    const verdict = r.appLow > r.catLow ? "pipeline low ABOVE catalogue low — wrong direction" : r.appHigh < r.catLow ? "pipeline entirely below catalogue low — right direction" : "pipeline straddles catalogue low";
    console.log(`  ${r.dir.slice(0, 22).padEnd(22)} ${r.artist.slice(0, 20).padEnd(20)} pipeline ${money(r.appLow)}-${money(r.appHigh)}  catalogue ${money(r.catLow)}-${money(r.catHigh)}  ${verdict}`);
  }
}
if (pending.length) {
  console.log(`\nNo outcome yet (${pending.length}): ${pending.map((r) => r.dir).join(", ")}`);
}
console.log(`\n  Pipeline numbers are meant as hammer-basis estimates but anchor on premium-inclusive comps since ADR-0016;`);
console.log(`  read mid/hammer and mid/realised together before calling a bias a valuation error.\n`);
