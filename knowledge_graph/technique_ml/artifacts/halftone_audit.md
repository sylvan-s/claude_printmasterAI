# Halftone-screen audit — Lithograph vs Offset lithograph (2026-09-14)

500 images at ≥7.0 px/mm (sheet basis), 250 sampled per label; score = spectral peakiness of the best native-resolution tile (log-ratio, MAD units).

- artist-weighted AUROC of `score_max` for Offset vs Lithograph labels: **0.708**
- artist-weighted AUROC of `score_top3` for Offset vs Lithograph labels: **0.681**
- artist-weighted AUROC of `frac_tiles_screened` for Offset vs Lithograph labels: **0.566**
- `Lithograph`: score_max median 4.3, p10 0.0, p90 6.6; share with a ≥2-direction screen (score ≥ 8): 5%
- `Offset lithograph`: score_max median 5.3, p10 0.0, p90 8.8; share with a ≥2-direction screen (score ≥ 8): 15%

## `Lithograph`-labelled images with a regular screen (13) — candidates for relabelling as offset / photolithograph
| score | peaks | lpi est. | px/mm | institution | artist | image |
|---:|---:|---:|---:|---|---|---|
| 13.55 | 2 | 67 | 7.2 | Bonhams | Josef Albers | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:255215 |
| 11.47 | 3 | 64 | 19.69 | Roseberys London | Zao Wou-Ki | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:183390 |
| 11.16 | 3 | 61 | 17.01 | Roseberys London | Jean Dubuffet | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:190463 |
| 11.13 | 3 | 64 | 17.83 | Bonhams | Richard Diebenkorn | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:403931 |
| 10.35 | 2 | 73 | 15.67 | Roseberys London | Laurence Stephen Lowry | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:187581 |
| 10.15 | 3 | 62 | 22.95 | Roseberys London | Tracey Emin | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:186853 |
| 9.5 | 3 | 62 | 10.52 | Roseberys London | Terry Frost | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:188936 |
| 9.02 | 3 | 77 | 13.63 | Forum Auctions | John Currin | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:175627 |
| 8.64 | 3 | 62 | 14.97 | Roseberys London | Diego Rivera | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:189192 |
| 8.52 | 3 | 68 | 18.66 | Forum Auctions | Keith Haring | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:179505 |
| 8.4 | 2 | 65 | 10.09 | Roseberys London | Ronald Brooks Kitaj | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:186954 |
| 8.4 | 3 | 64 | 11.39 | Forum Auctions | Joan Miró | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:173616 |
| 8.23 | 2 | 70 | 28.39 | Bonhams | Henri de Toulouse-Lautrec | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:412064 |

## `Offset lithograph`-labelled images with NO screen at ≥ 9 px/mm (92) — possibly hand-drawn, or screen finer than resolved
| score | peaks | px/mm | institution | artist | image |
|---:|---:|---:|---|---|---|
| 0.0 | 0 | 9.2 | Forum Auctions | Keith Haring | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:173368 |
| 0.0 | 0 | 9.2 | Forum Auctions | Keith Haring | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:176053 |
| 0.0 | 2 | 9.36 | Bonhams | George Grosz | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:263052 |
| 0.0 | 2 | 11.47 | Roseberys London | Ronald Searle | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:186635 |
| 0.0 | 0 | 9.2 | Forum Auctions | Keith Haring | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:175160 |
| 0.0 | 0 | 9.04 | Forum Auctions | Jasper Johns | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:176173 |
| 0.0 | 0 | 11.0 | Forum Auctions | Fernando Botero | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:180219 |
| 0.0 | 1 | 12.58 | Bonhams | Frank Stella | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:452980 |
| 0.0 | 0 | 10.55 | Bonhams | George Condo | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:281641 |
| 0.0 | 0 | 17.98 | Forum Auctions | Stik | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:171656 |
| 0.0 | 2 | 11.47 | Roseberys London | Ronald Searle | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:188413 |
| 0.0 | 0 | 9.04 | Forum Auctions | Jasper Johns | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:180022 |
| 0.0 | 0 | 9.51 | Roseberys London | Banksy | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:186137 |
| 0.0 | 0 | 10.4 | Roseberys London | Andy Warhol | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:185734 |
| 0.0 | 0 | 16.37 | Forum Auctions | Stik | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:176377 |
| 0.0 | 0 | 12.7 | Roseberys London | Yoshitomo Nara | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:187222 |
| 0.0 | 0 | 32.9 | Bonhams | Jean-Michel Basquiat | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:471675 |
| 0.0 | 0 | 9.04 | Forum Auctions | Jasper Johns | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:175230 |
| 0.0 | 0 | 57.14 | Forum Auctions | Gerhard Richter | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:175269 |
| 0.0 | 0 | 12.7 | Roseberys London | Yoshitomo Nara | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:188562 |
| 0.0 | 0 | 17.28 | Forum Auctions | Andy Warhol | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:178775 |
| 0.0 | 0 | 10.06 | Bonhams | Pablo Picasso | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:343463 |
| 0.0 | 0 | 13.08 | Roseberys London | Richard Wentworth | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:186638 |
| 0.0 | 0 | 9.52 | Forum Auctions | David Hockney | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:173179 |
| 0.0 | 0 | 13.0 | Bonhams | Andy Warhol | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:454780 |
| 0.0 | 0 | 9.6 | Forum Auctions | Stik | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:175388 |
| 4.01 | 2 | 9.01 | Forum Auctions | Jasper Johns | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:176172 |
| 4.21 | 2 | 10.87 | Bonhams | Andy Warhol | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:454836 |
| 4.23 | 2 | 19.33 | Bonhams | Christo and Jeanne-Claude | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:485523 |
| 4.3 | 2 | 10.0 | Roseberys London | Yayoi Kusama | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:187863 |
| 4.43 | 3 | 9.48 | Forum Auctions | John Piper | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:176694 |
| 4.45 | 3 | 13.35 | Bonhams | Andy Warhol | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:276452 |
| 4.53 | 3 | 18.95 | Bonhams | Peter Blake | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:433465 |
| 4.58 | 3 | 9.04 | Forum Auctions | Jasper Johns | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:175431 |
| 4.8 | 3 | 9.73 | Bonhams | Horto Van Houtteano | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:384951 |
| 4.84 | 2 | 9.43 | Roseberys London | Keith Haring | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:187163 |
| 4.93 | 2 | 10.43 | Bonhams | Robert Rauschenberg | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:505467 |
| 4.94 | 3 | 13.04 | Bonhams | George Condo | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:276000 |
| 5.0 | 2 | 20.53 | Bonhams | Küchel & Dresel | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:423983 |
| 5.06 | 2 | 19.73 | Bonhams | Ed Ruscha | 4:eaa66e5f-3fe5-4d49-84cf-90d071e71cbc:508235 |

## Conclusion (after inspecting the crops)

Three detector iterations were needed before the flags meant anything: the first fired on
flat colour (an almost empty spectrum makes JPEG block harmonics look like peaks — and
picking each image's best tile selected exactly those), the second on paper texture and
tusche grain; the third requires a 2-D lattice (two peaks of similar radius ~90° apart) in a
mid-tone or dark tile with real high-frequency energy. Under that test:

| score threshold | `Lithograph` (250) | `Offset lithograph` (250) | what the crops show at that score |
|---|---:|---:|---|
| ≥ 8 (loose) | 13 | 38 | grain, paper texture, fine flat-ink speckle — not screens |
| ≥ 12 | 1 | 7 | mixed |
| ≥ 15 | **0** | **1** | an unmistakable CMYK dot screen |

At listing-photo resolution (median 9 px/mm here) a halftone is visibly detectable only when
it is coarse and well photographed — one image in 250. Two things follow:

1. **The physical test cannot audit the `Offset lithograph` label at this resolution.** A
   133–175 lpi screen at 9 px/mm is 1.6–2 px per dot, below what survives JPEG; and most
   auction "offset lithographs" are flat-ink posters and reproductions with no tonal
   halftone at all, so absence of a screen is not evidence of hand lithography either.
2. **`Lithograph` vs `Offset lithograph` is not a pixel question for these images.** The
   label is about the press; solid offset ink and solid stone-litho ink photograph alike.
   For the classifier the two should be merged into one planographic class, with "offset"
   kept as a catalogue attribute; a strong lattice detection (score ≥ 15) can be surfaced as
   positive *photomechanical* evidence when it occurs, never as a training label.

This closes the gate false-pass in the tile model: the emitted `Offset lithograph` (test F1
0.29) is withdrawn, and the class is merged for Phase 4.
