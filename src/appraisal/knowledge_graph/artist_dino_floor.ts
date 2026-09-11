/**
 * The DINOv2 work-identity floor for ONE artist, read off their own background distribution.
 *
 * `D_T_DINO_FLOOR = 0.88` is global, and its own comment admits it is unfitted — five lots,
 * 0.010 between the lowest same-work match and the highest different-work one. Measured over
 * 37,905 image pairs from 400 artists (knowledge_graph/analyse_dino_threshold.py), it is a
 * reasonable CENTRE and a poor CONSTANT: the threshold holding a 1% false-positive rate runs
 * from 0.533 to 1.000 across the 977 artists with enough embedded output to measure, median
 * 0.875, with 473 needing a higher floor and 504 a lower one.
 *
 *   Damien Hirst    0.919    0.88 admits DIFFERENT works as the same print
 *   Elisabeth Frink 0.857
 *   Peter Blake     0.735    0.88 refuses matches that ARE the same print, discarding
 *   Banksy          0.710    evidence the graph actually holds
 *
 * The background EXCLUDES pairs whose titles normalise identically — one print on two nodes
 * is not two works. Without that filter Blake reads 0.983 instead of 0.735 and rejects his
 * 0.886 A0793/122 match, which the regression suite verifies against Tate P04038.
 *
 * ENRICHMENT, NEVER A GATE. Most artists have too little embedded output for a distribution
 * to mean anything, and for them this returns null and the caller keeps the global floor. A
 * missing background is a coverage fact about the graph, never evidence about the lot.
 */
import { getDriver, getDatabase } from "./client.js";
import { foldAccents, cypherFold } from "./unaccent.js";

export interface ArtistDinoFloor {
  /** The floor to apply: similarity exceeded by only 1% of this artist's different-work pairs. */
  floor: number;
  /** The 5% point, for a caller that wants a looser operating point without a recompute. */
  p95: number;
  /** Background pairs behind it — small n means a soft number, so it is returned, not hidden. */
  pairs: number;
  canonicalName: string;
}

// Same exact-match idiom as resolveArtistIdentity: folded equality against name or alias,
// never CONTAINS. A floor fetched for the wrong artist would silently re-gate work identity.
const QUERY = `
MATCH (a:Artist)
WHERE (${cypherFold("a.name")} = $name
       OR any(alt IN coalesce(a.alternateNames, []) WHERE ${cypherFold("alt")} = $name))
  AND a.dinoBackgroundP99 IS NOT NULL
RETURN a.name AS canonicalName, a.dinoBackgroundP99 AS p99,
       a.dinoBackgroundP95 AS p95, a.dinoBackgroundPairs AS pairs
ORDER BY a.dinoBackgroundPairs DESC
LIMIT 1
`;

/** Never throws — a graph hiccup must leave the global floor in place, not fail the lot. */
export async function queryArtistDinoFloor(artistName: string | null | undefined): Promise<ArtistDinoFloor | null> {
  const name = artistName?.trim();
  if (!name) return null;
  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(QUERY, { name: foldAccents(name) });
    if (res.records.length === 0) return null;
    const r = res.records[0];
    const num = (v: unknown): number | null =>
      typeof v === "number" ? v : v && typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : null;
    const floor = num(r.get("p99"));
    if (floor == null || !Number.isFinite(floor)) return null;
    return {
      floor,
      p95: num(r.get("p95")) ?? floor,
      pairs: num(r.get("pairs")) ?? 0,
      canonicalName: r.get("canonicalName") as string,
    };
  } catch (err: any) {
    console.warn(`[queryArtistDinoFloor] failed for "${name}": ${err.message}`);
    return null;
  } finally {
    await session.close();
  }
}
