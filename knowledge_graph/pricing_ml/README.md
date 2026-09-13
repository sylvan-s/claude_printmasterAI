# pricing_ml — a hammer-price model from the lot's own attributes

First test: Pablo Picasso, 2026-09-13. The question was whether technique, signature,
condition, catalogue citation, edition size and (bucketed) dimensions predict the hammer,
and whether that beats the house's estimate.

```bash
# 1. export one artist's sold auction records (hammer, estimates, medium text, edition, dims, citations)
knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/export_sales.py \
    --artist "Pablo Picasso" --out knowledge_graph/pricing_ml/data/picasso_sales.csv

# 2. temporal evaluation + ablation + importance + effects table
knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/train_price_model.py \
    knowledge_graph/pricing_ml/data/picasso_sales.csv --cut 2024-07-01 --importance --effects
```

`data/` is gitignored; regenerate with step 1. The venv is `venv-embeddings` (scikit-learn
1.6, Python 3.9).

## What it does

- Target: log(hammer GBP at the sale-date ECB rate). Gradient-boosted trees
  (`HistGradientBoostingRegressor`), three seeds averaged.
- Features parsed from the export, in `train_price_model.py`: technique family and process;
  signature class (hand / stamped / plate / initialled / unsigned) from the medium text and
  the `signed` flag; proof class (numbered / AP / HC / trial); edition size (declared, else
  "x/N" or "edition of N" in the text) and its band; sheet area and max side (structured
  dims, else the text) and area band; condition grade and defect flags parsed from the
  medium text; catalogue cited (Bloch / Baer / Mourlot / …); publisher and paper keywords;
  work year and decade; sale year and house.
- A **work prior**: the median log-hammer of EARLIER sales of the same ConceptualWork (or the
  same citation) — the same-work comp as a feature, leave-future-out so nothing later leaks.
- **Temporal split**: train on sales before `--cut`, test after. A random split would let the
  model see later sales of the same print.
- Baselines on the same test rows: artist median, same-work prior median, and the house
  estimate midpoint (raw and × 0.82 drift).
- `--effects`: a ridge log-linear model on the one-hot attributes with sale-year effects,
  reported as the multiplier each level carries against a reference level.

## Result on Picasso (1,385 sales 2010–2026, books/sets dropped; test = 212 sales from 2024-07)

| predictor | MAE(log) | ±25% | within 2x |
|---|---:|---:|---:|
| artist median | 0.794 | 24% | 60% |
| attributes only | 0.601 | 32% | 71% |
| attributes + work prior | 0.575 | 34% | 72% |
| same-work prior alone (86 rows that have one) | 0.373 | 44% | 84% |
| **house estimate midpoint, raw** | **0.340** | 38% | **91%** |
| attributes + work prior + estimate | 0.358 | 42% | 87% |

The attributes explain a real share of the variance — a quarter off the artist-median error,
with **signature the dominant attribute** (removing it costs +0.10 MAE), then sheet size,
edition size, the work prior, paper and publisher. But adding the attributes to the estimate
does not improve on the estimate: the house has already priced them, plus what the model
cannot see. The largest misses are rarity and state — a Baer state IIa "one of four
recorded impressions" at £223,530 predicted at £3,845; "a rare aquatint" at £10,000
predicted at £509. Those words are in the text and are exactly what a reader prices.

Effects (multiplier vs reference, other attributes fixed, all rows):
hand-signed ×2.20 vs unsigned; stamped signature ×0.97; trial proof ×1.71 and HC ×1.24 vs
numbered, AP ×0.96; edition >300 ×0.52 and 31–75 ×1.56 vs 76–150; sheet area ×1.19 per
doubling; Montval paper ×2.50, Japan ×1.81, Arches ×1.59 vs other; linocut ×1.74,
aquatint ×1.41, etching ×1.12 vs lithograph; Roseberys ×0.78 and Skinner ×0.69 vs Bonhams;
2026 ×1.38 vs 2010. Read these as descriptive: paper and publisher are proxies for which
suite a print belongs to, and "condition stated" (×1.3–1.6) is the older Bonhams cataloguing
of better lots, not a condition effect.

## Data facts this surfaced

- **Condition is not in the graph.** No condition field is ingested; Bonhams' medium text
  carried a condition sentence on ~19% of lots up to 2019 and on none since 2020. On the test
  period every lot is "condition unknown". A condition feature needs the condition report
  ingested, or Stage 1a's own read of the image.
- **Bonhams' stored GBP estimates are the hammer.** `estimateLowGBP` / `estimateHighGBP` come
  from the API's `gbp_low_estimate`, which Bonhams overwrites with the sold price after the
  sale; both equal `hammerPriceGBP` on every sold row. The native `estimateLow` / `estimateHigh`
  are real (Picasso hammers land at 0.88× their midpoint, p10 0.63, p90 1.6). The export and
  the comps query now use native ÷ `fxRateToGBP`; the stored properties await a repair
  (spawned task).
- The market drift is house- and period-specific: 0.82 on Roseberys/Forum 2016–2026, ~0.98
  on Bonhams Picasso 2024–2026.

## What it is good for

- **An adjustment table** for same-work comps: the multipliers above are the learned version
  of "unsigned is worth 60–70% less" that Stage 3 was guessing (it is ~55% less, and edition
  size and paper move it further).
- **A fallback where no estimate exists** — our own number from scratch, within 2x on 71% of
  lots, which is better than tier-2 comps (61–66%) and close to same-work comps.
- **Not** a replacement for the estimate where one exists.

## Next

Rarity/state words (rare, unique, one of N, state, proof aside from the edition) as features;
condition from Stage 1a's read rather than the catalogue; a second artist with a different
market shape (Hockney, Hirst) to see whether the effects transfer.
