/**
 * fx_series.ts against the committed ECB series (knowledge_graph/fx_gbp_ecb.json).
 *
 *   npm run test:fx-series
 */
import { gbpRate, fxLogShift } from "../../src/appraisal/knowledge_graph/fx_series";

let passed = 0, failed = 0;
function ok(label: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; console.log(`  FAIL ${label} ${detail}`); } }

ok("sterling is rate 1 and never shifts", gbpRate("GBP", "2020-01-01")!.rate === 1 && fxLogShift("GBP", "2015-01-01", "2025-01-01") === 0);
const d = gbpRate("USD", "2015-06-15")!;
ok("a weekday resolves to itself", d.date === "2015-06-15" && d.rate > 1.4 && d.rate < 1.7, JSON.stringify(d));
const sat = gbpRate("USD", "2015-06-13")!;
ok("a weekend resolves to the previous fixing", sat.date === "2015-06-12", JSON.stringify(sat));
const s = fxLogShift("USD", "2015-06-15", "2025-06-16");
const r15 = gbpRate("USD", "2015-06-15")!.rate, r25 = gbpRate("USD", "2025-06-16")!.rate;
ok("shift = ln(rate at comp) - ln(rate at valuation)", Math.abs(s - (Math.log(r15) - Math.log(r25))) < 1e-12);
ok("a 2015 dollar comp is re-priced UP for a 2025 valuation (sterling fell)", s > 0.1, String(s));
ok("unknown currency, or no dates: no shift", fxLogShift("XYZ", "2015-06-15", "2025-06-16") === 0 && fxLogShift("USD", null, "2025-06-16") === 0 && fxLogShift(null, "2015-06-15", "2025-06-16") === 0);

console.log(`\nfx_series tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
