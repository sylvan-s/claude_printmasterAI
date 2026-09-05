export { queryAckg, queryAckgWorks, scoreWorkTitleMatches } from "./query.js";
export { queryImageEmbeddingMatches, getStoredImageVectors } from "./query_image_similarity.js";
export { closeDriver } from "./client.js";
export { parseAckgDimMm } from "./dimension_parse.js";
export { normalizeTitleForEmbedding, isLowInformationTitle } from "./title_normalize.js";
export { embedText, embedTexts, cosine, titleSimFromCosine, TITLE_EMBED_MODEL } from "./embed_text.js";
export type { DimMm } from "./dimension_parse.js";
export type {
  AckgQueryParams,
  AckgCandidate,
  AckgProvenanceTag,
  AckgWorkQueryParams,
  AckgWorkMatch,
} from "./types.js";
