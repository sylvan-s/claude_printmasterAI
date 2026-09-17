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
  comps: { query: { sinceDate: "2014-06-01", untilDate: "2024-06-01", limit: 60, technique: null, workTitle: "T" }, items: [{ tier: "same_work", hammerGBP: 2500, realisedGBP: null, saleDate: "2023-03-01", house: "Bonhams", saleId: "s", lotNumber: 1, workTitle: "T", listingUrl: null, attrs: {} as any }], tierCounts: { same_work: 1, same_suite: 0, same_artist_technique: 0, same_artist: 0 }, coverageNote: "" },
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
  // Exact start in log space: level + technique beta + the reference print (hand-signed, numbered,
  // edition 31-75 at 50, size at the model reference) + Bonhams (0) + the valuation year's market (2024: 0.12).
  const p = e.profile!;
  const exactStart = p.level + 0.15 /* process_etching */ + 0.7 /* signature_hand */ + 0.2 /* edition_band_31-75 */ + -0.1 * Math.log(50) + 0.2 * Math.log(2400) + 0.12;
  ok("start + model bars = the priors witness price the blend used, exactly", close(exactStart + modelSteps, priors.mu));
  eq("no gap note on a consistent build", w.notes, []);
  eq("bar order: starts at artist + technique, no artist or technique bar", w.bars.map((b) => b.key), ["baseline", "signature", "impression", "edition", "size", "house", "calibration", "model", "comps", "total", "condition"]);
  ok("start label names the artist and technique", w.bars[0].label.startsWith("X, etching: numbered, hand-signed, edition 31–75, large, Bonhams, 2024 market ("));
  ok("signature bar is zero for a hand-signed lot (the reference)", close(w.bars.find((b) => b.key === "signature")!.logEffect, 0));
  const unsigned = { ...e, attrs: { ...e.attrs, signature: { value: "unsigned", source: "catalogue" } } } as any;
  const wU = valuationWaterfall(unsigned, cal, means, stage3aValuation(unsigned, cal, means)!.medianGBP)!;
  ok("signature bar for an unsigned lot is -beta(hand)", close(wU.bars.find((b) => b.key === "signature")!.logEffect, -0.7) && wU.notes.length === 0);
  ok("proof bar is zero for a numbered lot (the reference)", close(w.bars.find((b) => b.key === "impression")!.logEffect, 0));
  ok("edition bar for 50 in the 31-75 band is zero (the reference)", close(w.bars.find((b) => b.key === "edition")!.logEffect, 0));
  ok("house bar is the lot's house against Bonhams", close(w.bars.find((b) => b.key === "house")!.logEffect, Math.log(0.85)));
  ok("no market-level step: the start is priced at the valuation year's market", !w.bars.some((b) => b.key === "year"));
  {
    const two = { ...e, profile: { ...e.profile!, yearEffects: { "2019": 0, "2024": 0.12 } } } as any;
    const at = (d: string) => valuationWaterfall({ ...two, valuationDate: { value: d, source: "catalogue" } }, cal, means, median)!.bars[0].toGBP;
    ok("the start carries the valuation year's market: 2024 start is x1.13 the 2019 start", close(Math.log(at("2024-06-01")) - Math.log(at("2019-06-01")), 0.12, 2e-3));
    ok("a valuation year past the series carries the latest year forward", close(Math.log(at("2027-01-01")) - Math.log(at("2024-06-01")), 0, 2e-3));
  }
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
  // Edition columns at the training mix, against the reference (31-75 band, edition 50).
  const editionAtMix = 0.2 * 0.15 + -0.1 * 4.2 - (0.2 + -0.1 * Math.log(50));
  eq("proof without an edition: edition at the average edition, and says so", [close(bar("edition").logEffect, editionAtMix), bar("edition").label], [true, "Edition: not stated, priced at the average edition for an impression outside the edition"]);
  ok("hors commerce reads as outside the numbered edition", bar("impression").label.startsWith("Impression status: hors commerce (outside the numbered edition)"));
  const hcEd = { ...hc, attrs: { ...hc.attrs, editionSize: { value: 25, source: "catalogue" } } };
  const wEd = valuationWaterfall(hcEd, cal, means, stage3aValuation(hcEd, cal, means)!.medianGBP)!;
  ok("proof with a stated edition: the edition still prices it", wEd.bars.find((b) => b.key === "edition")!.logEffect !== 0 && wEd.bars.find((b) => b.key === "edition")!.label.startsWith("Edition: 25") && wEd.notes.length === 0);
  ok("proof: a large fitted proof effect is clamped to +10%", close(bar("impression").logEffect, -0.1 * 0.2 /* proof columns at the mix */ + Math.log(1.1)));
  ok("proof: label says modest proof premium", bar("impression").label.includes("modest proof premium, 5-10%"));
  const hcPriors = calibratedWitnesses(evidenceToBlendInputs(hc, { proofPolicy: { columnMeans: means.columns, premium: { min: 1.05, max: 1.1 } } }), cal, "no_estimate").witnesses.find((x) => x.source === "priors_model")!;
  const hcModelSteps = wHc.bars.slice(0, wHc.bars.findIndex((b) => b.key === "model")).filter((b) => b.kind === "factor").reduce((t, b) => t + b.logEffect, 0);
  eq("proof: no gap note, so the bars reach the model price exactly", wHc.notes, []);
  ok("proof: model price agrees with the chart's model subtotal", Math.abs(Math.log(bar("model").toGBP) - hcPriors.mu) < 1e-3 && hcModelSteps !== 0);
}
// ── shape size bands and the extra-large term ─────────────────────────────────────
{
  const e = ev();
  const shapeProfile = { ...e.profile!, referenceLevels: { ...e.profile!.referenceLevels, area_band: "1800-7500" },
    elasticities: { signature_hand: 0.7, "area_band_<400": -0.2, "area_band_>7500": 0.25, area_log_xl: 0.4, process_etching: 0.15 } };
  const shapeMeans = { ...means, columns: { signature_hand: 0.75, "area_band_<400": 0.05, "area_band_>7500": 0.08, area_log_xl: 0.05 } };
  const at = (cm2: number | null) => ({ ...e, profile: shapeProfile, attrs: { ...e.attrs, areaCm2: { value: cm2, source: cm2 == null ? "default" : "catalogue" } } }) as any;
  const sizeBar = (cm2: number | null) => { const x = at(cm2); const r = stage3aValuation(x, cal, shapeMeans)!; return valuationWaterfall(x, cal, shapeMeans, r.medianGBP)!; };
  const small = sizeBar(297);
  eq("small sheet label names the band and side", small.bars.find((b) => b.key === "size")!.label, "Size: small, up to 20 cm a side (297 cm², catalogue)");
  ok("small sheet bar is the band effect against large", close(small.bars.find((b) => b.key === "size")!.logEffect, -0.2));   // large is the reference size
  const big = sizeBar(30000);
  const bigBar = big.bars.find((b) => b.key === "size")!;
  ok("extra-large label gives the band and the per-doubling growth", bigBar.label.startsWith("Size: extra large, over 87 cm a side (30,000 cm², catalogue; larger still: x1.32 per doubling of area"));
  ok("extra-large bar adds the step and the log-area term above 7,500 cm²", close(bigBar.logEffect, 0.25 + 0.4 * Math.log(30000 / 7500)));
  eq("the chart still reaches the model price exactly (no gap note)", big.notes, []);
  eq("unknown size says so", sizeBar(null).bars.find((b) => b.key === "size")!.label, "Size: not stated (not stated: model default)");
}

// ── poster flag and offset technique (2026-09-17) ─────────────────────────────────
{
  const e = ev();
  const prof = { ...e.profile!, elasticities: { ...e.profile!.elasticities, poster: -0.6, process_offset: -0.3 } };
  const lot = (poster: boolean, process = "etching") => ({ ...e, profile: prof, attrs: { ...e.attrs, process: { value: process, source: "catalogue" }, poster: { value: poster, source: "catalogue" } } }) as any;
  const run = (x: any) => valuationWaterfall(x, cal, means, stage3aValuation(x, cal, means)!.medianGBP)!;
  const wp = run(lot(true));
  const bar = wp.bars.find((b) => b.key === "poster");
  ok("a poster lot gets a Poster bar worth the artist's poster term", !!bar && close(bar.logEffect, -0.6) && bar.label === "Poster: yes (catalogue)");
  eq("poster: the chart still reaches the model price exactly (no gap note)", wp.notes, []);
  ok("not a poster: no Poster bar", !run(lot(false)).bars.some((b) => b.key === "poster"));
  const wo = run(lot(false, "offset"));
  ok("offset technique is named in the start and priced in it", wo.bars[0].label.startsWith("X, offset print:") && wo.notes.length === 0);
  const profA = { ...prof, elasticities: { ...prof.elasticities, after: -1.2 } };
  const afterLot = { ...e, profile: profA, attrs: { ...e.attrs, after: { value: true, source: "catalogue", note: "after" } } } as any;
  const wa = valuationWaterfall(afterLot, cal, means, stage3aValuation(afterLot, cal, means)!.medianGBP)!;
  const ab = wa.bars.find((b) => b.key === "after");
  ok("an 'after' lot gets an Attribution bar worth the artist's after term, first among attributes", !!ab && close(ab.logEffect, -1.2) && wa.bars[1].key === "after" && ab.label.startsWith("Attribution: after the artist"));
  eq("after: the chart still reaches the model price exactly", wa.notes, []);
  ok("the artist's own print: no Attribution bar", !run(lot(false)).bars.some((b) => b.key === "after"));
  const profO = { ...prof, elasticities: { ...prof.elasticities, object: 0.4 } };
  const objLot = { ...e, profile: profO, attrs: { ...e.attrs, object: { value: true, source: "catalogue" } } } as any;
  const wob = valuationWaterfall(objLot, cal, means, stage3aValuation(objLot, cal, means)!.medianGBP)!;
  ok("an object multiple gets an Object multiple bar worth the artist's object term", close(wob.bars.find((b) => b.key === "object")?.logEffect ?? NaN, 0.4) && wob.notes.length === 0);
  const noPoster = { ...e, attrs: { ...e.attrs } } as any; delete noPoster.attrs.poster;
  ok("evidence built before the poster flag still charts", run(noPoster).notes.length === 0);
}

console.log(`\nstage3a waterfall tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
