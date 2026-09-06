/**
 * Pass/fail unit tests for src/appraisal/routing.ts — ADR-0006.
 *
 * No LLM calls, no network, no jest/vitest dependency (none exists in this repo yet — see
 * ADR-0006's plan notes). Plain node:assert, run via tsx like the existing
 * test:vea/test:backtest scripts.
 *
 * Run: npm run test:routing
 */
import assert from "node:assert/strict";
import {
  classifyTriageOutcome,
  applyDeterministicRouting,
  matchSpecialistConfig,
  countCompetitive,
  hasWorkLevelMatch,
  assertSpecialistConfigRegistryIsValid,
  Scenario,
  SCENARIO_NAMES,
  CONFIDENT_THRESHOLD,
} from "../../src/appraisal/routing";
import * as fixtures from "./fixtures";

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

console.log("Scenario classification\n");

test("Scenario 1: confirmed, clean", () => {
  const plan = classifyTriageOutcome(fixtures.scenario1ConfirmedClean);
  assert.equal(plan.scenario, Scenario.ConfirmedClean);
  assert.equal(plan.skepticModeEngaged, false);
});

test("Scenario 2: elevated authentication risk", () => {
  const plan = classifyTriageOutcome(fixtures.scenario2ElevatedAuthenticationRisk);
  assert.equal(plan.scenario, Scenario.ElevatedAuthenticationRisk);
  assert.equal(plan.skepticModeEngaged, true);
});

test("CRITICAL ORDERING: risk flag masks an otherwise-Scenario-1-looking match", () => {
  const plan = classifyTriageOutcome(fixtures.riskMasksConfidentMatch);
  assert.equal(
    plan.scenario,
    Scenario.ElevatedAuthenticationRisk,
    `expected risk to be checked before the confident-match rule, got Scenario ${plan.scenario} (${plan.scenarioName})`
  );
});

test("Scenario 3: artist confirmed, work unresolved (zero ACKG support of any kind)", () => {
  const plan = classifyTriageOutcome(fixtures.scenario3ArtistConfirmedWorkUnresolved);
  assert.equal(plan.scenario, Scenario.ArtistConfirmedWorkUnresolved);
  assert.equal(plan.skepticModeEngaged, false);
});

test("REGRESSION: authenticationBodyExists alone (no forgeryRisk/misattributionRisk) does NOT trigger Scenario 2", () => {
  const plan = classifyTriageOutcome(fixtures.authBodyExistsAloneDoesNotTriggerScenario2);
  assert.notEqual(
    plan.scenario,
    Scenario.ElevatedAuthenticationRisk,
    `authenticationBodyExists is a fact flag, not a risk trigger, as of 2026-08-26 — got Scenario ${plan.scenario} (${plan.scenarioName})`
  );
  assert.equal(plan.scenario, Scenario.ConfirmedClean);
});

test("Scenario 4: movement only", () => {
  const plan = classifyTriageOutcome(fixtures.scenario4MovementOnly);
  assert.equal(plan.scenario, Scenario.MovementOnly);
});

test("Scenario 5: competing candidates (two comparable probabilities)", () => {
  const plan = classifyTriageOutcome(fixtures.scenario5CompetingCandidates);
  assert.equal(plan.scenario, Scenario.CompetingCandidates);
  assert.equal(plan.skepticModeEngaged, true);
});

test("Scenario 5: competing candidates (evidenceCorroboration.conflicts trigger)", () => {
  const plan = classifyTriageOutcome(fixtures.scenario5EvidenceConflict);
  assert.equal(plan.scenario, Scenario.CompetingCandidates);
  assert.equal(plan.skepticModeEngaged, true);
});

test("Scenario 6: low signal everywhere", () => {
  const plan = classifyTriageOutcome(fixtures.scenario6LowSignalEverywhere);
  assert.equal(plan.scenario, Scenario.LowSignalEverywhere);
  assert.equal(plan.skepticModeEngaged, false);
});

console.log("\nEdge cases\n");

test("Empty candidateArtists array does not throw, resolves to a low-signal scenario", () => {
  const plan = classifyTriageOutcome(fixtures.edgeEmptyCandidates);
  assert.equal(plan.scenario, Scenario.LowSignalEverywhere);
});

test("Missing evidenceCorroboration entirely does not throw", () => {
  assert.doesNotThrow(() => classifyTriageOutcome(fixtures.edgeMissingEvidenceCorroboration));
});

test(`Threshold boundary: 0.64 (just below CONFIDENT_THRESHOLD=${CONFIDENT_THRESHOLD}) is NOT confident`, () => {
  const plan = classifyTriageOutcome(fixtures.edgeJustBelowConfidentThreshold);
  assert.notEqual(plan.scenario, Scenario.ArtistConfirmedWorkUnresolved);
  assert.notEqual(plan.scenario, Scenario.ConfirmedClean);
});

test(`Threshold boundary: exactly ${CONFIDENT_THRESHOLD} IS confident`, () => {
  const plan = classifyTriageOutcome(fixtures.edgeAtConfidentThreshold);
  assert.equal(plan.scenario, Scenario.ArtistConfirmedWorkUnresolved);
});

console.log("\nSpecialist config matching (ADR-0005 finding #8 regression)\n");

test("Rembrandt candidate matches rembrandt_etchings by artist name", () => {
  const t = fixtures.scenario5EvidenceConflict; // top candidate is "Rembrandt van Rijn"
  const { key, matchedOn } = matchSpecialistConfig(t);
  assert.equal(key, "rembrandt_etchings");
  assert.equal(matchedOn, "artistName");
});

test("Unmatched tradition/artist falls back to general_print_fallback, never invents a name", () => {
  const { key, matchedOn } = matchSpecialistConfig(fixtures.scenario1ConfirmedClean); // Hockney, no keyword match
  assert.equal(key, "general_print_fallback");
  assert.equal(matchedOn, "fallback");
});

test("assertSpecialistConfigRegistryIsValid: every registry key resolves to a real file", () => {
  assert.doesNotThrow(() => assertSpecialistConfigRegistryIsValid());
});

console.log("\nHelper functions\n");

test("countCompetitive counts candidates within COMPETITIVE_MARGIN of the top", () => {
  const n = countCompetitive(fixtures.scenario5CompetingCandidates.candidateArtists);
  assert.equal(n, 2);
});

test("countCompetitive returns 0 for an empty list", () => {
  assert.equal(countCompetitive([]), 0);
});

test("hasWorkLevelMatch requires ackgSupportCount>0 AND any real provenance tag (broadened 2026-08-26)", () => {
  assert.equal(hasWorkLevelMatch({ rank: 1, artistName: "x", candidateProbability: 0.9, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 5, ackgProvenanceTags: ["auction_history"] }), true);
  assert.equal(hasWorkLevelMatch({ rank: 1, artistName: "x", candidateProbability: 0.9, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 0, ackgProvenanceTags: ["institutional"] }), false);
  assert.equal(hasWorkLevelMatch({ rank: 1, artistName: "x", candidateProbability: 0.9, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 5, ackgProvenanceTags: ["institutional"] }), true);
  assert.equal(hasWorkLevelMatch({ rank: 1, artistName: "x", candidateProbability: 0.9, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 5, ackgProvenanceTags: [] }), false);
  assert.equal(hasWorkLevelMatch(undefined), false);
});

console.log("\napplyDeterministicRouting — full splice behaviour\n");

test("applyDeterministicRouting preserves LLM-declared humanEscalationRequired/Reason", () => {
  const raw = { ...fixtures.scenario2ElevatedAuthenticationRisk };
  raw.routingDecision = { ...raw.routingDecision, humanEscalationRequired: true, humanEscalationReason: "Test reason" };
  const routed = applyDeterministicRouting(raw);
  assert.equal(routed.routingDecision.humanEscalationRequired, true);
  assert.equal(routed.routingDecision.humanEscalationReason, "Test reason");
  assert.equal(routed.routingDecision.scenario, Scenario.ElevatedAuthenticationRisk);
  assert.equal(routed.routingDecision.specialistConfig, "general_print_fallback");
});

test("Every Scenario has a name in SCENARIO_NAMES", () => {
  for (const s of [1, 2, 3, 4, 5, 6] as const) {
    assert.ok(SCENARIO_NAMES[s as Scenario], `Scenario ${s} has no name`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
