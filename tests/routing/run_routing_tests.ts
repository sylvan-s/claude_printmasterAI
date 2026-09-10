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
import { injectTaskProfile } from "../../src/appraisal/prompts";
import { isConstrainedAckgQuery, anthropicCompatBaseUrl } from "../../src/appraisal/appraiser";
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

// ── the no-VEA clause on task profiles (2026-09-09) ────────────────────────────

test("every scenario has a task profile, and none mentions the no-VEA clause by default", () => {
  for (const s of Object.values(Scenario).filter((v) => typeof v === "number") as Scenario[]) {
    const out = injectTaskProfile("[TASK_PROFILE]", s);
    assert.ok(out.length > 50, `Scenario ${s} produced no profile`);
    assert.ok(!out.includes("NO PHYSICAL OBSERVATION AVAILABLE"), `Scenario ${s} leaked the clause when VEA ran`);
    assert.ok(!out.includes("[TASK_PROFILE]"), `Scenario ${s} left the placeholder unresolved`);
  }
});

test("veaRan=false appends the clause to EVERY scenario, profile intact", () => {
  for (const s of Object.values(Scenario).filter((v) => typeof v === "number") as Scenario[]) {
    const withVea = injectTaskProfile("[TASK_PROFILE]", s, true);
    const without = injectTaskProfile("[TASK_PROFILE]", s, false);
    assert.ok(without.startsWith(withVea), `Scenario ${s}: the clause must EXTEND the profile, not replace it`);
    assert.ok(without.includes("NO PHYSICAL OBSERVATION AVAILABLE"), `Scenario ${s} missing the clause`);
    // the specific failure it exists to prevent
    assert.ok(without.includes('Do NOT set attributionLevel to "unattributed"'), `Scenario ${s} missing the attribution guard`);
  }
});


// ---- query_ackg constraint gate ----------------------------------------------------
// As of 2026-09-09 this is a GATE, not a round-counter: an unconstrained query_ackg is
// refused with an is_error tool_result and never executed. It previously ran, and returned
// the graph's most prolific artists — a Peter Blake lot was handed "Pablo Picasso
// (support=670), Marc Chagall (428), Joan Miro (417)" off a bare period sweep.

test("a bare period range does not constrain — this is the observed failure", () => {
  assert.equal(isConstrainedAckgQuery({ periodStartYear: 1960, periodEndYear: 1970 }), false);
  assert.equal(isConstrainedAckgQuery({ periodStartYear: 1880, periodEndYear: 2025 }), false);
});

test("an artist name does not constrain — query_ackg has no artist parameter", () => {
  // The model invents this field; it is silently dropped, so it must not satisfy the gate.
  assert.equal(isConstrainedAckgQuery({ artist: "Peter Blake" }), false);
  assert.equal(isConstrainedAckgQuery({ artist: "Peter Blake", periodStartYear: 1960 }), false);
});

test("any one real filter constrains", () => {
  for (const k of ["technique", "region", "subject", "paper", "workTitle"]) {
    assert.equal(isConstrainedAckgQuery({ [k]: "x" }), true, `${k} should constrain`);
  }
});

test("an empty or whitespace filter value does not constrain", () => {
  assert.equal(isConstrainedAckgQuery({ technique: "" }), false);
  assert.equal(isConstrainedAckgQuery({ technique: "   " }), false);
  assert.equal(isConstrainedAckgQuery({ region: "", subject: "" }), false);
});

test("a non-string filter value does not constrain", () => {
  assert.equal(isConstrainedAckgQuery({ technique: 1 as any }), false);
  assert.equal(isConstrainedAckgQuery({ subject: true as any }), false);
  assert.equal(isConstrainedAckgQuery({ workTitle: null as any }), false);
});

test("a missing or non-object input does not constrain", () => {
  assert.equal(isConstrainedAckgQuery(undefined), false);
  assert.equal(isConstrainedAckgQuery(null), false);
  assert.equal(isConstrainedAckgQuery("technique"), false);
  assert.equal(isConstrainedAckgQuery({}), false);
});

test("a real filter still constrains alongside ignored fields", () => {
  assert.equal(
    isConstrainedAckgQuery({ artist: "Peter Blake", technique: "Screenprint", periodStartYear: 1964 }),
    true,
  );
});


// ---- Anthropic-compatible provider routing ------------------------------------------
// Alibaba/QwenCloud expose an Anthropic Messages API at /apps/anthropic, so a bare Qwen ID
// runs through the SAME hardened Stage 2a loop as Claude — only the origin and key differ.

test("bare qwen names route to the DashScope Anthropic endpoint", () => {
  for (const m of ["qwen-plus", "qwen-max", "qwen3.7-plus", "qwen-flash", "QWEN-PLUS"]) {
    assert.match(anthropicCompatBaseUrl(m) ?? "", /\/apps\/anthropic$/, `${m} should route`);
  }
});

test("Claude and Gemini models use the native Anthropic origin", () => {
  for (const m of ["claude-sonnet-4-6", "claude-haiku-4-5", "gemini-2.5-pro"]) {
    assert.equal(anthropicCompatBaseUrl(m), null, `${m} should not route to DashScope`);
  }
});

test("a model merely containing 'qwen' does not route to DashScope", () => {
  // The pattern must anchor at the start, or an unrelated vendor's ID with qwen in the
  // middle would be sent to Alibaba with an Alibaba key.
  assert.equal(anthropicCompatBaseUrl("my-qwen-finetune"), null);
  assert.equal(anthropicCompatBaseUrl("acme/qwen-plus"), null);
});

test("the compat base URL has no trailing /v1 — the caller appends /v1/messages", () => {
  // Alibaba's docs flag this: a base ending in /v1 yields /v1/v1/messages and a 404.
  assert.doesNotMatch(anthropicCompatBaseUrl("qwen-plus")!, /\/v1\/?$/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
