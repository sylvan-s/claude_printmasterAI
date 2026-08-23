import { ThreeStageAppraiser, appraiserConfigs } from "../src/appraisal/appraiser";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config();

const geminiKey = process.env.GEMINI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

if (!geminiKey) {
  console.error("Error: GEMINI_API_KEY environment variable is not defined.");
  process.exit(1);
}

if (!anthropicKey) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is not defined.");
  process.exit(1);
}

async function run() {
  const imagesDir = "/Users/sylvansitkey/antigravity/Fine-Art-Print-Analyzer/data/user_records/sylvan_sitkey@hotmail.com/images";
  const imageFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith(".webp"));
  if (imageFiles.length === 0) {
    console.error("No sample webp images found in local data directory.");
    process.exit(1);
  }

  const sampleImage = imageFiles[0];
  const imgPath = path.join(imagesDir, sampleImage);
  console.log(`Loading sample image: ${imgPath}`);
  const imgBase64 = fs.readFileSync(imgPath).toString("base64");
  
  const config = appraiserConfigs.find(c => c.id === "claude-3stage")!;
  if (!config) {
    console.error("Error: claude-3stage config not found in appraiserConfigs.");
    process.exit(1);
  }
  const appraiser = new ThreeStageAppraiser(config);
  
  console.log("Starting Claude 3-Stage appraisal...");
  const report = await appraiser.appraise({
    imageBase64: imgBase64,
    mimeType: "image/webp",
    currency: "USD",
    userNotes: "Salvador Dali - Velazquez etching print check"
  });
  
  console.log("\n========================================================");
  console.log("CLAUDE 3-STAGE APPRAISAL COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
  console.log("Likely Artist:", report.likelyArtist);
  console.log("Artist Confidence:", report.artistConfidence);
  console.log("Artwork Title:", report.artworkTitle);
  console.log("Title Confidence:", report.titleConfidence);
  console.log("Creation Period:", report.creationPeriod);
  console.log("Formatted Estimate:", report.auctionEstimate.formattedEstimate);
  console.log("Reproduction check: Likely reproduction? ", report.isLikelyReproductionOrPoster);
  console.log("Recent Auction Sales count:", report.recentAuctionSales?.length || 0);
  console.log("Stage 1 Output populated:", !!report.stage1Result);
  console.log("Stage 2 Output populated:", !!report.stage2Result);
  console.log("========================================================\n");
  
  const outputDir = "/Users/sylvansitkey/antigravity/Fine-Art-Print-Analyzer/dist";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = path.join(outputDir, "test-report-claude-3stage.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Saved report output to ${outputPath}`);
}

run().catch((err) => {
  console.error("Appraisal execution failed:", err);
  process.exit(1);
});
