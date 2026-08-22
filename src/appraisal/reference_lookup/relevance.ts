/**
 * Shared relevance filter — both Met's `q` search and MDS's `q` search are
 * broad full-text matches, not scoped to the artist/maker field. Confirmed
 * live on two separate false-positive cases:
 *   - MDS "James McNeill Whistler": 612 raw hits, only 305 actually had him
 *     as the catalogued maker.
 *   - Met "Hassia": both hits were false positives — "Hassia" is the Latin
 *     name for Hesse, matching a place reference, not an artist named Hassia.
 *
 * A plain surname-substring check on the catalogued maker field, not a full
 * fix — still worth watching on common surnames or unusual name orderings.
 */
export function matchesArtist(catalogued: string | null | undefined, queryArtist: string): boolean {
  if (!catalogued) return false;
  const tokens = queryArtist.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!tokens.length) return false;
  const surname = tokens[tokens.length - 1];
  return catalogued.toLowerCase().includes(surname);
}
