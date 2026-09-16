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
  houseOffsetOf,
  timeShift,
  houseMixOf,
  type HouseOffsets,
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
  sameWork: [], sameArtistTechnique: null, sameArtist: null, priors: null, sellThrough: null, recentSameHouseAppearance: null, ...over,
});

// ── rawWitnesses ──────────────────────────────────────────────────────────────
{
  const w = rawWitnesses(inputs());
  eq("estimate only -> one witness keyed by house", w.map((x) => [x.source, x.keys]), [["estimate", ["roseberys"]]]);
  close("estimate raw mu is log midpoint", w[0].rawMu, LN(1000));
  const sw = rawWitnesses(inputs({ sameWork: [{ hammerGBP: 400, saleDate: "2022-01-01" }, { hammerGBP: 900, saleDate: "2023-05-05" }, { hammerGBP: 600, saleDate: null }] }));
  const s = sw.find((x) => x.source === "same_work")!;
  close("same_work raw mu is the log median", s.rawMu, LN(600));
  eq("same_work keys: n band with the newest comp's age, then the band alone", s.keys, ["3+|recent", "3+"]);
  eq("same_work samples are sorted logs", s.rawSamples!.map((x) => Math.round(Math.exp(x))), [400, 600, 900]);
  ok("same_work basis names the latest dated sale", s.basis.includes("2023-05-05"));
  eq("n bands", [sameWorkBand(1), sameWorkBand(2), sameWorkBand(7)], ["1", "2", "3+"]);
  const none = rawWitnesses(inputs({ estimate: null, sameWork: [{ hammerGBP: 0, saleDate: null }] }));
  eq("zero-hammer comps and a missing estimate give no witnesses", none.length, 0);
  const t = rawWitnesses(inputs({ estimate: null, sameArtistTechnique: { n: 5, medianHammerGBP: 300 }, sameArtist: { n: 20, medianHammerGBP: 250 }, priors: { mu: LN(500), basis: "prior", earlierSales: 9, contributions: [] } }));
  eq("tier 2/3 and priors witnesses", t.map((x) => [x.source, x.keys]), [["same_artist_technique", []], ["same_artist", []], ["priors_model", ["prior"]]]);
  const old = rawWitnesses(inputs({ sameWork: [{ hammerGBP: 400, saleDate: "2015-01-01" }] })).find((x) => x.source === "same_work")!;
  eq("a lone comp older than RECENT_COMP_YEARS keys as old", old.keys, ["1|old", "1"]);
  const undated = rawWitnesses(inputs({ saleDate: null, sameWork: [{ hammerGBP: 400, saleDate: "2015-01-01" }] })).find((x) => x.source === "same_work")!;
  eq("no valuation date -> band key only", undated.keys, ["1"]);
}

// ── house offsets: re-basing comps and the priors house term ───────────────────
const offsets: HouseOffsets = {
  version: "TEST", referenceHouse: "Bonhams",
  houses: { Bonhams: { log: 0, se: 0 }, "Forum Auctions": { log: LN(0.8), se: 0.04 }, "Roseberys London": { log: LN(0.9), se: 0.03 } },
  pooledFallback: { log: LN(0.85), betweenHouseSd: 0.1 },
};
{
  eq("house lookup is case-insensitive and substring-tolerant", [houseOffsetOf(offsets, "forum").name, houseOffsetOf(offsets, "BONHAMS").measured], ["Forum Auctions", true]);
  eq("an unknown house takes the pooled fallback, flagged unmeasured", [houseOffsetOf(offsets, "Swann Auction Galleries").measured, +houseOffsetOf(offsets, null).log.toFixed(4)], [false, +LN(0.85).toFixed(4)]);
  const lot = inputs({
    estimate: null, targetHouse: "Forum Auctions",
    sameWork: [{ hammerGBP: 1000, saleDate: "2023-01-01", house: "Bonhams" }, { hammerGBP: 800, saleDate: "2023-06-01", house: "Forum Auctions" }],
    sameArtistTechnique: { n: 2, medianHammerGBP: 999, comps: [{ hammerGBP: 900, saleDate: null, house: "Roseberys London" }, { hammerGBP: 500, saleDate: null, house: "Bonhams" }] },
    priors: { mu: LN(1000) + LN(0.7), basis: "shrunk", earlierSales: 40, contributions: [{ term: "artist level", logEffect: LN(1000) }, { term: "house=Roseberys London", logEffect: LN(0.7) }] },
  });
  const w = rawWitnesses(lot, offsets);
  const sw = w.find((x) => x.source === "same_work")!;
  eq("same-work comps re-based to the target house: Bonhams 1000 -> 800, Forum 800 stays", sw.rawSamples!.map((x) => Math.round(Math.exp(x))), [800, 800]);
  ok("basis says the comps were re-based", sw.basis.includes("re-based to Forum Auctions"));
  const t2 = w.find((x) => x.source === "same_artist_technique")!;
  // Roseberys 900 -> 900 x 0.8/0.9 = 800; Bonhams 500 -> 400; median of 400 and 800 = sqrt(400*800) in log space
  close("tier-2 median re-taken over re-based comps, not the stored median", t2.rawMu, (LN(400) + LN(800)) / 2);
  const pr = w.find((x) => x.source === "priors_model")!;
  close("priors: the model's own house term is swapped for the target's offset", pr.rawMu, LN(1000) + LN(0.8));
  eq("priors contributions carry exactly one house term, the target's", pr.contributions!.map((c) => c.term), ["artist level", "house=Forum Auctions"]);
  const noTarget = rawWitnesses({ ...lot, targetHouse: null }, offsets);
  close("no target house -> comps re-based to the pooled level (Bonhams 1000 x 0.85)", noTarget.find((x) => x.source === "same_work")!.rawSamples![1], LN(1000) + LN(0.85));
  eq("no target house -> the priors house term names the pooled offset", noTarget.find((x) => x.source === "priors_model")!.contributions!.at(-1)!.term, "house=none chosen (pooled offset)");
  const noOffsets = rawWitnesses({ ...lot, targetHouse: null }, null);
  close("no offsets table at all -> no re-basing", noOffsets.find((x) => x.source === "same_work")!.rawSamples![1], LN(1000));
  const unmeasured = rawWitnesses({ ...lot, targetHouse: "Swann Auction Galleries" }, offsets).find((x) => x.source === "priors_model")!;
  ok("an unmeasured target house is named as such in the contribution", unmeasured.contributions!.some((c) => c.term.includes("unmeasured")));
  const cal = { ...defaultCalibration(), houseOffsets: offsets };
  const measuredSigma = calibratedWitnesses({ ...lot, targetHouse: "Forum Auctions" }, cal).witnesses.find((x) => x.source === "priors_model")!.sigma;
  const pooledSigma = calibratedWitnesses({ ...lot, targetHouse: "Swann Auction Galleries" }, cal).witnesses.find((x) => x.source === "priors_model")!.sigma;
  close("an unmeasured house adds the between-house SD in quadrature", pooledSigma, Math.sqrt(measuredSigma ** 2 + 0.1 ** 2));
}

// ── time adjustment ────────────────────────────────────────────────────────────
{
  const idx = { version: "T", referenceHouse: "Bonhams", houses: { Bonhams: { log: 0, se: 0 } }, pooledFallback: { log: 0, betweenHouseSd: 0 }, yearEffects: { "2015": -0.3, "2020": 0, "2023": 0.2, "2024": 0.1 } } as HouseOffsets;
  eq("no mode -> no shift", timeShift(idx, "2015-05-01", "2024-06-01"), 0);
  close("prior_year: a 2015 comp for a 2024 lot moves to the 2023 level", timeShift({ ...idx, timeAdjust: "prior_year" }, "2015-05-01", "2024-06-01"), 0.2 - -0.3);
  close("sale_year: to the lot's own year (leaky upper bound)", timeShift({ ...idx, timeAdjust: "sale_year" }, "2015-05-01", "2024-06-01"), 0.1 - -0.3);
  eq("comps at or after the target year are never moved back", [timeShift({ ...idx, timeAdjust: "prior_year" }, "2023-02-01", "2024-06-01"), timeShift({ ...idx, timeAdjust: "prior_year" }, "2024-01-01", "2024-06-01")], [0, 0]);
  close("unmeasured years clamp to the nearest measured one", timeShift({ ...idx, timeAdjust: "prior_year" }, "2010-01-01", "2030-01-01"), 0.1 - -0.3);
  const w = rawWitnesses(inputs({ estimate: null, sameWork: [{ hammerGBP: 1000, saleDate: "2015-01-01" }] }), { ...idx, timeAdjust: "prior_year" });
  close("same-work samples carry the time shift", w[0].rawSamples![0], LN(1000) + 0.5);
  ok("basis says the comps were market-adjusted", w[0].basis.includes("market-adjusted"));
}

// ── house mix on the artist-level witnesses ────────────────────────────────────
{
  // Two houses whose lots sell at the same level against same-work comps, but House B sells an
  // artist's cheaper works: its tier-2 median and priors read x2 high. The mix term must catch
  // that on tier 2 and priors and leave same-work alone.
  const rows: FitRow[] = [];
  for (let i = 0; i < 120; i++) {
    const house = i % 2 ? "House B" : "House A";
    const y = 6 + (i % 10) * 0.1;
    const skew = house === "House B" ? LN(2) : 0;
    rows.push({ hammerGBP: Math.exp(y), inputs: inputs({
      estimate: null, targetHouse: house,
      sameWork: [{ hammerGBP: Math.exp(y + ((i % 3) - 1) * 0.1), saleDate: "2023-01-01" }],
      sameArtistTechnique: { n: 5, medianHammerGBP: Math.exp(y + skew + ((i % 5) - 2) * 0.1) },
      priors: { mu: y + skew + ((i % 7) - 3) * 0.05, basis: "shrunk", earlierSales: 40, contributions: [] },
    }) });
  }
  const off = fitBlendCalibration(rows, { version: "T", fittedOn: "synthetic", fittedAt: "2026-09-16T00:00:00Z" });
  eq("house mix is off unless asked for", off.witnesses.priors_model.houseMix, undefined);
  const cal = fitBlendCalibration(rows, { version: "T", fittedOn: "synthetic", fittedAt: "2026-09-16T00:00:00Z", houseMix: true });
  const mA = houseMixOf(cal.witnesses.priors_model, "House A")!.logEffect, mB = houseMixOf(cal.witnesses.priors_model, "House B")!.logEffect;
  close("priors mix gap between the houses recovers the planted x2", mA - mB, LN(2), 0.08);
  close("tier-2 mix gap likewise", houseMixOf(cal.witnesses.same_artist_technique, "House A")!.logEffect - houseMixOf(cal.witnesses.same_artist_technique, "House B")!.logEffect, LN(2), 0.08);
  eq("same-work carries no mix term", cal.witnesses.same_work.houseMix, undefined);
  eq("an unseen house has no mix term", houseMixOf(cal.witnesses.priors_model, "House C"), null);
  const w = calibratedWitnesses(rows[1].inputs, cal, "no_estimate").witnesses.find((x) => x.source === "priors_model")!;
  close("witness mu applies key bias + house mix", w.mu, w.rawMu + w.keyBias! + w.houseMix!.logEffect);
  eq("the witness names its mix house", w.houseMix!.house, "House B");
  const b = calibratedWitnesses(rows[1].inputs, cal, "no_estimate").witnesses.find((x) => x.source === "priors_model")!;
  const a = calibratedWitnesses(rows[0].inputs, cal, "no_estimate").witnesses.find((x) => x.source === "priors_model")!;
  close("after mix, both houses' priors de-bias to within noise of the truth", Math.abs((b.mu - LN(rows[1].hammerGBP)) - (a.mu - LN(rows[0].hammerGBP))), 0, 0.15);
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
