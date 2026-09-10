/**
 * Query interface to the Art Context Knowledge Graph (ACKG) — see
 * knowledge_graph/08_ackg_schema_definition.md (repo root) for the full graph
 * schema and docs/adr/0003-knowledge-graph-grounded-triage.md for why this
 * exists: candidate-artist probabilities grounded in real ingested records
 * (Bonhams, Roseberys, Forum Auctions, Skinner, Tate, the Met, the British Museum)
 * rather than an LLM's unexaminable prior.
 */
import type { DimMm } from "./dimension_parse.js";

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
  /** A specific work title to look for, e.g. "Death of the Virgin". Substring match against
   *  ConceptualWork.name, case-insensitive. When given, supportCount and sampleWorks reflect
   *  ONLY each artist's works whose title matches — this is the ADR-0010 Decision 4a K_work
   *  probe: "does the ACKG catalogue a work by this title, and to whom?" */
  workTitle?: string;
  /** Suppress every impression documented by this sale. Once an upcoming catalogue is
   *  ingested, a lot's own record is in the graph and the lot corroborates ITSELF: the
   *  catalogued dimensions "match" because they were copied from the same catalogue entry
   *  the object is being compared against. Measured on A0793/303 — an ingested
   *  "37.0x46.0cm" row turned Sonnet's CONTRADICTED into STRONG for one model and flipped
   *  the routing from Scenario 2 (authentication risk) to Scenario 3. Same circularity
   *  queryImageEmbeddingMatches and queryAuctionComparables already guard, on the price
   *  and image sides. */
  excludeSaleId?: string | null;
  /** Max candidates returned, ranked by supportCount descending. Defaults to 10. */
  limit?: number;
}

export type AckgProvenanceTag = "institutional" | "auction_history";

/** Parameters for queryAckgWorks — the ADR-0010 Decision 9.1 K_work probe. Unlike
 *  AckgQueryParams (an artist-population query), this aggregates per ConceptualWork and
 *  returns catalogued technique + dimension facts for a specific work. */
export interface AckgWorkQueryParams {
  /** Artist name, substring, case-insensitive. Strongly recommended — without it the
   *  title match ranges across every artist. */
  artist?: string;
  /** Work title fragment, substring, case-insensitive. A short distinctive core phrase
   *  matches best ("Death of the Virgin", not "The Death of the Virgin, first state"). */
  workTitle?: string;
  /** Optional technique / period narrowing (same semantics as AckgQueryParams). */
  technique?: string;
  periodStartYear?: number;
  periodEndYear?: number;
  /** Suppress every impression documented by this sale — see AckgQueryParams.excludeSaleId.
   *  This is the query where it matters most: a work whose ONLY impressions come from the
   *  sale under appraisal drops out entirely, which is correct — there is no independent
   *  record of it. */
  excludeSaleId?: string | null;
  /** Max works returned, ranked by impression count descending. Default 8. */
  limit?: number;
}

/** One catalogued ConceptualWork with its aggregated impression facts. Near-duplicate
 *  title nodes (the graph has un-merged re-ingests) come back as separate rows — the
 *  caller merges them. */
export interface AckgWorkMatch {
  workTitle: string;
  artistName: string;
  artistUlanUrl: string | null;
  dateLabel: string | null;
  /** Technique node names on this work's impressions, e.g. ["Etching", "Drypoint"]. */
  techniques: string[];
  /** Free-text media strings (Impression.rawMedium), deduped, capped at 3. */
  rawMediums: string[];
  plateDimsMm: DimMm[];
  imageDimsMm: DimMm[];
  sheetDimsMm: DimMm[];
  /** EditionRun.declaredSize values seen for this work. */
  editionSizes: number[];
  impressionCount: number;
  /** "institutional" and/or "auction_history". */
  provenanceLayers: AckgProvenanceTag[];
  /** gemini-embedding-001 vector for the (normalized) title — null until backfilled. */
  titleEmbedding: number[] | null;
  /** Populated by scoreWorkTitleMatches: rescaled 0..1 similarity to the observed title. */
  titleSim?: number;
  titleSimBasis?: "embedding" | "token" | "none";
}

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
   *  institutional (Tate, Met, British Museum) vs. auction-history (Bonhams, Roseberys,
   *  Forum Auctions, Skinner). */
  institutionalSupportCount: number;
  auctionSupportCount: number;
  /** Up to 3 sample work titles, for the calling agent to sanity-check the match. */
  sampleWorks: string[];
}
