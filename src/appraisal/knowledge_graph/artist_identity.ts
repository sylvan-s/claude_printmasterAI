/**
 * Resolve an artist NAME to the graph's own identity for that artist — once, in code.
 *
 * Stage 2a used to ask the evidence agent for `dominantCandidateIdentityKey` ("ULAN or
 * Wikidata URI ... if query_ackg returned one"), which made identity resolution a cell the
 * MODEL filled by reading a URL off a returned row — with the same failure surface as every
 * other model-filled cell, and consumed by nothing. That cell is gone. Every later graph
 * read (catalogue raisonné lookup, Stage 3 comparables, Stage 2b's comparables and edition
 * tools) used to re-query the graph using the model's SPELLING of the artist's name; they
 * now use what this module returns.
 *
 * This does that step deterministically and exactly once. The model still chooses WHICH name
 * to resolve — that judgement is irreducibly its own — but name -> canonical identity is now
 * a lookup with one answer rather than an observation that varies by run.
 *
 * COVERAGE (measured 2026-09-11): 2,003 of 8,033 Artists carry a ulanUrl, which sounds thin
 * until it is weighted by output. Artists with 50+ catalogued works — the ones a print sale
 * is actually made of — are 83.2% covered, accounting for 90.4% of those works; artists with
 * a single work are 8% covered. So a miss is normal and means "not in ULAN, or not yet
 * backfilled", never "not a real artist". Resolution is therefore enrichment and must never
 * gate anything.
 *
 * MATCHING IS EXACT, deliberately. Names are folded for accents and case (unaccent.ts) and
 * compared for equality against Artist.name and Artist.alternateNames — no CONTAINS, no
 * similarity. Fuzzy matching on artist identity has caused two confirmed corruption
 * incidents in this graph, and while this module only READS, a wrong resolution here would
 * be carried forward into every downstream query under the authority of "canonical".
 */
import { getDriver, getDatabase } from "./client.js";
import { foldAccents, cypherFold } from "./unaccent.js";

export interface ArtistIdentity {
  /** The graph's own spelling — what downstream queries should use. */
  canonicalName: string;
  ulanUrl: string | null;
  wikidataUrl: string | null;
  /** Which field matched: the primary name, or one of the recorded alternates. */
  matchedOn: "name" | "alternateName";
  /** The name that was looked up, as given. */
  queriedAs: string;
  /** Catalogued works, for the caller to judge how well-evidenced the identity is. */
  workCount: number;
  /** The node's recorded aliases, so a later mention of this artist under a different name
   *  can be recognised as the SAME artist without another query. */
  alternateNames: string[];
  /**
   * More than one Artist node matched this name. The graph has a known duplicate-artist
   * history, so this is reported rather than hidden. When duplicates disagree about ULAN,
   * `ulanUrl` is left null: a coin-flip between two authority records is worse than none.
   */
  ambiguousMatchCount: number;
}

// Folded on both sides so "Elisabeth Frink" meets "Élisabeth Frink", and equality — never
// containment — so "Peter Blake" cannot resolve to "Peter Blake Jr" or vice versa.
const QUERY = `
MATCH (a:Artist)
WHERE ${cypherFold("a.name")} = $name
   OR any(alt IN coalesce(a.alternateNames, []) WHERE ${cypherFold("alt")} = $name)
OPTIONAL MATCH (a)-[:CREATED]->(cw:ConceptualWork)
WITH a, count(DISTINCT cw) AS workCount,
     CASE WHEN ${cypherFold("a.name")} = $name THEN 'name' ELSE 'alternateName' END AS matchedOn
RETURN a.name AS canonicalName, a.ulanUrl AS ulanUrl, a.wikidataUrl AS wikidataUrl,
       coalesce(a.alternateNames, []) AS alternateNames,
       matchedOn, workCount
// A primary-name match outranks an alias; within a tier, the best-evidenced node. This only
// ORDERS the duplicates — it never merges them, and the count is returned either way.
ORDER BY CASE matchedOn WHEN 'name' THEN 0 ELSE 1 END ASC, workCount DESC
LIMIT 10
`;

/**
 * Never throws and never invents. Returns null when the name is absent from the graph —
 * which is a statement about coverage, not about the artist.
 */
export async function resolveArtistIdentity(artistName: string | null | undefined): Promise<ArtistIdentity | null> {
  const queriedAs = artistName?.trim();
  if (!queriedAs) return null;

  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(QUERY, { name: foldAccents(queriedAs) });
    if (res.records.length === 0) return null;
    const top = res.records[0];

    // Duplicates that disagree about ULAN get no ULAN. Picking the better-evidenced node's
    // authority record would be a guess wearing a canonical label, and this value is about
    // to be carried forward as settled.
    const ulans = new Set(
      res.records.map((r) => r.get("ulanUrl")).filter((u): u is string => typeof u === "string" && u.length > 0),
    );
    const wikidatas = new Set(
      res.records.map((r) => r.get("wikidataUrl")).filter((u): u is string => typeof u === "string" && u.length > 0),
    );

    const toInt = (v: unknown): number =>
      v && typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : typeof v === "number" ? v : 0;

    return {
      canonicalName: top.get("canonicalName") as string,
      ulanUrl: ulans.size === 1 ? [...ulans][0] : null,
      wikidataUrl: wikidatas.size === 1 ? [...wikidatas][0] : null,
      matchedOn: top.get("matchedOn") as "name" | "alternateName",
      queriedAs,
      workCount: toInt(top.get("workCount")),
      alternateNames: ((top.get("alternateNames") as unknown[]) ?? []).filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      ),
      ambiguousMatchCount: res.records.length,
    };
  } catch (err: any) {
    console.warn(`[resolveArtistIdentity] failed for "${queriedAs}": ${err.message}`);
    return null;
  } finally {
    await session.close();
  }
}

/** One log line. Says what was resolved and what it cost in certainty. */
export function formatArtistIdentity(id: ArtistIdentity | null, queriedAs: string): string {
  if (!id) return `"${queriedAs}" — not in the ACKG under that name (coverage, not a verdict)`;
  const bits = [
    id.canonicalName === id.queriedAs ? `"${id.canonicalName}"` : `"${id.queriedAs}" -> "${id.canonicalName}"`,
    id.matchedOn === "alternateName" ? "via alternateName" : null,
    id.ulanUrl ? `ULAN ${id.ulanUrl.split("/").pop()}` : "no ULAN",
    `${id.workCount} work(s)`,
    id.ambiguousMatchCount > 1 ? `AMBIGUOUS: ${id.ambiguousMatchCount} Artist nodes match` : null,
  ].filter(Boolean);
  return bits.join(", ");
}

/**
 * Which artist name an ACKG query should actually use.
 *
 * Stages 2b and 3 query the graph about whoever the model names, and the graph MATCHes on
 * name — so "Sir Peter Blake" returns 0 comparables where "Peter Blake" returns 40. Stage 2a
 * has already resolved the appraised work's artist once; this applies that answer, and only
 * that answer, wherever the request is provably about the same person.
 *
 * Three steps, all EXACT — no similarity anywhere, because substituting one artist's name
 * for another's would silently answer a question nobody asked:
 *
 *   1. The requested name folds onto the Stage 2a identity's canonical name or one of its
 *      aliases -> use the canonical name. No query: the aliases came back with it.
 *   2. Otherwise resolve the requested name on its own merits. This is the Scenario 5 path,
 *      where Stage 2b is explicitly told to research every competing candidate — forcing the
 *      attributed artist's name onto a query about a rival candidate would answer about the
 *      wrong artist, so the rival gets canonicalised as itself.
 *   3. Neither resolves -> pass the name through untouched. Not in the graph under any known
 *      name is a coverage fact, and inventing a substitution would not change it.
 */
export async function canonicalArtistForQuery(
  requestedName: string | null | undefined,
  stage2aIdentity: { canonicalArtistName: string; alternateNames?: string[] } | null | undefined,
): Promise<{ name: string; via: "stage2a" | "resolved" | "unchanged" }> {
  const requested = (requestedName ?? "").trim();
  if (!requested) return { name: requested, via: "unchanged" };

  if (stage2aIdentity?.canonicalArtistName) {
    const want = foldAccents(requested);
    const known = [stage2aIdentity.canonicalArtistName, ...(stage2aIdentity.alternateNames ?? [])].map(foldAccents);
    if (known.includes(want)) return { name: stage2aIdentity.canonicalArtistName, via: "stage2a" };
  }

  const own = await resolveArtistIdentity(requested);
  return own ? { name: own.canonicalName, via: "resolved" } : { name: requested, via: "unchanged" };
}
