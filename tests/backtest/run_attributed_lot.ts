/**
 * The attributed-lot entry path on ONE Roseberys lot, from its URL (or sale + lot number):
 * fetch the lot, parse the house's own header into a CatalogueAttribution, download the
 * primary image, run AttributedLotAppraiser, and store result.json + report.html under
 * tests/backtest/output/<sale>_<lot>_attrpath/ in the same shape the hammer report reads
 * (`npm run report:hammer -- --suffix _attrpath`).
 *
 *   npm run backtest:attributed-lot -- --url https://www.roseberys.co.uk/bidding/A0785-.../1-...
 *   npm run backtest:attributed-lot -- --sale A0785 --lot 1 [--method claude-4stage-attributed]
 *   npm run backtest:attributed-lot -- --sale A0793 --random 10 --seed 7 --dry-run     # pick + graph-side facts, NO model calls
 *   npm run backtest:attributed-lot -- --sale A0793 --lots 12,45,301 [--stage3-model qwen-plus]
 *
 * Stage 1a (VEA) and Stage 1b (Gemini) are OFF on the attributed method (see the config in
 * appraiser.ts): the catalogue states what they would read, and both can recognise a
 * catalogued image. --vea forces Stage 1a on for an A/B.
 *
 * --dry-run does every graph read the path does (identity, work, comps, sell-through) with
 * zero LLM spend and prints, per lot, whether Stage 2b is CERTAIN to run (work unresolved or no
 * same-work comps) — the cost estimate is built from that.
 *
 * Past sales: the lot's own record is excluded from every graph read and the sale date cuts
 * comps and sell-through, so the run sees what a valuer saw before the sale.
 */
import dotenv from "dotenv";
dotenv.config();
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import {
  appraiserConfigs, AttributedLotAppraiser, usageSummary, printUsageSummary, resetUsage,
  type AppraisalInput, type AppraisalMethodConfig,
} from "../../src/appraisal/appraiser";
import { type CatalogueAttribution } from "../../src/appraisal/attributed_lot";
import { resolveArtistIdentity, resolveWorkIdentity, queryAuctionComparables, queryWorkFacts } from "../../src/appraisal/knowledge_graph/index.js";
import { compareResults } from "./compare";
import { buildBacktestReport } from "./build_report";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";
import { resolveSaleRef, type AuctionRef } from "../../benchmark/src/roseberys/discover";
import { fetchAuctionLots, imageUrl, lotUrl, type RawLot } from "../../benchmark/src/roseberys/api";
import { parseDescription, type ParsedLot } from "../../benchmark/src/roseberys/parse";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_METHOD = "claude-4stage-attributed";

interface Args { url?: string; sale?: string; lot?: string; lots: string[]; random: number; seed: number; dryRun: boolean; method: string; vea: boolean; stage3Model?: string }
function parseArgs(argv: string[]): Args {
  const a: Args = { method: DEFAULT_METHOD, vea: false, lots: [], random: 0, seed: 1, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--url") a.url = argv[++i];
    else if (x === "--sale") a.sale = argv[++i];
    else if (x === "--lot") a.lot = argv[++i];
    else if (x === "--lots") a.lots = argv[++i].split(",").map((t) => t.trim()).filter(Boolean);
    else if (x === "--random") a.random = Number(argv[++i]);
    else if (x === "--seed") a.seed = Number(argv[++i]);
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--method") a.method = argv[++i];
    else if (x === "--vea") a.vea = true;
    else if (x === "--stage3-model") a.stage3Model = argv[++i];
    else { console.error(`Unrecognised argument: ${x}`); process.exit(1); }
  }
  if (a.url) {
    // https://www.roseberys.co.uk/bidding/A0785-prints-multiples-.../1-pablo-picasso-...
    const m = a.url.match(/\/bidding\/([A-Za-z]\d{4})-[^/]*\/(\d+)-/);
    if (!m) { console.error(`Could not read sale code and lot number from URL: ${a.url}`); process.exit(1); }
    a.sale = m[1]; a.lot = m[2];
  }
  if (a.lot) a.lots = [a.lot];
  if (!a.sale || (!a.lots.length && !a.random)) { console.error("Usage: --url <roseberys lot url> | --sale <code> (--lot <n> | --lots a,b,c | --random N [--seed S]) [--dry-run] [--method <id>] [--stage3-model <m>] [--vea]"); process.exit(1); }
  return a;
}

async function downloadImageBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: res.headers.get("content-type") || "image/jpeg" };
}

/** Sale dates for past Roseberys sales (knowledge_graph/roseberys_sale_dates.json); null for an upcoming one. */
function saleDateOf(saleCode: string): string | null {
  const p = `${__dirname}/../../knowledge_graph/roseberys_sale_dates.json`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")).sales?.[saleCode]?.saleDate ?? null; } catch { return null; }
}

export function claimFromRoseberys(gt: ParsedLot, raw: RawLot, auction: AuctionRef): CatalogueAttribution {
  const header = [
    `${gt.artistQualifier && gt.artistQualifier !== "certain" ? `${gt.artistQualifier} ` : ""}${gt.artist ?? ""}`.trim(),
    `${gt.title ?? ""}${gt.year ? `, ${gt.year}` : ""}`.trim(),
  ].filter(Boolean).join(",\n");
  return {
    artist: gt.artist ?? "",
    artistQualifier: gt.artistQualifier ?? "certain",
    title: gt.title,
    year: gt.year,
    medium: [gt.medium, gt.support ? `on ${gt.support}` : null].filter(Boolean).join(" ") || null,
    editionNote: gt.edition,
    editionSize: gt.editionSize,
    signed: gt.signed,
    dimensions: gt.dimensions.map((d) => ({ kind: d.kind, widthCm: d.widthCm, heightCm: d.heightCm })),
    catalogueRefs: gt.catalogueRefs,
    estimateLow: raw.low_estimate,
    estimateHigh: raw.high_estimate,
    estimateCurrency: "GBP",
    house: "Roseberys London",
    saleId: auction.saleCode,
    lotNumber: raw.lot_number,
    saleDate: saleDateOf(auction.saleCode),
    lotUrl: lotUrl(raw),
    sourceExcerpt: header || null,
  };
}

const slugify = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "lot";
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Single-artist, unqualified, imaged, estimated lots — the attributed use case's population. */
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

/** Zero-LLM: the graph reads the path will make, so a batch can be costed before it is run. */
async function dryRun(rawLot: RawLot, gt: ParsedLot, auction: AuctionRef) {
  const claim = claimFromRoseberys(gt, rawLot, auction);
  // The lot is usually already in the graph (upcoming sales are ingested), so its own record
  // is excluded exactly as the appraiser excludes it — otherwise every lot "resolves" to itself.
  const saleLot = { saleId: auction.saleCode, lotNumber: rawLot.lot_number };
  const id = await resolveArtistIdentity(claim.artist);
  const canonical = id?.canonicalName ?? null;
  let work = "no artist node", sameWork = 0, sellThrough = "-";
  if (canonical) {
    const wi = await resolveWorkIdentity({ artistName: canonical, title: claim.title ?? "", catalogueRefs: claim.catalogueRefs?.length ? claim.catalogueRefs.join("; ") : null, excludeSaleLot: saleLot });
    work = wi.basis ? `resolved (${wi.basis})` : wi.ambiguousAt ? `ambiguous@${wi.ambiguousAt}` : "unresolved";
    const comps = await queryAuctionComparables({ artistName: canonical, conceptualWorkIds: wi.workIds, workTitle: claim.title ?? null, sinceDate: "2015-01-01", limit: 40, excludeSaleLot: saleLot, excludeListingUrl: claim.lotUrl });
    sameWork = comps.summary.tierCounts.same_work;
    if (wi.workIds.length) { const wf = await queryWorkFacts(wi.workIds, { excludeSaleLot: saleLot }); if (wf) sellThrough = `${wf.sellThrough.sold}/${wf.sellThrough.sold + wf.sellThrough.unsold}`; }
  }
  const stage2bCertain = !canonical || !work.startsWith("resolved") || sameWork === 0;
  return { claim, canonical, work, sameWork, sellThrough, stage2bCertain };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auction = await resolveSaleRef(args.sale!);
  if (!auction) throw new Error(`Could not resolve sale "${args.sale}"`);
  console.log(`[Attributed lot] sale ${auction.saleCode} (auction_id ${auction.auctionId})`);
  const allLots = await fetchAuctionLots(auction.auctionId);
  console.log(`[Attributed lot] ${allLots.length} lots in the sale`);

  let picked: RawLot[];
  if (args.random > 0) {
    const pool = allLots.filter((l) => eligible(l).ok);
    const rnd = mulberry32(args.seed);
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    picked = shuffled.slice(0, args.random).sort((a, b) => a.lot_number - b.lot_number);
    console.log(`[Attributed lot] ${pool.length} eligible single-artist lots; picked ${picked.length} with seed ${args.seed}: ${picked.map((l) => l.lot_number).join(", ")}`);
  } else {
    picked = args.lots.map((n) => { const l = allLots.find((x) => String(x.lot_number) === n || String(x.total_lot_number).toLowerCase() === n.toLowerCase()); if (!l) throw new Error(`Lot ${n} not found in sale ${auction.saleCode}`); return l; });
  }

  if (args.dryRun) {
    console.log(`\n${"lot".padStart(4)}  ${"artist".padEnd(26)} ${"title".padEnd(40)} ${"estimate".padStart(13)}  ${"artist node".padEnd(12)} ${"work".padEnd(24)} ${"same-work".padStart(9)} ${"sell-thru".padStart(9)}  2b`);
    let certain = 0;
    for (const lot of picked) {
      const e = eligible(lot);
      if (!e.ok) { console.log(`${String(lot.lot_number).padStart(4)}  INELIGIBLE: ${e.why}`); continue; }
      const d = await dryRun(lot, e.gt!, auction);
      if (d.stage2bCertain) certain++;
      console.log(`${String(lot.lot_number).padStart(4)}  ${(d.claim.artist).slice(0, 26).padEnd(26)} ${(d.claim.title ?? "").slice(0, 40).padEnd(40)} ${`${lot.low_estimate}-${lot.high_estimate}`.padStart(13)}  ${(d.canonical ? "yes" : "NO").padEnd(12)} ${d.work.slice(0, 24).padEnd(24)} ${String(d.sameWork).padStart(9)} ${d.sellThrough.padStart(9)}  ${d.stage2bCertain ? "CERTAIN" : "maybe skipped"}`);
    }
    const n = picked.length, maybe = n - certain;
    console.log(`\nStage 2b certain on ${certain}/${n}; may be skipped on ${maybe}.`);
    console.log(`Cost estimate (Stage 1a and 1b off): ~$0.08/lot without 2b, ~$0.45-0.70/lot with 2b (client-side search) -> low ~$${(certain * 0.45 + maybe * 0.08).toFixed(2)}, high ~$${(certain * 0.70 + maybe * 0.70).toFixed(2)} for ${n} lots.`);
    await closeDriver();
    return;
  }

  for (const lot of picked) {
    await runOne(lot, auction, args);
  }
  await closeDriver();
}

async function runOne(rawLot: RawLot, auction: AuctionRef, args: Args) {
  console.log(`\n[Attributed lot] ===== ${auction.saleCode} lot ${rawLot.lot_number} =====`);
  const imgUrl = imageUrl(rawLot);
  if (!imgUrl) throw new Error(`Lot ${rawLot.lot_number} has no primary image`);
  const { base64, mimeType } = await downloadImageBase64(imgUrl);

  const groundTruth = parseDescription(rawLot.description);
  if (!groundTruth.artist) throw new Error("The catalogue header names no artist — this is not an attributed lot");
  const claim = claimFromRoseberys(groundTruth, rawLot, auction);
  console.log(`[Attributed lot] claim: ${JSON.stringify({ ...claim, sourceExcerpt: undefined })}`);

  const baseConfig = appraiserConfigs.find((c) => c.id === args.method);
  if (!baseConfig) throw new Error(`Unknown method "${args.method}"`);
  const config: AppraisalMethodConfig = {
    ...baseConfig, attributedLotPath: true, enableVisualSearch: false, enableEmbeddingMatch: true,
    skipVea: !args.vea,
    ...(args.stage3Model ? { stage3Model: args.stage3Model } : {}),
  };
  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined;
  const appraiser = new AttributedLotAppraiser(config, ai);

  const input: AppraisalInput = {
    imageBase64: base64, mimeType, currency: "GBP",
    inscribedMarksNotes: groundTruth.inscriptions || undefined,
    provenanceNotes: groundTruth.provenance || undefined,
    conditionNotes: groundTruth.condition || undefined,
    catalogueNotes: groundTruth.bodyLines.join("\n") || undefined,
    catalogueAttribution: claim,
    testingExcludeSourceListing: `Roseberys, sale ${auction.saleCode}, lot ${rawLot.lot_number} (${lotUrl(rawLot)})`,
  };

  resetUsage();
  const t0 = Date.now();
  const report = await appraiser.appraise(input);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  printUsageSummary();
  const usage = usageSummary();

  const est = report.auctionEstimate;
  const gtLow = rawLot.low_estimate ?? null, gtHigh = rawLot.high_estimate ?? null;
  const hammer = rawLot.sold === 1 ? rawLot.rostrum_hammer : null;
  console.log(`\n[Attributed lot] ${elapsedS}s, $${usage.totalUsd.toFixed(4)} — Stage 2b ${report.attributedLot?.routing.stage2bSkipped ? "SKIPPED" : "ran"}; verification ${report.attributedLot?.verification.verdict}`);
  console.log(`[Valuation] app ${est?.lowEstimate}-${est?.highEstimate} ${est?.currency} vs catalogue ${gtLow}-${gtHigh}${hammer ? ` | HAMMER ${hammer}` : rawLot.sold === 0 && rawLot.passed ? " | UNSOLD" : ""}`);
  if (est?.valuationReasoning) {
    const r = est.valuationReasoning;
    console.log(`[Reasoning] anchor: ${r.anchor} (${r.anchorValue})`);
    for (const a of r.adjustments ?? []) console.log(`[Reasoning]   ${a.direction} ${a.magnitude} — ${a.factor}: ${a.evidence}`);
    console.log(`[Reasoning] confidence: ${r.confidence}`);
  }

  const comparison = compareResults(report, groundTruth, rawLot);
  const lotId = `${auction.saleCode}-${rawLot.lot_number}_attrpath${args.stage3Model ? `_${args.stage3Model.replace(/[^a-z0-9]+/gi, "")}` : ""}`;
  const outDir = `${__dirname}/output/${slugify(lotId)}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/result.json`, JSON.stringify({
    lotId, sale: auction, lotUrl: lotUrl(rawLot), method: config.id, entryPath: "attributed-lot",
    attributionProvided: true, catalogueAttribution: claim, tokenUsage: usage, elapsedSeconds: Number(elapsedS),
    stage1aVeaRun: !!args.vea, stage3Model: config.stage3Model ?? null,
    attributedLot: report.attributedLot,
    report, groundTruth, rawLot: { ...rawLot, description: undefined }, rawLotDescriptionHtml: rawLot.description, comparison,
  }, null, 2));
  writeFileSync(`${outDir}/report.html`, buildBacktestReport({
    lotId, lotUrl: lotUrl(rawLot), imageDataUrl: `data:${mimeType};base64,${base64}`, method: config.id,
    appraiserInputNotes: { inscribedMarksNotes: input.inscribedMarksNotes ?? null, provenanceNotes: input.provenanceNotes ?? null, conditionNotes: input.conditionNotes ?? null, catalogueNotes: input.catalogueNotes ?? null },
    report, groundTruth, rawLot, comparison,
  }));
  console.log(`[Attributed lot] wrote ${outDir}/result.json and report.html`);
}

main().then(() => process.exit(0)).catch(async (err) => { console.error(err); await closeDriver().catch(() => {}); process.exit(1); });
