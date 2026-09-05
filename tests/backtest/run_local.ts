// Ad-hoc harness — run the real appraisal pipeline against a local image + a
// hand-typed catalogue-style description, with no Roseberys/Forum fetch
// involved. Two modes for getting the description in:
//
//   --text-file <path>       Blind mode (default). parseDescription() splits
//                             the text into the withheld artist/title (used
//                             only for an after-the-fact comparison, never
//                             sent to the pipeline) and the catalogue body,
//                             sent verbatim as Stage 1c's notes — exactly
//                             what a human appraiser transcribing a lot into
//                             the app's four notes boxes would type.
//
//   --user-notes-file <path> Direct mode. The file's raw content is sent
//                             untouched as AppraisalInput.userNotes — the
//                             general free-text box that bypasses Stage 1c's
//                             extraction agent entirely and goes straight
//                             into Stage 2a/2b/3 as "high-priority evidence
//                             for attribution" (see appraiser.ts ~line 1643).
//                             Nothing is withheld in this mode — if the text
//                             names the artist, the model sees it.
//
// Usage:
//   npx tsx tests/backtest/run_local.ts --image <path> --text-file <path> [--method claude-4stage]
//   npx tsx tests/backtest/run_local.ts --image <path> --user-notes-file <path> [--method claude-4stage] [--out <dirname>]

import dotenv from "dotenv";
dotenv.config();

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, extname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { getAppraiserFromConfig, appraiserConfigs, type AppraisalInput } from "../../src/appraisal/appraiser";
import { parseDescription } from "../../benchmark/src/roseberys/parse";
import { compareArtistNames, compareTitles as _unused } from "./compare";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_METHOD = "claude-4stage";

interface Args { image: string; textFile?: string; userNotesFile?: string; method: string; currency: string; out: string }

function parseArgs(argv: string[]): Args {
  let image: string | undefined, textFile: string | undefined, userNotesFile: string | undefined;
  let method = DEFAULT_METHOD, currency = "GBP", out = "local_run";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") image = argv[++i];
    else if (a === "--text-file") textFile = argv[++i];
    else if (a === "--user-notes-file") userNotesFile = argv[++i];
    else if (a === "--method") method = argv[++i];
    else if (a === "--currency") currency = argv[++i];
    else if (a === "--out") out = argv[++i];
  }
  if (!image || (!textFile && !userNotesFile)) {
    console.error("Usage: --image <path> (--text-file <path> | --user-notes-file <path>) [--method <id>] [--currency GBP] [--out <dirname>]");
    process.exit(1);
  }
  return { image, textFile, userNotesFile, method, currency, out };
}

function mimeFromExt(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function main() {
  const { image, textFile, userNotesFile, method, currency, out } = parseArgs(process.argv.slice(2));

  const imageBase64 = readFileSync(image).toString("base64");
  const mimeType = mimeFromExt(image);

  const config = appraiserConfigs.find((c) => c.id === method);
  if (!config) throw new Error(`Unknown method "${method}"`);

  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined;
  const appraiser = getAppraiserFromConfig(config, ai);

  let input: AppraisalInput;
  let groundTruth: ReturnType<typeof parseDescription> | null = null;

  if (userNotesFile) {
    // Direct mode: raw text goes straight into userNotes, untouched — bypasses
    // Stage 1c entirely. Nothing withheld; the artist/title, if present in the
    // text, is visible to the model like any other appraiser note.
    const rawNotes = readFileSync(userNotesFile, "utf-8").replace(/<br\s*\/?>/gi, "\n").trim();
    console.log("[Local] Direct mode — raw text sent verbatim as userNotes:");
    console.log(`    ${rawNotes.split("\n").join("\n    ")}`);
    input = {
      imageBase64,
      mimeType,
      currency,
      userNotes: rawNotes,
      onProgress: (e) => console.log(`[Local] ${e.stage} ${e.status} (${e.percent}%): ${e.message}`),
    };
  } else {
    const descriptionHtml = readFileSync(textFile!, "utf-8");
    groundTruth = parseDescription(descriptionHtml);
    console.log("[Local] Parsed description:");
    console.log(`  artist (withheld):   ${groundTruth.artist} (${groundTruth.artistQualifier})`);
    console.log(`  title (withheld):    ${groundTruth.title}`);
    console.log(`  year:                ${groundTruth.year}`);
    console.log(`  medium/support:      ${groundTruth.medium} / ${groundTruth.support}`);
    console.log(`  dimensions:          ${JSON.stringify(groundTruth.dimensions)}`);
    console.log(`  provenance:          ${groundTruth.provenance}`);
    console.log(`  bodyLines sent as catalogueNotes:\n    ${groundTruth.bodyLines.join("\n    ")}`);

    const catalogueRefsLine = groundTruth.catalogueRefs.length
      ? `Catalogue reference(s): ${groundTruth.catalogueRefs.join(", ")}`
      : null;
    const rawCatalogueNotes = [groundTruth.bodyLines.join("\n"), catalogueRefsLine].filter(Boolean).join("\n\n") || undefined;

    input = {
      imageBase64,
      mimeType,
      currency,
      inscribedMarksNotes: groundTruth.inscriptions || undefined,
      provenanceNotes: groundTruth.provenance || undefined,
      conditionNotes: groundTruth.condition || undefined,
      catalogueNotes: rawCatalogueNotes,
      onProgress: (e) => console.log(`[Local] ${e.stage} ${e.status} (${e.percent}%): ${e.message}`),
    };
  }

  console.log(`\n[Local] Running pipeline (method: ${method})...`);
  const t0 = Date.now();
  const report = await appraiser.appraise(input);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[Local] Done in ${elapsedS}s`);

  const artistMatch = groundTruth ? compareArtistNames(report.likelyArtist, groundTruth.artist) : null;

  console.log("\n=== RESULT ===");
  console.log(`App attribution:     ${report.likelyArtist} (confidence ${report.artistConfidence})`);
  if (groundTruth) console.log(`Catalogue said:      ${groundTruth.artist} (${groundTruth.artistQualifier}) — match: ${artistMatch}`);
  console.log(`App title:           ${report.artworkTitle} (confidence ${report.titleConfidence})`);
  if (groundTruth) console.log(`Catalogue said:      ${groundTruth.title}`);
  console.log(`Creation period:     ${report.creationPeriod}`);
  console.log(`Estimate:            ${report.auctionEstimate?.currency} ${report.auctionEstimate?.lowEstimate}-${report.auctionEstimate?.highEstimate}`);
  console.log(`Reproduction?:       ${report.isLikelyReproductionOrPoster} — ${report.reproductionExplanation}`);
  if (report.pipelineMeta) {
    console.log(`Specialist config:   ${report.pipelineMeta.specialistConfigUsed}`);
    console.log(`Human escalation:    ${report.pipelineMeta.humanEscalationRequired}`);
    console.log(`Physical exam req.:  ${report.pipelineMeta.physicalExaminationRequired}`);
    console.log(`Overall confidence:  ${report.pipelineMeta.overallAttributionConfidence}`);
  }

  const outDir = `${__dirname}/output/${out}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/result.json`,
    JSON.stringify({ method, input: { ...input, imageBase64: "[omitted]", onProgress: undefined }, groundTruth, report, artistMatch }, null, 2),
  );
  console.log(`\n[Local] Wrote ${outDir}/result.json`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
