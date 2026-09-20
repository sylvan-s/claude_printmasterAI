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
  const trainRows = r.waterfall?.bars[0]?.label.match(/\(([\d,]+) auction (?:sales|lots)\)/)?.[1];
  if (trainRows) out.push({ label: "auction lots behind the average house estimate", value: Number(trainRows.replace(/,/g, "")), kind: "count" });
  // A multiplier may also be written as a percentage change: x0.85 is "15% lower", x1.37 "37% higher".
  for (const m of out.filter((a) => a.kind === "multiplier")) out.push({ label: `${m.label} as a % change`, value: Math.round(Math.abs(m.value - 1) * 100), kind: "percent" });
  // The sale house level may also be written as a share of the reference house's level: x0.92 is
  // "92% of Bonhams' level" (2026-09-17 live check). Only the house: for any other step a "% of" reading
  // would let "a 38% discount" through for a x0.38 bar.
  for (const hv of new Set([r.house.multiplier, ...(r.waterfall?.bars ?? []).filter((x) => x.key === "house").map((x) => x.multiplier)]))
    if (hv != null && Number.isFinite(hv)) out.push({ label: "sale house level as a % of the reference house", value: Math.round(hv * 100), kind: "percent" });
  // The size bands' sheet sides the system prompt names (small up to 20/30 cm, medium 30-42, large 42-87).
  for (const side of [20, 30, 42, 87]) out.push({ label: `size band edge (${side} cm a side)`, value: side, kind: "count" });
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
  // Numbers in the lot's own title ("USA 76", "Plate 4"): the narration may name the work.
  for (const t of [ev?.identity?.matchedName].filter(Boolean) as string[]) {
    for (const m of t.matchAll(/\b(\d{1,4})\b/g)) out.push({ label: `from the title "${t}"`, value: Number(m[1]), kind: "count" });
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

/**
 * Direction check (2026-09-17). The figure guard cannot see a sentence that quotes no number but gets
 * a step backwards: the Hockney G.E.L. 1649 narration said an edition of 30 "adds value" against a
 * x0.75 edition bar. Every chart step with a clear direction (below x0.98 lowers, above x1.02
 * raises) is matched to what the narration says about it:
 *  - each key driver whose factor names one step must carry that step's direction;
 *  - in the headline, narrative and explanations, a directional phrase ("adds value", "reduces",
 *    "discount", "pulls ... down", "below the model") is judged ONLY when its step is unambiguous:
 *    the sentence names exactly one step, or the phrase opens a "which/that" clause right after a
 *    clause naming exactly one step ("..., but has a smaller edition of 30, which adds value").
 *    Sentences naming several steps are not judged (live 30-lot check 2026-09-17: nearest-mention
 *    and clause-subject guesses misattributed 5 correct sentences such as "Forum Auctions' 15%
 *    discount and the 2023 market level adjust the model price"). A negated phrase is skipped.
 *  - Class comparisons ("hand-signed prints sell for more", "worth less") describe OTHER levels, not
 *    this lot's step, and are not judged. A mention of the other level ("signed" for an unsigned lot,
 *    "proof" for a numbered one) flips the expected direction: "signed impressions carry a premium"
 *    about an unsigned lot agrees with a x0.65 signature step.
 * Returns one plain message per contradiction, for the retry prompt and the guard record.
 */
const STEP_TOPICS: Array<{ key: string; re: RegExp }> = [
  { key: "signature", re: /\bsignatures?\b|\b(?:hand-)?signed\b|\bunsigned\b|\binitialled\b/i },
  { key: "impression", re: /\bimpression status\b|\bproofs?\b|\bhors commerce\b|\bnumbered impressions?\b/i },
  { key: "edition", re: /\beditions?\b/i },
  { key: "size", re: /\bsizes?\b|\bsheets?\b|\bdimensions?\b|\bcm a side\b/i },
  { key: "house", re: /\bsale house\b|\bhouse[- ]level\b|\bhouse's (?:price )?level\b|\bprice level at\b|\b(?:Bonhams|Roseberys|Forum Auctions|Skinner|Swann|Christie's|Sotheby's|Phillips)\b/i },
  { key: "year", re: /\bmarket level\b|\bmarket year\b|\bvaluation year\b|\bset to (?:19|20)\d{2}\b|\b(?:19|20)\d{2} (?:market )?(?:prices|levels?)\b/i },
  { key: "calibration", re: /\bcalibrat\w*|\bshrunk toward\b|\bhouse estimates\b/i },
  { key: "comps", re: /\bcomps?\b|\bcomparables\b|\bcomparable sales\b|\bre-based\b|\bmarket-adjusted\b|\bsame[- ](?:artist|work|technique|suite)\b|\bsales? from \d{4}\b|\brealised (?:sales?|prices?|hammers?)\b|\bauction (?:sales?|prices?|results?)\b|\bsales? of\b/i },
  { key: "poster", re: /\bposters?\b/i },
  { key: "after", re: /\bafter the artist\b|\battribution\b|\bnot (?:by )?the artist's own\b/i },
  { key: "object", re: /\bobject multiples?\b|\bnon-paper\b/i },
];
const UP_RE = /\badds? (?:to )?(?:the )?value\b|\badding (?:to )?(?:the )?value\b|\bincreas(?:es|ing|ed)\b|\brais(?:es|ing)\b|\blift(?:s|ing)\b|\bboost(?:s|ing)\b|\bpremium\b|\b(?:push(?:es|ing)?|pull(?:s|ing)?|move(?:s)?|moving|take(?:s)?|taking|bring(?:s|ing)?|nudge(?:s)?) (?:it |the price |the value |the estimate |the fair value )?up\b|\babove the (?:model|reference|baseline|average)\b/gi;
const DOWN_RE = /\breduc(?:es|ing|ed)\b|\blower(?:s|ing)?\b(?! (?:end|bound|estimate|edge))|\bcut(?:s|ting)?\b|\bdiscount(?:s|ed)?\b|\bdecreas(?:es|ing|ed)\b|\bdrag(?:s|ging)?\b|\b(?:push(?:es|ing)?|pull(?:s|ing)?|move(?:s)?|moving|take(?:s)?|taking|bring(?:s|ing)?|nudge(?:s)?) (?:it |the price |the value |the estimate |the fair value )?down\b|\bbelow the (?:model|reference|baseline|average)\b/gi;
const NEGATION_RE = /\b(?:not|no|never|neither|nor|without)\b(?:\W+\w+){0,2}\W*$/i;
/** A relative clause that continues the previous one ("..., which adds value in the model"). */
const CONTINUES_RE = /^\s*(?:and\s+)?(?:which|that)\b/i;

export function checkDirections(n: Pick<ValuationNarrative, "headline" | "keyDrivers" | "narrative">, bars: Array<{ key: string; label: string; kind: string; multiplier: number }>): string[] {
  const dir = (m: number): "up" | "down" | "flat" => (m > 1.02 ? "up" : m < 0.98 ? "down" : "flat");
  const steps = new Map<string, { dir: "up" | "down" | "flat"; label: string; multiplier: number }>();
  for (const b of bars) if (b.kind === "factor" || b.kind === "comps") steps.set(b.key, { dir: dir(b.multiplier), label: b.label, multiplier: b.multiplier });
  type Mention = { key: string; at: number; text: string };
  const mentionsIn = (text: string, offset = 0): Mention[] => {
    const ms: Mention[] = [];
    for (const t of STEP_TOPICS) {
      if (!steps.has(t.key)) continue;
      for (const m of text.matchAll(new RegExp(t.re.source, "gi"))) ms.push({ key: t.key, at: offset + m.index!, text: m[0].toLowerCase() });
    }
    return ms.sort((a, b) => a.at - b.at);
  };
  const out: string[] = [];
  for (const d of n.keyDrivers ?? []) {
    const keys = [...new Set(mentionsIn(d.factor).map((m) => m.key))];
    if (keys.length !== 1 || d.direction === "neutral") continue;
    const s = steps.get(keys[0])!;
    if (s.dir !== "flat" && s.dir !== d.direction) out.push(`key driver "${d.factor}" is marked ${d.direction}, but the chart step "${s.label}" is x${s.multiplier} (${s.dir})`);
  }
  const text = [n.headline, n.narrative, ...(n.keyDrivers ?? []).map((d) => d.explanation)].join("\n");
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    const all = mentionsIn(sentence);
    if (!all.length) continue;
    // clause boundaries: punctuation, or a contrast word
    const bounds = [0];
    for (const m of sentence.matchAll(/[,;:]|\s(?=(?:but|whereas|while|although|however)\s)/gi)) bounds.push(m.index! + m[0].length);
    bounds.push(sentence.length);
    const clauseOf = (at: number) => { let k = 0; while (k + 1 < bounds.length - 1 && bounds[k + 1] <= at) k++; return k; };
    for (const [re, said] of [[UP_RE, "up"], [DOWN_RE, "down"]] as const) {
      for (const m of sentence.matchAll(re)) {
        if (NEGATION_RE.test(sentence.slice(0, m.index))) continue;
        const c = clauseOf(m.index!);
        const keys = new Set(all.map((x) => x.key));
        let subject: Mention | undefined;
        if (keys.size === 1) subject = all[0];
        else if (c > 0 && CONTINUES_RE.test(sentence.slice(bounds[c], bounds[c + 1])) && !all.some((x) => clauseOf(x.at) === c && x.at < m.index!)) {
          const prev = all.filter((x) => clauseOf(x.at) === c - 1);
          if (prev.length && new Set(prev.map((x) => x.key)).size === 1) subject = prev[prev.length - 1];
        }
        if (!subject) continue;
        const s = steps.get(subject.key)!;
        const label = s.label.toLowerCase();
        let otherLevel = false;
        if (subject.key === "signature") {
          const ownUnsigned = !/signature: hand/.test(label);
          const saysSigned = all.some((x) => x.key === "signature" && /signed$/.test(x.text) && x.text !== "unsigned");
          const saysUnsigned = all.some((x) => x.key === "signature" && x.text === "unsigned");
          if (ownUnsigned && saysSigned && saysUnsigned) continue;           // both levels named: ambiguous
          otherLevel = ownUnsigned && /signed$/.test(subject.text) && subject.text !== "unsigned";
        }
        if (subject.key === "impression" && /numbered impression|not stated/.test(label)) {
          const saysProof = all.some((x) => x.key === "impression" && /proof/.test(x.text));
          const saysNumbered = all.some((x) => x.key === "impression" && /numbered/.test(x.text));
          if (saysProof && saysNumbered) continue;
          otherLevel = /proof/.test(subject.text);
        }
        const expected = s.dir === "flat" ? "flat" : otherLevel ? (s.dir === "up" ? "down" : "up") : s.dir;
        if (expected !== "flat" && expected !== said) out.push(`"${sentence.trim()}" says the ${subject.key} step ${said === "up" ? "raises" : "lowers"} the price, but the chart step "${s.label}" is x${s.multiplier}`);
      }
    }
  }
  return [...new Set(out)];
}

export const STAGE3B_SYSTEM = `You write the valuation commentary for a fine art print appraisal. The price has ALREADY been set by a calibrated model: a blend of the artist's pricing model and realised auction hammer prices. You explain it; you never change it.

WRITE
- headline: one sentence stating the fair-value range and what mainly sets it.
- keyDrivers: the 2-5 factors that move this price most, largest first, taken from the contribution chart. For each: the factor, direction (up/down/neutral) and one plain sentence why, citing the evidence (e.g. "hand-signed impressions of this artist sell for more", "three recent sales of this exact work").
- narrative: 3-6 sentences a collector can read: where the price starts (a reference print by this artist in this technique: numbered, hand-signed, edition 31–75, large, at Bonhams in the valuation year's market), what the print's own attributes do, what the market comps say and how much they pull, and how confident the range is and why.
- caveats: the caveats given, rewritten plainly; add none of your own.

HOW TO READ THE CHART (get this right; it is the most common error)
- The chart starts at a REFERENCE PRINT by THIS ARTIST in THIS TECHNIQUE: numbered, hand-signed, edition 31–75, large (42-87 cm a side), priced at Bonhams at the VALUATION YEAR's market level (e.g. "Georges Braque, aquatint: numbered, hand-signed, edition 31–75, large, Bonhams, 2026 market"), and multiplies step by step. The price is at today's market level: there is no separate market-level step.
- Every step compares THIS lot with that reference print, priced at this artist's own rates. A step is zero where the lot matches the reference. Write "unsigned prints of this artist sell for less than hand-signed ones", "a smaller edition than 31–75 adds value".
- "Offset print" as the technique means an offset lithograph or photolithograph (photomechanically printed), priced as its own technique, not as a hand-drawn lithograph. A "Poster" step appears only when the lot is a poster; it is this artist's measured poster discount or premium. An "Attribution" step appears only when the house catalogues the lot as "after" (or "manner of", "attributed to") the artist: it is NOT the artist's own print, and the step is this artist's measured discount for such lots. Say so plainly, and never describe such a lot as by the artist. An "Object multiple" step appears only when the lot is printed or made on a non-paper support (aluminium, Plexiglas, steel, canvas, wood) or is a cast object; it is this artist's measured difference for such multiples.
- "Impression status" is where this impression sits relative to the numbered edition (numbered, artist's proof, hors commerce, trial proof). It is NOT a catalogue raisonné citation. For an artist's proof, hors commerce or trial proof it is a modest proof premium of 5-10%; if no edition is stated, the edition step prices it at the average edition rather than as an unknown-edition penalty.
- "Size" compares this sheet with a large sheet (42-87 cm a side); the bands are named by sheet side (small up to 30 cm, medium 30-42 cm, large 42-87 cm, extra large over 87 cm, where larger still adds value per doubling).
- "Sale house" is the house's like-for-like price level against Bonhams. "Model calibration" corrects the pricing model to houses' own estimates for comparable lots.
- The price is a FAIR PRICE: the pricing model is fitted to auction houses' estimates (how specialists price a print's fundamentals, sold and unsold lots alike), and the market comps are realised hammer prices, which pull it toward what prints actually sell for. It is not a hammer forecast.
- "Same catalogue entry" comps are sales of OTHER works catalogued under the same catalogue raisonné entry as this print (e.g. other plates of the same book, "Vallier 153"): close relatives, not this exact work.
- The market comps are at most FIVE realised sales, chosen in order: sales of this same work; then this artist's prints in the same technique whose images look closest to this one; then prints by similar artists in the same technique whose images look closest. They are not adjusted for signature, edition or size.
- "Market comps" is the pull from realised sales, re-based to the target house and to the valuation date; the comps come from several houses and years, not one house.

RULES
1. Quote ONLY figures from ALLOWED FIGURES, written exactly as given (you may add a currency symbol or thousands separators, or write a multiplier as "x1.37"). Any other number is rejected. Prefer words to numbers where a number adds nothing.
2. The condition is noted and NOT priced: say so if you mention condition; never imply a discount or premium for it.
3. The house's printed estimate, if given, is a reference the price does not use. You may compare to it; never suggest the range should move toward it.
4. No hedging boilerplate, no marketing language, no advice to buy or sell.
5. Every step's direction must match its multiplier in the chart: below x1 LOWERS the price, above x1 RAISES it, x1 changes nothing. Check each step you mention against the chart before writing it. A smaller edition is not automatically worth more: say what THIS chart says.
6. Explain the price only with what you are given: the chart steps, the witnesses and the caveats. Never add causes that are not there (provenance, subject, rarity, condition as a price factor, demand, fashion).
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
    `FAIR-VALUE RANGE: ${est.lowEstimate}–${est.highEstimate} ${est.currency} (80% range; fair price: house-estimate basis, pulled toward realised hammers by the comps)`,
    `STRONGEST EVIDENCE: ${r.evidenceTier.replace(/_/g, " ")}`,
    `CONTRIBUTION CHART (reference print -> this lot; multipliers apply in order):\n${JSON.stringify(chart)}`,
    `WITNESSES BLENDED: ${JSON.stringify(r.witnesses.map((w) => ({ source: w.source, basis: w.basis, weight: w.effectiveWeight })))}`,
    `CONDITION: ${r.condition.grade ?? "not assessed"} — ${r.condition.note}`,
    `CAVEATS: ${JSON.stringify(r.caveats)}`,
    `ALLOWED FIGURES (quote only these):\n${allowed.map((a) => `- ${a.label}: ${a.value}`).join("\n")}`,
  ].join("\n\n");
}

/** All free text in a narration, for the figure check. */
export const narrationText = (n: Pick<ValuationNarrative, "headline" | "keyDrivers" | "narrative" | "caveats">): string =>
  [n.headline, n.narrative, ...n.keyDrivers.map((d) => `${d.factor} ${d.explanation}`), ...n.caveats].join("\n");
