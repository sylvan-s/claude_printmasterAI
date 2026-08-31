/**
 * queryAckg — ranked artist candidates from the ACKG, backed by real ingested
 * records rather than an LLM's training-time prior. See docs/adr/0003 for why
 * this is a tool call the model invokes deliberately, not a static context
 * dump: the caller supplies whichever filters it currently has evidence for
 * (any/all may be omitted) and can call again with refined filters as its
 * hypothesis narrows.
 *
 * Known, honest coverage gap: the graph's current sources (Met Open Access,
 * Roseberys, Forum Auctions) are strong for Western 19th-20th century prints
 * and thin-to-absent for ukiyo-e specifically — the same non-Western coverage
 * gap ADR-0003 already flags for Getty ULAN (~1.3% Japan). A zero or low
 * supportCount for an East Asian candidate reflects that gap, not evidence
 * against the attribution — never treat it as a vote to rule the candidate
 * out. This is a scope fact to surface to the calling agent, not a bug to
 * silently work around here.
 */
import neo4j from "neo4j-driver";
import { getDriver, getDatabase } from "./client.js";
import type { AckgQueryParams, AckgCandidate, AckgWorkQueryParams, AckgWorkMatch, AckgProvenanceTag } from "./types.js";
import { parseAckgDimMm, type DimMm } from "./dimension_parse.js";

const QUERY = `
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)
      -[:INCLUDES]->(imp:Impression)
OPTIONAL MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
OPTIONAL MATCH (imp)-[:PRINTED_ON]->(p:Paper)
OPTIONAL MATCH (imp)-[:DEPICTS]->(s:Subject)
MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp)
WHERE ($technique IS NULL OR toLower(t.name) CONTAINS toLower($technique))
  AND ($paper IS NULL OR toLower(p.name) CONTAINS toLower($paper))
  AND ($subject IS NULL OR toLower(s.name) CONTAINS toLower($subject))
  AND ($region IS NULL OR toLower(a.nationality) CONTAINS toLower($region))
  AND ($workTitle IS NULL OR toLower(cw.name) CONTAINS toLower($workTitle))
  AND ($periodStart IS NULL OR cw.dateCreated_year >= $periodStart)
  AND ($periodEnd IS NULL OR cw.dateCreated_year <= $periodEnd)
WITH a, count(DISTINCT cw) AS supportCount,
     count(DISTINCT CASE WHEN src.sourceType = 'institutional' THEN cw END) AS institutionalSupportCount,
     count(DISTINCT CASE WHEN src.sourceType = 'auction' THEN cw END) AS auctionSupportCount,
     collect(DISTINCT cw.name)[0..6] AS sampleWorks
RETURN a.name AS artistName, a.ulanUrl AS ulanUrl, a.wikidataUrl AS wikidataUrl,
       supportCount, institutionalSupportCount, auctionSupportCount, sampleWorks
ORDER BY supportCount DESC
LIMIT $limit
`;

function toInt(value: unknown): number {
  // neo4j-driver returns Integer objects for count()/collect() sizes by default;
  // toNumber() is safe here since these counts are far below JS's safe-integer range.
  if (value && typeof value === "object" && "toNumber" in (value as any)) {
    return (value as any).toNumber();
  }
  return typeof value === "number" ? value : 0;
}

export async function queryAckg(params: AckgQueryParams): Promise<AckgCandidate[]> {
  const driver = getDriver();
  const session = driver.session({ database: getDatabase() });
  try {
    const result = await session.run(QUERY, {
      technique: params.technique ?? null,
      paper: params.paper ?? null,
      subject: params.subject ?? null,
      region: params.region ?? null,
      workTitle: params.workTitle ?? null,
      periodStart: params.periodStartYear ?? null,
      periodEnd: params.periodEndYear ?? null,
      limit: neo4j.int(params.limit ?? 10),
    });
    return result.records.map((record) => ({
      artistName: record.get("artistName"),
      ulanUrl: record.get("ulanUrl") ?? null,
      wikidataUrl: record.get("wikidataUrl") ?? null,
      supportCount: toInt(record.get("supportCount")),
      institutionalSupportCount: toInt(record.get("institutionalSupportCount")),
      auctionSupportCount: toInt(record.get("auctionSupportCount")),
      sampleWorks: record.get("sampleWorks") ?? [],
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// queryAckgWorks — ADR-0010 Decision 9.1 K_work probe. Aggregates per
// ConceptualWork and returns catalogued technique + dimension facts, so the
// two-pass classifier can compare the physical object against the catalogued
// record (impression divergence, Decision 5b) rather than guessing.
// ---------------------------------------------------------------------------
const WORKS_QUERY = `
MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)
      -[:INCLUDES]->(imp:Impression)
MATCH (src:SourceRecord)-[:DOCUMENTS]->(imp)
WHERE ($artist IS NULL OR toLower(a.name) CONTAINS toLower($artist))
  AND ($workTitle IS NULL OR toLower(cw.name) CONTAINS toLower($workTitle))
  AND ($periodStart IS NULL OR cw.dateCreated_year >= $periodStart)
  AND ($periodEnd IS NULL OR cw.dateCreated_year <= $periodEnd)
OPTIONAL MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
WITH cw, a,
     count(DISTINCT imp) AS impressionCount,
     collect(DISTINCT t.name) AS techniques,
     collect(DISTINCT imp.rawMedium)[0..3] AS rawMediums,
     collect(DISTINCT imp.plateDimensions) AS plateDims,
     collect(DISTINCT imp.imageDimensions) AS imageDims,
     collect(DISTINCT imp.sheetDimensions) AS sheetDims,
     collect(DISTINCT er.declaredSize) AS editionSizes,
     collect(DISTINCT src.sourceType) AS sourceTypes
WHERE ($technique IS NULL OR any(x IN techniques WHERE toLower(x) CONTAINS toLower($technique)))
RETURN cw.name AS workTitle, a.name AS artistName, a.ulanUrl AS artistUlanUrl,
       cw.dateCreated_displayLabel AS dateLabel,
       techniques, rawMediums, plateDims, imageDims, sheetDims, editionSizes, sourceTypes,
       impressionCount
ORDER BY impressionCount DESC
LIMIT $limit
`;

function parseDimList(raw: unknown): DimMm[] {
  if (!Array.isArray(raw)) return [];
  const out: DimMm[] = [];
  for (const s of raw) {
    const d = parseAckgDimMm(typeof s === "string" ? s : null);
    if (d) out.push(d);
  }
  return out;
}

export async function queryAckgWorks(params: AckgWorkQueryParams): Promise<AckgWorkMatch[]> {
  const driver = getDriver();
  const session = driver.session({ database: getDatabase() });
  try {
    const result = await session.run(WORKS_QUERY, {
      artist: params.artist ?? null,
      workTitle: params.workTitle ?? null,
      technique: params.technique ?? null,
      periodStart: params.periodStartYear ?? null,
      periodEnd: params.periodEndYear ?? null,
      limit: neo4j.int(params.limit ?? 8),
    });
    return result.records.map((record) => {
      const sourceTypes: string[] = (record.get("sourceTypes") ?? []).filter(Boolean);
      const provenanceLayers: AckgProvenanceTag[] = [];
      if (sourceTypes.includes("institutional")) provenanceLayers.push("institutional");
      if (sourceTypes.includes("auction")) provenanceLayers.push("auction_history");
      return {
        workTitle: record.get("workTitle"),
        artistName: record.get("artistName"),
        artistUlanUrl: record.get("artistUlanUrl") ?? null,
        dateLabel: record.get("dateLabel") ?? null,
        techniques: (record.get("techniques") ?? []).filter(Boolean),
        rawMediums: (record.get("rawMediums") ?? []).filter(Boolean),
        plateDimsMm: parseDimList(record.get("plateDims")),
        imageDimsMm: parseDimList(record.get("imageDims")),
        sheetDimsMm: parseDimList(record.get("sheetDims")),
        editionSizes: (record.get("editionSizes") ?? [])
          .map((v: unknown) => toInt(v))
          .filter((n: number) => n > 0),
        impressionCount: toInt(record.get("impressionCount")),
        provenanceLayers,
      };
    });
  } finally {
    await session.close();
  }
}
