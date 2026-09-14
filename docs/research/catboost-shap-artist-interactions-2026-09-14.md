# CatBoost + SHAP: which price factors and interactions are real, and how strong — a handoff for the next log-linear pass

**Date:** 2026-09-14
**Status:** Research note, exploratory only. Nothing here has been wired into `build_priors.py`,
`write_price_priors.py`, or the graph — this is a diagnostic pass run in a separate session,
on top of the existing `knowledge_graph/pricing_ml/data/all_sales_with_subject.csv` export.
Written for a session that wants to design a **better log-linear (Ridge/effects-table style)
model** — which terms to add, which to drop, and roughly what magnitude to expect.
Cross-reference: `knowledge_graph/pricing_ml/README.md` (the existing Ridge effects table and
the per-artist priors system, `PRICING-PRIORS-1.2`).

## What was run

A `CatBoostRegressor` on `log(hammerGBP)`, fit on all 38,762 modelled sales (2010–2026, books/
sets dropped) as a description of the corpus — same "not a forecast" convention as
`train_price_model.py --effects`. 21 features, 13 of them genuinely categorical and passed to
CatBoost natively (no one-hot): **artist** (3,844 levels — this is the one thing a one-hot /
Ridge design can't do directly, and the reason CatBoost was picked over
`HistGradientBoostingRegressor`), tech_family, process, signature, proof, edition_band,
area_band, condition, catalogue, publisher, paper, house, subject. Continuous: edition_log,
area_log, max_side, work_year, sale_year, n_defects, has_citation, book_or_set.

- **5-fold CV, with artist as a feature:** MAE(log) 0.602, within-2x 67.2%.
- **Same features, artist excluded** (one-hot GradientBoostingRegressor pass): MAE(log) 0.772,
  within-2x 54.5%. Knowing the artist is worth more than every other attribute combined.
- SHAP values via `shap.TreeExplainer`; interaction values (`shap_interaction_values`, pairwise
  only — see caveat below) computed on samples of the relevant rows, usually restricted to
  artists with real within-artist diversity on the dimension being tested (otherwise the
  interaction just re-derives "which artist," not the attribute's own effect).

**Caveat that matters for how you use this**: these are tree-model SHAP multipliers, not
Ridge log-linear coefficients. Different model class, different (often no explicit) reference
level, nonlinear by construction. Treat every number below as "this term matters, roughly this
much, in roughly this direction" — not as a coefficient to paste into a linear model. Re-fit and
re-validate anything you add.

## Main-effect ranking (mean |SHAP|, log-hammer units)

| Rank | Feature | Mean \|SHAP\| |
|---|---|---:|
| 1 | **artist** | 0.406 |
| 2 | house | 0.176 |
| 3 | sale_year | 0.151 |
| 4 | catalogue | 0.122 |
| 5 | signature | 0.096 |
| 6 | edition_band | 0.095 |
| 7 | process | 0.067 |
| 8 | work_year | 0.064 |
| 9 | max_side | 0.061 |
| 10 | tech_family | 0.054 |
| 11 | paper | 0.053 |
| 12 | area_log | 0.046 |
| 13 | condition | 0.042 |
| 14 | edition_log | 0.031 |
| 15 | area_band | 0.025 |
| 16 | proof | 0.025 |
| 17 | publisher | 0.016 |
| 18 | **subject** | 0.012 |
| 19 | n_defects | 0.007 |
| 20 | has_citation | 0.004 |

Artist is 35× the size of subject. Subject is real but small even in the best case (see below)
— don't spend more modelling effort on it than the priors system already does (3 columns,
not 10).

## Top pairwise interactions (all 21 features, 1,500-row sample)

| Interaction | Mean \|SHAP interaction\| |
|---|---:|
| **artist × signature** | 0.074 |
| area_log × max_side *(artifact — see below)* | 0.065 |
| **artist × house** | 0.060 |
| artist × catalogue | 0.060 |
| **house × sale_year** | 0.050 |
| condition × sale_year *(artifact — see below)* | 0.042 |
| artist × sale_year | 0.038 |
| work_year × sale_year | 0.034 |
| **artist × tech_family** | 0.031 |
| **artist × edition_band** | 0.030 |
| **artist × process** | 0.027 |
| artist × work_year | 0.022 |
| condition × house | 0.021 |
| artist × area_log | 0.019 |
| artist × condition | 0.016 |
| artist × paper | 0.015 |

Artist interacts with almost everything. That is the headline structural fact: **there is no
attribute in this dataset whose effect is safely pooled across artists.** The priors system
already assumes this for signature/edition/process; this independently confirms it holds for
house and catalogue too, which the priors system currently does NOT give per-artist treatment to
(house is deliberately excluded from `adjustmentBetween` pending the cross-house repeat-sale
test; catalogue isn't in the elasticity columns at all).

## Two known artifacts — do not model these as real interactions

- **`area_log × max_side`** — the two largest interaction terms include this pair, but it's not
  economics: they're two measurements of the *same physical size*. If your design already carries
  both, you're not finding an interaction, you're finding collinearity. Keep one or the other, or
  an explicit ratio term, not both as independent effects.
- **`condition × sale_year`** — real, but not economic. Bonhams' medium-text stopped carrying
  condition sentences after ~2020 (already documented in `pricing_ml/README.md`), so
  "condition unknown" is really "sold after ~2020." Do not read this as "condition matters less
  in a hot market" — it's a cataloguing-practice shift, not a price signal.

## Per-attribute deep dives (isolated to artists with genuine within-artist diversity on that dimension, so the "interaction" isn't just re-deriving which artist it is)

### Artist × signature — the strongest real interaction found, universal direction, huge range

61 bigger-selling artists with ≥2 signature classes at ≥15 sales each. **Every single one** shows
hand-signed above unsigned — no exceptions — but the *size* of the gap runs from **1.08× to
1.76×**:

| Artist | Unsigned | Hand-signed | Gap |
|---|---:|---:|---:|
| Yayoi Kusama | 0.75× | 1.32× | 1.76× |
| Joan Miró | 0.70× | 1.19× | 1.71× |
| Marc Chagall | 0.70× | 1.17× | 1.67× |
| Pablo Picasso | 0.74× | 1.21× | 1.64× |
| Andy Warhol | 0.74× | 1.21× | 1.65× |
| David Hockney | 0.70× | 1.07× | 1.51× |
| Damien Hirst | 0.74× | 1.11× | 1.49× |
| Banksy | 0.86× | 1.19× | 1.39× |

Note Banksy's unsigned baseline (0.86×) sits well above everyone else's (0.69–0.82×) — his
unsigned prints hold value far better than a modern master's would, consistent with his market
authenticating on Pest Control certification rather than a pencil signature. This is already the
architecture the priors system uses (per-artist signature elasticity, shrunk toward neighbours)
— this finding validates that design, it doesn't ask for a new term.

### Artist × house — universal direction, but the gap scales with the artist's own price level

72 artists with ≥15 sales at both Bonhams and Roseberys. **Every one** favours Bonhams — no
crossovers, no "Roseberys wins for artist X" cases. But the gap ranges 1.36×–1.90× and
**correlates 0.74 with the artist's own median log-hammer price**. Blue-chip/international names
(Banksy 1.90×, Kusama 1.77×, Warhol 1.59×, Picasso 1.61×) get the biggest relative Bonhams lift;
more regionally/specialist-collected British names (Elizabeth Blackadder 1.36×, Julian Trevelyan
1.37×, Takashi Murakami 1.39×) show Bonhams still ahead but by much less.

**This is a genuine gap in the current priors system** — house is excluded from
`adjustmentBetween` entirely. If house is reintroduced, this result says it should scale with
the artist's price tier, not be a flat multiplier: consider an interaction term
`house × log(artist_price_level)` rather than a plain `house` dummy, or (more consistent with the
existing hierarchical architecture) a fourth per-artist-shrunk elasticity column alongside
signature/edition/process.

**Also found, not yet dug into**: `house × sale_year` (0.050) — the Bonhams/Roseberys gap has
**narrowed** since 2020 (not widened), across the whole corpus, not just per-artist. The current
Ridge effects table has one shared set of year-effect dummies across all houses; this says the
drift differs by house and a `house × year` term (or house-specific year effects) would capture
real signal the pooled year dummies are currently averaging away.

### Artist × technique (process) — real, and the biggest within-artist spread after signature

42 bigger-selling, technique-diverse artists (≥3 processes, ≥15 sales each). Spread runs
**1.02×–1.45×** — much bigger than subject's (below), confirming this deserves the per-artist
treatment it already gets in the priors system.

| Artist | Cheapest technique | Priciest technique | Spread |
|---|---|---|---:|
| Damien Hirst | lithograph 0.81× | other 1.17× | 1.45× |
| Banksy | lithograph 0.87× | screenprint 1.17× | 1.35× |
| Pablo Picasso | lithograph 0.91× | engraving 1.20× | 1.31× |
| Andy Warhol | lithograph 0.90× | screenprint 1.11× | 1.23× |
| Henri Matisse | linocut 0.87× | aquatint 1.10× | 1.27× |

**Lithograph is the cheapest technique for 17 of the 18 top-spread artists checked** — remarkably
consistent across eras and markets. Picasso's own priciest technique is engraving (echoes the
old-master engraving premium, e.g. Dürer, surfacing in a completely different market). Banksy
and Warhol's own priciest technique is screenprint — the medium they're actually known for.
Already captured by the priors system's `process_*` columns; this validates the existing design,
no new term needed here either.

### Artist × subject — real, but small; only 3 of 10 categories survive contact with reality

29 bigger-selling artists with genuine subject diversity (≥2 categories, ≥10 sales each). Spread
tops out at **1.10×** (Warhol, Toulouse-Lautrec, Matisse, Lichtenstein) — an order of magnitude
smaller than technique's or signature's range. The raw, uncontrolled market-wide subject effect
(0.62×–0.92× spread by nationality/period segment) turned out to be almost entirely artist
identity riding along as a proxy (e.g. the "genre_scene" reference bucket was 36% specific street
photographers, a different market entirely). Already handled: `build_priors.py` (v1.2) added
`subject_is_abstract` / `subject_is_comic_satirical` / `subject_is_surreal` as the only three
subject columns, since those were the only ones that didn't collapse to ~1.0× once artist was
controlled for. **Do not add the other 7 subject categories** — they'd just re-encode "which
artist," with false precision.

### Artist × signature × technique (practical 3-way) — a real, novel pattern not yet in any model

SHAP interaction values are pairwise only (see caveat below), so this was read as: does
signature's *combined* interaction with both artist and technique show a consistent pattern when
stratified by (artist, technique) cell? Six artists had real diversity on both dimensions at once
(Picasso, Warhol, Hockney, Piper, Lichtenstein, Haring). Result, well-supported (n≥15 hand-signed
AND n≥15 unsigned per cell):

| Artist | Higher-signature technique | Screenprint |
|---|---:|---:|
| Andy Warhol | lithograph 1.71× | screenprint 1.59× |
| Roy Lichtenstein | lithograph 1.68× | screenprint 1.52× |
| Keith Haring | lithograph 1.64× | screenprint 1.46× |
| John Piper | lithograph 1.27× | screenprint 1.24× |

**4 of 4 testable cases**: the signature premium is smaller for screenprint than for the artist's
other main technique. Reading: screenprint editions for these pop/street names were signed as
near-universal standard practice, so a hand signature adds less marginal distinguishing
information there than on a lithograph, where a genuine signature does more work separating a
desirable impression from commercial output. **This is a genuine candidate new term** — not yet
in the priors system, not yet in the Ridge effects table. Worth testing as a `signature × process`
cross-term, at minimum for the screenprint-heavy contemporary/street-art segment, before
committing to a full per-artist-per-process interaction (which would need much denser data than
most artists have).

## Recommendations for the log-linear rebuild, ranked by evidence strength

1. **Keep per-artist elasticities for signature, edition_band, process** — independently
   validated by two very different model classes now (Ridge+shrinkage, CatBoost+SHAP). No change
   needed.
2. **Add a `signature × process` term** (or at minimum a `signature × is_screenprint` flag),
   informed by the artist×signature×technique finding above — real, consistent, not currently
   modelled anywhere.
3. **Reconsider house**: currently excluded from the live adjustment logic entirely. The
   evidence says (a) it should scale with artist price tier rather than be a flat multiplier, and
   (b) its drift should be house-specific (`house × year`) rather than sharing the pooled year
   effects. Both are real, both are currently invisible to the model.
4. **Leave subject at 3 columns** (abstract, comic_satirical, surreal) — already done in
   `PRICING-PRIORS-1.2`. Resist the temptation to add the rest; the evidence says not to.
5. **Do not add** `condition × sale_year` or treat `area_log`/`max_side` as independently
   interacting — both are artifacts (cataloguing-practice shift; physical-quantity collinearity),
   not economics.
6. **Catalogue** (`artist × catalogue`, 0.060, the third-strongest interaction in the model) was
   flagged but not dug into this session — worth a follow-up pass before the next model iteration
   closes out, using the same isolated-diversity-artist method as above.

## Reproducing this

The scripts that produced these numbers live in a separate session's scratchpad, not in this
repo (this note was written specifically so the numbers survive without the scripts). To
reproduce: build a `CatBoostRegressor` on `knowledge_graph/pricing_ml/data/all_sales_with_subject.csv`
using `train_price_model.build_features()` for feature engineering, pass the 13 categorical
columns listed above via `cat_features=` (do NOT one-hot artist — that's the point of using
CatBoost here), and use `shap.TreeExplainer(model).shap_interaction_values(...)` on a subsample
for any interaction pair. Restrict to artists with real within-artist diversity on whichever
dimension you're testing before reading an "interaction" — otherwise you're re-deriving "which
artist," not the attribute's own effect, which is the mistake the raw market-wide subject
numbers made in the first place.
