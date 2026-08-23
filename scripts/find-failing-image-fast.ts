import { VISUAL_EXTRACTION_SCHEMA } from "../src/appraisal/appraiser";
import { VISUAL_EXTRACTION_SYSTEM_PROMPT, resolveCustomPrompt } from "../src/appraisal/prompts";
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

interface TestResult {
  isJsonError: boolean;
  success: boolean;
}

async function testImage(filename: string, imgPath: string): Promise<TestResult> {
  const imgBase64 = fs.readFileSync(imgPath).toString("base64");
  const mimeType = filename.endsWith(".webp") ? "image/webp" : "image/jpeg";
  const cleanBase64 = imgBase64.replace(/^data:image\/\w+;base64,/, "");
  
  const textPrompt = resolveCustomPrompt(
    VISUAL_EXTRACTION_SYSTEM_PROMPT,
    "USD",
    "Test run."
  );

  const parts1 = [
    {
      inlineData: {
        data: cleanBase64,
        mimeType: mimeType,
      },
    },
    { text: textPrompt }
  ];

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: { parts: parts1 },
      config: {
        responseMimeType: "application/json",
        responseSchema: VISUAL_EXTRACTION_SCHEMA,
        temperature: 0.1,
      }
    });

    const textOutput = response.text;
    if (!textOutput) {
      console.log(`[FAIL] ${filename}: No text output received`);
      return { success: false, isJsonError: false };
    }

    try {
      JSON.parse(textOutput.trim());
      console.log(`[OK] ${filename}`);
      return { success: true, isJsonError: false };
    } catch (parseErr: any) {
      console.error(`\n=========================================`);
      console.error(`[JSON ERROR] on ${filename}:`, parseErr.message);
      console.error(`Raw output length: ${textOutput.length}`);
      // Find the character index of the error from position or print a snippet around typical positions
      console.error(`Snippet around start: ...${textOutput.substring(0, 500)}...`);
      console.error(`Snippet around end: ...${textOutput.substring(Math.max(0, textOutput.length - 500))}...`);
      console.error(`=========================================\n`);
      const outPath = `/Users/sylvansitkey/.gemini/antigravity-ide/scratch/failed-output-${filename}.json`;
      fs.writeFileSync(outPath, textOutput);
      console.log(`Saved raw output to ${outPath}`);
      return { success: false, isJsonError: true };
    }
  } catch (apiErr: any) {
    console.error(`[API ERROR] on ${filename}:`, apiErr.message);
    return { success: false, isJsonError: false };
  }
}

async function run() {
  const imagesDir = "/Users/sylvansitkey/antigravity/Fine-Art-Print-Analyzer/data/user_records/sylvan_sitkey@hotmail.com/images";
  const imageFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith(".webp") || f.endsWith(".jpg"));
  console.log(`Found ${imageFiles.length} images to test.`);

  console.log("Starting fast parallelized test queue...");
  
  // Run with concurrency limit of 3 to reduce 503 occurrences
  const concurrencyLimit = 3;
  const queue = [...imageFiles];
  const activeWorkers: Promise<void>[] = [];
  let foundError = false;

  const worker = async () => {
    while (queue.length > 0 && !foundError) {
      const filename = queue.shift()!;
      const imgPath = path.join(imagesDir, filename);
      const res = await testImage(filename, imgPath);
      if (res.isJsonError) {
        foundError = true;
        console.log("Stopped queue due to JSON parsing failure.");
        process.exit(0);
      }
    }
  };

  for (let i = 0; i < concurrencyLimit; i++) {
    activeWorkers.push(worker());
  }

  await Promise.all(activeWorkers);
  if (!foundError) {
    console.log("All images checked successfully (excluding API errors)!");
  }
}

run().catch((err) => {
  console.error("Script execution failed:", err);
  process.exit(1);
});
