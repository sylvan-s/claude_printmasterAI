/**
 * Pure-function tests for src/appraisal/attributed_lot.ts: the claim overlay, the verification
 * verdicts, the routing rule, the synthesised attribution and the Stage 3 block. No graph, no
 * model. Each case pins one rule the plan (step 2) states.
 *
 *   npm run test:attributed-lot
 */
import {
  mergeClaimIntoAppraiserInput, verifyAttributedLot, routeAttributedLot, synthesizeAttributionResult,
  buildAttributedLotValuationBlock, describeCompDifferences, lotPriceAttrs, primaryDimension, emptyAppraiserInput,
  namesCompatible, workTitleFromImageMatch, deriveMisattributionRisk,
  sameArtist, divergenceSignalUsable, compAgeYears, liquidityVerdict, conditionEvidenceLines,
  type CatalogueAttribution, type WorkResolution,
} from "../../src/appraisal/attributed_lot";
import type { TriageResult, Stage1dResult, VisualExtractionResult } from "../../src/types";
import type { WorkFacts } from "../../src/appraisal/knowledge_graph/query_work_facts";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (label: string, cond: boolean) => eq(label, cond, true);

const claim: CatalogueAttribution = {
  artist: "Pablo Picasso", artistQualifier: "certain", title: "Le Repas frugal", year: "1904",
  medium: "etching on wove", editionSize: 250, signed: false, editionNote: "from the edition of 250",
  dimensions: [{ kind: "plate", widthCm: 37.5, heightCm: 46.5 }, { kind: "sheet", widthCm: 50, heightCm: 65 }],
  catalogueRefs: ["Bloch 1"], estimateLow: 4000, estimateHigh: 6000, estimateCurrency: "GBP",
  house: "Roseberys London", saleId: "A0785", lotNumber: 1, saleDate: "2026-08-01", lotUrl: "https://example/1",
};

const triage = (over: Partial<TriageResult["artistAttribution"]> = {}, imp: TriageResult["impressionAssessment"] = null, scenario: TriageResult["routingDecision"]["scenario"] = 3): TriageResult => ({
  schemaVersion: "x", triageTimestamp: "", inputValidation: { inputValidationError: false, lowSourceConfidence: false, veaExtractionConfidence: 0.8, provisionalOutput: false },
  traditionIdentification: { primaryTradition: "", traditionConfidence: 0.5, supportingEvidence: [], contradictingEvidence: [] },
  periodEstimation: { estimatedPeriodRange: "", periodConfidence: 0.5 }, candidateArtists: [],
  riskFlags: { forgeryRisk: false, reprintRisk: false, editionComplexityRisk: false, misattributionRisk: false, authenticationBodyExists: false, physicalExaminationRequired: false },
  routingDecision: { scenario, scenarioName: "", specialistConfig: "general_print_fallback", routingRationale: "", humanEscalationRequired: false, humanEscalationReason: null },
  triageConfidenceSummary: { overallTriageConfidence: 0.7, criticalUnresolved: [] },
  artistAttribution: { verdict: "attributed", artistName: "Pablo Picasso", confidence: "HIGH", evidenceBasis: "A4", agreementSet: ["A"], kId: "true", kOeuvreMatchCount: 3, subjectCorroboration: "typical", subjectNote: "", flags: [], contradictingIdentities: [], ...over },
  workIdentification: null,
  impressionAssessment: imp,
});
const vea = (technique: string | null): VisualExtractionResult => ({ printingTechniques: technique ? [{ technique, family: "intaglio", visualEvidence: [], techniqueConfidence: 0.8, conflictingEvidence: null }] : [], dimensions: { sourceImage: "no_scale_reference" } } as any);
const work: WorkResolution = { basis: "exact_title", workIds: ["w1"], matchedNames: ["Le Repas frugal"], ambiguousAt: null, ambiguousNames: [] };
const facts: WorkFacts = { workIds: ["w1"], names: ["Le Repas frugal"], impressionCount: 12, techniques: ["Etching"], editionSizes: [250, 30], plateDimsCm: [[37.4, 46.3]], imageDimsCm: [], sheetDimsCm: [[50, 65]], rawMediums: ["etching"], sellThrough: { sold: 5, unsold: 2 } };
const stage1d = (artist: string | null, title: string | null, conf: "HIGH" | "MEDIUM" | "LOW" | null = "MEDIUM"): Stage1dResult => ({
  schemaVersion: "IES-1.0", embeddingModelsUsed: { dinov2: "dinov2-large", clip: null }, indexCoverageNote: "", attributionCaveat: "", hypothesisWarning: "",
  candidateMatches: artist ? [{ artistName: artist, conceptualWorkTitle: title, impressionId: null, dinov2Similarity: 0.93, clipSimilarity: null, provenanceLayer: "auction_history" }] : [],
  bestMatchArtist: artist, bestMatchConceptualWorkTitle: title, dinov2SimilarityScore: artist ? 0.93 : null, clipSimilarityScore: null, matchConfidence: artist ? conf : null,
});

console.log("mergeClaimIntoAppraiserInput");
{
  const m = mergeClaimIntoAppraiserInput(undefined, claim);
  eq("claim is documented_fact from catalogueNotes", [m.claimedAttribution.status, m.claimedAttribution.sourceField, m.claimedAttribution.artist, m.claimedAttribution.title], ["documented_fact", "catalogueNotes", "Pablo Picasso", "Le Repas frugal"]);
  eq("edition size and signature carried", [m.inscriptionClaims.editionSizeClaim, m.inscriptionClaims.signatureClaim, m.inscriptionClaims.status], [250, "unsigned (per catalogue)", "documented_fact"]);
  eq("plate dims preferred over sheet", m.dimensionsClaim, { widthCm: 37.5, heightCm: 46.5, kind: "plate", source: "regex" });
  eq("catalogue refs added", m.catalogueReferences, [{ ref: "Bloch 1", source: "regex" }]);
  const base = emptyAppraiserInput(); base.provenanceChain = [{ ownerOrEntity: "X", dateOrPeriod: null, status: "hypothesis", sourceExcerpt: "x" }]; base.catalogueReferences = [{ ref: "Bloch 1", source: "llm" }];
  const m2 = mergeClaimIntoAppraiserInput(base, claim);
  eq("Stage 1c provenance kept, refs not duplicated", [m2.provenanceChain.length, m2.catalogueReferences.length], [1, 1]);
  const m3 = mergeClaimIntoAppraiserInput(undefined, { ...claim, artistQualifier: "after" });
  eq("qualified attribution keeps its qualifier in the claim text", m3.claimedAttribution.artist, "after Pablo Picasso");
}

console.log("verifyAttributedLot");
{
  const v = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: stage1d("Pablo Picasso", "Le Repas frugal"), work, workFacts: facts });
  eq("all agree -> verified", [v.verdict, v.artist.status, v.work.status, v.image.status, v.technique.status, v.dimensions.status, v.edition.status], ["verified", "agrees", "resolved", "agrees", "agrees", "agrees", "agrees"]);
  eq("no divergences", v.divergences, []);
  const v2 = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage({ artistName: "Georges Braque" }), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("tree names another artist -> divergent", [v2.verdict, v2.artist.status], ["divergent", "diverges"]);
  const v3 = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage({}, { divergence: "none", dimensionMatch: "UNASSESSABLE", techniqueMatch: "unassessable", notes: "" }), vea: vea("Lithograph"), stage1d: null, work, workFacts: facts });
  eq("observed technique off the node -> divergent", [v3.verdict, v3.technique.status], ["divergent", "diverges"]);
  const v4 = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage({}, { divergence: "later_edition", dimensionMatch: "true", techniqueMatch: "true", notes: "" }), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("tree impression divergence -> divergent", [v4.verdict, v4.impressionDivergence], ["divergent", "later_edition"]);
  const v5 = verifyAttributedLot({ claim: { ...claim, editionSize: 500 }, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("unseen edition size is flagged, not a divergence", [v5.verdict, v5.edition.status], ["verified", "unseen_edition"]);
  const v6 = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea(null), stage1d: stage1d("Pablo Picasso", "Minotauromachie"), work, workFacts: { ...facts, plateDimsCm: [], sheetDimsCm: [] } });
  eq("nothing checkable but nothing contradicts -> partially_verified", [v6.verdict, v6.image.status, v6.technique.status, v6.dimensions.status], ["partially_verified", "different_work_same_artist", "unassessable", "unassessable"]);
  const v7 = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: stage1d("Marc Chagall", "Something", "HIGH"), work, workFacts: facts });
  eq("HIGH image match to another artist -> divergent", [v7.verdict, v7.image.status], ["divergent", "different_artist"]);
  const v8 = verifyAttributedLot({ claim, canonicalArtist: null, triage: triage({ verdict: "not_attributed", artistName: null, confidence: null }), vea: vea("Etching"), stage1d: null, work: null, workFacts: null });
  eq("artist not in graph -> unverifiable", [v8.verdict, v8.artist.status, v8.work.status], ["unverifiable", "not_in_graph", "unresolved"]);
  const v9 = verifyAttributedLot({ claim: { ...claim, dimensions: [{ kind: "plate", widthCm: 20, heightCm: 25 }] }, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("catalogue dims off the node -> divergent", [v9.verdict, v9.dimensions.catalogueVsNode], ["divergent", "diverges"]);
  const v10 = verifyAttributedLot({ claim: { ...claim, dimensions: [{ kind: "plate", widthCm: 46.5, heightCm: 37.5 }] }, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("transposed dims still agree", v10.dimensions.catalogueVsNode, "agrees");
}

console.log("routeAttributedLot");
{
  const v = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("verified + comps + Scenario 3 -> skip 2b", routeAttributedLot(v, 4).stage2bSkipped, true);
  eq("no same-work comps -> 2b", routeAttributedLot(v, 0).stage2bSkipped, false);
  for (const s of [2, 4, 5] as const) eq(`Scenario ${s} -> 2b`, routeAttributedLot({ ...v, scenario: s }, 4).stage2bSkipped, false);
  for (const s of [1, 3, 6] as const) eq(`Scenario ${s} -> skip`, routeAttributedLot({ ...v, scenario: s }, 4).stage2bSkipped, true);
  eq("divergent -> 2b", routeAttributedLot({ ...v, verdict: "divergent", divergences: ["x"] }, 4).stage2bSkipped, false);
  eq("partially_verified still skips (nothing diverges)", routeAttributedLot({ ...v, verdict: "partially_verified" }, 1).stage2bSkipped, true);
  eq("qualified attribution -> 2b", routeAttributedLot({ ...v, artist: { ...v.artist, qualifier: "after" } }, 4).stage2bSkipped, false);
  eq("work ambiguous -> 2b", routeAttributedLot({ ...v, work: { ...v.work, status: "ambiguous" } }, 4).stage2bSkipped, false);
}

console.log("synthesizeAttributionResult");
{
  const v = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  const a = synthesizeAttributionResult({ claim, canonicalArtist: "Pablo Picasso", verification: v, workFacts: facts, triage: triage() });
  eq("ASA shape, definitive when verified HIGH", [a.schemaVersion, a.attributionConclusion.attributionLevel, a.attributionConclusion.attributedArtist, a.attributionConclusion.workTitle, a.attributionChallengeAssessment.verdict], ["ASA-1.0", "definitive", "Pablo Picasso", "Le Repas frugal", "NOT_APPLICABLE"]);
  eq("refs carried", [a.catalogueRaisonne.referenceFound, a.catalogueRaisonne.plateOrCatalogueNumber], [true, "Bloch 1"]);
  const b = synthesizeAttributionResult({ claim, canonicalArtist: "Pablo Picasso", verification: { ...v, verdict: "partially_verified" }, workFacts: facts, triage: triage() });
  eq("probable when only partially verified", b.attributionConclusion.attributionLevel, "probable");
}

console.log("Stage 3 block + comp differences");
{
  const v = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  const comp = { tier: "same_work", institutionName: "Bonhams", saleDate: "2024-03-01", saleId: "1", lotNumber: 1, workTitle: "Le Repas frugal", techniques: ["Etching"], editionSize: 250, signed: true, rawMedium: "etching, signed in pencil, sheet 50x65cm", copyType: "numbered", plateDimensions: "37.5x46.5cm", imageDimensions: null, sheetDimensions: "50.0x65.0cm", priceRealisedGBP: 6500, hammerPriceGBP: 5000, priceCurrency: "GBP", priceRealisedNative: 6500, fxRateDate: null, estimateLowGBP: 4000, estimateHighGBP: 6000, listingUrl: null } as const;
  eq("lot attrs from the claim (plate before sheet, as the trainer)", lotPriceAttrs(claim), { signature: "unsigned", proof: "edition_unnumbered", editionSize: 250, areaCm2: 37.5 * 46.5, process: "etching" });
  eq("signature + proof differences named; same edition and plate size silent", describeCompDifferences(lotPriceAttrs(claim), comp as any), ["signature hand vs lot unsigned", "proof numbered vs lot edition_unnumbered"]);
  const comps = { comparables: [comp as any, { ...comp, hammerPriceGBP: 9000, saleDate: "2025-01-01" } as any], summary: { count: 2, tierCounts: { same_work: 2, same_artist_technique: 0, same_artist: 0 }, medianGBP: 6500, medianHammerGBP: 7000, medianSameWorkHammerGBP: 7000, minGBP: 6500, maxGBP: 6500, earliestSale: "2024-03-01", latestSale: "2025-01-01" }, coverageNote: "" };
  const block = buildAttributedLotValuationBlock({ claim, verification: v, routing: routeAttributedLot(v, 2), comps, workFacts: facts });
  ok("block names the drift anchor", block.includes("midpoint x 0.82 = 4,100"));
  ok("block carries the divergence flag", /same-work median \/ drift anchor = 1\.71 — COMPS WELL ABOVE/.test(block));
  ok("block carries liquidity", block.includes("sold 5, unsold 2 (71% sell-through)"));
  ok("block says 2b skipped", block.includes("Stage 2b SKIPPED"));
  ok("block lists the comp difference as a fact", block.includes("signature hand vs lot unsigned"));
  const lowLiq = buildAttributedLotValuationBlock({ claim, verification: v, routing: routeAttributedLot(v, 2), comps, workFacts: { ...facts, sellThrough: { sold: 1, unsold: 3 } } });
  ok("liquidity warning under 50% on 3+", lowLiq.includes("MEASURED SIGNAL: YES"));
  eq("primaryDimension prefers image/plate", primaryDimension(claim.dimensions)?.kind, "plate");
}

console.log("namesCompatible");
{
  ok("initial + surname", namesCompatible("G Braque", "Georges Braque"));
  ok("dotted initial", namesCompatible("P. Picasso", "Pablo Picasso"));
  ok("canonical equality", namesCompatible("Braque", "G. Braque", "Georges Braque", "Georges Braque"));
  ok("illegible initial never matches", !namesCompatible("E. [illegible]", "Edvard Munch"));
  ok("different surname", !namesCompatible("Georges Rouault", "Georges Braque"));
  ok("different first name, same surname", !namesCompatible("Paloma Picasso", "Pablo Picasso"));
  const v = verifyAttributedLot({ claim: { ...claim, artist: "Georges Braque" }, canonicalArtist: "Georges Braque", triage: triage({ artistName: "G Braque" }), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  eq("tree spelling 'G Braque' is not a divergence", v.artist.status, "agrees");
}

console.log("workTitleFromImageMatch");
{
  const g: CatalogueAttribution = { artist: "Paul Gauguin", title: "Auti Te Pape (Women at the River)" };
  const long = "Auti Te Pape (Women at the River), from the Noa Noa Suite (Guérin 96; Kornfeld 16.II.D.b)";
  const s1d = (t: string | null, a = "Paul Gauguin", d = 0.867): Stage1dResult => ({ ...stage1d(a, t), dinov2SimilarityScore: d, candidateMatches: [{ artistName: a, conceptualWorkTitle: t, impressionId: null, dinov2Similarity: d, clipSimilarity: null, provenanceLayer: "auction_history" }] });
  eq("lot title is the graph title's core -> the graph title", workTitleFromImageMatch(g, s1d(long), "Paul Gauguin"), long);
  eq("below the DINOv2 floor -> null", workTitleFromImageMatch(g, s1d(long, "Paul Gauguin", 0.7), "Paul Gauguin"), null);
  eq("other artist -> null", workTitleFromImageMatch(g, s1d(long, "Emile Bernard"), "Paul Gauguin"), null);
  eq("unrelated title -> null", workTitleFromImageMatch(g, s1d("Manao Tupapau"), "Paul Gauguin"), null);
  eq("series sibling with a longer core -> null", workTitleFromImageMatch({ ...g, title: "Auti Te Pape" }, s1d("Auti Te Pape II, from the Noa Noa Suite"), "Paul Gauguin"), null);
  eq("no 1d -> null", workTitleFromImageMatch(g, null, "Paul Gauguin"), null);
}

console.log("deriveMisattributionRisk");
{
  const base = { artistEvidence: { dominantCandidateName: "Pablo Picasso", veaNamesArtist: true, veaArtistName: "Picasso", reverseImageNamesArtist: false, reverseImageArtistName: "" }, riskFlags: { misattributionRisk: true } };
  eq("flag dropped when nobody else is named", deriveMisattributionRisk(base, claim, "Pablo Picasso").keep, false);
  eq("flag kept when the dominant candidate is someone else", deriveMisattributionRisk({ ...base, artistEvidence: { ...base.artistEvidence, dominantCandidateName: "Georges Braque" } }, claim, "Pablo Picasso").keep, true);
  eq("flag kept when VEA reads another name", deriveMisattributionRisk({ ...base, artistEvidence: { ...base.artistEvidence, veaArtistName: "Marc Chagall" } }, claim, "Pablo Picasso").keep, true);
  eq("VEA abbreviated spelling of the claimed artist is not 'someone else'", deriveMisattributionRisk({ ...base, artistEvidence: { ...base.artistEvidence, veaArtistName: "P. Picasso" } }, claim, "Pablo Picasso").keep, false);
  eq("not flagged stays not flagged", deriveMisattributionRisk({ ...base, riskFlags: { misattributionRisk: false } }, claim, "Pablo Picasso").keep, false);
}

console.log("sameArtist — one typed slip in the surname");
{
  ok("catalogue typo", sameArtist("Storm Thorgeson", "Storm Thorgerson"));
  ok("transposition", sameArtist("Graham Sutherand", "Graham Sutherland") || sameArtist("Peter Blakr", "Peter Blake"));
  ok("still covers the initial case", sameArtist("G Braque", "Georges Braque"));
  ok("different surname is not a slip", !sameArtist("Georges Braque", "Georges Bracque".replace("Bracque", "Rouault")));
  ok("same surname, different forename", !sameArtist("Paloma Picasso", "Pablo Picasso"));
  ok("illegible", !sameArtist("E. [illegible]", "Edvard Munch"));
  const conflict = triage({ verdict: "conflict", artistName: null, confidence: null, contradictingIdentities: ["Storm Thorgeson", "Storm Thorgerson"] });
  const spelling = verifyAttributedLot({ claim: { ...claim, artist: "Storm Thorgeson", title: "Metal Heads" }, canonicalArtist: "Storm Thorgerson", triage: conflict, vea: vea(null), stage1d: null, work: null, workFacts: null });
  eq("a conflict between two spellings is not a divergence", [spelling.artist.status, spelling.divergences.length], ["agrees", 0]);
  ok("and it is reported", !!spelling.spellingNote);
  const real = triage({ verdict: "conflict", artistName: null, confidence: null, contradictingIdentities: ["Pablo Picasso", "Georges Braque"] });
  const realV = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: real, vea: vea(null), stage1d: null, work, workFacts: facts });
  eq("a real competing identity still diverges", realV.artist.status, "diverges");
}

console.log("divergenceSignalUsable — a lone stale comp is not a signal");
{
  const c = (d: string) => ({ saleDate: d });
  eq("two comps always count", divergenceSignalUsable([c("2017-01-01"), c("2018-01-01")], "2026-09-23").usable, true);
  eq("one recent comp counts", divergenceSignalUsable([c("2025-01-01")], "2026-09-23").usable, true);
  eq("one stale comp does not", divergenceSignalUsable([c("2017-03-22")], "2026-09-23").usable, false);
  eq("one undated comp does not", divergenceSignalUsable([{ saleDate: null }], "2026-09-23").usable, false);
  eq("none does not", divergenceSignalUsable([], "2026-09-23").usable, false);
  eq("an upcoming lot measures against today", divergenceSignalUsable([c(new Date().toISOString().slice(0, 10))], null).usable, true);
  ok("age is measured against the lot's own sale", Math.abs((compAgeYears("2017-03-22", "2026-09-23") ?? 0) - 9.5) < 0.1);
  // The A0793/64 shape: one 2017 hammer at 0.59x the anchor must not arrive as a directional flag.
  const old = { tier: "same_work", institutionName: "Bonhams", saleDate: "2017-03-22", saleId: "x", lotNumber: 1, workTitle: "Le Repas frugal", techniques: ["Etching"], editionSize: 250, signed: false, rawMedium: "etching", copyType: null, plateDimensions: null, imageDimensions: null, sheetDimensions: null, priceRealisedGBP: 845, hammerPriceGBP: 650, priceCurrency: "GBP", priceRealisedNative: 845, fxRateDate: null, estimateLowGBP: null, estimateHighGBP: null, listingUrl: null };
  const v2 = verifyAttributedLot({ claim, canonicalArtist: "Pablo Picasso", triage: triage(), vea: vea("Etching"), stage1d: null, work, workFacts: facts });
  const b = buildAttributedLotValuationBlock({ claim, verification: v2, routing: routeAttributedLot(v2, 1), comps: { comparables: [old as any], summary: { count: 1, tierCounts: { same_work: 1, same_artist_technique: 0, same_artist: 0 }, medianGBP: 845, medianHammerGBP: 650, medianSameWorkHammerGBP: 650, minGBP: 845, maxGBP: 845, earliestSale: "2017-03-22", latestSale: "2017-03-22" }, coverageNote: "" }, workFacts: facts });
  ok("a lone 2017 comp is labelled NOT a directional signal", /NOT a directional signal/.test(b));
  ok("and the comp is still shown", /2017-03-22 Bonhams hammer 650/.test(b));
}

console.log("liquidityVerdict — the block carries the verdict, not the threshold");
{
  const L = (sold: number, unsold: number) => liquidityVerdict({ sold, unsold });
  eq("3+ appearances under 50% is the measured cohort", [L(1, 3).applies, /MEASURED SIGNAL: YES/.test(L(1, 3).line)], [true, true]);
  eq("exactly at 50% on 4 is not", [L(2, 2).applies, /MEASURED SIGNAL: NO/.test(L(2, 2).line)], [false, true]);
  eq("2 appearances at 50% is not (the Bonhams 32240 case)", L(1, 1).applies, false);
  ok("and it says why, and forbids the adjustment", /below the 3 the base rates were measured on/.test(L(1, 1).line) && /Take NO liquidity adjustment/.test(L(1, 1).line));
  eq("one unsold appearance alone is not", L(0, 1).applies, false);
  eq("no history at all is not a signal either", [L(0, 0).applies, /coverage fact/.test(L(0, 0).line)], [false, true]);
  ok("a 6-appearance 33% work IS the cohort", L(2, 4).applies);
}

console.log("conditionEvidenceLines — facts priced, absence never deducted");
{
  const lines = conditionEvidenceLines({ ...claim, editionNote: "the full sheet, framed" }, null).join("\n");
  ok("names the catalogue wording it found", /the full sheet/.test(lines) && /framed/.test(lines));
  ok("says Stage 1a is off by design", /OFF on this path BY DESIGN/.test(lines));
  ok("forbids the absent-examination discount", /take NO adjustment for the absence of a hands-on examination/i.test(lines));
  ok("redirects uncertainty", /belongs in confidence, evidenceAgainst and whatWouldChangeIt/.test(lines));
  const withNotes = conditionEvidenceLines(claim, { ...emptyAppraiserInput(), conditionClaims: [{ claim: "light toning to the margins", status: "hypothesis", sourceExcerpt: "x" }] }).join("\n");
  ok("carries the appraiser's condition claims", /light toning to the margins \[hypothesis\]/.test(withNotes));
  const bare = conditionEvidenceLines({ artist: "X" }, null).join("\n");
  ok("says so when the catalogue is silent", /nothing about condition beyond the medium line/.test(bare));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
