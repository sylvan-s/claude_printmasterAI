/**
 * The report fields the LLM Stage 3 call used to write besides the estimate, now built in code from
 * Stage 1–2 outputs and the valuation evidence (plan docs/plans/2026-09-16-stage3-blend-valuation.md,
 * "LLM Stage 3 removed"). The LLM Stage 3 call now runs only when Stage 3a cannot price a lot.
 *
 *   recentAuctionSales         the evidence comps: same work first, then most recent
 *   editionSizeAndPrintNumber  the sourced edition and proof attributes, plus Stage 2b's edition notes
 *   isLikelyReproductionOrPoster / reproductionExplanation
 *                              set only by a reproduction finding (Stage 2a divergence, Stage 1a
 *                              image class); later printings and high reprint risk are explained
 *   nextSteps                  Stage 2b's unresolved questions and examination flags, plus what the
 *                              evidence left unstated (defaulted attributes, no sale house, condition)
 *
 * Pure. Every string names its source, so a reader can tell a catalogue fact from an inference.
 */
import type { AttributionResearchResult, PrintAnalysisReport, RecentSale, TriageResult, VisualExtractionResult } from "../types.js";
import type { ValuationEvidence } from "./valuation_evidence.js";

export const RECENT_SALES_SHOWN = 8;
const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
const TIER_NOTE: Record<string, string> = { same_work: "same work", same_suite: "same catalogue entry", same_artist_technique: "same artist and technique", same_artist: "same artist" };

export function recentSalesFromEvidence(ev: ValuationEvidence): RecentSale[] {
  const rank = { same_work: 0, same_suite: 1, same_artist_technique: 2, same_artist: 3 } as const;
  // A suite sale can also be in tier 2/3 (the blend counts both); the list shows each sale once, at its best tier.
  const seen = new Set<string>();
  return ev.comps.items
    .filter((c) => (c.hammerGBP ?? 0) > 0 || (c.realisedGBP ?? 0) > 0)
    .sort((a, b) => rank[a.tier] - rank[b.tier] || (b.saleDate ?? "").localeCompare(a.saleDate ?? ""))
    .filter((c) => { const k = `${c.house}|${c.saleDate?.slice(0, 10)}|${c.hammerGBP}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, RECENT_SALES_SHOWN)
    .map((c) => ({
      artworkTitle: c.workTitle ?? "Untitled",
      artist: ev.artist.canonical ?? ev.artist.reported ?? "",
      technique: c.attrs.process && c.attrs.process !== "other" ? c.attrs.process : "not recorded",
      saleDate: c.saleDate?.slice(0, 10) ?? "undated",
      // What buyers paid, with the hammer beside it: the fair-value range is on the hammer basis.
      priceRealized: c.realisedGBP != null && c.realisedGBP > 0
        ? `${gbp(c.realisedGBP)}${c.hammerGBP ? ` (hammer ${gbp(c.hammerGBP)})` : ""}`
        : `hammer ${gbp(c.hammerGBP!)}`,
      auctionHouse: c.house ?? "unknown house",
      conditionState: `not recorded; ${TIER_NOTE[c.tier]}${c.entry ? ` (${c.entry})` : ""} comparable`,
    }));
}

export function editionFromEvidence(ev: ValuationEvidence, attr: AttributionResearchResult | null | undefined): string {
  const parts: string[] = [];
  const { editionSize, proof } = ev.attrs;
  if (proof.value && proof.source !== "default") {
    parts.push(`${proof.value.replace(/_/g, " ")} (${proof.source})`);
  }
  if (editionSize.value != null) parts.push(`edition of ${editionSize.value} (${editionSize.source})`);
  const notes = (attr as any)?.seriesAndEditionIdentification?.editionNotes;
  if (notes) parts.push(`Stage 2b: ${notes}`);
  return parts.length ? parts.join("; ") : "Edition and impression number not stated in the catalogue, the notes or the image.";
}

export function reproductionFromEvidence(
  attr: AttributionResearchResult | null | undefined,
  vea: VisualExtractionResult | null | undefined,
  triage: TriageResult | null | undefined,
): { isLikely: boolean; explanation: string } {
  const a = attr as any;
  const risk = a?.reprintForgeryAssessment?.reprintForgeryRisk;
  const editionType = a?.seriesAndEditionIdentification?.editionType;
  const divergence = (triage as any)?.impressionAssessment?.divergence;
  const imageClass = vea?.imageAuthenticity?.classification;
  // The flag means a reproduction or poster: a mechanical copy, not a print from the artist's
  // matrix. Only a direct finding sets it. A posthumous edition or restrike is a genuine later
  // printing, and a HIGH reprint/forgery risk is a reason to examine, not a finding (checked
  // against the LLM Stage 3 on 33 saved runs, 2026-09-16: flagging those disagreed on 3 Gauguin
  // and Munch lots the model rightly left unflagged).
  const findings: string[] = [];
  if (divergence === "reproduction") findings.push("the evidence tree reports the impression as a reproduction");
  if (imageClass === "DIGITAL_REPRODUCTION") findings.push("the image analysis classifies the submission as a digital reproduction");
  const cautions: string[] = [];
  if (editionType === "posthumous" || editionType === "reprint") cautions.push(`Stage 2b identifies a ${editionType} edition: a genuine later printing, priced as such by its comps`);
  if (risk === "HIGH") cautions.push("Stage 2b rates the reprint/forgery risk HIGH: examine before relying on the range");
  if (findings.length) return { isLikely: true, explanation: `Likely a reproduction or poster: ${findings.join("; ")}.${cautions.length ? ` Also: ${cautions.join("; ")}.` : ""}` };
  if (cautions.length) return { isLikely: false, explanation: `No reproduction finding. ${cautions.join("; ")}.` };
  const assessed = risk && risk !== "UNASSESSABLE";
  return {
    isLikely: false,
    explanation: assessed
      ? `No reproduction indicators: Stage 2b reprint/forgery risk ${risk}${editionType && editionType !== "unknown" ? `, ${editionType} edition` : ""}.`
      : "No reproduction indicators were found, but reprint risk was not assessed; a hands-on examination would confirm.",
  };
}

export function nextStepsFromEvidence(ev: ValuationEvidence, attr: AttributionResearchResult | null | undefined): string[] {
  const a = attr as any;
  const steps: string[] = [];
  for (const q of a?.unresolvedQuestions ?? []) if (q?.resolutionAction) steps.push(q.resolutionAction);
  if (a?.reprintForgeryAssessment?.physicalExaminationRecommended || a?.researchConfidenceSummary?.physicalExaminationRequired) {
    steps.push("Examine the print in hand to confirm the impression, paper and signature.");
  }
  const unstated = Object.entries(ev.attrs).filter(([, v]) => v.source === "default").map(([k]) => ({ signature: "signature", proof: "impression status (numbered, artist's proof, hors commerce…)", editionSize: "edition size", areaCm2: "sheet size", process: "technique" } as Record<string, string>)[k]);
  if (unstated.length) steps.push(`Record the ${unstated.join(", ")}: the valuation priced ${unstated.length === 1 ? "it" : "them"} at the model's default.`);
  if (!ev.condition.grade && !ev.condition.appraiserClaims.length) steps.push("Obtain a condition report: condition is noted but not priced, and a damaged sheet can sell well below this range.");
  if (!ev.targetHouse.value) steps.push("Choose the auction house: the range uses the pooled house level and is wider for it.");
  if (!ev.identity.workIds.length) steps.push("Confirm the catalogue raisonné number or exact title so the work's own past sales can be used.");
  return [...new Set(steps)];
}

/** Everything the LLM Stage 3 call contributed to the report, except the estimate itself. */
export function stage3ReportFields(
  ev: ValuationEvidence,
  attr: AttributionResearchResult | null | undefined,
  vea: VisualExtractionResult | null | undefined,
  triage: TriageResult | null | undefined,
): Pick<PrintAnalysisReport, "recentAuctionSales" | "editionSizeAndPrintNumber" | "isLikelyReproductionOrPoster" | "reproductionExplanation" | "nextSteps"> {
  const repro = reproductionFromEvidence(attr, vea, triage);
  return {
    recentAuctionSales: recentSalesFromEvidence(ev),
    editionSizeAndPrintNumber: editionFromEvidence(ev, attr),
    isLikelyReproductionOrPoster: repro.isLikely,
    reproductionExplanation: repro.explanation,
    nextSteps: nextStepsFromEvidence(ev, attr),
  };
}
