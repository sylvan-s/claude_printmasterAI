# ADR-0014: Retire classic Stage 2a triage — the Attribution Evidence Agent is now the only Stage 2a

**Date:** 2026-09-06
**Status:** Accepted, implemented.

Removes the pre-ADR-0010 "classic triage" Stage 2a path (one LLM call declares
`candidateProbability` verdicts directly; `classifyTriageOutcome()` in `routing.ts` derives
the scenario from them) entirely, leaving ADR-0010's **Attribution Evidence Agent** +
two-pass tree (`two_pass_attribution.ts`) as the sole Stage 2a implementation. Because the
Evidence Agent needs Claude's tool-calling loop (`callClaudeWithAckgTool`, live `query_ackg`
rounds) and this project chose not to build a Gemini equivalent, `gemini-4stage` — the only
config whose Stage 2a ran on Gemini — is retired along with it, and `claude-4stage-evidence`
is deleted as redundant now that `claude-4stage` runs the same evidence path.

Builds on [ADR-0010](0010-two-pass-attribution-artist-then-work.md) (the two-pass classifier
and Evidence Agent, introduced as an opt-in `config.stage2aMode === "evidence"` alternative)
and [ADR-0006](0006-deterministic-stage2b-routing-and-skeptic-integration.md) (the six-scenario
routing surface, unchanged — `Scenario` / `SCENARIO_NAMES` / `matchSpecialistConfig` all
survive this ADR untouched).

---

## Context

Since ADR-0010, Stage 2a has run two routes side by side:

1. **Classic triage** (default/unset `stage2aMode`) — `ATTRIBUTION_TRIAGE_SYSTEM_PROMPT` asks
   the model for a full verdict in one shot: ranked `candidateArtists[]` with
   `candidateProbability`, `traditionIdentification`, `riskFlags`, `evidenceCorroboration`.
   `classifyTriageOutcome()` then reads those LLM-declared numbers through fixed thresholds
   (`CONFIDENT_THRESHOLD`, `MOVEMENT_THRESHOLD`, `COMPETITIVE_MARGIN`) to pick a scenario.
2. **Evidence mode** (`stage2aMode: "evidence"`) — `ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT` asks
   the model only to OBSERVE: fill raw evidence cells (is there a legible signature? does
   Stage 1b's hit agree with VEA? does `query_ackg`/`query_ackg_work` return a matching
   oeuvre/work?) and stop — no verdict, no scenario. `two_pass_attribution.ts`'s
   `classifyTwoPass` then runs a fully deterministic two-pass logic tree (artist → Conceptual
   Work → impression divergence) over exactly those cells.

The two routes have been running in parallel since ADR-0010 landed (`claude-4stage` on
classic, `claude-4stage-evidence` on evidence, compared via `npm run test:pool:triage --
--evidence`), specifically so evidence mode could be validated against the same fixture
pool before being trusted as the default. That validation is done: `npm run test:two-pass`
(72 cases) and `npm run test:stage2a-evidence` (24 cases) both pass, and manual backtest
rounds recorded in ADR-0010 already showed evidence mode's structured-observation approach
out-performing classic triage's single-shot verdict on the same lots.

Keeping both alive past that point was pure cost: two prompts, two schemas
(`ATTRIBUTION_TRIAGE_SYSTEM_PROMPT`/`TRIAGE_SCHEMA` vs `ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT`/
`ATTRIBUTION_EVIDENCE_SCHEMA`), two routing paths (`classifyTriageOutcome` in `routing.ts` vs
`classifyTwoPass` in `two_pass_attribution.ts`) that could silently drift out of sync on the
same six-scenario contract, and a config surface (`stage2aMode`) whose only real job was
picking between them.

---

## Decision

**Evidence mode becomes the only Stage 2a implementation.** Concretely:

- `runStage2aTriage` (the name is kept — "Stage 2a Triage" is still how the stage is referred
  to in logs and progress messages, independent of which algorithm runs it) now contains
  exactly what used to be `runStage2aEvidence`'s body. The `stage2aMode` branch, the classic
  LLM-verdict path (both its Claude and Gemini variants), and the standalone
  `runStage2aEvidence` method are gone.
- `classifyTriageOutcome`, `CONFIDENT_THRESHOLD`, `MOVEMENT_THRESHOLD`, `COMPETITIVE_MARGIN`,
  `hasWorkLevelMatch`, `countCompetitive`, `RoutingPlan`, and `applyDeterministicRouting` are
  deleted from `src/appraisal/routing.ts`. `Scenario`, `SCENARIO_NAMES`,
  `matchSpecialistConfig`, and `assertSpecialistConfigRegistryIsValid` remain — Stage 2b and
  the two-pass tree both still read/produce these.
- `ATTRIBUTION_TRIAGE_SYSTEM_PROMPT` (`prompts.ts`) and `TRIAGE_SCHEMA` (`schemas.ts`) are
  deleted outright; nothing else referenced them.
- `AppraisalMethodConfig.stage2aMode` is deleted from `appraiser.ts` — there is only one mode
  now, so the field has nothing left to select between.
- `callClaudeWithAckgTool`'s `finalTool` parameter, which defaulted to a
  `report_attribution_triage` tool over `TRIAGE_SCHEMA` for the classic path, is now a
  required parameter — every remaining call site (both inside the evidence agent) already
  passed its own `evidenceTool` explicitly, so the default was dead weight.
- **`gemini-4stage` is deleted.** It was the only config whose Stage 2a ran on Gemini; the
  Evidence Agent's `query_ackg` tool-calling loop only exists for Claude
  (`callClaudeWithAckgTool` hits the raw Anthropic Messages API directly), and this ADR does
  not build a Gemini equivalent — the same gap ADR-0005 finding #4 already noted for
  `lookup_museum_collections`. Rather than leave a config pointed at a mode it structurally
  cannot run (silently falling back to a mode that no longer exists), the config is removed.
  The three Gemini `*-3stage` configs are untouched — they never ran Stage 2a triage at all.
- **`claude-4stage-evidence` is deleted.** With evidence mode as the only mode, it became byte-
  for-byte identical to `claude-4stage` (same `stage2aModel: "claude-sonnet-4-6"`, same
  everything) other than the now-meaningless `stage2aMode: "evidence"` field.
- `tests/routing/run_routing_tests.ts` is gutted to the surface that survives:
  `matchSpecialistConfig` (2 cases), `assertSpecialistConfigRegistryIsValid` (1 case), and
  `SCENARIO_NAMES` completeness (1 case). Scenario-classification testing now lives entirely
  in `npm run test:two-pass` (the classifier) and `npm run test:stage2a-evidence` (the agent
  + assembly), which already covered evidence mode's behavior more thoroughly than the
  classic-triage fixtures ever did.
- `tests/backtest/run_pool_triage.ts` drops its `--evidence` flag (there is nothing left to
  opt into) and always reads the real Evidence Agent's two-pass result. Its `--two-pass` flag
  keeps a distinct job: running the coarse *fixture-adapter* version of the two-pass
  classifier (`toTwoPassInput` → `classifyTwoPass`, built directly from stored fixture
  fields rather than a live agent call) alongside the real agent's result, as a cross-check
  that the adapter still tracks reality — not a second mode of the pipeline itself.

## Consequences

- One Stage 2a implementation to maintain, test, and reason about instead of two. A future
  change to routing behavior (a new evidence cell, a re-tuned threshold) only has one place
  to land.
- 4-stage appraisal is Claude-only going forward for Stage 2a (Stage 1a/1b/1c/2b/3 keep their
  existing Gemini options where those already existed). A Gemini-routed Stage 2a would need a
  purpose-built Gemini tool-calling loop before it could exist again — a real build, not a
  config flag.
- `routingDecision.scenario`/`scenarioName`/`routingRationale` are now always populated by the
  two-pass tree, never by a raw LLM verdict — the comment in `types.ts` describing
  `artistAttribution`/`workIdentification`/`impressionAssessment` as "evidence-mode-only"
  fields is corrected: they're populated on every Stage 2a run now, not conditionally.
- Any external caller or stored fixture that still sets `config.stage2aMode` will get a type
  error (the field no longer exists on `AppraisalMethodConfig`) rather than a silent no-op —
  intentional, so a forgotten reference fails loudly at compile time.

## Not addressed

- `PIPELINE.md` was already flagged (see project memory) as stale relative to the live 4-stage
  implementation before this ADR; it still describes `ATTRIBUTION_TRIAGE_SYSTEM_PROMPT` and
  `classifyTriageOutcome()` as the routing mechanism and was not rewritten here — treat the
  code (`appraiser.ts`, `routing.ts`, `two_pass_attribution.ts`) and this ADR as authoritative
  until that doc gets its own pass.
- The two-pass tree's thresholds (`TAU_NAME`, `SIM_ARTIST_VOTE`, `SIM_WORK_VOTE`,
  `MOVEMENT_THRESHOLD`, etc.) remain the untuned placeholders ADR-0010 already flagged —
  this ADR changes which code path runs, not whether those numbers have been fitted to a real
  backtest corpus yet.
