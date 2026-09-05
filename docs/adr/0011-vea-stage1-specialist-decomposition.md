# ADR-0011: Stage 1a (VEA) — replacing the single Opus call with specialist models

**Date:** 2026-08-31
**Status:** Proposed — not started.

---

## Context

Stage 1a (the Visual Extraction Agent, schema `VEA-1.1`) is currently one Claude Opus call
that performs the entire visual inspection of a print in a single pass:
`VISUAL_EXTRACTION_SYSTEM_PROMPT` in `src/appraisal/prompts.ts` asks Opus to do all of the
following against the submitted images, per request:

- **Section 0** — binary/quaternary authenticity gate (scan vs. photograph vs. digital
  reproduction vs. uncertain), based on describable pixel artifacts (halftone dot screens,
  CMYK registration offset, context bleed, layered-texture gestalt).
- **2A / 2A-ii / 2H** — locate, transcribe, and classify every handwritten or printed mark on
  the sheet: signatures, dedicatory inscriptions, title inscriptions, edition/collector
  stamps.
- **2B** — locate, transcribe, and classify edition notation (fractions, AP/HC/PP/TP/BAT).
- **2C** — classify printing technique(s) from 14 categories across three families
  (intaglio/relief/planographic) plus digital, from texture/line/tonal evidence.
- **2D** — detect a plate mark, measure dimensions only when a scale reference is present.
- **2E** — classify paper surface type, tone, weight, mounting status.
- **2F** — detect and localize condition defects across five categories (tonal degradation,
  paper degradation, physical damage, surface contamination, restoration evidence), each with
  a severity grade.
- **2G** — list ink colours present, classify monochrome/duotone/multicolour, assess coverage
  evenness.
- **2I** — describe subject matter, style, key visual elements, palette (explicitly forbidden
  from naming the artist or title).
- **2J** — assess the submitted images' own photographic quality (focus, illumination, glare,
  distortion, resolution) as a confidence modifier on everything above.
- **Section 3** — synthesize 2–5 "visual evidence highlights": the findings a downstream human
  or agent should look at first, with a short evidentiary rationale for each.

This is the only stage that sees images (Stage 1b/Visual Search and Stage 1c/AIA are
text/reverse-image only — see [[project-pipeline-architecture]]), so its cost is paid on every
single appraisal, always at Opus rates, regardless of how visually straightforward the lot is.

**The core observation:** of the eleven sections above, only Section 3 is a genuine synthesis
task that benefits from an LLM reasoning over multiple signals at once. Sections 0, 2A/2A-ii/2H,
2B, 2C, 2D, 2E, 2F, 2G, 2I, and 2J are each, individually, a bounded detection, classification,
OCR, or deterministic-signal-processing problem — the kind of task purpose-built cheaper models
(or plain image-processing code) solve at least as reliably, for a fraction of the cost, and
without spending an LLM's visual-reasoning budget on work that doesn't need it.

---

## Decision

Decompose Stage 1a into a set of specialist components feeding a much smaller synthesis call,
rather than one Opus call doing everything. Per VEA section:

### 1. Section 0 (authenticity gate) → deterministic signal processing + a small learned classifier

The halftone-dot-screen and CMYK-registration-offset indicators are frequency-domain artifacts
with well-established deterministic detectors (FFT-based moiré/halftone detection) — free,
fast, and more reliable than a vision-language model eyeballing a dot pattern, since it's a
literal signal property rather than something to visually judge. The harder "layered texture /
picture-of-a-picture" gestalt case is a better fit for a small learned classifier (a DINOv2
linear probe, trained on labeled physical-print vs. reproduction examples) than for either
rule-based code or a full LLM call.

This gate matters more than the others to get right — a false negative here means every
downstream section (still run on the same call today) burns cost inspecting a reproduction.
Worth prioritizing its accuracy specifically, not just its cost.

### 2. Sections 2A / 2A-ii / 2H (signatures, titles, stamps) → detect, crop, then read

Split into two decoupled steps:
- **Localization**: a zero-shot open-vocabulary detector (Grounding DINO / OWL-ViT) or, once
  a modest labeled set exists, a fine-tuned lightweight detector (YOLOv8n-class). Pure
  grounding, no reasoning required.
- **Reading**: crop to the located region (now a few hundred pixels, not a full sheet) and
  transcribe with either a handwriting-OCR specialist (TrOCR) or a cheap multimodal model
  (Haiku / Gemini Flash) — the crop's small size means even an LLM-based reader costs a
  fraction of what full-page Opus vision tokens cost today.
- **Reframe as verification, not blind transcription, where possible**: by the time this runs,
  a candidate artist name is often already available from the auction-listing text ingested
  upstream. "Is this scrawl consistent with '{candidate}'?" is a smaller, cheaper, and more
  directly useful question than "what does this say?" — and it's the actual authentication
  signal the pipeline needs (catching a misattribution/forgery), not transcription for its
  own sake.

### 3. Section 2B (edition/numbering) → same detect+crop+OCR pipeline, classify by regex

Edition notation is a small, fixed string grammar (`\d+/\d+`, `AP`, `HC`, `PP`, `TP`, `BAT`,
Roman-numeral suites). Once the OCR step returns the transcribed text, classifying which
edition type it is needs no model at all — plain pattern-matching in code.

### 4. Section 2C (printing technique) → DINOv2-Large linear probe

The strongest single candidate for replacement. Technique identification is fine-grained
texture classification against a fixed, known taxonomy (14 categories) — exactly what a linear
probe on frozen DINOv2 features is good at, and the training labels already exist: Roseberys,
Forum Auctions, and Met records ingested into the ACKG carry ground-truth technique text for a
large share of the corpus (see [[project-ackg-status]]) — this is free supervision, not a new
labeling task.

### 5. Section 2D (plate mark & geometry) → classical CV

Detecting an embossed rectangular depression, and measuring against a ruler/coin of known size
when present, is a geometry/calibration problem — edge detection plus a scale-reference lookup,
not a visual-reasoning problem.

### 6. Section 2E (paper & support) → DINOv2/CLIP classifier

Same closed-set classification pattern as technique (surface type, tone, weight, mounting
status) — worth building once paper-type ground truth is confirmed to exist in the ingested
corpus at useful volume (likely thinner coverage than technique; needs checking before
committing to this one).

### 7. Section 2F (condition & damage) → fine-tuned defect detector/segmenter

A detection/segmentation problem across a known, finite defect list (foxing, tears, creases,
staining, restoration evidence), with severity as a secondary classifier on each detected
region. This is the most labor-intensive replacement to build in this ADR — it needs labeled
defect examples (bounding boxes or masks, not just a text label) that likely don't already
exist in the ingested auction data and would need to be created.

### 8. Section 2G (ink & colour) → deterministic pixel processing

No model needed. Colour-histogram clustering (k-means) answers "how many distinct ink colours"
and "monochrome vs. multicolour"; coverage evenness is a straightforward variance statistic
over the image area. Free, and more reliable than a model's verbal colour-counting.

### 9. Section 2I (visual composition) → CLIP zero-shot

Subject matter and style description against a controlled vocabulary is CLIP's strength —
and the pipeline already has an AAT-aligned technique/paper crosswalk (`aat_crosswalk.json`)
that a comparable style/subject vocabulary could follow the same pattern as, keeping VEA's
output vocabulary-consistent rather than inventing free text that then needs re-mapping
downstream.

### 10. Section 2J (scan quality) → deterministic image-quality metrics

Standard, well-established IQA techniques answer this without any learned model: Laplacian-
variance blur detection for focus, exposure-histogram analysis for illumination/glare,
geometric-distortion detection for perspective/curvature.

### 11. Section 3 (evidence highlights) → stays on an LLM, but not necessarily Opus

The one genuine synthesis task in VEA: selecting and prioritizing the most evidentially
significant findings across everything above, with a short rationale tying signals together.
By the point this runs, though, it's reasoning over compact structured fields already produced
by the specialist components above — not raw pixels — so a cheaper capable model (Sonnet) is
worth testing here before assuming Opus is required for this step specifically.

---

## Consequences

**Benefits:**
- Opus (or any per-image LLM cost) is paid only for the one section that's actually a
  reasoning task, instead of for all eleven.
- Several sections (2D, 2G, 2J, and the halftone-detection half of Section 0) cost nothing per
  image at all once built — deterministic code, not inference.
- The technique classifier (2C) can be trained today from data already sitting in the graph,
  with no new labeling effort.
- Sections that stay model-based (2A/2A-ii/2H reading, 2C, 2E) become independently
  cacheable/reusable and easier to evaluate in isolation (measurable per-task accuracy against
  a held-out set, instead of judging one opaque multi-task Opus output).

**Costs:**
- This is a real re-architecture, not a prompt tweak. It replaces one call with ~8 new
  components (a mix of trained models, a detector, and deterministic CV code) that each need
  building, hosting, and maintaining.
- **Loss of shared context.** Opus currently sees every signal at once in one pass — e.g. the
  paper-surface read can inform the ink-coverage read, and the halt gate short-circuits
  everything else on a reproduction before wasting effort. A decomposed pipeline gets none of
  that for free; cross-signal consistency (today implicit in one model's single forward pass)
  has to be re-assembled explicitly in code once inputs come from separate specialist
  components.
- Several of the classifiers (2C confidently, 2E and 2F less certainly) depend on labeled
  training data of adequate volume and quality existing or being creatable. 2F (condition) in
  particular needs region-level (bounding box/mask) labels the corpus likely doesn't have yet
  — a real data-collection task before that component can be built at all.
- Overall output quality needs to be validated against the current VEA baseline before this
  becomes the production path, not assumed from the task decomposition alone.

---

## Not addressed by this ADR

- A concrete labeled-data plan for 2F (condition/damage) — what volume of bounding-box/mask
  labels is needed, and where they'd come from.
- Whether 2E (paper/support) has enough labeled examples in the ingested corpus to be worth
  building versus staying on an LLM call.
- Confidence-score calibration and penalty rules (Section 0D's photographic-confidence-penalty
  logic) across a now-heterogeneous set of components instead of one model's self-reported
  confidence.
- Hosting/infra decisions for the trained models (DINOv2 probes, the detector) — self-hosted
  vs. a managed inference endpoint.
- A migration/rollout plan (e.g. shadow-running the decomposed pipeline alongside current VEA
  and comparing outputs before cutover).

## Suggested implementation order

Lowest effort, highest signal first:
1. **2G (ink/colour) and 2J (scan quality)** — pure deterministic code, no training data or
   new model needed at all. Build and validate against current VEA output first, since these
   are the cheapest possible proof that the decomposition approach holds up.
2. **2C (technique)** — training labels already exist in the graph; highest-value single
   replacement given how central technique is to downstream attribution reasoning (Stage 2a/2b
   both consume `observedTechniques` from VEA today).
3. Everything else, informed by what 1 and 2 reveal about calibration and integration cost.
