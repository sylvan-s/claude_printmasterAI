# Plan: attributed-lot valuation — is this upcoming auction lot fairly priced?

**Date:** 2026-09-13
**Status:** Plan, not an ADR. Nothing here is implemented yet. Each step below has a gate; a
step that fails its gate is recorded here and the plan is revised, not silently skipped.

## The use case, restated

Point the system at an upcoming auction lot (URL, catalogue text, image) and get back whether
the estimate is fair, with the attribution checked and the reasons visible.

The pipeline was built to **discover** attribution blind — the backtest harness deliberately
withholds the artist and title. The use case **hands us** the artist and title. That changes
the job from discovery to **verification and pricing**: resolve the catalogue's claim to a graph
node, check that the physical evidence agrees with that node, then price against realised
comparables. Most of that is deterministic work the graph already supports; the expensive LLM
stages become conditional.

## Where the pipeline actually is (main, 2026-09-13)

Read these before touching the code; several assumptions from earlier sessions are stale.

- **Stage 2a no longer chooses graph queries** — [ADR-0018](../adr/0018-stage2a-deterministic-query-plan.md).
  `buildStage2aQueryPlan()` derives candidates from Stage 1c/1b/1d and the VEA signature, resolves
  each through `resolveArtistIdentity` (exact, accent-folded, name or alias — `src/appraisal/knowledge_graph/artist_identity.ts`),
  runs every query before the model is called, and Haiku 4.5 judges the rows. Measured: Haiku on
  the plan is 6x cheaper than Sonnet on the loop and more stable (85% self-agreement on unseen
  lots vs 80%). Residual variance is almost entirely one model-set boolean, `misattributionRisk`
  (4 of 5 unstable lots).
- **The ACKG corroborates, it does not witness** — [ADR-0015](../adr/0015-artist-attribution-confidence-and-corroboration.md).
  `K` no longer votes; sources carry their own confidence; style similarity is exclusion-only.
- **Stage 3 reads graph realised prices first** — [ADR-0016](../adr/0016-ackg-realised-prices-as-primary-comparables.md).
  `queryAuctionComparables()` (`src/appraisal/knowledge_graph/query_comparables.ts`): 48,078 dated,
  GBP-at-sale-date comps (Bonhams 38,663 / Roseberys 8,164 / Skinner 1,251), tiered exact-match
  only (`same_work` > `same_artist_technique` > `same_artist`), self-match excluded in Cypher.
  **Never backtested against hammer prices.** Forum has no realised prices at all.
- **Work-title identity is partially done** — [ADR-0017](../adr/0017-work-title-identity-principal-name-and-aliases.md).
  Principal name + `alternateTitles` + `Impression.sourceTitle` written; the `State` node is
  populated; Decision 1 (decomposing plate/state/translation out of the title string) is not
  implemented. Tier-1 comps inherit every remaining title problem.
- **Splink exists for artist and work identity, offline only** — `knowledge_graph/fit_splink_artist_identity.py`,
  `fit_splink_work_identity.py`, `generate_splink_merge_candidates.py`. It emits ranked review
  queues and writes nothing. Absolute match probabilities are inflated by the blocked frame; only
  the ORDER and the per-field waterfall are trustworthy. It is not a replacement for Stage 2a.
- **A zero-LLM sale screen exists** — `tests/backtest/screen_sale.ts`. Ranks a whole catalogue by
  graph comps vs estimate with sell-through and identity basis. Its two known deflations (Ai
  Weiwei "Cats (Pink)", Shrigley "I hate humans") were identity errors, not price errors.
- **Token usage is logged per call** — `usageSummary()` / `printUsageSummary()` in
  `src/appraisal/appraiser.ts`; `run_evidence_isolation.ts` writes it into `result.json`.
- **PIPELINE.md is stale** (still describes pre-ADR-0014 triage). Treat the code and ADRs as
  authoritative.

## Where the money and the error go

One logged full run (A0793/113, Stage 1a/1b unlogged — different API path):

| Stage | Cost | Share | Note |
|---|---:|---:|---|
| 2b specialist web search (Sonnet) | $0.18–0.22 | 55–65% | fires on every lot regardless of scenario |
| 3 valuation (Sonnet) | $0.07 | ~22% | 12–14k input tokens, mostly re-sent VEA + ASA JSON |
| 2a (Haiku, plan) | $0.02 | ~7% | was $0.09 on Sonnet + loop |
| 1c (Haiku) | <$0.01 | ~2% | |
| **Total logged** | **$0.32–0.35** | | screen_sale.ts quotes ~$0.40 all-in |

Stored backtests (small n, yardstick = catalogue estimate, NOT hammer):

| Regime | n | artist exact | estimate ranges overlap | median midpoint ratio | lots with graph comps |
|---|---:|---:|---:|---:|---:|
| blind | 21 | 14 | 14 | 1.00 (spread 0.31–70) | 6 |
| attributed (`_attr`) | 10 | 7 | 6 | 1.49 (spread 0.15–2.65) | 8 |

Reading: supplying the attribution roughly doubles graph-comp coverage; the number is then
systematically above the house estimate, which may be the house being conservative or the
pipeline being high — hammer prices decide, and we do not have that measurement yet.

## The sequence

### 1. Hammer-price valuation backtest (zero LLM spend) — DO FIRST

**Why first:** nothing else on this list is measurable without it. `valuation_report.ts`
compares to the estimate and says so in its own header.

**What:** `benchmark/data/catalogue.csv` already carries `price_realised_inc_premium` and `sold`
for past Roseberys/Forum sales. Build a report that scores, per lot:
- log(pipeline midpoint / hammer) — the accuracy measure;
- coverage — share of lots with tier-1 / tier-2 / tier-3 / no comps;
- sell-through of the same-work comp set;
- whether the *catalogue estimate* itself bracketed the hammer (the house's own error rate is
  the baseline we have to beat).

Run `screen_sale.ts` over past **sold** sales the same way. If the free screen's ratio predicts
hammer-over-estimate for graph-covered lots, that alone answers "fairly priced" for a large
fraction of lots at $0, and LLM spend goes only on the lots it cannot reach.

**Gate:** a distribution, not a number — does the pipeline sit systematically high or low
against hammer, by tier and by price bracket? Also: does the screen's ratio have any predictive
power at all (rank correlation with hammer/estimate)?

**Watch for:** self-match leakage (the lot's own sale is in the graph — `excludeListingUrl` /
`excludeSaleLot` must be applied); Forum lots have no hammer in the graph but do in the CSV.

### 2. Attributed-lot entry path — the real use case

**What:** a new entry point that takes a lot URL + image. The catalogue's artist and title
enter the Stage 2a plan as `documented_fact` claims (they are what the house printed, not a
guess), resolve through `resolveArtistIdentity` and the ADR-0017 title identity to a
`ConceptualWork`, and go straight to comps. Verification replaces discovery: does the image
(Stage 1d), technique, dimensions and edition agree with the node it claims to be?

**Routing on the outcome:**
- resolved node + tier-1 comps + no divergence → **skip Stage 2b entirely**, run Stage 3 on
  Haiku (ADR-0018's lesson applies: judgement over facts already on the table does not need
  Sonnet). Target: ~$0.10/lot for graph-covered lots.
- scenarios 2 / 4 / 5, or no comps → Stage 2b as today.
- Stage 1a: keep Opus but only for lots that pass the screen; consider a condition-only VEA
  variant for lots where attribution is already resolved.

**Gate:** on the hammer backtest from step 1, the cheap path must be no worse than the full
path on graph-covered lots. Record cost per lot from `usageSummary()` alongside accuracy.

**Watch for:** the house's own attribution can be wrong ("Sunday B Morning" recorded as an
artist; "After X" lots; publisher-as-artist). A `documented_fact` claim still has to survive
Stage 1d and the dimension check. Do not let a catalogue claim short-circuit the tree.

### 3. Splink comparison model as the lot-to-work linkage scorer at Stage 2a

**What:** replace the title-embedding + 0.03 dimension tie band (`breakTitleTieOnDimensions`)
with the fitted work-identity comparison vector (title folded, catalogue citation, technique
family, dimensions, edition, DINOv2) scored against candidate `ConceptualWork` rows, with the
per-field waterfall carried into the trace.

**Why:** the embedding is blind to exactly the discriminators that change price — roman
numerals ("Spinning Man V" vs "VII" = 1.00), plate numbers (`pl. 25` vs `pl. 26` = 1.000),
series siblings ("I hate humans" vs "I Hate Human Beings" at dino 0.958).

**Constraints:** read-only, never a merge — the no-fuzzy-identity rule (`catalogue_matching.py`)
is about WRITES; fuzzy linkage as appraisal evidence is a read, but the tree consumes the
**tier** (exact / strong / weak), never the inflated absolute probability. Splink runs in
Python (DuckDB); the pipeline is TypeScript — either export the fitted weights as a table the
TS side applies, or run it as a sidecar. Exporting weights is simpler and testable.

**Gate:** precision/recall on the labelled pair set built for the work-identity fit
(commit a4c994a), and no regression on the 5 committed fixtures + 10 pool lots.

### 4. Make `misattributionRisk` code-derived

**What:** derive it from cells the tree already has — recorded `conflicts[]`,
`styleInconsistentWithCandidate`, dimension divergence, `ackgTitleMatchNamesDifferentArtist` —
instead of letting the model set it.

**Why:** it is the last model-written cell that moves the scenario (ADR-0018, "riskFlags is
the remaining variance surface").

**Gate:** the stability protocol (5 fixtures x 4 reps, then the 10 unseen pool lots) — the
stable-lot count should rise and agreement should approach 100% on the tree half.

### 5. Comps write-back (ADR-0007) stays gated on Phase 0

`src/appraisal/comp_storability.ts` measures whether Stage 2b comps are storable (key, numeric
price, hammer-vs-premium basis). Until it reports, do not build the write-back.

## Housekeeping done 2026-09-13

- The checkout was on `technique-classifier-deepdive`, 127 commits behind main, which is why
  earlier reads of the ADRs were stale. The three ADR-0019 commits were merged into main; the
  new work branch is `feature/attributed-lot-valuation`, cut from main.
- main's `.gitignore` already covers the merge-session backups/snapshots in `knowledge_graph/`.

## Not decided here

- Whether Stage 1a moves off Opus for attributed lots — measure first.
- ADR-0017 Decision 1 (title decomposition) — needed eventually for tier-1 comps to match
  "Ojai Festival (Baggott 81)" against "Ojai Festival"; not on the critical path for step 1.
- ADR-0019 Phase 1+ (technique features on a rented GPU) — separate track, unaffected.
