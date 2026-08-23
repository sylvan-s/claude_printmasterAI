# ADR-0003: Knowledge-graph-grounded Triage with Stage 1b feedback and appraiser input

**Date:** 2026-08-23
**Status:** Proposed — item 1 implemented (PR #13, branch `VEA_confidence`); item 3 superseded
by [ADR-0004](0004-appraiser-input-agent.md) (to-be architecture only, not implemented);
items 2 and 4 not started

---

## Context

Stage 2a (Triage / ATA) currently makes its tradition classification, period estimate,
candidate artist shortlist, and specialist routing decision from a single input: the Stage 1
VEA output. All of that reasoning is grounded in nothing but the model's own training-time
knowledge — there is no external, checkable evidence source behind a candidate's
`candidateProbability`, and no way to tell whether a shortlist reflects real population data
or a plausible-sounding guess.

Three specific gaps, found while reviewing the current 4-Stage Pipeline
(`CONTEXT.md`, `PIPELINE.md`):

1. **Stage 1b's evidence never reaches Triage.** Visual Search (Stage 1b) runs in parallel
   with Stage 2a and is deliberately routed to Stage 2b only (`PIPELINE.md` design principle
   #6: *"Stage 1b is advisory... passed to Stage 2b as hypotheses"*). This means a strong
   reverse-image hit — e.g. an exact match to a catalogued, attributed work — cannot influence
   Triage's Tier 1/2/3 routing decision or candidate shortlist. It only surfaces after routing
   has already committed the item to a specialist config, as supporting evidence the
   specialist has to reconcile after the fact.
2. **VEA confidence is uneven.** `VisualExtractionResult` carries per-field confidence on some
   observations (`signatureConfidence`, `techniqueConfidence`) but not others (`paper`,
   `composition`). Triage has no uniform signal for weighing which observations to trust when
   they conflict.
3. **No appraiser-supplied evidence channel.** Provenance notes, consignor history, or a
   human's own attribution hypothesis have no defined entry point into the pipeline at all.

Separately, `benchmark/` already collects structured, fact-only auction data (artist,
medium, dimensions, estimate, hammer price) from Roseberys and Forum Auctions for pipeline
evaluation (see `docs/agents/benchmark.md`). That corpus is a candidate data source for
grounding Triage's candidate shortlisting in real market population data, not just
encyclopedic/institutional artist records.

---

## Decision

Four changes, each independently shippable:

### 1. Uniform confidence envelope on `VisualExtractionResult`

Every extracted observation, not only the ones that already have it, carries the same shape:

```typescript
{ value: <observation>, confidence: number /* 0.0–1.0 */, evidenceNote: string }
```

Bumps VEA to `VEA-1.1`. `paper`, `composition`, and `stampsAndLabels` fields gain confidence
scoring for the first time.

**Implemented** in PR #13 (branch `VEA_confidence`), with one deliberate deviation from the
shape proposed above: rather than wrapping every leaf field as `{value, confidence,
evidenceNote}`, each section gained a single named sibling field instead —
`paperConfidence`, `compositionConfidence`, `defectConfidence`, `conditionConfidence`,
`stampConfidence`, `plateMarkConfidence`, `dimensionsConfidence`, `inkAndColourConfidence`,
`qualityAssessmentConfidence`, `editionConfidence` — matching the pattern the schema already
used for `signatureConfidence`/`techniqueConfidence`/`titleConfidence`. A full per-field
envelope would have meant restructuring every existing accessor across the prompt, schema,
Triage input, and the UI's report rendering for no real gain in expressiveness at this grain.
Verified against a real Claude Opus 4.8 call (not just schema validation): the new
confidence fields correctly separated high-certainty observations (`compositionConfidence:
0.85`) from low-certainty ones (`dimensionsConfidence: 0.20` without a scale reference), and
a targeted test confirmed the model does not blindly parrot a false user-supplied claim about
a supplementary photo's content — see `tests/vea/README.md`.

This work also folded in the unrelated fix from doc 07 that never got its own ADR: the
app's three fixed auxiliary-image slots (signature/damage/scale) were replaced with an
arbitrary-length list of user-captioned supplementary photos, which incidentally satisfies
the `VERSO_SCAN` gap noted in earlier design discussion — a user can now caption a photo as
the sheet's reverse without a dedicated scan type ever needing to exist for it. This is *not*
the structured `hypothesis`/`documented_fact` appraiser-input channel proposed in item 3
below — it's free-text guidance attached to an image, not a standalone assertion with a
trust level. Item 3 as scoped below is still unimplemented.

### 2. Route Stage 1b's `VisualSearchResult` into Stage 2a, not only Stage 2b

Triage becomes a consumer of Stage 1b evidence. This changes Stage 1b and Stage 2a from fully
parallel to a dependency: Stage 2a must wait on Stage 1b's result (or on a timeout/skip if
`enableVisualSearch: false`) before making its routing decision. The hypothesis warning
travels with the data — Triage must weigh it as evidence with a stated similarity/confidence
score, never as confirmed attribution, same discipline Stage 2b already applies.

### 3. Appraiser direct input as a defined pipeline input

A new input surface, arriving alongside the Item's images rather than being inferred from
them. Each entry carries an explicit status:

- `hypothesis` — an unverified assertion (e.g. "consignor believes this is a Hiroshige")
- `documented_fact` — backed by paperwork (e.g. a provenance chain, a prior sale record)

A `hypothesis` must not outrank contradicting VEA/ACKG evidence; a `documented_fact` should.

**Superseded by [ADR-0004](0004-appraiser-input-agent.md).** What's sketched here as an
input surface is fleshed out there as a full Stage-1-level agent — **Stage 1c, the Appraiser
Input Agent (AIA)** — running in parallel with VEA and Stage 1b rather than being folded into
either. ADR-0004 also resolves something this ADR didn't address: the appraiser's free text
was, until now, being fed directly into *VEA's* prompt (`{userNotes}`), not routed to Triage
at all — a layering violation ADR-0004 removes as part of standing AIA up. Read ADR-0004 for
the actual design (extraction approach, output schema, pipeline placement); this section is
left in place for historical context only.

### 4. Art Context Knowledge Graph (ACKG), queried by Stage 2a as a tool call

Not embedded in the prompt — too large, and an LLM asked to emit vocabulary URIs
(e.g. Getty AAT/ULAN identifiers) from memory without a live lookup is a real hallucination
risk. Instead, one new tool: `query_ackg(technique, period, paper, region, subject, ...)`
returning ranked candidates with a support count and a provenance tag per candidate. Two
source layers, kept distinct by that tag:

- **Institutional layer** — Getty ULAN/AAT, Wikidata, VIAF, museum collection APIs. Strong for
  identity and authoritative technique/period associations. Known gap: thin non-Western
  coverage (Getty's own published numbers put Japan at ~1.3% of ULAN's total records, ~37% of
  those with a native-script name) — directly relevant given this pipeline handles ukiyo-e.
- **Auction-history layer** — built from `benchmark/`'s existing Roseberys/Forum extractors.
  Gives real base rates: how often a given artist's actual output exhibits a specific
  paper/technique/condition combination, and surfaces reprint/forgery patterns institutional
  data won't capture. This is the same corpus `benchmark/` already collects for evaluation —
  the ACKG would be a second consumer of that data, not a new collection effort.

### Fusion logic in Stage 2a

- **Corroboration is the strong case.** Stage 1b matching a catalogued work, agreeing with
  VEA signature evidence and an ACKG candidate with strong auction-history support, produces
  a high-confidence single-candidate shortlist.
- **Contradiction must surface, not average out.** An appraiser hypothesis disagreeing with
  VEA physical evidence, or a high-confidence signature match pointing to an artist whose ACKG
  profile never shows the observed paper type, becomes an explicit entry in `riskFlags` —
  never silently resolved by averaging.
- **Tier 1/2/3 routing keeps its current shape**, just backed by the ACKG's returned
  candidates instead of Section 2A's hardcoded tradition/period lookup tables. Escalation
  (`humanEscalationRequired`) additionally triggers when appraiser input and algorithmic
  evidence disagree materially.

---

## Consequences

**Good:**
- Triage's routing decision can no longer be blindsided by strong reverse-image evidence that
  currently arrives too late to matter.
- Every candidate probability becomes traceable to an external, checkable source rather than
  the model's unexaminable prior.
- `benchmark/`'s auction corpus gets a second real use (ACKG grounding) beyond evaluation,
  strengthening the case for investing in it further.
- Confidence handling becomes uniform across VEA output, closing a real gap in today's schema.

**Accepted limitations / open risks:**
- **Stage 1b and Stage 2a lose parallelism.** Today they run concurrently; item 2 makes Stage
  2a depend on Stage 1b's completion, adding Stage 1b's latency to Stage 2a's critical path.
  Needs a decision: accept the latency cost (this is already the "high-quality" pipeline, per
  `CONTEXT.md`), or have Stage 2a run a first pass without Stage 1b and revise if a
  strong-confidence Stage 1b result arrives after.
- **ACKG is new infrastructure**, not a config change — a schema, a seed dataset, and a query
  service all need to be built before Stage 2a can call it. Recommended seed scope: the
  existing Tier 1 specialist config artists only (`src/appraisal/specialist_configs/`), not
  broad coverage, to validate the approach cheaply first.
- **No AAT/ULAN URIs should be generated by the model directly** — resolve enum values to
  vocabulary URIs in a deterministic post-processing layer outside the per-inference call, not
  by asking the LLM to recall or construct them.
- **ULAN's non-Western coverage gap** (Japan ~1.3% of records) means the institutional layer
  alone is insufficient for this pipeline's ukiyo-e volume; the auction-history layer is load-
  bearing here, not a nice-to-have.
- Should be backtested against known-attribution items before any live use, to confirm the
  fused shortlist improves on today's routing rather than introducing new failure modes from
  a noisy or sparsely-seeded graph.

---

## Not addressed by this ADR

- The exact `VisualExtractionResult` v1.1 schema diff (field-by-field) — follow-up.
- The ACKG's concrete storage technology (graph DB vs RDF triple store vs relational with
  join tables) — an implementation decision, not an architectural one, deferred to whoever
  builds item 4.
- Changes to Stage 2b or Stage 3 — this ADR only changes what reaches Stage 2a and how it
  reasons over it; downstream consumption of `TriageResult` is unchanged.
