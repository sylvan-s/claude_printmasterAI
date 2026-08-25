# ADR-0007: ACKG research write-back — "PrintMaster Research" as a fifth source layer

**Date:** 2026-08-25
**Status:** Proposed — not started.

Builds directly on ADR-0006's core principle — routing decisions move from LLM free-text
judgement to deterministic code operating on already-structured output — and applies the
same principle to a new problem: today, everything Stage 2b's specialist discovers via live
web research is used once, for one appraisal, then discarded. This ADR makes that research
durable and reusable, so the ACKG accumulates real coverage from the pipeline's own use over
time rather than only from periodic bulk ingests.

---

## Context

**The ACKG currently has four source layers, all populated by offline bulk ingestion:**
Met Open Access, Roseberys, Forum Auctions, and Tate Collection (`knowledge_graph/*_ingest.py`).
Stage 2b's specialist agent (`ATTRIBUTION_RESEARCH_SYSTEM_PROMPT`) independently does real
research every time it runs — `web_search`, `lookup_museum_collections`, catalogue raisonné
cross-referencing, auction comp collection — and produces a well-structured `ASA-1.0` JSON
result. None of that research currently reaches the graph. The same artist researched from
scratch in one appraisal gets researched from scratch again in the next, and `query_ackg`
(ADR-0003 item 4) can only ever be as good as the last bulk ingest, regardless of how much
the live pipeline has independently learned in between.

**No existing `sourceType` fits what this needs to be.** Doc08 §2's `SourceRecord.sourceType`
enum is `auction | institutional | dealer_listing | online_marketplace | specialist_opinion |
direct_inspection`. `specialist_opinion` looks closest but is the wrong shape for this: it's
scoped to a human appraiser's one-off hypothesis about *the specific item being appraised*
(`statusFlag: hypothesis | documented_fact`), not an *agent's* citable research finding about
an artist or work that should be reusable across unrelated future appraisals.

**ADR-0006 already established the operating principle this ADR extends.** ADR-0006 replaced
`routingDecision`'s LLM-declared free text with a deterministic function reading
`TriageResult`'s already-structured fields, specifically to fix the failure mode where an LLM
invents something plausible-sounding with nothing forcing it to correspond to reality
(ADR-0005 finding #8). The identical failure mode applies here: if Stage 2b's LLM decided, in
the moment, what was "worth writing" to the graph, there would be no way to audit why a given
fact made it in, and no structural guard against a hallucinated or misread web result being
written as if it were verified population data.

**A real, already-logged risk this makes materially worse if not addressed first.** Doc09
§3.1 documents an unresolved, known issue: `Artist` nodes fragmenting across honorific/name
variants (Laurence Stephen Lowry split across 7 nodes before being found by accident). A new
write path into the graph is another chance to create a duplicate node for an artist already
present — this ADR should not ship without that entity-resolution gap being closed first, not
deferred again.

---

## Decision

### 1. Write-back is deterministic post-processing, not a tool call the LLM decides to use

A new function, `contributeResearchToAckg(asaResult: AttributionResearchResult, triageResult: TriageResult)`,
runs automatically after every `runStage2bSpecialist` call completes — no new tool exposed to
the specialist agent, no LLM judgement about whether a given finding is "worth" recording.
Code applies an explicit quality gate to the already-structured `ASA-1.0` output:

- `attributionConclusion` facts (artist, work title, date, technique) are only written when
  `attributionLevel` is `definitive` or `probable` — never `possible` / `school_of` /
  `tradition_only` / `unattributed`.
- `catalogueRaisonne` is only written when `referenceFound: true`.
- Each `auctionComps[]` entry is only written when it carries a real `saleDate` and
  `auctionHouse` — the "couldn't find comps" empty-array case writes nothing.

Because this operates on `ASA-1.0`'s output structure rather than on a live tool call during
generation, it is **model-agnostic** — it behaves identically whether Stage 2b ran on Claude
or Gemini, which a live-tool-call design would not have been.

### 2. New `sourceType: "agent_research"`, kept structurally separate from every existing type

```
SourceRecord {
  sourceType: "agent_research",
  institutionName: "PrintMaster Research",   -- same field auction/institutional records
                                              -- already overload for a display name
  citationUrl: string,                       -- the actual web_search/lookup_museum_collections
                                              -- result URL the fact traces to — required,
                                              -- not optional (see Decision 3)
  originatingAppraisalId: string,            -- so a bad record can be traced back and purged
  reliabilityTier: "agent_derived"           -- new value, deliberately ranked below every
                                              -- existing tier
}
```

Structurally this is "a fifth source, at the same level as Roseberys/Forum/Met/Tate" exactly
as asked — filterable and queryable the same way — but its `reliabilityTier` and a dedicated
support-count bucket (Decision 4) keep it from being silently treated as equivalent evidence.

### 3. The citation requirement is a hard gate, not a formality

A finding is only written if `citationUrl` resolves to a real result the specialist's own
`web_search`/`lookup_museum_collections` call actually returned in that session — never a
bare LLM assertion with nothing behind it. This is the load-bearing distinction between "the
agent found a real record and we're caching it for reuse" and "the agent said something
plausible and we're now treating it as population data." No `citationUrl` means no write,
full stop.

### 4. `query_ackg` gets a third, segregated support count — never pooled with the other two

```
RETURN ..., institutionalSupportCount, auctionSupportCount, agentResearchSupportCount, ...
```

ADR-0003's premise was that a support count reflects real, checkable population data rather
than an unexaminable prior. Silently blending `agent_research` counts into
`institutionalSupportCount`/`auctionSupportCount` would quietly erode that guarantee the
first time a bad record slips through. Consumers (Stage 2a's fusion logic, ADR-0006's
scenario classifier) must be able to see the three counts separately and weight accordingly.

**Explicit rule for ADR-0006's classifier:** `agent_research`-backed support alone must never
be sufficient to reach Scenario 1 ("confirmed, clean") — it can corroborate an existing
institutional/auction-backed candidate, but cannot single-handedly manufacture confidence.
This is a rule to state in code, not leave as an implicit assumption.

### 5. Prerequisite: fix doc09 §3.1's honorific-fragmentation issue before this ships

This write-back must be a **consumer of real entity resolution**, not another ad hoc
merge-by-exact-name path layered on top of an already-known-fragile identity system. The
suggested approach doc09 already logged — group `Artist` nodes by a normalized surname+given-
name key, stripping ALL-CAPS trailing tokens generically rather than a fixed postnominal
list — should be built and run once as cleanup *and* reused as the matching logic this
write-back calls before ever creating a new `Artist` node. Shipping the write-back first and
the entity-resolution fix later would make the existing problem worse at exactly the moment
new data volume starts flowing in.

---

## Consequences

**Good:**
- The ACKG compounds in value with pipeline usage instead of only growing via periodic bulk
  ingests — a case Stage 2b had to research from scratch once becomes something Stage 2a can
  answer directly from `query_ackg` next time, for that artist or a stylistically similar one.
- Fully auditable: every `agent_research` record traces to a real `citationUrl` and an
  `originatingAppraisalId`, so a bad record can be found and purged, unlike an LLM's
  in-context research which leaves no durable trail today.
- Model-agnostic by construction, since it operates on structured JSON output rather than a
  live tool call — no Gemini-parity gap to solve, unlike `query_ackg` itself (ADR-0003) which
  remains Claude-only.
- Gives a real, measurable test of whether this is working: track the fraction of
  `query_ackg` hits that are `agent_research`-sourced over time, and whether Scenario 4
  ("movement only, no candidates" — ADR-0006) rate actually declines as the corpus grows.

**Accepted limitations / open risks:**
- **Hallucination-compounding is the central risk of this entire ADR, not a footnote.** Even
  with the citation gate, a misread or partially-correct web result could still be written
  as if fully verified. The segregated support count (Decision 4) limits the blast radius but
  doesn't eliminate the risk — this needs monitoring in practice, not a one-time design
  review.
- **Depends on a prerequisite that hasn't been built yet** (Decision 5) — this ADR describes
  the write-back design but should not be implemented before doc09 §3.1's entity-resolution
  sweep exists and is reused as this feature's matching logic.
- **Growth rate is organic, not bulk**, so AuraDB Free's 200,000-node ceiling (currently
  9,775 headroom after this session's Tate/Turner/image-node work) is a much slower-moving
  concern here than it was for institutional bulk ingests — but not zero, and worth revisiting
  once real usage volume exists rather than assumed negligible indefinitely.
- **`reliabilityTier: "agent_derived"`'s exact weighting relative to `dealer_listing`/
  `online_marketplace`/`specialist_opinion`** isn't specified numerically here — needs a real
  decision (and ideally a backtest) once this exists, not values invented in this document.
- **Deduplication against facts already in the graph is assumed, not solved.** If Stage 2b's
  research re-confirms something an institutional/auction source already documents, the
  right behaviour is strengthening/corroborating the existing record, not creating a parallel
  one — this depends on the same entity-resolution work as Decision 5, extended to
  `ConceptualWork`/`EditionRun` matching, not just `Artist`.

---

## Not addressed by this ADR

- The exact entity-resolution algorithm for doc09 §3.1's fragmentation sweep — a real,
  separate piece of work this ADR depends on but doesn't design.
- Numerical weighting of `reliabilityTier: "agent_derived"` in any downstream scoring formula.
- Whether `agent_research` findings should ever be "promoted" to a higher trust tier after
  independent corroboration by a later institutional/auction source — a plausible future
  refinement, not designed here.
- Any change to `web_search`/`lookup_museum_collections` themselves, or to Stage 2b's research
  process (STEPs 1–8) — this ADR only adds what happens to the output after Stage 2b returns.
