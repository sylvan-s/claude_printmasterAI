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
  const imageFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith(".webp") || f.endsWith(".jpg"));
  console.log(`Found ${imageFiles.length} images to test.`);

  const config = appraiserConfigs.find(c => c.id === "gemini-3stage")!;
  const appraiser = new ThreeStageAppraiser(config, ai);

  for (let i = 0; i < imageFiles.length; i++) {
    const filename = imageFiles[i];
    const imgPath = path.join(imagesDir, filename);
    console.log(`[${i+1}/${imageFiles.length}] Testing image: ${filename}`);
    
    const imgBase64 = fs.readFileSync(imgPath).toString("base64");
    const mimeType = filename.endsWith(".webp") ? "image/webp" : "image/jpeg";
    
    try {
      // We only run the first stage (visual extraction) to speed things up
      // three stage appraiser class has private stages, but we can call appraise and if it fails in Stage 1 we catch it.
      const report = await appraiser.appraise({
        imageBase64: imgBase64,
        mimeType: mimeType,
        currency: "USD",
        userNotes: "Test run."
      });
      console.log(`  -> SUCCESS! Artwork: ${report.artworkTitle} by ${report.likelyArtist}`);
    } catch (err: any) {
      console.error(`  -> FAILED on ${filename}:`, err.message);
      if (err.message.includes("JSON") || err.message.includes("parse")) {
        console.log("Found JSON parsing error! Stopping search.");
        break;
      }
    }
  }
}

run().catch((err) => {
  console.error("Script execution failed:", err);
  process.exit(1);
});
