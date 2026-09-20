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
  "sir", "dame", "ra", "ara", "pra", "prba", "re", "are", "rws", "arws", "rba", "arba",
  "rsa", "rsw", "neac", "re.", "hon", "obe", "cbe", "mbe", "dbe", "kt", "jr", "sr",
  // Added 2026-09-20 (ROSEBERYS-HEADER-1.0): Roseberys writes these into the artist line
  // ("David Hockney, OM CH RA, British 1937-2026"), where an unrecognised post-nominal
  // block reads as a co-artist. Seen in A0793: OM, CH, RDI, PRA, DBE, RP.
  "om", "ch", "rdi", "rp", "frsa", "rcm",
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
  // Added 2026-09-20 (ROSEBERYS-HEADER-1.0), all observed in A0793's artist lines.
  "bulgarian", "portuguese", "greek", "turkish", "israeli", "indian", "australian",
  "argentine", "argentinian", "cuban", "colombian", "peruvian", "icelandic",
  "finnish", "romanian", "serbian", "croatian", "ukrainian", "iranian", "egyptian",
  "nigerian", "ghanaian", "kenyan", "jamaican", "venezuelan", "uruguayan",
  "cypriot", "latvian", "lithuanian", "estonian", "slovak", "slovenian",
  "catalan", "basque", "moroccan", "algerian", "tunisian",
]);

/**
 * Demonyms written as two words. Kept separate from NATIONALITY_WORDS because the
 * header splitter has to match them BEFORE it decides a two-word token is a person's
 * name — "South African" and "New Zealand" are otherwise indistinguishable in shape
 * from "Kate Garner". Lowercase, single-spaced.
 */
export const NATIONALITY_PHRASES: ReadonlySet<string> = new Set([
  "south african", "new zealand", "sri lankan", "south korean", "north american",
  "south american", "puerto rican", "costa rican", "hong kong", "saudi arabian",
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
/**
 * Decode HTML entities in catalogue text.
 *
 * Auction HTML is full of them and a partial decoder is worse than none, because what survives
 * is a plausible-looking string that silently fails every exact match downstream. Measured on
 * Roseberys A0793: the sale screen resolved 263 of 268 artists, and four of the five misses were
 * this — "Salvador Dal&iacute;" and "Andr&eacute; Bic&acirc;t" reaching `resolveArtistIdentity`
 * with the entity intact and matching nothing, though both artists are in the graph (Dalí with
 * 990 works). The previous decoder was an allowlist of nine accented letters, and the two that
 * mattered were not on it.
 *
 * So: the full Latin-1 letter set rather than the ones someone happened to hit, plus decimal and
 * hexadecimal numeric references, plus the punctuation that auction descriptions actually use.
 * `&amp;` is decoded LAST so that an escaped entity (`&amp;eacute;`) becomes the literal text
 * `&eacute;` rather than being decoded twice into a letter that was never there.
 */
const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", deg: "\u00b0", times: "\u00d7",
  laquo: "\u00ab", raquo: "\u00bb", middot: "\u00b7", bull: "\u2022", dagger: "\u2020",
  frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", pound: "\u00a3", euro: "\u20ac", cent: "\u00a2",
  agrave: "\u00e0", aacute: "\u00e1", acirc: "\u00e2", atilde: "\u00e3", auml: "\u00e4", aring: "\u00e5", aelig: "\u00e6",
  ccedil: "\u00e7", egrave: "\u00e8", eacute: "\u00e9", ecirc: "\u00ea", euml: "\u00eb",
  igrave: "\u00ec", iacute: "\u00ed", icirc: "\u00ee", iuml: "\u00ef",
  ntilde: "\u00f1", ograve: "\u00f2", oacute: "\u00f3", ocirc: "\u00f4", otilde: "\u00f5", ouml: "\u00f6", oslash: "\u00f8",
  ugrave: "\u00f9", uacute: "\u00fa", ucirc: "\u00fb", uuml: "\u00fc", yacute: "\u00fd", yuml: "\u00ff", szlig: "\u00df",
  Agrave: "\u00c0", Aacute: "\u00c1", Acirc: "\u00c2", Atilde: "\u00c3", Auml: "\u00c4", Aring: "\u00c5", AElig: "\u00c6",
  Ccedil: "\u00c7", Egrave: "\u00c8", Eacute: "\u00c9", Ecirc: "\u00ca", Euml: "\u00cb",
  Igrave: "\u00cc", Iacute: "\u00cd", Icirc: "\u00ce", Iuml: "\u00cf",
  Ntilde: "\u00d1", Ograve: "\u00d2", Oacute: "\u00d3", Ocirc: "\u00d4", Otilde: "\u00d5", Ouml: "\u00d6", Oslash: "\u00d8",
  Ugrave: "\u00d9", Uacute: "\u00da", Ucirc: "\u00db", Uuml: "\u00dc", Yacute: "\u00dd",
};

export function decodeHtmlEntities(input: string): string {
  if (!input || !input.includes("&")) return input;
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name) => (name in HTML_ENTITIES ? HTML_ENTITIES[name] : m))
    .replace(/&amp;/g, "&");
}

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
  // A page-cited catalogue ("Czwiklitzer p.437", "Littmann p. 93") is a real citation: some
  // catalogues raisonnés number by page, not by entry. Forum's Picasso posters are cited that
  // way, and without the optional marker the reference stayed in the title and no CatalogueEntry
  // was ever made (A0793/305). catalogue_matching.py moves the marker onto the entry number.
  for (const m of text.matchAll(/[\[(]\s*([A-Z][A-Za-z&.\s]{2,25}?\s+(?:pp?\.\s*)?[\dIVX][\d.\-IVX]*)\s*[\])]/g)) {
    refs.add(m[1].replace(/\s+/g, " ").trim());
  }
  return [...refs];
}

/**
 * Edition size from "numbered n/N", else "edition of N" — the order train_price_model.py and
 * price_attrs.ts use, so "numbered 12/50 (there was also an unsigned edition of 500)" is 50 here
 * too. A bare "n/N" is NOT enough: in catalogue text it is almost always an imperial fraction
 * ("25 1/2in"), which read as editions of 2/4/8/16 on ~1,500 priced Forum and Roseberys sales
 * before the 2026-09-17 repair.
 */
export function detectEditionSize(text: string): number | null {
  const m = text.match(/\b(?:numbered|no\.)\s*(?:in pencil\s*)?['"\u2018\u2019\u201C\u201D]?\d+\s*\/\s*(\d{1,3}(?:,\d{3})+|\d+)\b(?!\s*(?:mm\b|cm\b|["\u201D]))/i)
    ?? text.match(/edition\s+of\s+(\d{1,3}(?:,\d{3})+|\d+)/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;   // "edition of 1,000" is 1000, not 1
}
