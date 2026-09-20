/**
 * Same-suite comparables (adopted 2026-09-16): earlier sales of OTHER works by the same artist that
 * are documented by the SAME CatalogueEntry — exact catalogue prefix + number, no title similarity.
 * Typically the other plates of a book or suite catalogued as one entry (Braque's Le Tir à l'arc,
 * Vallier 153), or an unmerged duplicate node of the same print.
 *
 * Generic numbering prefixes are excluded ("No.", "Nr.", "Cat.", "#", page/plate/figure markers,
 * and "P.", which is Tamayo's Pereda but far more often a page): a number under them does not
 * name a catalogue, so works sharing it are not a suite. CatalogueEntry nodes are shared across
 * artists ("P. 109" documents a Tamayo and a Beham), so siblings are always scoped to the artist.
 *
 * Read-only. The lot's entries: those documenting its own resolved works, plus any whose folded
 * prefix + number equals a citation the lot prints (foldPrefix, as work identity matches citations).
 */
import type { Session } from "neo4j-driver";
import { NON_DIRECT_URL_RE } from "./query_comparables.js";
import { getDriver, getDatabase } from "./client.js";
import { citationsInRefs, citationsInTitle, foldPrefix } from "./work_identity.js";

/** Folded prefixes (foldPrefix) that are numbering words, not catalogue names. */
export const GENERIC_CATALOGUE_PREFIXES = new Set([
  "", "no", "nos", "nr", "n", "number", "num", "cat", "catno", "catalogue", "ref", "inv", "lot",
  "p", "pp", "page", "pl", "plate", "planche", "fig", "figure", "1st",
]);
export const isGenericCataloguePrefix = (prefix: string | null | undefined): boolean => GENERIC_CATALOGUE_PREFIXES.has(foldPrefix(prefix ?? ""));

export interface SuiteComp { hammerGBP: number; currency: string | null; saleDate: string; house: string | null; work: string; workTitle: string | null; entry: string; listingUrl: string | null }
export interface CatalogueEntryRow { key: string; label: string; works: string[] }

const ENTRIES = `
MATCH (a:Artist {name: $artist})-[:CREATED]->(w:ConceptualWork)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
RETURN cr.numberingPrefix AS prefix, toString(ce.number) AS number, elementId(ce) AS entry, collect(DISTINCT w.id) AS works
`;
const SALES = `
MATCH (w:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE w.id IN $ids AND s.sourceType = 'auction' AND s.sold = true AND s.hammerPriceGBP > 0 AND s.saleDate IS NOT NULL
  AND substring(s.saleDate, 0, 10) >= $since AND substring(s.saleDate, 0, 10) < $until
  AND ($saleId IS NULL OR NOT (s.saleId = $saleId AND s.lotNumber = $lotNumber))
  AND ($listingUrl IS NULL OR s.listingUrl IS NULL OR s.listingUrl <> $listingUrl)
// Same attribution class as the lot (2026-09-17): see query_comparables ComparablesParams.attribution.
OPTIONAL MATCH (s)-[att:ATTRIBUTED_TO]->(:Artist)
WITH w, s, collect(att.qualifier) AS qs
WITH w, s, any(q IN qs WHERE q IS NOT NULL AND q <> 'direct') OR (all(q IN qs WHERE q IS NULL) AND coalesce(s.listingUrl, '') =~ $nonDirectUrlRe) AS nonDirect
WHERE $attribution IS NULL OR ($attribution = 'direct' AND NOT nonDirect) OR ($attribution = 'after' AND nonDirect)
RETURN DISTINCT s.hammerPriceGBP AS hammer, s.priceCurrency AS currency, substring(s.saleDate, 0, 10) AS date, s.institutionName AS house, w.id AS work, w.name AS title, s.listingUrl AS url
ORDER BY date DESC
`;

/** The artist's non-generic catalogue entries and the works each documents. */
export async function artistCatalogueEntries(session: Session, artist: string): Promise<CatalogueEntryRow[]> {
  const res = await session.run(ENTRIES, { artist });
  return res.records
    .filter((r) => !isGenericCataloguePrefix(r.get("prefix") as string))
    .map((r) => ({ key: `${foldPrefix(String(r.get("prefix") ?? ""))}|${String(r.get("number")).toLowerCase()}`, label: `${r.get("prefix")} ${r.get("number")}`, works: r.get("works") as string[] }));
}

/** Pure: the sibling work ids (with the entry that joins them) for a lot's works and printed citations. */
export function suiteSiblings(entries: CatalogueEntryRow[], workIds: string[], catalogueRefs: string | null | undefined, title: string | null | undefined): Map<string, string> {
  const cites = new Set([...citationsInRefs(catalogueRefs), ...citationsInTitle(title ?? "")].filter((c) => !isGenericCataloguePrefix(c.prefix)).map((c) => `${c.prefix}|${c.number}`));
  const siblings = new Map<string, string>();
  for (const e of entries) {
    if (!(e.works.some((w) => workIds.includes(w)) || cites.has(e.key))) continue;
    for (const w of e.works) if (!workIds.includes(w) && !siblings.has(w)) siblings.set(w, e.label);
  }
  return siblings;
}

/** Earlier same-suite sales for one lot. Never throws: a failed read returns no comps and the error. */
export async function querySuiteComps(input: {
  artist: string;
  workIds: string[];
  catalogueRefs?: string | null;
  title?: string | null;
  sinceDate: string;
  untilDate: string;
  excludeSaleLot?: { saleId: string; lotNumber: number } | null;
  excludeListingUrl?: string | null;
  /** The lot's attribution class; absent: no filter. */
  attribution?: "direct" | "after" | null;
  entries?: CatalogueEntryRow[];
}): Promise<{ comps: SuiteComp[]; error: string | null }> {
  const session = getDriver().session({ database: getDatabase() });
  try {
    const entries = input.entries ?? await artistCatalogueEntries(session, input.artist);
    const siblings = suiteSiblings(entries, input.workIds, input.catalogueRefs, input.title);
    if (!siblings.size) return { comps: [], error: null };
    const res = await session.run(SALES, {
      ids: [...siblings.keys()], since: input.sinceDate, until: input.untilDate,
      saleId: input.excludeSaleLot?.saleId ?? null, lotNumber: input.excludeSaleLot?.lotNumber ?? null, listingUrl: input.excludeListingUrl ?? null,
      attribution: input.attribution ?? null, nonDirectUrlRe: NON_DIRECT_URL_RE,
    });
    return {
      comps: res.records.map((r) => ({ hammerGBP: r.get("hammer") as number, currency: (r.get("currency") as string) ?? null, saleDate: r.get("date") as string, house: (r.get("house") as string) ?? null, work: r.get("work") as string, workTitle: (r.get("title") as string) ?? null, entry: siblings.get(r.get("work") as string)!, listingUrl: (r.get("url") as string) ?? null })),
      error: null,
    };
  } catch (err: any) {
    return { comps: [], error: String(err?.message ?? err) };
  } finally {
    await session.close();
  }
}
