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

export async function lookupArtistAcrossMuseums(artist: string): Promise<ArtistLookupResult> {
  const sources = await Promise.all([lookupMet(artist), lookupRijksmuseum(artist), lookupMds(artist)]);
  return { artist, sources };
}

export type { ArtistLookupResult, MuseumRecord, SourceResult, MuseumSource } from "./types.js";
