/**
 * Cross-institution artist lookup — normalized shape.
 *
 * Text/metadata only, by design: nothing here fetches or processes image
 * bytes. See docs/adr/0002-image-extraction-methodology-and-licensing.md —
 * this sidesteps the image-license (CC-BY-NC-ND/SA) problem, but bare facts
 * (title, medium, dimensions, date) are what's safe to lean on; a source's
 * own descriptive prose should be treated as a fact source, not quoted.
 */

export type MuseumSource = "met" | "rijksmuseum" | "mds";

export interface MuseumRecord {
  source: MuseumSource;
  /** For MDS, the specific institution within the aggregator (e.g. "Ashmolean Museum"). */
  collection: string | null;
  recordUrl: string | null;
  title: string | null;
  /** Deliberately not populated with curatorial prose by any source (met.ts uses
   *  short categorical fields only; rijksmuseum.ts and mds.ts both null this out —
   *  see their module comments for the specific records that forced the call:
   *  a 2,345-char curatorial essay from Rijksmuseum, a 431-char one from MDS).
   *  Facts and figures only — no artwork descriptions, no images. */
  description: string | null;
  medium: string | null;
  dimensions: string | null;
  /** Inscription/signature text — in practice, where edition numbers ("12/50") show up. */
  inscription: string | null;
  date: string | null;
  artistAsCatalogued: string | null;
}

export interface SourceResult {
  source: MuseumSource;
  ok: boolean;
  /** Present when ok=false — e.g. missing API key, network error. */
  error?: string;
  records: MuseumRecord[];
}

export interface ArtistLookupResult {
  artist: string;
  /** What was actually sent to each source, after stripping honorifics/post-
   *  nominals (e.g. "Sir Terry Frost RA" -> "Terry Frost"). See relevance.ts. */
  queriedAs: string;
  sources: SourceResult[];
}
