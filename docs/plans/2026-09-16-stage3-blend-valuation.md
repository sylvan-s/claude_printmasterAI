# Stage 3 as a deterministic blend: pricing model + market comps, with a contribution chart and LLM narration

**Date:** 2026-09-16 · **Branch:** `feature/stage3-blend-valuation` (off `feature/attributed-lot-valuation`)
**Status:** Phase 1 built and gated 2026-09-16 (see "Phase 1 result" at the end); phases 2–5 not started. Builds on step 8 of `2026-09-13-attributed-lot-valuation.md`
(`src/appraisal/knowledge_graph/price_blend.ts`, `knowledge_graph/pricing_ml/blend/`).

## What the user asked for

1. The Stage 3 price comes from blending the log-linear pricing model (artist, technique,
   signature, edition, size, citation, ...) with market comps.
2. Confidence depends on the evidence. Several recent same-work comps give a tight
   distribution. Similar works by the same artist give a looser one.
3. Stage 3 outputs an estimate range.
4. A contribution chart (SHAP-style) shows how the price was built from the input factors.
5. An LLM narrates the key drivers. It does not set the number.
6. Stage 2 prepares and structures everything Stage 3 needs.

## Decisions taken (2026-09-16)

| Question | Decision |
|---|---|
| House estimate in the maths? | **No — model + comps only.** The printed estimate stays on the report for display and feeds the divergence flag, never the blend. |
| House bias | **Shown as its own factor** in the contribution chart ("sale house: Forum ×0.71"), not hidden in a caveat. |
| Contribution method | **Exact log-linear.** For a linear model, SHAP_j = β_j · (x_j − E[x_j]). This is exact, needs no second model and runs with no Python at appraisal time. |
| Condition / subject | **Measured terms only.** Subject is left out (ablation Δ 0.000). Condition is a separate, labelled adjustment from Stage 1 and the appraiser's notes, marked as unmeasured, not presented as a model term. |

**Accuracy cost of leaving the estimate out:** when a lot has an estimate, estimate × 0.82 predicts
the hammer at MAE(log) 0.24–0.28 (90–93% within 2x). The no-estimate blend manages 0.64–0.78
(58–70% within 2x) on the same lots, roughly 2.5x the error. This plan follows the decision, but
it shows the estimate next to the blended range, and a large gap between them raises the
identity/divergence flag (flagged lots: MAE 0.331 vs 0.210 unflagged).

## Target architecture

```
Stage 1 (VEA, 1b, 1c, 1d) ─┐
                           ├─► Stage 2a/2b ─► buildValuationEvidence()  [code, end of Stage 2]
                           │                        │  ValuationEvidence (typed, persisted on the report)
                           │                        ▼
                           │               Stage 3a  blendValuation()   [code, pure, deterministic]
                           │                        │  range + waterfall + witnesses + flags
                           │                        ▼
                           │               Stage 3b  narrateValuation() [LLM, narration only]
                           ▼                        ▼
                                           ReportView: range, waterfall chart, narration
```

### Stage 2 output contract: `ValuationEvidence`

Built **in code** once Stage 2b has finished, from the outputs of Stage 1, 2a and 2b plus graph
reads. Every field records where it came from, so the chart can say "signature: hand-signed
(appraiser notes)".

```ts
interface Sourced<T> { value: T | null; source: "vea" | "appraiser" | "stage2b" | "catalogue" | "default"; note?: string }

interface ValuationEvidence {
  artist: { reported: string; canonical: string | null; profile: ArtistPriceProfile | null };
  attrs: {                                   // exactly the model's columns — nothing it cannot price
    signature: Sourced<SignatureClass>;
    proof: Sourced<ProofClass>;
    editionSize: Sourced<number>;
    areaCm2: Sourced<number>;
    process: Sourced<string>;
    catalogueCited: Sourced<boolean>;        // only once Phase 2 adds the column
  };
  targetHouse: Sourced<string>;              // the house the price is AT; drives the house factor
  valuationDate: string;                     // sale-year effect
  comps: {
    sameWork: { hammerGBP: number; saleDate: string; house: string; lotRef: string; url: string | null }[];
    sameArtistTechnique: { n: number; medianHammerGBP: number; latest: string | null } | null;
    sameArtist: { n: number; medianHammerGBP: number; latest: string | null } | null;
    web: CitedWebComp[];                     // Stage 2b finds the graph lacks; display + corroboration only
  };
  condition: { grade: "GOOD" | "FAIR" | "POOR" | null; defects: string[]; source: string };
  sellThrough: { sold: number; unsold: number } | null;
  printedEstimate: { lowGBP: number; highGBP: number; house: string } | null;   // display + divergence only
  identity: { workIds: string[]; confidence: string; misattributionRisk: string | null };
}
```

Most of this is already collected piecemeal: `queryAuctionComparables`, `resolveLotWorkIds`,
`queryArtistPriceProfile`, `price_attrs.ts`, `attributed_lot.ts` and the Stage 1c appraiser parse.
The work is putting it into one typed object. Stage 3 then does no graph reads of its own, and
2b's prompt is changed so it fills the gaps in `attrs` instead of writing prose.

### Stage 3a: `blendValuation(evidence, calibration)` (pure)

- **Witnesses:** `priors_model`, `same_work` (a kernel density over the actual hammers),
  `same_artist_technique` and `same_artist`. There is no `estimate` witness, so the blend always
  runs in the `no_estimate` regime.
- **Confidence from the evidence** (the user's point 2). The calibration already does this, and
  this plan extends it:
  - same_work sigma per comp-count band: 0.54 at n=1, 0.40 at n=2, 0.44 at n≥3. **Add comp age
    as a key** (step 8 left it out). Recent n≥3 is the tightest cell, and old or single comps
    widen it.
  - tier 2 sigma 0.72, tier 3 1.00: looser by construction.
  - priors model sigma per basis: shrunk/prior 0.58, segment 0.88.
  - The fitted pool weights and temperature keep the 80% interval honest.
- **Output:** median, **p10–p90 range** (the estimate range), the witness table with effective
  weights, divergence flags, and P(sells) as a separate hurdle that never shifts the price.
- **Condition:** applied after the blend as its own labelled multiplier, shown as a separate bar.

### House bias as a factor

On Forum the no-estimate blend failed its gate because every witness carries a house offset:
Forum sells about 1.45x below the Bonhams reference, and the model had never seen Forum. The fix
also produces the factor the user wants on the chart:

1. Measure a per-house offset for every house with hammer data (Bonhams, Roseberys, Forum,
   Skinner, Swann), from repeat sales of the same work where possible (step 7), falling back to
   the pooled residual. It is written into the `PricingModelRun` / calibration JSON, not into
   code.
2. Apply it to the model's `house` term **and** to the comp witnesses. A comp's hammer is moved
   from its own house to the target house, so a Bonhams comp for a Forum lot is adjusted before
   blending.
3. On the chart it is one bar, "Sale house: Forum Auctions ×0.71 (vs Bonhams reference)", with
   a tooltip listing the comp re-basing.
4. The target house is the lot's house when there is one. Otherwise the user chooses it, and
   `ValuationEvidence.targetHouse.source = "default"` makes the report say which house the price
   assumes.

### Contribution waterfall (exact)

For the log-linear model, with E[·] the training-population mean of each column (to be written to
`PricingModelRun` by `build_priors.py`, which does not store it today):

```
market baseline        = E[log hammer]                         (the average modelled print)
+ artist               = artist level + Σ β·E[x] − baseline     (who made it)
+ signature            = β_sig  · (x_sig  − E[x_sig])
+ proof / edition / size / process / citation   (same form, one bar each)
+ sale house           = β_house(target) − E[β_house]            (the house bias factor)
+ sale year            = year effect − E[year effect]
= pricing model price  (exactly: the bars sum to μ_model)
+ market comps pull    = blend median − μ_model                  (labelled with n, tier, recency, effective weight)
+ condition            = labelled adjustment, "not a measured model term"
= final median, drawn with its p10–p90 band
```

The first block adds up exactly, which is the SHAP efficiency property. The comps-pull bar is one
bar rather than one per witness, because a grid posterior's median is not additive in its inputs.
Its tooltip lists each witness's effective weight, so nothing is presented as more exact than it
is. A unit test checks that the bars sum to μ_model to 1e-9 for every basis (artist / prior /
segment).

Rendering: `src/components/ReportView.tsx` has no chart library. Build a small inline-SVG
`ValuationWaterfall` component (horizontal bars in ×multiplier and £, with light and dark themes)
rather than adding a dependency.

### Stage 3b: narration (LLM)

- Input: the computed waterfall, witness table, range, flags and the printed estimate, never raw
  comps to reason over.
- Output schema: `keyDrivers[]` ({factor, direction, why}), `narrative` (3–6 sentences),
  `caveats[]` (house assumed, thin comps, divergence, condition unmeasured), and `nextSteps`.
  **No numeric fields.**
- A code-side check fails the narration if it quotes a £ figure or a multiplier that isn't in the
  table, then retries once. The number is never taken from the LLM.
- Model: Haiku 4.5 should be enough for narrating a fixed table. Check it against Sonnet on 20
  lots before choosing.
- `valuationReasoning` (the current schema) is filled in from the computed table in code rather
  than written by the model.

## Phases and gates

| # | Work | Gate before moving on |
|---|---|---|
| 1 | **House offsets + comp re-basing + comp-age key** in `price_blend.ts` / `blend_gate.ts`; column means into `PricingModelRun` | Re-run the step-8 gate, no-estimate regime, **Roseberys → Forum**: 80% coverage 75–85% and MAE(log) better than the best single witness (0.802). Report the split by the best tier reached. |
| 2 | **`catalogue_cited` column** in `build_priors.py` (CatBoost SHAP ranked catalogue 4th, mean \|SHAP\| 0.122) | Temporal ablation improves MAE(log). If not, the column stays out and the chart never shows citation. |
| 3 | **`ValuationEvidence` builder** at the end of Stage 2 + persistence on the report | Parity: across the backtest pool, the evidence object gives the same comps / profile / attrs as the current Stage 3 reads. |
| 4 | **Stage 3a wired, shadow mode:** the blend runs next to the current LLM estimate, which is still the one shown | Backtest-pool run: blend vs current Stage 3 on hammer, MAE(log) + coverage. Agree the switch with the user; this changes live price predictions. |
| 5 | **Waterfall component + Stage 3b narration**, then the switch | Sums-to-model unit test; narration number-guard passes on the pool; visual check in both themes. |

Freshness: `check_price_priors_fresh.py` also covers the house offsets and the blend calibration.
All three go stale on the same events (bulk ingest, artist merge, a new `PricingModelRun`).

## Open items

- **Houses with no hammer data** (a dealer sale, a house the graph lacks): use the pooled
  offset, widen sigma and name the fallback on the chart.
- **Condition multiplier:** the 20/40/75% bands in the current prompt have never been measured.
  They are carried over as-is and labelled as such until there is a condition ingest.
- **Attributed-lot mode** currently anchors on estimate × 0.82. Under this plan it switches to the
  blend like every other path. Given the accuracy cost above, check this with the user before
  Phase 4 is switched on.

## Phase 1 result (2026-09-16): house offsets built; the gate passes leave-one-house-out, fails fit-on-one-house

**Built.**
- `knowledge_graph/pricing_ml/house_offsets.py` (read-only against the graph) fits
  `log hammer = work FE + house + sale year + signed` over every ConceptualWork with ≥2 dated,
  sold, hammer-priced records. That is 13,524 records on 5,101 works, 871 of which sold at two
  or more houses. The fit leaves out the 7,500 gate lots, then uses a work-cluster bootstrap.
  Output: `blend/house_offsets.json`.
- `price_blend.ts`:
  - every comp is re-based from its own house to `targetHouse`;
  - the tier-2/3 medians are re-taken after re-basing;
  - the priors model's per-artist `house=` term is swapped for the measured offset, so the
    chart has one house bar;
  - an unmeasured target house carries the between-house SD in quadrature;
  - same-work calibration keys add the newest comp's age (`3+|recent`, falling back to `3+`
    and then `all`);
  - the interval temperature is fitted per evidence tier.
  - Unit tests: 65 pass.
- The harness records `targetHouse` and each comp's house. `blend_gate.ts --house-offsets`
  prints a PHASE-1 GATE verdict.

**Like-for-like offsets vs Bonhams** (same work, year and signed held fixed; 90% CI):

| house | offset | CI |
|---|---|---|
| Forum | ×0.85 | 0.78–0.89 |
| Roseberys | ×0.92 | 0.87–0.96 |
| Skinner | ×0.81 | 0.75–0.87 |
| pooled fallback | ×0.92 | between-house SD 0.08 |

Step 8 inferred ×0.71 for Forum from priors-witness residuals. Most of that gap was mix and
model misfit, not a house effect. Within-work tau is 0.49. Swann has no hammer prices, so it
falls back to the pooled offset.

**Gate** (no estimate, out of sample; runs `*_n2500_blend_house.jsonl`, seed 11, same lots as step 8):

| fit → test | offsets | 80% cover | MAE(log) blend vs best single | geo |
|---|---|---|---|---|
| Roseberys → Forum | no | 67% | 0.726 vs 0.723 | 1.35 |
| Roseberys → Forum | yes | 69% | 0.679 vs 0.712 | 0.97 |
| Roseberys+Bonhams → Forum | yes, per-tier T | **77%** | **0.671 vs 0.714** | 1.07 — PASS |
| Forum+Bonhams → Roseberys | yes, per-tier T | 85.3% | 0.593 vs 0.695 | 1.12 — fails coverage by <0.5 pt, on the wide side |
| Forum+Roseberys → Bonhams | yes, per-tier T | **75%** | **0.639 vs 0.736** | 0.86 — PASS |

- The offsets remove the bias: Roseberys → Forum geo goes from 1.35 to 0.97.
- A single-house fit still fails on coverage because it learns that house's own dispersion.
  Fitted on two houses and tested on the third, the blend passes on Forum and Bonhams, and is
  0.3 pt too wide on Roseberys.
- Per-tier temperature fixed 1–2 same-work comps, which covered 69–70% on every held-out
  house and now cover 79–80%.
- The production calibration (`blend/calibration.json`, BLEND-1.1) is fitted on all three
  houses (5,094 lots).

**Range width by evidence** (BLEND-1.1, no estimate; median p90/p10):

| evidence | p90/p10 | ≈ ± around median |
|---|---|---|
| same_work 3+, recent | 3.4x | 1.84x |
| same_work 1–2 | 3.5x | 1.86x |
| same_work 3+, old | 4.1x | 2.03x |
| same-artist technique | 6.7x | 2.59x |
| same artist | 9.2x | 3.04x |
| priors model only | 30x | 5.5x |

Three or more recent same-work sales are barely tighter than one or two. The within-work spread
(tau 0.49) dominates, so more comps of the same print narrow the range less than expected. The
ordering the user asked for holds, but the steps between same-work tiers are small.

**Still wrong, logged, not fixed:**
1. **Bonhams reads 14% low (geo 0.86; same-work n≥3 geo 0.77, cover 69%).** Comps are not
   time-adjusted: a 2016 comp for a 2024 lot carries no market drift. `house_offsets.json`
   already holds the year effects, so re-basing comps in time works the same way as re-basing
   in house. This is the next item.
2. **Priors-model-only lots** cover 67–93% depending on the held-out house. They are few (135–313
   per house) and the widest ranges, but still the least trustworthy tier.
3. `check_price_priors_fresh.py` does not yet cover `house_offsets.json` or `calibration.json`.

## Phase 1b result (2026-09-16): comp time adjustment — adopted, but comp age was not what made Bonhams read low

**Built.** `timeShift` in `price_blend.ts` moves each comp forward using the repeat-sales year
index from `house_offsets.json`. Prices rise to a peak in 2022 (×1.15 vs 2020) and fall to
×0.77 in 2026, relative to 2020. It applies to same-work and tier-2/3 comps alike. The
`--time-adjust` modes:
- `prior_year`: brings older comps up to the level of the year before the valuation, the latest
  level a valuer could know.
- `sale_year`: brings them to the lot's own year. That year's level is not known before the
  sale, so this is a leaky upper bound for backtests only.

Comps are never moved backwards. Unit tests: 72 pass.

**Leave-one-house-out, no estimate** (none = the phase-1 run):

| held out | mode | 80% cover | MAE blend vs best single | geo | same-work 3+: MAE / geo / cover |
|---|---|---|---|---|---|
| Forum | none | 77% | 0.671 vs 0.714 | 1.07 | 0.433 / 1.11 / 79% |
| Forum | prior_year | 76% | 0.671 vs 0.706 | 1.05 | 0.419 / 1.07 / 80% |
| Roseberys | none | 85% | 0.593 vs 0.695 | 1.12 | 0.400 / 1.11 / 85% |
| Roseberys | prior_year | 85% | 0.595 vs 0.699 | 1.13 | 0.404 / 1.13 / 83% |
| Bonhams | none | 75% | 0.639 vs 0.736 | 0.86 | 0.493 / 0.77 / 69% |
| Bonhams | prior_year | 77% | 0.634 vs 0.728 | 0.87 | 0.460 / 0.82 / 77% |

`sale_year` is within 0.01 of `prior_year` everywhere, so the honest variant costs almost
nothing. On Bonhams, the most dated house, same-work comps improve most: MAE −0.033 and
coverage 69% → 77%. The overall Bonhams under-read barely moves (geo 0.86 → 0.87).
**Adopted:** BLEND-1.2 calibration, fitted on all three houses with `prior_year`.

**What actually makes Bonhams read low: a house-mix bias the like-for-like offset cannot see.**
Raw witness residual `median(log hammer − witness)`, after house re-basing and time
adjustment:

| test house | same_work | same-artist technique | same artist | priors (shrunk) |
|---|---|---|---|---|
| Forum | ×0.94 | ×0.92 | ×0.74 | ×0.83 |
| Roseberys | ×0.91 | ×0.85 | ×0.77 | ×0.74 |
| Bonhams | ×0.99 | ×1.05 | ×1.12 | ×0.94 |

- Same-work comps are close to unbiased at every house. The like-for-like offset does its job
  where the comparison really is like for like.
- The artist-level witnesses read high at Forum and Roseberys and slightly low at Bonhams. The
  regional houses sell the cheaper works of a given artist. That is a *mix* effect, not a price
  level, and it lands on exactly the witnesses a lot without same-work comps depends on.
- A calibration fitted on Forum and Roseberys learns "shade artist-level witnesses down ~25%"
  and applies it to Bonhams.

**The fix, and a decision it needs:** key the tier-2/3 and priors witness bias by the lot's
house (a mix factor per house), falling back to pooled for a house the fit has not seen. This
cannot be tested leave-one-house-out, because a held-out house has no mix key by definition.
It needs a within-house temporal split (fit before 2023, test from 2023). It also changes what
the house bar on the chart means. Either the bar shows like-for-like price level plus the
house's mix (one bar, "what lots at Forum typically fetch vs comparable Bonhams evidence"), or
it shows two bars, "house price level" and "house mix". Not started; this is for the user to
decide.

## Phase 1c result (2026-09-16): house mix built as a separate term, and it does not hold up over time — left off

**Built** (the user chose two chart bars: house price level, and house mix):
- `WitnessCalibration.houseMix` is a per-target-house bias on the artist-level witnesses
  (`HOUSE_MIX_SOURCES`: tier 2, tier 3, priors model). It is added to the key bias, so it can
  be reported as its own term.
- `PriceWitness.keyBias` and `PriceWitness.houseMix` expose the two parts for the waterfall.
- `fitBlendCalibration({ houseMix: true })` fits it. `blend_gate.ts` gains `--house-mix`,
  `--split-date` (fit on earlier lots, test on later ones, comma-separated files allowed) and a
  per-house gate verdict.
- Unit tests: 80 pass.

**Gate within houses over time** (all three houses; `prior_year` time adjustment; no estimate;
per-house MAE(log) / geo):

| split | mix | overall MAE / geo / cover | Bonhams | Forum | Roseberys |
|---|---|---|---|---|---|
| 2021 | off | 0.613 / 0.97 / 79% | 0.574 / 0.89 | 0.652 / 1.01 | 0.589 / 0.97 |
| 2021 | on | 0.619 / 0.89 / 80% | 0.566 / 0.96 | 0.663 / 0.87 | 0.595 / 0.88 |
| 2023 | off | 0.621 / 0.97 / 80% | 0.589 / 0.93 | 0.656 / 1.01 | 0.584 / 0.92 |
| 2023 | on | 0.628 / 0.91 / 78% | 0.583 / 1.02 | 0.661 / 0.93 | 0.598 / 0.83 |
| 2024 | off | 0.629 / 0.96 / 78% | 0.593 / 0.91 | 0.653 / 1.03 | 0.599 / 0.87 |
| 2024 | on | 0.633 / 0.90 / 79% | 0.590 / 0.98 | 0.654 / 0.95 | 0.611 / 0.79 |

- Every row passes the gate, overall and per house (coverage 76–83%; the blend beats the best
  single witness at every house).
- At all three split dates the mix term fixes Bonhams (MAE −0.003 to −0.008, geo moves to
  0.96–1.02), but it pushes Forum and Roseberys too low (Roseberys geo down to 0.79–0.88), and
  overall MAE is worse by 0.004–0.007.
- The mix fitted on earlier sales (Forum ×0.74–0.91, Roseberys ×0.82–0.90, Bonhams ×1.11–1.21)
  over-corrects later ones: what a house sells is not stable over time.

**Also:** without the mix term, the temporal gate already puts Bonhams at geo 0.89–0.93. The 0.86
under-read seen leave-one-house-out was mostly the calibration never having seen Bonhams lots,
which a production calibration fitted on every house does not suffer from.

**Decision needed.** The house-mix term is built but `calibration.json` stays BLEND-1.2 with the
mix off. Applying it would make prices slightly worse overall, and a chart bar for it would show
a correction that does not generalise. Options: keep it off and show one house bar (price level
only); or apply it anyway for the Bonhams gain. Not wired into anything.

**Decided 2026-09-16:** house mix stays off. The chart shows ONE house bar, the like-for-like price
level from `house_offsets.json`. The `houseMix` code stays in place for a later re-test (for
example once more post-2024 lots exist) but is never fitted into the production calibration.

## Phase 2 result (2026-09-16): catalogue citation fails its gate, not added to the model

`build_priors.py --with-citation` adds a 0/1 `catalogue_cited` elasticity column (presence
only: which catalogue is an artist proxy). Same export (`all_sales_with_subject.csv`), same
temporal cut (2024-07-01):

| earlier sales | without | with |
|---|---|---|
| 5–15 | 0.693 | 0.688 |
| 15–40 (k=30) | 0.684 | 0.686 |
| 40–100 | 0.633 | 0.631 |
| 100–300 | 0.604 | 0.607 |
| 300+ | 0.688 | 0.697 |
| **all, chosen kappa 30** | **0.652** | **0.654** |

The effect is real descriptively. Within Bonhams, with artist, year, signature, edition,
process and area held fixed, a cited lot sells for ×1.42. Across 146 shrunk artists the median
multiplier is ×1.15, but the per-artist range runs from Miró ×0.91 and Picasso ×0.97 to Warhol
×2.03 and Rembrandt ×2.47. It does not help predict later sales. Two likely reasons:

- Citation is a cataloguing choice. Bonhams cites 51% of lots, Roseberys 8.5%, and the cited
  share fell from ~0.45–0.53 before 2014 to ~0.35 after 2022.
- A cited lot is already a better lot on attributes the model has.

For Stage 3 the column would also change meaning. There it would be "Stage 2b found a catalogue
number", not "the house chose to print one".

**Decision:** the production build stays PRICING-PRIORS-1.2. `catalogue_cited` is opt-in for a
future re-test, and the contribution chart has no citation bar. Nothing was written to the graph.
