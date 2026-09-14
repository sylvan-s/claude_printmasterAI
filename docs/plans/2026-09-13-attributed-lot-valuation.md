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

### 5. Comps write-back (ADR-0007) — BUILT 2026-09-14

Phase 0 reported: on the first attributed lots to reach it, `comp_storability` scored 4/4
storable on key and price and 0/4 on hammer basis — every comp came back premium-inclusive.
The write-back was built anyway, with that as the load-bearing gate rather than a reason not
to start, because the alternative is discarding a hammer comp on the day one appears.

`src/appraisal/knowledge_graph/write_research_comps.ts`. One SourceRecord per comp, linked
straight to the ConceptualWork:

    (:SourceRecord {sourceType:'agent_research', reliabilityTier:'agent_derived'})
       -[:PRICES]->(:ConceptualWork)  and  -[:ATTRIBUTED_TO]->(:Artist)

No Impression and no EditionRun are created. An ingested auction record hangs off an Impression
because the catalogue describes a specific sheet; a web result says a sale of THIS WORK happened
at a price and does not say which edition run. Inventing an Impression would assert the thing we
did not learn. That shape is also the containment: `queryAuctionComparables` walks
ConceptualWork -> EditionRun -> Impression <- SourceRecord and filters `sourceType = 'auction'`,
so these rows are structurally unreachable from it and cannot become silent peers of Bonhams
data. `queryResearchComps` is a separate, opt-in read (ADR-0007 Decision 4).

**Basis: the first cut admitted hammer only, and that was wrong (corrected same day).** It
conflated putting a premium-inclusive figure in the HAMMER field — the 25-30% error
repair_bonhams undid across 39,914 rows — with RECORDING a premium figure as what it is, which
is what every ingested record already does. The SourceRecord schema has carried both since the
start. Each number now goes in the field matching its basis, `priceBasisRecorded` states it
outright so no reader infers it from which field is populated, and a premium figure leaves
hammer NULL rather than being divided by a guessed premium schedule. What stays refused is
"unknown": a number with no stated basis cannot go in either field without a guess. The old
gate threw away 4 of 4 comps on the first lots for no safety gain.

Seven gates, each from a specific failure: a determinate basis, hammer or premium-inclusive,
never unknown; a citation URL
(ADR-0007 Decision 3, and it is the dedupe key); a numeric price and a currency code; a sale
date and a house; the artist MATCHed never MERGEd (ADR-0007 Decision 5); the work resolved on an
UNAMBIGUOUS EXACT basis only — exact_title / citation / citation_and_title, never the
stripped-title or typo-tolerant levels, because the no-fuzzy rule is about writes; and the sale
not already in the graph by URL or house+sale+lot. GBP is set only for GBP-native prices;
everything else is left to `backfill_fx_gbp.py`, which owns sale-date FX.

Verified end to end 2026-09-14 against the live graph with synthetic records, since no real
comp has yet reached the writer: hammer, premium-GBP and premium-USD rows each land in the right
field (the USD row keeps its native price with GBP left null for `backfill_fx_gbp.py`, and both
premium rows leave hammer null); an unknown-basis row is refused; a comp whose sale is already
ingested is skipped naming the existing record (`bonhams-32236-108-record`); a re-run is
idempotent on the deterministic id, which keys on the SALE and not the basis;
`queryAuctionComparables` cannot see any written row; and all four batch refusals fire
(read-side work basis, attribution below probable, work unresolved, artist absent). Every
synthetic record was deleted; the graph holds no agent_research SourceRecords.

Two bugs the tests caught rather than review: `Date.parse("23 June 2026")` plus `toISOString()`
wrote 2026-06-22 under BST, and V8 accepted "summer 2026" as a date. Dates are now formatted
from local components and a string naming no day is refused.

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

### 8. Deterministic Bayesian price blend — the priors model, the comps and the estimate as witnesses

**Logged 2026-09-14. Not built. Gated on the same hammer lots as step 1.**

**Why.** Stage 3 today anchors on estimate × `ESTIMATE_DRIFT` (0.82) and hands the comps, the
liquidity verdict and the price profile to Sonnet as prose; the model writes the number. Three
things are wrong with that. The number is not reproducible run to run. The 745-artist priors
layer (step 6) contributes nothing numeric after its gate failed as a *correction to comps*.
And there is no answer at all when the lot has no printed estimate — the user's own object, a
dealer price, a private sale — which is the case the product exists for.

**Decision.** Every price source becomes a witness that emits a distribution over
`log(hammer GBP)`. A deterministic combiner multiplies the witnesses' densities (after
de-biasing) into one posterior, reports the median, an 80% interval, and the sale
probability, and writes down each witness's contribution. Sonnet's job at Stage 3 shrinks to
narration of a table it did not compute: the priors model's additive log-contributions, the
comps and the attributes on which they differ, the sale probability, and the divergence
between witnesses. It never touches a number.

**Witnesses and where their inputs already exist.**

| Witness | Mean in log space | Spread source | Measured MAE(log) → sigma (≈ MAE × 1.25 for Gaussian residuals) |
|---|---|---|---:|
| House estimate | log(midpoint) + log(0.82) | step-1 residual, per house | 0.24–0.28 → ~0.33 |
| Same-work comps (`ComparableTier` = `same_work`, `queryAuctionComparables`) | log of hammer medians, FX at sale date | repeat-sale model, see below | 0.40–0.50 at n≥3 → ~0.56 |
| Tier 2/3 comps (`same_artist_technique`, `same_artist`) | log median | own backtest residual (wide) | not yet measured on hammer; treat as a band |
| Priors model (`queryArtistPriceProfile`, `Artist.priceLevelLog` + `priceElasticities`) | level + Σ elasticity × attribute | per-`PriceProfileBasis` residual from `build_priors.py` | shrunk 0.60–0.69, prior 0.69, segment untested → ~0.80 / 0.86 |

Relative precision (1/sigma²) with all four present is roughly 9 : 3 : <1 : 1.5. With an
estimate, the posterior is mostly the estimate — that is what the step-1 and Picasso results
already say, and the blend must not lose to it. Without an estimate the priors + comps ARE the
answer, and that is the regime the gate is really about.

**Four corrections to the naive product, each with its fix.**

1. *The witnesses are correlated.* The house saw the same comps we did, so estimate and comps
   share error and multiplying nominal precisions double-counts it. The weights are therefore
   NOT the nominal 1/sigma²: fit them on the hammer lots by minimising log score (equivalently
   regress log hammer on the de-biased witness means), calibrate on Roseberys, test on Forum as
   the cross-house holdout. This is a linear opinion pool with learned weights — the
   "attributes + prior + estimate" row at 0.358 vs 0.340 lost precisely because it was not.
2. *Comps spread must depend on the evidence.* Same-work: sigma² = tau² + s²/n, where tau is
   the between-sale dispersion of the SAME work (measured from the repeat-sale pairs — step 7
   supplies it; until then use the n≥3 residual as the floor) and s²/n shrinks with the number
   of comps. Comp age widens sigma (`compAgeYears`, `LONE_COMP_MAX_AGE_YEARS` as the existing
   cut). Tier 2/3 get their own, much wider, backtest residual and so act as the plausibility
   band they already are, with no prompt language needed.
3. *Liquidity is a hurdle, not a shift.* Never-sold works go unsold 41% vs a 30% base
   (`liquidityVerdict`); that is P(sells), not a lower price. Report P(sells) and the price
   distribution conditional on selling separately. Do not fold the 9–15%
   (`LIQUIDITY_TYPICAL/MAX_PRICE_ADJUSTMENT`) into the mean; keep it, if at all, as its own
   witness with its measured spread.
4. *Gaussian tails are too thin.* The Picasso misses were "one of four recorded impressions"
   and a rare aquatint. Evaluate the product on a fixed grid over log-price (e.g. 400 points,
   log 10 GBP to log 10M GBP) instead of closed form: still deterministic, negligible cost,
   Student-t witnesses drop in, and the same-work witness can be a kernel density over the
   actual comp prices rather than one Gaussian — signed and unsigned impressions of one plate
   stay bimodal instead of averaging to a price nobody paid.

**Why the priors model belongs here after failing the step-6 gate.** The gate applied
artist-level elasticities as a *correction to same-work comps* and the size elasticity
mis-priced because a different sheet is usually a different edition. As a separate witness the
same failure is contained: with strong same-work comps the model's wide sigma gives it a small
weight; without comps it is the best from-scratch number we have (71% within 2x on Picasso,
0.691 vs 0.774 median on the 5–14-sales band). Log-linear is the right model here and not
CatBoost: at 5–40 sales per artist a tree model has nothing to learn, and the log-linear
contributions are exactly additive (coefficient × attribute), so the explanation table is free
and exact rather than an approximate SHAP.

**Contract (proposed, `src/appraisal/knowledge_graph/price_blend.ts`, pure, no I/O).**

```ts
interface PriceWitness {
  source: "estimate" | "same_work" | "same_artist_technique" | "same_artist" | "priors_model";
  mu: number;            // log GBP, bias already removed
  sigma: number;         // calibrated, not nominal
  weight: number;        // fitted pool weight, 0..1; 0 drops the witness
  df?: number;           // Student-t degrees of freedom; undefined = Gaussian
  samples?: number[];    // log GBP; when set the witness is a KDE over these, mu/sigma are summary only
  basis: string;         // human-readable: "n=4 same-work sales, latest 2024-11", "shrunk fit, 37 earlier sales"
  contributions?: { term: string; logEffect: number }[];  // priors model only: level, per-attribute terms
}
interface PriceBlend {
  grid: { logPrice: number; density: number }[];
  medianGBP: number; p10GBP: number; p90GBP: number;
  pSells: number | null;                // hurdle, from liquidityVerdict; null when no history
  witnesses: (PriceWitness & { effectiveWeight: number })[];
  divergence: { a: string; b: string; logGap: number }[];   // pairs > 0.5 apart: the identity-check flag
}
function blendPrices(witnesses: PriceWitness[], hurdle: { pSells: number } | null): PriceBlend
```

The divergence list is the feature that caught Ai Weiwei "Cats (Pink)" and Shrigley "I hate
humans" — both were identity errors visible as estimate-vs-comps gaps, and it becomes a coded
flag rather than something the model has to notice.

**Calibration artefact.** One committed JSON per fit (`pricing_ml/blend/`), the pattern of
`priors/`: per-witness bias, sigma by regime (house, tier, n-band, basis), pool weights, the
lot set and seed it was fitted on. Stage 3 reads it; nothing in the pipeline writes it. Goes
stale on the same events as the priors (`check_price_priors_fresh.py` extends to cover it).

**Gate (zero LLM spend).** Extend `tests/backtest/comps_hammer_backtest.ts` with `--blend`,
same lots and seed as step 3 (`--source {forum|roseberys} --limit 2500 --seed 11 --resolve-work`),
fit on Roseberys, score on Forum. Two regimes, one table:

| regime | baseline | blend must |
|---|---|---|
| estimate present | estimate × 0.82 (MAE(log) 0.24–0.28, 93% within 2x) | not lose on MAE(log) or within-2x; 80% interval covers 75–85% of hammers; CRPS ≤ baseline's Gaussian |
| estimate withheld | best single witness (same-work n≥3 ≈ 0.40–0.50; priors model ≈ 0.69 when no comps) | beat it on MAE(log); coverage 75–85%; report the split by best tier reached |

Also report, per regime: MAE(log) with and without the priors witness (its marginal value),
the fitted pool weights, and Spearman of the divergence flag against absolute error (does the
flag point at the lots the blend gets wrong).

**Not decided here.** Whether the house effect enters as a witness bias (waits on step 7);
whether tier 2/3 stay in the pool or are display-only once measured; the prompt rewrite for
Stage 3 — that is a wiring change to live price predictions and is not started until the gate
passes and is agreed separately.

## Step 8 built and gated (2026-09-14) — the blend ties the estimate and does not yet clear the no-estimate gate cross-house

**Built.** `src/appraisal/knowledge_graph/price_blend.ts` (pure; 53 unit tests,
`npm run test:price-blend`): witnesses from `BlendInputs`, `priorsModelPrediction` (the
artist's log-linear model on the lot's own attributes with the sale-year effect added back —
`ArtistPriceProfile` now carries `yearEffects`), a 601-point grid posterior over log price with
Student-t witnesses and a kernel density for same-work comps, the hurdle, the divergence list,
and `fitBlendCalibration` (bias + sigma per witness per key; pool weights by coordinate descent
on MAE(log) of the posterior median, constrained never to drop a lot's only witness; a
temperature for 80% coverage). `comps_hammer_backtest.ts --blend` records the witness inputs
per lot (one profile read per artist, one attrs read per lot; 0.28–0.35 s/lot). `blend_gate.ts`
fits on one file and scores on another in ~22 s, zero LLM, zero graph. The calibration JSON
lives at `knowledge_graph/pricing_ml/blend/calibration.json` (README beside it). Nothing in
Stage 3 reads any of it.

**Runs.** `--source {roseberys,forum} --limit 2500 --seed 11 --resolve-work --blend`:
Roseberys 1,714 sold lots with inputs (17 no profile), Forum 1,504 (5). Every resolved artist
gets a priors witness (segment default as the floor); same-work hammers on 481 / 404 lots.

**Fitted on Roseberys.** Estimate bias ×0.80, sigma 0.33. Same-work sigma 0.54 / 0.40 / 0.44
at n = 1 / 2 / 3+. Tier 2 sigma 0.72, tier 3 1.00. Priors model: shrunk and prior bases
unbiased (sigma 0.58), segment basis ×0.41 (sigma 0.88) — the segment default over-prices thin
artists by 2.4x. Weights with estimate {estimate 3, same_work 1.5, priors 1.5, tiers 0};
without {same_work 2, priors 2, tier 2 0.5, tier 3 0.25}.

**Gate, fit Roseberys → score Forum (artist-cluster bootstrap, 424 artists, 1,000 draws):**

| regime | baseline | blend | verdict |
|---|---|---|---|
| with estimate (n=1,504) | midpoint × 0.82: MAE(log) 0.277, 90% within 2x | 0.288, 90%, 80% interval covers 82% [79, 84] | MAE +0.011 [+0.006, +0.016] — a real, small LOSS; with the priors witness weighted 0 it is +0.001 [−0.002, +0.004], a tie |
| no estimate (n=1,504) | best single de-biased witness: 0.802, 57% | 0.778, 58%, covers 62% [58, 65], geo 1.445 | MAE −0.024 [−0.069, +0.016] — not significant; coverage FAILS |

**Why the no-estimate regime fails cross-house, and the two runs that show it.** On Forum the
blend and the priors witness both read ~1.45x high (geo). Re-fitting the priors bias on Forum
gives ×0.71 (shrunk) and ×0.22 (segment) against ×1.00 / ×0.41 on Roseberys: Forum sells at
a lower level than the model's Bonhams reference house, and Forum is a house the model never
saw (`house_Forum Auctions` is in every lot's `priorsUnknownColumns`), so nothing in the
Roseberys fit can carry the offset over. Tier 2/3 comps show the same thing in the same
direction (geo 1.12 / 1.41 on Forum, ~1.0 in-sample) because a Forum lot's comps are Bonhams
sales. That is the like-for-like house effect of step 7 arriving as a witness bias.

| direction | with-estimate blend vs midpoint × 0.82 | no-estimate blend vs best single | 80% coverage (no est.) |
|---|---|---|---|
| Roseberys → Forum (the gate) | 0.288 vs 0.277 (loses; ties without priors) | 0.778 vs 0.802 | 62% |
| Forum → Roseberys | 0.307 vs 0.310 (tie) | 0.636 vs 0.719 | 85% |
| Forum half A → Forum half B (within house) | 0.267 vs 0.266 (tie) | 0.670 vs 0.747 | 84% |

Within-house and in the reverse direction the no-estimate blend beats the best single witness
by 0.08 log with coverage inside the 75–85% band. Split by the best evidence a lot has (Forum
→ Forum): same-work n≥3 0.397 vs 0.397, n=1–2 0.429 vs 0.459, tier 2 only 0.624 vs 0.731, tier
3 only 0.941 vs 1.036, priors only 1.034. The priors witness is what carries the gain: with it
weighted 0 the blend is worse on every tier (tier 3 only 1.52 vs 1.04 cross-house).

**Verdict.** With an estimate: the blend adds nothing to estimate × 0.82, and the fitted
Roseberys weights make it slightly worse — consistent with step 1 and the Picasso test; the
right with-estimate weight for the priors witness is 0. The interval and the divergence flag
are the useful outputs there: coverage 82% out of sample, and flagged lots (a >0.5 log gap
between witnesses) carry MAE 0.331 vs 0.210 unflagged on Forum, Spearman 0.26 — the
identity-check signal, now in code. Without an estimate: the blend is the best number we have
and its interval is honest *within a house*; across houses it inherits the house-level offset
of every witness, and the gate as written (fit Roseberys, score Forum) fails on coverage. The
blend is not wired into Stage 3.

**What would clear it.** Key every witness's bias by the LOT'S house as well as its own key —
which is step 7's house effect measured as a witness bias per house, and needs hammer lots from
the house the lot will sell at (Roseberys and Forum both have them; a user's own object needs
the house it would sell at chosen, and the report should say so). The segment-basis priors
witness needs its own sigma floor or a lower weight (×0.41 bias with sigma 0.88 is a
plausibility band, not a price). Age of the latest same-work comp was not used as a key. None
of this is started.

**Compute.** Two 2,500-lot harness runs ≈ 12 min each; a gate fit + score ≈ 22 s; $0.

### 9. Estimate-residual model — the "house incentives" node in a causal read of the pipeline

**Logged and built 2026-09-14.** Prompted by re-reading step 8's blend gate causally: with an
estimate present, dropping every comps witness moved Forum MAE(log) from 0.288 to 0.287 —
nothing — and dropping the priors witness moved it from 0.288 to 0.278, an *improvement*. Read
as a graph rather than a set of witnesses to combine, that is near-total mediation:

```
provenance/priors ─┐
                    ├──→ house estimate ──→ hammer
market comps ───────┘         ↑
house incentives (latent) ────┘
```

Once the estimate is known, comps and provenance add almost nothing further to hammer — the
estimate is close to a sufficient statistic. Nothing in the pipeline modelled the estimate
itself before this; `price_blend.ts` treats it as one witness among several, correcting for its
correlation with comps only implicitly (down-weighting comps rather than saying why). This step
asks the upstream question: does the estimate follow from provenance + comps alone, and what's
left over — the closest measurable proxy for the fourth, latent node above.

**Built.** `src/appraisal/knowledge_graph/estimate_model.ts` (pure; 14 unit tests, `npm run
test:estimate-model`): a small hand-rolled ridge regression (Gaussian elimination on the normal
equations, 9 columns, no new dependency) fitting `log(estimate midpoint) ~ same-work comps +
tier comps + priors model`, deliberately WITHOUT a house term, reusing `rawWitnesses` from
step 8 so the predictors here are the identical numbers price_blend treats as alternatives to
combine — this model asks whether they instead explain the estimate. `residualsByHouse` groups
the residual by house: how far that house's estimates sit from what provenance + comps alone
would predict. `tests/backtest/estimate_residual_report.ts` runs it on the two `--blend` files
from step 8 (Roseberys = A, Forum = B, 2,471 / 2,486 lots with an estimate — every lot, not
just sold ones, since the target exists pre-sale) and reports three things: the pooled residual
by house, whether the fitted RELATIONSHIP (not just the level) transfers across houses, and
whether the estimate-side residual matches or diverges from the already-known hammer/estimate
gap.

**Result.**

| | Roseberys (A) | Forum (B) |
|---|---|---|
| Pooled-model residual (provenance+comps → estimate), 95% CI (artist-clustered bootstrap) | +0.040 [-0.011, +0.075] — not significant | -0.117 [-0.191, -0.041] (×0.89) — significant |
| Hammer / estimate-midpoint, sold lots | ×0.80 (n=1,714) | ×0.83 (n=1,504) |

Roseberys's printed estimate tracks provenance + comps about as well as a pooled log-linear
combination of that evidence would — its residual is indistinguishable from zero. Forum's
printed estimate runs measurably lower than the same evidence would predict, independently of
and on top of the fact that hammer then lands below BOTH houses' own midpoints by a similar
~20%. That second gap (hammer vs each house's own printed midpoint) is close in size for both
houses and is not what the estimate-side residual is measuring — it looks like a separate,
buyer-side effect (the midpoint sits above where hammer typically clusters for both houses,
consistent with `ESTIMATE_DRIFT = 0.82` already being fit against the midpoint rather than the
low estimate). The two houses differ in a *third* place: how far their PRINTED number sits from
what a valuer with only provenance and comps would write.

**Cross-house transfer says the two houses don't just differ by a flat amount — they weigh the
same evidence differently.** Fitting separately: same-work comps get coefficient 0.363 on
Roseberys vs 0.231 on Forum; tier-2 (same-artist-technique) comps get 0.185 vs 0.394 — roughly
inverted. Applying Roseberys's fitted relationship to Forum's lots gives a residual of -0.289
(much worse than the pooled -0.117); applying Forum's to Roseberys gives +0.204. Neither
house's estimate-setting process is a shifted copy of the other's; they lean on different
evidence types by different amounts when writing a number. That is new information — nothing
upstream of this measured it.

**What this is not.** The residual cannot separate "this house shades its printed number down
to invite bidding" from "this house is more conservative because it specialises in a segment
where the comps overstate value" from "this house's own valuers are simply more cautious" — all
three would show up identically as a negative residual net of the evidence this model can see.
Calling it "house incentives" is a label for what's measurable, not a claim the mechanism is
pinned down. A genuine separation would need an instrument (a policy change at one house, say),
which this dataset doesn't have.

**Not wired anywhere.** This is a diagnostic model, matching step 8's discipline: built, tested,
run, reported, nothing changed in Stage 3 or the blend. A natural next step — not started — is
whether the house residual, added as a bias term on the estimate witness in `price_blend.ts`,
improves the with-estimate regime at all (step 8 found it barely moves either way once the
estimate is present, so the honest prior going in is that it won't matter much for hammer
prediction even if it is real and informative about the houses themselves).

**Compute.** Fits and scores on 4,957 lots in under 2 seconds; $0; no graph reads (reuses the
step-8 `--blend` JSONL already on disk).

**Addendum 2026-09-14 (final) — the liquidity dummies rebuilt as a recency-weighted feature,
and what a properly-specified regression can and can't confirm.** Replaced the aggregate
`liquidityLimb` dummies entirely with a house-scoped feature: `BlendInputs` gained
`recentSameHouseAppearance: { sold, daysAgo } | null` (the single most recent PRE-SALE
appearance of the same work at the SAME house — `comps_hammer_backtest.ts` computes it natively
now via `RECENT_SAME_HOUSE`, mirroring `SELL_THROUGH`'s pattern; `patch_recency_feature.ts`
back-filled it onto the three existing `--blend` files in ~7s each rather than re-running the
12-minute harness). `estimate_model.ts`'s liquidity block became two present+value pairs —
`recent_unsold_present`/`_log_days` and `recent_sold_present`/`_log_days` — so the fit recovers
both a level shift and its decay with time, matching the shape `relist_discount_report.ts`
measured directly. 27 unit tests, including one that plants a decaying discount and confirms
the fit recovers both the level and the decay slope.

**Forum turned out to be structurally unable to inform this feature at all**, for a bigger
reason than previously recorded: [[project_forum_missing_sale_dates]] already flagged Forum's
6,228 sold+priced records as undated; re-checked directly this session and it's every one of
Forum's 10,050 auction `SourceRecord`s, unconditionally — `saleDate` is absent from the node's
property list, not merely null. A house-scoped, date-ordered query can never find a "most
recent Forum appearance" as a result. Reconfirmed in the existing memory note and spawned as a
follow-up (the fix was already scoped there: 57 saleIds, backfill from listing pages, no
re-ingest).

**Result, properly separated by whether the pool actually has informative rows:**

| Pool | recent_unsold_present | 95% CI |
|---|---:|---|
| Roseberys + Forum (Forum contributes 0 informative rows) | +0.113 — wrong sign | [-0.472, 0.753] |
| Roseberys + Bonhams (both informative) | **-0.357 (×0.70)** — matches the pairwise ×0.70/×0.71 almost exactly | [-0.715, 0.119] — still crosses 0 |

Pooling in Forum for this specific coefficient is worse than not having the feature at all — it
dilutes a real, correctly-signed effect into noise, because every Forum row is forced to the
reference level regardless of its true history. Restricted to the two houses that actually
carry the information, the regression's point estimate lands almost exactly on the value
`relist_discount_report.ts` measured directly (×0.70), which is a real agreement between two
independent methods. But even there the regression's own confidence interval still crosses
zero — with only house-residuals-worth of statistical power split across four new recency
columns plus five other predictors, a cross-sectional regression is a structurally noisier
instrument for this specific effect than the direct same-work paired comparison. The paired
test remains the authoritative measurement (tight bootstrap CI, [×0.70, ×0.71]); the regression
coefficient should be read as consistent with it, not as an independent confirmation.

**House residuals barely move with the corrected feature in place** (Roseberys vs Forum: +0.027
vs the earlier +0.039/+0.040; Roseberys vs Bonhams: -0.115 vs the earlier -0.117/-0.116) —
consistent with the earlier check that recent-history lots are too small a share of any sample
(under 6%) to be driving the main house-residual findings either way.

**Addendum 2026-09-14 (final, direct test) — does switching houses escape the re-listing
discount?** User hypothesis: an unsold-then-repriced lot is a distressed-sale signal, so waiting
roughly a year and consigning the next attempt to Bonhams instead of Roseberys should recover
the ~30% cut plus the general house-tier premium. `cross_house_relist_report.ts` tests this
directly — same (artist, normalizeTitleKey(title)) grouping as the same-house version, but
walking consecutive appearances ACROSS Roseberys and Bonhams (Forum excluded, no dates —
task_7cae1bb7) and splitting by whether the venue changed.

| Route after an unsold Roseberys lot | Median next estimate | 95% CI (artist-clustered bootstrap) |
|---|---:|---|
| Re-offered at Roseberys again | ×0.71 | [0.70×, 0.71×] |
| Consigned to Bonhams instead | ×1.00 | [0.80×, 1.37×] |
| Difference (log), Bonhams route minus Roseberys route | | [+0.122, +0.648] — excludes 0 |

The discount is house-specific, not a repricing of the object: Bonhams shows no measurable
inheritance of a Roseberys failure, and the gap from staying at Roseberys is real despite the
small (n=37) Bonhams-route sample, because the comparison side is pinned tightly by 1,215
same-house pairs. In 46% of Roseberys→Bonhams cases the next estimate came in ABOVE the failed
one, against 6% for same-house relists — some of the general Bonhams tier riding along, not just
the cut being erased.

**Timing looks secondary to venue.** Splitting the Roseberys→Bonhams cohort by gap length, even
the ≤180-day bucket (n=23, too thin to lean on alone) already shows no discount — the effect
looks tied to which house sees the failure, not how long has passed.

**Asymmetric, not a general "any switch clears the record" rule.** The reverse direction —
Bonhams unsold → next Roseberys — DOES carry a real discount (×0.80, n=85), smaller than
staying at Bonhams (×0.70) but not zero. Consistent with the smaller house tracking the larger
one's results more than the reverse; not tested directly.

**Same caveat as the earlier cross-house flip discussion**: a matched "same work" across houses
is very likely a different physical impression of one edition, not the identical sheet
re-consigned. This measures how the EDITION's estimate behaves across a venue switch after a
failure, not that a specific purchased copy would realize this exact effect. Buyer's premium and
Bonhams's own seller's commission are not in these numbers.

**Addendum 2026-09-14 (final, closing) — weighing the four drivers of a Roseberys estimate.**
Every earlier addendum in this step measured one driver at a time, in differently-specced
regressions, so their sizes were never directly comparable. `estimate_driver_weights.ts` puts
all four in ONE pooled Roseberys+Bonhams model (Forum excluded — no dates): priors and market
comps exactly as `estimate_model.ts` derives them, the re-listing penalty as the recency
rebuild derives it, and — new — an explicit `house_is_roseberys` dummy, so the house discount
is a first-class term instead of an unexplained residual. R² = 0.571.

LMG/Shapley decomposition of R² across the four driver groups (averaged over all 24 orderings,
the standard fair way to split credit among correlated predictors — exact for a linear model):

| Driver | Share of R² | Coefficient |
|---|---:|---:|
| Bonhams-calibrated priors | 53% | +0.66 |
| Market comparisons | 37% | same_work +0.33, tier 2 +0.16, tier 3 +0.08 |
| House discount (Roseberys vs Bonhams) | 9% | −0.11 (×0.90) |
| Re-listing penalty | 1% | −0.35 (×0.70, matches the pairwise measurement) |

**Variance share and per-lot magnitude are different questions, and the last two drivers are
exactly where they diverge.** House discount's variance share is small only because it's
CONSTANT — it shifts every Roseberys lot by the same ×0.90, so there is no cross-lot variation
left for it to explain; its actual size (−0.11) is close to the earlier, independently-measured
house-residual reading (−0.115 to −0.117 across the no-house-term specs), a consistency check
that holds. Re-listing's variance share is small only because it's RARE (fires on ~5% of lots)
— its coefficient when it fires (−0.35) is nearly as large as the priors model's own dominant
coefficient and matches `relist_discount_report.ts`'s direct pairwise measurement almost
exactly (×0.70 vs ×0.70/×0.71).

**Reading, stated as two separate questions rather than one number:**
- "Why does one Roseberys estimate differ from another?" — priors and comps do essentially all
  the work; house discount and re-listing barely register, because one never varies and the
  other rarely fires.
- "Why does a Roseberys number sit below what Bonhams-calibrated evidence alone implies?" — the
  house discount (universal, ~10%) and, for the minority of relisted lots, the re-listing
  penalty (~30%, the single largest per-lot effect in the model) are what's doing that.
  Priors and comps are the baseline being discounted from, not discounts themselves.

R² = 0.571 also means 43% of Roseberys estimate variation is still unexplained by these four
drivers — condition, rarity, state, and specialist judgement not captured anywhere in this
model, consistent with the residual noise found throughout this whole plan step.

**Addendum 2026-09-14 (final, decisive) — does the four-driver model's residual identify
genuine mispricing worth acting on?** The user's actual goal, stated directly: spot a
Roseberys/Forum lot that is distressed (the ~30% re-listing discount) AND mispriced beyond that
known, mechanical discount, since the discount alone likely isn't enough margin once round-trip
costs and other buyers' own awareness of the same pattern are counted. `undervaluation_screen.ts`
tests this: compute each lot's residual from the `estimate_driver_weights.ts` model (actual
estimate minus what priors+comps+house+relisting together predict), and check whether that
residual predicts anything real — specifically, does a large negative residual (looks
underpriced vs. the model) correlate with hammer later beating its own estimate, on lots whose
outcome is already known.

**Result: a real, validated signal, but a weak one.**

| Cohort | Spearman(residual, log hammer/estimate) | 95% CI |
|---|---:|---|
| All sold lots (n=3,591) | −0.092 | [−0.133, −0.053] — excludes 0 |
| Distressed lots only (n=238) | −0.039 | [−0.170, 0.120] — same direction, not independently significant |

(Negative is the "works" direction here: low residual — underpriced per the model — pairing
with high hammer/estimate; verified against a synthetic worked example before trusting the
sign, since it is easy to get backwards.) The correlation is genuine on the full sample — most
things fished for in a dataset this size turn up nothing, and this isn't nothing — but weak:
ρ≈0.09 explains a small share of what happens to any individual lot. On the distressed cohort
specifically, the direction is consistent but the sample (238) isn't enough to call it
significant on its own.

**Illustrative check**: the ten most underpriced-per-model distressed lots that went on to sell
averaged 1.10× their own low estimate — a real tilt, but with genuine losers in the list
(0.33×, 0.38×, 0.64×, 0.67×) alongside genuine winners (2.43×, 2.16×, 1.76×). Consistent with a
weak-but-real signal: favourable across many bets, not reliable on any single one.

**Why it's weak, most likely**: the model has zero visibility into condition, rarity, or state
— not ingested anywhere in this graph (documented earlier in this plan's pricing-model work). A
large negative residual is at least as likely to mean "the house saw a real flaw the model
can't see" as "the house missed genuine value" — mirrors the recurring finding throughout this
whole plan that the house estimate is a well-informed number, hard to systematically beat with
attribute-only data.

**Recommendation, not built further this session**: use the residual as a FILTER, not a
standalone signal — rank live distressed Roseberys/Forum lots by it to cut a long list to a
short one worth a human/expert look, rather than treating a flagged lot as a buy call on its
own. The genuine edge this graph cannot supply is exactly the connoisseurship (condition,
rarity, state) a specialist brings to the shortlist.

**Addendum 2026-09-14 (final, methodological correction) — a cleaner undervaluation test, and
why "sold under estimate then flipped to Bonhams" doesn't confirm the thesis on its own.** User
correction: hammer/estimate at ONE sale is contaminated by same-sale bidding psychology — a
buyer at a visibly distressed sale can rationally bid low regardless of the object's true worth,
so a low hammer is consistent with both "worth little" and "genuinely undervalued." Proposed a
cleaner test: a work that sold BELOW its own estimate at one auction, then sold again — much
higher — later the same year, at a sale whose price wasn't set by anyone reacting to the first
one. `repeat_sale_correction_report.ts` tests this directly on the combined Roseberys+Bonhams
catalogue (hammer prices on both sides, unlike the earlier estimate-only repeat-sale checks),
next SOLD appearance of the same nominal work within 365 days, control group = sold at/above
estimate.

| Cohort | Median next/first hammer | 95% CI |
|---|---:|---|
| Sold UNDER estimate → next sale | ×1.04 | [1.00×, 1.07×] |
| Sold AT/ABOVE estimate → next sale (control) | ×0.91 | [0.89×, 0.92×] |

A real, non-overlapping-CI difference between the two cohorts. But a robustness check trimming
the most extreme jumps (>10x, almost certainly different print generations of a famous edition
— the top-10 list is dominated by Dorothea Lange, Ansel Adams, Chagall, all heavily reproduced —
caught under one loose title key) moved NEITHER median at all, because medians are already
robust to a handful of outliers by construction. That check does not rule out **regression to
the mean**: if "sold under estimate" partly reflects an unusually low draw against noisy
edition-matching rather than genuine mispricing, the next observation would drift back toward
the average with zero real economic story required — and that produces exactly this shape
(cheap cohort drifts up, expensive cohort drifts down). Not resolved by anything built so far.

**The number that actually answers the user's specific strategy — buy cheap at Roseberys, sell
at Bonhams — using this cleaner criterion:**

| | n | Median | 95% CI |
|---|---:|---:|---|
| Roseberys (sold under estimate) → Bonhams | 31 | ×1.00 | [0.78×, 1.25×] |

Dead-center breakeven, wide interval, no edge either direction. Contrasted against the earlier
cross-house finding (`cross_house_relist_report.ts`): Roseberys UNSOLD → Bonhams showed a real,
significant recovery (×1.00 vs staying at Roseberys ×0.71, CI on the difference excludes 0).
Read together: what's recoverable by switching houses looks specific to escaping the UNSOLD
stigma — an institutional-memory effect the new house doesn't share — not a general tendency for
merely cheaply-sold lots to be undervalued. The distressed (unsold, relisted) case is the one
this data actually supports; a lot that simply sold under estimate without failing outright
shows no comparable cross-house recovery at this sample size (n=31).

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

**Addendum 2026-09-14 (later) — does the printed estimate respond to a track record of no
sales?** `liquidityVerdict` (attributed_lot.ts) established a real, measured effect on the
OUTCOME: a never-sold work goes unsold 41% of the time against a 30% base, and hammers at 0.750
of the midpoint against 0.857 when it does sell. Nobody had checked whether that history is
already reflected in the house's PRINTED number, as opposed to only showing up after the fact.
`estimate_model.ts` gained `liquidityLimb` (a local mirror of `liquidityVerdict`'s three-way
classification — never-sold, thin-record, sold-before-healthy, against a "no prior history"
reference) as three added dummies, reusing the sell-through data already saved in the `--blend`
files (no new harness run needed). `estimate_residual_report.ts` gained a coefficient-level
artist-clustered bootstrap CI, not just the house-residual CI it already had.

**Result (Roseberys ∪ Forum pool, 4,957 lots, 95% CI):**

| Track record | Coefficient | 95% CI |
|---|---:|---|
| Never sold before | +0.096 | [-0.069, 0.258] — includes 0 |
| Thin record (≥3 appearances, <50% sold) | -0.002 | [-0.201, 0.240] — includes 0 |
| Sold before, healthy rate | +0.073 | [-0.032, 0.181] — includes 0 |

None of the three are distinguishable from zero. The point estimate for never-sold even runs
slightly positive, the opposite of what a "houses shade the number down for a bad track record"
story would predict — but the interval easily contains zero, so this is not evidence of a
positive effect either, just an absence of a detectable one either direction.

**Reading.** The house's printed estimate appears liquidity-blind, at least at a sample size
and comp-window this model can resolve. The measured 41%-unsold / 0.750×-midpoint effect from
`liquidityVerdict` operates entirely on the OUTCOME side — whether bidders show up and what
they pay — not on the house's own opening number. That sharpens the causal diagram: liquidity
history is not a fifth input into "house estimate," it sits downstream of it, acting directly
on hammer (and specifically on P(sells), which is exactly how `price_blend.ts`'s hurdle already
treats it, kept separate from the price distribution rather than folded into any witness's
mean — this result is independent support for that design choice, not the reason for it).

**Caveat.** The CIs are wide (MAD on the estimate residual is ~0.5, comparable to the residual
noise floor everywhere else in this model), so this is "no effect detected at this sample size
and these two houses," not "proven zero." Pooling in Bonhams's rows too would sharpen the
interval — the liquidity coefficient itself doesn't inherit the reference-house circularity
that made the Bonhams HOUSE-residual reading unreliable, since it isn't measuring a house
effect at all — but that run hasn't been done.

**Addendum 2026-09-14 (later still) — the re-listing discount, confirmed directly, and a real
graph defect found along the way.** The Roseberys correction: my pooled liquidity dummies
(previous addendum) asked whether a work's AGGREGATE sell-through history correlates with
today's estimate and found nothing. That's a different, coarser question than what Roseberys
described — a SEQUENTIAL practice, discount the next listing after a specific failure — and the
dummy design cannot see it. `tests/backtest/relist_discount_report.ts` tests the sequential
claim directly: for every work with 2+ dated, estimated appearances at the same house, walk
consecutive pairs and measure the estimate-midpoint change, split by whether the earlier
appearance sold.

**Graph defect found first.** Querying the graph directly returned ZERO "previous unsold"
Roseberys pairs — implausible against Roseberys's own ~30%+ measured unsold rate. Checked
directly: every one of 3,846 unsold Roseberys `SourceRecord`s has `estimateLowGBP`/`HighGBP`
NULL in the graph, while the source catalogue (`benchmark/data/all-prints/catalogue.csv`) has a
usable estimate on 5,164 of 5,170 unsold rows (99.9%). The estimate is only reaching the graph
for SOLD Roseberys lots — an ingest defect, not a source-data gap. Not fixed here (out of scope
for this session); flagged as a follow-up task. Worth checking whether the same condition
affects any other Roseberys field written only on the sold path.

**Routed around it** by reading the same local catalogue `comps_hammer_backtest.ts`'s
`loadRoseberys()` already uses, grouping by an EXACT `(artist, normalizeTitleKey(title))` key —
no fuzzy matching — as the work-identity substitute for a resolved `ConceptualWork` id.

**Result — the practice is real, at both houses, and matches what Roseberys said almost
exactly:**

| | Bonhams (graph) | Roseberys (catalogue, graph bypassed) |
|---|---|---|
| Previous UNSOLD → next estimate, median | ×0.71 (−29%) | ×0.71 (−29%) |
| …restricted to a ≤180-day gap (the closest reading of "next auction") | ×0.70 (−30%), 51% cut ≥30% | ×0.68 (−32%), 53% cut ≥30% |
| …restricted to a >365-day gap | ×0.83 (−17%), 37% cut ≥30% | ×0.92 (−8%), 26% cut ≥30% |
| Previous SOLD → next estimate (baseline drift), median | ×1.00 (0%) | ×1.00 (0%) |

The discount is real, sequential, concentrated at short gaps (consistent with "the next
auction" specifically, not a slow market drift), and absent when the prior appearance sold —
the baseline-drift row is flat at every cut, which is the clean control the pooled dummy test
lacked. "Up to 30%" matches the short-gap median almost exactly at both houses. Roseberys is
not unusual here; Bonhams runs the same practice at close to the same size.

**Why the earlier pooled-dummy result and this one are both correct, about different things.**
The prior addendum's null result stands as stated: a work's AGGREGATE sell-through rate over a
10-year window does not measurably move a lot's estimate today. This result shows something
narrower and stronger: a SPECIFIC recent failure does move the very next listing's number, by a
large and consistent amount, and that effect washes out once folded into a coarse "ever
failed" flag averaged across appearances that may be years apart. The estimate model isn't
liquidity-blind — it was asked the wrong-shaped question.

**Caveat carried over from the cross-house flip discussion**: consecutive appearances of the
"same work" may be different physical impressions of the same edition, not the identical sheet
re-consigned by the same owner. A short gap between an unsold appearance and the next one at
the SAME house is the closest signal available without individual-copy tracking, not proof.

**Addendum 2026-09-14 — Roseberys vs Bonhams, and a confound the Forum comparison didn't have.**
Bonhams has no local catalogue CSV like Roseberys/Forum (`benchmark/data/bonhams/` was empty);
`tests/backtest/_pull_bonhams_catalogue.ts` reads it back out of the graph instead (52,155 dated
lots with a valid estimate) and `comps_hammer_backtest.ts --source bonhams` now runs the same
harness against it. Re-running the estimate-residual report with Bonhams as house B:

| | Roseberys | Forum (first run) | Bonhams |
|---|---|---|---|
| Pooled-model residual, 95% CI | **-0.117** [-0.163, -0.073] (×0.89) | -0.117 [-0.191, -0.041] (×0.89) | **+0.015** [-0.018, 0.051] — not significant |

Roseberys's residual FLIPPED from not-significant (paired against Forum) to significantly
negative (paired against Bonhams) — the same house, two different verdicts, because the
comparison house changed. That is the tell: this isn't measuring Roseberys in isolation, it's
measuring Roseberys relative to whichever house is in the pool.

**Why, and why Bonhams is not a clean comparison house for this model.** `build_priors.py`'s
`REFS` sets `"house": "Bonhams"` — Bonhams is the priors model's own reference level, so
`house_Bonhams`'s coefficient is 0 by construction and every other house's coefficient is
measured relative to it. Bonhams also supplies the large majority of the hammer-priced rows
the priors model and the same-work/tier comps corpus were built from (ADR-0016: 38,663 of
48,078 dated comps). So a near-zero Bonhams residual here is close to tautological — the
"provenance/comps" witness is itself substantially built FROM Bonhams sales — while Forum has
no realised prices at all and isn't a reference level for anything, making it the honest
out-of-population test the first run actually was. The Roseberys-vs-Bonhams gap mostly
reproduces the already-known house-level pricing tier ([[project_pricing_model_findings]]:
Roseberys ×0.36–0.95 of Bonhams, pooled ×0.51) rather than isolating a new "house incentive net
of evidence" signal the way the Forum comparison did.

**One number from the cross-house transfer survives that caveat.** Roseberys's own fitted
relationship, applied to Bonhams's lots, predicts them almost exactly (residual +0.022 — closer
to zero than Roseberys predicting its own training data, -0.078, which is ordinary log-price
skew, not a fitting error). Bonhams's own fitted relationship, applied to Roseberys's lots,
misses badly (-0.219, worse than the pooled estimate). That asymmetry doesn't depend on which
house is the reference level — it says the way Roseberys weighs evidence when writing an
estimate is compatible with Bonhams' price levels, but not the reverse, which is a real,
if modest, piece of evidence beyond the already-known house tier.

**Practical conclusion:** this model isolates a genuine house-specific estimate-setting effect
only when compared against a house that isn't itself baked into the evidence side of the
regression. Forum qualifies; Bonhams doesn't, and any third house added later needs the same
check before its residual is read as "house incentive" rather than "distance from the
reference house by construction."


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

### Liquidity: the threshold was assumed, and the measurement moved it (2026-09-14)

Bonhams 32240's Baldessari ("Arg, from Engravings with Sounds") exposed it. The work had been
offered twice and failed both times, and Stage 3 reached for that fact, found the verdict line
saying NO measured signal, and expressed the concern anyway under a different label ("absence
of same-work price history", -10%). Rather than tighten the prohibition again, the threshold
itself was measured — on the 941 backtest lots that had any prior history of the same work,
base unsold rate 30%:

| prior history of the same work | lots | then unsold |
|---|---:|---:|
| never sold, 1 failed appearance | 123 | 41% |
| never sold, 2+ failed appearances | 35 | 40% |
| **never sold, any count** | **158** | **41%** |
| sold once of 2 | 50 | 18% |
| sold twice of 2 | 99 | 27% |
| >=3 appearances, under 50%, sold at least once | 50 | 48% |
| >=3 appearances, 50% or more | 346 | 27% |
| sold at least once, any shape | 783 | 28% |

The old rule (>=3 appearances AND under 50%) caught 57 lots and missed all 158 never-sold ones.
The discriminator is not the appearance count: it is whether the work has EVER cleared. The
union of the two limbs separates 208 lots at 43% unsold from 733 at 27%, and holds against each
house's own base (Forum 37% base, 57% never-sold, 54% thin-record; Roseberys 25% base, 36% and
42%). `liquidityVerdict` now returns which limb fired and quotes the figures for it.

Re-run of the Baldessari: the -10% under a different label became "-15% Liquidity — MEASURED
SIGNAL: YES ... works with no prior sale go unsold 41% of the time against a 30% base". Same
range (GBP 1,200-1,800), correct provenance for the number.

**The general lesson, third time this session.** When Stage 3 routes around a prohibition, the
prohibition is usually describing a real signal badly. Clause H stopped the model inventing
discounts from uncertainty; it could not stop it reaching for a fact the rule wrongly excluded.
Measure the threshold before forbidding what falls outside it.

### Two smaller defects, fixed 2026-09-14

**A preview lot counted itself as a failed appearance.** The sale under appraisal is never
evidence about itself, and matching on sale + lot number does not enforce that: the Bonhams
ingest stores a preview lot with `lotNumber` 0 because no number is parseable from a preview
URL, so a claim keyed on the house's internal id (6181803) missed its own record. Measured on
Bonhams 32240: sell-through read 1/3 instead of 1/2 and Stage 3 took 12% off for it.
`queryWorkFacts` and `queryAuctionComparables` gained an opt-in `excludeSaleId` that drops
EVERY record of a sale, and the attributed path passes the claim's sale. Verified live: 1/3 ->
1/2, while the same-work comp from the June sale correctly survives. Deliberately opt-in rather
than derived from `excludeSaleLot`, because the backtest scores PAST sales where another lot in
the same sale is legitimate evidence, and widening it there would move measured results.

**Four of five unresolved artists were an HTML entity, not a graph gap.** `htmlToLines` decoded
a hand-written allowlist of nine accented letters, and the two that mattered were not on it, so
"Salvador Dal&iacute;" and "Andr&eacute; Bic&acirc;t" reached `resolveArtistIdentity` with the
entity intact and matched nothing — though Dalí has 990 works in the graph. A partial decoder is
worse than none: what survives is a plausible-looking string that silently fails every exact
match downstream. Replaced with `decodeHtmlEntities` in `src/shared/text_extraction.ts`: the
full Latin-1 letter set, decimal and hex numeric references, and the punctuation auction
descriptions use, with `&amp;` decoded LAST so an escaped entity stays literal. A0793 screen
re-run: artist coverage 263/268 -> 267/268, works resolved 141 -> 142. The one genuine miss left
is Rachel Jones, who is not in the graph.

### Stage 2b: Haiku measured against Sonnet (2026-09-14) — REJECTED as configured

Four lots, both arms, same code, $1.13 of a $2 budget. `npm run compare:stage2b` scores research
BEHAVIOUR rather than prose: did it search, does every figure carry a URL, do those URLs resolve
when HEAD-requested, does it agree on artist/level/catalogue, and does it record what it could
not find. A citation that 404s is the signature of a fabricated source and is the number that
decides this.

| | Sonnet 4.6 | Haiku 4.5 |
|---|---:|---:|
| cost per lot | $0.196 | $0.069 (65% less) |
| seconds per lot | ~166 | ~106 |
| Stage 2b calls, 4 lots | 15 | 9 |
| comps returned / storable | 21 / 17 | 11 / 8 |
| citations live | 23/24 | 9/10 |
| unresolved questions recorded | 15 | 18 |
| artist agreement | — | 4/4 same |
| final estimate | — | identical on 2, near on 2 |

Cheaper, faster, agrees on WHO, and honestly records more of what it could not resolve. And it
is still not safe here, because the failures are not spread evenly — they correlate with
under-searching, and when it under-searches it fills the gap instead of leaving it empty.

- **A0793/530 (Nick Smith), the GOOD failure.** One search, zero comps, and unresolved questions
  naming the gap ("Auction market data for Nick Smith giclée prints"). Sonnet found six cited,
  live comps. Haiku found nothing and said so, which is safe and merely worse.
- **A0793/420 (Cindy Sherman), the DISQUALIFYING one.** One search, then three comps with NO URL
  and basis "unknown" — "Untitled Film Still #96" at Bonhams London £1,875, "Untitled
  (Centerfolds)" at Sotheby's £2,400, "Untitled (History Portraits)" at Christie's £3,200. These
  are the artist's most famous series at small-print prices; a Tavily check for each returns only
  generic artist pages. Re-run to test reproducibility: one search again, two comps again with no
  URL and unknown basis, and **the same £1,875 attached to a different title**. That recurring
  figure is the tell — the numbers are being generated, not recalled or retrieved.

This is the exact failure ADR-0006/ADR-0016 recorded for qwen3-max: accept the search tool, make
a token call, answer from parametric memory. It is why Stage 2b is on Sonnet at all, and the
measurement says the reason still holds.

**The containment worked, and that is the other finding — now closed.** All three uncited comps
scored 0 storable and the write-back rejected every one, so nothing reached the graph. But they
DID reach Stage 3's prompt as "Stage 2b web-research comps": the citation requirement was
enforced at write-back and not at the point where comps enter the valuation, and the estimates
matching was luck rather than design.

`partitionCitedComps` now splits Stage 2b's comps at the Stage 3 boundary and only cited ones
are rendered into the prompt. The gate is the CITATION alone — price basis is the write-back's
concern, because a stored price in the wrong field is unrepairable, whereas for READING a cited
comp with an unstated basis is still real evidence. Over-filtering here would discard findings
that are true.

What is withheld is REPORTED rather than swallowed, to the log and to Stage 3 itself: a stage
that found five figures and could cite two is telling you something about the quality of that
research, and the valuation should be able to see it. The raw ASA result keeps every comp for
audit; only the prompt is filtered.

Verified live on the lot that exposed it (A0793/420, Haiku): 2 comps returned, both uncited,
both withheld, `[Stage 3 comps] withholding 2 uncited Stage 2b comp(s)`. Note that this run
produced "Untitled Film Still #96" at GBP 1,875 for the THIRD time across three runs — the same
title at the same price, still with no URL. Whatever that number is, it is not coming from a
search.

Not a flat no: on 2 of 4 lots (Chagall, Baldessari) Haiku searched 3-4 times and produced cited,
live, storable comps agreeing with Sonnet. It is unreliable rather than incapable, and the
unreliability is legible in the run (search count, citation rate). A gated design — Haiku first,
escalate to Sonnet when the search count or citation rate falls short — is measurable from here,
and would be the way to bank the 65% without the exposure. Two mild concerns for that design:
Haiku called "definitive" where Sonnet said "probable" on 2 of 4, and was less specific on the
catalogue raisonné (Cramer vs "Vollard; Cramer bk. 30").

**Found while measuring:** Stage 2b's exit path pushed the model's final turn while a tool call
was still pending, leaving an orphan the API rejects ("tool_use ids were found without
tool_result blocks"). Haiku calls more tools per round, reaches the 4-round budget with one
live, and so hit a latent bug Sonnet had been walking past. Every pending call is now answered
on the way out, telling the model the budget is spent and to record what is unresolved rather
than guess it. Stage 2a's loop was already correct.

### Stage 2b's comps are the graph's own comps, found again (2026-09-14)

Verifying the widened write-back against real Stage 2b output turned up something larger. On the
Bonhams Baldessari lot, 3 of 4 comps passed every gate and then ALL THREE were rejected as
already in the graph — `bonhams-32236-108-record`, `bonhams-22259-143-record`,
`bonhams-25796-120-record`. Measured across every stored attributed-path run:

| | |
|---|---:|
| comps returned by Stage 2b | 106 |
| passing the write-back gates | 90 |
| **already in the graph as ingested records** | **89** |
| genuinely new price data | **1** |

The graph holds 38,663 sold Bonhams lots plus Roseberys and Skinner, so for any well-covered
artist a house page the web surfaces is already ingested by construction. Stage 2b's comp
research yields about 1% net-new price data, and the write-back built today consequently has
almost nothing to write. That is the write-back's dedupe gate doing its job, and it is also a
statement about where this stage's value actually lies: the catalogue raisonné, the series
context, the MoMA record, the edition structure — not the prices.

**And the duplicates were reaching the valuation as corroboration.** Stage 3 receives two comp
blocks: the ACKG's records, which it is told to anchor on, and Stage 2b's findings, which it is
told to use "to corroborate". Across 24 stored lots, **80 of 106 web comps (75%) were the same
sale as an ACKG comp in the SAME prompt**, and on many lots every one was (4/4, 5/5, 7/7). The
model cannot tell they are one sale; the web copy is usually premium-inclusive where the ACKG
copy is hammer. One sale therefore arrived as two independent data points on two different price
bases, which is precisely what breaks anchoring.

`dropWebCompsAlreadyInGraph` removes them at the Stage 3 boundary, matching on listing URL or on
house + sale + lot together (a house and a lot with no sale identifies nothing and is left
alone). What is dropped is named in the log and reported to Stage 3 as duplicates that "must not
be read as corroboration". Verified live on A0793/530, where 6 of 7 were dropped.

Two bugs the tests caught rather than review, both of which would have silently under-matched in
production: the house arrives as `institutionName` from the graph and `auctionHouse` from Stage
2b, and sale ids and lot numbers arrive as numbers from the graph where the text helper only
accepted strings — so the graph side formed no key at all and matching was URL-only.

### Stage 2b was being TOLD to copy the graph's comps (2026-09-14)

The 89-of-90 duplication was not the model going wrong. STEP 7 of the specialist prompt said, of
the records `query_ackg_comparables` returns: "record them in auctionComps like any other comp
(listingUrl, priceAmount, priceCurrency "GBP" and priceBasis "premium_inclusive" all come
straight off the record)". It was doing exactly as instructed, and Stage 3 — which queries that
same corpus itself under ADR-0016 — then saw each sale twice.

STEP 7 now says the opposite: read the graph's records, do NOT copy them, `auctionComps` is for
sales the graph did not return, and an empty array is the correct answer when the graph already
covers the artist. The schema description says the same, so the instruction survives a model
that skims the prompt.

The search-budget clause took two attempts. The first said skip comp searches when the graph
returned "any same_work record, or three or more priced records at any tier", and A0793/530
ignored it and searched three times — correctly, as it turned out. It had 31 same-artist records
and no same_work, and same-artist records do not answer the question a same-work record answers
(within-2x 50% against 80%). The rule now keys on same_work ALONE, and says so with the tier
accuracies, so a large tier-3 count is not mistaken for coverage.

Measured on two lots:

| | A0793/530 (no same_work) | A0793/251 (10 same_work) |
|---|---|---|
| comps reported | 6 -> 1 | 5 -> 1 |
| Stage 2b output tokens | 4,208 -> 3,148 (-25%) | — |
| web searches | 4, correctly (nothing to skip) | 1, and spent on the edition format, not comps |
| valuation | 320-480 -> 280-420 | 800-1600 -> 800-1400 |

**Honest limits.** The output saving is real (-25% on the lot measured) but total cost was flat,
because on 530 the searches were legitimate. And the search-skip clause will fire less often
than it looks: the routing rule sends lots to Stage 2b *precisely because* same-work comps are
missing. Across nine observed routings, seven cited "no same-work comps in the graph" and only
two reached Stage 2b for another reason alone. So the skip applies mainly to lots that came for
a verification divergence or a Scenario 2/4/5, as A0793/251 did. The copying fix applies to all
of them; the search fix to a minority.

### Gated Stage 2b: Haiku researches, Sonnet redoes it when the result cannot be checked (2026-09-14)

`src/appraisal/stage2b_gate.ts`, live on `claude-4stage-attributed` only — every other method is
untouched and ungated. Haiku 4.5 runs the stage; code then judges what came back and re-runs it
on Sonnet 4.6 if it fails.

**The gate is about VERIFIABILITY, not effort.** The obvious signal was search count, since both
measured Haiku failures made exactly one search. But STEP 7 now tells Stage 2b to skip comp
searches when the graph holds a same_work record, so a single search can be correct and diligent
— gating on effort would punish the model for obeying an instruction added the same day. What
never becomes acceptable is an unverifiable claim:

| reason | what it catches |
|---|---|
| `uncited_comp` | a price with no page behind it — the measured fabrication signature |
| `uncited_catalogue_raisonne` | the same failure in another field, which ADR-0007 already refuses to write |
| `no_search_despite_gap` | zero searches when the graph holds no same_work sale: the job was not attempted |
| `research_failed` | the cheap attempt threw and returned no report at all |

That fourth reason came from the gate's own first live run. Haiku ended its turn on A0793/420
with a prose summary instead of the required JSON, the parser raised, and the lot died. Under
gating that must not happen: an unusable result is the strongest escalation signal there is. The
first attempt is now caught, and without an escalation model configured the error still
propagates exactly as before.

**Live, two lots:**

| lot | outcome | cost | against Sonnet-only |
|---|---|---|---|
| A0793/316 Chagall | PASSED on Haiku — 8 comps, all cited, 3 searches | $0.094 | ~$0.18, so 48% saved |
| A0793/420 Sherman | ESCALATED — zero searches with no same_work sale | $0.194 | ~$0.18, so ~8% penalty |

That is the shape of the trade: a pass saves about half, an escalation costs the wasted cheap
attempt. Stage 2b is about $0.04 on Haiku and $0.157 on Sonnet, so gated cost is
0.04 + E x 0.157 and it pays while the escalation rate E stays under about 75%. The 4-lot model
comparison put E at 50%; two live gated lots is not a rate, and the real one will only be known
after a batch.

**What this does NOT claim.** Haiku is not established as safe at Stage 2b — the measurement said
the opposite. The gate is a containment: it lets the cheap model do the work it can do and
catches, deterministically and from the output alone, the cases where it cannot. Every escalation
reason is recorded in `report.attributedLot.stage2bGate` with the model that failed, so the rate
is measurable from stored runs rather than assumed.

### Escalation rate measured: 58%, and the gate pays 16% (2026-09-14)

Ten fresh lots, seed 42, deliberately NOT the ones the gate was built against.
`npm run report:gate-rate` reads stored runs, so this is re-checkable for free as more accumulate.

| | |
|---|---:|
| stored runs | 41 |
| reached the gate | 12 |
| escalated | 7 |
| **E** | **58%** |
| reasons | no_search_despite_gap 6, uncited_catalogue_raisonne 2, research_failed 1 |

Stage 2b costs $0.04 on Haiku and $0.157 on Sonnet, so gated = 0.04 + 0.58 x 0.157 = **$0.132
against $0.157, 16% cheaper**, with break-even at E = 75%. It pays, but not by much: about
$0.025 a lot, or roughly £12 over a 500-lot sale.

**The separation is perfect, and that is the more useful finding.** Counting only Haiku's own
searches, before any Sonnet redo:

| Haiku searches | lots | outcome |
|---|---|---|
| 1, 4, 3, 1 | 14, 221, 300, 315 | **all 4 PASSED** |
| 0 | 15, 33, 164, 289, 346, 426 | **all 6 ESCALATED** |

Whether Haiku searches at all predicts the outcome with no exceptions in this sample. And when
it does not search it does not stay silent — it asserts. Lot 15 named "Michler & Löpsinger" as
Dalí's catalogue raisonné and lot 346 named "Benavides" for Vasarely, both plausible and neither
carrying a source URL. That is the same parametric-recall behaviour as the fabricated Sherman
comps, caught here by a different gate reason. The three reasons are independent tests of one
underlying failure.

Note this is not a side-effect of the STEP 7 rewrite that told Stage 2b to search less: in the
model comparison BEFORE that change, Haiku already made zero searches on 2 of 4 lots.

**What this means for the design.** The cost case is real but thin. The stronger case is
robustness: the gate is model-agnostic and also caught an outright crash (lot 33, Haiku returned
prose instead of JSON), which without gating kills the lot. Judge it as a safety net that
happens to save money rather than as a cost optimisation.

**The obvious next move is to make Haiku search.** Six of seven escalations are "did not try",
and every lot where it tried passed. If a prompt change lifted the search rate, escalations would
convert to passes and E would fall well under the break-even, at which point the saving is
material rather than marginal. Not attempted here — it is a prompt experiment with its own
measurement, and the honest current answer is the 58% above.

Observed, not yet acted on:
### Liquidity: the SIZE bounded on measurement, not judgement (2026-09-14)

Stage 3 took -60% for liquidity on a work with ONE prior unsold appearance. It obeyed the
direction and invented the magnitude — the same pattern as the clauses corrected earlier that
day, and for the same reason: the block stated a direction without a size.

The fix was to measure the size. Poor liquidity answers two questions that had been merged into
one cut, and they carry very different weights. On the 941 backtest lots with prior history:

| | n | then unsold | of those that SOLD: hammer / printed midpoint |
|---|---:|---:|---:|
| all lots with history | 941 | 30% | 0.833 median |
| **never cleared** | **158** | **41%** | **0.750 (n=92)** |
| sold at least once | 783 | 28% | 0.857 (n=559) |

So the RISK is real and large (41% against 30%), and the PRICE effect is real and small: 0.750
against 0.857 is -12.5% relative to a work that has sold, and since the anchor already carries
the market's 0.82 drift the residual against the anchor is 0.750/0.82 = 0.915, about **-9%**.
Per house, Roseberys 0.750 vs 0.833 (n=76) and Forum 0.827 vs 0.870 (n=16, thin).

`LIQUIDITY_TYPICAL_PRICE_ADJUSTMENT` = 0.09 and `LIQUIDITY_MAX_PRICE_ADJUSTMENT` = 0.15. The
verdict line now separates the two effects explicitly — risk into a protective lowEstimate and
into confidence, price into a capped adjustment — and says where a larger cut must go instead:
"if you believe the lot is worth materially less than that, the reason is something other than
liquidity and must be named as that other thing". Without that escape hatch a real concern gets
loaded onto the wrong factor.

Re-run of A0793/420, the lot that produced the -60%:

| | before | after |
|---|---|---|
| liquidity price adjustment | -60% | **-9%**, quoting the measurement |
| unsold risk | folded into the same cut | separate "protective floor" line on the lowEstimate |
| estimate | 1,200-2,400 | **2,400-3,600** (anchor 3,280, catalogue 3,000-5,000) |

The midpoint now sits at 0.91 of the anchor, which is the measured effect exactly. Two other
adjustments came back "none (already priced in anchor)" for edition size and signature — clause
H declining to double-count what the house's estimate already reflects.

Honest caveat: the bound moves the valuation TOWARD the house, which is more defensible rather
than automatically more accurate. The 23 September hammer decides that.
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

## Rolling cache breakpoints at Stage 2b (2026-09-14)

Stage 2b runs up to four tool-use rounds against an unchanged prefix: the
system prompt, the tool schemas and the lot dossier. Every round was re-sent
as fresh input. `withRollingCache` in `src/appraisal/appraiser.ts` marks the
last tool block plus the first and last user turns, so the prefix stays cached
as the transcript grows while staying inside the four-breakpoint limit. It is
skipped when a compat base URL is set — non-Anthropic gateways reject the field.

Measured on A0793 lot 289, the same lot both runs:

| | fresh in | cache read | Stage 2b |
|---|---|---|---|
| before | 30,494 | 25,011 | $0.2173 |
| after | 20 | 69,663 | $0.1834 |

Stage 2b fell 16%, the lot total 11% ($0.2722 → $0.2422). 16 unit tests in
`tests/appraisal/rolling_cache_tests.ts`.

## Two open defects found on lot 289

The same run valued lot 289 (after Matisse, *Le Cirque* from Jazz) at £25–50
against a catalogue estimate of £300–500. Both runs of the lot did this
(£45–90 before the cache change), so the cache is not the cause.

**1. Comp-driven adjustments are unbounded.** Stage 3 applied a single
`down -91%` step from one tier-2 comp (*Le destin, from Jazz*, Skinner
Feb 2026, edition 1500, hammer £29.24). Clause B of
`VALUATION_ATTRIBUTED_LOT_SUFFIX` tells the model comps are "a BAND and a
DIRECTION, not a price" but sets no magnitude. This is the same
obeys-direction-invents-magnitude failure already closed for liquidity
(`LIQUIDITY_MAX_PRICE_ADJUSTMENT`) and for condition; comps were never bounded.

**2. Every priced Forum record is invisible to the comps query.** The Cypher in
`query_comparables.ts` requires `src.saleDate IS NOT NULL`. All 6,228 sold,
priced Forum Auctions records have no date property at all:

| house | sold + priced | null saleDate |
|---|---|---|
| Forum Auctions | 6,228 | 6,228 |
| Bonhams | 38,663 | 0 |
| Roseberys London | 8,807 | 0 |
| Skinner | 1,251 | 0 |

That is 11% of the priced corpus. On this lot it mattered directly: the graph
holds exactly three sold Jazz records — £29.24 (Skinner), £300 (Forum,
edition 1500, unsigned) and £3,200 (Prospectus, edition 8). The £300 record
corroborates the catalogue estimate and is the closest match on edition size,
and it was dropped for the missing date, leaving the £29.24 outlier alone in
front of Stage 3.

The dates are recoverable: 6,228 records span only 57 distinct `saleId` values,
and each sale's date is on its Forum listing page. Logged, not swept.

## Stage 2b: ask the cheap model before replacing it (2026-09-14)

Across the backtest logs Stage 2b escalated Haiku → Sonnet eight times. Six read
"no web search was made, and the graph holds no same-work sale" — the model
called the graph tools, got nothing, and wrote its report anyway. The other two
were replies containing no JSON at all. In every case a full Sonnet re-run was
bought to replace a cheap run that was one turn from being usable.

Two changes, both in `src/appraisal/appraiser.ts`:

**In-loop search nudge** (`src/appraisal/stage2b_nudge.ts`). When the loop is
about to finalise with zero searches and the graph holds no same-work sale, it
pushes one turn saying the search was the job. This happens mid-conversation:
prefix cached, graph results still in context, rounds remaining. Capped at one
nudge, and only while a round remains to act on it. Guarded to the client-side
search path — `searchesMade` cannot see Anthropic's server-side tool, so
elsewhere it would accuse a diligent model of silence.

**Re-ask on unparseable output.** `parseCleanJson` repairs malformed JSON but
cannot repair a reply with no JSON in it, which is the measured shape. Instead
of raising, the model is asked once to restate the same findings as the schema.

Neither softens the gate. `assessStage2bResearch` judges what was produced on
unchanged terms; the nudge demands `unresolvedQuestions` over a price, so it
cannot be satisfied by inventing the comparable it asked for.

Measured on the three lots that previously escalated, one per failure mode:

| lot | before | after | change | escalated |
|---|---|---|---|---|
| 164 | $0.2433 | $0.1125 | −54% | yes → no |
| 426 | $0.1341 | $0.0848 | −37% | yes → no |
| 289 | $0.2722 | $0.0960 | −65% | yes → no |
| total | $0.6496 | $0.2933 | −55% | 3/3 → 0/3 |

The nudge fired on all three and each then searched 4–5 times; the re-ask was
never needed, because a model that searches also returns the schema. The gate
passed all three with every comp cited.

Accuracy held or improved. Lot 164 reproduced Sonnet's £280–420 exactly at half
the cost. Lot 426 moved £520–750 → £550–850, nearer its £700–1,000 catalogue.
Lot 289 moved £45–90 → £250–450 against £300–500: nudged Haiku found real cited
comps, so Stage 3 was no longer left with the single £29.24 outlier. That
removes the bad input, not the unbounded-adjustment defect above, which is
still open.
