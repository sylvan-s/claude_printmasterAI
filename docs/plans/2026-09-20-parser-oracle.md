# Parser oracle: grade the deterministic rules with a strong LLM, hand shapes down to a cheap one

**Date:** 2026-09-20
**Status:** PLANNED, NOT STARTED. **Paused 2026-09-20 for token budget** — no work done beyond
this document. Resume at Phase 0.

Sylvan's framing: we have deterministic rules for most parsing, and guards for where they are
not reliable enough. The next step is to test how well those parsers actually do by having a
strong model do the same work — and, as part of that, to find patterns that could be handed to a
Haiku-class model.

---

## Principle: the oracle is a discovery instrument, not a runtime dependency

The default disposition for anything the LLM finds is **fold it back into the deterministic
rule**. `EDITION-SIZE-1.1` is the proof: 344 rows, 19 of them badly wrong, found by reading four
regexes side by side. A model would have found them in an afternoon. The output of this work
should be more corpus — fixture cases, tighter rules, new guards — not more inference at runtime.

This is consistent with the objective in [RULES.md](../RULES.md): coverage and interrogability,
not accuracy.

## Score buckets, not accuracy

Per row, four outcomes, not equally interesting:

| | meaning | priority |
|---|---|---|
| rule silent, LLM found a value | coverage gap | high — 325 of the 344 were this |
| rule fired, LLM disagrees | **silent wrongness** | highest — the entire incident history |
| rule fired, LLM agrees | fine | ignore |
| LLM silent, rule fired | LLM miss *or* rule false positive | adjudicate both ways |

"LLM accuracy" is the wrong headline. The useful output is **how many distinct failure shapes a
rule has, and how often each fires** — a shape is what becomes a fixture case and a rule change.

## Phase 0 — calibrate the oracle before trusting it (start here)

We have an answer key, which is unusual and should be used: the 344 repaired rows are
known-correct, the 19 replacements were reviewed individually, and
`tests/fixtures/edition_size.jsonl` holds 29 cases with stated reasons.

Run the strong model over those, blind to the stored values. If it cannot rediscover the 19
parenthetical-run errors — `numbered in pencil 151/500 (aside from the edition of 3000 with
text)` is 500, not 3000 — it is not ready to look for failures we do not already know about.
Anything it flags *beyond* the 19 is the first real yield.

Cheap, bounded, and it yields a measured oracle-quality number instead of an assumed one.

## Phase 1 — sweep one family

Edition size first: it is the only family with a fixture corpus and a known answer key.
Stratified sample by source, batch API, Opus 5 as oracle. Batch precedent:
`clip_subject_classifier.py`, `resolve_tate_images.py`.

## Phase 2 — disposition each recurring shape

- **(a) deterministic** — a regex can capture it. Fold in, add the fixture case, write the guard.
  Zero runtime cost. **Expect most shapes here.**
- **(b) cheap model** — genuine judgement needed (which of two runs does this impression belong
  to?) *and* Haiku matches Opus on that specific shape. Precedent: `roseberys_pass2_haiku.py`.
- **(c) strong model or human** — rare; flag rather than automate.

## Phase 3 — the Haiku handover test, per shape, not globally

Two precedents in this repo went opposite ways: Haiku 4.5 reached 13/14 of Opus on the vision
adjudicator, but Opus was clearly needed on Roseberys multi-work lots (38/40; Haiku lost). So the
test runs per failure-shape.

Score it the way `tests/backtest/compare_stage2b_models.ts` does — on the behaviour that matters,
not prose similarity. For parsing, the behaviour that matters is **abstention**: does the model
say "no edition size stated" rather than inventing one? A parser oracle that confabulates is
worse than a regex returning null, and that is exactly where the cheap models failed before
(qwen3-max invented a GBP 3,486,000 sale; Gemini 2.5 Flash and DashScope Qwen were unusable at
~30% refusals and confabulation).

## Phase 4 — anything that ends up at runtime joins the corpus on the same terms

A shape in disposition (b) gets a rule ID, a fixture corpus and a guard, exactly as a regex
would. Otherwise it is an unmanaged dependency sitting outside the corpus.

## Shape of the work

`tests/parser_oracle/`, following the existing bake-off harnesses. An ADR records the
dispositions, so "we tried a model here and it was not needed" is captured as firmly as the
adoptions — as the trailing-`\b` decision was.

## Known costs and expectations

- This costs real tokens. Work has been paused for processing budget before (ADR-0019).
- It will surface more work than it closes. That is the point, but worth expecting.
