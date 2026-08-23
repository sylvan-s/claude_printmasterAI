# ADR-0001: Split ThreeStageAppraiser into ThreeStageAppraiser + FourStageAppraiser, and make pipeline config fully expressive

**Date:** 2026-08-18  
**Status:** Accepted

---

## Context

The original `ThreeStageAppraiser` class ran both the 3-stage and 4-stage pipelines inside a single `appraise()` method that branched on `this.config.stage2aModel`. This caused several problems:

1. **Misleading name.** The class said "three-stage" but ran a four-stage pipeline for half its callers.
2. **Cognitive overhead.** Every reader had to hold two pipeline models simultaneously. The interface was no simpler than reading both pipeline paths in full.
3. **Hardcoded Stage 1b model.** `STAGE1B_MODEL` was a `static readonly` on the class, invisible to the config registry. Changing the visual search model for one experiment required editing source code, not config.
4. **No way to disable Stage 1b per-experiment.** There was no config field to skip the visual search step without code changes, making it impossible to compare "4-stage with visual search" vs "4-stage without" as two registered Appraisal Methods.
5. **Duplicated report assembly.** ~70 lines of `(valuation as any)` field-stitching existed inside `appraise()` with no seam for testing.

The project's primary research activity is **experimenting with different agent mixes and pipeline configurations**. The config registry (`appraiserConfigs`) is the right mechanism for this — adding an experiment = adding a config entry, with results automatically tagged via `modelUsed`. The architecture was fighting this workflow.

---

## Decision

### 1. Introduce `MultiStageAppraiser` as an abstract base class

Shared callers (`callGemini`, `callClaude`, `callClaudeWithWebSearch`), shared stage runners (`runStage1VEA`, `runStage3Valuation`, `buildHaltReport`, `projectVeaForAttribution`), and the new `assembleReport()` method live here. Both pipeline classes extend it.

### 2. `ThreeStageAppraiser extends MultiStageAppraiser`

Implements the 3-stage orchestration only: `VEA → Attribution Research → Valuation`. Instantiated when `stage2aModel` is absent from config.

### 3. `FourStageAppraiser extends MultiStageAppraiser`

Implements the 4-stage orchestration only: `VEA (+ optional Stage 1b) → Triage → Specialist Attribution → Valuation`. Instantiated when `stage2aModel` is present. Stage 1b and the associated `fetchImageAsBase64`, `scoreVisualSimilarity`, `runStage1bVisionSearch` methods live here.

### 4. Two new fields on `AppraisalMethodConfig`

```typescript
stage1bModel?: string;        // which Gemini model runs Stage 1b visual search
                              // falls back to DEFAULT_STAGE1B_MODEL ("gemini-3.7-flash")
enableVisualSearch?: boolean; // set false to skip Stage 1b entirely (default: true)
```

These fields are persisted to the `appraisal_methods` DB table as `stage1b_model` and `enable_visual_search`.

### 5. `assembleReport(vea, attr, valuation, currency): PrintAnalysisReport`

Extracted from the inline assembly block into a `protected` method on `MultiStageAppraiser`. Both pipeline classes call it. The `any` casts remain for now (see consequences) but are isolated to one place.

### 6. `modelUsed` encodes full pipeline including Stage 1b

```
4-Stage [S1: claude-opus-4-8 | S1b: gemini-3.7-flash | S2a: claude-sonnet-4-6 | S2b: claude-sonnet-4-6 | S3: claude-sonnet-4-6]
4-Stage [S1: claude-opus-4-8 | S1b: skip | S2a: claude-sonnet-4-6 | S2b: claude-sonnet-4-6 | S3: claude-sonnet-4-6]
```

This makes every `PrintAnalysisReport` self-describing for experiment comparison.

---

## Factory routing

```typescript
// getAppraiserFromConfig
if (config.stage2aModel)                    → FourStageAppraiser
if (config.stage1Model || config.stage2Model) → ThreeStageAppraiser
if (config.provider === "anthropic")          → ConfigurableClaudeAppraiser
else                                          → ConfigurableGeminiAppraiser
```

---

## Consequences

**Good:**
- Adding a new pipeline variant (e.g. "4-stage, no visual search, Haiku triage") = one new entry in `appraiserConfigs`. No code change.
- `stage1bModel` is now config-scoped: different experiments can use different visual search models simultaneously.
- `assembleReport` is testable in isolation without running the full pipeline.
- `ThreeStageAppraiser` and `FourStageAppraiser` each have a single clear pipeline responsibility.
- The `modelUsed` tag on every result enables automated experiment comparison without metadata sidecar files.

**Accepted limitations:**
- `assembleReport` still uses `as any` casts where `LegacyAttributionResult` and `ASAAttributionResult` share no common typed fields. The union type is correct; the consuming code is not narrowing on `schemaVersion`. This is a known TODO — a follow-up pass should narrow properly and remove the `any` casts.
- The Stage 1b methods (`fetchImageAsBase64`, `scoreVisualSimilarity`, `runStage1bVisionSearch`) are `protected` on `MultiStageAppraiser` rather than private to `FourStageAppraiser`. They could be moved fully into `FourStageAppraiser` in a future cleanup pass — no behaviour change, just better encapsulation.

---

## Files changed

- `src/appraisal/appraiser.ts` — class restructure, new config fields, updated registry/factory
- `src/db/pool.ts` — migration: `ADD COLUMN IF NOT EXISTS stage1b_model`, `enable_visual_search`
- `src/db/queries.ts` — `APPRAISAL_METHOD_COLUMNS` and `saveAppraisalMethod` updated
- `server.ts` — seeding SQL updated for new columns
