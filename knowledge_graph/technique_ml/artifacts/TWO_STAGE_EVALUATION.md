# Two-stage technique classifier — evaluation

Generated 2026-09-07 10:05:03. Stage A names the process family; Stage B names the process within it, but only for techniques that cleared a 0.45 within-family F1 bar on validation. Everything else returns the family and stops.

All numbers are on held-out **artists**, and Stage B runs on Stage A's *predicted* family, so family errors propagate as they would in production.

## Stage A — process family

Artist-balanced macro-F1 **0.558** (flat 21-way model, same fold: 0.298)

| Family | Test images | Test artists | P | R | Artist-bal. F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Intaglio | 2,288 | 490 | 0.74 | 0.67 | 0.69 |
| Planographic | 2,090 | 456 | 0.42 | 0.88 | 0.59 |
| Screen | 1,092 | 177 | 0.49 | 0.62 | 0.56 |
| Photographic | 822 | 238 | 0.80 | 0.91 | 0.88 |
| Relief | 462 | 148 | 0.49 | 0.39 | 0.43 |
| Other | 71 | 35 | 0.15 | 0.18 | 0.21 |

## Stage B — the escalation gate

Within-family F1 on the held-back half of validation, at a threshold chosen on the other half. The bracketed figure is the 20th-percentile bootstrap over artists, and it is what the bar is applied to — a class must clear it even on an unlucky draw. The rest are reachable only as a family.

| Family | Technique | Val. F1, point (bootstrap lower) | Emitted? |
| --- | --- | ---: | :---: |
| Intaglio | Etching | 0.78 (0.77) | yes |
| Intaglio | Engraving | 0.58 (0.55) | yes |
| Intaglio | Aquatint | 0.43 (0.40) | — |
| Intaglio | Photogravure | 0.45 (0.32) | — |
| Intaglio | Mezzotint | 0.33 (0.26) | — |
| Intaglio | Drypoint | 0.25 (0.21) | — |
| Intaglio | Intaglio | 0.18 (0.10) | — |
| Other | Collage | 0.30 (0.21) | — |
| Photographic | Gelatin silver print | 0.81 (0.80) | yes |
| Photographic | Chromogenic print | 0.52 (0.47) | yes |
| Photographic | Platinum print | 0.00 (0.00) | — |
| Photographic | Cibachrome print | too few to judge | — |
| Planographic | Lithograph | 0.91 (0.90) | yes |
| Planographic | Offset lithograph | 0.20 (0.17) | — |
| Planographic | Monotype | 0.07 (0.00) | — |
| Relief | Woodcut | 0.67 (0.62) | yes |
| Relief | Embossing | 0.53 (0.43) | — |
| Relief | Linocut | 0.37 (0.27) | — |
| Relief | Wood engraving | 0.32 (0.20) | — |
| Relief | Letterpress | too few to judge | — |
| Screen | Screenprint / Serigraphy | 0.51 (0.48) | yes |

## End-to-end

- Names a specific technique for **96%** of test images
- When it names one, **65%** of those calls hit a technique the print genuinely uses
- The other 4% return a family only

| Technique | Test images | P | R | Artist-bal. F1 | Flat model F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lithograph | 1,862 | 0.41 | 0.88 | 0.56 | 0.59 |
| Etching | 1,618 | 0.45 | 0.58 | 0.51 | 0.53 |
| Screenprint / Serigraphy | 1,092 | 0.50 | 0.63 | 0.56 | 0.56 |
| Gelatin silver print | 681 | 0.68 | 0.83 | 0.75 | 0.78 |
| Engraving | 274 | 0.44 | 0.71 | 0.54 | 0.52 |
| Woodcut | 220 | 0.37 | 0.39 | 0.38 | 0.37 |
| Chromogenic print | 87 | 0.38 | 0.44 | 0.41 | 0.38 |

## How to read this against the flat model

The flat model's macro-F1 averages over 21 techniques it always answers, including ones it gets right 10% of the time. This one abstains, so its macro-F1 is not comparable — coverage and precision-when-answering are the honest pair. The per-technique table above puts both side by side for the techniques this system is willing to name.
