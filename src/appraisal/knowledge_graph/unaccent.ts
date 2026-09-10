/**
 * Accent-insensitive matching for ACKG string comparisons.
 *
 * `toLower()` does not fold diacritics, and the ACKG is full of French, so every
 * `toLower(x) = toLower($y)` title comparison in this codebase silently missed accented
 * titles. Measured on Roseberys A0793 lot 303 (2026-09-09): Stage 2b asked for
 * "Peintre et Modele", the graph holds "Peintre et Modèle", and SIX matching Picasso works
 * carrying declared edition sizes (50 / 150 / 30) returned nothing at all.
 *
 * The same defect sits in `queryAuctionComparables`' tier-1 title match, where it is worse:
 * tier 1 is the same_work tier, the single strongest comparable available to a valuation,
 * and it was being suppressed on every accented title.
 *
 * Neo4j cannot fold accents natively and APOC is not installed on this instance
 * (`apoc.meta.cypher.type` is unavailable), so the fold is done explicitly on both sides:
 *
 *   TS side     `foldAccents()` normalises the caller's search string before it is sent.
 *   Cypher side `cypherFold()` builds a nested `replace()` chain over the stored property.
 *
 * Both read from ONE table, so the two sides cannot drift apart — the failure mode where a
 * query folds its input differently from the graph it is matching against is exactly the
 * kind of silent miss this module exists to remove.
 *
 * NFD normalisation alone is not enough: it decomposes é into e + combining acute, but ø,
 * æ, œ, ß, ð, đ and ł are single indivisible codepoints that no amount of normalising will
 * reduce. They need the explicit mappings below, which is the other reason for a shared
 * table rather than a one-line regex.
 *
 * This is for MATCHING only. Nothing here is stored, and no folded value is ever written
 * back to the graph or used to merge catalogue identity.
 */

/**
 * Lowercase source → ASCII replacement. Applied after `toLower`, so uppercase forms need no
 * entry. Multi-character expansions (æ→ae) must be identical on both sides, which is why
 * they live here rather than in a regex.
 */
export const ACCENT_FOLD: ReadonlyArray<readonly [string, string]> = [
  ["à", "a"], ["á", "a"], ["â", "a"], ["ã", "a"], ["ä", "a"], ["å", "a"], ["ā", "a"],
  ["æ", "ae"],
  ["ç", "c"], ["ć", "c"], ["č", "c"],
  ["è", "e"], ["é", "e"], ["ê", "e"], ["ë", "e"], ["ē", "e"], ["ę", "e"],
  ["ì", "i"], ["í", "i"], ["î", "i"], ["ï", "i"], ["ī", "i"],
  ["ñ", "n"], ["ń", "n"],
  ["ò", "o"], ["ó", "o"], ["ô", "o"], ["õ", "o"], ["ö", "o"], ["ø", "o"], ["ō", "o"],
  ["œ", "oe"],
  ["ù", "u"], ["ú", "u"], ["û", "u"], ["ü", "u"], ["ū", "u"],
  ["ý", "y"], ["ÿ", "y"],
  ["ß", "ss"],
  ["ð", "d"], ["đ", "d"],
  ["ł", "l"],
  ["š", "s"], ["ś", "s"],
  ["ž", "z"], ["ź", "z"], ["ż", "z"],
  ["ř", "r"],
  ["ť", "t"],
  ["þ", "th"],
];

/**
 * Fold a caller-supplied search string to lowercase ASCII. NFD strips the combining marks
 * that decompose; the table handles the codepoints that do not.
 */
export function foldAccents(input: string): string {
  let s = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [from, to] of ACCENT_FOLD) s = s.split(from).join(to);
  return s;
}

/**
 * Build a Cypher expression folding a stored string property the same way `foldAccents`
 * folds the parameter it will be compared against.
 *
 * `cypherFold("cw.name")` →
 *   `replace(replace(toLower(cw.name),'à','a'),'á','a')…`
 *
 * The chain is long but constant-folded once at module load, and these queries are already
 * scanning one artist's works rather than using a text index on the raw property — so this
 * costs nothing that was being saved before.
 */
export function cypherFold(expr: string): string {
  let out = `toLower(${expr})`;
  for (const [from, to] of ACCENT_FOLD) out = `replace(${out},'${from}','${to}')`;
  return out;
}

/** `cypherFold` over a trimmed property — the common case for title comparison. */
export function cypherFoldTrim(expr: string): string {
  return cypherFold(`trim(${expr})`);
}

/**
 * Punctuation stripped before comparing two titles for identity.
 *
 * Measured on the live graph 2026-09-10: 27,267 ConceptualWork nodes — 29.9% of all works —
 * are redundant, in the sense that another work by the SAME artist has a byte-identical
 * title once case, accents, punctuation and whitespace are folded. Real examples:
 *
 *   "'Durham Wharf'"             vs  "Durham Wharf"
 *   "The Lock-Keeper's Cottage"  vs  "The Lock Keeper’s Cottage"     ASCII vs curly apostrophe
 *   "Blue Brown Interweave"      vs  "Blue & Brown Interweave"
 *   "Rythmes Couleurs"           vs  "Rythmes-couleurs"
 *
 * That fragmentation is why queryAuctionComparables' tier-1 same_work match — the strongest
 * comparable a valuation gets — finds only a fraction of a work's own sales: the impressions
 * are split across variant-titled nodes. Folding at query time recovers them without writing
 * anything to the graph.
 *
 * This is still EXACT matching, not fuzzy: two titles collide only if identical after a
 * deterministic fold. No threshold, no similarity score, so the project's standing rule
 * against fuzzy catalogue-identity matching is untouched.
 *
 * Enumerated rather than a character class because Cypher has no regex replace and APOC is
 * not installed — the chain below is generated for both sides of the comparison.
 */
export const TITLE_PUNCTUATION: ReadonlyArray<string> = [
  ".", ",", ";", ":", "!", "?", "'", "\u2019", "\u2018", '"', "\u201c", "\u201d",
  "(", ")", "[", "]", "{", "}", "-", "\u2013", "\u2014", "_", "/", "\\", "&", "+",
  "*", "#", "@", "|", "<", ">", "=", "~", "\u00b4", "\u0060",
];

/** Fold a title to its identity key: lowercase, unaccented, unpunctuated, single-spaced. */
export function normalizeTitleKey(input: string): string {
  let s = foldAccents(input);
  for (const p of TITLE_PUNCTUATION) s = s.split(p).join(" ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Cypher expression folding a stored title the same way `normalizeTitleKey` folds the
 * parameter it is compared against. Whitespace is collapsed by a fixed number of passes
 * rather than a regex — enough for the longest run of punctuation observed in the corpus.
 */
export function cypherNormalizeTitle(expr: string): string {
  // A Cypher single-quoted literal escapes backslash and apostrophe with a backslash.
  // Getting this wrong does not fail loudly at the character — an unescaped backslash ends
  // the literal early and corrupts the rest of the query, which surfaces as a syntax error
  // pointing at an unrelated line.
  const lit = (c: string) => c.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let out = cypherFold(`trim(${expr})`);
  for (const p of TITLE_PUNCTUATION) out = `replace(${out},'${lit(p)}',' ')`;
  for (let i = 0; i < 4; i++) out = `replace(${out},'  ',' ')`;
  return `trim(${out})`;
}
