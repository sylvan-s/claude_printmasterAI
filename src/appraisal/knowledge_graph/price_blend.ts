/**
 * price_blend — a deterministic Bayesian blend of the price witnesses Stage 3 has.
 *
 * Plan docs/plans/2026-09-13-attributed-lot-valuation.md, step 8. Every source of price
 * evidence becomes a WITNESS that emits a distribution over log(hammer GBP):
 *
 *   estimate                the house's printed range, midpoint de-biased by the measured drift
 *   same_work               realised hammers of the same ConceptualWork (tier 1 comps)
 *   same_artist_technique   tier 2 comp median — a plausibility band, wide sigma
 *   same_artist             tier 3 comp median — wider still
 *   priors_model            the artist's log-linear elasticities (step 6) applied to the lot's
 *                           own attributes, sale-year effect added back — a from-scratch number
 *
 * The combiner multiplies the witnesses' densities on a fixed grid over log-price and reads
 * the posterior median, an 80% interval and the divergence between witnesses off it. Nothing
 * here calls a model or the graph; the graph reads live in the callers (the backtest harness
 * and, once the gate passes, Stage 3). Sonnet's job becomes narrating the witness table.
 *
 * Four things the naive product of nominal Gaussians gets wrong, and what this module does:
 *   1. The witnesses are CORRELATED (the house saw the same comps we did), so nominal
 *      precisions double-count. Weights are FITTED on the hammer backtest (`fitBlendCalibration`),
 *      a linear opinion pool in log-density space, not the 1/sigma^2 of independent evidence.
 *   2. A comp witness's spread depends on the evidence: same_work sigma is calibrated per
 *      comp-count band, so n=1 is wide and n>=3 narrow; tier 2/3 carry their own residual.
 *   3. Liquidity is a HURDLE, not a price shift: P(sells) is reported beside the price
 *      distribution and never folded into the median.
 *   4. Gaussian tails are too thin for "one of four recorded impressions": witnesses are
 *      Student-t on the grid, and same_work is a kernel density over the actual comp hammers so
 *      a signed/unsigned split of one plate stays bimodal instead of averaging to a price
 *      nobody paid.
 *
 * Calibration is a committed JSON (knowledge_graph/pricing_ml/blend/), the pattern of the
 * priors: bias and sigma per witness per key, pool weights and a temperature per regime
 * (with / without an estimate). `defaultCalibration()` carries the plan-table figures for use
 * before a fit exists and for tests; it is NOT what Stage 3 should read.
 *
 * Pure: no I/O, no randomness. Same inputs, same numbers.
 */
import type { ArtistPriceProfile, PriceAttrs } from "./artist_price_profile.js";
import { editionBand, areaBand, areaBandFor } from "./artist_price_profile.js";

export type WitnessSource = "estimate" | "same_work" | "same_artist_technique" | "same_artist" | "priors_model";
export const WITNESS_SOURCES: WitnessSource[] = ["estimate", "same_work", "same_artist_technique", "same_artist", "priors_model"];
export type BlendRegime = "with_estimate" | "no_estimate";

/** What the callers collect for one lot — every number in GBP, nothing yet in log space. */
export interface BlendInputs {
  saleDate: string | null;
  /** Calibration key for the estimate witness: the house whose drift applies ("roseberys", "forum", ...). */
  house: string | null;
  estimate: { lowGBP: number; highGBP: number } | null;
  /**
   * The house the price is FOR, as the graph names it ("Forum Auctions"). With a calibration
   * that carries `houseOffsets`, every comp is re-based from its own house to this one and the
   * priors model's house term is replaced by this house's measured offset. Null or absent: no
   * re-basing, the pre-2026-09-16 behaviour.
   */
  targetHouse?: string | null;
  /** Tier-1 comps with a hammer, strictly before the lot's sale. `house` enables re-basing. */
  sameWork: CompSale[];
  /** `comps` (added 2026-09-16) lets the median be re-taken after re-basing; without it the stored median is used as-is. */
  sameArtistTechnique: { n: number; medianHammerGBP: number; comps?: CompSale[] } | null;
  sameArtist: { n: number; medianHammerGBP: number; comps?: CompSale[] } | null;
  /** From `priorsModelPrediction`, when the artist has a profile. */
  priors: { mu: number; basis: string; earlierSales: number | null; contributions: PriceContribution[] } | null;
  /** Pre-sale appearances of the same work, for the hurdle. */
  sellThrough: { sold: number; unsold: number } | null;
  /**
   * The single most recent PRE-SALE appearance of the same work AT THE SAME HOUSE (strictly
   * before this lot's own sale date), if any — house-scoped, unlike `sellThrough` which pools
   * every house. Added 2026-09-14 to replace an earlier liquidity feature that used AGGREGATE
   * sell-through and found no effect on the estimate; `relist_discount_report.ts` showed why —
   * the real practice is sequential and house-specific (Roseberys told the user directly: an
   * unsold lot is typically re-priced down ~30% for its next auction), not something an
   * aggregate rate captures. `daysAgo` is what lets the estimate model fit a decay: the measured
   * effect is strongest within ~180 days and fades by ~365.
   */
  recentSameHouseAppearance: { sold: boolean; daysAgo: number } | null;
}

export interface CompSale { hammerGBP: number; saleDate: string | null; house?: string | null }

export interface PriceContribution { term: string; logEffect: number }

export interface PriceWitness {
  source: WitnessSource;
  /** log GBP, calibration bias already removed. */
  mu: number;
  /** As the caller computed it, before de-biasing — kept for the report. */
  rawMu: number;
  sigma: number;
  /** Fitted pool weight; 0 drops the witness. */
  weight: number;
  /** Student-t degrees of freedom; null = Gaussian. */
  df: number | null;
  /** log GBP, de-biased. When set the witness is a kernel density over these. */
  samples?: number[];
  /** Calibration key the bias/sigma came from ("roseberys", "3+", "shrunk", "all"). */
  key: string;
  /** Human-readable provenance for the report. */
  basis: string;
  contributions?: PriceContribution[];
  /** The calibration bias applied from `key`, excluding the house mix. */
  keyBias?: number;
  /** The house-mix part of the bias, when the calibration has one for the target house. */
  houseMix?: { house: string; logEffect: number } | null;
}

export interface PriceBlend {
  regime: BlendRegime;
  grid: { logPrice: number; density: number }[];
  medianGBP: number;
  p10GBP: number;
  p90GBP: number;
  /** Hurdle: probability the lot sells at all. Null when there is no history to read. */
  pSells: number | null;
  pSellsBasis: string;
  witnesses: (PriceWitness & { effectiveWeight: number })[];
  /** Witness pairs whose de-biased means sit more than `divergenceThreshold` apart in log space. */
  divergence: { a: WitnessSource; b: WitnessSource; logGap: number }[];
}

export interface WitnessCalibration {
  df: number | null;
  /** bias = median(log hammer - raw mu) on the fit lots; sigma = 1.4826 x MAD of the de-biased residual. */
  byKey: Record<string, { bias: number; sigma: number; n: number }>;
  /**
   * House MIX, per target house (graph institution name): the median residual left after the
   * key bias, on that house's fit lots. Only the artist-level witnesses carry it (HOUSE_MIX_SOURCES).
   * It is additive to the key bias and kept apart from the like-for-like house offset, so the
   * report can show "house price level" and "house mix" as two separate factors. A house with
   * too few fit lots, or none, gets no entry and so no mix term.
   */
  houseMix?: Record<string, { bias: number; n: number }>;
}

/**
 * Witnesses that price the ARTIST rather than the print, and so inherit what a house tends to
 * sell: measured 2026-09-16, after house re-basing and time adjustment, tier-2/3 comps and the
 * priors model read x0.74-0.92 at Forum/Roseberys and x0.94-1.12 at Bonhams, while same-work
 * comps stayed within x0.91-0.99 everywhere. Same-work comps are left out on purpose.
 */
export const HOUSE_MIX_SOURCES: WitnessSource[] = ["same_artist_technique", "same_artist", "priors_model"];

/** The mix term for a witness at a target house, or null when the calibration has none for it. */
export function houseMixOf(cal: WitnessCalibration, house: string | null | undefined): { house: string; logEffect: number; n: number } | null {
  if (!cal.houseMix || !house) return null;
  const h = house.toLowerCase();
  for (const [name, v] of Object.entries(cal.houseMix)) {
    const n = name.toLowerCase();
    if (n === h || n.includes(h) || h.includes(n)) return { house: name, logEffect: v.bias, n: v.n };
  }
  return null;
}
export interface RegimeCalibration {
  weights: Record<WitnessSource, number>;
  /** Common divisor on the log-posterior; >1 widens the interval. Fitted for 80% coverage. */
  temperature: number;
  /** Per evidence tier, fitted for 80% coverage within the tier; a tier without enough fit lots uses `temperature`. */
  temperatureByTier?: Partial<Record<EvidenceTier, number>>;
  fitLots: number;
  fitMaeLog: number;
  fitCoverage80: number;
}
export interface BlendCalibration {
  version: string;
  fittedAt: string;
  fittedOn: string;
  witnesses: Record<WitnessSource, WitnessCalibration>;
  regimes: Record<BlendRegime, RegimeCalibration>;
  divergenceThreshold: number;
  /** Like-for-like house price levels (knowledge_graph/pricing_ml/house_offsets.py). Absent: no re-basing. */
  houseOffsets?: HouseOffsets | null;
}

/**
 * The shape house_offsets.py writes, trimmed to what the blend reads. Every entry is log hammer
 * against `referenceHouse` for the SAME work, sale year and signed status — a house effect, not
 * a mix effect.
 */
export interface HouseOffsets {
  version: string;
  referenceHouse: string;
  houses: Record<string, { log: number; se: number }>;
  /** For a house with no hammer data: the measured houses' weighted mean, and their spread,
   *  which is added in quadrature to every witness sigma because the offset itself is unknown. */
  pooledFallback: { log: number; betweenHouseSd: number };
  /** Repeat-sales market index, log hammer by sale year vs REFERENCE_YEAR, from the same fit. */
  yearEffects?: Record<string, number>;
  /**
   * How comps are moved in time (plan 2026-09-16, phase 1b). Absent or "none": not at all.
   * "prior_year": a comp older than the valuation year minus one is brought up to that year's
   * index level — the latest level a valuer could know. "sale_year": to the valuation year's own
   * level; that level is not known before the sale, so it is a leaky upper bound for backtests
   * only, never for Stage 3.
   */
  timeAdjust?: "none" | "prior_year" | "sale_year";
}

/** Index level for a year, clamped to the measured range (the nearest measured year otherwise). */
function indexAt(years: Record<string, number>, year: number): number | null {
  const ys = Object.keys(years).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ys.length) return null;
  const y = Math.min(Math.max(year, ys[0]), ys[ys.length - 1]);
  let best = ys[0];
  for (const k of ys) if (Math.abs(k - y) < Math.abs(best - y)) best = k;
  return years[String(best)];
}

/**
 * Log shift that moves a comp sold at `compDate` to the market level the valuation can use.
 * Only ever moves a comp FORWARD: a comp at or after the target year is left alone, so a sale
 * earlier in the valuation's own year is not dragged back to last year's level.
 */
export function timeShift(offsets: HouseOffsets | null | undefined, compDate: string | null | undefined, valuationDate: string | null | undefined): number {
  const mode = offsets?.timeAdjust ?? "none";
  if (mode === "none" || !offsets?.yearEffects || !compDate || !valuationDate) return 0;
  const compYear = Number(compDate.slice(0, 4)), valYear = Number(valuationDate.slice(0, 4));
  if (!Number.isFinite(compYear) || !Number.isFinite(valYear)) return 0;
  const target = mode === "prior_year" ? valYear - 1 : valYear;
  if (compYear >= target) return 0;
  const a = indexAt(offsets.yearEffects, target), b = indexAt(offsets.yearEffects, compYear);
  return a == null || b == null ? 0 : a - b;
}

/** A house's offset, matched on the graph's institution name (case-insensitive, substring either way). */
export function houseOffsetOf(table: HouseOffsets, house: string | null | undefined): { log: number; measured: boolean; name: string } {
  if (house) {
    const h = house.toLowerCase();
    for (const [name, v] of Object.entries(table.houses)) {
      const n = name.toLowerCase();
      if (n === h || n.includes(h) || h.includes(n)) return { log: v.log, measured: true, name };
    }
  }
  return { log: table.pooledFallback.log, measured: false, name: house ?? "unknown house" };
}

/** Comps older than this (at the valuation date) key the same-work witness as "old". */
export const RECENT_COMP_YEARS = 3;

// ── grid ──────────────────────────────────────────────────────────────────────

export const GRID_LOG_MIN = 0;                 // 1 GBP
export const GRID_LOG_MAX = Math.log(1e8);
export const GRID_POINTS = 601;                // step ~0.031 in log space
const GRID_STEP = (GRID_LOG_MAX - GRID_LOG_MIN) / (GRID_POINTS - 1);
const GRID: number[] = Array.from({ length: GRID_POINTS }, (_, i) => GRID_LOG_MIN + i * GRID_STEP);

/** Log-density kernel up to a constant: Gaussian, or Student-t with `df`. */
function logKernel(z: number, df: number | null): number {
  if (df == null) return -0.5 * z * z;
  return -((df + 1) / 2) * Math.log1p((z * z) / df);
}

function logDensity(w: PriceWitness, x: number): number {
  const s = Math.max(w.sigma, 1e-3);
  if (w.samples && w.samples.length > 1) {
    // Kernel density: mean of identical kernels, evaluated in log space via log-sum-exp.
    let m = -Infinity;
    const ls: number[] = [];
    for (const sample of w.samples) { const l = logKernel((x - sample) / s, w.df); ls.push(l); if (l > m) m = l; }
    let acc = 0;
    for (const l of ls) acc += Math.exp(l - m);
    return m + Math.log(acc / ls.length);
  }
  return logKernel((x - w.mu) / s, w.df);
}

// ── the priors model as a witness ──────────────────────────────────────────────

const CONTINUOUS: Array<["edition_log" | "area_log", keyof PriceAttrs, string]> = [
  ["edition_log", "editionSize", "edition size"],
  ["area_log", "areaCm2", "sheet area"],
];

/** The house levels the model was fitted with (build_priors REFS.house = Bonhams). */
function houseLevel(house: string | null | undefined): string | null {
  if (!house) return null;
  const h = house.toLowerCase();
  if (h.includes("bonhams")) return "Bonhams";
  if (h.includes("roseberys")) return "Roseberys London";
  if (h.includes("skinner")) return "Skinner";
  return null;
}

/**
 * The artist's log-linear model evaluated on the lot's own attributes: level + sum of
 * elasticity x attribute + the pooled effect for the lot's sale year. Mirrors
 * build_priors.predict — continuous terms enter as raw logs filled with the training median,
 * so here they are split into the median part (folded into "level") and the deviation
 * (shown as the attribute's effect). Subject flags are unknown for a lot and contribute 0. A
 * house the model never saw (Forum) contributes 0 and is listed in `unknownColumns`; the
 * calibration bias per house absorbs it.
 */
/** Proof classes outside the numbered edition: an edition size does not describe the sheet. */
export const PROOF_POLICY_CLASSES = ["artist_proof", "hors_commerce", "trial_proof"] as const;
/**
 * The proof policy (2026-09-16, user direction: proofs attract a modest premium, 5-10%). Measured
 * on the fitted models before adopting it: the proof term alone is a premium against the typical
 * mix (median shrunk artist AP x1.07, HC x1.14, trial x1.11), but proofs rarely state an edition,
 * and the "edition unknown" term they then carry turned the combined effect into a discount
 * (x0.85-0.96). So for a proof: the proof step is the artist's own proof effect against the mix,
 * clamped to [min, max]; and when no edition is stated, the edition terms sit at the training mix.
 */
export const DEFAULT_PROOF_PREMIUM = { min: 1.05, max: 1.1 };
export interface ProofPolicy { columnMeans: Record<string, number>; premium: { min: number; max: number } }
export const isPolicyProof = (proof: string | null | undefined): boolean => !!proof && (PROOF_POLICY_CLASSES as readonly string[]).includes(proof);

export function priorsModelPrediction(
  attrs: PriceAttrs,
  profile: ArtistPriceProfile,
  ctx: { saleDate: string | null | undefined; house?: string | null; proofPolicy?: ProofPolicy | null },
): { mu: number; contributions: PriceContribution[]; unknownColumns: string[] } {
  const unknown = new Set<string>();
  const levels: Record<string, string> = {
    signature: attrs.signature ?? "unsigned",
    proof: attrs.proof ?? "unknown",
    edition_band: editionBand(attrs.editionSize),
    area_band: areaBandFor(attrs.areaCm2, profile.referenceLevels),
    process: attrs.process ? attrs.process.toLowerCase() : "other",
  };
  const policy = ctx.proofPolicy && isPolicyProof(attrs.proof) ? ctx.proofPolicy : null;
  // Edition goes to the mix only when no edition is stated: a stated edition still prices a proof
  // (an AP from an edition of 25 is not an AP from 250). Measured on 375 backtest proofs: neutral
  // edition cut blended MAE(log) 0.438 -> 0.229 on HC/trial proofs without an edition, and raised
  // it 0.526 -> 0.542 on the 322 APs whose edition was stated.
  const neutralEdition = !!policy && !(attrs.editionSize != null && Number.isFinite(attrs.editionSize) && attrs.editionSize > 0);
  const beta = (col: string) => { const b = profile.elasticities[col]; return b != null && Number.isFinite(b) ? b : 0; };
  const atMix = (prefix: string) => Object.keys(profile.elasticities).filter((c) => c.startsWith(prefix)).reduce((t, c) => t + beta(c) * (policy!.columnMeans[c] ?? 0), 0);
  const contributions: PriceContribution[] = [];
  let level = profile.level;
  let mu = profile.level;
  for (const [dim, lvl] of Object.entries(levels)) {
    if (neutralEdition && dim === "edition_band") {
      // No edition effect for a proof: the band sits at the training mix.
      const mix = atMix("edition_band_");
      level += mix; mu += mix;
      continue;
    }
    if (policy && dim === "proof") {
      const mix = atMix("proof_");
      const measured = beta(`proof_${lvl}`) - mix;
      const prem = Math.min(Math.log(policy.premium.max), Math.max(Math.log(policy.premium.min), measured));
      level += mix; mu += mix + prem;
      contributions.push({ term: `proof=${lvl}`, logEffect: prem });
      continue;
    }
    if (profile.referenceLevels[dim] === lvl) continue;
    const col = `${dim}_${lvl}`;
    const b = profile.elasticities[col];
    if (b == null || !Number.isFinite(b)) { unknown.add(col); continue; }
    contributions.push({ term: `${dim}=${lvl}`, logEffect: b });
    mu += b;
  }
  for (const [col, field, label] of CONTINUOUS) {
    const b = profile.elasticities[col];
    if (b == null || !Number.isFinite(b) || b === 0) continue;
    if (neutralEdition && col === "edition_log") {
      const mix = b * (policy.columnMeans[col] ?? profile.continuousMedians[col] ?? 0);
      level += mix; mu += mix;
      continue;
    }
    const median = profile.continuousMedians[col] ?? 0;
    level += b * median;
    mu += b * median;
    const v = attrs[field] as number | null | undefined;
    if (v != null && Number.isFinite(v) && v > 0) {
      const eff = b * (Math.log(v) - median);
      if (eff !== 0) contributions.push({ term: `${label}=${Math.round(v)}`, logEffect: eff });
      mu += eff;
    }
  }
  const hl = houseLevel(ctx.house);
  if (ctx.house && hl == null) unknown.add(`house_${ctx.house}`);
  if (hl && profile.referenceLevels.house !== hl) {
    const b = profile.elasticities[`house_${hl}`];
    if (b != null && Number.isFinite(b)) { contributions.push({ term: `house=${hl}`, logEffect: b }); mu += b; }
    else unknown.add(`house_${hl}`);
  }
  const year = ctx.saleDate ? ctx.saleDate.slice(0, 4) : null;
  const yearEff = year != null ? profile.yearEffects[year] ?? 0 : 0;
  if (yearEff !== 0) contributions.push({ term: `sale year ${year}`, logEffect: yearEff });
  mu += yearEff;
  contributions.unshift({ term: "artist level", logEffect: level });
  return { mu, contributions, unknownColumns: [...unknown].sort() };
}

// ── witnesses from inputs ──────────────────────────────────────────────────────

const ln = Math.log;
export const sameWorkBand = (n: number): string => (n <= 1 ? "1" : n === 2 ? "2" : "3+");

interface RawWitness {
  source: WitnessSource;
  rawMu: number;
  /** Calibration keys, most specific first ("3+|recent", "3+"); "all" is always the last resort. */
  keys: string[];
  basis: string;
  rawSamples?: number[];
  contributions?: PriceContribution[];
}

const medianOfSorted = (s: number[]): number => (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);

const yearsBetween = (from: string, to: string): number => (Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / (365.25 * 86400e3);

/**
 * House re-basing (plan 2026-09-16 phase 1). A comp sold at house H is moved to the target
 * house T by exp(offset[T] - offset[H]): the SAME print fetches less at Forum than at Bonhams,
 * so a Bonhams comp for a Forum lot reads high until it is re-based. Returns the log shift for
 * one comp, 0 when either side is not known.
 */
function compShift(offsets: HouseOffsets | null | undefined, target: string | null | undefined, compHouse: string | null | undefined): number {
  // No target house means "no house chosen": comps go to the POOLED level (houseOffsetOf(null)),
  // not left at their own houses, so the price matches the pooled factor the report shows.
  if (!offsets || !compHouse) return 0;
  return houseOffsetOf(offsets, target).log - houseOffsetOf(offsets, compHouse).log;
}

function rebasedLogs(comps: CompSale[], inp: BlendInputs, offsets: HouseOffsets | null | undefined): number[] {
  return comps
    .filter((c) => c.hammerGBP > 0)
    .map((c) => ln(c.hammerGBP) + compShift(offsets, inp.targetHouse, c.house) + timeShift(offsets, c.saleDate, inp.saleDate))
    .sort((a, b) => a - b);
}

/**
 * The priors model with its house term swapped for the measured like-for-like offset of the
 * target house. The model's own `house=` column is per-artist and never saw Forum; the offset
 * table is one consistent, measured number per house, and it is what the contribution chart
 * shows as the house factor. Both are relative to Bonhams, so the swap is a replacement, not a
 * re-reference.
 */
function priorsWithHouse(priors: NonNullable<BlendInputs["priors"]>, inp: BlendInputs, offsets: HouseOffsets | null | undefined): { mu: number; contributions: PriceContribution[] } {
  if (!offsets) return { mu: priors.mu, contributions: priors.contributions };
  const own = priors.contributions.filter((c) => c.term.startsWith("house="));
  const kept = priors.contributions.filter((c) => !c.term.startsWith("house="));
  const off = houseOffsetOf(offsets, inp.targetHouse);
  const mu = priors.mu - own.reduce((t, c) => t + c.logEffect, 0) + off.log;
  const term = inp.targetHouse ? `house=${off.name}${off.measured ? "" : " (unmeasured: pooled offset)"}` : "house=none chosen (pooled offset)";
  return { mu, contributions: [...kept, { term, logEffect: off.log }] };
}

export function rawWitnesses(inp: BlendInputs, offsets?: HouseOffsets | null): RawWitness[] {
  const out: RawWitness[] = [];
  if (inp.estimate && inp.estimate.lowGBP > 0 && inp.estimate.highGBP > 0) {
    out.push({ source: "estimate", rawMu: ln((inp.estimate.lowGBP + inp.estimate.highGBP) / 2), keys: inp.house ? [inp.house] : [], basis: `catalogue estimate ${inp.estimate.lowGBP}-${inp.estimate.highGBP} GBP` });
  }
  const sw = inp.sameWork.filter((c) => c.hammerGBP > 0);
  if (sw.length) {
    const logs = rebasedLogs(sw, inp, offsets);
    const latest = sw.map((c) => c.saleDate).filter(Boolean).sort().pop() ?? null;
    const band = sameWorkBand(sw.length);
    // Age of the NEWEST comp at the valuation date: several recent sales are the tightest
    // evidence there is; the same count of decade-old sales is not.
    const age = latest && inp.saleDate ? (yearsBetween(latest, inp.saleDate) <= RECENT_COMP_YEARS ? "recent" : "old") : null;
    const rebased = (offsets && sw.some((c) => c.house) ? `, re-based to ${inp.targetHouse ?? "the pooled house level"}` : "") + (offsets?.timeAdjust && offsets.timeAdjust !== "none" && offsets.yearEffects ? ", market-adjusted to the valuation date" : "");
    out.push({ source: "same_work", rawMu: medianOfSorted(logs), keys: age ? [`${band}|${age}`, band] : [band], basis: `${sw.length} prior sale${sw.length === 1 ? "" : "s"} of this work, latest ${latest ?? "undated"}${rebased}`, rawSamples: logs });
  }
  const tier = (t: BlendInputs["sameArtistTechnique"], source: WitnessSource, label: string) => {
    if (!t || t.n <= 0 || !(t.medianHammerGBP > 0)) return;
    const logs = t.comps?.length ? rebasedLogs(t.comps, inp, offsets) : [];
    const mu = logs.length ? medianOfSorted(logs) : ln(t.medianHammerGBP);
    out.push({ source, rawMu: mu, keys: [], basis: `median of ${t.n} ${label} sales${logs.length && offsets ? `, re-based to ${inp.targetHouse ?? "the pooled house level"}` : ""}` });
  };
  tier(inp.sameArtistTechnique, "same_artist_technique", "same-artist, same-technique");
  tier(inp.sameArtist, "same_artist", "same-artist");
  if (inp.priors && Number.isFinite(inp.priors.mu)) {
    const p = priorsWithHouse(inp.priors, inp, offsets);
    out.push({ source: "priors_model", rawMu: p.mu, keys: [inp.priors.basis], basis: `log-linear model, ${inp.priors.basis} basis${inp.priors.earlierSales != null ? `, ${inp.priors.earlierSales} earlier sales` : ""}`, contributions: p.contributions });
  }
  return out;
}

function lookup(cal: WitnessCalibration, keys: string[]): { bias: number; sigma: number; key: string } | null {
  for (const k of [...keys, "all"]) {
    const hit = cal.byKey[k];
    if (hit) return { bias: hit.bias, sigma: hit.sigma, key: k };
  }
  return null;
}

/** Apply a calibration: de-bias, attach sigma / df / pool weight, drop what has no calibration or a zero weight. */
export function calibratedWitnesses(inp: BlendInputs, cal: BlendCalibration, regime?: BlendRegime): { witnesses: PriceWitness[]; regime: BlendRegime } {
  const raw = rawWitnesses(inp, cal.houseOffsets);
  const r: BlendRegime = regime ?? (raw.some((w) => w.source === "estimate") ? "with_estimate" : "no_estimate");
  const weights = cal.regimes[r].weights;
  // A target house with no measured offset: the offset is a guess, so every witness carries
  // the between-house spread on top of its own sigma.
  const extra = cal.houseOffsets && !houseOffsetOf(cal.houseOffsets, inp.targetHouse).measured ? cal.houseOffsets.pooledFallback.betweenHouseSd : 0;
  const witnesses: PriceWitness[] = [];
  for (const w of raw) {
    if (r === "no_estimate" && w.source === "estimate") continue;
    const c = lookup(cal.witnesses[w.source], w.keys);
    if (!c) continue;
    const weight = weights[w.source] ?? 0;
    const mix = houseMixOf(cal.witnesses[w.source], inp.targetHouse);
    const bias = c.bias + (mix?.logEffect ?? 0);
    witnesses.push({
      source: w.source, rawMu: w.rawMu, mu: w.rawMu + bias, sigma: Math.sqrt(c.sigma ** 2 + extra ** 2), weight, df: cal.witnesses[w.source].df,
      samples: w.rawSamples?.map((s) => s + bias), key: c.key, basis: w.basis, contributions: w.contributions,
      keyBias: c.bias, houseMix: mix ? { house: mix.house, logEffect: mix.logEffect } : null,
    });
  }
  return { witnesses, regime: r };
}

// ── hurdle ─────────────────────────────────────────────────────────────────────

/** Measured 2026-09-14 on 941 backtest lots (attributed_lot.ts liquidityVerdict): 30% base
 *  unsold rate; works with prior appearances and no sale go unsold 41% regardless of how many
 *  attempts. */
export const SELL_THROUGH_BASE = 0.70;
export const SELL_THROUGH_NEVER_SOLD = 0.59;

export function hurdleFrom(st: BlendInputs["sellThrough"]): { pSells: number | null; basis: string } {
  if (!st || st.sold + st.unsold === 0) return { pSells: null, basis: "no prior auction appearance recorded — a coverage fact, not a liquidity signal" };
  if (st.sold === 0) return { pSells: SELL_THROUGH_NEVER_SOLD, basis: `never cleared in ${st.unsold} prior appearance${st.unsold === 1 ? "" : "s"}: measured 41% unsold vs 30% base` };
  return { pSells: SELL_THROUGH_BASE, basis: `sold before (${st.sold} of ${st.sold + st.unsold} appearances): base rate` };
}

// ── the blend ──────────────────────────────────────────────────────────────────

/** cdf[i] is the mass up to the right edge of cell i (GRID[i] + step/2); interpolate on those edges. */
function quantileOnGrid(cdf: number[], q: number): number {
  for (let i = 0; i < cdf.length; i++) {
    if (cdf[i] >= q) {
      const c0 = i === 0 ? 0 : cdf[i - 1], c1 = cdf[i];
      const t = c1 > c0 ? (q - c0) / (c1 - c0) : 0;
      return GRID[i] - GRID_STEP / 2 + t * GRID_STEP;
    }
  }
  return GRID[GRID.length - 1];
}

/**
 * Multiply the witnesses on the grid. `temperature` divides the summed log-density: 1 is the
 * plain product, >1 widens every interval by the same factor (the calibration's coverage fix).
 * Returns null when no witness carries weight.
 */
export function blendWitnesses(witnesses: PriceWitness[], opts: { temperature?: number; regime: BlendRegime; hurdle?: BlendInputs["sellThrough"]; divergenceThreshold?: number }): PriceBlend | null {
  const active = witnesses.filter((w) => w.weight > 0 && Number.isFinite(w.mu));
  if (!active.length) return null;
  const T = Math.max(opts.temperature ?? 1, 1e-3);
  const logPost = new Array<number>(GRID_POINTS);
  let m = -Infinity;
  for (let i = 0; i < GRID_POINTS; i++) {
    let acc = 0;
    for (const w of active) acc += w.weight * logDensity(w, GRID[i]);
    logPost[i] = acc / T;
    if (logPost[i] > m) m = logPost[i];
  }
  const dens = logPost.map((l) => Math.exp(l - m));
  const total = dens.reduce((t, d) => t + d, 0);
  const cdf: number[] = [];
  let run = 0;
  for (const d of dens) { run += d / total; cdf.push(run); }
  const grid = GRID.map((x, i) => ({ logPrice: x, density: dens[i] / (total * GRID_STEP) }));
  const thr = opts.divergenceThreshold ?? 0.5;
  const divergence: PriceBlend["divergence"] = [];
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const gap = active[i].mu - active[j].mu;
    if (Math.abs(gap) > thr) divergence.push({ a: active[i].source, b: active[j].source, logGap: gap });
  }
  const wsum = active.reduce((t, w) => t + w.weight, 0);
  const h = hurdleFrom(opts.hurdle ?? null);
  return {
    regime: opts.regime,
    grid,
    medianGBP: Math.exp(quantileOnGrid(cdf, 0.5)),
    p10GBP: Math.exp(quantileOnGrid(cdf, 0.1)),
    p90GBP: Math.exp(quantileOnGrid(cdf, 0.9)),
    pSells: h.pSells,
    pSellsBasis: h.basis,
    witnesses: witnesses.map((w) => ({ ...w, effectiveWeight: w.weight > 0 ? w.weight / wsum : 0 })),
    divergence,
  };
}

/** The whole path: inputs -> calibrated witnesses -> posterior. */
export function blendPrices(inp: BlendInputs, cal: BlendCalibration, regime?: BlendRegime): PriceBlend | null {
  const { witnesses, regime: r } = calibratedWitnesses(inp, cal, regime);
  const reg = cal.regimes[r];
  const temperature = reg.temperatureByTier?.[evidenceTier(inp)] ?? reg.temperature;
  return blendWitnesses(witnesses, { temperature, regime: r, hurdle: inp.sellThrough, divergenceThreshold: cal.divergenceThreshold });
}

/** The strongest price evidence a lot has, ignoring the estimate — what sets how wide its range should be. */
export type EvidenceTier = "same_work_3+" | "same_work_1-2" | "same_artist_technique" | "same_artist" | "priors_model" | "none";
export const EVIDENCE_TIERS: EvidenceTier[] = ["same_work_3+", "same_work_1-2", "same_artist_technique", "same_artist", "priors_model", "none"];
export function evidenceTier(inp: BlendInputs): EvidenceTier {
  const sw = inp.sameWork.filter((c) => c.hammerGBP > 0).length;
  if (sw >= 3) return "same_work_3+";
  if (sw >= 1) return "same_work_1-2";
  if (inp.sameArtistTechnique && inp.sameArtistTechnique.n > 0) return "same_artist_technique";
  if (inp.sameArtist && inp.sameArtist.n > 0) return "same_artist";
  if (inp.priors) return "priors_model";
  return "none";
}

/** CRPS of a grid posterior against an observed log price — lower is better, in log units. */
export function crpsOnGrid(blend: PriceBlend, logObserved: number): number {
  let run = 0, crps = 0;
  const total = blend.grid.reduce((t, g) => t + g.density, 0) * GRID_STEP;
  for (const g of blend.grid) {
    run += (g.density * GRID_STEP) / total;
    const ind = g.logPrice >= logObserved ? 1 : 0;
    crps += (run - ind) ** 2 * GRID_STEP;
  }
  return crps;
}

// ── calibration ────────────────────────────────────────────────────────────────

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mad = (xs: number[], m: number): number => median(xs.map((x) => Math.abs(x - m)));
const SIGMA_FLOOR = 0.15;
/** A key needs this many fit lots to get its own bias/sigma; below it the pooled "all" entry is used. */
export const MIN_KEY_LOTS = 20;
const WEIGHT_GRID = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
const TEMPERATURE_GRID = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 4];

export interface FitRow { inputs: BlendInputs; hammerGBP: number }

/** Plan-table figures, for tests and for a first look before a fit exists. Not for Stage 3. */
export function defaultCalibration(): BlendCalibration {
  const w = (bias: number, sigma: number, df: number | null): WitnessCalibration => ({ df, byKey: { all: { bias, sigma, n: 0 } } });
  const weights: Record<WitnessSource, number> = { estimate: 1, same_work: 1, same_artist_technique: 1, same_artist: 1, priors_model: 1 };
  return {
    version: "BLEND-DEFAULT",
    fittedAt: "",
    fittedOn: "plan-table sigmas (docs/plans/2026-09-13-attributed-lot-valuation.md step 8), not fitted",
    witnesses: {
      estimate: w(ln(0.82), 0.33, 5),
      same_work: w(0, 0.56, 5),
      same_artist_technique: w(0, 0.9, 5),
      same_artist: w(0, 1.1, 5),
      priors_model: w(0, 0.8, 5),
    },
    regimes: {
      with_estimate: { weights, temperature: 1, fitLots: 0, fitMaeLog: NaN, fitCoverage80: NaN },
      no_estimate: { weights: { ...weights, estimate: 0 }, temperature: 1, fitLots: 0, fitMaeLog: NaN, fitCoverage80: NaN },
    },
    divergenceThreshold: 0.5,
  };
}

function scoreRows(rows: FitRow[], cal: BlendCalibration, regime: BlendRegime): { mae: number; coverage80: number; n: number } {
  let n = 0, ae = 0, cov = 0;
  for (const r of rows) {
    const b = blendPrices(r.inputs, cal, regime);
    if (!b) continue;
    const y = ln(r.hammerGBP);
    n++; ae += Math.abs(ln(b.medianGBP) - y);
    if (y >= ln(b.p10GBP) && y <= ln(b.p90GBP)) cov++;
  }
  return { mae: n ? ae / n : NaN, coverage80: n ? cov / n : NaN, n };
}

/**
 * Fit bias/sigma per witness per key, then pool weights by coordinate descent on MAE(log) of
 * the posterior median, then a temperature for 80% interval coverage — separately for the
 * with-estimate and no-estimate regimes. Deterministic. Fit on one house, score on another.
 */
export function fitBlendCalibration(rows: FitRow[], opts: { version: string; fittedOn: string; fittedAt?: string; df?: number | null; divergenceThreshold?: number; houseOffsets?: HouseOffsets | null; houseMix?: boolean }): BlendCalibration {
  const df = opts.df === undefined ? 5 : opts.df;
  const witnesses = {} as Record<WitnessSource, WitnessCalibration>;
  for (const src of WITNESS_SOURCES) witnesses[src] = { df, byKey: {} };
  const resid: Record<WitnessSource, Record<string, number[]>> = { estimate: {}, same_work: {}, same_artist_technique: {}, same_artist: {}, priors_model: {} };
  for (const r of rows) {
    const y = ln(r.hammerGBP);
    // Residuals are taken AFTER re-basing, so the bias left for a witness is what the house
    // offset does not explain — and a Roseberys fit carries over to a Forum lot.
    for (const w of rawWitnesses(r.inputs, opts.houseOffsets)) {
      const e = y - w.rawMu;
      if (!Number.isFinite(e)) continue;
      for (const k of [...w.keys, "all"]) (resid[w.source][k] ??= []).push(e);
    }
  }
  for (const src of WITNESS_SOURCES) {
    for (const [key, es] of Object.entries(resid[src])) {
      if (key !== "all" && es.length < MIN_KEY_LOTS) continue;
      if (!es.length) continue;
      const b = median(es);
      witnesses[src].byKey[key] = { bias: b, sigma: Math.max(SIGMA_FLOOR, 1.4826 * mad(es, b)), n: es.length };
    }
  }
  if (opts.houseMix) {
    // Second pass: what each target house leaves over after the key bias. Additive, so the key
    // bias stays the pooled calibration and the mix is a separate, reportable term.
    const left: Record<string, Record<string, number[]>> = {};
    for (const r of rows) {
      if (!r.inputs.targetHouse) continue;
      const y = ln(r.hammerGBP);
      for (const w of rawWitnesses(r.inputs, opts.houseOffsets)) {
        if (!HOUSE_MIX_SOURCES.includes(w.source)) continue;
        const c = lookup(witnesses[w.source], w.keys);
        const e = y - w.rawMu - (c?.bias ?? 0);
        if (Number.isFinite(e)) ((left[w.source] ??= {})[r.inputs.targetHouse] ??= []).push(e);
      }
    }
    for (const src of HOUSE_MIX_SOURCES) {
      for (const [house, es] of Object.entries(left[src] ?? {})) {
        if (es.length < MIN_KEY_LOTS) continue;
        (witnesses[src].houseMix ??= {})[house] = { bias: median(es), n: es.length };
      }
    }
  }
  const cal: BlendCalibration = {
    version: opts.version, fittedAt: opts.fittedAt ?? new Date().toISOString(), fittedOn: opts.fittedOn, witnesses,
    regimes: {
      with_estimate: { weights: { estimate: 1, same_work: 1, same_artist_technique: 1, same_artist: 1, priors_model: 1 }, temperature: 1, fitLots: 0, fitMaeLog: NaN, fitCoverage80: NaN },
      no_estimate: { weights: { estimate: 0, same_work: 1, same_artist_technique: 1, same_artist: 1, priors_model: 1 }, temperature: 1, fitLots: 0, fitMaeLog: NaN, fitCoverage80: NaN },
    },
    divergenceThreshold: opts.divergenceThreshold ?? 0.5,
    houseOffsets: opts.houseOffsets ?? null,
  };
  for (const regime of ["with_estimate", "no_estimate"] as BlendRegime[]) {
    const pool = regime === "with_estimate" ? rows.filter((r) => r.inputs.estimate) : rows;
    const reg = cal.regimes[regime];
    const sources = WITNESS_SOURCES.filter((s) => regime === "with_estimate" || s !== "estimate");
    // Coordinate descent on MAE(log) of the posterior median. A weight change that leaves any
    // lot with no witness at all is rejected: dropping the only witness some lots have would
    // shrink the scored set, and a smaller set is not a better fit.
    const start = scoreRows(pool, cal, regime);
    let best = start.mae;
    for (let sweep = 0; sweep < 8; sweep++) {
      let changed = false;
      for (const src of sources) {
        const current = reg.weights[src];
        let bestW = current;
        for (const w of WEIGHT_GRID) {
          if (w === current) continue;
          reg.weights[src] = w;
          const s = scoreRows(pool, cal, regime);
          if (s.n >= start.n && Number.isFinite(s.mae) && s.mae < best - 1e-6) { best = s.mae; bestW = w; }
        }
        if (bestW !== current) changed = true;
        reg.weights[src] = bestW;
      }
      if (!changed) break;
    }
    // If every weight collapsed to 0 the regime has no evidence; keep the strongest witness at 1.
    if (sources.every((s) => reg.weights[s] === 0)) reg.weights[regime === "with_estimate" ? "estimate" : "same_work"] = 1;
    let bestT = 1, bestGap = Infinity;
    for (const T of TEMPERATURE_GRID) {
      reg.temperature = T;
      const s = scoreRows(pool, cal, regime);
      const gap = Math.abs(s.coverage80 - 0.8);
      if (gap < bestGap - 1e-9) { bestGap = gap; bestT = T; }
    }
    reg.temperature = bestT;
    // Then one temperature per evidence tier. A single temperature is set by the tier mix of
    // the fit set, and out of sample it left 1-2 same-work comps covering ~70% on every house
    // (2026-09-16): thin same-work evidence read as more certain than it is. Temperature only
    // widens or narrows the interval, never the median, so the tiers fit independently.
    reg.temperatureByTier = {};
    for (const tier of EVIDENCE_TIERS) {
      const sub = pool.filter((r) => evidenceTier(r.inputs) === tier);
      if (sub.length < 2 * MIN_KEY_LOTS) continue;
      let tBest = bestT, tGap = Infinity;
      for (const T of TEMPERATURE_GRID) {
        reg.temperatureByTier[tier] = T;
        const gap = Math.abs(scoreRows(sub, cal, regime).coverage80 - 0.8);
        if (gap < tGap - 1e-9) { tGap = gap; tBest = T; }
      }
      reg.temperatureByTier[tier] = tBest;
    }
    const final = scoreRows(pool, cal, regime);
    reg.fitLots = final.n; reg.fitMaeLog = final.mae; reg.fitCoverage80 = final.coverage80;
  }
  return cal;
}
