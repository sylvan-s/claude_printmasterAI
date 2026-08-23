import { ThreeStageAppraiser, appraiserConfigs } from "../src/appraisal/appraiser";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Error: GEMINI_API_KEY environment variable is not defined.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

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
  
  const config = appraiserConfigs.find(c => c.id === "gemini-3stage")!;
  const appraiser = new ThreeStageAppraiser(config, ai);
  
  console.log("Starting 3-Stage appraisal...");
  const report = await appraiser.appraise({
    imageBase64: imgBase64,
    mimeType: "image/webp",
    currency: "GBP",
    userNotes: "A fine art print under review."
  });
  
  console.log("\n========================================================");
  console.log("3-STAGE APPRAISAL COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
  console.log("Likely Artist:", report.likelyArtist);
  console.log("Artist Confidence:", report.artistConfidence);
  console.log("Artwork Title:", report.artworkTitle);
  console.log("Title Confidence:", report.titleConfidence);
  console.log("Creation Period:", report.creationPeriod);
  console.log("Formatted Estimate:", report.auctionEstimate.formattedEstimate);
  console.log("Reproduction check: Likely reproduction? ", report.isLikelyReproductionOrPoster);
  console.log("Reproduction explanation:", report.reproductionExplanation);
  console.log("Recent Auction Sales count:", report.recentAuctionSales?.length || 0);
  console.log("Stage 1 Output populated:", !!report.stage1Result);
  console.log("Stage 2 Output populated:", !!report.stage2Result);
  console.log("========================================================\n");
  
  const outputDir = "/Users/sylvansitkey/antigravity/Fine-Art-Print-Analyzer/dist";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = path.join(outputDir, "test-report-3stage.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Saved report output to ${outputPath}`);
}

run().catch((err) => {
  console.error("Appraisal execution failed:", err);
  process.exit(1);
});
