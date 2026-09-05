/**
 * Run Stage 1c (Appraiser Input Agent) in isolation against a stored backtest lot's
 * notes, or against notes passed on the command line. For iterating on
 * APPRAISER_INPUT_SYSTEM_PROMPT without re-running the whole pipeline.
 *
 *   npx tsx tests/backtest/run_stage1c.ts --from tests/backtest/output/A0777_1
 *   npx tsx tests/backtest/run_stage1c.ts --catalogue "monochrome woodcut, signed by Henry Moore"
 */
import dotenv from "dotenv";
dotenv.config();

import { readFileSync } from "node:fs";
import { FourStageAppraiser, appraiserConfigs } from "../../src/appraisal/appraiser";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDir = arg("from");
let notes: {
  inscribedMarksNotes?: string;
  provenanceNotes?: string;
  conditionNotes?: string;
  catalogueNotes?: string;
};

if (fromDir) {
  const r = JSON.parse(readFileSync(`${fromDir}/result.json`, "utf8"));
  const n = r.appraiserInputNotes ?? {};
  notes = {
    inscribedMarksNotes: n.inscribedMarksNotes ?? undefined,
    provenanceNotes: n.provenanceNotes ?? undefined,
    conditionNotes: n.conditionNotes ?? undefined,
    catalogueNotes: n.catalogueNotes ?? undefined,
  };
  console.log(`\nnotes from ${fromDir}/result.json`);
  if (r.groundTruth?.artist) console.log(`ground-truth artist (withheld from Stage 1c): ${r.groundTruth.artist}\n`);
} else {
  notes = {
    inscribedMarksNotes: arg("inscribed"),
    provenanceNotes: arg("provenance"),
    conditionNotes: arg("condition"),
    catalogueNotes: arg("catalogue"),
  };
  if (!Object.values(notes).some(Boolean)) {
    console.error("Provide --from <dir> or at least one of --inscribed / --provenance / --condition / --catalogue");
    process.exit(1);
  }
}

const config = appraiserConfigs.find((c) => c.id === "claude-4stage")!;
const appraiser = new FourStageAppraiser(config);

// runStage1cAppraiserInput is protected — this is a test harness, reach in.
const result = await (appraiser as any).runStage1cAppraiserInput(notes);

console.log("claimedAttribution:", JSON.stringify(result.claimedAttribution, null, 2));
console.log("\nprovenanceChain:", JSON.stringify(result.provenanceChain, null, 2));
console.log("\ninscriptionClaims:", JSON.stringify(result.inscriptionClaims, null, 2));
console.log("\nlowConfidenceFlags:", JSON.stringify(result.lowConfidenceFlags));
console.log("overallExtractionConfidence:", result.overallExtractionConfidence);

const a = result.claimedAttribution?.artist;
console.log(
  `\n=> claimedAttribution.artist = ${a === null ? "null" : `"${a}"`}` +
    (result.claimedAttribution?.status ? ` (status: ${result.claimedAttribution.status})` : ""),
);
