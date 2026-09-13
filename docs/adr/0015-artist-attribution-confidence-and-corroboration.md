# ADR-0015: Artist attribution scores on two axes — source confidence and ACKG corroboration

**Date:** 2026-09-09
**Status:** Accepted, implemented. Thresholds unfitted.

Separates the two things Pass 1 was conflating. A naming source (V/R/A/D) reports **who** and
**how sure it is**; the ACKG reports **whether the record supports that name**. The ACKG stops
voting, each source carries its own confidence, and corroboration becomes a cascade the
deterministic tree evaluates over cells the agent fills.

Supersedes the Decision 4a amendment of
[ADR-0010](0010-two-pass-attribution-artist-then-work.md) (the `K` vote and `A8K`). Builds on
[ADR-0013](0013-stage1d-image-embedding-evidence.md) (Stage 1d, source `D`) and leaves
[ADR-0006](0006-deterministic-stage2b-routing-and-skeptic-integration.md)'s six-scenario
routing surface untouched — `Scenario`, `SCENARIO_NAMES`, `matchSpecialistConfig` and the
`evidenceBasis` codes all survive, so Stage 2b task profiles and the report renderer need no
change.

---

## Context

ADR-0010 Decision 4a let the ACKG vote: an artist back-propagated from a title-matched work
(`ackgWorkAnchor`) counted as source `K`, alongside V (VEA), R (Stage 1b), A (Stage 1c) and
later D (Stage 1d). `A8K` let `K` alone promote a lot to a MEDIUM candidate, and `K` counted
toward `n` in A1/A2.

That is a category error, and it produced a live false positive.

`K`'s artist is not an independent observation. It is derived from a *title*, and that title
came from `V_t` / `R_t` / `A_t` / `D_t` — the very sources `K` was then counted alongside. On
Roseberys A0793 lot 148 (David Hockney, *Cold water about to hit the Prince*) Stage 2a
returned:

```
artist=A2 attributed/HIGH "David Hockney"  agreementSet=["K","D"]
```

`K`'s artist came from a title match to *Reclining Figure* — a different Hockney work
entirely, matched at `titleSim 1.00`. It won because the correct work had **no title
embedding**: all three of its `ConceptualWork` rows were unembedded while *Reclining Figure*
was embedded in the 2026-08-31 backfill, so the right work was scored by token overlap and
could not compete. (That coverage gap — 43.8% of works — was closed separately on 2026-09-09;
the ranking defect it exposed, embedding-basis and token-basis scores sorted on one scale, is
tracked on its own.) A wrong title match manufactured a second independent-looking vote and
carried the verdict to HIGH on what was really a single source.

Two further problems were visible in the same code:

- **Confidence was discarded.** Every source already reports how sure it is —
  `veaSignatureConfidence`, `reverseImageSimilarity`, `appraiserTrust`, Stage 1d's
  `matchConfidence` — and Pass 1 read none of it. Two sources scraping past their gates
  scored identically to two confident ones.
- **Corroboration was a single crude lift.** `applyCorroborationLifts` moved one band on
  `kOeuvreMatchCount >= 3`, and only for single-source verdicts. `kSubject` was explicitly
  annotation-only ("it must not influence any other cell").

## Decision

### 1. The ACKG corroborates; it does not witness

`K` is removed from `eligibleVotes`. `A8K` is retired — an ACKG title match with no naming
source now yields `A11 not_attributed`, because nobody actually named anyone.

A title match naming a *different* artist from the sole witness no longer produces an `A10`
conflict either. A reference disagreeing with a witness is not a second witness; it is
recorded as `ackgTitleMatchNamesDifferentArtist:<name>` and left for the specialist.

### 2. Each source carries its own confidence

`sourceConfidence()` normalises to 0..1: V from `veaSignatureConfidence`, capped at 0.5 when
the authorship mark was reconstructed rather than legible; R from its similarity; A and D from
documented ordinal placeholders (0.85 / 0.9).

Agreement remains primary — `n` sets the base band — but the **mean** confidence of the
agreeing sources demotes one band below `CONFIDENCE_MEAN_FLOOR = 0.8`.

That floor is deliberately *above* every vote gate. R only votes at sim ≥ 0.75, A only at
`documented_fact` (0.85), D only at HIGH (0.9). A floor beneath those could never fire on
anything except a lone weak V, which `A5` already sends to LOW — the first implementation used
0.5 and was dead code. Set above the gates, the rule separates a pair that barely cleared its
thresholds from one that cleared them comfortably. The mean rather than the max, so two
marginal sources do not read as one confident source plus a passenger.

### 3. Corroboration is a cascade, cheapest and most discriminating first

`corroborateArtist()`:

1. **Same title.** A title-matched work catalogued to *this* artist → `strong`, stop. Nothing
   else adds to it.
2. Otherwise the artist's **catalogued output**: technique/period (`kOeuvreMatchCount`) and
   subject (`kSubject`). Both → `moderate`; one → `weak`; neither → `none`.

`CORROBORATION_BAND_DELTA` is `strong: +1, moderate: +1, weak: 0, none: −1`, chosen to preserve
the pre-existing A2/A3/A4 spread (HIGH / MEDIUM_HIGH / MEDIUM) now driven by the cascade rather
than raw counts.

**A negative delta applies only at `n === 2`.** At `n >= 3` agreement stands on its own — this
preserves ADR-0010's explicit A1 rule, "K_oeuvre = 0 — noted, not downgraded". At `n === 1` the
band already encodes that source's own confidence, and single-source lots are exactly where
coverage gaps bite, so demoting again would double-penalise. `n === 2` is the one place the
graph is genuinely the tie-breaker.

Holding a band lower on `none` is not treating absence as evidence against: the verdict and the
named artist are untouched, only the certainty attached to them moves.

`kSubject` is therefore now a scoring input, and the prompt line declaring it annotation-only
is corrected.

### 4. `kId` scores nothing

Identity/authority is supplemental context, reported and not weighed. Only **2,187 of 8,018**
ACKG artists (27%) carry a ULAN or Wikidata record, so a missing one is a coverage artifact
rather than a finding. This changes `recognisedNoOeuvre` from A3 to A4.

### 5. Style consistency is an exclusion signal only

`queryArtistStyleConsistency()` compares the submission's DINOv2 vector against one candidate's
catalogued images, **excluding near-identical matches** (dino ≥ 0.90) so the result is
independent of Stage 1d rather than a restatement of it.

Three approaches were measured on A0793/148 before choosing. Two were rejected:

- **CLIP image↔text**, scoped per artist — the correct artist came *second* (Hockney 0.6720,
  Henry Moore 0.6742), with a total spread of 0.005 across all results. CLIP's modality gap
  puts image and text vectors in separate cones, so cross-modal cosines are dominated by the
  gap rather than by content. Useless here.
- **Image↔image without the identity exclusion** — separates cleanly (Hockney 0.9812 vs
  0.94/0.94/0.91) but the top hit *is* the work, so it re-measures Stage 1d and would
  corroborate `D` with `D`'s own evidence. The same circularity this ADR removes from `K`.

The third, adopted, is image↔image with identity excluded — and it **cannot discriminate
between plausible candidates**:

| artist (A0793/148, a Hockney) | best | mean top-5 |
|---|---|---|
| David Hockney *(correct)* | 0.8049 | 0.7820 |
| Henry Moore | 0.8006 | 0.7920 |
| Pablo Picasso | 0.8063 | **0.7991** |
| Banksy | 0.6773 | 0.6660 |
| Damien Hirst | 0.6484 | 0.6229 |

The correct artist came **third**. Among mid-century figurative intaglio printmakers the signal
is measuring tradition and medium family — precisely
[ADR-0002](0002-image-extraction-methodology-and-licensing.md)'s documented false positive, two
artists sharing a style. What it *does* separate is the stylistically alien candidate, ~0.13
below the cluster.

So `applyStyleExclusion()` is strictly one-directional. It may withhold corroboration
(`moderate`/`weak` → `none`) and raise `styleInconsistentWithCandidate`; it may never lift a
band or choose between candidates. Guards: skipped below `STYLE_MIN_COMPARED = 20` embedded
works; ignored when the style evidence names a different artist; and a **`strong` title match
is never overridden**, since documentary evidence that the artist made a work of that name
outweighs stylistic distance from the rest of their output — the flag is still recorded.

`catalogueDescription` of the nearest works is carried through as `supportingText` — narrative
evidence for the report, never scored.

### 6. Where it runs

The style query is async I/O and the tree is pure and synchronous, so `runStage2aTriage` runs
it *before* `runEvidenceTree`, for whichever candidate the agent named, and passes the result
in as a cell. No extra LLM round-trip and no agent variance — the same reason `D` and `D_t` are
built in code.

## Consequences

- **`A8K` is gone.** An ACKG title match alone yields `A11 not_attributed`.
- **`A10` no longer fires from an ACKG disagreement** — only from genuinely competing witnesses.
- **A2/A3/A4 keep their bands** but are selected by the corroboration cascade, not by
  `kOeuvre >= 1` / `kId`. A2 now requires technique *and* subject, which is stricter than the
  old `kOeuvreMatchCount >= 1`.
- **`kSubject` affects confidence.** Both the prompt line calling it annotation-only and the
  Decision 4a line saying the anchor "VOTES" are corrected.
- `Stage1dResult` gains a **transient** `dinov2QueryVector`, stripped in `appraise()` before the
  report is stored. It is passed rather than stashed on the appraiser because
  `appraiserRegistry` holds singletons and instance state would leak across concurrent runs.
- Artist matching in the style query is case-insensitive and accepts `alternateNames`; exact
  matching returned thin results for name variants and the exclusion would never have fired.
- Fixed a latent bug: `liftBand` had no lower clamp. Harmless while every delta was +1;
  the first negative delta would have returned `BANDS[-1]` — `undefined`.
- Tests: `test:two-pass` 90 → 97, `test:stage2a-evidence` 42. Existing scenario/routing tests
  pass unchanged.

## Not addressed

- **Every threshold here is unfitted**, as ADR-0010 Decision 4 already says of its own.
  `CONFIDENCE_MEAN_FLOOR`, `CORROBORATION_BAND_DELTA`, `STYLE_ALIEN_BELOW` and
  `STYLE_MIN_COMPARED` were reasoned from a handful of observations —
  `STYLE_ALIEN_BELOW = 0.72` is read off **a single lot**. `npm run test:pool:triage` over the
  fixture pool is the instrument; it needs Anthropic credit, which was exhausted when this
  landed. **None of this has been validated end-to-end against a live pipeline run.**
- **A and D confidences are ordinal placeholders.** A has only `documented_fact`/`hypothesis`
  to work with; D reports a HIGH/MEDIUM/LOW band while `Stage1dResult` carries the raw
  dino/clip numbers that never reach the cell. Both could be made real.
- **The style signal's discriminating power is untested beyond one lot.** It fired correctly
  against Banksy and Hirst there; whether 0.72 separates alien from plausible in general is
  unknown.
- **Impression-level `clipTextEmbedding` is now unused by attribution.** 53,089 impressions
  carry one and the cross-modal experiment above found no use for it. Text↔text — embedding a
  description of the submission and comparing like with like — was not tried and may be viable.
- **`catalogueDescription` coverage is partial**: 10,026 of the 53,089 embedded impressions
  (19%) kept their source text, so `supportingText` is often empty even when the style
  comparison itself succeeds.
- The **duplicate-artist problem** bites here: a stray `Artist {name: "Picasso"}` node with 1
  work sits alongside `"Pablo Picasso"` with 1,547, and the style query's `LIMIT 1` can pick
  the wrong one. The thin-data guard discards it safely rather than acting on it, but the
  underlying duplication is untouched.
