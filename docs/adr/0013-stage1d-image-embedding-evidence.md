# ADR-0013: Stage 1d — DINOv2/CLIP image-embedding match as independent visual evidence

**Date:** 2026-09-05
**Status:** Implemented (Stage 1d itself: DINOv2-Large + CLIP-Base embedding service, ACKG
vector-index lookup, `runStage1dEmbeddingMatch`, shadow-run in every 4-stage appraisal). See
the **2026-09-06 amendment** below: the "Deliberately not proposed here" voting-rights
deferral this ADR originally made is now superseded — D votes, gated to HIGH confidence. The
index-coverage figures quoted in Context and Decision 2 are also superseded — see the
**2026-09-07 amendment**.

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
pending re-embedding (Decision 2). *(Figures superseded — see the 2026-09-07 amendment; Bonhams has since been
embedded, Forum and Roseberys still have not.)* A weak or absent match reflects that coverage gap, not evidence
against the submission's attribution — this has to be stated on the result itself, not just in a code comment,
because it needs to reach the evidence agent's prompt and the human-facing report.

### 2. Standardize on DINOv2-Large; Forum's stale small-model embeddings removed

Resolved (not left open, per Context item 1): every `DigitalImage.embedding` in the graph is now `dinov2-large`.
The only outstanding work is re-embedding the 1,005 Forum images (now embedding-less after cleanup) and the
Roseberys catalogue (never embedded at all, despite ADR-0002 naming it the primary source) on `dinov2-large` —
that's a straightforward batch job with `embed_images_dinov2.py` pointed at the right model, not an open design
question. Until that batch job runs, Stage 1d's candidate pool is effectively British Museum + Tate only
(12,061 images); Forum and Roseberys re-enter coverage once re-embedded. *(Superseded — the candidate pool is now
52,939 images, Bonhams included; see the 2026-09-07 amendment. Forum and Roseberys are still not embedded, so the
consequence for those two houses stands.)*

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

**Deliberately not proposed here (superseded 2026-09-06 — see the amendment below):** adding a fifth `SourceTag`
(e.g. `"D"`) to `two_pass_attribution.ts`'s voting tree. `SourceTag = "V" | "R" | "A" | "K"` each represents an
evidence source whose reliability characteristics are already understood and tuned (TAU_NAME, TAU_TITLE, etc.,
calibrated against real backtest data per ADR-0010). Giving embedding-match a vote on day one, before its own
precision/recall against a backtest set is known, risks exactly the failure ADR-0002 already documented — a
stylistic false-positive casting a vote as if it were an independent identity signal. Corroboration-only
(surfaced to the LLM evidence agent's judgement, and in `evidenceCorroboration` for the report/reviewer) is the
correct scope for this ADR; formal voting rights are a follow-up ADR gated on backtest evidence, exactly as
ADR-0011 gates its riskier classifiers on labeled-data availability.

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
   images and the Roseberys catalogue on `dinov2-large` so they re-enter the candidate pool. *(Still outstanding
   as of 2026-09-07, and larger than stated — Forum is now 10,036 unembedded images and Roseberys 10,365; see the
   2026-09-07 amendment.)*
2. ~~Neo4j vector index + a minimal query function~~ — done.
3. ~~Stage 1d as a pipeline stage producing `Stage1dResult`, shadow-run~~ — done; ran in production
   shadow-run for a period before the amendment below.
4. ~~Wire into `EvidenceAgentOutput`, corroboration-only~~ — superseded: wired directly into
   `two_pass_attribution.ArtistEvidence` instead (see amendment), not through the LLM's schema at all.
5. ~~Only after a genuine backtest — formal voting rights~~ — done via the amendment below, gated to HIGH
   confidence only rather than a full backtest-fitted threshold (see amendment for the reasoning).

---

## Amendment (2026-09-06): D given voting rights, gated to HIGH confidence

This ADR's original Decision 4 explicitly withheld a `SourceTag` for Stage 1d, deferring formal voting rights to
"a follow-up ADR gated on backtest evidence." Per direct user instruction, that follow-up happens here rather
than as a separate ADR number, because the change made is narrower than a full backtest-calibrated threshold:
**a HIGH `matchConfidence` votes; MEDIUM and LOW are treated as "don't know"** — no vote, no corroboration effect,
dropped as if the match hadn't run at all. This sidesteps needing the labeled backtest set the original deferral
called for, by only trusting the tier of the signal the model already self-reports as its strongest read, on the
theory that a HIGH categorical confidence is far less likely to be the ADR-0002 false-positive-namesake failure
mode than a MEDIUM/LOW one — the same logic already used for Stage 1b's R (gated on a numeric similarity floor,
`SIM_ARTIST_VOTE`/`SIM_ARTIST_STRONG` in `two_pass_attribution.ts`).

**What changed:**
- `SourceTag` gains `"D"`; `ArtistEvidence` gains an `embeddingMatch: NamingSource` cell.
- Unlike V/R/A/K, this cell is **not** filled by the LLM evidence agent's tool call — it costs nothing to compute
  deterministically from `Stage1dResult.bestMatchArtist` / `matchConfidence`, so `evidenceToTwoPassInput()` and
  `runEvidenceTree()` (`stage2a_evidence.ts`) both take an optional `stage1d` parameter and build the cell
  directly in code. `ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT`/`ATTRIBUTION_EVIDENCE_SCHEMA` are untouched — the LLM is
  never shown Stage 1d's result and makes no judgement about it.
- `eligibleVotes()` gates D to `matchConfidence === "HIGH"`; MEDIUM/LOW are logged to the rule trace as dropped,
  with zero downstream effect (no corroboration lift either, unlike a hypothesis-tier appraiser claim).
- A lone HIGH-confidence D vote is a new rule, **A6D** — same treatment as A6 (a lone strong Stage 1b image
  match): `candidate`/MEDIUM, never `attributed` on visual similarity alone. D joining V/R/A/K's agreement
  cluster participates in A1 (n≥3) and A2/A3/A4 (n=2) exactly like any other source — `agree()`/`eligibleVotes()`
  were already generic over the vote list, so no special-casing was needed there.
- `appraiser.ts`'s `FourStageAppraiser.appraise()` now awaits `embeddingMatchPromise` inside the Stage 2a block
  (previously an independent 4th `Promise.all` member, deliberately kept out of Stage 2a's inputs per this ADR's
  original shadow-run scope) and passes the result into `runStage2aTriage`. This adds Stage 1d's latency to Stage
  2a's critical path — the same tradeoff ADR-0003 item 2 already accepted for Stage 1b.
- Stage 1d is **still not** passed into Stage 2b (`runStage2bSpecialist`) — unchanged, out of scope here.

**Tests:** 7 new cases in `tests/two_pass_attribution/run_tests.ts` (A6D alone; MEDIUM/LOW don't vote; D joining
V to reach n=2; D+V+R to reach n=3/A1; D conflicting with V) — 72 → 78. 5 new cases in
`tests/stage2a_evidence/run_tests.ts` covering the `stage1d` parameter end to end (no arg / no bestMatchArtist /
HIGH / a full `runEvidenceTree` HIGH-alone and MEDIUM-alone run) — 24 → 29.

**Not addressed by the amendment** (inherits this ADR's own unaddressed items above): `matchConfidence`
calibration for Stage 1d specifically was never separately validated against a labeled backtest set — this
amendment's "HIGH only" gate is a conservative stand-in for that validation, not a replacement for eventually
doing it. If Stage 1d's HIGH tier turns out to be poorly calibrated (too permissive or too rare) once real
backtest data accumulates, revisit the gate — tighten to a numeric embedding-similarity floor (mirroring R's
`SIM_ARTIST_VOTE`) rather than trusting the categorical label, or recalibrate what HIGH means at the source.


## Amendment (2026-09-07): index coverage is Bonhams + Tate + British Museum, not BM + Tate

The coverage figures this ADR states in Context (`indexCoverageNote`) and Decision 2 predate the Bonhams ingest
and are stale. Verified against the live graph on 2026-09-07:

| corpus | images with `embedding` + `clipImageEmbedding` | not yet embedded |
|---|---|---|
| Bonhams | 40,224 | 13,353 |
| Tate | 10,208 | — |
| British Museum | 2,507 | — |
| Roseberys | **0** | 10,365 |
| Forum Auctions | **0** | 10,036 |
| **total** | **52,939** | 33,755 |

(86,694 `DigitalImage` nodes in all; every embedded one carries both vectors. The unembedded column is 33,754
across these five corpora plus one image whose `sourceUrl` matches none of them.) The British Museum figure has also
grown from the 1,691 quoted above, via the 10-artist extraction.

**What changes.** Stage 1d's candidate pool is 4.4x the size this ADR assumed, and its centre of gravity is now
auction rather than institutional — 40,224 of 52,939 images resolve to 3,717 Artists and 35,972 ConceptualWorks
in the Bonhams corpus. `STAGE1D_INDEX_COVERAGE_NOTE` in `appraiser.ts` has been corrected to match, since that
string reaches both the evidence agent's prompt and the human-facing report.

**What does not change.** The Decision 2 batch job is still outstanding for the two houses that matter most to
the backtest: Roseberys (10,365 images, never embedded, despite ADR-0002 naming it the primary source) and Forum
(10,036). `tests/backtest/test_pool_100.json` is 100% Roseberys/Forum, so a pool lot's own image file is still
never in the index — there is no self-match.

**But that does not make the exact work unreachable, which an earlier draft of this amendment got wrong.** Prints
are editions: the pool lot is one impression of a `ConceptualWork` that Bonhams, Tate or the BM frequently hold
*another* impression of, and those images are indexed. Measured over the 99-lot pool, Stage 1d returns the
correct work in its top 3 for **24.2%** of lots — Banksy's *Happy Chopper* at dino=0.990, Damien Hirst's
*Fruitful (Small)* at 0.988, Rembrandt's *Death of the Virgin* at 0.974, all matched against a different
impression of the same edition. So exact-work retrieval is a live capability on this pool, not a structural
impossibility; what is impossible is a trivial self-match, and the ~24% is a floor set by edition overlap
between the pool's two houses and the three embedded corpora, not by the model.

(That 24.2% is measured with the title-agreement proxy in `run_noise_robustness.ts`; all 27 title agreements were
inspected by hand and 26 were genuine work matches, the exception being an `Untitled` / `Untitled` collision.)

**Measured consequence.** A paired clean-vs-degraded run over the whole pool on 2026-09-07
(`tests/backtest/run_noise_robustness.ts`, report in `tests/backtest/output/noise_robustness.md`) separates two
populations that the headline averages hide:

| | clean | degraded |
|---|---|---|
| correct artist, top 1 | 41.4% | 28.3% |
| correct artist, top 3 | 48.5% | 37.4% |
| correct work, top 1 | 22.2% | 14.1% |
| **correct work, top 3** | **24.2%** | **23.2%** |

Aggregate top-3 retrieval stability is only **25-32%** mean overlap, with 53 of 99 lots returning a completely
disjoint top 3 — but that number is dominated by the lots with no true match to find. (It is a bracket because
neither available identity is exact: keying on the resolved `ConceptualWork` id under-counts, since the ACKG
holds separate work nodes for the same print sold at Bonhams more than once — 35 of 99 lots have such a collision
inside a single top 3, which is itself worth a dedupe pass; keying on normalised artist+title over-counts by
merging different works that share a title.) Split by the strength of the clean top-1: lots scoring
**dino >= 0.95** (n=20, i.e. a genuine instance match on another impression) hold **49-68%** top-3 overlap
through degradation, against **18-21%** for the rest — roughly 3x, under either identity. Correct-work-in-top-3
barely moves at all (24.2% -> 23.2%); what noise does is demote the true work from first place to somewhere in
the top 3 (22.2% -> 14.1% at top-1).

The read: **DINOv2 instance matching is robust to bad photography; DINOv2 stylistic-neighbour ranking is not.**
The churn is concentrated in exactly the cases that carry no signal. That supports the HIGH-confidence gate in
the 2026-09-06 amendment rather than undermining it, and it argues that a numeric similarity floor (the
alternative that amendment flags) would be a sound tightening — the >= 0.95 population behaves like a different
mechanism from the rest, not a better-scoring sample of the same one.
