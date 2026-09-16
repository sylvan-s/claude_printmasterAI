/**
 * Phase 3 parity gate (plan docs/plans/2026-09-16-stage3-blend-valuation.md). Zero LLM.
 *
 * The blend was calibrated on the inputs comps_hammer_backtest.ts --blend recorded. Stage 3a
 * will price from ValuationEvidence instead. This rebuilds the evidence for calibration lots
 * from their catalogue fields (the attributed-lot path: claim -> readLotGraphEvidence ->
 * assembleValuationEvidence -> evidenceToBlendInputs) and checks it reproduces what was
 * calibrated: the same same-work hammers, the same tier-2/3 comps, the same priors-model mean,
 * the same target house, and so the same blended price.
 *
 *   npx tsx tests/backtest/valuation_evidence_parity.ts --per-file 150 --seed 3
 *
 * Expected, not a bug: lots whose harness priors used the lot's OWN graph record for its
 * attributes (lotAttrsSource "graph"). A production lot is not in the graph, so the evidence
 * reads the claim; those lots are reported apart, as the size of that difference.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { closeDriver, blendPrices, type BlendInputs, type BlendCalibration } from "../../src/appraisal/knowledge_graph/index";
import { readLotGraphEvidence, assembleValuationEvidence, evidenceToBlendInputs } from "../../src/appraisal/valuation_evidence";
import type { CatalogueAttribution } from "../../src/appraisal/attributed_lot";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PER_FILE = Number(arg("per-file", "150"));
const SEED = Number(arg("seed", "3"));
const D = "tests/backtest/comps_hammer";
const FILES = (arg("files") ?? `${D}/forum_n2500_blend_house.jsonl,${D}/roseberys_n2500_blend_house.jsonl,${D}/bonhams_n2500_blend_house.jsonl`).split(",");
const cal: BlendCalibration = JSON.parse(readFileSync("knowledge_graph/pricing_ml/blend/calibration.json", "utf8"));

function rng(seed: number) { let s = seed; return () => { s = (s * 48271) % 2147483647; return s / 2147483647; }; }
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const multiset = (xs: number[]) => xs.map(r3).sort((a, b) => a - b).join(",");

type Check = "same_work" | "tier2" | "tier3" | "priors" | "target_house" | "price";
async function main() {
  const counts: Record<string, Record<Check | "n", number>> = {};
  const reasons: Record<string, number> = {};
  const priceGaps: number[] = [];
  const termDiffs: Record<string, number> = {};
  const examples: string[] = [];
  const worst: { gap: number; line: string }[] = [];
  const bump = (group: string, c: Check | "n") => { (counts[group] ??= { n: 0, same_work: 0, tier2: 0, tier3: 0, priors: 0, target_house: 0, price: 0 })[c]++; };
  for (const file of FILES) {
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.sold && r.blend && r.canonicalArtist && !r.error);
    const next = rng(SEED);
    const sample = rows.map((r) => [next(), r] as const).sort((a, b) => a[0] - b[0]).slice(0, PER_FILE).map(([, r]) => r);
    for (const row of sample) {
      const h: BlendInputs = row.blend.inputs;
      const claim: CatalogueAttribution = {
        artist: row.artist, title: row.title, medium: row.medium, editionNote: row.editionNote, editionSize: row.editionSize, signed: row.signed,
        dimensions: row.widthCm && row.heightCm ? [{ kind: "unspecified", widthCm: row.widthCm, heightCm: row.heightCm }] : null,
        catalogueRefs: row.catalogueRefs ? [row.catalogueRefs] : null, estimateLow: row.lowEst, estimateHigh: row.highEst, estimateCurrency: "GBP",
        house: h.targetHouse ?? null, saleId: row.saleId, lotNumber: row.lotNumber, saleDate: row.saleDate, lotUrl: row.listingUrl,
      };
      const graph = await readLotGraphEvidence({
        canonicalArtist: row.canonicalArtist, workTitle: claim.title ?? null, catalogueRefs: row.catalogueRefs ?? null, techniqueText: row.medium ?? null,
        valuationDate: row.saleDate, excludeSaleLot: { saleId: String(row.saleId), lotNumber: Number(row.lotNumber) }, excludeListingUrl: row.listingUrl ?? null, via: "claim",
      });
      const ev = assembleValuationEvidence({
        builtAt: "parity", reportedArtist: row.artist, canonicalArtist: row.canonicalArtist, claim, graph,
        targetHouse: { value: h.targetHouse ?? null, source: "catalogue" }, valuationDate: { value: row.saleDate, source: "catalogue" },
      });
      const e = evidenceToBlendInputs(ev);
      const group = `${h.targetHouse} / attrs ${row.blend.lotAttrsSource}`;
      bump(group, "n");
      const ok = (c: Check, pass: boolean, why: string) => { if (pass) bump(group, c); else reasons[`${c}: ${why}`] = (reasons[`${c}: ${why}`] ?? 0) + 1; };
      ok("same_work", multiset(h.sameWork.map((c) => c.hammerGBP)) === multiset(e.sameWork.map((c) => c.hammerGBP)),
        h.sameWork.length === e.sameWork.length ? "same count, different sales" : e.sameWork.length > h.sameWork.length ? "evidence has more" : "evidence has fewer");
      const tierEq = (a: BlendInputs["sameArtist"], b: BlendInputs["sameArtist"]) => (!a && !b) || (!!a && !!b && a.n === b.n && multiset((a.comps ?? []).map((c) => c.hammerGBP)) === multiset((b.comps ?? []).map((c) => c.hammerGBP)));
      ok("tier2", tierEq(h.sameArtistTechnique, e.sameArtistTechnique), `n ${h.sameArtistTechnique?.n ?? 0} vs ${e.sameArtistTechnique?.n ?? 0}`.replace(/\d+ vs \d+/, (m) => (m.split(" vs ").map(Number).reduce((x, y) => y - x) > 0 ? "evidence has more" : "evidence has fewer/different")));
      ok("tier3", tierEq(h.sameArtist, e.sameArtist), "differs");
      const priorsOk = (!h.priors && !e.priors) || (!!h.priors && !!e.priors && Math.abs(h.priors.mu - e.priors.mu) < 1e-6);
      ok("priors", priorsOk, !h.priors || !e.priors ? "one side has no profile" : "different mu (attributes)");
      if (!priorsOk && h.priors && e.priors) {
        // Which attribute terms differ: the term names carry the level ("signature=hand", "edition size=150").
        const dim = (t: string) => t.replace(/[=\s].*$/, "").replace(/^edition$/, "edition size").replace(/^sheet$/, "sheet area");
        const hm = new Map(h.priors.contributions.map((c) => [c.term, c.logEffect])), em = new Map(e.priors.contributions.map((c) => [c.term, c.logEffect]));
        const dims = new Set<string>();
        for (const t of new Set([...hm.keys(), ...em.keys()])) if (!(hm.has(t) && em.has(t) && Math.abs(hm.get(t)! - em.get(t)!) < 1e-9)) dims.add(dim(t));
        for (const d of dims) termDiffs[`${h.targetHouse}: ${d}`] = (termDiffs[`${h.targetHouse}: ${d}`] ?? 0) + 1;
        if (examples.length < 12) examples.push(`${h.targetHouse} ${row.key}: harness [${h.priors.contributions.map((c) => c.term).join(", ")}] vs evidence [${e.priors.contributions.map((c) => c.term).join(", ")}]  medium="${row.medium}" editionNote="${row.editionNote}"`);
      }
      ok("target_house", (h.targetHouse ?? null) === (e.targetHouse ?? null), "differs");
      const bh = blendPrices(h, cal, "no_estimate"), be = blendPrices(e, cal, "no_estimate");
      const gap = bh && be ? Math.log(be.medianGBP / bh.medianGBP) : NaN;
      if (Number.isFinite(gap)) { priceGaps.push(gap); worst.push({ gap, line: `${row.key} gap x${Math.exp(gap).toFixed(2)}: harness [${h.priors?.contributions.map((c) => c.term).join(", ")}] vs evidence [${e.priors?.contributions.map((c) => c.term).join(", ")}]  medium="${row.medium}" note="${row.editionNote}"` }); }
      ok("price", Number.isFinite(gap) && Math.abs(gap) < 0.01, !bh || !be ? "one side has no blend" : Math.abs(gap) < 0.1 ? "within 10%" : "over 10%");
    }
    console.log(`done ${file}`);
  }
  console.log(`\n── Parity: evidence-built blend inputs vs the calibrated harness inputs ──`);
  for (const [g, c] of Object.entries(counts).sort()) {
    const p = (k: Check) => `${Math.round((100 * c[k]) / c.n)}%`;
    console.log(`  ${g.padEnd(36)} n=${String(c.n).padStart(3)}  same_work ${p("same_work")}  tier2 ${p("tier2")}  tier3 ${p("tier3")}  priors ${p("priors")}  house ${p("target_house")}  price<1% ${p("price")}`);
  }
  console.log(`\n  mismatch reasons:`);
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
  console.log(`\n  priors terms that differ (lots):`);
  for (const [k, v] of Object.entries(termDiffs).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
  console.log(`\n  examples:`);
  for (const x of examples) console.log(`    ${x}`);
  console.log(`\n  largest price gaps:`);
  for (const w of worst.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 6)) console.log(`    ${w.line}`);
  const abs = priceGaps.map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  console.log(`\n  |log price gap| over ${abs.length} lots: median ${q(0.5).toFixed(3)}  p90 ${q(0.9).toFixed(3)}  max ${abs[abs.length - 1].toFixed(3)}`);
  await closeDriver();
}
main();
