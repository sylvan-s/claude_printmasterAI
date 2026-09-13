/**
 * queryWorkFacts — what the graph knows about ONE resolved ConceptualWork (or the set of
 * nodes work_identity.ts resolved a lot to): catalogued techniques, dimensions, edition sizes,
 * and the work's own auction sell-through. Read by the attributed-lot path to VERIFY a
 * catalogue claim against the node it names, and to report liquidity to Stage 3.
 *
 * The lot under appraisal is excluded by sale + lot number when it is itself in the graph
 * (backtests over past sales), and sell-through is cut at `untilDate` for the same reason.
 * Never throws: a graph hiccup leaves the caller with null, not a failed lot.
 */
import { getDriver, getDatabase } from "./client.js";
import { dimsCm } from "./price_attrs.js";
import neo4j from "neo4j-driver";

export interface WorkFacts {
  workIds: string[];
  names: string[];
  impressionCount: number;
  /** Technique node names on the work's impressions, deduped. */
  techniques: string[];
  /** Distinct declared edition sizes across the work's EditionRuns. */
  editionSizes: number[];
  /** Catalogued dimensions in cm, [width, height], per kind, deduped. */
  plateDimsCm: [number, number][];
  imageDimsCm: [number, number][];
  sheetDimsCm: [number, number][];
  rawMediums: string[];
  /** Auction appearances of this work before `untilDate` (own lot excluded). */
  sellThrough: { sold: number; unsold: number };
}

const QUERY = `
MATCH (cw:ConceptualWork) WHERE cw.id IN $ids
MATCH (cw)-[:PRINTED_AS]->(er:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (s:SourceRecord)-[:DOCUMENTS]->(i)
WITH cw, er, i, s
WHERE $excludeSaleId IS NULL OR s IS NULL OR s.saleId IS NULL
   OR NOT (s.saleId = $excludeSaleId AND s.lotNumber = $excludeLotNumber)
OPTIONAL MATCH (i)-[:USES_TECHNIQUE]->(t:Technique)
WITH cw, er, i, s, collect(DISTINCT t.name) AS techs
RETURN collect(DISTINCT cw.name) AS names,
       count(DISTINCT i) AS impressions,
       collect(DISTINCT techs) AS techLists,
       collect(DISTINCT coalesce(er.declaredSize, er.editionSize)) AS editionSizes,
       collect(DISTINCT i.plateDimensions) AS plateDims,
       collect(DISTINCT i.imageDimensions) AS imageDims,
       collect(DISTINCT i.sheetDimensions) AS sheetDims,
       collect(DISTINCT i.rawMedium)[0..6] AS rawMediums,
       count(DISTINCT CASE WHEN s.sourceType = 'auction' AND s.sold = true
                            AND ($untilDate IS NULL OR s.saleDate IS NULL OR substring(s.saleDate, 0, 10) < $untilDate) THEN s END) AS sold,
       count(DISTINCT CASE WHEN s.sourceType = 'auction' AND s.sold = false
                            AND ($untilDate IS NULL OR s.saleDate IS NULL OR substring(s.saleDate, 0, 10) < $untilDate) THEN s END) AS unsold
`;

const num = (v: unknown): number | null =>
  typeof v === "number" ? v : v && typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : null;

function dedupeDims(strs: unknown[]): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (const s of strs) {
    const d = dimsCm(typeof s === "string" ? s : null);
    if (!d) continue;
    const k = `${d[0].toFixed(1)}x${d[1].toFixed(1)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(d);
  }
  return out;
}

export async function queryWorkFacts(
  workIds: string[],
  opts: { excludeSaleLot?: { saleId: string; lotNumber: number } | null; untilDate?: string | null } = {},
): Promise<WorkFacts | null> {
  if (!workIds.length) return null;
  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(QUERY, {
      ids: workIds,
      excludeSaleId: opts.excludeSaleLot?.saleId ?? null,
      excludeLotNumber: opts.excludeSaleLot ? neo4j.int(opts.excludeSaleLot.lotNumber) : null,
      untilDate: opts.untilDate ?? null,
    });
    const r = res.records[0];
    if (!r) return null;
    const techniques = [...new Set(((r.get("techLists") as unknown[][]) ?? []).flat().filter((x): x is string => typeof x === "string" && !!x))];
    const editionSizes = [...new Set(((r.get("editionSizes") as unknown[]) ?? []).map(num).filter((x): x is number => x != null && x > 0))].sort((a, b) => a - b);
    return {
      workIds,
      names: ((r.get("names") as unknown[]) ?? []).filter((x): x is string => typeof x === "string"),
      impressionCount: num(r.get("impressions")) ?? 0,
      techniques,
      editionSizes,
      plateDimsCm: dedupeDims(r.get("plateDims") ?? []),
      imageDimsCm: dedupeDims(r.get("imageDims") ?? []),
      sheetDimsCm: dedupeDims(r.get("sheetDims") ?? []),
      rawMediums: ((r.get("rawMediums") as unknown[]) ?? []).filter((x): x is string => typeof x === "string" && !!x),
      sellThrough: { sold: num(r.get("sold")) ?? 0, unsold: num(r.get("unsold")) ?? 0 },
    };
  } catch (err: any) {
    console.warn(`[queryWorkFacts] failed: ${err?.message ?? err}`);
    return null;
  } finally {
    await session.close();
  }
}
