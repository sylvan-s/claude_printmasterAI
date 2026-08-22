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

const LEADING_HONORIFICS = /^(sir|dame|lord|lady|dr|mr|mrs|ms|miss|madame|monsieur|professor|prof)\.?\s+/i;
// Trailing post-nominals: short all-caps tokens (RA, CBE, OM, RBA...), same
// rule the project's own filename artist-parser already uses (CLAUDE.md).
const TRAILING_POSTNOMINAL = /(\s+[A-Z]{1,4})+$/;

/**
 * Roseberys' own artist field is full of "Sir Terry Frost RA" / "Dame ..."
 * style names — literal full-text search against Met/MDS breaks on these
 * exactly like it did on "Madame Hassia" (which found zero results; "Hassia"
 * alone found the artist, confirming the honorific was the problem, not an
 * absence of holdings). Strip both before querying.
 */
export function cleanArtistQuery(name: string): string {
  return name.replace(LEADING_HONORIFICS, "").replace(TRAILING_POSTNOMINAL, "").trim();
}
