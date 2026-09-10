export { queryAckg, queryAckgWorks, scoreWorkTitleMatches, queryArtistStyleConsistency } from "./query.js";
export type { ArtistStyleConsistency } from "./query.js";
export { queryImageEmbeddingMatches, getStoredImageVectors } from "./query_image_similarity.js";
export { queryAuctionComparables, parseExcludedListing } from "./query_comparables.js";
export { queryCatalogueRaisonneForArtist, formatCatalogueRaisonneBlock, recordCatalogueRaisonneFinding, MIN_WORKS_FOR_DERIVED_CR } from "./catalogue_raisonne.js";
export { queryEditionRuns, formatEditionRunsForClaude, EDITION_DEFAULT_LIMIT } from "./edition_runs.js";
export type { EditionQueryResult, EditionQueryParams, EditionWorkFact, CopyType } from "./edition_runs.js";
export type { ArtistCatalogueRaisonne, CatalogueRaisonneRef, CatalogueRaisonneFinding, CatalogueRaisonneWriteOutcome } from "./catalogue_raisonne.js";
export type { AuctionComparable, ComparablesSummary, ComparablesResult, ComparablesParams, ComparableTier } from "./query_comparables.js";
export { closeDriver } from "./client.js";
export { parseAckgDimMm } from "./dimension_parse.js";
export { normalizeTitleForEmbedding, isLowInformationTitle } from "./title_normalize.js";
export { foldAccents, normalizeTitleKey, cypherNormalizeTitle } from "./unaccent.js";
export { embedText, embedTexts, cosine, titleSimFromCosine, TITLE_EMBED_MODEL } from "./embed_text.js";
export type { DimMm } from "./dimension_parse.js";
export type {
  AckgQueryParams,
  AckgCandidate,
  AckgProvenanceTag,
  AckgWorkQueryParams,
  AckgWorkMatch,
} from "./types.js";
