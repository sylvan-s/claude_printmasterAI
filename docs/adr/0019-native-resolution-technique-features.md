# ADR-0019: Technique classification needs native-resolution features, not a bigger head

**Date:** 2026-09-13
**Status:** Proposed. **Phase 0 gate passed on 2026-09-13** (results below): tiling at a fixed
physical scale is worth +0.09 / +0.15 artist-balanced F1 on aquatint / drypoint over the same
encoder at 518px, and resolution alone is worth nothing. Phases 1–4 are unblocked but not
started.

The printmaking-technique classifier ([`knowledge_graph/technique_ml/`](../../knowledge_graph/technique_ml/README.md))
is rebuilt on features extracted from the images at the resolution the sources actually
serve, tiled and normalised to a fixed physical scale, instead of the whole-image 224px
DINOv2-Large embeddings the ACKG already stores. The stored `embedding` property is left
untouched — Stage 1d depends on it — and the new features live under a new property.

Builds on the evaluation protocol the existing classifier established (artist-grouped
split, artist-balanced macro-F1, source-leakage probe, family-then-process escalation
gate). That protocol is kept unchanged so the numbers stay comparable.

---

## Context

The existing classifier reaches 0.275 artist-balanced macro-F1 across 21 processes and
0.558 across six process families. Its evaluation concluded that the head is not the limit:
`--hidden 1024` scores worse than 512, family-collapsing nearly doubles the score, and the
failing classes are exactly the ones whose evidence is fine surface structure — aquatint's
resin grain (~0.1–0.3 mm), drypoint's burr, mezzotint's rocker texture, the halftone
rosette that separates an offset lithograph from a hand-drawn one. Restricted to images
already labelled *Etching*, the model still ranks aquatint at 1.79× chance and drypoint at
1.55×, so the grain signal survives the 224px resize in traces. The evaluation named
"native-resolution tiled re-embedding" as the next experiment.

Two things were established on 2026-09-13 that make that experiment cheap:

**The resolution was discarded at embedding time, not at download.** The embed scripts
download the source file, pass it through `AutoImageProcessor` (resize 256 → centre-crop
224), and delete the file. What the stored `sourceUrl` actually serves, probed live:

| Host | Images | Technique-labelled | Stored URL serves | Best available | How to get it |
|---|---:|---:|---|---|---|
| Bonhams (`images1/2.bonhams.com`) | 53,577 | 53,577 | **2880px** | 2880px | already at the stored URL; `&width=N` resamples (4000 is an upscale) |
| Roseberys (S3) | 20,765 | 16,011 | 650px | **4000px** | `/lot_images/large/` → `/lot_images/xlarge/` |
| Pompidou (`images.navigart.fr`) | 21,189 | 19,339 | 1000px | 1000px | hard cap — every other size segment returns 404/415 |
| Tate (`media.tate.org.uk`) | 10,208 | 10,208 | 600px | 600px | Wagtail rendition; the legacy `…/P02159_10.jpg` pattern is gone (404) |
| British Museum | 2,507 | 2,507 | 611px | 1000px | `preview_` → `mid_` |

**Physical scale is recoverable.** `Impression.sheetDimensions` is populated on 102,119
impressions (`"45.4x55.2cm"` form; `plateDimensions` 13,095, `imageDimensions` 16,348), so
pixels-per-millimetre can be derived per image. That is the variable that matters, not the
pixel count: at 224px across a 500 mm sheet aquatint grain is ~0.5 px/mm and invisible; a
2880px Bonhams photograph of the same sheet is ~5–8 px/mm; a 4000px Roseberys one ~10 px/mm;
a 600px Tate rendition of a typical 235 mm print ~2.5 px/mm, which is marginal.

The labelled corpus has also doubled since the classifier was trained — 44,927 → ~101k
images — because the Pompidou ingest (21,189 images, all technique-labelled) landed after
2026-09-07. Pompidou is a fourth museum source with 2,149 aquatints and 1,882 drypoints,
which directly weakens the "learn the photographer" confound the evaluation measured at
0.907 probe accuracy.

Constraints that shape the design:

- One image per Bonhams impression (`imageType: listing_photo`), no detail shots. Listing
  photographs include mounts and frames, so tiles must come from the print area.
- The local machine is an M1 / 16 GB with a working MPS backend and **17 GB of free disk**.
  A full-resolution cache is impossible (Bonhams alone ≈ 65 GB); extraction must stream and
  discard. The Oracle VM (2 OCPU Ampere / 12 GB) is not a compute option.
- Non-commercial research use ([memory: non-commercial scope]); the navigart
  `rightsReservation` / `embeddingCommercialUse` flags carry forward to any derived feature.

## Decision

Rebuild the technique features from native-resolution imagery, in five phases, with a hard
gate after the first.

### Phase 0 — gate experiment (`technique_ml/phase0_resolution_probe.py`)

Before any infrastructure: ~300 images each of *Etching-only*, *Aquatint* (± etching) and
*Drypoint* (± etching) from Bonhams and Roseberys, chosen with `sheetDimensions` present and
capped per artist so no hand dominates. Native-resolution files are fetched once into the
session scratchpad (~1.5 GB, discarded afterwards). Four feature sets are compared on the
within-intaglio task, where the current model scores aquatint 0.43 / drypoint 0.25
validation F1:

| Feature set | What it isolates |
|---|---|
| F0: stored 224px whole-image CLS (1024-d) | the baseline the existing classifier used |
| F1: DINOv2-L at 518px whole-image CLS | resolution alone, no tiling |
| F2: 224px tiles from the central print area, resampled so one tile spans a fixed ~40 mm (≈5.6 px/mm, never upsampled), mean ⊕ max pooled (2048-d) | tiling + physical normalisation |
| F3: F2 ⊕ per-tile texture statistics (Laplacian variance, radial FFT band energies) | a cheap hand-crafted grain/halftone channel |

Evaluation is 5-fold artist-grouped cross-validation, thresholds tuned on held-back
training artists, artist-balanced F1 and average precision per class. **Go/no-go:** F2 or F3
must beat F1 meaningfully on aquatint and drypoint (the working bar is ≥ +0.10
artist-balanced F1 on both). If tiling does not beat the 518px whole image, the hypothesis
is wrong and the remaining phases are not started.

#### Phase 0 result (2026-09-13)

899 images (300 etching-only / 299 aquatint / 300 drypoint), 348 artists, median 5.6 px/mm
after normalisation, 5-fold artist-grouped CV, one image dropped as smaller than a tile
(6.4 × 5.7 cm). `artifacts/phase0_results.json`.

| Feature set | Aquatint F1 / AP | Drypoint F1 / AP |
|---|---:|---:|
| F0: stored 224px whole image | 0.577 / 0.536 | 0.544 / 0.496 |
| F1: 518px whole image | 0.569 / 0.546 | 0.561 / 0.533 |
| F2: tiles at ~40 mm, mean ⊕ max | **0.655 / 0.673** | **0.710 / 0.745** |
| F3: F2 ⊕ texture statistics | 0.646 / 0.680 | 0.703 / 0.751 |

Three findings, in order of weight:

1. **Resolution alone is worth nothing.** Showing the same encoder the whole image at 518px
   instead of 224px moves neither class (±0.01). A bigger whole-image input was the obvious
   cheap fix and it does not work; the grain has to be presented at a scale the patch grid can
   resolve.
2. **Tiling at a fixed physical scale is the whole effect.** F2 over F1: drypoint +0.149 F1 /
   +0.212 AP, aquatint +0.086 F1 / +0.127 AP. Drypoint clears the +0.10 bar outright; aquatint
   is just under it on F1 and well over on AP, the threshold-free measure. The gate is passed.
3. **Hand-crafted texture statistics add nothing** once tile embeddings are present (F3 ≈ F2
   within noise). The halftone-rosette idea for offset lithography stays in Phase 3 as an
   *audit* channel, not a feature.

Both approximations in the probe are conservative — px/mm assumes the sheet spans the
image's long axis (listing photographs include mounts, so tiles are slightly coarser than
40 mm), and "print area" is the central 60% with no localiser (mat and frame tiles go in as
noise) — so the Phase 1 localiser should only widen the gap. Per-fold variance was not
computed; that belongs in the Phase 4 evaluation, not here.

### Phase 1 — high-resolution acquisition layer

- A `hires_url(sourceUrl)` resolver per host implementing the substitutions in the table.
- A print-area localiser run on a downsampled copy, so tiles come from the sheet and not
  from the mat, frame or backdrop.
- New `DigitalImage` properties: `hiresWidthPixels`, `hiresHeightPixels`, `pxPerMm` (from
  `sheetDimensions`), `resolutionTier`. Images under a px/mm floor are flagged and excluded
  from fine-grain classes, not from family-level classes.
- Streaming, resumable, rate-limited, same `User-Agent` and politeness as the existing
  ingests. No image cache.

### Phase 2 — feature extraction at scale

- Labelled images first, artist-capped (the trainer caps at 40 per artist–technique anyway),
  so ~50k images rather than 108k. At 16 tiles per image that is ~800k DINOv2-L forward
  passes — roughly 10–15 h on MPS plus ~75 GB over the wire; a multi-day background job.
- Written to a new property (`tileEmbedding` + a small meta map), never to `embedding`.
- Only if Phase 4 plateaus: LoRA fine-tune of the last DINOv2 blocks on tiles.

### Phase 3 — label repair

- Collapse naming-only distinctions: Giclée / Inkjet / Pigment / Digital print → one inkjet
  class. Treat the generic `Intaglio` (713) and `Relief printing` (238) labels as
  family-only supervision, not as process classes.
- Use the halftone channel to audit `Lithograph` vs `Offset lithograph` (F1 0.01 today,
  Bonhams/Roseberys-only): a rosette is physical evidence, so the label-quality problem
  becomes measurable rather than assumed.
- Cross-source conflicts (one `ConceptualWork`, two institutions, two techniques) are
  flagged; museum labels outrank auction text.
- An out-of-fold confident-learning pass surfaces probable mislabels for a small review,
  using the Haiku 4.5 vision adjudicator on native-resolution tiles.

### Phase 4 — model and evaluation

- The two-stage family → process design, the artist-grouped split and the **same held-out
  test artists** are kept, so results compare directly to 0.275 / 0.558.
- Heads: MLP on pooled tiles first; attention-MIL over per-tile embeddings second, so the
  model can find the one tile that carries the burr.
- The source-institution probe is re-run and must drop from 0.907; if it does not, the new
  features have learned the camera again.
- Target: aquatint, drypoint, mezzotint, wood engraving, linocut and offset lithograph clear
  the escalation gate (7 of 21 techniques do today).

### Phase 5 — product implication

`predict_technique.py` receives a user photograph of unknown scale. The model will need
either the sheet dimensions or a close-up detail shot; Stage 1 should ask for one. This is
noted here because it shapes the evaluation — the noise-robustness run already showed
defocus is the expensive degradation — and is not otherwise decided by this ADR.

## Consequences

- Phase 0 costs about a day and ~1k images and can kill the whole plan cheaply. That is the
  point of it.
- Tate is stuck at 600px and Pompidou at 1000px. Both remain fully usable for family-level
  labels; whether they contribute to fine-grain classes is decided by the px/mm floor, not
  by institution.
- No stored embedding changes, so Stage 1d, the artist-merge tooling and the vector indexes
  are unaffected.
- Disk is the binding local constraint. The plan streams; if a reusable cache is ever wanted
  it needs an external volume.
- The physical-scale normalisation (tiles in millimetres, not pixels) is the load-bearing
  design choice: it is what stops "resolution" from becoming a fourth institution-identity
  shortcut alongside lighting, backdrop and studio style.
