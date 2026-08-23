// VEA trial harness — runs Stage 1a (Visual Extraction Agent) alone, against a
// real DB item or a local image file, using the actual production code path
// (FourStageAppraiser.runStage1VEA), so results can't drift from what the live
// pipeline does. Writes a JSON result + a readable HTML report per target.
//
// Usage — see README.md for full details:
//   npx tsx tests/vea/run_vea_trial.ts --item <uuid> [--item <uuid> ...]
//   npx tsx tests/vea/run_vea_trial.ts --image <path> [--image <path> ...]
//   npx tsx tests/vea/run_vea_trial.ts --item <uuid> --model claude-opus-4-8

import dotenv from "dotenv";
dotenv.config();

import { Pool } from "pg";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { extname, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { FourStageAppraiser, appraiserConfigs, type AppraisalInput } from "../../src/appraisal/appraiser";
import { buildVeaReport } from "./build_report";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL = "claude-opus-4-8"; // matches claude-4stage's stage1Model — production default

interface Target {
  kind: "item" | "image";
  ref: string; // uuid or file path
}

function parseArgs(argv: string[]): { targets: Target[]; model: string } {
  const targets: Target[] = [];
  let model = DEFAULT_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--item") targets.push({ kind: "item", ref: argv[++i] });
    else if (arg === "--image") targets.push({ kind: "image", ref: argv[++i] });
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unrecognised argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  if (targets.length === 0) {
    console.error("No targets given.\n");
    printHelp();
    process.exit(1);
  }
  return { targets, model };
}

function printHelp() {
  console.error(`
VEA trial harness — run Stage 1a alone against a DB item or a local image.

  --item <uuid>     Item id from the "items" table (fetches its primary image)
  --image <path>    Local image file (jpg/png/webp)
  --model <name>    Stage 1a model (default: ${DEFAULT_MODEL})

Repeat --item/--image to run several targets in one invocation, e.g.:
  npx tsx tests/vea/run_vea_trial.ts --item 76af658c-... --item ac7b5247-...
`);
}

async function loadFromDb(itemId: string): Promise<{ mimeType: string; base64: string; label: string }> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query(
      `SELECT storage_key, content_type, original_filename FROM images WHERE item_id = $1 AND image_type = 'primary' LIMIT 1`,
      [itemId]
    );
    if (r.rows.length === 0) throw new Error(`No primary image found for item ${itemId}`);
    const { storage_key, original_filename } = r.rows[0];
    const match = /^data:([^;]+);base64,(.+)$/s.exec(storage_key);
    if (!match) throw new Error(`Item ${itemId}'s storage_key is not a base64 data URI (external storage not supported by this harness yet)`);
    return { mimeType: match[1], base64: match[2], label: original_filename || itemId };
  } finally {
    await pool.end();
  }
}

function loadFromFile(path: string): { mimeType: string; base64: string; label: string } {
  const ext = extname(path).toLowerCase();
  const mimeType = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext];
  if (!mimeType) throw new Error(`Unsupported image extension: ${ext} (${path})`);
  const base64 = readFileSync(path).toString("base64");
  return { mimeType, base64, label: basename(path) };
}

function slugify(s: string): string {
  return s.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "target";
}

async function runOne(target: Target, model: string, ai: GoogleGenAI, appraiser: FourStageAppraiser) {
  console.log(`\n[VEA trial] ${target.kind}: ${target.ref}`);
  const { mimeType, base64, label } =
    target.kind === "item" ? await loadFromDb(target.ref) : loadFromFile(target.ref);

  const input: AppraisalInput = { imageBase64: base64, mimeType, currency: "GBP" };

  console.log(`[VEA trial] Calling Stage 1a (${model})...`);
  const t0 = Date.now();
  // runStage1VEA is protected — this harness intentionally reaches past that to
  // call it in isolation. Cast is deliberate, not a type-safety gap to fix.
  const vea = await (appraiser as any).runStage1VEA(input, model, ai);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[VEA trial] Done in ${elapsedS}s — schemaVersion=${vea.schemaVersion}, overallExtractionConfidence=${vea.overallExtractionConfidence}`);

  const outDir = `${__dirname}/output/${slugify(label)}`;
  mkdirSync(outDir, { recursive: true });

  writeFileSync(`${outDir}/result.json`, JSON.stringify(vea, null, 2));

  const html = buildVeaReport(vea, `data:${mimeType};base64,${base64}`, {
    title: label,
    itemNote: target.kind === "item" ? `Item id: ${target.ref}` : `Local file: ${target.ref}`,
    model,
  });
  writeFileSync(`${outDir}/report.html`, html);

  console.log(`[VEA trial] Wrote ${outDir}/result.json and report.html`);
  return outDir;
}

async function main() {
  const { targets, model } = parseArgs(process.argv.slice(2));

  const config = appraiserConfigs.find((c) => c.id === "claude-4stage");
  if (!config) throw new Error("claude-4stage config not found in appraiserConfigs");
  const appraiser = new FourStageAppraiser(config);

  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : (null as any); // unused on the Claude branch

  const outDirs: string[] = [];
  for (const target of targets) {
    outDirs.push(await runOne(target, model, ai, appraiser));
  }

  console.log(`\n[VEA trial] All done. Reports:`);
  for (const d of outDirs) console.log(`  ${d}/report.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
