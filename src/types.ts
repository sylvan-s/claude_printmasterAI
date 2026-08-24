export interface AuctionEstimate {
  lowEstimate: number;
  highEstimate: number;
  currency: string;
  formattedEstimate: string;
  valuationContext: string;
}

export interface TechnicalDetail {
  technique: string;
  confidence: number; // 0-100 percent
  evidenceIdentified: string[];
  description: string;
}

export interface ConditionNotes {
  overallGrade: 'Poor' | 'Fair' | 'Good' | 'Excellent' | 'Mint';
  issuesDetected: string[];
  signatureStatus: string; // e.g. "Signed in graphite", "Signed in plate", "Unsigned"
  mattingAndMargins: string;
  analysisDetails: string;
}

export interface PrintAnalysisReport {
  likelyArtist: string;
  artistConfidence: number; // 0-100 percent
  artworkTitle: string;
  titleConfidence: number; // 0-100 percent
  creationPeriod: string;
  techniques: TechnicalDetail[];
  auctionEstimate: AuctionEstimate;
  conditionNotes: ConditionNotes;
  visualDescription: string;
  historicalContext: string;
  nextSteps: string[];
  isLikelyReproductionOrPoster: boolean;
  reproductionExplanation: string;
  recentAuctionSales?: RecentSale[]; // Recent auction transactions for similar prints
  inferredDimensions?: string; // Estimated physical dimensions of the print (e.g. inferred from coin ratio)
  signatureAnalysis?: string; // Appraiser's transcription and authentication analysis of the uploaded signature
  damageAnalysis?: string; // Close-up analysis regarding paper tears, foxing, acidity or pigment preservation
  editionSizeAndPrintNumber?: string; // Verified printing number and overall edition details (e.g., "45 / 100", "Artists Proof", "Unlimited Open Edition")
  visualEvidenceHighlights?: VisualEvidenceHighlight[];
  modelUsed?: string;
  promptVersion?: string;
  stage1Result?: VisualExtractionResult;
  stage1cResult?: AppraiserInputResult;
  stage2aResult?: TriageResult;
  stage2Result?: AttributionResearchResult;
  pipelineMeta?: {
    specialistConfigUsed: string;
    humanEscalationRequired: boolean;
    physicalExaminationRequired: boolean;
    overallAttributionConfidence: number;
  };
}

export interface VisualEvidenceHighlight {
  id?: string;
  label: string;
  observation: string;
  sourceImage?: string;
  box_2d: number[]; // [ymin, xmin, ymax, xmax] coordinates from 0 to 1000
}

export interface RecentSale {
  artworkTitle: string;
  artist: string;
  technique: string;
  saleDate: string;
  priceRealized: string;
  auctionHouse: string;
  conditionState: string;
  wasSoldInBroaderLot?: boolean;
  broaderLotPriceAdjustment?: string;
}

export interface SupplementaryImage {
  imageUrl: string;
  caption: string; // free-text guidance from the user on what this photo shows
}

export interface AnalysisHistoryItem {
  id: string;
  timestamp: string;
  imageUrl: string;
  imageFileName: string;
  imageSize: string;
  report: PrintAnalysisReport;
  lotNumber?: string; // e.g. "Lot 101"
  lotTitle?: string;  // e.g. "Post-war Prints"
  supplementaryImages?: SupplementaryImage[];
  catalogue_id?: string | null;
  lot_id?: string | null;
}

export interface CatalogMetadata {
  id: string;
  name: string;
  timestamp: string;
}

export interface ImageAuthenticityIndicator {
  indicator: string;
  description: string;
  conclusive?: boolean;
}

export interface ImageAuthenticity {
  classification: 'PHYSICAL_PRINT_SCAN' | 'PHYSICAL_PRINT_PHOTOGRAPH' | 'DIGITAL_REPRODUCTION' | 'UNCERTAIN';
  classificationConfidence: number;
  reproductionIndicatorsFound: ImageAuthenticityIndicator[];
  physicalPrintIndicatorsFound: ImageAuthenticityIndicator[];
  captureMethodNotes: string;
  confidencePenaltyApplied: number;
  reliabilityStatement: string;
  haltRecommended: boolean;
  haltReason: string | null;
  humanReviewRequired: boolean;
}

export interface SignaturesItem {
  id: string;
  type: 'hand_signed' | 'plate_signed' | 'stamp' | 'facsimile' | 'inscription' | 'annotation' | 'unknown';
  transcription: string;
  medium: 'graphite' | 'ink' | 'blind_stamp' | 'printed' | 'other' | string;
  location: string;
  sourceImage: 'PRIMARY_SCAN' | string; // or 'SUPPLEMENTARY_SCAN_n'
  box_2d: number[];
  authenticityNotes: string;
  signatureConfidence: number;
}

export interface EditionInfoItem {
  id: string;
  type: 'fractional' | 'AP' | 'HC' | 'PP' | 'BAT' | 'TP' | 'roman_numeral' | 'open_edition_claimed' | 'unknown';
  transcription: string;
  inscriptionMethod: 'hand_inscribed' | 'printed' | 'stamp' | 'unknown';
  location: string;
  sourceImage: string;
  box_2d: number[];
  editionConfidence: number;
}

export interface PrintingTechniqueItem {
  technique: string;
  family: 'intaglio' | 'relief' | 'planographic' | 'digital' | 'photomechanical' | 'mixed';
  visualEvidence: string[];
  techniqueConfidence: number;
  conflictingEvidence: string | null;
}

export interface PlateMarkDetails {
  present: boolean | 'uncertain';
  clarity: 'clear' | 'faint' | 'absent' | 'not_visible_in_scan';
  marginsEven: boolean | 'uncertain';
  observationNotes: string;
  plateMarkConfidence: number;
}

export interface DimensionsDetails {
  sourceImage: 'supplementary_scale_photo' | 'estimated_from_PRIMARY_SCAN' | 'unavailable' | string;
  printedImageMM: { width: number | null; height: number | null };
  fullSheetMM: { width: number | null; height: number | null };
  marginCondition: 'original' | 'trimmed' | 'irregular' | 'uncertain';
  dimensionsConfidence: number;
}

export interface PaperDetails {
  surfaceType: 'wove' | 'laid' | 'japanese' | 'BFK' | 'chine_colle' | 'vellum' | 'card' | 'fabric' | 'unknown' | string;
  tone: 'bright_white' | 'cream' | 'ivory' | 'yellowed' | 'grey' | 'other' | string;
  weight: 'lightweight' | 'medium' | 'heavy' | 'unknown';
  chainLinesVisible: boolean | 'uncertain';
  watermarkVisible: boolean | 'uncertain';
  watermarkDescription: string | null;
  mountingStatus: 'unmounted' | 'window_mount' | 'flush_mount' | 'dry_mounted' | 'laid_down' | 'framed' | 'unknown';
  paperConfidence: number;
}

export interface ConditionDefect {
  id: string;
  category: 'tonal_degradation' | 'paper_degradation' | 'physical_damage' | 'contamination' | 'restoration';
  type: string;
  severity: 'TRACE' | 'MINOR' | 'MODERATE' | 'SIGNIFICANT';
  location: string;
  affectsImageArea: boolean;
  sourceImage: string;
  box_2d: number[];
  defectConfidence: number;
}

export interface ConditionDetails {
  overallGrade: 'EXCELLENT' | 'VERY GOOD' | 'GOOD' | 'FAIR' | 'POOR' | 'DAMAGED';
  defects: ConditionDefect[];
  restorationEvidence: boolean;
  restorationNotes: string | null;
  conditionConfidence: number;
}

export interface InkAndColourDetails {
  coloursPresent: string[];
  colourMode: 'monochrome' | 'duotone' | 'multicolour';
  inkSurface: 'matte' | 'satin' | 'glossy' | 'mixed';
  inkCoverageEvenness: 'even' | 'minor_variation' | 'uneven';
  unevennesDescription: string | null;
  selectiveVarnishing: boolean | 'uncertain';
  inkAndColourConfidence: number;
}

export interface StampsAndLabelsItem {
  id: string;
  type: 'gallery_stamp' | 'publisher_stamp' | 'auction_label' | 'collector_stamp' | 'institutional_stamp' | 'price_notation' | 'framer_label' | 'customs_stamp' | 'conservation_label' | 'unknown' | string;
  transcription: string;
  inkColour: string;
  location: string;
  sourceImage: string;
  box_2d: number[];
  lugReference: string | null;
  stampConfidence: number;
}

export interface CompositionDetails {
  subjectMatter: string;
  subjectCategory: 'figurative' | 'abstract' | 'landscape' | 'portrait' | 'still_life' | 'typographic' | 'architectural' | 'geometric' | 'other';
  visualStyle: string;
  textWithinImage: string | null;
  dateWithinImage: string | null;
  numberOfColours: number | null;
  colourPaletteSummary: string;
  imageToSheetRatio: string;
  imageBoundary: 'bleeds_to_edge' | 'defined_border' | 'mixed';
  compositionConfidence: number;
}

export interface PhotographicQuality {
  focusUniformity: 'uniform' | 'centre_sharp_edges_soft' | 'uneven';
  lightingEvenness: 'even' | 'minor_glare' | 'significant_glare' | 'deep_shadows' | 'colour_temperature_variation';
  printFlat: boolean | 'uncertain';
  estimatedResolution: 'high' | 'medium' | 'low';
  observationsLimitedByPhotography: string[];
  additionalScansRecommended: Array<{ scanType: string; reason: string }>;
  qualityAssessmentConfidence: number;
}

export interface VisualExtractionResult {
  schemaVersion: string;
  inspectionTimestamp: string;
  imagesReceived: {
    primaryScan: boolean;
    supplementaryScanCount: number;
  };
  imageAuthenticity: ImageAuthenticity;
  titleInscriptions?: Array<{
    id: string;
    transcription: string;
    classification: string;
    location: string;
    medium: string;
    sourceImage: string;
    box_2d?: number[];
    titleConfidence: number | string;
  }>;
  signatures: SignaturesItem[];
  editionInfo: EditionInfoItem[];
  editionInfoAbsent: boolean;
  printingTechniques: PrintingTechniqueItem[];
  plateMark: PlateMarkDetails;
  dimensions: DimensionsDetails;
  paper: PaperDetails;
  condition: ConditionDetails;
  inkAndColour: InkAndColourDetails;
  stampsAndLabels: StampsAndLabelsItem[];
  composition: CompositionDetails;
  photographicQuality: PhotographicQuality;
  visualEvidenceHighlights: VisualEvidenceHighlight[];
  overallExtractionConfidence: number;
  lowConfidenceFlags: string[];
  provisionalOutput: boolean;
}

// Stage 1c — Appraiser Input Agent output. See ADR-0004. Text-only, no
// vision — extracted from the four AppraiserNotesInput.tsx free-text boxes.
export type ClaimStatus = "hypothesis" | "documented_fact" | "absent";

export interface AppraiserInputResult {
  schemaVersion: "AIA-1.0";
  inputReceived: {
    inscribedMarksNotes: boolean;
    provenanceNotes: boolean;
    conditionNotes: boolean;
    catalogueNotes: boolean;
  };
  claimedAttribution: {
    artist: string | null;
    title: string | null;
    period: string | null;
    technique: string | null;
    status: ClaimStatus;
    sourceField: "inscribedMarksNotes" | "provenanceNotes" | "conditionNotes" | "catalogueNotes" | null;
    sourceExcerpt: string | null;
  };
  inscriptionClaims: {
    signatureClaim: string | null;
    editionClaim: string | null;
    editionSizeClaim: number | null;
    monogramOrStampClaim: string | null;
    status: ClaimStatus;
  };
  provenanceChain: Array<{
    ownerOrEntity: string;
    dateOrPeriod: string | null;
    status: Exclude<ClaimStatus, "absent">;
    sourceExcerpt: string;
  }>;
  conditionClaims: Array<{
    claim: string;
    status: Exclude<ClaimStatus, "absent">;
    sourceExcerpt: string;
  }>;
  catalogueReferences: Array<{
    ref: string;
    source: "regex" | "llm";
  }>;
  literatureOrExhibitionClaims: string[];
  dimensionsClaim: {
    widthCm: number | null;
    heightCm: number | null;
    kind: string | null;
    source: "regex" | "llm" | "both";
  } | null;
  /** Paper/support material as stated in the notes, e.g. "BFK Rives wove",
   *  "wove paper", "vellum". No regex hint exists for this (unlike dimensions/
   *  catalogue refs/edition size) — LLM-only extraction. */
  paperOrSupport: string | null;
  rawNotes: {
    inscribedMarksNotes: string | null;
    provenanceNotes: string | null;
    conditionNotes: string | null;
    catalogueNotes: string | null;
  };
  overallExtractionConfidence: number;
  lowConfidenceFlags: string[];
}

// 3-stage legacy attribution result. schemaVersion is absent in existing DB records.
export interface LegacyAttributionResult {
  schemaVersion?: undefined;
  likelyArtist?: string;
  artistConfidence?: number;
  artworkTitle?: string;
  titleConfidence?: number;
  creationPeriod?: string;
  catalogueRaisonneMatch?: {
    matched: boolean;
    referenceName: string | null;
    notes: string | null;
  };
  editionsInformation?: string;
  isPosthumousReprint?: boolean;
  posthumousReprintDetails?: string | null;
  editionSynthesisEvidence?: string;
}

// 4-stage Specialist Attribution Agent (ASA-1.0) result.
export interface ASAAttributionResult {
  schemaVersion: "ASA-1.0";
  specialistConfigUsed: string;
  attributionConclusion: {
    attributedArtist: string | null;
    attributedArtistNative: string | null;
    attributionLevel: 'definitive' | 'probable' | 'possible' | 'school_of' | 'tradition_only' | 'unattributed';
    attributionConfidence: number;
    attributionEvidenceChain: string[];
    attributionCounterEvidence: string[];
    workTitle: string | null;
    workTitleNative: string | null;
    dateOrPeriod: string | null;
    technique: string | null;
    confirmedSeriesName: string | null;
  };
  catalogueRaisonne: {
    referenceFound: boolean;
    catalogueName: string | null;
    plateOrCatalogueNumber: string | null;
    catalogueEditionInfo: string | null;
    humanReferenceRequired: boolean;
  };
  reprintForgeryAssessment: {
    reprintForgeryRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNASSESSABLE';
    physicalExaminationRecommended: boolean;
  };
  seriesAndEditionIdentification: {
    seriesConfirmed: boolean;
    seriesName: string | null;
    editionType: 'first' | 'later' | 'reprint' | 'posthumous' | 'unknown';
    editionNotes: string | null;
  };
  valuationRelevantFindings: {
    impressionPeriod: string | null;
    conditionNotes: string | null;
    rarityFactors: string[];
    discountFactors: string[];
    keyValueDrivers: string[];
  };
  researchConfidenceSummary: {
    overallAttributionConfidence: number;
    humanEscalationRequired: boolean;
    humanEscalationReason: string | null;
    physicalExaminationRequired: boolean;
  };
  unresolvedQuestions: Array<{
    question: string;
    whyUnresolved: string;
    resolutionAction: string;
    confidenceImpact: 'CRITICAL' | 'SIGNIFICANT' | 'MODERATE' | 'MINOR';
  }>;
}

// Discriminated on schemaVersion: undefined → legacy 3-stage, "ASA-1.0" → 4-stage specialist.
export type AttributionResearchResult = LegacyAttributionResult | ASAAttributionResult;

export interface TriageResult {
  schemaVersion: string;
  triageTimestamp: string;
  inputValidation: {
    inputValidationError: boolean;
    lowSourceConfidence: boolean;
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
  candidateArtists: Array<{
    rank: number;
    artistName: string;
    candidateProbability: number;
    supportingEvidence: string[];
    contradictingEvidence: string[];
  }>;
  riskFlags: {
    forgeryRisk: boolean;
    reprintRisk: boolean;
    editionComplexityRisk: boolean;
    misattributionRisk: boolean;
    authenticationBodyExists: boolean;
    physicalExaminationRequired: boolean;
  };
  routingDecision: {
    tier: 1 | 2 | 3;
    specialistConfig: string;
    routingRationale: string;
    humanEscalationRequired: boolean;
    humanEscalationReason: string | null;
    alternativeConfig: string;
  };
  triageConfidenceSummary: {
    overallTriageConfidence: number;
    criticalUnresolved: string[];
  };
}

