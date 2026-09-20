# The print market by sale year: a repeat-sales index, with and without dollar sales, by segment, and against Swann

**Date:** 2026-09-16
**Status:** Research note. The GBP-only index is built (`blend/house_offsets_gbp_years.json`) and
tested in the Stage 3a temporal gate, as is re-pricing dollar comps at the valuation-date rate.
Neither is **adopted**: production still reads the
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
5. **The boom and bust was driven by modern and contemporary prints, and it was transatlantic.**
   Prints by artists born 1945 or later rose 2.5-fold from 2015 to 2022 and are still falling in
   2026. US dollar hammer prices (Bonhams New York, Skinner) trace the same peak and fall as London.
   See "The 2020–22 boom and bust".
6. **Older prints have been in long nominal decline in both London and New York.** This covers
   artists born before 1900, from Rembrandt to early modernists such as Picasso and Miró. Swann,
   which sells almost nothing else, had no COVID boom at all: its prices fell about 30% in dollars
   from 2016–18 to 2025. See "Swann comparison".

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
  against 2025's $1.32. Re-pricing each foreign-currency comp at the valuation date's rate was
  built and gated. It made no measurable difference (next section).
- **Nominal, not real.** Neither index deflates by inflation.
- **Thin early years.** Sterling-only years before 2010 have under 200 sales, and their bands are
  wide (roughly ±10–17%).
- **Unmeasured composition.** A work fixed effect holds the print constant, not its condition or
  frame. If the prints that resold in 2021–22 were systematically better copies, the boom is
  slightly overstated.
- **The pricing model has its own year effects** (`priors_stage3a/artist_elasticities.json`), fitted
  cross-sectionally on all currencies. They show the same peak (about +0.37 log in 2021–22) and
  would carry the same pre-2019 currency drift. Untested.

## The 2020–22 boom and bust

`knowledge_graph/pricing_ml/market_index/segment_index.py` refits the sterling-only index on subsets
(100 bootstraps per subset). The sample differs slightly from the main index: every sterling sale
with a dated repeat sale and a resolved artist, with no gate-lot exclusion (8,208 sales on 3,081
works). The all-sales row therefore reads a little differently from the table above.

Level relative to 2025 [90% band]:

| Segment | 2015 | 2019 | 2022 | 2026 (part) |
|---|---|---|---|---|
| All sterling sales | 1.05 [0.96–1.14] | 1.09 [1.02–1.18] | 1.43 [1.35–1.50] | 0.96 [0.91–1.01] |
| Artist born 1945+ | **0.59** [0.48–0.74] | 1.06 [0.94–1.23] | **1.50** [1.39–1.64] | **0.90** [0.82–0.99] |
| Artist born 1900–1944 | 1.08 [0.96–1.20] | 1.03 [0.93–1.14] | 1.36 [1.24–1.51] | 1.00 [0.91–1.08] |
| Artist born before 1900 | 1.35 [1.14–1.52] | 1.30 [1.13–1.46] | 1.30 [1.14–1.46] | 0.98 [0.86–1.08] |
| Work usually under £500 | 1.33 [1.04–1.76] | 1.24 [1.07–1.42] | 1.52 [1.36–1.70] | 0.94 [0.85–1.04] |
| Work usually £500–2,000 | 1.25 [1.14–1.38] | 1.15 [1.04–1.29] | 1.47 [1.39–1.59] | 0.94 [0.89–1.03] |
| Work usually £2,000+ | 0.74 [0.64–0.86] | 0.91 [0.82–1.04] | 1.25 [1.09–1.38] | 1.01 [0.94–1.13] |

The most-resold artists born 1945 or later are Banksy, Damien Hirst, Tracey Emin, Takashi Murakami,
David Shrigley, the Connor Brothers, Keith Haring and Julian Opie. "Usually" is the work's median
hammer across its sales. Grouping on that is a mild selection effect, since a work's own prices set
its tier.

Three movements sit inside the overall index:

1. **Contemporary boom and bust.** The 1945+ segment rose from ×0.59 (2015) to ×1.50 (2022) and is
   the only segment clearly still falling in 2026.
2. **Modern and post-war boom, fully reversed.** The 1900–1944 segment was flat before 2020, rose
   about a third, and is back at its 2019 level.
3. **Slow decline underneath.** Pre-1900 artists and cheaper prints have drifted down since at least
   2015, with a COVID bump on top. Works usually above £2,000 are the only group above their 2015
   level.

**Sell-through and supply** (sterling records):
- Sell-through peaked in 2020–21: Bonhams 85% (67–77% before), Roseberys 79% (61–69% before). Both
  were back near 70% by 2024–25.
- Offered lots rose after the peak: Roseberys from about 940 (2019) to 1,500–1,600 a year in 2022–24,
  Forum from about 570 (2022) to about 2,250 (2024–25). This may partly reflect the graph's coverage
  of each house by year, so treat it as a pointer rather than a measurement.
- Bonhams' median sterling hammer fell from £2,000 (2021) to £1,100 (2026), partly a change of mix.

**Likely causes.** These are wider market events, not measured in this data. They fit the timing but
are not tested against it.

- *Boom, 2020–22.* Lockdown savings, Bank Rate at 0.1% and rising asset prices. Auctions moved
  online and brought in new bidders, and prints are the easiest art to buy online. Crypto and NFT
  wealth chased contemporary names, which fits the 1945+ segment rising most.
- *Reversal, from 2023.* Bank Rate rose to 5.25% by August 2023. UK inflation peaked above 11% in
  late 2022, with a cost-of-living squeeze. Crypto crashed in 2022. Boom-era buyers began to resell,
  consistent with the rise in offered lots. Industry reports (Art Basel/UBS) recorded shrinking global
  art sales in 2023 and 2024.
- *No return to growth.* In sterling there was no pre-2020 growth to return to (finding 3). Rates
  remain well above their 2010s level, the speculative segment is still deflating, and older and
  cheaper prints were already declining before COVID. After UK inflation of roughly 30% since 2019,
  real prices are well below pre-COVID levels.

## Swann comparison

Swann Auction Galleries (New York) is in the graph differently from the other houses. It has 10,392
sold lots from 2016-09 to 2026-04, priced in dollars as the price *realised* (with buyer's premium):
no hammer and no sterling conversion. Stage 3a comps and the year index above therefore never use
Swann. `knowledge_graph/pricing_ml/market_index/swann_index.py` fits the same repeat-sales model,
2016–2026, separately for three markets:

| Year | UK sterling hammer | US dollar hammer (Bonhams NY, Skinner) | Swann, dollar price realised |
|---|---|---|---|
| 2016 | 0.91 [0.81–1.01] | 1.04 [0.91–1.17] | **1.42** [1.35–1.53] |
| 2017 | 0.92 [0.82–1.02] | 1.01 [0.89–1.11] | 1.41 [1.35–1.49] |
| 2018 | 1.02 [0.92–1.10] | 0.98 [0.83–1.07] | 1.47 [1.39–1.59] |
| 2019 | 1.11 [1.03–1.22] | 0.98 [0.89–1.07] | 1.35 [1.26–1.44] |
| 2020 | 1.35 [1.24–1.45] | 1.14 [1.03–1.23] | 1.26 [1.18–1.34] |
| 2021 | 1.40 [1.31–1.47] | 1.44 [1.32–1.56] | 1.49 [1.41–1.62] |
| 2022 | 1.40 [1.32–1.48] | **1.46** [1.35–1.57] | 1.32 [1.24–1.41] |
| 2023 | 1.20 [1.14–1.27] | 1.19 [1.11–1.28] | 1.19 [1.13–1.26] |
| 2024 | 1.14 [1.10–1.18] | 1.08 [1.01–1.17] | 1.13 [1.05–1.23] |
| 2025 | 1.00 | 1.00 | 1.00 |
| 2026 (part) | 0.95 [0.90–1.00] | 1.00 [0.91–1.13] | 1.16 [1.06–1.31] |
| Repeat sales | 5,429 | 2,839 | 5,384 (1,745 works) |

The UK column is refitted on 2016–2026 sales only, so it differs slightly from the main table.

**Swann sells a different market.** Its most-resold artists are Rembrandt, Dürer, Thomas Hart Benton,
Picasso, Whistler, Chagall, Piranesi, Miró, Martin Lewis and Tamayo. 91% of its repeat sales are by
artists born before 1900, and 2 are by artists born after 1945.

**Reading.**
- **The boom and bust was transatlantic.** US dollar hammer prices were flat from 2016 to 2019, peaked
  at ×1.46 in 2022 and were back to ×1.00 by 2025, almost matching London. The drivers were global,
  not British.
- **Swann had no boom.** It dipped in 2020 (×1.26, the year lockdown disrupted sales), rebounded for
  one year in 2021 (×1.49), then fell steadily to ×1.00. From 2016–18 that is a nominal fall of about
  30%, and about half in real terms after US inflation of roughly a third.
- **Older prints are declining in both markets.** Swann's pre-1900 segment falls from ×1.44 (2016)
  to ×1.00, in line with the UK pre-1900 segment (×1.35 in 2015 to ×1.00). The decline shows across
  Swann's price tiers: works usually $1,000–5,000 fell from ×1.43 to ×1.00, and $5,000+ from ×1.38.
  Swann's 1900–1944 segment has only 347 repeat sales, with wide bands.
- **Swann's volume moved against price.** Sell-through rose from 68–71% before 2020 to 75–80% since,
  while offered lots fell from about 2,100 (2017) to about 800 (2025) and the median price realised
  fell from $3,000 to about $1,900. That fits a house setting lower estimates and reserves to clear a
  thinner market, though the graph's coverage of Swann's recent sales is unchecked.
- **For "no return to growth".** For older prints, returning to growth would mean reversing a decline
  that predates COVID. An ageing collector base and shifting taste are plausible reasons, but untested.

**Swann-specific caveats.**
- Prices include buyer's premium. If Swann raised its premium rate over the decade, the hammer decline
  is steeper than shown. Its premium history is unchecked.
- The 2026 rise (×1.16) rests on 118 repeat sales from the spring sales alone and may reflect the
  season's mix rather than a turn.
- Converting Swann to sterling at sale-date rates gives the same shape, with 2022 raised to ×1.44 by
  the weak pound.
- Works that sold only once at Swann do not enter the index. 1,745 of 6,753 sold works resold there.

## Follow-up: re-pricing dollar comps at the valuation-date rate

**Built, gated, not adopted.** Code is in place with the switch off, so production behaviour is
unchanged.

- `knowledge_graph/fx_series.ts`: `fxLogShift(currency, compDate, valuationDate)` = ln(rate at the
  comp's sale) − ln(rate at the valuation date), using the committed ECB series. Adding it to a
  comp's log GBP hammer re-prices the native hammer at the valuation date's rate.
- `price_blend.ts`: `CompSale` carries `currency` and `fxLogShift`. `HouseOffsets.fxReconvert` applies
  the shift before the house and time adjustments; the witness basis says so. BLEND-1.4 has no
  `fxReconvert`, so nothing moves.
- Live evidence now carries each comp's currency (`SourceRecord.priceCurrency` through the comparables
  and same-suite queries) and computes the shift, ready if the switch is turned on.
- Backtest: the harness comps predate the currency field. `tests/backtest/extract_comp_currency.ts`
  recovers it from the graph by house, date and GBP hammer (10,349 non-sterling keys, none shared
  with a sterling record). `refit_blend_calibration.ts --fx-reconvert` applies it. Of 179,154 backtest
  comps, 56,699 (32%) are non-sterling, with a mean absolute shift of 0.079 log (about 8%).

**Gate.** Four variants: year index all-currency or sterling-only, and re-pricing off or on. Scored on
two splits: the standard one (fit before 2024-07, 1,495 lots) and an earlier one (fit before 2018,
3,654 lots). The earlier split puts sterling's 2016 fall inside the scored lots' comp windows. At
that split the year index and model priors were fitted on later sales too. That leak is the same
for every variant, so the comparison between them stands, but the absolute figures are optimistic.

| Split / lots | All-currency index | + re-pricing | Sterling index | + re-pricing |
|---|---|---|---|---|
| 2024: all (1,495) | 0.622, 78% | 0.620, 79% | 0.620, 79% | 0.623, 78% |
| 2024: comps 25%+ non-sterling (444) | 0.648, 75% | 0.648, 77% | 0.645, 77% | 0.650, 76% |
| 2024: … and median comp 3y+ (149) | 0.638, 78% | 0.638, 81% | 0.640, 80% | 0.638, 78% |
| 2018: all (3,654) | 0.611, 79% | 0.610, 79% | 0.611, 79% | 0.610, 81% |
| 2018: comps 25%+ non-sterling (1,174) | 0.623, 76% | 0.623, 76% | 0.625, 76% | 0.625, 78% |
| 2018: … and median comp 3y+ (476) | 0.615, 77% | 0.613, 77% | 0.618, 77% | 0.613, 79% |
| 2018: Bonhams (770) | 0.576, 78% | 0.576, 78% | 0.578, 78% | 0.577, 80% |

MAE(log hammer), then the share inside the 80% range.

**Reading.** Every variant is within 0.003 MAE of every other, in every group, at both splits: below
anything this gate can resolve. Re-pricing does what it should to the level: it lowers the 2018-split
over-pricing (geo ×1.07 → ×1.05, ×1.06 → ×1.04) and lifts coverage by a point or two. It does not
make the median more accurate. Likely reasons:

- the shift is small (8% on average) and applies to a third of the comps;
- the blend's median leans on the pricing model and same-work comps, and heavy-tailed kernels damp
  any one comp group;
- sterling and dollar print prices need not move together. Re-pricing assumes a dollar print holds
  its dollar value, which may be no truer than assuming it holds its sterling value.

The correction is right in principle and harmless in practice. Adopting it, with or without the
sterling index, is a presentation and consistency choice rather than an accuracy gain.

## Reproduce

Year index and gate:

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/house_offsets.py \
        --exclude tests/backtest/comps_hammer/{forum,roseberys,bonhams}_n2500_blend_recency.jsonl \
        --year-currency GBP --out knowledge_graph/pricing_ml/blend/house_offsets_gbp_years.json
    npx tsx tests/backtest/refit_blend_calibration.ts --suite tests/backtest/comps_hammer/suite_comps.jsonl \
        --dry --offsets knowledge_graph/pricing_ml/blend/house_offsets_gbp_years.json

- Drop `--year-currency` (and `--offsets`) for the all-currency index. Every build prints and stores
  its per-year bands (`yearBands`).
- Add `--fx-reconvert` for dollar re-pricing, after `npx tsx tests/backtest/extract_comp_currency.ts`.
- Add `--split 2018-01-01` for the earlier split.

Segment and Swann analyses (read-only; print only, and `swann_index.py` takes an optional JSON output
path):

    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/market_index/segment_index.py
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/market_index/swann_index.py
