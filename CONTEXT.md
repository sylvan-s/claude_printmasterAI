# PrintMaster AI — Domain Glossary

This file is the authoritative vocabulary for the appraisal pipeline. Use these terms exactly in code, issues, ADRs, and PR descriptions. Don't drift to synonyms.

---

## Core pipeline concepts

**Appraisal Method**
A named, config-driven variant of the appraisal pipeline. Defined in `appraiserConfigs` in `src/appraisal/appraiser.ts`. Each method has an `id`, a set of model assignments per stage, and optional flags (`enableVisualSearch`, `stage1bModel`). Adding a new experiment = adding a new Appraisal Method config entry; no code change required.

**Pipeline**
The ordered sequence of AI calls that transforms an artwork image into a `PrintAnalysisReport`. Two pipeline shapes exist: the 3-Stage Pipeline and the 4-Stage Pipeline (see below). Both share Stage 1 (VEA) and Stage 3 (Valuation).

**3-Stage Pipeline**
`VEA → Attribution Research → Valuation`. Runs when `stage2aModel` is absent from the Appraisal Method config. Handled by `ThreeStageAppraiser`. Good for fast or cost-sensitive runs.

**4-Stage Pipeline**
`VEA (+ optional Visual Search) → Triage → Specialist Attribution → Valuation`. Runs when `stage2aModel` is present. Handled by `FourStageAppraiser`. The standard pipeline for high-quality appraisals.

**Stage 1 — VEA (Visual Extraction Agent)**
First stage of every pipeline. Extracts raw visual observations from the artwork image: signatures, inscriptions, printing technique, plate mark, paper type, condition, dimensions. Model selected by `stage1Model` config field. Produces a `VisualExtractionResult`.

**Stage 1b — Visual Search**
Optional parallel step in the 4-Stage Pipeline only. Sends the image to Gemini with Google Search enabled to find auction records and museum pages for the work. Produces a `VisualSearchResult` with a `visualSimilarityScore` and `hypothesisWarning`. Controlled by:
- `enableVisualSearch: boolean` — set `false` to skip entirely
- `stage1bModel: string` — which Gemini model runs the search (default: `gemini-3.7-flash`, defined in `DEFAULT_STAGE1B_MODEL`)

Stage 1b always carries a hypothesis warning — its output must be cross-referenced against VEA evidence before use in attribution.

**Stage 2a — Triage (ATA: Attribution Triage Agent)**
4-Stage Pipeline only. Routes the print to the correct specialist domain (e.g. Modernist European, Japanese Woodblock, British Etching) based on VEA output. Produces a `TriageResult` with a `routingDecision.specialistConfig` key used to load a specialist config JSON. Model: `stage2aModel`.

**Stage 2b — Specialist Attribution (ASA: Attribution Specialist Agent)**
4-Stage Pipeline only. Receives VEA output, triage routing, and the Stage 1b visual search result. Conducts deep attribution research — consulting specialist config JSON, web search (if Claude), or grounded Gemini search. Produces an `ASAAttributionResult`. Model: `stage2bModel` (falls back to `stage2aModel`).

**Stage 2 — Attribution Research**
3-Stage Pipeline only. Combined triage + attribution in one call. Produces a `LegacyAttributionResult`. Model: `stage2Model`.

**Stage 3 — Valuation**
Final stage of both pipelines. Searches for recent auction comparables and produces estimate fields only (`auctionEstimate`, `recentAuctionSales`, `nextSteps`, `editionSizeAndPrintNumber`). Model: `stage3Model`.

**assembleReport**
The `protected assembleReport(vea, attr, valuation, currency)` method on `MultiStageAppraiser`. Merges the three stage outputs into a single `PrintAnalysisReport`. Both pipeline classes call it — it is the single source of field-stitching logic.

---

## Attribution result types

**LegacyAttributionResult**
Output schema from the 3-Stage Attribution Research stage. Top-level fields: `likelyArtist`, `artistConfidence`, `artworkTitle`, `titleConfidence`, `creationPeriod`, `historicalContext`. No `schemaVersion` field.

**ASAAttributionResult**
Output schema from the 4-Stage Specialist Attribution stage. Nested under `attributionConclusion`: `attributedArtist`, `attributionConfidence`, `workTitle`, `dateOrPeriod`, `technique`, `attributionEvidenceChain`. Identified by `schemaVersion: "ASA-1.0"`.

**AttributionResearchResult**
TypeScript union: `LegacyAttributionResult | ASAAttributionResult`. Discriminated by `schemaVersion`. `assembleReport` reads both variants.

---

## Storage concepts

**Catalogue**
A named collection of Items belonging to a user. Has an `id` (format: `email-NNNN`), `name`, and `created_at`. Stored in the `catalogues` PostgreSQL table and mirrored in IndexedDB on the client.

**Item**
A single artwork scan submitted for appraisal. Belongs to a user and optionally to a Catalogue and a Lot. Has a primary image and up to three supplementary scans (signature, damage, scale). Stored in the `items` table.

**Lot**
A named grouping of Items (e.g. auction lot number). Stored in the `lots` table. Optional — Items can exist without a Lot.

**Supplementary Scan**
An auxiliary close-up image attached to an Item. Three types: `signature` (close-up of the artist's signature or embossment), `damage` (potential paper damage or staining), `scale` (coin placed beside the sheet for dimension inference). Stored as `image_type = 'supplementary'` rows in the `images` table.

---

## Class hierarchy

```
MultiStageAppraiser (abstract)
├── ThreeStageAppraiser   — 3-stage pipeline
└── FourStageAppraiser    — 4-stage pipeline

ConfigurableGeminiAppraiser  — single-stage Gemini
ConfigurableClaudeAppraiser  — single-stage Claude
```

All four implement `AppraisalMethod { appraise(input): Promise<PrintAnalysisReport> }`.

Factory: `getAppraiserFromConfig(config)` — selects the correct class based on which stage fields are present in config.

---

## Specialist configs

JSON files in `src/appraisal/specialist_configs/`. Loaded by `loadSpecialistConfig(key)` at Stage 2b. Each file describes the attribution domain, known artists, key reference works, and evidence priorities. Fallback: `general_print_fallback.json`.

---

## Key invariants

- `enableVisualSearch` defaults to `true` for 4-stage configs. Set `false` to run a 4-stage pipeline without Stage 1b — useful for speed/cost experiments or when the image is already well-identified.
- `stage1bModel` is config-scoped, not global. Changing it for one Appraisal Method does not affect others.
- The `modelUsed` field written to every `PrintAnalysisReport` encodes the full pipeline: `4-Stage [S1: … | S1b: … | S2a: … | S2b: … | S3: …]`. This is the primary identifier for comparing experiment results.
- All DB access goes through `src/db/queries.ts`. No direct `pool.query` calls in route handlers.
- Item fetch uses a single LEFT JOIN query (no N+1). Supplementary scans are aggregated in the same query via `MAX(CASE WHEN …)`.
