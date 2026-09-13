# ADR-0018: Stage 2a resolves the ACKG in code, and hands the model the answers

**Date:** 2026-09-11
**Status:** Accepted, implemented, **default on** as of 2026-09-11 — the stability protocol decided it (below). `config.deterministicStage2aQueries: false` falls back to the tool loop. Thresholds unfitted.

The Attribution Evidence Agent stops choosing which graph queries to run. A deterministic
planner derives the candidate set and the query parameters from the structured Stage 1a/1b/1c/1d
outputs, runs every query before the model is called, and puts the rows in the prompt. The
model is offered no graph tools, and the `K_*` and `catalogue_*` cells are written by code from
the rows it was shown.

Narrows [ADR-0003](0003-knowledge-graph-grounded-triage.md) item 4 — the ACKG lookup is still a
live lookup rather than a prompt-time recollection, which was that decision's point; only the
*choice* of query moves out of the model. Leaves
[ADR-0010](0010-two-pass-attribution-artist-then-work.md)'s cell set, the two-pass tree and
[ADR-0006](0006-deterministic-stage2b-routing-and-skeptic-integration.md)'s routing surface
untouched: the same cells reach the same tree, from a different hand.

---

## Context

Stage 2a is two systems. A model fills observation cells through a tool loop; a pure
deterministic tree turns those cells into a rule, a verdict, a confidence and a scenario. The
tree has been the stable half throughout. The loop has not.

Measured self-agreement against a majority reference, 5 committed fixtures, 4 repetitions:

| model | agrees with own majority | stable lots | degraded | s/lot | $/lot |
|---|---:|---:|---:|---:|---:|
| Sonnet 4.6 | 80% | 3/5 | 0/20 | 61 | $0.0728 |
| qwen-plus (2025-12) | 35% | 1/5 | 1/20 | 54 | $0.0093 |
| qwen3-14b | 35% | 3/5 | 2/20 | 36 | $0.0156 |
| qwen3.7-plus | 50% | 0/5 | 5/20 | 108 | $0.0145 |

Five Qwen models were tested and none reached usable stability; there was no size gradient.
The conclusion drawn at the time was that Stage 2a needs a strong model. That conclusion was
half right. A large part of what was being measured is not disagreement about evidence — it is
disagreement about **whether to go and look**, and **what to ask for**.

The loop left the model four free choices per lot: whether to call `query_ackg` at all, what
technique string to pass, whether to call `query_ackg_work`, and which number to transcribe
back into `kWorkTitleSim`. Each is a fork that produces a different cell set from identical
input, and the worst of them is silent: an agent that never calls `query_ackg_work` leaves
`kWorkQueried` false and `kWorkTitleSim` -1, which switches off the entire title cascade in
`two_pass_attribution`. No error, no warning, just a lot decided on less evidence than the one
before it. A refusal budget (`MIN_ACKG_ROUNDS_BEFORE_REPORT`) was added to push back on an
early report, which is a symptom-level fix: it forces *a* query without constraining *which*.

None of this is a model failing. Choosing a controlled-vocabulary string, deciding whether a
title is worth looking up, and transcribing a similarity score are not judgement. They are
lookup and clerical work, and they were being asked of the one component in the stage that
cannot do them the same way twice.

## Decision

**1 — Code builds the query plan.** `buildStage2aQueryPlan()` is pure and unit-tested. From
the structured Stage 1 outputs it derives:

- the **candidate set** — Stage 1c's claimed artist, a VEA signature that reduces to a plain
  name, Stage 1b's best match, Stage 1d's matched artists; deduped on the folded name, capped
  at 4;
- the **technique**, mapped into the graph's controlled vocabulary. `queryAckg` matches
  technique as a case-insensitive substring of the stored node name, so "Silkscreen" against a
  graph storing "Screenprint / Serigraphy" returns zero rows with no error — indistinguishable
  from an artist who made no screenprints. The mapping is a table, not an instruction;
- the **paper**, likewise;
- the **title to score against**, and separately the title to *retrieve* with.

**2 — Every query runs before the model is called, for every candidate.** Previously only the
candidate the model settled on got graph evidence, so a wrong dominant meant the graph was
never asked about the right artist. Now each candidate is resolved through
`resolveArtistIdentity` (absorbing the honorific problem: "Sir Peter Blake" returned 0 comps
where "Peter Blake" returned 40, and 35 artists holding 4,859 works carry honorific aliases),
counted against the œuvre query, and looked up by title.

**3 — The model gets no graph tools.** `graphToolsDisabled` also drops the
query-before-you-report gate, which would otherwise refuse reports until a refusal budget ran
out on queries that no longer exist. `ATTRIBUTION_EVIDENCE_PRERESOLVED_SUFFIX` supersedes
STEP 3/STEP 4's call instructions; it is a constant appended to a constant, so the cached
prefix costs one write per run rather than one per lot.

**4 — Code writes the graph cells, over whatever the model reported, and logs the difference.**
This is the measurement that did not previously exist: a mis-transcribed `kWorkTitleSim` was
indistinguishable from a real one.

**5 — The model still names candidates.** Where code cannot derive one — a monogram, an
illegible mark — the candidate is simply absent from the plan and the model may name it;
`lookupLateCandidate` then runs the same fixed queries for that name. The model can name an
artist. It cannot choose a query.

**6 — Dimensions break ties the title embedding cannot see.** Detailed below.

## What the first run measured

5 fixtures, Sonnet 4.6, one pass. 5/5 artist matches ground truth, 0 degraded lots, every lot
logging `round 1: no graph query — stopping loop (0 rounds used)`.

| | tool loop | deterministic |
|---|---:|---:|
| mean s/lot | 61 | 50 |
| $/lot | $0.0728 | $0.0525 |
| graph rounds | 1–5 | 0 |

**28% cheaper and 18% faster**, which is a side effect rather than the aim: the loop's rounds
carry the growing tool-call history as uncached input on every subsequent call.

The override log is the substantive result. Consistently across both runs:

- **`kWorkBackPropArtist` overridden on 4 of 5 lots.** The model reported the artist it already
  believed in — "Pablo Picasso", "Banksy", "Elisabeth Frink", "Peter Blake" — from an
  artist-blind title probe that supports nobody (0 artists matched the Picasso title; 12
  matched "flag"). This is precisely the circularity [ADR-0015](0015-artist-attribution-confidence-and-corroboration.md)
  removed `K` from `eligibleVotes` for, reappearing one layer down as a transcription. The cell
  is now `""`.
- **`catalogueTechniques` overridden on every screenprint lot**, the model splitting the single
  stored node name `"Screenprint / Serigraphy"` into two techniques.

## Three findings that changed the design

### The period filter was measuring date coverage, not period

`cw.dateCreated_year` is absent on 26,435 of 86,585 ConceptualWorks (30.5%) — and on 289 of
Peter Blake's 532 (54%) — and a Cypher comparison drops a null. Measured on A0793/122, Peter
Blake, Screenprint + wove, A0793 excluded:

```
strict 1962-1966     66 artists    Blake =   1
null-tolerant       383 artists    Blake = 127
no period           400 artists    Blake = 229
```

A period range silently discards every undated work, and the count that comes back measures
date coverage. Blake falls from 229 to 1, which reads downstream as "this artist is not
catalogued working like this" and fails corroboration at `KOEUVRE_DISCRIMINATING_MIN = 3`. A
null-tolerant predicate fixes the silent discard but barely narrows anything, so period is not
doing discriminating work either way. Between a filter that manufactures false absence and one
that does nothing, the system's own rule decides it: absence of population data is never
evidence against a candidate. **The œuvre query carries no period bounds.**

Consequence, recorded and not acted on here: `kOeuvreMatchCount` is now high for almost any
real artist — 319 of 400 returned artists clear 3. `KOEUVRE_DISCRIMINATING_MIN` was already an
unfitted placeholder ([ADR-0010](0010-two-pass-attribution-artist-then-work.md) Decision 4) and
needs refitting against this distribution. It is left alone so the refit is its own measurable
change rather than a side effect of this one.

### Both sides of a dimension comparison must come from one hand

`classifyDimensionMatch` is axis-strict — it compares width to width and height to height,
with no orientation tolerance. On A0793/2 the model had transposed **both** sides, and the
error cancelled. Writing the catalogue side from the graph while leaving the observed side as
the model's broke the cancellation and produced a 36.2% "material" divergence on a print that
matches its catalogue record exactly.

So `applyObservedDims` fills the observed cells from Stage 1c's structured `dimensionsClaim`
whenever the catalogue side is being written. Whether "width first" is semantically right is a
separate question — the auction convention is arguably height first, and both the parser and
Stage 1c read the first number as width. What an axis-strict comparison needs is that the two
sides agree, and the only way to guarantee that is for one source to fill both.

### Dimensions can settle what the title embedding is blind to

On A0793/113, Stage 1c gives the title as a bare "Spinning man". The graph catalogues eight
Frink siblings, and the embedding scores *Spinning Man V* at 1.00 because it cannot see the
roman numeral — the same blindness measured directly on the graph's titles: `pl. 25` vs
`pl. 26` = 1.000, `2e planche` vs `3e planche` = 0.983.

The object measures 600×830mm. *Spinning Man V* is catalogued at 800×575 — a third out, read
correctly by the tree as `later_edition` and routed to Scenario 2, buying an adversarial
authentication pass. *Spinning Man VII* is 575×805: 4.3% and 3.1% out, inside the 8% sheet
tolerance. The series genuinely contains both orientations, recorded correctly. The wrong
sibling was picked upstream, where nothing could see the measurement.

`breakTitleTieOnDimensions` is a **repair, not a reranking**. It fires only when the top row
fails the tolerance test and another row inside a 0.03 title band passes it. A top row that
already measures right is never disturbed; a row outside the band is never promoted however
well it measures. Dimensions get to choose between works the title says are the same, and
nothing more. The band is measured, not guessed: 0.03 covers the numeral failures above without
reaching titles the embedding can actually separate ("Flag" vs "Silver Flag" = 0.874, "Cats
(Pink)" vs "Cats (Black)" = 0.633). The tolerance test itself is `dimsWithinTolerance`,
exported from `two_pass_attribution` and shared with `compareDims`, so the tie-break cannot
promote a row the tree then rejects.

### What three runs actually moved

| lot | run 1 | run 2 | run 3 | cause |
|---|---|---|---|---|
| A0793/2 Villon | Sc.3 | Sc.3 | Sc.3 | observed-dimension fix: `later_edition` -> `none`, work LOW -> MEDIUM_HIGH |
| A0793/113 Frink | Sc.2 | Sc.2 | **Sc.3** | tie-break: *Spinning Man V* -> *VII*, false `later_edition` gone |
| A0793/122 Blake | Sc.1 | Sc.1 | **Sc.3** | Pass 1 artist rule A2 -> A3 — model variance, not this change |
| A0793/303 Picasso | Sc.2 | Sc.2 | Sc.2 | stable |
| A0793/512 Banksy | Sc.3 | Sc.3 | Sc.3 | stable |

5/5 against ground truth in every run, 0 degraded. The tie-break fired once — on the case it
was built for — and declined three times, each decline recorded: no row inside the band fitted
the object, so the top row stood.

Lot 122 is the instructive one. Its Pass 2 trace is byte-identical between runs 2 and 3, both
graph-cell overrides are identical, and the move comes entirely from Pass 1: `A2
attributed/HIGH` became `A3 attributed/MEDIUM_HIGH`. That is the artist rule reading the
naming-source cells — `veaNamesArtist`, `appraiserTrust`, `reverseImageConsistentWithVea` —
which this decision deliberately leaves with the model.

This is a result rather than a disappointment. With the graph cells pinned, **the residual
variance is now isolated to the observation cells and visible**. Before, a Scenario 1 -> 3 move
could have come from either half of the stage and there was no way to tell which. The
stability protocol should now be read as measuring the observation half specifically.

### Writing cells surfaced a block that was never an object

Flipping the default turned up a crash the 20 protocol runs had not: Haiku 4.5 returned
`impressionEvidence` as a JSON *string* rather than an object, and `applyCandidateFacts` threw
`Cannot create property 'catalogueTechniques' on string` — taking the lot down with a
TypeError, the failure mode `runStage2aTriage`'s own comment exists to prevent.

The loud half was mine and is fixed: the cell setter now refuses any non-object target. The
quiet half predates this decision and is the more serious of the two. `evidenceToTwoPassInput`
reads `kId`, `kOeuvreMatchCount` and the rest off whatever it is handed; off a string it gets
`undefined` for every one, and the tree evaluates a block that looked present and was empty.
On the tool-loop path that produced an inexplicably uncorroborated lot with no error anywhere.

`normalizeEvidenceBlocks` parses such a block back before anything reads or writes a cell. The
evidence was all there; only its envelope was wrong. A string that will not parse is left
alone for the existing "report omitted X" check to degrade on honestly.

Worth stating plainly, because it is an argument for the decision rather than against it:
this defect was found only because code now writes into those blocks. Reading from them had
been failing silently for as long as the block could arrive stringified.

### The stability protocol

5 committed fixtures x 4 repetitions, majority reference, no `--resume` so every repetition
re-runs every lot. Haiku 4.5 on the plan, against the historic tool-loop figures:

| model | Stage 2a mode | agrees with own majority | stable lots | degraded | s/lot | $/lot |
|---|---|---:|---:|---:|---:|---:|
| Sonnet 4.6 | tool loop | 80% (n=2) | 3/5 | 0/20 | 61 | $0.0728 |
| qwen3.7-plus | tool loop | 50% | 0/5 | 5/20 | 108 | $0.0145 |
| qwen-plus | tool loop | 35% | 1/5 | 1/20 | 54 | $0.0093 |
| qwen3-14b | tool loop | 35% | 3/5 | 2/20 | 36 | $0.0156 |
| **Haiku 4.5** | **plan** | **95%** | **4/5** | **0/20** | **31** | **$0.0122** |

20/20 against ground truth. Total cost of the protocol: $0.244.

**Haiku on the plan beats Sonnet on the loop on every axis, cost included — six times cheaper
and more stable.** That inverts the conclusion the Qwen work reached. Five models were ruled
out of Stage 2a on the reading that the stage needs a strong model; what they were failing at
was the loop, not the judgement. The stage as it now stands asks for judgement over facts
already on the table, and a small model does that well.

At 443 lots this is $5.41 for Stage 2a, against $32.25 for Sonnet on the loop — which alone
exceeded the £20 budget for the whole pass before any other stage ran.

### The one unstable lot names the remaining variance surface

A0793/113 across the four repetitions produces an identical tree result every time —
`A2 attributed/HIGH "Elisabeth Frink"`, `T5 candidate/MEDIUM_HIGH`, `impression=none`, the
same dimension note, the tie-break firing in all four. The divergence is entirely in
`riskFlags`:

| | |
|---|---|
| reps 1-3 | `editionComplexityRisk`, `authenticationBodyExists`, `physicalExaminationRequired` |
| rep 4 | `misattributionRisk`, `physicalExaminationRequired` |

`misattributionRisk` routes to Scenario 2 rather than Scenario 3. Identical evidence,
identical verdict, a different risk judgement — and `riskFlags` is now the entire remaining
variance surface at Stage 2a. It is the same shape as the Sonnet lot-122 result above: what
code writes holds still, and what the model writes moves.

Caveat worth keeping in view: five lots, and they are the committed reproduction fixtures —
lots this pipeline has been tuned against. A fresh slice of the pool the plan has never seen
is the honest next test, and these figures should not be read as a pool-wide estimate until
that runs.

### The fresh slice: 95% was flattered by the fixtures

The figures above come from the five committed reproduction fixtures — lots this pipeline has
been tuned against. Re-run on the 10 pool lots the plan had never seen, same protocol, same
model:

| | 5 fixtures (tuned) | 10 pool lots (unseen) |
|---|---:|---:|
| agreement with own majority | 95% | **85%** |
| fully stable lots | 4/5 | **5/10** |
| degraded runs | 0/20 | **0/40** |
| artist matches ground truth | 20/20 | **8/40** |

85%, not 95%. It still beats Sonnet's 80% on the loop, and 0 degraded runs out of 40 holds,
but the headline number does not survive contact with lots the plan has not seen and should
not be quoted as though it does.

The accuracy collapse is a different thing and is NOT Stage 2a regressing. The two lot sets
are structurally different populations:

| | A0793 fixtures | pool slice |
|---|---|---|
| Stage 1c claimed artist | yes, `documented_fact` from catalogue notes | **none** |
| Stage 1d embedding match | yes | **none** |

The fixtures hand Stage 2a the artist in a trust-tagged cell; the pool lots do not, and have no
`D` voter either. Six of the ten name no artist in any repetition. 20/20 was measuring Stage 1c
recall as much as Stage 2a judgement. Any future comparison has to hold the input regime fixed.

One of the 32 non-matches is a bad label rather than a bad answer: `A0731_171` names "Andy
Warhol" in all four repetitions and is scored a miss because its ground truth is recorded as
"Sunday B Morning" — a publisher, not an artist.

### riskFlags is the remaining variance surface, now properly evidenced

The Frink result above was one lot. On the fresh slice every single unstable lot has an
**identical tree artist verdict across all four repetitions**:

| lot | verdict, all four reps | what actually flips |
|---|---|---|
| 1012_147 | `A11 not_attributed` | `misattributionRisk` |
| 1105_109 | `A11 not_attributed` | `misattributionRisk` |
| 1147_303 | `A11 not_attributed` | `misattributionRisk` |
| A0724_373 | `A11 not_attributed` | `misattributionRisk` |
| A0673_182 | `A7 candidate/MEDIUM "Yaacov Agam"` | a work title |

Four of the five turn on a single boolean the model sets, with the evidence and the verdict
byte-identical either side of it — `misattributionRisk` routes to Scenario 2 instead of
Scenario 4. The fifth is the same story in a different cell: one repetition produced a work
candidate ("Black/White Stripes") the other three did not, and that candidate's dimension
mismatch drove Scenario 2. `plan.observedTitle` is code-derived and stable, so that title came
from a model-filled cell as well.

That is the claim the single Frink lot could only gesture at, now reproduced across 10 lots in
a different input regime: **what code writes holds still; what the model writes moves.** And it
localises the problem — `misattributionRisk` alone accounts for four of the five failures, which
makes it the obvious next target rather than "the observation cells" in general.

## Consequences

**Stage 2a's model requirement changes shape, and the change is large.** The stage now asks
for judgement over facts already on the table rather than tool-loop discipline, and Haiku 4.5
does that at 95% self-agreement where Sonnet 4.6 on the loop managed 80%. Stage 2a's default
model should follow; the Qwen models deserve a re-test against the plan on the same grounds,
since they too were ruled out against the loop.

**A graph outage degrades rather than fails.** `executeStage2aQueryPlan` throwing falls back to
the tool loop, and says so.

**The model can no longer research its way out of a bad plan.** If the planner derives the
wrong technique, no amount of model competence recovers it — where previously an agent might
have tried a second query. This is the real cost of the decision, and the reason the plan's
every choice is recorded in a trace rather than applied silently.

**Truncation is never reported as absence.** The œuvre query returns artists ordered by support
and cut at 500; a candidate missing from a full page may simply have fallen off the end, so it
is recorded as -1 (not assessed), never 0.

## Status and what is unfitted

- `TITLE_TIE_BAND = 0.03` — measured against the blindness cases, not fitted.
- `MAX_PLANNED_CANDIDATES = 4`, `OEUVRE_LIMIT = 500`, `WORK_ROW_LIMIT = 60`,
  `TITLE_PROBE_LIMIT = 12` — cost bounds, not findings.
- `KOEUVRE_DISCRIMINATING_MIN` — was 3 and inherited; refitted to 10 on 2026-09-11 against
  24 candidate rows over 14 lots, each scored against the lot's ground-truth artist:

  | threshold | ground truth clears | rivals clear |
  |---|---:|---:|
  | >= 3 | 79% | 70% |
  | **>= 10** | **79%** | **50%** |
  | >= 25 | 57% | 30% |

  10 is the largest value costing no sensitivity — every true positive 3 kept, half the
  rivals. Past it the first casualties are niche artists whose technique is thinly catalogued
  (Sam Francis 1 of 538 works, Pat Steir 1 of 32, Jim Dine 0 of 618), which is absence of
  population data rather than evidence against.

  Two results worth keeping. A share-of-œuvre normalisation is WORSE, not better — AUC 0.646
  against the absolute count's 0.746 — because it rewards thin coverage: rival Shmuel Shapiro
  scores 11 of 12 works (91.7%) and Willem de Kooning 42 of 46 (91.3%), against a correct
  Picasso at 15.6%. And no threshold makes this a strong signal: AUC 0.746 is weak whatever is
  chosen, tolerable only because this is step 2 of the cascade, reached when no catalogued work
  matched the title. The value is fitted in direction, not in precision — 14 positives and 10
  negatives is a small sample, and the gap between 3 and 10 rests on two rival rows.
- The candidate-name recovery from a VEA signature is deliberately conservative: a monogram or
  anything that does not reduce to a short run of alphabetic tokens returns null and is left to
  the model. Being wrong there is worse than being absent — a wrong name is queried, comes back
  with support, and corroborates itself.

## Verification

- `npm run test:stage2a-query-plan` — 38 unit tests over the pure half.
- `npm run test:stage2a-evidence` — 49 tests, including the stringified-block recovery.
- `npm run test:pool:triage -- --dir tests/backtest/fixtures` — the live path, against the
  committed reproduction fixtures. Add `--tool-loop` to run the pre-plan behaviour for
  comparison.
- `npm run test:pool:triage -- --dir tests/backtest/pool_output` — the unseen pool slice. Ten
  lots with no Stage 1c artist claim and no Stage 1d; the harder and more realistic regime.
- The stability protocol has been run on Haiku 4.5 (above) and settled the default. It has
  **not** been run on Sonnet against the plan — the three Sonnet passes recorded above are
  single passes — so no plan-mode agreement figure exists for Sonnet.
- The fixture figures and the pool-slice figures are not interchangeable: different input
  regimes (see the fresh slice above). Quote them separately.
