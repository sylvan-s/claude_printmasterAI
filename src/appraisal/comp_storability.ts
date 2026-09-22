/**
 * Is a Stage 2b web-research comp good enough to write back to the ACKG?
 *
 * This is the measuring instrument for Phase 0 of the comps write-back, and it is
 * deliberately only that. Nothing here writes anything. The question Phase 0 exists to
 * answer is empirical and currently unanswered: when Stage 2b is ASKED for a listing URL,
 * a numeric price and an explicit price basis, how often does it actually come back with
 * them? If the answer is "rarely", the rest of the write-back is not worth building, and
 * that is a cheaper thing to discover here than after designing a dedupe strategy.
 *
 * Three independent gates, because a comp fails in different ways and the mix matters:
 *
 *   KEY    — can this comp be identified again later? `listingUrl`, or failing that
 *            auctionHouse + saleId + lotNumber. Without one, a comp cannot be
 *            de-duplicated against the 39,914 auction SourceRecords already in the graph
 *            except by similarity, and similarity matching on catalogue identity has
 *            caused two confirmed ACKG corruption incidents. No key, no write.
 *   PRICE  — is there an actual number and a currency? Free-text prices frequently are not
 *            prices: ADR-0016 records a real `hammerPrice` of "Estimate £3,000-£3,500
 *            (hammer price not publicly disclosed)".
 *   BASIS  — is the number hammer or premium-inclusive? This is the gate that matters most
 *            and the one most likely to fail. Most house result pages show a
 *            premium-inclusive figure without labelling it, so a model filling the field
 *            from the figure alone will guess. Guessing "hammer" understates every
 *            valuation built on the comp by the buyer's premium — roughly 25-30%. That is
 *            exactly the class of error `repair_bonhams_price_realised.py` had to correct
 *            across 39,914 rows, and an unlabelled comp reintroduces it one row at a time,
 *            unrepairable because nothing records which rows were guesses.
 *
 * `unknown` is therefore a PASS for honesty and a FAIL for storability, and the two are
 * counted separately: a high `unknown` rate means the prompt is working and the sources
 * are silent, which is a different conclusion from a high `hammer` rate that cannot be
 * trusted.
 */

/** What a comp's price number represents. Anything else is treated as "unknown". */
export type CompPriceBasis = "hammer" | "premium_inclusive" | "unknown";

export interface Stage2bComp {
  artworkTitle?: string | null;
  artist?: string | null;
  technique?: string | null;
  hammerPrice?: string | null;
  saleDate?: string | null;
  auctionHouse?: string | null;
  conditionState?: string | null;
  listingUrl?: string | null;
  saleId?: string | null;
  lotNumber?: string | null;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  priceBasis?: CompPriceBasis | string | null;
  wasSoldInBroaderLot?: boolean | null;
  broaderLotPriceAdjustment?: string | null;
}

export interface CompAssessment {
  /** Passes all three gates — the only comps a future Phase 1 would write. */
  storable: boolean;
  hasKey: boolean;
  keyKind: "listing_url" | "house_sale_lot" | "none";
  hasNumericPrice: boolean;
  hasCurrency: boolean;
  basis: CompPriceBasis;
  hasDeterminateBasis: boolean;
  /** Why it failed, in the order the gates are described above. Empty when storable. */
  reasons: string[];
}

export interface CompStorabilityReport {
  total: number;
  storable: number;
  withKey: number;
  withNumericPrice: number;
  withDeterminateBasis: number;
  /** Split of priceBasis across all comps — an honest "unknown" is not the same failure
   *  as a suspicious "hammer", so they are never collapsed into one number. */
  basisCounts: Record<CompPriceBasis, number>;
  reasonCounts: Record<string, number>;
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** http(s) only. A bare domain or a "search Bonhams for..." instruction is not a key. */
function isUsableUrl(raw: unknown): boolean {
  const v = text(raw);
  if (!v) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * CITATION-URL-1.0. Can a comp's URL show THIS sale? A link to an artist overview, a search, or
 * a site's home page cannot: it exists, but the price is not on it. Found in the first Artsy A/B
 * (2026-09-22): lot 389 cited artsy.net/artist/cindy-sherman for a GBP 2,000 Roseberys price and
 * passed, because the check only asked whether a URL existed. Such a comp is treated as uncited.
 *
 * Deliberately a list of known non-result shapes rather than a whitelist of result shapes: an
 * unfamiliar house's lot page must still count, and escalating on every site this list does not
 * know would make the gate fire on honest research.
 */
export function isSpecificResultUrl(raw: unknown): boolean {
  if (!isUsableUrl(raw)) return false;
  const u = new URL(String(raw).trim());
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  const segs = path.split("/").filter(Boolean);
  if (!segs.length) return false;                                   // a home page
  if (/(^|\/)search(\/|$)/.test(path) || ["q", "query", "keyword", "keywords", "search"].some((k) => u.searchParams.has(k))) return false;
  if (/(^|\.)(google|bing|duckduckgo)\./.test(host)) return false;
  if (host.endsWith("artsy.net")) return segs[0] === "auction-result" || segs[0] === "artwork" || (segs[0] === "auction" && segs.includes("artwork"));
  if (host.endsWith("mutualart.com")) return segs[0] === "artwork";
  if (host.endsWith("artnet.com") && segs[0] === "artists") {
    // /artists/<name>, /artists/<name>/past-auction-results, /artists/<name>/biography
    return segs.length >= 3 && !["past-auction-results", "auction-results", "biography", "artworks-for-sale"].includes(segs[2]);
  }
  if (host.endsWith("invaluable.com") && segs[0] === "artist") return false;
  if (host.endsWith("wikipedia.org")) return false;
  return true;
}


export function normalizePriceBasis(raw: unknown): CompPriceBasis {
  const v = text(raw).toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "hammer") return "hammer";
  if (v === "premium_inclusive") return "premium_inclusive";
  return "unknown";
}

export function assessComp(comp: Stage2bComp): CompAssessment {
  const reasons: string[] = [];

  // An artist overview or search page is a URL but not a key: it cannot identify this sale.
  const urlKey = isSpecificResultUrl(comp.listingUrl);
  // A sale id and a lot number only identify a sale alongside the house that ran it.
  const tripleKey = !!text(comp.auctionHouse) && !!text(comp.saleId) && !!text(comp.lotNumber);
  const keyKind = urlKey ? "listing_url" : tripleKey ? "house_sale_lot" : "none";
  if (keyKind === "none") reasons.push("no_key");

  // Number-typed and finite and positive: a model that echoes "£5,245.51" into a numeric
  // field yields a string or NaN, and a 0 is not a realised price.
  const hasNumericPrice = typeof comp.priceAmount === "number" && Number.isFinite(comp.priceAmount) && comp.priceAmount > 0;
  if (!hasNumericPrice) reasons.push("no_numeric_price");

  const hasCurrency = ISO_CURRENCY.test(text(comp.priceCurrency).toUpperCase());
  if (!hasCurrency) reasons.push("no_iso_currency");

  const basis = normalizePriceBasis(comp.priceBasis);
  const hasDeterminateBasis = basis !== "unknown";
  if (!hasDeterminateBasis) reasons.push("basis_unknown");

  return {
    storable: keyKind !== "none" && hasNumericPrice && hasCurrency && hasDeterminateBasis,
    hasKey: keyKind !== "none",
    keyKind,
    hasNumericPrice,
    hasCurrency,
    basis,
    hasDeterminateBasis,
    reasons,
  };
}

/**
 * Split Stage 2b's comps into the ones Stage 3 may see and the ones it may not.
 *
 * The specialist prompt already states the rule — "Every figure you take from here must be
 * attributable to one of the returned URLs; a price you cannot point at a URL for is not a
 * verified comparable" — and until now nothing enforced it at the valuation boundary. The
 * write-back gates on a citation, so an uncited comp could never reach the graph, but it
 * reached Stage 3's prompt unchallenged. Measured 2026-09-14 while comparing Stage 2b models:
 * Haiku returned three comps with no URL and no stated basis, naming Cindy Sherman's most
 * famous series at small-print prices, and on a re-run produced the same GBP 1,875 against a
 * different title. Those numbers were generated, not retrieved, and the only thing standing
 * between them and a valuation was luck.
 *
 * The gate is the CITATION alone, deliberately. Price basis is the write-back's concern
 * (a stored price in the wrong field is unrepairable); for reading, a cited comp with an
 * unstated basis is still real evidence and Stage 3 is told to treat the basis as unknown.
 * Over-filtering here would discard findings that are true.
 *
 * The dropped count is returned rather than swallowed, because a stage that found five figures
 * and could cite two is telling you something about the quality of that research, and Stage 3
 * should be able to see it.
 */
export function partitionCitedComps(comps: unknown): { cited: Stage2bComp[]; uncited: Stage2bComp[] } {
  if (!Array.isArray(comps)) return { cited: [], uncited: [] };
  const cited: Stage2bComp[] = [], uncited: Stage2bComp[] = [];
  for (const c of comps as Stage2bComp[]) (isSpecificResultUrl(c?.listingUrl) ? cited : uncited).push(c);
  return { cited, uncited };
}

/** One line naming what was withheld and why, for the Stage 3 prompt and the run log. */
export function describeUncitedComps(uncited: Stage2bComp[]): string {
  if (!uncited.length) return "";
  const named = uncited
    .map((c) => `"${text(c.artworkTitle) || "untitled"}"${text(c.auctionHouse) ? ` (${text(c.auctionHouse)})` : ""}${typeof c.priceAmount === "number" ? ` at ${c.priceAmount}` : ""}`)
    .slice(0, 6)
    .join(", ");
  return `${uncited.length} further web finding(s) were WITHHELD from you because they carry no URL that shows the sale: ${named}. ` +
    `A price with no page behind it is not a comparable, and a research step that produces several of them is itself a signal that its findings are thin — weigh the rest accordingly.`;
}

/**
 * The fields needed to recognise a sale, whatever shape the caller's comp type is.
 *
 * The house arrives under two different names: ACKG comparables carry `institutionName`,
 * Stage 2b's comps carry `auctionHouse`. Reading only one silently produced URL-only matching
 * and let through every duplicate whose graph record had no listing URL.
 */
export interface SaleIdentity {
  institutionName?: string | null;
  auctionHouse?: string | null;
  saleId?: string | null;
  lotNumber?: number | string | null;
  listingUrl?: string | null;
}

const houseKey = (v: unknown) => text(v).toLowerCase().replace(/[^a-z]/g, "");
const urlKey = (v: unknown) => {
  const s = text(v);
  if (!s) return "";
  try { const u = new URL(s); return `${u.hostname.replace(/^www\./i, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase(); }
  catch { return ""; }
};
/** Sale ids and lot numbers arrive as strings from a model and as numbers from the graph.
 *  `text()` returns "" for a number, so reading them through it silently dropped every
 *  graph-side key and left the match URL-only. */
const idText = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

function saleKeys(c: SaleIdentity): string[] {
  const out: string[] = [];
  const u = urlKey(c.listingUrl);
  if (u) out.push(`u:${u}`);
  const h = houseKey(c.institutionName ?? c.auctionHouse), s = idText(c.saleId), l = idText(c.lotNumber);
  if (h && s && l) out.push(`k:${h}|${s}|${l}`);
  return out;
}

/**
 * Drop web findings that are the SAME SALE as a graph comparable already in the prompt.
 *
 * Stage 3 receives two comp blocks: the ACKG's structured records, which it is told to anchor
 * on, and Stage 2b's web findings, which it is told to use "to corroborate". Measured across 24
 * stored lots: 80 of 106 web comps (75%) were the same sale as an ACKG comp in the SAME prompt,
 * and on many lots every single one was — 4/4, 5/5, 7/7. The graph holds 38,663 sold Bonhams
 * lots, so for a well-covered artist any Bonhams page the web surfaces is already ingested.
 *
 * A duplicate is worse than redundant here. The model cannot tell the two entries are one sale,
 * the prompt invites it to read the second as corroboration of the first, and the web copy is
 * usually premium-inclusive where the ACKG copy is hammer — so one sale arrives as two
 * independent data points on two different price bases. Anchoring is exactly what that breaks.
 *
 * Matched on the listing URL, or on house + sale + lot together. A house and a lot number
 * without a sale identify nothing, and are left alone rather than guessed at.
 */
export function dropWebCompsAlreadyInGraph<T extends SaleIdentity>(
  webComps: T[], graphComps: SaleIdentity[],
): { kept: T[]; duplicates: T[] } {
  if (!webComps.length || !graphComps.length) return { kept: webComps, duplicates: [] };
  const seen = new Set(graphComps.flatMap(saleKeys));
  if (!seen.size) return { kept: webComps, duplicates: [] };
  const kept: T[] = [], duplicates: T[] = [];
  for (const c of webComps) (saleKeys(c).some((k) => seen.has(k)) ? duplicates : kept).push(c);
  return { kept, duplicates };
}

export function assessComps(comps: unknown): CompStorabilityReport {
  const list: Stage2bComp[] = Array.isArray(comps) ? comps : [];
  const report: CompStorabilityReport = {
    total: list.length,
    storable: 0,
    withKey: 0,
    withNumericPrice: 0,
    withDeterminateBasis: 0,
    basisCounts: { hammer: 0, premium_inclusive: 0, unknown: 0 },
    reasonCounts: {},
  };
  for (const c of list) {
    const a = assessComp(c ?? {});
    if (a.storable) report.storable++;
    if (a.hasKey) report.withKey++;
    if (a.hasNumericPrice) report.withNumericPrice++;
    if (a.hasDeterminateBasis) report.withDeterminateBasis++;
    report.basisCounts[a.basis]++;
    for (const r of a.reasons) report.reasonCounts[r] = (report.reasonCounts[r] ?? 0) + 1;
  }
  return report;
}

/** One log line per lot. Aggregated across a run, this is the Phase 0 measurement. */
export function formatCompStorability(r: CompStorabilityReport): string {
  if (r.total === 0) return "0 comps";
  const pct = (n: number) => `${Math.round((100 * n) / r.total)}%`;
  const reasons = Object.entries(r.reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return (
    `${r.storable}/${r.total} storable (${pct(r.storable)}) | ` +
    `key ${pct(r.withKey)} price ${pct(r.withNumericPrice)} basis ${pct(r.withDeterminateBasis)} | ` +
    `basis hammer=${r.basisCounts.hammer} premium=${r.basisCounts.premium_inclusive} unknown=${r.basisCounts.unknown}` +
    (reasons ? ` | ${reasons}` : "")
  );
}
