/**
 * Plan step 9 — does a house cut the estimate when it RE-OFFERS a lot that just failed to sell?
 *
 * Prompted directly by a correction from Roseberys (2026-09-14): they told the user they
 * typically discount an unsold lot up to 30% for its next auction. The pooled liquidity-history
 * dummies added to `estimate_model.ts` found no effect — but that model asks a different,
 * coarser question ("does this work's sell-through rate over a 10-year window correlate with
 * today's estimate"), not the specific sequential pattern described: fails once, gets
 * RE-OFFERED, with a cut. This script tests that pattern directly: for every ConceptualWork
 * with 2+ dated, estimated auction appearances at the SAME house, walk consecutive pairs and
 * measure the estimate-midpoint change from one appearance to the next, split by whether the
 * earlier appearance sold or not. If the practice is real, the "previous unsold" pairs should
 * show a real, negative, roughly-30%-ish shift that the "previous sold" pairs don't.
 *
 * Caveat carried over from the cross-house flip question earlier in this session: consecutive
 * appearances of the "same work" may be different physical impressions from the same edition,
 * not the identical sheet re-consigned. A short gap between an unsold appearance and the next
 * one at the SAME house, on the SAME nominal work, is the closest this graph can get to "the
 * same lot was re-offered" without individual-copy tracking — read the gap-day split as
 * evidence toward that, not proof of it.
 *
 *   npx tsx tests/backtest/relist_discount_report.ts
 */
import { readFileSync } from "node:fs";
import { getDriver, getDatabase, closeDriver } from "../../src/appraisal/knowledge_graph/client";
import { normalizeTitleKey, isLowInformationTitle } from "../../src/appraisal/knowledge_graph/index";

const QUERY = `
MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE s.institutionName IN ['Roseberys London','Bonhams'] AND s.sourceType='auction' AND s.saleDate IS NOT NULL
  AND s.estimateLowGBP IS NOT NULL AND s.estimateHighGBP IS NOT NULL AND s.estimateLowGBP > 0
WITH cw, s.institutionName AS house, s
ORDER BY s.saleDate
WITH cw.name AS work, house, collect({date: s.saleDate, sold: s.sold, low: s.estimateLowGBP, high: s.estimateHighGBP}) AS apps
WHERE size(apps) >= 2
RETURN work, house, apps
`;

const num = (v: any): number | null => (v == null ? null : typeof v === "number" ? v : v.toNumber?.() ?? Number(v));
const ln = Math.log;

interface Pair { house: string; work: string; gapDays: number; logRatio: number; prevSold: boolean; prevMid: number; nextMid: number }

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "n/a");

/** Artist/work-clustered-free bootstrap (pairs from the same work are already adjacent
 *  observations of one lot's history; resample at the WORK level so one prolific work with many
 *  relist pairs doesn't dominate the CI). */
function bootstrapCI(pairs: Pair[], stat: (ps: Pair[]) => number, draws = 500): [number, number] {
  const byWork = new Map<string, Pair[]>();
  for (const p of pairs) (byWork.get(p.work) ?? byWork.set(p.work, []).get(p.work)!).push(p);
  const clusters = [...byWork.values()];
  let seed = 41; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const vals: number[] = [];
  for (let b = 0; b < draws; b++) {
    const sample: Pair[] = []; for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rnd() * clusters.length)]);
    vals.push(stat(sample));
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * (vals.length - 1))], vals[Math.floor(0.975 * (vals.length - 1))]];
}

function report(house: string, pairs: Pair[]) {
  const prevUnsold = pairs.filter((p) => !p.prevSold);
  const prevSold = pairs.filter((p) => p.prevSold);
  console.log(`\n── ${house} ──`);
  console.log(`  total consecutive pairs: ${pairs.length}  (previous unsold: ${prevUnsold.length}, previous sold: ${prevSold.length})`);
  for (const [label, ps] of [["previous UNSOLD -> next estimate", prevUnsold], ["previous SOLD -> next estimate (baseline drift)", prevSold]] as const) {
    if (!ps.length) { console.log(`  ${label}: n=0`); continue; }
    const logs = ps.map((p) => p.logRatio);
    const m = median(logs);
    const [lo, hi] = bootstrapCI(ps, (xs) => median(xs.map((p) => p.logRatio)));
    const anyCut = ps.filter((p) => p.logRatio < 0).length;
    const cut10 = ps.filter((p) => p.logRatio <= ln(0.9)).length;
    const cut30 = ps.filter((p) => p.logRatio <= ln(0.7)).length;
    console.log(`  ${label} (n=${ps.length})`);
    console.log(`     median next/prev = ${Math.exp(m).toFixed(2)}x (${m >= 0 ? "+" : ""}${(100 * (Math.exp(m) - 1)).toFixed(0)}%)   95% CI on the median [${Math.exp(lo).toFixed(2)}x, ${Math.exp(hi).toFixed(2)}x]`);
    console.log(`     any cut at all: ${pct(anyCut, ps.length)}   cut >=10%: ${pct(cut10, ps.length)}   cut >=30% (the stated practice): ${pct(cut30, ps.length)}`);
  }
  // Split the "previous unsold" cohort by how soon the relist happened — a real re-offering
  // practice should show up strongest at a short gap, not spread evenly over years.
  if (prevUnsold.length) {
    console.log(`  previous-unsold pairs, split by gap to the next appearance:`);
    for (const [label, test] of [["<=180 days", (d: number) => d <= 180], ["181-365 days", (d: number) => d > 180 && d <= 365], [">365 days", (d: number) => d > 365]] as const) {
      const ps = prevUnsold.filter((p) => test(p.gapDays));
      if (ps.length < 5) { console.log(`     ${label}: n=${ps.length} (too few)`); continue; }
      const m = median(ps.map((p) => p.logRatio));
      console.log(`     ${label.padEnd(14)} n=${String(ps.length).padStart(4)}  median ${Math.exp(m).toFixed(2)}x (${m >= 0 ? "+" : ""}${(100 * (Math.exp(m) - 1)).toFixed(0)}%)  cut>=30%: ${pct(ps.filter((p) => p.logRatio <= ln(0.7)).length, ps.length)}`);
    }
  }
}

// ── Roseberys from the local catalogue, not the graph ──────────────────────────
// The graph gap found 2026-09-14: EVERY unsold Roseberys SourceRecord (3,846 of them) has a
// NULL estimateLowGBP/HighGBP, even though the source catalogue has one for 5,164 of 5,170
// unsold rows (99.9%) — an ingest defect, not a source-data gap. Flagged as a follow-up; this
// script routes around it by reading the catalogue directly, the same file
// comps_hammer_backtest.ts's loadRoseberys() reads, using an exact (artist, normalized title)
// key — no fuzzy/similarity matching — as the work-identity substitute for a resolved
// ConceptualWork id.
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
function roseberysPairs(): Pair[] {
  const dates = JSON.parse(readFileSync("knowledge_graph/roseberys_sale_dates.json", "utf8")).sales as Record<string, { saleDate: string }>;
  const rows = readCsv("benchmark/data/all-prints/catalogue.csv");
  const groups = new Map<string, { date: string; sold: boolean; low: number; high: number }[]>();
  for (const r of rows) {
    const saleDate = dates[r.sale_code]?.saleDate;
    if (!saleDate) continue;
    if (r.multi_work.trim()) continue;
    if (r.artist_qualifier && r.artist_qualifier !== "certain") continue;
    const title = r.title.trim();
    if (!title || isLowInformationTitle(title)) continue;
    const low = Number(r.low_estimate), high = Number(r.high_estimate);
    if (!(low > 0) || !(high > 0)) continue;
    const key = `${r.artist.trim().toLowerCase()}|${normalizeTitleKey(title)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ date: saleDate, sold: r.sold === "sold", low, high });
  }
  const pairs: Pair[] = [];
  for (const [work, apps] of groups) {
    if (apps.length < 2) continue;
    apps.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < apps.length; i++) {
      const prev = apps[i - 1], next = apps[i];
      const prevMid = (prev.low + prev.high) / 2, nextMid = (next.low + next.high) / 2;
      const gapDays = (new Date(next.date).getTime() - new Date(prev.date).getTime()) / 86400000;
      if (!Number.isFinite(gapDays) || gapDays < 0) continue;
      pairs.push({ house: "Roseberys London (from catalogue)", work, gapDays, logRatio: ln(nextMid / prevMid), prevSold: prev.sold, prevMid, nextMid });
    }
  }
  return pairs;
}

async function main() {
  const session = getDriver().session({ database: getDatabase() });
  const allPairs: Pair[] = [];
  try {
    const res = await session.run(QUERY);
    for (const rec of res.records) {
      const work = rec.get("work") as string;
      const house = rec.get("house") as string;
      const apps = (rec.get("apps") as any[]).map((a) => ({
        date: a.date as string, sold: !!a.sold, low: num(a.low)!, high: num(a.high)!,
      }));
      for (let i = 1; i < apps.length; i++) {
        const prev = apps[i - 1], next = apps[i];
        const prevMid = (prev.low + prev.high) / 2, nextMid = (next.low + next.high) / 2;
        if (prevMid <= 0 || nextMid <= 0) continue;
        const gapDays = (new Date(next.date).getTime() - new Date(prev.date).getTime()) / 86400000;
        if (!Number.isFinite(gapDays) || gapDays < 0) continue;
        allPairs.push({ house, work, gapDays, logRatio: ln(nextMid / prevMid), prevSold: prev.sold, prevMid, nextMid });
      }
    }
  } finally {
    await session.close();
  }
  console.log(`loaded ${allPairs.length} consecutive same-work, same-house appearance pairs from the graph`);
  console.log(`  NOTE: Roseberys is near-absent from the graph query below (unsold estimates missing in the graph — see the`);
  console.log(`  comment above roseberysPairs()); its real numbers are the separate "from catalogue" section that follows.`);
  for (const house of ["Roseberys London", "Bonhams"]) report(house, allPairs.filter((p) => p.house === house));

  const rbPairs = roseberysPairs();
  console.log(`\nloaded ${rbPairs.length} consecutive same-work pairs from the LOCAL Roseberys catalogue (bypasses the graph gap)`);
  report("Roseberys London (from catalogue)", rbPairs);
}

main().then(() => closeDriver()).catch(async (e) => { console.error(e); await closeDriver(); process.exit(1); });
