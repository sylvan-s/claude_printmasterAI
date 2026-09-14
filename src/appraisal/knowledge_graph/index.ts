export { queryAckg, queryAckgWorks, scoreWorkTitleMatches, queryArtistStyleConsistency } from "./query.js";
export type { ArtistStyleConsistency } from "./query.js";
export { queryImageEmbeddingMatches, getStoredImageVectors } from "./query_image_similarity.js";
export { queryAuctionComparables, parseExcludedListing } from "./query_comparables.js";
export { resolveWorkIdentity, fetchArtistWorks, titleIdentityKey, titleIdentityKeyNoSeries, isIdentifyingTitle, citationsInTitle, citationsInRefs, foldPrefix } from "./work_identity.js";
export type { WorkIdentity, WorkIdentityBasis, Citation } from "./work_identity.js";
export { queryCatalogueRaisonneForArtist, formatCatalogueRaisonneBlock, recordCatalogueRaisonneFinding, MIN_WORKS_FOR_DERIVED_CR } from "./catalogue_raisonne.js";
export { queryEditionRuns, formatEditionRunsForClaude, EDITION_DEFAULT_LIMIT } from "./edition_runs.js";
export { resolveArtistIdentity, formatArtistIdentity, canonicalArtistForQuery } from "./artist_identity.js";
export { queryArtistDinoFloor } from "./artist_dino_floor.js";
export { queryArtistPriceProfile, adjustmentBetween, editionBand, areaBand, periodOf, nationalityGroup, segmentKey, pickSegmentDefault, multipliersFrom } from "./artist_price_profile.js";
export type { ArtistPriceProfile, PriceAttrs, PriceAdjustment, PriceProfileBasis, SignatureClass, ProofClass, EditionBand, AreaBand } from "./artist_price_profile.js";
export { priceAttrsOfComparable, priceAttrsOfLot, signatureClass, proofClass, editionSizeOf, dimsCm, primaryProcess, PROCESSES } from "./price_attrs.js";
export { queryWorkFacts } from "./query_work_facts.js";
export { writeResearchComps, queryResearchComps, gateComp, researchCompId, normaliseSaleDate, WRITEABLE_WORK_BASES } from "./write_research_comps.js";
export type { WriteResearchCompsInput, WriteResearchCompsResult, ResearchComp, CompGateResult, CompRejection, RecordedPriceBasis } from "./write_research_comps.js";
export { isTypoVariant, isSurnameTypoVariant, isDesignatorToken, osaDistanceAtMost } from "./typo_tolerance.js";
export type { WorkFacts } from "./query_work_facts.js";
export { lookupArtistNames } from "./artist_lookup.js";
export type { ArtistLookup, ArtistLookupVia } from "./artist_lookup.js";
export type { ArtistDinoFloor } from "./artist_dino_floor.js";
export type { ArtistIdentity } from "./artist_identity.js";
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
