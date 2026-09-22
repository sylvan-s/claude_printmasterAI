/**
 * Does Stage 2b need to research comparables for this lot? (STAGE2B-COMPS-PLAN-1.0)
 *
 * Stage 3a prices from the pricing model and the graph's own comps; it never reads Stage 2b's
 * web comps (ValuationEvidence.webComps is "display and corroboration only, never a witness").
 * Measured on the first Artsy A/B (2026-09-22): Stage 3a priced 40 of 40 lots, so every web
 * search Stage 2b spent on STEP 7 bought display rows and a graph write-back, not a price.
 * The LLM Stage 3 that DOES read them runs only when Stage 3a returns no price.
 *
 * So the plan is decided before Stage 2b, by running Stage 3a itself on the evidence available
 * before it (the catalogue claim on the attributed path, Stage 2a's canonical artist on the
 * standard one). Stage 3a returns no price only when it has no witness at all — no artist, no
 * comps, no profile — which Stage 2b's output cannot supply, so this predicts it exactly
 * rather than guessing:
 *
 *   SUMMARY  Stage 3a will price. Stage 2b gets a few lines about the graph comps already read
 *            instead of its own query_ackg_comparables tool, spends NO web searches on comps,
 *            and may make ONE query_artsy_results call so the report still shows other houses.
 *   FULL     Stage 3a will not price, so the LLM fallback depends on Stage 2b's comps. Unchanged.
 *
 * Unknown (the evidence build failed, or no artist was resolved before Stage 2b) is FULL: the
 * safe default is the behaviour that existed before this rule.
 */
import type { ValuationEvidence } from "./valuation_evidence.js";

export type Stage2bCompsMode = "full" | "summary";

export interface Stage2bCompsPlan {
  mode: Stage2bCompsMode;
  /** One line for the run log and the report. */
  reason: string;
  /** Appended to Stage 2b's user message. Empty in full mode. */
  userBlock: string;
}

/** Artsy calls allowed in summary mode: one, for the report's display of other houses. */
export const SUMMARY_MODE_ARTSY_CALLS = 1;

export function planStage2bComps(ev: ValuationEvidence | null, stage3aPrices: boolean | null): Stage2bCompsPlan {
  if (!ev || stage3aPrices === null) {
    return { mode: "full", reason: "Stage 3a could not be checked before Stage 2b — full comps research (the pre-rule default)", userBlock: "" };
  }
  if (!stage3aPrices) {
    return { mode: "full", reason: "Stage 3a has no witness for this lot (no comps, no profile) — the LLM fallback needs Stage 2b's comps", userBlock: "" };
  }
  const t = ev.comps.tierCounts as Record<string, number>;
  const counts = Object.entries(t).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const sameWork = t.same_work ?? 0;
  const newestSameWork = ev.comps.items
    .filter((c) => c.tier === "same_work" && c.saleDate)
    .map((c) => c.saleDate as string)
    .sort()
    .pop();
  const userBlock =
    "\n\nCOMPS MODE: SUMMARY. Stage 3 will price this lot from the knowledge graph and the pricing model, " +
    "which do not read your auctionComps. So in this run:\n" +
    "- query_ackg_comparables is NOT available; the summary below is what the graph holds, already read in code.\n" +
    "- Spend NO web searches on auction comparables (STEP 7). Spend them on attribution, the catalogue raisonné " +
    "(STEP 3) and the series / edition structure.\n" +
    `- You may make ONE query_artsy_results call so the report can show other houses' sales; rows from it go in ` +
    "auctionComps as usual. Leave auctionComps empty if you skip it.\n" +
    "- The SCENARIO 1 comp floor does NOT apply in this mode: an auctionComps list shorter than three is correct here.\n" +
    `GRAPH COMPARABLES (summary): ${counts}. A sale of this exact print is ${sameWork > 0 ? `in the graph (${sameWork} record(s)${newestSameWork ? `, newest ${newestSameWork}` : ""})` : "NOT in the graph"}.` +
    (ev.profile ? ` The artist has a price profile (${ev.profile.basis === "segment" ? "segment default" : "own sales"}).` : "");
  return {
    mode: "summary",
    reason: `Stage 3a will price (graph comps: ${counts}${ev.profile ? "; profile present" : ""}) — comps research skipped, one Artsy call allowed`,
    userBlock,
  };
}
