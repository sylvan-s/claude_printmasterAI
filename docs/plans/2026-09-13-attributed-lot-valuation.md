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

**Elasticity priors database** (`knowledge_graph/pricing_ml/priors/`, 319 artists): per-artist
log-linear elasticities shrunk toward a similarity-weighted prior from the 10 nearest donor
artists (κ = 60 chosen on later sales). For artists with 15–40 earlier sales the prior alone
matches their own fit and the blend beats own, prior and pooled in every sales band (e.g.
0.679 vs 0.707 own vs 0.689 pooled at 15–40); the estimate stays ~0.3 log better. This is the
adjustment table for same-work comps, per artist, with a fallback for thin artists.

## Follow-on work logged (2026-09-13)

### 6. Integrate the elasticity priors into the graph

Decision (2026-09-13): the priors are a derived layer IN the graph, not a second database.
The committed JSON stays as the build artefact and `build_priors.py` stays the only writer;
the pipeline never writes them.

Schema to add:
- `Artist.priceLevelLog`, `Artist.priceElasticities` (flat float list), `Artist.priceEarlierSales`,
  `Artist.priceElasticitiesRun` — for every artist with >=5 sales, plus segment defaults keyed
  on nationality/period for artists with none.
- One `PricingModelRun` node per build: version, cut, κ, column list, reference levels, year
  effects, continuous medians, row count — so a run is reversible by id (MergeEvent pattern).
- `(:Artist)-[:PRICE_NEIGHBOUR {weight, run}]->(:Artist)` for the neighbours that formed each
  prior (explanation material for the report).

Write discipline as for every other backfill: dry run, pre-snapshot of touched properties,
batched writes, verification query, and a check script that fails when any artist's run tag
predates the latest ingest or merge (the priors go stale on exactly those events).

Read side: `queryArtistPriceProfile(canonicalName)` in `src/appraisal/knowledge_graph/`,
returning elasticities + neighbours; Stage 3's comps block then carries, in code, the
multiplier between the lot and each same-work comp over the attributes that differ (signature,
edition band, size, process). That replaces the guessed "60-70% unsigned discount".

Gate: on the hammer backtest, same-work comps adjusted by the artist's multipliers vs raw
same-work medians, MAE(log) and within-2x on the same lots. Rebuild cadence: after each bulk
ingest or artist-merge pass.

**Step 6 status (2026-09-13): graph layer and read side DONE; Stage 3 wiring NOT done (gate).**
`build_priors.py` 1.1 extends coverage to 745 artists (319 shrunk own fits + 426 prior-only
from 5–14 sales; the prior scores 0.691 vs 0.774 median on that band) and adds 31 segment
defaults keyed nationality group × birth-year period. `knowledge_graph/write_price_priors.py`
wrote run `PRICING-PRIORS-1.1@2026-09-13T16:50:19+00:00`: 1 PricingModelRun, 745 Artists
tagged (all matched by exact name, none ambiguous), 7,450 PRICE_NEIGHBOUR edges; re-run is
idempotent; `check_price_priors_fresh.py` passes (built after the latest MergeEvent 05:27 and
price stamp 16:10; 48,847 sold priced rows then and now). SourceRecord carries no ingest
timestamp, so the check uses the backfill/repair stamps plus the row count as the proxy.
`queryArtistPriceProfile` + `adjustmentBetween` live in `artist_price_profile.ts` with 42 unit
tests; house is excluded from the adjustment until step 7. Next: the gate backtest — same-work
comps × adjustment vs raw same-work medians on the hammer backtest lots.

**Step 6 gate result (2026-09-13): FAILED — the multipliers are not applied in Stage 3.**
`npm run backtest:comps-hammer -- --source {forum|roseberys} --limit 2500 --seed 11 --resolve-work --adjust`
(the step-3 lots; the lot's own attributes read from its graph record so both sides of the
adjustment are classified by the trainer's rules — `price_attrs.ts`, verified identical to
`train_price_model.py` on all 48,847 export rows). Same-work comps re-priced to the lot by
`adjustmentBetween` over signature, proof, edition, size and process (house excluded):

| sold lots with a profile + same-work hammer comps | Roseberys (n=371) raw → adjusted | Forum (n=283) raw → adjusted | estimate × 0.82 |
|---|---|---|---|
| MAE(log), n>=1 | 0.471 → 0.464 | 0.520 → 0.556 | 0.273 / 0.243 |
| MAE(log), n>=2 | 0.401 → 0.438 | 0.532 → 0.566 | 0.284 / 0.239 |
| MAE(log), n>=3 | 0.397 → 0.433 | 0.500 → 0.521 | 0.265 / 0.246 |
| within 2x, n>=3 | 89% → 82% | 76% → 77% | 93% |
| lots the adjustment moved >25% (95 / 87): MAE | 0.670 → 0.649, geo 1.45 → 1.24 | 0.608 → 0.716 | 0.252 / 0.271 |
| Spearman(comp/mid, hammer/mid), n>=1 | 0.234 → 0.231 | 0.077 → 0.059 | — |

The adjustment removes some of the upward bias where it fires hard on Roseberys (geo 1.45 →
1.24) and adds noise everywhere else; on Forum — the cross-house, honest number — it is worse
on every cut. The control (comp attributes identical to the lot's, n=108) is unchanged by
construction. Profile basis does not rescue it: shrunk 0.453 → 0.453 / 0.501 → 0.541, prior
0.560 → 0.497 / 0.786 → 0.808, segment n too small. The attribute that differs most often is
size (area_log on 65-87% of lots), and the fitted size elasticity is the one that mis-prices:
the same print in a different sheet size is usually a different edition, not a scaled price.

**What Stage 3 does with the profile instead:** nothing numeric. The attributed-lot path
lists, per same-work comp, the attributes that differ from the lot (signed / edition / size /
process) as facts, and says in the prompt that applying the fitted multipliers did not beat the
raw comps on 650 lots. The anchor stays estimate × 0.82; the comps stay a band and a
divergence flag. Revisit only with a per-work (not per-artist) model — plate/state/edition are
the price, and an artist-level elasticity cannot see them.

### 7. Cross-house repeat-sale test

Same work, attribute-matched, sold at one house and later at another: the realised spread net
of each house's drift. Tests whether the like-for-like house effect (Roseberys ×0.36-0.95 of
Bonhams) is an arbitrage or a selection artefact. Needed before the house effect is used in a
verdict.

## Step 2 built (2026-09-13) — the attributed-lot entry path

`src/appraisal/attributed_lot.ts` + `AttributedLotAppraiser` (appraiser.ts), method
`claude-4stage-attributed`, harness `npm run backtest:attributed-lot -- --url <roseberys lot url>`
(or `--sale A0785 --lot 1`). 41 pure-function tests (`npm run test:attributed-lot`).

Input: `AppraisalInput.catalogueAttribution` — the house's printed artist (with qualifier),
title, year, medium, edition, signed, dimensions, catalogue refs, estimate, sale/lot/date/URL.
The server route picks the path from the INPUT: any 4-stage method runs it when the field is
present. Flow:

1. Stage 1a/1b/1c/1d as today. The claim is then overlaid on Stage 1c's extraction in code
   (`mergeClaimIntoAppraiserInput`) as `documented_fact`, and `overrideEvidenceCells` forces
   the Stage 2a APPRAISER cells from the claim — the agent's own trust rule is written for
   free-text notes and would tag a printed header as a hypothesis. A qualified attribution
   ("after X") is never an authorship vote. The tree still runs: a lone documented_fact source
   cannot reach Scenario 1, so the claim cannot short-circuit routing.
2. The CLAIM (not the tree's settled artist) is resolved to the graph, then the work
   (`resolveWorkIdentity`, ADR-0017 levels, own record excluded), the work's facts
   (`queryWorkFacts`: techniques, dims, edition sizes, own sell-through) and its comps
   (sale-date cut when the lot is a past sale).
3. `verifyAttributedLot` — artist (identity + tree verdict), work (resolved / ambiguous /
   unresolved), image (Stage 1d best match vs the resolved work), technique (tree match, else
   VEA vs catalogued), dimensions (tree match, else catalogue vs node within 5% / sheet 8%),
   edition (claimed size among the node's edition runs; an unseen size is flagged, not a
   divergence), plus the tree's impression divergence. Verdict: verified / partially_verified
   / divergent / unverifiable.
4. `routeAttributedLot` — Stage 2b is SKIPPED iff: unqualified attribution, work resolved,
   >=1 same-work comp, verdict not divergent/unverifiable, and Scenario not 2/4/5. Otherwise
   Stage 2b runs unchanged. When skipped, `synthesizeAttributionResult` builds the ASA-shaped
   result Stage 3 expects from the claim, the graph and the verification.
5. Stage 3 (Haiku) gets the ATTRIBUTED-LOT EVIDENCE block + `VALUATION_ATTRIBUTED_LOT_SUFFIX`:
   the anchor is the printed midpoint x 0.82 (step 1), same-work comps are a band and a
   divergence flag with the measured bucket base rates, liquidity is the work's own
   sell-through, comp attribute differences are listed as facts (step 6: multipliers not
   applied), and `auctionEstimate.valuationReasoning` (anchor, adjustments with evidence,
   for/against, confidence, what would change it) is mandatory. Report carries
   `report.attributedLot` (claim, verification, routing, comps summary, sell-through, anchor).

Not built: a Forum URL fetcher (Roseberys only), and a UI field for the claim.

### Decisions taken on the path (2026-09-13, evening)

- **Stage 1a and 1b are OFF on the attributed method.** The catalogue states technique, signature,
  edition, dimensions and condition (Stage 1c carries them), and a frontier vision model or a
  Gemini visual search reading a catalogued image is a leakage surface. Measured: Opus vision was
  $0.47 of the $0.74/lot on the six lots that ran with it.
- **Stage 2b uses the client-side (Tavily) web_search on every endpoint** — `clientWebSearch` on
  the method — for traceability and cost. The six earlier lots had silently used Anthropic's
  server-side search; the log now says which ran.
- **misattributionRisk is code-derived on this path** (`deriveMisattributionRisk`): the agent's
  flag survives only when some source names a different artist. Before this, the model set it on
  every lot (6/6), forcing Scenario 2 and Stage 2b on all of them. Step 4 of the plan, applied
  here first.
- **Read-side name compatibility** (`namesCompatible`): the tree's "G Braque" is not a divergence
  from "Georges Braque"; an illegible initial never matches. The graph's identity resolver stays
  exact-match.
- **Image-match work route** (`workTitleFromImageMatch`): when the claim's title does not resolve
  but Stage 1d's best match is the same artist above the DINOv2 floor and the lot title is the
  graph title's core (minus series suffix and bracketed citations), resolve by that exact name.
- **The pricing model is a reference, not arithmetic**: Stage 3 gets the artist's fitted
  multipliers for the lot's attributes and a model-implied factor per same-work comp, and is told
  to cite them as direction/magnitude for named adjustments (step 6 gate).

### Step 3 result on A0793 (upcoming sale of 2026-09-23; ten random single-artist lots, seed 7)

`npm run backtest:attributed-lot -- --sale A0793 --random 10 --seed 7 --dry-run` predicted 3 lots
could skip Stage 2b; all three did. Stage 1a/1b off, Stage 3 on Haiku.

| | lots | cost/lot | time/lot |
|---|---:|---:|---:|
| Stage 2b skipped (16, 47, 64) | 3 | $0.037 | 62-73 s |
| Stage 2b ran, client-side search (3-4 searches) | 7 | $0.199 | 142-211 s |
| all ten | 10 | $0.150 | — |

Against the six earlier lots at $0.74 (Opus vision on, server-side search): 5x cheaper with 2b,
20x cheaper without. Estimate midpoint / drift anchor ranged 0.52-1.28; two lots departed hard —
64 (Bawden, one 2017 comp at 0.59x the anchor fired the "comps well below" flag, -41%) and 420
(Cindy Sherman, 1,200-2,200 vs 3,000-5,000 on edition size + 0/1 sell-through + no
examination). No hammer until 23 September; score with `npm run report:hammer -- --suffix _attrpath`.

### The four observations, fixed (2026-09-13, later)

1. **A lone stale comp no longer fires the divergence flag.** `divergenceSignalUsable`: two or
   more same-work sales always carry the signal; ONE carries it only within
   `LONE_COMP_MAX_AGE_YEARS` (3) of the lot's own sale. Below the bar the comp is still shown
   to Stage 3, labelled "NOT a directional signal". A0793/64 re-run: the -41% "comps well
   below" cut is gone and the 2017 hammer is treated as a floor with its age named.
2. **One typed slip is tolerated on the READ side only** — `knowledge_graph/typo_tolerance.ts`,
   optimal string alignment distance 1 (a transposition counts as one edit; plain Levenshtein
   calls it two, and "Clegry" for "Clegyr" is exactly a transposition). Three guards: designator
   tokens (digits, roman numerals) must be identical on both sides, so "Spinning Man V" vs "VII"
   and "pl. 25" vs "pl. 26" are refused; the differing token must be >=5 characters; every other
   token must match exactly. Applied in three places: `nameSimilarity` (the tree's identity
   fusion — A0793/168's "Storm Thorgeson" vs "Thorgerson" scored 0.50, below TAU_NAME, and the
   tree reported a CONFLICT between two spellings of one man), `sameArtist` in the verification,
   and a LAST-resort `typo_title` level in `resolveWorkIdentity` after every exact level has
   missed. The ACKG's write rule is untouched: nothing here merges, writes or dedupes.
   A0793/168 re-run: Scenario 5 -> Scenario 3, verification DIVERGENT -> VERIFIED.
   A0793/67 is NOT fixed by this and correctly so: "Clegyr Boia I" against a graph node named
   "Clegyr Boia" differs by a numeral, which the designator guard refuses.
3. **Stage 2b can no longer search for the lot it is valuing** — `src/appraisal/search_scope.ts`.
   `sanitizeSearchQuery` strips the sale code and lot number from every query, and the house
   only when the query was already naming this sale (searching "Roseberys" in general is
   legitimate); `filterExcludedResults` drops any result whose URL is the lot's own listing or a
   sibling lot in the same sale. Wired for production, not just the harness: the attributed path
   passes the claim's house/sale/lot/URL, and a harness run derives the same from its exclusion
   string. Prompted by A0793/530, where Stage 2b searched `Nick Smith "Radiant Baby" Roseberys
   lot 530 A0793 realised price sold`. Unit-tested on that exact query; the re-run did not
   exercise it live because the model did not name the sale that time.
4. **Stage 3 no longer treats the absent vision stage as a discount** — suffix clause G: Stage 1a
   is off by design, the catalogue's condition wording IS the condition evidence and should be
   priced, and a further deduction for "no physical examination" double-counts what the house's
   own estimate already reflects. Partially effective on the re-run: A0793/168 went from -15% to
   -5% but still names it. Worth another pass if it persists.

**Found on the way and fixed:** an evidence block the model returns as a malformed JSON string
used to survive as a string and then crash the lot in the cell writers ("Cannot create property
'observedSheetMm' on string", Haiku, A0793/64). `normalizeEvidenceBlocks` now DROPS a string
block that does not parse to a plain object, so it reads as absent; `applyObservedDims` and
`applyCandidateFacts` refuse to write into a non-object block as a second line of defence.

**Also tightened:** suffix clause D (liquidity). The measured base rates need three or more
prior appearances and a sell-through below 50%; A0793/64's re-run converted "sold 1 of 2" into a
-40% cut citing that clause. It now says what the measurement supports and what it does not.

### The two leaking clauses, fixed by moving the verdict into code (2026-09-14)

Stating a threshold in the prompt and leaving the model to apply it does not work. On Bonhams
32240 (Hockney, Old Rinkrank) Stage 3 wrote "with only 2 prior appearances, this is ordinary
auction noise rather than a measured signal (base rates require 3+ appearances)" and took 10%
off anyway, and took a further 15% for "Condition uncertainty ... Stage 1a did not run", which
clause G already forbade. Both clauses had changed the model's language without changing its
behaviour.

The fix follows ADR-0018's rule: decide in code, let the model judge over the answer.
- `liquidityVerdict()` computes the cohort test and the block now carries a line reading
  `MEASURED SIGNAL: YES` or `NO`, with the reason and, on NO, an explicit "take NO liquidity
  adjustment; an adjustment whose evidence cites this history is invalid".
- `conditionEvidenceLines()` lists what the catalogue and the appraiser's notes actually say
  about condition, states that Stage 1a is off by design rather than missing, and closes the
  door on deducting for the absence of an examination.
- Clause D now says "obey the verdict line", not "here is the threshold". Clause G points at
  the condition section. A new clause H governs both: UNCERTAINTY IS NOT A DISCOUNT — read each
  adjustment's own evidence back, and if it rests on something you could not check rather than
  something you found, its magnitude is 0% and it belongs in evidenceAgainst.

Re-run of the same lot, same anchor, same comps: the liquidity adjustment is gone entirely and
appears in evidenceAgainst as "measured signal is NO, so no adjustment applied"; the condition
cut fell from -15% to -5%, and the -5% is now a priced catalogue FACT (framed, where the
comparable was unframed, so the verso cannot be inspected) rather than a hedge. Stage 3 also
emits an explicit 0% line for the absence of examination. The published range did not move
(GBP 1,800-2,600), so this bought honesty in the reasoning rather than a different number.
Cost rose from $0.18 to $0.28 on the longer block and fuller reasoning.

### The dimension check: transposition-tolerant for VERIFICATION, axis-strict for DISCRIMINATION (2026-09-14)

`dimsMatchEitherAxis` tries the swap only AFTER the direct comparison fails, returns
`transposed`, and `DimensionComparison` gained an `axes` field so a swapped match is visible
in the trace rather than silent. `compareDims` uses it; a transposed match reports direction
"equal", because "larger"/"smaller" would be describing the recording error rather than the
object.

Stage 2a's title tie-break deliberately does NOT use it, and the test suite is what established
that. Switching the tie-break to either-axis broke three committed cases: on A0793/113 it
promoted "Spinning Man V" over "Spinning Man VII", because V's catalogued pair is the observed
one transposed. The two callers ask different questions. Verification asks "is this lot the
work it claims to be?", where a swapped pair is a cataloguing convention and tolerating it
avoids a false divergence. The tie-break asks "WHICH of these near-identically-titled siblings
is it?", and there the axes are the discriminator. Tolerating the swap there would hand the
tree the wrong work, which is worse than the problem the tolerance fixes.

Re-run of Bonhams 32240, the lot that exposed it. The fix cascaded further than the dimension
cell: the tree's `later_edition` impression verdict had been resting on the dimension mismatch,
so it cleared too.

| run | routing | verification | adjustments | range | cost |
|---|---|---|---|---|---|
| 1. wrong exclusion key | 2b ran, Scenario 2 | divergent | -12% liquidity, -15% condition, -5% dims | 1,800-2,600 | $0.242 |
| 2. key fixed | 2b ran, Scenario 2 | divergent | -15% condition, -10% liquidity | 1,800-2,600 | $0.179 |
| 3. clauses D/G/H moved into code | 2b ran, Scenario 2 | divergent | -5% framing, -3% dims | 1,800-2,600 | $0.284 |
| 4. dimension check fixed | **2b SKIPPED**, Scenario 3 | **verified** | **none** | 1,800-2,600 | **$0.053** |

The range never moved across all four. Every fix bought correctness of reasoning and a 5x cost
reduction, not a different number — which is the honest reading: this lot was always going to
be priced off its anchor and its one same-work comp, and the adjustments were noise the
pipeline was generating about itself.

Observed, not yet acted on:
- An upcoming lot ALREADY INGESTED into the graph is excluded by saleId + lotNumber, and the
  Bonhams ingest stores preview lots as lotNumber 0 (no number is parseable from a preview
  URL). Keying the claim on the Bonhams internal id missed it, and the lot counted its own
  not-yet-sold record as a failed appearance (1/3 rather than 1/2). Exclusion should also match
  on a normalised listing URL, or the claim should carry the graph's own key.
- Stage 3's own reasoning is where a thin signal now reappears as a large adjustment (A0793/64's
  -40% liquidity cut). The evidence block states thresholds; the prompt has to keep saying which
  side of them the lot sits on.

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
