/**
 * Cross-institution artist lookup for the Specialist Attribution stage.
 *
 * Text/metadata only — see types.ts header. Queries Met, Rijksmuseum, and MDS
 * in parallel; one source failing (e.g. no Rijksmuseum key configured) never
 * blocks the others, since a partial result is still useful to the agent.
 */
import type { ArtistLookupResult } from "./types.js";
import { lookupMet } from "./met.js";
import { lookupMds } from "./mds.js";
import { lookupRijksmuseum } from "./rijksmuseum.js";
import { cleanArtistQuery } from "./relevance.js";

export async function lookupArtistAcrossMuseums(artist: string): Promise<ArtistLookupResult> {
  const queriedAs = cleanArtistQuery(artist);
  const sources = await Promise.all([
    lookupMet(queriedAs),
    lookupRijksmuseum(queriedAs),
    lookupMds(queriedAs),
  ]);
  return { artist, queriedAs, sources };
}

export type { ArtistLookupResult, MuseumRecord, SourceResult, MuseumSource } from "./types.js";
