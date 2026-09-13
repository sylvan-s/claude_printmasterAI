# ADR-0019: Technique classification needs native-resolution features, not a bigger head

**Date:** 2026-09-13
**Status:** Proposed. **Phase 0 gate passed on 2026-09-13** (results below): tiling at a fixed
physical scale is worth +0.09 / +0.15 artist-balanced F1 on aquatint / drypoint over the same
encoder at 518px, and resolution alone is worth nothing. **Amended 2026-09-13** after the
physical-cue research in [`docs/research/intaglio-technique-visual-cues-2026-09-13.md`](../research/intaglio-technique-visual-cues-2026-09-13.md):
a Phase 0b (encoder head-to-head and a finer tile scale, in the existing harness) is inserted
before Phase 1, and Phases 1–4 are revised as marked. Phase 0b is next; nothing after it is
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

#### What the physical cues say about the Phase 0 result (2026-09-13)

The research note puts each intaglio cue on a millimetre scale and reads the Phase 0
numbers against it. The two findings that change the design:

- **Drypoint vs etching is a sub-millimetre problem the 40 mm tile does not resolve.** The
  only physical difference is the burr halo, ~0.1–0.5 mm beyond the line core; at 5.6 px/mm
  that is under 2 px of gradient. The +0.15 F1 came from *aggregate* cues — velvety,
  soft-edged dark masses where burr is dense — not from seeing burr. Aquatint cells
  (~0.05–0.3 mm) are likewise aliased and survive only as a noise statistic, which is why
  aquatint gained less. Whether finer tiles read the halo itself is an open, testable question.
- **Line-level cues need ≥ 10 px/mm to see and ≥ 20 to characterise**, which only Roseberys
  `xlarge` and small Bonhams sheets reach. Hatching *syntax* (0.5–3 mm spacing) is visible on
  every source and is what the 224px model was already using. Plate mark and ink relief
  (~40 µm) are lighting cues, absent from any flat-lit listing photograph.

The null on the hand-crafted texture channel has five identifiable causes (no print-area
localisation; spectra taken after resampling, so grain sat at or above Nyquist; JPEG block
energy that moves with the resample factor; radial bands discarding orientation, which is
the actual discriminant; no masking of line work). It is dropped as a feature and kept only
as the native-resolution halftone audit in Phase 3.

Burr wears off in a dozen to 20–30 impressions before steel-facing (1857) and 300–500 after,
so pre-1860 "drypoint" lots carry an irreducible error floor. Drypoint metrics are split by
period from here on.

### Phase 0b — encoder head-to-head and a finer tile scale (added 2026-09-13)

Run inside the Phase 0 harness on the same 899 images, before any bulk extraction, so the
Phase 2 forward passes are spent on the winner:

- **Encoders:** DINOv2-L (baseline) vs `facebook/dinov2-with-registers-large` vs
  `facebook/dinov3-vitl16-pretrain-lvd1689m` (patch 16 — 256 px tiles to keep 40 mm, or
  accept a 2.9 mm patch). Registers remove the high-norm background-token artefacts that
  mat/paper tiles trigger; DINOv3's gram anchoring targets dense/texture fidelity, which is
  what grain and burr are.
- **Pooling:** CLS mean ⊕ max (baseline) vs orderless pooling of patch tokens (GeM /
  Fisher-vector style) — texture is local, and the CLS token encodes the layout we want to
  discard.
- **A second, finer tile scale** of ~16–20 mm per 224 px tile (11–14 px/mm), computed only
  where native px/mm ≥ 11 (Roseberys `xlarge`; Bonhams sheets ≤ ~260 mm), never upsampled.
  Report drypoint and aquatint F1 **per px/mm bucket** (2–4, 4–7, 7–11, > 11). A monotone
  rise with px/mm means the halo is being read and the fine scale earns its place; a flat
  curve means the model reads macro cues and the fine scale is dropped.

Go/no-go for Phase 2's encoder choice: the best configuration on artist-balanced F1 and AP,
with the same 5-fold artist split as Phase 0.

### Phase 1 — high-resolution acquisition layer (revised 2026-09-13)

- A `hires_url(sourceUrl)` resolver per host implementing the substitutions in the table.
- A print-area localiser run on a downsampled copy (edge-density / saliency, or a small
  segmentation model), so tiles come from the sheet and not from the mat, frame or backdrop.
  Prerequisite for everything below; Phase 0 used the central 60% and paid for it.
- **Content-stratified tile placement** instead of a grid: (a) flat mid-tone regions —
  aquatint reticulation, mezzotint ground, lithographic tint and halftone screens live here;
  (b) high edge-density regions — line syntax and burr halos; (c) the darkest connected
  regions — massed burr, mezzotint blacks; (d) a band along the print edge for the plate
  mark where it is not matted out. Tiles > 90% paper-white are excluded — they carry the
  photographer's lighting and paper colour and nothing about the process. ~16 tiles per
  image, each tagged with its stratum so attention weights stay interpretable.
- New `DigitalImage` properties: `hiresWidthPixels`, `hiresHeightPixels`, `pxPerMm` (from
  `sheetDimensions`), `resolutionTier`. Tiers: family-level — any px/mm; aquatint / mezzotint
  / drypoint — ≥ 5 px/mm (what Phase 0 worked at); fine-grain confident — ≥ 10 px/mm. Images
  under a floor are excluded from that class, not from family-level classes.
- Streaming, resumable, rate-limited, same `User-Agent` and politeness as the existing
  ingests. No image cache.

### Phase 2 — feature extraction at scale (revised 2026-09-13)

- The encoder, pooling and tile scales are whatever Phase 0b selected. Where the fine scale
  is available it is stored alongside the primary one; where it is not, the head receives a
  learned "absent" token, never an upsampled tile.
- Labelled images first, artist-capped (the trainer caps at 40 per artist–technique anyway),
  so ~50k images rather than 108k. At 16 tiles per image that is ~800k ViT-L forward
  passes — roughly 10–15 h on MPS plus ~75 GB over the wire; a multi-day background job.
- Per-tile vectors are kept (not only the pooled vector) so Phase 4's attention-MIL can be
  trained without re-extracting. Written to a new property (`tileEmbedding` + a small meta
  map recording scale, stratum and px/mm), never to `embedding`.
- Only if Phase 4 plateaus: LoRA fine-tune of the last encoder blocks on tiles, gated on the
  source-institution probe — with one photographer style per source, an adapter can learn the
  camera.

### Phase 3 — label repair

- Collapse naming-only distinctions: Giclée / Inkjet / Pigment / Digital print → one inkjet
  class. Treat the generic `Intaglio` (713) and `Relief printing` (238) labels as
  family-only supervision, not as process classes.
- A **native-resolution halftone / screen detector** on flat-tone tiles (2D-FFT peak-pair
  detection, moiré as the below-Nyquist fallback) audits `Lithograph` vs `Offset lithograph`
  (F1 0.01 today, Bonhams/Roseberys-only): a rosette is physical, periodic and separable from
  every hand process, so the label-quality problem becomes measurable rather than assumed. It
  is the one extra channel this ADR adds; it also becomes a binary feature for the
  photomechanical family. Ink-density, plate-tone and line-profile statistics are explicitly
  *not* added — the first two measure the photographer, the third needs ≥ 15 px/mm.
- Cross-source conflicts (one `ConceptualWork`, two institutions, two techniques) are
  flagged; museum labels outrank auction text.
- An out-of-fold confident-learning pass surfaces probable mislabels for a small review,
  using the Haiku 4.5 vision adjudicator on native-resolution tiles.

### Phase 4 — model and evaluation

- The two-stage family → process design, the artist-grouped split and the **same held-out
  test artists** are kept, so results compare directly to 0.275 / 0.558.
- Heads: MLP on pooled tiles first; gated attention-MIL over per-tile embeddings second —
  drypoint accents and aquatint fields occupy a minority of tiles, mean-pooling dilutes them
  and max-pooling is noisy, and the attention weights say which tile (and which stratum)
  carried the decision, which the adjudicator queue needs.
- px/mm tier and source institution are inputs to the *calibration* layer only, so
  confidence can depend on resolution without the encoder ever seeing the institution.
- F1 is reported per px/mm bucket, and drypoint is reported split by period (pre-/post-1860,
  from `ConceptualWork` dates) and by pure vs etching-combined label. A post-1860 drypoint
  miss is a model error; a pre-1860 one is possibly a worn impression or a label issue and
  goes to the adjudicator queue.
- The source-institution probe is re-run and must drop from 0.907; if it does not, the new
  features have learned the camera again.
- Target: aquatint, drypoint, mezzotint, wood engraving, linocut and offset lithograph clear
  the escalation gate (7 of 21 techniques do today).

### Phase 5 — product implication

`predict_technique.py` receives a user photograph of unknown scale, which cannot be placed
on the px/mm scale at all without sheet dimensions or a ruler in frame. A raking-light
close-up would additionally supply the plate mark and ink relief that no listing photograph
has. Both belong in the Stage 1 capture prompt. This is
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
