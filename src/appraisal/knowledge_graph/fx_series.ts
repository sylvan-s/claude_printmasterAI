/**
 * The committed ECB reference series (knowledge_graph/fx_gbp_ecb.json, base GBP): the rates the
 * graph's GBP prices were converted with. Read once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FX_PATH = join(process.cwd(), "knowledge_graph/fx_gbp_ecb.json");
let fxCache: { base: string; rates: Record<string, Record<string, number>> } | null | undefined;
let days: string[] = [];

/**
 * Units of `currency` per GBP at the latest ECB reference rate on or before `date` (else the
 * latest available). Null when the currency is not in the series.
 */
export function gbpRate(currency: string, date: string | null): { rate: number; date: string } | null {
  if (currency.toUpperCase() === "GBP") return { rate: 1, date: date ?? "n/a" };
  if (fxCache === undefined) {
    try { fxCache = JSON.parse(readFileSync(FX_PATH, "utf8")); days = Object.keys(fxCache!.rates).sort(); }
    catch (err: any) { console.warn(`[fx] series unreadable at ${FX_PATH}: ${err?.message ?? err}`); fxCache = null; }
  }
  if (!fxCache || !days.length) return null;
  const cur = currency.toUpperCase();
  // Binary search for the last day on or before `date`.
  let hi = days.length - 1;
  if (date) {
    const d = date.slice(0, 10);
    let lo = 0, found = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] <= d) { found = m; lo = m + 1; } else hi = m - 1; }
    hi = found >= 0 ? found : days.length - 1;
  }
  for (let i = hi; i >= 0; i--) {
    const r = fxCache.rates[days[i]]?.[cur];
    if (r && r > 0) return { rate: r, date: days[i] };
  }
  return null;
}

/**
 * log shift that re-prices a hammer converted to GBP at `compDate` at the rate on `valuationDate`:
 * GBP = native / rate, so the shift is ln(rate at compDate) - ln(rate at valuationDate). 0 for
 * sterling, unknown currency, or dates the series cannot price.
 */
export function fxLogShift(currency: string | null | undefined, compDate: string | null | undefined, valuationDate: string | null | undefined): number {
  if (!currency || currency.toUpperCase() === "GBP" || !compDate || !valuationDate) return 0;
  const a = gbpRate(currency, compDate), b = gbpRate(currency, valuationDate);
  return a && b ? Math.log(a.rate) - Math.log(b.rate) : 0;
}
