/**
 * Pass/fail unit tests for src/appraisal/two_pass_attribution.ts — ADR-0010.
 *
 * No LLM calls, no network, no test framework (matches tests/routing/). Plain
 * node:assert, run via tsx.
 *
 * Run: npm run test:two-pass
 */
import assert from "node:assert/strict";
import {
  classifyArtistPass,
  passTwoGate,
  classifyWorkPass,
  classifyImpression,
  classifyDimensionMatch,
  classifyTechniqueMatch,
  techniqueFamily,
  classifyTwoPass,
  mapTwoPassToScenario,
  normalizeName,
  nameSimilarity,
  titleSimilarity,
  SIM_ARTIST_VOTE,
} from "../../src/appraisal/two_pass_attribution";
import { Scenario } from "../../src/appraisal/routing";
import * as f from "./fixtures";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
  }
}

// ── name / title normalization ───────────────────────────────────────────────
console.log("Name & title normalization\n");

test("normalizeName flips 'Surname, First' and strips honorifics/nationality/dates", () => {
  assert.equal(normalizeName("Trevelyan, Julian Otto").key, normalizeName("Julian Otto Trevelyan").key);
  assert.equal(normalizeName("Julian Trevelyan RA").key, normalizeName("Julian Trevelyan").key);
  assert.equal(normalizeName("Julian Trevelyan (British, 1910-1988)").key, normalizeName("Julian Trevelyan").key);
});

test("nameSimilarity: reversed form matches natural form >= threshold", () => {
  assert.ok(nameSimilarity("Trevelyan, Julian Otto", "Julian Trevelyan RA") >= 0.9);
  assert.ok(nameSimilarity("Pablo Picasso", "Georges Braque") < 0.5);
});

test("titleSimilarity: cross-form title match", () => {
  assert.ok(titleSimilarity("The Great Wave off Kanagawa", "Great Wave off Kanagawa") >= 0.8);
  assert.ok(titleSimilarity("The Bathers", "The Cardplayers") < 0.5);
});

// ── PASS 1: artist decision table ────────────────────────────────────────────
console.log("\nPass 1 — Artist (A1..A11)\n");

test("A1 — V+R+A agree -> ATTRIBUTED HIGH", () => {
  const v = classifyArtistPass(f.a1_threeAgree);
  assert.equal(v.evidenceBasis, "A1");
  assert.equal(v.verdict, "attributed");
  assert.equal(v.confidence, "HIGH");
  assert.deepEqual(v.agreementSet.sort(), ["A", "R", "V"]);
});

test("A2 — n=2 + K_oeuvre>=1 -> ATTRIBUTED HIGH (ackgCorroborated)", () => {
  const v = classifyArtistPass(f.a2_twoAgreeAckgSupport);
  assert.equal(v.evidenceBasis, "A2");
  assert.equal(v.confidence, "HIGH");
  assert.ok(v.flags.includes("ackgCorroborated"));
});

test("A3 — n=2, K_oeuvre=0, K_id true -> MEDIUM_HIGH + recognisedArtist_noMatchingOeuvre", () => {
  const v = classifyArtistPass(f.a3_recognisedNoOeuvre);
  assert.equal(v.evidenceBasis, "A3");
  assert.equal(v.confidence, "MEDIUM_HIGH");
  assert.ok(v.flags.includes("recognisedArtist_noMatchingOeuvre"));
});

test("A4 — n=2, K_id false -> MEDIUM (artistNotInACKG)", () => {
  const v = classifyArtistPass(f.a4_notInAckg);
  assert.equal(v.evidenceBasis, "A4");
  assert.equal(v.confidence, "MEDIUM");
  assert.ok(v.flags.includes("artistNotInACKG"));
});

test("A5 — single VEA signature -> CANDIDATE MEDIUM", () => {
  const v = classifyArtistPass(f.a5_singleVeaSignature);
  assert.equal(v.evidenceBasis, "A5");
  assert.equal(v.verdict, "candidate");
  // K_oeuvre=1 is < KOEUVRE_DISCRIMINATING_MIN, so no lift
  assert.equal(v.confidence, "MEDIUM");
});

test("A5 — low-confidence signature -> CANDIDATE LOW", () => {
  const v = classifyArtistPass(f.a5_lowConfidenceSignature);
  assert.equal(v.evidenceBasis, "A5");
  assert.equal(v.confidence, "LOW");
});

test("A6 — strong image match only -> CANDIDATE MEDIUM", () => {
  const v = classifyArtistPass(f.a6_strongImageOnly);
  assert.equal(v.evidenceBasis, "A6");
  assert.equal(v.confidence, "MEDIUM");
});

test("A7 — weak image match only -> CANDIDATE LOW", () => {
  const v = classifyArtistPass(f.a7_weakImageOnly);
  assert.equal(v.evidenceBasis, "A7");
  assert.equal(v.confidence, "LOW");
});

test("A8 — documented appraiser claim only -> CANDIDATE (lifted one band by discriminating K_oeuvre? no, count=1) MEDIUM", () => {
  const v = classifyArtistPass(f.a8_documentedAppraiserOnly);
  assert.equal(v.evidenceBasis, "A8");
  assert.equal(v.verdict, "candidate");
  assert.equal(v.confidence, "MEDIUM");
});

test("A9 — appraiser hypothesis only -> NOT ATTRIBUTED LOW", () => {
  const v = classifyArtistPass(f.a9_appraiserHypothesisOnly);
  assert.equal(v.evidenceBasis, "A9");
  assert.equal(v.verdict, "not_attributed");
});

test("A10 — V and R name different artists -> CONFLICT", () => {
  const v = classifyArtistPass(f.a10_conflict);
  assert.equal(v.evidenceBasis, "A10");
  assert.equal(v.verdict, "conflict");
  assert.ok(v.contradictingIdentities.length >= 1);
});

test("A10 — documented_fact appraiser claim vs legible VEA signature -> CONFLICT (override)", () => {
  const v = classifyArtistPass(f.a10_documentedFactVsSignature);
  assert.equal(v.evidenceBasis, "A10");
  assert.equal(v.verdict, "conflict");
});

test("A11 — no signal -> NOT ATTRIBUTED, no confidence", () => {
  const v = classifyArtistPass(f.a11_nothing);
  assert.equal(v.evidenceBasis, "A11");
  assert.equal(v.verdict, "not_attributed");
  assert.equal(v.confidence, null);
});

console.log("\nPass 1 — layered rules\n");

test("hypothesis contradicting VEA does NOT force a conflict (VEA wins, n=1 -> A5)", () => {
  const v = classifyArtistPass(f.hypothesisVsVeaNotConflict);
  assert.notEqual(v.verdict, "conflict");
  assert.equal(v.artistName, "Barbara Hepworth");
});

test("Stage 1b hit inconsistent with VEA is dropped from the vote (V-only -> A5, not A1/A2)", () => {
  const v = classifyArtistPass(f.rInconsistentDropped);
  assert.equal(v.evidenceBasis, "A5");
  assert.ok(v.ruleTrace.some((l) => l.includes("R dropped from vote")));
});

test(`Stage 1b hit below sim floor (${SIM_ARTIST_VOTE}) is dropped from the vote`, () => {
  const v = classifyArtistPass(f.rBelowThresholdDropped);
  assert.equal(v.evidenceBasis, "A5");
});

test("subject ATYPICAL raises a flag but does NOT downgrade the verdict", () => {
  const v = classifyArtistPass(f.subjectAtypicalFlag);
  assert.equal(v.evidenceBasis, "A2"); // n=2 + K_oeuvre>=1
  assert.equal(v.confidence, "HIGH");
  assert.equal(v.subjectCorroboration, "atypical");
  assert.ok(v.flags.includes("subjectAtypicalForArtist"));
});

test("subject corroboration is carried through to the verdict (typical + note)", () => {
  const v = classifyArtistPass(f.a1_threeAgree);
  assert.equal(v.subjectCorroboration, "typical");
  assert.ok(v.subjectNote.length > 0);
});

test("Tate reversed-name form still agrees (n=3 -> A1)", () => {
  const v = classifyArtistPass(f.reversedNameStillAgrees);
  assert.equal(v.evidenceBasis, "A1");
});

// ── K vote — ADR-0010 Decision 4a amendment ──────────────────────────────────

test("K alone (ACKG work-level artist+title match) lifts NOT ATTRIBUTED -> CANDIDATE MEDIUM (A8K)", () => {
  const v = classifyArtistPass(
    f.artistEv({ ackgWorkAnchor: { artist: "Rembrandt van Rijn", titleSim: 0.95 } }),
  );
  assert.equal(v.evidenceBasis, "A8K");
  assert.equal(v.verdict, "candidate");
  assert.equal(v.confidence, "MEDIUM");
  assert.equal(v.artistName, "Rembrandt van Rijn");
  assert.deepEqual(v.agreementSet, ["K"]);
});

test("K below TAU_TITLE does not vote (stays NOT ATTRIBUTED)", () => {
  const v = classifyArtistPass(
    f.artistEv({ ackgWorkAnchor: { artist: "Rembrandt van Rijn", titleSim: 0.5 } }),
  );
  assert.equal(v.evidenceBasis, "A11");
  assert.equal(v.verdict, "not_attributed");
});

test("K + a consistent single VEA signature -> n=2 (A2/A3/A4 depending on K_oeuvre)", () => {
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Rembrandt van Rijn" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      kOeuvreMatchCount: 240,
      ackgWorkAnchor: { artist: "Rembrandt van Rijn", titleSim: 0.95 },
    }),
  );
  assert.equal(v.verdict, "attributed");
  assert.ok(["A2", "A3", "A4"].includes(v.evidenceBasis));
  assert.ok(v.agreementSet.includes("K") && v.agreementSet.includes("V"));
});

test("K naming a different identity than VEA -> CONFLICT (A10)", () => {
  const v = classifyArtistPass(
    f.artistEv({
      vea: { kind: "names", raw: "Joan Miró" },
      veaAuthorshipSignalLegible: true,
      veaSignatureConfidence: 0.8,
      ackgWorkAnchor: { artist: "Marc Chagall", titleSim: 0.9 },
    }),
  );
  assert.equal(v.verdict, "conflict");
  assert.equal(v.evidenceBasis, "A10");
});

// ── GATE ─────────────────────────────────────────────────────────────────────
console.log("\nPass-2 gate\n");

test("gate opens for an ATTRIBUTED artist", () => {
  assert.equal(passTwoGate(classifyArtistPass(f.a2_twoAgreeAckgSupport), false).runPass2, true);
});

test("gate opens for a MEDIUM candidate", () => {
  assert.equal(passTwoGate(classifyArtistPass(f.a6_strongImageOnly), false).runPass2, true);
});

test("gate BLOCKS a LOW candidate with no in-image title", () => {
  const g = passTwoGate(classifyArtistPass(f.a7_weakImageOnly), false);
  assert.equal(g.runPass2, false);
});

test("gate opens via the in-image-title exception even when the artist verdict is weak", () => {
  const g = passTwoGate(classifyArtistPass(f.a9_appraiserHypothesisOnly), true);
  assert.equal(g.runPass2, true);
  assert.equal(g.mode, "in_image_title");
});

// ── PASS 2: work decision table ─────────────────────────────────────────────
console.log("\nPass 2 — Conceptual Work (T1..T7)\n");

test("T1 — all three title sources agree -> IDENTIFIED HIGH", () => {
  const v = classifyWorkPass(f.t1_allTitlesAgree);
  assert.equal(v.evidenceBasis, "T1");
  assert.equal(v.confidence, "HIGH");
});

test("T2 — 2 agree + K_work title match -> IDENTIFIED HIGH", () => {
  const v = classifyWorkPass(f.t2_twoAgreeKworkFullMatch);
  assert.equal(v.evidenceBasis, "T2");
  assert.equal(v.confidence, "HIGH");
});

test("T4 — 2 agree, no K_work hit -> IDENTIFIED MEDIUM", () => {
  const v = classifyWorkPass(f.t4_twoAgreeNoKwork);
  assert.equal(v.evidenceBasis, "T4");
  assert.equal(v.confidence, "MEDIUM");
});

test("T4 — 2 agree, weak K_work titleSim -> IDENTIFIED MEDIUM (not T2)", () => {
  const v = classifyWorkPass(f.t4_twoAgreeWeakKwork);
  assert.equal(v.evidenceBasis, "T4");
});

test("T5 — single title source -> CANDIDATE", () => {
  const v = classifyWorkPass(f.t5_singleTitleSource);
  assert.equal(v.evidenceBasis, "T5");
  assert.equal(v.verdict, "candidate");
});

test("T8K — no source consensus but a strong K_work embedding match -> IDENTIFIED MEDIUM", () => {
  const v = classifyWorkPass(f.t8k_kworkAnchorNoConsensus);
  assert.equal(v.evidenceBasis, "T8K");
  assert.equal(v.verdict, "identified");
  assert.equal(v.confidence, "MEDIUM");
  assert.equal(v.conceptualWorkTitle, "H10-1 Wu Zetian, from The Empresses");
});

test("T6 — title sources conflict -> CONFLICT", () => {
  const v = classifyWorkPass(f.t6_titlesConflict);
  assert.equal(v.evidenceBasis, "T6");
  assert.equal(v.verdict, "conflict");
});

test("T7 — no title evidence -> UNRESOLVED", () => {
  const v = classifyWorkPass(f.t7_noTitleEvidence);
  assert.equal(v.evidenceBasis, "T7");
  assert.equal(v.verdict, "unresolved");
});

// ── IMPRESSION ──────────────────────────────────────────────────────────────
console.log("\nImpression divergence (5b) + dimension rules\n");

test("dimensions: no usable observed measurement -> UNASSESSABLE (not a mismatch)", () => {
  const d = classifyDimensionMatch({ observedSource: "none", workIsIntaglio: true });
  assert.equal(d.match, "UNASSESSABLE");
});

test("dimensions: VEA-scaled widens tolerance to swallow ±15-20% noise", () => {
  const d = classifyDimensionMatch({
    observedSource: "vea_scaled",
    workIsIntaglio: true,
    observedPlateMm: { w: 352, h: 264 }, // +10% — a real mismatch at 3% tol, within the 18% VEA-scaled band
    cataloguePlateMm: { w: 320, h: 240 },
  });
  assert.equal(d.match, "true");
});

test("dimensions: plate mark is the primary comparison for intaglio", () => {
  const d = classifyDimensionMatch(f.imp_laterEdition.dimensions);
  assert.equal(d.comparedOn, "plate");
  assert.equal(d.match, "false");
  assert.equal(d.direction, "larger");
});

test("dimensions: plate vs sheet (no like-for-like pair) -> UNASSESSABLE", () => {
  const d = classifyDimensionMatch(f.imp_plateVsSheetNoComparison.dimensions);
  assert.equal(d.match, "UNASSESSABLE");
});

test("impression: technique matches, dims within tol -> none", () => {
  assert.equal(classifyImpression(f.imp_none).divergence, "none");
});

test("impression: technique matches, dims minor over -> variant_sheet", () => {
  assert.equal(classifyImpression(f.imp_variantSheetMinor).divergence, "variant_sheet");
});

test("impression: technique matches, dims materially larger -> later_edition", () => {
  assert.equal(classifyImpression(f.imp_laterEdition).divergence, "later_edition");
});

test("impression: technique differs -> medium_divergence", () => {
  assert.equal(classifyImpression(f.imp_mediumDivergence).divergence, "medium_divergence");
});

test("impression: photomechanical vs expected original -> reproduction", () => {
  assert.equal(classifyImpression(f.imp_reproduction).divergence, "reproduction");
});

test("impression: no scale scan, technique matches -> none (UNASSESSABLE dims don't create divergence)", () => {
  assert.equal(classifyImpression(f.imp_noScaleScanUnassessable).divergence, "none");
});

// ── technique family matching (Decision 9.1 rules table) ─────────────────────

test("techniqueFamily buckets the common processes", () => {
  assert.equal(techniqueFamily("Etching"), "intaglio");
  assert.equal(techniqueFamily("soft-ground etching and engraving"), "intaglio");
  assert.equal(techniqueFamily("Lithograph"), "planographic");
  assert.equal(techniqueFamily("Offset lithograph"), "photomechanical");
  assert.equal(techniqueFamily("Woodcut"), "relief");
  assert.equal(techniqueFamily("Screenprint / Serigraphy"), "screen");
  assert.equal(techniqueFamily("Giclée"), "photomechanical");
  assert.equal(techniqueFamily("laminated giclée print"), "photomechanical");
  assert.equal(techniqueFamily("something odd"), "other");
});

test("classifyTechniqueMatch: same family -> true", () => {
  const r = classifyTechniqueMatch({
    observedTechniques: ["Etching", "Drypoint"],
    observedIsPhotomechanical: false,
    catalogueTechniques: ["Etching", "Aquatint", "Drypoint"],
  });
  assert.equal(r.match, "true");
});

test("classifyTechniqueMatch: no catalogue technique -> unassessable", () => {
  const r = classifyTechniqueMatch({ observedTechniques: ["Etching"], observedIsPhotomechanical: false, catalogueTechniques: [] });
  assert.equal(r.match, "unassessable");
});

test("classifyTechniqueMatch: observed photomechanical vs catalogued etching -> false + catalogueIsOriginalProcess", () => {
  const r = classifyTechniqueMatch({
    observedTechniques: ["Offset lithograph"],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Etching"],
    catalogueMediumRaw: "etching with drypoint",
  });
  assert.equal(r.match, "false");
  assert.equal(r.catalogueIsOriginalProcess, true);
});

test("classifyTechniqueMatch: giclée observed AND giclée catalogued (Hirst Empresses) -> true, no divergence", () => {
  const r = classifyTechniqueMatch({
    observedTechniques: [],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Giclée"],
    catalogueMediumRaw: "laminated giclée print",
  });
  assert.equal(r.match, "true");
  assert.equal(r.catalogueIsOriginalProcess, false);
  const imp = classifyImpression({
    observedTechniques: [],
    observedIsPhotomechanical: true,
    catalogueTechniques: ["Giclée"],
    catalogueMediumRaw: "laminated giclée print",
    dimensions: { observedSource: "none", workIsIntaglio: false },
  });
  assert.equal(imp.divergence, "none");
});

test("classifyDimensionMatch: parses via the real ACKG-style values (appraiser cm vs catalogue mm)", () => {
  const d = classifyDimensionMatch({
    observedSource: "appraiser",
    workIsIntaglio: true,
    observedPlateMm: { w: 410, h: 324 },
    cataloguePlateMm: { w: 412, h: 322 },
  });
  assert.equal(d.match, "true");
});

// ── SCENARIO MAPPING ────────────────────────────────────────────────────────
console.log("\nScenario mapping (Decision 8)\n");

test("artist HIGH (A2) + work HIGH + no divergence -> Scenario 1", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a2_twoAgreeAckgSupport),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch),
    impression: classifyImpression(f.imp_none),
    traditionConfidence: 0.8,
  });
  assert.equal(s.scenario, Scenario.ConfirmedClean);
});

test("single-source MEDIUM candidate (A5) + weak work candidate (T5) -> Scenario 3, NOT Scenario 1", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a5_singleVeaSignature), // A5 candidate/MEDIUM
    work: classifyWorkPass(f.t5_singleTitleSource), // T5 candidate/LOW-MEDIUM
    impression: null,
    traditionConfidence: 0.7,
  });
  assert.equal(s.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("attributed HIGH but only A3 (not A1/A2) + work identified HIGH -> Scenario 3, not clean-fast-pathed", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a3_recognisedNoOeuvre),
    work: classifyWorkPass(f.t1_allTitlesAgree),
    impression: null,
    traditionConfidence: 0.7,
  });
  assert.equal(s.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("medium_divergence -> Scenario 2 (elevated authentication risk), checked before a clean match", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a2_twoAgreeAckgSupport),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch),
    impression: classifyImpression(f.imp_mediumDivergence),
    traditionConfidence: 0.8,
  });
  assert.equal(s.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("artist conflict -> Scenario 5", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a10_conflict),
    work: null,
    impression: null,
    traditionConfidence: 0.6,
  });
  assert.equal(s.scenario, Scenario.CompetingCandidates);
});

test("A3 recognisedArtist_noMatchingOeuvre -> Scenario 3", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a3_recognisedNoOeuvre),
    work: classifyWorkPass(f.t7_noTitleEvidence),
    impression: null,
    traditionConfidence: 0.5,
  });
  assert.equal(s.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("not attributed + confident tradition -> Scenario 4", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a11_nothing),
    work: null,
    impression: null,
    traditionConfidence: 0.6,
  });
  assert.equal(s.scenario, Scenario.MovementOnly);
});

test("not attributed + weak tradition -> Scenario 6", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a11_nothing),
    work: null,
    impression: null,
    traditionConfidence: 0.1,
  });
  assert.equal(s.scenario, Scenario.LowSignalEverywhere);
});

test("riskFlags.forgeryRisk carries forward -> Scenario 2, even with an otherwise-clean A1/HIGH match", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a1_threeAgree),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch),
    impression: classifyImpression(f.imp_none),
    traditionConfidence: 0.8,
    riskFlags: { forgeryRisk: true, misattributionRisk: false },
  });
  assert.equal(s.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("riskFlags absent -> risk path is skipped (no crash on undefined)", () => {
  const s = mapTwoPassToScenario({
    artist: classifyArtistPass(f.a1_threeAgree),
    work: classifyWorkPass(f.t2_twoAgreeKworkFullMatch),
    impression: classifyImpression(f.imp_none),
    traditionConfidence: 0.8,
  });
  assert.equal(s.scenario, Scenario.ConfirmedClean);
});

// ── END-TO-END ──────────────────────────────────────────────────────────────
console.log("\nclassifyTwoPass — end to end\n");

test("e2e: confirmed, clean -> Scenario 1, both passes ran", () => {
  const r = classifyTwoPass(f.e2e_confirmedClean);
  assert.equal(r.pass2Ran, true);
  assert.equal(r.artistAttribution.confidence, "HIGH");
  assert.equal(r.workIdentification?.confidence, "HIGH");
  assert.equal(r.scenario, Scenario.ConfirmedClean);
});

test("e2e: reproduction routes to Scenario 2", () => {
  const r = classifyTwoPass(f.e2e_reproductionRoutesToScenario2);
  assert.equal(r.impressionAssessment?.divergence, "reproduction");
  assert.equal(r.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("e2e: artist conflict routes to Scenario 5", () => {
  const r = classifyTwoPass(f.e2e_artistConflictRoutesToScenario5);
  assert.equal(r.artistAttribution.verdict, "conflict");
  assert.equal(r.scenario, Scenario.CompetingCandidates);
});

test("e2e: weak artist + no in-image title -> Pass 2 blocked, work stays null", () => {
  const r = classifyTwoPass(f.e2e_gateBlocksPass2);
  assert.equal(r.pass2Ran, false);
  assert.equal(r.workIdentification, null);
});

test("e2e: back-propagation — in-image title identifies the artist, Pass 1 re-run lifts the verdict", () => {
  const r = classifyTwoPass(f.backProp_workIdentifiesArtist);
  assert.equal(r.pass2Mode, "in_image_title");
  assert.equal(r.workIdentification?.verdict, "identified");
  assert.ok(
    r.artistAttribution.flags.includes("backPropagatedFromWork"),
    `expected back-prop to lift the artist verdict, got ${r.artistAttribution.evidenceBasis}/${r.artistAttribution.verdict}`,
  );
  assert.equal(r.artistAttribution.artistName, "Katsushika Hokusai");
});

test("e2e: movement only -> Scenario 4", () => {
  assert.equal(classifyTwoPass(f.e2e_movementOnly).scenario, Scenario.MovementOnly);
});

test("e2e: low signal -> Scenario 6", () => {
  assert.equal(classifyTwoPass(f.e2e_lowSignal).scenario, Scenario.LowSignalEverywhere);
});

test("VEA halt short-circuits both passes -> not_attributed, Scenario 6, even with a clean-looking match", () => {
  const r = classifyTwoPass({ ...f.e2e_confirmedClean, veaHaltRecommended: true });
  assert.equal(r.artistAttribution.verdict, "not_attributed");
  assert.equal(r.artistAttribution.evidenceBasis, "VEA-halt");
  assert.equal(r.pass2Ran, false);
  assert.equal(r.workIdentification, null);
  assert.equal(r.scenario, Scenario.LowSignalEverywhere);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
