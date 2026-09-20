/**
 * Catalogue-description parser.
 *
 * This is the shared engine: it powers BOTH the Roseberys search extract and the
 * benchmark corpus. Roseberys' descriptions are a single prose blob, which is why
 * their site search can't tell "a print BY Picasso" from "a folio that MENTIONS
 * Picasso". Giving that blob structure fixes both problems at once.
 *
 * Observed house format (<br>-delimited):
 *
 *   Pablo Picasso,
 *   Spanish 1881-1973,
 *
 *   1st illustration from Le Cocu Magnifique [Bloch 1244], 1968;
 *
 *   etching on BFK Rives wove,
 *   from the edition of 200,
 *   printed by Editions Crommelynck, Paris,
 *   published by Editions Crommelynck, Paris,
 *   image: 22 x 32cm,
 *   (framed)
 *   (ARR)
 *
 *   Provenance
 *   A Private Collector of Art & Studio Pottery
 *
 * The format is consistent but not guaranteed — every extractor below degrades to
 * null rather than guessing.
 */

import type { Dimension } from "../../../src/shared/text_extraction";
import { parseDimensions, extractCatalogueRefs, detectEditionSize, artistNameLeakTokens, artistSurnameToken, decodeHtmlEntities, HONORIFICS, NATIONALITY_WORDS, NATIONALITY_PHRASES } from "../../../src/shared/text_extraction";

// Re-exported for anything importing these from this module directly — the
// canonical implementations now live in src/shared/text_extraction.ts since
// they're shared with the Appraiser Input Agent (see ADR-0004). Forum's
// parser (benchmark/src/forum/parse.ts) keeps its own independent copies —
// deliberately not merged, see docs/agents/benchmark.md.
export type { Dimension };
export { parseDimensions, extractCatalogueRefs };

export type ArtistQualifier =
  | "certain" | "attributed" | "circle" | "studio" | "follower" | "after" | "unknown";

export interface ParsedLot {
  artist: string | null;
  artistQualifier: ArtistQualifier;
  /** Multiple names on the artist line (e.g. a Cocteau folio illustrated by Picasso). */
  additionalArtists: string[];
  nationality: string | null;
  lifeDates: string | null;
  title: string | null;
  year: string | null;
  medium: string | null;
  support: string | null;
  dimensions: Dimension[];
  edition: string | null;
  editionSize: number | null;
  signed: boolean;
  inscriptions: string | null;
  printer: string | null;
  publisher: string | null;
  catalogueRefs: string[];
  framed: boolean;
  provenance: string | null;
  /** Condition notes. Regex never populates this — filled only by the LLM fallback. */
  condition: string | null;
  /** Lot contains more than one artwork — excluded from the benchmark. */
  isMultiWork: boolean;
  multiWorkReason: string | null;
  /** Body lines that would reveal the artist in a blind-mode benchmark run. */
  leakRisks: string[];
  bodyLines: string[];
}

/* ------------------------------------------------------------------ helpers */

export function htmlToLines(html: string): string[] {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // Was a nine-letter allowlist; "&iacute;" and "&acirc;" were not on it, so Dalí and Bicât
    // reached the graph with the entity intact and matched nothing. See decodeHtmlEntities.
    .split("\n")
    .map(decodeHtmlEntities)
    .join("\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

const QUALIFIERS: [RegExp, ArtistQualifier][] = [
  [/\battributed\s+to\b/i, "attributed"],
  [/\bcircle\s+of\b/i, "circle"],
  [/\bstudio\s+of\b/i, "studio"],
  [/\bfollower\s+of\b/i, "follower"],
  [/\bmanner\s+of\b/i, "manner" as ArtistQualifier],
  [/\bafter\b/i, "after"],
];

function detectQualifier(line: string): ArtistQualifier {
  for (const [re, q] of QUALIFIERS) if (re.test(line)) return q;
  return "certain";
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MULTIWORK_PATTERNS: [RegExp, string][] = [
  [/\ba\s+pair\b/i, "a pair"],
  [/\b(?:two|2)\s+works\b/i, "2 works"],
  [/\b(?:three|3)\s+works\b/i, "3 works"],
  [/\b(?:four|4)\s+works\b/i, "4 works"],
  [/\ba\s+set\s+of\s+\w+/i, "a set of"],
  [/\ba\s+group\s+of\s+\w+/i, "a group of"],
  [/\btogether\s+with\b/i, "together with"],
  [/\band\s+another\b/i, "and another"],
  [/\bportfolio\s+of\s+\w+/i, "portfolio of"],
  [/\bthe\s+complete\s+(?:set|portfolio|suite)\b/i, "complete set"],
  [/\((?:2|3|4|5|6|7|8|9|\d{2})\)\s*$/m, "trailing (n)"],
];

export function detectMultiWork(text: string): { isMultiWork: boolean; reason: string | null } {
  for (const [re, label] of MULTIWORK_PATTERNS) {
    if (re.test(text)) return { isMultiWork: true, reason: label };
  }
  return { isMultiWork: false, reason: null };
}



/* ---------------------------------------------- artist header (ROSEBERYS-HEADER-1.0) */

/**
 * The artist block, however Roseberys chose to lay it out.
 *
 * The house format puts the name on line 0 and "<nationality> <life dates>" on line 1, but
 * a third of A0793's lots put some or all of that metadata on line 0 instead, comma-separated:
 *
 *   Giorgio de Chirico,  Italian, 1888-1978        <- nationality and dates on the artist line
 *   David Hockney, OM CH RA, British 1937-2026     <- post-nominals too
 *   Edd Pearman, British 21st Century              <- a century where the dates would go
 *
 * `parseDescription` used to split line 0 on commas and call everything after the first
 * element a co-artist, so "Italian" and "1888-1978" became `additionalArtists` — which blanked
 * `nationality`/`lifeDates` AND made the lot look like a multi-artist lot to every consumer
 * that counts them (170 of A0793's 533 lots; it is what excluded lot 320 from the
 * attributed-lot population entirely).
 *
 * The rule: peel metadata off the END of each comma element — life dates, then nationality,
 * then post-nominals, in the order the house writes them — and keep whatever prose is left as
 * a name. Genuine co-artists ("Russell Young, British, b.1959 and Kate Garner") survive
 * because a real name is never consumed by any of the three peels.
 */

/** Life dates as Roseberys writes them: "1888-1978", "b.1963", "b. 1965", "1937-", "d.1990". */
const LIFE_DATES_RE = /(?:^|\s)((?:[bdc]\.?\s*)?\d{4}\s*(?:[-\u2013\u2014]\s*\d{0,4})?)\s*$/i;

/** The house's stand-in for dates on a living or undated artist: "21st Century", "20th/21st Century". */
const CENTURY_RE = /(?:^|\s)(\d{1,2}(?:st|nd|rd|th)(?:\s*\/\s*\d{1,2}(?:st|nd|rd|th))?\s+century)\s*$/i;

const stripEdgePunct = (t: string) => t.replace(/^[\s,;]+|[\s,;]+$/g, "");

/** "British", "French/ Hungarian", "South African" — but not "Kate Garner". */
export function isNationalityToken(t: string): boolean {
  // Periods survive here because the house types them: "Terry O'Neill, British. 1938-2019".
  const s = stripEdgePunct(t).toLowerCase().replace(/\s*\/\s*/g, "/").replace(/\./g, "");
  if (!s) return false;
  if (NATIONALITY_PHRASES.has(s)) return true;
  const parts = s.split(/[/-]/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((x) => NATIONALITY_WORDS.has(x));
}

/** A run of post-nominals and nothing else: "RA", "OM CH RA", "CBE RDI RA". */
export function isHonorificToken(t: string): boolean {
  const parts = stripEdgePunct(t).split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((x) => HONORIFICS.has(x.toLowerCase().replace(/\./g, "")));
}

interface Peeled { rest: string; nationality: string | null; lifeDates: string | null }

/**
 * Peel "<name> <post-nominals> <nationality> <dates>" back to the name, right to left.
 *
 * `guardNationality` is set for the FIRST comma element, the one that holds the artist's name.
 * There, a trailing demonym is only metadata when something else in the same element says so —
 * life dates, or the closing bracket of an alias ("Weegee (Arthur Fellig) Polish"). Without
 * that guard "John French" loses its surname, because French is also a nationality.
 */
function peelHeaderToken(token: string, guardNationality = false): Peeled {
  // Roseberys writes compound nationalities with spaces around the slash ("Austrian / American");
  // closing it up first keeps the compound as one word for the word-wise peel below.
  let rest = stripEdgePunct(token).replace(/\s*\/\s*/g, "/").replace(/\.$/, "");
  let nationality: string | null = null;
  let lifeDates: string | null = null;

  const dm = rest.match(LIFE_DATES_RE) ?? rest.match(CENTURY_RE);
  if (dm) {
    lifeDates = dm[1].replace(/\s+/g, " ").trim();
    rest = stripEdgePunct(rest.slice(0, rest.length - dm[0].length));
  }

  // Nationality is one or two words; try the longer form first so "South African" is not
  // read as the single word "African" preceded by a name.
  const words = rest.split(/\s+/).filter(Boolean);
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const cand = words.slice(words.length - n).join(" ");
    if (!isNationalityToken(cand)) continue;
    const before = stripEdgePunct(words.slice(0, words.length - n).join(" "));
    if (guardNationality && !lifeDates && !/\)$/.test(before)) break;
    nationality = cand.replace(/\./g, "");
    rest = before;
    break;
  }

  // Trailing post-nominals, which sit between the name and the nationality. Only on the
  // metadata elements: the artist's own name KEEPS its post-nominals, because that is the
  // string the rest of the pipeline matches on and the leak detector's surname guard is
  // asserted against it (tests/benchmark_parse/leak_detection_tests.ts, A0793/46 Lowry).
  if (!guardNationality) {
    let tail = rest.split(/\s+/).filter(Boolean);
    while (tail.length > 1 && HONORIFICS.has(tail[tail.length - 1].toLowerCase().replace(/\./g, ""))) {
      tail = tail.slice(0, -1);
    }
    rest = stripEdgePunct(tail.join(" "));
  }

  return { rest, nationality, lifeDates };
}

export interface ArtistHeader { names: string[]; nationality: string | null; lifeDates: string | null }

export function splitArtistHeader(artistLine: string): ArtistHeader {
  const cleaned = stripEdgePunct(artistLine)
    .replace(/\b(attributed to|circle of|studio of|follower of|manner of|after)\b/gi, "");
  const names: string[] = [];
  let nationality: string | null = null;
  let lifeDates: string | null = null;

  const tokens = cleaned.split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const p = peelHeaderToken(tokens[i], i === 0);
    if (nationality && p.nationality && p.nationality.startsWith("/")) nationality += p.nationality;
    else nationality ??= p.nationality;
    lifeDates ??= p.lifeDates;
    // A co-artist can be introduced by the conjunction that followed the dates we just
    // removed ("b.1959 and Kate Garner"); the leading "and" is not part of the name.
    const rest = stripEdgePunct(p.rest.replace(/^(?:\s*(?:&|and)\s+)/i, ""));
    if (!rest) continue;
    // The first element is the artist even when it carries metadata; later elements that
    // are nothing but post-nominals are metadata, not people.
    if (i > 0 && isHonorificToken(rest)) continue;
    // "Mr Doodle, (Sam Cox)" — a bracketed element is the preceding name's alias. Most lots
    // write it inline ("Hera (Jasmin Siddiqui) German"); a comma before it does not make it
    // a second artist.
    if (i > 0 && names.length && /^\(.*\)$/.test(rest)) { names[names.length - 1] += ` ${rest}`; continue; }
    names.push(rest);
  }
  return { names, nationality, lifeDates };
}

/** Is this line the house's dedicated nationality/life-dates line, rather than the title? */
function nationalityLine(line: string): { nationality: string | null; lifeDates: string | null } | null {
  const t = stripEdgePunct(line);
  if (!t) return null;
  const p = peelHeaderToken(t);
  if (!p.nationality && !p.lifeDates) return null;
  // Anything left over means this line is prose that merely ends in a year — a title such as
  // "Beautiful inside my head forever, 2008", which used to be read as a nationality line and
  // then pushed the real title selection one line too far down the record.
  if (p.rest && !isHonorificToken(p.rest)) return null;
  return { nationality: p.nationality, lifeDates: p.lifeDates };
}

/* -------------------------------------------------------------------- parse */

export function parseDescription(html: string): ParsedLot {
  const lines = htmlToLines(html);
  const full = lines.join("\n");

  // Provenance splits the record; everything before it is catalogue proper.
  const provIdx = lines.findIndex((l) => /^provenance\b/i.test(l));
  const head = provIdx >= 0 ? lines.slice(0, provIdx) : lines;
  const provenance =
    provIdx >= 0 ? lines.slice(provIdx + 1).join(" ").trim() || null : null;

  // Line 0: artist(s), and - on a third of lots - the nationality and life dates too.
  // ROSEBERYS-HEADER-1.0; see splitArtistHeader for why this is not a plain comma split.
  const artistLine = head[0] ?? "";
  const artistQualifier = detectQualifier(artistLine);
  const header = splitArtistHeader(artistLine);
  const artist = header.names[0] ?? null;
  const additionalArtists = header.names.slice(1);

  // Line 1 is the house's dedicated nationality line ("Spanish 1881-1973", "British b.1965")
  // ONLY when line 0 did not already carry that metadata and the line holds nothing else.
  const natMatch = header.nationality || header.lifeDates ? null : nationalityLine(head[1] ?? "");
  const nationality = header.nationality ?? natMatch?.nationality ?? null;
  const rawLifeDates = header.lifeDates ?? natMatch?.lifeDates ?? null;
  const lifeDates = rawLifeDates ? rawLifeDates.replace(/\s+/g, "") : null;

  // Title: first line terminated by ';' (house convention), else the line after
  // the artist block.
  const titleIdx = head.findIndex((l, i) => i >= 1 && /;\s*$/.test(l));
  const titleLine = titleIdx >= 0 ? head[titleIdx] : head[natMatch ? 2 : 1] ?? null;
  let title: string | null = null;
  let year: string | null = null;
  if (titleLine) {
    const t = titleLine.replace(/;\s*$/, "").trim();
    const ym = t.match(/,\s*((?:c\.?\s*)?\d{4}(?:\s*[-–]\s*\d{2,4})?)\s*$/);
    year = ym ? ym[1].trim() : (t.match(/\b(1[5-9]\d{2}|20[0-2]\d)\b/)?.[1] ?? null);
    title = (ym ? t.slice(0, ym.index).trim() : t).replace(/[,;]\s*$/, "") || null;
  }

  // Body: everything after the title line.
  const bodyStart = titleIdx >= 0 ? titleIdx + 1 : natMatch ? 3 : 2;
  const bodyLines = head.slice(bodyStart);
  const body = bodyLines.join("\n");

  // Medium is conventionally the first body line; support follows " on ".
  const mediumLine = bodyLines[0] ?? null;
  let medium: string | null = null;
  let support: string | null = null;
  if (mediumLine) {
    const cleaned = mediumLine.replace(/,\s*$/, "").trim();
    const onIdx = cleaned.search(/\s+on\s+/i);
    if (onIdx > 0) {
      medium = cleaned.slice(0, onIdx).trim();
      support = cleaned.slice(onIdx).replace(/^\s*on\s+/i, "").trim();
    } else {
      medium = cleaned;
    }
  }

  const pick = (re: RegExp): string | null =>
    bodyLines.find((l) => re.test(l))?.replace(/,\s*$/, "").trim() ?? null;

  const printer = pick(/^printed\s+by\b/i)?.replace(/^printed\s+by\s*/i, "") ?? null;
  const publisher = pick(/^published\s+by\b/i)?.replace(/^published\s+by\s*/i, "") ?? null;
  const inscriptions = bodyLines.filter((l) => /\b(signed|inscribed|numbered|stamped|monogram|dated)\b/i.test(l))
    .join("; ").replace(/,\s*$/, "") || null;

  const editionLine = pick(/\b(edition|proof|artist'?s proof|A\/P|H\.?C\.?|hors commerce|épreuve)\b/i);
  const editionSize = detectEditionSize(body);

  const { isMultiWork, reason } = detectMultiWork(full);

  // Blind-mode leak detection: anything in the body that reveals the artist.
  const leakRisks: string[] = [];
  // Post-nominals used to defeat this entirely: the surname was taken as the last
  // whitespace token, so "Laurence Stephen Lowry RBA RA" yielded "RA", too short
  // to clear the length guard, and a body naming Lowry three times raised nothing.
  // Search body AND provenance: provenance is split out of `body` by this parser,
  // but the harnesses send it to Stage 1c as provenanceNotes, so a name there is
  // every bit as much a leak. A0785 lot 290 (Pablo Picasso) hid its only mention
  // of "Picasso" in the provenance line and passed as a blind run.
  const leakSurface = [body, provenance].filter(Boolean).join("\n");
  const appearsInBody = (tok: string) => new RegExp(`\\b${escapeRe(tok)}\\b`, "i").test(leakSurface);
  const namedArtists = [artist, ...additionalArtists];
  // The surname is the identifying token and is reported on its own, because
  // downstream harnesses gate blind runs on it (tests/backtest/blindness.ts).
  for (const surname of namedArtists.map(artistSurnameToken)) {
    if (surname && appearsInBody(surname)) {
      leakRisks.push(`artist surname "${surname}" appears in body/provenance`);
    }
  }
  // Remaining tokens are reported but do not gate: a forename on its own rarely
  // identifies anyone, and matching them indiscriminately produces false
  // positives (A0777/1, Paul Gauguin, matched "the Paul Kovesdy Gallery").
  const otherTokens = [...new Set(
    namedArtists.flatMap((n) => artistNameLeakTokens(n).slice(0, -1)).filter(appearsInBody),
  )];
  if (otherTokens.length) {
    leakRisks.push(`artist forename/middle name(s) appear in body/provenance: ${otherTokens.join(", ")}`);
  }
  const refs = extractCatalogueRefs(full);
  if (refs.length) leakRisks.push(`catalogue raisonné ref(s): ${refs.join(", ")}`);
  if (printer) leakRisks.push(`printer named: ${printer}`);
  if (publisher) leakRisks.push(`publisher named: ${publisher}`);
  if (provenance && /gallery|galerie|collection of|estate of/i.test(provenance)) {
    leakRisks.push("provenance names a gallery/estate");
  }

  return {
    artist,
    artistQualifier,
    additionalArtists,
    nationality,
    lifeDates,
    title,
    year,
    medium,
    support,
    dimensions: parseDimensions(head),
    edition: editionLine,
    editionSize,
    signed: /\bsigned\b/i.test(body),
    inscriptions,
    printer,
    publisher,
    catalogueRefs: refs,
    framed: /\(framed\)/i.test(full),
    provenance,
    condition: null,
    isMultiWork,
    multiWorkReason: reason,
    leakRisks,
    bodyLines,
  };
}
