/**
 * Pure-function tests for price_blend.ts — the witness construction, the priors-model
 * prediction, the grid posterior, the hurdle and the calibration fit. No graph, no randomness.
 * Synthetic numbers are round so the expected values can be checked by hand.
 *
 *   npm run test:price-blend
 */
import {
  blendPrices,
  blendWitnesses,
  calibratedWitnesses,
  rawWitnesses,
  priorsModelPrediction,
  fitBlendCalibration,
  defaultCalibration,
  hurdleFrom,
  crpsOnGrid,
  sameWorkBand,
  type BlendInputs,
  type PriceWitness,
  type FitRow,
} from "../../src/appraisal/knowledge_graph/price_blend";
import type { ArtistPriceProfile } from "../../src/appraisal/knowledge_graph/artist_price_profile";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
function close(label: string, got: number, want: number, tol = 1e-6) {
  if (Math.abs(got - want) <= tol * Math.max(1, Math.abs(want))) passed++;
  else { failed++; console.log(`  FAIL ${label}\n       got  ${got}\n       want ${want}`); }
}
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }

const LN = Math.log;
const inputs = (over: Partial<BlendInputs> = {}): BlendInputs => ({
  saleDate: "2024-03-01", house: "roseberys", estimate: { lowGBP: 800, highGBP: 1200 },
  sameWork: [], sameArtistTechnique: null, sameArtist: null, priors: null, sellThrough: null, ...over,
});

// ── rawWitnesses ──────────────────────────────────────────────────────────────
{
  const w = rawWitnesses(inputs());
  eq("estimate only -> one witness keyed by house", w.map((x) => [x.source, x.key]), [["estimate", "roseberys"]]);
  close("estimate raw mu is log midpoint", w[0].rawMu, LN(1000));
  const sw = rawWitnesses(inputs({ sameWork: [{ hammerGBP: 400, saleDate: "2022-01-01" }, { hammerGBP: 900, saleDate: "2023-05-05" }, { hammerGBP: 600, saleDate: null }] }));
  const s = sw.find((x) => x.source === "same_work")!;
  close("same_work raw mu is the log median", s.rawMu, LN(600));
  eq("same_work key is the n band", s.key, "3+");
  eq("same_work samples are sorted logs", s.rawSamples!.map((x) => Math.round(Math.exp(x))), [400, 600, 900]);
  ok("same_work basis names the latest dated sale", s.basis.includes("2023-05-05"));
  eq("n bands", [sameWorkBand(1), sameWorkBand(2), sameWorkBand(7)], ["1", "2", "3+"]);
  const none = rawWitnesses(inputs({ estimate: null, sameWork: [{ hammerGBP: 0, saleDate: null }] }));
  eq("zero-hammer comps and a missing estimate give no witnesses", none.length, 0);
  const t = rawWitnesses(inputs({ estimate: null, sameArtistTechnique: { n: 5, medianHammerGBP: 300 }, sameArtist: { n: 20, medianHammerGBP: 250 }, priors: { mu: LN(500), basis: "prior", earlierSales: 9, contributions: [] } }));
  eq("tier 2/3 and priors witnesses", t.map((x) => [x.source, x.key]), [["same_artist_technique", "all"], ["same_artist", "all"], ["priors_model", "prior"]]);
}

// ── priorsModelPrediction ─────────────────────────────────────────────────────
const profile: ArtistPriceProfile = {
  canonicalName: "Test Artist", level: 6.0,
  elasticities: { signature_hand: LN(2), "edition_band_>300": LN(0.5), process_etching: LN(1.5), "house_Roseberys London": LN(0.8), edition_log: 0.1, area_log: 0 },
  multipliers: {}, neighbours: [], run: "test", basis: "shrunk", earlierSales: 50, segment: null,
  referenceLevels: { signature: "unsigned", proof: "numbered", edition_band: "76-150", area_band: "400-900", process: "lithograph", house: "Bonhams" },
  continuousMedians: { edition_log: LN(100), area_log: LN(600) },
  yearEffects: { "2022": 0.3, "2024": 0.1 },
};
{
  // reference lot: unsigned numbered lithograph, edition 100 (=median), area in the reference band, Bonhams, 2024
  const ref = priorsModelPrediction({ signature: "unsigned", proof: "numbered", editionSize: 100, areaCm2: 600, process: "lithograph" }, profile, { saleDate: "2024-06-01", house: "Bonhams" });
  close("reference lot = level + median part + year", ref.mu, 6.0 + 0.1 * LN(100) + 0.1);
  eq("reference lot contributions: level and year only", ref.contributions.map((c) => c.term), ["artist level", "sale year 2024"]);
  close("artist level folds the continuous median part in", ref.contributions[0].logEffect, 6.0 + 0.1 * LN(100));
  const lot = priorsModelPrediction({ signature: "hand", proof: "numbered", editionSize: 400, areaCm2: 600, process: "etching" }, profile, { saleDate: "2022-01-01", house: "Roseberys London" });
  close("signed etching, edition 400, Roseberys, 2022", lot.mu, 6.0 + 0.1 * LN(100) + LN(2) + LN(0.5) + 0.1 * (LN(400) - LN(100)) + LN(1.5) + LN(0.8) + 0.3);
  eq("every non-reference attribute is a contribution", lot.contributions.map((c) => c.term), ["artist level", "signature=hand", "edition_band=>300", "process=etching", "edition size=400", "house=Roseberys London", "sale year 2022"]);
  const forum = priorsModelPrediction({ signature: null, proof: null, editionSize: null, areaCm2: null, process: "screenprint" }, profile, { saleDate: "2030-01-01", house: "Forum Auctions" });
  close("unknown attrs take reference/median; unseen year is 0", forum.mu, 6.0 + 0.1 * LN(100));
  eq("unseen house, process and the levels this profile lacks are listed, not applied", forum.unknownColumns, ["area_band_unknown", "edition_band_unknown", "house_Forum Auctions", "process_screenprint", "proof_unknown"]);
}

// ── grid posterior ─────────────────────────────────────────────────────────────
const gauss = (source: PriceWitness["source"], mu: number, sigma: number, weight = 1): PriceWitness => ({ source, mu, rawMu: mu, sigma, weight, df: null, key: "all", basis: "" });
{
  const single = blendWitnesses([gauss("estimate", LN(1000), 0.3)], { regime: "with_estimate" })!;
  close("single Gaussian: median is its mean", LN(single.medianGBP), LN(1000), 1e-3);
  close("single Gaussian: p90 is mean + 1.28 sigma", LN(single.p90GBP), LN(1000) + 1.2816 * 0.3, 2e-2);
  const two = blendWitnesses([gauss("estimate", 7, 1), gauss("same_work", 9, 1)], { regime: "with_estimate" })!;
  close("equal Gaussians: precision-weighted mean", LN(two.medianGBP), 8, 1e-2);
  close("equal Gaussians: posterior sigma is 1/sqrt(2)", (LN(two.p90GBP) - LN(two.p10GBP)) / (2 * 1.2816), Math.SQRT1_2, 3e-2);
  const unequal = blendWitnesses([gauss("estimate", 7, 0.5), gauss("same_work", 9, 1)], { regime: "with_estimate" })!;
  close("precision weighting: mean = 7 + (0*4 + 2*1)/5", LN(unequal.medianGBP), 7.4, 1e-2);
  const weighted = blendWitnesses([gauss("estimate", 7, 1, 3), gauss("same_work", 9, 1, 1)], { regime: "with_estimate" })!;
  close("pool weight multiplies precision: 7 + (0*3 + 2*1)/4", LN(weighted.medianGBP), 7.5, 1e-2);
  const tempered = blendWitnesses([gauss("estimate", 7, 1), gauss("same_work", 9, 1)], { regime: "with_estimate", temperature: 4 })!;
  close("temperature does not move a symmetric median", LN(tempered.medianGBP), 8, 1e-2);
  close("temperature 4 doubles the interval", (LN(tempered.p90GBP) - LN(tempered.p10GBP)) / (LN(two.p90GBP) - LN(two.p10GBP)), 2, 3e-2);
  eq("zero-weight witnesses give no blend", blendWitnesses([gauss("estimate", 7, 1, 0)], { regime: "with_estimate" }), null);
  eq("effective weights are normalised over active witnesses", weighted.witnesses.map((w) => w.effectiveWeight), [0.75, 0.25]);
  const div = blendWitnesses([gauss("estimate", 7, 1), gauss("same_work", 7.8, 1), gauss("priors_model", 7.2, 1)], { regime: "with_estimate", divergenceThreshold: 0.5 })!;
  eq("divergence lists only pairs over the threshold", div.divergence.map((d) => [d.a, d.b, +d.logGap.toFixed(2)]), [["estimate", "same_work", -0.8], ["same_work", "priors_model", 0.6]]);
  // Kernel density: two clusters of the same plate stay bimodal
  const kde: PriceWitness = { source: "same_work", mu: 8, rawMu: 8, sigma: 0.15, weight: 1, df: null, key: "3+", basis: "", samples: [7, 7, 7, 9, 9, 9] };
  const bi = blendWitnesses([kde], { regime: "no_estimate" })!;
  const dAt = (x: number) => bi.grid.reduce((best, g) => (Math.abs(g.logPrice - x) < Math.abs(best.logPrice - x) ? g : best)).density;
  ok("KDE over two clusters is bimodal: density at the midpoint far below the modes", dAt(8) < 0.05 * dAt(7) && dAt(8) < 0.05 * dAt(9));
  // Student-t tails: an outlying witness pulls a t posterior less than a Gaussian one
  const tG = blendWitnesses([gauss("estimate", 7, 0.3), gauss("same_work", 10, 0.3)], { regime: "with_estimate" })!;
  const tT = blendWitnesses([{ ...gauss("estimate", 7, 0.3), df: 3 }, { ...gauss("same_work", 10, 0.3), df: 3 }], { regime: "with_estimate" })!;
  ok("Gaussian product of two distant witnesses sits at the midpoint", Math.abs(LN(tG.medianGBP) - 8.5) < 0.05);
  ok("Student-t product of the same two is bimodal, median still between them", LN(tT.medianGBP) > 7 && LN(tT.medianGBP) < 10);
  const crpsGood = crpsOnGrid(single, LN(1000)), crpsBad = crpsOnGrid(single, LN(4000));
  ok("CRPS grows with the miss", crpsBad > crpsGood && crpsGood > 0);
}

// ── hurdle ─────────────────────────────────────────────────────────────────────
{
  eq("no history -> null", hurdleFrom(null).pSells, null);
  eq("zero appearances -> null", hurdleFrom({ sold: 0, unsold: 0 }).pSells, null);
  eq("never sold -> measured 59%", hurdleFrom({ sold: 0, unsold: 2 }).pSells, 0.59);
  eq("sold before -> base 70%", hurdleFrom({ sold: 1, unsold: 3 }).pSells, 0.7);
}

// ── calibratedWitnesses / blendPrices with the default calibration ─────────────
{
  const cal = defaultCalibration();
  const c = calibratedWitnesses(inputs(), cal);
  eq("regime inferred from the estimate", c.regime, "with_estimate");
  close("estimate de-biased by the drift", c.witnesses[0].mu, LN(1000) + LN(0.82));
  eq("key falls back to 'all' when the house has no entry", c.witnesses[0].key, "all");
  const noEst = calibratedWitnesses(inputs({ estimate: null, priors: { mu: LN(700), basis: "shrunk", earlierSales: 30, contributions: [] } }), cal);
  eq("no estimate -> no_estimate regime, priors witness carried", [noEst.regime, noEst.witnesses.map((w) => w.source)], ["no_estimate", ["priors_model"]]);
  const forced = calibratedWitnesses(inputs({ priors: { mu: LN(700), basis: "shrunk", earlierSales: 30, contributions: [] } }), cal, "no_estimate");
  eq("forcing no_estimate drops the estimate witness even when present", forced.witnesses.map((w) => w.source), ["priors_model"]);
  const b = blendPrices(inputs({ sellThrough: { sold: 0, unsold: 1 } }), cal)!;
  close("estimate-only blend median is the de-biased midpoint", b.medianGBP, 820, 1e-2);
  eq("hurdle rides along", b.pSells, 0.59);
  eq("no witnesses -> null", blendPrices(inputs({ estimate: null }), cal), null);
}

// ── fitBlendCalibration on synthetic lots ──────────────────────────────────────
{
  // Deterministic pseudo-noise so the fit is reproducible without Math.random.
  let seed = 7; const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
  const rows: FitRow[] = [];
  for (let i = 0; i < 300; i++) {
    const y = 5 + 3 * (i / 300);                    // log hammer 150..3000 GBP
    const hammer = Math.exp(y);
    const estMid = Math.exp(y - LN(0.8) + 0.25 * noise());   // house prints ~1.25x hammer, tight
    const swN = i % 3;                                          // 0, 1 or 2 same-work comps
    const sameWork = Array.from({ length: swN }, () => ({ hammerGBP: Math.exp(y + 0.2 + 0.6 * noise()), saleDate: "2022-01-01" }));
    const priors = { mu: y - 0.4 + 0.9 * noise(), basis: "shrunk", earlierSales: 40, contributions: [] };
    rows.push({ inputs: inputs({ estimate: { lowGBP: estMid * 0.8, highGBP: estMid * 1.2 }, sameWork, priors }), hammerGBP: hammer });
  }
  const cal = fitBlendCalibration(rows, { version: "BLEND-TEST", fittedOn: "synthetic", fittedAt: "2026-09-14T00:00:00Z" });
  close("estimate bias recovers the planted drift", cal.witnesses.estimate.byKey.roseberys.bias, LN(0.8), 0.06);
  close("priors bias recovers the planted +0.4", cal.witnesses.priors_model.byKey.shrunk.bias, 0.4, 0.12);
  ok("estimate sigma is the tightest", cal.witnesses.estimate.byKey.all.sigma < cal.witnesses.same_work.byKey.all.sigma && cal.witnesses.estimate.byKey.all.sigma < cal.witnesses.priors_model.byKey.all.sigma);
  ok("same_work keyed by n band with enough lots", "1" in cal.witnesses.same_work.byKey && "2" in cal.witnesses.same_work.byKey);
  const infl = (src: "estimate" | "priors_model") => cal.regimes.with_estimate.weights[src] / cal.witnesses[src].byKey.all.sigma ** 2;
  ok("with-estimate regime: the estimate's weighted precision dominates the priors model's", infl("estimate") > 3 * infl("priors_model"));
  ok("no-estimate regime keeps the priors witness (the only one a third of the lots have)", cal.regimes.no_estimate.weights.priors_model > 0 && cal.regimes.no_estimate.fitLots === 300);
  eq("no-estimate regime never weights the estimate", cal.regimes.no_estimate.weights.estimate, 0);
  ok("fitted coverage lands near 80%", Math.abs(cal.regimes.with_estimate.fitCoverage80 - 0.8) < 0.08 && Math.abs(cal.regimes.no_estimate.fitCoverage80 - 0.8) < 0.08);
  ok("with-estimate MAE beats the no-estimate MAE on these lots", cal.regimes.with_estimate.fitMaeLog < cal.regimes.no_estimate.fitMaeLog);
  const again = fitBlendCalibration(rows, { version: "BLEND-TEST", fittedOn: "synthetic", fittedAt: "2026-09-14T00:00:00Z" });
  eq("the fit is deterministic", JSON.stringify(again), JSON.stringify(cal));
}

console.log(`\nprice_blend tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
