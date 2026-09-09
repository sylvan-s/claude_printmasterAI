// Evidence-isolation harness — same blind Roseberys backtest as run_backtest.ts, but
// with a restricted attribution evidence set, to test what the pipeline can reach on
// Stage 1c (appraiser notes) + Stage 1d (DINOv2/CLIP match against the ACKG's own
// image index) alone.
//
// Two suppressions relative to the production `claude-4stage` path:
//
//   1. Stage 1b (Gemini reverse image search) is switched off at config level
//      (enableVisualSearch: false), so the two-pass classifier's R vote never fires.
//   2. Stage 1a (VEA) DOES NOT RUN. No vision call is made at all; a stub result
//      standing for "not run" is passed downstream in its place.
//
//      This started out as suppressing VEA's authorship vote while still letting it
//      run, which was not enough. VEA's non-authorship prose still steered the
//      evidence agent: on A0793 lot 148 VEA's description of the image produced
//      `observedTitle: "Reclining figure beneath valance"`, that string was what the
//      agent handed to query_ackg_work, and the resulting match to an unrelated
//      Hockney work titled "Reclining Figure" is what the work pass then resolved to.
//      A run that means "1c + 1d only" cannot have Stage 1a shaping the graph queries.
//
//      The cost is real and deliberate: Stage 2b and Stage 3 lose every physical
//      observation (technique, plate mark, paper, condition, signatures, dimensions),
//      so the specialist and the valuation work from Stage 1c's notes and Stage 1d's
//      match alone. Read the estimate from these runs accordingly — this harness tests
//      what 1c+1d can carry, not what the production pipeline would produce.
//
// The ACKG votes (K / K_work) and Stage 1d's D vote are both kept — 1d's candidates
// come out of the same graph, so they are one internal-evidence path.
//
// Also accepts --auction-id, because resolveSaleRef() reads the public sitemap and a
// sale that has not been listed there yet (e.g. A0793 / auction 673 at time of
// writing) is unresolvable by sale code.
//
// Usage:
//   npx tsx tests/backtest/run_evidence_isolation.ts --auction-id 673 --sale-code A0793 --lot 46
//   npx tsx tests/backtest/run_evidence_isolation.ts --sale A0785 --lot 12 --method claude-4stage-fast

import dotenv from "dotenv";
dotenv.config();

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import {
  FourStageAppraiser,
  appraiserConfigs,
  type AppraisalInput,
  type AppraisalMethodConfig,
  printUsageSummary,
  usageSummary,
} from "../../src/appraisal/appraiser";
import type { VisualExtractionResult } from "../../src/types";
import type { EvidenceAgentOutput } from "../../src/appraisal/stage2a_evidence";
import type { AckgLoopEvent } from "../../src/appraisal/appraiser";
import { resolveSaleRef, type AuctionRef } from "../../benchmark/src/roseberys/discover";
import { fetchLotByNumber, imageUrl, lotUrl, type RawLot } from "../../benchmark/src/roseberys/api";
import { parseDescription, type ParsedLot } from "../../benchmark/src/roseberys/parse";
import { compareResults, type BacktestComparison } from "./compare";
import { buildBacktestReport } from "./build_report";
import { assertBlindOrExit } from "./blindness";
import { buildEvidenceRecord } from "./evidence_capture";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_METHOD = "claude-4stage";

// ───────────────────────────────────────────────────────────────────────────────
// The restricted appraiser
// ───────────────────────────────────────────────────────────────────────────────

/**
 * A schema-shaped VisualExtractionResult standing for "Stage 1a was not run".
 *
 * Every field downstream reads is optional-chained or an array (verified across
 * projectVeaForAttribution, assembleReport, and the Stage 2b/3 prompt builders), so
 * empties are safe. `haltRecommended` must stay false — true short-circuits the whole
 * pipeline into the halt report. `overallExtractionConfidence: 0` plus the explicit
 * lowConfidenceFlag is what tells the Stage 2a evidence agent it is looking at an
 * absence of observation rather than an observation of absence.
 */
function notRunVea(): VisualExtractionResult {
  return {
    schemaVersion: "VEA-1.1",
    inspectionTimestamp: new Date().toISOString(),
    imagesReceived: { primaryScan: false, supplementaryScanCount: 0 },
    imageAuthenticity: { haltRecommended: false } as any,
    titleInscriptions: [],
    signatures: [],
    editionInfo: [],
    editionInfoAbsent: true,
    printingTechniques: [],
    plateMark: {} as any,
    dimensions: {} as any,
    paper: {} as any,
    condition: {} as any,
    inkAndColour: {} as any,
    stampsAndLabels: [],
    composition: {} as any,
    photographicQuality: {} as any,
    visualEvidenceHighlights: [],
    overallExtractionConfidence: 0,
    lowConfidenceFlags: [
      "Stage 1a (Visual Extraction Agent) WAS NOT RUN in this appraisal — no image was " +
        "examined and no physical observation exists. Every field below is empty because " +
        "nothing was looked at, NOT because the work lacks those features. Draw no inference " +
        "from the absence of signatures, inscriptions, technique or condition data.",
    ],
    provisionalOutput: true,
  };
}

/**
 * Skips Stage 1a entirely and blanks any VEA authorship cell the evidence agent still
 * manages to fill. Hooking the tool call rather than reimplementing runStage2aTriage
 * keeps the retry/content-filter/degrade behaviour of the real stage intact.
 */
class EvidenceIsolationAppraiser extends FourStageAppraiser {
  public veaVoteSuppressed: { veaNamesArtist: boolean; veaArtistName: string; legible: boolean; sigConf: number } | null = null;
  /** The Stage 2a cells exactly as the agent filled them — the pipeline itself keeps no copy. */
  public agentCells: EvidenceAgentOutput | null = null;
  /** Every ACKG tool-loop step, for the stored record. */
  public ackgRounds: AckgLoopEvent[] = [];

  protected onAckgLoopEvent(e: AckgLoopEvent): void {
    this.ackgRounds.push(e);
    super.onAckgLoopEvent(e); // keep the live log unchanged
  }

  /** No vision call. Returns the "not run" stub without touching the model. */
  protected async runStage1VEA(): Promise<VisualExtractionResult> {
    console.log("[Isolation] Stage 1a (VEA) SKIPPED — no vision call made; passing a 'not run' stub downstream");
    return notRunVea();
  }

  protected async callClaudeWithAckgTool(
    modelName: string,
    systemInstruction: string,
    userText: string,
    maxTokens: number = 8192,
    finalTool: { name: string; description: string; schema: any },
    opts: { extraTools?: any[]; maxRounds?: number } = {},
  ): Promise<any> {
    const out = await super.callClaudeWithAckgTool(modelName, systemInstruction, userText, maxTokens, finalTool, opts);
    if (finalTool?.name === "report_attribution_evidence" && out?.artistEvidence) {
      // Snapshot BEFORE the VEA blanking below, so the record shows what the agent said.
      this.agentCells = JSON.parse(JSON.stringify(out)) as EvidenceAgentOutput;
      const a = out.artistEvidence;
      this.veaVoteSuppressed = {
        veaNamesArtist: !!a.veaNamesArtist,
        veaArtistName: a.veaArtistName || "",
        legible: !!a.veaAuthorshipSignalLegible,
        sigConf: typeof a.veaSignatureConfidence === "number" ? a.veaSignatureConfidence : -1,
      };
      // With Stage 1a skipped there is nothing for the agent to read an artist off, so
      // this should always be a no-op now. Kept as a tripwire: if it ever reports
      // veaNamesArtist=true, the agent invented a VEA observation out of the stub.
      console.log(
        `[Isolation] VEA authorship cells (expected empty — Stage 1a did not run): ` +
          `veaNamesArtist=${this.veaVoteSuppressed.veaNamesArtist} ` +
          `veaArtistName="${this.veaVoteSuppressed.veaArtistName}" ` +
          `legible=${this.veaVoteSuppressed.legible} sigConf=${this.veaVoteSuppressed.sigConf}`,
      );
      a.veaNamesArtist = false;
      a.veaArtistName = "";
      a.veaAuthorshipSignalLegible = false;
      a.veaSignatureConfidence = -1;
    }
    return out;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────────

interface Args { sale?: string; auctionId?: number; saleCode?: string; lot: string; method: string; allowLeak: boolean; attributed: boolean }

function parseArgs(argv: string[]): Args {
  let sale: string | undefined, auctionId: number | undefined, saleCode: string | undefined;
  let lot: string | undefined, method = DEFAULT_METHOD, allowLeak = false, attributed = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sale") sale = argv[++i];
    else if (a === "--auction-id") auctionId = Number(argv[++i]);
    else if (a === "--sale-code") saleCode = argv[++i];
    else if (a === "--lot") lot = argv[++i];
    else if (a === "--method") method = argv[++i];
    else if (a === "--allow-leak") allowLeak = true;
    else if (a === "--attributed") attributed = true;
    else { console.error(`Unrecognised argument: ${a}`); process.exit(1); }
  }
  if (!lot || (!sale && !auctionId)) {
    console.error("Usage: (--sale <ref> | --auction-id <id> [--sale-code <code>]) --lot <n> [--method <id>] [--allow-leak] [--attributed]");
    process.exit(1);
  }
  return { sale, auctionId, saleCode, lot, method, allowLeak, attributed };
}

async function downloadImageBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: res.headers.get("content-type") || "image/jpeg" };
}

const slugify = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "lot";

// ───────────────────────────────────────────────────────────────────────────────

async function main() {
  const { sale, auctionId, saleCode, lot: lotNumber, method, allowLeak, attributed } = parseArgs(process.argv.slice(2));

  let auction: AuctionRef;
  if (auctionId) {
    auction = { auctionId, saleCode: saleCode ?? String(auctionId), slug: "", url: "" };
    console.log(`[Isolation] Using auction_id ${auctionId} directly (sale code ${auction.saleCode}) — sitemap bypassed`);
  } else {
    const resolved = await resolveSaleRef(sale!);
    if (!resolved) throw new Error(`Could not resolve sale reference "${sale}"`);
    auction = resolved;
    console.log(`[Isolation] Sale resolved: ${auction.saleCode} (auction_id ${auction.auctionId})`);
  }

  console.log(`[Isolation] Fetching lot ${lotNumber}...`);
  const rawLot: RawLot | null = await fetchLotByNumber(auction.auctionId, lotNumber);
  if (!rawLot) throw new Error(`Lot ${lotNumber} not found in sale ${auction.saleCode}`);

  const imgUrl = imageUrl(rawLot);
  if (!imgUrl) throw new Error(`Lot ${lotNumber} has no primary image`);
  console.log(`[Isolation] Downloading primary image: ${imgUrl}`);
  const { base64, mimeType } = await downloadImageBase64(imgUrl);

  const groundTruth: ParsedLot = parseDescription(rawLot.description);
  // Hard-stops unless --allow-leak: a body that names the artist makes the run
  // non-blind, and Stage 1c gets that text verbatim. See ./blindness.ts.
  // Under --attributed the run is deliberately NOT blind, so the guard does not apply.
  const blindnessCompromised = attributed
    ? "attribution deliberately supplied (--attributed) — this run is not blind by design"
    : assertBlindOrExit(groundTruth.leakRisks, { allowLeak, tag: "Isolation" });

  const baseConfig = appraiserConfigs.find((c) => c.id === method);
  if (!baseConfig) throw new Error(`Unknown method "${method}"`);
  const config: AppraisalMethodConfig = {
    ...baseConfig,
    id: `${baseConfig.id}-1c1d`,
    name: `${baseConfig.name} — 1c+1d evidence isolation`,
    enableVisualSearch: false,   // kills the Stage 1b R vote
    enableEmbeddingMatch: true,  // Stage 1d D vote must be live
  };

  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined;
  const appraiser = new EvidenceIsolationAppraiser(config, ai);

  const catalogueRefsLine = groundTruth.catalogueRefs.length
    ? `Catalogue reference(s): ${groundTruth.catalogueRefs.join(", ")}`
    : null;
  // --attributed: hand Stage 1c the artist and title the blind runs withhold, in the
  // catalogue's own header form — what an appraiser transcribing an attributed lot would
  // type. The qualifier matters and is kept: "after Picasso" is a different object, and a
  // different value, from "Picasso". Nationality/life dates are deliberately omitted —
  // parseDescription mis-assigns them on some lots (A0793/113 put the title in
  // `nationality`), and they add nothing to a valuation.
  const attributionHeader = attributed
    ? [
        `${groundTruth.artistQualifier && groundTruth.artistQualifier !== "certain" ? `${groundTruth.artistQualifier} ` : ""}${groundTruth.artist ?? ""}`.trim(),
        `${groundTruth.title ?? ""}${groundTruth.year ? `, ${groundTruth.year}` : ""}`.trim(),
      ]
        .filter(Boolean)
        .join(",\n") + ";"
    : null;

  const rawCatalogueNotes =
    [attributionHeader, groundTruth.bodyLines.join("\n"), catalogueRefsLine].filter(Boolean).join("\n\n") || undefined;

  const input: AppraisalInput = {
    imageBase64: base64,
    mimeType,
    currency: "GBP",
    inscribedMarksNotes: groundTruth.inscriptions || undefined,
    provenanceNotes: groundTruth.provenance || undefined,
    conditionNotes: groundTruth.condition || undefined,
    catalogueNotes: rawCatalogueNotes,
    testingExcludeSourceListing: `Roseberys, sale ${auction.saleCode}, lot ${rawLot.lot_number} (${lotUrl(rawLot)})`,
  };

  const notesFieldsUsed = (["inscribedMarksNotes", "provenanceNotes", "conditionNotes", "catalogueNotes"] as const)
    .filter((k) => input[k]);
  console.log(`[Isolation] Stage 1c notes populated: ${notesFieldsUsed.join(", ") || "(none)"}`);
  console.log(`[Isolation] Stage 1a (VEA): NOT RUN | Stage 1b: DISABLED | Stage 1d: ON | ACKG K/K_work: ON | attribution: ${attributed ? "SUPPLIED to Stage 1c" : "withheld (blind)"}`);

  const t0 = Date.now();
  const report = await appraiser.appraise(input);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Isolation] Done in ${elapsedS}s — app says: "${report.likelyArtist}" / "${report.artworkTitle}"`);

  // report.modelUsed is assembled inside the pipeline and still names a Stage 1 model
  // that was never called. Correct it rather than storing a claim that isn't true.
  if (report.modelUsed) report.modelUsed = report.modelUsed.replace(/S1: [^|\]]+/, "S1: skip (VEA not run) ");

  printUsageSummary();

  const comparison: BacktestComparison = compareResults(report, groundTruth, rawLot);
  const est = report.auctionEstimate;
  const gtLow = rawLot.low_estimate ?? null;
  const gtHigh = rawLot.high_estimate ?? null;
  if (est && gtLow != null && gtHigh != null) {
    const appMid = ((est.lowEstimate ?? 0) + (est.highEstimate ?? 0)) / 2;
    const gtMid = (gtLow + gtHigh) / 2;
    const ratio = gtMid > 0 ? appMid / gtMid : 0;
    const overlaps = (est.lowEstimate ?? 0) <= gtHigh && (est.highEstimate ?? 0) >= gtLow;
    const midInRange = appMid >= gtLow && appMid <= gtHigh;
    console.log(
      `[Valuation] app ${est.lowEstimate}-${est.highEstimate} vs catalogue ${gtLow}-${gtHigh} | ` +
        `midpoint ratio ${ratio.toFixed(2)} | ranges ${overlaps ? "OVERLAP" : "DISJOINT"} | ` +
        `app midpoint ${midInRange ? "inside" : "OUTSIDE"} the catalogue range`,
    );
  }
  console.log(`[Isolation] Catalogue says: "${groundTruth.artist}" / "${groundTruth.title}"`);
  console.log(`[Isolation] Verdict: ${comparison.overallVerdict}`);
  for (const d of comparison.materialDifferences) console.log(`  - ${d}`);

  const lotId = `${auction.saleCode}-${rawLot.lot_number}-1c1d${attributed ? "-attr" : ""}`;
  const outDir = `${__dirname}/output/${slugify(lotId)}`;
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    `${outDir}/result.json`,
    JSON.stringify(
      {
        lotId,
        sale: auction,
        lotUrl: lotUrl(rawLot),
        method: config.id,
        blindnessCompromised,
        tokenUsage: usageSummary(),
        stage2aEvidence: buildEvidenceRecord(
          appraiser.agentCells,
          report.stage1dResult,
          report.stage1cResult,
          !!report.stage1Result?.imageAuthenticity?.haltRecommended,
          appraiser.ackgRounds,
        ),
        attributionProvided: attributed,
        attributionHeaderSentToStage1c: attributionHeader,
        evidenceIsolation: {
          stage1aVeaRun: false,
          stage1aNote:
            "No vision call was made. Stage 2b and Stage 3 therefore had no physical " +
            "observation to work from, so the estimate reflects Stage 1c notes + Stage 1d " +
            "match only and is not comparable to a production run.",
          stage1bDisabled: true,
          veaAuthorshipCellsAsFilledByAgent: appraiser.veaVoteSuppressed,
          stage1dEnabled: true,
          ackgVotesEnabled: true,
        },
        appraiserInputNotes: {
          inscribedMarksNotes: input.inscribedMarksNotes ?? null,
          provenanceNotes: input.provenanceNotes ?? null,
          conditionNotes: input.conditionNotes ?? null,
          catalogueNotes: input.catalogueNotes ?? null,
        },
        testingExcludeSourceListing: input.testingExcludeSourceListing ?? null,
        report,
        groundTruth,
        rawLot: { ...rawLot, description: undefined },
        rawLotDescriptionHtml: rawLot.description,
        comparison,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    `${outDir}/report.html`,
    buildBacktestReport({
      lotId,
      lotUrl: lotUrl(rawLot),
      imageDataUrl: `data:${mimeType};base64,${base64}`,
      method: config.id,
      appraiserInputNotes: {
        inscribedMarksNotes: input.inscribedMarksNotes ?? null,
        provenanceNotes: input.provenanceNotes ?? null,
        conditionNotes: input.conditionNotes ?? null,
        catalogueNotes: input.catalogueNotes ?? null,
      },
      report,
      groundTruth,
      rawLot,
      comparison,
    }),
  );

  console.log(`\n[Isolation] Wrote ${outDir}/result.json and report.html`);
  await closeDriver();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
