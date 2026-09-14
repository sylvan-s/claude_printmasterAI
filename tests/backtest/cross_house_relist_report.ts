/**
 * Plan step 9 — does switching houses escape the re-listing discount, or does it follow the
 * work anywhere?
 *
 * Prompted directly by a user hypothesis: an unsold-then-repriced lot is a "distressed sale"
 * signal, and if you wait roughly a year and consign the NEXT attempt to a different, stronger
 * house (Bonhams rather than Roseberys), you recover the ~30% cut plus the general house-tier
 * premium. `relist_discount_report.ts` measured the SAME-HOUSE version of this (confirmed: real,
 * ~30% at a short gap, fading by a year) but never asked whether the discount is a house-specific
 * "institutional memory" of the failure (which a venue switch would escape) or a genuine
 * repricing of the work's demand (which would follow it to any house). This script walks
 * consecutive appearances of the same nominal work ACROSS houses and asks exactly that,
 * splitting by whether the switch happened soon or roughly a year later, matching the
 * hypothesis's own timing.
 *
 * Data: the local Roseberys catalogue (which, unlike the graph, has estimates on unsold lots —
 * see the ingest gap found earlier this session, task_c3f61cab, running) UNION the Bonhams
 * export already pulled this session (benchmark/data/bonhams/catalogue.json). Forum is excluded
 * — its SourceRecords carry no date at all (task_7cae1bb7, running). Grouped by an EXACT
 * (artist, normalizeTitleKey(title)) key, no fuzzy matching, same convention as the rest of this
 * plan's work.
 *
 * SAME CAVEAT AS THE EARLIER FLIP DISCUSSION: consecutive appearances of "the same work" across
 * houses are very likely DIFFERENT physical impressions of one edition, not the identical sheet
 * moving between owners. This measures how the MARKET-WIDE nominal-work estimate behaves across
 * a venue switch, not whether a specific purchased copy would see this exact effect.
 *
 *   npx tsx tests/backtest/cross_house_relist_report.ts
 */
import { readFileSync } from "node:fs";
import { normalizeTitleKey, isLowInformationTitle } from "../../src/appraisal/knowledge_graph/index";

const ln = Math.log;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "n/a");

interface Appearance { key: string; date: string; house: "Roseberys London" | "Bonhams"; sold: boolean; low: number; high: number }

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

function loadRoseberys(): Appearance[] {
  const dates = JSON.parse(readFileSync("knowledge_graph/roseberys_sale_dates.json", "utf8")).sales as Record<string, { saleDate: string }>;
  const rows = readCsv("benchmark/data/all-prints/catalogue.csv");
  const out: Appearance[] = [];
  for (const r of rows) {
    const saleDate = dates[r.sale_code]?.saleDate;
    if (!saleDate) continue;
    if (r.multi_work.trim()) continue;
    if (r.artist_qualifier && r.artist_qualifier !== "certain") continue;
    const key = keyOf(r.artist, r.title);
    if (!key) continue;
    const low = Number(r.low_estimate), high = Number(r.high_estimate);
    if (!(low > 0) || !(high > 0)) continue;
    out.push({ key, date: saleDate, house: "Roseberys London", sold: r.sold === "sold", low, high });
  }
  return out;
}
function loadBonhams(): Appearance[] {
  const rows = JSON.parse(readFileSync("benchmark/data/bonhams/catalogue.json", "utf8")) as {
    artist: string; title: string | null; saleDate: string; lowEst: number | null; highEst: number | null; sold: boolean;
  }[];
  const out: Appearance[] = [];
  for (const r of rows) {
    if (!r.artist || !r.title) continue;
    const key = keyOf(r.artist, r.title);
    if (!key) continue;
    if (!(r.lowEst! > 0) || !(r.highEst! > 0)) continue;
    out.push({ key, date: r.saleDate, house: "Bonhams", sold: r.sold, low: r.lowEst!, high: r.highEst! });
  }
  return out;
}

interface Pair { key: string; gapDays: number; logRatio: number; prevHouse: string; nextHouse: string; prevSold: boolean }

function main() {
  const all = [...loadRoseberys(), ...loadBonhams()];
  const groups = new Map<string, Appearance[]>();
  for (const a of all) (groups.get(a.key) ?? groups.set(a.key, []).get(a.key)!).push(a);

  const crossHouse: Pair[] = [];
  const sameHouse: Pair[] = [];
  for (const apps of groups.values()) {
    if (apps.length < 2) continue;
    apps.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < apps.length; i++) {
      const prev = apps[i - 1], next = apps[i];
      const prevMid = (prev.low + prev.high) / 2, nextMid = (next.low + next.high) / 2;
      const gapDays = (new Date(next.date).getTime() - new Date(prev.date).getTime()) / 86400000;
      if (!Number.isFinite(gapDays) || gapDays < 0) continue;
      const p: Pair = { key: prev.key, gapDays, logRatio: ln(nextMid / prevMid), prevHouse: prev.house, nextHouse: next.house, prevSold: prev.sold };
      (prev.house === next.house ? sameHouse : crossHouse).push(p);
    }
  }
  console.log(`${crossHouse.length} cross-house consecutive pairs, ${sameHouse.length} same-house (for comparison)`);

  function block(label: string, pairs: Pair[]) {
    if (!pairs.length) { console.log(`  ${label}: n=0`); return; }
    const m = median(pairs.map((p) => p.logRatio));
    const cut30 = pairs.filter((p) => p.logRatio <= ln(0.7)).length;
    const up = pairs.filter((p) => p.logRatio > 0).length;
    console.log(`  ${label.padEnd(52)} n=${String(pairs.length).padStart(4)}  median ${Math.exp(m).toFixed(2)}x (${m >= 0 ? "+" : ""}${(100 * (Math.exp(m) - 1)).toFixed(0)}%)  cut>=30%: ${pct(cut30, pairs.length)}  ABOVE prev estimate: ${pct(up, pairs.length)}`);
  }

  console.log(`\n── Roseberys -> Bonhams, split by whether the Roseberys attempt sold ──`);
  const rb = crossHouse.filter((p) => p.prevHouse === "Roseberys London" && p.nextHouse === "Bonhams");
  block("previous UNSOLD at Roseberys -> next Bonhams estimate", rb.filter((p) => !p.prevSold));
  block("previous SOLD at Roseberys -> next Bonhams estimate (baseline)", rb.filter((p) => p.prevSold));
  const rbUnsold = rb.filter((p) => !p.prevSold);
  if (rbUnsold.length) {
    console.log(`  split by gap to the Bonhams appearance (tests the "wait ~a year" part of the hypothesis):`);
    for (const [lbl, test] of [["<=180 days", (d: number) => d <= 180], ["181-365 days", (d: number) => d > 180 && d <= 365], [">365 days", (d: number) => d > 365]] as const) {
      block(`     ${lbl}`, rbUnsold.filter((p) => test(p.gapDays)));
    }
  }

  console.log(`\n── Bonhams -> Roseberys, split by whether the Bonhams attempt sold (the reverse direction) ──`);
  const br = crossHouse.filter((p) => p.prevHouse === "Bonhams" && p.nextHouse === "Roseberys London");
  block("previous UNSOLD at Bonhams -> next Roseberys estimate", br.filter((p) => !p.prevSold));
  block("previous SOLD at Bonhams -> next Roseberys estimate (baseline)", br.filter((p) => p.prevSold));

  console.log(`\n── For direct comparison: the SAME-HOUSE numbers already measured (relist_discount_report.ts) ──`);
  block("Roseberys, previous UNSOLD -> next Roseberys estimate", sameHouse.filter((p) => p.prevHouse === "Roseberys London" && !p.prevSold));
  block("Bonhams, previous UNSOLD -> next Bonhams estimate", sameHouse.filter((p) => p.prevHouse === "Bonhams" && !p.prevSold));

  console.log(`\nNB: "same nominal work" across houses is very likely a DIFFERENT physical impression of one`);
  console.log(`    edition, not the identical sheet re-consigned — see the header comment.`);
}

main();
