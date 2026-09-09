// Backtest harness — Part 1: given a Roseberys sale + lot number, pull the primary
// lot image and description, and run both through the real appraisal pipeline —
// the image as the primary scan, the description as the Appraiser Input Agent's
// (Stage 1c) notes, exactly as a human appraiser transcribing the catalogue
// would. `catalogueNotes` carries the raw, unprocessed catalogue body verbatim —
// dimensions, paper/support, technique/medium, edition markings, printer/
// publisher, all as typed by Roseberys — while `inscribedMarksNotes` and
// `provenanceNotes` additionally get parseDescription()'s cleanly-split
// inscription and provenance lines, since those already have a natural home in
// Stage 1c's own box structure. Part 2: diff the pipeline's output against the
// catalogue's own facts and flag material differences (artist, title, estimate).
//
// The artist name and title themselves are never fed in — parseDescription()
// splits off the artist/nationality/title header from the rest of the catalogue
// body, and none of Stage 1c's four boxes is "who is the artist" in the real UI
// either; that's an assessment the pipeline is meant to reach on its own, not a
// field a human appraiser types in. The auction estimate (low_estimate/
// high_estimate) is likewise never passed in — only used afterwards for
// comparison.
//
// Usage — see README.md for full details:
//   npx tsx tests/backtest/run_backtest.ts --sale A0800 --lot 123
//   npx tsx tests/backtest/run_backtest.ts --sale 665 --lot 45A --method claude-4stage-fast

import dotenv from "dotenv";
dotenv.config();

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { appraiserConfigs, type AppraisalInput } from "../../src/appraisal/appraiser";
import { resolveSaleRef } from "../../benchmark/src/roseberys/discover";
import { fetchLotByNumber, imageUrl, lotUrl, type RawLot } from "../../benchmark/src/roseberys/api";
import { parseDescription, type ParsedLot } from "../../benchmark/src/roseberys/parse";
import { compareResults, type BacktestComparison } from "./compare";
import { buildBacktestReport } from "./build_report";
import { assertBlindOrExit } from "./blindness";
import { appraiserWithEvidenceCapture, buildEvidenceRecord } from "./evidence_capture";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_METHOD = "claude-4stage"; // production default

interface Args {
  sale: string;
  lot: string;
  method: string;
  allowLeak: boolean;
}

function parseArgs(argv: string[]): Args {
  let sale: string | undefined;
  let lot: string | undefined;
  let method = DEFAULT_METHOD;
  let allowLeak = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sale") sale = argv[++i];
    else if (arg === "--lot") lot = argv[++i];
    else if (arg === "--method") method = argv[++i];
    else if (arg === "--allow-leak") allowLeak = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unrecognised argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!sale || !lot) {
    console.error("Both --sale and --lot are required.\n");
    printHelp();
    process.exit(1);
  }
  return { sale, lot, method, allowLeak };
}

function printHelp() {
  console.error(`
Backtest harness — run the real pipeline blind against a Roseberys lot and diff
the output against the withheld catalogue facts.

  --sale <ref>      Auction id ("665"), sale code ("A0800"), or slug fragment
  --lot <number>     Lot number as shown in the catalogue, e.g. "123" or "45A"
  --method <id>      Appraiser config id from appraiserConfigs (default: ${DEFAULT_METHOD})
  --allow-leak       Run even when the catalogue body names the artist. Without it
                     such a lot aborts, because Stage 1c would receive the name
                     verbatim and the run would not be blind. Recorded in the
                     output as blindnessCompromised.

Example:
  npx tsx tests/backtest/run_backtest.ts --sale A0800 --lot 123
`);
}

async function downloadImageBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "image/jpeg";
  return { base64: buf.toString("base64"), mimeType };
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "lot";
}

async function main() {
  const { sale, lot: lotNumber, method, allowLeak } = parseArgs(process.argv.slice(2));

  console.log(`[Backtest] Resolving sale "${sale}"...`);
  const auction = await resolveSaleRef(sale);
  if (!auction) throw new Error(`Could not resolve sale reference "${sale}"`);
  console.log(`[Backtest] Sale resolved: ${auction.saleCode} (auction_id ${auction.auctionId})`);

  console.log(`[Backtest] Fetching lot ${lotNumber}...`);
  const rawLot: RawLot | null = await fetchLotByNumber(auction.auctionId, lotNumber);
  if (!rawLot) throw new Error(`Lot ${lotNumber} not found in sale ${auction.saleCode}`);

  const imgUrl = imageUrl(rawLot);
  if (!imgUrl) throw new Error(`Lot ${lotNumber} has no primary image`);
  console.log(`[Backtest] Downloading primary image: ${imgUrl}`);
  const { base64, mimeType } = await downloadImageBase64(imgUrl);

  // Ground truth — parsed once, used two ways below: most of it becomes the
  // Appraiser Input Agent's notes (see below); the whole object is also the
  // answer key for Part 2 comparison. Catalogue refs / printer / publisher in
  // parseDescription()'s leakRisks are expected here (they're deliberately
  // sent as notes content) — only a surname restated in the body text itself
  // is a genuine concern, since that's outside anything this harness intends
  // to send.
  const groundTruth: ParsedLot = parseDescription(rawLot.description);
  // Hard-stops unless --allow-leak: a body that names the artist makes the run
  // non-blind, and Stage 1c gets that text verbatim. See ./blindness.ts.
  const blindnessCompromised = assertBlindOrExit(groundTruth.leakRisks, { allowLeak, tag: "Backtest" });

  const config = appraiserConfigs.find((c) => c.id === method);
  if (!config) throw new Error(`Unknown method "${method}" — check appraiserConfigs in src/appraisal/appraiser.ts`);

  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined;
  // Same appraiser, but keeping a copy of the Stage 2a cells — the pipeline discards them
  // and a stored result is much harder to diagnose without them (see ./evidence_capture.ts).
  const { appraiser, getAgentCells, getAckgRounds } = appraiserWithEvidenceCapture(config, ai);

  // catalogueNotes gets the raw, unprocessed catalogue body verbatim — everything
  // between the title line and the "Provenance" heading (medium, support, sheet/
  // image dimensions, edition markings, printer/publisher, inscriptions — as
  // typed by Roseberys, not re-derived from the individual parsed fields) — so
  // Stage 1c sees the same physical/technical detail a human appraiser reading
  // the catalogue would transcribe. It's still just the raw text of ParsedLot's
  // bodyLines, which by construction excludes the artist/nationality/title
  // header lines that precede it. Catalogue-raisonné refs (e.g. "Bloch 1244")
  // are appended explicitly since the house convention puts them in the title
  // line (bracketed, e.g. "...; [Bloch 1244]"), which bodyLines excludes.
  const catalogueRefsLine = groundTruth.catalogueRefs.length
    ? `Catalogue reference(s): ${groundTruth.catalogueRefs.join(", ")}`
    : null;
  const rawCatalogueNotes =
    [groundTruth.bodyLines.join("\n"), catalogueRefsLine].filter(Boolean).join("\n\n") || undefined;

  // Image as the primary scan, plus the catalogue text reshaped into the same
  // four boxes AppraiserNotesInput.tsx exposes, fed to Stage 1c (Appraiser Input
  // Agent). No userNotes, no supplementary photos, no estimate.
  //
  // testingExcludeSourceListing tells Stage 3 which listing this input was
  // sourced from, so it can recognise and exclude that listing if Stage 2b's web
  // search surfaces it as a "comp" — otherwise the app's estimate can end up
  // anchored on the very auction record this test is comparing it against,
  // which happened on a real run (Roseberys A0777 lot 5: Stage 2b's only comp
  // was that same lot's own pre-sale estimate).
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
  console.log(
    notesFieldsUsed.length
      ? `[Backtest] Appraiser Input Agent notes populated: ${notesFieldsUsed.join(", ")}`
      : `[Backtest] No appraiser notes extracted from this lot's catalogue text — Stage 1c will run with nothing to extract.`,
  );
  console.log(`[Backtest] Stage 3 will exclude comps matching: ${input.testingExcludeSourceListing}`);

  console.log(`[Backtest] Running pipeline (method: ${method})...`);
  const t0 = Date.now();
  const report = await appraiser.appraise(input);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Backtest] Done in ${elapsedS}s — app says: "${report.likelyArtist}" / "${report.artworkTitle}"`);

  const comparison: BacktestComparison = compareResults(report, groundTruth, rawLot);

  console.log(`[Backtest] Catalogue says: "${groundTruth.artist}" / "${groundTruth.title}"`);
  console.log(`[Backtest] Verdict: ${comparison.overallVerdict}`);
  if (comparison.materialDifferences.length > 0) {
    for (const d of comparison.materialDifferences) console.log(`  - ${d}`);
  }

  const lotId = `${auction.saleCode}-${rawLot.lot_number}`;
  const outDir = `${__dirname}/output/${slugify(lotId)}`;
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    `${outDir}/result.json`,
    JSON.stringify(
      {
        lotId,
        sale: auction,
        lotUrl: lotUrl(rawLot),
        method,
        blindnessCompromised,
        stage2aEvidence: buildEvidenceRecord(
          getAgentCells(),
          report.stage1dResult,
          report.stage1cResult,
          !!report.stage1Result?.imageAuthenticity?.haltRecommended,
          getAckgRounds(),
        ),
        appraiserInputNotes: {
          inscribedMarksNotes: input.inscribedMarksNotes ?? null,
          provenanceNotes: input.provenanceNotes ?? null,
          conditionNotes: input.conditionNotes ?? null,
          catalogueNotes: input.catalogueNotes ?? null,
        },
        testingExcludeSourceListing: input.testingExcludeSourceListing ?? null,
        report,
        groundTruth,
        rawLot: { ...rawLot, description: undefined }, // description kept out of the JSON body; see rawLotDescriptionHtml below
        rawLotDescriptionHtml: rawLot.description,
        comparison,
      },
      null,
      2,
    ),
  );

  const html = buildBacktestReport({
    lotId,
    lotUrl: lotUrl(rawLot),
    imageDataUrl: `data:${mimeType};base64,${base64}`,
    method,
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
  });
  writeFileSync(`${outDir}/report.html`, html);

  console.log(`\n[Backtest] Wrote ${outDir}/result.json and report.html`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
