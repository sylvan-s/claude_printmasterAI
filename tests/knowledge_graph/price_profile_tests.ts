/**
 * Pure-function tests for artist_price_profile.ts — the same-work comp adjustment and the
 * segment-key mirror of build_priors.py. No graph. The synthetic profile uses round multipliers
 * so every expected value can be checked by hand; the band boundaries are the model's own
 * (train_price_model.py edition_band / area_band).
 *
 *   npm run test:price-profile
 */
import {
  adjustmentBetween,
  editionBand,
  areaBand,
  periodOf,
  nationalityGroup,
  segmentKey,
  pickSegmentDefault,
  multipliersFrom,
  type ArtistPriceProfile,
} from "../../src/appraisal/knowledge_graph/artist_price_profile";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
function close(label: string, got: number, want: number, tol = 1e-9) {
  if (Math.abs(got - want) <= tol * Math.max(1, Math.abs(want))) passed++;
  else { failed++; console.log(`  FAIL ${label}\n       got  ${got}\n       want ${want}`); }
}

const LN = Math.log;
const elasticities = {
  signature_hand: LN(2.2),
  signature_stamped: LN(0.97),
  proof_artist_proof: LN(1.2),
  "edition_band_>300": LN(0.5),
  "edition_band_<=30": LN(1.5),
  process_screenprint: LN(3),
  process_etching: LN(1.4),
  "area_band_>1800": LN(1.3),
  edition_log: LN(1.1) / LN(2),   // x1.1 per doubling
  area_log: 0,
};
const profile: ArtistPriceProfile = {
  canonicalName: "Test Artist",
  level: 8.0,
  elasticities,
  multipliers: multipliersFrom(elasticities),
  neighbours: [],
  run: "PRICING-PRIORS-1.1@test",
  basis: "shrunk",
  earlierSales: 100,
  segment: null,
  referenceLevels: { signature: "unsigned", proof: "numbered", edition_band: "76-150", area_band: "400-900", process: "lithograph", house: "Bonhams" },
  continuousMedians: { edition_log: LN(100), area_log: LN(600) },
  yearEffects: {},
};

// ── multipliersFrom: per-doubling for the continuous terms ───────────────────
close("categorical multiplier is exp(coef)", profile.multipliers.signature_hand, 2.2);
close("continuous multiplier is per doubling", profile.multipliers.edition_log, 1.1);

// ── adjustmentBetween ────────────────────────────────────────────────────────
const base = { signature: "unsigned" as const, proof: "numbered" as const, editionSize: 100, areaCm2: 600, process: "lithograph" };
let a = adjustmentBetween(base, base, profile);
close("identical impressions -> 1", a.multiplier, 1);
eq("identical -> no factors", a.factors, []);
eq("identical -> no unknowns", a.unknownColumns, []);

a = adjustmentBetween({ ...base, signature: "hand" }, base, profile);
close("hand-signed lot vs unsigned comp -> x2.2", a.multiplier, 2.2);
eq("factor attributed to signature", a.factors.map((f) => [f.attribute, f.lot, f.comp]), [["signature", "hand", "unsigned"]]);
close("reverse direction is the reciprocal", adjustmentBetween(base, { ...base, signature: "hand" }, profile).multiplier, 1 / 2.2);

a = adjustmentBetween({ ...base, signature: "hand" }, { ...base, signature: "stamped" }, profile);
close("hand vs stamped: neither is the reference", a.multiplier, 2.2 / 0.97);

a = adjustmentBetween({ ...base, editionSize: 400 }, base, profile);
close("edition 400 vs 100: band x0.5 and two doublings x1.1^2", a.multiplier, 0.5 * 1.1 * 1.1);
eq("both the band and the continuous term are reported", a.factors.map((f) => f.attribute), ["edition_band", "edition_log"]);

a = adjustmentBetween({ ...base, editionSize: null }, base, profile);
close("unknown lot edition: band 'unknown' has no coef in this run, continuous at the median -> 1", a.multiplier, 1);
eq("…and the missing band column is surfaced", a.unknownColumns, ["edition_band_unknown"]);

a = adjustmentBetween({ ...base, editionSize: 50 }, { ...base, editionSize: null }, profile);
close("known lot vs unknown comp: continuous term against the median (100 -> 50 is one halving); neither band has a coef here", a.multiplier, 1 / 1.1);
eq("…both missing band columns are surfaced", a.unknownColumns, ["edition_band_31-75", "edition_band_unknown"]);
a = adjustmentBetween({ ...base, editionSize: 20 }, { ...base, editionSize: null }, profile);
close("edition 20 vs unknown: band <=30 x1.5, continuous 20 vs median 100", a.multiplier, 1.5 * Math.pow(1.1, Math.log2(20 / 100)));

a = adjustmentBetween({ ...base, process: "mezzotint" }, base, profile);
close("process the run never saw contributes nothing", a.multiplier, 1);
eq("…and is listed", a.unknownColumns, ["process_mezzotint"]);

a = adjustmentBetween({ ...base, process: "Screenprint" }, base, profile);
close("process is case-insensitive", a.multiplier, 3);

a = adjustmentBetween({ ...base, signature: null }, base, profile);
close("null signature is the model's unsigned, not unknown", a.multiplier, 1);
eq("…no unknown column", a.unknownColumns, []);

a = adjustmentBetween({ ...base, proof: null }, base, profile);
close("null proof is the 'unknown' level, which this run has no coef for", a.multiplier, 1);
eq("…and is listed", a.unknownColumns, ["proof_unknown"]);

a = adjustmentBetween({ ...base, signature: "hand", process: "screenprint", proof: "artist_proof" }, base, profile);
close("differences multiply", a.multiplier, 2.2 * 3 * 1.2);

a = adjustmentBetween({ ...base, areaCm2: 2400 }, { ...base, areaCm2: 600 }, profile);
close("area band moves, area per doubling is x1 here", a.multiplier, 1.3);
eq("only the band is a factor when the continuous coef is zero", a.factors.map((f) => f.attribute), ["area_band"]);

// house is not an attribute: nothing to pass, nothing applied
eq("PriceAttrs has no house key", "house" in base, false);

// ── bands (boundaries are the model's) ───────────────────────────────────────
eq("edition bands", [1, 30, 31, 75, 76, 150, 151, 300, 301].map(editionBand), ["<=30", "<=30", "31-75", "31-75", "76-150", "76-150", "151-300", "151-300", ">300"]);
eq("edition unknowns", [null, undefined, 0, -5, NaN].map(editionBand), ["unknown", "unknown", "unknown", "unknown", "unknown"]);
eq("area bands", [1, 149.9, 150, 399.9, 400, 899.9, 900, 1799.9, 1800].map(areaBand), ["<150cm2", "<150cm2", "150-400", "150-400", "400-900", "400-900", "900-1800", "900-1800", ">1800"]);
eq("area unknowns", [null, 0].map(areaBand), ["unknown", "unknown"]);

// ── segment key mirror of build_priors.py ────────────────────────────────────
eq("period boundaries", [1606, 1799, 1800, 1879, 1880, 1929, 1930, 1974].map(periodOf), ["pre1800", "pre1800", "c19", "c19", "modern", "modern", "contemporary", "contemporary"]);
eq("period unknown", periodOf(null), "unknown");
eq("nationality groups", ["British", "English", "Scottish", "Welsh", "American", "German/American", "French", "française", "Spanish", "German", "Dutch", null].map(nationalityGroup),
  ["british", "british", "british", "british", "american", "american", "french", "french", "spanish", "german", "other", "other"]);
eq("Banksy", segmentKey("British", 1974), "british|contemporary");
eq("Rembrandt", segmentKey("Dutch", 1606), "other|pre1800");
eq("nothing known", segmentKey(null, null), "other|unknown");

const defaults = { "british|modern": "exact", "british|any": "nat", "any|modern": "period", "any|any": "global" };
eq("exact cell first", pickSegmentDefault(defaults, "british|modern")?.key, "british|modern");
eq("then the nationality marginal", pickSegmentDefault(defaults, "british|c19")?.key, "british|any");
eq("then the period marginal", pickSegmentDefault(defaults, "spanish|modern")?.key, "any|modern");
eq("then global", pickSegmentDefault(defaults, "spanish|c19")?.key, "any|any");
eq("nothing -> null", pickSegmentDefault({}, "spanish|c19"), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
