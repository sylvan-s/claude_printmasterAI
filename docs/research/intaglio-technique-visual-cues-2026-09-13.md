# Intaglio technique cues in photographs: physical scale, resolvability, and what to extract beyond DINOv2 tiles

**Date:** 2026-09-13
**Status:** Research note. Input to [ADR-0019](../adr/0019-native-resolution-technique-features.md) Phases 1–4.
Read alongside `knowledge_graph/technique_ml/artifacts/phase0_results.json`.

**Question.** (1) What physically distinguishes drypoint from etching, and the intaglio processes from each
other, *as seen in a flat-lit photograph of the impression*, at what scale in millimetres, and hence at what
px/mm? (2) Which feature-extraction methods beyond DINOv2 tile embeddings at ~5.6 px/mm could plausibly add
signal, and what would each cost to test?

Access note: the Met "Printed Image in the West" essays and the MoMA glossary rate-limited every fetch
(HTTP 429/403) during this session; two numeric claims below are marked *(snippet)* because they were
recovered from search-engine excerpts of those pages rather than from the page itself. Graphics Atlas
(IPI) is JavaScript-only and its identification text could not be read. Griffiths' *Prints and
Printmaking* is borrow-only on archive.org; it is not quoted.

---

## Summary

- **Drypoint vs etching is a sub-millimetre problem.** The only thing that physically separates a drypoint
  line from an etched one is the *burr* — a ragged ridge of displaced metal that holds a film of ink and
  prints as a soft, velvety halo around the line ([Tate](https://www.tate.org.uk/art/art-terms/d/drypoint),
  [MoMA](https://www.moma.org/collection/terms/drypoint), [V&A](https://www.vam.ac.uk/articles/what-is-print)).
  The halo lives at roughly 0.1–0.5 mm (an estimate; no conservation paper measuring printed burr width was
  found). An etched line is "of the same width along [its] length" with blunt, rounded ends; a burin line has
  clean edges, pointed ends and swells ([CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/),
  [History of Cartography v.3 ch.22, fig. 22.8](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf)).
  Line widths are ~0.1–0.5 mm: a burin cuts a groove "200 micrometers in width" ([Print Clock](http://www.printclock.org/));
  Hedges measured 16th-century map-plate grooves across a 0–500 µm range ([Hedges 2008](http://www.hedgeslab.org/pubs/200.pdf)).
- **At 5.6 px/mm none of these line-level cues is resolved.** A 0.2 mm line is ~1 px; a 0.3 mm burr halo is
  under 2 px of soft gradient. What the tile encoder is using at that scale is the *aggregate* texture:
  velvety dark masses with soft boundaries, the density and freedom of the line network, and the granularity of
  tone areas. That is consistent with Phase 0 (drypoint +0.15, aquatint +0.09 over 518px whole-image) and it
  predicts that going finer helps — **the drypoint/etching cue itself needs ≥ 10 px/mm to be seen as a
  gradient and ≥ 20 px/mm to be characterised**. Roseberys `xlarge` (4000 px) and small Bonhams sheets already
  reach 10–20 px/mm; Tate (600 px) and Pompidou (1000 px) never will.
- **Aquatint and mezzotint are texture-statistics problems and are partly resolvable.** Aquatint grain
  particles are tens of µm (modern stochastic aquatint screens are sold at 31/40/84 µm dots;
  [Rittagraf](https://www.rittagraf.com/en/aquatint-screen-for-photogravure-fine-grain.html)), hand-ground
  rosin is coarser and mixed; the printed reticulation is at ~0.05–0.3 mm (estimate). Mezzotint rockers are
  45–100 lines per inch, i.e. a 0.25–0.56 mm tooth pitch ([E C Lyons](https://eclyons.com/index.php?main_page=index&cPath=12),
  [Conrad](https://www.conradmachine.com/mezzotint-rockers/)). Mezzotint pitch is at Nyquist at ~4–8 px/mm;
  aquatint cells are aliased at 5.6 px/mm but still leave a characteristic noise texture — which is why
  aquatint gained less than drypoint in Phase 0 and why the hand-crafted radial FFT bands added nothing (see §4).
- **Burr wear is real, fast and confounding.** An unfaced drypoint yields "20 or 30 impressions"
  ([Béguin](https://www.polymetaal.nl/beguin/maps/steelfacing.htm)); the Met puts it at "no more than a dozen"
  good ones *(snippet)*; steel-facing (patented 1857) raises that to 300–500. So post-1857 editioned drypoints
  keep their burr across the edition, while late impressions of old-master drypoints look like etchings. The
  label "drypoint" therefore has an irreducible visual error floor on old-master lots, and the classifier's
  drypoint recall should be reported separately for pre- and post-1860 works.
- **Ink relief and the plate mark are not photograph cues.** Intaglio ink stands ~20 µm proud of the sheet
  with ~20 µm of embossing ([banknote intaglio metrology](https://www.researchgate.net/publication/282327575_Intaglio_Quality_Measurement));
  this is visible in raking light or RTI, not in a flat-lit listing photograph. The plate mark (a 1–3 mm bevel
  indentation) is sometimes visible as a faint edge but is routinely hidden by mats and frames.
- **For Part 2:** the highest-value additions are (i) a print-area localiser plus content-stratified tile
  placement, (ii) a second, finer tile scale (~16–20 mm at 11–14 px/mm) where the source resolution supports
  it, (iii) attention-MIL over tiles, (iv) a drop-in swap to DINOv2-with-registers or DINOv3 ViT-L/16, and
  (v) a native-resolution halftone/screen detector as an audit channel. Line-profile descriptors, ink-density
  and plate-tone statistics, MAE, pathology models and multi-image/raking-light cues are not worth testing on
  flat-lit single listing photographs at 5.6 px/mm.

---

## 1. Cue table

Nyquist rule used throughout: *detecting* a feature of size *s* mm needs ≥ 2/*s* px/mm; *characterising its
shape* (profile, ends, halo gradient) needs ≥ 4–5 px across it, i.e. ≥ 4/*s* to 5/*s* px/mm.
"Listing photo" = single flat-lit auction photograph of a framed or matted sheet, JPEG, 600–4000 px on the
long side, 2.5–20 px/mm depending on host and sheet size (ADR-0019 table).

| # | Cue | Technique(s) it separates | Physical scale (mm) | Source for scale | px/mm to detect / characterise | Visible in a flat-lit listing photo? | Status |
|---|---|---|---|---|---|---|---|
| 1 | Burr halo: soft, velvety ink film either side of the line core | drypoint vs etching/engraving; fresh vs worn impression | halo ~0.1–0.5 beyond the core (**estimate**; burr ridge is a "sliver of copper about the thickness of dental floss" for a burin — [Print Clock](http://www.printclock.org/)) | Tate, MoMA, V&A (qualitative); no measured width found | ≥ 5–10 / ≥ 20 | As a gradient: no at 5.6, marginal at 10+. As aggregate "velvety black masses with soft edges" where burr is dense: yes | Conservation fact that burr exists and holds ink; the halo width is unmeasured |
| 2 | Line width uniformity | etching (uniform) vs engraving (swelling/tapering) | line widths ~0.1–0.5; burin groove ~0.2; swelling varies over mm–cm lengths | [Print Clock](http://www.printclock.org/), [Hedges 2008 fig. 6](http://www.hedgeslab.org/pubs/200.pdf), [CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/), [Tate engraving](https://www.tate.org.uk/art/art-terms/e/engraving) | width itself ≥ 10 / ≥ 20; *swelling along the line* is a mm-scale feature and is visible at 5 | Swelling: yes (as varying line darkness). Width: no | Settled connoisseurship, corroborated by microscopy (CHSOS, HOC fig. 22.8) |
| 3 | Line-end morphology | etching (blunt/rounded ends) vs engraving (tapered/pointed) vs drypoint (ragged) | end taper ~0.2–1.0 long, ~0.1–0.2 wide | [HOC v.3 ch.22 fig. 22.8](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf), [CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/) | ≥ 20 / ≥ 40 | No | Connoisseurship convention, corroborated under magnification |
| 4 | Line freedom / hatching syntax (loose, curved, sketch-like vs regular parallel and lozenge cross-hatch) | etching vs engraving (family-level) | 0.5–3 mm hatch spacing; cm-scale strokes | [HOC ch.22](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf) (Ivins/Panofsky syntax), [Wellcome/Gascoigne](https://docs.wellcomecollection.org/visual-and-material-culture-cataloguing/pre-cataloguing/about/untitled) | ≥ 1 / ≥ 3 | Yes | Connoisseurship; strongest macro cue and the one the 224px model already uses |
| 5 | Plate tone / surface tone (ink film left on the plate surface) | intaglio (any) vs planographic/relief; early vs later impressions; wiping style | cm-scale veil; no fine structure | [Rijksmuseum, *Three Crosses*](https://www.rijksmuseum.nl/en/collection/object/De-drie-kruisen--7b9320dad7806437d71325eb4044f1dd) ("met plaattoon"); Hinterding on surface tone from c.1647 | any | Yes, but confounded with paper tone, exposure and white balance | Fact that it exists; its reading is connoisseurship and inking-, not technique-, specific |
| 6 | Aquatint grain: "granular pattern of tiny indented rings" printing as a reticulated tone | aquatint vs wash-like tones (lavis, litho tusche, mezzotint) | rosin particles ~10–20 µm (low-trust source), stochastic screens 31/40/84 µm; hand-ground grain coarser and mixed; printed cells ~0.05–0.3 (**estimate**) | [Tate](https://www.tate.org.uk/art/art-terms/a/aquatint), [NGV Goya](https://www.ngv.vic.gov.au/custom/goya/index.php?chapter=9), [Rittagraf](https://www.rittagraf.com/en/aquatint-screen-for-photogravure-fine-grain.html) | individual cells ≥ 10–20 / ≥ 40; *statistical granularity* detectable at ~5 as aliased noise | Grain: no. Flat matte granular tone vs line-built tone: yes | Grain mechanism is conservation fact; the printed cell size is an estimate |
| 7 | Mezzotint rocked ground: dense multi-directional pits/burrs, burnished to lights | mezzotint vs aquatint vs stipple | rocker 45–100 lpi → 0.25–0.56 pitch; burnished gradients over mm–cm | [E C Lyons](https://eclyons.com/index.php?main_page=index&cPath=12), [Renaissance Graphic Arts](https://www.renaissancegraphics.com/product/mezzotint-rocker-1-100-teeth-per-inch/), [Tate](https://www.tate.org.uk/art/art-terms/m/mezzotint) | pitch ≥ 4–8 / ≥ 10–20 | Pitch: marginal at 5.6, yes at 10. Continuous dark-to-light tone with no line and velvety black: yes | Fact |
| 8 | Plate mark (bevelled plate edge embossed into the sheet) | intaglio vs everything else | 1–3 mm bevel; runs the full plate perimeter | [V&A](https://www.vam.ac.uk/articles/what-is-print), [HOC ch.22](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf), [Wellcome/Gascoigne](https://docs.wellcomecollection.org/visual-and-material-culture-cataloguing/pre-cataloguing/about/untitled) | ≥ 1 | Sometimes, as a faint tonal edge; usually hidden by the mat/frame; needs raking light or RTI to be reliable | Fact |
| 9 | Ink relief (ink standing proud; embossing) | intaglio vs planographic | ~20 µm ink + ~20 µm embossing ≈ 40 µm relief (banknote intaglio) | [Intaglio Quality Measurement](https://www.researchgate.net/publication/282327575_Intaglio_Quality_Measurement), [CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/), [HOC ch.22](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf) | not a resolution question — a lighting question | No | Fact; RTI "documents embossing better than raking light" |
| 10 | Burr wear across an edition (early vs late impression) | early/late; drypoint → looks like etching when worn | same scale as #1, diminishing | [Rijksmuseum](https://www.rijksmuseum.nl/en/collection/object/De-drie-kruisen--7b9320dad7806437d71325eb4044f1dd), [Béguin](https://www.polymetaal.nl/beguin/maps/steelfacing.htm), Met *(snippet)* | as #1 | Only as global richness; confounded with inking, paper, exposure | Fact that it happens; the counts are convention |
| 11 | Line thinning across editions (engraved lines thin faster than etched) | dating; early vs late | groove widths 0–500 µm shrink with each polishing | [Hedges 2008](http://www.hedgeslab.org/pubs/200.pdf), [Hedges 2006 Proc R Soc A](https://royalsocietypublishing.org/rspa/article-abstract/462/2076/3555/82024/A-method-for-dating-early-books-and-prints-using) | ≥ 20 | No | Measured conservation science (ocular-micrometer groove widths) |
| 12 | Steel-facing | none visually; it *prevents* #10 after 1857 | n/a | [Béguin](https://www.polymetaal.nl/beguin/maps/steelfacing.htm) | n/a | No — a catalogue-text fact, not a visual cue | Fact |
| 13 | Halftone screen / rosette | photomechanical (offset litho, halftone relief, rotogravure) vs hand processes and hand-pulled photogravure | 85–300 lpi → 0.30–0.085 pitch; newsprint ~85 lpi | [Wikipedia LPI](https://en.wikipedia.org/wiki/Lines_per_inch), [photogravure.com](https://photogravure.com/identification-guide/) | 85 lpi: ≥ 7; 150 lpi: ≥ 12; 300 lpi: ≥ 24. Below Nyquist the screen aliases into **moiré**, which is itself detectable | Coarse screens and moiré: often yes. Fine screens: no | Fact; standard descreening-literature methods exist |

### What the px/mm numbers mean for the corpus

| Source | px/mm (typical 235–500 mm sheets) | Cues resolvable |
|---|---|---|
| Bonhams 2880px | 5–8 (up to ~14 for a 200 mm sheet) | #4, #5, #6-statistical, #7-marginal, #13-coarse; #1 marginal on small sheets |
| Roseberys `xlarge` 4000px | ~10 (up to ~20 for a 200 mm sheet) | adds #1 (gradient), #7 (pitch), #13 (150 lpi); #2/#3 only on small sheets |
| Pompidou 1000px | ~2–4 | #4, #5 only — family-level |
| Tate 600px | ~2.5 | #4, #5 only — family-level |
| British Museum `mid_` 1000px | ~3–4 | #4, #5 only |

The corpus therefore splits into a *family-tier* (all sources) and a *fine-grain tier* (Bonhams + Roseberys,
and within them the smaller sheets), which is the per-image px/mm floor ADR-0019 Phase 1 already proposes.

---

## 2. Technique by technique

### 2.1 Drypoint

- **Mechanism.** "A diamond-pointed needle is used to incise lines directly into a bare metal printing plate,
  displacing ridges of metal that adhere to the edges of the incised lines. This displaced metal is called
  burr. Inking fills the incised lines and clings to the burr" — the result is "a characteristically fuzzy
  line" ([MoMA](https://www.moma.org/collection/terms/drypoint)). Tate: "a slightly raised ragged rough edge to
  the lines, known as the burr … the burr receive[s] ink when the plate is wiped, giving the printed line a
  distinctive velvety look" ([Tate](https://www.tate.org.uk/art/art-terms/d/drypoint)). V&A: "the burr is not
  polished away … the lines of a drypoint print have a soft blurred quality" ([V&A](https://www.vam.ac.uk/articles/what-is-print)).
- **Scale.** Nobody publishes a measured printed-halo width. Reasoning from the plate: the burin's displaced
  curl is "about the thickness of dental floss" ([Print Clock](http://www.printclock.org/)), i.e. ~0.1–0.2 mm,
  and the drypoint ridge is of the same order; the ink film it holds spreads under press pressure, so a printed
  halo of ~0.1–0.5 mm either side of a ~0.1–0.2 mm core is the working estimate. Where lines are massed
  (Rembrandt's late plates), the halos merge into velvety black fields with soft boundaries — that is a
  mm-to-cm feature and it *is* visible at 5.6 px/mm.
- **Wear.** "The burr, which gives drypoint lines such a sumptuous velvety look, wears away quickly"; on the
  *Three Crosses* the plate "became increasingly lighter" and Rembrandt "made areas of shadow darker again with
  extra lines" ([Rijksmuseum](https://www.rijksmuseum.nl/en/collection/object/De-drie-kruisen--7b9320dad7806437d71325eb4044f1dd)).
  Counts are convention, not measurement: "no more than a dozen" good impressions (Met essay, *snippet*);
  "20 or 30 impressions" unfaced vs "300 to 500 impressions" steel-faced ([Béguin](https://www.polymetaal.nl/beguin/maps/steelfacing.htm));
  Tate: editions stop "before the burr is crushed by the pressure of the intaglio press".
- **Steel-facing.** "A plating process in which a copper plate is covered by a thin coat of iron by means of an
  electroplating procedure … invented by Salmon and Garner who took out a patent for it in 1857"
  ([Béguin](https://www.polymetaal.nl/beguin/maps/steelfacing.htm)). Consequence for the classifier: a
  20th-century editioned drypoint (most of the Bonhams/Roseberys drypoint lots) shows fresh burr on every
  impression; an old-master "drypoint" lot may show almost none.
- **Combination labels.** "Etching and drypoint" means a plate etched for the structure and drypoint added for
  accents; the drypoint evidence is then *local* (a few passages), which is the case for attention-MIL rather
  than mean-pooling (§4, row G).

### 2.2 Etching

- **Line character.** "Etching uses a rounded needle that passing through the wax ground give[s] a more blunt
  end to the line than the engraving tool … Etched line[s] will be of the same width along their length, while
  the burin gives swelling shapes" ([CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/)).
  The History of Cartography's fig. 22.8 makes the same comparison on 1570s Venetian maps: with "a rounded
  stylus … the short hatching marks representing the water exhibit rounded ends. In contrast, the example at
  the bottom has been engraved with a burin, as can be seen from the tapered ends of the lines"
  ([HOC v.3 ch.22](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf)). Tate:
  "Stronger acid and longer exposure produce deeper lines" ([Tate](https://www.tate.org.uk/art/art-terms/e/etching)),
  so within one plate line *darkness* varies by biting stage, not by hand pressure.
- **Scale.** Groove widths on 16th-century plates run 0–500 µm (Hedges' ocular-micrometer measurements,
  [fig. 6](http://www.hedgeslab.org/pubs/200.pdf)); a fine modern etching needle is at the low end. At 5.6 px/mm
  every etched line is a sub-pixel, anti-aliased grey streak whose grey value is a confounded product of width
  × ink density × biting depth — there is no way to read "uniform width" from it. Line *ends* need ≥ 20 px/mm.
- **Durability.** Zonca (17th c.): a copperplate yields "one thousand impressions, the maximum with retouching
  two thousand. For etching … five hundred as a minimum and one thousand as a maximum" ([HOC ch.22](https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf)).
  Hedges showed that "engraved lines were thinning faster than etched lines" because "engraved and etched
  grooves both are tapered, meaning that shallower grooves are necessarily thinner" as the plate is polished
  between runs ([Hedges 2008](http://www.hedgeslab.org/pubs/200.pdf)). This is measured conservation science
  and it is a *dating* signal, not a technique signal; it needs ≥ 20 px/mm.
- **What separates etching from drypoint in a listing photo** is therefore not the line but the *absence* of
  soft, velvety mass and the presence of an open, sketch-like line network with crisp ends at the aggregate
  scale (cue #4). That is a weak, artist-style-confounded cue, which is exactly the 0.25 F1 the old model had.

### 2.3 Engraving

- "The burin makes incisions into the metal at various angles and with varying pressure which dictates the
  quantity of ink the line can hold – hence variations in width and darkness when printed"
  ([Tate](https://www.tate.org.uk/art/art-terms/e/engraving)). The line "has clean edges, tends to be pointed
  at each end and to swell or diminish during its length" ([CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/)).
  Burin: "2 mm wide" tool, "triangular-shaped groove (200 micrometers in width, or one-fifth of a millimeter)"
  ([Print Clock](http://www.printclock.org/)). The engraver's burr is scraped off, so no halo.
- The swelling/tapering, the regularity of parallel hatching and the lozenge cross-hatch are mm–cm
  features and survive 5.6 px/mm; the clean edge and pointed ends do not.

### 2.4 Aquatint (and etching + aquatint)

- "Fine acid-resistant particles, typically powdered rosin, are heated onto a printing plate. When immersed in
  acid, the metal around these particles erodes, produc[ing] a granular pattern of tiny indented rings. Longer
  periods produce more deeply-bitten rings, which print darker areas of tone" ([Tate](https://www.tate.org.uk/art/art-terms/a/aquatint)).
- **Scale.** The NGV conservation study of Goya's plates: "the coarser the grain the larger the pits, and the
  finer the smaller the pits"; Goya "used different sized grains in the same print" — *Disparate de miedo* has
  "larger white dots randomly dispersed in the sky region that look like stars which were caused by larger
  granules" ([NGV](https://www.ngv.vic.gov.au/custom/goya/index.php?chapter=9)). No peer-reviewed measurement
  of printed cell size was found. Anchors: rosin powder "typically 10–20 microns" (a study-guide site — low
  trust); modern stochastic aquatint screens for photogravure at "31 micron", "40 micron" and "84 micron" dots
  ([Rittagraf](https://www.rittagraf.com/en/aquatint-screen-for-photogravure-fine-grain.html)); hand-ground and
  bag-sifted rosin is coarser and polydisperse. The printed reticulation cell (the ring of ink around each
  protected speck, merging with its neighbours) is therefore plausibly ~0.05–0.3 mm. **Estimate; treat as such.**
- **Wear.** "The ridges around the depressed pits of aquatint are vulnerable to wear as more impressions are
  pulled"; a worn aquatint shows "a mottled, indistinct appearance rather than a reticulated tonal appearance"
  ([NGV](https://www.ngv.vic.gov.au/custom/goya/index.php?chapter=9)). Late impressions therefore lose the very
  texture we want.
- **In a listing photo** at 5.6 px/mm the cells are 0.3–1.7 px: aliased, but a field of aliased grain is still
  a distinctive high-frequency noise field, different from the smooth wash of a lithographic tint or the
  directional pits of a mezzotint. That is a statistical cue the ViT patch grid can pick up if the tile is
  placed on a flat mid-tone region — and it is lost if the tile straddles line work or the mat.

### 2.5 Mezzotint

- Made "by rocking a toothed metal tool across the surface" then "burnishing the rough surface to various
  degrees of smoothness to reduce the ink-holding capacity" ([Tate](https://www.tate.org.uk/art/art-terms/m/mezzotint));
  the fully rocked plate "will print a deep even black" ([V&A](https://www.vam.ac.uk/articles/what-is-print)).
- **Scale.** Rockers are sold at 45 (coarse), 65/85 (medium) and 100 (fine) lines per inch
  ([E C Lyons](https://eclyons.com/index.php?main_page=index&cPath=12), [Conrad](https://www.conradmachine.com/mezzotint-rockers/),
  [Renaissance Graphic Arts](https://www.renaissancegraphics.com/product/mezzotint-rocker-1-100-teeth-per-inch/)),
  i.e. a tooth pitch of 0.56–0.25 mm, rocked in many directions so the ground is isotropic. Nyquist for the
  pitch is 4–8 px/mm; 10–20 px/mm to see individual pits.
- **Wear.** "Each plate will render only a small number of truly first-rate impressions … the earliest
  impressions are the finest and print very dark" (NPG *Early history of mezzotint*, *snippet*; page blocked).
- **In a listing photo** mezzotint's macro signature (continuous tone, no line, deep velvety blacks, lights
  scraped out of dark) is the most photograph-robust of all the intaglio cues, which is why mezzotint is
  among the classes the ADR expects to clear the gate.

### 2.6 Cross-cutting: plate mark, ink relief, plate tone

- Plate mark: "The pressure exerted by the press results in an outline of the metal plate itself being
  impressed into the paper" ([V&A](https://www.vam.ac.uk/articles/what-is-print)); Gascoigne's first
  decision question is "Does the image have a plate-mark? Are there depressed edges around image?"
  ([Wellcome](https://docs.wellcomecollection.org/visual-and-material-culture-cataloguing/pre-cataloguing/about/untitled)).
  In hand it is decisive; in a listing photograph the sheet is matted to the image or the plate mark is
  a faint tonal edge that a flat-lit JPEG barely records.
- Ink relief: "In strong dark lines the ink considerably rises up from the paper"; "RTI (Reflectance
  Transformation Imaging) allows to document embossing better than raking light"
  ([CHSOS](https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/)).
  Industrial intaglio metrology gives ~20 µm ink + ~20 µm embossing ([Intaglio Quality Measurement](https://www.researchgate.net/publication/282327575_Intaglio_Quality_Measurement)).
  Not a single-photo cue.
- Plate tone: Rembrandt's *Three Crosses* impression is catalogued "droge naald en burijn, met plaattoon"
  ([Rijksmuseum](https://www.rijksmuseum.nl/en/collection/object/De-drie-kruisen--7b9320dad7806437d71325eb4044f1dd));
  Hinterding dates Rembrandt's use of surface tone to c.1647 onward and only in some impressions. It is an
  *inking* choice present on intaglio of every process, so it is at best a family cue, and in a photograph
  it is indistinguishable from warm paper, a warm lamp or a cautious exposure.

---

## 3. Settled fact vs convention — one line each

| Claim | Status |
|---|---|
| Burr exists, holds ink, prints soft; wears under press pressure | conservation fact (Tate, MoMA, V&A, Rijksmuseum, NGV) |
| Impression counts before burr is lost (a dozen / 20–30 / 300–500 faced) | convention; figures vary by source and by plate |
| Etched lines uniform width, blunt ends; burin lines swell, pointed ends | connoisseurship, corroborated by microscopy on dated examples (CHSOS, HOC fig. 22.8) |
| Engraved lines thin faster than etched across editions; cause is polishing, not press compression | measured (Hedges 2006/2008) |
| Burin groove ~200 µm | single stated figure (Print Clock); consistent with Hedges' 0–500 µm measurements |
| Aquatint pits scale with grain size; worn aquatint goes mottled | conservation observation (NGV) |
| Printed aquatint cell 0.05–0.3 mm; burr halo 0.1–0.5 mm | **this note's estimates** — no measured source found |
| Mezzotint pitch 0.25–0.56 mm | tool specification (manufacturers) |
| Halftone 85–300 lpi | industry standard |
| Ink relief ~40 µm | industrial intaglio (banknote) metrology; fine-art values unmeasured here |

---

## 4. Part 2 — feature extraction beyond DINOv2 tiles

Baseline: DINOv2-L CLS per 224 px tile at ~5.6 px/mm (≈ 40 mm per tile, 2.5 mm per 14 px patch),
mean ⊕ max pooled; Phase 0 F2 = aquatint 0.655 / drypoint 0.710 artist-balanced F1.

| Row | Method | Cue(s) targeted | Plausibly adds signal over DINOv2 tiles at 5.6 px/mm from flat-lit photos? | Cost to test | Verdict |
|---|---|---|---|---|---|
| A | Edge / line-profile descriptors: ridge detection (Steger/Frangi), line-width histogram, edge-sharpness, endpoint curvature | #1, #2, #3 | **No at 5.6 px/mm** — lines are sub-pixel; the anti-aliased grey value conflates width, ink density and biting depth. Only defensible on the ≥ 15 px/mm subset (Roseberys `xlarge`, small Bonhams sheets), where it is untested | 1–2 days classical CV; run on the ≥ 15 px/mm subset only | Skip for the main pipeline; optional probe on the high-px/mm subset once the localiser exists |
| B | Frequency-domain grain analysis (2D FFT / angular + radial spectra, autocorrelation) | #6, #7, #13 | **Why the Phase 0 radial bands failed**: (1) no print-area localisation — mat, frame and backdrop tiles dominated; (2) scale mixing — bands were taken *after* resampling to 5.6 px/mm, putting aquatint cells (0.3–1.7 px) at or above Nyquist where they alias into broadband noise indistinguishable from paper texture and JPEG quantisation; (3) JPEG 8×8 blocks inject energy at pixel-fixed frequencies that shift with the resampling factor; (4) radial bands discard orientation, but orientation is the discriminant (isotropic mezzotint/aquatint vs directional etched/engraved hatching); (5) no masking of line work, so the drawing's spectrum swamped the grain's. Done properly — native resolution, flat mid-tone regions only, angular anisotropy, JPEG-aware — it could add a little for mezzotint/aquatint at ≥ 8 px/mm | 1–2 days | Modest; build it as the *audit* channel the ADR already proposes, not as a headline feature |
| C | Ink-density and plate-tone statistics (paper-white estimate, image-area luminance distribution, veil) | #5 | **No** — the statistic measures the photographer as much as the printer (exposure, white balance, paper); plate tone is an inking choice across all intaglio; risk of re-learning the 0.907 source-institution probe | 0.5 day | Skip |
| D | Halftone / rosette / screen detection: 2D FFT peak-pair detection or MIN/MAX peak counting on flat-tone regions at *native* resolution (methods as in [US7365882B2](https://patents.google.com/patent/US7365882B2/en), [US6734991B1](https://patents.google.com/patent/US6734991B1/en)); moiré detection as a fallback below Nyquist | #13 | **Yes** — physical, periodic, and separable from every hand process; coarse screens and moiré are visible even at 5–7 px/mm. Photogravure.com's loupe rule (random grain vs regular screen at 8–15×) is exactly a spectral-peak test | 1–2 days; validate on `Offset lithograph` vs `Lithograph` and on known halftone reproductions | Do it — as the Phase 3 label-audit channel first, and as a binary feature for the photomechanical family |
| E | Multi-image / raking-light / RTI cues | #8, #9 | **Unavailable** — Bonhams has one `listing_photo` per impression; Roseberys/Pompidou/Tate likewise flat-lit. RTI "documents embossing better than raking light" ([CHSOS](https://chsopensource.org/reflectance-transformation-imaging-rti/)) but needs a light dome | n/a | Not from the corpus. For Phase 5, ask the user for one raking-light close-up; the noise-robustness run already showed defocus is the expensive degradation |
| F1 | DINOv2-L **with registers** (`facebook/dinov2-with-registers-large`, Apache 2.0) or test-time registers | all | **Small but nearly free.** Registers remove "high-norm tokens appearing … primarily in low-informative background areas" ([Darcet et al.](https://arxiv.org/abs/2309.16588)) — background being exactly mat/paper tiles; matters most if we pool patch tokens or use attention over patches; CLS-level classification gains are not claimed. A training-free variant exists ([test-time registers](https://arxiv.org/abs/2506.08010)) | 0.5 day (checkpoint swap in the Phase 0 harness) | Do it |
| F2 | **DINOv3 ViT-L/16** (`facebook/dinov3-vitl16-pretrain-lvd1689m`, distilled from ViT-7B, 4 registers, 1024-d; [paper](https://arxiv.org/abs/2508.10104), [model card](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m)) | all, esp. #6/#7 texture | **Most promising drop-in.** Gram anchoring targets "dense feature maps degrading during long training", i.e. local/texture fidelity, which is what grain and burr are. Patch 16 at 224 px gives 14×14 patches — use 256 px tiles (16×16) to keep the tile at 40 mm, or keep 224 and accept 2.9 mm patches. License permits research with attribution; commercial use allowed under the DINOv3 License (non-commercial scope applies to us anyway) | 1 day (re-run F1/F2 in the Phase 0 harness) | Do it, head-to-head with F1 |
| F3 | CLIP / SigLIP 2 (incl. NaFlex native-aspect variant; [paper](https://arxiv.org/abs/2502.14786)) | all | **Unlikely to beat DINO.** Weakly-supervised features are semantic; on DTD textures OpenCLIP-G scores 86.0 vs DINOv2-L 84.0 / g 84.5 (linear probe, [DINOv2 Table 8](https://arxiv.org/html/2304.07193v2)), so not worse on textures per se, but the artwork-classification literature finds the DINO family stronger ([SSL for art classification](https://arxiv.org/abs/2605.18974)). NaFlex's native aspect ratio is irrelevant for square tiles | 1 day | Optional; run only if the harness makes it free |
| F4 | Pathology / microscopy foundation models (UNI, UNI2 — DINOv2 ViT-L trained on H&E; [UNI](https://github.com/mahmoodlab/UNI)) | #6, #7 | **No** — domain-specific to stained tissue; no reason to transfer to ink on paper. **But the *recipe* is the right analogue**: tiles at a fixed physical scale (µm-per-pixel normalisation is standard in pathology) + attention-MIL over tiles ([CLAM](https://www.nature.com/articles/s41551-020-00682-w)). ADR-0019 is already following it | 0 | Skip the models, keep the recipe |
| F5 | MAE | all | **No** — weaker linear-probe features than DINO ([MAE](https://arxiv.org/abs/2111.06377)); would need fine-tuning to be competitive | — | Skip |
| F6 | Texture-specific descriptors on top of the backbone: Fisher-vector / GeM pooling over DINO patch tokens instead of CLS | #6, #7 | **Plausible, cheap.** Texture recognition "does not require long-range dependencies … most of the relevant information is compacted within a delimited area around each pixel" ([deep filter banks](https://arxiv.org/abs/2605.27843)); orderless pooling of patch tokens is the ViT analogue and discards the layout the CLS token encodes | 0.5 day (same forward passes, different pooling) | Try alongside F1/F2 |
| G | Attention-MIL over per-tile embeddings (gated attention, [Ilse et al. 2018](https://arxiv.org/abs/1802.04712); [CLAM](https://www.nature.com/articles/s41551-020-00682-w)) | #1 (localised burr in etching+drypoint), #6 (flat-tone tiles only) | **Yes, modest.** Drypoint accents and aquatint fields occupy a minority of tiles; mean-pooling dilutes them and max-pooling is noisy. Attention weights also give the interpretability the Haiku adjudicator pass needs (which tile carried the decision) | 1–2 days on cached tile embeddings | Do it (already Phase 4) |
| H | Light fine-tuning: LoRA on the last DINO blocks on tiles | all | **Plausible after G plateaus.** Analogue: LoRA on DINOv2 reaches 99.0 % on 394 fine-grained font classes "training only 1 % of the model's 87.2M parameters" ([GoogleFontsBench](https://arxiv.org/abs/2602.13889)) — glyph-shape detail is a similar sub-pixel-to-few-pixel regime. Risk: with one photographer style per source, the adapter learns the camera; the source-institution probe must be re-run | 2–3 days on M1 MPS with cached tiles (ViT-L, batch 8–16, mixed precision) | Later, gated on the probe |
| I | Second, finer tile scale (~16–20 mm at 11–14 px/mm) where the source resolution allows, no upsampling | #1, #6, #7 | **Yes — this is the direct test of §1.** If drypoint F1 rises with px/mm the halo is being read; if it is flat, the model is using macro cues and finer tiles are wasted | 1 day inside the Phase 0 harness (Roseberys `xlarge` subset) | Do it first |
| J | Print-area localiser + content-stratified tile placement | all | **Yes — prerequisite** for B, D, G and I; Phase 0 used the central 60 % with no localiser, so mat and frame tiles entered as noise and grain tiles were placed at random relative to tone areas | 1–2 days (saliency/edge-density or a small segmentation model on a downsampled copy) | Do it first (Phase 1) |

---

## 5. Implications for ADR-0019

Concretely, for the Phase 1–4 design:

1. **Tile scale.** Keep the 40 mm / ~5.6 px/mm tile as the *primary* scale — it is validated and it is what
   every source can supply at the family level. Add a **secondary fine scale of ~16–20 mm per 224 px tile
   (11–14 px/mm)** computed only for images whose native px/mm ≥ 11 (Roseberys `xlarge`; Bonhams sheets
   ≤ ~260 mm on the long side). Never upsample to reach it. Store which scales an image has; the head
   receives the fine-scale pooled vector or a learned "absent" token.
2. **px/mm floors per class** (Phase 1's `resolutionTier`): family-level — any; aquatint/mezzotint/drypoint
   — ≥ 5 px/mm (empirically what Phase 0 worked at); "fine-grain confident" tier — ≥ 10 px/mm. Report Phase 4
   F1 **per px/mm bucket** (2–4, 4–7, 7–11, > 11); a monotone rise in drypoint F1 is the physics in §1 being
   confirmed, a flat curve means the model is reading macro cues and the fine scale can be dropped.
3. **Tile placement.** Localise the print area first (on a downsampled copy), then sample tiles
   *stratified by content* rather than on a grid: (a) flat mid-tone regions (aquatint reticulation, mezzotint
   ground, lithographic tint, halftone screen live here); (b) high edge-density regions (line syntax, burr
   halos); (c) the darkest connected regions (massed burr, mezzotint blacks, plate tone); (d) a band along
   the print edge (plate mark, when not matted out). Exclude tiles that are > 90 % paper-white — they carry
   the photographer's lighting and paper colour and nothing about the process. Keep the tile count at ~16 but
   record the stratum of each tile so attention weights are interpretable.
4. **Pooling / head.** Replace mean ⊕ max with gated attention-MIL over tiles (G), and evaluate orderless
   pooling of patch tokens (F6) as the per-tile vector alongside CLS.
5. **Encoder.** Re-run the Phase 0 harness with (i) DINOv2-L with registers and (ii) DINOv3 ViT-L/16 before
   Phase 2's multi-day extraction, so the 800k forward passes are spent on the winner. Both are checkpoint
   swaps; DINOv3 needs 256 px tiles or an accepted 2.9 mm patch.
6. **Extra channels.** Add exactly one: a native-resolution halftone/screen detector on flat-tone regions
   (D), used first as the Phase 3 audit of `Lithograph` vs `Offset lithograph` and then as a binary feature
   for the photomechanical family. Drop the Laplacian/radial-FFT statistics (confirmed null in Phase 0, and
   §4 row B explains why). Do **not** add ink-density, plate-tone or line-profile statistics.
7. **Metadata to the head, not the encoder.** Feed px/mm tier and source as inputs to the *calibration*
   layer only, so confidence can depend on resolution without the encoder learning the institution; keep the
   source-institution probe as the gate (must fall from 0.907).
8. **Label semantics.** Expect an irreducible drypoint error on pre-1860 lots (worn burr, §2.1) and on
   etching + drypoint combinations where drypoint is an accent. Split drypoint metrics by period
   (pre-/post-1860, from `ConceptualWork` dates) and by pure vs combined label; treat a post-1860 "drypoint"
   miss as a model error and a pre-1860 one as possibly a label/impression issue for the adjudicator queue.
9. **Phase 5.** A user photograph of unknown scale cannot be placed on the px/mm scale at all without sheet
   dimensions or a ruler in frame; a raking-light close-up would add the plate mark and ink relief (#8, #9)
   that no listing photo has. Both belong in the Stage 1 capture prompt.

---

## 6. Sources

Museum / curatorial

- Tate, *Drypoint* — https://www.tate.org.uk/art/art-terms/d/drypoint
- Tate, *Aquatint* — https://www.tate.org.uk/art/art-terms/a/aquatint
- Tate, *Mezzotint* — https://www.tate.org.uk/art/art-terms/m/mezzotint
- Tate, *Etching* — https://www.tate.org.uk/art/art-terms/e/etching
- Tate, *Engraving* — https://www.tate.org.uk/art/art-terms/e/engraving
- MoMA, *Drypoint* (art term) — https://www.moma.org/collection/terms/drypoint
- V&A, *What is print?* — https://www.vam.ac.uk/articles/what-is-print
- Rijksmuseum, Rembrandt, *De drie kruisen* (drypoint and burin, with plate tone) — https://www.rijksmuseum.nl/en/collection/object/De-drie-kruisen--7b9320dad7806437d71325eb4044f1dd
- The Met, *The Printed Image in the West: Drypoint* (rate-limited; "no more than a dozen" via search snippet) — https://www.metmuseum.org/essays/the-printed-image-in-the-west-drypoint
- National Portrait Gallery, *The early mezzotint* (blocked; impression-count claim via snippet) — https://www.npg.org.uk/collections/research/programmes/early-history-of-mezzotint/the-early-mezzotint
- NGV, *Impossible Monsters — the materials and techniques of Goya's intaglio prints*, ch. 9 (aquatint) — https://www.ngv.vic.gov.au/custom/goya/index.php?chapter=9
- Wellcome Collection cataloguing guide, *Identifying prints* (Gascoigne-derived decision questions) — https://docs.wellcomecollection.org/visual-and-material-culture-cataloguing/pre-cataloguing/about/untitled
- Bamber Gascoigne, *How to Identify Prints*, 2nd ed., Thames & Hudson 2004 (not online; cited via Wellcome) — https://books.google.com/books/about/How_to_Identify_Prints.html?id=DlVfQgAACAAJ

Technical / conservation science

- David Woodward, "Techniques of Map Engraving, Printing, and Coloring in the European Renaissance", *History of Cartography* vol. 3 pt 1, ch. 22 (fig. 22.8 etching vs engraving line ends; Zonca's impression counts; plate-mark and ink relief) — https://press.uchicago.edu/sites/hoc/HOC_V3_Pt1/HOC_VOLUME3_Part1_chapter22.pdf
- S. Blair Hedges, "A method for dating early books and prints using image analysis", *Proc. R. Soc. A* 462 (2006) 3555–3573 — https://royalsocietypublishing.org/rspa/article-abstract/462/2076/3555/82024/A-method-for-dating-early-books-and-prints-using
- S. Blair Hedges, "Dating Old Maps with the Print Clock", *The Portolan* (Fall 2008) — groove widths 0–500 µm, engraved thin faster than etched — http://www.hedgeslab.org/pubs/200.pdf
- Print Clock project site (burin 2 mm; groove 200 µm) — http://www.printclock.org/
- CHSOS, *Identify Prints: Relief, Intaglio, Engraving and Etching* (USB microscopy; RTI vs raking light) — https://chsopensource.org/identification-of-prints-relief-and-intaglio-by-engraving-and-etching/
- CHSOS, *Reflectance Transformation Imaging* — https://chsopensource.org/reflectance-transformation-imaging-rti/
- AIC Conservation Wiki, *Reflectance Transformation Imaging (RTI)* — https://conservation-wiki.com/wiki/Reflectance_Transformation_Imaging_(RTI)
- Béguin, *Steelfacing* (Salmon & Garner 1857; 20–30 vs 300–500 impressions) — https://www.polymetaal.nl/beguin/maps/steelfacing.htm
- *Intaglio Quality Measurement* (banknote intaglio: ~20 µm ink + ~20 µm embossing) — https://www.researchgate.net/publication/282327575_Intaglio_Quality_Measurement
- Photogravure.com, *Identification Guide* (8–15× loupe; random grain vs screen) — https://photogravure.com/identification-guide/
- E C Lyons, mezzotint rockers (45/65/85/100 lpi) — https://eclyons.com/index.php?main_page=index&cPath=12
- Conrad Machine Co., mezzotint rockers — https://www.conradmachine.com/mezzotint-rockers/
- Renaissance Graphic Arts, 100 tpi rocker — https://www.renaissancegraphics.com/product/mezzotint-rocker-1-100-teeth-per-inch/
- Rittagraf, stochastic aquatint screens (31/40/84 µm dots) — https://www.rittagraf.com/en/aquatint-screen-for-photogravure-fine-grain.html
- StudyGuides, aquatint materials (rosin 10–20 µm; **low trust**) — https://studyguides.com/study-methods/overview/cmp6eqbnvt2w401neo1u54cib
- Wikipedia, *Lines per inch* (85 lpi newsprint; up to 300 lpi) — https://en.wikipedia.org/wiki/Lines_per_inch
- US7365882B2, halftone screen frequency and magnitude estimation — https://patents.google.com/patent/US7365882B2/en
- US6734991B1, halftone line frequency estimation by MIN/MAX detection — https://patents.google.com/patent/US6734991B1/en
- Graphics Atlas (IPI) — identification pages are JavaScript-only; not readable this session — http://www.graphicsatlas.org/identification/

ML methods

- Oquab et al., *DINOv2: Learning Robust Visual Features without Supervision* (Table 8 DTD; patch 14; 518 px end-of-training) — https://arxiv.org/abs/2304.07193 / https://arxiv.org/html/2304.07193v2
- Darcet et al., *Vision Transformers Need Registers*, ICLR 2024 — https://arxiv.org/abs/2309.16588
- `facebook/dinov2-with-registers-large` model card (Apache 2.0) — https://huggingface.co/facebook/dinov2-with-registers-large
- Jiang et al., *Vision Transformers Don't Need Trained Registers* (test-time registers) — https://arxiv.org/abs/2506.08010
- Siméoni et al., *DINOv3* (gram anchoring) — https://arxiv.org/abs/2508.10104
- `facebook/dinov3-vitl16-pretrain-lvd1689m` model card (patch 16, 1024-d, 4 registers, distilled from ViT-7B) — https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m ; license — https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m/blob/main/LICENSE.md
- Tschannen et al., *SigLIP 2* (NaFlex; dense features) — https://arxiv.org/abs/2502.14786
- He et al., *Masked Autoencoders Are Scalable Vision Learners* — https://arxiv.org/abs/2111.06377
- Ilse, Tomczak, Welling, *Attention-based Deep Multiple Instance Learning*, ICML 2018 — https://arxiv.org/abs/1802.04712
- Lu et al., *Data-efficient and weakly supervised computational pathology on whole-slide images* (CLAM), *Nat. Biomed. Eng.* 2021 — https://www.nature.com/articles/s41551-020-00682-w
- Chen et al., UNI pathology foundation model (DINOv2 ViT-L on H&E) — https://github.com/mahmoodlab/UNI
- *Parameter-Efficient Fine-Tuning of DINOv2 for Large-Scale Font Classification* (LoRA, 1 % params, 99.0 %) — https://arxiv.org/abs/2602.13889
- *A self-supervised learning approach to deep filter banks for texture recognition* — https://arxiv.org/abs/2605.27843
- *Harnessing Self-Supervised Features for Art Classification* (DINO family vs CLIP on artworks) — https://arxiv.org/abs/2605.18974
