/**
 * Stage 3a — the deterministic price (plan docs/plans/2026-09-16-stage3-blend-valuation.md,
 * phase 4). Pricing model + market comps, blended on a grid by price_blend.ts with the committed
 * calibration, from Stage 2's ValuationEvidence. No model call, no graph read: same evidence and
 * calibration, same numbers.
 *
 * THE DISPLAYED ESTIMATE (user decision 2026-09-16, after the phase-4 Stage 3 trial): the report's
 * auctionEstimate is Stage 3a's 80% range, converted from GBP at the ECB rate. The aim is a fair
 * price from the print's inherent value and past market comps, not a forecast of a hammer that
 * the house's own estimate sways. The LLM Stage 3 estimate is kept beside it for audit
 * (`llmAuctionEstimate`) and is shown only when Stage 3a cannot price the lot.
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
import type { AuctionEstimate } from "../types.js";

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

// ── the displayed estimate ─────────────────────────────────────────────────────

const FX_PATH = join(process.cwd(), "knowledge_graph/fx_gbp_ecb.json");
let fxCache: { base: string; rates: Record<string, Record<string, number>> } | null | undefined;
/**
 * Units of `currency` per GBP at the latest ECB reference rate on or before `date` (else the
 * latest available), from the committed series knowledge_graph/fx_gbp_ecb.json (the same rates
 * the graph's GBP prices were converted with). Null when the currency is not in the series.
 */
export function gbpRate(currency: string, date: string | null): { rate: number; date: string } | null {
  if (currency.toUpperCase() === "GBP") return { rate: 1, date: date ?? "n/a" };
  if (fxCache === undefined) {
    try { fxCache = JSON.parse(readFileSync(FX_PATH, "utf8")); }
    catch (err: any) { console.warn(`[Stage 3a] FX series unreadable at ${FX_PATH}: ${err?.message ?? err}`); fxCache = null; }
  }
  if (!fxCache) return null;
  const days = Object.keys(fxCache.rates).sort();
  const cut = date ? days.filter((d) => d <= date.slice(0, 10)) : days;
  for (let i = (cut.length ? cut : days).length - 1; i >= 0; i--) {
    const d = (cut.length ? cut : days)[i];
    const r = fxCache.rates[d]?.[currency.toUpperCase()];
    if (r && r > 0) return { rate: r, date: d };
  }
  return null;
}

/** Auction-style rounding: tens below 100, else two significant figures; low rounded down, high up. */
export function roundEstimate(x: number, dir: "down" | "up" | "nearest" = "nearest"): number {
  if (!(x > 0)) return 0;
  const step = x < 100 ? 10 : Math.pow(10, Math.floor(Math.log10(x)) - 1);
  const f = dir === "down" ? Math.floor : dir === "up" ? Math.ceil : Math.round;
  return Math.max(step, f(x / step) * step);
}

/**
 * The model's terms as one line per factor a reader recognises. The band and the per-doubling
 * term of the same attribute are one effect (edition band + edition size; area band + sheet
 * area), and the house term is already stated as the like-for-like house level, so it is dropped.
 */
export function groupedContributions(terms: { term: string; logEffect: number }[]): { factor: string; logEffect: number; terms: string[] }[] {
  const groupOf = (t: string): string | null => {
    if (t === "artist level" || t.startsWith("house=")) return null;
    if (t.startsWith("edition")) return "edition";
    if (t.startsWith("area_band") || t.startsWith("sheet area")) return "size";
    if (t.startsWith("sale year")) return "sale year";
    return t.split("=")[0];
  };
  const out = new Map<string, { factor: string; logEffect: number; terms: string[] }>();
  for (const c of terms) {
    const g = groupOf(c.term);
    if (!g) continue;
    const e = out.get(g) ?? { factor: g, logEffect: 0, terms: [] };
    e.logEffect += c.logEffect; e.terms.push(c.term);
    out.set(g, e);
  }
  return [...out.values()];
}

const TIER_CONFIDENCE: Record<string, string> = {
  "same_work_3+": "MEDIUM — several prior sales of this work",
  "same_work_1-2": "MEDIUM — one or two prior sales of this work",
  same_artist_technique: "LOW — no sale of this work; the artist's sales in the same technique and the pricing model",
  same_artist: "LOW — no sale of this work or technique; the artist's other sales and the pricing model",
  priors_model: "LOW — no market comps; the pricing model alone",
  none: "LOW — no evidence",
};

/**
 * Stage 3a's result as the report's auctionEstimate, in the report currency, with the reasoning
 * written in code from the evidence. Null when the currency cannot be converted.
 */
export function stage3aAuctionEstimate(r: Stage3aResult, currency: string, valuationDate: string | null): AuctionEstimate | null {
  const fx = gbpRate(currency, valuationDate);
  if (!fx) return null;
  const low = roundEstimate(r.lowGBP * fx.rate, "down");
  const high = Math.max(roundEstimate(r.highGBP * fx.rate, "up"), low + 1);
  const median = roundEstimate(r.medianGBP * fx.rate);
  const cur = currency.toUpperCase();
  const fxNote = cur === "GBP" ? "" : ` Converted from GBP at the ECB reference rate of ${fx.date} (${fx.rate} ${cur}/GBP).`;
  const houseNote = r.house.name
    ? `priced at ${r.house.name}${r.house.measured ? ` (like-for-like price level x${r.house.multiplier} vs ${r.house.referenceHouse})` : " (no measured price level: pooled offset, wider range)"}`
    : "no sale house chosen (pooled house level, wider range)";
  const witnessLines = r.witnesses.map((w) => `${w.source.replace(/_/g, " ")}: ${w.basis}; ${Math.round(w.priceGBP * fx.rate).toLocaleString("en-GB")} ${cur}, weight ${Math.round(w.effectiveWeight * 100)}%`);
  return {
    lowEstimate: low,
    highEstimate: high,
    currency: cur,
    formattedEstimate: `${low} - ${high} ${cur}`,
    valuationContext:
      `A fair-value range from the print's own attributes and past market sales, not a forecast anchored on any house estimate. `
      + `It is the 80% range of a calibrated blend of the artist's pricing model and realised hammer prices (Stage 3a, calibration ${r.calibrationVersion}), `
      + `median ${median.toLocaleString("en-GB")} ${cur}, ${houseNote}. Hammer basis: buyer's premium is additional.${fxNote}`
      + (r.printedEstimate?.midpointOverMedian ? ` The house's printed estimate midpoint is x${r.printedEstimate.midpointOverMedian} this median; it is shown for reference and does not enter the price.` : "")
      + ` Condition: ${r.condition.note}.`,
    valuationReasoning: {
      anchor: `Calibrated blend of the pricing model and market comps (Stage 3a ${r.calibrationVersion}); strongest evidence: ${r.evidenceTier.replace(/_/g, " ")}`,
      anchorValue: median,
      adjustments: [
        ...(r.house.name ? [{ factor: "sale house price level", direction: r.house.multiplier < 1 ? "down" : r.house.multiplier > 1 ? "up" : "none", magnitude: `x${r.house.multiplier}`, evidence: `like-for-like repeat sales vs ${r.house.referenceHouse}${r.house.measured ? "" : " (pooled, unmeasured house)"}` }] : []),
        ...groupedContributions(r.priorsContributions).map((g) => ({ factor: g.factor, direction: g.logEffect < -0.005 ? "down" : g.logEffect > 0.005 ? "up" : "none", magnitude: `x${Math.exp(g.logEffect).toFixed(2)}`, evidence: `artist pricing model: ${g.terms.join(" + ")}` })),
      ],
      evidenceFor: witnessLines,
      evidenceAgainst: [...r.caveats, ...r.divergence.map((d) => `${d.a.replace(/_/g, " ")} and ${d.b.replace(/_/g, " ")} disagree by x${d.ratio}: check the identification`)],
      confidence: TIER_CONFIDENCE[r.evidenceTier] ?? "LOW",
      whatWouldChangeIt: [
        "a further sale of this exact work",
        "a hands-on condition report (condition is not priced)",
        "a different identification of the work, state or edition",
        ...(r.house.name ? [] : ["choosing the house it will be offered at"]),
      ],
    },
  };
}
