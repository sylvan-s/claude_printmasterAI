/**
 * Stage 3a — the deterministic price (plan docs/plans/2026-09-16-stage3-blend-valuation.md,
 * phase 4). Pricing model + market comps, blended on a grid by price_blend.ts with the committed
 * calibration, from Stage 2's ValuationEvidence. No model call, no graph read: same evidence and
 * calibration, same numbers.
 *
 * SHADOW MODE. The result is attached to the report as `stage3aShadow` beside the LLM Stage 3
 * estimate, which is still the one shown. Switching the displayed estimate is a separate user
 * decision taken on the phase-4 comparison.
 *
 * Decisions this encodes (2026-09-16): the printed estimate is never a witness (no_estimate
 * regime always; it is compared, not blended); house mix off, one like-for-like house offset;
 * condition is NOT applied to the number — its bands have never been measured — and is carried
 * as a labelled note for the chart and narration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blendPrices, calibratedWitnesses, evidenceTier, houseOffsetOf, type BlendCalibration, type EvidenceTier, type WitnessSource } from "./knowledge_graph/price_blend.js";
import { evidenceToBlendInputs, type ValuationEvidence } from "./valuation_evidence.js";

export const STAGE3A_VERSION = "STAGE3A-1.0";
const CALIBRATION_PATH = join(process.cwd(), "knowledge_graph/pricing_ml/blend/calibration.json");

let cached: BlendCalibration | null | undefined;
/** The committed calibration, read once. Null (and logged) when it cannot be read — Stage 3a then reports nothing. */
export function loadBlendCalibration(path = CALIBRATION_PATH): BlendCalibration | null {
  if (cached !== undefined && path === CALIBRATION_PATH) return cached;
  let cal: BlendCalibration | null = null;
  try { cal = JSON.parse(readFileSync(path, "utf8")); }
  catch (err: any) { console.warn(`[Stage 3a] calibration unreadable at ${path}: ${err?.message ?? err}`); }
  if (path === CALIBRATION_PATH) cached = cal;
  return cal;
}

export interface Stage3aWitness {
  source: WitnessSource;
  basis: string;
  /** The witness's own central price after re-basing, time adjustment and calibration bias, GBP. */
  priceGBP: number;
  /** Calibrated spread in log units — the width this evidence carries on its own. */
  sigma: number;
  /** Share of the blend this witness carried (pool weight normalised over active witnesses). */
  effectiveWeight: number;
  calibrationKey: string;
}

export interface Stage3aResult {
  version: typeof STAGE3A_VERSION;
  calibrationVersion: string;
  /** The 80% range and its median, hammer basis, GBP. */
  lowGBP: number;
  medianGBP: number;
  highGBP: number;
  /** The strongest evidence the lot has; it set the interval width. */
  evidenceTier: EvidenceTier;
  witnesses: Stage3aWitness[];
  /** The like-for-like house offset applied, vs the reference house. */
  house: { name: string | null; multiplier: number; measured: boolean; referenceHouse: string };
  /** Priors-model additive log contributions (the chart's attribute bars, before phase 5 re-centres them). */
  priorsContributions: { term: string; logEffect: number }[];
  /** Hurdle, reported beside the price and never folded into it. */
  pSells: number | null;
  pSellsBasis: string;
  /** Witness pairs more than the calibration threshold apart in log space: the identity-check flag. */
  divergence: { a: WitnessSource; b: WitnessSource; ratio: number }[];
  /** The printed estimate, compared, not blended: its midpoint over the blend median. */
  printedEstimate: { low: number; high: number; currency: string; midpointOverMedian: number | null } | null;
  /** Condition as evidence, not applied: its price bands are unmeasured. */
  condition: { grade: string | null; note: string };
  /** Everything a reader should know before trusting the range. */
  caveats: string[];
}

/** Stage 3a on one lot's evidence. Null when no witness carries weight (no artist, no comps, no profile). */
export function stage3aValuation(ev: ValuationEvidence, cal: BlendCalibration): Stage3aResult | null {
  const inputs = evidenceToBlendInputs(ev);
  const blend = blendPrices(inputs, cal, "no_estimate");
  if (!blend) return null;
  const { witnesses } = calibratedWitnesses(inputs, cal, "no_estimate");
  const byKey = new Map(blend.witnesses.map((w) => [w.source, w]));
  const tier = evidenceTier(inputs);
  const houseOff = cal.houseOffsets ? houseOffsetOf(cal.houseOffsets, ev.targetHouse.value) : null;
  const caveats: string[] = [];
  const defaulted = Object.entries(ev.attrs).filter(([, v]) => v.source === "default").map(([k]) => k);
  if (defaulted.length) caveats.push(`attributes not evidenced, priced at the model's reference/median level: ${defaulted.join(", ")}`);
  if (!ev.targetHouse.value) caveats.push("no sale house chosen: the pooled house offset is used and every range is widened by the between-house spread");
  else if (houseOff && !houseOff.measured) caveats.push(`${ev.targetHouse.value} has no measured price level: pooled offset used, range widened`);
  if (tier === "priors_model") caveats.push("no market comps: the pricing model alone, the widest and least reliable range");
  if (ev.profile?.basis === "segment") caveats.push("the artist has too few sales for their own model: a nationality/period segment default stands in");
  if (!ev.identity.workIds.length) caveats.push("the lot was not resolved to a catalogued work: no same-work comps could be taken");
  for (const w of ev.warnings) caveats.push(`graph: ${w}`);
  const mid = ev.printedEstimate ? (ev.printedEstimate.low + ev.printedEstimate.high) / 2 : null;
  return {
    version: STAGE3A_VERSION,
    calibrationVersion: cal.version,
    lowGBP: Math.round(blend.p10GBP),
    medianGBP: Math.round(blend.medianGBP),
    highGBP: Math.round(blend.p90GBP),
    evidenceTier: tier,
    witnesses: witnesses.filter((w) => w.weight > 0).map((w) => ({
      source: w.source, basis: w.basis, priceGBP: Math.round(Math.exp(w.mu)), sigma: +w.sigma.toFixed(3),
      effectiveWeight: +(byKey.get(w.source)?.effectiveWeight ?? 0).toFixed(3), calibrationKey: w.key,
    })),
    house: { name: ev.targetHouse.value, multiplier: +Math.exp(houseOff?.log ?? 0).toFixed(3), measured: !!houseOff?.measured, referenceHouse: cal.houseOffsets?.referenceHouse ?? "Bonhams" },
    priorsContributions: witnesses.find((w) => w.source === "priors_model")?.contributions ?? [],
    pSells: blend.pSells,
    pSellsBasis: blend.pSellsBasis,
    divergence: blend.divergence.map((d) => ({ a: d.a, b: d.b, ratio: +Math.exp(d.logGap).toFixed(2) })),
    printedEstimate: ev.printedEstimate ? { ...ev.printedEstimate, midpointOverMedian: mid ? +(mid / blend.medianGBP).toFixed(2) : null } : null,
    condition: {
      grade: ev.condition.grade,
      note: "not applied to the range: condition price effects have not been measured on this corpus"
        + (ev.condition.defects.length ? `; defects seen: ${ev.condition.defects.join(", ")}` : "")
        + (ev.condition.appraiserClaims.length ? `; appraiser notes: ${ev.condition.appraiserClaims.join("; ")}` : ""),
    },
    caveats,
  };
}
