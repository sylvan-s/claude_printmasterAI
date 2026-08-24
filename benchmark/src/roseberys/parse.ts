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
import { parseDimensions, extractCatalogueRefs, detectEditionSize } from "../../../src/shared/text_extraction";

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
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:ldquo|rdquo|quot);/g, '"')
    .replace(/&(?:lsquo|rsquo|#39);/g, "'")
    .replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à")
    .replace(/&uuml;/g, "ü").replace(/&ouml;/g, "ö").replace(/&auml;/g, "ä")
    .replace(/&ccedil;/g, "ç").replace(/&ntilde;/g, "ñ").replace(/&oacute;/g, "ó")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
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


/* -------------------------------------------------------------------- parse */

export function parseDescription(html: string): ParsedLot {
  const lines = htmlToLines(html);
  const full = lines.join("\n");

  // Provenance splits the record; everything before it is catalogue proper.
  const provIdx = lines.findIndex((l) => /^provenance\b/i.test(l));
  const head = provIdx >= 0 ? lines.slice(0, provIdx) : lines;
  const provenance =
    provIdx >= 0 ? lines.slice(provIdx + 1).join(" ").trim() || null : null;

  // Line 0: artist(s). Multiple names arrive comma-separated on one line.
  const artistLine = head[0] ?? "";
  const artistQualifier = detectQualifier(artistLine);
  const names = artistLine
    .replace(/,\s*$/, "")
    .replace(/\b(attributed to|circle of|studio of|follower of|manner of|after)\b/gi, "")
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const artist = names[0] ?? null;
  const additionalArtists = names.slice(1);

  // Line 1: nationality + life dates, e.g. "Spanish 1881-1973" / "British b.1965".
  const natLine = head[1] ?? "";
  const natMatch = natLine.match(
    /^([A-Za-z\/\s-]+?)[,\s]+((?:b\.?\s*)?\d{4}\s*(?:[-–]\s*\d{4})?)/,
  );
  const nationality = natMatch ? natMatch[1].replace(/,\s*$/, "").trim() : null;
  const lifeDates = natMatch ? natMatch[2].replace(/\s+/g, "") : null;

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
  // Descriptions are hand-typed, so surnames can carry stray metacharacters.
  const surname = artist?.split(/\s+/).pop()?.replace(/[^\p{L}\p{M}'-]/gu, "");
  if (surname && surname.length > 3 && new RegExp(`\\b${escapeRe(surname)}\\b`, "i").test(body)) {
    leakRisks.push(`artist surname "${surname}" appears in body`);
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
