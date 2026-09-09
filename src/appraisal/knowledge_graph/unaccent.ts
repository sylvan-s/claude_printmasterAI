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
