/**
 * Hand-built TriageResult fixtures, one per ADR-0006 scenario, plus edge cases.
 * Used by run_routing_tests.ts — no LLM calls, no network.
 */
import type { TriageResult } from "../../src/types";

function baseTriage(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    schemaVersion: "TA-1.0",
    triageTimestamp: new Date().toISOString(),
    inputValidation: {
      inputValidationError: false,
      lowSourceConfidence: false,
      veaExtractionConfidence: 0.8,
      provisionalOutput: false,
    },
    traditionIdentification: {
      primaryTradition: "European / American Modern",
      traditionConfidence: 0.3,
      supportingEvidence: [],
      contradictingEvidence: [],
    },
    periodEstimation: {
      estimatedPeriodRange: "1950-1970",
      periodConfidence: 0.5,
    },
    candidateArtists: [],
    riskFlags: {
      forgeryRisk: false,
      reprintRisk: false,
      editionComplexityRisk: false,
      misattributionRisk: false,
      authenticationBodyExists: false,
      physicalExaminationRequired: false,
    },
    evidenceCorroboration: {
      stage1bAgreement: null,
      ackgAgreement: null,
      conflicts: [],
    },
    // Placeholder — classifyTriageOutcome overwrites this entirely; fixtures don't need a
    // "correct" starting value, only a shape-valid one.
    routingDecision: {
      scenario: 6,
      scenarioName: "placeholder",
      tier: 3,
      specialistConfig: "general_print_fallback",
      routingRationale: "",
      humanEscalationRequired: false,
      humanEscalationReason: null,
    },
    triageConfidenceSummary: {
      overallTriageConfidence: 0.5,
      criticalUnresolved: [],
    },
    ...overrides,
  };
}

// Scenario 1 — Confirmed, clean: high-confidence top candidate, institutional ACKG support
// (the work-level-match proxy), no risk flags, no conflicts.
export const scenario1ConfirmedClean = baseTriage({
  candidateArtists: [
    {
      rank: 1,
      artistName: "David Hockney",
      candidateProbability: 0.85,
      supportingEvidence: ["Signed in pencil", "Technique matches known editions"],
      contradictingEvidence: [],
      ackgSupportCount: 12,
      ackgProvenanceTags: ["institutional", "auction_history"],
    },
  ],
});

// Scenario 2 — Elevated authentication risk: high-confidence candidate, but forgeryRisk true.
export const scenario2ElevatedAuthenticationRisk = baseTriage({
  candidateArtists: [
    {
      rank: 1,
      artistName: "Pablo Picasso",
      candidateProbability: 0.8,
      supportingEvidence: ["Signature style consistent"],
      contradictingEvidence: [],
      ackgSupportCount: 40,
      ackgProvenanceTags: ["institutional", "auction_history"],
    },
  ],
  riskFlags: {
    forgeryRisk: true,
    reprintRisk: false,
    editionComplexityRisk: false,
    misattributionRisk: false,
    authenticationBodyExists: true,
    physicalExaminationRequired: true,
  },
});

// Boundary/ordering case — must still resolve to Scenario 2 even though the candidate
// otherwise looks exactly like Scenario 1 (clean corroboration, high confidence, work-level
// match). This is the single highest-value regression test: risk must be checked BEFORE a
// confident-looking match, never masked by one.
export const riskMasksConfidentMatch = baseTriage({
  candidateArtists: [
    {
      rank: 1,
      artistName: "Andy Warhol",
      candidateProbability: 0.9,
      supportingEvidence: ["Strong signature match"],
      contradictingEvidence: [],
      ackgSupportCount: 20,
      ackgProvenanceTags: ["institutional"],
    },
  ],
  riskFlags: {
    forgeryRisk: true,
    reprintRisk: false,
    editionComplexityRisk: false,
    misattributionRisk: false,
    authenticationBodyExists: false,
    physicalExaminationRequired: false,
  },
  evidenceCorroboration: { stage1bAgreement: true, ackgAgreement: true, conflicts: [] },
});

// Scenario 3 — Artist confirmed, work unresolved: high confidence, but no institutional
// ACKG support (auction_history only counts as weaker per the documented proxy).
export const scenario3ArtistConfirmedWorkUnresolved = baseTriage({
  candidateArtists: [
    {
      rank: 1,
      artistName: "Joan Miro",
      candidateProbability: 0.72,
      supportingEvidence: ["Style and signature consistent"],
      contradictingEvidence: [],
      ackgSupportCount: 3,
      ackgProvenanceTags: ["auction_history"],
    },
  ],
});

// Scenario 4 — Movement only: no confident candidate, but tradition confidence is high.
export const scenario4MovementOnly = baseTriage({
  traditionIdentification: {
    primaryTradition: "School of Paris",
    traditionConfidence: 0.65,
    supportingEvidence: ["Pencil-signed and numbered", "Mourlot stamp"],
    contradictingEvidence: [],
  },
  candidateArtists: [
    { rank: 1, artistName: "Unknown School of Paris artist", candidateProbability: 0.2, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 0, ackgProvenanceTags: [] },
  ],
});

// Scenario 5 — Competing candidates: two candidates within COMPETITIVE_MARGIN of each other.
export const scenario5CompetingCandidates = baseTriage({
  candidateArtists: [
    { rank: 1, artistName: "Marc Chagall", candidateProbability: 0.55, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 5, ackgProvenanceTags: ["institutional"] },
    { rank: 2, artistName: "Joan Miro", candidateProbability: 0.48, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 4, ackgProvenanceTags: ["auction_history"] },
  ],
});

// Scenario 5, alternate trigger — a real evidenceCorroboration conflict, single candidate.
export const scenario5EvidenceConflict = baseTriage({
  candidateArtists: [
    { rank: 1, artistName: "Rembrandt van Rijn", candidateProbability: 0.5, supportingEvidence: [], contradictingEvidence: ["Paper type inconsistent with claimed period"], ackgSupportCount: 1, ackgProvenanceTags: ["institutional"] },
  ],
  evidenceCorroboration: {
    stage1bAgreement: false,
    ackgAgreement: null,
    conflicts: ["Appraiser claimed 17th-century Dutch paper; VEA physical evidence shows machine-made wove paper inconsistent with that period."],
  },
});

// Scenario 6 — Low signal everywhere: no confident candidate, low tradition confidence too.
export const scenario6LowSignalEverywhere = baseTriage({
  traditionIdentification: {
    primaryTradition: "Unclear",
    traditionConfidence: 0.15,
    supportingEvidence: [],
    contradictingEvidence: [],
  },
  candidateArtists: [],
});

// Edge case — empty candidateArtists array entirely (not just low-probability entries).
export const edgeEmptyCandidates = baseTriage({
  candidateArtists: [],
  traditionIdentification: {
    primaryTradition: "Unclear",
    traditionConfidence: 0.1,
    supportingEvidence: [],
    contradictingEvidence: [],
  },
});

// Edge case — evidenceCorroboration omitted entirely (only `conflicts` is schema-required;
// the LLM could in principle omit the whole object on older/malformed records).
export const edgeMissingEvidenceCorroboration = baseTriage({
  candidateArtists: [
    { rank: 1, artistName: "Henri Matisse", candidateProbability: 0.7, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 2, ackgProvenanceTags: ["institutional"] },
  ],
});
delete (edgeMissingEvidenceCorroboration as any).evidenceCorroboration;

// Edge case — threshold boundary: 0.64 (just below CONFIDENT_THRESHOLD=0.65) must NOT
// count as confident.
export const edgeJustBelowConfidentThreshold = baseTriage({
  candidateArtists: [
    { rank: 1, artistName: "Georges Braque", candidateProbability: 0.64, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 5, ackgProvenanceTags: ["institutional"] },
  ],
  traditionIdentification: {
    primaryTradition: "Cubism",
    traditionConfidence: 0.55,
    supportingEvidence: [],
    contradictingEvidence: [],
  },
});

// Edge case — exactly at CONFIDENT_THRESHOLD=0.65 must count as confident.
export const edgeAtConfidentThreshold = baseTriage({
  candidateArtists: [
    { rank: 1, artistName: "Georges Braque", candidateProbability: 0.65, supportingEvidence: [], contradictingEvidence: [], ackgSupportCount: 0, ackgProvenanceTags: [] },
  ],
});
