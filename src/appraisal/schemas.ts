import { Type } from "@google/genai";

// Converts Gemini Type.* enum schema to standard JSON Schema (lowercases type strings).
// Used when passing schemas to the Anthropic API as tool input_schema.
export function translateSchemaToStandardJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const result: any = Array.isArray(schema) ? [] : {};
  for (const key of Object.keys(schema)) {
    const val = schema[key];
    if (key === "type" && typeof val === "string") {
      result[key] = val.toLowerCase();
    } else if (typeof val === "object") {
      result[key] = translateSchemaToStandardJsonSchema(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stage 1 — Visual Extraction Agent (VEA-1.1)
// ---------------------------------------------------------------------------
export const VISUAL_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    schemaVersion: { type: Type.STRING },
    inspectionTimestamp: { type: Type.STRING },
    imagesReceived: {
      type: Type.OBJECT,
      properties: {
        primaryScan: { type: Type.BOOLEAN },
        supplementaryScanCount: { type: Type.INTEGER }
      },
      required: ["primaryScan", "supplementaryScanCount"]
    },
    imageAuthenticity: {
      type: Type.OBJECT,
      properties: {
        classification: { type: Type.STRING },
        classificationConfidence: { type: Type.NUMBER },
        reproductionIndicatorsFound: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              indicator: { type: Type.STRING },
              description: { type: Type.STRING },
              conclusive: { type: Type.BOOLEAN }
            },
            required: ["indicator", "description", "conclusive"]
          }
        },
        physicalPrintIndicatorsFound: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              indicator: { type: Type.STRING },
              description: { type: Type.STRING }
            },
            required: ["indicator", "description"]
          }
        },
        captureMethodNotes: { type: Type.STRING },
        confidencePenaltyApplied: { type: Type.NUMBER },
        reliabilityStatement: { type: Type.STRING },
        haltRecommended: { type: Type.BOOLEAN },
        haltReason: { type: Type.STRING },
        humanReviewRequired: { type: Type.BOOLEAN }
      },
      required: [
        "classification", "classificationConfidence", "reproductionIndicatorsFound",
        "physicalPrintIndicatorsFound", "captureMethodNotes", "confidencePenaltyApplied",
        "reliabilityStatement", "haltRecommended", "haltReason", "humanReviewRequired"
      ]
    },
    titleInscriptions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          transcription: { type: Type.STRING },
          classification: { type: Type.STRING },
          location: { type: Type.STRING },
          medium: { type: Type.STRING },
          sourceImage: { type: Type.STRING },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          titleConfidence: { type: Type.NUMBER }
        },
        required: ["id", "transcription", "classification", "location", "medium", "sourceImage", "box_2d", "titleConfidence"]
      }
    },
    signatures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          type: { type: Type.STRING },
          transcription: { type: Type.STRING },
          medium: { type: Type.STRING },
          location: { type: Type.STRING },
          sourceImage: { type: Type.STRING },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          authenticityNotes: { type: Type.STRING },
          signatureConfidence: { type: Type.NUMBER }
        },
        required: ["id", "type", "transcription", "medium", "location", "sourceImage", "box_2d", "authenticityNotes", "signatureConfidence"]
      }
    },
    editionInfo: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          type: { type: Type.STRING },
          transcription: { type: Type.STRING },
          inscriptionMethod: { type: Type.STRING },
          location: { type: Type.STRING },
          sourceImage: { type: Type.STRING },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          editionConfidence: { type: Type.NUMBER }
        },
        required: ["id", "type", "transcription", "inscriptionMethod", "location", "sourceImage", "box_2d", "editionConfidence"]
      }
    },
    editionInfoAbsent: { type: Type.BOOLEAN },
    printingTechniques: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          technique: { type: Type.STRING },
          family: { type: Type.STRING },
          visualEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          techniqueConfidence: { type: Type.NUMBER },
          conflictingEvidence: { type: Type.STRING }
        },
        required: ["technique", "family", "visualEvidence", "techniqueConfidence", "conflictingEvidence"]
      }
    },
    plateMark: {
      type: Type.OBJECT,
      properties: {
        present: { type: Type.STRING },
        clarity: { type: Type.STRING },
        marginsEven: { type: Type.STRING },
        observationNotes: { type: Type.STRING },
        plateMarkConfidence: { type: Type.NUMBER }
      },
      required: ["present", "clarity", "marginsEven", "observationNotes", "plateMarkConfidence"]
    },
    dimensions: {
      type: Type.OBJECT,
      properties: {
        sourceImage: { type: Type.STRING },
        printedImageMM: {
          type: Type.OBJECT,
          properties: {
            width: { type: Type.INTEGER },
            height: { type: Type.INTEGER }
          }
        },
        fullSheetMM: {
          type: Type.OBJECT,
          properties: {
            width: { type: Type.INTEGER },
            height: { type: Type.INTEGER }
          }
        },
        marginCondition: { type: Type.STRING },
        dimensionsConfidence: { type: Type.NUMBER }
      },
      required: ["sourceImage", "printedImageMM", "fullSheetMM", "marginCondition", "dimensionsConfidence"]
    },
    paper: {
      type: Type.OBJECT,
      properties: {
        surfaceType: { type: Type.STRING },
        tone: { type: Type.STRING },
        weight: { type: Type.STRING },
        chainLinesVisible: { type: Type.STRING },
        watermarkVisible: { type: Type.STRING },
        watermarkDescription: { type: Type.STRING },
        mountingStatus: { type: Type.STRING },
        paperConfidence: { type: Type.NUMBER }
      },
      required: ["surfaceType", "tone", "weight", "chainLinesVisible", "watermarkVisible", "watermarkDescription", "mountingStatus", "paperConfidence"]
    },
    condition: {
      type: Type.OBJECT,
      properties: {
        overallGrade: { type: Type.STRING },
        defects: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              category: { type: Type.STRING },
              type: { type: Type.STRING },
              severity: { type: Type.STRING },
              location: { type: Type.STRING },
              affectsImageArea: { type: Type.BOOLEAN },
              sourceImage: { type: Type.STRING },
              box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
              defectConfidence: { type: Type.NUMBER }
            },
            required: ["id", "category", "type", "severity", "location", "affectsImageArea", "sourceImage", "box_2d", "defectConfidence"]
          }
        },
        restorationEvidence: { type: Type.BOOLEAN },
        restorationNotes: { type: Type.STRING },
        conditionConfidence: { type: Type.NUMBER }
      },
      required: ["overallGrade", "defects", "restorationEvidence", "restorationNotes", "conditionConfidence"]
    },
    inkAndColour: {
      type: Type.OBJECT,
      properties: {
        coloursPresent: { type: Type.ARRAY, items: { type: Type.STRING } },
        colourMode: { type: Type.STRING },
        inkSurface: { type: Type.STRING },
        inkCoverageEvenness: { type: Type.STRING },
        unevennesDescription: { type: Type.STRING },
        selectiveVarnishing: { type: Type.STRING },
        inkAndColourConfidence: { type: Type.NUMBER }
      },
      required: ["coloursPresent", "colourMode", "inkSurface", "inkCoverageEvenness", "unevennesDescription", "selectiveVarnishing", "inkAndColourConfidence"]
    },
    stampsAndLabels: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          type: { type: Type.STRING },
          transcription: { type: Type.STRING },
          inkColour: { type: Type.STRING },
          location: { type: Type.STRING },
          sourceImage: { type: Type.STRING },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          lugReference: { type: Type.STRING },
          stampConfidence: { type: Type.NUMBER }
        },
        required: ["id", "type", "transcription", "inkColour", "location", "sourceImage", "box_2d", "lugReference", "stampConfidence"]
      }
    },
    composition: {
      type: Type.OBJECT,
      properties: {
        subjectMatter: { type: Type.STRING },
        subjectCategory: { type: Type.STRING },
        visualStyle: { type: Type.STRING },
        textWithinImage: { type: Type.STRING },
        dateWithinImage: { type: Type.STRING },
        numberOfColours: { type: Type.INTEGER },
        colourPaletteSummary: { type: Type.STRING },
        imageToSheetRatio: { type: Type.STRING },
        imageBoundary: { type: Type.STRING },
        compositionConfidence: { type: Type.NUMBER }
      },
      required: ["subjectMatter", "subjectCategory", "visualStyle", "textWithinImage", "dateWithinImage", "numberOfColours", "colourPaletteSummary", "imageToSheetRatio", "imageBoundary", "compositionConfidence"]
    },
    photographicQuality: {
      type: Type.OBJECT,
      properties: {
        focusUniformity: { type: Type.STRING },
        lightingEvenness: { type: Type.STRING },
        printFlat: { type: Type.STRING },
        estimatedResolution: { type: Type.STRING },
        observationsLimitedByPhotography: { type: Type.ARRAY, items: { type: Type.STRING } },
        additionalScansRecommended: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              scanType: { type: Type.STRING },
              reason: { type: Type.STRING }
            },
            required: ["scanType", "reason"]
          }
        },
        qualityAssessmentConfidence: { type: Type.NUMBER }
      },
      required: ["focusUniformity", "lightingEvenness", "printFlat", "estimatedResolution", "observationsLimitedByPhotography", "additionalScansRecommended", "qualityAssessmentConfidence"]
    },
    visualEvidenceHighlights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          label: { type: Type.STRING },
          sourceImage: { type: Type.STRING },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          observation: { type: Type.STRING }
        },
        required: ["id", "label", "sourceImage", "box_2d", "observation"]
      }
    },
    overallExtractionConfidence: { type: Type.NUMBER },
    lowConfidenceFlags: { type: Type.ARRAY, items: { type: Type.STRING } },
    provisionalOutput: { type: Type.BOOLEAN }
  },
  required: [
    "schemaVersion", "inspectionTimestamp", "imagesReceived", "imageAuthenticity", "titleInscriptions", "signatures",
    "editionInfo", "editionInfoAbsent", "printingTechniques", "plateMark", "dimensions", "paper",
    "condition", "inkAndColour", "stampsAndLabels", "composition", "photographicQuality",
    "visualEvidenceHighlights", "overallExtractionConfidence", "lowConfidenceFlags", "provisionalOutput"
  ]
};

// ---------------------------------------------------------------------------
// Stage 2 (3-stage path) — Legacy Attribution Research
// ---------------------------------------------------------------------------
export const ATTRIBUTION_RESEARCH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    likelyArtist: { type: Type.STRING },
    artistConfidence: { type: Type.INTEGER },
    artworkTitle: { type: Type.STRING },
    titleConfidence: { type: Type.INTEGER },
    creationPeriod: { type: Type.STRING },
    catalogueRaisonneMatch: {
      type: Type.OBJECT,
      properties: {
        matched: { type: Type.BOOLEAN },
        referenceName: { type: Type.STRING },
        notes: { type: Type.STRING }
      },
      required: ["matched", "referenceName", "notes"]
    },
    editionsInformation: { type: Type.STRING },
    isPosthumousReprint: { type: Type.BOOLEAN },
    posthumousReprintDetails: { type: Type.STRING },
    editionSynthesisEvidence: { type: Type.STRING }
  },
  required: [
    "likelyArtist", "artistConfidence", "artworkTitle", "titleConfidence", "creationPeriod",
    "catalogueRaisonneMatch", "editionsInformation", "isPosthumousReprint",
    "posthumousReprintDetails", "editionSynthesisEvidence"
  ]
};

// ---------------------------------------------------------------------------
// Stage 2a — Attribution Triage Agent (ATA-1.0)
// ---------------------------------------------------------------------------
export const TRIAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    schemaVersion: { type: Type.STRING },
    triageTimestamp: { type: Type.STRING },
    inputValidation: {
      type: Type.OBJECT,
      properties: {
        inputValidationError: { type: Type.BOOLEAN },
        lowSourceConfidence: { type: Type.BOOLEAN },
        veaExtractionConfidence: { type: Type.NUMBER },
        provisionalOutput: { type: Type.BOOLEAN }
      },
      required: ["inputValidationError", "lowSourceConfidence", "veaExtractionConfidence", "provisionalOutput"]
    },
    traditionIdentification: {
      type: Type.OBJECT,
      properties: {
        primaryTradition: { type: Type.STRING },
        traditionConfidence: { type: Type.NUMBER },
        supportingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
        contradictingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
        traditionNotes: { type: Type.STRING }
      },
      required: ["primaryTradition", "traditionConfidence", "supportingEvidence", "contradictingEvidence"]
    },
    periodEstimation: {
      type: Type.OBJECT,
      properties: {
        estimatedPeriodRange: { type: Type.STRING },
        periodConfidence: { type: Type.NUMBER }
      },
      required: ["estimatedPeriodRange", "periodConfidence"]
    },
    candidateArtists: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rank: { type: Type.INTEGER },
          artistName: { type: Type.STRING },
          candidateProbability: { type: Type.NUMBER },
          supportingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          contradictingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ["rank", "artistName", "candidateProbability", "supportingEvidence", "contradictingEvidence"]
      }
    },
    riskFlags: {
      type: Type.OBJECT,
      properties: {
        forgeryRisk: { type: Type.BOOLEAN },
        reprintRisk: { type: Type.BOOLEAN },
        editionComplexityRisk: { type: Type.BOOLEAN },
        misattributionRisk: { type: Type.BOOLEAN },
        authenticationBodyExists: { type: Type.BOOLEAN },
        physicalExaminationRequired: { type: Type.BOOLEAN }
      },
      required: ["forgeryRisk", "reprintRisk", "editionComplexityRisk", "misattributionRisk", "authenticationBodyExists", "physicalExaminationRequired"]
    },
    routingDecision: {
      type: Type.OBJECT,
      properties: {
        tier: { type: Type.INTEGER },
        specialistConfig: { type: Type.STRING },
        routingRationale: { type: Type.STRING },
        humanEscalationRequired: { type: Type.BOOLEAN },
        humanEscalationReason: { type: Type.STRING },
        alternativeConfig: { type: Type.STRING }
      },
      required: ["tier", "specialistConfig", "routingRationale", "humanEscalationRequired", "alternativeConfig"]
    },
    triageConfidenceSummary: {
      type: Type.OBJECT,
      properties: {
        overallTriageConfidence: { type: Type.NUMBER },
        criticalUnresolved: { type: Type.ARRAY, items: { type: Type.STRING } }
      },
      required: ["overallTriageConfidence", "criticalUnresolved"]
    }
  },
  required: [
    "schemaVersion", "inputValidation", "traditionIdentification", "periodEstimation",
    "candidateArtists", "riskFlags", "routingDecision", "triageConfidenceSummary"
  ]
};

// ---------------------------------------------------------------------------
// Stage 2b — Specialist Attribution Agent (ASA-1.0)
// ---------------------------------------------------------------------------
export const SPECIALIST_ATTRIBUTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    schemaVersion: { type: Type.STRING },
    specialistConfigUsed: { type: Type.STRING },
    attributionConclusion: {
      type: Type.OBJECT,
      properties: {
        attributedArtist: { type: Type.STRING },
        attributedArtistNative: { type: Type.STRING },
        attributionLevel: { type: Type.STRING },
        attributionConfidence: { type: Type.NUMBER },
        attributionEvidenceChain: { type: Type.ARRAY, items: { type: Type.STRING } },
        attributionCounterEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
        workTitle: { type: Type.STRING },
        workTitleNative: { type: Type.STRING },
        dateOrPeriod: { type: Type.STRING },
        technique: { type: Type.STRING },
        confirmedSeriesName: { type: Type.STRING }
      },
      required: ["attributedArtist", "attributionLevel", "attributionConfidence", "attributionEvidenceChain", "attributionCounterEvidence"]
    },
    catalogueRaisonne: {
      type: Type.OBJECT,
      properties: {
        referenceFound: { type: Type.BOOLEAN },
        catalogueName: { type: Type.STRING },
        plateOrCatalogueNumber: { type: Type.STRING },
        catalogueEditionInfo: { type: Type.STRING },
        humanReferenceRequired: { type: Type.BOOLEAN }
      },
      required: ["referenceFound", "humanReferenceRequired"]
    },
    reprintForgeryAssessment: {
      type: Type.OBJECT,
      properties: {
        reprintForgeryRisk: { type: Type.STRING },
        physicalExaminationRecommended: { type: Type.BOOLEAN }
      },
      required: ["reprintForgeryRisk", "physicalExaminationRecommended"]
    },
    seriesAndEditionIdentification: {
      type: Type.OBJECT,
      properties: {
        seriesConfirmed: { type: Type.BOOLEAN },
        seriesName: { type: Type.STRING },
        editionType: { type: Type.STRING },
        editionNotes: { type: Type.STRING }
      },
      required: ["seriesConfirmed", "editionType"]
    },
    valuationRelevantFindings: {
      type: Type.OBJECT,
      properties: {
        impressionPeriod: { type: Type.STRING },
        conditionNotes: { type: Type.STRING },
        rarityFactors: { type: Type.ARRAY, items: { type: Type.STRING } },
        discountFactors: { type: Type.ARRAY, items: { type: Type.STRING } },
        keyValueDrivers: { type: Type.ARRAY, items: { type: Type.STRING } }
      },
      required: ["rarityFactors", "discountFactors", "keyValueDrivers"]
    },
    researchConfidenceSummary: {
      type: Type.OBJECT,
      properties: {
        overallAttributionConfidence: { type: Type.NUMBER },
        humanEscalationRequired: { type: Type.BOOLEAN },
        humanEscalationReason: { type: Type.STRING },
        physicalExaminationRequired: { type: Type.BOOLEAN }
      },
      required: ["overallAttributionConfidence", "humanEscalationRequired", "physicalExaminationRequired"]
    },
    unresolvedQuestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          whyUnresolved: { type: Type.STRING },
          resolutionAction: { type: Type.STRING },
          confidenceImpact: { type: Type.STRING }
        },
        required: ["question", "resolutionAction", "confidenceImpact"]
      }
    },
    auctionComps: {
      type: Type.ARRAY,
      description: "2–3 verified auction comps collected during Stage 2b research. Empty array if none found.",
      items: {
        type: Type.OBJECT,
        properties: {
          artworkTitle: { type: Type.STRING },
          artist: { type: Type.STRING },
          technique: { type: Type.STRING },
          hammerPrice: { type: Type.STRING },
          saleDate: { type: Type.STRING },
          auctionHouse: { type: Type.STRING },
          conditionState: { type: Type.STRING },
          wasSoldInBroaderLot: { type: Type.BOOLEAN },
          broaderLotPriceAdjustment: { type: Type.STRING }
        },
        required: ["artworkTitle", "artist", "technique", "hammerPrice", "saleDate", "auctionHouse", "conditionState", "wasSoldInBroaderLot", "broaderLotPriceAdjustment"]
      }
    }
  },
  required: [
    "schemaVersion", "specialistConfigUsed", "attributionConclusion", "catalogueRaisonne",
    "reprintForgeryAssessment", "seriesAndEditionIdentification", "valuationRelevantFindings",
    "researchConfidenceSummary", "unresolvedQuestions", "auctionComps"
  ]
};

// ---------------------------------------------------------------------------
// Stage 3 — Valuation & Final Report
// ---------------------------------------------------------------------------
export const FINAL_REPORT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    likelyArtist: { type: Type.STRING, description: "The most likely artist of the print based on visual clues, signature, and style. If completely unknown/unidentifiable, state 'Unknown Printmaker' or 'Unidentified Artist'." },
    artistConfidence: { type: Type.INTEGER, description: "Confidence rating (from 0 to 100) regarding the artist identity." },
    artworkTitle: { type: Type.STRING, description: "The title or subject of the print artwork. If unknown, provide a descriptive title in brackets, like '[Seascape with Fishing Boats]'." },
    titleConfidence: { type: Type.INTEGER, description: "Confidence rating (from 0 to 100) regarding the artwork title." },
    creationPeriod: { type: Type.STRING, description: "Estimated date or period of creation, e.g., 'circa 1930', 'late 19th Century', '1888', 'Contemporary (circa 2010)'." },
    techniques: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          technique: { type: Type.STRING, description: "Name of the technique detected, e.g., 'Etching', 'Woodcut', 'Lithography', 'Screenprint', 'Aquatint', 'Giclée Reproduction'." },
          confidence: { type: Type.INTEGER, description: "Confidence percentage (from 0 to 100) that this technique was used." },
          evidenceIdentified: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Direct visual cues supporting this technique." },
          description: { type: Type.STRING, description: "A short explanation of how the technique manifests on the paper sheet." }
        },
        required: ["technique", "confidence", "evidenceIdentified", "description"]
      },
      description: "List of printing techniques identified in the artwork. Identify at least one primary technique."
    },
    auctionEstimate: {
      type: Type.OBJECT,
      properties: {
        lowEstimate: { type: Type.INTEGER, description: "Low-end estimated auction value scaled in the user's preferred currency, e.g., 500." },
        highEstimate: { type: Type.INTEGER, description: "High-end estimated auction value scaled in the user's preferred currency, e.g., 1000." },
        currency: { type: Type.STRING, description: "Currency code of preferred currency, e.g. 'USD', 'GBP', or 'EUR'." },
        formattedEstimate: { type: Type.STRING, description: "Formatted price estimate text using preferred currency symbol, e.g. '£500 - £1,000 GBP'." },
        valuationContext: { type: Type.STRING, description: "Detailed background context for this valuation." }
      },
      required: ["lowEstimate", "highEstimate", "currency", "formattedEstimate", "valuationContext"]
    },
    conditionNotes: {
      type: Type.OBJECT,
      properties: {
        overallGrade: { type: Type.STRING, description: "One of standard grades: 'Poor', 'Fair', 'Good', 'Excellent', 'Mint'." },
        issuesDetected: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of physical condition concerns seen on the paper, border, margins, or ink layout." },
        signatureStatus: { type: Type.STRING, description: "Describe any visible signature, hand numbering, or monogram." },
        mattingAndMargins: { type: Type.STRING, description: "Assessment of borders, margins, and presentation." },
        analysisDetails: { type: Type.STRING, description: "A narrative report summary analyzing the structural condition of the visible print piece." }
      },
      required: ["overallGrade", "issuesDetected", "signatureStatus", "mattingAndMargins", "analysisDetails"]
    },
    visualDescription: { type: Type.STRING, description: "Composition and iconography notes restricted to stylistic features, motifs, or formal qualities that directly support attribution to an artist or link to a specific period within an artist's stylistic development. Do not describe the image generally — focus only on what is evidentially relevant to attribution." },
    historicalContext: { type: Type.STRING, description: "Historical context focused on the artist's period of activity, the print tradition or movement this work belongs to, and how the specific stylistic features connect to known phases of the artist's output." },
    nextSteps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Custom recommendations for conservation, appraisal, or handling." },
    isLikelyReproductionOrPoster: { type: Type.BOOLEAN, description: "Set to true if there are high indicators of a mechanical reproduction rather than an authentic hand-pulled limited-edition print." },
    reproductionExplanation: { type: Type.STRING, description: "Provide details on why this is or isn't suspected of being a mechanical reproduction." },
    recentAuctionSales: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          artworkTitle: { type: Type.STRING, description: "Title of the print sold." },
          artist: { type: Type.STRING, description: "Artist name." },
          technique: { type: Type.STRING, description: "Detected technique." },
          saleDate: { type: Type.STRING, description: "Month and year of sale, e.g., 'October 2023'." },
          priceRealized: { type: Type.STRING, description: "Price achieved in formatted currency, e.g., '£2,760,000 GBP'." },
          auctionHouse: { type: Type.STRING, description: "Name of auction house and location." },
          conditionState: { type: Type.STRING, description: "Brief summary of print state/condition details." },
          wasSoldInBroaderLot: { type: Type.BOOLEAN, description: "Indicate if sold bundled as part of a broader lot." },
          broaderLotPriceAdjustment: { type: Type.STRING, description: "The price adjustment performed to derive single-item value." }
        },
        required: ["artworkTitle", "artist", "technique", "saleDate", "priceRealized", "auctionHouse", "conditionState", "wasSoldInBroaderLot", "broaderLotPriceAdjustment"]
      },
      description: "A list of 2 or 3 recent actual or highly realistic auction sales for the same or similar prints."
    },
    inferredDimensions: { type: Type.STRING, description: "Estimated physical dimensions of the print." },
    signatureAnalysis: { type: Type.STRING, description: "Detailed critique of the custom signature close-up." },
    damageAnalysis: { type: Type.STRING, description: "Detailed microscopic review of the paper decay close-up image." },
    editionSizeAndPrintNumber: { type: Type.STRING, description: "Details regarding the print number and global edition size." },
    visualEvidenceHighlights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "Name of the visual evidence feature." },
          observation: { type: Type.STRING, description: "A short descriptive observation backing up what is seen in this crop." },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: "Normalized bounding box coordinates [ymin, xmin, ymax, xmax] from 0 to 1000." }
        },
        required: ["label", "observation", "box_2d"]
      },
      description: "A collection of 2 to 4 visual evidence highlights cropped from the primary scan."
    }
  },
  required: [
    "likelyArtist", "artistConfidence", "artworkTitle", "titleConfidence", "creationPeriod",
    "techniques", "auctionEstimate", "conditionNotes", "visualDescription", "historicalContext",
    "nextSteps", "isLikelyReproductionOrPoster", "reproductionExplanation", "recentAuctionSales",
    "inferredDimensions", "signatureAnalysis", "damageAnalysis", "editionSizeAndPrintNumber",
    "visualEvidenceHighlights"
  ]
};

// Pre-translated version for Anthropic tool input_schema (standard JSON Schema, types lowercased).
// Eliminates the 220-line inline duplication in ConfigurableClaudeAppraiser.
export const FINAL_REPORT_CLAUDE_SCHEMA = translateSchemaToStandardJsonSchema(FINAL_REPORT_RESPONSE_SCHEMA);

// Slim schema for Stage 3 web-search call — valuation fields only.
// All other PrintAnalysisReport fields are passed through from Stage 1/2b and merged in the orchestrator.
export const STAGE3_VALUATION_ONLY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    auctionEstimate: {
      type: Type.OBJECT,
      properties: {
        lowEstimate: { type: Type.INTEGER, description: "Low-end estimated auction value as a plain integer with NO currency symbol or commas, e.g. 1200 not '$1,200'." },
        highEstimate: { type: Type.INTEGER, description: "High-end estimated auction value as a plain integer with NO currency symbol or commas, e.g. 2800 not '$2,800'." },
        currency: { type: Type.STRING, description: "Currency code only, e.g. 'USD', 'GBP', 'EUR'. No symbols." },
        formattedEstimate: { type: Type.STRING, description: "Human-readable price range using the currency code only, NOT the symbol, e.g. '1200 - 2800 USD'. The UI adds the symbol — do not include it here." },
        valuationContext: { type: Type.STRING, description: "Explanation of the valuation rationale, condition penalties applied, and how comps informed the estimate." }
      },
      required: ["lowEstimate", "highEstimate", "currency", "formattedEstimate", "valuationContext"]
    },
    recentAuctionSales: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          artworkTitle: { type: Type.STRING },
          artist: { type: Type.STRING },
          technique: { type: Type.STRING },
          saleDate: { type: Type.STRING },
          priceRealized: { type: Type.STRING },
          auctionHouse: { type: Type.STRING },
          conditionState: { type: Type.STRING },
          wasSoldInBroaderLot: { type: Type.BOOLEAN },
          broaderLotPriceAdjustment: { type: Type.STRING }
        },
        required: ["artworkTitle", "artist", "technique", "saleDate", "priceRealized", "auctionHouse", "conditionState", "wasSoldInBroaderLot", "broaderLotPriceAdjustment"]
      },
      description: "2–3 recent verifiable auction comps for the same or similar prints."
    },
    nextSteps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Recommendations for conservation, further authentication, or sale strategy." },
    editionSizeAndPrintNumber: { type: Type.STRING, description: "Final synthesized edition and print number assessment." },
    isLikelyReproductionOrPoster: { type: Type.BOOLEAN, description: "True if evidence points to a mechanical reproduction." },
    reproductionExplanation: { type: Type.STRING, description: "Reasoning behind the reproduction assessment." }
  },
  required: ["auctionEstimate", "recentAuctionSales", "nextSteps", "editionSizeAndPrintNumber", "isLikelyReproductionOrPoster", "reproductionExplanation"]
};

// ---------------------------------------------------------------------------
// Stage 1c — Appraiser Input Agent (AIA-1.0) — see ADR-0004
// ---------------------------------------------------------------------------
const STATUS_ENUM = { type: Type.STRING, description: "'hypothesis' | 'documented_fact' | 'absent'" };

export const APPRAISER_INPUT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    schemaVersion: { type: Type.STRING },
    inputReceived: {
      type: Type.OBJECT,
      properties: {
        inscribedMarksNotes: { type: Type.BOOLEAN },
        provenanceNotes: { type: Type.BOOLEAN },
        conditionNotes: { type: Type.BOOLEAN },
        catalogueNotes: { type: Type.BOOLEAN }
      },
      required: ["inscribedMarksNotes", "provenanceNotes", "conditionNotes", "catalogueNotes"]
    },
    claimedAttribution: {
      type: Type.OBJECT,
      properties: {
        artist: { type: Type.STRING },
        title: { type: Type.STRING },
        period: { type: Type.STRING },
        technique: { type: Type.STRING },
        status: STATUS_ENUM,
        sourceField: { type: Type.STRING, description: "'inscribedMarksNotes' | 'provenanceNotes' | 'conditionNotes' | 'catalogueNotes' | null" },
        sourceExcerpt: { type: Type.STRING }
      },
      required: ["artist", "title", "period", "technique", "status", "sourceField", "sourceExcerpt"]
    },
    inscriptionClaims: {
      type: Type.OBJECT,
      properties: {
        signatureClaim: { type: Type.STRING },
        editionClaim: { type: Type.STRING },
        editionSizeClaim: { type: Type.INTEGER },
        monogramOrStampClaim: { type: Type.STRING },
        status: STATUS_ENUM
      },
      required: ["signatureClaim", "editionClaim", "editionSizeClaim", "monogramOrStampClaim", "status"]
    },
    provenanceChain: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ownerOrEntity: { type: Type.STRING },
          dateOrPeriod: { type: Type.STRING },
          status: STATUS_ENUM,
          sourceExcerpt: { type: Type.STRING }
        },
        required: ["ownerOrEntity", "dateOrPeriod", "status", "sourceExcerpt"]
      }
    },
    conditionClaims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: { type: Type.STRING },
          status: STATUS_ENUM,
          sourceExcerpt: { type: Type.STRING }
        },
        required: ["claim", "status", "sourceExcerpt"]
      }
    },
    catalogueReferences: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ref: { type: Type.STRING },
          source: { type: Type.STRING, description: "'regex' | 'llm'" }
        },
        required: ["ref", "source"]
      }
    },
    literatureOrExhibitionClaims: { type: Type.ARRAY, items: { type: Type.STRING } },
    dimensionsClaim: {
      type: Type.OBJECT,
      properties: {
        widthCm: { type: Type.NUMBER },
        heightCm: { type: Type.NUMBER },
        kind: { type: Type.STRING },
        source: { type: Type.STRING, description: "'regex' | 'llm' | 'both'" }
      },
      required: ["widthCm", "heightCm", "kind", "source"]
    },
    paperOrSupport: { type: Type.STRING, description: "Paper/support material as stated in the notes, e.g. 'BFK Rives wove', 'wove paper', 'vellum'. null if not stated." },
    rawNotes: {
      type: Type.OBJECT,
      properties: {
        inscribedMarksNotes: { type: Type.STRING },
        provenanceNotes: { type: Type.STRING },
        conditionNotes: { type: Type.STRING },
        catalogueNotes: { type: Type.STRING }
      },
      required: ["inscribedMarksNotes", "provenanceNotes", "conditionNotes", "catalogueNotes"]
    },
    overallExtractionConfidence: { type: Type.NUMBER },
    lowConfidenceFlags: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: [
    "schemaVersion", "inputReceived", "claimedAttribution", "inscriptionClaims",
    "provenanceChain", "conditionClaims", "catalogueReferences", "literatureOrExhibitionClaims",
    "dimensionsClaim", "paperOrSupport", "rawNotes", "overallExtractionConfidence", "lowConfidenceFlags"
  ]
};
