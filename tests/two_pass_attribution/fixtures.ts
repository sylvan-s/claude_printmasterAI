/**
 * Hand-built evidence-cell fixtures for the ADR-0010 two-pass attribution classifier.
 * Used by run_tests.ts — no LLM calls, no network.
 */
import type {
  ArtistEvidence,
  WorkEvidence,
  ImpressionEvidence,
  TwoPassInput,
} from "../../src/appraisal/two_pass_attribution";

// ── builders ──────────────────────────────────────────────────────────────────
export function artistEv(o: Partial<ArtistEvidence> = {}): ArtistEvidence {
  return {
    vea: { kind: "silent" },
    reverseImageSearch: { kind: "no_match" },
    appraiser: { kind: "absent" },
    embeddingMatch: { kind: "no_match" },
    stage1bConsistentWithVea: null,
    veaAuthorshipSignalLegible: false,
    veaSignatureConfidence: null,
    kId: "unknown",
    kOeuvreMatchCount: null,
    kSubject: "UNASSESSABLE",
    ackgWorkAnchor: null,
    ...o,
  };
}

export function workEv(o: Partial<WorkEvidence> = {}): WorkEvidence {
  return {
    titleVea: { kind: "silent" },
    titleReverseImageSearch: { kind: "silent" },
    titleAppraiser: { kind: "silent" },
    titleEmbeddingMatch: { kind: "silent" },
    kWork: null,
    ...o,
  };
}

export function impressionEv(o: Partial<ImpressionEvidence> = {}): ImpressionEvidence {
  return {
    observedTechniques: ["Etching"],
    observedIsPhotomechanical: false,
    catalogueTechniques: ["Etching"],
    catalogueMediumRaw: "etching",
    dimensions: {
      observedSource: "appraiser",
      workIsIntaglio: true,
      observedPlateMm: { w: 320, h: 240 },
      cataloguePlateMm: { w: 320, h: 240 },
    },
    ...o,
  };
}

export function twoPass(o: Partial<TwoPassInput> = {}): TwoPassInput {
  // structuredClone so an e2e fixture that reuses an A-/T-fixture object can't be
  // affected by (or affect) a test that used that same object directly.
  return structuredClone({
    artistEvidence: artistEv(),
    workEvidence: workEv(),
    impressionEvidence: null,
    veaInImageTitleLegible: false,
    traditionConfidence: 0.3,
    ...o,
  });
}

// ── PASS 1 — ARTIST (A1..A11) ─────────────────────────────────────────────────

// A1 — V + R + A all agree
export const a1_threeAgree = artistEv({
  vea: { kind: "names", raw: "Pablo Picasso" },
  reverseImageSearch: { kind: "names", raw: "Pablo Picasso", sim: 0.92 },
  appraiser: { kind: "names", raw: "Picasso, Pablo", trust: "documented_fact" },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.9,
  kId: "true",
  kOeuvreMatchCount: 40,
  kSubject: "TYPICAL",
  kSubjectNote: "bulls appear in 47 catalogued Picasso prints (~6% of print oeuvre)",
});

// A2 — n=2 (V+R) with ACKG oeuvre support
export const a2_twoAgreeAckgSupport = artistEv({
  vea: { kind: "names", raw: "Marc Chagall" },
  reverseImageSearch: { kind: "names", raw: "Marc Chagall", sim: 0.88 },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.8,
  kId: "true",
  kOeuvreMatchCount: 6,
  kSubject: "TYPICAL", // 2026-09-09: A2 now means the ACKG corroborates on technique AND subject
});

// A3 — n=2, K_oeuvre=0, but artist is a real authority record
export const a3_recognisedNoOeuvre = artistEv({
  vea: { kind: "names", raw: "Henry Moore" },
  reverseImageSearch: { kind: "names", raw: "Henry Moore", sim: 0.9 },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.85, // comfortably above CONFIDENCE_MEAN_FLOOR — this fixture is about corroboration
  kId: "true",
  kOeuvreMatchCount: 6, // catalogued in this technique/period...
  kSubject: "OCCASIONAL", // ...but the subject does not corroborate -> weak -> A3
});

// A4 — n=2, artist not in ACKG at all
export const a4_notInAckg = artistEv({
  vea: { kind: "names", raw: "Obscure Printmaker" },
  appraiser: { kind: "names", raw: "Obscure Printmaker", trust: "documented_fact" },
  stage1bConsistentWithVea: null,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.85, // comfortably above CONFIDENCE_MEAN_FLOOR — this fixture is about corroboration
  kId: "false",
  kOeuvreMatchCount: 0,
  kSubject: "UNASSESSABLE",
});

// A5 — n=1, VEA legible signature only
export const a5_singleVeaSignature = artistEv({
  vea: { kind: "names", raw: "David Hockney" },
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.85,
  kId: "true",
  kOeuvreMatchCount: 1,
  kSubject: "OCCASIONAL",
});

// A5 (LOW) — VEA name from a low-confidence signature
export const a5_lowConfidenceSignature = artistEv({
  vea: { kind: "names", raw: "Agathe Sorel" },
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.4,
  kId: "unknown",
  kOeuvreMatchCount: null,
  kSubject: "UNASSESSABLE",
});

// A6 — n=1, strong image match only
export const a6_strongImageOnly = artistEv({
  reverseImageSearch: { kind: "names", raw: "Bridget Riley", sim: 0.9 },
  stage1bConsistentWithVea: true,
  kId: "true",
  kOeuvreMatchCount: 0,
  kSubject: "UNASSESSABLE",
});

// A7 — n=1, weak image match only
export const a7_weakImageOnly = artistEv({
  reverseImageSearch: { kind: "names", raw: "Eduardo Paolozzi", sim: 0.78 },
  stage1bConsistentWithVea: true,
  kId: "true",
  kOeuvreMatchCount: 0,
  kSubject: "UNASSESSABLE",
});

// A8 — n=1, documented appraiser claim only
export const a8_documentedAppraiserOnly = artistEv({
  appraiser: { kind: "names", raw: "Roberto Matta", trust: "documented_fact" },
  kId: "true",
  kOeuvreMatchCount: 1,
  kSubject: "TYPICAL",
});

// A9 — the only signal is an appraiser hypothesis
export const a9_appraiserHypothesisOnly = artistEv({
  appraiser: { kind: "names", raw: "possibly Sam Francis", trust: "hypothesis" },
  kId: "unknown",
  kSubject: "UNASSESSABLE",
});

// A10 — V and R name different artists, no dominant
export const a10_conflict = artistEv({
  vea: { kind: "names", raw: "Georges Braque" },
  reverseImageSearch: { kind: "names", raw: "Pablo Picasso", sim: 0.82 },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.7,
  kId: "true",
  kOeuvreMatchCount: 5,
  kSubject: "OCCASIONAL",
});

// A10 — documented_fact appraiser claim contradicting a legible VEA signature
export const a10_documentedFactVsSignature = artistEv({
  vea: { kind: "names", raw: "Stanley William Hayter" },
  appraiser: { kind: "names", raw: "Joan Miro", trust: "documented_fact" },
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.85,
  kId: "true",
  kOeuvreMatchCount: 3,
  kSubject: "OCCASIONAL",
});

// A11 — nothing
export const a11_nothing = artistEv();

// hypothesis contradicting VEA does NOT force a conflict — VEA wins, hypothesis noted
export const hypothesisVsVeaNotConflict = artistEv({
  vea: { kind: "names", raw: "Barbara Hepworth" },
  appraiser: { kind: "names", raw: "Ben Nicholson", trust: "hypothesis" },
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.8,
  kId: "true",
  kOeuvreMatchCount: 4,
  kSubject: "OCCASIONAL",
});

// R with high sim but INCONSISTENT with VEA — dropped from the vote (so V-only -> A5, not A1/A2)
export const rInconsistentDropped = artistEv({
  vea: { kind: "names", raw: "Utagawa Hiroshige" },
  reverseImageSearch: { kind: "names", raw: "Utagawa Hiroshige", sim: 0.95 },
  stage1bConsistentWithVea: false, // e.g. VEA saw halftone dots; the web match is the woodblock original
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.6,
  kId: "false",
  kOeuvreMatchCount: 0,
  kSubject: "UNASSESSABLE",
});

// R below the vote threshold — dropped
export const rBelowThresholdDropped = artistEv({
  vea: { kind: "names", raw: "Paul Nash" },
  reverseImageSearch: { kind: "names", raw: "Paul Nash", sim: 0.7 },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.8,
  kId: "true",
  kOeuvreMatchCount: 0,
  kSubject: "UNASSESSABLE",
});

// subject ATYPICAL -> flag, no downgrade
export const subjectAtypicalFlag = artistEv({
  vea: { kind: "names", raw: "Bridget Riley" },
  reverseImageSearch: { kind: "names", raw: "Bridget Riley", sim: 0.88 },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.8,
  kId: "true",
  kOeuvreMatchCount: 3,
  kSubject: "ATYPICAL",
  kSubjectNote: "figurative subject; Riley's catalogued output is entirely abstract",
});

// Tate reversed-name form should still agree with the natural form
export const reversedNameStillAgrees = artistEv({
  vea: { kind: "names", raw: "Julian Trevelyan" },
  appraiser: { kind: "names", raw: "Trevelyan, Julian Otto", trust: "documented_fact" },
  reverseImageSearch: { kind: "names", raw: "Julian Trevelyan RA", sim: 0.9 },
  stage1bConsistentWithVea: true,
  veaAuthorshipSignalLegible: true,
  veaSignatureConfidence: 0.85,
  kId: "true",
  kOeuvreMatchCount: 8,
  kSubject: "TYPICAL",
});

// ── PASS 2 — CONCEPTUAL WORK (T1..T7) ─────────────────────────────────────────

export const t1_allTitlesAgree = workEv({
  titleVea: { kind: "names", raw: "The Great Wave off Kanagawa" },
  titleReverseImageSearch: { kind: "names", raw: "Great Wave off Kanagawa", sim: 0.97 },
  titleAppraiser: { kind: "names", raw: "The Great Wave, Kanagawa" },
});

export const t2_twoAgreeKworkFullMatch = workEv({
  titleVea: { kind: "names", raw: "Bacchante au tambourin" },
  titleAppraiser: { kind: "names", raw: "Bacchante au tambourin, Suite Vollard" },
  kWork: { titleSim: 0.95, matchedWorkTitle: "Bacchante au tambourin", backPropArtist: "Pablo Picasso" },
});

export const t4_twoAgreeNoKwork = workEv({
  titleVea: { kind: "names", raw: "Composition with Figures" },
  titleAppraiser: { kind: "names", raw: "Composition with Figures" },
  kWork: null,
});

export const t4_twoAgreeWeakKwork = workEv({
  titleVea: { kind: "names", raw: "Farm at Watendlath" },
  titleAppraiser: { kind: "names", raw: "Farm at Watendlath" },
  kWork: { titleSim: 0.55, matchedWorkTitle: "A Farm in Cumbria" },
});

export const t5_singleTitleSource = workEv({
  titleVea: { kind: "names", raw: "Untitled Abstract" },
  kWork: { titleSim: 0.4, matchedWorkTitle: "Abstraction No. 3" },
});

// n=0 (sources conflict), but a strong ACKG embedding match anchors the work — T8K
export const t8k_kworkAnchorNoConsensus = workEv({
  titleVea: { kind: "names", raw: "Wu Zetian" },
  titleReverseImageSearch: { kind: "names", raw: "Nur Jahan H10-2", sim: 0.9 },
  kWork: { titleSim: 0.94, matchedWorkTitle: "H10-1 Wu Zetian, from The Empresses", backPropArtist: "Damien Hirst" },
});

// ── K_work corroboration must be to the SAME work (2026-09-08 amendment) ────────

// Two sources agree on one work; K_work scored a perfect match to a DIFFERENT one.
// The old code read titleSim alone and returned T2/HIGH off that mismatch.
export const t4_kworkMatchedADifferentWork = workEv({
  titleVea: { kind: "names", raw: "Cold Water about to Hit the Prince" },
  titleAppraiser: { kind: "names", raw: "Cold water about to hit the Prince" },
  kWork: { titleSim: 1.0, matchedWorkTitle: "Reclining Figure", backPropArtist: "David Hockney" },
});

// Same mismatch with a single source: the band must fall back to LOW, not MEDIUM.
export const t5_kworkMatchedADifferentWork = workEv({
  titleAppraiser: { kind: "names", raw: "Cold water about to hit the Prince" },
  kWork: { titleSim: 1.0, matchedWorkTitle: "Reclining Figure", backPropArtist: "David Hockney" },
});

// A strong hit whose matched title was never recorded cannot be verified either way.
export const t4_kworkUnverifiable = workEv({
  titleVea: { kind: "names", raw: "Station Approach" },
  titleAppraiser: { kind: "names", raw: "Station Approach" },
  kWork: { titleSim: 0.97, matchedWorkTitle: null },
});

// The corroborating case still works when the catalogued title merely carries a series
// suffix — TAU_TITLE_AGREE is a token measure, not string equality.
export const t2_kworkSeriesSuffixStillAgrees = workEv({
  titleVea: { kind: "names", raw: "Cold Water about to Hit the Prince" },
  titleAppraiser: { kind: "names", raw: "Cold water about to hit the Prince" },
  kWork: {
    titleSim: 0.93,
    matchedWorkTitle: "Cold Water about to Hit the Prince, from 'Illustrations for Six Fairy Tales from the Brothers Grimm'",
  },
});

// ── D_t (Stage 1d catalogued title, 2026-09-08 amendment) ───────────────────────

// The A0793/148 shape: no title source of any kind, but Stage 1d matched the work at
// HIGH. Before D_t this fell through to T8K and resolved to whatever K_work matched.
export const dt_embeddingTitleOnly_high = workEv({
  titleEmbeddingMatch: { kind: "names", raw: "Cold Water about to Hit the Prince", matchConfidence: "HIGH" },
  kWork: { titleSim: 1.0, matchedWorkTitle: "Reclining Figure", backPropArtist: "David Hockney" },
});

// Same, but Stage 1d is not confident — D_t must NOT vote, and T8K takes over again.
export const dt_embeddingTitleOnly_medium = workEv({
  titleEmbeddingMatch: { kind: "names", raw: "Cold Water about to Hit the Prince", matchConfidence: "MEDIUM" },
  kWork: { titleSim: 1.0, matchedWorkTitle: "Reclining Figure", backPropArtist: "David Hockney" },
});

// D_t agreeing with the appraiser: two sources -> T2/T4 rather than a lone candidate.
export const dt_agreesWithAppraiser = workEv({
  titleAppraiser: { kind: "names", raw: "Cold water about to hit the Prince" },
  titleEmbeddingMatch: { kind: "names", raw: "Cold Water about to Hit the Prince", matchConfidence: "HIGH" },
  kWork: { titleSim: 0.93, matchedWorkTitle: "Cold Water about to Hit the Prince" },
});

// D_t as the fourth agreeing source — T1 must still fire at n >= 3.
export const dt_fourSourcesAgree = workEv({
  titleVea: { kind: "names", raw: "The Great Wave off Kanagawa" },
  titleReverseImageSearch: { kind: "names", raw: "Great Wave off Kanagawa", sim: 0.97 },
  titleAppraiser: { kind: "names", raw: "The Great Wave, Kanagawa" },
  titleEmbeddingMatch: { kind: "names", raw: "The Great Wave off Kanagawa", matchConfidence: "HIGH" },
});

// D_t contradicting the only other source, with no K_work anchor -> a real conflict.
export const dt_contradictsAppraiser = workEv({
  titleAppraiser: { kind: "names", raw: "The Bathers" },
  titleEmbeddingMatch: { kind: "names", raw: "Station Approach", matchConfidence: "HIGH" },
});

export const t6_titlesConflict = workEv({
  titleVea: { kind: "names", raw: "The Bathers" },
  titleAppraiser: { kind: "names", raw: "The Cardplayers" },
});

export const t7_noTitleEvidence = workEv();

// back-prop: in-image title, K_work-by-title returns a consistent artist
export const backProp_workIdentifiesArtist = twoPass({
  artistEvidence: artistEv({
    vea: { kind: "names", raw: "Utagawa school" },
    veaAuthorshipSignalLegible: false,
    veaSignatureConfidence: 0.2,
    kId: "false",
    kSubject: "UNASSESSABLE",
  }),
  workEvidence: workEv({
    titleVea: { kind: "names", raw: "Thirty-six Views of Mount Fuji: Fine Wind, Clear Morning" },
    titleReverseImageSearch: { kind: "names", raw: "Fine Wind Clear Morning, 36 Views of Mount Fuji", sim: 0.9 },
    kWork: {
      titleSim: 0.95,
      matchedWorkTitle: "Fine Wind, Clear Morning (Gaifū kaisei)",
      backPropArtist: "Katsushika Hokusai",
    },
  }),
  veaInImageTitleLegible: true,
  traditionConfidence: 0.7,
});

// ── IMPRESSION DIVERGENCE (5b) ────────────────────────────────────────────────

export const imp_none = impressionEv();

export const imp_laterEdition = impressionEv({
  dimensions: {
    observedSource: "appraiser",
    workIsIntaglio: true,
    observedPlateMm: { w: 360, h: 270 },
    cataloguePlateMm: { w: 320, h: 240 },
  },
});

export const imp_variantSheetMinor = impressionEv({
  dimensions: {
    observedSource: "appraiser",
    workIsIntaglio: true,
    // dw=15 (>9.6 tol), dh=10 (>7.2 tol) => beyond tolerance; relMax ~4.7% (<10%) => "minor"
    observedPlateMm: { w: 335, h: 250 },
    cataloguePlateMm: { w: 320, h: 240 },
  },
});

// screenprint object, catalogue says lithograph -> different family, not photomechanical
export const imp_mediumDivergence = impressionEv({
  observedTechniques: ["Screenprint / Serigraphy"],
  observedIsPhotomechanical: false,
  catalogueTechniques: ["Lithograph"],
  catalogueMediumRaw: "lithograph in colours",
  dimensions: {
    observedSource: "appraiser",
    workIsIntaglio: false,
    observedImageMm: { w: 300, h: 400 },
    catalogueImageMm: { w: 300, h: 400 },
  },
});

// halftone/giclée object, catalogue says etching -> reproduction of a hand-pulled original
export const imp_reproduction = impressionEv({
  observedTechniques: ["Offset lithograph"],
  observedIsPhotomechanical: true,
  catalogueTechniques: ["Etching"],
  catalogueMediumRaw: "etching with drypoint",
  dimensions: { observedSource: "none", workIsIntaglio: false },
});

export const imp_noScaleScanUnassessable = impressionEv({
  dimensions: { observedSource: "none", workIsIntaglio: true },
});

export const imp_plateVsSheetNoComparison = impressionEv({
  dimensions: {
    observedSource: "appraiser",
    workIsIntaglio: true,
    observedPlateMm: { w: 320, h: 240 },
    cataloguePlateMm: null,
    catalogueImageMm: null,
  },
});

// ── END-TO-END (classifyTwoPass) ─────────────────────────────────────────────

export const e2e_confirmedClean = twoPass({
  artistEvidence: a1_threeAgree,
  workEvidence: t2_twoAgreeKworkFullMatch,
  impressionEvidence: impressionEv(),
  traditionConfidence: 0.8,
});

export const e2e_reproductionRoutesToScenario2 = twoPass({
  artistEvidence: a2_twoAgreeAckgSupport,
  workEvidence: t2_twoAgreeKworkFullMatch,
  impressionEvidence: imp_reproduction,
  traditionConfidence: 0.7,
});

export const e2e_artistConflictRoutesToScenario5 = twoPass({
  artistEvidence: a10_conflict,
  workEvidence: t7_noTitleEvidence,
  traditionConfidence: 0.6,
});

export const e2e_gateBlocksPass2 = twoPass({
  artistEvidence: a9_appraiserHypothesisOnly,
  workEvidence: t1_allTitlesAgree, // would be HIGH, but the gate must block Pass 2
  traditionConfidence: 0.2,
});

export const e2e_movementOnly = twoPass({
  artistEvidence: a11_nothing,
  workEvidence: t7_noTitleEvidence,
  traditionConfidence: 0.6,
});

export const e2e_lowSignal = twoPass({
  artistEvidence: a11_nothing,
  workEvidence: t7_noTitleEvidence,
  traditionConfidence: 0.15,
});
