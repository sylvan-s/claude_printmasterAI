# ADR-0006: Deterministic Stage 2a→2b routing, six triage scenarios, and Skeptic Agent integration

**Date:** 2026-08-25
**Status:** Proposed — not started.

Supersedes the sequencing decision made during ADR-0003's implementation to keep Stage 2b as
a single undifferentiated process ("we don't really have many specialist agents to go down
different routes for 2b... just have a single 2b deep dive process"). That was a deliberate
choice to unblock Stage 2a work without designing both stages at once — not a permanent
stance. With ADR-0003 items 2 and 4 now shipped (Stage 1b routed into Stage 2a; the
`query_ackg` tool live), Stage 2a produces real, structured, checkable evidence. This ADR is
the return to Stage 2b that move deliberately deferred.

Also resolves GitHub Issue #7 ("Skeptic agent: challenge Stage 2b attribution before
valuation") by folding it into Stage 2b rather than building it as a separate stage — see
Decision 4. Issue #7 should be closed with a reference to this ADR once implemented.

---

## Context

**Stage 2a can now say more than it used to, but Stage 2b treats every output identically.**
`TriageResult` already carries real, differentiated signal — `candidateArtists[]` (with
`ackgSupportCount`/`ackgProvenanceTags` from ADR-0003 item 4), `evidenceCorroboration`
(`stage1bAgreement`/`ackgAgreement`/`conflicts`, from item 2's fusion logic), `riskFlags`
(`forgeryRisk`/`misattributionRisk`/`authenticationBodyExists`/etc.), and
`traditionIdentification.traditionConfidence`. A confidently-resolved single artist with
clean corroboration and a confidently-resolved single artist with an active forgery-risk flag
produce structurally different `TriageResult` shapes today — but `ATTRIBUTION_RESEARCH_SYSTEM_PROMPT`
runs the identical fixed 8-step process against both, with only one minor in-process shortcut
("if the top candidate is confirmed after the first search, skip to comps").

**A separate, standing problem this ADR also addresses:** ADR-0005 finding #8 found
`routingDecision.specialistConfig` — an LLM-generated free-text field — named a config file
that doesn't exist in the codebase in **4 out of 4** real appraisals checked. `loadSpecialistConfig`
silently falls back to `general_print_fallback` every time. This isn't a coverage gap that
more config files would fix — it's the LLM inventing a plausible-sounding string with nothing
forcing it to check the string resolves to something real. The same failure mode would recur
for any new routing field left to the LLM's free-text judgement, including a naive version of
the scenario-routing this ADR proposes.

**The six scenarios discussed this session**, restated as the trigger conditions they
actually are:

| # | Scenario | Trigger (TriageResult fields) |
|---|---|---|
| 1 | Confirmed, clean | Top candidate probability high; `evidenceCorroboration` all-agree, `conflicts: []`; `riskFlags` all false; ACKG's `sampleWorks` plausibly match the specific piece |
| 2 | Confirmed artist, elevated authentication risk | Top candidate probability high, but `riskFlags.forgeryRisk`/`misattributionRisk`/`authenticationBodyExists` true |
| 3 | Artist confirmed, work unresolved | Top candidate probability high, but no work-level match in ACKG's returned `sampleWorks` |
| 4 | Movement/style only | `candidateArtists[]` empty or all low-probability; `ackgSupportCount` near-zero across the board (absence, not contradiction); `traditionIdentification` itself confident |
| 5 | Competing candidates | 2+ candidates with comparable probability, or `evidenceCorroboration.conflicts` non-empty (includes a human appraiser's own hypothesis being contradicted by physical evidence — the rule already stated in doc08) |
| 6 | Low signal everywhere | Thin/absent evidence across VEA, ACKG, *and* Stage 1b — including `traditionIdentification.traditionConfidence` itself being low |

**The open design question from the earlier discussion is now resolved by the user's own
steer, not left open:** routing should be decided by code applying explicit rules to
`TriageResult`'s structured fields, not by the LLM declaring which situation it thinks it's
in. Triage's job is literally to decide the route a patient takes — that's a protocol, not a
judgement call an individual clinician re-derives from scratch each time.

---

## Decision

### 1. Replace LLM-decided routing with a deterministic classifier

A new pure function, `classifyTriageOutcome(triage: TriageResult): RoutingPlan`, runs after
Stage 2a's LLM call returns — no model call, no prompt, fully unit-testable against fixture
`TriageResult` objects, fully logged (the boolean trace that produced a classification is
loggable in a way an LLM's internal rationale never was). It replaces what
`routingDecision.tier`/`specialistConfig`/`alternativeConfig` currently ask the LLM to
free-associate, and produces two independent outputs:

**a. Domain specialist config** (the existing axis — which databases/authentication
markers/known forgeries apply — made deterministic). Matched from
`traditionIdentification.primaryTradition` and `candidateArtists[0]?.artistName` against a
real registry of the specialist configs that actually exist on disk
(`ukiyo_e_edo_general`, `rembrandt_etchings`, `general_print_fallback` today), falling back
explicitly and loggably to `general_print_fallback` when nothing matches — never inventing a
name. **This directly fixes ADR-0005 finding #8** as a structural consequence, not a
separate patch: a config name that doesn't resolve to a real file becomes impossible to
produce, not just less likely.

**b. Scenario / task profile** (the new axis). One of the six scenarios above, computed by
explicit, ordered rules — order matters, because risk and contradiction must be checked
*before* a confident-looking match, not masked by one:

```
if riskFlags.forgeryRisk || riskFlags.misattributionRisk || riskFlags.authenticationBodyExists:
    → Scenario 2 (elevated authentication risk)
else if evidenceCorroboration.conflicts.length > 0 || countCompetitive(candidateArtists) >= 2:
    → Scenario 5 (competing candidates)
else if topCandidateProbability >= CONFIDENT_THRESHOLD && hasWorkLevelMatch(ackgResult):
    → Scenario 1 (confirmed, clean)
else if topCandidateProbability >= CONFIDENT_THRESHOLD:
    → Scenario 3 (artist confirmed, work unresolved)
else if traditionIdentification.traditionConfidence >= MOVEMENT_THRESHOLD:
    → Scenario 4 (movement only)
else:
    → Scenario 6 (low signal everywhere)
```

Thresholds are named constants in code, versioned and tunable independently of prompt
wording — not magic numbers buried in prose instructions to a model.

### 2. Scenarios map to a task profile injected into the existing Stage 2b prompt

Not a new agent or a new prompt file per scenario — that was already ruled out for good
reason (only 3 real domain configs exist; multi-agent routing is premature infrastructure).
Instead, `classifyTriageOutcome`'s scenario output selects a small, code-owned instruction
block — which of the existing 8 steps run at full depth, which are abbreviated, which are
skipped — injected into `ATTRIBUTION_RESEARCH_SYSTEM_PROMPT` alongside the domain
`specialistConfig` that's already injected today. The routing decision stays fully outside
the LLM; only the resulting task shape is expressed to it as an instruction.

| Scenario | Task profile |
|---|---|
| 1 — Confirmed, clean | Skip re-deriving identity. STEP 3 (pin exact work/edition) and STEP 7 (comps) are the deliverable. |
| 2 — Elevated authentication risk | STEP 4 (authentication markers) and STEP 5 (forgery/reprint risk) run at full adversarial depth — see Decision 4. Proactively set `physicalExaminationRecommended`. |
| 3 — Artist confirmed, work unresolved | STEP 3 becomes the real work (actually fetch/cross-reference the catalogue raisonné), not a check-box. STEP 6 (edition/state) is the main output. |
| 4 — Movement only | Flip from verify to generate: heavier web search, broader candidate generation. A final `attributionLevel: "tradition_only"`/`"school_of"` is a legitimate terminal state, not an escalation failure. |
| 5 — Competing candidates | Run STEP 4's marker analysis once per named candidate, comparatively — adversarial depth here too (Decision 4). Output must state which hypothesis won and why the other was ruled out. |
| 6 — Low signal everywhere | Don't burn search budget chasing a name. Establish the honest floor and set `humanEscalationRequired: true`. |

### 3. `routingDecision.tier` is retired as an LLM-declared field and derived instead

`tier: 1 | 2 | 3` predates ACKG grounding and already overlaps with what the scenario
classification now expresses more precisely. Rather than maintaining two parallel,
potentially-conflicting routing signals, `tier` becomes a derived, coarser view of the
scenario (e.g. 1 → light-touch, 3/4 → standard depth, 2/5/6 → heavy/escalate) — computed by
the same deterministic function, not asked of the LLM. Anything downstream currently reading
`routingDecision.tier` needs auditing before this ships (see Consequences).

### 4. Skeptic Agent (Issue #7) folded into Stage 2b, not built as a separate stage

Per explicit direction: the adversarial-challenge behaviour Issue #7 proposed — actively try
to falsify the leading hypothesis rather than only report supporting evidence — becomes
mandatory behaviour for STEP 4/5 specifically under **Scenario 2** (elevated authentication
risk) and **Scenario 5** (competing candidates): the two scenarios where a challenge-first
posture is the actual job, not wasted effort. Scenarios 1/3/4/6 keep the existing
confirmatory research posture — adversarially challenging a well-corroborated, low-value
item's obvious attribution has no payoff. This captures Issue #7's value inside Stage 2b's
existing latency/cost budget rather than adding a whole additional LLM stage between 2b and
3. Issue #7 should close with a reference to this ADR once implemented.

---

## Consequences

**Good:**
- `routingDecision` becomes fully deterministic, testable with zero LLM calls, and
  auditable — "why scenario 5" is a literal boolean trace against real field values, not a
  rationale string reverse-engineered from an LLM's free text.
- ADR-0005 finding #8 (specialist configs that don't exist) is fixed as a structural
  consequence of this change, not a separate patch applied on top.
- The Skeptic Agent's value is captured without a new Stage 2.5 LLM call — folded into
  Stage 2b's existing budget, targeted only at the two scenarios where it's actually needed.
- Issue #7 can close as resolved rather than sitting as open, separate future work.

**Accepted limitations / open risks:**
- **Deterministic rules can misclassify at the boundaries** — a `candidateProbability` of
  0.69 vs. a 0.70 threshold flips the scenario. This has the same brittleness any hand-tuned
  threshold has, and needs the same backtest-before-trust discipline ADR-0003 already
  called for, applied specifically to threshold tuning.
- **The classifier is only as good as the structured fields feeding it.** If Stage 2a's LLM
  populates `riskFlags`/`evidenceCorroboration` inconsistently, or defaults them to empty
  when unsure rather than genuinely assessed, the deterministic layer inherits that noise
  silently — confidently-routed garbage in, confidently-routed garbage out. Stage 2a's own
  reliability at honestly populating these fields hasn't been separately audited and should
  be, before this is trusted at volume.
- **Domain specialist-config coverage is still just 3 real files.** The deterministic
  matcher makes the fallback *visible* and *loggable* rather than silent, but doesn't create
  new domain coverage — building more real configs remains separate, valuable follow-up
  work, not solved here.
- **Folding Skeptic-Agent behaviour into Stage 2b's own call means the specialist may be
  auditing its own work in the same context** rather than a genuinely independent second
  pass with no sunk cost in the first hypothesis — plausibly weaker adversarial pressure
  than a truly separate agent. Worth watching in practice; if it doesn't produce real
  pushback, the fallback isn't necessarily a full separate stage — a second LLM round
  within Stage 2b (hypothesize, then challenge) is the more likely next step before
  reaching for a whole new stage.
- **`routingDecision.tier`'s retirement touches `TriageResult`'s schema** — anything
  downstream (UI report rendering, Stage 3, analytics) currently reading `tier` as an
  LLM-declared field needs auditing before this ships, not assumed unaffected.

---

## Not addressed by this ADR

- The exact threshold constants (`CONFIDENT_THRESHOLD`, `MOVEMENT_THRESHOLD`, what counts as
  a "competitive" second candidate) — these need real backtest data against known-attribution
  items, not values invented in a design doc.
- New or expanded domain specialist-config files beyond the existing 3 — separate follow-up,
  independent of this ADR's routing-layer change.
- Whether the Skeptic-Agent-in-2b behaviour should eventually split into its own LLM call
  within Stage 2b (a genuine two-round hypothesize-then-challenge pattern) rather than one
  combined call — an implementation decision for whoever builds this, informed by whether the
  single-call version shows real adversarial pressure in practice.

---

## Implementation note (2026-08-26)

Implemented as planned, with one correction and one addition found during implementation:

- **Correction to this ADR's own Scenario 1 pseudocode**: the trigger as originally written
  references ACKG's `sampleWorks` matching "the specific piece." `sampleWorks`
  (`src/appraisal/knowledge_graph/types.ts` `AckgCandidate.sampleWorks`) is never persisted
  onto `TriageResult` — it exists only transiently inside Stage 2a's live `query_ackg` tool
  loop. `classifyTriageOutcome` (`src/appraisal/routing.ts`) uses the closest available proxy
  instead: `ackgSupportCount > 0 && ackgProvenanceTags.includes("institutional")`. Weaker than
  the ideal (title/dimensions were never actually compared) — documented inline in code as a
  known simplification, not silently substituted.
- **Addition, decided via AskUserQuestion during planning**: GitHub Issue #7 asked for an
  explicit CONFIRMED/CHALLENGED/UNCERTAIN verdict that Stage 3 reacts to by widening its
  valuation range. Rather than lose that behaviour when folding Skeptic logic into Stage 2b,
  `ASAAttributionResult` gained a new `attributionChallengeAssessment` field
  (`skepticModeEngaged`, `verdict`, `challengeNarrative`), and
  `VALUATION_REPORT_SYSTEM_PROMPT` gained a step reacting to it. **This means Stage 3 is not
  unaffected by this ADR**, correcting the "Not addressed" claim below.
- **Verified live, end-to-end**, not just via the unit suite (`tests/routing/`, 20/20
  passing): three real `tests/backtest/run_backtest.ts` runs (A0785 lot 2 — Braque, A0777
  lot 9 — Villon, A0785 lot 67 — Nash) all routed into Scenario 2 (each had a genuine
  `riskFlags` hit) and produced three *different* verdicts — UNCERTAIN, CONFIRMED, and
  CHALLENGED respectively — confirming the adversarial pass is genuinely discriminating
  rather than defaulting to one canned answer. The Nash case is a particularly good real
  example: skeptic mode correctly caught that Stage 1b's own visual-search hypothesis was
  likely wrong (no such print title in any accessible record, missing standard edition
  apparatus, a documented "after Nash" reproduction category exists). All three lots hitting
  Scenario 2 in a 3-lot sample is noted as a data point for future threshold tuning, not
  read as evidence of a routing bug — the classifier correctly followed whatever `riskFlags`
  Stage 2a's own LLM call produced in each case.
- Not yet exercised in a real run: Scenarios 1, 3, 4, 5, 6. Worth a wider backtest pass before
  fully trusting the untuned placeholder thresholds at volume.

## Implementation note 2 (2026-08-26) — the wider backtest pass found a real bug, fixed

A 5-lot backtest batch (Roseberys A0777, lots 1–5) found what the note above asked for: not
just more Scenario 2 hits, but a *diagnosable* reason for it. Combined with the earlier 3-lot
sample, **8 of 8 real backtest lots routed to Scenario 2** — not because these were all
genuinely high-risk transactions, but because `riskFlags` themselves weren't discriminating.
Pulling the raw flags (not just the derived scenario) showed **all six flags true in 6 of 8
lots**, across genuinely different artists (Braque, Villon, Nash, Gauguin ×2, Maillol, Munch
×2) and genuinely different real outcomes (some clean against the catalogue, some with real
title/estimate misses). That uniformity across a diverse, differently-outcomed sample is the
signature of non-discrimination, not of every lot actually being equally risky.

**Root cause, found by reading the actual prompt text, not by guessing**: Section 2D of
`ATTRIBUTION_TRIAGE_SYSTEM_PROMPT` was one line — `"Assess: FORGERY_RISK, REPRINT_RISK,
EDITION_COMPLEXITY_RISK, MISATTRIBUTION_RISK, AUTHENTICATION_BODY_EXISTS,
PHYSICAL_EXAMINATION_REQUIRED."` — no criteria for what makes any flag true vs. false, unlike
2A's detailed tradition taxonomy elsewhere in the same prompt. Given zero discriminating
guidance, defaulting to maximal caution on every flag is a plausible, unforced model response,
not a sign the model is malfunctioning.

**Two fixes, both implemented and verified:**

1. **Section 2D rewritten** with explicit, falsifiable per-flag criteria (default FALSE,
   require citable evidence, explicitly reject "generic reasoning about the artist's fame").
   `AUTHENTICATION_BODY_EXISTS` is redefined as a **fact flag** ("does a catalogue raisonné
   exist"), not a risk signal — it was true for nearly every historically documented
   printmaker in this catalogue regardless of actual outcome, which is exactly what a fact
   about the artist's documentation status would look like, not a risk signal about this
   transaction. `MISATTRIBUTION_RISK`'s criteria now explicitly excludes a low Stage 1b
   similarity score against a Wikipedia *artist portrait* (a known, separate Stage 1b coverage
   gap — comparing against the wrong kind of reference image entirely) from counting as
   evidence of misattribution.
2. **`classifyTriageOutcome`'s Scenario 2 trigger drops `authenticationBodyExists`** — now
   `forgeryRisk || misattributionRisk` only, matching the flag's redefinition. Also broadened
   `hasWorkLevelMatch` (Scenario 1's trigger) to count ACKG support from *either* provenance
   layer, not institutional-only — that restriction bought a source-trust distinction, not
   real work-specificity, given `ackgSupportCount` was already a population-support proxy
   rather than a verified title match regardless of source.

Both changes are covered by new/updated tests in `tests/routing/` (21/21 passing, including a
named regression test asserting `authenticationBodyExists` alone can no longer trigger
Scenario 2). A second backtest pass on the same 5 lots follows this note to confirm the fix
actually produces varied risk profiles rather than a different constant.

---

## Implementation note 3 (2026-09-11) — `misattributionRisk` only routes when something is attributed

The Scenario 2 trigger is narrowed a second time, for the same reason it was narrowed the
first. Implementation note 2 dropped `authenticationBodyExists` because it was a fact about
the artist's documentation status rather than a risk about this transaction, and it fired on
nearly every lot. `misattributionRisk` has the same defect in a different place: it fires on
lots where **nothing has been attributed at all**.

Measured over 60 Stage 2a stability runs (5 committed fixtures and 10 unseen pool lots, four
repetitions each, Haiku 4.5 on the ADR-0018 query plan):

| | |
|---|---:|
| runs with `misattributionRisk` true | 20 / 60 (33%) |
| …of those, artist verdict `not_attributed` (A11) | **14 (70%)** |
| …of those 14, with no `forgeryRisk` either | **13** |
| share of all `not_attributed` runs pulled into Scenario 2 this way | **56%** |

Three things make this wrong rather than merely noisy.

The flag's own definition presupposes a candidate — "VEA's physical evidence itself conflicts
with **the leading candidate**", or "two or more candidates ... pointing to DIFFERENT
identities". A11 means there is no leading candidate, and the second clause, if it were
genuinely true, produces verdict `conflict` and Scenario 5, not `not_attributed`.

The task profile this trigger injects is undeliverable. Scenario 2 orders Stage 2b to
"actively try to falsify the leading attribution hypothesis". On an A11 lot there is no
hypothesis to falsify: the adversarial pass has no target, and is paid for regardless.

And it was the largest single source of Stage 2a's run-to-run instability. On the unseen pool
slice, four of the five unstable lots produced a **byte-identical tree verdict in every
repetition** and flipped Scenario 4 ↔ 2 on this one boolean.

**The change.** In `mapTwoPassToScenario`, `misattributionRisk` routes only when
`artist.verdict !== "not_attributed"`. `forgeryRisk` is deliberately NOT gated — an object can
be a forgery whether or not anyone has worked out who it purports to be by. The flag itself is
untouched: it still reaches Stage 2b, the report and `riskFlags`. Only its power to route
changes, and a suppressed firing is stated in the routing rationale rather than vanishing.

**Measured effect**, re-running the same 10 unseen lots × 4 repetitions:

| | before | after |
|---|---:|---:|
| `misattributionRisk` on a `not_attributed` lot | 14 | 9 |
| …of those routed to Scenario 2 | **14** | **1** |
| …and that one also carries `forgeryRisk` | 1 | 1 |

Every remaining firing is correctly suppressed; the one surviving Scenario 2 is `forgeryRisk`,
by design.

Two cautions about how to read this. The aggregate stability figure moved 85% → 88% and 5/10 →
6/10 fully stable, which is **within sampling noise** at this size — the before and after are
different draws of 40 runs. The per-lot attribution is the real evidence: 1012_147, 1147_303
and A0724_373 went from mixed to uniform Scenario 4, while the three lots that got *worse*
(1171_177, A0731_171, A0673_182) all carry `misattributionRisk=false` in every repetition, so
the gate never fired on them and cannot be the cause.

The second caution is the more interesting one. **1151_41 was stable before and stably wrong**
— four repetitions of Scenario 2 on a lot with nothing attributed, buying an adversarial pass
with no target every time. A stability metric cannot see that failure at all, which is a
standing argument against reading agreement percentages as a quality measure on their own.
