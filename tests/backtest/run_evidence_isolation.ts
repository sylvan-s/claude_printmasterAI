// Evidence-isolation harness — same blind Roseberys backtest as run_backtest.ts, but
// with a restricted attribution evidence set, to test what the pipeline can reach on
// Stage 1c (appraiser notes) + Stage 1d (DINOv2/CLIP match against the ACKG's own
// image index) alone.
//
// Two suppressions relative to the production `claude-4stage` path:
//
//   1. Stage 1b (Gemini reverse image search) is switched off at config level
//      (enableVisualSearch: false), so the two-pass classifier's R vote never fires.
//   2. Stage 1a's AUTHORSHIP vote is suppressed. VEA still runs — the pipeline needs
//      its physical description for Stage 2b/3, and it is the only stage that sees
//      the image — but the artist-naming evidence cells it fills (veaNamesArtist /
//      veaArtistName / veaAuthorshipSignalLegible / veaSignatureConfidence) are
//      blanked before the deterministic tree reads them, so the V vote never fires.
//      VEA's non-authorship observations (including any legible in-image title) are
//      left alone: they feed the ACKG work query, which this harness deliberately
//      keeps.
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
} from "../../src/appraisal/appraiser";
import { resolveSaleRef, type AuctionRef } from "../../benchmark/src/roseberys/discover";
import { fetchLotByNumber, imageUrl, lotUrl, type RawLot } from "../../benchmark/src/roseberys/api";
import { parseDescription, type ParsedLot } from "../../benchmark/src/roseberys/parse";
import { compareResults, type BacktestComparison } from "./compare";
import { buildBacktestReport } from "./build_report";
import { assertBlindOrExit } from "./blindness";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_METHOD = "claude-4stage";

// ───────────────────────────────────────────────────────────────────────────────
// The restricted appraiser
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Blanks the VEA authorship cells on the Stage 2a evidence agent's output, on the way
 * back from the model and before `runEvidenceTree` reads them. Hooking the tool call
 * rather than reimplementing runStage2aTriage keeps the retry/content-filter/degrade
 * behaviour of the real stage intact.
 */
class EvidenceIsolationAppraiser extends FourStageAppraiser {
  public veaVoteSuppressed: { veaNamesArtist: boolean; veaArtistName: string; legible: boolean; sigConf: number } | null = null;

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
      const a = out.artistEvidence;
      this.veaVoteSuppressed = {
        veaNamesArtist: !!a.veaNamesArtist,
        veaArtistName: a.veaArtistName || "",
        legible: !!a.veaAuthorshipSignalLegible,
        sigConf: typeof a.veaSignatureConfidence === "number" ? a.veaSignatureConfidence : -1,
      };
      console.log(
        `[Isolation] suppressing VEA authorship vote — agent had filled: ` +
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

interface Args { sale?: string; auctionId?: number; saleCode?: string; lot: string; method: string; allowLeak: boolean }

function parseArgs(argv: string[]): Args {
  let sale: string | undefined, auctionId: number | undefined, saleCode: string | undefined;
  let lot: string | undefined, method = DEFAULT_METHOD, allowLeak = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sale") sale = argv[++i];
    else if (a === "--auction-id") auctionId = Number(argv[++i]);
    else if (a === "--sale-code") saleCode = argv[++i];
    else if (a === "--lot") lot = argv[++i];
    else if (a === "--method") method = argv[++i];
    else if (a === "--allow-leak") allowLeak = true;
    else { console.error(`Unrecognised argument: ${a}`); process.exit(1); }
  }
  if (!lot || (!sale && !auctionId)) {
    console.error("Usage: (--sale <ref> | --auction-id <id> [--sale-code <code>]) --lot <n> [--method <id>] [--allow-leak]");
    process.exit(1);
  }
  return { sale, auctionId, saleCode, lot, method, allowLeak };
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
  const { sale, auctionId, saleCode, lot: lotNumber, method, allowLeak } = parseArgs(process.argv.slice(2));

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
  const blindnessCompromised = assertBlindOrExit(groundTruth.leakRisks, { allowLeak, tag: "Isolation" });

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
  const rawCatalogueNotes =
    [groundTruth.bodyLines.join("\n"), catalogueRefsLine].filter(Boolean).join("\n\n") || undefined;

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
  console.log(`[Isolation] Stage 1b: DISABLED | VEA authorship vote: SUPPRESSED | Stage 1d: ON | ACKG K/K_work: ON`);

  const t0 = Date.now();
  const report = await appraiser.appraise(input);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Isolation] Done in ${elapsedS}s — app says: "${report.likelyArtist}" / "${report.artworkTitle}"`);

  const comparison: BacktestComparison = compareResults(report, groundTruth, rawLot);
  console.log(`[Isolation] Catalogue says: "${groundTruth.artist}" / "${groundTruth.title}"`);
  console.log(`[Isolation] Verdict: ${comparison.overallVerdict}`);
  for (const d of comparison.materialDifferences) console.log(`  - ${d}`);

  const lotId = `${auction.saleCode}-${rawLot.lot_number}-1c1d`;
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
        evidenceIsolation: {
          stage1bDisabled: true,
          veaAuthorshipVoteSuppressed: true,
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
