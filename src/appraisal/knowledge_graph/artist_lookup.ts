/**
 * Artist NAME -> the graph's stored `Artist.name` value(s), resolved as a cheap step of its
 * own so that every query about that artist can start from the `artist_name` RANGE index.
 *
 * Matching the folded name inline — `cypherFold(a.name) = $x`, or `toLower(a.name) =
 * toLower($x)` — is not indexable: the planner has to evaluate the expression on every
 * Artist node, and once a traversal is attached it may not even start there. Measured on
 * queryAuctionComparables 2026-09-13 (SHOW TRANSACTIONS): the planner started from
 * SourceRecord instead, ~1.5M page hits and 3.3-4.6 s per call, against 24-80 ms once the
 * artist came from the index. The Artist-only scans elsewhere are cheaper (~100-180 ms on
 * the 11k-node label) but every one of them is paid several times per lot, and under
 * concurrent backtest workers they stack.
 *
 * Three steps, each run only when the previous one finds nothing:
 *
 *   1. EXACT   `MATCH (a:Artist {name: $exact})` — an index seek. Callers usually pass the
 *              graph's own spelling (resolveArtistIdentity's canonicalName), so this is the
 *              common path and it costs a few milliseconds.
 *   2. FOLDED  the accent/case-folded equality against `name` OR `alternateNames` that the
 *              call sites used to run inline. Still a label scan, still EXACT matching —
 *              equality after a deterministic fold, never similarity — and it also reports
 *              whether the primary name or an alias matched.
 *   3. CONTAINS (opt-in, `contains: true`) the folded-substring match `queryAckgWorks`
 *              exposes to the Stage 2a tool as "artist name, substring". Kept as a last
 *              resort so a partial name from the model still finds "Pablo Picasso" — but
 *              only after the two exact passes miss, so a canonical name never pays for it.
 *
 * The result is a list of stored names for `WHERE a.name IN $names`, which the planner
 * serves from the index. Nothing here writes, and nothing here merges: several Artist
 * nodes sharing a name (the graph's known duplicate-artist history) all come back, and the
 * caller decides what to do with more than one.
 */
import type { Session } from "neo4j-driver";
import { cypherFold, foldAccents } from "./unaccent.js";

export type ArtistLookupVia = "exact" | "folded" | "contains" | "none";

export interface ArtistLookup {
  /** Distinct stored `Artist.name` values. Empty when nothing matched. */
  names: string[];
  /** The subset of `names` that matched on the primary name rather than only via an alias. */
  nameMatched: string[];
  via: ArtistLookupVia;
}

const EXACT = `MATCH (a:Artist {name: $exact}) RETURN DISTINCT a.name AS name`;

// Folded on both sides so "Elisabeth Frink" meets "Élisabeth Frink", and equality — never
// containment — so "Peter Blake" cannot resolve to "Peter Blake Jr" or vice versa.
const FOLDED = `
MATCH (a:Artist)
WHERE ${cypherFold("a.name")} = $folded
   OR any(alt IN coalesce(a.alternateNames, []) WHERE ${cypherFold("alt")} = $folded)
RETURN DISTINCT a.name AS name, ${cypherFold("a.name")} = $folded AS onName
`;

const CONTAINS = `MATCH (a:Artist) WHERE ${cypherFold("a.name")} CONTAINS $folded RETURN DISTINCT a.name AS name`;

const EMPTY: ArtistLookup = { names: [], nameMatched: [], via: "none" };

/**
 * Runs in the caller's session so it shares the transaction context of the query that
 * follows. Throws on driver errors like any other `session.run`; callers that must never
 * fail already wrap their whole read in try/catch.
 */
export async function lookupArtistNames(
  session: Session,
  artistName: string,
  opts: { contains?: boolean } = {},
): Promise<ArtistLookup> {
  const exact = artistName.trim();
  if (!exact) return EMPTY;

  const hit = await session.run(EXACT, { exact });
  if (hit.records.length) {
    const names = hit.records.map((r) => String(r.get("name")));
    return { names, nameMatched: names, via: "exact" };
  }

  const folded = foldAccents(exact);
  const scan = await session.run(FOLDED, { folded });
  if (scan.records.length) {
    const names: string[] = [];
    const nameMatched: string[] = [];
    for (const r of scan.records) {
      const name = String(r.get("name"));
      if (!names.includes(name)) names.push(name);
      if (r.get("onName") === true && !nameMatched.includes(name)) nameMatched.push(name);
    }
    return { names, nameMatched, via: "folded" };
  }

  if (opts.contains) {
    const sub = await session.run(CONTAINS, { folded });
    if (sub.records.length) {
      const names = [...new Set(sub.records.map((r) => String(r.get("name"))))];
      return { names, nameMatched: names, via: "contains" };
    }
  }

  return EMPTY;
}
