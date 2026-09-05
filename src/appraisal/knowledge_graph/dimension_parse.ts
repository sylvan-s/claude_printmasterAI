/**
 * Parse the ACKG's bare dimension strings into millimetres.
 *
 * Impression.{plate,image,sheet}Dimensions is free text whose shape varies by source:
 *   Forum / V&A  "380x518mm"
 *   Roseberys    "80.0x58.0cm"  "41.0x32.4cm"
 *   Met          "17 x 20-3/4 inches (43.2 x 52.7 cm)"   "9-7/8 x 8-3/8 in. (25.1 x 21.3 cm)"
 *
 * When a parenthetical metric value is present (the Met pattern) it wins — it is the
 * museum's own conversion. Otherwise the leading "W x H unit" is taken. Fractions
 * ("20-3/4") are only ever in the imperial half, which we skip whenever a paren exists.
 */
export interface DimMm {
  w: number;
  h: number;
}

function toMm(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("mm")) return value;
  if (u.startsWith("cm")) return value * 10;
  return value * 25.4; // in / inch / inches
}

function num(s: string): number {
  // "20-3/4" -> 20.75 ; "3/4" -> 0.75 ; "8-3/8" -> 8.375
  const frac = s.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) + Number(frac[2]) / Number(frac[3]);
  const bare = s.match(/^(\d+)\/(\d+)$/);
  if (bare) return Number(bare[1]) / Number(bare[2]);
  return parseFloat(s);
}

export function parseAckgDimMm(raw: string | null | undefined): DimMm | null {
  if (!raw || typeof raw !== "string") return null;

  const paren = raw.match(/\(\s*([\d.]+)\s*(?:x|×)\s*([\d.]+)\s*(cm|mm)\s*\)/i);
  if (paren) {
    const w = toMm(parseFloat(paren[1]), paren[3]);
    const h = toMm(parseFloat(paren[2]), paren[3]);
    if (w > 0 && h > 0) return { w: round1(w), h: round1(h) };
  }

  const m = raw.match(/([\d]+(?:-\d+\/\d+)?(?:\.\d+)?)\s*(?:x|×)\s*([\d]+(?:-\d+\/\d+)?(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?)?/i);
  if (m) {
    const unit = m[3] || "mm";
    const w = toMm(num(m[1]), unit);
    const h = toMm(num(m[2]), unit);
    if (w > 0 && h > 0) return { w: round1(w), h: round1(h) };
  }
  return null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
