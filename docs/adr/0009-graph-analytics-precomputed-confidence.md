# ADR-0009: Precomputed graph-analytics confidence signals for `query_ackg`

**Date:** 2026-08-26
**Status:** Proposed — not started.

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
