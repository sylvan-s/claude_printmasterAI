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
- Changes to Stage 3 (valuation) — unaffected; this ADR only changes how Stage 2a's output
  routes into Stage 2b and what Stage 2b does once routed.
