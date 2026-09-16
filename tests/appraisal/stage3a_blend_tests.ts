/**
 * Pure tests for stage3a_blend.ts: the range is ordered and sane, the printed estimate never
 * moves it, caveats name what was defaulted, and no witness means no price.
 *
 *   npm run test:stage3a
 */
import { stage3aValuation, stage3aAuctionEstimate, roundEstimate, gbpRate, groupedContributions } from "../../src/appraisal/stage3a_blend";
import { defaultCalibration, type HouseOffsets } from "../../src/appraisal/knowledge_graph/price_blend";
import type { ValuationEvidence } from "../../src/appraisal/valuation_evidence";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }

const offsets: HouseOffsets = { version: "T", referenceHouse: "Bonhams", houses: { Bonhams: { log: 0, se: 0 }, "Forum Auctions": { log: Math.log(0.85), se: 0.04 } }, pooledFallback: { log: Math.log(0.92), betweenHouseSd: 0.5 } }; // large, so the widening clears the grid step
const cal = { ...defaultCalibration(), houseOffsets: offsets };
const comp = (tier: any, hammer: number, house: string, date: string): any => ({ tier, hammerGBP: hammer, realisedGBP: null, saleDate: date, house, saleId: "s", lotNumber: 1, workTitle: "T", listingUrl: null, attrs: {} });
const ev = (over: Partial<ValuationEvidence> = {}): ValuationEvidence => ({
  schemaVersion: "VE-1.0", builtAt: "t", artist: { reported: "X", canonical: "X" },
  profile: { canonicalName: "X", level: 6.5, elasticities: {}, multipliers: {}, neighbours: [], run: "t", basis: "shrunk", earlierSales: 40, segment: null, referenceLevels: { signature: "unsigned", proof: "numbered", edition_band: "76-150", area_band: "400-900", process: "lithograph", house: "Bonhams" }, continuousMedians: {}, yearEffects: {} },
  attrs: { signature: { value: "hand", source: "catalogue" }, proof: { value: "numbered", source: "default" }, editionSize: { value: 50, source: "catalogue" }, areaCm2: { value: null, source: "default" }, process: { value: "etching", source: "catalogue" } },
  targetHouse: { value: "Forum Auctions", source: "catalogue" }, valuationDate: { value: "2024-06-01", source: "catalogue" },
  identity: { workIds: ["w"], basis: "exact_title", matchedName: "T", ambiguousAt: null, via: "claim" },
  comps: { query: { sinceDate: "2014-06-01", untilDate: "2024-06-01", limit: 60, technique: null, workTitle: "T" }, items: [comp("same_work", 900, "Bonhams", "2023-03-01"), comp("same_work", 1100, "Forum Auctions", "2023-09-01"), comp("same_work", 1000, "Bonhams", "2022-05-01")], tierCounts: { same_work: 3, same_artist_technique: 0, same_artist: 0 }, coverageNote: "" },
  webComps: [], condition: { grade: "FAIR", defects: ["foxing (minor)"], appraiserClaims: [], source: "vea" }, sellThrough: { sold: 2, unsold: 0 },
  printedEstimate: { low: 800, high: 1200, currency: "GBP" }, warnings: [], ...over,
});
{
  const r = stage3aValuation(ev(), cal)!;
  ok("low < median < high", r.lowGBP < r.medianGBP && r.medianGBP < r.highGBP);
  eq("evidence tier from three same-work comps", r.evidenceTier, "same_work_3+");
  eq("house offset reported, measured", [r.house.name, r.house.multiplier, r.house.measured], ["Forum Auctions", 0.85, true]);
  ok("witness weights sum to 1", Math.abs(r.witnesses.reduce((t, w) => t + w.effectiveWeight, 0) - 1) < 0.01);
  ok("the printed estimate is compared, not blended", r.printedEstimate!.midpointOverMedian! > 0);
  const moved = stage3aValuation(ev({ printedEstimate: { low: 8000, high: 12000, currency: "GBP" } }), cal)!;
  eq("a 10x printed estimate does not move the range", [moved.lowGBP, moved.medianGBP, moved.highGBP], [r.lowGBP, r.medianGBP, r.highGBP]);
  ok("condition is noted, never applied", r.condition.note.startsWith("not applied") && r.condition.note.includes("foxing"));
  ok("defaulted attributes are named in the caveats", r.caveats.some((c) => c.includes("proof") && c.includes("areaCm2")));
  const pooled = stage3aValuation(ev({ targetHouse: { value: null, source: "default" } }), cal)!;
  ok("no house: caveat and a wider range", pooled.caveats.some((c) => c.startsWith("no sale house")) && pooled.highGBP / pooled.lowGBP > r.highGBP / r.lowGBP);
  eq("no profile and no comps -> no price", stage3aValuation(ev({ profile: null, comps: { ...ev().comps, items: [], tierCounts: { same_work: 0, same_artist_technique: 0, same_artist: 0 } } }), cal), null);
  const modelOnly = stage3aValuation(ev({ comps: { ...ev().comps, items: [], tierCounts: { same_work: 0, same_artist_technique: 0, same_artist: 0 } }, identity: { ...ev().identity, workIds: [] } }), cal)!;
  ok("model-only lots say so", modelOnly.evidenceTier === "priors_model" && modelOnly.caveats.some((c) => c.startsWith("no market comps")));
}
// ── the displayed estimate ─────────────────────────────────────────────────────
{
  eq("rounding: two significant figures, low down and high up", [roundEstimate(1234, "down"), roundEstimate(1234, "up"), roundEstimate(87, "down"), roundEstimate(87, "up"), roundEstimate(46, "down")], [1200, 1300, 80, 90, 40]);
  eq("GBP converts at 1", gbpRate("GBP", "2024-01-01")!.rate, 1);
  const usd = gbpRate("USD", "2024-06-03")!;
  ok("USD rate is on or before the valuation date and plausible", usd.date <= "2024-06-03" && usd.rate > 1.1 && usd.rate < 1.5);
  eq("an unknown currency has no rate", gbpRate("XYZ", null), null);
  const r = stage3aValuation(ev(), cal)!;
  const gbp = stage3aAuctionEstimate(r, "GBP", "2024-06-01")!;
  ok("GBP estimate brackets the rounded Stage 3a range", gbp.lowEstimate <= r.lowGBP && gbp.highEstimate >= r.highGBP && gbp.currency === "GBP");
  ok("context says fair value, not estimate-anchored, and names the house", gbp.valuationContext.startsWith("A fair-value range") && gbp.valuationContext.includes("Forum Auctions"));
  ok("printed estimate referenced, not used", gbp.valuationContext.includes("does not enter the price"));
  eq("reasoning anchor value is the rounded median", gbp.valuationReasoning!.anchorValue, roundEstimate(r.medianGBP));
  ok("house factor listed as an adjustment", gbp.valuationReasoning!.adjustments.some((a) => a.factor === "sale house price level" && a.magnitude === "x0.85"));
  const usdEst = stage3aAuctionEstimate(r, "USD", "2024-06-01")!;
  ok("USD estimate is converted and says at which rate", usdEst.lowEstimate > gbp.lowEstimate && usdEst.valuationContext.includes("ECB reference rate"));
  const g = groupedContributions([{ term: "artist level", logEffect: 7 }, { term: "signature=hand", logEffect: 0.7 }, { term: "area_band=150-400", logEffect: 0.3 }, { term: "sheet area=315", logEffect: -0.6 }, { term: "edition_band=unknown", logEffect: -0.3 }, { term: "house=Roseberys London", logEffect: -0.08 }, { term: "sale year 2026", logEffect: 0.1 }]);
  eq("contributions grouped one line per factor, house and level dropped", g.map((x) => [x.factor, +x.logEffect.toFixed(2)]), [["signature", 0.7], ["size", -0.3], ["edition", -0.3], ["sale year", 0.1]]);
  ok("the house appears once in the reasoning", gbp.valuationReasoning!.adjustments.filter((a) => /house/.test(a.factor)).length === 1);
  eq("no rate -> null (the appraiser falls back to the LLM)", stage3aAuctionEstimate(r, "XYZ", null), null);
}

console.log(`\nstage3a tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
