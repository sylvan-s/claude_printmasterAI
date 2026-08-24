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
