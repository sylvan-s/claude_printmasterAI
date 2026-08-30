/**
 * Evidence-agent output fixtures for tests/stage2a_evidence/run_tests.ts.
 * No LLM, no network — plain objects fed to the pure mapper / assembler.
 */
import type { EvidenceAgentOutput, WH } from "../../src/appraisal/stage2a_evidence";

const Z: WH = { width: 0, height: 0 };

/** A neutral, all-empty evidence output; override any leaf via the partial. */
export function evOut(o: DeepPartial<EvidenceAgentOutput> = {}): EvidenceAgentOutput {
  const base: EvidenceAgentOutput = {
    schemaVersion: "AEA-1.0",
    evidenceTimestamp: "2026-08-29T00:00:00.000Z",
    inputValidation: { inputValidationError: false, veaExtractionConfidence: 0.8, provisionalOutput: false },
    traditionIdentification: {
      primaryTradition: "European / American Modern",
      traditionConfidence: 0.7,
      supportingEvidence: [],
      contradictingEvidence: [],
    },
    periodEstimation: { estimatedPeriodRange: "1950–1970", periodConfidence: 0.6 },
    artistEvidence: {
      veaNamesArtist: false,
      veaArtistName: "",
      veaAuthorshipSignalLegible: false,
      veaSignatureConfidence: -1,
      reverseImageNamesArtist: false,
      reverseImageArtistName: "",
      reverseImageSimilarity: -1,
      reverseImageConsistentWithVea: false,
      reverseImageConsistencyRationale: "",
      appraiserNamesArtist: false,
      appraiserArtistName: "",
      appraiserTrust: "none",
      dominantCandidateName: "",
      dominantCandidateIdentityKey: "",
      kId: "unknown",
      kOeuvreMatchCount: -1,
      kOeuvreProvenanceTags: [],
      kSubject: "UNASSESSABLE",
      kSubjectNote: "",
    },
    workEvidence: {
      veaTitle: "",
      veaInImageTitleLegible: false,
      reverseImageTitle: "",
      reverseImageTitleSimilarity: -1,
      appraiserTitle: "",
      kWorkQueried: false,
      kWorkTitleSim: -1,
      kWorkTechniqueMatch: "unassessable",
      kWorkDimensionMatch: "UNASSESSABLE",
      kWorkBackPropArtist: "",
    },
    impressionEvidence: {
      assessable: false,
      techniqueMatch: true,
      veaTechniqueIsPhotomechanical: false,
      catalogueExpectsOriginalPrintmaking: true,
      hadScaleScan: false,
      workIsIntaglio: false,
      veaPlateMm: Z,
      cataloguePlateMm: Z,
      veaImageMm: Z,
      catalogueImageMm: Z,
    },
    riskFlags: {
      forgeryRisk: false,
      reprintRisk: false,
      editionComplexityRisk: false,
      misattributionRisk: false,
      authenticationBodyExists: false,
      physicalExaminationRequired: false,
    },
    conflicts: [],
    humanEscalationRequired: false,
    humanEscalationReason: "",
    evidenceNarrative: "",
  };
  return merge(base, o) as EvidenceAgentOutput;
}

// ── a small deep-merge (objects only; arrays and scalars replace) ─────────────
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
function merge(a: any, b: any): any {
  if (b === undefined) return a;
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = merge(a?.[k], b[k]);
  return out;
}

// ── named scenarios ──────────────────────────────────────────────────────────

/** V + R + A all name Picasso, R scored & consistent, ACKG corroborates, work identified. */
export const confirmedClean = evOut({
  artistEvidence: {
    veaNamesArtist: true,
    veaArtistName: "Pablo Picasso",
    veaAuthorshipSignalLegible: true,
    veaSignatureConfidence: 0.9,
    reverseImageNamesArtist: true,
    reverseImageArtistName: "Pablo Picasso",
    reverseImageSimilarity: 0.9,
    reverseImageConsistentWithVea: true,
    reverseImageConsistencyRationale: "same etching, differs only in photography",
    appraiserNamesArtist: true,
    appraiserArtistName: "Picasso",
    appraiserTrust: "documented_fact",
    dominantCandidateName: "Pablo Picasso",
    dominantCandidateIdentityKey: "http://vocab.getty.edu/ulan/500009666",
    kId: "true",
    kOeuvreMatchCount: 12,
    kOeuvreProvenanceTags: ["institutional", "auction_history"],
    kSubject: "TYPICAL",
    kSubjectNote: "the bull is a recurring subject in Picasso's prints",
  },
  workEvidence: {
    veaTitle: "Le Taureau",
    veaInImageTitleLegible: true,
    reverseImageTitle: "Le Taureau",
    reverseImageTitleSimilarity: 0.9,
    appraiserTitle: "Le Taureau",
    kWorkQueried: true,
    kWorkTitleSim: 0.95,
    kWorkTechniqueMatch: "true",
    kWorkDimensionMatch: "true",
  },
  impressionEvidence: { assessable: true, techniqueMatch: true, workIsIntaglio: true, hadScaleScan: true },
});

/** Two sources agree on a real artist; ACKG shows zero matching oeuvre but kId true → A3. */
export const recognisedNoOeuvre = evOut({
  artistEvidence: {
    veaNamesArtist: true,
    veaArtistName: "Edvard Munch",
    veaAuthorshipSignalLegible: true,
    veaSignatureConfidence: 0.7,
    appraiserNamesArtist: true,
    appraiserArtistName: "E. Munch",
    appraiserTrust: "documented_fact",
    dominantCandidateName: "Edvard Munch",
    kId: "true",
    kOeuvreMatchCount: 0,
    kSubject: "UNASSESSABLE",
  },
});

/** VEA reads one hand, a documented_fact appraiser claim names someone else → conflict. */
export const attributionConflict = evOut({
  artistEvidence: {
    veaNamesArtist: true,
    veaArtistName: "Joan Miró",
    veaAuthorshipSignalLegible: true,
    veaSignatureConfidence: 0.8,
    appraiserNamesArtist: true,
    appraiserArtistName: "Marc Chagall",
    appraiserTrust: "documented_fact",
    dominantCandidateName: "Joan Miró",
  },
});

/** Photomechanical technique where an original is expected → reproduction divergence. */
export const reproductionDivergence = evOut({
  artistEvidence: {
    veaNamesArtist: true,
    veaArtistName: "Roy Lichtenstein",
    veaAuthorshipSignalLegible: true,
    veaSignatureConfidence: 0.85,
    reverseImageNamesArtist: true,
    reverseImageArtistName: "Roy Lichtenstein",
    reverseImageSimilarity: 0.88,
    reverseImageConsistentWithVea: true,
    reverseImageConsistencyRationale: "same composition",
    dominantCandidateName: "Roy Lichtenstein",
    kId: "true",
    kOeuvreMatchCount: 5,
    kOeuvreProvenanceTags: ["institutional"],
  },
  workEvidence: {
    veaTitle: "Crak!",
    veaInImageTitleLegible: true,
    reverseImageTitle: "Crak!",
    reverseImageTitleSimilarity: 0.9,
    kWorkQueried: true,
    kWorkTitleSim: 0.95,
    kWorkTechniqueMatch: "false",
  },
  impressionEvidence: {
    assessable: true,
    techniqueMatch: false,
    veaTechniqueIsPhotomechanical: true,
    catalogueExpectsOriginalPrintmaking: true,
  },
});

/** VEA signature name illegible, Stage 1b hit inconsistent — but the ACKG holds the
 *  Stage-1b title catalogued to exactly one artist. Decision 4a amendment: K votes. */
export const ackgWorkAnchorPromotes = evOut({
  artistEvidence: {
    veaNamesArtist: false,
    veaArtistName: "",
    veaAuthorshipSignalLegible: false,
    veaSignatureConfidence: 0.45,
    reverseImageNamesArtist: true,
    reverseImageArtistName: "Rembrandt van Rijn",
    reverseImageSimilarity: 0.4,
    reverseImageConsistentWithVea: false,
    reverseImageConsistencyRationale: "loose composition match only",
    dominantCandidateName: "Rembrandt van Rijn",
    dominantCandidateIdentityKey: "http://vocab.getty.edu/ulan/500011051",
    kId: "true",
    kOeuvreMatchCount: 240,
    kOeuvreProvenanceTags: ["auction_history"],
  },
  workEvidence: {
    reverseImageTitle: "The Death of the Virgin",
    reverseImageTitleSimilarity: 0.9,
    kWorkQueried: true,
    kWorkTitleSim: 0.95,
    kWorkBackPropArtist: "Rembrandt van Rijn",
  },
});

/** Stage 1b names a famous artist but the hit is inconsistent with VEA — must not vote. */
export const stage1bInconsistent = evOut({
  artistEvidence: {
    veaNamesArtist: false,
    reverseImageNamesArtist: true,
    reverseImageArtistName: "Rembrandt van Rijn",
    reverseImageSimilarity: 0.82,
    reverseImageConsistentWithVea: false,
    reverseImageConsistencyRationale: "Stage 1b says etching c.1650; VEA saw aniline pigment and a pencil signature (post-1856)",
    dominantCandidateName: "Rembrandt van Rijn",
  },
});
