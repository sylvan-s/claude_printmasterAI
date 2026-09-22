/**
 * STAGE2B-COMPS-PLAN-1.0 (src/appraisal/stage2b_comps_plan.ts). The property that matters: Stage 2b
 * only drops comps research when Stage 3a is KNOWN to price; anything uncertain stays "full".
 *
 *   npm run test:stage2b-comps-plan
 */
import { planStage2bComps } from "../../src/appraisal/stage2b_comps_plan";
import { assessStage2bResearch } from "../../src/appraisal/stage2b_gate";
import type { ValuationEvidence } from "../../src/appraisal/valuation_evidence";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (l: string, c: boolean) => eq(l, c, true);

const ev = (tierCounts: Record<string, number>, items: { tier: string; saleDate: string | null }[] = [], profile: any = { basis: "artist" }) =>
  ({ comps: { tierCounts, items }, profile } as unknown as ValuationEvidence);

console.log("the safe default is full");
{
  eq("no evidence: full", planStage2bComps(null, null).mode, "full");
  eq("evidence but Stage 3a not checked: full", planStage2bComps(ev({ same_work: 2 }), null).mode, "full");
  eq("Stage 3a has no price: full, because the LLM fallback reads Stage 2b's comps", planStage2bComps(ev({}), false).mode, "full");
  eq("full mode adds nothing to the prompt", planStage2bComps(ev({}), false).userBlock, "");
}

console.log("summary when Stage 3a will price");
{
  const p = planStage2bComps(ev({ same_work: 2, same_artist: 30 }, [{ tier: "same_work", saleDate: "2019-05-01" }, { tier: "same_work", saleDate: "2023-11-02" }]), true);
  eq("mode", p.mode, "summary");
  ok("says the graph tool is unavailable", /query_ackg_comparables is NOT available/.test(p.userBlock));
  ok("forbids comp web searches", /Spend NO web searches on auction comparables/.test(p.userBlock));
  ok("allows exactly one Artsy call", /ONE query_artsy_results call/.test(p.userBlock));
  ok("lifts the Scenario 1 comp floor, which would otherwise demand searching", /SCENARIO 1 comp floor does NOT apply/.test(p.userBlock));
  ok("reports the tier counts", /same_work 2, same_artist 30/.test(p.userBlock));
  ok("reports the same-print sale and its newest date", /in the graph \(2 record\(s\), newest 2023-11-02\)/.test(p.userBlock));
  const none = planStage2bComps(ev({ same_artist: 4 }), true);
  ok("and says plainly when no same-print sale exists", /is NOT in the graph/.test(none.userBlock));
  ok("a price from the profile alone still counts as pricing", planStage2bComps(ev({}), true).mode === "summary");
}

console.log("the gate follows the plan");
{
  const quiet = { auctionComps: [] };
  eq("full mode: no search and no same-work sale still escalates",
    assessStage2bResearch(quiet, { searches: 0, graphSameWorkComps: 0, compsRequired: true }).reasons, ["no_search_despite_gap"]);
  ok("summary mode: silence on comps is correct",
    !assessStage2bResearch(quiet, { searches: 0, graphSameWorkComps: 0, compsRequired: false }).escalate);
  eq("summary mode does not excuse an uncited comp",
    assessStage2bResearch({ auctionComps: [{ artworkTitle: "x", priceAmount: 5 }] }, { searches: 0, graphSameWorkComps: 0, compsRequired: false }).reasons, ["uncited_comp"]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
