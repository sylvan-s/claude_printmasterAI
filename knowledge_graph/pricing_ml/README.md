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

## Transfer test: do the multipliers move from artist to artist? (2026-09-13)

`transfer_test.py` fits the same log-linear model on ten high-volume artists (Picasso,
Chagall, Miró, Hockney, Warhol, Lowry, Banksy, Hirst, Rembrandt, Lichtenstein; 7,522 sales),
prints their multipliers side by side, and scores each artist's post-2024-07 sales under an
own-artist model, a pooled model (artist intercepts, shared slopes), and Picasso's slopes
with the target's own level ("from Picasso").

Mean MAE(log) over the ten artists: artist median 1.09 · **own 0.69** · pooled 0.76 · from
Picasso 0.84 · house estimate 0.34. Own beats pooled beats transfer for eight of ten; adding
artist-specific slopes for signature/edition/area to the pooled model recovers part of the
gap (Banksy −0.12, Lowry −0.07, Hirst −0.05). Rembrandt gains almost nothing from any
attribute model (0.78 vs 0.81 median): what prices an old-master impression — state, quality,
watermark, provenance — is not in these features.

Where the elasticities differ, read off the table:
- **Edition size inverts by market.** Editions over 300 vs 76–150: Chagall ×0.14, Lichtenstein
  ×0.38, Warhol ×0.47, Picasso ×0.50 — but Banksy ×1.21, Hockney ×1.20, Hirst ×1.09. For the
  modern masters a large edition is a book plate or a poster; for the contemporary names it
  IS the market.
- **Signature** is the most stable (×2.2–2.8 for the modern names), but ×3.4 for Hirst and
  ×1.5 for Rembrandt, where "signed" means in the plate.
- **Screenprint vs lithograph**: Banksy ×5.8, Hirst ×3.3, Picasso ×2.2, ~×1 elsewhere.
- **House**: like-for-like, Roseberys hammers at ×0.36 (Warhol) to ×0.95 (Picasso) of Bonhams,
  pooled ×0.51. Part of this is selection (what each house is consigned, including
  after-Warhol Sunday B. Morning sheets under Warhol's name) and part is the buyer pool.

So: per-artist models where an artist has a few hundred sales; segment-pooled models
(modern-master editions / contemporary editions / old master) as the fallback for thin
artists — a follow-up test; and never a single donor's slopes.

## The priors database: elasticities per artist, shrunk toward similar artists (2026-09-13)

`build_priors.py` → `priors/artist_elasticities.json`, `artist_multipliers.csv`, `neighbours.csv`.

For every artist with ≥15 earlier sales (319 artists, 38,762 sales 2010–2026; since 1.1 also a prior-only entry from 5 sales, see below) it stores each
elasticity three ways — the artist's own estimate with its support, the prior, and the shrunk
value actually to use — plus the artist's price level, the neighbours that formed the prior,
and the descriptor vector. Elasticities are log-linear coefficients on log hammer deflated by
pooled sale-year effects, reference levels dropped (unsigned, numbered, edition 76–150, area
400–900 cm², lithograph, Bonhams); continuous terms per doubling.

    elasticity = (n_own × own + κ × prior) / (n_own + κ),  κ = 60 (chosen on later sales)

The prior is a similarity-weighted mean over the artist's 10 nearest **donor** artists (≥100
earlier sales, 63 of them) in a standardised descriptor space: price level, price spread,
share hand-signed/unsigned, median edition size and sheet area, technique-family mix, share
of artist's proofs, median work year, birth year, house mix, nationality group — price level,
work year and birth year weighted double. A level an artist has never sold (fewer than 3 rows)
takes the prior outright.

MAE(log) on sales from 2024-07, by the artist's earlier-sales count:

| earlier sales | artists | test rows | median | pooled | own | prior only | shrunk κ=60 | estimate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 15–40 | 188 | 851 | 0.746 | 0.689 | 0.707 | 0.703 | **0.679** | 0.433 |
| 40–100 | 68 | 851 | 0.676 | 0.669 | 0.639 | 0.639 | **0.616** | 0.426 |
| 100–300 | 49 | 1,627 | 0.732 | 0.690 | 0.612 | 0.683 | **0.608** | 0.367 |
| 300+ | 14 | 1,577 | 0.972 | 0.776 | 0.686 | 0.772 | **0.684** | 0.343 |

For thin artists the neighbour prior is as informative as the artist's own data, and the blend
beats own, prior and pooled in every band. The gains are modest (0.01–0.03 log), consistent,
and the estimate remains ~0.3 log better everywhere. Sensible neighbours fall out without being
told: Picasso ← Miró, Dalí, Chagall, Hockney; Banksy ← Warhol, Hockney, Hirst, Lichtenstein;
Rembrandt ← Gillray, Renoir, Dürer, Whistler; Chadwick ← Moore, Piper, Frink, Sutherland.

Readable examples (own → prior → stored): Banksy screenprint vs lithograph 6.88 → 1.46 → 5.65
(414 sales keep most of the own value); Banksy edition >300 1.46 → 0.53 → 1.28 (the market
inversion survives shrinkage); KAWS (38 sales) screenprint 2.31 → 1.31 → 1.64; Lynn Chadwick
(39 sales) hand-signed 0.97 → 1.31 → 1.16.

To apply: take a lot's attribute vector, look up the artist's stored elasticities (or, for an
artist below 15 sales, the prior computed from their descriptors' nearest donors), and the
product of the multipliers is the adjustment between two impressions of the same work — the
same-work comp corrected for signature, edition, size and process, per artist.

## 1.1: priors from five sales, segment defaults, and the graph as the store (2026-09-13)

Same build, extended. Three tiers by earlier-sales count (`basis` in the JSON):

| basis | earlier sales | artists | what is stored |
|---|---:|---:|---|
| `shrunk` | ≥ 15 | 319 | own fit shrunk toward the neighbour prior (as 1.0) |
| `prior` | 5–14 | 426 | the neighbour prior outright — five sales place an artist in descriptor space (price level, signed share, technique mix, period, nationality) but cannot fit 33 coefficients |
| segment default | < 5 | — | no per-artist entry; the reader falls back to the sqrt(n)-weighted mean of the stored elasticities over the artist's nationality group × birth-year period (31 cells incl. `any` marginals and `any|any`) |

The 5–14 band on the same temporal test: median 0.774 · pooled 0.681 · **prior 0.691** · estimate
0.473 (426 artists, 671 test rows) — the neighbour prior is as good as the pooled model for
artists it has never fitted, and 0.08 log better than their own median. κ re-chosen on the
larger set: 30 and 60 tie at 0.653 and 30 is stored. Segment defaults read sensibly: hand-signed
×1.76 French vs ×1.39 British; edition >300 ×0.37 French, ×0.65 American modern, ×0.88 British
contemporary — the modern-master vs contemporary-edition inversion from the transfer test, now
as a fallback table. Nationality "française" (145 graph nodes) now counts as French.

**In the graph.** `knowledge_graph/write_price_priors.py` (the only writer; dry-run, pre-snapshot,
batched UNWIND, verification) writes one `PricingModelRun` per build (`<version>@<built_at>`,
with the column list, reference levels, year effects, continuous medians and the segment
defaults as JSON strings, row counts), `Artist.priceLevelLog / priceElasticities /
priceEarlierSales / priceElasticitiesRun / priceElasticitiesBasis` on every artist matched by
EXACT name (745/745 resolved; unmatched or ambiguous names are reported and skipped), and
`(:Artist)-[:PRICE_NEIGHBOUR {weight, run}]->(:Artist)` for the donors (7,450 edges). A new
run clears the old tags and edges. `check_price_priors_fresh.py` fails when the live run predates
the latest MergeEvent or SourceRecord price-data stamp, or when the sold-priced row count the
build saw (48,847) differs from the graph's now.

Read side: `src/appraisal/knowledge_graph/artist_price_profile.ts` — `queryArtistPriceProfile`
(artist tier, else segment fallback from the artist's nationality and birth year) and the pure
`adjustmentBetween(lot, comp, profile)`: the multiplier from a same-work comp's hammer to the
lot's, over signature, proof, edition band, area band, process and the two per-doubling terms.
House is deliberately excluded until the cross-house repeat-sale test. NOT wired into Stage 3 —
gated on the backtest (plan step 6).

```bash
knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/export_sales.py --out knowledge_graph/pricing_ml/data/all_sales.csv
knowledge_graph/venv-embeddings/bin/python knowledge_graph/pricing_ml/build_priors.py knowledge_graph/pricing_ml/data/all_sales.csv
python3 knowledge_graph/write_price_priors.py --dry-run && python3 knowledge_graph/write_price_priors.py
python3 knowledge_graph/check_price_priors_fresh.py
npm run test:price-profile
```

## Image subject (CLIP zero-shot): mostly an artist proxy, not an independent price driver (2026-09-14)

Question: does the pictured subject (portrait, nude, landscape, animal, still life, religious/
mythological, genre scene, abstract, surreal, comic/satirical — a 10-category taxonomy agreed
with the user) move the hammer, controlling for the other attributes above?

`../clip_subject_classifier.py` classifies every `DigitalImage.clipImageEmbedding` (already
stored by the various `*_embed_images.py` writers, no re-embedding needed) by cosine similarity
to CLIP TEXT embeddings of each category's prompts, writing `clipSubject` / `clipSubjectMargin`
/ `clipSubjectConfident` (margin = top-1 minus top-2 cosine, confident iff >= 0.02) /
`clipSubjectRun`. Run `CLIP-SUBJECT-1.0@2026-09-14T09:05:09Z`: 97,374 images classified, 35.1%
confident. Prompts were tuned once against a 155-image title-keyword pilot: raw top-1 agreement
65.2%, rising to 85.1% at margin >= 0.02 (48% coverage) and 100% at margin >= 0.05 (12%
coverage, small n). Animal and comic/satirical stayed weaker even after tuning — largely
monochrome 19th-c./old-master engravings genuinely ambiguous between categories (a skull study
vs. an animal; a satirical crowd scene vs. a genre scene) and out of CLIP's native photographic
training distribution.

`export_sales.py` now joins `clipSubject`/`clipSubjectMargin`/`clipSubjectConfident` onto each
sale via its Impression's DigitalImage. 13,855 of 48,847 priced sales (28%) get a confident
label. `train_price_model.py --effects` treats `subject` like any other categorical (reference
level `genre_scene`, non-confident rows coded `unclassified`).

**Raw market-wide effect looks large**: religious/portrait command the least discount vs.
genre_scene, landscape/abstract the most (x0.62–x0.92 spread) — but the drop-one ablation on
the ML model shows removing subject changes test MAE by 0.000: it adds no incremental
predictive power once the other attributes are in. The reason: subject is heavily confounded
with **which artist** made the work (comic_satirical is 36% James Gillray; genre_scene's
reference bucket of 341 is dominated by Cartier-Bresson/Doisneau/Winogrand — street
photographers, a different market entirely, not painters/printmakers) and artist identity is
already known to be the dominant price driver ([[project-hammer-backtest-findings]]-style: the
estimate/artist beats attributes 2x over).

**The clean test**: restrict to the 7 artists whose own confidently-labelled sales span >= 3
subjects at >= 15 sales each (Picasso, Warhol, Hockney, Moore, Matisse, Piper, Dalí — 1,276
rows) and add artist dummies alongside subject, technique, signature, edition and size. Most
subject effects collapse to ~1.0x (nude x0.99, religious x1.00, still_life x0.97, animal x1.02
vs. portrait) — indistinguishable from no effect once you know who made it. Two exceptions
survive, tentatively (small n): abstract compositions x0.54 and comic/satirical x0.61, even
within the same artist's output. But per-artist breakdowns of those same subjects **don't agree
in direction** — Picasso's still lifes sell at x0.80 of his portraits, Hockney's at x1.88 — the
same "multipliers are artist-specific, don't pool" pattern already found for signature/edition/
technique now holds for subject too.

**Conclusion: don't treat subject as a universal pricing lever.** If it matters, it's an
artist-specific effect, not a market constant — consistent with how technique/signature/edition
elasticities are already handled per-artist in the priors system above.

**Update 2026-09-14 (later, PRICING-PRIORS-1.2): added anyway, but only the 3 categories that
survived artist control.** `build_priors.py` now includes three independent 0/1 elasticity
columns — `subject_is_abstract`, `subject_is_comic_satirical`, `subject_is_surreal` (1 iff
`clipSubjectConfident` and that category, 0 for every other confident subject AND for
unclassified) — fit with the exact same per-artist-Ridge-then-neighbour-shrinkage machinery as
every other column, which is architecturally the clean within-artist test already, since each
artist's own fit never mixes in another artist's rows. The other 7 subject categories were
deliberately left out: their effect was artist identity in disguise, not a printmaking subject
effect, and adding them would just give a false sense of precision. 36 elasticity columns now
(was 33), 81/745 artists have an own-fitted abstract coefficient (n>=3 confident sales), 33 for
comic_satirical, 20 for surreal — most artists get the neighbour-shrunk value. Market-wide
segment default (`any|any`): abstract x0.91, comic_satirical x0.91, surreal x1.23 — much more
moderate than the naive unconditional market read (x0.64-0.67), consistent with the
artist-controlled robustness check above. Run `PRICING-PRIORS-1.2@2026-09-14T09:30:19Z`,
`check_price_priors_fresh.py` and `npm run test:price-profile` both pass. `artist_price_profile.
ts`'s `adjustmentBetween` does not read these columns yet (its dims list is still signature/
proof/edition_band/area_band/process) — a natural follow-up once Stage 3 wiring is revisited.

## Next

Rarity/state words (rare, unique, one of N, state, proof aside from the edition) as features;
condition from Stage 1a's read rather than the catalogue; a second artist with a different
market shape (Hockney, Hirst) to see whether the effects transfer.
