/**
 * Forum Auctions catalogue-description parser.
 *
 * Forum's format differs from Roseberys and needs its own logic:
 *
 *   <p>Norman Ackroyd (b.1938)</p>              ← artist, life dates INLINE in parens
 *   <p>Wasdale Screes</p>                        ← title (no ';' terminator)
 *   <p>Etching, 1982, signed, titled, dated and numbered from the edition of 80
 *      in pencil, on wove paper, with full margins, 510 x 647mm (20 x 25 3/8in)
 *      (unframed)</p>                            ← medium, year, inscriptions, support, dims
 *
 * vs Roseberys, which put nationality on its own line, terminated the title with
 * ';', and gave dimensions in cm. Forum uses mm.
 *
 * Output field names match the Roseberys parser so the two extracts combine.
 */

export type ArtistQualifier =
  | "certain" | "attributed" | "circle" | "studio" | "follower" | "after" | "unknown";

export interface Dimension {
  kind: string;
  widthCm: number | null;
  heightCm: number | null;
  raw: string;
}

export interface ParsedLot {
  artist: string | null;
  artistQualifier: ArtistQualifier;
  additionalArtists: string[];
  nationality: string | null;   // Forum rarely states it; usually null
  lifeDates: string | null;     // from the inline parens, e.g. "b.1938", "1917-1984"
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
  isMultiWork: boolean;
  multiWorkReason: string | null;
  leakRisks: string[];
  bodyLines: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function htmlToLines(html: string): string[] {
  return html
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:ldquo|rdquo|quot);/g, '"')
    .replace(/&(?:lsquo|rsquo|#39);/g, "'")
    .replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à")
    .replace(/&uuml;/g, "ü").replace(/&ouml;/g, "ö").replace(/&auml;/g, "ä")
    .replace(/&ccedil;/g, "ç").replace(/&ntilde;/g, "ñ")
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
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
  [/\bafter\b/i, "after"],
];

function detectQualifier(line: string): ArtistQualifier {
  for (const [re, q] of QUALIFIERS) if (re.test(line)) return q;
  return "certain";
}

/** mm is Forum's default unit; normalise everything to cm to match Roseberys. */
function toCm(value: number, unit: string): number {
  if (/mm/i.test(unit)) return value / 10;
  if (/\bin(ch(es)?)?\b/i.test(unit) || unit === '"') return value * 2.54;
  return value; // cm
}

export function parseDimensions(text: string): Dimension[] {
  const out: Dimension[] = [];
  // Forum: "510 x 647mm (20 x 25 3/8in)" — take the metric pair, ignore the
  // parenthetical imperial restatement. Also "sheet: 510 x 647mm", "image 200 x 300mm".
  const re =
    /(sheet|image|plate|overall|block|the full sheet|diameter)?\s*:?\s*(\d{2,4})\s*(?:x|×)\s*(\d{2,4})\s*(mm|cm)/gi;
  for (const m of text.matchAll(re)) {
    out.push({
      kind: (m[1] || "size").toLowerCase().trim(),
      widthCm: +toCm(parseFloat(m[2]), m[4]).toFixed(2),
      heightCm: +toCm(parseFloat(m[3]), m[4]).toFixed(2),
      raw: m[0].trim(),
    });
  }
  return out;
}

const MULTIWORK_PATTERNS: [RegExp, string][] = [
  [/\ba\s+pair\b/i, "a pair"],
  [/\b(?:two|2)\s+works\b/i, "2 works"],
  [/\b(?:three|3)\s+works\b/i, "3 works"],
  [/\bon\s+(?:two|three|four|five|\d+)\s+sheets\b/i, "multiple sheets"],
  [/\ba\s+set\s+of\s+\w+/i, "a set of"],
  [/\ba\s+group\s+of\s+\w+/i, "a group of"],
  [/\btogether\s+with\b/i, "together with"],
  [/\band\s+another\b/i, "and another"],
  [/\bthe\s+(?:complete\s+)?(?:set|portfolio|suite|series)\s+of\s+\w+/i, "complete set"],
  [/\((?:2|3|4|5|6|7|8|9|\d{2})\)\s*$/m, "trailing (n)"],
];

export function detectMultiWork(text: string): { isMultiWork: boolean; reason: string | null } {
  for (const [re, label] of MULTIWORK_PATTERNS) {
    if (re.test(text)) return { isMultiWork: true, reason: label };
  }
  return { isMultiWork: false, reason: null };
}

export function extractCatalogueRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/[\[(]\s*([A-Z][A-Za-z&.\s]{2,25}?\s+[\dIVX][\d.\-IVX]*)\s*[\])]/g)) {
    refs.add(m[1].replace(/\s+/g, " ").trim());
  }
  return [...refs];
}

/** Split "Norman Ackroyd (b.1938)" → { name, dates }. Handles en-dash, spaces, "b."/"d." */
function splitArtistLine(line: string): { name: string; dates: string | null; qualifier: ArtistQualifier } {
  const qualifier = detectQualifier(line);
  const cleaned = line.replace(/\b(attributed to|circle of|studio of|follower of|after)\b/gi, "").trim();
  const m = cleaned.match(/^(.*?)\s*\((\s*(?:b\.?|d\.?|born|circa|c\.)?\s*\d{3,4}\s*(?:[-–—]\s*\d{2,4})?\s*)\)\s*$/);
  if (m) {
    return { name: m[1].replace(/,\s*$/, "").trim(), dates: m[2].replace(/\s+/g, " ").trim(), qualifier };
  }
  return { name: cleaned.replace(/,\s*$/, "").trim() || null as any, dates: null, qualifier };
}

export function parseDescription(html: string): ParsedLot {
  const lines = htmlToLines(html);
  const full = lines.join("\n");

  const provIdx = lines.findIndex((l) => /^provenance\b/i.test(l));
  const head = provIdx >= 0 ? lines.slice(0, provIdx) : lines;
  const provenance = provIdx >= 0 ? lines.slice(provIdx + 1).join(" ").trim() || null : null;

  // Line 0: artist with inline life dates.
  const { name: artist, dates: lifeDates, qualifier: artistQualifier } = splitArtistLine(head[0] ?? "");

  // Occasionally two artists share the first line (comma-separated).
  const additionalArtists =
    (head[0] ?? "").includes(",") && !/\d{4}/.test((head[0] ?? "").split(",")[1] ?? "")
      ? (head[0] ?? "").split(",").slice(1).map((s) => s.replace(/\(.*?\)/g, "").trim()).filter(Boolean)
      : [];

  // Line 1: title (no ';' convention here — it's simply the second paragraph).
  const title = (head[1] ?? "").replace(/[,;]\s*$/, "").trim() || null;

  // Line 2+: the description body.
  const bodyLines = head.slice(2);
  const body = bodyLines.join(" ");

  // Medium = text before the first comma of the body.
  // "Etching, 1982, ..." → "Etching"; "Lithograph printed in colours, 1963, ..." → "Lithograph printed in colours".
  let medium: string | null = null;
  let year: string | null = null;
  let support: string | null = null;
  if (body) {
    const firstComma = body.indexOf(",");
    medium = (firstComma >= 0 ? body.slice(0, firstComma) : body).trim() || null;

    // Year: first standalone 4-digit (or c.YYYY) after the medium.
    const ym = body.match(/\b(c\.?\s*)?(1[5-9]\d{2}|20[0-2]\d)\b/);
    year = ym ? (ym[1] ? "c." + ym[2] : ym[2]) : null;

    // Support: text after " on " up to the next comma.
    const onm = body.match(/\bon\s+([^,]+?(?:paper|wove|vellum|board|card|canvas|blanket|wool|Rives|Arches|Saunders|Japan)[^,]*)/i);
    support = onm ? onm[1].trim() : null;
  }

  const printer = body.match(/printed by ([^,]+)/i)?.[1]?.trim() ?? null;
  const publisher = body.match(/published by ([^,]+)/i)?.[1]?.trim() ?? null;

  const inscriptions =
    bodyLines.filter((l) => /\b(signed|inscribed|numbered|stamped|dated|titled)\b/i.test(l))
      .join("; ").replace(/,\s*$/, "") || (/\b(signed|inscribed|numbered|stamped|dated|titled)\b/i.test(body)
      ? body.match(/\b((?:signed|inscribed|numbered|stamped|dated|titled)[^.]*?)(?:, on |, printed| \d{2,4} x)/i)?.[1]?.trim() ?? null
      : null);

  const editionSizeMatch = body.match(/edition of (\d+)/i) ?? body.match(/\b\d+\s*\/\s*(\d+)\b/);
  const editionSize = editionSizeMatch ? Number(editionSizeMatch[1]) : null;
  const editionLine = body.match(/((?:an? )?(?:artist'?s|printer'?s)? ?proof[^,]*|from the (?:total )?edition of \d+[^,]*|numbered from[^,]*)/i)?.[1]?.trim() ?? null;

  const { isMultiWork, reason } = detectMultiWork(full);

  const leakRisks: string[] = [];
  const surname = artist?.split(/\s+/).pop()?.replace(/[^\p{L}\p{M}'-]/gu, "");
  if (surname && surname.length > 3 && new RegExp(`\\b${escapeRe(surname)}\\b`, "i").test(body)) {
    leakRisks.push(`artist surname "${surname}" appears in body`);
  }
  const refs = extractCatalogueRefs(full);
  if (refs.length) leakRisks.push(`catalogue ref(s): ${refs.join(", ")}`);
  if (printer) leakRisks.push(`printer named: ${printer}`);
  if (publisher) leakRisks.push(`publisher named: ${publisher}`);

  return {
    artist: artist || null,
    artistQualifier,
    additionalArtists,
    nationality: null,
    lifeDates,
    title,
    year,
    medium,
    support,
    dimensions: parseDimensions(full),
    edition: editionLine,
    editionSize,
    signed: /\bsigned\b/i.test(body),
    inscriptions,
    printer,
    publisher,
    catalogueRefs: refs,
    framed: /\bframed\b/i.test(full) && !/\bunframed\b/i.test(full),
    provenance,
    isMultiWork,
    multiWorkReason: reason,
    leakRisks,
    bodyLines,
  };
}
