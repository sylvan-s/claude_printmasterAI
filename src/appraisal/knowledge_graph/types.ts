/**
 * Query interface to the Art Context Knowledge Graph (ACKG) — see
 * knowledge_graph/08_ackg_schema_definition.md (repo root) for the full graph
 * schema and docs/adr/0003-knowledge-graph-grounded-triage.md for why this
 * exists: candidate-artist probabilities grounded in real ingested records
 * (Met, Roseberys, Forum Auctions) rather than an LLM's unexaminable prior.
 */

export interface AckgQueryParams {
  /** Printing technique name, e.g. "Etching", "Screenprint / Serigraphy". Substring match, case-insensitive. */
  technique?: string;
  /** Inclusive year range on the work's creation date. Either bound may be given alone. */
  periodStartYear?: number;
  periodEndYear?: number;
  /** Paper type, e.g. "wove", "laid". Substring match, case-insensitive. */
  paper?: string;
  /** Artist nationality hint, e.g. "British", "American". Substring match against
   *  Artist.nationality, which is itself free text (e.g. "American, born Poland"). */
  region?: string;
  /** Depicted subject, e.g. "Portraits", "Horses". Substring match, case-insensitive. */
  subject?: string;
  /** Max candidates returned, ranked by supportCount descending. Defaults to 10. */
  limit?: number;
}

export type AckgProvenanceTag = "institutional" | "auction_history";

export interface AckgCandidate {
  artistName: string;
  ulanUrl: string | null;
  wikidataUrl: string | null;
  /** Total distinct works matching the query's filters. Zero is a real, meaningful
   *  signal — absence of population data — never treat it as evidence *against*
   *  the candidate; the graph's coverage is not exhaustive (see module docstring
   *  in query.ts for known coverage gaps). */
  supportCount: number;
  /** Support broken down by source layer, per ADR-0003's two-layer design:
   *  institutional (Met, V&A) vs. auction-history (Roseberys, Forum Auctions). */
  institutionalSupportCount: number;
  auctionSupportCount: number;
  /** Up to 3 sample work titles, for the calling agent to sanity-check the match. */
  sampleWorks: string[];
}
