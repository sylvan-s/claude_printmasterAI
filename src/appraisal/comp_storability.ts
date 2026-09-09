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

export function normalizePriceBasis(raw: unknown): CompPriceBasis {
  const v = text(raw).toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "hammer") return "hammer";
  if (v === "premium_inclusive") return "premium_inclusive";
  return "unknown";
}

export function assessComp(comp: Stage2bComp): CompAssessment {
  const reasons: string[] = [];

  const urlKey = isUsableUrl(comp.listingUrl);
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
