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
import { Scenario, SCENARIO_TO_TIER } from "../../src/appraisal/routing";
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

test("kWork is null when neither technique nor dimension nor titleSim was assessed", () => {
  const inp = evidenceToTwoPassInput(f.recognisedNoOeuvre, false);
  assert.equal(inp.workEvidence.kWork, null);
});

test("kWork is passed through when technique/dimension were assessed", () => {
  const inp = evidenceToTwoPassInput(f.confirmedClean, false);
  assert.ok(inp.workEvidence.kWork);
  assert.equal(inp.workEvidence.kWork!.techniqueMatch, true);
  assert.equal(inp.workEvidence.kWork!.dimensionMatch, "true");
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

// ── end-to-end: runEvidenceTree ──────────────────────────────────────────────

test("confirmed-clean evidence → artist attributed HIGH, work identified, Scenario 1", () => {
  const { triage, twoPass } = runEvidenceTree(f.confirmedClean, false);
  assert.equal(twoPass.artistAttribution.verdict, "attributed");
  assert.equal(twoPass.artistAttribution.confidence, "HIGH");
  assert.equal(twoPass.workIdentification?.verdict, "identified");
  assert.equal(triage.routingDecision.scenario, Scenario.ConfirmedClean);
  assert.equal(triage.routingDecision.tier, 1);
  assert.equal(triage.artistAttribution?.artistName, "Pablo Picasso");
  assert.equal(triage.candidateArtists[0].artistName, "Pablo Picasso");
  assert.ok(triage.candidateArtists[0].candidateProbability >= 0.85);
});

test("recognised artist, zero oeuvre, kId true → A3 + Scenario 3", () => {
  const { triage, twoPass } = runEvidenceTree(f.recognisedNoOeuvre, false);
  assert.equal(twoPass.artistAttribution.evidenceBasis, "A3");
  assert.ok(twoPass.artistAttribution.flags.includes("recognisedArtist_noMatchingOeuvre"));
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
  assert.equal(triage.routingDecision.tier, SCENARIO_TO_TIER[Scenario.ElevatedAuthenticationRisk]);
});

test("ACKG work-level artist+title match promotes an otherwise-unattributed lot → candidate (A8K)", () => {
  const inp = evidenceToTwoPassInput(f.ackgWorkAnchorPromotes, false);
  assert.equal(inp.artistEvidence.ackgWorkAnchor?.artist, "Rembrandt van Rijn");
  assert.equal(inp.artistEvidence.ackgWorkAnchor?.identityKey, "http://vocab.getty.edu/ulan/500011051");
  const { twoPass } = runEvidenceTree(f.ackgWorkAnchorPromotes, false);
  assert.equal(twoPass.artistAttribution.verdict, "candidate");
  assert.equal(twoPass.artistAttribution.evidenceBasis, "A8K");
  assert.equal(twoPass.artistAttribution.artistName, "Rembrandt van Rijn");
  assert.equal(twoPass.pass2Ran, true);
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
  assert.ok([1, 2, 3].includes(rd.tier));
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
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
