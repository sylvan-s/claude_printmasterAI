# ADR-0020: Parsing rules live in one module per rule family, mirrored not generated

**Date:** 2026-09-20
**Status:** Proposed. The pattern is not new — it is read off `knowledge_graph/copy_type.py`
(`COPY-TYPE-1.1`, on `fix/ingest-dims-copytype`), which already implements every element below
for the copy-type family. This ADR names that shape so the next family does not have to
rediscover it. **Phase 2 (measurement) done 2026-09-20**, numbers in Context. **EDITION-SIZE-1.1 adopted
2026-09-20** — the ingest gap closed; see Reconciliations.

A *rule family* is one question asked of free-form catalogue prose — "what was the edition
size?", "is this a proof, and of what kind?", "is it signed?". Each family gets exactly one
Python module and at most one TypeScript mirror. Ingests, the price model, the benchmark
parsers and the live appraisal path all call into it rather than carrying their own copy.

---

## Context

Rules are currently implemented once per consumer. For edition size there are four live
implementations, all patched independently:

| | `src/shared/text_extraction.ts` | `benchmark/src/forum/parse.ts` | `knowledge_graph/bonhams_parsing.py` | `knowledge_graph/pricing_ml/train_price_model.py` |
|---|---|---|---|---|
| consumers | Roseberys parser, `appraiser.ts:2722` (live Stage 2) | Forum parser | bonhams **and swann** ingest | price-model fallback |
| `numbered n/N` | yes | yes | yes | yes |
| `No.` prefix, `in pencil` | yes | yes | **no** | yes |
| mm/cm/in lookahead guard | yes | yes | **no** (shielded instead by a mandatory `number(ed)` prefix) | yes |
| `edition of N` | yes | yes | yes | yes |
| `approximately`/`circa` qualifier | no | no | no | **yes** |
| `one of N impressions` | no | no | no | **yes** |
| roman impression number | no | no | **yes** | no |
| size cap | `\d+` | `\d+` | `\d+` | `\d{1,5}` |

Measured against `tests/fixtures/edition_size.jsonl` (24 cases) on 2026-09-20: **the four
disagree on 8**. `bonhams_parsing` returns nothing for `No. 45/250` and for
`numbered in pencil 3/8` — ordinary catalogue phrasings, not edge cases, and it serves two
ingests.

Measured against the graph the same day, on Bonhams / Skinner / Swann impressions:

| divergence | impressions | `declaredSize` null today | already set | null **and** sold |
|---|---|---|---|---|
| ingest gap (`No.` / `in pencil`) | 343 | 318 | 25 | 248 |
| model-only (`one of` / `approx`) | 999 | 902 | 97 | 670 |

The second row is the important one: for 902 impressions the **price model already reads an
edition size from text that the graph does not store**. Model and graph disagree today, and
the model holds the richer value. Unifying the ingests upward therefore makes the graph agree
with what the model already believed — it is not a change of model behaviour on those rows.

The 122 impressions that already carry a size are the only ones where a value could *change*.
They are reviewed individually; nothing is written to the graph by this ADR.

Three edition-size bugs have been fixed in this family (Forum inch fractions, the price model's
text fallback, thousands separators). Each was found and repaired in one implementation at a
time. The divergences above are what those independent repairs left behind.

## Decision

**1. One module per rule family, named for the rule, not the source.** `copy_type.py`,
`edition_size.py` — not `bonhams_parsing.py`. A module named after a house accumulates
unrelated rules and gives a second house no reason to look inside it.

**2. The module docstring opens with the rule ID, its version, and the incident.** As
`copy_type.py` does: what the rule was before, what it broke, how many rows, when it was
measured, which repair script fixed it. The docstring is where a reader learns why the regex
is shaped the way it is, and it is the thing a later session greps for.

**3. Rule IDs are load-bearing.** `COPY-TYPE-1.1`, `EDITION-SIZE-1.0`. The ID appears in the
module, in its mirror, in the guard and in `docs/RULES.md`. Today IDs like `BLEND-1.6` live
almost entirely in ADRs and memory, so the ID that names a rule does not reach the code that
implements it.

**4. A `legacy_*()` twin is kept whenever a graph repair is possible.** `copy_type.py` keeps
`legacy_detect_copy_type()` and `LEGACY_COPY_TYPE_KEYWORDS` for exactly one purpose: letting
`repair_copy_type_bat.py` confirm a stored value is still precisely what the old ingest
produced before it overwrites it. Without the twin, a repair cannot distinguish a value it
created from one a human or a later rule set.

**5. The TypeScript mirror is hand-written, not generated, and says so.** Python and JS regex
semantics differ — `price_attrs.ts` already spells `[\p{L}\p{N}_]` by hand because Python's
`(?<!\w)` is Unicode-aware and JS's `\b` is not. A generator would have to model that
difference. Instead each mirror carries an explicit *change the two together* line naming its
counterpart, and the fixture corpus (below) is what actually catches the drift.

**6. One fixture corpus per family, consumed by both languages.**
`tests/fixtures/<family>.jsonl`, one `{id, text, expect, why}` per line. The `why` field
carries the incident, so a case cannot be quietly deleted when it becomes inconvenient. Both
the TypeScript runner and the Python runner read the same file. This is the only mechanism
binding the mirrors; it needs no build step.

**7. Extraction lands as a pure move, reconciliation lands separately.** The commit that
creates the shared module changes no behaviour — it may carry two differently-named functions
if the callers genuinely differ today. Only afterwards does each divergence get reconciled,
one commit each, each with its own row count. A move and a behaviour change in one commit
cannot be reviewed, and cannot be bisected.

**8. Nothing in this pattern writes to the graph.** Unifying a parser changes what *new*
ingests produce. Existing stored values move only under a named repair script, decided
separately, measured separately.

## Reconciliations

Each divergence closes in its own commit with its own row count, per decision 7.

### EDITION-SIZE-1.1 — the ingest gap (adopted 2026-09-20)

The ingest rule now reads the `No. 45/250` prefix and the `in pencil` filler. **348 rows change
across the graph; the model rule is provably untouched (0 rows).** Of the 344 in houses that
actually consume this rule, 325 gain an edition size they never had, and 19 had one that was
wrong.

All 19 were reviewed individually and all 19 are corrections of the same shape: the rule could
not read the fraction, so it fell through to an `edition of N` that named a *different* run
mentioned in parentheses. `numbered in pencil 151/500 (aside from the edition of 3000 with text)`
was stored as 3000. `98/180 (there was also and edition of 10 in Roman numerals)` was stored as
10 — a sold lot in the <=30 band. Reading the fraction is what makes the family's documented
precedence reachable here at all.

**The model rule's dimension guard was measured and rejected for this rule.** Adding it buys
nothing — the ingest rule is already shielded by requiring a `number(ed)`/`No.` prefix
immediately before the fraction — and its trailing `\b` *loses* 15 rows, because it rejects the
suffixed edition numbers auctioneers really write: `20/25"` in quotes, `14/250P`, `48/50A`,
`8/9C`, `10/200in pen`.

### Open: the trailing `\b` (next)

That same `\b` is in `train_price_model`, `price_attrs.ts` **and** `text_extraction.ts`, so three
implementations — including the live Stage 3 pricing path — still lose those rows. Found while
adopting 1.1, recorded in both fixture runners, not fixed there: separate divergence, own count.

### Open: `one of N impressions` and the approximately/circa qualifiers

Model-only, 999 impressions, 902 with no stored size. Unchanged by 1.1.

### Not yet decided: the graph repair

1.1 changes what *new* ingests produce. The 348 stored values already in the graph are untouched.
Moving them is a named repair script with its own measurement and its own decision.

## What is deliberately excluded

`picasso_paris_ingest.extract_edition` reads bare fractions (`/30`) out of Navigart's `tirage`
field, where a leading number is the impression number and a bare `/30` means the size is known
and the number is not. Different input, different semantics; it is not a member of the edition
family and is left alone.

Dimensions are **not** unified yet. `benchmark/src/forum/parse.ts` states that its dimension and
catalogue-ref logic stays independent of `src/shared/text_extraction.ts` on purpose — house
formats differ, mm against cm — while honorifics are shared because post-nominals are not a
house concern. That distinction is correct. It also matters that a suspected height x width
transposition on Roseberys dimensions is still open; unifying on top of it would bake it in.

## Consequences

The cost is one more indirection between an ingest and its regex, and a mirror pair that a
human must keep in step. The fixture corpus makes the second failure loud, which is the trade.

The benefit is that the next edition-size bug is fixed once. The last three were each fixed in
one place while three other implementations kept the old behaviour, and the table above is the
residue.

`docs/RULES.md` indexes every rule family: ID, module, mirror, guard, ADR.
