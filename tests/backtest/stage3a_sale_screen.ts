/**
 * Rank a whole sale by the Stage 3a blend, at ZERO LLM spend.
 *
 * The question this answers: which lots does the ACKG plus the pricing model price furthest
 * above the bottom of the house's printed estimate — i.e. where is the headroom if you bid at
 * or near the low estimate.
 *
 * How it differs from `run_attributed_lot --screen`: that screen ranks on the raw same-work
 * median hammer against the estimate MIDPOINT scaled by the market's 0.82 drift. This one runs
 * the actual production valuation — buildValuationEvidence -> stage3aValuation (BLEND-2.3) —
 * so the number ranked is the same fair-value median a full appraisal would report, with the
 * pricing model, the house offset, the time adjustment and the tiered comps all applied.
 *
 * What it is NOT: the LLM stages never run, so nothing here verifies that the catalogue's
 * attribution is true, and Stage 1d never runs, so no CLIP vector is available — the same-work
 * tier is unaffected (it keys on work ids) but tiers 2 and 3 fall back to nearest sale date
 * instead of image similarity. Treat the output as a candidate list to appraise properly,
 * never as a valuation.
 *
 *   npx tsx tests/backtest/stage3a_sale_screen.ts --sale A0793 [--min-ratio 1.3] [--concurrency 6]
 */
import dotenv from "dotenv";
dotenv.config();
import { writeFileSync } from "fs";
import { resolveArtistIdentity, closeDriver } from "../../src/appraisal/knowledge_graph/index.js";
import { readLotGraphEvidence, assembleValuationEvidence } from "../../src/appraisal/valuation_evidence";
import { stage3aValuation, loadBlendCalibration } from "../../src/appraisal/stage3a_blend";
import { loadColumnMeans } from "../../src/appraisal/stage3a_waterfall";
import { resolveSaleRef } from "../../benchmark/src/roseberys/discover";
import { fetchAuctionLots, imageUrl, type RawLot } from "../../benchmark/src/roseberys/api";
import { parseDescription, type ParsedLot } from "../../benchmark/src/roseberys/parse";
import { claimFromRoseberys } from "./run_attributed_lot";

const args = process.argv.slice(2);
const argOf = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SALE = argOf("--sale", "A0793")!;
const MIN_RATIO = Number(argOf("--min-ratio", "1.0"));
const CONCURRENCY = Number(argOf("--concurrency", "6"));
const SALE_DATE = argOf("--sale-date", "2026-09-23")!;
/** Restrict to these lot numbers and print each one's comps and witnesses in full. */
const ONLY = (argOf("--lots", "") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const HOUSE = "Roseberys London";

interface Row {
  lot: number; artist: string; title: string; lowEst: number; highEst: number;
  median: number; low: number; high: number; tier: string; ratio: number;
  sameWork: number; sold: number; unsold: number; pSells: number | null;
  basis: string | null; divergence: string; witnesses: string;
}

/** The population the attributed-lot path can actually appraise. */
function eligible(lot: RawLot): { ok: boolean; why?: string; gt?: ParsedLot } {
  const gt = parseDescription(lot.description);
  if (!gt.artist) return { ok: false, why: "no artist" };
  if (gt.isMultiWork) return { ok: false, why: `multi-work: ${gt.multiWorkReason}` };
  if (gt.additionalArtists?.length) return { ok: false, why: "several artists" };
  if (gt.artistQualifier && gt.artistQualifier !== "certain") return { ok: false, why: `qualified: ${gt.artistQualifier}` };
  if (!imageUrl(lot)) return { ok: false, why: "no image" };
  if (!lot.low_estimate || !lot.high_estimate) return { ok: false, why: "no estimate" };
  if (lot.withdrawn) return { ok: false, why: "withdrawn" };
  return { ok: true, gt };
}

async function valueLot(raw: RawLot, gt: ParsedLot, auction: any): Promise<Row | null> {
  const claim = claimFromRoseberys(gt, raw, auction);
  const id = await resolveArtistIdentity(claim.artist);
  const canonical = id?.canonicalName ?? null;
  if (!canonical) return null;
  // The lot's own record is in the graph (upcoming sales are ingested) and must never price itself.
  const excludeSaleLot = { saleId: SALE, lotNumber: raw.lot_number };
  const graph = await readLotGraphEvidence({
    canonicalArtist: canonical, workTitle: claim.title, catalogueRefs: claim.catalogueRefs?.join("; ") ?? null,
    techniqueText: claim.medium, valuationDate: SALE_DATE, excludeSaleLot, excludeListingUrl: claim.lotUrl,
    clipVector: null, via: "claim",
  });
  const ev = assembleValuationEvidence({
    builtAt: new Date().toISOString(), reportedArtist: claim.artist, canonicalArtist: canonical, claim, graph,
    targetHouse: { value: HOUSE, source: "catalogue" }, valuationDate: { value: SALE_DATE, source: "input" },
  });
  const cal = loadBlendCalibration();
  if (!cal) throw new Error("blend calibration unreadable");
  const r = stage3aValuation(ev, cal, loadColumnMeans());
  if (!r) return null;
  if (ONLY.length) {
    console.log(`\n===== lot ${raw.lot_number} — ${canonical}, "${claim.title}"`);
    console.log(`  catalogue: ${claim.medium ?? "-"}`);
    console.log(`  estimate ${claim.estimateLow}-${claim.estimateHigh} GBP | Stage 3a ${r.lowGBP}-${r.highGBP}, median ${r.medianGBP} | tier ${r.evidenceTier}`);
    console.log(`  work identity: ${graph.identity.basis ?? "unresolved"} (${graph.identity.workIds.length} node(s)), matched "${graph.identity.matchedName ?? "-"}"`);
    console.log(`  sell-through: ${ev.sellThrough ? `${ev.sellThrough.sold} sold / ${ev.sellThrough.sold + ev.sellThrough.unsold} appearances` : "-"}`);
    console.log(`  comps: ${ev.comps.coverageNote}`);
    for (const c of ev.comps.items) {
      console.log(`    ${c.tier.padEnd(22)} ${String(c.saleDate ?? "-").slice(0, 10)} ${String(c.house ?? "-").padEnd(24)} hammer ${c.hammerGBP ?? "-"} ${c.currency ?? ""}` +
        ` | "${c.workTitle ?? "-"}" ed ${c.attrs?.editionSize ?? "-"} area ${c.attrs?.areaCm2 ?? "-"} sig ${c.attrs?.signature ?? "-"}` +
        ` | clip ${c.clipSimilarity != null ? c.clipSimilarity.toFixed(3) : "-"}`);
      if (c.listingUrl) console.log(`      ${c.listingUrl}`);
    }
    for (const w of r.witnesses) console.log(`  witness ${w.source}: ${Math.round(w.priceGBP)} GBP, weight ${Math.round(w.effectiveWeight * 100)}%, sigma ${w.sigma.toFixed(3)} — ${w.basis}`);
    if (r.divergence.length) console.log(`  divergence: ${r.divergence.map((d) => `${d.a} vs ${d.b} x${d.ratio}`).join("; ")}`);
    if (r.waterfall) for (const b of r.waterfall.bars) console.log(`  bar ${b.key.padEnd(12)} x${String(b.multiplier).padEnd(6)} ${b.fromGBP} -> ${b.toGBP}  ${b.label}`);
  }
  const st = ev.sellThrough ?? { sold: 0, unsold: 0 };
  return {
    lot: raw.lot_number, artist: canonical, title: claim.title ?? "", lowEst: raw.low_estimate!, highEst: raw.high_estimate!,
    median: r.medianGBP, low: r.lowGBP, high: r.highGBP, tier: r.evidenceTier, ratio: r.medianGBP / raw.low_estimate!,
    sameWork: ev.comps.tierCounts.same_work, sold: st.sold, unsold: st.unsold, pSells: r.pSells,
    basis: graph.identity.basis, divergence: r.divergence.map((d) => `${d.a}/${d.b} x${d.ratio}`).join("; "),
    witnesses: r.witnesses.map((w) => `${w.source} ${Math.round(w.priceGBP)}@${Math.round(w.effectiveWeight * 100)}%`).join(", "),
  };
}

async function main() {
  const auction = await resolveSaleRef(SALE);
  if (!auction) throw new Error(`could not resolve sale ${SALE}`);
  const lots = await fetchAuctionLots((auction as any).auctionId ?? (auction as any).auction_id ?? auction);
  console.log(`[Screen] ${SALE}: ${lots.length} lots, valuation date ${SALE_DATE}, house ${HOUSE}`);

  const work: { raw: RawLot; gt: ParsedLot }[] = [];
  const skipped = new Map<string, number>();
  for (const l of lots) {
    const e = eligible(l);
    if (ONLY.length && !ONLY.includes(String(l.lot_number))) continue;
    if (e.ok) work.push({ raw: l, gt: e.gt! });
    else skipped.set(e.why!.split(":")[0], (skipped.get(e.why!.split(":")[0]) ?? 0) + 1);
  }
  console.log(`[Screen] eligible ${work.length}; skipped ${lots.length - work.length} (${[...skipped].map(([k, v]) => `${k} ${v}`).join(", ")})`);

  const rows: Row[] = [];
  let done = 0, failed = 0;
  const queue = [...work];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try { const r = await valueLot(item.raw, item.gt, auction); if (r) rows.push(r); }
      catch (e: any) { failed++; if (failed <= 5) console.log(`  lot ${item.raw.lot_number} failed: ${e?.message ?? e}`); }
      if (++done % 50 === 0) console.log(`  ...${done}/${work.length}`);
    }
  }));
  await closeDriver();

  rows.sort((a, b) => b.ratio - a.ratio);
  const priced = rows.filter((r) => r.ratio >= MIN_RATIO);
  const pct = (s: number, u: number) => (s + u ? `${s}/${s + u}` : "-");
  const head = `${"lot".padStart(4)}  ${"artist".padEnd(22)} ${"title".padEnd(30)} ${"low est".padStart(8)} ${"median".padStart(7)} ${"ratio".padStart(5)} ${"range".padStart(13)}  ${"tier".padEnd(14)} ${"n".padStart(2)} ${"sold".padStart(6)}`;
  const line = (r: Row) =>
    `${String(r.lot).padStart(4)}  ${r.artist.slice(0, 22).padEnd(22)} ${r.title.slice(0, 30).padEnd(30)} ${String(r.lowEst).padStart(8)} ${String(r.median).padStart(7)} ${r.ratio.toFixed(2).padStart(5)} ${`${r.low}-${r.high}`.padStart(13)}  ${r.tier.padEnd(14)} ${String(r.sameWork).padStart(2)} ${pct(r.sold, r.unsold).padStart(6)}`;

  console.log(`\n== ${rows.length} lots valued by Stage 3a; ${priced.length} at ratio >= ${MIN_RATIO} ==`);
  console.log(`\n-- fair-value median vs LOW estimate, ranked --\n${head}`);
  for (const r of priced.slice(0, 40)) console.log(line(r));
  const byTier = new Map<string, number>();
  for (const r of rows) byTier.set(r.tier, (byTier.get(r.tier) ?? 0) + 1);
  console.log(`\nevidence tiers: ${[...byTier].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  // A --lots run is an inspection of a few lots, not a screen: it must never overwrite the
  // whole-sale ranking that a full run produced.
  const out = `tests/backtest/output/${SALE}_stage3a_screen${ONLY.length ? "_lots" : ""}.json`;
  writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(`wrote ${out} (${rows.length} rows)`);
}
main().catch(async (e) => { console.error(e); await closeDriver(); process.exit(1); });
