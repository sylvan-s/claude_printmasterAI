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

### Labels received 2026-09-22

150/150 labelled: 44 same, 68 different, 38 unsure (`out/gold_labels.json`). 13 of the 26
collaboration-name pairs were *unsure*. The pair is part-of, not same or different. So the page
gained two relation labels, **Collaboration** and **After**, and the 41 pairs with collaboration
or after names are queued for re-review. Relation-labelled pairs are a separate class, excluded
from same/different precision and from LLM calibration. The graph fix is scoped in
`docs/plans/2026-09-22-collaborations-and-after-attributions.md`.

### Relation re-review 2026-09-22
Final labels: 38 same, 66 different, 14 collaboration, 7 after, 25 unsure.

## 3. LLM calibration: run 2026-09-22 (`phase0_llm_calibration.py`, Haiku 4.5, $0.18)

**Result: the gate fails as specified. The ways it fails are informative.**

- **Identity pairs** (the person said same or different; 104 pairs): 97.0% agreement where Haiku
  committed (97/100, 95% low 91.5%). It passes the point estimate in 5 of 7 strata. It fails
  fuzzy/clean (90.5%, n=21) and subset/clean (91.7%, n=12).
- **No stratum can be *certified* at 95% with n≈15-20.** The Wilson lower bounds run 51-82% even
  at 100% agreement. Certifying a stratum at a 95% lower bound needs about 75 agreeing pairs.
- **Same-precision is 73%** (33 of 45 Haiku `same`s). The 12 misses fall into three groups:
  - **4 are a label-definition clash**, not model error: two spellings of *the same* composite
    credit (Degas / Thornley ×2, Gould & Richter, Sayer & Bennett). Haiku says `same`, which is
    right at node level; the person used the relation label because the entity is a composite.
    **Rule needed:** composite vs the same composite = `same`, and the node is then decomposed.
  - **7 are world-knowledge calls on pairs the person left unsure** (Wyndham Lewis, Charles
    Wilbert White, Driskell, Shagin, Kuhnert, Alex S. MacLean, the Manzú lot artefact). They are
    probably right but unverified from the page evidence.
  - **1 is a confabulation:** "Ghisi is a shortened form of Scultori". They are two different
    Mantuan families. So a world-knowledge claim must be corroborated, never trusted alone.
- **Relations:** Haiku found 12 of 21 (11 exactly). 5 went to `same`, the four composite pairs
  above plus Ghisi, and 4 went to `different`.
- **3 pairs where the person said same and Haiku said different** are worth a second look:
  Master Ag / Master Mr, Jack Baker / John Barker, and Samuel Alken / Samuel Henry Alken (the
  Alken family is a father/son trap).


Haiku 4.5 is run over the 150 pairs using the same evidence the page shows plus the trap list.
Agreement is measured per stratum. The gate is ≥ 95% on every stratum it will label.

### Step 1 applied 2026-09-22: the composite rule

**Rules** (on the labelling page and in the Haiku prompt, LLM-1.1):
1. Two spellings of the **same** composite credit → `same`. The node is then decomposed.
2. A composite vs one of its own parties → `collaboration` or `after`.
3. Two composites that **differ** in a party (two engravers after one designer) → `different`.

**Relabelled `same` under rule 1** (previous label kept on each document): g007, g067 (Degas /
Thornley), g073 (Gould & Richter), g119 (Sayer & Bennett).

**Re-scored, from the same Haiku run:**
- Identity agreement goes from 97.0% (97/100) to 97.1% (101/104).
- Same-precision goes from 73.3% to 82.2% overall. **Excluding pairs the person left unsure it
  is 97.4% (37/38)**, and the one false `same` is Ghisi / Scultori.
- If the two recommended corrections below are accepted: 99.0% (103/104, 95% low 94.8%). Only
  subset/clean stays under 95% (11/12; the miss is Haiku calling the Samuel Alkens different).

**Waiting on the person, whose labels these are:**
- Recommended corrections: g022 Master AG / Master MR → different (distinct monogrammists);
  g056 Jack Baker / John Barker → different (nothing links them). Keep g038 Samuel Alken /
  Samuel Henry Alken as `same` (ULAN 500014677 is 1810–1894, the node's exact dates).
- Rule 3 candidates, currently labelled `after`: g029 Antonio da Trento vs Antonio Maria
  Zanetti (both after Parmigianino) and g112 Ghisi vs Scultori (both after Giulio Romano) are
  different engravers, so `different`. For g113 Thomas Walton vs Thomas Watson (both after
  Reynolds): Watson was a well-known mezzotinter after Reynolds, and "Walton" may be a
  misspelling of him. That one is your call.
- g098 Augustus Pugin after Thomas Rowlandson vs Thomas Rowlandson is labelled
  `collaboration`; by the definitions it is `after`.

### Reviewer decisions 2026-09-22; final gold labels

- g022 Master AG / Master MR → `unsure`. The titles and subjects are very similar, but the
  monograms differ.
- g056 Jack Baker / John Barker → `different`.
- g038 Samuel Alken / Samuel Henry Alken stays `same`.
- g062, the Manzú lot-grouping pair → `same`. It is a parsing error; both nodes are Giacomo Manzú
  after junk text. The two junk-named nodes should eventually fold into the real Giacomo Manzú
  node through the malformed-names repair path. Logged, not done.
- Not changed by the reviewer: rule-3 candidates g029, g112 and g113 stay `after`; g098 stays
  `collaboration`.

**Final:** 41 same, 67 different, 12 collaboration, 5 after, 25 unsure.

**Haiku, re-scored on the final labels (LLM-1.0 run):**
- Identity agreement: 103/104 = 99.0% (95% low 94.8%). The only stratum below 95% is
  subset/clean (11/12; the miss is the Alkens).
- Same-precision on pairs the person didn't leave unsure: 38/39 = 97.4% (low 86.8%). The single
  false `same` is g112 Ghisi / Scultori, a confabulation.
- Haiku said `same` on 6 pairs the person left unsure. All six rest on name form plus world
  knowledge, and none can be checked against the page evidence. That is step 2 (verified
  world-knowledge claims).

### Reviewer changes, then re-score (2026-09-22)
- Changes: g029 and g112 → `different` (rule 3), g113 → `unsure` (Walton / Watson may be a
  misspelling). **Final:** 41 same, 69 different, 12 collaboration, 2 after, 26 unsure.
- LLM-1.0 run re-scored: identity 104/106 = 98.1%.
- **Correction on g112.** ULAN 500008510 (Giovanni Battista Scultori) lists "Ghisi, Giovanni
  Battista (Mantovano)" among his name forms. So Haiku's Ghisi = Scultori call was probably
  *right*, not the confabulation it was called earlier. The reviewer set `different` on that
  mistaken advice; the recommendation is now `unsure`, or `same`.

## Step 2: world-knowledge `same` verified against ULAN (2026-09-22)

**`ulan_verify.py`** checks a pair against the 1.1M ULAN name forms using exact matches only:
token bag after folding, plus the repo's positional initials rule. The engraver side of "after"
credits and lot-grouping junk are stripped first, and life dates come from the ULAN bio.
- Verdicts: verified / conflict / ambiguous / unverified.
- On the disputed pairs: Kuhnert, Driskell, Charles White, Wyndham Lewis, Samuel Henry Alken and
  Manzú are verified. MacLean, Shagin and Ghisi / Scultori are unverified: the 3-word
  "Giovanni B. Ghisi" does not match the 4-word ULAN form, and the rule stays strict.

**LLM-1.2 prompt.** Haiku must state `basis` (record_evidence / world_knowledge). Re-run over all
150 pairs, $0.22.

| Policy for a Haiku `same` | kept & correct on firmly-labelled pairs | true merges sent to a person |
|---|---|---|
| raw | 38/39 (97.4%) | 0 |
| **A: world_knowledge must be ULAN-verified** | **34/34 (100%, 95% low 89.8%)** | 4 |
| B: every `same` ULAN-verified | 18/18 | 20 |
| C: names equivalent, else ULAN-verified | 25/25 | 13 |

**Recommendation: Policy A.** It removes the only false `same` (g112) at the cost of 4 true
merges going to a person (Comte, Giorgio Ghisi, Burne-Jones, Armand Vallée ~ Drian).

**The self-reported `basis` is noisy in both directions:**
- It says world_knowledge for trivial accent/case pairs (Géricault).
- It says record_evidence for name-form inferences (Driskell; Alex MacLean ~ Alex S. MacLean,
  which is unverified).

Policy C closes that gap at a cost of 13 merges to a person. Revisit it when Phase 1 has more
data. Identity agreement under A is 98/99 (99.0%); the only miss is subset/clean (the Alkens).

**Still not certifiable:** 34 pairs gives a 95% lower bound of 89.8%. Showing a lower bound of
≥95% needs roughly 73 consecutive correct `same`s.

### ULAN-sourced gold labels (2026-09-22)
On the reviewer's instruction, four pairs previously `unsure` were relabelled `same` with
`labelSource: "ulan"`: g012 Kuhnert (500030818), g020 Driskell (500077890), g118 Charles White
(500115749) and g137 Wyndham Lewis (500025826). **Final:** 45 same, 69 different, 12
collaboration, 2 after, 22 unsure.

- Policy A on the final labels: 38/38 correct `same` on firmly labelled pairs (95% low 90.8%),
  with 4 true merges sent to a person.
- **Report the independent figure.** These four labels come from the same ULAN check the
  verifier uses. So quote Policy A **excluding** `labelSource: "ulan"` pairs: 34/34 (low 89.8%).
  Any future ULAN-sourced label gets the same treatment.

- g112 Ghisi / Scultori → `same` (`labelSource: "ulan"`, 500008510). **Final:** 46 same, 68
  different, 12 collaboration, 2 after, 22 unsure.
  - Policy A: raw 43/43 on all labels. With the verifier, 38/38, and **5** true merges go to a
    person. g112 is now one of them: the verifier does not match the 3-word "Giovanni B. Ghisi"
    to the 4-word ULAN form.
  - Excluding ULAN-sourced labels: 34/34 (low 89.8%), 4 to a person.

## Phase 0 closed 2026-09-22

**Decision:** Policy A adopted (`ulan_verify.apply_policy`, POLICY-A-1.0). Haiku 4.5 with prompt
LLM-1.2 is the labeller. A `same` based on world_knowledge must be ULAN-verified, or it becomes
`unsure` and goes to a person.

**What Phase 0 established:**
- **Candidate pool:** the union of name blocks plus shared work, 9,404 pairs, with 99.3% recall
  on 283 known merges. Name changes such as Taylor-Wood → Taylor-Johnson need a
  ULAN/Wikidata alias block.
- **Gold set:** 150 pairs. Final labels: 46 same, 68 different, 12 collaboration, 2 after, 22
  unsure; 5 are ULAN-sourced, and figures are quoted without them.
- **Labeller:** 98% agreement on identity pairs. Under Policy A, no false `same` on firm pairs
  (34/34, 95% low 89.8%). About 4 true merges per 150 go to a person.
- **Labelling rules:** the composite-credit rules 1-3, and the relation labels collaboration and
  after, which route to decomposition, never to a merge.

**Carried into Phase 1:**
1. Training features for merged pairs must come from pre-merge snapshots such as
   `artist_splink_triage.csv`; the live graph has lost them.
2. The per-stratum 95% gate cannot be certified at n≈20. Phase 1 reports lower bounds and
   grows the gold set where the agent leans on the LLM (subset/fuzzy).
3. Haiku's self-reported `basis` is noisy. Watch name-form inferences labelled record_evidence
   (Alex MacLean). Policy C (verify unless the names are equivalent) is the fallback if one
   turns out wrong.
4. **Logged, not fixed:**
   - the misnamed survivor "Yoshitomo Nara & Hiroshi Sugimoto";
   - the Manzú lot-grouping junk nodes;
   - the 351 collaboration/after credit nodes, scoped separately.
