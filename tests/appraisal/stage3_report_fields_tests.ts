/**
 * The report fields built in code instead of by the LLM Stage 3 call. `npm run test:stage3-report-fields`
 */
import { recentSalesFromEvidence, editionFromEvidence, reproductionFromEvidence, nextStepsFromEvidence, stage3ReportFields, RECENT_SALES_SHOWN } from "../../src/appraisal/stage3_report_fields";
import type { ValuationEvidence } from "../../src/appraisal/valuation_evidence";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); } }
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }

const comp = (tier: any, hammer: number | null, realised: number | null, date: string, title = "T"): any => ({ tier, hammerGBP: hammer, realisedGBP: realised, saleDate: date, house: "Bonhams", saleId: "s", lotNumber: 1, workTitle: title, listingUrl: null, attrs: { process: "etching" } });
const ev = (over: Partial<ValuationEvidence> = {}): ValuationEvidence => ({
  schemaVersion: "VE-1.0", builtAt: "t", artist: { reported: "X", canonical: "Artist X" }, profile: null,
  attrs: { signature: { value: "hand", source: "catalogue" }, proof: { value: "artist_proof", source: "catalogue" }, editionSize: { value: 50, source: "catalogue" }, areaCm2: { value: null, source: "default" }, process: { value: "etching", source: "catalogue" } },
  targetHouse: { value: "Bonhams", source: "catalogue" }, valuationDate: { value: "2024-06-01", source: "catalogue" },
  identity: { workIds: ["w"], basis: "exact_title", matchedName: "T", ambiguousAt: null, via: "claim" },
  comps: { query: {} as any, items: [comp("same_artist", 300, 390, "2024-01-01", "Other"), comp("same_work", 1000, 1300, "2020-01-01"), comp("same_work", 1200, null, "2023-01-01"), comp("same_artist_technique", null, null, "2024-02-01")], tierCounts: { same_work: 2, same_artist_technique: 1, same_artist: 1 }, coverageNote: "" },
  webComps: [], condition: { grade: null, defects: [], appraiserClaims: [], source: "default" }, sellThrough: null, printedEstimate: null, warnings: [], ...over,
});
{
  const sales = recentSalesFromEvidence(ev());
  eq("same work first, newest first within a tier; priceless comps dropped", sales.map((s) => [s.artworkTitle, s.saleDate]), [["T", "2023-01-01"], ["T", "2020-01-01"], ["Other", "2024-01-01"]]);
  eq("price shows what buyers paid with the hammer beside it", sales[1].priceRealized, "£1,300 (hammer £1,000)");
  eq("hammer-only comps say so", sales[0].priceRealized, "hammer £1,200");
  ok("condition is never invented", sales.every((s) => s.conditionState.startsWith("not recorded")));
  const many = ev({ comps: { ...ev().comps, items: Array.from({ length: 20 }, (_, i) => comp("same_artist", 100 + i, null, `2020-01-${String(i + 1).padStart(2, "0")}`)) } });
  eq("capped", recentSalesFromEvidence(many).length, RECENT_SALES_SHOWN);

  eq("edition: sourced proof and size plus Stage 2b notes", editionFromEvidence(ev(), { seriesAndEditionIdentification: { editionNotes: "first state" } } as any), "artist proof (catalogue); edition of 50 (catalogue); Stage 2b: first state");
  eq("edition: nothing stated says so", editionFromEvidence(ev({ attrs: { ...ev().attrs, proof: { value: "numbered", source: "default" }, editionSize: { value: null, source: "default" } } }), null), "Edition and impression number not stated in the catalogue, the notes or the image.");

  const clean = reproductionFromEvidence({ reprintForgeryAssessment: { reprintForgeryRisk: "LOW" }, seriesAndEditionIdentification: { editionType: "first" } } as any, null, null);
  eq("no indicators with an assessed risk", [clean.isLikely, clean.explanation], [false, "No reproduction indicators: Stage 2b reprint/forgery risk LOW, first edition."]);
  const repro = reproductionFromEvidence({ reprintForgeryAssessment: { reprintForgeryRisk: "HIGH" }, seriesAndEditionIdentification: { editionType: "posthumous" } } as any, { imageAuthenticity: { classification: "DIGITAL_REPRODUCTION" } } as any, { impressionAssessment: { divergence: "reproduction" } } as any);
  ok("a reproduction finding flags, and every signal is named", repro.isLikely && ["HIGH", "posthumous", "evidence tree", "digital reproduction"].every((k) => repro.explanation.includes(k)));
  const later = reproductionFromEvidence({ reprintForgeryAssessment: { reprintForgeryRisk: "HIGH" }, seriesAndEditionIdentification: { editionType: "posthumous" } } as any, null, null);
  ok("a posthumous edition with HIGH risk is explained, not flagged", !later.isLikely && later.explanation.includes("genuine later printing") && later.explanation.includes("examine"));
  eq("unassessed risk is not a clean bill", reproductionFromEvidence(null, null, null).explanation.includes("not assessed"), true);

  const steps = nextStepsFromEvidence(ev({ targetHouse: { value: null, source: "default" }, identity: { ...ev().identity, workIds: [] } }), { unresolvedQuestions: [{ resolutionAction: "Check Bloch 123" }], reprintForgeryAssessment: { physicalExaminationRecommended: true } } as any);
  ok("Stage 2b's actions come first", steps[0] === "Check Bloch 123");
  ok("examination, unstated size, condition, house and identity steps all present", ["in hand", "sheet size", "condition report", "auction house", "catalogue raisonné"].every((k) => steps.some((s) => s.includes(k))));
  const all = stage3ReportFields(ev(), null, null, null);
  eq("the bundle carries exactly the five LLM-free fields", Object.keys(all).sort(), ["editionSizeAndPrintNumber", "isLikelyReproductionOrPoster", "nextSteps", "recentAuctionSales", "reproductionExplanation"]);
}
console.log(`\nstage3 report fields tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
