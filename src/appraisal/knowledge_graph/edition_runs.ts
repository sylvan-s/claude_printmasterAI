/**
 * Edition facts from the ACKG — declared edition size and the proof types actually
 * catalogued for a work. Stage 2b's STEP 6 (impression state / series and edition
 * identification) has been answering this from web search, while the graph held it unused
 * by any stage.
 *
 * Coverage, verified 2026-09-09:
 *   EditionRun.declaredSize   52,386 of 97,061 runs (54%), stored as an integer
 *   Impression.copyType       76,602 of 97,059 impressions (79%), controlled vocabulary:
 *                             numbered 66,185 | AP 8,633 | PP 595 | HC 580 | BAT 311 | TP 298
 *   Impression.editionNumber  1 (effectively absent — do not build on it)
 *
 * The property is `declaredSize`, and the name is the point: it is what a source stated,
 * not a verified truth. Two sources may legitimately declare different sizes for the same
 * work, and 155 ConceptualWorks in the graph do exactly that. That is NOT a conflict to
 * resolve down to one number, and this module deliberately never picks a winner —
 * it returns every distinct declared size it found, because for prints the multiplicity is
 * usually the real answer:
 *
 *   - Lettered editions. Roseberys A0793 lot 148 is inscribed "Grimm edition B 35/100".
 *     Hockney's Grimm suite has editions A/B/C/D, each of 100 — so "100" is the size of
 *     one lettered edition, not of the whole run, and an appraisal that collapses them
 *     misreads the rarity by a factor of four. Stage 2b worked this out from the web on a
 *     previous run; the graph can hand it over.
 *   - Proofs outside the numbered edition. An edition "of 75" routinely means 75 numbered
 *     impressions PLUS APs, PPs, HCs and BATs. `copyType` is how many of each the graph has
 *     actually seen, which is a floor on what exists, never a total.
 *   - Later or posthumous editions of the same image, declared at a different size.
 *
 * So a caller that wants "the edition size" is asking the wrong question, and the shape of
 * this result is designed to make that visible rather than to answer it.
 *
 * Read-only. Title matching is exact first, then a clearly-labelled CONTAINS pass — the
 * same idiom `queryAckgWorks` already uses for reads. The project's no-fuzzy-matching rule
 * governs MERGING catalogue identity, which this module never does.
 */
import neo4j from "neo4j-driver";
import { getDriver, getDatabase } from "./client.js";
import { isLowInformationTitle } from "./title_normalize.js";
import { foldAccents, cypherFold, cypherFoldTrim, normalizeTitleKey, cypherNormalizeTitle } from "./unaccent.js";

/** Proof/copy designations as the ingests normalise them. */
export type CopyType = "numbered" | "AP" | "PP" | "HC" | "BAT" | "TP";

/**
 * Edition facts for ONE ConceptualWork. Runs are folded to the work, because that is the
 * only scope at which several declared sizes mean anything: two sizes on one work are
 * competing editions of one image, whereas two sizes across two works are just two prints
 * with different edition sizes, which is unremarkable and must not be reported as a
 * finding.
 */
export interface EditionWorkFact {
  workTitle: string;
  /** "exact" = title matched exactly (case/whitespace-insensitive); "contains" = looser
   *  substring pass; "artist_only" = no title filter was applied. */
  matchType: "exact" | "contains" | "artist_only";
  /** Distinct declared sizes for THIS work, ascending. Length > 1 is the signal. */
  declaredSizes: number[];
  /** Edition runs folded into this work. */
  runCount: number;
  years: number[];
  /** Impressions of this work the graph holds. A floor on what exists, never a total. */
  impressions: number;
  /** Count per copyType among those impressions. Absent types are simply uncatalogued. */
  copyTypes: Partial<Record<CopyType, number>>;
}

export interface EditionQueryResult {
  artistName: string;
  queriedAs: string;
  workTitle: string | null;
  works: EditionWorkFact[];
  /**
   * Titles of matched works carrying MORE THAN ONE declared size — several genuinely
   * different editions of one image (lettered A/B/C/D, a later or posthumous edition, a
   * restrike), or less often a disagreement between sources. Never collapsed to a single
   * number. Scoped per work: a spread across DIFFERENT works is not a finding.
   */
  multiEditionWorks: string[];
  /** Proof types seen across all matched runs, summed. */
  copyTypeTotals: Partial<Record<CopyType, number>>;
  coverageNote: string;
}

export interface EditionQueryParams {
  artistName: string;
  workTitle?: string | null;
  limit?: number;
  /**
   * Suppress the sale under appraisal. The circularity here is sharper than elsewhere,
   * because the headline output is `declaredSize` and that lives on the EDITION RUN, not on
   * the impression: ingesting an upcoming catalogue creates a run carrying the size the
   * catalogue declared, so the lot is handed back its own claim as if the graph had
   * corroborated it. Filtering impressions alone would not fix that — the run, and its
   * size, would survive with zero impressions attached. So a run is dropped when every
   * impression it holds comes from this sale, and kept when any impression does not.
   * Runs with no impressions at all are kept either way; they are not attributable to the
   * sale, and dropping them would make the guard change results it has no evidence about.
   */
  excludeSaleId?: string | null;
}

export const EDITION_DEFAULT_LIMIT = 12;

// $artistName and $workTitle arrive ALREADY accent-folded by foldAccents(); the stored
// properties are folded in-query so the two sides meet. Without this "Peintre et Modele"
// never matched the graph's "Peintre et Modèle" — see unaccent.ts.
const QUERY = `
MATCH (a:Artist)
WHERE ${cypherFold("a.name")} = $artistName
   OR any(alt IN coalesce(a.alternateNames, []) WHERE ${cypherFold("alt")} = $artistName)
WITH a LIMIT 1
MATCH (a)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(er:EditionRun)
WITH a, cw, er,
     CASE
       WHEN $workTitle IS NULL THEN 'artist_only'
       WHEN ${cypherNormalizeTitle("cw.name")} = $workTitleKey THEN 'exact'
       // Containment must run BOTH ways. Checking only cw.name CONTAINS $workTitle silently
       // misses every case where the searched title is the longer string — Stage 2b asked
       // for "The Beach Boys" and the graph holds "Beach Boys", so an obviously correct
       // match returned nothing at all.
       WHEN ${cypherFold("cw.name")} CONTAINS $workTitle
         OR $workTitle CONTAINS ${cypherFold("cw.name")} THEN 'contains'
       ELSE NULL
     END AS matchType
WHERE matchType IS NOT NULL
OPTIONAL MATCH (er)-[:INCLUDES]->(i:Impression)
WITH a, cw, er, matchType, collect(i) AS allImpressions
// Keep only impressions this sale did not document, then drop any run left with nothing —
// a run whose every impression is the lot itself is the lot's own claim, not a record of it.
WITH a, cw, er, matchType, size(allImpressions) AS totalImpressions,
     [x IN allImpressions WHERE $excludeSaleId IS NULL
        OR NOT EXISTS { MATCH (s:SourceRecord)-[:DOCUMENTS]->(x) WHERE s.saleId = $excludeSaleId }
     ] AS keptImpressions
WHERE totalImpressions = 0 OR size(keptImpressions) > 0
WITH a, cw, er, matchType,
     size(keptImpressions) AS impressions,
     [x IN keptImpressions | x.copyType] AS copyTypes
// Exact title matches first, then the wider passes; within a tier, the best-evidenced runs.
RETURN a.name AS artistName,
       cw.name AS workTitle,
       matchType,
       er.declaredSize AS declaredSize,
       er.dateRange_year AS year,
       impressions,
       copyTypes
ORDER BY CASE matchType WHEN 'exact' THEN 0 WHEN 'contains' THEN 1 ELSE 2 END ASC,
         impressions DESC
LIMIT $limit
`;

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return typeof v === "number" ? v : null;
}

/**
 * Edition runs the ACKG holds for an artist, optionally narrowed to one work. Returns null
 * when the artist is not in the graph. Never throws — this is enrichment, and a graph
 * hiccup must not take Stage 2b down.
 */
export async function queryEditionRuns(params: EditionQueryParams): Promise<EditionQueryResult | null> {
  const artistName = params.artistName?.trim();
  if (!artistName) return null;

  // A title carrying no identifying information ("Untitled", "Plate 4") would match half
  // the artist's output and report a meaningless spread of sizes — the same guard
  // queryAuctionComparables applies before its tier-1 title match.
  const rawTitle = params.workTitle?.trim() || null;
  const workTitle = rawTitle && !isLowInformationTitle(rawTitle) ? rawTitle : null;

  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(QUERY, {
      artistName: foldAccents(artistName),
      workTitle: workTitle ? foldAccents(workTitle) : null,
      workTitleKey: workTitle ? normalizeTitleKey(workTitle) : null,
      excludeSaleId: params.excludeSaleId ?? null,
      limit: neo4j.int(params.limit ?? EDITION_DEFAULT_LIMIT),
    });
    if (res.records.length === 0) return null;

    // Fold runs to their work. The query returns one row per EditionRun, and a work with
    // lettered editions has several — collapsing here is what makes `declaredSizes` mean
    // "editions of THIS image" rather than "sizes seen anywhere in the result set".
    const byWork = new Map<string, EditionWorkFact>();
    const rank = { exact: 0, contains: 1, artist_only: 2 } as const;
    for (const r of res.records) {
      const title = r.get("workTitle") as string;
      const matchType = r.get("matchType") as EditionWorkFact["matchType"];
      const cur =
        byWork.get(title) ??
        { workTitle: title, matchType, declaredSizes: [], runCount: 0, years: [], impressions: 0, copyTypes: {} };
      if (rank[matchType] < rank[cur.matchType]) cur.matchType = matchType;
      cur.runCount += 1;
      cur.impressions += toNum(r.get("impressions")) ?? 0;
      const size = toNum(r.get("declaredSize"));
      if (size != null && !cur.declaredSizes.includes(size)) cur.declaredSizes.push(size);
      const yr = toNum(r.get("year"));
      if (yr != null && !cur.years.includes(yr)) cur.years.push(yr);
      for (const c of (r.get("copyTypes") as (string | null)[]) ?? []) {
        if (!c) continue;
        cur.copyTypes[c as CopyType] = (cur.copyTypes[c as CopyType] ?? 0) + 1;
      }
      byWork.set(title, cur);
    }

    const works = [...byWork.values()];
    for (const w of works) {
      w.declaredSizes.sort((a, b) => a - b);
      w.years.sort((a, b) => a - b);
    }
    works.sort((a, b) => rank[a.matchType] - rank[b.matchType] || b.impressions - a.impressions);

    const copyTypeTotals: Partial<Record<CopyType, number>> = {};
    for (const w of works) {
      for (const [k, v] of Object.entries(w.copyTypes)) {
        copyTypeTotals[k as CopyType] = (copyTypeTotals[k as CopyType] ?? 0) + v;
      }
    }

    return {
      artistName: res.records[0].get("artistName") as string,
      queriedAs: artistName,
      workTitle,
      works,
      multiEditionWorks: works.filter((w) => w.declaredSizes.length > 1).map((w) => w.workTitle),
      copyTypeTotals,
      coverageNote:
        "declaredSize is present on 54% of edition runs and copyType on 79% of impressions, " +
        "so an absent size or proof type is missing data, never evidence that none exists. " +
        "Impression counts are what the graph holds, a floor on what exists, not an edition total.",
    };
  } catch (err: any) {
    console.warn(`[queryEditionRuns] failed for "${artistName}": ${err.message}`);
    return null;
  } finally {
    await session.close();
  }
}

/** Renders an edition lookup as a Stage 2b tool_result. */
export function formatEditionRunsForClaude(res: EditionQueryResult | null): string {
  if (!res) {
    return (
      "No edition runs found — either this artist is not in the graph under that name, or " +
      "no work matched that title. Absence of coverage, not evidence about the edition."
    );
  }
  const lines = [
    `Edition data for ${res.artistName}${res.workTitle ? ` matching title "${res.workTitle}"` : " (artist-wide sample — these are DIFFERENT works, so their sizes are not comparable to each other)"}: ${res.works.length} work(s).`,
  ];

  if (res.multiEditionWorks.length > 0) {
    lines.push(
      `SEVERAL DECLARED SIZES ON ONE WORK: ${res.multiEditionWorks.map((t) => `"${t.length > 120 ? `${t.slice(0, 117)}…` : t}"`).join(", ")}. ` +
        `Do not average them or pick one. For prints this usually means genuinely different ` +
        `editions of the SAME image — lettered editions (A/B/C/D, each its own edition of N), ` +
        `a later or posthumous edition, or a restrike — and only sometimes a disagreement ` +
        `between sources. Establish WHICH edition this impression belongs to; the inscription ` +
        `is usually what settles it.`,
    );
  }

  const totals = Object.entries(res.copyTypeTotals);
  if (totals.length) {
    lines.push(
      `Catalogued copy types across these works: ${totals.map(([k, v]) => `${k}=${v}`).join(", ")}. ` +
        `Proofs (AP/PP/HC/BAT/TP) sit OUTSIDE the numbered edition, so a numbered size ` +
        `understates how many impressions of that image exist.`,
    );
  }

  // Some ingested "titles" are provenance notes hundreds of characters long (a real Banksy
  // row is a 400-char Greenpeace commissioning note). Truncate for the tool result rather
  // than spend the context; the underlying data issue is logged, not fixed here.
  const short = (t: string) => (t.length > 120 ? `${t.slice(0, 117)}…` : t);
  for (const w of res.works) {
    lines.push(
      `\n"${short(w.workTitle)}" [${w.matchType}]` +
        (w.years.length ? ` (${w.years.join(", ")})` : "") +
        ` — declaredSize: ${w.declaredSizes.length ? w.declaredSizes.join(" / ") : "—"}` +
        `, runs: ${w.runCount}, impressions held: ${w.impressions}` +
        (Object.keys(w.copyTypes).length
          ? `, copyTypes: ${Object.entries(w.copyTypes).map(([k, v]) => `${k}=${v}`).join(" ")}`
          : ""),
    );
  }

  lines.push(`\nCoverage: ${res.coverageNote}`);
  return lines.join("\n");
}
