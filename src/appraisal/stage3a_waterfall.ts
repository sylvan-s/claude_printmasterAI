/**
 * The contribution waterfall for one lot's Stage 3a price (plan docs/plans/2026-09-16-stage3-
 * blend-valuation.md, phase 5). Exact, not approximate: for the log-linear pricing model the SHAP
 * value of column j is beta_j * (x_j - E[x_j]), with E over the model's training rows
 * (knowledge_graph/pricing_ml/priors/column_means.json). In log space:
 *
 *   this artist, this technique   level + technique beta + sum_(other j) beta_j E[x_j] + E[house level] + E[year effect]
 * + signature / proof / edition / size   sum over the attribute's columns of beta_j (x_j - E[x_j]);
 *                                 for an AP / HC / trial proof, proof = the clamped proof premium, and
 *                                 edition = 0 when no edition is stated (price_blend PROOF_POLICY_CLASSES)
 * + sale house (like-for-like)    offset(target) - E[offset]
 * + sale year                     yearEffect(year) - E[year effect]
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
import { calibratedWitnesses, houseOffsetOf, isPolicyProof, DEFAULT_PROOF_PREMIUM, type BlendCalibration, type ProofPolicy } from "./knowledge_graph/price_blend.js";
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

const MEANS_PATH = join(process.cwd(), "knowledge_graph/pricing_ml/priors/column_means.json");
let meansCache: ColumnMeans | null | undefined;
export function loadColumnMeans(path = MEANS_PATH): ColumnMeans | null {
  if (meansCache !== undefined && path === MEANS_PATH) return meansCache;
  let m: ColumnMeans | null = null;
  try { m = JSON.parse(readFileSync(path, "utf8")); } catch (err: any) { console.warn(`[Stage 3a waterfall] column means unreadable at ${path}: ${err?.message ?? err}`); }
  if (path === MEANS_PATH) meansCache = m;
  return m;
}

const LABELS: Record<string, string> = { signature: "Signature", proof: "Proof", edition: "Edition", size: "Size" };
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
  return out;
}

function attrLabel(dim: string, ev: ValuationEvidence, policyProof: boolean, neutralEdition: boolean): string {
  const a = ev.attrs;
  const src = (s: { source: string }) => (s.source === "default" ? "not stated: model default" : s.source);
  switch (dim) {
    case "signature": return `${LABELS.signature}: ${pretty(a.signature.value)} (${src(a.signature)})`;
    case "proof": return policyProof
      ? `${LABELS.proof}: ${pretty(a.proof.value)} (${src(a.proof)}; modest proof premium, ${Math.round((DEFAULT_PROOF_PREMIUM.min - 1) * 100)}-${Math.round((DEFAULT_PROOF_PREMIUM.max - 1) * 100)}%)`
      : `${LABELS.proof}: ${pretty(a.proof.value)} (${src(a.proof)})`;
    case "edition": return neutralEdition
      ? `${LABELS.edition}: not stated, not held against a ${pretty(a.proof.value)}`
      : `${LABELS.edition}: ${a.editionSize.value ?? "unknown"} (${src(a.editionSize)})`;
    case "size": return `${LABELS.size}: ${a.areaCm2.value != null ? `${Math.round(a.areaCm2.value)} cm²` : "unknown"} (${src(a.areaCm2)})`;
    default: return dim;
  }
}

/**
 * The waterfall from Stage 2's evidence to Stage 3a's median. `medianGBP` is Stage 3a's median
 * before rounding. Returns null only when there is no median to reach.
 *
 * The chart starts at THIS ARTIST AND TECHNIQUE (user direction 2026-09-16): the artist's model
 * with the lot's technique and every other attribute at the training mix, the training house mix
 * and the average market year. Each later bar moves from there.
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
      const m = means.columns[col] ?? 0;
      if (dim === "process") { baseline += beta * x; continue; }   // the technique is part of the start
      baseline += beta * m;
      if ((policyProof && dim === "proof") || (neutralEdition && dim === "edition")) continue;
      byDim[dim] = (byDim[dim] ?? 0) + beta * (x - m);
    }
    if (policyProof) {
      // The same clamp priorsModelPrediction applies: the artist's proof effect against the mix.
      const mix = Object.keys(profile.elasticities).filter((c) => c.startsWith("proof_")).reduce((t, c) => t + (profile.elasticities[c] ?? 0) * (means.columns[c] ?? 0), 0);
      const measured = (profile.elasticities[`proof_${ev.attrs.proof.value}`] ?? 0) - mix;
      byDim.proof = Math.min(Math.log(DEFAULT_PROOF_PREMIUM.max), Math.max(Math.log(DEFAULT_PROOF_PREMIUM.min), measured));
      if (neutralEdition) byDim.edition = 0;
    }
    const off = cal.houseOffsets;
    const houseLog = off ? houseOffsetOf(off, ev.targetHouse.value).log : 0;
    const meanHouse = off ? Object.entries(means.houseShares).reduce((t, [h, sh]) => t + sh * houseOffsetOf(off, h).log, 0) : 0;
    baseline += meanHouse + means.meanYearEffect;
    const year = ev.valuationDate.value.slice(0, 4);
    const yearEff = profile.yearEffects[year] ?? 0;
    const tech = ev.attrs.process.value && ev.attrs.process.value !== "other" ? ev.attrs.process.value : "technique not stated";
    const who = ev.artist.canonical ?? ev.artist.reported ?? "Unknown artist";
    running = baseline;
    bars.push({ key: "baseline", label: `${who}, ${tech}: typical print (${profile.basis === "shrunk" ? `${profile.earlierSales} own sales` : profile.basis === "prior" ? "priced from similar artists" : "segment default"})`, kind: "baseline", logEffect: 0, multiplier: 1, fromGBP: Math.round(Math.exp(baseline)), toGBP: Math.round(Math.exp(baseline)) });
    for (const dim of ["signature", "proof", "edition", "size"]) if (dim in byDim) push(dim, attrLabel(dim, ev, policyProof, neutralEdition), "factor", byDim[dim]);
    if (off) push("house", `Sale house: ${ev.targetHouse.value ?? "none chosen (pooled level)"}`, "factor", houseLog - meanHouse);
    push("year", `Market level: ${year}`, "factor", yearEff - means.meanYearEffect);
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
  push("comps", comps.length ? `Market comps: ${comps.map((w) => pretty(w.source)).join(", ")}` : "No market comps", "comps", Math.log(medianGBP) - running);
  bars.push({ key: "total", label: "Fair-value median", kind: "total", logEffect: 0, multiplier: 1, fromGBP: Math.round(medianGBP), toGBP: Math.round(medianGBP) });
  bars.push({ key: "condition", label: `Condition: ${ev.condition.grade ?? "not assessed"} (noted, not priced)`, kind: "note", logEffect: 0, multiplier: 1, fromGBP: Math.round(medianGBP), toGBP: Math.round(medianGBP) });
  return { bars, meansVersion: means.version, notes };
}
