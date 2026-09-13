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

## Step 1 result (2026-09-13) — the gate did not pass the way the plan assumed

Run: `npm run backtest:comps-hammer -- --source {forum|roseberys} --limit 2500 --seed 11`
(2,500 random lots per house, all qualifiers "certain", multi-work lots excluded, comps cut to
sales strictly before each lot's own sale date, 10-year window, own record excluded). Plus
`npm run report:hammer` over the 35 stored pipeline results (10 of which have since sold).

### What the market does, before anything else

| | Forum (n=1,509 sold) | Roseberys (n=1,731 sold) |
|---|---:|---:|
| hammer inside [low, high] | 48% | 39% |
| hammer below low | 37% | 44% |
| hammer above high | 15% | 17% |
| median hammer / estimate midpoint | 0.83 | 0.80 |
| unsold | 40% | 30% |

The premise in `valuation_report.ts` ("houses estimate conservatively to attract bidding") is
wrong on this corpus: lots clear at ~0.8x the printed midpoint, four in ten sold lots go
below low, and a third do not sell. "Fairly priced" has to be judged against that, not
against the printed range.

### Coverage: the graph reaches the same work on ~14% of lots

| best tier reached (resolved lots) | Forum | Roseberys |
|---|---:|---:|
| artist resolves to a node | 99% | 99% |
| same_work (exact title) | 13% | 15% |
| same_work with >=3 prior comps | 5% | 5% |
| same_artist_technique | 60% | 39% |
| same_artist only | 15% | 23% |
| nothing | 13% | 23% |

The identity resolver is not the bottleneck. Tier-1 title matching is: ~1,500-1,850 lots per
sample have comps for the artist but no same-work match, and most of those titles are
ordinary ("Cats (Red)", "Femmes Fleurs", "Tiger") — variant wording, series suffixes, and
`Untitled (qualifier)` being treated as low-information (`isLowInformationTitle`). This is
ADR-0017 Decision 1 and plan step 3, and it is now the coverage ceiling on everything below.

### Accuracy: same-work comps are usable, other tiers are not, and none beats the estimate

Comp median / realised price (both premium-inclusive), sold lots:

| tier | Forum geo / ±25% / within 2x | Roseberys geo / ±25% / within 2x |
|---|---|---|
| same_work, >=3 comps | 1.20 / 35% / 75% | 1.13 / 43% / 89% |
| same_artist_technique, >=3 | 1.32 / 25% / 61% | 1.25 / 24% / 65% |
| same_artist, >=3 | 1.74 / 16% / 43% | 1.49 / 19% / 53% |

Same-work comps run 10-20% above what the lot then made, and land within 2x three
quarters of the time. Same-artist comps are not a price. (Forum's premium is assumed at 1.30;
if Forum's real ratio is higher, its comps look slightly less high.)

**The decisive comparison** — predictors of hammer on the lots with >=2 same-work comps:

| predictor | Forum (n=139): ±25% / 2x / MAE(log) | Roseberys (n=156): ±25% / 2x / MAE(log) |
|---|---|---|
| catalogue midpoint | 61% / 96% / 0.254 | 47% / 93% / 0.321 |
| **catalogue midpoint × 0.82** | **64% / 95% / 0.241** | **53% / 91% / 0.288** |
| same-work comp median (÷ premium) | 29% / 78% / 0.508 | 43% / 86% / 0.398 |
| geometric blend of both, both debiased | 49% / 91% / 0.308 | 52% / 88% / 0.300 |

The house's own estimate, scaled by the market's known 0.82 drift, is the best point
predictor of hammer available, and adding the comps to it makes it worse. On the
same_artist_technique tier the gap is larger still. Spearman of (comp median vs estimate)
against (hammer vs estimate) is 0.28-0.30 on Roseberys same-work lots and 0.06-0.10 on
Forum — the graph's comps are mostly same-house Roseberys results, so the Forum figure is
the honest cross-house number.

### What the comps DO carry

- **Liquidity.** Prior sell-through of the same title below 50% → 41-52% of lots go unsold,
  against 22-32% otherwise. This is the one clean, cross-house signal in the data.
- **A directional flag on Roseberys.** Same-work comps > 1.5x the estimate: 33% hammer above
  high (base 19%), 9% unsold (base 22%). Comps < 0.67x: 62% below low (base 36%). Weak and
  same-house, but real.
- **Nothing extra on Forum.** Buckets barely move off the base rate.

### The pipeline runs high

Ten stored blind runs now have a hammer: hammer inside the pipeline's range 5/10, inside the
catalogue's 6/10; pipeline midpoint / hammer geo-mean 1.83 (one Gauguin at 61x; median 1.43),
pipeline midpoint / realised 1.40. Of 21 unsold lots, the pipeline's LOW sat above the
catalogue low on 12. Part of this is basis (ADR-0016 comps are premium-inclusive, the prompt
asks for a hammer-basis estimate — ~1.3x by construction) and the rest is the same upward
bias the comps show. Ten lots is not a measurement of accuracy; the direction is consistent
with everything above.

### What this changes in the plan

1. **Step 2's cheap path cannot price from comps.** A "resolved node + tier-1 comps → price
   from the graph" route would be worse than reading the catalogue estimate and scaling it.
   The cheap path is instead: **estimate × 0.82 as the anchor**, with the graph supplying
   sell-through (liquidity) and the same-work divergence flag, and Stage 1d/dimensions
   supplying attribution verification. The LLM stages earn their cost only where the
   catalogue claim fails verification or the lot is off-catalogue.
2. **Step 3 (title identity → tier-1 coverage) moves ahead of step 2** in leverage: tier-1
   coverage is 14% and it is the ceiling on every graph signal.
3. **Stage 3's prompt basis must be fixed** before any LLM valuation is compared again:
   either ask for a premium-inclusive number or divide the comps. Cheap, and it removes a
   1.3x confound from every future run.
4. **The house's estimate is the baseline any valuation must beat**, and on this data it has
   not been beaten. Report every future accuracy figure next to "estimate × 0.82".

### 3-year window: same conclusion, less coverage

Re-run with `--window-years 3` on the identical 2x2,500 lots. Same-work coverage falls
(Forum 13% → 9%, Roseberys 15% → 12%) and the upward bias does not go away (same_work >=3:
geo 1.15 Forum, 1.26 Roseberys). Head to head on same_work n>=2 lots, MAE(log): estimate ×
0.82 = 0.256 / 0.298, comps = 0.456 / 0.396, blend = 0.289 / 0.298 (Forum / Roseberys). A
stale window is not why the comps lose; the blend at best ties the estimate. Ten years stays
the default because it reaches more lots for the liquidity and divergence signals.

## Stage 3 price basis fixed (2026-09-13)

Every dated auction record carries `hammerPriceGBP` (48,078 of 48,078). `queryAuctionComparables`
now returns it per comp plus `medianHammerGBP` / `medianSameWorkHammerGBP`; Stage 3's comps block
and prompt anchor `auctionEstimate` on hammer, never on realised; `recentAuctionSales` keeps the
realised figure (that field is what buyers paid). The prompt also says tier 2/3 comps are a
plausibility band, not a price (measured within-2x 60% / 50%), and carries the market-reality
line (hammer ~0.8x midpoint, 40% of sold lots below low, a third unsold). A sold record with a
hammer but no realised price is now a comparable (643 Roseberys records were excluded).

One live run after the fix (A0785/1, Picasso etching, hammer 420, catalogue 300-500) still said
1,200-2,500: no same-work comp, and the model centred on 40 same-artist-technique comps. That is
the tier-2 problem the prompt line now addresses; one lot is not a measurement.

**Performance defect found on the way, fixed for the comps query only:** matching the artist as
`cypherFold(a.name) = $x` is not indexable and with the traversal attached the planner walks the
graph from SourceRecord — 3.3-4.6 s per call against 24-80 ms from the `artist_name` index. The
comps query now resolves the exact stored name first. Eight other queries (artist_dino_floor,
artist_identity, catalogue_raisonne x4, edition_runs, query.ts x2) carry the same pattern — a
spawned follow-up task.

## Step 3, first slice (2026-09-13) — lot -> work identity in code

`src/appraisal/knowledge_graph/work_identity.ts` (`resolveWorkIdentity`, 44 unit tests on real
strings). Five levels, first UNAMBIGUOUS level wins, an ambiguous level refuses: exact title
(name / alias / source title) → citation → citation narrowed by title → stripped title
(citations, years, leading catalogue numbers removed; residual must still be identifying) →
stripped title ignoring a `, from <series>` suffix. Plate, state, series and colourway
designators are never stripped. Wired into Stage 3 and the Stage 2b comps tool; the basis is
reported to the model. The backtest resolves with the lot's OWN record excluded, since a
production lot is not in the graph yet.

Same 2x2,500 lots as step 1 (`--resolve-work`):

| | Forum baseline → now | Roseberys baseline → now |
|---|---|---|
| lots reaching same_work | 315 (13%) → **403 (16%)** | 378 (15%) → **478 (19%)** |
| same_work with >=3 prior comps | 128 → 139 | 125 → 133 |
| same_work >=3 comps, within 2x of realised | 75% → 76% | 89% → 88% |
| resolved by citation / citation+title | 66 + 16 lots | 38 + 3 lots |
| resolved by stripped title / no-series | 120 + 24 lots | 54 + 20 lots |
| refused as ambiguous | 23 lots | 4 lots |
| no resolution at all | 849 (35%) | 1,264 (51%) |

About a quarter more lots reach the same-work tier and overall accuracy does not move. Per
basis, citation matches are as accurate as exact ones (within 2x 87%). Stripped-title matches
are weaker on Forum (within 2x 57%, n=28; p10 0.31) and fine on Roseberys (82%, n=17) — small
n, but a sibling-work risk worth an adjudication step. The head-to-head predictor result is
unchanged: estimate × 0.82 still wins.

**What is left on the table is not wording.** 35-51% of lots resolve to nothing: the work is not
in the graph under any spelling, or it is there under a name no exact rule reaches. That is the
second slice — the Splink work-identity comparison vector (title similarity, citation, technique
family, dimensions, edition, DINOv2) as a scored, tiered candidate ranker, with the
stripped-title matches adjudicated by dimensions and image the same way.

## Does adjusting tier-2 comps for signed / edition / condition rescue them? (2026-09-13)

Prompted by the Picasso lot above. Stage 3 DID know the lot was unsigned, edition of 200,
framed, very good condition, and applied a 60-70% unsigned discount to a signed-edition-of-50
population — and still landed 3x high, because the discount needed was ~90% and the one truly
comparable comp (an unsigned large-edition plate at 950 hammer) was used as a floor, not the
anchor.

Two data facts found on the way: `Impression.signed` is set on every sold comp and
`EditionRun.declaredSize` on 69% of them, and the comps query had been reading `er.editionSize`,
a property that exists on 0 of 127,305 edition runs — so Stage 3 saw a null edition size on
every comp it was ever shown. Fixed (`coalesce(er.declaredSize, …)`); `signed` now rides on
each comp row.

Measured (`--stratify`, same 2x2,500 lots): tier-2 comps restricted to the lot's signed status
and edition band, against plain tier 2 and the estimate, on the same sold lots:

| | Forum (n=687) MAE(log) / within 2x | Roseberys (n=469) MAE(log) / within 2x |
|---|---|---|
| plain same_artist_technique median | 0.635 / 65% | 0.561 / 72% |
| signed + edition band matched | 0.577 / 69% | 0.553 / 72% |
| catalogue midpoint × 0.82 | 0.226 / 94% | 0.268 / 94% |

Stratifying helps a little and consistently, and it does not change the conclusion: a same-
artist population is not a price even when segmented (its 10th-90th percentile still spans
~10x), because the specific print — which plate, which state, which edition — dominates, and
the house's estimate already prices that lot. Signed status and edition size belong in the
prompt as facts about each comp (now present) and as filters on tier 2, not as a licence to
anchor on tier 2.

## Pricing model, first test on Picasso (2026-09-13)

`knowledge_graph/pricing_ml/` — an attribute model (technique, signature, condition, citation,
edition size, bucketed dimensions, plus paper/publisher/work year) on 1,385 Picasso sales,
temporal split, test = 212 sales from 2024-07. Full write-up in its README.

| predictor | MAE(log) | within 2x |
|---|---:|---:|
| artist median | 0.794 | 60% |
| attributes only | 0.601 | 71% |
| attributes + same-work prior | 0.575 | 72% |
| house estimate midpoint | **0.340** | **91%** |
| attributes + prior + estimate | 0.358 | 87% |

Signature is the dominant attribute (hand-signed ×2.2 over unsigned); edition size, sheet
size, paper/suite and process follow. Condition could not be modelled: no condition field is
ingested and Bonhams stopped writing condition sentences in 2020. The attributes do not add
to the house estimate, which already prices them plus rarity and state — the largest misses
are "one of four recorded impressions" and "a rare aquatint". Useful as an adjustment table
for same-work comps and as a from-scratch fallback (71% within 2x, better than tier 2), not as
a replacement for the estimate.

Data defect found: Bonhams' stored `estimateLowGBP/HighGBP` equal the hammer (API field is
overwritten post-sale). Repaired 2026-09-13 by `knowledge_graph/repair_bonhams_estimate_gbp.py`:
39,851 collapsed Bonhams+Skinner rows rewritten as native ÷ sale-date FX, and 15,034 Roseberys/
Forum rows (which never had a GBP estimate) filled the same way — 54,890 rows, old values kept
under `estimate*GBPBeforeRepair`. `bonhams_ingest.py` no longer writes the API field and
`backfill_fx_gbp.py` now owns every GBP estimate; `check_bonhams_estimate_gbp.py` guards it.
`query_comparables.ts` reads the stored property again. Honest hammer-at-low-estimate sales
remain: 5,132 of the 39,851 sold Bonhams+Skinner rows, down from every one of the 15,386
GBP-native rows.

**Transfer test, ten artists (7,522 sales):** multipliers do NOT transfer cleanly. Mean MAE(log):
own-artist model 0.69, pooled shared slopes 0.76, Picasso's slopes + own level 0.84, artist
median 1.09, house estimate 0.34. Editions over 300 are ×0.14–0.50 for Chagall/Lichtenstein/
Warhol/Picasso but ×1.1–1.2 for Banksy/Hockney/Hirst; screenprint ×5.8 for Banksy; signature
×1.5 Rembrandt vs ×3.4 Hirst. Like-for-like house effect: Roseberys ×0.36–0.95 of Bonhams
(pooled ×0.51), partly selection. Details in `knowledge_graph/pricing_ml/README.md`.

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
