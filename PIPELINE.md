# Fine Art Print Appraisal Pipeline

## Overview

The appraisal system supports both a 3-stage and a 4-stage pipeline, implemented in `src/appraisal/appraiser.ts`. The 4-stage pipeline is the primary production path. All stages communicate via structured JSON — **only Stages 1a and 1b ever see the images** (1a for inspection, 1b for reverse-image search), and only Stage 1c ever sees the appraiser's free-text notes. Stages 2a, 2b and 3 work purely from upstream JSON.

```
   images                     image                 appraiser free-text notes
     │                          │                              │
     ▼                          ▼                              ▼
Stage 1a (VEA)           Stage 1b (Visual Search)        Stage 1c (Appraiser Input Agent)
     │                        │   │                            │
     │      all three launch immediately, run fully concurrently│
     └──────────┬─────────────┘   │   └────────────────────────┘
                ▼                  │   Stage 2a waits on ALL of 1a + 1b + 1c
         Stage 2a (Triage)         │
                │                  │   Stage 1b's result is also passed
                ▼                  │   straight through to Stage 2b
         Stage 2b (Specialist ASA) ◄┘
                │
                ▼
         Stage 3 (Valuation)
                │
                ▼
         PrintAnalysisReport
```

**Cost/latency tradeoff:** because Stage 1b starts before VEA's halt-gate result is known, a submission that VEA flags as a digital reproduction (Section 0, see below) still pays for a Stage 1b Gemini call whose result gets discarded — a deliberate latency-over-cost choice, since most submissions are real physical prints and halts are the exception. Stage 1b also sits on Stage 2a's critical path: Triage blocks until the visual-search result is ready rather than 1b and 2a overlapping (ADR-0003 item 2). That cost is accepted so Triage can weigh a strong reverse-image match, instead of that evidence only reaching Stage 2b.

---

## Stage 1a — Visual Extraction Agent (VEA)

**Prompt:** `VISUAL_EXTRACTION_SYSTEM_PROMPT`
**Schema output:** `VEA-1.1` (every section now carries its own `*Confidence` field — see below; `VEA-1.0` records without them are still accepted downstream)
**Receives:** Raw images (primary scan + an arbitrary-length list of user-captioned supplementary photos)
**One of only two stages that see images (the other is Stage 1b). Receives no appraiser text — see Stage 1c.**

### What it does

Works through ten inspection sections:

| Section | Task |
|---------|------|
| 0 | **Digital reproduction gate** — classifies image as `PHYSICAL_PRINT_SCAN`, `PHYSICAL_PRINT_PHOTOGRAPH`, `DIGITAL_REPRODUCTION`, or `UNCERTAIN`. If reproduction detected, sets `haltRecommended: true` and returns immediately — no downstream stages run. |
| 2A | **Signature detection** — type, verbatim transcription, medium, authenticity indicators, bounding box, confidence score |
| 2A-ii | **Title inscription detection** — handwritten/printed titles in lower margin; highest-value attribution clue |
| 2B | **Edition and numbering** — fractional numbers, AP, HC, PP, BAT, TP, roman numerals; hand-inscribed vs stamped |
| 2C | **Printing technique identification** — intaglio (etching, drypoint, aquatint, mezzotint, engraving), relief (woodcut, linocut), planographic (lithograph, screenprint), digital (giclée) |
| 2D | **Plate mark and sheet geometry** — embossed plate depression presence/clarity; dimension estimates if scale scan provided |
| 2E | **Paper and support** — surface type (wove, laid, Japanese, BFK Rives…), tone, weight, mounting status |
| 2F | **Condition assessment** — systematic survey of tonal degradation, paper degradation, physical damage, contamination, restoration evidence; each defect gets severity grade and bounding box |
| 2G | **Ink and colour** — colour palette, surface character (matte/satin/glossy), coverage evenness |
| 2H | **Stamps and labels** — gallery/publisher stamps, auction labels, collector dry stamps (Lugt refs), framer's labels |
| 2I | **Visual composition** — purely descriptive: subject matter, style, any text/dates within image. Explicitly forbidden from naming artist or estimating value |
| 2J | **Image quality assessment** — focus uniformity, lighting, distortion, resolution; flags which observations are limited by photography vs print condition |

All features with bounding boxes returned in `[ymin, xmin, ymax, xmax]` format on a 0–1000 scale.

---

## Stage 1b — Gemini Visual Search

**Model:** Gemini, per-config (`stage1bModel`; default `DEFAULT_STAGE1B_MODEL` = `gemini-3.7-flash`)
**Runs:** Launched immediately, fully concurrent with Stage 1a and Stage 1c — needs only the primary image, no dependency on VEA's output. **Stage 2a blocks on its result** (ADR-0003 item 2); Stage 2b then receives it as well.
**Receives:** Primary image + Google Search tool

### What it does

Two-pass reverse image search and visual similarity scoring:

**Pass 1 — Search (Gemini 2.5 Flash + Google Search)**
Sends the artwork image with Google Search enabled. Searches Artnet, MutualArt, Catawiki, Invaluable, Christie's, Sotheby's, Bonhams, British Museum, V&A, Met, and MoMA.

Prioritises evidence in this order: legible text (signatures, titles, edition numbers, stamps) → distinctive composition → technique markers → subject/style. Returns a **single best-match hypothesis** — artist, title, technique, period, confidence level, a direct URL to a matching image of the work, and a source page URL.

**Pass 2 — Visual similarity scoring (Gemini 2.5 Flash, multimodal)**
Fetches the best-match image URL returned in Pass 1. Passes both the original submission and the retrieved image to Gemini for side-by-side comparison. Returns a `visualSimilarityScore` (0.0–1.0) and a one-sentence rationale.

| Score | Meaning |
|-------|---------|
| 1.0 | Identical work, same impression |
| 0.9 | Same work, minor photographic differences |
| 0.8 | Very likely same work or direct variant |
| 0.7 | Strong match — same artist, same period, similar composition |
| 0.6 | Probable match — similar style and technique |
| < 0.6 | Treat with high scepticism |

The full result — artist, title, similarity score, rationale, image URL, and page URLs — is passed to **Stage 2a** (where Triage fuses it with VEA and the ACKG in `evidenceCorroboration` — see below) and **again to Stage 2b**, always carrying an explicit hypothesis warning. Both stages are instructed to cross-reference against VEA signatures, title inscriptions, and technique before accepting any match, and to treat results with similarity < 0.6 or `LOW` confidence with high scepticism.

---

## Stage 1c — Appraiser Input Agent (AIA)

**Prompt:** `APPRAISER_INPUT_SYSTEM_PROMPT`
**Schema output:** `AIA-1.0`
**Model:** Claude Haiku 4.5 (`STAGE1C_MODEL`)
**Runs:** Launched alongside Stage 1a, independently of it — no dependency either way. See ADR-0004.
**Receives:** The four `AppraiserNotesInput.tsx` free-text boxes (inscribed marks, provenance, condition, catalogue/lit refs), plus deterministic regex hints (dimensions, catalogue refs, edition size) computed from that text before the model call. Text only — no images, no vision.

### What it does

Extracts the appraiser's free-text notes into structured, trust-tagged claims for Stage 2a — VEA never sees this text at all, keeping VEA strictly vision-only.

Every claim is tagged:
- `documented_fact` — the note itself references supporting paperwork or a verifiable record (an invoice, a certificate, an exhibition catalogue entry). AIA detects that a document is *claimed*; it does not verify one exists.
- `hypothesis` — stated as belief, with no referenced documentation.

Produces: a holistic `claimedAttribution` (artist/title/period/technique, scanned across all four note blocks, since a claim can appear anywhere), `inscriptionClaims` (signature/edition/monogram), a `provenanceChain`, `conditionClaims`, `catalogueReferences` (tagged by whether the regex pass or the model found them), `literatureOrExhibitionClaims`, and an optional `dimensionsClaim`. Always echoes back the verbatim `rawNotes` for every block provided — the structured extraction never replaces the original text.

Best-effort like Stage 1b: skipped entirely (zero API cost) if no notes were submitted at all; returns an empty result on any failure rather than failing the pipeline.

---

## Stage 2a — Attribution Triage Agent (ATA)

**Prompt:** `ATTRIBUTION_TRIAGE_SYSTEM_PROMPT`
**Schema output:** `ATA-1.0`
**Receives:** VEA JSON (text only — no images) + Stage 1c's structured appraiser claims + Stage 1b's visual-search result
**Runs:** Waits on **all** of Stage 1a, Stage 1b and Stage 1c
**Tool:** `query_ackg` — queries the Art Context Knowledge Graph (ingested Met / Roseberys / Forum records) for real population support behind candidate artists

### What it does

| Section | Task |
|---------|------|
| 2A | **Tradition identification** — classifies into East Asian (Ukiyo-e, Shin-hanga, Sosaku-hanga), European Old Master, 19th Century European, European/American Modern (1900–1970), or Contemporary (post-1970) |
| 2B | **Period estimation** — uses paper type (laid/wove/machine-made), edition conventions (no numbering = pre-1880 Western; pencil signature = post-1880; fractional numbering = post-1900), and seal/stamp evidence |
| 2C | **Candidate shortlisting** — ranked 1–5 candidates; text signals weighted highest (legible titles, signatures, publisher marks) over style alone |
| 2D | **Risk flag assessment** — FORGERY_RISK, REPRINT_RISK, EDITION_COMPLEXITY_RISK, MISATTRIBUTION_RISK, PHYSICAL_EXAMINATION_REQUIRED. Every flag defaults FALSE and needs specific cited evidence (never generic reasoning about an artist's fame or market value). AUTHENTICATION_BODY_EXISTS is a *fact* flag (does a catalogue raisonné / foundation exist), not a risk signal. |
| 2E | **Evidence fusion** — reconciles VEA, the Stage 1b match, and `query_ackg` results into `candidateArtists[]` + `evidenceCorroboration` (`stage1bAgreement`, `ackgAgreement`, `conflicts[]`). Corroboration ranks a candidate up; contradiction goes into `conflicts[]`, never averaged away. |
| 2F | **Escalation assessment** — sets `humanEscalationRequired` (physical exam + auth body + forgery all true, OR VEA `overallExtractionConfidence` < 0.35, OR appraiser input materially contradicts the physical evidence) |

**Triage does not choose the route.** Since ADR-0006, routing is deterministic: `classifyTriageOutcome()` in `src/appraisal/routing.ts` is a pure function over the `TriageResult` fields above — no LLM call. It picks, in order, one of six scenarios (Confirmed-clean · Elevated-authentication-risk · Artist-confirmed-work-unresolved · Movement-only · Competing-candidates · Low-signal-everywhere), a coarse tier, whether the Stage 2b Skeptic pass engages, and a specialist config key from a real on-disk registry (`rembrandt_etchings`, `ukiyo_e_edo_general`, `general_print_fallback` today) — falling back explicitly to `general_print_fallback`, never inventing a name (the ADR-0005 finding #8 failure mode). The LLM's only routing-related output is `humanEscalationRequired`.

When Stage 1c produced any claims, Triage weighs `documented_fact` claims above `hypothesis` claims, and `hypothesis` claims no higher than VEA's own physical evidence — a claim conflicting with VEA's observations is recorded as an explicit entry in `evidenceCorroboration.conflicts[]`, never silently preferred over the other.

---

## Stage 2b — Specialist Attribution Agent (ASA)

**Prompt:** `ATTRIBUTION_RESEARCH_SYSTEM_PROMPT` + injected specialist config + injected scenario task profile
**Schema output:** `ASA-1.0`
**Receives:** VEA JSON + triage routing (scenario, tier, `specialistConfig`) + Stage 1b visual-search result (all text)
**Has web search access**

### What it does

Loads the specialist knowledge config for the routed tradition from `src/appraisal/specialist_configs/<key>.json` — this defines which databases to query (priority order), critical authentication markers, known forgeries/facsimiles, and catalogue raisonnés.

Executes a structured 8-step research process. Stage 2a's deterministic router (ADR-0006) also injects a **scenario task profile** deciding which steps run at full depth, which are abbreviated, and which are skipped:

| Step | Task |
|------|------|
| 1 | Extract search keys from triage output (artist name, series title, native script text) |
| 2 | Primary database queries — at most 5 web searches total (≤3 attribution, ≤2 comps), priority order from the specialist config |
| 3 | Catalogue raisonné cross-reference — note all discrepancies vs VEA |
| 4 | Authentication marker analysis — each marker assessed as CONFIRMED / ABSENT / INCONSISTENT / UNASSESSABLE |
| 5 | Forgery and reprint risk assessment → `reprintForgeryRisk: LOW / MEDIUM / HIGH / UNASSESSABLE` |
| 6 | Impression state and series/edition identification |
| 7 | Auction comp collection — 1–2 searches for recent verifiable sales of identical/similar prints (Roseberys, Sotheby's, Christie's, Phillips, Bonhams, Artnet); fractional-lot logic applied |
| 8 | Attribution confidence scoring (structured formula: base score from database match + marker modifiers + risk penalty + image-quality penalty; ceilings apply) |

**Skeptic pass (ADR-0006, resolves Issue #7):** under the *Elevated-authentication-risk* and *Competing-candidates* scenarios, STEP 4/5 run adversarially — actively trying to falsify the leading hypothesis. The outcome is recorded in `attributionChallengeAssessment` (`skepticModeEngaged`, `verdict` = CONFIRMED / CHALLENGED / UNCERTAIN, `challengeNarrative`), which Stage 3 reads when setting its valuation range.

Outputs attribution level (`definitive | probable | possible | school_of | tradition_only | unattributed`), confidence score, evidence chain, and valuation-relevant findings — **no monetary estimates**.

---

## Stage 3 — Valuation Agent

**Prompt:** `VALUATION_REPORT_SYSTEM_PROMPT`
**Receives:** Stage 1a VEA JSON (condition/technique) + Stage 2b ASA JSON (attribution/edition/rarity, incl. `attributionChallengeAssessment`)
**Has web search access**

### What it does

Searches for recent auction comps at Sotheby's, Christie's, Phillips, Bonhams, and Roseberys (Roseberys London April auctions prioritised). For group lot sales, calculates the individual print's fractional value rather than using the full lot price.

Applies condition penalties (20%–75% discount based on VEA defect grade) and rarity/edition factors from Stage 2b, and widens the estimate range on a CHALLENGED or UNCERTAIN Skeptic verdict from Stage 2b. Outputs only six fields: `auctionEstimate`, `recentAuctionSales`, `nextSteps`, `editionSizeAndPrintNumber`, `isLikelyReproductionOrPoster`, `reproductionExplanation`.

Deliberately siloed from attribution — does not re-describe the artwork or repeat Stage 2b findings.

---

## Model Configurations

| Config ID | Stage 1a (VEA) | Stage 1b (Visual Search) | Stage 1c (Appraiser Input) | Stage 2a (Triage) | Stage 2b (Specialist) | Stage 3 (Valuation) |
|-----------|---------------|--------------------------|-----------------------------|-------------------|----------------------|---------------------|
| `claude-4stage` | Claude Opus 4.8 | Gemini 3.7 Flash | Claude Haiku 4.5 | Claude Sonnet 4.6 | Claude Sonnet 4.6 | Claude Sonnet 4.6 |
| `claude-4stage-fast` | Claude Opus 4.8 | Gemini 3.7 Flash | Claude Haiku 4.5 | Claude Haiku 4.5 | Claude Sonnet 4.6 | Claude Sonnet 4.6 |
| `gemini-4stage` | Gemini 2.5 Pro | Gemini 3.7 Flash | Claude Haiku 4.5 | Gemini 3.1 Pro Preview | Gemini 3.1 Pro Preview | Gemini 2.5 Pro |
| `gemini-3stage` | Gemini 2.5 Pro | — | — | — | Gemini 2.5 Pro (direct) | Gemini 2.5 Pro |
| `claude-3stage` | Claude Sonnet 4.6 | — | — | — | Claude Sonnet 4.6 (direct) | Claude Sonnet 4.6 |

Unlike Stage 1b's model (`stage1bModel`, per-config), Stage 1c's model is currently hardcoded (`STAGE1C_MODEL`) rather than a config field — every 4-stage config gets Claude Haiku 4.5. It has no presence in the 3-stage pipelines, which have no Stage 2a to feed.

**Rationale for model assignment:**
- **Opus on Stage 1a** — multimodal visual extraction is the highest-fidelity task; bounding box accuracy and technique identification benefit most from frontier vision
- **Haiku on Stage 1c** — free-text field extraction against a fixed schema; the same reasoning that puts Haiku on Stage 2a (fast variant) applies here even more directly, since AIA has no vision and no external tool calls
- **Haiku on Stage 2a (fast variant)** — triage is a classification/routing task that does not require deep reasoning; Haiku reduces cost and latency with minimal quality loss
- **Sonnet on Stage 2b** — web search + structured attribution reasoning; does not require vision
- **Sonnet on Stage 3** — auction comp search and valuation arithmetic; does not require vision

---

## Key Design Principles

1. **Images are seen only in Stage 1** — Stage 1a (inspection) and Stage 1b (reverse-image search) are the only image-processing layers. Stages 2a, 2b and 3 work purely from structured JSON.
2. **Separation of concerns** — visual extraction, tradition routing, attribution research, and valuation are handled by separate agents with separate prompts and schemas.
3. **Text signals are privileged** — legible inscriptions (titles, signatures, edition numbers) outweigh stylistic inference in all attribution stages.
4. **Null over fabrication** — all agents are instructed to return `null` or `"uncertain"` rather than guess unobservable fields.
5. **Halt gate** — if Stage 1a detects a digital reproduction, the pipeline stops immediately and returns a zero-value report rather than producing a meaningless valuation.
6. **Stage 1b is advisory** — its visual-search match is passed to Stage 2a (fused in `evidenceCorroboration`) and to Stage 2b as a hypothesis labelled with a warning, never as confirmed attribution.
7. **Appraiser text is seen only by Stage 1c** — VEA is strictly vision-only; the appraiser's free-text notes reach the pipeline exclusively through Stage 1c's structured, trust-tagged extraction, not mixed into VEA's inspection prompt. See ADR-0004.
8. **Trust-tagged claims never silently override physical evidence** — Stage 1c tags every claim `hypothesis` or `documented_fact`; Triage weighs `documented_fact` above `hypothesis`, and `hypothesis` no higher than VEA's own observations. A conflict between an appraiser claim and VEA's physical evidence is recorded explicitly, never resolved by picking one silently.
