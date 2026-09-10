/**
 * queryAuctionComparables — realised auction prices from the ACKG, for Stage 3 valuation.
 *
 * ADR-0016. Stage 3 previously valued from `auctionComps` alone: free-text findings
 * written out by Stage 2b's web research. Those are unverifiable and frequently carry no
 * usable number at all (a real backtest artifact records a hammerPrice of
 * "Estimate £3,000–£3,500 (hammer price not publicly disclosed)"). The ACKG holds 39,916
 * dated, sold, GBP-normalised auction records — a real comparables corpus that Stage 3
 * was ignoring. This makes the graph the PRIMARY comps source and leaves web research as
 * the fallback for artists the graph does not cover.
 *
 * Two preconditions this depends on, both landed before this query was written:
 *   - `knowledge_graph/repair_bonhams_price_realised.py` — until 2026-09-08 every Bonhams
 *     and Skinner `priceRealised` was inflated by one whole hammer price (the adapter read
 *     `pricing.hammer_premium`, a premium-INCLUSIVE total, as if it were the premium
 *     amount). Bonhams+Skinner is ~all of the dated corpus, so wiring comps in before that
 *     repair would have fed a ~2x inflation straight into valuations.
 *   - `knowledge_graph/backfill_fx_gbp.py` — `priceRealisedGBP` converted at the SALE DATE
 *     from ECB daily rates. Without it, comps would have to be GBP-only, discarding the
 *     24,469 USD/EUR/CAD/AUD rows (~61% of the dated corpus).
 * Both are why this query reads `priceRealisedGBP` and never `priceRealised` directly.
 *
 * Tiering is EXACT-MATCH ONLY, never similarity. Tier 1 is "same ConceptualWork node",
 * which the caller has already resolved via queryAckgWorks; tier 2 is same artist + a
 * shared technique; tier 3 is same artist. This deliberately follows the project's
 * standing rule against fuzzy catalogue-identity matching — the two ACKG corruption
 * incidents that rule exists to prevent both came from similarity-based work merging, and
 * a mis-tiered comp here would silently anchor a valuation to the wrong print.
 *
 * Self-match exclusion is STRUCTURAL, not advisory. Roseberys and Forum lots are both in
 * the graph and in the backtest pool, so a backtest lot can match its own SourceRecord and
 * value itself from its own realised price. `excludeListingUrl` / `excludeSaleLot` filter
 * that in Cypher. This is strictly better than the free-text path, which could only ASK
 * the model to notice and discard its own source listing.
 */
import neo4j from "neo4j-driver";
import { getDriver, getDatabase } from "./client.js";
import { isLowInformationTitle } from "./title_normalize.js";
import { foldAccents, cypherFold, cypherFoldTrim, normalizeTitleKey, cypherNormalizeTitle } from "./unaccent.js";

export type ComparableTier = "same_work" | "same_artist_technique" | "same_artist";

export interface AuctionComparable {
  tier: ComparableTier;
  institutionName: string | null;
  saleDate: string | null;
  saleId: string | null;
  lotNumber: number | null;
  workTitle: string | null;
  techniques: string[];
  editionSize: number | null;
  priceRealisedGBP: number;
  priceCurrency: string | null;
  priceRealisedNative: number | null;
  fxRateDate: string | null;
  estimateLowGBP: number | null;
  estimateHighGBP: number | null;
  listingUrl: string | null;
}

export interface ComparablesSummary {
  count: number;
  tierCounts: Record<ComparableTier, number>;
  medianGBP: number | null;
  minGBP: number | null;
  maxGBP: number | null;
  earliestSale: string | null;
  latestSale: string | null;
}

export interface ComparablesResult {
  comparables: AuctionComparable[];
  summary: ComparablesSummary;
  coverageNote: string;
}

export interface ComparablesParams {
  artistName: string;
  /** ACKG ConceptualWork id, when the caller resolved one. Strongest tier-1 signal. */
  conceptualWorkId?: string | null;
  /**
   * Identified work title. Falls back to tier 1 by EXACT (case/whitespace-insensitive)
   * title match within the same artist when no conceptualWorkId is available. Ignored when
   * the title carries no identifying information ("Untitled", "Plate 4"), which would
   * otherwise collapse every untitled print by the artist into one bogus same-work set.
   */
  workTitle?: string | null;
  /** Technique name for tier 2; matched case-insensitively against the impression's techniques. */
  technique?: string | null;
  /** ISO date lower bound, e.g. "2015-01-01". Older sales are poor comps for print prices. */
  sinceDate?: string | null;
  /** Backtest circularity guard — drop the listing this input came from. */
  excludeListingUrl?: string | null;
  /** Backtest circularity guard — drop a specific sale/lot pair. */
  excludeSaleLot?: { saleId: string; lotNumber: number } | null;
  limit?: number;
}

const QUERY = `
MATCH (a:Artist)
WHERE ${cypherFold("a.name")} = $artistName
MATCH (a)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(imp:Impression)
MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp)
WHERE src.sourceType = 'auction'
  AND src.sold = true
  AND src.priceRealisedGBP IS NOT NULL
  AND src.priceRealisedGBP > 0
  AND src.saleDate IS NOT NULL
  AND ($sinceDate IS NULL OR src.saleDate >= $sinceDate)
  AND ($excludeListingUrl IS NULL OR src.listingUrl IS NULL OR src.listingUrl <> $excludeListingUrl)
  AND ($excludeSaleId IS NULL OR NOT (src.saleId = $excludeSaleId AND src.lotNumber = $excludeLotNumber))
OPTIONAL MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
WITH cw, src, er, collect(DISTINCT t.name) AS techniques
// Tier must be decided HERE, not after LIMIT. Ordering by saleDate alone and tiering in
// TS would let a tier-1 same-work comp fall outside the LIMIT window whenever the artist
// has enough recent sales — silently discarding the single most relevant comparable.
WITH cw, src, er, techniques,
     CASE
       WHEN $conceptualWorkId IS NOT NULL AND cw.id = $conceptualWorkId THEN 0
       WHEN $workTitle IS NOT NULL
            AND ${cypherNormalizeTitle("cw.name")} = $workTitle THEN 0
       WHEN $technique IS NOT NULL
            AND any(x IN techniques WHERE ${cypherFold("x")} CONTAINS $technique) THEN 1
       ELSE 2
     END AS tierRank
// One row per SourceRecord, keeping its STRONGEST tier. Without this the match fans out:
// a SourceRecord whose Impression is reachable by more than one ConceptualWork/EditionRun
// path is emitted once per path, so a single real sale is counted as several comparables
// and drags the median toward whichever lots happen to be duplicated. Measured at ~4%
// excess rows (120 rows for 115 distinct records on one artist) before this collapse.
ORDER BY tierRank ASC
WITH src, collect({
       tierRank: tierRank, workId: cw.id, workTitle: cw.name,
       editionSize: er.editionSize, techniques: techniques
     })[0] AS best
ORDER BY best.tierRank ASC, src.saleDate DESC
LIMIT $limit
RETURN best.tierRank AS tierRank,
       best.workId AS workId,
       best.workTitle AS workTitle,
       src.institutionName AS institutionName,
       src.saleDate AS saleDate,
       src.saleId AS saleId,
       src.lotNumber AS lotNumber,
       src.priceRealisedGBP AS priceRealisedGBP,
       src.priceCurrency AS priceCurrency,
       src.priceRealised AS priceRealisedNative,
       src.fxRateDate AS fxRateDate,
       src.estimateLowGBP AS estimateLowGBP,
       src.estimateHighGBP AS estimateHighGBP,
       src.listingUrl AS listingUrl,
       best.editionSize AS editionSize,
       best.techniques AS techniques
`;

function num(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "object" && "toNumber" in (value as any)) return (value as any).toNumber();
  return typeof value === "number" ? value : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pull structured exclusion keys out of `AppraisalInput.testingExcludeSourceListing`.
 *
 * That field is PROSE, not a URL — the backtest harnesses build it as
 * `Roseberys, sale A0777, lot 42 (https://www.roseberys.co.uk/bidding/...)` so Stage 3's
 * model-facing note can name the sale in readable form. Passing it straight into an
 * exact-equality URL comparison silently matches nothing, which is how the first cut of
 * this guard shipped inert. It went unnoticed because Roseberys had no `saleDate` and was
 * therefore excluded from comps anyway; once the sale dates were backfilled, the same
 * inert guard became a live self-match hole — the backtest pool IS Roseberys lots.
 *
 * Both keys are returned and both are applied: the URL is exact but format-fragile, while
 * sale code + lot number survives any URL-shape change. Free text that yields neither is
 * not an error — it just means only the model-facing instruction applies, as before.
 */
export function parseExcludedListing(raw: string | null | undefined): {
  listingUrl: string | null;
  saleLot: { saleId: string; lotNumber: number } | null;
} {
  if (!raw) return { listingUrl: null, saleLot: null };
  const urlMatch = raw.match(/https?:\/\/[^\s)<>"']+/);
  const listingUrl = urlMatch ? urlMatch[0].replace(/[.,;]+$/, "") : null;
  const saleLotMatch = raw.match(/\bsale\s+([A-Za-z0-9_-]+)\s*,\s*lot\s+(\d+)\b/i);
  const saleLot = saleLotMatch
    ? { saleId: saleLotMatch[1], lotNumber: Number(saleLotMatch[2]) }
    : null;
  return { listingUrl, saleLot };
}

export async function queryAuctionComparables(params: ComparablesParams): Promise<ComparablesResult> {
  const driver = getDriver();
  const session = driver.session({ database: getDatabase() });
  const limit = params.limit ?? 60;
  const rawTitle = params.workTitle?.trim() || null;
  const titleForExactMatch = rawTitle && !isLowInformationTitle(rawTitle) ? rawTitle : null;
  try {
    const res = await session.run(QUERY, {
      // Accent-folded to match the folded properties in QUERY — an unfolded "Peintre et
      // Modele" never reached tier 0 against the graph's "Peintre et Modèle". See unaccent.ts.
      artistName: foldAccents(params.artistName),
      conceptualWorkId: params.conceptualWorkId ?? null,
      // Normalised, not merely accent-folded: 29.9% of works are variant-titled duplicates
      // of another work by the same artist, so an accent-only fold still misses most of a
      // work's own sales at tier 1. See TITLE_PUNCTUATION.
      workTitle: titleForExactMatch ? normalizeTitleKey(titleForExactMatch) : null,
      technique: params.technique?.trim() ? foldAccents(params.technique.trim()) : null,
      sinceDate: params.sinceDate ?? null,
      excludeListingUrl: params.excludeListingUrl ?? null,
      excludeSaleId: params.excludeSaleLot?.saleId ?? null,
      excludeLotNumber: params.excludeSaleLot ? neo4j.int(params.excludeSaleLot.lotNumber) : null,
      limit: neo4j.int(limit),
    });

    // Single source of truth for tiering: the rank Cypher already applied to the LIMIT.
    const TIERS: ComparableTier[] = ["same_work", "same_artist_technique", "same_artist"];
    const comparables: AuctionComparable[] = res.records.map((r) => {
      const techniques = (r.get("techniques") as unknown[]).filter(Boolean).map(String);
      const tier = TIERS[num(r.get("tierRank")) ?? 2] ?? "same_artist";
      return {
        tier,
        institutionName: r.get("institutionName") ?? null,
        saleDate: r.get("saleDate") ?? null,
        saleId: r.get("saleId") ?? null,
        lotNumber: num(r.get("lotNumber")),
        workTitle: r.get("workTitle") ?? null,
        techniques,
        editionSize: num(r.get("editionSize")),
        priceRealisedGBP: num(r.get("priceRealisedGBP")) as number,
        priceCurrency: r.get("priceCurrency") ?? null,
        priceRealisedNative: num(r.get("priceRealisedNative")),
        fxRateDate: r.get("fxRateDate") ?? null,
        estimateLowGBP: num(r.get("estimateLowGBP")),
        estimateHighGBP: num(r.get("estimateHighGBP")),
        listingUrl: r.get("listingUrl") ?? null,
      };
    });

    const prices = comparables.map((c) => c.priceRealisedGBP);
    const dates = comparables.map((c) => c.saleDate).filter(Boolean) as string[];
    const tierCounts: Record<ComparableTier, number> = {
      same_work: 0, same_artist_technique: 0, same_artist: 0,
    };
    for (const c of comparables) tierCounts[c.tier] += 1;

    return {
      comparables,
      summary: {
        count: comparables.length,
        tierCounts,
        medianGBP: median(prices),
        minGBP: prices.length ? Math.min(...prices) : null,
        maxGBP: prices.length ? Math.max(...prices) : null,
        earliestSale: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        latestSale: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
      },
      coverageNote:
        "ACKG dated auction coverage is Bonhams (2003-2026, 38,663 sold lots), Roseberys London " +
        "(2014-2026, 8,164) and Skinner (2022-2026, 1,251). Forum Auctions is excluded: its " +
        "records carry neither a saleDate nor a realised price. An absent or thin comp set " +
        "reflects that coverage gap, not evidence that the artist's work is unsaleable or " +
        "worthless. All prices are premium-inclusive realised prices converted to GBP at the " +
        "sale-date ECB rate.",
    };
  } finally {
    await session.close();
  }
}
