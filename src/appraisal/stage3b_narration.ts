/**
 * Stage 3b — narration of the Stage 3a price (plan docs/plans/2026-09-16-stage3-blend-valuation.md,
 * phase 5). The model explains a price it did not set. It is handed the contribution waterfall,
 * the witnesses and the caveats, plus a list of the only figures it may quote; every figure in its
 * output is checked against that list in code (`checkFigures`). A narration that quotes a number
 * not in the list is retried once with the offending figures named, then dropped. The Stage 4
 * trial showed a model given the priced table defers to it (identical range on 79/100 lots), so
 * this stage has no numeric output fields at all.
 */
import type { Stage3aResult } from "./stage3a_blend.js";
import { roundEstimate } from "./stage3a_blend.js";
import { DEFAULT_PROOF_PREMIUM } from "./knowledge_graph/price_blend.js";
import type { AuctionEstimate } from "../types.js";
import type { ValuationEvidence } from "./valuation_evidence.js";

export const STAGE3B_VERSION = "STAGE3B-1.0";

export interface AllowedFigure { label: string; value: number; kind: "money" | "multiplier" | "percent" | "count" | "year" }

export interface ValuationNarrative {
  version: typeof STAGE3B_VERSION;
  headline: string;
  keyDrivers: { factor: string; direction: "up" | "down" | "neutral"; explanation: string }[];
  narrative: string;
  caveats: string[];
  model: string;
  guard: { attempts: number; rejected: string[] };
}

/** Every figure the narration may quote, in the report currency, rounded as the report shows them. */
export function allowedFigures(r: Stage3aResult, est: AuctionEstimate, fxRate: number, ev?: ValuationEvidence | null): AllowedFigure[] {
  const cur = est.currency;
  const money = (label: string, gbp: number): AllowedFigure => ({ label, value: roundEstimate(gbp * fxRate), kind: "money" });
  const out: AllowedFigure[] = [
    { label: `estimate low (${cur})`, value: est.lowEstimate, kind: "money" },
    { label: `estimate high (${cur})`, value: est.highEstimate, kind: "money" },
    { label: `estimate median (${cur})`, value: est.valuationReasoning?.anchorValue ?? roundEstimate(r.medianGBP * fxRate), kind: "money" },
  ];
  for (const w of r.witnesses) {
    out.push(money(`${w.source.replace(/_/g, " ")} price (${cur})`, w.priceGBP));
    out.push({ label: `${w.source.replace(/_/g, " ")} weight (%)`, value: Math.round(w.effectiveWeight * 100), kind: "percent" });
  }
  for (const b of r.waterfall?.bars ?? []) {
    if (b.kind === "factor" || b.kind === "comps") out.push({ label: `${b.label}: multiplier`, value: b.multiplier, kind: "multiplier" });
    if (b.kind !== "note") out.push(money(`${b.label}: price after (${cur})`, b.toGBP));
  }
  out.push({ label: "sale house level multiplier", value: r.house.multiplier, kind: "multiplier" });
  out.push({ label: "the range is an 80% range (%)", value: 80, kind: "percent" });
  // The proof policy's stated band, which the chart label prints ("modest proof premium, 5-10%").
  out.push({ label: "proof premium floor (%)", value: Math.round((DEFAULT_PROOF_PREMIUM.min - 1) * 100), kind: "percent" });
  out.push({ label: "proof premium cap (%)", value: Math.round((DEFAULT_PROOF_PREMIUM.max - 1) * 100), kind: "percent" });
  const trainRows = r.waterfall?.bars[0]?.label.match(/\(([\d,]+) auction sales\)/)?.[1];
  if (trainRows) out.push({ label: "auction sales behind the average sold print", value: Number(trainRows.replace(/,/g, "")), kind: "count" });
  // A multiplier may also be written as a percentage change: x0.85 is "15% lower", x1.37 "37% higher".
  for (const m of out.filter((a) => a.kind === "multiplier")) out.push({ label: `${m.label} as a % change`, value: Math.round(Math.abs(m.value - 1) * 100), kind: "percent" });
  // Individual comps the narration may cite: the hammer (in the report currency) and the year.
  for (const c of ev?.comps.items ?? []) {
    if (c.hammerGBP != null && c.hammerGBP > 0) {
      out.push({ label: `${c.tier.replace(/_/g, " ")} comp hammer, ${c.house ?? "?"} ${c.saleDate?.slice(0, 10) ?? "?"}`, value: roundEstimate(c.hammerGBP * fxRate), kind: "money" });
      if (fxRate === 1) out.push({ label: `${c.tier.replace(/_/g, " ")} comp hammer exact`, value: Math.round(c.hammerGBP), kind: "money" });
    }
    if (c.saleDate) out.push({ label: "comp sale year", value: Number(c.saleDate.slice(0, 4)), kind: "year" });
  }
  if (ev) out.push({ label: "valuation year", value: Number(ev.valuationDate.value.slice(0, 4)), kind: "year" });
  if (r.printedEstimate) {
    out.push({ label: `house printed estimate low (${r.printedEstimate.currency})`, value: r.printedEstimate.low, kind: "money" });
    out.push({ label: `house printed estimate high (${r.printedEstimate.currency})`, value: r.printedEstimate.high, kind: "money" });
  }
  // The lot's own attribute values the chart labels print ("Edition: 850", "Size: 2688 cm²"), with
  // the thousands separator the model tends to add.
  for (const b of r.waterfall?.bars ?? []) {
    for (const m of b.label.matchAll(/\b(\d[\d,]*)\b/g)) out.push({ label: `from chart label "${b.label}"`, value: Number(m[1].replace(/,/g, "")), kind: "count" });
  }
  // Counts and years the witnesses name ("3 prior sales of this work, latest 2023-05-01").
  for (const w of r.witnesses) {
    for (const m of w.basis.matchAll(/\b(\d{1,4})\b/g)) {
      const n = Number(m[1]);
      out.push({ label: `from "${w.basis}"`, value: n, kind: n >= 1400 && n <= 2100 ? "year" : "count" });
    }
  }
  return out;
}

/** The figures in `text` that match nothing allowed. Small counts (<= 12) and ordinal words are free. */
export function checkFigures(text: string, allowed: AllowedFigure[]): string[] {
  const bad: string[] = [];
  const re = /[x×]\s?(\d+(?:\.\d+)?)|(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(%)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    if (m[1] != null) {
      const v = Number(m[1]);
      if (!allowed.some((a) => a.kind === "multiplier" && Math.abs(a.value - v) <= 0.011)) bad.push(raw);
      continue;
    }
    const v = Number(m[2].replace(/,/g, ""));
    if (m[3]) { if (!allowed.some((a) => a.kind === "percent" && Math.abs(a.value - v) <= 1)) bad.push(raw); continue; }
    if (Number.isInteger(v) && v <= 12) continue;
    const ok = allowed.some((a) =>
      (a.kind === "money" && Math.abs(a.value - v) <= Math.max(1, 0.01 * a.value)) ||
      (a.kind === "multiplier" && Math.abs(a.value - v) <= 0.011) ||
      ((a.kind === "count" || a.kind === "year") && a.value === v) ||
      (a.kind === "percent" && Math.abs(a.value - v) <= 1));
    if (!ok) bad.push(raw);
  }
  return [...new Set(bad)];
}

export const STAGE3B_SYSTEM = `You write the valuation commentary for a fine art print appraisal. The price has ALREADY been set by a calibrated model: a blend of the artist's pricing model and realised auction hammer prices. You explain it; you never change it.

WRITE
- headline: one sentence stating the fair-value range and what mainly sets it.
- keyDrivers: the 2-5 factors that move this price most, largest first, taken from the contribution chart. For each: the factor, direction (up/down/neutral) and one plain sentence why, citing the evidence (e.g. "hand-signed impressions of this artist sell for more", "three recent sales of this exact work").
- narrative: 3-6 sentences a collector can read: where the price starts (a typical print by this artist in this technique), what the print's own attributes do, what the market comps say and how much they pull, and how confident the range is and why.
- caveats: the caveats given, rewritten plainly; add none of your own.

HOW TO READ THE CHART (get this right; it is the most common error)
- The chart starts at a typical print by THIS ARTIST in THIS TECHNIQUE (e.g. "Georges Braque, aquatint"), at the training mix of signature, impression status, edition and size, and multiplies step by step.
- Every attribute step (signature, impression status, edition, size) compares THIS lot's attribute with the AVERAGE MIX of that attribute across all training sales, priced at this artist's own rates. It is NOT a comparison with the artist's other works. Write "hand-signed prints of this artist sell for more than the typical mix", not "than his unsigned prints".
- "Impression status" is where this impression sits relative to the numbered edition (numbered, artist's proof, hors commerce, trial proof). It is NOT a catalogue raisonné citation. For an artist's proof, hors commerce or trial proof it is a modest proof premium of 5-10%; if no edition is stated, the edition step is zero rather than a penalty.
- "Size" compares this sheet with the typical training size mix; the bands are named by sheet side (small up to 30 cm, medium 30-42 cm, large 42-87 cm, extra large over 87 cm, where larger still adds value per doubling).
- "Sale house" is the house's like-for-like price level against the average house mix of the training sales. "Market level" is the valuation year's market against the average year. "Model calibration" corrects the model to realised hammers.
- "Same catalogue entry" comps are sales of OTHER works catalogued under the same catalogue raisonné entry as this print (e.g. other plates of the same book, "Vallier 153"): close relatives, not this exact work.
- "Market comps" is the pull from realised sales, re-based to the target house and to the valuation date; the comps come from several houses and years, not one house.

RULES
1. Quote ONLY figures from ALLOWED FIGURES, written exactly as given (you may add a currency symbol or thousands separators, or write a multiplier as "x1.37"). Any other number is rejected. Prefer words to numbers where a number adds nothing.
2. The condition is noted and NOT priced: say so if you mention condition; never imply a discount or premium for it.
3. The house's printed estimate, if given, is a reference the price does not use. You may compare to it; never suggest the range should move toward it.
4. No hedging boilerplate, no marketing language, no advice to buy or sell.
Return only the tool call.`;

export const STAGE3B_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    keyDrivers: {
      type: "array",
      items: { type: "object", properties: { factor: { type: "string" }, direction: { type: "string", enum: ["up", "down", "neutral"] }, explanation: { type: "string" } }, required: ["factor", "direction", "explanation"] },
    },
    narrative: { type: "string" },
    caveats: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "keyDrivers", "narrative", "caveats"],
};

export function stage3bUserText(r: Stage3aResult, est: AuctionEstimate, allowed: AllowedFigure[], lot: { artist: string | null; title: string | null }): string {
  const chart = (r.waterfall?.bars ?? []).map((b) => ({ step: b.label, kind: b.kind, multiplier: b.kind === "factor" || b.kind === "comps" ? b.multiplier : undefined }));
  return [
    `LOT: ${lot.artist ?? "unknown artist"}${lot.title ? ` — "${lot.title}"` : ""}`,
    `FAIR-VALUE RANGE: ${est.lowEstimate}–${est.highEstimate} ${est.currency} (80% range; hammer basis)`,
    `STRONGEST EVIDENCE: ${r.evidenceTier.replace(/_/g, " ")}`,
    `CONTRIBUTION CHART (average sold print -> this lot; multipliers apply in order):\n${JSON.stringify(chart)}`,
    `WITNESSES BLENDED: ${JSON.stringify(r.witnesses.map((w) => ({ source: w.source, basis: w.basis, weight: w.effectiveWeight })))}`,
    `CONDITION: ${r.condition.grade ?? "not assessed"} — ${r.condition.note}`,
    `CAVEATS: ${JSON.stringify(r.caveats)}`,
    `ALLOWED FIGURES (quote only these):\n${allowed.map((a) => `- ${a.label}: ${a.value}`).join("\n")}`,
  ].join("\n\n");
}

/** All free text in a narration, for the figure check. */
export const narrationText = (n: Pick<ValuationNarrative, "headline" | "keyDrivers" | "narrative" | "caveats">): string =>
  [n.headline, n.narrative, ...n.keyDrivers.map((d) => `${d.factor} ${d.explanation}`), ...n.caveats].join("\n");
