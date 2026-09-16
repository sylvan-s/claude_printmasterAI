/**
 * The bid currency of every non-sterling sold auction record, keyed the way the comps_hammer
 * harness records a comp (house | sale date | hammer GBP to 2 dp), for the dollar-comp
 * re-pricing gate (2026-09-16). The harness comps predate the currency field; this recovers it.
 * Sterling records are read too, only to count keys shared across currencies. Read-only.
 *
 *   npx tsx tests/backtest/extract_comp_currency.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getDriver, getDatabase, closeDriver } from "../../src/appraisal/knowledge_graph/client";

export const compCurrencyKey = (house: string | null | undefined, date: string | null | undefined, hammerGBP: number) =>
  `${house ?? ""}|${(date ?? "").slice(0, 10)}|${hammerGBP.toFixed(2)}`;

const OUT = "tests/backtest/comps_hammer/comp_currency.json";
const Q = `
MATCH (s:SourceRecord)
WHERE s.sourceType = 'auction' AND s.sold = true AND s.hammerPriceGBP > 0 AND s.saleDate IS NOT NULL
  AND s.institutionName IN ['Bonhams', 'Skinner']
RETURN s.institutionName AS house, substring(s.saleDate, 0, 10) AS date, s.hammerPriceGBP AS hammer, s.priceCurrency AS currency
`;

async function main() {
  const session = getDriver().session({ database: getDatabase() });
  const seen = new Map<string, Set<string>>();
  try {
    for (const r of (await session.run(Q)).records) {
      const k = compCurrencyKey(r.get("house"), r.get("date"), Number(r.get("hammer")));
      (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(String(r.get("currency") ?? "GBP"));
    }
  } finally { await session.close(); await closeDriver(); }
  const out: Record<string, string> = {};
  let mixed = 0;
  for (const [k, cs] of seen) {
    if (cs.size > 1) { mixed++; continue; }
    const c = [...cs][0];
    if (c !== "GBP") out[k] = c;
  }
  writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), note: "non-GBP keys only; keys shared by two currencies dropped", mixedKeysDropped: mixed, keys: out }) + "\n");
  const by = Object.values(out).reduce((t, c) => ({ ...t, [c]: (t[c] ?? 0) + 1 }), {} as Record<string, number>);
  console.log(`${seen.size} Bonhams/Skinner keys; non-GBP ${Object.keys(out).length} ${JSON.stringify(by)}; ambiguous dropped ${mixed}; written ${OUT}`);
}
if (process.argv[1]?.endsWith("extract_comp_currency.ts")) main();
