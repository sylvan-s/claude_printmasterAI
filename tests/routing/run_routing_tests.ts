/**
 * Pass/fail unit tests for src/appraisal/routing.ts's shared surface — ADR-0006 /
 * ADR-0014. Scenario classification itself now lives in the two-pass tree
 * (src/appraisal/two_pass_attribution.ts, exercised by tests/two_pass/), so this file only
 * covers what's left in routing.ts: specialist-config matching and the Scenario/
 * SCENARIO_NAMES surface both the tree and Stage 2b share.
 *
 * No LLM calls, no network, no jest/vitest dependency (none exists in this repo yet — see
 * ADR-0006's plan notes). Plain node:assert, run via tsx like the existing
 * test:vea/test:backtest scripts.
 *
 * Run: npm run test:routing
 */
import assert from "node:assert/strict";
import {
  matchSpecialistConfig,
  assertSpecialistConfigRegistryIsValid,
  Scenario,
  SCENARIO_NAMES,
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

console.log("Specialist config matching (ADR-0005 finding #8 regression)\n");

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

console.log("\nScenario surface\n");

test("Every Scenario has a name in SCENARIO_NAMES", () => {
  for (const s of [1, 2, 3, 4, 5, 6] as const) {
    assert.ok(SCENARIO_NAMES[s as Scenario], `Scenario ${s} has no name`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
