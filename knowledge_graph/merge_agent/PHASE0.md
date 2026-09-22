# Merge-review agent: Phase 0 progress

Design: `docs/plans/2026-09-22-artist-merge-active-learning-agent.md`.

## 1. Block recall: done 2026-09-22 (`phase0_blocks.py`)

Ground truth is 283 Artist merges, taken from MergeEvents with survivorRenamed excluded.

| Block | Recall |
|---|---|
| surname, strict (last token) | 79.5% |
| surname, either last token in the other | 91.5% |
| five name rules (find_artist_merge_candidates) | 74.6% |
| Splink pool, 2026-09-12 snapshot | 60.4% |
| shared-image scan | 1.1% |
| joined-words (spaces removed) *new* | 17.3% |
| surname one edit apart, same initial *new* | 4.9% |
| **union** | **99.3% (281/283)** |

The two misses:
- `Sam Taylor-Wood` → `Sam Taylor-Johnson` is a name change that no string rule can catch. It
  needs a ULAN/Wikidata alias block.
- `Yoshitomo Nara and Hiroshi Sugito` → `Yoshitomo Nara & Hiroshi Sugimoto`. **The survivor's name
  is wrong.** Sugito is Nara's collaborator; Hiroshi Sugimoto is a different artist, a
  photographer. This is logged here and not fixed.

**Caveat:** the known merges were mostly *found* by name rules, so name-block recall is an upper
bound. Duplicates with dissimilar names (pseudonyms, name changes) are under-represented. The
shared-work block covers them. It has a live pool of 902 pairs, and its recall cannot be measured
after a merge.

**Cannot be measured after a merge:** shared work and alias overlap. SourceRecords don't keep the
raw artist string, so once two nodes are merged the graph can't say which works came from the
absorbed one. **Training features for merged pairs must come from pre-merge snapshots** such as
`artist_splink_triage.csv` (2026-09-12, 1,229 pairs with features), not from the live graph.

**Live pool:** 9,404 pairs, against 67.7M possible. The largest surname blocks are smith (47),
jones (28) and martin (24).

## 2. Gold set: sampled; waiting on labels (`phase0_gold_sample.py`)

- 150 pairs, seed 20260922, reproducible. `out/gold_sample.json` holds the strata; the labelling
  page does not show them.
- Strata:

  | Stratum | Pairs |
  |---|---|
  | strong/clean | 20 |
  | strong/trap | 1 (only 1 exists in the pool) |
  | subset/clean | 22 |
  | subset/trap | 22 |
  | fuzzy/clean | 28 |
  | fuzzy/trap | 22 |
  | weak/clean | 18 |
  | weak/trap | 17 |

- Rejected edges (seed negatives) are excluded, so no gold pair is also a training pair.
- Labelling page: https://claude.ai/artifact/P8SHHSbUVdGCYyig45QUwu. Labels are stored in its db
  at `labels/<gNNN>` as {label: same|different|unsure, note, at}.

## 3. LLM calibration: blocked on the labels

Haiku 4.5 is run over the 150 pairs using the same evidence the page shows plus the trap list.
Agreement is measured per stratum. The gate is ≥ 95% on every stratum it will label.
