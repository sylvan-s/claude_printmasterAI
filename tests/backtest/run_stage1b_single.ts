/**
 * Stage 1b (Gemini reverse image search) against exactly one image URL.
 *
 * Usage: npx tsx tests/backtest/run_stage1b_single.ts "<imageUrl>"
 */
import dotenv from "dotenv";
dotenv.config();

import { FourStageAppraiser, appraiserConfigs } from "../../src/appraisal/appraiser";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";

async function main() {
  const url = process.argv[2];
  if (!url) { console.error("Usage: run_stage1b_single.ts <imageUrl>"); process.exit(1); }

  const config = appraiserConfigs.find((c) => c.id === "claude-4stage")!;
  const appraiser = new FourStageAppraiser(config) as any;

  const fetched = await appraiser.fetchImageAsBase64(url);
  if (!fetched) { console.error("image fetch failed"); process.exit(1); }

  const b = await appraiser.runStage1bVisionSearch(fetched.base64, fetched.mimeType);
  console.log("\nFull Stage 1b result:\n");
  console.log(JSON.stringify(b, null, 2));

  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
