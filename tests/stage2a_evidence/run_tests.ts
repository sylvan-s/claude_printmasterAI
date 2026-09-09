/**
 * Unit tests for src/appraisal/stage2a_evidence.ts — the Attribution Evidence Agent glue
 * (ADR-0010 Decisions 7, 8, 9.2). No LLM, no network. Plain node:assert via tsx.
 *
 * Run: npm run test:stage2a-evidence
 */
import assert from "node:assert/strict";
import {
  evidenceToTwoPassInput,
  assembleTriageResult,
  runEvidenceTree,
  emptyEvidenceOutput,
} from "../../src/appraisal/stage2a_evidence";
import { Scenario } from "../../src/appraisal/routing";
import {
  postAnthropicMessages,
  trimVeaProse,
  AnthropicContentFilterError,
} from "../../src/appraisal/appraiser";
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
async function atest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
  }
}

// ── evidenceToTwoPassInput ───────────────────────────────────────────────────

test("R that names the dominant candidate inherits its ULAN identity key", () => {
  const inp = evidenceToTwoPassInput(f.confirmedClean, false);
  assert.equal(inp.artistEvidence.vea.kind, "names");
  assert.equal((inp.artistEvidence.vea as any).identityKey, "http://vocab.getty.edu/ulan/500009666");
  assert.equal((inp.artistEvidence.reverseImageSearch as any).identityKey, "http://vocab.getty.edu/ulan/500009666");
});

test("Stage 1b consistency flag passes through; inconsistent hit is not marked consistent", () => {
  assert.equal(evidenceToTwoPassInput(f.confirmedClean, false).artistEvidence.stage1bConsistentWithVea, true);
  assert.equal(evidenceToTwoPassInput(f.stage1bInconsistent, false).artistEvidence.stage1bConsistentWithVea, false);
});

test("appraiser trust maps documented_fact vs hypothesis", () => {
  assert.equal((evidenceToTwoPassInput(f.confirmedClean, false).artistEvidence.appraiser as any).trust, "documented_fact");
  const hyp = f.evOut({
    artistEvidence: { appraiserNamesArtist: true, appraiserArtistName: "X", appraiserTrust: "hypothesis" },
  });
  assert.equal((evidenceToTwoPassInput(hyp, false).artistEvidence.appraiser as any).trust, "hypothesis");
});

test("kWork is null when query_ackg_work was not called", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false);
  assert.equal(inp.workEvidence.kWork, null);
});

test("kWork carries the embedding titleSim + matched title when query_ackg_work was called", () => {
  const inp = evidenceToTwoPassInput(f.confirmedClean, false);
  assert.ok(inp.workEvidence.kWork);
  assert.equal(inp.workEvidence.kWork!.titleSim, 0.95);
  assert.equal(inp.workEvidence.kWork!.matchedWorkTitle, "Le Taureau (Bloch 330)");
  assert.equal(inp.workEvidence.kWork!.backPropArtist, "Pablo Picasso");
});

test("impressionEvidence is null when the agent marked it not assessable", () => {
  assert.equal(evidenceToTwoPassInput(f.recognisedNoOeuvre, false).impressionEvidence, null);
  assert.ok(evidenceToTwoPassInput(f.confirmedClean, false).impressionEvidence);
});

test("-1 numeric sentinels become null / 0 as appropriate", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false);
  assert.equal(inp.artistEvidence.veaSignatureConfidence, 0.7);
  const noSig = f.evOut({ artistEvidence: { veaSignatureConfidence: -1 } });
  assert.equal(evidenceToTwoPassInput(noSig, false).artistEvidence.veaSignatureConfidence, null);
});

// ── D — Stage 1d embedding match, 2026-09-06 amendment to ADR-0013 ──────────
// (built directly from the optional stage1d arg, not from the LLM's evidence cells)

const stage1d = (
  matchConfidence: "HIGH" | "MEDIUM" | "LOW" | null,
  bestMatchArtist = "Henry Moore",
  bestMatchConceptualWorkTitle: string | null = null,
) => ({
  schemaVersion: "IES-1.0" as const,
  embeddingModelsUsed: { dinov2: "dinov2-large" as const, clip: "clip-vit-b32" as const },
  indexCoverageNote: "",
  candidateMatches: [],
  bestMatchArtist,
  bestMatchConceptualWorkTitle,
  matchConfidence,
  // Production always supplies these; the cell builder derives its measured confidence
  // from them, and both D floors are read off that measurement.
  dinov2SimilarityScore: matchConfidence === "HIGH" ? 0.974 : matchConfidence === "MEDIUM" ? 0.86 : 0.6,
  clipSimilarityScore: matchConfidence === "HIGH" ? 0.974 : matchConfidence === "MEDIUM" ? 0.86 : 0.6,
  attributionCaveat: "",
  hypothesisWarning: "",
});

test("no stage1d arg -> embeddingMatch is no_match (D never votes)", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false);
  assert.equal(inp.artistEvidence.embeddingMatch.kind, "no_match");
});

test("stage1d with no bestMatchArtist -> embeddingMatch is no_match", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false, stage1d("HIGH", ""));
  assert.equal(inp.artistEvidence.embeddingMatch.kind, "no_match");
});

test("stage1d HIGH confidence -> embeddingMatch carries the name + matchConfidence", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false, stage1d("HIGH"));
  assert.equal(inp.artistEvidence.embeddingMatch.kind, "names");
  assert.equal((inp.artistEvidence.embeddingMatch as any).raw, "Henry Moore");
  assert.equal((inp.artistEvidence.embeddingMatch as any).matchConfidence, "HIGH");
});

// ── A_t comes from Stage 1c, never from the agent's inference ───────────────────

/** A minimal AppraiserInputResult carrying just the title claim under test. */
const stage1c = (title: string | null) => ({
  schemaVersion: "AIA-1.0" as const,
  inputReceived: { inscribedMarksNotes: true, provenanceNotes: false, conditionNotes: false, catalogueNotes: true },
  claimedAttribution: { artist: null, title, period: null, technique: null, status: (title ? "hypothesis" : "absent") as any, sourceField: null, sourceExcerpt: null },
  inscriptionClaims: { signatureClaim: null, editionClaim: null, editionSizeClaim: null, monogramOrStampClaim: null, status: "absent" as any },
  provenanceChain: [], conditionClaims: [], catalogueReferences: [], literatureOrExhibitionClaims: [],
  dimensionsClaim: null, paperOrSupport: null,
  rawNotes: { inscribedMarksNotes: null, provenanceNotes: null, conditionNotes: null, catalogueNotes: null },
  overallExtractionConfidence: 0.8, lowConfidenceFlags: [],
});

test("REGRESSION A0793/148: Stage 1c claims no title -> A_t is silent even when the agent inferred one", () => {
  // The agent read the edition inscription "Grimm edition B 35/100" as a title.
  const ev = f.evOut({ workEvidence: { ...f.evOut({}).workEvidence, appraiserTitle: "Grimm edition B 35/100" } });
  const inp = evidenceToTwoPassInput(ev as any, false, null, stage1c(null) as any);
  assert.equal(inp.workEvidence.titleAppraiser.kind, "silent");
});

test("Stage 1c's title is used verbatim, not the agent's differing version", () => {
  const ev = f.evOut({ workEvidence: { ...f.evOut({}).workEvidence, appraiserTitle: "Grimm edition B 35/100" } });
  const inp = evidenceToTwoPassInput(ev as any, false, null, stage1c("Cold water about to hit the Prince") as any);
  assert.equal(inp.workEvidence.titleAppraiser.kind, "names");
  assert.equal((inp.workEvidence.titleAppraiser as any).raw, "Cold water about to hit the Prince");
});

test("with Stage 1c silent and Stage 1d HIGH, the work pass resolves on D_t instead of conflicting", () => {
  const ev = f.evOut({ workEvidence: { ...f.evOut({}).workEvidence, appraiserTitle: "Grimm edition B 35/100" } });
  const inp = evidenceToTwoPassInput(
    ev as any, false,
    stage1d("HIGH", "David Hockney", "Cold Water about to Hit the Prince"),
    stage1c(null) as any,
  );
  const { twoPass } = runEvidenceTree(ev as any, false, stage1d("HIGH", "David Hockney", "Cold Water about to Hit the Prince"), stage1c(null) as any);
  assert.equal(inp.workEvidence.titleAppraiser.kind, "silent");
  assert.equal(twoPass.workIdentification?.conceptualWorkTitle, "Cold Water about to Hit the Prince");
  assert.notEqual(twoPass.workIdentification?.verdict, "conflict");
});

test("no Stage 1c result supplied at all -> falls back to the agent cell (fixture path)", () => {
  const ev = f.evOut({ workEvidence: { ...f.evOut({}).workEvidence, appraiserTitle: "Le Taureau" } });
  const inp = evidenceToTwoPassInput(ev as any, false);
  assert.equal((inp.workEvidence.titleAppraiser as any).raw, "Le Taureau");
});

test("no stage1d work title -> titleEmbeddingMatch is silent (D_t never votes)", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false, stage1d("HIGH"));
  assert.equal(inp.workEvidence.titleEmbeddingMatch.kind, "silent");
});

test("stage1d work title -> titleEmbeddingMatch carries the title + matchConfidence", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false, stage1d("HIGH", "David Hockney", "Cold Water about to Hit the Prince"));
  assert.equal(inp.workEvidence.titleEmbeddingMatch.kind, "names");
  assert.equal((inp.workEvidence.titleEmbeddingMatch as any).raw, "Cold Water about to Hit the Prince");
  assert.equal((inp.workEvidence.titleEmbeddingMatch as any).matchConfidence, "HIGH");
});

test("a MEDIUM stage1d work title is carried but gated out of the vote by the classifier", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false, stage1d("MEDIUM", "David Hockney", "Cold Water about to Hit the Prince"));
  assert.equal((inp.workEvidence.titleEmbeddingMatch as any).matchConfidence, "MEDIUM");
});

test("end-to-end: a lone HIGH-confidence Stage 1d match (no other evidence) -> A6D candidate, Scenario 3", () => {
  const { twoPass } = runEvidenceTree(f.evOut({}), false, stage1d("HIGH", "Barbara Hepworth"));
  assert.equal(twoPass.artistAttribution.evidenceBasis, "A6D");
  assert.equal(twoPass.artistAttribution.verdict, "candidate");
  assert.equal(twoPass.artistAttribution.artistName, "Barbara Hepworth");
  assert.equal(twoPass.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("end-to-end: a lone MEDIUM-confidence Stage 1d match now votes, weakly", () => {
  const { twoPass } = runEvidenceTree(
    f.evOut({ traditionIdentification: { traditionConfidence: 0.2 } }),
    false,
    stage1d("MEDIUM", "Barbara Hepworth"),
  );
  assert.equal(twoPass.artistAttribution.verdict, "candidate");
  assert.equal(twoPass.artistAttribution.evidenceBasis, "A6D");
  assert.equal(twoPass.artistAttribution.artistName, "Barbara Hepworth");
  // measured 0.86 clears both the 0.7 vote floor and the 0.8 confidence floor
  assert.equal(twoPass.artistAttribution.confidence, "MEDIUM");
});

// ── end-to-end: runEvidenceTree ──────────────────────────────────────────────

test("confirmed-clean evidence → artist attributed HIGH, work identified, Scenario 1", () => {
  const { triage, twoPass } = runEvidenceTree(f.confirmedClean, false);
  assert.equal(twoPass.artistAttribution.verdict, "attributed");
  assert.equal(twoPass.artistAttribution.confidence, "HIGH");
  assert.equal(twoPass.workIdentification?.verdict, "identified");
  assert.equal(triage.routingDecision.scenario, Scenario.ConfirmedClean);
  assert.equal(triage.artistAttribution?.artistName, "Pablo Picasso");
  assert.equal(triage.candidateArtists[0].artistName, "Pablo Picasso");
  assert.ok(triage.candidateArtists[0].candidateProbability >= 0.85);
});

test("recognised artist the ACKG corroborates on nothing → A4 + Scenario 3", () => {
  // Was A3 on kId alone. kId no longer scores — only 27% of ACKG artists carry a ULAN or
  // Wikidata record, so a missing one is a coverage gap, not a finding. With zero oeuvre and
  // an unassessable subject this is now "uncorroborated" (A4), one band below a corroborated
  // pair, with the verdict and the named artist untouched.
  const { triage, twoPass } = runEvidenceTree(f.recognisedNoOeuvre, false);
  assert.equal(twoPass.artistAttribution.evidenceBasis, "A4");
  assert.equal(twoPass.artistAttribution.verdict, "attributed");
  assert.ok(twoPass.artistAttribution.flags.includes("corroboration:none:ackgSilent"), twoPass.artistAttribution.flags.join(","));
  assert.equal(triage.routingDecision.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

test("documented_fact appraiser claim vs legible VEA signature → conflict + Scenario 5", () => {
  const { triage, twoPass } = runEvidenceTree(f.attributionConflict, false);
  assert.equal(twoPass.artistAttribution.verdict, "conflict");
  assert.equal(triage.routingDecision.scenario, Scenario.CompetingCandidates);
  assert.ok(triage.candidateArtists.some((c) => c.artistName === "Marc Chagall"));
});

test("photomechanical technique where an original is expected → reproduction → Scenario 2", () => {
  const { triage, twoPass } = runEvidenceTree(f.reproductionDivergence, false);
  assert.equal(twoPass.impressionAssessment?.divergence, "reproduction");
  assert.equal(triage.impressionAssessment?.divergence, "reproduction");
  assert.equal(triage.routingDecision.scenario, Scenario.ElevatedAuthenticationRisk);
});

test("giclée observed AND giclée catalogued (Hirst Empresses) → NOT a reproduction, not Scenario 2", () => {
  const { triage, twoPass } = runEvidenceTree(f.giclEditionNotReproduction, false);
  assert.equal(twoPass.impressionAssessment?.divergence, "none");
  assert.notEqual(triage.routingDecision.scenario, Scenario.ElevatedAuthenticationRisk);
  assert.equal(twoPass.artistAttribution.artistName, "Damien Hirst");
});

test("an ACKG work-level match no longer promotes a lot no source named", () => {
  // Was A8K candidate. The anchor is still built and still carries its identity key — it is
  // read as corroboration now, not as a witness, so with no naming source it names nobody.
  const inp = evidenceToTwoPassInput(f.ackgWorkAnchorPromotes, false);
  assert.equal(inp.artistEvidence.ackgWorkAnchor?.artist, "Rembrandt van Rijn");
  assert.equal(inp.artistEvidence.ackgWorkAnchor?.identityKey, "http://vocab.getty.edu/ulan/500011051");
  const { twoPass } = runEvidenceTree(f.ackgWorkAnchorPromotes, false);
  assert.equal(twoPass.artistAttribution.verdict, "not_attributed");
  assert.equal(twoPass.artistAttribution.evidenceBasis, "A11");
  assert.equal(twoPass.artistAttribution.artistName, null);
});

test("inconsistent Stage 1b hit does not become a vote → not attributed", () => {
  const { twoPass } = runEvidenceTree(f.stage1bInconsistent, false);
  assert.equal(twoPass.artistAttribution.verdict, "not_attributed");
  assert.ok(!twoPass.artistAttribution.agreementSet.includes("R"));
});

test("VEA halt → empty evidence, not attributed, escalate, no pass 2", () => {
  const { triage, twoPass } = runEvidenceTree(emptyEvidenceOutput(0.2), true);
  assert.equal(twoPass.artistAttribution.verdict, "not_attributed");
  assert.equal(twoPass.pass2Ran, false);
  assert.equal(triage.routingDecision.scenario, Scenario.LowSignalEverywhere);
  assert.equal(triage.routingDecision.humanEscalationRequired, true);
  assert.equal(triage.candidateArtists.length, 0);
});

// ── assembleTriageResult shape guarantees ────────────────────────────────────

test("assembled TriageResult keeps a valid routingDecision for Stage 2b", () => {
  const { triage } = runEvidenceTree(f.confirmedClean, false);
  const rd = triage.routingDecision;
  assert.ok(rd.specialistConfig && typeof rd.specialistConfig === "string");
  assert.ok(rd.scenarioName.length > 0);
  assert.equal(triage.schemaVersion, "ATA-2.0-evidence");
});

test("evidenceCorroboration reflects agreement set and ACKG", () => {
  const { triage } = runEvidenceTree(f.confirmedClean, false);
  assert.equal(triage.evidenceCorroboration?.stage1bAgreement, true);
  assert.equal(triage.evidenceCorroboration?.ackgAgreement, true);
});

test("assembler does not mutate the input evidence object", () => {
  const ev = f.confirmedClean;
  const snap = JSON.stringify(ev);
  const tp = runEvidenceTree(ev, false).twoPass;
  assembleTriageResult(ev, tp);
  assert.equal(JSON.stringify(ev), snap);
});

// ── content-filter degradation ───────────────────────────────────────────────

test("emptyEvidenceOutput override → not_attributed, escalate, Scenario 6 (no crash)", () => {
  const degraded = emptyEvidenceOutput(0.5, { reason: "blocked twice", narrative: "manual triage" });
  const { triage, twoPass } = runEvidenceTree(degraded, false);
  assert.equal(twoPass.artistAttribution.verdict, "not_attributed");
  assert.equal(triage.routingDecision.scenario, Scenario.LowSignalEverywhere);
  assert.equal(triage.routingDecision.humanEscalationRequired, true);
  assert.equal(triage.routingDecision.humanEscalationReason, "blocked twice");
  assert.equal(triage.candidateArtists.length, 0);
});

test("trimVeaProse keeps structured fields, shortens long prose, deep-clones", () => {
  const vea = {
    printingTechniques: [{ technique: "Lithograph", confidence: 0.5 }],
    signatures: [{ transcription: "Picasso", signatureConfidence: 0.9 }],
    composition: { textWithinImage: "Le Taureau", description: "x".repeat(400) },
    plateMark: { observationNotes: "y".repeat(200), present: true },
  };
  const snap = JSON.stringify(vea);
  const t = trimVeaProse(vea);
  assert.equal(JSON.stringify(vea), snap, "input not mutated");
  assert.equal(t.printingTechniques[0].technique, "Lithograph");
  assert.equal(t.signatures[0].transcription, "Picasso");
  assert.equal(t.composition.textWithinImage, "Le Taureau");
  assert.ok(t.composition.description.length < 200 && t.composition.description.endsWith("… [trimmed]"));
  assert.ok(t.plateMark.observationNotes.length <= 100 && t.plateMark.observationNotes.endsWith("… [trimmed]"));
  assert.equal(t.plateMark.present, true);
});

// ── postAnthropicMessages retry / content-filter typing ───────────────────────
// Stub global fetch; assert the helper's control flow without a real network call.

const realFetch = globalThis.fetch;
function stubFetch(responders: Array<() => Response | Promise<Response>>) {
  let i = 0;
  globalThis.fetch = (async () => {
    const r = responders[Math.min(i, responders.length - 1)];
    i++;
    return r();
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
    return i;
  };
}
const jsonResponse = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

await atest("retries a 529 then succeeds", async () => {
  const restore = stubFetch([
    () => new Response("overloaded", { status: 529 }),
    () => jsonResponse({ ok: true, content: [] }),
  ]);
  const data = await postAnthropicMessages("k", { model: "m" }, { label: "test", maxAttempts: 3 });
  const calls = restore();
  assert.equal(calls, 2);
  assert.deepEqual(data, { ok: true, content: [] });
});

await atest("retries a thrown network error ('fetch failed') then succeeds", async () => {
  const restore = stubFetch([
    () => { throw new TypeError("fetch failed"); },
    () => jsonResponse({ recovered: true }),
  ]);
  const data = await postAnthropicMessages("k", { model: "m" }, { label: "test", maxAttempts: 3 });
  restore();
  assert.equal(data.recovered, true);
});

await atest("a content-filter 400 throws AnthropicContentFilterError (not retried)", async () => {
  const restore = stubFetch([
    () => new Response("Output blocked by content filtering policy", { status: 400 }),
    () => jsonResponse({ shouldNotReach: true }),
  ]);
  await assert.rejects(
    postAnthropicMessages("k", { model: "m" }, { label: "test", maxAttempts: 3 }),
    (e: any) => e instanceof AnthropicContentFilterError,
  );
  assert.equal(restore(), 1, "not retried");
});

await atest("a plain 400 throws a generic error, not the content-filter type", async () => {
  const restore = stubFetch([() => new Response("bad request: missing field", { status: 400 })]);
  await assert.rejects(
    postAnthropicMessages("k", { model: "m" }, { label: "test", maxAttempts: 2 }),
    (e: any) => !(e instanceof AnthropicContentFilterError) && /400/.test(e.message),
  );
  restore();
});

// ── summary ──────────────────────────────────────────────────────────────────
// ── evidence capture for test runs (tests/backtest/evidence_capture.ts) ─────────

test("buildEvidenceRecord replays the tree and records what code overrode", async () => {
  const { buildEvidenceRecord } = await import("../backtest/evidence_capture");

  // The A0793/148 shape: the agent invented a title from an inscription, Stage 1c claimed
  // none, and Stage 1d matched the work at HIGH.
  const ev = f.evOut({ workEvidence: { ...f.evOut({}).workEvidence, appraiserTitle: "Grimm edition B 35/100" } });
  const rec = buildEvidenceRecord(
    ev as any,
    stage1d("HIGH", "David Hockney", "Cold Water about to Hit the Prince") as any,
    stage1c(null) as any,
  );

  // the agent's own cells are preserved verbatim
  assert.equal((rec.agentCells as any).workEvidence.appraiserTitle, "Grimm edition B 35/100");
  // ...and the tree is shown reading something different
  assert.equal(rec.treeInput!.workEvidence.titleAppraiser.kind, "silent");
  assert.equal((rec.treeInput!.workEvidence.titleEmbeddingMatch as any).raw, "Cold Water about to Hit the Prince");
  // the override is named, not left to be inferred
  assert.equal(rec.overriddenByCode.titleAppraiser.agentSaid, "Grimm edition B 35/100");
  assert.equal(rec.overriddenByCode.titleAppraiser.codeUsed, null);
  assert.ok(rec.overriddenByCode.embeddingSources, "D/D_t provenance should be recorded");
  // the replayed verdict carries the full trace, including the pass-2 vote line
  assert.equal(rec.treeResult!.workIdentification?.conceptualWorkTitle, "Cold Water about to Hit the Prince");
  assert.ok(rec.treeResult!.ruleTrace.some((t) => t.includes("pass2:")), rec.treeResult!.ruleTrace.join(" | "));
});

test("buildEvidenceRecord with no agent output degrades instead of throwing", async () => {
  const { buildEvidenceRecord } = await import("../backtest/evidence_capture");
  const rec = buildEvidenceRecord(null);
  assert.equal(rec.agentCells, null);
  assert.equal(rec.treeResult, null);
  assert.deepEqual(rec.overriddenByCode, {});
});

// ── ACKG loop hook: same log output, now recordable ────────────────────────────

function captureLog(fn: () => void): string[] {
  const out: string[] = [];
  const real = console.log;
  console.log = (...a: any[]) => { out.push(a.join(" ")); };
  try { fn(); } finally { console.log = real; }
  return out;
}

test("onAckgLoopEvent's default output is byte-identical to the strings the loop used to print", async () => {
  const { FourStageAppraiser, appraiserConfigs } = await import("../../src/appraisal/appraiser");
  const a = new FourStageAppraiser(appraiserConfigs.find((c) => c.id === "claude-4stage")!) as any;

  const lines = captureLog(() => {
    a.onAckgLoopEvent({ round: 3, kind: "stop", roundsUsed: 2 });
    a.onAckgLoopEvent({ round: 1, kind: "reasoning", reasoning: "short reasoning" });
    a.onAckgLoopEvent({ round: 1, kind: "call", toolName: "query_ackg", input: { technique: "Etching" } });
    a.onAckgLoopEvent({ round: 2, kind: "result", toolName: "query_ackg", count: 10, summary: "10 candidate(s) — top: David Hockney (support=144)" });
    a.onAckgLoopEvent({ round: 2, kind: "result", toolName: "query_ackg", error: "boom" });
    a.onAckgLoopEvent({ round: 5, kind: "max_rounds", maxRounds: 5 });
  });

  assert.deepEqual(lines, [
    "[Stage 2a ACKG loop] round 3: no graph query — stopping loop (2 round(s) used)",
    "[Stage 2a ACKG loop] round 1 reasoning: short reasoning",
    '[Stage 2a ACKG loop] round 1 query_ackg call: {"technique":"Etching"}',
    "[Stage 2a ACKG loop] round 2 result: 10 candidate(s) — top: David Hockney (support=144)",
    "[Stage 2a ACKG loop] round 2 result: ERROR — boom",
    "[Stage 2a ACKG loop] hit MAX_ROUNDS=5 — finalizing with whatever evidence was gathered",
  ]);
});

test("long reasoning is truncated in the log but kept whole in the event", async () => {
  const { FourStageAppraiser, appraiserConfigs } = await import("../../src/appraisal/appraiser");
  const a = new FourStageAppraiser(appraiserConfigs.find((c) => c.id === "claude-4stage")!) as any;
  const long = "x".repeat(500);
  const [line] = captureLog(() => a.onAckgLoopEvent({ round: 1, kind: "reasoning", reasoning: long }));
  assert.ok(line.endsWith("…"), "log should be truncated");
  assert.equal(line.length, "[Stage 2a ACKG loop] round 1 reasoning: ".length + 401);
});

test("a recording subclass captures rounds AND still logs", async () => {
  const { appraiserWithEvidenceCapture } = await import("../backtest/evidence_capture");
  const { appraiserConfigs } = await import("../../src/appraisal/appraiser");
  const { appraiser, getAckgRounds } = appraiserWithEvidenceCapture(
    appraiserConfigs.find((c) => c.id === "claude-4stage")!,
  );
  const lines = captureLog(() => {
    (appraiser as any).onAckgLoopEvent({ round: 1, kind: "call", toolName: "query_ackg_work", input: { artist: "Hockney" } });
  });
  assert.equal(lines.length, 1, "the live log must not be swallowed by the recorder");
  assert.deepEqual(getAckgRounds().map((r) => [r.round, r.kind, r.toolName]), [[1, "call", "query_ackg_work"]]);
});

test("a non-4-stage config still runs, capturing nothing", async () => {
  const { appraiserWithEvidenceCapture } = await import("../backtest/evidence_capture");
  const { appraiserConfigs } = await import("../../src/appraisal/appraiser");
  const three = appraiserConfigs.find((c) => !c.stage2aModel)!;
  const { getAgentCells, getAckgRounds } = appraiserWithEvidenceCapture(three);
  assert.equal(getAgentCells(), null);
  assert.deepEqual(getAckgRounds(), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
