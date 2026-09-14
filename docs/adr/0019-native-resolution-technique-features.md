# ADR-0019: Technique classification needs native-resolution features, not a bigger head

**Date:** 2026-09-13
**Status:** Proposed → **implemented through Phase 4 on 2026-09-14**: on the 2026-09-07 held-out artists the tile model scores family macro-F1 0.662 (was 0.558) and flat 21-way 0.389 (was 0.275), emitting 13 techniques (was 7). **Corrected 2026-09-14** — the Phase 0/0b drypoint figures were host-confounded; see "Correction and variance" under Phase 4. **Phase 0 gate passed on 2026-09-13** (results below): tiling at a fixed
physical scale is worth +0.09 / +0.15 artist-balanced F1 on aquatint / drypoint over the same
encoder at 518px, and resolution alone is worth nothing. **Amended 2026-09-13** after the
physical-cue research in [`docs/research/intaglio-technique-visual-cues-2026-09-13.md`](../research/intaglio-technique-visual-cues-2026-09-13.md):
a Phase 0b (encoder head-to-head and a finer tile scale, in the existing harness) is inserted
before Phase 1, and Phases 1–4 are revised as marked. **Phase 0b done 2026-09-13**: DINOv3
ViT-L/16 selected — **withdrawn 2026-09-14 in favour of DINOv2-L** (see "Encoder decision, re-made" under Phase 4); CLS pooling kept; fine scale dropped after the pilot.
Phase 1 is next; nothing after 0b is started.

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

#### Phase 0b result (2026-09-13)

`technique_ml/phase0b_encoder_scale_probe.py`, 896 images / 347 artists (three of Phase 0's
899 fail the stricter tile-fit check), 195 with a native ≥ 11.2 px/mm fine scale; native
px/mm buckets 2–4 / 4–7 / 7–11 / >11 hold 137 / 274 / 263 / 203 images.
`artifacts/phase0b_results.json`. Artist-balanced F1 / AP:

| Feature set | DINOv2-L | DINOv2-L + registers | DINOv3 ViT-L/16 |
|---|---|---|---|
| CLS, mean ⊕ max (= Phase 0 F2) — aquatint | 0.630 / 0.692 | **0.680** / 0.643 | 0.653 / 0.667 |
| CLS, mean ⊕ max — drypoint | 0.736 / 0.747 | 0.704 / 0.701 | **0.762 / 0.835** |
| PATCH (orderless patch-token pooling) — aquatint / drypoint | 0.646 / 0.623 · 0.658 / 0.666 | 0.667 / 0.644 · 0.724 / 0.711 | 0.634 / 0.664 · 0.767 / 0.773 |
| CLS+PATCH — aquatint / drypoint | 0.665 / 0.662 · 0.722 / 0.708 | 0.686 / 0.657 · 0.721 / 0.699 | 0.636 / 0.670 · 0.772 / 0.818 |
| CLS+FINE concat — aquatint / drypoint | 0.666 / 0.691 · 0.727 / 0.737 | 0.650 / 0.659 · 0.711 / 0.733 | 0.640 / 0.694 · 0.745 / 0.803 |
| FINE alone, 195-image subset — drypoint | 0.774 / **0.814** | 0.778 / **0.861** | 0.795 / **0.838** |
| CLS alone, same subset — drypoint | 0.703 / 0.678 | 0.746 / 0.715 | 0.771 / 0.772 |

Decisions taken from it:

1. **Encoder: DINOv3 ViT-L/16 for Phase 2.** Best drypoint by a clear margin (AP 0.835 vs
   0.747 for DINOv2-L, +0.09) and level on aquatint; the gram-anchored dense features do
   carry more of the surface signal. Registers on DINOv2 are a wash at CLS level (aquatint
   F1 up, everything else down) and are not adopted on their own — DINOv3 has them anyway.
   Gated checkpoint; `HF_TOKEN` is required wherever Phase 2 runs.
2. **Pooling: CLS per tile.** Orderless patch-token pooling adds nothing on any encoder,
   alone or concatenated. The CLS token is not discarding texture; the question is closed.
3. **The finer scale carries drypoint signal the 40 mm tile lacks.** On the controlled
   195-image subset (same images, same folds), 20 mm tiles beat 40 mm tiles on drypoint AP for
   all three encoders: +0.14, +0.15, +0.07. Aquatint on that subset is noise — small sheets
   are rarely aquatints. **Concatenating the two scales does not capture it** (CLS+FINE is flat
   on the full set) because the fine block is zero for 78% of images and the head learns to
   ignore it. So the fine scale is kept, and Phase 4's head must treat scales separately — a
   fine-scale specialist gated on px/mm, or MIL over tiles tagged with their scale — rather
   than widening the input vector.
4. **The per-bucket curves are descriptive only.** Drypoint F1 rises with native px/mm
   (DINOv3 CLS: 0.54 → 0.61 → 0.85 → 0.82) and aquatint falls (0.70 → 0.71 → 0.58 → 0.44),
   identically across encoders and feature sets — but px/mm is confounded with sheet size and
   source (small plates and Roseberys `xlarge` fill the top buckets), so the curves are not
   evidence of resolution on their own. The subset comparison in (3) is the controlled test.

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

#### Phase 1 result (backfill completed 2026-09-14)

All 107,937 `DigitalImage` nodes carry `hiresUrl`, native pixel dimensions, `pxPerMm` (where
the impression has a catalogue dimension) and `resolutionTier`. Per host:

| Host | Checked | fine (≥10) | process (5–10) | family (<5) | no dims | dead | median px/mm |
|---|---:|---:|---:|---:|---:|---:|---:|
| Bonhams (images2) | 33,097 | 5,154 | 11,907 | 15,287 | 456 | 293 | 5.2 |
| Bonhams (images1) | 20,480 | 3,067 | 7,465 | 8,644 | 1,298 | 6 | 5.3 |
| Roseberys + Forum (S3 `xlarge`) | 20,706 | 5,256 | 9,365 | 3,353 | 2,726 | 6 | 7.5 |
| Pompidou / navigart | 20,938 | 135 | 959 | 17,780 | 2,064 | 0 | 1.9 |
| Tate | 10,208 | 47 | 403 | 9,449 | 309 | 0 | 1.5 |
| British Museum (`mid_`) | 2,507 | 281 | 727 | 1,487 | 12 | 0 | 4.1 |

So 41,770 labelled images sit at ≥ 5 px/mm (the fine-grain tiers), overwhelmingly auction
photography; the museum sources are family-tier almost entirely. The 306 dead links are
Bonhams CDN paths that also fail in the daily embed job. The full Phase 2 manifest
(`export_phase2_manifest.py --min-tier process --artist-cap 40`, all techniques) holds
**28,822 images / 3,498 artists**: fine 8,434 / process 20,388; Bonhams 18,381, Forum 4,526,
Roseberys 3,610, Skinner 729, Tate 444, BM 373, French museums ~750; etching 7,600,
lithograph 6,023, screenprint 4,253, aquatint 3,145, gelatin silver 3,064, drypoint 1,937,
offset lithograph 1,528, woodcut 1,395, engraving 1,176, linocut 635, wood engraving 399,
mezzotint 162. A family-tier manifest (Tate + Pompidou at native scale, for the family head
only) is a separate, later decision.

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

#### Where it runs, and how (added 2026-09-13)

The extraction is latency- and download-bound, not a local job: ~5k pilot images × 16–32
tiles is ~7 h on the M1, ~10 min on a rented A10/A100. It runs on a rented GPU box with
**no graph credentials on the box** — the graph is read and written from the local machine:

```
local:  export_phase2_manifest.py  → phase2_<name>.jsonl    (what to fetch, dims, labels)
box:    extract_tile_embeddings.py → tiles_NNNN.npz shards  (needs only the manifest + HF_TOKEN)
local:  rsync shards back; load_tile_embeddings.py           (pooled vectors onto DigitalImage)
```

Box requirements: any CUDA image with PyTorch ≥ 2.4 (RunPod / Lambda "PyTorch" templates),
1 GPU with ≥ 16 GB (A10G / L4 / A100 all fine — ViT-L fp16 at batch 32 needs ~6 GB), ~20 GB
disk (the model is 1.2 GB, shards are ~64 KB per image), outbound HTTPS to the image hosts
and Hugging Face. Setup and launch, verified 2026-09-13 on MPS with the same scripts:

```bash
# on the box
mkdir -p ~/phase2 && cd ~/phase2
tar xzf phase2_bundle.tar.gz && cd phase2_bundle          # scp'd from local: 4 scripts + manifest
pip install -r requirements-gpu.txt
export HF_TOKEN=hf_...                                    # gated DINOv3 checkpoint
nohup python technique_ml/extract_tile_embeddings.py \
    --manifest phase2_pilot_intaglio.jsonl --out-dir tiles --fetch-threads 8 \
    > extract.log 2>&1 &
tail -f extract.log                                       # ~100-image progress lines, ETA
```

```bash
# back on local, when extract.log says done
rsync -av --progress <box>:~/phase2/phase2_bundle/tiles/ knowledge_graph/technique_ml/data/tiles_pilot/
```

The run is resumable (image ids already in shards are skipped), so a box that dies mid-run
costs at most one 500-image shard. `failures.jsonl` records anything skipped and why.
Per-tile vectors stay in the shards for the Phase 4 attention-MIL head; only the pooled
vectors go into the graph.

#### Pilot run (2026-09-13) — what actually happened

4,959-image intaglio manifest (etching / aquatint / drypoint / engraving / mezzotint at
≥ 5 px/mm, 40 per artist–technique, 782 artists). Result: **4,784 images extracted, 1,515
with the fine scale, 175 excluded** ("print area smaller than one tile" — small prints at the
40 mm scale, not errors). Shards: 301 MB in `technique_ml/data/tiles_pilot/`. Steady-state
**10 img/s** on an RTX 4090 pod; the whole run was 8 minutes of GPU time, total spend under
$2 including the false starts below. Scripts: `runpod_pod.py` (create / wait / terminate over
the REST API), `pod_bootstrap.sh`, `pod_collect.sh`, `pod_cpu_test.py`.

Lessons that are now baked into those scripts, in the order they cost time:

1. **The bottleneck is CPU, not GPU.** Decode of a 4000×5800 WebP is 2.7–3.8 s, the primary
   tiles 1–2.6 s, the fine-scale window statistics 3.7–6.5 s; the GPU encode is negligible.
   Preprocessing runs in a `spawn` process pool created *before* torch loads (forking after
   the encoder is initialised inherits its OpenMP state and the children stall).
   `stratified_tiles()` now uses integral images and a BOX downsample.
2. **RunPod hosts differ enormously in real CPU.** An EU-RO-1 L4 pod advertised 48 vCPUs, had
   a 5.1-core cgroup quota, and delivered **2.7 effective cores ~8× slower than an M1 core** —
   0.3 img/s and unfixable in code. A US-NC-1 RTX 4090 pod: 13.6 effective M1-class cores.
   `pod_bootstrap.sh` measures effective cores and refuses to launch under 6.
3. **SSH key injection is `PUBLIC_KEY`**, not the documented `SSH_PUBLIC_KEY`; the helper
   passes both. The stock image has no `rsync`; collection is a tar stream over SSH.
4. **Copy → verify → terminate are three separate steps.** The first successful run's shards
   were lost because the terminate was chained after a failed copy with `;`. `pod_collect.sh`
   verifies shard shapes, uniqueness and non-empty rows and prints `SAFE-TO-TERMINATE`;
   nothing terminates a pod automatically.
5. The HF token lives in `~/.cache/huggingface/token` (from `huggingface-cli login`), not in
   `.env`; it is streamed to the box over stdin and is the only secret the box ever holds.

For the full-corpus run (~50k images) the same box class gives ~1.5 h; the remaining CPU
cost is the WebP/JPEG decode and the fine-scale statistics, which could be halved with
`pillow-simd`/libvips and by computing the fine-scale window statistics on a downsampled
copy. Not needed for the pilot.

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

#### Phase 4 pilot result (2026-09-13) — `train_tile_head.py`, `artifacts/tile_head_pilot.json`

Multi-label heads over the pilot shards: 4,784 intaglio images, 769 artists, 5-fold
artist-grouped CV, thresholds tuned on held-out training artists. Positives: etching 3,733 /
aquatint 1,518 / drypoint 816 / engraving 614. Artist-balanced F1 / AP:

| Head | Etching | Aquatint | Drypoint | Engraving |
|---|---|---|---|---|
| POOLED: mean ⊕ max of 16 primary tiles → MLP | 0.885 / 0.892 | **0.634 / 0.641** | **0.388 / 0.312** | **0.652 / 0.653** |
| MIL: gated attention over primary tiles | 0.879 / 0.891 | 0.628 / 0.602 | 0.357 / 0.286 | 0.626 / 0.624 |
| MIL+FINE: fine-scale tiles as extra instances with a scale embedding | 0.887 / 0.888 | 0.618 / 0.619 | 0.372 / 0.266 | 0.589 / 0.659 |
| "always yes" F1 at this prevalence | 0.876 | 0.485 | 0.291 | 0.228 |

Source-institution probe on the pooled features: 0.757 against a 0.384 majority baseline over
eight institutions (the old figure, 0.907 / 0.734, was over three, so only the excess is
comparable — and it has grown, not shrunk).

What this says, plainly:

1. **Engraving and aquatint are learned; etching is barely above trivial; drypoint is weak.**
   Engraving at 0.65 F1 on 13% prevalence and aquatint at 0.63 on 32% are real signal.
   Etching at 78% prevalence is nearly the "always yes" answer.
2. **Neither attention-MIL nor the fine scale helped here**, in direct contradiction of the
   Phase 0b subset result for the fine scale. The MIL heads were trained for 40 mini-batch
   epochs at 5e-4 and may be under-trained; that is untested and is the first cheap check.
3. **The tiling pipeline is not to blame.** On the 334 images shared with Phase 0, the same
   head on Phase 0b's central-grid DINOv3 tiles vs the pilot's localised, stratified tiles
   scores aquatint 0.575/0.527 vs 0.612/0.517 and drypoint 0.579/0.542 vs 0.537/0.482 —
   equivalent within noise.
4. **Drypoint's fall from 0.76 to 0.39 is the task framing.** Phase 0 posed a balanced
   etching-only vs drypoint(±etching) question with 300 positives; here drypoint is 17% of a
   multi-label intaglio set, the positives are mostly etching+drypoint accents, and the
   negatives include aquatints and engravings. The research note's expectation — that
   drypoint-as-accent and pre-1860 worn burr carry an irreducible error — applies in full.
   The per-period split the ADR asked for has not been run yet.

Next steps, in the order they are worth doing: (a) MIL with proper training budget and a
learning-rate sweep — cheap, and it decides whether attention is dead or under-fed; (b) a
hierarchical framing for drypoint — pure etching vs etching+drypoint, negatives restricted to
etching-only, which is the question the burr actually answers; (c) the pre-/post-1860 and
pure-vs-combined splits of the drypoint metric; (d) a VLM baseline on the same images with
artist and text removed, to put a number on what a frontier model reads from pixels alone.

#### Phase 4 pilot, second pass (2026-09-13) — head budget, hierarchical framing, composition

Runs on the same shards (`train_tile_head.py --lr/--restrict`; results in
`artifacts/tile_head_e150.json`, `tile_head_mil_lr1e-3.json`, `tile_head_drypoint_hier.json`,
`tile_head_aquatint_hier.json`):

| Run | Head | Result |
|---|---|---|
| A: 150 epochs (vs 40) | pooled / MIL / MIL+fine | unchanged: aquatint AP 0.652 / 0.613 / 0.619, drypoint 0.297 / 0.279 / 0.278 |
| B: MIL, 150 epochs, lr 1e-3 | MIL | unchanged: aquatint 0.603, drypoint 0.291 |
| C: hierarchical drypoint — images labelled only etching and/or drypoint, 2,551 imgs, 25% positive | pooled / MIL | F1 0.445 / 0.367, AP 0.415 / 0.366 |
| D: hierarchical aquatint — etching and/or aquatint, 3,244 imgs, 41% positive | pooled / MIL | F1 0.681 / 0.689, AP 0.727 / 0.670 |

**Attention-MIL is not under-trained; it does not help.** Four times the budget and a higher
learning rate leave it level with or below mean ⊕ max on every class and both framings. The
fine scale as extra instances likewise. Both are dropped from the Phase 4 design until a new
reason appears.

**The framing helps drypoint only slightly, and the Phase 0/0b level does not reproduce.** The
composition test (Phase 0's own head, etching/drypoint-only images from the pilot shards)
isolates the reasons, read as AP relative to prevalence because F1 is not comparable across
class balances ("always yes" scores 0.67 on a balanced set and 0.29 at 17%):

| Drypoint set-up | n | prev. | AP | AP ÷ prev. |
|---|---:|---:|---:|---:|
| Phase 0b DINOv3 grid tiles, ≤5/artist, Bonhams+Roseberys | 896 | 0.33 | 0.835 | **2.5×** |
| pilot tiles, same recipe (≤5/artist, B+R, balanced) | 446 | 0.50 | 0.723 | 1.45× |
| all institutions, ≤5/artist, balanced | 552 | 0.50 | 0.617 | 1.23× |
| B+R, ≤40/artist, natural balance | 1,561 | 0.22 | 0.453 | 2.06× |
| all institutions, ≤40/artist, natural | 2,476 | 0.23 | 0.412 | 1.8× |
| run C (pooled) | 2,551 | 0.25 | 0.415 | 1.66× |
| the 334 images shared with Phase 0, either tiling | 334 | 0.33 | ~0.51 | 1.5× |

Every pilot configuration sits at 1.5–2.1× prevalence; Phase 0b's 2.5× is not reached by any
of them, including the one that copies its recipe on the same images. The drypoint signal is
real and modest, and the Phase 0b figure was most likely the favourable end of run-to-run
variance — which nothing so far has measured. **Fold-level variance (and a bootstrap over
artists) is the next thing to add to every number in this ADR before any further design
decision is taken on drypoint.** Aquatint is steadier: 1.8× prevalence under the hierarchical
framing, 0.68 F1 at 41%.

Design state after the pilot: pooled mean ⊕ max of stratified 40 mm DINOv3 tiles into a small
MLP, per family; drypoint and aquatint posed hierarchically within intaglio; no MIL, no fine
scale, no hand-crafted channels. Etching-as-a-class is dropped (78% prevalent, trivially
predicted); it is the intaglio default that the other processes are detected against.

#### Correction and variance (2026-09-14) — the Phase 0/0b drypoint figures were host-confounded

Adding fold-level variance and an artist bootstrap (`train_tile_head.py --n-boot`,
`artifacts/*_var.json`, `phase0b_variance.json`) to every number, and reporting
**artist-weighted AUROC** — the only statistic comparable across class balances (F1 and AP both
depend on prevalence, which is why the earlier "AP ÷ prevalence" comparison was also unsound) —
led to the following.

**1. The Phase 0 sample was institution-confounded.** Its sampler put Roseberys first and took
up to 300 per class; Roseberys had 306 etching-only lots and ~30 drypoints, so the sample came
out etching-only 83% Roseberys / drypoint 92% Bonhams. Host identity alone ranks drypoint
against etching-only at AUROC 0.860 on that sample. The source-institution probe that would have
caught this was not run on the Phase 0 sample. Aquatint was far less skewed (177 / 123; host
alone 0.62), which is why every aquatint number reproduced and every drypoint number did not.

**2. Within host, the Phase 0 claims survive with smaller magnitudes** (AUROC, positives vs
etching-only negatives, DINOv2-L features):

| Features | Drypoint pooled (confounded) | Drypoint within Bonhams / Roseberys | Aquatint within Bonhams / Roseberys |
|---|---|---|---|
| F0 stored 224 px whole | 0.686 | 0.573 / 0.586 | 0.739 / 0.677 |
| F1 518 px whole | 0.711 | 0.602 / 0.652 | 0.749 / 0.684 |
| F2 tiles at 40 mm | 0.842 | 0.683 / 0.748 | 0.815 / 0.756 |

Tiling at a fixed physical scale remains the main effect (+0.10–0.16 AUROC over the stored
embedding within host); the 518 px whole image is worth a little (+0.03–0.07), not nothing; and
the true drypoint level on these features is ~0.7–0.75, not the 0.84 the confounded pooling
showed. Phase 0b's DINOv3 drypoint AUROC of 0.925 ± 0.022 is 0.778 / 0.773 within host — the
same as the pilot's 0.785–0.790 on mixed institutions. **DINOv3's selection over DINOv2 was
made on confounded drypoint numbers and stands only on aquatint (0.829 vs 0.848, i.e. no
advantage) and engraving (untested in 0b).** It is not reversed here, because the pilot shards
are DINOv3 and re-extraction is cheap, but the choice is open again and should be re-run with
DINOv2-L on the pilot manifest before the full-corpus extraction.

**3. Pilot numbers with intervals** (folds mean ± SD; artist-bootstrap 5–95%; pooled MLP):

| Task | F1 | AP | AUROC |
|---|---|---|---|
| 4-way: aquatint | 0.633 ± 0.039 | 0.651 ± 0.090 [0.59–0.69] | 0.833 ± 0.026 [0.81–0.85] |
| 4-way: drypoint | 0.369 ± 0.113 | 0.338 ± 0.118 [0.25–0.38] | 0.785 ± 0.062 [0.77–0.83] |
| 4-way: engraving | 0.649 ± 0.045 | 0.670 ± 0.093 [0.56–0.74] | 0.893 ± 0.037 [0.87–0.92] |
| 4-way: etching | 0.885 ± 0.026 | 0.892 ± 0.033 | 0.738 ± 0.020 [0.70–0.77] |
| hierarchical drypoint (etching-only negatives) | 0.451 ± 0.043 [0.38–0.52] | 0.461 ± 0.092 [0.36–0.51] | 0.790 ± 0.045 [0.75–0.83] |
| hierarchical aquatint | 0.686 ± 0.016 [0.65–0.72] | 0.727 ± 0.029 [0.68–0.76] | 0.822 ± 0.023 [0.80–0.84] |

Everything in this ADR before this section that quotes a drypoint F1 or AP from Phase 0 or 0b
should be read through this correction. The design decisions that rested only on aquatint and
on within-host effects (tiling at physical scale; CLS pooling; no hand-crafted channels; no
MIL; no fine-scale concatenation) stand. The decisions that rested on the confounded drypoint
figures (the size of the tiling effect, DINOv3 over DINOv2, the fine-scale subset result) are
reopened and must be re-measured on the pilot manifest with a class × institution cross-tab
and the source probe reported alongside.

#### Encoder decision, re-made on clean evidence (2026-09-14) — DINOv2-L

DINOv2-L tile shards were extracted for the same 4,959-image pilot manifest
(`data/tiles_pilot_dinov2/`, RTX A6000 pod, ~$0.30) and scored with the same pooled head,
folds and intervals as the DINOv3 shards (`artifacts/enc_dinov2_*.json`, `enc_dinov3_*.json`).
The class × institution cross-tab is balanced for every class (no institution owns a class;
e.g. drypoint positives Bonhams 311 / Forum 270 / Roseberys 81 against proportional negatives).

| AUROC, pooled MLP | DINOv3 ViT-L/16 | DINOv2-L |
|---|---|---|
| Aquatint, 4-way / hierarchical | 0.833 ± 0.026 / 0.822 ± 0.023 | 0.839 ± 0.033 / 0.824 ± 0.018 |
| Drypoint, 4-way / hierarchical | 0.785 ± 0.062 / 0.790 ± 0.045 | 0.787 ± 0.052 / 0.793 ± 0.019 |
| Engraving, 4-way | 0.893 ± 0.037 | 0.873 ± 0.028 |
| Source-institution probe (majority 0.384) | 0.757 | **0.630** |

The two encoders tie on every technique within a fold-SD. DINOv2-L's features are markedly
less institution-identifiable (0.63 vs 0.76 against the same 0.38 majority), it is ungated and
Apache-2.0, and it is the encoder the ACKG already uses for Stage 1d. **Phase 2's encoder is
DINOv2-L**; the Phase 0b selection of DINOv3 rested on the host-confounded drypoint figure and
is withdrawn. The DINOv3 shards are kept for reference only.

#### Full-corpus two-stage model (2026-09-14) — the comparable numbers

`train_two_stage_tiles.py` on `data/tiles_full/` (28,127 images extracted from the 28,822-image
manifest at ≥ 5 px/mm; DINOv2-L, 16 stratified 40 mm tiles, mean ⊕ max pooled; 3.5 GB;
$1.60 of GPU). Scored on the **2026-09-07 model's own held-out artists** — 637 of its 1,244
test artists have images at ≥ 5 px/mm, giving 4,587 test images; train 18,172 images / 2,096
artists (the old train fold plus 1,307 artists ingested since); labels the same 21 techniques.
`artifacts/two_stage_tiles.json`. Artist-balanced, single split as in the original protocol.

| | 2026-09-07 (stored 224 px embedding) | Tile features (this ADR) |
|---|---|---|
| Family macro-F1 (6 families) | 0.558 | **0.662** |
| Flat 21-way macro-F1 | 0.275 | **0.389** |
| Techniques passing the escalation gate | 7 / 21 | **13 / 21** |

Stage A per family (F1 / AUROC): Photographic 0.93 / 0.99, Intaglio 0.81 / 0.91, Planographic
0.65 / 0.89, Screen 0.63 / 0.95, Relief 0.58 / 0.89, Other (collage) 0.37 / 0.84.

Stage B, within-family test F1 / AUROC for the emitted techniques: etching 0.82 / 0.78,
engraving 0.62 / 0.84, aquatint 0.59 / 0.80, photogravure 0.67 / 0.98 (n=47), gelatin silver
0.93 / 0.91, lithograph 0.93 / 0.81, woodcut 0.80 / 0.85, wood engraving 0.77 / 0.95, linocut
0.56 / 0.92, letterpress 0.75 / 0.94 (n=24), embossing 0.57 / 0.94 (n=26), screenprint via
Stage A. Not emitted: drypoint (gate 0.41 vs bar 0.45; test 0.38 / 0.79), mezzotint (n=24),
monotype, platinum, chromogenic, collage.

Read with these cautions:

- **Offset lithograph passed the gate (0.50) and scored 0.29 on test** — the gate false-pass the
  original evaluation warned about, at the class the ADR already flags as a label problem. It
  should be treated as not emitted until the Phase 3 halftone audit fixes its labels.
- Several newly emitted relief/intaglio techniques rest on small test counts (24–80 images);
  their gate passes are real but their F1s carry wide intervals. Artist-bootstrap intervals on
  this split are the next addition.
- The test images are the held-out artists' images at ≥ 5 px/mm, not the identical image set
  the 2026-09-07 model was scored on; the artists are the same, the resolution filter is new.

Net: on the same held-out artists, native-resolution tiles lift the family model by +0.10
macro-F1 and the flat 21-way model by +0.11, and nearly double the number of processes the
system is entitled to name. Drypoint remains a family-level answer, as the research note
predicted for accent-only, worn-burr labels.

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
