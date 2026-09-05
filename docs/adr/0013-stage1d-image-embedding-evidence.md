# ADR-0013: Stage 1d — DINOv2/CLIP image-embedding match as independent visual evidence

**Date:** 2026-09-05
**Status:** Proposed — not started.

---

## Context

Stage 1b (Visual Search, `runStage1bVisionSearch()` in `src/appraisal/appraiser.ts:1253`) already produces one
kind of visual-similarity evidence: a Gemini + Google Search reverse-image lookup against the open web, returned
as `VisualSearchResult` (`appraiser.ts:57-81` — `bestMatchArtist`, `bestMatchTitle`, `visualSimilarityScore`,
`matchConfidence`, `evidenceBasis`). This runs unconditionally alongside 1a/1c and its result becomes evidence
cells (`reverseImageNamesArtist`, `reverseImageArtistName`, `reverseImageSimilarity`, …) that Stage 2a's
Attribution Evidence Agent (AEA) fills in and the deterministic two-pass classifier
(`src/appraisal/two_pass_attribution.ts`) then votes on via `SourceTag = "V" | "R" | "A" | "K"`.

Separately, [[project-two-stage-image-similarity]] and ADR-0002 already built DINOv2 (and, for British Museum,
CLIP) embeddings for a *different* purpose — a reference index over the ACKG's own ingested images
(`knowledge_graph/embed_images_dinov2.py`, `knowledge_graph/bm_embed_images.py`), stored on `DigitalImage` nodes
per `08_ackg_schema_definition.md` §7 (`embedding`, `embeddingModel`, `embeddingDim`, `embeddedAt`). This index
has **no runtime consumer today** — the only query path is an ad hoc client-side numpy cosine script
(`query_tate_image_similarity.py`), explicitly noted in that project as not production-ready, disconnected from
`src/appraisal/`.

This ADR proposes wiring that dormant index into the live pipeline as a new stage that answers a distinct
question from 1b: not "does this image (or one very like it) appear anywhere on the indexed web," but "which
images *already inside our own graph* are the closest visual neighbours, by learned embedding distance."

**Three important facts changed the shape of this decision, checked directly against the live graph
(2026-09-05) rather than assumed from the batch-script names:**

1. **The embedding corpus was not uniform, but the fix was small.** Live counts before cleanup: British Museum
   1,691 + Tate 10,208 images on `facebook/dinov2-large` (1024-dim) + CLIP; Forum Auctions 1,005 images on
   `facebook/dinov2-small` (384-dim), no CLIP; Roseberys 0 (never embedded despite ADR-0002 naming it the primary
   source). Large was already the dominant model, not Small — so standardizing meant cleaning up the minority, not
   a full-corpus re-embed. **Done as part of this ADR**: Forum's 1,005 `dinov2-small` nodes had their
   `embedding`/`embeddingModel`/`embeddingDim`/`embeddedAt` properties removed (their other properties —
   `sourceUrl`, `id`, `imageType` — were left intact); the graph now holds exactly one DINOv2 model
   (`dinov2-large`, 12,061 images). Those 1,005 Forum images still need re-embedding on `dinov2-large` before
   they're queryable again — see "Suggested implementation order."
2. **ADR-0002 already establishes the epistemic status of this signal**: "a POC top match was two different
   artists sharing style" — DINOv2/CLIP similarity reflects visual/stylistic closeness, not verified authorship.
   Whatever this stage produces must be treated the same way — as one more corroborating/conflicting evidence
   point, never as a standalone attribution.
3. **ADR-0002's commercial-licensing gate does not apply here.** That ADR's constraint on bulk-indexing Tate
   imagery is scoped to a "commercial-facing," "paid" product. This appraisal pipeline's current and stated use is
   personal research — building a more robust artist-attribution tool for its own sake, not a product sold to
   third parties. Tate's 10,208 images (the majority of the current index) are therefore in scope for Stage 1d's
   candidate pool as-is. **This is a scoping assumption specific to the current use, not a reversal of ADR-0002**:
   if the pipeline is ever commercialized, ADR-0002's constraint reactivates and Stage 1d's Tate coverage would
   need a license or an exclusion filter at that point, not before.

---

## Decision

### 1. New Stage 1d, parallel to 1a–1c, not a tool inside Stage 2a

Stage 1d's input is the same raw submission image `AppraisalInput.imageBase64` that Stage 1b's
`runStage1bVisionSearch()` receives — not a supplementary/cropped image, and not anything VEA (1a) derives from it.
It runs unconditionally at that same trigger point, computes DINOv2 + CLIP embeddings directly from those image
bytes, and performs the nearest-neighbour lookup against the ACKG's own `DigitalImage.embedding` index itself — producing a result shaped like `VisualSearchResult` so Stage 2a's existing
fusion pattern extends rather than forks:

```ts
// src/appraisal/appraiser.ts — alongside VisualSearchResult

export type EmbeddingModelKey = "dinov2-small" | "dinov2-large" | "clip-vit-b32" | string;

export interface EmbeddingMatchCandidate {
  artistName: string;
  conceptualWorkTitle: string | null;
  impressionId: string;                 // ACKG node id — provenance/debugging, not shown to the end user
  dinov2Similarity: number | null;      // 0..1 cosine; null if candidate has no DINOv2 vector on this model
  clipSimilarity: number | null;        // 0..1 cosine; null if candidate has no CLIP vector
  provenanceLayer: AckgProvenanceTag;   // "institutional" | "auction_history" — reuses knowledge_graph/types.ts
}

export interface Stage1dResult {
  schemaVersion: "IES-1.0";             // Image Embedding Search — sibling to VEA-1.1 / AEA-1.0 / AIA-1.0
  embeddingModelsUsed: {
    dinov2: EmbeddingModelKey | null;   // null if generation failed for this submission
    clip: EmbeddingModelKey | null;
  };
  indexCoverageNote: string;
  // -- mirrors the two-stage-image-similarity project: DINOv2 coarse instance match,
  // then title/metadata reranking against the candidate's own catalogued title -- 
  candidateMatches: EmbeddingMatchCandidate[];   // ranked, best first, capped (e.g. top 10)
  bestMatchArtist?: string | null;
  bestMatchConceptualWorkTitle?: string | null;
  dinov2SimilarityScore?: number | null;   // best match's dinov2Similarity, hoisted for easy access
  clipSimilarityScore?: number | null;
  matchConfidence?: "HIGH" | "MEDIUM" | "LOW" | null;   // calibrated separately from Stage 1b's — see Decision 4
  /** Structural, not just documentary: ADR-0002's caution surfaced on every result so no
   *  downstream consumer (2a's prompt, the report renderer, a future dashboard) can read this
   *  as attribution on its own. */
  attributionCaveat: string;
  hypothesisWarning: string;   // same intent/field name as VisualSearchResult, for renderer consistency
}
```

`indexCoverageNote` exists for the same reason `query.ts`'s block comment exists for ULAN/ukiyo-e coverage: as of
this ADR the ACKG's queryable image index is British Museum (1,691) + Tate (10,208) only — Forum and Roseberys are
pending re-embedding (Decision 2). A weak or absent match reflects that coverage gap, not evidence against the
submission's attribution — this has to be stated on the result itself, not just in a code comment, because it
needs to reach the evidence agent's prompt and the human-facing report.

### 2. Standardize on DINOv2-Large; Forum's stale small-model embeddings removed

Resolved (not left open, per Context item 1): every `DigitalImage.embedding` in the graph is now `dinov2-large`.
The only outstanding work is re-embedding the 1,005 Forum images (now embedding-less after cleanup) and the
Roseberys catalogue (never embedded at all, despite ADR-0002 naming it the primary source) on `dinov2-large` —
that's a straightforward batch job with `embed_images_dinov2.py` pointed at the right model, not an open design
question. Until that batch job runs, Stage 1d's candidate pool is effectively British Museum + Tate only
(12,061 images); Forum and Roseberys re-enter coverage once re-embedded.

### 3. Candidate retrieval: Neo4j native vector index, not client-side cosine

`scoreWorkTitleMatches` (`knowledge_graph/query.ts:200`) currently does title-embedding cosine **client-side in
TS**, after a Cypher query has already narrowed the candidate set by artist/title/technique filters — that's fine
there because the filters keep the candidate set small (tens of rows). There is no equivalent cheap pre-filter
for "which images look like this one" — the candidate set is the *entire* image index, and per
[[project_bm_ingest_pilot]] the full British Museum print catalogue alone is 516,376 objects. Brute-force cosine
in application code does not scale to that. Stage 1d's retrieval must use Neo4j's native vector index
(`db.index.vector.queryNodes` against `DigitalImage.embedding`) — this is also the exact migration
`query_tate_image_similarity.py`'s own documentation already flags as needed "at scale," so this ADR is that
migration, not a new idea.

### 4. Plumbing into Stage 2a — evidence, not a new vote, on day one

Stage 1d's result reaches Stage 2a the same way 1b's does: passed into the Attribution Evidence Agent's prompt
context, and the AEA distills it into new flat cells on `EvidenceAgentOutput`
(`src/appraisal/stage2a_evidence.ts:45`), mirroring the existing `reverseImage*` cells one-for-one:

```ts
// artistEvidence additions
embeddingMatchAvailable: boolean;              // false if embedding generation or the graph query failed
embeddingMatchNamesArtist: boolean;
embeddingMatchArtistName: string;
embeddingMatchDinoSimilarity: number;          // -1 sentinel, matching veaSignatureConfidence's convention
embeddingMatchClipSimilarity: number;          // -1 sentinel
embeddingMatchConsistentWithVea: boolean;
embeddingMatchConsistentWithReverseImage: boolean;   // corroboration between the two INDEPENDENT visual stages
embeddingMatchConsistencyRationale: string;

// workEvidence additions
embeddingMatchTitle: string;
embeddingMatchTitleSimilarity: number;         // -1 sentinel
```

And `TriageResult.evidenceCorroboration` (`stage2a_evidence.ts:384`) gets one new field alongside
`stage1bAgreement`/`ackgAgreement`:

```ts
embeddingMatchAgreement: boolean | null;   // null when embeddingMatchAvailable is false
```

**Deliberately not proposed here:** adding a fifth `SourceTag` (e.g. `"D"`) to `two_pass_attribution.ts`'s voting
tree. `SourceTag = "V" | "R" | "A" | "K"` each represents an evidence source whose reliability characteristics are
already understood and tuned (TAU_NAME, TAU_TITLE, etc., calibrated against real backtest data per ADR-0010).
Giving embedding-match a vote on day one, before its own precision/recall against a backtest set is known, risks
exactly the failure ADR-0002 already documented — a stylistic false-positive casting a vote as if it were an
independent identity signal. Corroboration-only (surfaced to the LLM evidence agent's judgement, and in
`evidenceCorroboration` for the report/reviewer) is the correct scope for this ADR; formal voting rights are a
follow-up ADR gated on backtest evidence, exactly as ADR-0011 gates its riskier classifiers on labeled-data
availability.

---

## Consequences

**Benefits:**
- Activates an embedding index that's been sitting unused since ADR-0002 — no new data collection needed to ship
  a first version.
- A second, *independent* visual-evidence stream (our own graph vs. the open web) makes corroboration a much
  stronger signal than either alone: 1b + 1d agreeing on the same artist from two unrelated retrieval mechanisms
  is meaningfully harder to get by coincidence than either one alone.
- Keeps heavy model inference (DINOv2/CLIP) out of Stage 2a's LLM tool loop, consistent with how 1a-1c already
  keep vision-model work upstream of the deterministic/LLM-fusion stage.
- Reuses `AckgProvenanceTag` and the existing coverage-gap-disclosure pattern (`query.ts`'s block comment) instead
  of inventing new conventions.

**Costs:**
- The multi-model embedding inconsistency is resolved (Decision 2), but Forum's 1,005 images and the entire
  Roseberys catalogue still need a `dinov2-large` re-embedding pass before Stage 1d's coverage includes them.
- Neo4j vector index setup and tuning (Decision 3) is new infrastructure the graph doesn't have today.
- `EvidenceAgentOutput` grows by ~9 fields, and the AEA prompt (`ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT`) needs
  updating to actually read and populate them — untouched by this ADR's code sketch above.
- A second embedding-generation path (DINOv2 + CLIP) needs a callable service: today's embedding code
  (`embed_images_dinov2.py`, `bm_embed_images.py`) is offline Python batch scripts in an isolated
  `venv-embeddings`, not something `appraiser.ts` (TypeScript, request-time) can call directly. This ADR does not
  resolve that boundary — see "Not addressed."

---

## Not addressed by this ADR

- **How Stage 1d actually invokes DINOv2/CLIP inference at request time** from a TypeScript pipeline — a Python
  microservice, an ONNX/WASM runtime callable from Node, or a managed inference endpoint (Modal/Replicate/HF
  Inference). The existing embedding code is offline-batch-only; this is real infra work, not a detail.
- A migration plan (batch scheduling, verification) for re-embedding Forum's 1,005 images and the Roseberys
  catalogue on `dinov2-large`.
- Neo4j vector index configuration specifics (similarity function, `M`/`efConstruction` tuning) and expected
  query latency at current/projected corpus size.
- Backtest methodology for deciding whether embedding-match should later earn formal voting rights
  (`SourceTag`) — needs a labeled set the same way ADR-0010's TAU thresholds were calibrated.
- `matchConfidence` calibration for Stage 1d specifically — it should not simply reuse Stage 1b's HIGH/MEDIUM/LOW
  thresholds without checking they mean the same thing for a learned-embedding cosine score as they do for
  Gemini's self-reported reverse-image confidence.
- Whether CLIP's zero-shot text-to-image capability (already used ad hoc in
  `query_tate_image_similarity.py`) has any role here, beyond image-to-image matching — e.g. cross-checking VEA's
  subject/style description against the submission image independent of DINOv2. Left for a later ADR.

## Suggested implementation order

1. ~~Resolve the multi-model embedding inconsistency~~ — done (Decision 2). **Next:** re-embed Forum's 1,005
   images and the Roseberys catalogue on `dinov2-large` so they re-enter the candidate pool.
2. **Neo4j vector index + a minimal query function**, tested standalone against the existing corpus, before any
   pipeline wiring — mirrors how ADR-0011 recommends proving out the cheapest deterministic pieces first.
3. **Stage 1d as a pipeline stage** producing `Stage1dResult`, initially logged/shadow-run alongside real
   appraisals without being read by Stage 2a at all — lets the multi-model fix and the vector index get validated
   against real submissions before any evidence-agent prompt changes.
4. **Wire into `EvidenceAgentOutput`** (Decision 4) once shadow results look sane, starting corroboration-only.
5. Only after a genuine backtest — formal voting rights, as its own follow-up ADR.
