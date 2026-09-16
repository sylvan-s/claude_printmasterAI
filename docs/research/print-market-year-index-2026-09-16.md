# The print market by sale year: a repeat-sales index, with and without dollar sales

**Date:** 2026-09-16
**Status:** Research note. The GBP-only index is built (`blend/house_offsets_gbp_years.json`) and
tested in the Stage 3a temporal gate. It is **not adopted**: production still reads the
all-currency index in `blend/house_offsets.json` through BLEND-1.4.
**Context:** Stage 3a moves every comparable sale to the market level of the year before the
valuation (plan `docs/plans/2026-09-16-stage3-blend-valuation.md`, phase 1b). Walking through a
Braque example showed comps from 2020–2023 being marked *down*, which raised two questions: have
print prices really fallen, and how much of the index is the exchange rate?

## Findings

1. **Prices peaked in 2021–22 and have fallen about a quarter to a third since.** The 2022 level
   is ×1.46 [1.39–1.54] of 2025 with all sales, ×1.41 [1.32–1.51] with sterling sales only. The
   fall to 2023 is far outside both bands. Since 2023 prices have drifted down gently. 2026 so
   far is indistinguishable from 2025. These are nominal pounds: after UK inflation (about +25%
   from 2021 to 2025) the real fall is larger.
2. **The 2020–22 boom is not an exchange-rate artefact.** Sterling hit a record low against the
   dollar in 2022, which inflates dollar hammers converted to pounds. Removing dollar sales lowers
   2022 only from ×1.46 to ×1.41. The boom is at least as strong in sterling-priced sales: 2020 is
   ×1.35 against ×1.26.
3. **The long-run rise before 2019 largely is an exchange-rate artefact.** With all sales, 2010–17
   sits at ×0.75–0.95 of 2025, a steady climb. In sterling sales the same years sit at
   ×0.86–1.06: broadly flat from 2010 to 2019 (most years overlap ×1.00), then the 2020 jump. The difference matches
   sterling's fall after the 2016 referendum (annual average $1.58 in 2010–15, $1.30 in 2017–25,
   ECB rates in `knowledge_graph/fx_gbp_ecb.json`). A 2010–15 dollar hammer converts to about
   ×0.80–0.86 of the pounds the same dollars fetch in 2025, which is the gap between the two indices.
4. **For a sterling buyer, an old print has not appreciated much.** Like-for-like, a print that sold
   in London in 2010–2019 fetches about the same nominal hammer today, after a boom and bust in
   between.

## Method

`knowledge_graph/pricing_ml/house_offsets.py` (HOUSE-OFFSETS-1.1), read-only against the graph.
Every ConceptualWork with at least two dated, sold, hammer-priced auction records enters one sparse
least-squares fit:

    log hammer GBP = work fixed effect + house effect + sale-year effect + signed effect + error

The work fixed effect holds the print itself constant. A year effect is therefore how the same
works sold that year, not a change in which prints came up. Hammers are converted at the sale-date
rate. The backtest gate lots (`*_n2500_blend_recency.jsonl`) are excluded, as in production.

Bands are 90% work-cluster bootstraps (200 resamples of whole works, refitting each time), taken on
each year's level relative to 2025. 2025 is therefore ×1.00 with no band by construction.

`--year-currency GBP` fits the year index on sterling-priced sales only. House offsets still use
every sale: Skinner sells only in dollars, and dropping them would lose its offset. The all-currency
rebuild reproduces the production `house_offsets.json` exactly (house and year effects identical).

## The index

Level relative to 2025 [90% band]. Sales and works are the repeat-sale records supporting each year.

| Year | All currencies | Sales | Sterling only | Sales |
|---|---|---|---|---|
| 2003 | ×0.70 [0.60–0.81] | 65 | ×0.80 [0.67–0.94] | 62 |
| 2004 | ×0.71 [0.62–0.80] | 109 | ×0.81 [0.72–0.93] | 106 |
| 2005 | ×0.82 [0.76–0.88] | 376 | ×0.95 [0.85–1.09] | 116 |
| 2006 | ×0.77 [0.72–0.83] | 477 | ×0.89 [0.81–1.00] | 126 |
| 2007 | ×0.75 [0.70–0.80] | 487 | ×0.88 [0.78–1.01] | 161 |
| 2008 | ×0.77 [0.71–0.82] | 453 | ×1.00 [0.90–1.12] | 117 |
| 2009 | ×0.77 [0.71–0.83] | 357 | ×0.88 [0.78–0.99] | 88 |
| 2010 | ×0.81 [0.75–0.87] | 488 | ×1.05 [0.97–1.15] | 200 |
| 2011 | ×0.75 [0.71–0.81] | 504 | ×0.86 [0.76–0.95] | 173 |
| 2012 | ×0.78 [0.72–0.84] | 460 | ×1.00 [0.90–1.11] | 196 |
| 2013 | ×0.83 [0.77–0.88] | 533 | ×0.96 [0.87–1.08] | 228 |
| 2014 | ×0.85 [0.81–0.92] | 497 | ×1.06 [0.97–1.15] | 252 |
| 2015 | ×0.91 [0.85–0.98] | 443 | ×1.06 [0.95–1.16] | 241 |
| 2016 | ×0.94 [0.89–1.01] | 371 | ×0.97 [0.86–1.07] | 162 |
| 2017 | ×0.95 [0.89–1.03] | 420 | ×0.96 [0.86–1.07] | 243 |
| 2018 | ×1.00 [0.94–1.07] | 488 | ×1.03 [0.96–1.12] | 281 |
| 2019 | ×1.02 [0.96–1.09] | 595 | ×1.08 [0.99–1.18] | 330 |
| 2020 | ×1.26 [1.19–1.34] | 590 | ×1.35 [1.25–1.47] | 347 |
| 2021 | ×1.36 [1.29–1.43] | 996 | ×1.41 [1.33–1.51] | 565 |
| 2022 | ×1.46 [1.39–1.54] | 947 | ×1.41 [1.32–1.51] | 521 |
| 2023 | ×1.13 [1.08–1.18] | 1,052 | ×1.11 [1.04–1.19] | 519 |
| 2024 | ×1.11 [1.06–1.16] | 1,106 | ×1.13 [1.07–1.20] | 618 |
| 2025 | ×1.00 | 1,068 | ×1.00 | 616 |
| 2026 (part) | ×0.97 [0.92–1.03] | 642 | ×0.96 [0.90–1.02] | 379 |

All currencies: 13,524 sales on 5,101 works. Sterling only: 6,647 sales. Of the sold, dated records
in the graph, Bonhams holds 23,190 in dollars against 15,445 in pounds; Skinner's 1,251 are all in
dollars; Forum and Roseberys are all in pounds.

## Stage 3a temporal gate

`tests/backtest/refit_blend_calibration.ts --suite … --dry [--offsets …]`: calibration fitted on
3,599 lots sold before 2024-07-01, scored on the 1,495 after, file priors and same-suite comps as in
BLEND-1.4. Only the year index differs.

| Lots scored | All-currency index (production) | Sterling-only index |
|---|---|---|
| All (1,495) | 0.622, cover 78%, geo ×0.97 | **0.620**, cover 79%, geo ×0.98 |
| Bonhams (177) | 0.588, 77% | 0.587, 79% |
| Forum (876) | 0.644, 76% | 0.642, 77% |
| Roseberys (442) | 0.591, 83% | 0.589, 83% |
| Median comp under 3 years old (906) | 0.588, 77% | 0.585, 79% |
| Median comp 3–5 years old (404) | 0.606, 78% | 0.605, 79% |
| Median comp 6+ years old (72) | 0.622, 83% | 0.622, 82% |
| With same-suite comps (74) | 0.504, 76% | 0.509, 80% |

MAE is on log hammer. Cover is the share of hammers inside the 80% range.

**Reading.** A tie with a slight, consistent edge to the sterling-only index: MAE lower or equal in
every group but the 74 suite-comp lots, and coverage one or two points closer to 80%. The gate has
little power where the indices really differ. They diverge before 2019, but lots sold after
mid-2024 draw mostly on recent comps: only 72 have a median comp six or more years old.

## Caveats and open threads

- **Dollar comps still carry currency drift.** A sterling index corrects the market level, not the
  conversion. A 2015 Bonhams New York comp converted at 2015's $1.53 still reads about 14% low
  against 2025's $1.32. The fuller fix would reconvert each foreign-currency comp at the valuation
  date's rate before applying the sterling index. It is not built.
- **Nominal, not real.** Neither index deflates by inflation.
- **Thin early years.** Sterling-only years before 2010 have under 200 sales, and their bands are
  wide (roughly ±10–17%).
- **Unmeasured composition.** A work fixed effect holds the print constant, not its condition or
  frame. If the prints that resold in 2021–22 were systematically better copies, the boom is
  slightly overstated.
- **The pricing model has its own year effects** (`priors_stage3a/artist_elasticities.json`), fitted
  cross-sectionally on all currencies. They show the same peak (about +0.37 log in 2021–22) and
  would carry the same pre-2019 currency drift. Untested.

## Reproduce

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/house_offsets.py \
        --exclude tests/backtest/comps_hammer/{forum,roseberys,bonhams}_n2500_blend_recency.jsonl \
        --year-currency GBP --out knowledge_graph/pricing_ml/blend/house_offsets_gbp_years.json
    npx tsx tests/backtest/refit_blend_calibration.ts --suite tests/backtest/comps_hammer/suite_comps.jsonl \
        --dry --offsets knowledge_graph/pricing_ml/blend/house_offsets_gbp_years.json

Drop `--year-currency` (and `--offsets`) for the all-currency index. Every build now prints and
stores its per-year bands (`yearBands`).
