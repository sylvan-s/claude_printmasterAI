/**
 * Normalize a print title before embedding (ADR-0010 Decision 9.1, Part B).
 *
 * Catalogue titles carry noise the embedding shouldn't have to fight: catalogue-raisonné
 * refs baked into the string ("(Bloch 330, Baer 377/II/B/a)"), trailing years, series
 * folder markers, smart quotes. Strip those to the core title, lowercased and
 * whitespace-collapsed, then embed that. Deliberately conservative — the embedding
 * tolerates series suffixes ("…, from The Empresses") on its own; over-stripping risks
 * collapsing genuinely distinct works.
 */

/** A trailing "(Word 123…)" that looks like a catalogue-raisonné reference:
 *  a capitalised author token, then a number, optionally with more refs after a
 *  ";" or ",". e.g. "(Bloch 330, Baer 377/II/B/a)", "(Herdman 5202)", "(Field 75-7M&L 514a)". */
const TRAILING_CAT_REF = /\s*\((?:[A-Z][A-Za-z&.'-]+\.?\s+)+[\dIVXLC][\w./&\s,;-]*\)\s*$/;
/** Trailing ", 2019" / " 2019" / "(2019)" year. */
const TRAILING_YEAR = /[\s,(]+(?:circa\s+|c\.?\s*)?(1[5-9]\d{2}|20[0-4]\d)\)?\s*$/i;
/** Leading list ordinal "4. " / "12) " (but NOT a fraction like "1/4 "). */
const LEADING_ORDINAL = /^\s*\d{1,3}[.)]\s+/;
/** Leading catalogue-number prefix: "H10-1. ", "H10-1 ", "10-1. " (Hirst H-numbers and similar). */
const LEADING_CAT_NUM = /^\s*[A-Za-z]{0,2}\s?\d{1,4}[-.]\d{1,3}[a-z]?\.?\s+/;
/** Trailing series / collection / portfolio attribution — a short distinctive title is
 *  dominated by a long shared suffix in the embedding ("Nur Jahan, from The Empresses" ~
 *  "Wu Zetian, from The Empresses" scores high). Strip it so the distinctive part carries.
 *  e.g. ", from The Empresses", " from the Suite Vollard", ", Portfolio II". */
const TRAILING_SERIES = /[,;:]?\s+(from|in|part of|plate\s+\d+\s+(from|of))\s+(the\s+)?[A-Za-z0-9][A-Za-z0-9\s'&.-]{1,45}$/i;
const TRAILING_PORTFOLIO = /[,;:]?\s+(portfolio|suite|series|set)\b[A-Za-z0-9\s'&.-]{0,30}$/i;

export function normalizeTitleForEmbedding(raw: string): string {
  let s = (raw ?? "").normalize("NFC");
  // unify quotes / dashes
  s = s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, "-");
  // strip wrapping quotes
  s = s.replace(/^["']+/, "").replace(/["']+$/, "");
  // peel trailing cat-refs / years / series suffixes (may be several)
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(TRAILING_CAT_REF, "")
      .replace(TRAILING_YEAR, "")
      .replace(TRAILING_SERIES, "")
      .replace(TRAILING_PORTFOLIO, "");
    if (s === before) break;
  }
  s = s.replace(LEADING_ORDINAL, "").replace(LEADING_CAT_NUM, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || (raw ?? "").trim().toLowerCase();
}

/** Cheap gate: an "Untitled" / bare-composition title carries almost no matchable
 *  signal — flag it so callers can fall back to technique/date rather than trust a
 *  title cosine that will be high against every other "Untitled". */
export function isLowInformationTitle(raw: string): boolean {
  const s = normalizeTitleForEmbedding(raw);
  return (
    s.length < 3 ||
    /^(untitled|no title|sans titre|ohne titel|senza titolo)\b/.test(s) ||
    /^(untitled )?(composition|abstract|plate|figure|study|print)( no\.? ?\d+)?$/.test(s)
  );
}
