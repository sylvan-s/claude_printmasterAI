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
  titleContainment,
  TAU_TITLE_AGREE,
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
    /** Sheet, added 2026-09-09 — compared last, at a wider tolerance. */
    observedSheetMm?: WH;
    catalogueSheetMm?: WH;
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
/**
 * A shared token for every source that names the SAME artist as the dominant candidate.
 *
 * sameIdentity() compares two votes' identityKeys for EQUALITY and nothing else, and every
 * vote that earns a key here gets the same string — so the token's content has never been
 * read as a URI, only as "these two agree". Its job is a transitivity bridge: V naming
 * "P. Picasso" and A naming "Pablo Picasso" may each clear TAU_NAME against the dominant
 * "Pablo Picasso" without clearing it against each other.
 *
 * It used to be the model-supplied dominantCandidateIdentityKey (ADR-0010's ULAN/Wikidata
 * cell), which made a real mechanism depend on a cosmetic field. Across 13 stored runs the
 * model wrote a wrong URI twice — Banksy as wikidata Q11701 (nobody: Banksy is Q133600) and
 * Rachel Whiteread as ULAN 500118577 (she is 500118666, and her node carries no Wikidata at
 * all, so it was not read off any row). Neither error changed a verdict, precisely because
 * the value is only compared with itself — which is the argument for not asking for it.
 *
 * The dominant name serves identically and costs nothing. NOTE this makes the bridge
 * unconditional where it was previously contingent on the model having filled the cell: a
 * run where the model left it "" now gets the bridge it should always have had.
 */
function identityKeyFor(name: string, dom: string): string | null {
  if (!name || !dom) return null;
  return nameSimilarity(name, dom) >= TAU_NAME ? `name:${dom.trim().toLowerCase()}` : null;
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
  // Defensive: callers should reject a report missing these (runStage2aTriage does), but
  // this function is exported and also drives the fixture adapters and tests. A missing
  // block yields empty cells and a not_attributed verdict rather than a TypeError.
  const a = ev.artistEvidence ?? ({} as NonNullable<typeof ev.artistEvidence>);
  const w = ev.workEvidence ?? ({} as NonNullable<typeof ev.workEvidence>);
  const dom = a.dominantCandidateName || "";

  // D / D_t — Stage 1d's DINOv2 + CLIP match against the ACKG's own image index (ADR-0013).
  // Built here in code from Stage 1d's output; no LLM judgement, unlike V/R/A.
  //
  // BEST-OF ACROSS THE ARTIST'S ROWS, PER MEASURE. Stage 1d returns up to 10 candidate rows
  // and the two vector searches do not return the same set — on A0793/122 the top row was
  // Peter Blake with a dino score and NO clip, while rows 2 and 3 were also Peter Blake with
  // clip scores and no dino. Reading only the top row threw away half the evidence for an
  // artist who was, across those rows, plainly present. An artist counts as matched when any
  // example in their corpus matches, so each measure is maxed over that artist's rows
  // independently — and never averaged with the other, since they are different scales.
  // Stage 1d's own top-level scores, used only as a fallback when candidateMatches is empty.
  const dinoScore = typeof stage1d?.dinov2SimilarityScore === "number" ? stage1d.dinov2SimilarityScore : undefined;
  const clipScore = typeof stage1d?.clipSimilarityScore === "number" ? stage1d.clipSimilarityScore : undefined;

  const rows = stage1d?.candidateMatches ?? [];
  const bestOf = (keep: (row: any) => boolean) => {
    const sel = rows.filter(keep);
    const pick = (f: (r: any) => unknown) => {
      const vals = sel.map(f).filter((v): v is number => typeof v === "number");
      return vals.length ? Math.max(...vals) : undefined;
    };
    return { dino: pick((r) => r.dinov2Similarity), clip: pick((r) => r.clipSimilarity) };
  };

  const bestArtist = stage1d?.bestMatchArtist ?? "";
  const artistScores = bestArtist
    ? bestOf((r) => !!r.artistName && nameSimilarity(r.artistName, bestArtist) >= TAU_NAME)
    : { dino: undefined, clip: undefined };

  const bestWork = stage1d?.bestMatchConceptualWorkTitle ?? "";
  const workScores = bestWork
    ? bestOf((r) => !!r.conceptualWorkTitle && titleContainment(r.conceptualWorkTitle, bestWork) >= TAU_TITLE_AGREE)
    : { dino: undefined, clip: undefined };

  const embeddingMatch: NamingSource = stage1d?.bestMatchArtist
    ? {
        kind: "names",
        raw: stage1d.bestMatchArtist,
        matchConfidence: stage1d.matchConfidence ?? undefined,
        // Fall back to the single top-row scores if the per-artist scan found nothing.
        dinoSimilarity: artistScores.dino ?? dinoScore ?? undefined,
        clipSimilarity: artistScores.clip ?? clipScore ?? undefined,
      }
    : { kind: "no_match" };

  const titleEmbeddingMatch: WorkEvidence["titleEmbeddingMatch"] = stage1d?.bestMatchConceptualWorkTitle
    ? {
        kind: "names",
        raw: stage1d.bestMatchConceptualWorkTitle,
        matchConfidence: stage1d.matchConfidence ?? undefined,
        // Work identity is DINOv2 only: on A0793 CLIP scored 0.937 and 0.946 against the
        // WRONG works by the right artists — it recognises style and medium, not the image.
        dinoSimilarity: workScores.dino ?? dinoScore ?? undefined,
      }
    : { kind: "silent" };

  const veaSource: NamingSource = a.veaNamesArtist && a.veaArtistName
    ? { kind: "names", raw: a.veaArtistName, identityKey: identityKeyFor(a.veaArtistName, dom) }
    : { kind: "silent" };

  const rNamed = a.reverseImageNamesArtist && !!a.reverseImageArtistName;
  const reverseImageSearch: NamingSource = rNamed
    ? {
        kind: "names",
        raw: a.reverseImageArtistName,
        identityKey: identityKeyFor(a.reverseImageArtistName, dom),
        sim: a.reverseImageSimilarity >= 0 ? a.reverseImageSimilarity : 0,
      }
    : { kind: "no_match" };

  const appraiserTrust = a.appraiserTrust === "documented_fact" ? "documented_fact" : "hypothesis";
  const appraiser: NamingSource = a.appraiserNamesArtist && a.appraiserArtistName
    ? {
        kind: "names",
        raw: a.appraiserArtistName,
        identityKey: identityKeyFor(a.appraiserArtistName, dom),
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
          identityKey: identityKeyFor(anchorArtist, dom),
          titleSim: w.kWorkTitleSim,
        }
      : null;

  const imp = ev.impressionEvidence;

  // Stage 1c is a first-class source for the physical facts, not just VEA. The evidence
  // schema ties observedTechniques to VEA ("verbatim from VEA printingTechniques"), so with
  // Stage 1a skipped the technique cell came back empty on every A0793 lot even though
  // Stage 1c had extracted "lithograph in colours" / "silkscreen print in colours" from the
  // catalogue text. Dimensions were already Stage 1c's job by design; technique now is too.
  const claimedTechnique = appraiserInput?.claimedAttribution?.technique?.trim() || "";
  const agentTechniques = (imp?.observedTechniques ?? []).filter((t) => t && t.trim());
  const observedTechniques = agentTechniques.length
    ? agentTechniques
    : claimedTechnique
      ? [claimedTechnique]
      : [];
  const observedTechniqueSource: "vea" | "appraiser" | "none" = agentTechniques.length
    ? "vea"
    : claimedTechnique
      ? "appraiser"
      : "none";

  // Sheet dimensions, admitted at a wider tolerance because 65% of A0793 lots state nothing
  // else. Stage 1c's dimensionsClaim carries the kind, so only a stated SHEET becomes one.
  const dc = appraiserInput?.dimensionsClaim;
  const observedSheetMm =
    dc && dc.kind === "sheet" && dc.widthCm && dc.heightCm
      ? { w: dc.widthCm * 10, h: dc.heightCm * 10 }
      : wh(imp?.observedSheetMm);
  const observedDimSource: "appraiser" | "vea_scaled" | "none" =
    imp?.observedDimSource === "appraiser" || imp?.observedDimSource === "vea_scaled"
      ? imp.observedDimSource
      : "none";
  // Assessable when a real PAIR exists to compare — both sides of a technique or of one
  // dimension kind. Otherwise it is noise (T4 world).
  //
  // Rewritten 2026-09-09. The previous gate discarded everything the code now supplies:
  // it required the agent's own `assessable` flag (false on all five A0793 lots, since the
  // agent judges that before the tree has ruled on the work), it counted only CATALOGUE
  // techniques so a Stage 1c-supplied observed technique could never satisfy it, and its
  // dimension leg knew nothing about sheet. The result was `work corroboration NONE` on
  // every lot with the comparison data sitting unused one line below.
  //
  // The agent's flag is no longer an AND: if it transcribed catalogue facts at all it
  // queried a work, and the presence of a comparable pair is the more reliable signal.
  // observedIsPhotomechanical is an observed technique family in its own right —
  // classifyTechniqueMatch adds it even when no process was named — so it counts as the
  // observed side of a pair. (VEA seeing halftone dots but naming nothing is exactly the
  // Hirst Empresses case: giclée observed against giclée catalogued, which is NOT a
  // reproduction.)
  const haveObservedTechnique = observedTechniques.length > 0 || !!imp?.observedIsPhotomechanical;
  const haveTechniquePair = haveObservedTechnique && (imp?.catalogueTechniques ?? []).length > 0;
  const haveDimPair =
    observedDimSource !== "none" &&
    ((!!wh(imp?.observedPlateMm) && !!wh(imp?.cataloguePlateMm)) ||
      (!!wh(imp?.observedImageMm) && !!wh(imp?.catalogueImageMm)) ||
      (!!observedSheetMm && !!wh(imp?.catalogueSheetMm)));
  const impressionAssessable = !!imp && (haveTechniquePair || haveDimPair);
  const impressionEvidence = impressionAssessable && imp
    ? {
        observedTechniques,
        observedTechniqueSource,
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
          observedSheetMm,
          catalogueSheetMm: wh(imp.catalogueSheetMm),
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
      dominantCandidateName: "",
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
