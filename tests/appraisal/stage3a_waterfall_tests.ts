/**
 * The waterfall's sum identity and labels. `npm run test:stage3a-waterfall`
 */
import { valuationWaterfall, type ColumnMeans } from "../../src/appraisal/stage3a_waterfall";
import { stage3aValuation } from "../../src/appraisal/stage3a_blend";
import { defaultCalibration, calibratedWitnesses, type HouseOffsets } from "../../src/appraisal/knowledge_graph/price_blend";
import { evidenceToBlendInputs, type ValuationEvidence } from "../../src/appraisal/valuation_evidence";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); } }
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const offsets: HouseOffsets = { version: "T", referenceHouse: "Bonhams", houses: { Bonhams: { log: 0, se: 0 }, "Forum Auctions": { log: Math.log(0.85), se: 0 }, "Roseberys London": { log: Math.log(0.92), se: 0 } }, pooledFallback: { log: Math.log(0.92), betweenHouseSd: 0.08 }, yearEffects: { "2020": 0, "2023": 0.1 }, timeAdjust: "prior_year" };
const cal = { ...defaultCalibration(), houseOffsets: offsets };
cal.witnesses.priors_model.byKey.shrunk = { bias: Math.log(0.8), sigma: 0.6, n: 100 };
const means: ColumnMeans = {
  version: "CM-T", priorsVersion: "PRICING-PRIORS-1.2", priorsBuiltAt: "2026-09-14T09:30:19+00:00", trainRows: 1000, baselineLogHammer: Math.log(1000),
  columns: { signature_hand: 0.75, proof_unknown: 0.2, edition_band_31_75: 0.1, "edition_band_31-75": 0.15, "area_band_>1800": 0.3, process_etching: 0.25, edition_log: 4.2, area_log: 7.8, "house_Roseberys London": 0.2 },
  meanYearEffect: 0.03, houseShares: { Bonhams: 0.78, "Roseberys London": 0.2, Skinner: 0.02 },
};
const ev = (over: Partial<ValuationEvidence> = {}): ValuationEvidence => ({
  schemaVersion: "VE-1.0", builtAt: "t", artist: { reported: "X", canonical: "X" },
  profile: {
    canonicalName: "X", level: 6.4, run: "PRICING-PRIORS-1.2@2026-09-14T09:30:19+00:00", basis: "shrunk", earlierSales: 120, segment: null, neighbours: [], multipliers: {},
    elasticities: { signature_hand: 0.7, proof_unknown: -0.1, "edition_band_31-75": 0.2, "area_band_>1800": 0.3, process_etching: 0.15, edition_log: -0.1, area_log: 0.2, "house_Roseberys London": -0.3, subject_is_abstract: -0.5 },
    referenceLevels: { signature: "unsigned", proof: "numbered", edition_band: "76-150", area_band: "400-900", process: "lithograph", house: "Bonhams" },
    continuousMedians: { edition_log: Math.log(100), area_log: Math.log(2400) }, yearEffects: { "2024": 0.12 },
  },
  attrs: { signature: { value: "hand", source: "catalogue" }, proof: { value: "numbered", source: "default" }, editionSize: { value: 50, source: "catalogue" }, areaCm2: { value: 3000, source: "catalogue" }, process: { value: "etching", source: "catalogue" } },
  targetHouse: { value: "Forum Auctions", source: "catalogue" }, valuationDate: { value: "2024-06-01", source: "catalogue" },
  identity: { workIds: ["w"], basis: "exact_title", matchedName: "T", ambiguousAt: null, via: "claim" },
  comps: { query: { sinceDate: "2014-06-01", untilDate: "2024-06-01", limit: 60, technique: null, workTitle: "T" }, items: [{ tier: "same_work", hammerGBP: 2500, realisedGBP: null, saleDate: "2023-03-01", house: "Bonhams", saleId: "s", lotNumber: 1, workTitle: "T", listingUrl: null, attrs: {} as any }], tierCounts: { same_work: 1, same_artist_technique: 0, same_artist: 0 }, coverageNote: "" },
  webComps: [], condition: { grade: "GOOD", defects: [], appraiserClaims: [], source: "vea" }, sellThrough: null, printedEstimate: null, warnings: [], ...over,
});
{
  const e = ev();
  const r = stage3aValuation(e, cal)!;
  const median = Math.exp(Math.log(r.medianGBP)); // rounded median is fine for the identity
  const w = valuationWaterfall(e, cal, means, median)!;
  const steps = w.bars.filter((b) => b.kind === "factor" || b.kind === "comps").reduce((t, b) => t + b.logEffect, 0);
  const start = Math.log(w.bars[0].toGBP);
  ok("start + every step = log median (start rounded to the pound)", close(start + steps, Math.log(median), 1e-3));
  const priors = calibratedWitnesses(evidenceToBlendInputs(e, { proofPolicy: { columnMeans: means.columns, premium: { min: 1.05, max: 1.1 } } }), cal, "no_estimate").witnesses.find((x) => x.source === "priors_model")!;
  const modelSteps = w.bars.slice(0, w.bars.findIndex((b) => b.key === "model")).filter((b) => b.kind === "factor").reduce((t, b) => t + b.logEffect, 0);
  // Exact start in log space: level + technique beta + other betas at the mix + mean house + mean year.
  const p = e.profile!;
  const exactStart = p.level + 0.15 /* process_etching */ + [["signature_hand", 0.7], ["proof_unknown", -0.1], ["edition_band_31-75", 0.2], ["area_band_>1800", 0.3], ["edition_log", -0.1], ["area_log", 0.2]].reduce((t, [c, b]) => t + (b as number) * (means.columns[c as string] ?? 0), 0)
    + (0.78 * 0 + 0.2 * Math.log(0.92) + 0.02 * Math.log(0.92)) + 0.03;
  ok("start + model bars = the priors witness price the blend used, exactly", close(exactStart + modelSteps, priors.mu));
  eq("no gap note on a consistent build", w.notes, []);
  eq("bar order: starts at artist + technique, no artist or technique bar", w.bars.map((b) => b.key), ["baseline", "signature", "impression", "edition", "size", "house", "year", "calibration", "model", "comps", "total", "condition"]);
  ok("start label names the artist and technique", w.bars[0].label.startsWith("X, etching: typical print"));
  ok("signature bar is beta * (1 - share)", close(w.bars.find((b) => b.key === "signature")!.logEffect, 0.7 * (1 - 0.75)));
  ok("proof bar for a numbered (reference) lot is -beta * share of unknown", close(w.bars.find((b) => b.key === "impression")!.logEffect, -(-0.1) * 0.2));
  ok("house bar is the lot's level minus the training mix's level", close(w.bars.find((b) => b.key === "house")!.logEffect, Math.log(0.85) - (0.2 * Math.log(0.92) + 0.02 * Math.log(0.92)))); // Skinner is unmeasured here: pooled
  ok("calibration bar is the witness bias", close(w.bars.find((b) => b.key === "calibration")!.logEffect, Math.log(0.8)));
  ok("labels carry the attribute source", w.bars.find((b) => b.key === "impression")!.label.includes("not stated: model default"));
  ok("the step is labelled impression status in plain words", w.bars.find((b) => b.key === "impression")!.label.startsWith("Impression status: numbered impression"));
  ok("running prices chain: each bar starts where the last ended", w.bars.filter((b) => b.kind === "factor" || b.kind === "comps").every((b, i, a) => i === 0 || Math.abs(b.fromGBP - a[i - 1].toGBP) <= 1));
  eq("condition is a zero-length note", [w.bars.at(-1)!.kind, w.bars.at(-1)!.logEffect], ["note", 0]);
  const other = valuationWaterfall({ ...e, profile: { ...e.profile!, run: "PRICING-PRIORS-9@2027" } }, cal, means, median)!;
  ok("a different priors build is noted", other.notes.some((n) => n.startsWith("chart centred on")));
  const noModel = valuationWaterfall({ ...e, profile: null }, cal, means, 2000)!;
  eq("no profile: average sold print straight to comps", noModel.bars.map((b) => b.key), ["baseline", "comps", "total", "condition"]);
  ok("no profile: comps bar reaches the median", close(Math.log(1000) + noModel.bars[1].logEffect, Math.log(2000)));

  // A hors-commerce proof with no edition: edition bar zero, proof bar clamped into 5-10%.
  const hc = { ...e, attrs: { ...e.attrs, proof: { value: "hors_commerce", source: "catalogue" }, editionSize: { value: null, source: "default" } } } as any;
  hc.profile = { ...e.profile!, elasticities: { ...e.profile!.elasticities, proof_hors_commerce: 0.6, edition_band_unknown: -0.8 } };
  const rHc = stage3aValuation(hc, cal, means)!;
  const wHc = valuationWaterfall(hc, cal, means, rHc.medianGBP)!;
  const bar = (k: string) => wHc.bars.find((b) => b.key === k)!;
  eq("proof without an edition: edition bar is zero and says so", [bar("edition").logEffect, bar("edition").label], [0, "Edition: not stated, not held against an impression outside the edition"]);
  ok("hors commerce reads as outside the numbered edition", bar("impression").label.startsWith("Impression status: hors commerce (outside the numbered edition)"));
  const hcEd = { ...hc, attrs: { ...hc.attrs, editionSize: { value: 25, source: "catalogue" } } };
  const wEd = valuationWaterfall(hcEd, cal, means, stage3aValuation(hcEd, cal, means)!.medianGBP)!;
  ok("proof with a stated edition: the edition still prices it", wEd.bars.find((b) => b.key === "edition")!.logEffect !== 0 && wEd.bars.find((b) => b.key === "edition")!.label.startsWith("Edition: 25") && wEd.notes.length === 0);
  ok("proof: a large fitted proof effect is clamped to +10%", close(bar("impression").logEffect, Math.log(1.1)));
  ok("proof: label says modest proof premium", bar("impression").label.includes("modest proof premium, 5-10%"));
  const hcPriors = calibratedWitnesses(evidenceToBlendInputs(hc, { proofPolicy: { columnMeans: means.columns, premium: { min: 1.05, max: 1.1 } } }), cal, "no_estimate").witnesses.find((x) => x.source === "priors_model")!;
  const hcModelSteps = wHc.bars.slice(0, wHc.bars.findIndex((b) => b.key === "model")).filter((b) => b.kind === "factor").reduce((t, b) => t + b.logEffect, 0);
  eq("proof: no gap note, so the bars reach the model price exactly", wHc.notes, []);
  ok("proof: model price agrees with the chart's model subtotal", Math.abs(Math.log(bar("model").toGBP) - hcPriors.mu) < 1e-3 && hcModelSteps !== 0);
}
console.log(`\nstage3a waterfall tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
