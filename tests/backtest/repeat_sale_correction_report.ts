/**
 * Plan step 9 — a cleaner test of genuine undervaluation, free of same-sale bidding psychology.
 *
 * The problem with using hammer/estimate at ONE sale as evidence of a bargain: a buyer at a
 * visibly distressed sale (unsold before, re-priced down) can rationally bid low BECAUSE they
 * perceive the situation as distressed, independent of what the object is actually worth — so a
 * low hammer there is consistent with both "genuinely worth little" and "genuinely undervalued,
 * bid opportunistically." The two are indistinguishable from that one number alone.
 *
 * The fix: find a work that sold BELOW its own estimate at one auction, then find the SAME
 * nominal work selling again — at a MUCH HIGHER hammer — later that year. The second sale's
 * price wasn't set by anyone reacting to the first sale's distress signal (different buyers,
 * different room, usually a different specific impression), so a genuine, large jump is much
 * harder to explain away as same-sale bidding psychology. Control group: appearances that sold
 * AT OR ABOVE their own estimate, followed the same way — isolates whether "sold under
 * estimate" specifically predicts an outsized next-sale jump, versus ordinary market drift any
 * repeat-sold work would show.
 *
 * SAME CAVEAT AS EVERY REPEAT-SALE CHECK THIS SESSION: "same nominal work" across appearances is
 * very likely a different physical impression of one edition, not the identical sheet
 * re-consigned — this measures the edition's behaviour, not a specific copy's.
 *
 *   npx tsx tests/backtest/repeat_sale_correction_report.ts
 */
import { readFileSync } from "node:fs";
import { normalizeTitleKey, isLowInformationTitle } from "../../src/appraisal/knowledge_graph/index";

const ln = Math.log;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "n/a");
const WITHIN_DAYS = 365;

interface Appearance { key: string; date: string; house: "Roseberys London" | "Bonhams"; sold: boolean; low: number; high: number; hammer: number | null }

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
    const hammer = Number(r.hammer);
    out.push({ key, date: saleDate, house: "Roseberys London", sold: r.sold === "sold", low, high, hammer: hammer > 0 ? hammer : null });
  }
  return out;
}
function loadBonhams(): Appearance[] {
  const rows = JSON.parse(readFileSync("benchmark/data/bonhams/catalogue.json", "utf8")) as {
    artist: string; title: string | null; saleDate: string; lowEst: number | null; highEst: number | null; sold: boolean; hammer: number | null;
  }[];
  const out: Appearance[] = [];
  for (const r of rows) {
    if (!r.artist || !r.title) continue;
    const key = keyOf(r.artist, r.title);
    if (!key) continue;
    if (!(r.lowEst! > 0) || !(r.highEst! > 0)) continue;
    out.push({ key, date: r.saleDate, house: "Bonhams", sold: r.sold, low: r.lowEst!, high: r.highEst!, hammer: r.hammer && r.hammer > 0 ? r.hammer : null });
  }
  return out;
}

interface Case { key: string; gapDays: number; logJump: number; sameHouse: boolean; firstHammer: number; secondHammer: number; firstHouse: string; secondHouse: string }

function bootstrapCI(cases: Case[], stat: (cs: Case[]) => number, draws = 1000): [number, number] {
  const byWork = new Map<string, Case[]>();
  for (const c of cases) (byWork.get(c.key) ?? byWork.set(c.key, []).get(c.key)!).push(c);
  const clusters = [...byWork.values()];
  let seed = 61; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const vals: number[] = [];
  for (let b = 0; b < draws; b++) { const sample: Case[] = []; for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rnd() * clusters.length)]); vals.push(stat(sample)); }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * (vals.length - 1))], vals[Math.floor(0.975 * (vals.length - 1))]];
}

function block(label: string, cases: Case[]) {
  if (!cases.length) { console.log(`  ${label}: n=0`); return; }
  const m = median(cases.map((c) => c.logJump));
  const [lo, hi] = bootstrapCI(cases, (cs) => median(cs.map((c) => c.logJump)));
  const up2x = cases.filter((c) => c.logJump >= ln(2)).length;
  const up15x = cases.filter((c) => c.logJump >= ln(1.5)).length;
  const down = cases.filter((c) => c.logJump < 0).length;
  console.log(`  ${label.padEnd(60)} n=${String(cases.length).padStart(4)}  median next/first ${Math.exp(m).toFixed(2)}x  95% CI [${Math.exp(lo).toFixed(2)}x, ${Math.exp(hi).toFixed(2)}x]  >=1.5x: ${pct(up15x, cases.length)}  >=2x: ${pct(up2x, cases.length)}  went DOWN: ${pct(down, cases.length)}`);
}

function main() {
  const all = [...loadRoseberys(), ...loadBonhams()];
  const groups = new Map<string, Appearance[]>();
  for (const a of all) (groups.get(a.key) ?? groups.set(a.key, []).get(a.key)!).push(a);

  const cheapCases: Case[] = [], controlCases: Case[] = [];
  for (const apps of groups.values()) {
    const sold = apps.filter((a) => a.sold && a.hammer && a.hammer > 0).sort((a, b) => a.date.localeCompare(b.date));
    if (sold.length < 2) continue;
    for (let i = 0; i < sold.length - 1; i++) {
      const first = sold[i];
      // next SOLD appearance within WITHIN_DAYS
      let next: Appearance | null = null;
      for (let j = i + 1; j < sold.length; j++) {
        const gap = (new Date(sold[j].date).getTime() - new Date(first.date).getTime()) / 86400000;
        if (gap <= WITHIN_DAYS) { next = sold[j]; break; }
        else break; // sorted by date; first candidate beyond the window means none qualify
      }
      if (!next) continue;
      const gapDays = (new Date(next.date).getTime() - new Date(first.date).getTime()) / 86400000;
      const c: Case = {
        key: first.key, gapDays, logJump: ln(next.hammer! / first.hammer!), sameHouse: first.house === next.house,
        firstHammer: first.hammer!, secondHammer: next.hammer!, firstHouse: first.house, secondHouse: next.house,
      };
      (first.hammer! < first.low ? cheapCases : controlCases).push(c);
    }
  }

  console.log(`"sold under estimate" cohort: n=${cheapCases.length}   control (sold at/above estimate): n=${controlCases.length}`);
  console.log(`(next SOLD appearance of the same nominal work within ${WITHIN_DAYS} days, any house)\n`);

  console.log(`── Does "sold under estimate" predict an outsized jump at the NEXT sale, vs the control? ──`);
  block("sold UNDER estimate -> next sale within a year", cheapCases);
  block("sold AT OR ABOVE estimate -> next sale within a year (control)", controlCases);

  console.log(`\n── Robustness: same comparison with the most extreme jumps excluded (>10x either way) — these are`);
  console.log(`   almost certainly different print generations of a famous edition caught by the same (artist,title)`);
  console.log(`   key, not a genuine repricing of one thing, and could be driving the headline numbers above ──`);
  const trim = (cs: Case[]) => cs.filter((c) => Math.abs(c.logJump) <= ln(10));
  block("sold UNDER estimate, trimmed", trim(cheapCases));
  block("sold AT/ABOVE estimate, trimmed (control)", trim(controlCases));
  console.log(`  excluded from "under estimate": ${cheapCases.length - trim(cheapCases).length} of ${cheapCases.length}   excluded from control: ${controlCases.length - trim(controlCases).length} of ${controlCases.length}`);

  console.log(`\n── The "sold under estimate" cohort, split by whether the next sale changed house (the flip thesis) ──`);
  block("same house both times", cheapCases.filter((c) => c.sameHouse));
  block("DIFFERENT house the second time", cheapCases.filter((c) => !c.sameHouse));
  const toBonhams = cheapCases.filter((c) => !c.sameHouse && c.secondHouse === "Bonhams" && c.firstHouse === "Roseberys London");
  block("...specifically Roseberys (under estimate) -> Bonhams", toBonhams);

  const sortedCheap = [...cheapCases].sort((a, b) => b.logJump - a.logJump);
  console.log(`\n── Top 10 biggest jumps in the "sold under estimate" cohort (illustrative) ──`);
  for (const c of sortedCheap.slice(0, 10)) {
    console.log(`  ${c.key.slice(0, 55).padEnd(56)} £${c.firstHammer.toFixed(0).padStart(7)} (${c.firstHouse.slice(0, 4)}) -> £${c.secondHammer.toFixed(0).padStart(7)} (${c.secondHouse.slice(0, 4)})  ${Math.exp(c.logJump).toFixed(2)}x  gap ${c.gapDays.toFixed(0)}d`);
  }

  console.log(`\nNB: "same nominal work" across appearances is very likely a DIFFERENT physical impression`);
  console.log(`    of one edition, not the identical sheet re-consigned — see the header comment.`);
}

main();
