# ADR-0009: Precomputed graph-analytics confidence signals for `query_ackg`

**Date:** 2026-08-26
**Status:** Proposed — similarity/centrality prototyped and tested live against real ACKG
data (`knowledge_graph/gds_prototype.py`); write-back into `query_ackg` not implemented.

---

## Context

**Real timing data from this session's backtests puts a number on a cost that was previously
only felt anecdotally.** Across 12 completed live Triage runs, Stage 2a duration ranged
**132.4s–258.0s** (mean ~209s) — routinely the single largest chunk of a backtest's total
runtime. Adding round-by-round logging to the `query_ackg` tool loop (`callClaudeWithAckgTool`,
`src/appraisal/appraiser.ts`) made the cause visible for the first time rather than inferred:

- Round counts of 2–4 were observed; one lot hit the hard `MAX_ROUNDS=4` cap without resolving
  cleanly, and that same lot's final attribution landed at only 0.28 confidence — a direct,
  visible link between running out of loop budget and a weak final answer.
- **A large fraction of individual `query_ackg` calls return zero candidates.** The model
  reasons sensibly about this when it happens ("no population data — coverage gap for late
  19th-century French prints, let me broaden") and retries with different filters, but each such
  cycle costs a full LLM round-trip.
- The model has **no precomputed signal for "how well-evidenced is this artist overall"** — it
  can only infer confidence from whatever a single filtered `supportCount` happens to return,
  which pushes it toward re-querying with different parameter combinations just to build a
  fuller picture.

**A real, already-available asset is sitting unused.** Earlier this session (comparing Neo4j
against BigQuery as the graph backend), confirmed directly against Neo4j's own documentation
and changelog: **Aura Graph Analytics — the full Graph Data Science algorithm suite (PageRank,
Louvain, node similarity, FastRP embeddings, 65+ algorithms) — is available at no cost on
AuraDB Free**, running in isolated compute sessions (2GB memory, up to 4-hour session duration,
sessions themselves unbilled on Free tier). This was identified as a genuine advantage of the
Neo4j choice over BigQuery specifically, and has not been used for anything in this project yet.

**Important mechanical constraint, confirmed the same session**: GDS algorithms run in an
isolated compute session, not as something invokable live inside a single request. So this
can't mean "run PageRank during Triage" — it means **precompute scores offline on a schedule,
store them as ordinary node properties, and have `query_ackg` read those properties cheaply at
request time** — the same operating pattern already established for
[ADR-0008](0008-ackg-pruning-and-curation.md)'s Curator (offline maintenance, never live
pipeline cost).

---

## Decision

### 1. Two precomputed signals, both offline, both stored as ordinary node properties

**a. A node-similarity index**, built via Aura Graph Analytics' node similarity (or FastRP
embedding + k-NN) algorithm, over a feature projection of each `Artist`/`ConceptualWork`'s
technique + period + region + subject + paper profile — the exact dimensions `query_ackg`
already filters on. Used specifically for the empty-result case: when an exact-filter query
returns nothing, `query_ackg` falls back to the similarity index to surface the *nearest* real
candidates rather than nothing at all, collapsing what currently takes 2+ rounds of manual
filter-loosening into a single response.

**b. An evidence-strength centrality score per artist** (PageRank or weighted degree
centrality over the Artist→ConceptualWork→SourceRecord subgraph, weighted by source layer —
institutional vs. auction, matching the existing provenance-tag split), stored as
`Artist.evidenceCentrality` and added to every `AckgCandidate` `query_ackg` returns. Gives the
model a genuine "how well-evidenced is this artist, overall" reading on its *first* call,
reducing the pressure to keep re-querying just to build that picture manually.

### 2. `query_ackg`'s contract changes, with provenance transparency preserved

- Similarity-based fallback results are explicitly labeled as such (e.g. a
  `matchBasis: "exact" | "similarity"` field) — never silently presented as equivalent to a
  real filtered population match. Same discipline as institutional vs. auction-history
  tagging: a weaker evidence type must always be visibly weaker, never blended in.
- `evidenceCentrality` is additive to the existing `supportCount`/`institutionalSupportCount`/
  `auctionSupportCount` fields, not a replacement for any of them.

### 3. Offline refresh cadence matches ADR-0008's operating model

Recompute runs on a schedule or ingestion-volume trigger (e.g., after a bulk load, or once
[ADR-0007](0007-ackg-research-writeback-learning-loop.md)'s write-back has accumulated a
meaningful amount of new data) — not per-request, not per-appraisal. A GDS session starts, runs
the algorithm(s), writes results back as properties via normal Cypher writes, and closes. No
incremental node/relationship cost of concern beyond the new properties themselves.

### 4. Prompt update

Section 2F of `ATTRIBUTION_TRIAGE_SYSTEM_PROMPT` (knowledge graph grounding) gains a
description of `evidenceCentrality` and explicit instruction that a `matchBasis: "similarity"`
result is weaker evidence than an exact filtered match — never treat the two as
interchangeable when weighing `candidateProbability`.

### 5. Explicitly not addressed here: the loop mechanism itself

This does not change `MAX_ROUNDS`, the loop's round-based structure, or how many rounds a given
Triage call might still take. It changes what each round's response *contains* — the bet is
that richer, precomputed signal per call reduces how often multiple rounds are needed, not that
any single round becomes faster or that rounds are eliminated outright.

---

## Consequences

**Good:**
- Uses a real, already-available, currently-idle asset (Aura Graph Analytics) rather than
  building bespoke similarity/ranking logic from scratch — the free-tier availability was
  specifically identified as an advantage of staying on Neo4j; this is the first thing that
  actually spends it.
- Targets the empirically observed pain point directly — empty results forcing manual
  re-querying — with a mechanism that scales as [ADR-0007](0007-ackg-research-writeback-learning-loop.md)'s
  write-back grows the graph, rather than degrading.
- Zero added latency risk to the live appraisal path — all compute happens offline, matching
  ADR-0008's pattern, not a new real-time dependency.
- A plausible, not-yet-decided future integration point: `evidenceCentrality` could eventually
  feed [ADR-0006](0006-deterministic-stage2b-routing-and-skeptic-integration.md)'s deterministic
  classifier (e.g., sharpening `hasWorkLevelMatch` or `CONFIDENT_THRESHOLD` reasoning) — flagged
  here as a future possibility, not decided or implemented by this ADR.

**Accepted limitations / open risks:**
- **Feature encoding for the similarity index is real design work, not a default.** Deciding
  how to project technique/period/region/subject/paper into a comparable feature space for a
  similarity or embedding algorithm needs real design and testing — not specified here, left to
  implementation.
- **Real risk of the similarity fallback being misread as equivalent to true population
  evidence** if the `matchBasis` distinction isn't enforced consistently in both the tool's
  output and the prompt's instructions — the same category of risk ADR-0007 already flagged for
  `agent_research`-tagged evidence, and it needs the same discipline: never silently blended in.
- **Centrality scores go stale between refreshes** — same staleness risk any precomputed signal
  carries. Needs a real, monitored refresh cadence, not an install-once-and-forget script.
- **No backtest evidence yet that this actually reduces Stage 2a's round count or timing** —
  this ADR's premise is a reasoned hypothesis from real log analysis, not a validated result.
  Should be verified with real before/after backtest timing once built, the same
  verify-don't-assume discipline applied throughout ADR-0006's implementation.
- **Exact algorithm choice (node similarity vs. k-NN vs. FastRP embeddings + cosine similarity)
  is unsettled** — worth prototyping on a slice of the graph before committing to one.
- **Doesn't guarantee fewer rounds** — this is a probabilistic improvement (richer signal per
  round), not a structural fix; a lot could still need multiple rounds even with this in place.

---

## Not addressed by this ADR

- The exact feature encoding and GDS algorithm selection for the similarity index.
- The exact refresh-trigger mechanism (scheduled job vs. ingestion-volume-triggered vs. manual
  invocation as part of the ACKG Curator's own maintenance pass).
- Whether `evidenceCentrality` should feed ADR-0006's `classifyTriageOutcome` directly — a
  plausible follow-up, not decided here.
- GDS session cost/behaviour at graph sizes materially larger than the current ~190K nodes —
  not stress-tested.
- **Using the similarity index itself as an identity-resolution signal** (see Implementation
  note below) — flagged as a real idea worth investigating, not designed or tested.

---

## Implementation note (2026-08-26)

`knowledge_graph/gds_prototype.py` prototyped both signals live against the real ACKG (not a
synthetic sample) via ephemeral Aura Graph Analytics sessions. Centrality (weighted degree over
`SourceRecord-[:ATTRIBUTED_TO]->Artist`, projected `Artist -> SourceRecord` — direction matters,
see the script's own comments for why) worked cleanly and produced a plausible "evidence
strength" ranking headed by Damien Hirst, Salvador Dalí, David Hockney, Andy Warhol, Henry
Moore — real high-volume print-market names, not noise.

The similarity index took real design work, per this ADR's own "not addressed" list. **Read
with the correction below attached**: this was all artist-level aggregation (one combined
feature profile per artist across their whole output), which the "Correction" section further
down identifies as the wrong grain — an artist's career isn't one style, so "Trevelyan is
similar to Cecil Collins" means their careers overlap in aggregate, not that any specific work
by one resembles a specific work by the other. Kept below as an accurate record of what was
prototyped and found, not as an endorsed design.

- **Feature dimensions**: started at technique-only, then extended to technique + paper +
  subject + genre (all real, directly-connected controlled-vocab nodes) + period + region.
  Period and region required a genuine schema addition — see
  [doc 08 §8](../../knowledge_graph/08_ackg_schema_definition.md) — because they were plain
  properties (doc 08 §5), not nodes, and the obvious in-session workaround
  (`apoc.create.vNode`) was confirmed live to not give stable shared identity across rows.
- **Algorithm comparison, as this ADR asked for**: discrete Jaccard (`gds.nodeSimilarity`) vs.
  FastRP embedding + cosine similarity, run head-to-head on identical input. Result is a real,
  non-obvious finding, not a clean win for either: for well-documented artists with rich
  profiles (e.g. Julian Trevelyan, Jacques Villon), Jaccard produced tighter, more
  art-historically coherent cohorts (Trevelyan → Cecil Collins, Michael Ayrton, John Piper,
  Patrick Heron, Graham Sutherland, Henry Moore; Villon → Georges Rouault, Fernand Léger, Raoul
  Dufy, Marc Chagall) than FastRP did for the same artists (looser, more geographically/
  stylistically mixed lists). **The "exact algorithm" question this ADR left open is not
  settled in FastRP's favor** just because it handles sparse/thin profiles slightly better —
  worth real evaluation against more artists before committing either way.
- **Tie-saturation is a real, structural ceiling, not a bug**: even with all six feature
  dimensions, artists with a thin real profile (few works, generic technique description) tie
  at exactly 1.0 with many others, because a small controlled vocabulary means distinct
  artists genuinely can share an identical small feature set — confirmed concretely on Agathe
  Sorel (2 works, technique-only profile until a period-backfill pass added her decade). No
  further categorical feature engineering removes this; it would need continuous per-work
  signal (price, dimensions, image embeddings) to fully break.
- **A real crosswalk bug was found and fixed as a side effect** of investigating why an artist
  known to have Tate holdings (Agathe Sorel) had no `Artist` node at all: `"intaglio"` was
  never a recognized keyword in `crosswalk_matching.py`'s technique vocabulary, silently
  excluding any Tate row described only as "Intaglio print on paper" from the print-medium
  filter. Fixed; backfilled 615 previously-excluded rows across 107 artists. Unrelated to the
  similarity-index design itself, but a concrete example of this kind of live prototyping
  surfacing real upstream data gaps.
- **A future idea, not yet investigated**: running these similarity queries surfaced at least
  four likely duplicate-identity cases purely as a side effect — `"Elisabeth Frink"` /
  `"Elizabeth Frink"`, `"Zoran Mušič"` / `"Zoran Mu&scaron;ič"` (an unescaped HTML entity from a
  scrape), `"Henry Moore OM CH FBA"` / `"Henry, OM, CH Moore"`, and `"Le Corbusier"` /
  `"Le Corbusier (Charles-Edouard Jeanneret)"` — every one a real doc 08 §7a identity-resolution
  gap (same person, unmerged name variants), every one scoring identically or near-identically
  against the same neighbour set as its counterpart. That pattern suggests a usable heuristic:
  **two Artist nodes with a very similar name string AND a very similar (or identical)
  similarity-index profile/score against the same third parties are plausible candidates for
  being the same real person under different name forms** — a cheap, structural cross-check
  that doesn't require an external authority lookup (ULAN/Wikidata), unlike doc 08 §7a's
  existing reconciliation approach. Not designed, not tested against false-positive rate (two
  genuinely different artists with coincidentally similar names and similar coarse profiles
  would look the same), and not connected to any actual merge workflow — purely an observation
  worth a real investigation later, not a decided approach.

---

## Decision extension (2026-08-26): wiring these signals live into `query_ackg` and the Stage 2a loop

### Context for this extension

A real, backtest-grounded question prompted this: standing back from the prototyping above,
where is the ACKG actually resolving attribution issues from Stage 1's evidence? A survey of
all 13 completed backtests (`tests/backtest/output/`) found a genuine, concrete answer — 9 of
13 cite explicit ACKG evidence in their top candidate's rationale, most strikingly
[A0777_1](../../tests/backtest/output/A0777_1/result.json), where the appraiser's own claimed
attribution (Agathe Sorel) was overridden by ACKG population evidence (`query_ackg` returning
Paul Gauguin, supportCount=4, explicitly citing the same title independently) — but the same
survey found real cases where it's inert (zero graph coverage, [A0777_3](../../tests/backtest/output/A0777_3/result.json))
or simply unneeded (an artist-specific catalogue-raisonné number already settles it,
[A0785_1](../../tests/backtest/output/A0785_1/result.json)). The value is real but partial —
which is what prompted the request this extension responds to: use the graph-analytics work
above not just as a richer per-call signal (this ADR's original Decision 1), but specifically
to cut down the **wasted round-trip pattern** the same survey's earlier session work already
measured (`callClaudeWithAckgTool`, 132.4s–258.0s per Stage 2a call, 2–4 rounds, a meaningful
fraction returning zero candidates and re-querying with loosened filters to find that out).

A live-code audit (`src/appraisal/knowledge_graph/`, `src/appraisal/appraiser.ts:781-880`,
`src/appraisal/routing.ts`) found the real constraints this design has to work within, none of
which were visible from the ADR text alone:

- **`query_ackg` has no `artistName` parameter at all today** — it is a population-discovery
  query (technique/period/paper/region/subject → ranked candidates), never a point-lookup for a
  specific named artist. A per-artist "coverage" signal needs a genuinely new input, not an
  enrichment of an existing one.
- **The tool-loop has exactly two exit paths**: the model spontaneously doesn't call
  `query_ackg` again, or it hits `MAX_ROUNDS=4` (`appraiser.ts:822`). There is no programmatic
  early-exit today — every round is the model's own judgement call, made from whatever
  `formatAckgResultForClaude()`'s text summary told it last round.
- **`matchBasis`, `evidenceCentrality`, and every other signal this ADR named are unimplemented
  in live code** — confirmed via a full-repo grep returning zero `.ts` hits outside this
  document. This extension is real greenfield wiring, not a small parameter tweak.
- **Four confirmed live identity-duplication cases** (Frink, Zoran Mušič, Henry Moore, Le
  Corbusier — all found this session purely as a side effect of running similarity queries)
  directly threaten this design's correctness: a duplicated Artist node means real evidence is
  silently split across two nodes, understating `evidenceCentrality` for exactly the artists
  most likely to matter. This was a curiosity while the similarity index was just a prototype;
  it becomes a real accuracy risk the moment its output feeds a live triage decision.

### Correction (2026-08-26, same day): artist-level similarity is the wrong grain

The design below originally proposed an artist-to-artist similarity index (the same one
prototyped above — `gds_prototype.py`'s Artist-feature bipartite graph, aggregating one
combined technique/paper/subject/genre/period/region profile per artist across their whole
output). That is a real design error, caught in review, not a refinement: an artist's career is
not one style. Trevelyan's early etchings and any later screenprint experiments are not
meaningfully "similar to each other" just because one person made both — collapsing a whole
career into one aggregate profile can make two artists look alike (or unlike) for reasons that
have nothing to do with any actual comparable pair of works. **The Trevelyan/Villon/Sorel
results explored earlier in this session should be read with that caveat retroactively
attached**: "these two careers overlap in aggregate feature space," not "here is a specific work
by one that resembles a specific work by the other."

The corrected grain is **work-level**: the actual claim worth checking is "artist A produced
specific works using the same technique/subject/paper as specific works by artist B" —
`ConceptualWork` (or `Impression`, if paper/technique resolution needs to be per-edition rather
than per-work), never `Artist`, is the node that should be compared.

This has a large, welcome side effect: **it removes the need for a precomputed GDS similarity
index for this signal entirely.** At the artist level, similarity had to be precomputed because
comparing ~5,000 aggregate profiles pairwise isn't a live-query operation. At the work level,
Stage 1 has *already extracted* the specific work's technique/paper/subject/period values —
there is no discovery problem to solve with an embedding or Jaccard algorithm, only a query
problem: find other real works sharing some of those exact, already-known values, ranked by how
many dimensions overlap. That is a plain Cypher query, not a GDS session — simpler, fully
transparent (it can say *which* dimensions matched and which didn't, rather than emitting an
opaque score), and immune to the staleness/refresh-cadence problem a precomputed index carries.

`Artist.evidenceCentrality` (Decision 1's other half — "how much overall market/institutional
presence does this artist have") is **unaffected by this correction** — a career-wide market
footprint is legitimately a whole-career aggregate, unlike "what does this artist's work look
like." That signal stays artist-level and still needs offline GDS precompute, for the reasons
already given.

### Decision (revised)

**1. Two signals now, not three — and only one still needs GDS.**

- **Coverage** (unchanged from the initial pass): a cheap live `COUNT` alongside the existing
  Cypher `query.ts:22-43`, using loosened matches (technique family, decade bucket, no
  subject/paper constraint). No precomputation, no staleness risk.
- **Named-artist evidence-strength** (unchanged): `Artist.evidenceCentrality`, precomputed
  offline via GDS weighted degree centrality, read cheaply at query time.
- ~~Artist similarity~~ **replaced by comparable-works matching**: a live Cypher query at the
  `ConceptualWork` level — given the technique/paper/subject/period values Stage 1 already
  extracted for the work under investigation, find other real works sharing some of them,
  ranked by dimension-overlap count (ties broken by `supportCount`-style population weight).
  No precompute, no GDS session, no `SIMILAR_TO` edges, no K-value to tune.

**2. `query_ackg` contract change** (`src/appraisal/knowledge_graph/types.ts`,
`src/appraisal/appraiser.ts:735-746`) — revised from the initial pass:

```
Input (new, optional): artistName?: string   — Stage 1b's hypothesis, when it has one

Output (new, per call, not per-candidate):
  coverageNote: {
    broadenedSupportCount: number,        // live count, loosened filters
    interpretation: "populated" | "thin" | "empty"
  }

Output (new, only when artistName given):
  namedArtistCoverage: {
    resolved: boolean,                    // false = no matching Artist node found at all —
                                           // must stay distinguishable from "resolved but
                                           // evidenceCentrality is genuinely low", or a name-
                                           // matching miss looks identical to a real evidence
                                           // gap and the model draws the wrong conclusion
    evidenceCentrality: number | null,
    evidenceCentralityPercentile: number | null,
    analyticsAsOf: string,                // ISO date — staleness must be visible, never silent
  } | null

Output (new, fallback when exact results are thin/empty): live-queried, not precomputed
  comparableWorks: {
    workTitle: string,
    artistName: string,
    matchedDimensions: ("technique" | "paper" | "subject" | "period")[],   // transparent,
                                                                            // not an opaque score
    unmatchedDimensions: ("technique" | "paper" | "subject" | "period")[],
    matchType: "partial",               // never conflated with an exact-filter AckgCandidate
  }[]
```

Realizes this ADR's original `AckgCandidate`/`matchBasis` intent (Decision 1a/2), but as an
explicit matched/unmatched dimension list rather than a single similarity score — more
transparent, and correct at the work-level grain rather than the artist-level grain the
original prose implied.

**3. Round-reduction mechanism: unchanged in spirit, simpler in practice.** Because
`comparableWorks` is now computed in the same live Cypher pass as the exact-match query (no
separate GDS round-trip), the exact-match candidates and the partial-match fallback can return
together in **one** `query_ackg` call instead of needing a second round to discover the exact
match was empty. `formatAckgResultForClaude()` (`appraiser.ts:749-766`) still gets the
`"thin"`/`"empty"` nudge text from the initial design, now paired with the actual comparable
works it found in the same response — a hard "coverage is low, stop" auto-terminate rule is
still rejected for the same reason as before (A0777_9's legitimate second-candidate
investigation), but the model now has both the low-coverage signal *and* a concrete alternative
to investigate in a single round, which is where the real round-reduction comes from.

**4. Offline precompute pipeline — narrowed.** `knowledge_graph/refresh_analytics.py` now only
needs to handle `Artist.evidenceCentrality` / `evidenceCentralityPercentile` /
`analyticsComputedAt` (plain `SET`, idempotent). The `Artist -[:SIMILAR_TO]-> Artist` edge
proposal from the initial pass is dropped for this use case — it solved a problem
(artist-to-artist discovery) that no longer exists once the comparison moved to the work level.
It may still be worth building someday for a genuinely different use case (e.g. a "browse
similar artists" feature, unrelated to triage), but that would be its own decision, not a
dependency of this one.

**5. `matchType` discipline must be a type-level guard, not a prompt instruction.**
`routing.ts`'s `hasWorkLevelMatch`/`classifyTriageOutcome` must be changed so a `matchType:
"partial"` comparable-work can never count toward `ackgSupportCount`-style promotion to Scenario
1 (`ConfirmedClean`) — enforced in code, not left to a prompt line, for the same reason as
before: prompt instructions erode silently under later edits.

**6. Prior-appraisal fast-path — a bigger, separately-motivated mechanism, quantified against
real data.** Everything above (Decisions 1-5) makes Stage 2a's existing research loop more
efficient per round. This is a different kind of win: **detect that a lot is a repeat
consignment — the same edition Roseberys has already sold before — and skip most of the
pipeline for it entirely**, rather than just shortening the loop that re-derives the same
attribution from scratch.

*The real number behind this*: a live query against the actual Roseberys ingest
(`institutionName: 'Roseberys London'`, 12,675 lots across 43 sales) found **1,529 distinct
works (3,905 lots, 31%)** recur across more than one Roseberys sale — using artist + exact
title as the candidate match, **technique agreement as a hard filter** (technique doesn't carry
natural measurement noise, so a mismatch reliably means two different works — e.g. Sam Francis's
"Untitled" showing up as both Aquatint and Lithograph), and **dimension agreement as a soft
filter** (majority-of-pairs >20% size disagreement only — a strict "any disagreement rejects"
version was tried first and wrongly threw out real single editions, e.g. L.S. Lowry's popular
reprints, whose recorded sheet dimensions vary a few cm across catalogue entries from different
years, almost certainly measurement/trimming inconsistency between cataloguers rather than
different works). Bare "Untitled" titles were excluded outright as an unreliable match key. One
real, useful side-catch from this pass: Jonas Wood's "Large Shelf Still Life" has 18 of 19
recorded dimension entries clustered tightly around 58.5×58.5cm and one recorded as
`(59.0, 589.0)` — an obvious data-entry typo, not a different size, worth a future data-cleaning
pass but not fixed here.

*The business case, back-of-envelope*: if a confirmed-repeat lot can be processed at roughly
50% of normal consignment speed — skipping fresh attribution/tradition research and Stage 2b's
catalogue-raisonné deep-dive in favour of confirming it's genuinely the same edition (not a
different impression sharing title/technique) plus a condition/signature check and refreshed
comps — the arithmetic is `0.31 incidence × 0.50 speed-up ≈ 15.5%` reduction in total pipeline
time across the whole book, holding the other 69% of lots unchanged. A real, quantified
efficiency case, not a qualitative one like Decisions 1-5.

*Why this has to run before the expensive stages, not inside Stage 2a's loop*: unlike
`comparableWorks` (Decision 2), which is a mid-loop lookup, prior-appraisal detection is a
pre-flight gate. It needs Stage 1's already-extracted technique/dimensions to check against
prior Roseberys sales *before* deciding whether the lot takes the full pipeline or a lightweight
"reconfirm and refresh" path — arriving mid-loop is too late to save the cost.

*Why the confidence bar here has to be stricter than Decision 2's exploratory heuristic*: a
`comparableWorks` false positive just means the model sees a slightly-wrong suggestion it can
weigh and discard, same as any other piece of evidence. A prior-appraisal-fast-path false
positive means **skipping real verification work on a lot that actually needed it** — the Jonas
Wood typo is a concrete reminder that this data has real noise, and the technique+dimension
heuristic that's good enough for a back-of-envelope estimate is not automatically good enough to
gate which lots get full scrutiny. This needs a real precision/recall check against known cases
before it gates anything, not just the same heuristic ported over as-is.

### Proposed sequencing (revised again)

1. `query_ackg` contract change (Decision 2) — the comparable-works half needs no precompute at
   all now, so it can ship without waiting on any offline pipeline.
2. `refresh_analytics.py` for `Artist.evidenceCentrality` only — narrower scope than the initial
   pass, still foundational for the `namedArtistCoverage` half of Decision 2.
3. The loop-nudge text change (Decision 3) — last of the Decision 1-5 work, same reasoning as
   before: it's the piece that touches live model behaviour on real appraisals.
4. **Prior-appraisal fast-path (Decision 6) — sequenced separately, not before the above**: (a)
   validate the technique+dimension matching heuristic's precision against a real sample of
   confirmed-same-edition vs. confirmed-different-work pairs, since the confidence bar here is
   higher than Decision 2's; (b) only then design the actual pre-flight gate and the lightweight
   "reconfirm and refresh" path it routes into. Higher potential payoff (15.5% back-of-envelope)
   than Decisions 1-5 combined, but also the least validated — should not jump the queue ahead
   of the precision check just because the number is bigger.
5. **Still not sequenced, still a strong recommendation, not a decision**: some identity-dedup
   pass before `namedArtistCoverage` ships, since `evidenceCentrality` (the one signal that
   remains artist-level) is exactly what a duplicated Artist node silently corrupts.

### Accepted limitations / open risks (revised)

- **Identity duplication still corrupts `evidenceCentrality`** — this risk is now scoped to
  exactly one signal instead of two, since `comparableWorks` no longer depends on artist
  identity resolution at all (it compares works, and a duplicated `ConceptualWork` record is a
  different, less pressing data-quality question than a duplicated `Artist` node).
- **`coverageNote`'s `"thin"`/`"empty"` thresholds and the dimension-overlap ranking weights are
  first guesses** — needs real backtest calibration, same status as every other threshold this
  ADR has introduced.
- **The nudge-text approach still depends on the model reading and acting on it** — unchanged
  from the initial pass; needs a real before/after round-count comparison to confirm it works,
  not just a design argument.
- **The prior-appraisal fast-path's 31%/15.5% figures are a real measurement, but of a heuristic,
  not of ground truth** — no confirmed-duplicate labels exist to validate precision/recall
  against; the true false-positive rate on "gate full verification off" decisions is unknown
  until Decision 6's sequencing step 4(a) is actually done.

### Not addressed by this extension (revised)

- The exact `"populated"`/`"thin"`/`"empty"` thresholds and how many overlapping dimensions
  should count as a "comparable" work worth surfacing — left to real calibration.
- The identity-dedup pass itself — still flagged as a precondition worth strongly considering
  for `evidenceCentrality`, not designed or scheduled.
- Any change to `MAX_ROUNDS` itself, or to the loop's round-based structure — unchanged, per
  this ADR's original Decision 5; only what a round's response *contains* changes.
- Whether a genuinely different future feature (browsing/discovering similar artists outside
  the triage path) would still want the artist-level `SIMILAR_TO` mechanism dropped above — not
  ruled out, just decoupled from this decision.
- The prior-appraisal fast-path's actual pre-flight gate design, its "reconfirm and refresh"
  lightweight path, and its precision/recall validation — flagged as the next real design step
  in Decision 6, not designed here.
