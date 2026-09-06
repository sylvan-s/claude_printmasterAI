/**
 * Stage 1d against exactly one image URL, printing the FULL candidate list (not just
 * top 3) with dino/clip scores and the matchConfidence formula's own tier for each.
 *
 * Usage: npx tsx tests/backtest/run_stage1d_single.ts "<imageUrl>"
 */
import dotenv from "dotenv";
dotenv.config();

import { FourStageAppraiser, appraiserConfigs } from "../../src/appraisal/appraiser";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";

function confidenceFor(dino: number | null, clip: number | null): string {
  const d = dino ?? 0;
  const c = clip ?? 0;
  if (d >= 0.90 && c >= 0.80) return "HIGH";
  if (d >= 0.80) return "MEDIUM";
  return "LOW";
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.error("Usage: run_stage1d_single.ts <imageUrl>"); process.exit(1); }

  const config = appraiserConfigs.find((c) => c.id === "claude-4stage")!;
  const appraiser = new FourStageAppraiser(config) as any;

  const fetched = await appraiser.fetchImageAsBase64(url);
  if (!fetched) { console.error("image fetch failed"); process.exit(1); }

  const d = await appraiser.runStage1dEmbeddingMatch(fetched.base64, fetched.mimeType);
  console.log(`\nmatchConfidence (top candidate, per Stage 1d's own formula): ${d.matchConfidence}\n`);
  console.log("| # | Artist | Work | dino | clip | tier (if this were top) |");
  console.log("|---|---|---|---|---|---|");
  (d.candidateMatches ?? []).forEach((c: any, i: number) => {
    console.log(`| ${i + 1} | ${c.artistName} | ${c.conceptualWorkTitle ?? "?"} | ${c.dinov2Similarity?.toFixed(3) ?? "—"} | ${c.clipSimilarity?.toFixed(3) ?? "—"} | ${confidenceFor(c.dinov2Similarity, c.clipSimilarity)} |`);
  });

  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
