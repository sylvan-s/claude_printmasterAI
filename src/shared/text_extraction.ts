/**
 * Deterministic regex extraction helpers for pulling structured fields out of
 * free-form art-related prose — dimensions, catalogue raisonné references,
 * edition fractions.
 *
 * Originally built in benchmark/src/roseberys/parse.ts for Roseberys'
 * <br>-delimited catalogue format (see ADR-0004). Moved here because the
 * *code* has no licensing constraint — only the *data* that module parses
 * does (Roseberys catalogue text/images; see docs/agents/benchmark.md) — so
 * both benchmark/ and src/appraisal/ (the Appraiser Input Agent) can share
 * it without pulling appraisal code into the benchmark module's licensing
 * boundary or vice versa.
 *
 * Deliberately NOT shared with benchmark/src/forum/parse.ts, which has its
 * own independent implementations tuned to Forum's different house format
 * (different dimension units, different field semantics) — see
 * docs/agents/benchmark.md on why Roseberys and Forum stay separate.
 */

/**
 * Post-nominals, honorifics and generational suffixes that turn up inside artist
 * name strings — "Laurence Stephen Lowry RBA RA", "Sir Frank Brangwyn RA",
 * "Henry Moore OM CH". Lowercase, punctuation-free; callers lowercase their own
 * tokens before testing membership.
 *
 * Shared rather than duplicated because the two consumers must agree on what is
 * NOT part of a person's name: `normalizeName()` in
 * src/appraisal/two_pass_attribution.ts (artist-identity matching) and the
 * blind-mode leak detectors in benchmark/src/{roseberys,forum}/parse.ts. Those
 * leak detectors previously took the last whitespace token of the artist header
 * as the surname, which on "Laurence Stephen Lowry RBA RA" yields "RA" — short
 * enough to fall through the length guard, so a catalogue body naming Lowry
 * three times passed a blind backtest with no warning at all.
 */
export const HONORIFICS: ReadonlySet<string> = new Set([
  "sir", "dame", "ra", "ara", "pra", "re", "are", "rws", "arws", "rba", "arba",
  "rsa", "rsw", "neac", "re.", "hon", "obe", "cbe", "mbe", "kt", "jr", "sr",
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
]);

/**
 * Nationality words that appear in artist headers ("Laurence Stephen Lowry RBA RA,
 * British 1887-1976"). Shared with `normalizeName()` in two_pass_attribution.ts for
 * the same reason as HONORIFICS.
 *
 * The leak detectors need these because Roseberys' comma-split artist line hands
 * "British" and "1937-2026" to `additionalArtists` as if they were co-artists — so
 * without this filter, any catalogue body containing the word "British" reads as a
 * surname leak. (Trade-off: an artist genuinely surnamed French or Fleming is not
 * leak-tested. Rarer than the false positive it prevents.)
 */
export const NATIONALITY_WORDS: ReadonlySet<string> = new Set([
  "british", "english", "scottish", "welsh", "irish", "french", "german", "dutch",
  "flemish", "italian", "spanish", "american", "japanese", "chinese", "korean",
  "swiss", "belgian", "austrian", "russian", "danish", "norwegian", "swedish",
  "czech", "polish", "hungarian", "mexican", "chilean", "brazilian", "canadian",
]);

/**
 * Minimum token length worth leak-testing against a catalogue body. Below this,
 * name fragments collide with ordinary catalogue words too often to be a usable
 * signal. Preserves the original detector's `length > 3` guard — which does mean
 * genuinely short surnames (Arp, Dix, Ray) are still not leak-tested.
 */
export const NAME_TOKEN_MIN_LENGTH = 4;

/**
 * The tokens of an artist name worth leak-testing against catalogue text: every
 * token, not just the last, with post-nominals, life dates, initials and stray
 * hand-typed metacharacters dropped. Original casing preserved, for a
 * case-insensitive word-boundary search.
 *
 * Callers should weight the LAST token (see `artistSurnameToken`) differently from
 * the rest. A surname in the body identifies the artist; a forename usually does
 * not, and matching forenames indiscriminately produces real false positives —
 * Roseberys A0777 lot 1 (Paul Gauguin) has "the Paul Kövesdy Gallery" in a
 * collection essay and never mentions Gauguin at all.
 */
export function artistNameLeakTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .split(/\s+/)
    // Descriptions are hand-typed, so tokens carry stray metacharacters; this
    // also strips digits, which drops life dates ("1887-1976") to punctuation.
    .map((t) => t.replace(/[^\p{L}\p{M}'-]/gu, ""))
    .filter((t) => {
      const lc = t.toLowerCase();
      return t.length >= NAME_TOKEN_MIN_LENGTH && !HONORIFICS.has(lc) && !NATIONALITY_WORDS.has(lc);
    });
}

/**
 * The identifying token of an artist name — the last one left after post-nominals
 * and initials are dropped. "Laurence Stephen Lowry RBA RA" -> "Lowry",
 * "Vincent van Gogh" -> "Gogh" ("van" is below the length floor).
 */
export function artistSurnameToken(name: string | null | undefined): string | null {
  const tokens = artistNameLeakTokens(name);
  return tokens.length ? tokens[tokens.length - 1] : null;
}

export interface Dimension {
  kind: string; // image | sheet | plate | overall | framed | diameter
  widthCm: number | null;
  heightCm: number | null;
  raw: string;
}

function toCm(value: number, unit: string): number {
  return /mm/i.test(unit) ? value / 10 : /\bin(ch(es)?)?\b/i.test(unit) ? value * 2.54 : value;
}

/** Matches lines like "image: 22 x 32cm" or "framed size: 45 x 60 cm". */
export function parseDimensions(lines: string[]): Dimension[] {
  const out: Dimension[] = [];
  const re =
    /(each\s+sheet|image|sheet|plate|overall|framed(?:\s+size)?|block|diameter|size)\s*:?\s*([\d.]+)\s*(?:x|×)\s*([\d.]+)\s*(cm|mm|in(?:ch(?:es)?)?)?/gi;
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const unit = m[4] || "cm";
      out.push({
        kind: m[1].toLowerCase().replace(/\s+/g, " "),
        widthCm: +toCm(parseFloat(m[2]), unit).toFixed(2),
        heightCm: +toCm(parseFloat(m[3]), unit).toFixed(2),
        raw: m[0].trim(),
      });
    }
  }
  return out;
}

/** Catalogue raisonné refs — e.g. [Bloch 1244], (Vallier 153), (Danilowitz 173.9). */
export function extractCatalogueRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/[\[(]\s*([A-Z][A-Za-z&.\s]{2,25}?\s+[\dIVX][\d.\-IVX]*)\s*[\])]/g)) {
    refs.add(m[1].replace(/\s+/g, " ").trim());
  }
  return [...refs];
}

/** Edition size from "edition of 100" or a fraction like "45/100" -> 100. */
export function detectEditionSize(text: string): number | null {
  const m = text.match(/edition\s+of\s+(\d+)/i) ?? text.match(/\b\d+\s*\/\s*(\d+)\b/);
  return m ? Number(m[1]) : null;
}
