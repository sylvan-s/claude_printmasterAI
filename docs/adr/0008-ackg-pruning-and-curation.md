# ADR-0008: ACKG pruning and curation — the ACKG Curator

**Date:** 2026-08-25
**Status:** Proposed — not started.

Formalizes a process that was, until now, done entirely by hand and ad hoc during this
session's Tate ingestion (Met zero-metadata prune, Tate generic-"School" exclusion, the
per-artist source-layer check that found Turner, the dead-`DigitalImage`-node prune). Also
depends in part on [ADR-0007](0007-ackg-research-writeback-learning-loop.md)'s write-back
existing before its best version can run — see Decision 4.

---

## Context

**AuraDB Free's 200,000-node ceiling is a hard, recurring constraint, not a one-time
problem.** This session hit it directly during Tate ingestion and resolved it through a
sequence of manual, one-off decisions: pruning Met's zero-artist/zero-metadata prints,
excluding Tate's generic period/nationality placeholders, deprioritizing and then fully
deleting J.M.W. Turner's 908 records once his existing coverage was found to be 100%
single-source and saturated, and separately deleting 8,942 `DigitalImage` nodes once their
`sourceUrl` values were confirmed dead. [ADR-0007](0007-ackg-research-writeback-learning-loop.md)
adds a new, ongoing growth source ("PrintMaster Research") on top of the existing bulk-ingest
sources — meaning node growth doesn't stop once Tate is fully loaded; it continues
indefinitely as the pipeline is used. Without a formal process, every future headroom crunch
repeats this session's manual, error-prone cycle.

**Not everything worth removing is the same kind of problem, and treating them identically
is the actual risk.** Three genuinely different categories showed up this session:

1. **Never had value** — garbage that slipped past ingestion filters (no artist, no
   metadata, placeholder entities like "British (?) School").
2. **Had value, decayed** — Tate's `DigitalImage.sourceUrl` values, real when ingested,
   dead once Tate restructured its site.
3. **Has value, but is the lowest value given a hard ceiling** — Turner's records were
   correct, real, institutionally sourced, and would be worth keeping in an unconstrained
   graph. They were the worst *use of scarce budget* specifically because his own coverage
   was already 100% single-source and saturated — a genuinely relative, opportunity-cost
   judgement, not an absolute defect.

Categories 1 and 2 are detectable by deterministic checks alone. Category 3 requires
judgement about relative value that a threshold alone can't fully capture. Building one
undifferentiated "pruning agent" that handles all three the same way would be either
dangerously trigger-happy (deleting category-3 nodes on a raw usage number, the same mistake
this ADR's own author made twice this session estimating headroom from a single sample) or
uselessly cautious (an LLM re-litigating category-1 garbage that a linter-equivalent check
could catch instantly).

**A concrete, already-made mistake this design should structurally prevent:** during Tate
ingestion, headroom was estimated by extrapolating from one observed chunk's node-cost, and
that estimate was wrong twice — once by thousands of nodes, once by missing that headroom
was already exhausted before a run even started. Any formal tool built here must compute
exact before/after counts from a live query before executing a prune, never extrapolate.

---

## Decision

### 1. Tier 1 — automatic deterministic sweeps, no agent involved

Scheduled, code-only checks equivalent to a linter, run on a cadence (Decision 5), not
triggered by any model judgement:

- **Dead-link checker**: periodically re-verify `DigitalImage.sourceUrl` reachability
  (the exact check that found Tate's 8,942 dead nodes this session); auto-flag anything
  failing N consecutive checks for Tier-1 removal.
- **Orphan/zero-metadata checker**: nodes with no meaningful relationships or missing core
  identity fields, re-run periodically against already-loaded data — the same filters
  already applied at ingest time, since not everything that should be caught there
  necessarily is on the first pass.
- **Identity-fragmentation sweep**: the still-outstanding doc09 §3.1 fix (Artist nodes
  split across honorific/spelling variants, e.g. Lowry across 7 nodes). This is a pruning
  function too, via merge rather than delete, and is also a hard prerequisite for
  ADR-0007's write-back per that ADR's own Decision 5.

### 2. Tier 2 — value-scoring, still no agent, produces a ranked shortlist only

Formalizes this session's ad hoc `rerank_tate.py` script (written, used once to find Turner,
then deleted — a known gap already logged) into a real, reusable, versioned tool. For every
artist/subgraph, compute:

- **Source-layer diversity** — institutional vs. auction-history split, the metric that
  correctly identified Turner's saturation.
- **Attribute-slice saturation** — technique × decade coverage already established this
  session as the real test of marginal value, not raw support-count totals.
- **Usage/outcome signal** (once available — see Decision 4) — how often `query_ackg`
  actually returns a given node, and separately, how often it was part of an attribution
  Stage 2b actually settled on (`attributionLevel: definitive | probable`) versus always
  being an also-ran that never contributed to a real outcome.

Output is a ranked table with the numbers shown — exactly the format used this session for
the Tate remainder — never an automatic deletion.

### 3. Tier 3 — the ACKG Curator agent, recommends, never executes directly

A new agent, named to match the existing stage-agent convention (VEA/ATA/ASA/AIA), reviews
Tier 2's shortlist and reasons about context a raw number can't capture — e.g. recognizing
that a low-hit-rate artist is one of the graph's only non-Western entries (a documented gap
per ADR-0003's Getty/ULAN coverage finding) and recommending *against* pruning despite the
low number, versus recommending cuts to genuinely redundant, oversaturated coverage. Its
output is a **written recommendation with stated rationale** — the same shape as this
session's actual Turner discussion (options proposed, quantified precisely, human decides).
It never executes a delete itself; a human approval step (Decision 4) sits between
recommendation and action, structurally, not as a courtesy.

### 4. Safety measures, built in from the start rather than learned the hard way

- **Export before delete.** Every prune batch writes the full to-be-deleted subgraph (nodes,
  properties, relationships) to a versioned JSON file before execution — the same discipline
  already applied to excluded ingestion rows (`roseberys_excluded_rows.csv`). AuraDB has no
  undo; a bad prune should be a re-ingest away from fixed, never gone.
- **Exact quantification, never extrapolation.** Every proposed prune states a real,
  freshly-queried before/after node count, not an estimate from a sample chunk — directly
  fixing the mistake made twice this session.
- **Human approval required for every Tier 3 action.** The Curator's recommendation is not
  self-executing regardless of confidence.

### 5. Cadence: headroom-triggered, never inline with a live appraisal

Tier 1 runs on a schedule or when headroom drops below a threshold (e.g. 15,000 nodes
remaining). Tier 3's agent review triggers at a tighter threshold (e.g. 5,000) or on a fixed
lower-frequency schedule (e.g. quarterly), whichever comes first. None of this runs as part
of Stage 1–3 of a live appraisal — it is offline maintenance, the same category of work as
the Python `knowledge_graph/*_ingest.py` scripts, not a pipeline stage.

---

## Consequences

**Good:**
- Replaces a manual, error-prone, one-off process (this session's actual experience) with a
  repeatable one that structurally prevents the specific mistake already made twice
  (headroom estimated from extrapolation rather than a real query).
- Keeps judgement scoped to where it's actually needed (Tier 3's relative-value calls) rather
  than spending LLM review on category-1/2 problems a deterministic check resolves instantly.
- Every action is reversible via the export step and auditable via the Curator's stated
  rationale — consistent with ADR-0006/0007's shared principle of keeping deterministic code
  in charge of anything that's actually just arithmetic, and reserving model judgement for
  genuine relative-value tradeoffs.

**Accepted limitations / open risks:**
- **Tier 2's best available signal today is the static source-diversity heuristic** — the
  materially better usage/outcome signal depends on ADR-0007's write-back and query logging
  existing first. This ADR should ship Tiers 1–2 on the static heuristic now and upgrade
  Tier 2's scoring once ADR-0007 lands, rather than waiting for both together.
- **The Curator's judgement is still bounded by what it's told about known limitations**
  (e.g. the ULAN coverage gap) — if a future coverage gap isn't documented anywhere the
  Curator can see it, it has no way to weigh against pruning something that's actually
  valuable for an undocumented reason. This argues for keeping ADRs and doc09's known-gap
  sections current, not a flaw unique to this design.
- **Threshold values** (headroom triggers, N-consecutive-failures for dead-link flagging)
  are illustrative here, not tuned — need real operating experience to set properly.
- **This adds a new, standing maintenance surface** (schedules, a shortlist tool, an agent
  definition) to a project that has, so far, run its knowledge-graph work as one-off scripts
  per session — a real increase in operational surface area worth weighing against how often
  headroom crunches actually recur in practice once ADR-0007's organic growth is the norm.

---

## Not addressed by this ADR

- The exact usage/outcome telemetry schema `query_ackg` would need to log for Tier 2's
  upgraded scoring — depends on ADR-0007 shipping first.
- Where the Curator agent's definition/prompt actually lives (a new file under
  `knowledge_graph/`, matching the Python toolkit's existing pattern, is the likely home
  given this is offline maintenance rather than live pipeline code, but not decided here).
- Numerical tuning of any threshold named above.
- What happens if AuraDB is ever upgraded to a paid tier (judged too expensive for this
  personal project as of 2026-08-25) — this ADR assumes the Free tier's ceiling remains the
  operating constraint; a paid upgrade would change the urgency but not necessarily the value
  of keeping the graph clean regardless.
