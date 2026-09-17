/**
 * Stage 3a comparables: at most FIVE realised sales, chosen in tiers (user direction 2026-09-17).
 *
 *   1. same_work              same artist, same technique, same ConceptualWork; nearest sale date first
 *   2. same_artist_technique  same artist, same technique, other works, ranked by CLIP image similarity
 *                             to the lot (at or above CLIP_FLOOR), then by sale date
 *   3. same_artist            SIMILAR ARTISTS (the pricing model's neighbours for this artist), same
 *                             technique, ranked by CLIP similarity (at or above CLIP_FLOOR), then date
 *
 * A later tier only fills the slots the earlier tiers left. Every comp is a sold, hammer-priced auction
 * record in the 10-year window before the valuation date, in the lot's attribution class (the artist's
 * own work for a direct lot, "after" lots for an "after" lot). Comps are not adjusted for attributes;
 * technique is a filter. The blend still re-bases each comp to the target house and the valuation year.
 *
 * CLIP similarity is Neo4j's vector.similarity.cosine, which reports (1 + cos) / 2. On 400 Hockney
 * images (2026-09-17) different works by the artist sit at median 0.844 (p90 0.892) and repeat sales of
 * the same work at median 0.975 (p10 0.94), so the floor 0.88 keeps roughly the closest 10-15% of other
 * works. With no lot vector (embedding service down, no image) tiers 2 and 3 fall back to nearest date.
 *
 * The same_artist tier key is reused for similar artists so the blend's witness slots and calibration
 * keys stay as fitted; the evidence item carries `artist` so the chart and report can name them.
 */
import neo4j from "neo4j-driver";
import { getDriver, getDatabase } from "./client.js";
import { primaryProcess } from "./price_attrs.js";
import { NON_DIRECT_URL_RE, type AuctionComparable, type ComparablesResult, type ComparableTier } from "./query_comparables.js";

export const MAX_COMPS = 5;
export const CLIP_FLOOR = 0.88;
export const NEIGHBOUR_ARTISTS = 10;

export interface SelectCompsInput {
  artist: string;
  workIds: string[];
  /** The lot's technique class (price_attrs.primaryProcess); "other"/null: technique not filtered. */
  process: string | null;
  /** The lot image's CLIP vector (Stage 1d), or null. */
  clipVector: number[] | null;
  /** Similar artists, strongest first (ArtistPriceProfile.neighbours). */
  neighbours: string[];
  sinceDate: string;
  untilDate: string;
  attribution: "direct" | "after";
  excludeSaleLot?: { saleId: string; lotNumber: number } | null;
  excludeListingUrl?: string | null;
  max?: number;
  clipFloor?: number;
}

export interface SelectedComp extends AuctionComparable {
  artist: string;
  clipSimilarity: number | null;
}

const QUERY = `
MATCH (a:Artist) WHERE a.name IN $artists
MATCH (a)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(imp:Impression)<-[:DOCUMENTS]-(src:SourceRecord)
WHERE src.sourceType = 'auction' AND src.sold = true AND src.hammerPriceGBP > 0 AND src.saleDate IS NOT NULL
  AND substring(src.saleDate, 0, 10) >= $since AND substring(src.saleDate, 0, 10) < $until
  AND ($onlyWorks IS NULL OR cw.id IN $onlyWorks)
  AND ($skipWorks IS NULL OR NOT cw.id IN $skipWorks)
  AND ($excludeLotSaleId IS NULL OR NOT (src.saleId = $excludeLotSaleId AND src.lotNumber = $excludeLotNumber))
  AND ($excludeListingUrl IS NULL OR src.listingUrl IS NULL OR src.listingUrl <> $excludeListingUrl)
OPTIONAL MATCH (src)-[att:ATTRIBUTED_TO]->(a)
WITH a, cw, er, imp, src, collect(att.qualifier) AS qs
WITH a, cw, er, imp, src,
     any(q IN qs WHERE q IS NOT NULL AND q <> 'direct') OR (all(q IN qs WHERE q IS NULL) AND coalesce(src.listingUrl, '') =~ $nonDirectUrlRe) AS nonDirect
WHERE ($attribution = 'direct' AND NOT nonDirect) OR ($attribution = 'after' AND nonDirect)
OPTIONAL MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (img:DigitalImage)-[:SHOWS]->(imp)
WITH a, cw, er, imp, src, collect(DISTINCT t.name) AS techniques,
     max(CASE WHEN $vec IS NULL OR img.clipImageEmbedding IS NULL THEN null ELSE vector.similarity.cosine(img.clipImageEmbedding, $vec) END) AS clipSim
RETURN src.id AS id, a.name AS artist, cw.id AS workId, cw.name AS workTitle, src.institutionName AS institutionName,
       src.saleDate AS saleDate, src.saleId AS saleId, src.lotNumber AS lotNumber,
       src.priceRealisedGBP AS priceRealisedGBP, src.hammerPriceGBP AS hammerPriceGBP, src.priceCurrency AS priceCurrency,
       src.priceRealised AS priceRealisedNative, src.fxRateDate AS fxRateDate,
       src.estimateLowGBP AS estimateLowGBP, src.estimateHighGBP AS estimateHighGBP, src.listingUrl AS listingUrl,
       coalesce(er.declaredSize, er.editionSize) AS editionSize, imp.signed AS signed, techniques, imp.rawMedium AS rawMedium,
       imp.copyType AS copyType, imp.plateDimensions AS plateDimensions, imp.imageDimensions AS imageDimensions,
       imp.sheetDimensions AS sheetDimensions, clipSim
`;

const num = (v: unknown): number | null => (v == null ? null : typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : typeof v === "number" ? v : null);

async function candidates(input: SelectCompsInput, artists: string[], only: string[] | null, skip: string[] | null, tier: ComparableTier): Promise<SelectedComp[]> {
  if (!artists.length) return [];
  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(QUERY, {
      artists, since: input.sinceDate.slice(0, 10), until: input.untilDate.slice(0, 10), onlyWorks: only, skipWorks: skip,
      excludeLotSaleId: input.excludeSaleLot?.saleId ?? null, excludeLotNumber: input.excludeSaleLot ? neo4j.int(input.excludeSaleLot.lotNumber) : null,
      excludeListingUrl: input.excludeListingUrl ?? null, attribution: input.attribution, nonDirectUrlRe: NON_DIRECT_URL_RE, vec: input.clipVector,
    });
    const seen = new Set<string>();
    const out: SelectedComp[] = [];
    for (const r of res.records) {
      const id = String(r.get("id"));
      if (seen.has(id)) continue;
      seen.add(id);
      const techniques = ((r.get("techniques") as unknown[]) ?? []).filter(Boolean).map(String);
      const rawMedium = (r.get("rawMedium") as string) ?? null;
      if (input.process && input.process !== "other" && primaryProcess([...techniques, rawMedium]) !== input.process) continue;
      out.push({
        tier, artist: String(r.get("artist")), institutionName: r.get("institutionName") ?? null, saleDate: r.get("saleDate") ?? null,
        saleId: r.get("saleId") ?? null, lotNumber: num(r.get("lotNumber")), workTitle: r.get("workTitle") ?? null, techniques,
        editionSize: num(r.get("editionSize")), signed: typeof r.get("signed") === "boolean" ? (r.get("signed") as boolean) : null,
        rawMedium, copyType: r.get("copyType") ?? null, plateDimensions: r.get("plateDimensions") ?? null,
        imageDimensions: r.get("imageDimensions") ?? null, sheetDimensions: r.get("sheetDimensions") ?? null,
        priceRealisedGBP: num(r.get("priceRealisedGBP")), hammerPriceGBP: num(r.get("hammerPriceGBP")), priceCurrency: r.get("priceCurrency") ?? null,
        priceRealisedNative: num(r.get("priceRealisedNative")), fxRateDate: r.get("fxRateDate") ?? null,
        estimateLowGBP: num(r.get("estimateLowGBP")), estimateHighGBP: num(r.get("estimateHighGBP")), listingUrl: r.get("listingUrl") ?? null,
        nonDirect: input.attribution === "after", clipSimilarity: num(r.get("clipSim")),
      } as SelectedComp);
    }
    return out;
  } finally {
    await session.close();
  }
}

const byDateDesc = (a: SelectedComp, b: SelectedComp) => String(b.saleDate ?? "").localeCompare(String(a.saleDate ?? ""));

/** Pure: rank a tier's candidates. With a lot vector: at or above the floor, most similar first; without: nearest date. */
export function rankSimilar(cs: SelectedComp[], hasVector: boolean, floor = CLIP_FLOOR): SelectedComp[] {
  if (!hasVector) return [...cs].sort(byDateDesc);
  return cs.filter((c) => c.clipSimilarity != null && c.clipSimilarity >= floor)
    .sort((a, b) => (b.clipSimilarity! - a.clipSimilarity!) || byDateDesc(a, b));
}

/** Up to five tiered comparables for one lot. Throws on a graph error (the caller records a warning). */
export async function selectComparables(input: SelectCompsInput): Promise<ComparablesResult & { comparables: SelectedComp[] }> {
  const max = input.max ?? MAX_COMPS;
  const floor = input.clipFloor ?? CLIP_FLOOR;
  const hasVector = !!input.clipVector?.length;
  const picked: SelectedComp[] = [];
  const notes: string[] = [];
  if (input.workIds.length) {
    const same = (await candidates(input, [input.artist], input.workIds, null, "same_work")).sort(byDateDesc);
    picked.push(...same.slice(0, max));
    notes.push(`${same.length} same-work sale${same.length === 1 ? "" : "s"}`);
  }
  if (picked.length < max) {
    const own = rankSimilar(await candidates(input, [input.artist], null, input.workIds.length ? input.workIds : null, "same_artist_technique"), hasVector, floor);
    picked.push(...own.slice(0, max - picked.length));
    notes.push(`${own.length} same-artist ${hasVector ? `CLIP >= ${floor}` : "(no image vector: by date)"}`);
  }
  if (picked.length < max && input.neighbours.length) {
    const pool = input.neighbours.filter((n) => n !== input.artist).slice(0, NEIGHBOUR_ARTISTS);
    const sim = rankSimilar(await candidates(input, pool, null, null, "same_artist"), hasVector, floor);
    picked.push(...sim.slice(0, max - picked.length));
    notes.push(`${sim.length} similar-artist ${hasVector ? `CLIP >= ${floor}` : "(by date)"}`);
  }
  const hammers = picked.map((c) => c.hammerPriceGBP).filter((h): h is number => h != null && h > 0).sort((a, b) => a - b);
  const prices = picked.map((c) => c.priceRealisedGBP).filter((h): h is number => h != null && h > 0);
  const tierCounts: Record<ComparableTier, number> = { same_work: 0, same_artist_technique: 0, same_artist: 0 };
  for (const c of picked) tierCounts[c.tier]++;
  const dates = picked.map((c) => c.saleDate).filter(Boolean).sort() as string[];
  const mid = (xs: number[]) => (xs.length ? (xs.length % 2 ? xs[xs.length >> 1] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : null);
  return {
    comparables: picked,
    summary: {
      count: picked.length, tierCounts, medianGBP: mid([...prices].sort((a, b) => a - b)), medianHammerGBP: mid(hammers),
      medianSameWorkHammerGBP: mid(picked.filter((c) => c.tier === "same_work").map((c) => c.hammerPriceGBP!).filter((h) => h > 0).sort((a, b) => a - b)),
      minGBP: hammers[0] ?? null, maxGBP: hammers[hammers.length - 1] ?? null, earliestSale: dates[0] ?? null, latestSale: dates[dates.length - 1] ?? null,
    },
    coverageNote: `${picked.length} of ${max} comps (${notes.join("; ")})`,
  };
}
