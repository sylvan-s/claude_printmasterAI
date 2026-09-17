/**
 * The contribution waterfall for one lot's Stage 3a price (plan docs/plans/2026-09-16-stage3-
 * blend-valuation.md, phase 5). Exact, not approximate: the model is log-linear, so each bar is
 * beta_j * (x_j - r_j), where r is a named REFERENCE PRINT (user direction 2026-09-17):
 * "<artist>, <technique>: numbered, hand-signed, edition 31-75, large, Bonhams, 2025". In log space:
 *
 *   the reference print          level + technique beta + sum_(other j) beta_j r_j + offset(Bonhams) + yearEffect(2025)
 * + signature / proof / edition / size   sum over the attribute's columns of beta_j (x_j - r_j);
 *                                 for an AP / HC / trial proof, proof = the proof columns at the training
 *                                 mix plus the clamped premium, and when no edition is stated the edition
 *                                 columns sit at the training mix (price_blend PROOF_POLICY_CLASSES)
 * + sale house (like-for-like)    offset(target) - offset(Bonhams)
 * + sale year                     yearEffect(year) - yearEffect(2025)
 * + model calibration             the priors witness's calibration bias
 * = pricing model price           exactly the priors witness the blend used
 * + market comps                  log(Stage 3a median) - log(pricing model price)
 * = Stage 3a median
 *   condition                     zero-length, labelled: noted, not priced
 *
 * The comps bar is one bar, not one per witness: a grid posterior's median is not additive in its
 * witnesses. Its label carries the witnesses' weights. Pure; the checks in tests hold the sum to 1e-9.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calibratedWitnesses, houseOffsetOf, isPolicyProof, xlAreaLog, DEFAULT_PROOF_PREMIUM, type BlendCalibration, type ProofPolicy } from "./knowledge_graph/price_blend.js";
import { editionBand, areaBandFor, type ArtistPriceProfile } from "./knowledge_graph/artist_price_profile.js";
import { evidenceToBlendInputs, attrsValues, type ValuationEvidence } from "./valuation_evidence.js";

export interface ColumnMeans {
  version: string;
  priorsVersion: string;
  priorsBuiltAt: string;
  trainRows: number;
  baselineLogHammer: number;
  columns: Record<string, number>;
  meanYearEffect: number;
  houseShares: Record<string, number>;
}

export type WaterfallKind = "baseline" | "factor" | "subtotal" | "comps" | "total" | "note";
export interface WaterfallBar {
  key: string;
  label: string;
  kind: WaterfallKind;
  /** Log-price step this bar adds (0 for baseline, subtotals and notes). */
  logEffect: number;
  /** exp(logEffect), rounded for display. */
  multiplier: number;
  /** The running price before and after this bar, GBP. For baseline/subtotal/total, both are the level. */
  fromGBP: number;
  toGBP: number;
}
export interface Waterfall {
  bars: WaterfallBar[];
  meansVersion: string;
  /** Anything a reader should know about the chart itself (build mismatch, no pricing model). */
  notes: string[];
}

/** The training mix of the Stage 3a model file (build_priors --size-terms shape-bands+xl). */
const MEANS_PATH = join(process.cwd(), "knowledge_graph/pricing_ml/priors_stage3a/column_means.json");
let meansCache: ColumnMeans | null | undefined;
export function loadColumnMeans(path = MEANS_PATH): ColumnMeans | null {
  if (meansCache !== undefined && path === MEANS_PATH) return meansCache;
  let m: ColumnMeans | null = null;
  try { m = JSON.parse(readFileSync(path, "utf8")); } catch (err: any) { console.warn(`[Stage 3a waterfall] column means unreadable at ${path}: ${err?.message ?? err}`); }
  if (path === MEANS_PATH) meansCache = m;
  return m;
}

const LABELS: Record<string, string> = { signature: "Signature", proof: "Impression status", edition: "Edition", size: "Size", poster: "Poster" };
/** Plain names for the proof classes: where the impression sits relative to the numbered edition. */
const IMPRESSION_STATUS: Record<string, string> = {
  numbered: "numbered impression",
  artist_proof: "artist's proof (outside the numbered edition)",
  hors_commerce: "hors commerce (outside the numbered edition)",
  trial_proof: "trial proof (before the edition)",
  edition_unnumbered: "unnumbered impression from the edition",
  unknown: "not stated",
};
const pretty = (s: string) => s.replace(/_/g, " ");

/** The lot's value on every non-house model column, exactly as priorsModelPrediction reads them. */
function lotColumns(profile: ArtistPriceProfile, ev: ValuationEvidence): Record<string, { dim: string; x: number }> {
  const a = attrsValues(ev.attrs);
  const levels: Record<string, string> = {
    signature: a.signature ?? "unsigned",
    proof: a.proof ?? "unknown",
    edition_band: editionBand(a.editionSize),
    area_band: areaBandFor(a.areaCm2, profile.referenceLevels),
    process: a.process ? a.process.toLowerCase() : "other",
  };
  const dimOf: Record<string, string> = { signature: "signature", proof: "proof", edition_band: "edition", area_band: "size", process: "process" };
  const out: Record<string, { dim: string; x: number }> = {};
  for (const col of Object.keys(profile.elasticities)) {
    const cat = Object.keys(levels).find((d) => col.startsWith(`${d}_`));
    if (cat) out[col] = { dim: dimOf[cat], x: col === `${cat}_${levels[cat]}` ? 1 : 0 };
  }
  const logOr = (v: number | null | undefined, median: number) => (v != null && Number.isFinite(v) && v > 0 ? Math.log(v) : median);
  if ("edition_log" in profile.elasticities) out.edition_log = { dim: "edition", x: logOr(a.editionSize, profile.continuousMedians.edition_log ?? 0) };
  if ("area_log" in profile.elasticities) out.area_log = { dim: "size", x: logOr(a.areaCm2, profile.continuousMedians.area_log ?? 0) };
  if ("area_log_xl" in profile.elasticities) out.area_log_xl = { dim: "size", x: xlAreaLog(a.areaCm2) };
  if ("poster" in profile.elasticities) out.poster = { dim: "poster", x: a.poster ? 1 : 0 };
  return out;
}

/**
 * The print every chart starts from. Each value is a level the model has (or a point on a continuous
 * term); "large" is the shape-band reference, so it contributes nothing. The edition-size term needs
 * a number inside the 31-75 band: 50, close to the band's geometric middle (48).
 */
export const REFERENCE_PRINT = {
  signature: "hand", proof: "numbered", editionBand: "31-75", editionSize: 50,
  areaBand: "1800-7500", house: "Bonhams", year: "2025",
} as const;
const REFERENCE_LABEL = "numbered, hand-signed, edition 31–75, large, Bonhams, 2025";

/** The reference print's value on a model column (0/1 for levels, a log value for continuous terms). */
function referenceX(col: string, profile: ArtistPriceProfile): number {
  const R = REFERENCE_PRINT;
  if (col === "edition_log") return Math.log(R.editionSize);
  if (col === "area_log") return profile.continuousMedians.area_log ?? 0;   // pre-shape-band builds only
  if (col === "area_log_xl") return 0;
  return col === `signature_${R.signature}` || col === `proof_${R.proof}` || col === `edition_band_${R.editionBand}` || col === `area_band_${R.areaBand}` ? 1 : 0;
}

/** Plain names for the shape size bands (build_priors --size-terms shape-bands[+xl]), by sheet side. */
const SIZE_BAND_NAMES: Record<string, string> = {
  "<400": "small, up to 20 cm a side",
  "400-900": "small, 20-30 cm a side",
  "900-1800": "medium, 30-42 cm a side",
  "1800-7500": "large, 42-87 cm a side (the typical size)",
  ">7500": "extra large, over 87 cm a side",
};

function sizeLabel(ev: ValuationEvidence, profile: ArtistPriceProfile): string {
  const a = ev.attrs.areaCm2;
  const src = a.source === "default" ? "not stated: model default" : a.source;
  if (a.value == null) return `${LABELS.size}: not stated (${src})`;
  const cm2 = `${Math.round(a.value).toLocaleString("en-GB")} cm²`;
  if (profile.referenceLevels.area_band !== "1800-7500") return `${LABELS.size}: ${cm2} (${src})`;
  const band = areaBandFor(a.value, profile.referenceLevels);
  const xl = profile.elasticities.area_log_xl;
  const larger = band === ">7500" && xl != null && Number.isFinite(xl) ? `; larger still: x${Math.exp(xl * Math.LN2).toFixed(2)} per doubling of area` : "";
  return `${LABELS.size}: ${SIZE_BAND_NAMES[band] ?? band} (${cm2}, ${src}${larger})`;
}

function attrLabel(dim: string, ev: ValuationEvidence, policyProof: boolean, neutralEdition: boolean, profile: ArtistPriceProfile): string {
  const a = ev.attrs;
  const src = (s: { source: string }) => (s.source === "default" ? "not stated: model default" : s.source);
  switch (dim) {
    case "signature": return `${LABELS.signature}: ${pretty(a.signature.value)} (${src(a.signature)})`;
    case "proof": return policyProof
      ? `${LABELS.proof}: ${IMPRESSION_STATUS[a.proof.value] ?? pretty(a.proof.value)} (${src(a.proof)}; modest proof premium, ${Math.round((DEFAULT_PROOF_PREMIUM.min - 1) * 100)}-${Math.round((DEFAULT_PROOF_PREMIUM.max - 1) * 100)}%)`
      : `${LABELS.proof}: ${IMPRESSION_STATUS[a.proof.value] ?? pretty(a.proof.value)} (${src(a.proof)})`;
    case "edition": return neutralEdition
      ? `${LABELS.edition}: not stated, priced at the average edition for an impression outside the edition`
      : `${LABELS.edition}: ${a.editionSize.value ?? "unknown"} (${src(a.editionSize)})`;
    case "size": return sizeLabel(ev, profile);
    case "poster": return `${LABELS.poster}: ${a.poster?.value ? "yes" : "no"} (${a.poster ? src(a.poster) : "not stated: model default"})`;
    default: return dim;
  }
}

/**
 * The waterfall from Stage 2's evidence to Stage 3a's median. `medianGBP` is Stage 3a's median
 * before rounding. Returns null only when there is no median to reach.
 *
 * The chart starts at THIS ARTIST AND TECHNIQUE (user direction 2026-09-16) as a named reference
 * print (REFERENCE_PRINT, 2026-09-17), not the training mix: the reader can see what each bar is
 * measured against. Each later bar moves from there.
 */
export function valuationWaterfall(ev: ValuationEvidence, cal: BlendCalibration, means: ColumnMeans, medianGBP: number): Waterfall | null {
  if (!(medianGBP > 0)) return null;
  const notes: string[] = [];
  const policy: ProofPolicy = { columnMeans: means.columns, premium: DEFAULT_PROOF_PREMIUM };
  const inputs = evidenceToBlendInputs(ev, { proofPolicy: policy });
  const witnesses = calibratedWitnesses(inputs, cal, "no_estimate").witnesses;
  const priors = witnesses.find((w) => w.source === "priors_model" && w.weight > 0) ?? null;
  const bars: WaterfallBar[] = [];
  let running = 0;
  const push = (key: string, label: string, kind: WaterfallKind, logEffect: number) => {
    const from = Math.exp(running);
    if (kind === "factor" || kind === "comps") running += logEffect;
    bars.push({ key, label, kind, logEffect, multiplier: +Math.exp(logEffect).toFixed(2), fromGBP: Math.round(from), toGBP: Math.round(Math.exp(running)) });
  };
  const profile = ev.profile;
  if (profile && priors) {
    if (!profile.run.includes(means.priorsBuiltAt.slice(0, 19)) && !profile.run.includes(means.priorsVersion)) {
      notes.push(`chart centred on ${means.priorsVersion} (${means.priorsBuiltAt}); the artist profile is from ${profile.run}`);
    }
    const policyProof = isPolicyProof(ev.attrs.proof.value);
    const neutralEdition = policyProof && !(ev.attrs.editionSize.value != null && ev.attrs.editionSize.value > 0);
    const cols = lotColumns(profile, ev);
    const byDim: Record<string, number> = {};
    let baseline = profile.level;
    for (const [col, { dim, x }] of Object.entries(cols)) {
      const beta = profile.elasticities[col];
      if (beta == null || !Number.isFinite(beta)) continue;
      if (dim === "process") { baseline += beta * x; continue; }   // the technique is part of the start
      const r = referenceX(col, profile);
      baseline += beta * r;
      if ((policyProof && dim === "proof") || (neutralEdition && dim === "edition")) { byDim[dim] = (byDim[dim] ?? 0) - beta * r; continue; }
      byDim[dim] = (byDim[dim] ?? 0) + beta * (x - r);
    }
    if (policyProof) {
      // What priorsModelPrediction prices: the proof (and, with no edition, the edition) columns at the
      // training mix, plus the artist's proof effect against that mix clamped to the premium range.
      const atMix = (prefix: string) => Object.keys(profile.elasticities).filter((c) => c.startsWith(prefix)).reduce((t, c) => t + (profile.elasticities[c] ?? 0) * (means.columns[c] ?? 0), 0);
      const mix = atMix("proof_");
      const measured = (profile.elasticities[`proof_${ev.attrs.proof.value}`] ?? 0) - mix;
      byDim.proof = (byDim.proof ?? 0) + mix + Math.min(Math.log(DEFAULT_PROOF_PREMIUM.max), Math.max(Math.log(DEFAULT_PROOF_PREMIUM.min), measured));
      if (neutralEdition) {
        const bLog = profile.elasticities.edition_log;
        byDim.edition = (byDim.edition ?? 0) + atMix("edition_band_") + (bLog != null && Number.isFinite(bLog) ? bLog * (means.columns.edition_log ?? profile.continuousMedians.edition_log ?? 0) : 0);
      }
    }
    const off = cal.houseOffsets;
    const houseLog = off ? houseOffsetOf(off, ev.targetHouse.value).log : 0;
    const refHouse = off ? houseOffsetOf(off, REFERENCE_PRINT.house).log : 0;
    const refYear = profile.yearEffects[REFERENCE_PRINT.year] ?? 0;
    baseline += refHouse + refYear;
    const year = ev.valuationDate.value.slice(0, 4);
    const yearEff = profile.yearEffects[year] ?? 0;
    const tech = ev.attrs.process.value === "offset" ? "offset print" : ev.attrs.process.value && ev.attrs.process.value !== "other" ? ev.attrs.process.value : "technique not stated";
    const who = ev.artist.canonical ?? ev.artist.reported ?? "Unknown artist";
    running = baseline;
    bars.push({ key: "baseline", label: `${who}, ${tech}: ${REFERENCE_LABEL} (${profile.basis === "shrunk" ? `${profile.earlierSales} own sales` : profile.basis === "prior" ? "priced from similar artists" : "segment default"})`, kind: "baseline", logEffect: 0, multiplier: 1, fromGBP: Math.round(Math.exp(baseline)), toGBP: Math.round(Math.exp(baseline)) });
    // Bar key "impression" (the impression-status step); the model dimension behind it is "proof".
    for (const dim of ["signature", "proof", "edition", "size", "poster"]) if (dim in byDim && (dim !== "poster" || ev.attrs.poster?.value)) push(dim === "proof" ? "impression" : dim, attrLabel(dim, ev, policyProof, neutralEdition, profile), "factor", byDim[dim]);
    if (off) push("house", `Sale house: ${ev.targetHouse.value ?? "none chosen (pooled level)"}`, "factor", houseLog - refHouse);
    push("year", `Market level: ${year}`, "factor", yearEff - refYear);
    push("calibration", "Model calibration on realised hammers", "factor", priors.mu - priors.rawMu);
    const gap = priors.mu - running;
    if (Math.abs(gap) > 1e-6) {
      notes.push(`model bars fall ${gap.toFixed(4)} log short of the model price; folded into the starting point`);
      bars[0].fromGBP = bars[0].toGBP = Math.round(Math.exp(baseline + gap));
      running = priors.mu;
    }
    bars.push({ key: "model", label: "Pricing model price", kind: "subtotal", logEffect: 0, multiplier: 1, fromGBP: Math.round(Math.exp(running)), toGBP: Math.round(Math.exp(running)) });
  } else {
    running = means.baselineLogHammer;
    bars.push({ key: "baseline", label: `Average sold print (${means.trainRows.toLocaleString("en-GB")} auction sales)`, kind: "baseline", logEffect: 0, multiplier: 1, fromGBP: Math.round(Math.exp(running)), toGBP: Math.round(Math.exp(running)) });
    notes.push(profile ? "the pricing model carried no weight for this lot" : "no pricing model for this artist: the price comes from market comps alone");
  }

  const comps = witnesses.filter((w) => w.source !== "priors_model" && w.weight > 0);
  const entries = [...new Set(ev.comps.items.filter((c) => c.tier === "same_suite" && c.entry).map((c) => c.entry!))];
  const compName = (src: string) => (src === "same_suite" ? `same catalogue entry${entries.length ? ` (${entries.join(", ")})` : ""}` : pretty(src));
  push("comps", comps.length ? `Market comps: ${comps.map((w) => compName(w.source)).join(", ")}` : "No market comps", "comps", Math.log(medianGBP) - running);
  bars.push({ key: "total", label: "Fair-value median", kind: "total", logEffect: 0, multiplier: 1, fromGBP: Math.round(medianGBP), toGBP: Math.round(medianGBP) });
  bars.push({ key: "condition", label: `Condition: ${ev.condition.grade ?? "not assessed"} (noted, not priced)`, kind: "note", logEffect: 0, multiplier: 1, fromGBP: Math.round(medianGBP), toGBP: Math.round(medianGBP) });
  return { bars, meansVersion: means.version, notes };
}
