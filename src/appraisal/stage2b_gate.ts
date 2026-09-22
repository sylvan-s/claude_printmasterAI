/**
 * Should Stage 2b's research be redone on a stronger model?
 *
 * Measured 2026-09-14, four lots each way: Haiku 4.5 costs $0.069 a lot against Sonnet 4.6's
 * $0.196, agrees on the attributed artist 4 times out of 4, and honestly records MORE of what it
 * could not resolve. It is also, on half those lots, unusable — and the two halves are
 * distinguishable from the output itself, which is what makes a gate possible rather than a
 * gamble.
 *
 * THE GATE IS ABOUT VERIFIABILITY, NOT EFFORT. The obvious signal was search count: both Haiku
 * failures made exactly one search. But STEP 7 of the specialist prompt now tells Stage 2b to
 * skip comp searches when the graph already holds a same_work record, so a single search can be
 * correct and diligent. Gating on effort would punish the model for obeying an instruction added
 * the same day. What does not become acceptable is an unverifiable claim, so that is what is
 * checked:
 *
 *   UNCITED COMP — a price with no page behind it, or only a page that cannot show it (an artist
 *     overview, a search, a home page — see isSpecificResultUrl). This is the measured fabrication signature:
 *     on the Cindy Sherman lot Haiku returned three comps with no URL and no stated basis, naming
 *     the artist's most famous series at small-print prices, and across three runs produced the
 *     same GBP 1,875 attached to three different titles. The specialist prompt already says a
 *     price you cannot point at a URL for is not a comparable; a model that ignores that on the
 *     comps is not to be trusted on the rest of its report either.
 *   UNCITED CATALOGUE RAISONNÉ — the same failure in a different field: a named catalogue
 *     asserted with no source, which ADR-0007 Decision 3 already refuses to write to the graph.
 *   SILENT ON A REAL GAP — zero searches when the graph returned no same_work record. With a
 *     same_work record, zero searches is now correct. Without one, finding a comparable was the
 *     job, and not attempting it is not a finding. A same-print sale from query_artsy_results
 *     (2026-09-22) closes the gap the same way: the comparable WAS found, by the cheap route,
 *     and it arrives with an artsy.net result URL, so the uncited-comp check still applies.
 *
 * A FOURTH reason is not a judgement about the output but the absence of one: the cheap attempt
 * THREW. Measured the first time this gate ran live — Haiku ended its turn on the Cindy Sherman
 * lot with a prose summary instead of the required JSON, the parser raised, and the lot died.
 * Under gating that must not happen: an unusable result is the strongest escalation signal there
 * is, and a model that cannot be relied on to return the schema is exactly what the stronger
 * model is held in reserve for. `stage2bResearchFailed` builds that verdict.
 *
 * Escalation re-runs the stage from scratch on the stronger model and uses that result. The
 * cheap attempt is kept in the report so the decision is auditable, not just its outcome.
 *
 * The economics, from the same measurement: Stage 2b costs about $0.04 on Haiku and $0.157 on
 * Sonnet, so a gated run costs 0.04 + E x 0.157 against 0.157 always-Sonnet, and pays for itself
 * while the escalation rate E stays under about 75%. On the four measured lots E was 50%.
 */
import { isSpecificResultUrl, type Stage2bComp } from "./comp_storability.js";

export interface Stage2bResearchTelemetry {
  /** Web searches actually executed during the stage (webSearchUsage().searches). */
  searches: number;
  /** same_work comps the graph returned for this lot, which decides whether silence is honest. */
  graphSameWorkComps: number;
  /** Same-print sales query_artsy_results returned during the stage (artsyUsage().sameWork).
   *  Counts toward closing the gap just as a graph same_work record does — see SILENT ON A
   *  REAL GAP above. Optional so older callers read as zero. */
  artsySameWorkComps?: number;
  /** False when stage2b_comps_plan.ts put the stage in summary mode: Stage 3a prices the lot, so
   *  researching comps was not the task and silence on them is correct. Optional: default true. */
  compsRequired?: boolean;
}

export type Stage2bGateReason =
  | "uncited_comp" | "uncited_catalogue_raisonne" | "no_search_despite_gap" | "research_failed";

export interface Stage2bGateResult {
  escalate: boolean;
  reasons: Stage2bGateReason[];
  /** One line for the run log, naming what failed and what it was. */
  detail: string;
}

const usableUrl = (raw: unknown): boolean => {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return false;
  try { const u = new URL(v); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes("."); }
  catch { return false; }
};

/** The cheap model threw rather than returning a report. Escalate on the strongest signal. */
export function stage2bResearchFailed(err: unknown): Stage2bGateResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    escalate: true,
    reasons: ["research_failed"],
    detail: `the research call failed and returned no usable report: ${msg.slice(0, 200)}`,
  };
}

export function assessStage2bResearch(result: unknown, t: Stage2bResearchTelemetry): Stage2bGateResult {
  const reasons: Stage2bGateReason[] = [];
  const notes: string[] = [];
  const r = (result ?? {}) as any;

  const comps: Stage2bComp[] = Array.isArray(r.auctionComps) ? r.auctionComps : [];
  const uncited = comps.filter((c) => !isSpecificResultUrl(c?.listingUrl));
  if (uncited.length) {
    reasons.push("uncited_comp");
    notes.push(`${uncited.length} of ${comps.length} comp(s) carry no URL that shows the sale (${uncited.map((c) => `"${c?.artworkTitle ?? "untitled"}"${typeof c?.priceAmount === "number" ? ` @ ${c.priceAmount}` : ""}`).join(", ")})`);
  }

  const cr = r.catalogueRaisonne ?? {};
  if (cr.referenceFound === true && typeof cr.catalogueName === "string" && cr.catalogueName.trim() && !usableUrl(cr.sourceUrl)) {
    reasons.push("uncited_catalogue_raisonne");
    notes.push(`catalogue raisonné "${cr.catalogueName.trim()}" asserted with no source URL`);
  }

  if (t.compsRequired !== false && t.searches === 0 && t.graphSameWorkComps === 0 && (t.artsySameWorkComps ?? 0) === 0) {
    reasons.push("no_search_despite_gap");
    notes.push("no web search was made, and neither the graph nor Artsy holds a same-work sale — the gap it was sent to close was not attempted");
  }

  return {
    escalate: reasons.length > 0,
    reasons,
    detail: reasons.length ? notes.join("; ") : `research is verifiable: ${comps.length} comp(s), all cited; ${t.searches} search(es)`,
  };
}
