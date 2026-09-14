/**
 * The attributed-lot entry path.
 *
 * Two ways in. `--claim <file.json>` takes ANY house's lot as a hand-built CatalogueAttribution
 * plus an image URL, which is the entry the use case actually describes (a lot URL and a
 * picture) and the only way to reach a house the project has no fetcher for — Bonhams,
 * Christie's, a dealer's page. Everything else here is the Roseberys convenience path:
 * fetch the lot, parse the house's own header into a CatalogueAttribution, download the
 * primary image, run AttributedLotAppraiser, and store result.json + report.html under
 * tests/backtest/output/<sale>_<lot>_attrpath/ in the same shape the hammer report reads
 * (`npm run report:hammer -- --suffix _attrpath`).
 *
 *   npm run backtest:attributed-lot -- --claim /tmp/hockney.json
 *   npm run backtest:attributed-lot -- --url https://www.roseberys.co.uk/bidding/A0785-.../1-...
 *   npm run backtest:attributed-lot -- --sale A0785 --lot 1 [--method claude-4stage-attributed]
 *   npm run backtest:attributed-lot -- --sale A0793 --random 10 --seed 7 --dry-run     # pick + graph-side facts, NO model calls
 *   npm run backtest:attributed-lot -- --sale A0793 --screen                            # rank the WHOLE sale, NO model calls
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
import { divergenceSignalUsable, ESTIMATE_DRIFT, type CatalogueAttribution } from "../../src/appraisal/attributed_lot";
import { resolveArtistIdentity, resolveWorkIdentity, queryAuctionComparables, queryWorkFacts } from "../../src/appraisal/knowledge_graph/index.js";
import { compareResults } from "./compare";
import { buildBacktestReport } from "./build_report";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";
import { resolveSaleRef, type AuctionRef } from "../../benchmark/src/roseberys/discover";
import { fetchAuctionLots, imageUrl, lotUrl, type RawLot } from "../../benchmark/src/roseberys/api";
import { parseDescription, type ParsedLot } from "../../benchmark/src/roseberys/parse";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_METHOD = "claude-4stage-attributed";

interface Args { claimFile?: string; stage2bModel?: string; url?: string; sale?: string; lot?: string; lots: string[]; random: number; seed: number; dryRun: boolean; screen: boolean; concurrency: number; minRatio: number; method: string; vea: boolean; stage3Model?: string }
function parseArgs(argv: string[]): Args {
  const a: Args = { method: DEFAULT_METHOD, vea: false, lots: [], random: 0, seed: 1, dryRun: false, screen: false, concurrency: 6, minRatio: 1.25 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--claim") a.claimFile = argv[++i];
    else if (x === "--url") a.url = argv[++i];
    else if (x === "--sale") a.sale = argv[++i];
    else if (x === "--lot") a.lot = argv[++i];
    else if (x === "--lots") a.lots = argv[++i].split(",").map((t) => t.trim()).filter(Boolean);
    else if (x === "--random") a.random = Number(argv[++i]);
    else if (x === "--seed") a.seed = Number(argv[++i]);
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--screen") { a.screen = true; a.dryRun = true; }
    else if (x === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (x === "--min-ratio") a.minRatio = Number(argv[++i]);
    else if (x === "--method") a.method = argv[++i];
    else if (x === "--vea") a.vea = true;
    else if (x === "--stage3-model") a.stage3Model = argv[++i];
    else if (x === "--stage2b-model") a.stage2bModel = argv[++i];
    else { console.error(`Unrecognised argument: ${x}`); process.exit(1); }
  }
  if (a.url) {
    // https://www.roseberys.co.uk/bidding/A0785-prints-multiples-.../1-pablo-picasso-...
    const m = a.url.match(/\/bidding\/([A-Za-z]\d{4})-[^/]*\/(\d+)-/);
    if (!m) { console.error(`Could not read sale code and lot number from URL: ${a.url}`); process.exit(1); }
    a.sale = m[1]; a.lot = m[2];
  }
  if (a.claimFile) return a;
  if (a.lot) a.lots = [a.lot];
  if (a.screen) { if (!a.sale) { console.error("--screen needs --sale <code>"); process.exit(1); } return a; }
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
  let basis: string | null = null, swMedianHammer: number | null = null, swLatest: string | null = null;
  let tier2 = 0, sold = 0, unsold = 0, signal: { usable: boolean; reason: string } = { usable: false, reason: "not reached" };
  if (canonical) {
    const wi = await resolveWorkIdentity({ artistName: canonical, title: claim.title ?? "", catalogueRefs: claim.catalogueRefs?.length ? claim.catalogueRefs.join("; ") : null, excludeSaleLot: saleLot });
    basis = wi.basis;
    work = wi.basis ? `resolved (${wi.basis})` : wi.ambiguousAt ? `ambiguous@${wi.ambiguousAt}` : "unresolved";
    const comps = await queryAuctionComparables({ artistName: canonical, conceptualWorkIds: wi.workIds, workTitle: claim.title ?? null, sinceDate: "2015-01-01", limit: 60, excludeSaleLot: saleLot, excludeListingUrl: claim.lotUrl });
    sameWork = comps.summary.tierCounts.same_work;
    tier2 = comps.summary.tierCounts.same_artist_technique;
    const sw = comps.comparables.filter((c) => c.tier === "same_work");
    const h = sw.map((c) => c.hammerPriceGBP).filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
    swMedianHammer = h.length ? (h.length % 2 ? h[(h.length - 1) / 2] : (h[h.length / 2 - 1] + h[h.length / 2]) / 2) : null;
    swLatest = sw.map((c) => c.saleDate?.slice(0, 10) ?? "").filter(Boolean).sort().pop() ?? null;
    signal = divergenceSignalUsable(sw, claim.saleDate);
    if (wi.workIds.length) {
      const wf = await queryWorkFacts(wi.workIds, { excludeSaleLot: saleLot });
      if (wf) { sold = wf.sellThrough.sold; unsold = wf.sellThrough.unsold; sellThrough = `${sold}/${sold + unsold}`; }
    }
  }
  const stage2bCertain = !canonical || !work.startsWith("resolved") || sameWork === 0;
  const mid = ((rawLot.low_estimate ?? 0) + (rawLot.high_estimate ?? 0)) / 2;
  const anchor = mid > 0 ? mid * ESTIMATE_DRIFT : null;
  return {
    lot: rawLot.lot_number, claim, canonical, work, basis, sameWork, tier2, sellThrough, sold, unsold, stage2bCertain,
    swMedianHammer, swLatest, signal, anchor,
    ratio: anchor && swMedianHammer ? swMedianHammer / anchor : null,
  };
}
type ScreenRow = Awaited<ReturnType<typeof dryRun>>;

/**
 * Rank a whole sale for lots the graph prices ABOVE the house, at zero LLM spend.
 *
 * "Undervalued" here is one specific, measured thing: this work's own prior HAMMER prices sit
 * well above the printed estimate scaled by the market's 0.82 drift. On the 2026-09-13 backtest
 * that bucket (comps > 1.5x the anchor) went above the high estimate 33% of the time against a
 * 19% base rate on Roseberys. It is a candidate generator and not a valuation: it knows nothing
 * about this impression's condition, state or edition position, which is what the pipeline is for.
 *
 * Three disciplines carried from screen_sale.ts, each bought with a wrong answer:
 *   - identity before price: the ratio is only computed for a work the TITLE resolved (an image
 *     matching a sibling in a series idiom is how "I hate humans" got priced as "I Hate Human
 *     Beings");
 *   - sell-through beside every ratio: a work that fails to sell is marked to clear, not
 *     underpriced (the Ai Weiwei case: five sales against seven bought-in attempts);
 *   - the signal gate: one stale comp is not a directional signal (divergenceSignalUsable).
 */
function reportScreen(rows: ScreenRow[], minRatio: number) {
  const priced = rows.filter((r) => r.ratio != null && r.basis);
  const ranked = priced.filter((r) => r.ratio! >= minRatio).sort((a, b) => b.ratio! - a.ratio!);
  const gated = ranked.filter((r) => r.signal.usable);
  const thin = ranked.filter((r) => !r.signal.usable);
  const line = (r: ScreenRow) =>
    `${String(r.lot).padStart(4)}  ${(r.claim.artist ?? "").slice(0, 24).padEnd(24)} ${(r.claim.title ?? "").slice(0, 32).padEnd(32)} ` +
    `${`${r.claim.estimateLow}-${r.claim.estimateHigh}`.padStart(11)} ${String(Math.round(r.anchor!)).padStart(6)} ` +
    `${String(Math.round(r.swMedianHammer!)).padStart(7)} ${r.ratio!.toFixed(2).padStart(5)}  ${String(r.sameWork).padStart(2)} ${(r.swLatest ?? "-").padStart(10)} ${r.sellThrough.padStart(5)}  ${(r.basis ?? "").slice(0, 16)}`;
  const head = `${"lot".padStart(4)}  ${"artist".padEnd(24)} ${"title".padEnd(32)} ${"estimate".padStart(11)} ${"anchor".padStart(6)} ${"comp".padStart(7)} ${"ratio".padStart(5)}   n ${"latest".padStart(10)} ${"sold".padStart(5)}  basis`;
  console.log(`\n== ${rows.length} single-artist lots screened; ${priced.length} reached a same-work hammer price ==`);
  console.log(`\n-- Graph prices the work ABOVE the house's drift anchor (>= ${minRatio}x), signal usable --\n${head}`);
  for (const r of gated) console.log(line(r));
  if (!gated.length) console.log("  (none)");
  console.log(`\n-- Same ratio, signal too thin to lean on (shown, not ranked) --\n${head}`);
  for (const r of thin.slice(0, 20)) console.log(`${line(r)}  << ${r.signal.reason}`);
  if (!thin.length) console.log("  (none)");
  const under = priced.filter((r) => r.ratio! <= 0.67 && r.signal.usable).sort((a, b) => a.ratio! - b.ratio!);
  console.log(`\n-- For contrast: graph prices the work BELOW the anchor (<= 0.67x), signal usable --\n${head}`);
  for (const r of under.slice(0, 10)) console.log(line(r));
  if (!under.length) console.log("  (none)");
  console.log(`\ncoverage: artist node ${rows.filter((r) => r.canonical).length}/${rows.length}  work resolved ${rows.filter((r) => r.basis).length}  same-work comps ${priced.length}  signal usable ${priced.filter((r) => r.signal.usable).length}`);
}

/**
 * A lot from any house, described by hand. The JSON is a CatalogueAttribution (see
 * src/appraisal/attributed_lot.ts) plus `imageUrl`, and optionally the four Stage 1c note
 * fields. Nothing here is parsed out of a page: the caller is asserting what the catalogue
 * says, which is exactly the claim the path is built to verify rather than trust.
 */
interface ClaimFile extends CatalogueAttribution {
  imageUrl: string;
  inscribedMarksNotes?: string;
  provenanceNotes?: string;
  conditionNotes?: string;
  catalogueNotes?: string;
}

async function runFromClaimFile(args: Args) {
  const cf = JSON.parse(readFileSync(args.claimFile!, "utf8")) as ClaimFile;
  if (!cf.artist?.trim()) throw new Error("the claim file names no artist");
  if (!cf.imageUrl) throw new Error("the claim file has no imageUrl");
  const { imageUrl: imgUrl, inscribedMarksNotes, provenanceNotes, conditionNotes, catalogueNotes, ...claim } = cf;
  console.log(`[Attributed lot] ===== ${claim.house ?? "?"} ${claim.saleId ?? "?"} lot ${claim.lotNumber ?? "?"} =====`);
  console.log(`[Attributed lot] claim: ${JSON.stringify({ ...claim, sourceExcerpt: undefined })}`);
  const { base64, mimeType } = await downloadImageBase64(imgUrl);

  const baseConfig = appraiserConfigs.find((c) => c.id === args.method);
  if (!baseConfig) throw new Error(`Unknown method "${args.method}"`);
  const config: AppraisalMethodConfig = {
    ...baseConfig, attributedLotPath: true, enableVisualSearch: false, enableEmbeddingMatch: true,
    skipVea: !args.vea, ...(args.stage3Model ? { stage3Model: args.stage3Model } : {}),
    ...(args.stage2bModel ? { stage2bModel: args.stage2bModel } : {}),
  };
  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined;
  const appraiser = new AttributedLotAppraiser(config, ai);

  const input: AppraisalInput = {
    imageBase64: base64, mimeType, currency: claim.estimateCurrency || "GBP",
    inscribedMarksNotes, provenanceNotes, conditionNotes, catalogueNotes,
    catalogueAttribution: claim,
  };
  resetUsage();
  const t0 = Date.now();
  const report = await appraiser.appraise(input);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  printUsageSummary();
  const usage = usageSummary();
  const est = report.auctionEstimate;
  console.log(`\n[Attributed lot] ${elapsedS}s, $${usage.totalUsd.toFixed(4)} — Stage 2b ${report.attributedLot?.routing.stage2bSkipped ? "SKIPPED" : "ran"}; verification ${report.attributedLot?.verification.verdict}`);
  console.log(`[Valuation] app ${est?.lowEstimate}-${est?.highEstimate} ${est?.currency} vs catalogue ${claim.estimateLow}-${claim.estimateHigh}`);
  const r = est?.valuationReasoning;
  if (r) {
    console.log(`[Reasoning] anchor: ${r.anchor} (${r.anchorValue})`);
    for (const a of r.adjustments ?? []) console.log(`[Reasoning]   ${a.direction} ${a.magnitude} — ${a.factor}: ${a.evidence}`);
    console.log(`[Reasoning] confidence: ${r.confidence}`);
  }
  const lotId = `${(claim.house ?? "lot").replace(/[^a-z0-9]+/gi, "")}-${claim.saleId ?? "x"}-${claim.lotNumber ?? "x"}_attrpath${args.stage2bModel ? `_2b-${args.stage2bModel.replace(/[^a-z0-9]+/gi, "")}` : ""}`;
  const outDir = `${__dirname}/output/${slugify(lotId)}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/result.json`, JSON.stringify({
    lotId, lotUrl: claim.lotUrl, method: config.id, entryPath: "attributed-lot/claim-file",
    attributionProvided: true, catalogueAttribution: claim, tokenUsage: usage, elapsedSeconds: Number(elapsedS),
    stage1aVeaRun: !!args.vea, stage3Model: config.stage3Model ?? null, stage2bModel: config.stage2bModel ?? null,
    attributedLot: report.attributedLot, report,
    appraiserInputNotes: { inscribedMarksNotes: inscribedMarksNotes ?? null, provenanceNotes: provenanceNotes ?? null, conditionNotes: conditionNotes ?? null, catalogueNotes: catalogueNotes ?? null },
  }, null, 2));
  writeFileSync(`${outDir}/image.txt`, imgUrl);
  console.log(`[Attributed lot] wrote ${outDir}/result.json`);
  await closeDriver();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.claimFile) return runFromClaimFile(args);
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

  if (args.screen) {
    const pool = allLots.filter((l) => eligible(l).ok);
    console.log(`[Attributed lot] screening ${pool.length} eligible single-artist lots (of ${allLots.length}) at ${args.concurrency}x — zero LLM spend`);
    const rows: ScreenRow[] = [];
    let i = 0;
    const worker = async () => {
      while (i < pool.length) {
        const lot = pool[i++];
        const e = eligible(lot);
        try { rows.push(await dryRun(lot, e.gt!, auction)); }
        catch (err: any) { console.warn(`  lot ${lot.lot_number}: ${err?.message ?? err}`); }
        if (rows.length % 50 === 0) console.log(`  …${rows.length}/${pool.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
    rows.sort((a, b) => a.lot - b.lot);
    mkdirSync(`${__dirname}/attrpath_logs`, { recursive: true });
    writeFileSync(`${__dirname}/attrpath_logs/${auction.saleCode}_screen.json`, JSON.stringify(rows, null, 1));
    reportScreen(rows, args.minRatio);
    await closeDriver();
    return;
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
    ...(args.stage2bModel ? { stage2bModel: args.stage2bModel } : {}),
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
  const lotId = `${auction.saleCode}-${rawLot.lot_number}_attrpath${args.stage3Model ? `_${args.stage3Model.replace(/[^a-z0-9]+/gi, "")}` : ""}${args.stage2bModel ? `_2b-${args.stage2bModel.replace(/[^a-z0-9]+/gi, "")}` : ""}`;
  const outDir = `${__dirname}/output/${slugify(lotId)}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/result.json`, JSON.stringify({
    lotId, sale: auction, lotUrl: lotUrl(rawLot), method: config.id, entryPath: "attributed-lot",
    attributionProvided: true, catalogueAttribution: claim, tokenUsage: usage, elapsedSeconds: Number(elapsedS),
    stage1aVeaRun: !!args.vea, stage3Model: config.stage3Model ?? null, stage2bModel: config.stage2bModel ?? null,
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
