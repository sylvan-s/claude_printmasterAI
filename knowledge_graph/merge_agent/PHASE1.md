# Merge-review agent: Phase 1 progress (seed model)

Run with `knowledge_graph/venv-embeddings/bin/python` (sklearn 1.6). No graph writes. LLM cost so
far is $0.18 (two active-learning rounds).

## Data (`phase1_data.py`)
- **Records for merged pairs come from pre-merge snapshots,** in this order: the 2026-09-15
  `artist_records.parquet`, the four band-B snapshots, the pairs snapshots, merge-event fields,
  then the live graph.
- **Features are intrinsic only:** name ladder, Jaro-Winkler, dates, ULAN/Wikidata, nationality,
  trap flags, surname frequency and work counts. Shared works and DINOv2 are left out because
  they cannot be rebuilt for merged pairs, and a feature missing for one class is a leak.
- **Seed:** 283 merge-record positives, 60 rejected edges, 849 hard negatives (same surname plus
  a ULAN or ≥10-year date contradiction) and 566 easy negatives (weight 0.5).
  - **Leak found and fixed.** Hard negatives are selected for having dates (95% carry both
    birth years, against 69% of positives and 12% of gold `same` pairs). The easy negatives are
    chosen without looking at dates, which brings birth-year coverage to 69% vs 73%.
  - **Source probe:** the same negatives featurised from snapshot vs live records are only
    weakly distinguishable (AUC 0.558). The difference is almost all work counts, since live
    nodes have grown.

## Seed model (`phase1_model.py`)
Grouped by artist, 5-fold, with the operating point picked on out-of-fold precision ≥ 0.97.

| model | OOF AUC | gold AUC | gold `same` calls correct | gate |
|---|---|---|---|---|
| logistic | 0.998 | 0.960 | 37/46 (80%) | fail |
| boosted trees | 0.998 | 0.941 | 33/36 (92%) | fail |

**The seed is easier than the pool** (0.998 vs 0.94). Every false `same` has one shape: same
forename, a surname 1–2 letters off, no dates (Brian Wall ~ Brian Yale, Albert Merz ~ Albert
Mura). The seed has positives of that shape and no negatives of it.

## Active learning (`phase1_active.py`), with Haiku 4.5 and Policy A
Each round labels 60 pool pairs: half by uncertainty, half a **random audit of the high band**
outside `strong` names. Labels carry weight 0.7.

| | high-band audit precision | gold `same` calls correct (95% low) | gold recall | gold AUC |
|---|---|---|---|---|
| seed only | 14/24 = 58% | 33–34/36–37, 3 false | 83% | 0.938 |
| + round 1 (51 labels) | — | 33/33 (89.6%) | 80% | 0.972 |
| + round 2 (49 labels) | 21/24 = 88% (round-2 audit, 95% low 69%) | **34/34 (89.8%)** | 83% | 0.972 |

- Round 1 removed all three gold false `same`s.
- The remaining audit misses are initials (T H Baynes ~ T M Baynes), a collaboration subset
  (Christo and Jeanne-Claude ~ Claude) and a compound forename (Henri Lucien-Robert ~
  Henri-Louis Robert).

## Why the gate is not yet passed
The gate needs gold precision ≥ 95% **and** a 95% Wilson lower bound ≥ 90%. With 41 gold `same`
pairs, even zero errors needs ≥ 35 correct `same` calls, i.e. recall ≥ 85%. The model sits at
34. So the gate is limited by gold size as much as by the model. The audit is the tougher
measure, and it says the non-strong high band is about 88% right.

## Rounds 3–5 (80 pairs each: 40 audit, 40 uncertain)

**Stopping rule, set in advance:** stop when one round's audit is ≥ 95% and the last two rounds
pooled have a 95% lower bound ≥ 90%, with a cap of four more rounds (about $0.50).

| round | features | threshold | high-band audit | gold `same` calls correct (low) | gold recall | gold AUC |
|---|---|---|---|---|---|---|
| 3 | DATA-1.0 | 0.65 | 22/30 = 73% | 30/30 (88.6%) | 73% | 0.977 |
| 4 | **DATA-1.1** | 0.82 | **33/33 = 100% (low 90%)** | 34/34 (89.8%) | 83% | 0.986 |
| 5 | DATA-1.1 | 0.72 | 32/36 = 89% | 32/32 (89.3%) | 78% | 0.982 |

**DATA-1.1 came out of the round-3 audit.** The model's real misses were trap words it didn't
know:
- Italian, French and German attribution terms ("Seguace di", "École de", "Umkreis");
- "/" as a joint credit ("Edward Weston/Cole Weston");
- generation markers ("Carl Wilhelm I Kolbe" vs "Carl Wilhelm Kolbe").

The vocabulary was extended and a `generation_mismatch` feature added. The next round's audit
was 33/33.

**Stopped after round 5.** Rounds 4+5 pooled give 65/69 = 94.2% (low 86.0%). No sixth round,
however clean, could lift the pooled lower bound to 90%. And the audit now has a **labeller noise
floor**. Of round 5's four misses:
- one is Haiku's own error (G. F. Watts called "after");
- two are possible catalogue misspellings Haiku cannot settle (Delvaux ~ Devaux, Pater ~ Paret);
- only one is a real model miss (Marcantonio Raimondi "after Raphael" vs "And Circle", a
  composite relation).

Policy A also parks true typo matches as `unsure` (Goltzius / "Golitzus", Kolbe), which keeps
them out of both training and the audit.

Total Phase 1 LLM spend: about $0.51. Labels gathered: 213 carried into round 5, plus round 5's own.

## Where Phase 1 stands
- **Gold:** no false `same` in any round since round 1 (34/34 at best). The gate fails only on
  the lower bound, because 41 gold positives cap it just under 90%.
- **Audit:** 89–100% per round once DATA-1.1 is in. Its remaining misses are mostly labeller noise.
- **Certifying either measure needs human labels,** not more LLM rounds: grow the gold set
  (subset/fuzzy), or have a person adjudicate the audit disagreements. The model is now limited
  by the measurement, not the other way round.

## Human adjudication of the audit disagreements (2026-09-22)
52 pairs (`phase1_adjudication_set.py`) labelled on the "Merge Audit Adjudication" page, with the
model score and LLM answer hidden. Result: 21 same, 9 different, 2 collaboration, 1 after, 19 unsure.

**Audits re-scored with human truth** (`phase1_adjudicated.py`):

| round | LLM-scored | human-scored | 95% low |
|---|---|---|---|
| 1 | 58% | 18/25 = 72% | 52% |
| 2 | 88% | 25/27 = 93% | 77% |
| 3 | 73% | 31/33 = 94% | 80% |
| 4 | 100% | 38/39 = 97% | 87% |
| 5 | 89% | **37/37 = 100%** | **90.6%** |
| 4+5 pooled | — | **75/76 = 98.7%** | **92.9%** |

**The audit stopping rule is met on human truth.** The LLM had understated the model: in rounds
3 and 5 most of the "misses" were the labeller, not the model.

**The labeller on the disputed pairs:**
- **Its `different` is unreliable.** Of 21 LLM `different`s, the person agreed with 8 and said
  same for 3 (Wiericx ~ Wierix, T H Baynes ~ T M Baynes, and the Cantagallina follower pair, see
  below). 9 were unsure and 1 was a collaboration.
- **Policy A's `unsure` hid 15 true `same`s.** That is the price of the insurance. It costs recall
  only, never precision.

**Retrained with the human labels** (weight 1.0, overriding the LLM's), features DATA-1.2:

| training labels | gold `same` calls correct | 95% low | gold recall | gate |
|---|---|---|---|---|
| LLM only | 31/31 | 89.0% | 76% | fail |
| **+ human adjudication** | **36/36** | **90.4%** | **88%** | **PASS** |

**Phase 1 gate: PASSED.** Gold precision 100% with a lower bound ≥ 90%, and the audit pooled over
the current model with a lower bound ≥ 90%. Both pass narrowly, because both samples are small.

**To check:** adj-labelled `same` for "Remigio Cantagallina ~ Seguace di Remigio Cantagallina".
"Seguace di" means "follower of", which the composite rules treat as a relation (`after`), not
the same artist. It may be a mis-click.
