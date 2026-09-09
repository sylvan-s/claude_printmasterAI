/**
 * Stage 2a — Attribution Evidence Agent glue (ADR-0010 Decisions 7, 8, 9.2).
 *
 * The Attribution Evidence Agent (one Sonnet call + the query_ackg loop — see
 * ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT / ATTRIBUTION_EVIDENCE_SCHEMA) fills a flat set of
 * OBSERVATION cells. This module does the deterministic rest, with no LLM and no network:
 *
 *   evidenceToTwoPassInput()  — flat cells        -> two_pass_attribution.TwoPassInput
 *   assembleTriageResult()    — cells + tree run  -> the legacy-shaped TriageResult that
 *                               Stage 2b, the router bridge, and the report renderer read,
 *                               plus the ADR-0010 Decision 7 artistAttribution /
 *                               workIdentification / impressionAssessment fields.
 *
 * evidenceToTwoPassInput() also takes an optional Stage1dResult (ADR-0013's DINOv2/CLIP
 * match against the ACKG's own image index) and builds the D evidence cell from it directly
 * in code — no LLM judgement involved, unlike V/R/A/K. Only a HIGH matchConfidence votes
 * (2026-09-06 amendment to ADR-0013, which had deliberately withheld voting rights).
 *
 * Pure and unit-tested — tests/stage2a_evidence/.
 */
import type { TriageResult, Stage1dResult, AppraiserInputResult } from "../types";
import {
  classifyTwoPass,
  nameSimilarity,
  TAU_NAME,
  type TwoPassInput,
  type TwoPassResult,
  type NamingSource,
  type TitleSource,
  type KWorkResult,
  type StyleConsistencyEvidence,
  type WorkEvidence,
  type Confidence,
} from "./two_pass_attribution";
import {
  Scenario,
  SCENARIO_NAMES,
  matchSpecialistConfig,
} from "./routing";

// ───────────────────────────────────────────────────────────────────────────────
// The evidence agent's output — mirrors ATTRIBUTION_EVIDENCE_SCHEMA (AEA-1.0).
// Numbers use -1 as a "not assessed / not applicable" sentinel (tool schemas can't
// express nullable cleanly).
// ───────────────────────────────────────────────────────────────────────────────
export interface WH {
  width: number;
  height: number;
}

export interface EvidenceAgentOutput {
  schemaVersion: string;
  evidenceTimestamp?: string;
  inputValidation: {
    inputValidationError: boolean;
    veaExtractionConfidence: number;
    provisionalOutput: boolean;
  };
  traditionIdentification: {
    primaryTradition: string;
    traditionConfidence: number;
    supportingEvidence: string[];
    contradictingEvidence: string[];
  };
  periodEstimation: {
    estimatedPeriodRange: string;
    periodConfidence: number;
  };
  artistEvidence: {
    veaNamesArtist: boolean;
    veaArtistName: string;
    veaAuthorshipSignalLegible: boolean;
    veaSignatureConfidence: number;
    reverseImageNamesArtist: boolean;
    reverseImageArtistName: string;
    reverseImageSimilarity: number;
    reverseImageConsistentWithVea: boolean;
    reverseImageConsistencyRationale: string;
    appraiserNamesArtist: boolean;
    appraiserArtistName: string;
    appraiserTrust: "documented_fact" | "hypothesis" | "none" | string;
    dominantCandidateName: string;
    dominantCandidateIdentityKey: string;
    kId: "true" | "false" | "unknown" | string;
    kOeuvreMatchCount: number;
    kOeuvreProvenanceTags: string[];
    kSubject: "TYPICAL" | "OCCASIONAL" | "ATYPICAL" | "UNASSESSABLE" | string;
    kSubjectNote: string;
  };
  workEvidence: {
    veaTitle: string;
    veaInImageTitleLegible: boolean;
    reverseImageTitle: string;
    reverseImageTitleSimilarity: number;
    appraiserTitle: string;
    kWorkQueried: boolean;
    /** query_ackg_work's computed title similarity (0..1, embedding-based) for the best match. -1 if not queried. */
    kWorkTitleSim: number;
    /** The catalogued title the observed title matched, "" if none. */
    kWorkMatchedTitle: string;
    kWorkBackPropArtist: string;
  };
  impressionEvidence: {
    assessable: boolean;
    /** VEA's observed printing technique name(s). */
    observedTechniques: string[];
    /** VEA read halftone dots / offset / giclée. */
    observedIsPhotomechanical: boolean;
    /** Catalogued technique(s) for the identified work, from query_ackg_work. */
    catalogueTechniques: string[];
    /** Most informative catalogued rawMedium string, "" if none. */
    catalogueMediumRaw: string;
    workIsIntaglio: boolean;
    /** Where the observed measurement comes from: "appraiser" (Stage 1c, preferred) |
     *  "vea_scaled" (VEA had a scale reference) | "none". */
    observedDimSource: "appraiser" | "vea_scaled" | "none" | string;
    observedPlateMm: WH;
    observedImageMm: WH;
    cataloguePlateMm: WH;
    catalogueImageMm: WH;
  };
  riskFlags: {
    forgeryRisk: boolean;
    forgeryRiskNote?: string;
    reprintRisk: boolean;
    reprintRiskNote?: string;
    editionComplexityRisk: boolean;
    editionComplexityRiskNote?: string;
    misattributionRisk: boolean;
    misattributionRiskNote?: string;
    authenticationBodyExists: boolean;
    authenticationBodyNote?: string;
    physicalExaminationRequired: boolean;
    physicalExaminationReason?: string;
  };
  conflicts: string[];
  humanEscalationRequired: boolean;
  humanEscalationReason?: string;
  evidenceNarrative: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────────
const num = (n: unknown): number | null => (typeof n === "number" && n >= 0 ? n : null);
const wh = (o: WH | undefined | null): { w: number; h: number } | null =>
  o && o.width > 0 && o.height > 0 ? { w: o.width, h: o.height } : null;

/** Attach the model-resolved ULAN/Wikidata key to a source only when that source
 *  actually names the dominant candidate — otherwise identity-level agreement would
 *  be spuriously asserted between sources naming different people. */
function identityKeyFor(name: string, dom: string, key: string): string | null {
  if (!key) return null;
  if (!name || !dom) return null;
  return nameSimilarity(name, dom) >= TAU_NAME ? key : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// evidence cells -> TwoPassInput
// ───────────────────────────────────────────────────────────────────────────────
export function evidenceToTwoPassInput(
  ev: EvidenceAgentOutput,
  veaHaltRecommended: boolean,
  stage1d?: Stage1dResult | null,
  appraiserInput?: AppraiserInputResult | null,
  styleConsistency?: StyleConsistencyEvidence | null,
): TwoPassInput {
  const a = ev.artistEvidence;
  const w = ev.workEvidence;
  const dom = a.dominantCandidateName || "";
  const domKey = a.dominantCandidateIdentityKey || "";

  // D — Stage 1d DINOv2/CLIP match against the ACKG's own image index (ADR-0013 + the
  // 2026-09-06 voting amendment). Computed entirely in code from Stage 1d's own output —
  // no LLM judgement involved, unlike V/R/A/K — so this is built here rather than read off
  // the evidence agent's tool-call output. eligibleVotes() below gates it to HIGH only.
  const embeddingMatch: NamingSource = stage1d?.bestMatchArtist
    ? { kind: "names", raw: stage1d.bestMatchArtist, matchConfidence: stage1d.matchConfidence ?? undefined }
    : { kind: "no_match" };

  // D_t — the catalogued title of that same Stage 1d match. Built here in code for the
  // same reason as D above (no LLM judgement involved); eligibleTitleVotes() applies the
  // HIGH-only gate.
  const titleEmbeddingMatch: WorkEvidence["titleEmbeddingMatch"] = stage1d?.bestMatchConceptualWorkTitle
    ? {
        kind: "names",
        raw: stage1d.bestMatchConceptualWorkTitle,
        matchConfidence: stage1d.matchConfidence ?? undefined,
      }
    : { kind: "silent" };

  const veaSource: NamingSource = a.veaNamesArtist && a.veaArtistName
    ? { kind: "names", raw: a.veaArtistName, identityKey: identityKeyFor(a.veaArtistName, dom, domKey) }
    : { kind: "silent" };

  const rNamed = a.reverseImageNamesArtist && !!a.reverseImageArtistName;
  const reverseImageSearch: NamingSource = rNamed
    ? {
        kind: "names",
        raw: a.reverseImageArtistName,
        identityKey: identityKeyFor(a.reverseImageArtistName, dom, domKey),
        sim: a.reverseImageSimilarity >= 0 ? a.reverseImageSimilarity : 0,
      }
    : { kind: "no_match" };

  const appraiserTrust = a.appraiserTrust === "documented_fact" ? "documented_fact" : "hypothesis";
  const appraiser: NamingSource = a.appraiserNamesArtist && a.appraiserArtistName
    ? {
        kind: "names",
        raw: a.appraiserArtistName,
        identityKey: identityKeyFor(a.appraiserArtistName, dom, domKey),
        trust: appraiserTrust,
      }
    : { kind: "absent" };

  const kId: "true" | "false" | "unknown" =
    a.kId === "true" || a.kId === "false" ? a.kId : "unknown";
  const kSubject =
    a.kSubject === "TYPICAL" || a.kSubject === "OCCASIONAL" || a.kSubject === "ATYPICAL"
      ? (a.kSubject as "TYPICAL" | "OCCASIONAL" | "ATYPICAL")
      : ("UNASSESSABLE" as const);

  // K_work (Part B): the embedding-scored title match to a catalogued work. Technique /
  // dimension comparison moved to impressionEvidence (Part A).
  const kWork: KWorkResult | null =
    w.kWorkQueried && w.kWorkTitleSim >= 0
      ? {
          titleSim: w.kWorkTitleSim,
          matchedWorkTitle: w.kWorkMatchedTitle || null,
          backPropArtist: w.kWorkBackPropArtist || null,
        }
      : null;

  const titleSrc = (s: string): TitleSource => (s ? { kind: "names", raw: s } : { kind: "silent" });

  // A_t — the appraiser's title. Deciding what in a set of notes is a TITLE and what is
  // merely an inscription is Stage 1c's job, not the evidence agent's; when Stage 1c
  // reports no title claim, there is no appraiser title. The agent's own `appraiserTitle`
  // cell was the one cell in workEvidence with no schema description, and it filled the
  // gap by inference: on A0793 lot 148 it read the edition inscription "Grimm edition
  // B 35/100" as a title while Stage 1c had correctly recorded claimedAttribution.title
  // as null. That invented vote collided with D_t and collapsed the work pass to a T6
  // conflict. Stage 1c is authoritative here; the agent's cell is reported, never voted.
  const claimedTitle = appraiserInput?.claimedAttribution?.title?.trim() || "";
  const titleAppraiser: TitleSource = appraiserInput
    ? claimedTitle
      ? { kind: "names", raw: claimedTitle }
      : { kind: "silent" }
    // No Stage 1c result supplied at all — unit fixtures that drive the agent's cells
    // directly. Production always passes one: runStage1cAppraiserInput returns a fully
    // formed "absent" result rather than undefined even when there are no notes.
    : titleSrc(w.appraiserTitle);
  if (appraiserInput && w.appraiserTitle?.trim() && w.appraiserTitle.trim() !== claimedTitle) {
    console.warn(
      `[Stage 2a evidence] evidence agent reported appraiserTitle "${w.appraiserTitle.trim()}" but Stage 1c claimed ` +
        `${claimedTitle ? `"${claimedTitle}"` : "no title"} — using Stage 1c; the agent's value does not vote.`,
    );
  }

  // ACKG work-level anchor (ADR-0010 Decision 4a amendment): a catalogued work whose title
  // matches an observed title AND is attributed to one artist. The agent puts that artist in
  // kWorkBackPropArtist and the title-match strength in kWorkTitleSim. This VOTES.
  const anchorArtist = w.kWorkBackPropArtist || "";
  const ackgWorkAnchor =
    anchorArtist && w.kWorkTitleSim >= 0
      ? {
          artist: anchorArtist,
          identityKey: identityKeyFor(anchorArtist, dom, domKey),
          titleSim: w.kWorkTitleSim,
        }
      : null;

  const imp = ev.impressionEvidence;
  const observedDimSource: "appraiser" | "vea_scaled" | "none" =
    imp?.observedDimSource === "appraiser" || imp?.observedDimSource === "vea_scaled"
      ? imp.observedDimSource
      : "none";
  // Only run the impression layer when there's something concrete to compare — a catalogued
  // technique or a like-for-like dimension pair. Otherwise it's noise (T4 world).
  const impressionAssessable =
    !!imp?.assessable &&
    ((imp.catalogueTechniques ?? []).length > 0 ||
      (observedDimSource !== "none" &&
        (!!wh(imp.cataloguePlateMm) || !!wh(imp.catalogueImageMm))));
  const impressionEvidence = impressionAssessable && imp
    ? {
        observedTechniques: imp.observedTechniques ?? [],
        observedIsPhotomechanical: !!imp.observedIsPhotomechanical,
        catalogueTechniques: imp.catalogueTechniques ?? [],
        catalogueMediumRaw: imp.catalogueMediumRaw || "",
        dimensions: {
          observedSource: observedDimSource,
          workIsIntaglio: !!imp.workIsIntaglio,
          observedPlateMm: wh(imp.observedPlateMm),
          observedImageMm: wh(imp.observedImageMm),
          cataloguePlateMm: wh(imp.cataloguePlateMm),
          catalogueImageMm: wh(imp.catalogueImageMm),
        },
      }
    : null;

  return {
    artistEvidence: {
      vea: veaSource,
      reverseImageSearch,
      appraiser,
      embeddingMatch,
      stage1bConsistentWithVea: rNamed ? !!a.reverseImageConsistentWithVea : null,
      veaAuthorshipSignalLegible: !!a.veaAuthorshipSignalLegible,
      veaSignatureConfidence: num(a.veaSignatureConfidence),
      kId,
      kOeuvreMatchCount: num(a.kOeuvreMatchCount),
      kSubject,
      kSubjectNote: a.kSubjectNote || "",
      styleConsistency: styleConsistency ?? null,
      ackgWorkAnchor,
    },
    workEvidence: {
      titleVea: titleSrc(w.veaTitle),
      titleReverseImageSearch: w.reverseImageTitle
        ? { kind: "names", raw: w.reverseImageTitle, sim: w.reverseImageTitleSimilarity >= 0 ? w.reverseImageTitleSimilarity : 0 }
        : { kind: "silent" },
      titleAppraiser,
      titleEmbeddingMatch,
      kWork,
    },
    impressionEvidence,
    veaInImageTitleLegible: !!w.veaInImageTitleLegible,
    traditionConfidence: ev.traditionIdentification?.traditionConfidence ?? 0,
    veaHaltRecommended,
    riskFlags: {
      forgeryRisk: !!ev.riskFlags?.forgeryRisk,
      misattributionRisk: !!ev.riskFlags?.misattributionRisk,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// cells + tree run -> TriageResult (legacy shape + ADR-0010 Decision 7 fields)
// ───────────────────────────────────────────────────────────────────────────────
const BAND_PROB: Record<Confidence, number> = {
  HIGH: 0.9,
  MEDIUM_HIGH: 0.75,
  MEDIUM: 0.6,
  LOW: 0.4,
};
function artistProbability(v: TwoPassResult["artistAttribution"]): number {
  if (v.verdict === "conflict") return 0.5;
  if (v.verdict === "not_attributed") return 0.15;
  if (v.confidence) return BAND_PROB[v.confidence];
  return v.verdict === "attributed" ? 0.55 : 0.35;
}

export function assembleTriageResult(ev: EvidenceAgentOutput, tp: TwoPassResult): TriageResult {
  const art = tp.artistAttribution;
  const work = tp.workIdentification;
  const imp = tp.impressionAssessment;

  // candidateArtists — dominant first, then any contradicting identities the tree
  // logged, so Stage 2b and the renderer still get a shortlist.
  const candidateArtists: TriageResult["candidateArtists"] = [];
  if (art.artistName) {
    candidateArtists.push({
      rank: 1,
      artistName: art.artistName,
      candidateProbability: artistProbability(art),
      supportingEvidence: [
        `two-pass ${art.evidenceBasis}: ${art.verdict}/${art.confidence ?? "-"}`,
        ...(art.agreementSet.length ? [`sources agreeing: ${art.agreementSet.join("+")}`] : []),
        ...art.flags,
      ],
      contradictingEvidence: art.contradictingIdentities.map((n) => `competing identity: ${n}`),
      ackgSupportCount: art.kOeuvreMatchCount,
      ackgProvenanceTags: ev.artistEvidence?.kOeuvreProvenanceTags ?? [],
    });
  }
  for (const name of art.contradictingIdentities) {
    candidateArtists.push({
      rank: candidateArtists.length + 1,
      artistName: name,
      candidateProbability: 0.4,
      supportingEvidence: ["named by a competing source in the artist pass"],
      contradictingEvidence: [`disagrees with ${art.artistName ?? "the leading read"}`],
      ackgSupportCount: null,
      ackgProvenanceTags: [],
    });
  }

  const stage1bAgreement: boolean | null = ev.artistEvidence.reverseImageNamesArtist
    ? art.agreementSet.includes("R")
    : null;
  const ackgAgreement: boolean | null =
    art.agreementSet.includes("K")
      ? true
      : art.kOeuvreMatchCount == null
        ? null
        : art.kOeuvreMatchCount >= 1 || art.kId === "true";

  const scenario = tp.scenario;
  const partial = {
    traditionIdentification: ev.traditionIdentification,
    candidateArtists,
  } as unknown as TriageResult;
  const { key: specialistConfig } = matchSpecialistConfig(partial);

  const routingRationale =
    tp.ruleTrace.length ? tp.ruleTrace[tp.ruleTrace.length - 1] : `Scenario ${scenario}`;

  const overallTriageConfidence = Math.max(
    0,
    Math.min(1, artistProbability(art) - (ev.conflicts?.length ? 0.1 : 0) - (ev.inputValidation?.provisionalOutput ? 0.2 : 0)),
  );

  return {
    schemaVersion: "ATA-2.0-evidence",
    triageTimestamp: ev.evidenceTimestamp || new Date().toISOString(),
    inputValidation: {
      inputValidationError: !!ev.inputValidation?.inputValidationError,
      lowSourceConfidence: (ev.inputValidation?.veaExtractionConfidence ?? 1) < 0.4,
      veaExtractionConfidence: ev.inputValidation?.veaExtractionConfidence ?? 0,
      provisionalOutput: !!ev.inputValidation?.provisionalOutput,
    },
    traditionIdentification: {
      primaryTradition: ev.traditionIdentification?.primaryTradition ?? "",
      traditionConfidence: ev.traditionIdentification?.traditionConfidence ?? 0,
      supportingEvidence: ev.traditionIdentification?.supportingEvidence ?? [],
      contradictingEvidence: ev.traditionIdentification?.contradictingEvidence ?? [],
    },
    periodEstimation: {
      estimatedPeriodRange: ev.periodEstimation?.estimatedPeriodRange ?? "",
      periodConfidence: ev.periodEstimation?.periodConfidence ?? 0,
    },
    candidateArtists,
    riskFlags: {
      forgeryRisk: !!ev.riskFlags?.forgeryRisk,
      reprintRisk: !!ev.riskFlags?.reprintRisk,
      editionComplexityRisk: !!ev.riskFlags?.editionComplexityRisk,
      misattributionRisk: !!ev.riskFlags?.misattributionRisk,
      authenticationBodyExists: !!ev.riskFlags?.authenticationBodyExists,
      physicalExaminationRequired: !!ev.riskFlags?.physicalExaminationRequired,
    },
    evidenceCorroboration: {
      stage1bAgreement,
      ackgAgreement,
      conflicts: ev.conflicts ?? [],
    },
    routingDecision: {
      scenario: scenario as 1 | 2 | 3 | 4 | 5 | 6,
      scenarioName: SCENARIO_NAMES[scenario],
      specialistConfig,
      routingRationale,
      humanEscalationRequired: !!ev.humanEscalationRequired,
      humanEscalationReason: ev.humanEscalationReason || null,
    },
    triageConfidenceSummary: {
      overallTriageConfidence,
      criticalUnresolved: [
        ...(ev.conflicts ?? []),
        ...(ev.humanEscalationRequired && ev.humanEscalationReason ? [ev.humanEscalationReason] : []),
      ],
    },
    artistAttribution: {
      verdict: art.verdict,
      artistName: art.artistName,
      confidence: art.confidence,
      evidenceBasis: art.evidenceBasis,
      agreementSet: art.agreementSet,
      kId: art.kId,
      kOeuvreMatchCount: art.kOeuvreMatchCount,
      subjectCorroboration: art.subjectCorroboration,
      subjectNote: art.subjectNote,
      flags: art.flags,
      contradictingIdentities: art.contradictingIdentities,
    },
    workIdentification: work
      ? {
          verdict: work.verdict,
          conceptualWorkTitle: work.conceptualWorkTitle,
          confidence: work.confidence,
          evidenceBasis: work.evidenceBasis,
          agreementSet: work.agreementSet,
          backPropagatedToArtist: art.evidenceBasis === "A-backprop" || art.flags.includes("backPropagatedFromWork"),
        }
      : null,
    impressionAssessment: imp
      ? {
          divergence: imp.divergence,
          dimensionMatch: imp.dimensionMatch,
          techniqueMatch: imp.techniqueMatch,
          notes: imp.notes,
        }
      : null,
  };
}

const ZERO_WH: WH = { width: 0, height: 0 };

/** An all-empty evidence set. Two uses, both bypassing the model:
 *  - VEA already halted (reproduction / catalogue scan): no work to attribute.
 *    classifyTwoPass short-circuits on veaHaltRecommended regardless of these values.
 *  - the evidence-agent call could not be completed (content-filtered twice, or a hard
 *    error): degrade to a "not attributed, escalate" result instead of crashing the lot.
 *  Override `reason` / `narrative` for the second case. */
export function emptyEvidenceOutput(
  veaExtractionConfidence: number,
  override?: { reason?: string; narrative?: string },
): EvidenceAgentOutput {
  return {
    schemaVersion: "AEA-1.0",
    evidenceTimestamp: new Date().toISOString(),
    inputValidation: { inputValidationError: false, veaExtractionConfidence, provisionalOutput: false },
    traditionIdentification: { primaryTradition: "", traditionConfidence: 0, supportingEvidence: [], contradictingEvidence: [] },
    periodEstimation: { estimatedPeriodRange: "", periodConfidence: 0 },
    artistEvidence: {
      veaNamesArtist: false, veaArtistName: "", veaAuthorshipSignalLegible: false, veaSignatureConfidence: -1,
      reverseImageNamesArtist: false, reverseImageArtistName: "", reverseImageSimilarity: -1,
      reverseImageConsistentWithVea: false, reverseImageConsistencyRationale: "",
      appraiserNamesArtist: false, appraiserArtistName: "", appraiserTrust: "none",
      dominantCandidateName: "", dominantCandidateIdentityKey: "",
      kId: "unknown", kOeuvreMatchCount: -1, kOeuvreProvenanceTags: [], kSubject: "UNASSESSABLE", kSubjectNote: "",
    },
    workEvidence: {
      veaTitle: "", veaInImageTitleLegible: false, reverseImageTitle: "", reverseImageTitleSimilarity: -1,
      appraiserTitle: "", kWorkQueried: false, kWorkTitleSim: -1, kWorkMatchedTitle: "", kWorkBackPropArtist: "",
    },
    impressionEvidence: {
      assessable: false, observedTechniques: [], observedIsPhotomechanical: false,
      catalogueTechniques: [], catalogueMediumRaw: "", workIsIntaglio: false,
      observedDimSource: "none", observedPlateMm: ZERO_WH, observedImageMm: ZERO_WH,
      cataloguePlateMm: ZERO_WH, catalogueImageMm: ZERO_WH,
    },
    riskFlags: {
      forgeryRisk: false, reprintRisk: false, editionComplexityRisk: false, misattributionRisk: false,
      authenticationBodyExists: false, physicalExaminationRequired: false,
    },
    conflicts: [],
    humanEscalationRequired: true,
    humanEscalationReason: override?.reason ?? "VEA halted — digital reproduction / not an original print.",
    evidenceNarrative:
      override?.narrative ?? "VEA flagged this as a reproduction or catalogue scan; no original work to attribute.",
  };
}

/** One-shot: evidence cells -> tree -> TriageResult. */
export function runEvidenceTree(
  ev: EvidenceAgentOutput,
  veaHaltRecommended: boolean,
  stage1d?: Stage1dResult | null,
  appraiserInput?: AppraiserInputResult | null,
  styleConsistency?: StyleConsistencyEvidence | null,
): {
  triage: TriageResult;
  twoPass: TwoPassResult;
} {
  const twoPass = classifyTwoPass(evidenceToTwoPassInput(ev, veaHaltRecommended, stage1d, appraiserInput, styleConsistency));
  return { triage: assembleTriageResult(ev, twoPass), twoPass };
}

export { Scenario };
