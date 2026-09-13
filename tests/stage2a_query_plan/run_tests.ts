/**
 * Pass/fail unit tests for the PURE half of src/appraisal/stage2a_query_plan.ts.
 *
 * No LLM calls, no network, no test framework — plain node:assert via tsx, matching
 * tests/two_pass_attribution/ and tests/routing/.
 *
 * The executor half needs a live graph and is exercised by
 * `npm run test:pool:triage -- --deterministic-queries`.
 *
 * Run: npm run test:stage2a-query-plan
 */
import assert from "node:assert/strict";
import {
  buildStage2aQueryPlan,
  mapTechniqueToAckgVocabulary,
  mapPaperToAckgVocabulary,
  parseClaimedPeriod,
  titlePreFilter,
  titleProbeFilter,
  artistNameFromSignature,
  mergeDuplicateWorkRows,
  observedDimsFromClaim,
  breakTitleTieOnDimensions,
  TITLE_TIE_BAND,
} from "../../src/appraisal/stage2a_query_plan";
import type { VisualExtractionResult, AppraiserInputResult } from "../../src/types";
import type { AckgWorkMatch } from "../../src/appraisal/knowledge_graph/types";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  FAIL- ${name}\n        ${err.message}`);
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
function vea(over: Partial<VisualExtractionResult> = {}): VisualExtractionResult {
  return {
    schemaVersion: "VEA-1.0",
    inspectionTimestamp: "",
    imagesReceived: { primaryScan: true, supplementaryScanCount: 0 },
    imageAuthenticity: {} as any,
    titleInscriptions: [],
    signatures: [],
    editionInfo: [],
    editionInfoAbsent: true,
    printingTechniques: [],
    plateMark: {} as any,
    dimensions: {} as any,
    paper: { surfaceType: "unknown" } as any,
    condition: {} as any,
    inkAndColour: {} as any,
    stampsAndLabels: [],
    composition: {} as any,
    photographicQuality: {} as any,
    visualEvidenceHighlights: [],
    overallExtractionConfidence: 0.8,
    lowConfidenceFlags: [],
    provisionalOutput: false,
    ...over,
  } as VisualExtractionResult;
}

function aia(artist: string | null, title: string | null, period: string | null, status: any = "hypothesis"): AppraiserInputResult {
  return {
    schemaVersion: "AIA-1.0",
    inputReceived: {} as any,
    claimedAttribution: { artist, title, period, technique: null, status, sourceField: null, sourceExcerpt: null },
    inscriptionClaims: {} as any,
    provenanceChain: [],
    conditionClaims: [],
    catalogueReferences: [],
    literatureOrExhibitionClaims: [],
    dimensionsClaim: null,
    paperOrSupport: null,
    rawNotes: {} as any,
    overallExtractionConfidence: 0.8,
    lowConfidenceFlags: [],
  } as AppraiserInputResult;
}

const tech = (technique: string, techniqueConfidence = 0.9) =>
  ({ technique, family: "planographic", visualEvidence: [], techniqueConfidence, conflictingEvidence: null }) as any;

const sig = (transcription: string, signatureConfidence = 0.9, type = "hand_signed") =>
  ({ id: "s1", type, transcription, medium: "graphite", location: "lower right", sourceImage: "PRIMARY_SCAN",
     box_2d: [], authenticityNotes: "", signatureConfidence }) as any;

// ── vocabulary ───────────────────────────────────────────────────────────────
console.log("\nControlled vocabulary");
test("Silkscreen and Serigraph both map to the stored 'Screenprint'", () => {
  assert.equal(mapTechniqueToAckgVocabulary("Silkscreen"), "Screenprint");
  assert.equal(mapTechniqueToAckgVocabulary("Serigraph"), "Screenprint");
  assert.equal(mapTechniqueToAckgVocabulary("Screenprint in colours"), "Screenprint");
});
test("compounds beat their parts", () => {
  assert.equal(mapTechniqueToAckgVocabulary("Wood engraving"), "Wood engraving");
  assert.equal(mapTechniqueToAckgVocabulary("Line engraving"), "Engraving");
  assert.equal(mapTechniqueToAckgVocabulary("Offset lithograph"), "Offset lithograph");
  assert.equal(mapTechniqueToAckgVocabulary("Colour lithograph"), "Lithograph");
  assert.equal(mapTechniqueToAckgVocabulary("Woodblock print"), "Woodcut");
});
test("an unmappable technique returns null rather than a string that silently returns zero rows", () => {
  assert.equal(mapTechniqueToAckgVocabulary("Cyanotype"), null);
  assert.equal(mapTechniqueToAckgVocabulary(""), null);
  assert.equal(mapTechniqueToAckgVocabulary(undefined), null);
});
test("paper maps only within the stored vocabulary", () => {
  assert.equal(mapPaperToAckgVocabulary("wove"), "wove");
  assert.equal(mapPaperToAckgVocabulary("BFK"), "BFK");
  assert.equal(mapPaperToAckgVocabulary("unknown"), null);
  assert.equal(mapPaperToAckgVocabulary("chine_colle"), null);
});

// ── period ───────────────────────────────────────────────────────────────────
console.log("\nPeriod parsing");
test("an explicit range is used as given", () => {
  assert.deepEqual(parseClaimedPeriod("1962-1964"), { startYear: 1962, endYear: 1964, basis: "explicit range 1962-1964" });
});
test("a decade becomes its ten years", () => {
  const r = parseClaimedPeriod("1960s")!;
  assert.equal(r.startYear, 1960);
  assert.equal(r.endYear, 1969);
});
test("circa widens by five, a bare year by two — catalogued and claimed dates disagree", () => {
  assert.deepEqual(parseClaimedPeriod("c. 1965")!.startYear, 1960);
  assert.deepEqual(parseClaimedPeriod("c. 1965")!.endYear, 1970);
  assert.deepEqual(parseClaimedPeriod("1965")!.startYear, 1963);
  assert.deepEqual(parseClaimedPeriod("1965")!.endYear, 1967);
});
test("nothing parseable, and an implausible year, yield null", () => {
  assert.equal(parseClaimedPeriod("mid-century"), null);
  assert.equal(parseClaimedPeriod(null), null);
  assert.equal(parseClaimedPeriod("edition of 3000"), null);
});

// ── title pre-filter ─────────────────────────────────────────────────────────
console.log("\nTitle pre-filter");
test("the longest 4+ letter word is chosen", () => {
  assert.equal(titlePreFilter("The Death of the Virgin"), "virgin");
  assert.equal(titlePreFilter("Nūr Jahān (H10-2, from The Empresses)"), "empresses");
});
test("accents fold rather than vanish — the graph folds both sides", () => {
  // Stripping punctuation before folding deleted the É outright and produced
  // "petit quilibrist", which is not a substring of the folded "le petit equilibrist".
  assert.equal(titleProbeFilter("Le Petit Équilibrist"), "petit equilibrist");
  assert.equal(titlePreFilter("Le Petit Équilibrist"), "equilibrist");
});
test("a title with no long word yields undefined rather than a useless filter", () => {
  assert.equal(titlePreFilter("Cat"), undefined);
  assert.equal(titlePreFilter(""), undefined);
});

// ── signature name recovery ──────────────────────────────────────────────────
console.log("\nSignature name recovery");
test("a plain signature reduces to a name, edition marks and dates stripped", () => {
  assert.equal(artistNameFromSignature("David Hockney"), "David Hockney");
  assert.equal(artistNameFromSignature("Picasso 47/50"), "Picasso");
  assert.equal(artistNameFromSignature("Peter Blake, A.P."), "Peter Blake");
  assert.equal(artistNameFromSignature("Henry Moore 1967"), "Henry Moore");
});
test("a monogram, an illegible mark, or a sentence returns null — the model reads those", () => {
  assert.equal(artistNameFromSignature("P.P."), null);
  assert.equal(artistNameFromSignature("illegible"), null);
  assert.equal(artistNameFromSignature("signature illegible in lower right"), null);
  assert.equal(artistNameFromSignature("HM"), null);
  assert.equal(artistNameFromSignature(""), null);
});
test("a long inscription is not mistaken for a name", () => {
  assert.equal(artistNameFromSignature("Printed by the Curwen Studio for the artist"), null);
});

// ── the plan ─────────────────────────────────────────────────────────────────
console.log("\nQuery plan");
test("candidates come from every structured source, appraiser first, deduped by folded name", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea({ signatures: [sig("David Hockney")] }),
    visualSearch: { bestMatchArtist: "David Hockney", bestMatchTitle: "A Bigger Splash", evidenceBasis: "visual" },
    appraiserInput: aia("Sir Peter Blake", "Babe Rainbow", "1968"),
    stage1d: { candidateMatches: [{ artistName: "Richard Hamilton", dinov2Similarity: 0.91 }] } as any,
  });
  assert.deepEqual(plan.candidates.map((c) => c.name), ["Sir Peter Blake", "David Hockney", "Richard Hamilton"]);
  assert.equal(plan.candidates[0].source, "appraiser");
  // Hockney arrives from VEA first and is not repeated when Stage 1b names him too.
  assert.equal(plan.candidates.filter((c) => c.name === "David Hockney").length, 1);
});

test("the scored title only ever comes off the object — Stage 1b's guess retrieves but is not scored", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea(),
    visualSearch: { bestMatchArtist: "Andy Warhol", bestMatchTitle: "Marilyn", evidenceBasis: "visual" },
    appraiserInput: null,
    stage1d: null,
  });
  assert.equal(plan.observedTitle, null);
  assert.equal(plan.observedTitleSource, null);
  assert.equal(plan.retrievalTitle, "Marilyn");
  assert.ok(plan.trace.some((t) => /circular/.test(t)));
});

test("Stage 1c's title outranks VEA's in-image reading", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea({ titleInscriptions: [{ id: "t1", transcription: "LE TAUREAU", classification: "title cartouche", location: "lower", medium: "printed", sourceImage: "PRIMARY_SCAN", titleConfidence: 0.9 }] }),
    appraiserInput: aia("Pablo Picasso", "Le Taureau, planche 3", "1945"),
  });
  assert.equal(plan.observedTitle, "Le Taureau, planche 3");
  assert.equal(plan.observedTitleSource, "appraiser");
  assert.equal(plan.observedTitleLegibleInImage, true);
});

test("VEA's in-image title is used when Stage 1c states none, but only for a title classification above threshold", () => {
  const titled = buildStage2aQueryPlan({
    vea: vea({ titleInscriptions: [{ id: "t1", transcription: "LE TAUREAU", classification: "title cartouche", location: "", medium: "", sourceImage: "", titleConfidence: 0.9 }] }),
  });
  assert.equal(titled.observedTitle, "LE TAUREAU");
  assert.equal(titled.observedTitleSource, "vea_in_image");

  const editionMark = buildStage2aQueryPlan({
    vea: vea({ titleInscriptions: [{ id: "t1", transcription: "47/50", classification: "edition mark", location: "", medium: "", sourceImage: "", titleConfidence: 0.9 }] }),
  });
  assert.equal(editionMark.observedTitle, null);

  const unsure = buildStage2aQueryPlan({
    vea: vea({ titleInscriptions: [{ id: "t1", transcription: "LE TAUREAU", classification: "title", location: "", medium: "", sourceImage: "", titleConfidence: 0.2 }] }),
  });
  assert.equal(unsure.observedTitle, null);
});

test("the œuvre query is refused when nothing survives the vocabulary — the same gate the loop enforced, now in code", () => {
  const plan = buildStage2aQueryPlan({ vea: vea({ printingTechniques: [tech("Cyanotype")] }), appraiserInput: aia(null, null, "1965") });
  assert.equal(plan.oeuvre, null);
  assert.ok(plan.oeuvreRefusal);
  assert.ok(/narrows nothing/.test(plan.oeuvreRefusal!));
});

test("the œuvre query carries technique and paper — and never the period, which would drop every undated work", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea({ printingTechniques: [tech("Silkscreen", 0.95)], paper: { surfaceType: "wove" } as any }),
    appraiserInput: aia("Peter Blake", null, "1968"),
  });
  assert.deepEqual(plan.oeuvre, { technique: "Screenprint", paper: "wove" });
  // The claim is still parsed and reported — it is context for the model, not a filter.
  assert.deepEqual(plan.claimedPeriod!.startYear, 1966);
  assert.ok(plan.trace.some((t) => /NOT applied as a filter/.test(t)));
});

test("Stage 1c's paper stands in when VEA read none, and alone it keeps the query off the refusal gate", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea(),
    appraiserInput: { ...aia("Peter Blake", "The Beach Boys", "1964", "documented_fact"), paperOrSupport: "wove" } as any,
  });
  assert.deepEqual(plan.oeuvre, { paper: "wove" });
  assert.equal(plan.oeuvreRefusal, null);
  assert.equal(plan.observedTechnique, null);
  assert.equal(plan.observedTechniqueSource, null);
});

test("a Stage 1c technique claim is used as a filter but flagged as a claim, not an observation", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea(),
    appraiserInput: { ...aia("Peter Blake", "The Beach Boys", "1964", "documented_fact"),
                      claimedAttribution: { artist: "Peter Blake", title: "The Beach Boys", period: "1964",
                                            technique: "silkscreen print in colours", status: "documented_fact",
                                            sourceField: null, sourceExcerpt: null } } as any,
  });
  assert.equal(plan.observedTechnique, "Screenprint");
  assert.equal(plan.observedTechniqueSource, "appraiser_claim");
  assert.deepEqual(plan.oeuvre, { technique: "Screenprint" });
});

test("the title probe filter is the whole title minus a leading article, not one word", () => {
  const plan = buildStage2aQueryPlan({ vea: vea(), appraiserInput: aia("Peter Blake", "The Beach Boys", null) });
  assert.equal(plan.titleProbeFilter, "beach boys");
  assert.equal(titlePreFilter(plan.observedTitle), "beach");
});

test("the highest-confidence mappable technique wins, and an unmappable one does not block a mappable one", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea({ printingTechniques: [tech("Cyanotype", 0.95), tech("Etching", 0.8)] }),
  });
  assert.equal(plan.observedTechnique, "Etching");
  assert.deepEqual(plan.observedTechniques, ["Cyanotype", "Etching"]);
});

test("the candidate list is capped, and the cap is recorded rather than silent", () => {
  const plan = buildStage2aQueryPlan({
    vea: vea(),
    stage1d: { candidateMatches: ["A", "B", "C", "D", "E", "F"].map((n) => ({ artistName: `Artist ${n}`, dinov2Similarity: 0.9 })) } as any,
  });
  assert.equal(plan.candidates.length, 4);
  assert.ok(plan.trace.some((t) => /capped at 4/.test(t)));
});

test("no derivable candidate is stated, not hidden", () => {
  const plan = buildStage2aQueryPlan({ vea: vea({ signatures: [sig("HM")] }) });
  assert.equal(plan.candidates.length, 0);
  assert.ok(plan.trace.some((t) => /lookupLateCandidate/.test(t)));
});

// ── duplicate work-row merging ───────────────────────────────────────────────
console.log("\nDuplicate work rows");
const row = (workTitle: string, artistName: string, over: Partial<AckgWorkMatch> = {}): AckgWorkMatch => ({
  workTitle, artistName, artistUlanUrl: null, dateLabel: null, techniques: [], rawMediums: [],
  plateDimsMm: [], imageDimsMm: [], sheetDimsMm: [], editionSizes: [], impressionCount: 1,
  provenanceLayers: [], titleEmbedding: null, ...over,
});

test("un-merged re-ingests of one work collapse; different works do not", () => {
  const merged = mergeDuplicateWorkRows([
    row("The Babe Rainbow", "Peter Blake", { techniques: ["Screenprint / Serigraphy"], impressionCount: 3 }),
    row("the babe rainbow", "Peter Blake", { techniques: ["Screenprint"], impressionCount: 2 }),
    row("Babe Rainbow II", "Peter Blake", { impressionCount: 1 }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].impressionCount, 5);
  assert.deepEqual(merged[0].techniques, ["Screenprint / Serigraphy", "Screenprint"]);
});

test("the same title under a different artist is never merged", () => {
  const merged = mergeDuplicateWorkRows([row("Flag", "Jasper Johns"), row("Flag", "Robert Rauschenberg")]);
  assert.equal(merged.length, 2);
});

// ── observed dimensions ──────────────────────────────────────────────────────
console.log("\nObserved dimensions from Stage 1c");
const claimDims = (widthCm: any, heightCm: any, kind: any) =>
  ({ ...aia("x", null, null), dimensionsClaim: { widthCm, heightCm, kind, source: "both" } }) as any;

test("cm becomes mm with width FIRST — the same order the catalogue rows are read in", () => {
  const d = observedDimsFromClaim(claimDims(22.2, 16.3, "plate"))!;
  assert.equal(d.kind, "plate");
  assert.deepEqual(d.mm, { width: 222, height: 163 });
});
test("the claimed kind routes to the matching cell", () => {
  assert.equal(observedDimsFromClaim(claimDims(50, 40, "full sheet"))!.kind, "sheet");
  assert.equal(observedDimsFromClaim(claimDims(50, 40, "printed image"))!.kind, "image");
});
test("an unstated or unattributable measurement is left to the model rather than guessed as a sheet", () => {
  assert.equal(observedDimsFromClaim(claimDims(50, 40, null)), null);
  assert.equal(observedDimsFromClaim(claimDims(50, null, "plate")), null);
  assert.equal(observedDimsFromClaim(null), null);
});
test("the plan carries the object's measurement", () => {
  const plan = buildStage2aQueryPlan({ vea: vea(), appraiserInput: claimDims(22.2, 16.3, "plate") });
  assert.deepEqual(plan.observedDims!.mm, { width: 222, height: 163 });
});

// ── dimension tie-break ──────────────────────────────────────────────────────
console.log("\nTitle tie broken on dimensions");
const sheetRow = (t: string, sim: number, w: number, h: number) =>
  row(t, "Elisabeth Frink", { titleSim: sim, sheetDimsMm: [{ w, h }] });
const OBJ = { kind: "sheet" as const, mm: { width: 600, height: 830 }, basis: "test" };

test("the measured A0793/113 case: the roman-numeral sibling the embedding cannot see is promoted", () => {
  const tr: string[] = [];
  // "Spinning man" against a series the embedding scores identically. V is a third out; VII fits.
  const out = breakTitleTieOnDimensions(
    [sheetRow("Spinning Man V", 1.0, 800, 575), sheetRow("Spinning Man VII", 1.0, 575, 805)],
    OBJ, tr,
  );
  assert.equal(out[0].workTitle, "Spinning Man VII");
  assert.ok(tr.some((t) => /title tie broken on dimensions/.test(t)));
});

test("a top row that already measures right is never disturbed", () => {
  const tr: string[] = [];
  const out = breakTitleTieOnDimensions(
    [sheetRow("Spinning Man VII", 1.0, 575, 805), sheetRow("Spinning Man V", 1.0, 800, 575)],
    OBJ, tr,
  );
  assert.equal(out[0].workTitle, "Spinning Man VII");
  assert.equal(tr.length, 0);
});

test("a better-measuring row OUTSIDE the tie band is not promoted — dimensions only settle titles the embedding calls equal", () => {
  const tr: string[] = [];
  const out = breakTitleTieOnDimensions(
    [sheetRow("Spinning Man V", 1.0, 800, 575), sheetRow("Something Else Entirely", 1.0 - TITLE_TIE_BAND - 0.2, 575, 805)],
    OBJ, tr,
  );
  assert.equal(out[0].workTitle, "Spinning Man V");
});

test("when nothing in the band fits, the top row stands and the failure is recorded", () => {
  const tr: string[] = [];
  const out = breakTitleTieOnDimensions(
    [sheetRow("Spinning Man V", 1.0, 800, 575), sheetRow("Spinning Man II", 1.0, 485, 770)],
    OBJ, tr,
  );
  assert.equal(out[0].workTitle, "Spinning Man V");
  assert.ok(tr.some((t) => /none matches the object/.test(t)));
});

test("no observed measurement, or nothing catalogued to compare against, changes nothing silently", () => {
  const tr: string[] = [];
  assert.equal(breakTitleTieOnDimensions([sheetRow("A", 1.0, 800, 575), sheetRow("B", 1.0, 575, 805)], null, tr)[0].workTitle, "A");
  assert.equal(
    breakTitleTieOnDimensions([row("A", "X", { titleSim: 1.0 }), row("B", "X", { titleSim: 1.0 })], OBJ, tr)[0].workTitle,
    "A",
  );
  assert.equal(tr.length, 0);
});

test("the closest fitting sibling wins, not merely the first", () => {
  const tr: string[] = [];
  const out = breakTitleTieOnDimensions(
    [sheetRow("V", 1.0, 800, 575), sheetRow("VI", 0.99, 560, 800), sheetRow("VII", 0.99, 598, 828)],
    OBJ, tr,
  );
  assert.equal(out[0].workTitle, "VII");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
