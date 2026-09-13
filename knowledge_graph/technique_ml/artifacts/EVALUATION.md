# Printmaking-technique classifier — evaluation report

Generated 2026-09-07 00:29:01 · model `mlp` on 44,487 DINOv2-Large embeddings (3,966 artists, 21 techniques)

## Headline

| Metric | Value |
| --- | --- |
| **Artist-balanced macro-F1 (held-out artists)** | **0.298** |
| Macro-F1 | 0.275 |
| Micro-F1 | 0.481 |
| Artist-balanced macro average precision | 0.283 |
| Exact set match | 0.233 |
| Test images / artists | 6,650 / 1,244 |

## How much of that is artist memorisation

The same head on a conventional image-level random split scores **0.579** macro-F1 against **0.275** on held-out artists — a +0.304 gap. That difference is the shortcut: it is what the model gains from having seen the same artist (often the same work) in training, and it is the number a naively-evaluated version of this model would have reported.

## Source confound

An identical head predicts the source institution from the same embeddings with **0.907** accuracy (majority baseline 0.734). Techniques below that appear from only one institution are therefore partly scored on studio style, not process:

- `Chromogenic print` — Bonhams only
- `Cibachrome print` — Bonhams only
- `Gelatin silver print` — Bonhams only
- `Offset lithograph` — Bonhams only
- `Platinum print` — Bonhams only

## Per-technique (held-out artists)

| Technique | Test images | Test artists | P | R | F1 | Artist-bal. F1 | Artist-bal. AP | Thr. |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Lithograph | 1,862 | 436 | 0.43 | 0.78 | 0.55 | 0.59 | 0.62 | 0.44 |
| Etching | 1,618 | 321 | 0.56 | 0.59 | 0.58 | 0.53 | 0.54 | 0.58 |
| Screenprint / Serigraphy | 1,092 | 177 | 0.47 | 0.65 | 0.55 | 0.56 | 0.58 | 0.63 |
| Gelatin silver print ⚠ | 681 | 175 | 0.72 | 0.90 | 0.80 | 0.78 | 0.84 | 0.67 |
| Aquatint | 680 | 163 | 0.23 | 0.22 | 0.23 | 0.19 | 0.18 | 0.65 |
| Drypoint | 323 | 66 | 0.18 | 0.31 | 0.23 | 0.17 | 0.10 | 0.68 |
| Engraving | 274 | 105 | 0.37 | 0.70 | 0.48 | 0.52 | 0.53 | 0.71 |
| Woodcut | 220 | 81 | 0.26 | 0.32 | 0.29 | 0.37 | 0.33 | 0.80 |
| Offset lithograph ⚠ | 188 | 11 | 0.02 | 0.01 | 0.01 | 0.00 | 0.00 | 0.77 |
| Linocut | 134 | 23 | 0.63 | 0.35 | 0.45 | 0.20 | 0.20 | 0.73 |
| Intaglio | 94 | 29 | 0.12 | 0.36 | 0.18 | 0.17 | 0.11 | 0.57 |
| Chromogenic print ⚠ | 87 | 48 | 0.16 | 0.54 | 0.25 | 0.38 | 0.31 | 0.40 |
| Collage | 71 | 35 | 0.09 | 0.24 | 0.13 | 0.18 | 0.20 | 0.34 |
| Mezzotint | 71 | 43 | 0.38 | 0.28 | 0.32 | 0.51 | 0.43 | 0.68 |
| Wood engraving | 64 | 21 | 0.15 | 0.33 | 0.20 | 0.20 | 0.20 | 0.48 |
| Monotype | 42 | 23 | 0.08 | 0.24 | 0.12 | 0.27 | 0.22 | 0.67 |
| Photogravure | 40 | 15 | 0.12 | 0.15 | 0.13 | 0.18 | 0.07 | 0.42 |
| Embossing | 39 | 20 | 0.19 | 0.08 | 0.11 | 0.21 | 0.14 | 0.60 |
| Platinum print ⚠ | 31 | 14 | 0.05 | 0.10 | 0.06 | 0.10 | 0.12 | 0.44 |
| Letterpress | 27 | 23 | 0.07 | 0.19 | 0.10 | 0.15 | 0.16 | 0.29 |
| Cibachrome print ⚠ | 25 | 15 | 0.00 | 0.00 | 0.00 | 0.00 | 0.05 | 0.66 |

## What is actually usable

6 of 21 techniques clear an artist-balanced F1 of 0.40 on unseen artists. These are the only classes worth acting on downstream; the rest are reported for completeness and should be treated as no-signal:

- **Lithograph** — F1 0.59 (1,862 test images, 436 artists)
- **Etching** — F1 0.53 (1,618 test images, 321 artists)
- **Screenprint / Serigraphy** — F1 0.56 (1,092 test images, 177 artists)
- **Gelatin silver print** — F1 0.78 (681 test images, 175 artists)
- **Engraving** — F1 0.52 (274 test images, 105 artists)
- **Mezzotint** — F1 0.51 (71 test images, 43 artists)

## Can it see plate texture?

Restricted to the 1,618 test images already labelled Etching, where the only thing separating the classes below is fine surface grain rather than the print's overall look:

| Secondary process | Positives | Base rate | Avg. precision | Lift |
| --- | ---: | ---: | ---: | ---: |
| Aquatint | 505 | 0.280 | 0.500 | 1.79x |
| Drypoint | 148 | 0.084 | 0.130 | 1.55x |

## Per-institution macro-F1 (test fold)

| Institution | Test images | Techniques scored | Macro-F1 |
| --- | ---: | ---: | ---: |
| Bonhams | 4,883 | 21 | 0.271 |
| British Museum | 75 | 4 | 0.465 |
| Tate | 1,692 | 12 | 0.311 |

## Techniques excluded from the label space

Below the 150-image floor — too few images to split across three folds and still leave a testable number of held-out artists:

Pigment print (130), Collotype (129), Relief printing (83), Inkjet print (64), Photolithograph (40), Digital print (35), Giclée (32), Photomechanical print (30), Chine-collé (21), Photorelief (5), Stencil printing (2)

## Configuration

```json
{
  "data": "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/knowledge_graph/technique_ml/data/dataset.npz",
  "out_dir": "/Users/sylvansitkey/PycharmProjects/claude_printmasterAI/knowledge_graph/technique_ml/artifacts",
  "model": "mlp",
  "min_class_count": 150,
  "per_artist_cap": 40,
  "artist_weight_alpha": 0.5,
  "hidden": 512,
  "dropout": 0.3,
  "lr": 0.001,
  "weight_decay": 0.0001,
  "batch_size": 256,
  "epochs": 60,
  "patience": 8,
  "max_pos_weight": 20.0,
  "seed": 13,
  "compare_random_split": true
}
```
