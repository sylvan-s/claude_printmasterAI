# ADR-0010: Two-pass attribution in Triage — artist, then Conceptual Work, with an impression-divergence layer

**Date:** 2026-08-29
**Status:** Accepted, implemented behind a config flag; thresholds untuned.
- The deterministic classifier (Decisions 3, 3b, 4a-amendment, 5, 5b, 6, 8, 9.1) — `src/appraisal/two_pass_attribution.ts`, `npm run test:two-pass` (72 cases).
- The Sonnet **Attribution Evidence Agent** (Decision 9.2) — `ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT` / `ATTRIBUTION_EVIDENCE_SCHEMA` (one Claude call + the `query_ackg` loop, fills observation cells only), plus `src/appraisal/stage2a_evidence.ts` (`evidenceToTwoPassInput` → `classifyTwoPass` → `assembleTriageResult`) and `FourStageAppraiser.runStage2aEvidence`. `npm run test:stage2a-evidence` (23 cases).
- **Resilience.** All Anthropic calls go through `postAnthropicMessages` (shared retry: undici network failures — which surface as thrown `TypeError`s, not HTTP statuses — plus 429/529/5xx, exp backoff, `retry-after` honoured). A content-filter 400 is a typed `AnthropicContentFilterError`; `runStage2aEvidence` retries once with VEA prose trimmed (`trimVeaProse`), then degrades to a "not attributed → escalate" result rather than crashing the lot.
- **K_work (Decision 9.1, Part A — real catalogued technique + dimensions).** New `queryAckgWorks` / `query_ackg_work` tool aggregates per `ConceptualWork` and returns catalogued `techniques`, `rawMedium`, plate/image/sheet dimensions (parsed to mm — `dimension_parse.ts`), and edition sizes. The evidence agent transcribes both sides; `classifyTechniqueMatch` (a keyword→family rules table: intaglio / planographic / relief / screen / photomechanical) and the reworked `classifyDimensionMatch` (observed side is now Stage 1c's stated dimensions, not VEA; `vea_scaled` widens tolerance; sheet never used for identity) do the comparison in code. This unlocks the impression-divergence layer (Decision 5b) — e.g. observed giclée vs catalogued etching → `reproduction`, but observed giclée vs catalogued giclée (Hirst *Empresses*) → `none`.
- **K_work (Decision 9.1, Part B — embedding title matcher).** `ConceptualWork.name` is embedded once (`gemini-embedding-001`, 768-d, L2-normalized, `SEMANTIC_SIMILARITY`) via `backfill_title_embeddings.ts` → `titleEmbedding` property. `query_ackg_work` now takes `observedTitle` + `observedTechnique`; `scoreWorkTitleMatches` embeds the observed title, cosines against the catalogued vectors, rescales the compressed gemini cosine band (`titleSimFromCosine`, floor 0.72 / ceil 0.96) to a 0..1 `titleSim`, and returns the rows ranked. A technique-incompatible work is demoted (×0.85) **only as a tie-break** — when a compatible candidate is within 0.08 `titleSim` of it — so a clear title winner keeps its score (a giclée *Empresses* work must not lose to VEA reading "screenprint"; the impression layer does the real technique comparison). `normalizeTitleForEmbedding` folds diacritics, strips catalogue-ref parentheticals (`"Nūr Jahān (H10-2, from The Empresses)"` → `"nur jahan"`) and series suffixes before the embed; the `ConceptualWork.name` backfill uses the same normalization. The agent transcribes the top row's `titleSim` / `matchedWorkTitle` / `backPropArtist`. New row **T8K**: a strong embedding match (`titleSim ≥ TAU_TITLE_ANCHOR` 0.85) identifies the Conceptual Work even when the title SOURCES give no consensus (the Hirst *Empresses* case). Smoke: Ofili `A1 + T8K` (titleSim 0.95), Rembrandt `A8K + T8K` (1.0), Hirst `A8K + T8K` "Wu Zetian" (1.0, impression `none` — giclée = giclée) — all `Sc.3 MATCH`, all `A11 / Sc.2` before Part B. `titleSimFromCosine` + `title_normalize` tested in `npm run test:kg-parse`. Known limits: romaji↔English does not bridge (ukiyo-e); source-vs-source title clustering (`TAU_TITLE_AGREE`) is still token-based.
- **Opt-in:** `config.stage2aMode === "evidence"` (Claude only — needs the tool loop; Gemini falls back to classic triage). Config `claude-4stage-evidence`. Classic `runStage2aTriage` / `classifyTriageOutcome` are otherwise unchanged. Exercise against the fixture with `npm run test:pool:triage -- --evidence`.
- **Backtest tuning (10-lot fixture, 3 rounds, 2026-08-29).** Round 1 → three fixes: `misattributionRisk` no longer fires on a weak/low-similarity Stage 1b hit (the reworked Stage 1b retrieves the *closest* work and scores it honestly — normal, not a misattribution signal); an unscaled VEA dimension is `UNASSESSABLE`, never a `conflicts[]` entry (dimensions come from Stage 1c — the fixture VEA dims were stripped, `tests/backtest/strip_vea_dimensions.ts`); the Decision 4a amendment above. Round 2 → Scenario 1 is now reachable ONLY by the strict pair (A1/A2 attributed HIGH + work IDENTIFIED HIGH + no divergence) — a lone MEDIUM candidate no longer fast-paths to "clean" — and `query_ackg` gained a `workTitle` substring probe so the `K` vote isn't hostage to the 3-sample-works window (sample window also 3→6). Result across rounds: artist match ~1 → 2/9 → **5/9**; false "elevated risk" routes 6 → 1 → **0**; final spread Sc.3×4 / Sc.4×2 / Sc.5×1 / Sc.6×2 (Rembrandt, Dalí, Damien Hirst all promoted A11→A8K by the `workTitle` probe).
- Every numeric threshold is still a named placeholder flagged for tuning against `tests/backtest/` before production trust (see *Not addressed*). Open levers: `A8K` (lone `K` vote) caps at `candidate`/MEDIUM; `T8K` caps at `identified`/MEDIUM; the `titleSimFromCosine` floor/ceiling and `TAU_TITLE` / `TAU_TITLE_ANCHOR` are calibrated from ~10 pairs, not the backtest. Artist-name matching still uses the token overlap-coefficient fallback (`resolve_artist_identity.py` / embeddings for names not yet wired).

Builds on [ADR-0003](0003-knowledge-graph-grounded-triage.md) (Stage 1b → Triage, the
`query_ackg` tool) and [ADR-0006](0006-deterministic-stage2b-routing-and-skeptic-integration.md)
(deterministic routing). It does **not** change the pipeline shape or the six routing
scenarios — it refines what Triage produces *before* `classifyTriageOutcome()` reads it.

---

## Context

Since ADR-0003 item 2 and ADR-0006, Stage 2a fuses VEA + Stage 1b + appraiser input +
`query_ackg` into `candidateArtists[]` — each entry a name plus a single flat
`candidateProbability` — and an `evidenceCorroboration` block of two booleans
(`stage1bAgreement`, `ackgAgreement`) plus `conflicts[]`. `routing.ts` then reads
`topCandidateProbability`, `countCompetitive()`, `conflicts.length` and `traditionConfidence`
to pick a scenario.

Four things that structure cannot express:

1. **Artist vs Conceptual Work vs Impression.** `candidateProbability` conflates "we know who
   made this", "we know which work this is", and "the object in hand is an original impression
   of it". A confidently-attributed Picasso etching whose plate mark is 12% off the catalogued
   *Suite Vollard* plate is *high-confidence artist · high-confidence Conceptual Work ·
   low-confidence impression* — three different answers, one number. The ACKG schema already
   models these as distinct nodes (`ConceptualWork`, `Matrix`, `EditionRun`, `Impression` —
   `knowledge_graph/08_ackg_schema_definition.md`); Triage's output does not.

2. **Why a confidence was reached.** `candidateProbability: 0.7` does not record whether that
   came from three sources agreeing, one legible signature, or a bare Stage 1b hit. Neither
   the router nor a human auditor can tell a well-corroborated 0.7 from a thin one —
   ADR-0006's own accepted-limitations section names this failure mode ("confidently-routed
   garbage in, confidently-routed garbage out").

3. **"Recognised artist, but no catalogued work like this."** Two sources agreeing on a real,
   documented artist while `query_ackg` returns zero works matching the observed
   technique/paper/period is a specific, actionable state — *verify the oeuvre downstream* —
   currently indistinguishable from ordinary ACKG silence.

4. **"Same Conceptual Work, different impression."** A title match with a technique or
   dimension mismatch is the signal for a later edition, a restrike, a photomechanical
   reproduction, or the artist's own variant in another medium. Today it just lowers a
   probability, with no reason attached and no distinction between "trimmed sheet" and "this
   is a poster".

---

## Decision

### 1. Triage runs two ordered passes with one feedback edge

**Pass 1 — Artist.** **Pass 2 — Conceptual Work**, gated on Pass 1. One edge runs backwards:
a work identified from in-image text can re-inform the artist pass exactly once (Decision 6).
No loop — a single back-propagation keeps the whole thing deterministic-classifier-friendly
in the ADR-0006 sense.

A third layer, **Impression assessment** (Decision 5), is not a pass — it is a set of flags
raised by Pass 2 when the Conceptual Work matches but the physical object diverges from the
catalogued record.

### 2. Evidence primitives

Three sources can **name** an artist or a title. They vote.

| Sym | Source | States |
|---|---|---|
| `V` | VEA-derived — legible signature/monogram text, in-image title/series inscription implying authorship, publisher/atelier marks | `NAMES(x)` \| `SILENT` |
| `R` | Reverse image search (Stage 1b) | `NAMES(x, sim)` \| `NO_MATCH` |
| `A` | Appraiser input (Stage 1c) `claimedAttribution` | `NAMES(x, trust)`, `trust ∈ {documented_fact, hypothesis}` \| `ABSENT` |

The ACKG **corroborates** — its *population counts* never vote (Decision 4a), but see the
Decision 4a amendment below for the one work-level signal that does:

| Sym | Query | Returns |
|---|---|---|
| `K_id(x)` | is `x` an authority record? — ACKG **institutional layer only** (ULAN / Wikidata / Tate / Met authority). The auction-history layer does **not** count. | `true` \| `false` \| `unknown` (Decision 5b carve-out) |
| `K_oeuvre(x, {technique, paper, period})` | count of works by `x` in the ACKG whose technique + paper + period overlap the VEA reading | `matchCount`, `provenanceTags[]` |
| `K_subject(x, VEA.subjectElements[])` | works by `x` in the ACKG depicting each observed subject, as a share of `x`'s catalogued output | `TYPICAL` \| `OCCASIONAL` \| `ATYPICAL` \| `UNASSESSABLE` — **annotation only, never a vote or a confidence input** (Decision 3b) |
| `K_work(x, t, {technique, dims})` | works by `x` whose title fuzzy-matches `t` | `titleSim`, `techniqueMatch`, `dimensionMatch ∈ {true, false, UNASSESSABLE}` |

**Decision 4a amendment (2026-08-29, from the first evidence-agent backtest).** A `K_work`
result where an *observed title* (from `V_t` / `R_t` / `A_t`) matches a work the ACKG
catalogues to **exactly one artist** at `titleSim ≥ TAU_TITLE` is a fourth voting source,
`K`. Rationale: unlike a population count ("Rembrandt has 240 etchings"), a work-level
artist+title match is a specific, independently-verifiable fact — the ACKG confirms both
*that titled work exists* and *who made it* — and in the backtest it was the difference
between routing a legible-title Rembrandt to `A11 → movement only` and to a real candidate.
Guardrails: `K` alone (n=1) tops out at `candidate / MEDIUM` (row **A8K**) — never
`attributed` without a direct V/R/A signal; `K` naming a different identity than a voting
source is a normal `A10` conflict; the title-match strength gate (`TAU_TITLE`) is the same
one `K_work` already owes tuning on. `K_id` / `K_oeuvre` / `K_subject` are unchanged —
still corroboration only.

**Agreement** is identity-level, not string-level: two sources agree iff they resolve to the
same artist identity — ULAN/Wikidata ID match first, else normalized-name match ≥ `TAU_NAME`.
Normalization: case/diacritic fold; honorific strip (`RA`, `ARA`, `RE`, …); **"Surname, First"
↔ "First Surname"** (Tate stores names reversed — `_parse_tate_artist_name()`,
`knowledge_graph/tate_ingest.py`). `agree(S)` is the largest subset of `{V, R, A}` resolving
to one identity `x*`; `n = |agree(S)|`.

**Stage 1b counts as a vote only when `sim ≥ threshold` AND its hypothesis is consistent with
the VEA read** (does not contradict observed technique / period / signature characters /
medium). An inconsistent Stage 1b hit is dropped from the vote but retained as a note — it
often tells you *which* work is being reproduced, which feeds Decision 5. Rationale: Stage
1b's characteristic failures (fame-driven substitution, matching a Wikipedia artist portrait,
matching a reproduction of the work) all produce a confident, high-`sim` hypothesis that is
*wrong about this object*; without the consistency gate, "V + R agree" is reachable by Stage
1b hallucinating agreement with a signature it cannot see.

### 3. Artist pass — decision table

`agree(S) → x*`, `n = |agree(S)|`, `S ⊆ {V, R, A, K}` (Decision 4a amendment adds `K`).
Evaluate top to bottom; first match wins.

| # | Condition | Verdict | Confidence | Flag |
|---|---|---|---|---|
| A1 | `n = 3` | ATTRIBUTED `x*` | **HIGH** | if `K_oeuvre = 0` → note `noMatchingOeuvre`, do **not** downgrade |
| A2 | `n = 2` and `K_oeuvre(x*) ≥ 1` | ATTRIBUTED `x*` | **HIGH** | `ackgCorroborated` |
| A3 | `n = 2` and `K_oeuvre = 0` and `K_id(x*) ∈ {true, unknown}` | ATTRIBUTED `x*` (qualified) | **MEDIUM-HIGH** | `recognisedArtist_noMatchingOeuvre` — mandatory oeuvre check at Stage 2b (Decision 7) |
| A4 | `n = 2` and `K_id(x*) = false` | ATTRIBUTED `x*` (qualified) | **MEDIUM** | `artistNotInACKG` |
| A5 | `n = 1` = `V`, legible hand-signature or in-image title cartouche | CANDIDATE `x*` | MEDIUM (LOW if signature `signatureConfidence < 0.6`) | `singleSourceVEA` |
| A6 | `n = 1` = `R`, `sim ≥ SIM_ARTIST_STRONG` | CANDIDATE `x*` | MEDIUM | `singleSourceImageMatch` |
| A7 | `n = 1` = `R`, `SIM_ARTIST_VOTE ≤ sim < SIM_ARTIST_STRONG` | CANDIDATE `x*` | LOW | `weakImageMatchOnly` |
| A8 | `n = 1` = `A`, `documented_fact` | CANDIDATE `x*` | MEDIUM | `appraiserDocumentedOnly` |
| A8K | `n = 1` = `K` (ACKG work-level artist+title match, `titleSim ≥ TAU_TITLE`) | CANDIDATE `x*` | MEDIUM | `ackgWorkAnchor` |
| A9 | `n = 1` = `A`, `hypothesis` | not attributed | LOW | `appraiserHypothesisUncorroborated` |
| A10 | ≥ 2 sources name **different** identities, none dominant | not attributed | — | `attributionConflict` → `conflicts[]` |
| A11 | all `SILENT` / `ABSENT` / `NO_MATCH` | not attributed → tradition-level grouping | — | — |

`K` also participates in `n = 2` / `n = 3` (rows A1–A4) like any other vote.

Rules layered on top:

- **`hypothesis` is corroboration, not a vote** (Decision 4b). It never contributes to `n` in
  A1–A4. It can lift confidence one band within an already-established verdict, and it breaks
  ties. A `documented_fact` is a full vote (it references paperwork independent of the
  signature).
- **A `documented_fact` claim contradicting a legible VEA signature is always A10.** A
  `hypothesis` contradicting VEA → VEA wins, the hypothesis is logged as contradicting
  evidence but does **not** by itself trigger Scenario 5.
- **ACKG can lift a verdict by at most one confidence band; it can never lift "not
  attributed"** (Decision 4a). A uniquely-discriminating `K_oeuvre` result is what makes A2
  fire and can push A5/A6/A7 up one band — it cannot manufacture a candidate from silence.

**Gate to Pass 2:** artist verdict is ATTRIBUTED (any) **or** CANDIDATE with confidence ≥
MEDIUM — **or** the Decision 6 in-image-title exception applies.

### 3b. Subject corroboration — annotation only

Once Pass 1 has a named `x*` (ATTRIBUTED or CANDIDATE), run `K_subject(x*, VEA.subjectElements[])`
against the ACKG's `Impression -[:DEPICTS]-> Subject` data (VEA subjects are already
AAT-crosswalked by `resolve_vea_composition.py`). It resolves to one of:

| State | Meaning | Effect |
|---|---|---|
| `TYPICAL` | the subject is well-represented in `x*`'s catalogued ACKG oeuvre | positive report note |
| `OCCASIONAL` | present in `x*`'s output but rare | mild positive note |
| `ATYPICAL` | `x*` has catalogued ACKG output, none depicting this subject | soft flag `subjectAtypicalForArtist` — a **note for Stage 2b and the report, not a downgrade and not a `conflicts[]` entry** |
| `UNASSESSABLE` | `x*` thin/absent in the ACKG | nothing |

**This never changes a verdict, a confidence band, or a route**, and `classifyTriageOutcome()`
does not read it. It exists to give the appraisal a real corroboration sentence — *"the image
depicts a bull, a recurring subject in the artist's prints (N catalogued works, ~X% of his
print oeuvre in the ACKG)"* — and, in the `ATYPICAL` case, one more small thing for the
Stage 2b specialist to weigh with real research.

It is deliberately kept out of the verdict math for the reason behind Decision 4a: subject is
the weakest discriminator (a bull distinguishes almost nothing — many printmakers did bulls),
the AAT-crosswalked tags are coarse, and a "typical subject" signal that *could* nudge
confidence would systematically inflate it for exactly the artists with broad,
well-documented oeuvres (Picasso's subjects are all "typical") — the fame-inflation failure
mode, laundered through the graph. `ATYPICAL` is almost always an ACKG coverage gap, not
evidence against, so it can only annotate.

### 4. Threshold and policy constants

Named constants, `routing.ts`-style, all flagged for backtest tuning:

```
TAU_NAME            = 0.90   // normalized-name match to count as "same identity" (fallback when no ULAN/Wikidata ID)
SIM_ARTIST_VOTE     = 0.75   // Stage 1b sim floor to count as an artist vote
SIM_ARTIST_STRONG   = 0.85   // Stage 1b sim for a MEDIUM single-source artist candidate
SIM_WORK_VOTE       = 0.85   // Stage 1b sim floor to count as a Conceptual Work (title) vote
TAU_TITLE           = 0.80   // fuzzy title-similarity floor for a K_work hit
TAU_DIM_PLATE_PCT   = 0.03   // plate-mark dimension tolerance (with a 2 mm absolute floor)
TAU_DIM_IMAGE_PCT   = 0.05   // image/composition dimension tolerance (with a 3 mm absolute floor)
```

`SIM_ARTIST_VOTE = 0.75`, not 0.70: the Stage 1b rubric defines 0.70 as *"same artist, same
period, similar composition"* — "similar composition" is where fame-driven false positives
live. 0.75 leans the band toward the "same artist" reading. The consistency-with-VEA gate
(Decision 2) applies on top of every band.

### 5. Conceptual Work pass — decision table

Title sources: `V_t` (VEA `composition.textWithinImage` / title inscription, §2A-ii), `R_t`
(Stage 1b `title`, counts only at `sim ≥ SIM_WORK_VOTE`), `A_t` (appraiser title). Normalize
into `{title, series, plate/state}`, transliterate, fuzzy-match the core title.
`K_work(x*, t, {technique, dims})` returns `titleSim`, `techniqueMatch`, `dimensionMatch`.

| # | Condition | Work verdict | Confidence | Flag |
|---|---|---|---|---|
| T1 | `V_t, R_t, A_t` all → `t*` | IDENTIFIED `t*` | **HIGH** | — |
| T2 | 2 of 3 → `t*` and `K_work`: `titleSim ≥ TAU_TITLE` ∧ `techniqueMatch` ∧ `dimensionMatch = true` | IDENTIFIED `t*` | **HIGH** | `ackgWorkCorroborated` |
| T3 | 2 of 3 → `t*` and `titleSim ≥ TAU_TITLE` and (`¬techniqueMatch` ∨ `dimensionMatch = false`) | Conceptual Work = `t*`; **impression diverges** | HIGH on *work*, flag on *impression* | `impressionDivergence` (Decision 5b) |
| T4 | 2 of 3 → `t*`, no `K_work` hit **or** `dimensionMatch = UNASSESSABLE` | IDENTIFIED `t*` (qualified) | **MEDIUM** | `workNotInACKG` / `impressionUnverifiable` |
| T5 | 1 source → `t*` | CANDIDATE work | LOW–MEDIUM | `singleSourceTitle` |
| T6 | title sources conflict | UNRESOLVED | — | `titleConflict` → `conflicts[]` |
| T7 | all title sources `SILENT` | UNRESOLVED | — | `noTitleEvidence` |

> **Implementation note (Parts A + B).** As built, `K_work.techniqueMatch` / `dimensionMatch`
> are not a work-verdict input — the whole physical-vs-catalogued comparison moved into the
> impression layer (5b), which runs after Pass 2 for *any* `identified`/`candidate` work.
> So **T2 and T3 collapse**: T2 = "2 sources agree + `titleSim ≥ TAU_TITLE`" → IDENTIFIED HIGH,
> and any divergence is carried by `impressionAssessment`, not the work verdict. A new **T8K**
> row was added: a strong embedding title match (`titleSim ≥ TAU_TITLE_ANCHOR`) → IDENTIFIED
> MEDIUM even when the title *sources* give no consensus (`ag.n = 0`), checked before T6/T7.
> `titleSim` is the rescaled `gemini-embedding-001` cosine from `scoreWorkTitleMatches`.

#### 5b. Impression divergence

| Observation | Interpretation | Flag |
|---|---|---|
| technique matches; dims within `max(TAU_DIM_*_PCT, absolute floor)` | trimming / plate-vs-sheet confusion | `dimWithinTolerance` (no divergence) |
| technique matches; dims materially off, proportionally consistent | trimmed or variant sheet, same edition | `possibleVariantSheet` — condition/value note only |
| technique matches; dims materially **larger** | later / enlarged edition, restrike | `possibleLaterEdition` → REPRINT_RISK |
| **technique differs** (ACKG: etching; VEA: lithograph, or halftone dots) | same image, **different production** — reproduction *after*, photomechanical copy, or artist's own variant in another medium | `mediumDivergence` → REPRINT_RISK; Stage 2b resolves which |
| technique = photomechanical (halftone / giclée) vs expected original printmaking | reproduction / poster, not an original impression | feeds VEA's `isLikelyReproductionOrPoster`; halt-adjacent |

**Dimension comparison rules:** compare **plate mark** if the work is intaglio and both sides
have it (`TAU_DIM_PLATE_PCT`, 2 mm floor); else **image/composition size**
(`TAU_DIM_IMAGE_PCT`, 3 mm floor); **never sheet size** for work identity — sheet size varies
within one authentic edition and is only a `sheetSizeNote` for condition. `dimensionMatch =
UNASSESSABLE` (→ T4, not T3) when VEA had **no `SCALE_SCAN`** (unscaled VEA dimensions are
±15–20%) or when VEA and the ACKG record report **different dimension types** (plate vs
sheet). Normalize all units to mm on ingest (Roseberys cm, Forum mm).

### 6. In-image-title exception to the Pass-2 gate, with back-propagation

Pass 2 also runs — **regardless of the artist verdict** — when VEA reports a legible in-image
title/series inscription (`textWithinImage` classified as a title, high VEA confidence). This
matters most for the material where artist ID is weakest: ukiyo-e prints carry the series and
print title *in the image*, so a worn signature can leave the artist at "Utagawa school"
while the Conceptual Work is unambiguous.

In this mode `K_work` is queried on **title + technique + period, not artist**. If it returns
works matching that title consistently by one artist, **re-run Pass 1 once** with that
work→artist link as an additional signal (the work identifies the artist). Exactly one
iteration — no loop. The Conceptual Work can reach HIGH via this path; the artist verdict
only moves if the back-propagation lifts it.

### 7. Output schema

`candidateArtists[]` keeps its shape for backward compatibility (Stage 2b and the report
renderer still read it; `candidateArtists[0]` = `x*`), but `candidateProbability` becomes a
**derived** projection of the new structured fields, not an LLM free-choice number. Add:

```jsonc
"artistAttribution": {
  "verdict": "attributed | candidate | not_attributed | conflict",
  "artistName": "", "artistNameNative": null,
  "confidence": "HIGH | MEDIUM_HIGH | MEDIUM | LOW",
  "evidenceBasis": "A1..A11",              // which row fired
  "agreementSet": ["V", "R"],              // which sources agreed
  "kId": true, "kOeuvreMatchCount": 0,
  "subjectCorroboration": "typical | occasional | atypical | unassessable",  // Decision 3b — annotation only
  "subjectNote": "",
  "flags": ["recognisedArtist_noMatchingOeuvre"]
},
"workIdentification": {
  "verdict": "identified | candidate | unresolved | conflict",
  "conceptualWorkTitle": "", "series": null, "plateOrState": null,
  "confidence": "HIGH | MEDIUM | LOW",
  "evidenceBasis": "T1..T7",
  "agreementSet": ["V_t", "A_t"],
  "backPropagatedToArtist": false
},
"impressionAssessment": {
  "divergence": "none | variant_sheet | later_edition | medium_divergence | reproduction",
  "dimensionMatch": "true | false | UNASSESSABLE",
  "techniqueMatch": true,
  "notes": ""
}
```

`evidenceCorroboration` is kept (ADR-0006's router still reads `conflicts[]`), with
`stage1bAgreement` / `ackgAgreement` now populated from `agreementSet` membership.

### 8. Router mapping (`classifyTriageOutcome()` update)

The six scenarios are unchanged. The two-pass verdicts **add** to what the router reads; they
do not replace the triage LLM's Section-2D risk flags. `forgeryRisk` / `misattributionRisk`
still trigger Scenario 2 (ADR-0006), checked **first** — a forgery flag raised by a
signature-medium conflict (not an impression divergence) would otherwise fall between the
tables. Then:

| Triage outcome | Scenario |
|---|---|
| `riskFlags.forgeryRisk` **or** `riskFlags.misattributionRisk` | 2 — Elevated authentication risk (Skeptic) |
| `artistAttribution` HIGH **and** `workIdentification` HIGH **and** `impressionAssessment.divergence = none` | 1 — Confirmed, clean |
| `impressionAssessment.divergence ∈ {later_edition, medium_divergence, reproduction}` | 2 — Elevated authentication risk (Skeptic) |
| `artistAttribution.verdict = conflict` **or** `workIdentification.verdict = conflict` **or** `countCompetitive ≥ 2` | 5 — Competing candidates (Skeptic) |
| `artistAttribution` ≥ MEDIUM_HIGH **and** `workIdentification.verdict = unresolved` | 3 — Artist confirmed, work unresolved |
| `artistAttribution.flags` includes `recognisedArtist_noMatchingOeuvre` | 3 — with a mandatory STEP 3/4 oeuvre check |
| `artistAttribution.verdict = not_attributed` **and** `traditionConfidence ≥ MOVEMENT_THRESHOLD` | 4 — Movement / style only |
| `artistAttribution.verdict = not_attributed` **and** `traditionConfidence < MOVEMENT_THRESHOLD` | 6 — Low signal everywhere (escalate) |

### 9. Execution model — code fills the tree, one Sonnet call fills the evidence cells

The two-pass tree is **not operationalised as model reasoning.** Following ADR-0006's pattern:
the model's job is to populate a set of evidence cells; deterministic code evaluates the tree
over them. Splitting the work by *model tier* (Haiku / Sonnet / Opus per sub-step) is the
wrong axis — the right split is **code / one model call / embeddings**, because once the
deterministic parts are removed, what remains is a single tier of judgment, not three.

#### 9.1 Who executes what

| Operation | Nature | Executor |
|---|---|---|
| Name normalization, honorific strip, "Surname, First" ↔ "First Surname", ULAN/Wikidata resolution | deterministic | **code** — `resolve_artist_identity.py` |
| Derive `V` / `A` candidate identity from the VEA transcription and the Stage 1c claim | mostly deterministic (both already structured upstream) | **code** |
| `agree(S)`, `n`, all `sim`/`TAU`/`τ` threshold comparisons | set logic + arithmetic | **code** |
| `K_id` / `K_oeuvre` / `K_subject` | Cypher queries | **`query_ackg` tool**, orchestrated by the model |
| `K_work` fuzzy title/name similarity | cross-language string/semantic match | **embeddings** (cosine) — *not* an LLM call; reuse the `knowledge_graph/` embedding infra, add a text model |
| Stage 1b ↔ VEA consistency check ("halftone ≠ woodblock", "aniline pigment ⇒ post-1856") | bounded domain reasoning | **model** — or a technique/period-incompatibility rules table for the common cases, model for the residue |
| `query_ackg` loop — choose params, narrow, decide "confirmed", spot a signature-vs-paper contradiction | iterative judgement | **model** — this is the latency bottleneck (ADR-0009: Stage 2a 132–258 s) |
| A1–A11, the Pass-2 gate, T1–T7, impression dimension math, back-prop orchestration, router mapping | pure functions | **code** — extends `classifyTriageOutcome()` (`src/appraisal/routing.ts`) |
| Evidence chain / `subjectNote` prose, `humanEscalationRequired` | light generation + judgement | **model** — folded into the same call |

#### 9.2 The one model call

A single call — *"the ACKG evidence agent"* — receives VEA JSON + the Stage 1b result +
Stage 1c claims + the code-resolved identities; has the `query_ackg` tool; runs the
consistency check and the query loop; **populates the evidence cells**
(`agreementSet`, `kId`, `kOeuvreMatchCount`, `subjectCorroboration`, `techniqueMatch`,
`dimensionMatch`, `conflicts[]`, the prose fields, `humanEscalationRequired`); then stops.
Code takes it from there.

- **Tier: Sonnet.** The judgement is the `query_ackg` loop and the consistency reasoning —
  Sonnet-class. Keep the `stage2aModel` config field (a lot can already run `claude-4stage-fast`
  on Haiku).
- **No Opus in the tree.** Opus earns its cost on Stage 1a (vision fidelity). Post-VEA the
  tree is classification + graph-grounding; the genuinely hard attribution calls are
  *deliberately deferred* to Stage 2b's Skeptic pass (ADR-0006 Decision 4).
- **No separate Haiku call by default.** The only candidates are the evidence prose and
  ambiguous-mark extraction; both are small enough that a second call's round-trip is not
  worth it. Fold them into the Sonnet call. Add a Haiku pre-pass only if a backtest shows the
  extraction genuinely needs model help and the token saving is real.

#### 9.3 Why not split by model tier

- **Handovers here are cheap but pointless.** Every seam passes small structured JSON (VEA
  already stripped the images); a handover costs a few hundred tokens plus one round-trip
  (~1–3 s TTFT) — negligible against the ~200 s `query_ackg` loop. But splitting the
  *arithmetic* onto Haiku buys nothing that running it in code doesn't buy better (instant,
  unit-testable, auditable). The tree is one kind of medium reasoning wrapped in a lot of
  arithmetic, not three kinds of hard thinking.
- **The tier you need falls as you codify.** ADR-0006 (deterministic routing), ADR-0009
  (precomputed graph-analytics signals) and this ADR's A/T tables all pull work *out* of the
  model. The shallower the `query_ackg` loop becomes, the more defensible Haiku-for-2a is —
  which is the bet `claude-4stage-fast` already makes. Build it as one Sonnet call now; let
  the backtest say when Haiku is sufficient for the residual judgement.

---

## Consequences

**Good:**

- Attribution confidence is decomposed into the three questions it was silently averaging
  (artist / work / impression), each with its own verdict, confidence, and — critically — a
  recorded `evidenceBasis` string. "Why HIGH" becomes a table row, not an opaque number.
- The two states the current schema cannot represent both get first-class handling:
  `recognisedArtist_noMatchingOeuvre` (A3) routes to a real downstream oeuvre check;
  `impressionDivergence` (T3) separates "trimmed sheet" from "this is a reproduction" and
  routes the latter adversarially.
- The Stage 1b consistency gate and the `hypothesis`-is-not-a-vote rule close the two
  "false agreement" holes that let ADR-0006's router fast-path a thin attribution.
- The in-image-title exception recovers Conceptual-Work identification precisely for the
  material (ukiyo-e) where the ULAN coverage gap makes artist ID weakest — and the
  work→artist back-propagation turns a legible cartouche into an artist signal.
- Subject-oeuvre fit (Decision 3b) gives the appraisal report a genuine corroboration
  sentence ("a bull — a recurring subject in the artist's prints") while being structurally
  barred from touching the verdict, so a weak, coverage-skewed signal cannot inflate
  confidence.
- Execution stays cheap and testable (Decision 9): one Sonnet call fills evidence cells,
  code evaluates the tree. No model-tier handover chain, no Opus in the loop, and the
  required tier drops further as ADR-0009's precomputation lands.

**Accepted limitations / open risks:**

- **Every threshold is a guess.** `SIM_ARTIST_VOTE`, `TAU_TITLE`, `TAU_DIM_*` etc. have not
  been fitted to anything — same "backtest before trust" discipline ADR-0003 and ADR-0006
  already owe, now with more knobs. Boundary misclassification (a `sim` of 0.74 vs 0.75)
  has the same brittleness any hand-tuned threshold has.
- **`K_work` adds a `query_ackg` round.** ADR-0009 already flags Stage 2a duration
  (132–258 s, mean ~209 s) as the pipeline's largest cost; a title-fuzzy-match query on top
  of the oeuvre query widens that. May be mitigable by folding both into one tool call.
- **ACKG coverage still governs the ceiling.** A3/A4/T4 fire on *absence*, and absence is
  heavily skewed — Met/Roseberys/Forum are Western-print-dense, ukiyo-e is thin-to-absent.
  The East-Asian `K_id = unknown` carve-out (Decision 2/3) is a patch on one symptom, not a
  fix for the coverage itself.
- **The back-propagation edge is a small dent in ADR-0006's "pure function" property.** It is
  bounded to one iteration and is deterministic given the same inputs, but the artist pass no
  longer runs strictly once. Whoever implements should keep Pass 1, the gate, Pass 2, and the
  single re-run as four explicit stages, not a `while` loop.
- **Schema migration touches Stage 2b, Stage 3, and the report renderer.** They read
  `candidateArtists[0]` and `candidateProbability` today; those stay, but anything that should
  react to `impressionAssessment` (Stage 3's valuation range especially — a `reproduction`
  divergence should collapse it, mirroring ADR-0006's `attributionChallengeAssessment`
  handling) needs deliberate wiring, not assumed.
- **Fuzzy name/title matching is unspecified here.** `TAU_NAME` / `TAU_TITLE` presume a
  matcher (token-set ratio? embedding cosine?) that doesn't exist yet. `resolve_artist_identity.py`
  has the honorific-strip and ULAN-resolution half; the title half is greenfield.

---

## Not addressed

- The actual constant values — deferred to a `tests/backtest/` pass against the
  known-attribution corpus with these rules in place, exactly as ADR-0006 deferred its own.
- Titles: the embedding matcher is built (Part B — `gemini-embedding-001` on
  `ConceptualWork.name`, `scoreWorkTitleMatches`). The `titleSimFromCosine` floor/ceiling and
  `TAU_TITLE` / `TAU_TITLE_ANCHOR` are calibrated from ~10 pairs, not the backtest.
  romaji↔English does not bridge (ukiyo-e). Source-vs-source title clustering
  (`TAU_TITLE_AGREE`) is still the token overlap-coefficient.
- **Artist-name canonical resolution — ROADMAP.** Decision 2 wants identity-level agreement
  ("ULAN/Wikidata ID match first, else normalized-name match ≥ `TAU_NAME`"), but only ~18% of
  ACKG `Artist` nodes carry a ULAN id (907 / 5,056) and the pipeline has no resolver, so the
  V/R/A/K agreement check is string-based for ~80% of artists. Embeddings are the *wrong* tool
  here — names are named entities with little semantic content, and ULAN already stores every
  variant form (incl. non-Latin scripts) deterministically. The right build: a
  `resolve_artist(observedName) → { canonicalName, ulanUrl, ackgArtistId, confidence }` step
  = Getty ULAN reconciliation (`services.getty.edu/vocab/reconcile/`) + Jaro-Winkler /
  token-overlap against the ACKG `Artist.name` list + a small curated transliteration table
  for recurring ukiyo-e names. This is the "greenfield half" of `resolve_artist_identity.py`.
  A one-time ULAN backfill over the 5,056 `Artist` nodes would also fill most missing ids and
  surface the dedup/noise problems ("George Braque" vs "Georges Braque",
  "Henry Moore OM CH FBA", mangled multi-artist strings) for the ACKG Curator (ADR-0008).
- **VEA free-text technique/paper/subject — mostly handled; one small reconciliation item.**
  Technique and paper are absorbed by the ingest-time crosswalk
  (`knowledge_graph/crosswalk_matching.py` — priority-ordered keyword lists aligned to VEA's
  vocabulary, e.g. `["screenprint", "serigraphy", "silk screen", …] → "Screenprint / Serigraphy"`)
  and by this ADR's own `TECH_FAMILY_KEYWORDS` regex in `two_pass_attribution.ts` for the
  impression comparison. **Two keyword tables that can drift** — worth reconciling to one
  source of truth and exposing it to the TS query path so the agent's `query_ackg` `technique`
  param is normalized before the `CONTAINS` match. Subject (`composition.subjectMatter`) is
  genuinely ungrounded (no AAT/Iconclass backing — `resolve_vea_composition.py` notes this),
  but low-stakes: K_subject is annotation-only (Decision 3b), it never votes.
- The exact Stage 2a model tier — Decision 9 commits to *one* call at Sonnet-class now, with
  the `stage2aModel` config field kept; whether Haiku is sufficient for the residual
  judgement after ADR-0006/0009/0010 codification is a backtest question, not decided here.
- Whether `impressionAssessment` should eventually be its own pipeline stage (a dedicated
  "is this an original impression" check with its own prompt) rather than a Pass-2 by-product.
- Multi-work lots — out of scope here as everywhere (the standing deferred policy; see
  `knowledge_graph/09_source_ingestion_semantic_layer.md` §3.1).
- Group-lot fractional logic interaction with `impressionAssessment` (a reproduction inside a
  mixed lot).
