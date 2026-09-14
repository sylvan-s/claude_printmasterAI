/**
 * Comps-vs-hammer backtest — what the ACKG's realised prices would have said about a lot
 * BEFORE it sold, scored against what it then actually made. Zero LLM spend.
 *
 * This is step 1 of docs/plans/2026-09-13-attributed-lot-valuation.md. Every later step is
 * gated on what this reports, because until now the only yardstick for a valuation was the
 * catalogue estimate — the house's pre-sale opinion — and valuation_report.ts says in its own
 * header that hammer prices are the real test. The catalogue CSVs under benchmark/data/ carry
 * hammer and (for Roseberys) premium-inclusive realised prices for past sales, so the test
 * can be run over thousands of lots without a model in the loop.
 *
 * WHAT IS MEASURED, per lot:
 *   - the artist and title as the house printed them (this is the attributed-lot regime: the
 *     catalogue hands us the attribution, the question is verification and price);
 *   - the graph's comparables for that artist/title/technique, restricted to sales STRICTLY
 *     BEFORE the lot's own sale date (`untilDate`) and inside a rolling window, with the
 *     lot's own SourceRecord excluded — so nothing the valuer could not have known leaks in;
 *   - pre-sale sell-through of the same work, under the same date cut;
 *   - the outcome: sold/unsold, hammer, realised price.
 *
 * WHAT IS REPORTED (the summary at the end, or --summary-only on a saved run):
 *   - coverage: how many lots resolve to an Artist node, and which comp tier they reach;
 *   - accuracy: log(comp median / realised) per tier — median, geometric mean, spread,
 *     share within ±25% and within 2x. Comps are PREMIUM-INCLUSIVE GBP, so they are scored
 *     against the realised price, never against hammer;
 *   - the house baseline on the same lots: hammer inside [low, high], and log(hammer/mid);
 *   - the screen decision: bucket each lot by comp-median vs estimate (over / fair / under),
 *     and report per bucket the share that went unsold, hammered above high, below low —
 *     against the base rate. Plus Spearman rank correlation of the signal with the outcome.
 *
 * PRICE BASES, stated once so they are not confused:
 *   - Estimates and hammer are hammer-basis. Comps and `price_realised_inc_premium` are
 *     premium-inclusive. To put an estimate on the comp basis it is multiplied by that sale's
 *     premium ratio — for Roseberys the median realised/hammer over the sale's sold lots
 *     (known pre-sale: it is the house's published premium schedule); for Forum, whose CSV
 *     has no realised price, an ASSUMED ratio (--forum-premium, default 1.30) that is labelled
 *     as such in the output.
 *
 * Forum lots are the cleaner test: Forum records in the graph carry no realised price, so a
 * Forum lot's comps come only from Bonhams / Roseberys / Skinner — a different house.
 * Roseberys lots can match earlier Roseberys sales of the same print, which is legitimate
 * (a valuer would have those results) but is same-house.
 *
 * Usage:
 *   npx tsx tests/backtest/comps_hammer_backtest.ts --source forum --limit 300
 *   npx tsx tests/backtest/comps_hammer_backtest.ts --source roseberys --sales A0777,A0785
 *   npx tsx tests/backtest/comps_hammer_backtest.ts --source both --limit 2000 --seed 7
 *   npx tsx tests/backtest/comps_hammer_backtest.ts --summary-only tests/backtest/comps_hammer/forum.jsonl
 *
 *   npx tsx tests/backtest/comps_hammer_backtest.ts --source roseberys --limit 2500 --seed 11 --resolve-work --blend --out tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl
 *
 * Writes one JSON line per lot to tests/backtest/comps_hammer/<name>.jsonl (gitignored;
 * --resume skips lots already present) and prints the summary.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  queryAuctionComparables,
  resolveArtistIdentity,
  closeDriver,
  normalizeTitleKey,
  isLowInformationTitle,
  resolveWorkIdentity,
  fetchArtistWorks,
  queryArtistPriceProfile,
  adjustmentBetween,
  priceAttrsOfComparable,
  priceAttrsOfLot,
  priorsModelPrediction,
  type BlendInputs,
  type ComparablesResult,
  type WorkIdentityBasis,
  type ArtistPriceProfile,
  type PriceAttrs,
} from "../../src/appraisal/knowledge_graph/index";
import { getDriver, getDatabase } from "../../src/appraisal/knowledge_graph/client";
import { mapTechniqueToAckgVocabulary } from "../../src/appraisal/stage2a_query_plan";

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n: string) => argv.includes(`--${n}`);
const SOURCE = (arg("source", "forum") as "roseberys" | "forum" | "bonhams" | "both");
const SALES = arg("sales")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const LIMIT = Number(arg("limit", "0"));
const SEED = Number(arg("seed", "1"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const WINDOW_YEARS = Number(arg("window-years", "10"));
const FORUM_PREMIUM = Number(arg("forum-premium", "1.30"));
const INCLUDE_QUALIFIED = has("include-qualified");
const SOLD_ONLY = has("sold-only");
const RESUME = has("resume");
/** Market drift applied to the catalogue midpoint as a rival predictor. 0.82 was the median
 *  hammer/midpoint on the first 2x2,500-lot runs (2026-09-13); pass --drift to override. It
 *  is a prior, not fitted per run — the in-sample figure is printed alongside for reference. */
const DRIFT = Number(arg("drift", "0.82"));
const SUMMARY_ONLY = arg("summary-only");
/** Resolve the lot to ConceptualWork ids with work_identity.ts before querying comps (step 3).
 *  Off by default so a run without it is the step-1 baseline. */
const RESOLVE_WORK = has("resolve-work");
/** Stratify tier 2 on the lot's signed status and edition band (client-side, from a wider
 *  comp window) and report it beside plain tier 2. The question: does matching the market
 *  segment beat discounting a mixed population by judgement? */
const STRATIFY = has("stratify");
/** Plan step 6 gate: multiply each same-work comp's hammer by the artist's stored elasticities
 *  over the attributes that differ from the lot (signature, proof, edition, size, process —
 *  never house) and score the adjusted median against the raw one on the same lots. */
const ADJUST = has("adjust");
/** Plan step 8: record the blend witnesses' inputs per lot — every same-work hammer with its
 *  date, tier 2/3 medians, the priors model evaluated on the lot's own attributes (sale-year
 *  effect added back), sell-through — so tests/backtest/blend_gate.ts can fit and score the
 *  deterministic blend offline. Adds one profile read per artist and one attrs read per lot. */
const BLEND = has("blend");
/** Edition bands: unsigned book plates and portfolio sheets sit in the hundreds; signed
 *  editions in the tens. Boundaries chosen on the Picasso etching split (2026-09-13). */
const editionBand = (n: number | null | undefined): string => (n == null || n <= 0 ? "unknown" : n <= 50 ? "<=50" : n <= 150 ? "51-150" : ">150");
const OUT_DIR = join(process.cwd(), "tests/backtest/comps_hammer");
const OUT = arg("out", join(OUT_DIR, `${SOURCE}${SALES ? "_" + SALES.join("-") : ""}${LIMIT ? "_n" + LIMIT : ""}.jsonl`));

// ── catalogue parsing (same rules as screen_sale.ts) ──────────────────────────
const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", Eacute: "É", agrave: "à", aacute: "á", acirc: "â", auml: "ä", ccedil: "ç",
  uuml: "ü", ouml: "ö", oacute: "ó", ocirc: "ô", iacute: "í", icirc: "î", uacute: "ú", ntilde: "ñ", szlig: "ß", oslash: "ø", aring: "å",
};
const unesc = (s: string) =>
  s.replace(/&([a-zA-Z]+);/g, (m, c) => ENT[c] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const POST = /\b(FBA|RA|RE|RBA|RWS|ARA|ARE|OM|CH|CBE|OBE|MBE|DBE|PRA|RSA|RSW|NEAC|RCA|FRSA|PPRWS|Hon|R\.A|R\.E)\b\.?/g;
const cleanArtist = (s: string) =>
  unesc(s).replace(POST, "").replace(/^(Dame|Sir|Lord|Lady)\s+/i, "").replace(/\s+/g, " ").trim();
const MEDIUM_WORDS = /\b(etching|lithograph|screenprint|serigraph|woodcut|linocut|aquatint|drypoint|engraving|giclee|photogravure|wove|laid|somerset|arches|signed|numbered|framed|paper)\b/i;
function titleIsUnusable(t: string): boolean {
  const s = t.trim();
  if (!s || s.length < 3) return true;
  if (isLowInformationTitle(s)) return true;
  const hits = s.match(new RegExp(MEDIUM_WORDS.source, "gi")) ?? [];
  return hits.length >= 2;
}
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

interface Lot {
  source: "roseberys" | "forum"; // "bonhams" lots are tagged source:"roseberys" (see loadBonhams) — house identity travels separately, see BONHAMS_HOUSE below
  saleId: string;
  lotNumber: number;
  saleDate: string;
  artistRaw: string;
  artist: string;
  qualifier: string;
  title: string;
  medium: string;
  lowEst: number;
  highEst: number;
  sold: boolean;
  hammer: number | null;
  /** Premium-inclusive realised price. Null for Forum (not in its CSV). */
  realised: number | null;
  /** realised / hammer for this lot's sale — measured for Roseberys, assumed for Forum. */
  premiumRatio: number;
  premiumBasis: "measured" | "assumed";
  listingUrl: string | null;
  /** The house's own catalogue-raisonné refs column, when it has one. */
  catalogueRefs: string | null;
  signed: boolean | null;
  editionSize: number | null;
  /** Catalogue fields the pricing-model attributes are read from (--adjust). */
  editionNote: string | null;
  widthCm: number | null;
  heightCm: number | null;
}
const numOrNull = (v: string | undefined) => (Number(v) > 0 ? Number(v) : null);
/** Populated in main() when --source bonhams is used, so processLot can tag blend inputs with
 *  the real house even though loadBonhams() reuses the "roseberys" Lot shape. */
const BONHAMS_HOUSE = new Set<string>();
/** The graph's real institutionName for a lot — needed for LOT_ATTRS and priorsModelPrediction's
 *  house term, since loadBonhams() reuses the "roseberys" Lot shape (see BONHAMS_HOUSE above). */
const houseName = (lot: Lot): string => (BONHAMS_HOUSE.has(lot.saleId) ? "Bonhams" : lot.source === "roseberys" ? "Roseberys London" : "Forum Auctions");

function loadRoseberys(): Lot[] {
  const dates = JSON.parse(readFileSync("knowledge_graph/roseberys_sale_dates.json", "utf8")).sales as Record<string, { saleDate: string }>;
  const rows = readCsv("benchmark/data/all-prints/catalogue.csv");
  // Premium ratio per sale: median realised/hammer over that sale's sold lots.
  const ratios: Record<string, number[]> = {};
  for (const r of rows) {
    const h = Number(r.hammer), p = Number(r.price_realised_inc_premium);
    if (r.sold === "sold" && h > 0 && p > 0) (ratios[r.sale_code] ??= []).push(p / h);
  }
  const premium: Record<string, number> = {};
  for (const [k, v] of Object.entries(ratios)) { v.sort((a, b) => a - b); premium[k] = v[Math.floor(v.length / 2)]; }
  const out: Lot[] = [];
  for (const r of rows) {
    const saleDate = dates[r.sale_code]?.saleDate;
    if (!saleDate) continue;
    if (r.multi_work.trim()) continue;
    const h = Number(r.hammer), p = Number(r.price_realised_inc_premium);
    out.push({
      source: "roseberys", saleId: r.sale_code, lotNumber: Number(r.lot_number), saleDate,
      artistRaw: r.artist, artist: cleanArtist(r.artist), qualifier: r.artist_qualifier || "certain",
      title: unesc(r.title).trim(), medium: r.medium, lowEst: Number(r.low_estimate || 0), highEst: Number(r.high_estimate || 0),
      sold: r.sold === "sold", hammer: h > 0 ? h : null, realised: p > 0 ? p : null,
      premiumRatio: premium[r.sale_code] ?? 1.3, premiumBasis: premium[r.sale_code] ? "measured" : "assumed",
      listingUrl: r.lot_url || null, catalogueRefs: r.catalogue_refs?.trim() || null,
      signed: r.signed === "yes" ? true : r.signed === "no" ? false : null,
      editionSize: Number(r.edition_size) > 0 ? Number(r.edition_size) : null,
      editionNote: r.edition_note?.trim() || null, widthCm: numOrNull(r.width_cm), heightCm: numOrNull(r.height_cm),
    });
  }
  return out;
}

/** Bonhams has no separate pre-ingest catalogue CSV (unlike Roseberys/Forum) — its data only
 *  exists already-ingested in the graph, so this reads back the export written by
 *  tests/backtest/_pull_bonhams_catalogue.ts rather than a scraped catalogue. Self-match
 *  exclusion (excludeSaleLot/excludeListingUrl in queryAuctionComparables) still applies, so a
 *  Bonhams lot cannot value itself off its own realised price — but Bonhams is ~80% of the
 *  graph's dated corpus, so a Bonhams lot's comps are overwhelmingly OTHER Bonhams sales
 *  (legitimate: a valuer would see them) rather than a genuinely cross-house test. Premium
 *  ratio is measured per-sale exactly as for Roseberys, since priceRealisedGBP is populated. */
function loadBonhams(): Lot[] {
  const rows = JSON.parse(readFileSync("benchmark/data/bonhams/catalogue.json", "utf8")) as {
    artist: string; title: string | null; rawMedium: string | null; saleId: string; lotNumber: number | null; saleDate: string;
    lowEst: number | null; highEst: number | null; sold: boolean; hammer: number | null; realised: number | null; listingUrl: string | null;
    signed: boolean | null; editionSize: number | null; plateDims: string | null; imageDims: string | null; sheetDims: string | null;
  }[];
  const ratios: Record<string, number[]> = {};
  for (const r of rows) if (r.sold && r.hammer && r.hammer > 0 && r.realised && r.realised > 0) (ratios[r.saleId] ??= []).push(r.realised / r.hammer);
  const premium: Record<string, number> = {};
  for (const [k, v] of Object.entries(ratios)) { v.sort((a, b) => a - b); premium[k] = v[Math.floor(v.length / 2)]; }
  const dimsCm = (s: string | null): { widthCm: number | null; heightCm: number | null } => {
    const m = s?.match(/([\d.]+)\s*x\s*([\d.]+)\s*cm/i);
    return m ? { widthCm: Number(m[1]), heightCm: Number(m[2]) } : { widthCm: null, heightCm: null };
  };
  const out: Lot[] = [];
  for (const r of rows) {
    if (!r.artist || !r.lotNumber) continue;
    const dims = dimsCm(r.sheetDims ?? r.imageDims ?? r.plateDims);
    out.push({
      source: "roseberys", // reuses the "roseberys"-shaped Lot; distinguished via a synthetic house tag below
      saleId: r.saleId, lotNumber: r.lotNumber, saleDate: r.saleDate,
      artistRaw: r.artist, artist: cleanArtist(r.artist), qualifier: "certain",
      title: unesc(r.title ?? "").trim(), medium: r.rawMedium ?? "", lowEst: r.lowEst ?? 0, highEst: r.highEst ?? 0,
      sold: r.sold, hammer: r.hammer && r.hammer > 0 ? r.hammer : null, realised: r.realised && r.realised > 0 ? r.realised : null,
      premiumRatio: premium[r.saleId] ?? 1.25, premiumBasis: premium[r.saleId] ? "measured" : "assumed",
      listingUrl: r.listingUrl, catalogueRefs: null, signed: r.signed ?? null, editionSize: r.editionSize ?? null,
      editionNote: null, widthCm: dims.widthCm, heightCm: dims.heightCm,
    });
  }
  return out;
}

function loadForum(): Lot[] {
  const rows = readCsv("benchmark/data/forum/catalogue.csv");
  const out: Lot[] = [];
  for (const r of rows) {
    if (!r.sale_date) continue;
    if (r.multi_work.trim()) continue;
    if (r.is_print_medium && r.is_print_medium !== "yes") continue;
    const h = Number(r.hammer);
    out.push({
      source: "forum", saleId: r.sale_code, lotNumber: Number(r.lot_number), saleDate: r.sale_date,
      artistRaw: r.artist, artist: cleanArtist(r.artist), qualifier: r.artist_qualifier || "certain",
      title: unesc(r.title).trim(), medium: r.medium, lowEst: Number(r.low_estimate || 0), highEst: Number(r.high_estimate || 0),
      sold: r.sold === "sold", hammer: h > 0 ? h : null, realised: null,
      premiumRatio: FORUM_PREMIUM, premiumBasis: "assumed",
      listingUrl: r.lot_url || null, catalogueRefs: r.catalogue_refs?.trim() || null,
      signed: r.signed === "yes" ? true : r.signed === "no" ? false : null,
      editionSize: Number(r.edition_size) > 0 ? Number(r.edition_size) : null,
      editionNote: r.edition_note?.trim() || null, widthCm: numOrNull(r.width_cm), heightCm: numOrNull(r.height_cm),
    });
  }
  return out;
}

// ── per-lot result ────────────────────────────────────────────────────────────
interface TierStat { n: number; median: number | null; medianHammer: number | null; latest: string | null }
interface Row extends Lot {
  key: string;
  canonicalArtist: string | null;
  resolved: boolean;
  ambiguous: number;
  titleUsable: boolean;
  technique: string | null;
  sinceDate: string;
  tiers: { same_work: TierStat; same_artist_technique: TierStat; same_artist: TierStat };
  /** --stratify: tier-2 comps sharing the lot's signed status (and, when both known, edition band). */
  strata?: { signedOnly: TierStat; signedAndBand: TierStat };
  bestTier: "same_work" | "same_artist_technique" | "same_artist" | "none";
  bestMedian: number | null;
  sellThrough: { sold: number; unsold: number } | null;
  /** --adjust: same-work comps re-priced to the lot's attributes by the artist's elasticities. */
  adjusted?: {
    basis: ArtistPriceProfile["basis"]; earlierSales: number | null; lotAttrs: PriceAttrs; lotAttrsSource: "graph" | "csv";
    n: number; medianRawHammer: number | null; medianAdjHammer: number | null;
    /** Median |log multiplier| — how much the adjustment actually moved the comps. */
    medianAbsLogAdj: number; differingAttrs: Record<string, number>; unknownColumns: string[];
  } | null;
  /** --blend: the witness inputs for price_blend.ts, plus where the lot's attributes came from. */
  blend?: { inputs: BlendInputs; lotAttrsSource: "graph" | "csv" | "none"; priorsUnknownColumns: string[] } | null;
  /** How the lot was resolved to a work (only when --resolve-work). */
  workIdentity?: { basis: WorkIdentityBasis | null; ids: number; ambiguousAt: WorkIdentityBasis | null; matchedName: string | null };
  error?: string;
}

const SELL_THROUGH = `
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
      -[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE a.name = $artist AND s.sourceType = 'auction'
  AND s.saleDate IS NOT NULL AND substring(s.saleDate, 0, 10) < $untilDate
  AND ($sinceDate IS NULL OR s.saleDate >= $sinceDate)
  AND NOT (s.saleId = $saleId AND s.lotNumber = $lotNumber)
WITH cw, s
WHERE replace(replace(replace(toLower(trim(cw.name)),'(',' '),')',' '),'-',' ') CONTAINS $titleKey
RETURN count(CASE WHEN s.sold THEN 1 END) AS sold,
       count(CASE WHEN s.sold = false THEN 1 END) AS unsold
`;
async function sellThrough(artist: string, titleKey: string, lot: Lot, sinceDate: string) {
  const s = getDriver().session({ database: getDatabase() });
  try {
    const r = await s.run(SELL_THROUGH, { artist, titleKey, untilDate: lot.saleDate, sinceDate, saleId: lot.saleId, lotNumber: lot.lotNumber });
    const rec = r.records[0];
    const n = (v: any) => v?.toNumber?.() ?? Number(v ?? 0);
    return { sold: n(rec?.get("sold")), unsold: n(rec?.get("unsold")) };
  } finally { await s.close(); }
}

function statOf(xs: ComparablesResult["comparables"]): TierStat {
  const p = xs.map((x) => x.priceRealisedGBP).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const med = p.length ? (p.length % 2 ? p[(p.length - 1) / 2] : (p[p.length / 2 - 1] + p[p.length / 2]) / 2) : null;
  const h = xs.map((x) => x.hammerPriceGBP).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const medH = h.length ? (h.length % 2 ? h[(h.length - 1) / 2] : (h[h.length / 2 - 1] + h[h.length / 2]) / 2) : null;
  const latest = xs.map((x) => x.saleDate?.slice(0, 10) ?? "").filter(Boolean).sort().pop() ?? null;
  return { n: xs.length, median: med, medianHammer: medH, latest };
}
function tierStat(c: ComparablesResult, tier: Row["bestTier"]): TierStat {
  return statOf(c.comparables.filter((x) => x.tier === tier));
}

const identityCache = new Map<string, { canonical: string | null; ambiguous: number }>();
const profileCache = new Map<string, Promise<ArtistPriceProfile | null>>();
function priceProfile(canonical: string) {
  if (!profileCache.has(canonical)) profileCache.set(canonical, queryArtistPriceProfile(canonical));
  return profileCache.get(canonical)!;
}
/** The lot's OWN catalogue record in the graph (excluded from comps, but its description is
 *  what the house printed and a valuer reads pre-sale). Used for the lot's pricing attributes
 *  so both sides of the adjustment are classified from the same fields by the same rules: the
 *  CSV drops the "numbered 12/50" text and the structured copyType that the graph keeps, which
 *  made proof class differ on 30 of 32 smoke-run lots for no real reason. */
const LOT_ATTRS = `
MATCH (src:SourceRecord)-[:DOCUMENTS]->(i:Impression)<-[:INCLUDES]-(er:EditionRun)
WHERE src.saleId = $saleId AND src.lotNumber = $lotNumber AND src.institutionName = $house
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
RETURN i.rawMedium AS rawMedium, i.copyType AS copyType, i.signed AS signed, coalesce(er.declaredSize, er.editionSize) AS editionSize,
       i.plateDimensions AS plateDimensions, i.imageDimensions AS imageDimensions, i.sheetDimensions AS sheetDimensions,
       collect(DISTINCT t.name) AS techniques
LIMIT 1`;
async function lotAttrsFromGraph(lot: Lot): Promise<PriceAttrs | null> {
  const s = getDriver().session({ database: getDatabase() });
  try {
    const r = await s.run(LOT_ATTRS, { saleId: lot.saleId, lotNumber: lot.lotNumber, house: houseName(lot) });
    const rec = r.records[0]; if (!rec) return null;
    const n = (v: any) => (v == null ? null : typeof v === "number" ? v : v.toNumber?.() ?? null);
    return priceAttrsOfComparable({
      techniques: (rec.get("techniques") as unknown[]).filter(Boolean).map(String), signed: typeof rec.get("signed") === "boolean" ? rec.get("signed") : null,
      editionSize: n(rec.get("editionSize")), rawMedium: rec.get("rawMedium") ?? null, copyType: rec.get("copyType") ?? null,
      plateDimensions: rec.get("plateDimensions") ?? null, imageDimensions: rec.get("imageDimensions") ?? null, sheetDimensions: rec.get("sheetDimensions") ?? null,
    });
  } finally { await s.close(); }
}
const medianOf = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const worksCache = new Map<string, Awaited<ReturnType<typeof fetchArtistWorks>>>();
async function artistWorks(canonical: string) {
  if (!worksCache.has(canonical)) worksCache.set(canonical, await fetchArtistWorks(canonical));
  return worksCache.get(canonical)!;
}
async function resolve(name: string) {
  if (identityCache.has(name)) return identityCache.get(name)!;
  const id = await resolveArtistIdentity(name);
  const v = { canonical: id?.canonicalName ?? null, ambiguous: id?.ambiguousMatchCount ?? 0 };
  identityCache.set(name, v);
  return v;
}

async function processLot(lot: Lot): Promise<Row> {
  const since = new Date(lot.saleDate); since.setFullYear(since.getFullYear() - WINDOW_YEARS);
  const sinceDate = since.toISOString().slice(0, 10);
  const base: Row = {
    ...lot, key: `${lot.source}:${lot.saleId}:${lot.lotNumber}`,
    canonicalArtist: null, resolved: false, ambiguous: 0,
    titleUsable: !titleIsUnusable(lot.title), technique: mapTechniqueToAckgVocabulary(lot.medium), sinceDate,
    tiers: { same_work: { n: 0, median: null, medianHammer: null, latest: null }, same_artist_technique: { n: 0, median: null, medianHammer: null, latest: null }, same_artist: { n: 0, median: null, medianHammer: null, latest: null } },
    bestTier: "none", bestMedian: null, sellThrough: null,
  };
  try {
    let id = await resolve(lot.artist);
    if (!id.canonical && lot.artist !== unesc(lot.artistRaw).trim()) id = await resolve(unesc(lot.artistRaw).trim());
    base.canonicalArtist = id.canonical; base.resolved = !!id.canonical; base.ambiguous = id.ambiguous;
    if (!id.canonical) return base;
    let workIds: string[] = [];
    if (RESOLVE_WORK) {
      const wi = await resolveWorkIdentity({ artistName: id.canonical, title: lot.title, catalogueRefs: lot.catalogueRefs, works: await artistWorks(id.canonical), excludeSaleLot: { saleId: lot.saleId, lotNumber: lot.lotNumber } });
      workIds = wi.workIds;
      base.workIdentity = { basis: wi.basis, ids: wi.workIds.length, ambiguousAt: wi.ambiguousAt, matchedName: wi.matchedNames[0] ?? null };
    }
    const c = await queryAuctionComparables({
      artistName: id.canonical,
      conceptualWorkIds: workIds,
      workTitle: base.titleUsable ? lot.title : null,
      technique: base.technique,
      sinceDate, untilDate: lot.saleDate,
      excludeSaleLot: { saleId: lot.saleId, lotNumber: lot.lotNumber },
      excludeListingUrl: lot.listingUrl,
      limit: STRATIFY ? 200 : 60,
    });
    if (STRATIFY) {
      const t2 = c.comparables.filter((x) => x.tier === "same_artist_technique");
      const sameSigned = lot.signed == null ? [] : t2.filter((x) => x.signed === lot.signed);
      const sameBand = lot.signed == null || lot.editionSize == null ? [] : sameSigned.filter((x) => editionBand(x.editionSize) === editionBand(lot.editionSize));
      base.strata = { signedOnly: statOf(sameSigned), signedAndBand: statOf(sameBand) };
    }
    if (ADJUST) {
      const sw = c.comparables.filter((x) => x.tier === "same_work" && x.hammerPriceGBP != null && x.hammerPriceGBP > 0);
      const profile = sw.length ? await priceProfile(id.canonical) : null;
      if (profile && sw.length) {
        const fromGraph = await lotAttrsFromGraph(lot);
        const lotAttrs = fromGraph ?? priceAttrsOfLot({ text: [lot.medium, lot.editionNote].filter(Boolean).join(", "), techniques: base.technique ? [base.technique] : null, signed: lot.signed, editionSize: lot.editionSize, widthCm: lot.widthCm, heightCm: lot.heightCm });
        const differing: Record<string, number> = {};
        const unknown = new Set<string>();
        const adj: number[] = [], raw: number[] = [], logs: number[] = [];
        for (const x of sw) {
          const a = adjustmentBetween(lotAttrs, priceAttrsOfComparable(x), profile);
          for (const f of a.factors) differing[f.attribute] = (differing[f.attribute] ?? 0) + 1;
          for (const u of a.unknownColumns) unknown.add(u);
          raw.push(x.hammerPriceGBP!); adj.push(x.hammerPriceGBP! * a.multiplier); logs.push(Math.abs(a.logAdjustment));
        }
        base.adjusted = { basis: profile.basis, earlierSales: profile.earlierSales, lotAttrs, lotAttrsSource: fromGraph ? "graph" : "csv", n: sw.length, medianRawHammer: medianOf(raw), medianAdjHammer: medianOf(adj), medianAbsLogAdj: medianOf(logs) ?? 0, differingAttrs: differing, unknownColumns: [...unknown].sort() };
      } else {
        base.adjusted = null;
      }
    }
    if (BLEND) {
      const profile = await priceProfile(id.canonical);
      const fromGraph = profile ? await lotAttrsFromGraph(lot) : null;
      const lotAttrs = fromGraph ?? priceAttrsOfLot({ text: [lot.medium, lot.editionNote].filter(Boolean).join(", "), techniques: base.technique ? [base.technique] : null, signed: lot.signed, editionSize: lot.editionSize, widthCm: lot.widthCm, heightCm: lot.heightCm });
      const pred = profile ? priorsModelPrediction(lotAttrs, profile, { saleDate: lot.saleDate, house: houseName(lot) }) : null;
      const t2 = tierStat(c, "same_artist_technique"), t3 = tierStat(c, "same_artist");
      base.blend = {
        inputs: {
          saleDate: lot.saleDate, house: BONHAMS_HOUSE.has(lot.saleId) ? "bonhams" : lot.source,
          estimate: lot.lowEst > 0 && lot.highEst > 0 ? { lowGBP: lot.lowEst, highGBP: lot.highEst } : null,
          sameWork: c.comparables.filter((x) => x.tier === "same_work" && x.hammerPriceGBP != null && x.hammerPriceGBP > 0).map((x) => ({ hammerGBP: x.hammerPriceGBP!, saleDate: x.saleDate })),
          sameArtistTechnique: t2.n > 0 && t2.medianHammer != null ? { n: t2.n, medianHammerGBP: t2.medianHammer } : null,
          sameArtist: t3.n > 0 && t3.medianHammer != null ? { n: t3.n, medianHammerGBP: t3.medianHammer } : null,
          priors: pred && profile ? { mu: pred.mu, basis: profile.basis, earlierSales: profile.earlierSales, contributions: pred.contributions } : null,
          sellThrough: null,
        },
        lotAttrsSource: fromGraph ? "graph" : profile ? "csv" : "none",
        priorsUnknownColumns: pred?.unknownColumns ?? [],
      };
    }
    base.tiers = {
      same_work: tierStat(c, "same_work"),
      same_artist_technique: tierStat(c, "same_artist_technique"),
      same_artist: tierStat(c, "same_artist"),
    };
    for (const t of ["same_work", "same_artist_technique", "same_artist"] as const) {
      if (base.tiers[t].n > 0) { base.bestTier = t; base.bestMedian = base.tiers[t].median ?? (base.tiers[t].medianHammer != null ? base.tiers[t].medianHammer! * lot.premiumRatio : null); break; }
    }
    if (base.titleUsable) {
      const key = normalizeTitleKey(lot.title).slice(0, 24);
      if (key) base.sellThrough = await sellThrough(id.canonical, key, lot, sinceDate);
    }
    if (base.blend) base.blend.inputs.sellThrough = base.sellThrough;
  } catch (err: any) {
    base.error = String(err?.message ?? err);
  }
  return base;
}

// ── stats helpers ─────────────────────────────────────────────────────────────
const ln = Math.log;
function quantile(xs: number[], q: number): number { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; }
function geo(xs: number[]): number { return Math.exp(xs.reduce((t, x) => t + x, 0) / xs.length); }
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return NaN;
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const ma = ra.reduce((t, x) => t + x, 0) / n, mb = rb.reduce((t, x) => t + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
const pct = (k: number, n: number) => n ? `${((100 * k) / n).toFixed(0)}%` : "-";
const f2 = (x: number) => x.toFixed(2);

function logRatioBlock(label: string, xs: number[]) {
  if (!xs.length) { console.log(`  ${label.padEnd(34)} n=0`); return; }
  const within25 = xs.filter((x) => Math.abs(x) <= ln(1.25)).length;
  const within2x = xs.filter((x) => Math.abs(x) <= ln(2)).length;
  console.log(
    `  ${label.padEnd(34)} n=${String(xs.length).padStart(5)}  median=${f2(Math.exp(quantile(xs, 0.5))).padStart(5)}  geo=${f2(geo(xs)).padStart(5)}  ` +
    `p10=${f2(Math.exp(quantile(xs, 0.1))).padStart(5)} p90=${f2(Math.exp(quantile(xs, 0.9))).padStart(6)}  ±25%: ${pct(within25, xs.length).padStart(4)}  within 2x: ${pct(within2x, xs.length).padStart(4)}`,
  );
}

function summarize(rows: Row[]) {
  const all = rows.filter((r) => !r.error);
  const errors = rows.length - all.length;
  const sold = all.filter((r) => r.sold && r.hammer);
  console.log(`\n══ Comps-vs-hammer backtest ═══════════════════════════════════════════════════════`);
  console.log(`lots=${rows.length} (errors ${errors})  sold=${sold.length}  unsold=${all.length - sold.length}  window=${WINDOW_YEARS}y  sources=${[...new Set(all.map((r) => r.source))].join(",")}`);
  const assumed = all.filter((r) => r.premiumBasis === "assumed").length;
  if (assumed) console.log(`premium ratio ASSUMED (${FORUM_PREMIUM}) on ${assumed} lots — their "realised" is hammer × that ratio`);

  // coverage
  console.log(`\n── Coverage (all lots) ──`);
  const resolved = all.filter((r) => r.resolved);
  console.log(`  artist resolves to an Artist node : ${resolved.length}/${all.length} (${pct(resolved.length, all.length)})   ambiguous (>1 node): ${resolved.filter((r) => r.ambiguous > 1).length}`);
  console.log(`  title usable for tier-1 matching  : ${all.filter((r) => r.titleUsable).length}/${all.length}`);
  console.log(`  technique mapped to graph vocab   : ${all.filter((r) => r.technique).length}/${all.length}`);
  const byBest = (s: Row[]) => ({
    same_work: s.filter((r) => r.bestTier === "same_work").length,
    sat: s.filter((r) => r.bestTier === "same_artist_technique").length,
    sa: s.filter((r) => r.bestTier === "same_artist").length,
    none: s.filter((r) => r.bestTier === "none").length,
  });
  const b = byBest(resolved);
  console.log(`  best tier reached (resolved lots) : same_work ${b.same_work} (${pct(b.same_work, resolved.length)})  same_artist_technique ${b.sat} (${pct(b.sat, resolved.length)})  same_artist ${b.sa} (${pct(b.sa, resolved.length)})  none ${b.none} (${pct(b.none, resolved.length)})`);
  console.log(`  same_work with >=3 pre-sale comps : ${resolved.filter((r) => r.tiers.same_work.n >= 3).length}`);
  const bl = resolved.filter((r) => r.blend);
  if (bl.length) {
    console.log(`  blend inputs (--blend)            : ${bl.length} lots; priors model on ${bl.filter((r) => r.blend!.inputs.priors).length} (attrs from graph ${bl.filter((r) => r.blend!.lotAttrsSource === "graph").length}); same-work hammers on ${bl.filter((r) => r.blend!.inputs.sameWork.length).length}  -> score with npm run backtest:blend-gate`);
  }
  const wi = resolved.filter((r) => r.workIdentity);
  if (wi.length) {
    const byBasis: Record<string, { lots: number; withComps: number }> = {};
    for (const r of wi) { const k = r.workIdentity!.basis ?? (r.workIdentity!.ambiguousAt ? `AMBIGUOUS@${r.workIdentity!.ambiguousAt}` : "none"); const b = (byBasis[k] ??= { lots: 0, withComps: 0 }); b.lots++; if (r.tiers.same_work.n > 0) b.withComps++; }
    console.log(`  work identity (--resolve-work)    : ${Object.entries(byBasis).map(([k, v]) => `${k} ${v.lots} (same_work comps on ${v.withComps})`).join("  |  ")}`);
  }

  // accuracy: comp median vs realised (premium basis on both sides)
  const realisedOf = (r: Row) => r.realised ?? (r.hammer ? r.hammer * r.premiumRatio : null);
  console.log(`\n── Accuracy: comp median / realised price (sold lots; both premium-inclusive) ──`);
  for (const t of ["same_work", "same_artist_technique", "same_artist"] as const) {
    for (const minN of t === "same_work" ? [1, 3] : [3]) {
      const xs = sold.filter((r) => r.tiers[t].n >= minN && r.tiers[t].median != null && realisedOf(r)).map((r) => ln(r.tiers[t].median! / realisedOf(r)!));
      logRatioBlock(`${t} (n>=${minN})`, xs);
    }
  }
  logRatioBlock("best available tier", sold.filter((r) => r.bestMedian != null && r.bestMedian > 0 && realisedOf(r)).map((r) => ln(r.bestMedian! / realisedOf(r)!)));
  if (wi.length) {
    console.log(`  — same_work (n>=1) split by identity basis —`);
    for (const basis of ["exact_title", "citation", "stripped_title", "stripped_no_series"]) {
      logRatioBlock(`  via ${basis}`, sold.filter((r) => r.workIdentity?.basis === basis && r.tiers.same_work.n >= 1 && r.tiers.same_work.median != null && realisedOf(r)).map((r) => ln(r.tiers.same_work.median! / realisedOf(r)!)));
    }
  }

  // house baseline
  console.log(`\n── House baseline on the same sold lots: hammer vs catalogue estimate ──`);
  const withEst = sold.filter((r) => r.lowEst > 0 && r.highEst > 0);
  const inRange = withEst.filter((r) => r.hammer! >= r.lowEst && r.hammer! <= r.highEst).length;
  const below = withEst.filter((r) => r.hammer! < r.lowEst).length;
  const above = withEst.filter((r) => r.hammer! > r.highEst).length;
  console.log(`  hammer inside [low, high]: ${pct(inRange, withEst.length)}   below low: ${pct(below, withEst.length)}   above high: ${pct(above, withEst.length)}   (n=${withEst.length})`);
  logRatioBlock("hammer / estimate midpoint", withEst.map((r) => ln(r.hammer! / ((r.lowEst + r.highEst) / 2))));
  const unsoldAll = all.filter((r) => !r.sold).length;
  console.log(`  sold-through overall: ${pct(all.length - unsoldAll, all.length)} of ${all.length} lots`);

  // screen decision
  console.log(`\n── Screen decision: comp median vs estimate midpoint (on the premium basis) ──`);
  for (const [label, sel] of [
    ["same_work n>=2", (r: Row) => r.tiers.same_work.n >= 2 ? r.tiers.same_work.median : null],
    ["same_work n>=1", (r: Row) => r.tiers.same_work.n >= 1 ? r.tiers.same_work.median : null],
    ["same_artist_technique n>=3", (r: Row) => r.tiers.same_artist_technique.n >= 3 ? r.tiers.same_artist_technique.median : null],
    ["best tier", (r: Row) => r.bestMedian],
  ] as const) {
    const pool = all.filter((r) => r.lowEst > 0 && r.highEst > 0 && sel(r) != null);
    if (!pool.length) { console.log(`  ${label}: n=0`); continue; }
    const signal = (r: Row) => ln(sel(r)! / (((r.lowEst + r.highEst) / 2) * r.premiumRatio));
    const outcome = (r: Row) => ln(r.hammer! / ((r.lowEst + r.highEst) / 2));
    const soldPool = pool.filter((r) => r.sold && r.hammer);
    const rho = spearman(soldPool.map(signal), soldPool.map(outcome));
    console.log(`\n  ${label}: n=${pool.length} (sold ${soldPool.length})   Spearman(signal, hammer/mid) = ${isNaN(rho) ? "n/a" : rho.toFixed(3)}`);
    console.log(`  ${"bucket".padEnd(22)} ${"n".padStart(5)}  ${"unsold".padStart(7)}  ${"hammer<low".padStart(11)}  ${"hammer>high".padStart(12)}  ${"median hammer/mid".padStart(18)}`);
    const buckets: Array<[string, (s: number) => boolean]> = [
      ["comps < 0.67x est", (s) => s < ln(0.67)],
      ["0.67x – 0.8x", (s) => s >= ln(0.67) && s < ln(0.8)],
      ["0.8x – 1.25x (fair)", (s) => s >= ln(0.8) && s <= ln(1.25)],
      ["1.25x – 1.5x", (s) => s > ln(1.25) && s <= ln(1.5)],
      ["comps > 1.5x est", (s) => s > ln(1.5)],
      ["ALL (base rate)", () => true],
    ];
    for (const [name, test] of buckets) {
      const g = pool.filter((r) => test(signal(r)));
      const gs = g.filter((r) => r.sold && r.hammer);
      const unsold = g.length - gs.length;
      const lo = gs.filter((r) => r.hammer! < r.lowEst).length, hi = gs.filter((r) => r.hammer! > r.highEst).length;
      const med = gs.length ? Math.exp(quantile(gs.map(outcome), 0.5)) : NaN;
      console.log(`  ${name.padEnd(22)} ${String(g.length).padStart(5)}  ${pct(unsold, g.length).padStart(7)}  ${pct(lo, gs.length).padStart(11)}  ${pct(hi, gs.length).padStart(12)}  ${(isNaN(med) ? "-" : f2(med)).padStart(18)}`);
    }
  }

  // stratified tier 2 vs plain tier 2, on the same lots
  const strat = sold.filter((r) => r.strata);
  if (strat.length) {
    console.log(`\n── Tier 2 stratified on the lot's signed status / edition band vs plain tier 2 (same lots) ──`);
    for (const [label, pick] of [
      ["signed status matched (n>=3)", (r: Row) => r.strata!.signedOnly],
      ["signed + edition band matched (n>=3)", (r: Row) => r.strata!.signedAndBand],
    ] as const) {
      const g = strat.filter((r) => pick(r).n >= 3 && pick(r).medianHammer != null && r.tiers.same_artist_technique.n >= 3 && r.tiers.same_artist_technique.medianHammer != null);
      if (!g.length) { console.log(`  ${label}: n=0`); continue; }
      const err = (f: (r: Row) => number) => g.map((r) => ln(f(r) / r.hammer!));
      const show = (name: string, e: number[]) => console.log(`     ${name.padEnd(30)} n=${String(e.length).padStart(4)} geo=${f2(geo(e)).padStart(5)}  ±25%: ${pct(e.filter((x) => Math.abs(x) <= ln(1.25)).length, e.length).padStart(4)}  within 2x: ${pct(e.filter((x) => Math.abs(x) <= ln(2)).length, e.length).padStart(4)}  MAE(log)=${(e.reduce((t, x) => t + Math.abs(x), 0) / e.length).toFixed(3)}`);
      console.log(`  ${label} — lots where both are available: ${g.length}`);
      show("plain tier-2 hammer median", err((r) => r.tiers.same_artist_technique.medianHammer!));
      show("stratified hammer median", err((r) => pick(r).medianHammer!));
      show(`catalogue midpoint x ${DRIFT}`, err((r) => ((r.lowEst + r.highEst) / 2) * DRIFT));
    }
    const cov = strat.filter((r) => r.tiers.same_artist_technique.n >= 3).length;
    console.log(`  coverage: tier-2 n>=3 on ${cov} sold lots; signed-matched n>=3 on ${strat.filter((r) => r.strata!.signedOnly.n >= 3).length}; signed+band n>=3 on ${strat.filter((r) => r.strata!.signedAndBand.n >= 3).length}`);
  }

  // predictors of hammer, head to head: does the comp add anything to the estimate?
  console.log(`\n── Predictors of HAMMER, head to head (sold lots with same_work comps) ──`);
  const inSampleDrift = withEst.length ? Math.exp(quantile(withEst.map((r) => ln(r.hammer! / ((r.lowEst + r.highEst) / 2))), 0.5)) : NaN;
  console.log(`  drift prior ${DRIFT} (in-sample median hammer/mid on this run: ${isNaN(inSampleDrift) ? "n/a" : f2(inSampleDrift)})`);
  for (const [label, tier, minN] of [["same_work n>=2", "same_work", 2], ["same_work n>=1", "same_work", 1], ["same_artist_technique n>=3", "same_artist_technique", 3]] as const) {
    const g = withEst.filter((r) => r.tiers[tier].n >= minN);
    if (g.length < 5) { console.log(`  ${label}: n=${g.length} (too few)`); continue; }
    const mid = (r: Row) => (r.lowEst + r.highEst) / 2;
    // Comp on the HAMMER basis: the graph's own hammerPriceGBP when the run recorded it,
    // else realised / premium ratio (runs made before medianHammer existed).
    const comp = (r: Row) => r.tiers[tier].medianHammer ?? r.tiers[tier].median! / r.premiumRatio;
    const hammerBased = g.filter((r) => r.tiers[tier].medianHammer != null).length;
    const preds: Array<[string, (r: Row) => number]> = [
      ["catalogue midpoint", mid],
      [`catalogue midpoint x ${DRIFT}`, (r) => mid(r) * DRIFT],
      [`comp hammer median${hammerBased < g.length ? " (realised/premium where no hammer)" : ""}`, comp],
      ["geo blend (mid x drift, comp / 1.1)", (r) => Math.sqrt(mid(r) * DRIFT * (comp(r) / 1.1))],
    ];
    console.log(`  ${label} (n=${g.length})`);
    for (const [name, fn] of preds) {
      const e = g.map((r) => ln(fn(r) / r.hammer!));
      const mae = e.reduce((t, x) => t + Math.abs(x), 0) / e.length;
      console.log(`     ${name.padEnd(36)} geo=${f2(geo(e)).padStart(5)}  ±25%: ${pct(e.filter((x) => Math.abs(x) <= ln(1.25)).length, e.length).padStart(4)}  within 2x: ${pct(e.filter((x) => Math.abs(x) <= ln(2)).length, e.length).padStart(4)}  MAE(log)=${mae.toFixed(3)}`);
    }
  }

  // step 6 gate: same-work comps adjusted by the artist's elasticities vs raw, same lots
  const adjRows = withEst.filter((r) => r.adjusted && r.adjusted.medianAdjHammer != null && r.adjusted.medianRawHammer != null);
  if (adjRows.length) {
    console.log(`\n── Step 6 gate: same-work comp hammer ADJUSTED by the artist's elasticities vs raw (same sold lots) ──`);
    const nAdj = all.filter((r) => r.adjusted).length, nNoProfile = all.filter((r) => r.adjusted === null && r.tiers.same_work.n > 0).length;
    console.log(`  lots with a profile and same-work hammer comps: ${nAdj}; same-work comps but no profile: ${nNoProfile}`);
    const byBasis: Record<string, number> = {};
    for (const r of adjRows) byBasis[r.adjusted!.basis] = (byBasis[r.adjusted!.basis] ?? 0) + 1;
    console.log(`  profile basis: ${Object.entries(byBasis).map(([k, v]) => `${k} ${v}`).join(", ")}   lot attrs from graph record: ${adjRows.filter((r) => r.adjusted!.lotAttrsSource === "graph").length}/${adjRows.length}`);
    const moved = adjRows.filter((r) => r.adjusted!.medianAbsLogAdj > ln(1.25)).length;
    console.log(`  adjustment moved the comps by >25% on ${moved}/${adjRows.length} lots (median |log mult| ${f2(Math.exp(quantile(adjRows.map((r) => r.adjusted!.medianAbsLogAdj), 0.5)))}x)`);
    const diffCounts: Record<string, number> = {};
    for (const r of adjRows) for (const k of Object.keys(r.adjusted!.differingAttrs)) diffCounts[k] = (diffCounts[k] ?? 0) + 1;
    console.log(`  lots where an attribute differed from a comp: ${Object.entries(diffCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    const mid = (r: Row) => (r.lowEst + r.highEst) / 2;
    const show = (name: string, e: number[]) => console.log(`     ${name.padEnd(44)} n=${String(e.length).padStart(4)} geo=${f2(geo(e)).padStart(5)}  ±25%: ${pct(e.filter((x) => Math.abs(x) <= ln(1.25)).length, e.length).padStart(4)}  within 2x: ${pct(e.filter((x) => Math.abs(x) <= ln(2)).length, e.length).padStart(4)}  MAE(log)=${(e.reduce((t, x) => t + Math.abs(x), 0) / e.length).toFixed(3)}`);
    const groups: Array<[string, (r: Row) => boolean]> = [
      ["same_work n>=1", () => true],
      ["same_work n>=2", (r) => r.adjusted!.n >= 2],
      ["same_work n>=3", (r) => r.adjusted!.n >= 3],
      ["basis=shrunk (own fit)", (r) => r.adjusted!.basis === "shrunk"],
      ["basis=prior (neighbours)", (r) => r.adjusted!.basis === "prior"],
      ["basis=segment (market default)", (r) => r.adjusted!.basis === "segment"],
      ["adjustment moved comps >25%", (r) => r.adjusted!.medianAbsLogAdj > ln(1.25)],
      ["comp ATTRS ALL SAME as lot (control)", (r) => Object.keys(r.adjusted!.differingAttrs).length === 0],
    ];
    for (const [label, sel] of groups) {
      const g = adjRows.filter(sel);
      if (g.length < 5) { console.log(`  ${label}: n=${g.length} (too few)`); continue; }
      console.log(`  ${label} (n=${g.length})`);
      const err = (f: (r: Row) => number) => g.map((r) => ln(f(r) / r.hammer!));
      show("raw same-work hammer median", err((r) => r.adjusted!.medianRawHammer!));
      show("ADJUSTED same-work hammer median", err((r) => r.adjusted!.medianAdjHammer!));
      show(`catalogue midpoint x ${DRIFT}`, err((r) => mid(r) * DRIFT));
      show("geo blend (mid x drift, adjusted)", err((r) => Math.sqrt(mid(r) * DRIFT * r.adjusted!.medianAdjHammer!)));
      const rhoRaw = spearman(g.map((r) => ln(r.adjusted!.medianRawHammer! / mid(r))), g.map((r) => ln(r.hammer! / mid(r))));
      const rhoAdj = spearman(g.map((r) => ln(r.adjusted!.medianAdjHammer! / mid(r))), g.map((r) => ln(r.hammer! / mid(r))));
      console.log(`     Spearman(comp/mid, hammer/mid): raw ${isNaN(rhoRaw) ? "n/a" : rhoRaw.toFixed(3)}  adjusted ${isNaN(rhoAdj) ? "n/a" : rhoAdj.toFixed(3)}`);
    }
  }

  // sell-through as a second axis
  const st = all.filter((r) => r.sellThrough && r.sellThrough.sold + r.sellThrough.unsold >= 3);
  if (st.length) {
    console.log(`\n── Pre-sale sell-through of the same title (>=3 prior appearances) ──`);
    for (const [name, test] of [["prior sell-through < 50%", (x: number) => x < 0.5], ["prior sell-through >= 50%", (x: number) => x >= 0.5]] as const) {
      const g = st.filter((r) => test(r.sellThrough!.sold / (r.sellThrough!.sold + r.sellThrough!.unsold)));
      const unsold = g.filter((r) => !r.sold).length;
      console.log(`  ${name.padEnd(28)} n=${String(g.length).padStart(5)}  went unsold: ${pct(unsold, g.length)}`);
    }
  }
  console.log(`\nNB: comps are premium-inclusive GBP at the sale-date ECB rate, restricted to sales strictly before each lot's own sale date.`);
  console.log(`    Ratios of comps to HAMMER would read ~${f2(all[0]?.premiumRatio ?? 1.3)}x high by construction; they are not shown.\n`);
}

// ── main ──────────────────────────────────────────────────────────────────────
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function main() {
  if (SUMMARY_ONLY) {
    const rows = readFileSync(SUMMARY_ONLY, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
    summarize(rows);
    return;
  }
  let lots: Lot[] = [];
  if (SOURCE === "roseberys" || SOURCE === "both") lots.push(...loadRoseberys());
  if (SOURCE === "forum" || SOURCE === "both") lots.push(...loadForum());
  if (SOURCE === "bonhams") { const bh = loadBonhams(); for (const l of bh) BONHAMS_HOUSE.add(l.saleId); lots.push(...bh); }
  if (SALES) lots = lots.filter((l) => SALES.includes(l.saleId));
  if (!INCLUDE_QUALIFIED) lots = lots.filter((l) => l.qualifier === "certain");
  if (SOLD_ONLY) lots = lots.filter((l) => l.sold && l.hammer);
  lots = lots.filter((l) => l.artist && l.lowEst > 0);
  if (LIMIT && lots.length > LIMIT) {
    const rnd = mulberry32(SEED);
    for (let i = lots.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [lots[i], lots[j]] = [lots[j], lots[i]]; }
    lots = lots.slice(0, LIMIT);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const done = new Set<string>();
  const rows: Row[] = [];
  if (RESUME && existsSync(OUT)) {
    for (const l of readFileSync(OUT, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as Row; done.add(r.key); rows.push(r); }
    console.log(`resuming: ${done.size} lots already in ${OUT}`);
  } else if (existsSync(OUT)) {
    writeFileSync(OUT, "");
  }
  const todo = lots.filter((l) => !done.has(`${l.source}:${l.saleId}:${l.lotNumber}`));
  console.log(`${todo.length} lots to run (${lots.length} selected, ${SOURCE}${SALES ? " sales " + SALES.join(",") : ""}) -> ${OUT}`);

  let i = 0, n = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (i < todo.length) {
      const lot = todo[i++];
      const row = await processLot(lot);
      rows.push(row);
      appendFileSync(OUT, JSON.stringify(row) + "\n");
      if (++n % 100 === 0) console.log(`  …${n}/${todo.length}  ${((Date.now() - t0) / 1000 / n).toFixed(2)}s/lot`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`done: ${n} lots in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  summarize(rows);
}

main().then(() => closeDriver()).catch(async (e) => { console.error(e); await closeDriver(); process.exit(1); });
