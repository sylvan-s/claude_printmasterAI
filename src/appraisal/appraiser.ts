import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import {
  PrintAnalysisReport,
  VisualExtractionResult,
  AttributionResearchResult,
  TriageResult,
  AppraiserInputResult,
  Stage1dResult,
  EmbeddingMatchCandidate,
} from "../types";
import {
  getPrompt,
  PromptKey,
  resolveCustomPrompt,
  VISUAL_EXTRACTION_SYSTEM_PROMPT,
  ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT,
  ATTRIBUTION_RESEARCH_SYSTEM_PROMPT,
  VALUATION_REPORT_SYSTEM_PROMPT,
  APPRAISER_INPUT_SYSTEM_PROMPT,
  injectSpecialistConfig,
  injectTaskProfile,
} from "./prompts";
import { Scenario } from "./routing";
import { runEvidenceTree, emptyEvidenceOutput, type EvidenceAgentOutput } from "./stage2a_evidence";
import {
  translateSchemaToStandardJsonSchema,
  VISUAL_EXTRACTION_SCHEMA,
  ATTRIBUTION_RESEARCH_SCHEMA,
  ATTRIBUTION_EVIDENCE_SCHEMA,
  SPECIALIST_ATTRIBUTION_SCHEMA,
  FINAL_REPORT_RESPONSE_SCHEMA,
  FINAL_REPORT_CLAUDE_SCHEMA,
  STAGE3_VALUATION_ONLY_SCHEMA,
  APPRAISER_INPUT_SCHEMA,
} from "./schemas";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { lookupArtistAcrossMuseums, type ArtistLookupResult } from "./reference_lookup/index.js";
import { queryAckg, queryAckgWorks, scoreWorkTitleMatches, queryImageEmbeddingMatches } from "./knowledge_graph/index.js";
import type { AckgCandidate, AckgWorkMatch } from "./knowledge_graph/types.js";
import { getImageEmbeddings } from "./embedding_client.js";
import { techniqueFamily } from "./two_pass_attribution";
import { parseDimensions, extractCatalogueRefs, detectEditionSize } from "../shared/text_extraction";

// Resolved from the process working directory, not import.meta.url / __dirname:
// esbuild's --format=cjs bundling (src/appraisal/appraiser.ts -> dist/server.cjs)
// squashes every module into one file, so any path relative to "where this code
// physically lives" stops meaning anything post-bundle — and import.meta.url
// itself comes back undefined in the bundled CJS output, crashing at import
// time. npm start/dev both run from the project root, so cwd is the one
// reliable anchor across the bundled and unbundled cases alike.
const SPECIALIST_CONFIGS_DIR = join(process.cwd(), "src/appraisal/specialist_configs");

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface VisualSearchResult {
  webEntities: string[];
  matchedUrls: string[];
  visuallySimilarUrls: string[];
  pagesWithMatchingImages: string[];
  // Stage 1b enriched fields
  bestMatchArtist?: string | null;
  bestMatchTitle?: string | null;
  bestMatchImageUrl?: string | null;
  bestMatchImageBase64?: string | null;
  bestMatchImageMimeType?: string | null;
  visualSimilarityScore?: number | null;   // 0.0–1.0
  visualSimilarityRationale?: string | null;
  /** How close the retrieved reference image's composition is to the submission,
   *  per the search step's own side-by-side read. */
  compositionMatch?: "identical" | "very_close" | "loose" | "none" | null;
  matchConfidence?: "HIGH" | "MEDIUM" | "LOW" | null;
  /** Self-reported by the model: was this match confirmed against an actual
   *  reference image ("visual"), inferred from a page's written attribution
   *  without a confirmed image match ("textual"), some of both ("mixed"), or
   *  no match at all ("none")? Lets the logs and any downstream consumer
   *  distinguish a genuine reverse-image match from a text-search guess. */
  evidenceBasis?: "visual" | "textual" | "mixed" | "none" | null;
  hypothesisWarning: string;
}

export interface AppraisalProgressEvent {
  stage: string;       // e.g. "stage1", "stage1b", "stage2a", "stage2b", "stage3"
  status: "start" | "done";
  message: string;
  percent: number;     // 0–95 (100 is reserved for post-pipeline completion)
}

export interface SupplementaryImageInput {
  base64: string;
  mimeType?: string;
  caption: string; // free-text guidance from the user on what this photo shows
}

export interface AppraisalInput {
  imageBase64: string;
  mimeType?: string;
  userNotes?: string;
  supplementaryImages?: SupplementaryImageInput[];
  // Stage 1c (Appraiser Input Agent) inputs — the same four AppraiserNotesInput.tsx
  // boxes, sent separately by topic rather than compiled into userNotes. See
  // ADR-0004. userNotes above is untouched and keeps flowing to Stage 2a/2b/3
  // exactly as before; these are additive, consumed only by Stage 1c.
  inscribedMarksNotes?: string;
  provenanceNotes?: string;
  conditionNotes?: string;
  catalogueNotes?: string;
  currency?: string;
  onProgress?: (event: AppraisalProgressEvent) => void;
  // Backtest/eval-harness only — not something a real submitting user would ever
  // set. When this input's image/description were sourced from a live auction
  // listing (e.g. tests/backtest/), pass that listing's identity here so Stage 3
  // can recognise and exclude it from its own comps: Stage 2b's web search can
  // find the very listing this input came from, and using its own price as a
  // "comp" for the item it's describing would make the valuation circular rather
  // than independent.
  testingExcludeSourceListing?: string;
}

export interface AppraisalMethod {
  id: string;
  name: string;
  description: string;
  config: AppraisalMethodConfig;
  appraise(input: AppraisalInput): Promise<PrintAnalysisReport>;
}

export interface AppraisalMethodConfig {
  id: string;
  name: string;
  description: string;
  modelName: string;
  temperature: number;
  promptKey: PromptKey;
  promptText?: string;
  imageQuality: "original" | "medium" | "low";
  includeAuxiliaryScans: boolean;
  provider?: "gemini" | "anthropic";
  stage1Model?: string;
  stage1bModel?: string;       // model for Stage 1b visual search (FourStageAppraiser only)
  enableVisualSearch?: boolean; // set false to skip Stage 1b entirely (default: true)
  /** ADR-0013: set false to skip Stage 1d (image-embedding match) entirely (default: true).
   *  Shadow-run only — its result is attached to the report but never read by Stage 2a/2b/3. */
  enableEmbeddingMatch?: boolean;
  stage2aModel?: string;
  stage2bModel?: string;
  stage2Model?: string;
  stage3Model?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isClaude(model: string): boolean {
  return model.toLowerCase().startsWith("claude");
}

function getCurrencySymbol(code: string): string {
  if (code === "USD") return "$";
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  return "";
}

function parseCleanJson(text: string): any {
  let clean = text.trim();

  // Strip markdown code fences
  if (clean.startsWith("```")) {
    const lines = clean.split("\n");
    const start = lines[0].startsWith("```") ? 1 : 0;
    const end = lines[lines.length - 1] === "```" ? lines.length - 1 : lines.length;
    clean = lines.slice(start, end).join("\n").trim();
  }

  // Strip unary + from numeric values (e.g. +0.05 → 0.05) — Haiku emits these
  const stripUnaryPlus = (s: string) => s.replace(/:\s*\+(\d)/g, ": $1");

  // Repair unescaped apostrophes/single-quotes inside JSON string values.
  // Only targets apostrophes that appear between two double-quote delimiters,
  // i.e. inside a string value, and are not already escaped.
  const fixApostrophes = (s: string) => {
    // Replace ' with \' only when inside a double-quoted JSON string
    return s.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
      match.replace(/(?<!\\)'/g, "\\'")
    );
  };

  // Repair trailing commas before } or ] — common model mistake
  const fixTrailingCommas = (s: string) => s.replace(/,(\s*[}\]])/g, "$1");

  const repairs = [
    (s: string) => s,
    stripUnaryPlus,
    fixApostrophes,
    fixTrailingCommas,
    (s: string) => fixApostrophes(stripUnaryPlus(s)),
    (s: string) => fixTrailingCommas(fixApostrophes(stripUnaryPlus(s))),
  ];

  // Try direct parse with each repair
  for (const repair of repairs) {
    try { return JSON.parse(repair(clean)); } catch {}
  }

  // Extract first {...} block from prose-wrapped output and retry repairs
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const block = clean.slice(firstBrace, lastBrace + 1);
    for (const repair of repairs) {
      try { return JSON.parse(repair(block)); } catch {}
    }
  }

  throw new SyntaxError("No valid JSON object found in response");
}

// ---------------------------------------------------------------------------
// Anthropic Messages API — shared POST with retry + content-filter typing.
// Replaces the ad-hoc "retry once on 5xx" blocks. Retries: undici network
// failures ("fetch failed" / ECONNRESET / ETIMEDOUT — which surface as thrown
// TypeErrors, not HTTP statuses, so the old `response.status >= 500` guard never
// saw them), plus 429 / 529 / 5xx, with exponential backoff and `retry-after`
// honoured. A 400 whose body names the content policy is surfaced as a distinct
// error type so callers can strip prose / degrade gracefully rather than crash.
// ---------------------------------------------------------------------------
export class AnthropicContentFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicContentFilterError";
  }
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anthropicBackoffMs = (attempt: number) =>
  Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

export async function postAnthropicMessages(
  apiKey: string,
  body: Record<string, unknown>,
  opts: { betaHeader?: string; label?: string; maxAttempts?: number } = {},
): Promise<any> {
  const { betaHeader, label = "Anthropic", maxAttempts = 4 } = opts;
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (betaHeader) headers["anthropic-beta"] = betaHeader;
  const payload = JSON.stringify(body);

  let lastNetworkErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: payload });
    } catch (err: any) {
      lastNetworkErr = err;
      if (attempt >= maxAttempts) break;
      const wait = anthropicBackoffMs(attempt);
      console.warn(`[${label}] network error "${err?.message ?? err}" — retry ${attempt}/${maxAttempts - 1} in ${Math.round(wait)}ms`);
      await sleepMs(wait);
      continue;
    }

    if (response.ok) return response.json();

    const errorText = await response.text();

    if (response.status === 400 && /content[ _-]?filter|content policy|blocked by .*polic/i.test(errorText)) {
      throw new AnthropicContentFilterError(`${label}: output blocked by content filtering — ${errorText.slice(0, 300)}`);
    }

    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : anthropicBackoffMs(attempt);
      console.warn(`[${label}] transient ${response.status} — retry ${attempt}/${maxAttempts - 1} in ${Math.round(wait)}ms`);
      await sleepMs(wait);
      continue;
    }

    throw new Error(`${label} request failed: ${response.status}: ${errorText.slice(0, 500)}`);
  }
  throw new Error(`${label} request failed after ${maxAttempts} attempts: ${(lastNetworkErr as any)?.message ?? lastNetworkErr}`);
}

/** Trim VEA's free-text prose to its factual core for a content-filter retry. Keeps
 *  every structured field (technique names, dimensions, booleans, confidences, and
 *  short text like signature transcriptions / in-image titles) — only long descriptive
 *  strings and known prose fields get shortened, since those are what a content filter
 *  most often trips on when the model echoes them back. Deep-clones; never mutates input. */
const VEA_PROSE_FIELDS = new Set([
  "observationNotes", "visualSimilarityRationale", "description", "compositionSummary",
  "sceneDescription", "narrativeDescription", "analysisDetails",
]);
export function trimVeaProse(value: any, key?: string): any {
  if (typeof value === "string") {
    if (key && VEA_PROSE_FIELDS.has(key)) return value.length > 80 ? value.slice(0, 80) + "… [trimmed]" : value;
    return value.length > 180 ? value.slice(0, 180) + "… [trimmed]" : value;
  }
  if (Array.isArray(value)) return value.map((v) => trimVeaProse(v));
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = trimVeaProse(v, k);
    return out;
  }
  return value;
}

function loadSpecialistConfig(configKey: string): object {
  for (const key of [configKey, "general_print_fallback"]) {
    const filePath = join(SPECIALIST_CONFIGS_DIR, `${key}.json`);
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        console.error(`[4-Stage] Failed to parse specialist config: ${key}`);
      }
    }
  }
  if (configKey !== "general_print_fallback") {
    console.warn(`[4-Stage] Specialist config not found: "${configKey}", falling back to general_print_fallback`);
  }
  return { configKey: "general_print_fallback", domain: "General fine art prints", contextNote: "No specialist config found — applying general knowledge." };
}

// ---------------------------------------------------------------------------
// Image assembly helpers — used by all three appraiser classes
// ---------------------------------------------------------------------------

// A supplementary image's label always carries the user's own caption, so the
// model knows what the photo is meant to show — but is told elsewhere
// (VISUAL_EXTRACTION_SYSTEM_PROMPT Section 1) to verify rather than assume
// the caption is accurate.
function supplementaryLabel(index: number, caption: string): string {
  const trimmed = (caption || "").trim();
  const guidance = trimmed
    ? `user-provided guidance: "${trimmed}"`
    : "no guidance provided by the user — inspect for whatever is visible";
  return `--- SUPPLEMENTARY_SCAN_${index + 1}: ${guidance} ---`;
}

function buildGeminiImageParts(input: AppraisalInput, includeAux: boolean): any[] {
  const parts: any[] = [];
  parts.push({
    inlineData: {
      data: input.imageBase64.replace(/^data:image\/\w+;base64,/, ""),
      mimeType: input.mimeType || "image/jpeg",
    },
  });
  if (includeAux) {
    (input.supplementaryImages || []).forEach((img, i) => {
      parts.push({ text: supplementaryLabel(i, img.caption) });
      parts.push({ inlineData: { data: img.base64.replace(/^data:image\/\w+;base64,/, ""), mimeType: img.mimeType || "image/jpeg" } });
    });
  }
  return parts;
}

function buildClaudeImageBlocks(input: AppraisalInput, includeAux: boolean): any[] {
  const blocks: any[] = [];
  blocks.push({
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType || "image/jpeg",
      data: input.imageBase64.replace(/^data:image\/\w+;base64,/, ""),
    },
  });
  if (includeAux) {
    (input.supplementaryImages || []).forEach((img, i) => {
      blocks.push({ type: "text", text: supplementaryLabel(i, img.caption) });
      blocks.push({ type: "image", source: { type: "base64", media_type: img.mimeType || "image/jpeg", data: img.base64.replace(/^data:image\/\w+;base64,/, "") } });
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// ConfigurableGeminiAppraiser — single-stage Gemini
// ---------------------------------------------------------------------------

export class ConfigurableGeminiAppraiser implements AppraisalMethod {
  public id: string;
  public name: string;
  public description: string;
  public config: AppraisalMethodConfig;
  private aiClient: GoogleGenAI | null = null;

  constructor(config: AppraisalMethodConfig, aiClient?: GoogleGenAI) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    if (aiClient) this.aiClient = aiClient;
  }

  private getClient(): GoogleGenAI {
    if (!this.aiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not defined.");
      this.aiClient = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
    }
    return this.aiClient;
  }

  public async appraise(input: AppraisalInput): Promise<PrintAnalysisReport> {
    const ai = this.getClient();
    const currency = input.currency || "USD";
    const includeAux = this.config.includeAuxiliaryScans;
    const parts = buildGeminiImageParts(input, includeAux);

    const supplementaryCaptions = includeAux ? (input.supplementaryImages || []).map((i) => i.caption) : [];
    let textPrompt: string;
    if (this.config.promptText) {
      textPrompt = resolveCustomPrompt(this.config.promptText, currency, input.userNotes, supplementaryCaptions);
    } else {
      textPrompt = getPrompt(this.config.promptKey, currency, input.userNotes, supplementaryCaptions);
    }
    parts.push({ text: textPrompt });

    const response = await ai.models.generateContent({
      model: this.config.modelName,
      contents: { parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: FINAL_REPORT_RESPONSE_SCHEMA,
        temperature: this.config.temperature,
        safetySettings: GEMINI_SAFETY_SETTINGS,
      },
    });

    if (!response.text) throw new Error("No output text received from Gemini analysis.");
    const report = JSON.parse(response.text.trim());
    report.modelUsed = this.config.modelName;
    report.promptVersion = this.config.promptKey;
    return report;
  }
}

// ---------------------------------------------------------------------------
// ConfigurableClaudeAppraiser — single-stage Claude
// ---------------------------------------------------------------------------

export class ConfigurableClaudeAppraiser implements AppraisalMethod {
  public id: string;
  public name: string;
  public description: string;
  public config: AppraisalMethodConfig;

  constructor(config: AppraisalMethodConfig) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
  }

  public async appraise(input: AppraisalInput): Promise<PrintAnalysisReport> {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY environment variable is defined.");

    const currency = input.currency || "USD";
    const includeAux = this.config.includeAuxiliaryScans;
    const contentBlocks = buildClaudeImageBlocks(input, includeAux);

    const supplementaryCaptions = includeAux ? (input.supplementaryImages || []).map((i) => i.caption) : [];
    let textPrompt: string;
    if (this.config.promptText) {
      textPrompt = resolveCustomPrompt(this.config.promptText, currency, input.userNotes, supplementaryCaptions);
    } else {
      textPrompt = getPrompt(this.config.promptKey, currency, input.userNotes, supplementaryCaptions);
    }
    contentBlocks.push({ type: "text", text: textPrompt });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.modelName,
        max_tokens: 4096,
        messages: [{ role: "user", content: contentBlocks }],
        tools: [{
          name: "report_print_analysis",
          description: "Report the structured art print analysis and appraisal details.",
          input_schema: FINAL_REPORT_CLAUDE_SCHEMA,
        }],
        tool_choice: { type: "tool", name: "report_print_analysis" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const toolUseBlock = data.content?.find((b: any) => b.type === "tool_use");
    if (!toolUseBlock?.input) throw new Error("Claude did not return a valid structured tool call report.");

    const report = toolUseBlock.input as PrintAnalysisReport;
    report.modelUsed = this.config.modelName;
    report.promptVersion = this.config.promptKey;
    return report;
  }
}

// ---------------------------------------------------------------------------
// Shared Gemini safety settings
// ---------------------------------------------------------------------------

const GEMINI_SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ---------------------------------------------------------------------------
// Default model for Stage 1b visual search
// ---------------------------------------------------------------------------

const DEFAULT_STAGE1B_MODEL = "gemini-3.7-flash";
const HYPOTHESIS_WARNING =
  "⚠️ HYPOTHESIS ONLY — Stage 1b reverse image search result. Must be verified against VEA visual evidence (signatures, inscriptions, technique) before use in attribution. Do not treat as confirmed attribution.";
const STAGE1C_MODEL = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Stage 1d — image-embedding match (ADR-0013). Shadow-run only: computed and
// attached to the report for visibility, never read by Stage 2a/2b/3 this pass.
// ---------------------------------------------------------------------------

const STAGE1D_INDEX_COVERAGE_NOTE =
  "ACKG image index currently covers British Museum + Tate only (~12k images, DINOv2-Large/CLIP). " +
  "Forum Auctions and Roseberys are not yet embedded — a weak or absent match reflects this coverage gap, not evidence against attribution.";
const STAGE1D_ATTRIBUTION_CAVEAT =
  "DINOv2/CLIP similarity reflects visual/stylistic closeness, not verified authorship — one corroborating " +
  "evidence point, never a standalone attribution (see ADR-0002, ADR-0013).";
const STAGE1D_HYPOTHESIS_WARNING =
  "⚠️ HYPOTHESIS ONLY — Stage 1d image-embedding match. Shadow-run: not yet used in attribution. DINOv2/CLIP visual similarity, not verified authorship. Do not treat as confirmed attribution.";

// ---------------------------------------------------------------------------
// MultiStageAppraiser — base class with shared callers and stage runners
// ---------------------------------------------------------------------------

abstract class MultiStageAppraiser implements AppraisalMethod {
  public id: string;
  public name: string;
  public description: string;
  public config: AppraisalMethodConfig;
  private aiClient: GoogleGenAI | null = null;

  constructor(config: AppraisalMethodConfig, aiClient?: GoogleGenAI) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    if (aiClient) this.aiClient = aiClient;
  }

  protected getClient(): GoogleGenAI {
    if (!this.aiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not defined.");
      this.aiClient = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
    }
    return this.aiClient;
  }

  // ---- Low-level API callers ------------------------------------------------

  protected async callGemini(
    ai: GoogleGenAI,
    modelName: string,
    systemInstruction: string,
    parts: any[],
    responseSchema: any,
    temperature: number,
    useSearch: boolean = false
  ): Promise<any> {
    const config: any = {
      temperature,
      systemInstruction,
      safetySettings: GEMINI_SAFETY_SETTINGS,
    };

    if (useSearch) {
      config.tools = [{ googleSearch: {} }];
      parts.push({
        text: `\n\nIMPORTANT FORMATTING REQUIREMENT:\nReturn your output strictly as a valid JSON object matching the schema below. Do not output any text before or after the JSON.\n\nJSON Schema:\n${JSON.stringify(responseSchema, null, 2)}`,
      });
    } else {
      config.responseMimeType = "application/json";
      config.responseSchema = responseSchema;
    }

    const response = await ai.models.generateContent({ model: modelName, contents: { parts }, config });
    if (!response.text) throw new Error(`No output text received from Gemini model ${modelName}.`);

    try {
      return useSearch ? parseCleanJson(response.text) : JSON.parse(response.text.trim());
    } catch (err: any) {
      console.error(`[4-Stage] Failed to parse JSON from ${modelName} (useSearch=${useSearch}). Raw text (first 500):`, response.text?.slice(0, 500));
      throw new Error(`Failed to parse ${modelName} JSON output: ${err.message}`);
    }
  }

  protected async callClaude(
    modelName: string,
    systemInstruction: string,
    contentBlocks: any[],
    toolName: string,
    toolDescription: string,
    inputSchema: any
  ): Promise<any> {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY environment variable is defined.");

    // Prompt caching: `tools` and `system` render before `messages`, so a breakpoint on
    // the system block caches the (static) tool schema + system prompt together. Big win
    // for batch runs and repeated evaluations against a fixed pool — every lot after the
    // first reads the schema+prompt from cache (~0.1x) instead of re-sending it. The
    // per-lot content (image, notes) sits in `messages`, after the breakpoint, so it
    // never poisons the cache. 5-minute TTL is enough while a batch is actively running.
    const data = await postAnthropicMessages(
      apiKey,
      {
        model: modelName,
        max_tokens: 4096,
        system: [{ type: "text", text: systemInstruction, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: contentBlocks }],
        tools: [{ name: toolName, description: toolDescription, input_schema: translateSchemaToStandardJsonSchema(inputSchema) }],
        tool_choice: { type: "tool", name: toolName },
      },
      { label: `Claude ${toolName}` },
    );

    const toolUseBlock = data.content?.find((b: any) => b.type === "tool_use");
    if (!toolUseBlock?.input) throw new Error(`Claude did not return a valid structured tool call for ${toolName}.`);
    return toolUseBlock.input;
  }

  // ---- Museum collection lookup tool (Stage 2b) --------------------------------

  private static readonly MUSEUM_LOOKUP_TOOL = {
    name: "lookup_museum_collections",
    description:
      "Search the Metropolitan Museum of Art, the Rijksmuseum, and the UK Museum " +
      "Data Service (which aggregates many UK institutions) for catalogued works by " +
      "a given artist. Returns real facts from actual museum records — title, medium, " +
      "dimensions, inscription/edition text, date, holding institution — not search " +
      "snippets to interpret. Text/metadata only, no images. Coverage varies hugely by " +
      "artist: strong for historic/deceased artists, often empty for living or very " +
      "recent ones — an empty result reflects institutional coverage, not evidence " +
      "against the attribution. Use the artist's formal name; honorifics and " +
      "post-nominal letters are stripped automatically, but misspellings and " +
      "nicknames are not corrected.",
    input_schema: {
      type: "object" as const,
      properties: {
        artist: {
          type: "string" as const,
          description: "The candidate artist's full formal name, e.g. \"Elizabeth Frink\".",
        },
      },
      required: ["artist"],
    },
  };

  /** Cap what reaches the model — real facts, not a dump of every field on every record. */
  private formatMuseumLookupForClaude(result: ArtistLookupResult): string {
    const MAX_RECORDS_PER_SOURCE = 12;
    const lines: string[] = [`Museum lookup for "${result.artist}" (queried as "${result.queriedAs}"):`];

    for (const s of result.sources) {
      if (!s.ok) {
        lines.push(`\n${s.source}: unavailable (${s.error})`);
        continue;
      }
      lines.push(`\n${s.source}: ${s.records.length} record(s)${s.records.length === 0 ? " — no holdings found under this name" : ""}`);
      for (const r of s.records.slice(0, MAX_RECORDS_PER_SOURCE)) {
        const parts = [
          r.title ? `"${r.title}"` : "(untitled)",
          r.medium,
          r.dimensions,
          r.date,
          r.collection,
        ].filter(Boolean);
        lines.push(`  - ${parts.join(" | ")}`);
        if (r.inscription) lines.push(`    inscription: ${r.inscription}`);
      }
      if (s.records.length > MAX_RECORDS_PER_SOURCE) {
        lines.push(`  … and ${s.records.length - MAX_RECORDS_PER_SOURCE} more`);
      }
    }
    return lines.join("\n");
  }

  protected async callClaudeWithWebSearch(
    modelName: string,
    systemInstruction: string,
    userText: string,
    maxTokens: number = 8192
  ): Promise<any> {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY environment variable is defined.");

    const tools = [{ type: "web_search_20250305", name: "web_search" }, MultiStageAppraiser.MUSEUM_LOOKUP_TOOL];

    const post = (messages: any[], forceFinal: boolean) =>
      postAnthropicMessages(
        apiKey!,
        {
          model: modelName,
          max_tokens: maxTokens,
          // Cache the specialist system prompt (+ injected config). Reused verbatim for
          // every lot routed to the same specialist config; the web_search tool renders
          // before it and is cached alongside.
          system: [{ type: "text", text: systemInstruction, cache_control: { type: "ephemeral" } }],
          messages,
          tools,
          ...(forceFinal ? { tool_choice: { type: "none" } } : {}),
        },
        { label: "Claude web-search", betaHeader: "web-search-2025-03-05" },
      );

    // Loop while Claude is still requesting client-executed tools (lookup_museum_collections).
    // Crucially, tools stay AVAILABLE (not forced to none) between rounds — Anthropic's
    // native web_search is server-executed, but if a client tool_use appears before a
    // pending web_search resolves in the same turn, the search is left dangling (a
    // server_tool_use block with no paired web_search_tool_result). Forcing tool_choice:
    // none immediately after supplying the client tool_result — the previous behavior —
    // orphans that pending search and the API rejects the next request outright. Letting
    // the loop continue with tools still enabled lets Anthropic actually finish it.
    const messages: any[] = [{ role: "user", content: userText }];
    const MAX_ROUNDS = 4;
    let data: any = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      data = await post(messages, false);

      if (data.stop_reason === "max_tokens") {
        throw new Error("Claude (web-search) hit max_tokens limit — response was truncated. Try a simpler query or increase max_tokens.");
      }

      const clientToolUses = (data.content || []).filter((b: any) => b.type === "tool_use");
      if (clientToolUses.length === 0) break; // done — either end_turn text, or only server-resolved web search

      messages.push({ role: "assistant", content: data.content });
      const toolResults = await Promise.all(
        clientToolUses.map(async (b: any) => {
          if (b.name === "lookup_museum_collections") {
            const artist = typeof b.input?.artist === "string" ? b.input.artist : "";
            let content: string;
            try {
              const result = await lookupArtistAcrossMuseums(artist);
              content = this.formatMuseumLookupForClaude(result);
            } catch (err: any) {
              content = `Museum lookup failed: ${err.message}`;
            }
            return { type: "tool_result", tool_use_id: b.id, content };
          }
          return { type: "tool_result", tool_use_id: b.id, content: "Search complete." };
        }),
      );
      messages.push({ role: "user", content: toolResults });
    }

    // If Claude stopped naturally (end_turn) with no pending tool calls, parse directly.
    const hasToolUse = (data.content || []).some((b: any) => b.type === "tool_use");
    if (!hasToolUse && data.stop_reason === "end_turn") {
      const textBlocks = (data.content || []).filter((b: any) => b.type === "text");
      const lastText = textBlocks[textBlocks.length - 1]?.text as string;
      console.log("[4-Stage] web-search raw response (first 500):", lastText?.slice(0, 500));
      console.log("[4-Stage] web-search raw response (last 300):", lastText?.slice(-300));
      try { return parseCleanJson(lastText); } catch (err: any) {
        throw new Error(`Failed to parse web-search JSON output: ${err.message}`);
      }
    }

    // Either the round budget ran out, or the last turn ended on a resolved server tool
    // (web_search) with no client action needed. Either way, finalise: keep tools defined
    // (Anthropic requires consistent tool schemas across a conversation) but force no more
    // calls, and ask for pure JSON.
    messages.push({ role: "assistant", content: data.content });
    messages.push({
      role: "user",
      content: "Now output your final answer as a single valid JSON object only. No prose, no markdown, no explanation. Start with { and end with }.",
    });

    const finalData = await post(messages, true);
    const finalTextBlocks = finalData.content?.filter((b: any) => b.type === "text") || [];
    if (!finalTextBlocks.length) throw new Error("Claude (web-search finalise) returned no text blocks.");

    const lastText = finalTextBlocks[finalTextBlocks.length - 1].text as string;
    console.log("[4-Stage] web-search raw response (first 500):", lastText?.slice(0, 500));
    console.log("[4-Stage] web-search raw response (last 300):", lastText?.slice(-300));
    try {
      const parsed = parseCleanJson(lastText);
      console.log("[4-Stage] web-search parsed JSON keys:", Object.keys(parsed));
      console.log("[4-Stage] recentAuctionSales:", JSON.stringify(parsed.recentAuctionSales || parsed.attributionConclusion?.recentAuctionSales || "MISSING"));
      return parsed;
    } catch (err: any) {
      console.error("[4-Stage] Failed to parse web-search JSON. Full raw text:", lastText);
      throw new Error(`Failed to parse ASA JSON output: ${err.message}`);
    }
  }

  // ---- ACKG (Art Context Knowledge Graph) query tool (Stage 2a) --------------
  // See docs/adr/0003-knowledge-graph-grounded-triage.md item 4 and
  // src/appraisal/knowledge_graph/. Deliberately a tool call, not embedded in
  // the prompt: an LLM asked to emit vocabulary URIs or population statistics
  // from memory, without a live lookup, is a real hallucination risk.

  private static readonly QUERY_ACKG_TOOL = {
    name: "query_ackg",
    description:
      "Query the Art Context Knowledge Graph — a Neo4j graph built from real ingested " +
      "print records (Metropolitan Museum of Art, Roseberys, Forum Auctions; ~4,800 " +
      "artists, ~33,700 works) — for artists whose actual catalogued output matches the " +
      "given technique/period/paper/region/subject combination. Returns candidates ranked " +
      "by supportCount (how many real matching works exist), split into institutional vs. " +
      "auction-history provenance. All parameters are optional — supply whichever you " +
      "currently have evidence for from VEA, and narrow with a second call once your " +
      "hypothesis sharpens. IMPORTANT: a zero or low supportCount is real absence-of-" +
      "population-data for that combination in this graph's current sources — it is NOT " +
      "evidence against a candidate. Coverage is strong for Western 19th-20th century " +
      "prints and currently thin-to-absent for ukiyo-e specifically; treat a zero result " +
      "for an East Asian candidate as a coverage gap, never as disqualifying.",
    input_schema: {
      type: "object" as const,
      properties: {
        technique: { type: "string" as const, description: "Printing technique, e.g. \"Etching\", \"Screenprint\"." },
        periodStartYear: { type: "integer" as const, description: "Inclusive lower bound on creation year." },
        periodEndYear: { type: "integer" as const, description: "Inclusive upper bound on creation year." },
        paper: { type: "string" as const, description: "Paper type, e.g. \"wove\", \"laid\"." },
        region: { type: "string" as const, description: "Artist nationality/region hint, e.g. \"British\", \"Japanese\"." },
        subject: { type: "string" as const, description: "Depicted subject, e.g. \"Portraits\", \"Horses\"." },
        workTitle: { type: "string" as const, description: "A specific work title to look for, e.g. \"Death of the Virgin\". Substring, case-insensitive, against catalogued work names. Use this to check whether a title from VEA text / Stage 1b / the appraiser is catalogued in the graph and to which artist — supportCount and sample works then reflect only that artist's title-matching works." },
      },
      required: [],
    },
  };

  private static readonly QUERY_ACKG_WORK_TOOL = {
    name: "query_ackg_work",
    description:
      "Look up a SPECIFIC catalogued work in the Art Context Knowledge Graph and return its " +
      "catalogued technique(s), medium description, plate/image/sheet dimensions (in mm), and " +
      "edition sizes — aggregated per Conceptual Work across every ingested impression. Use " +
      "this once you have a leading artist and a candidate title, to fill the impressionEvidence " +
      "cells: it tells you what the catalogued record says the work's medium and size are, so " +
      "the physical object in hand can be checked against it (later edition, restrike, " +
      "photomechanical reproduction, medium variant). Pass `artist` AND `workTitle` (a short " +
      "distinctive fragment). Near-duplicate title rows are un-merged re-ingests — merge them. " +
      "An empty result is absence-of-coverage, not evidence the work is fake.",
    input_schema: {
      type: "object" as const,
      properties: {
        artist: { type: "string" as const, description: "Artist name, substring — strongly recommended." },
        workTitle: { type: "string" as const, description: "Distinctive title fragment for the substring pre-filter, e.g. \"Death of the Virgin\", \"Wu Zetian\", \"Le Taureau\". Keep it short." },
        observedTitle: { type: "string" as const, description: "The FULL observed title as best you have it (from VEA text / Stage 1b / the appraiser). Used for an embedding similarity rank — the result reports a 'computed title similarity' per work; transcribe the best one into kWorkTitleSim." },
        observedTechnique: { type: "string" as const, description: "VEA's observed printing technique, e.g. \"Etching\", \"Lithograph\", \"Screenprint\". Used to break ties between same-titled works of different media." },
        technique: { type: "string" as const, description: "Optional hard technique filter on the returned works." },
        periodStartYear: { type: "integer" as const, description: "Optional inclusive lower bound on creation year." },
        periodEndYear: { type: "integer" as const, description: "Optional inclusive upper bound on creation year." },
      },
      required: [],
    },
  };

  /** Cap what reaches the model — ranked facts, not a raw graph dump. */
  private formatAckgResultForClaude(candidates: AckgCandidate[]): string {
    if (candidates.length === 0) {
      return "No candidates found for this filter combination — this is an absence-of-" +
        "population-data signal for this graph's current sources, not evidence against " +
        "any specific artist. Try broadening or dropping a filter, or proceed with other evidence.";
    }
    const lines = [`${candidates.length} candidate(s), ranked by support count:`];
    for (const c of candidates) {
      lines.push(
        `\n${c.artistName} — supportCount=${c.supportCount} ` +
        `(institutional=${c.institutionalSupportCount}, auction_history=${c.auctionSupportCount})` +
        `${c.ulanUrl ? ` [ULAN: ${c.ulanUrl}]` : ""}`
      );
      if (c.sampleWorks.length) lines.push(`  sample works: ${c.sampleWorks.join(" | ")}`);
    }
    return lines.join("\n");
  }

  /** Merge near-duplicate ConceptualWork rows (un-merged re-ingests) and render the
   *  catalogued technique + dimension facts the impression check needs. */
  private formatAckgWorksForClaude(works: AckgWorkMatch[]): string {
    if (works.length === 0) {
      return "No catalogued work matches this artist + title in the graph's current sources. " +
        "This is absence-of-coverage, not evidence the work is fake — leave impressionEvidence " +
        "catalogueTechniques [] and observedDimSource per what the appraiser/VEA gave you.";
    }
    const dl = (label: string, ds: { w: number; h: number }[]) =>
      ds.length ? `${label}=${[...new Set(ds.map((d) => `${d.w}x${d.h}mm`))].join(", ")}` : "";
    const scored = works.some((w) => w.titleSim != null);
    const lines = [
      `${works.length} catalogued row(s)${scored ? ", ranked by computed title similarity (merge near-identical titles)" : " (merge near-identical titles)"}:`,
    ];
    for (const w of works) {
      const dims = [dl("plate", w.plateDimsMm), dl("image", w.imageDimsMm), dl("sheet", w.sheetDimsMm)].filter(Boolean).join("  ");
      lines.push(
        `\n"${w.workTitle}" — ${w.artistName}${w.dateLabel ? ` (${w.dateLabel})` : ""} [${w.impressionCount} impr., ${w.provenanceLayers.join("+") || "?"}]` +
          (w.titleSim != null ? `\n  computed title similarity: ${w.titleSim.toFixed(2)} (${w.titleSimBasis})` : "") +
          `\n  techniques: ${w.techniques.join(", ") || "—"}` +
          (w.rawMediums.length ? `\n  media: ${w.rawMediums.join(" | ")}` : "") +
          (dims ? `\n  dims: ${dims}` : "\n  dims: — (none catalogued)") +
          (w.editionSizes.length ? `\n  editions: ${w.editionSizes.join(", ")}` : ""),
      );
    }
    return lines.join("\n");
  }

  /**
   * Bounded tool loop for Stage 2a (Triage), scoped to only the query_ackg tool —
   * no native web_search, since Triage classifies and routes, it doesn't browse
   * the web (that's Stage 2b's job via callClaudeWithWebSearch below). A new,
   * dedicated function rather than a modification of callClaudeWithWebSearch:
   * that function is Stage 2b's already-shipped, tested tool loop and stays
   * untouched here to carry zero regression risk.
   *
   * Finalises with a forced tool_choice matching the target schema (the same
   * mechanism callClaude uses) rather than callClaudeWithWebSearch's free-text-
   * JSON-then-parse finalisation — more robust, and the full tool-call history
   * carries over into that final request at no extra cost.
   */
  protected async callClaudeWithAckgTool(
    modelName: string,
    systemInstruction: string,
    userText: string,
    maxTokens: number = 8192,
    finalTool: { name: string; description: string; schema: any },
    opts: { extraTools?: any[]; maxRounds?: number } = {}
  ): Promise<any> {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY environment variable is defined.");

    const tools = [MultiStageAppraiser.QUERY_ACKG_TOOL, ...(opts.extraTools ?? [])];
    const graphToolNames = new Set(tools.map((t: any) => t.name));
    const finalToolName = finalTool.name;

    const post = (messages: any[], forceFinalTool: boolean) =>
      postAnthropicMessages(
        apiKey!,
        {
          model: modelName,
          max_tokens: maxTokens,
          // Cache the triage system prompt (it is large and identical for every lot). Across
          // a pool run — and across repeated triage-version evaluations against that pool —
          // this is the single biggest input-token saving: only the first lot writes it,
          // every lot after reads it at ~0.1x. The query_ackg tool schema (rendered before
          // `system`) is cached alongside it. The growing tool-loop `messages` sit after the
          // breakpoint. On the final forced call the extra report tool changes `tools`, so
          // that one call rewrites — one rewrite per lot, still cheap.
          system: [{ type: "text", text: systemInstruction, cache_control: { type: "ephemeral" } }],
          messages,
          tools: forceFinalTool
            ? [...tools, { name: finalToolName, description: finalTool.description, input_schema: translateSchemaToStandardJsonSchema(finalTool.schema) }]
            : tools,
          ...(forceFinalTool ? { tool_choice: { type: "tool", name: finalToolName } } : {}),
        },
        { label: "Stage 2a ACKG tool" },
      );

    const messages: any[] = [{ role: "user", content: userText }];
    const MAX_ROUNDS = opts.maxRounds ?? 4;
    let data: any = null;

    let roundsUsed = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      data = await post(messages, false);
      if (data.stop_reason === "max_tokens") {
        throw new Error("Claude (ACKG tool) hit max_tokens limit — response was truncated.");
      }
      const clientToolUses = (data.content || []).filter((b: any) => b.type === "tool_use" && graphToolNames.has(b.name));
      if (clientToolUses.length === 0) {
        console.log(`[Stage 2a ACKG loop] round ${round + 1}: no graph query — stopping loop (${roundsUsed} round(s) used)`);
        break;
      }
      roundsUsed = round + 1;

      // Log any reasoning text Claude produced alongside the tool call(s) this round —
      // the closest thing to "why" it's querying, since the API doesn't otherwise expose it.
      const reasoningText = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
      if (reasoningText) {
        console.log(`[Stage 2a ACKG loop] round ${round + 1} reasoning: ${reasoningText.slice(0, 400)}${reasoningText.length > 400 ? "…" : ""}`);
      }

      messages.push({ role: "assistant", content: data.content });
      const toolResults = await Promise.all(
        clientToolUses.map(async (b: any) => {
          console.log(`[Stage 2a ACKG loop] round ${round + 1} ${b.name} call: ${JSON.stringify(b.input || {})}`);
          let content: string;
          try {
            if (b.name === "query_ackg_work") {
              const inp = b.input || {};
              const observed = inp.observedTitle || inp.workTitle || "";
              // Derive a substring pre-filter from the observed title when the agent
              // didn't supply one — a raw artist-only query is ORDER BY impressionCount
              // and would drop a low-impression target work before scoring.
              const preFilter =
                inp.workTitle ||
                (observed
                  .toLowerCase()
                  .replace(/[^a-z0-9\s]/g, " ")
                  .split(/\s+/)
                  .filter((w: string) => w.length >= 4)
                  .sort((a: string, b: string) => b.length - a.length)[0] || undefined);
              let works = await queryAckgWorks({ ...inp, workTitle: preFilter });
              if (works.length === 0 && preFilter) {
                works = await queryAckgWorks({ ...inp, workTitle: undefined }); // last resort: artist only
              }
              if (observed && works.length) {
                const obsFam = inp.observedTechnique ? techniqueFamily(inp.observedTechnique) : null;
                works = await scoreWorkTitleMatches(observed, works, {
                  techniqueIncompatible: obsFam
                    ? (w) => w.techniques.length > 0 && !w.techniques.some((t) => techniqueFamily(t) === obsFam)
                    : undefined,
                });
              }
              content = this.formatAckgWorksForClaude(works);
              const best = works[0];
              console.log(`[Stage 2a ACKG loop] round ${round + 1} result: ${works.length} work row(s)${best ? ` — best: "${best.workTitle}" titleSim=${best.titleSim ?? "n/a"}` : ""}`);
            } else {
              const result = await queryAckg(b.input || {});
              content = this.formatAckgResultForClaude(result);
              console.log(`[Stage 2a ACKG loop] round ${round + 1} result: ${result.length} candidate(s)${result.length ? ` — top: ${result.slice(0, 3).map(c => `${c.artistName} (support=${c.supportCount})`).join(", ")}` : ""}`);
            }
          } catch (err: any) {
            content = `ACKG query failed: ${err.message}`;
            console.log(`[Stage 2a ACKG loop] round ${round + 1} result: ERROR — ${err.message}`);
          }
          return { type: "tool_result", tool_use_id: b.id, content };
        }),
      );
      messages.push({ role: "user", content: toolResults });

      if (round === MAX_ROUNDS - 1) {
        console.log(`[Stage 2a ACKG loop] hit MAX_ROUNDS=${MAX_ROUNDS} — finalizing with whatever evidence was gathered`);
      }
    }

    // Finalise: force the schema tool call, carrying the full reasoning + tool-result
    // history from above into it.
    messages.push({
      role: "user",
      content: `Now report your final structured result via the ${finalToolName} tool.`,
    });
    const finalData = await post(messages, true);
    const toolUseBlock = finalData.content?.find((b: any) => b.type === "tool_use" && b.name === finalToolName);
    if (!toolUseBlock?.input) {
      throw new Error(`Claude (ACKG tool) did not return a valid structured tool call for ${finalToolName}.`);
    }
    return toolUseBlock.input;
  }

  // ---- Stage 1b — Gemini Visual Search ----------------------------------------

  // Uses Google Custom Search API (image search) to retrieve a direct image URL for a
  // known artist + title hypothesis. Falls back gracefully when keys are absent.
  // Fetch a reference thumbnail via the Wikimedia API using artist + title as search terms.
  // Returns base64-encoded image data ready for visual similarity scoring, or null if not found.
  private async fetchReferenceImageViaWikimedia(
    artist: string,
    title: string | null
  ): Promise<{ base64: string; mimeType: string; sourceUrl: string; isArtistPortrait: boolean } | null> {
    const WIKIMEDIA_UA = "PrintMasterAI/1.0 (https://github.com/printmaster-ai; sylvansitkey07@gmail.com) node-fetch/3";
    const fullQuery = [artist, title].filter(Boolean).join(" ");

    try {
      // Strategy 1: Wikipedia article for the artist — get the lead image thumbnail
      // This reliably returns a representative work image for all major artists
      const wikiArtistParams = new URLSearchParams({
        action: "query",
        titles: artist,
        prop: "pageimages",
        pithumbsize: "500",
        piprop: "thumbnail|name",
        format: "json",
        origin: "*",
      });
      const wikiArtistRes = await fetch(
        `https://en.wikipedia.org/w/api.php?${wikiArtistParams}`,
        { headers: { "User-Agent": WIKIMEDIA_UA }, signal: AbortSignal.timeout(8000) }
      );
      let wikiArtistThumbUrl: string | null = null;
      if (wikiArtistRes.ok) {
        const wikiData: any = await wikiArtistRes.json();
        const pages = Object.values(wikiData?.query?.pages || {}) as any[];
        wikiArtistThumbUrl = pages[0]?.thumbnail?.source || null;
        if (wikiArtistThumbUrl) console.log(`[Stage 1b] Wikipedia artist thumb: ${wikiArtistThumbUrl}`);
      }

      // Strategy 2: search Commons full-text (all namespaces) for artist + title
      const commonsSearchParams = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: fullQuery,
        srlimit: "5",
        format: "json",
        origin: "*",
      });
      const searchRes = await fetch(
        `https://commons.wikimedia.org/w/api.php?${commonsSearchParams}`,
        { headers: { "User-Agent": WIKIMEDIA_UA }, signal: AbortSignal.timeout(8000) }
      );
      let commonsThumbUrl: string | null = null;
      if (searchRes.ok) {
        const searchData: any = await searchRes.json();
        const results: any[] = searchData?.query?.search || [];
        // Find the first result that is a file
        const fileResult = results.find((r: any) => r.title?.startsWith("File:"));
        if (fileResult) {
          const thumbParams = new URLSearchParams({
            action: "query",
            titles: fileResult.title,
            prop: "imageinfo",
            iiprop: "url",
            iiurlwidth: "500",
            format: "json",
            origin: "*",
          });
          const thumbRes = await fetch(
            `https://commons.wikimedia.org/w/api.php?${thumbParams}`,
            { headers: { "User-Agent": WIKIMEDIA_UA }, signal: AbortSignal.timeout(8000) }
          );
          if (thumbRes.ok) {
            const thumbData: any = await thumbRes.json();
            const pages = Object.values(thumbData?.query?.pages || {}) as any[];
            commonsThumbUrl = pages[0]?.imageinfo?.[0]?.url || null;
            if (commonsThumbUrl) console.log(`[Stage 1b] Wikimedia Commons thumb: ${commonsThumbUrl}`);
          }
        }
      }

      // Prefer Commons (a specific-work match) over the Wikipedia artist page (a portrait).
      const finalUrl = commonsThumbUrl || wikiArtistThumbUrl;
      const isArtistPortrait = !commonsThumbUrl && !!wikiArtistThumbUrl;
      if (!finalUrl) {
        console.log(`[Stage 1b] Wikimedia: no image found for "${fullQuery}"`);
        return null;
      }

      console.log(`[Stage 1b] Wikimedia thumbnail: ${finalUrl}${isArtistPortrait ? " (artist-page lead image — likely a portrait)" : ""}`);
      const fetched = await this.fetchImageAsBase64(finalUrl);
      if (!fetched) {
        console.warn(`[Stage 1b] Wikimedia thumbnail fetch failed`);
        return null;
      }
      return { ...fetched, sourceUrl: finalUrl, isArtistPortrait };
    } catch (err: any) {
      console.warn(`[Stage 1b] Wikimedia lookup error: ${err.message}`);
      return null;
    }
  }

  protected async fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": new URL(url).origin + "/",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        console.warn(`[Stage 1b] Image fetch failed: HTTP ${response.status} from ${url}`);
        return null;
      }
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
      const buf = Buffer.from(await response.arrayBuffer());
      // Sniff magic bytes — museum/CDN image APIs and S3 buckets often serve images as
      // application/octet-stream or with no Content-Type, and many valid image URLs
      // (Met IIIF /main-image, Artsy's proxy) have no file extension.
      const sniff = (): string | null => {
        if (buf.length < 12) return null;
        if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
        if (buf.toString("ascii", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
        if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
        if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
        return null;
      };
      const mimeType = contentType.startsWith("image/") ? contentType : sniff();
      if (!mimeType) {
        console.warn(`[Stage 1b] Not an image (content-type "${contentType || "none"}", bytes don't match): ${url}`);
        return null;
      }
      return { base64: buf.toString("base64"), mimeType };
    } catch (err: any) {
      console.warn(`[Stage 1b] Image fetch error: ${err.message}`);
      return null;
    }
  }

  protected async scoreVisualSimilarity(
    ai: GoogleGenAI,
    inputBase64: string,
    inputMimeType: string,
    matchBase64: string,
    matchMimeType: string,
    candidateLabel: string
  ): Promise<{ score: number; rationale: string }> {
    const prompt = `You are a fine art visual similarity expert. Compare these two images — the first is the submitted artwork, the second is a candidate match found via reverse image search (${candidateLabel}).

The question is whether these are the SAME WORK — not whether the two photographs are framed the same way. A tight crop, a different angle, different lighting, a border cropped off, or one being a catalogue scan and the other a phone photo are NOT reasons to lower the score if the composition is the same.

Score their visual similarity from 0.0 to 1.0 using this scale:
  1.0 — Same work, near-identical reproduction
  0.9 — Clearly the same work — same composition and forms; differs only in photography (angle, lighting, crop, colour cast)
  0.8 — Very likely the same work or a direct variant (same image, different state / edition / colourway)
  0.7 — Strong match — same artist and composition family, but a genuine compositional difference remains
  0.6 — Probable match — similar style and technique, plausibly the same artist, composition only loosely aligned
  0.5 — Possible match — shared tradition and technique, significant compositional differences
  0.3 — Weak match — similar tradition only
  0.0 — No meaningful visual similarity  (e.g. one image is a photo of a person, a gallery interior, or an unrelated work)

Focus on: composition and layout, the forms and their placement, subject matter, colour relationships, and technique markers (line quality, ink texture, screen/plate registration). Ignore differences that are purely photographic.

Return ONLY a JSON object:
{
  "visualSimilarityScore": 0.0,
  "rationale": "One sentence explaining the score."
}`;

    try {
      const response = await ai.models.generateContent({
        model: this.config.stage1bModel || DEFAULT_STAGE1B_MODEL,
        contents: {
          parts: [
            { inlineData: { data: inputBase64, mimeType: inputMimeType } },
            { inlineData: { data: matchBase64, mimeType: matchMimeType } },
            { text: prompt },
          ],
        },
        config: { responseMimeType: "application/json", temperature: 0.05 },
      });
      const parsed = parseCleanJson(response.text || "{}");
      return {
        score: typeof parsed.visualSimilarityScore === "number" ? parsed.visualSimilarityScore : 0,
        rationale: parsed.rationale || "",
      };
    } catch {
      return { score: 0, rationale: "Visual similarity scoring failed." };
    }
  }

  protected async runStage1bVisionSearch(imageBase64: string, mimeType: string = "image/jpeg"): Promise<VisualSearchResult> {
    const stage1bModel = this.config.stage1bModel || DEFAULT_STAGE1B_MODEL;
    const EMPTY: VisualSearchResult = {
      webEntities: [], matchedUrls: [], visuallySimilarUrls: [], pagesWithMatchingImages: [],
      hypothesisWarning: HYPOTHESIS_WARNING,
    };

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      console.warn("[Stage 1b] GEMINI_API_KEY not set — skipping visual search.");
      return EMPTY;
    }

    const t = Date.now();
    console.log(`[Timing] Stage 1b (Gemini Visual Search) starting — model: ${stage1bModel}`);

    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const searchPrompt = `You are a fine-art REVERSE IMAGE search engine. You are given ONE image of a print or work on paper.

YOUR SINGLE DELIVERABLE: the direct URL of the reference image on the public web that is VISUALLY CLOSEST to this submission — ideally a photograph of the same work. Everything else you report is metadata describing that image.

You are NOT being asked to name an artist. Do not go looking for who made this. If the closest-matching image you find happens to come with a reliable artist/title, report them — but an artist name with no matching image is a FAILURE, not a result, and must be returned with artist/title still filled only if the image match itself supports them.

METHOD — in this order:
1. Look at the submitted image only: overall composition and layout, subject, colour palette, the print technique (etching / drypoint / aquatint / lithograph / screenprint / woodblock characteristics), and any signature, title, date or edition number physically inscribed IN the print. Those inscriptions are evidence from the object and are fine to use.
2. Use Google Search to find pages HOSTING REFERENCE IMAGES of prints with that composition — auction archives (Artnet, MutualArt, Christie's, Sotheby's, Bonhams, Phillips, Invaluable), museum collections (British Museum, V&A, Met, MoMA, Tate, NGA, Art Institute of Chicago), and dealer/gallery sites. Open several candidates.
3. Compare the ACTUAL IMAGES side by side. Pick the one whose composition, proportions and mark placement match the submission most closely.
4. Return the DIRECT image-file URL of that best match — the file itself (…/foo.jpg, …/bar.webp), not the webpage it sits on.

STRICTLY FORBIDDEN: identifying the work from a page's PROSE — an auction lot description, gallery caption or article — without visually confirming it against an actual image of that specific work. A confident-sounding written attribution you have NOT visually verified is not a match; it is someone else's unverified claim, and must not raise compositionMatch above "loose".

If no candidate genuinely matches the composition, return closestReferenceImageUrl: null and compositionMatch: "none". Do NOT return a loosely-related image, or a portrait of an artist, just to have something.

Return a single JSON object:
{
  "closestReferenceImageUrl": "direct image-file URL (.jpg/.jpeg/.png/.webp) of the closest match, or null",
  "sourcePageUrl": "the page that image was found on, or null",
  "compositionMatch": "identical | very_close | loose | none",
  "whatMatches": "specific visual features shared by the two images (composition, forms, palette, technique markers)",
  "whatDiffers": "specific visual features that differ, or 'none'",
  "artist": "artist name ONLY if the image match itself supports it, else null",
  "title": "work title ONLY if the image match itself supports it, else null",
  "technique": "etching / lithograph / screenprint / woodblock / ...",
  "period": "e.g. 1960s, or null",
  "webEntities": ["key identifying terms you saw"],
  "pagesWithMatchingImages": ["up to 5 page URLs you actually opened"]
}`;

    try {
      const response = await ai.models.generateContent({
        model: stage1bModel,
        contents: {
          parts: [
            { inlineData: { data: cleanBase64, mimeType: mimeType || "image/jpeg" } },
            { text: searchPrompt },
          ],
        },
        config: { tools: [{ googleSearch: {} }], temperature: 0.1 },
      });

      const text = response.text || "";
      console.log(`[Timing] Stage 1b (search) done — ${((Date.now() - t) / 1000).toFixed(1)}s`);

      let parsed: any;
      try {
        parsed = parseCleanJson(text);
      } catch {
        console.warn("[Stage 1b] Could not parse JSON from Gemini — returning empty result");
        console.log(`[Stage 1b] Raw response (unparsed, first 1000): ${text.slice(0, 1000)}`);
        return EMPTY;
      }

      const refUrl: string | null = parsed.closestReferenceImageUrl || null;
      const sourcePage: string | null = parsed.sourcePageUrl || null;
      const compositionMatch: VisualSearchResult["compositionMatch"] =
        ["identical", "very_close", "loose", "none"].includes(parsed.compositionMatch) ? parsed.compositionMatch : "none";
      const artist: string | null = parsed.artist || null;
      const title: string | null = parsed.title || null;
      console.log(`[Stage 1b] closest ref image : ${refUrl || "none"}   (compositionMatch=${compositionMatch})`);
      console.log(`[Stage 1b] source page       : ${sourcePage || "none"}`);
      console.log(`[Stage 1b] matches / differs : ${parsed.whatMatches || "-"}  //  ${parsed.whatDiffers || "-"}`);
      console.log(`[Stage 1b] metadata          : ${artist || "?"} — "${title || "?"}" (${parsed.technique || "?"}, ${parsed.period || "?"})`);

      // Score against the reference image the SEARCH step actually found (this is the
      // reverse-image-match). Only if it gave no usable image do we fall back to
      // Wikimedia Commons for the WORK by title — and never score against an
      // artist-portrait fallback, which is a meaningless comparison.
      let matchBase64: string | null = null;
      let matchMimeType: string | null = null;
      let matchSource: "search" | "commons_work" | "none" = "none";
      let similarityScore: number | null = null;
      let similarityRationale: string | null = null;

      // Try to fetch whatever URL the search returned — don't pre-filter on the
      // extension (museum IIIF endpoints and CDN proxies have none). fetchImageAsBase64
      // validates by response Content-Type + magic bytes.
      if (refUrl && /^https?:\/\//i.test(refUrl)) {
        const fetched = await this.fetchImageAsBase64(refUrl);
        if (fetched) {
          matchBase64 = fetched.base64;
          matchMimeType = fetched.mimeType;
          matchSource = "search";
        } else {
          console.warn(`[Stage 1b] could not fetch the search result's image URL: ${refUrl}`);
        }
      }

      if (!matchBase64 && artist && title && compositionMatch !== "none") {
        const wm = await this.fetchReferenceImageViaWikimedia(artist, title);
        if (wm && !wm.isArtistPortrait) {
          matchBase64 = wm.base64;
          matchMimeType = wm.mimeType;
          matchSource = "commons_work";
        } else if (wm?.isArtistPortrait) {
          console.log(`[Stage 1b] Wikimedia only had the artist's portrait — not scoring against it`);
        }
      }

      if (matchBase64 && matchMimeType) {
        const label = `${artist || "Unknown"} — "${title || "Untitled"}"`;
        const sim = await this.scoreVisualSimilarity(ai, cleanBase64, mimeType, matchBase64, matchMimeType, label);
        similarityScore = sim.score;
        similarityRationale = sim.rationale;
        console.log(`[Stage 1b] visual similarity : ${similarityScore} (vs ${matchSource} image) — ${similarityRationale}`);
      } else {
        console.warn(`[Stage 1b] no artwork reference image to score against — similarity skipped`);
        if (parsed.whatMatches || parsed.whatDiffers) {
          similarityRationale = `not scored (no reference image retrieved). compositionMatch=${compositionMatch}; matches: ${parsed.whatMatches || "-"}; differs: ${parsed.whatDiffers || "-"}`;
        }
      }

      // The search step over-claims "identical" then sometimes returns a different work
      // by the same artist. When the actual score contradicts its self-report, trust
      // the score.
      let effectiveCompositionMatch = compositionMatch;
      if (similarityScore != null) {
        if (similarityScore < 0.5 && compositionMatch !== "none") effectiveCompositionMatch = "loose";
        else if (similarityScore < 0.7 && compositionMatch === "identical") effectiveCompositionMatch = "very_close";
      }
      if (effectiveCompositionMatch !== compositionMatch) {
        console.log(`[Stage 1b] compositionMatch "${compositionMatch}" -> "${effectiveCompositionMatch}" (similarity ${similarityScore} contradicts the search step's read)`);
      }

      // Authoritative evidenceBasis + confidence, derived HERE from what actually
      // happened — not the model's self-report (which over-claims "visual").
      const evidenceBasis: VisualSearchResult["evidenceBasis"] =
        similarityScore != null ? "visual" : artist || title ? "textual" : "none";
      const matchConfidence: VisualSearchResult["matchConfidence"] =
        similarityScore == null
          ? artist || title
            ? "LOW"
            : null
          : similarityScore >= 0.85
            ? "HIGH"
            : similarityScore >= 0.7
              ? "MEDIUM"
              : "LOW";
      if (evidenceBasis === "textual") {
        console.warn(
          `[Stage 1b] ⚠️ metadata present but NO reference image was scored — evidenceBasis=textual, confidence capped at LOW. Downstream must treat this as an unverified name, not a visual match.`,
        );
      }

      return {
        webEntities: parsed.webEntities || [],
        matchedUrls: [],
        visuallySimilarUrls: [],
        pagesWithMatchingImages: parsed.pagesWithMatchingImages || [],
        bestMatchArtist: artist,
        bestMatchTitle: title,
        bestMatchImageUrl: refUrl,
        bestMatchImageBase64: matchSource === "search" ? matchBase64 : null,
        bestMatchImageMimeType: matchSource === "search" ? matchMimeType : null,
        visualSimilarityScore: similarityScore,
        visualSimilarityRationale: similarityRationale,
        compositionMatch: effectiveCompositionMatch,
        matchConfidence,
        evidenceBasis,
        hypothesisWarning: HYPOTHESIS_WARNING,
      };
    } catch (err: any) {
      console.warn(`[Stage 1b] Gemini visual search failed — skipping: ${err.message}`);
      return EMPTY;
    }
  }

  // ---- Stage 1d — image-embedding match (ADR-0013) ---------------------------
  // Shadow-run only: computed and attached to the report for visibility, but
  // deliberately NOT threaded into runStage2aTriage/runStage2bSpecialist this
  // pass (see FourStageAppraiser.appraise()). Same "degrade to empty, never
  // throw" discipline as Stage 1b — a down/slow embedding service or a Neo4j
  // query failure must never fail the appraisal.

  protected async runStage1dEmbeddingMatch(imageBase64: string, mimeType: string = "image/jpeg"): Promise<Stage1dResult> {
    const EMPTY: Stage1dResult = {
      schemaVersion: "IES-1.0",
      embeddingModelsUsed: { dinov2: null, clip: null },
      indexCoverageNote: STAGE1D_INDEX_COVERAGE_NOTE,
      candidateMatches: [],
      attributionCaveat: STAGE1D_ATTRIBUTION_CAVEAT,
      hypothesisWarning: STAGE1D_HYPOTHESIS_WARNING,
    };
    const t = Date.now();
    const vectors = await getImageEmbeddings(imageBase64, mimeType);
    if (!vectors || (!vectors.dinov2 && !vectors.clip)) {
      console.warn("[Stage 1d] embedding service unavailable or returned no vectors — skipping");
      return EMPTY;
    }
    try {
      const candidates: EmbeddingMatchCandidate[] = await queryImageEmbeddingMatches(
        vectors.dinov2?.vector ?? null,
        vectors.clip?.vector ?? null,
        { limit: 10 },
      );
      const best = candidates[0];
      // Provisional threshold, NOT calibrated against a backtest set — ADR-0013's "Not
      // addressed" section explicitly flags this. Low-stakes to leave uncalibrated since
      // nothing downstream reads it this pass.
      const matchConfidence: Stage1dResult["matchConfidence"] = !best
        ? null
        : (best.dinov2Similarity ?? 0) >= 0.90 && (best.clipSimilarity ?? 0) >= 0.80
          ? "HIGH"
          : (best.dinov2Similarity ?? 0) >= 0.80
            ? "MEDIUM"
            : "LOW";
      console.log(
        `[Stage 1d] done — ${((Date.now() - t) / 1000).toFixed(1)}s, ${candidates.length} candidate(s), ` +
        `top: ${best?.artistName ?? "none"} — "${best?.conceptualWorkTitle ?? "?"}" ` +
        `(dino=${best?.dinov2Similarity ?? "—"}, clip=${best?.clipSimilarity ?? "—"})`
      );
      return {
        schemaVersion: "IES-1.0",
        embeddingModelsUsed: { dinov2: vectors.dinov2?.model ?? null, clip: vectors.clip?.model ?? null },
        indexCoverageNote: STAGE1D_INDEX_COVERAGE_NOTE,
        candidateMatches: candidates,
        bestMatchArtist: best?.artistName ?? null,
        bestMatchConceptualWorkTitle: best?.conceptualWorkTitle ?? null,
        dinov2SimilarityScore: best?.dinov2Similarity ?? null,
        clipSimilarityScore: best?.clipSimilarity ?? null,
        matchConfidence,
        attributionCaveat: STAGE1D_ATTRIBUTION_CAVEAT,
        hypothesisWarning: STAGE1D_HYPOTHESIS_WARNING,
      };
    } catch (err: any) {
      console.warn(`[Stage 1d] Neo4j vector query failed — skipping: ${err.message}`);
      return EMPTY;
    }
  }

  // ---- Stage 1c — Appraiser Input Agent (AIA) --------------------------------
  // See ADR-0004. Text-only, no vision, runs independently in parallel with
  // Stage 1a/1b — advisory evidence for Stage 2a, same discipline as Stage 1b:
  // best-effort, never fails the pipeline, never treated as confirmed fact.

  protected async runStage1cAppraiserInput(notes: {
    inscribedMarksNotes?: string;
    provenanceNotes?: string;
    conditionNotes?: string;
    catalogueNotes?: string;
  }): Promise<AppraiserInputResult> {
    const EMPTY: AppraiserInputResult = {
      schemaVersion: "AIA-1.0",
      inputReceived: { inscribedMarksNotes: false, provenanceNotes: false, conditionNotes: false, catalogueNotes: false },
      claimedAttribution: { artist: null, title: null, period: null, technique: null, status: "absent", sourceField: null, sourceExcerpt: null },
      inscriptionClaims: { signatureClaim: null, editionClaim: null, editionSizeClaim: null, monogramOrStampClaim: null, status: "absent" },
      provenanceChain: [],
      conditionClaims: [],
      catalogueReferences: [],
      literatureOrExhibitionClaims: [],
      dimensionsClaim: null,
      paperOrSupport: null,
      rawNotes: {
        inscribedMarksNotes: notes.inscribedMarksNotes || null,
        provenanceNotes: notes.provenanceNotes || null,
        conditionNotes: notes.conditionNotes || null,
        catalogueNotes: notes.catalogueNotes || null,
      },
      overallExtractionConfidence: 0,
      lowConfidenceFlags: [],
    };

    const { inscribedMarksNotes, provenanceNotes, conditionNotes, catalogueNotes } = notes;
    const hasAnyNotes = !!(
      inscribedMarksNotes?.trim() || provenanceNotes?.trim() || conditionNotes?.trim() || catalogueNotes?.trim()
    );
    if (!hasAnyNotes) {
      return EMPTY; // nothing to extract — skip the call entirely, no cost for an empty submission
    }

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      console.warn("[Stage 1c] ANTHROPIC_API_KEY not set — skipping appraiser input extraction.");
      return EMPTY;
    }

    const t = Date.now();
    console.log("[Timing] Stage 1c (Appraiser Input Agent) starting");

    // Deterministic regex pass — cheap, reused from benchmark/src/roseberys/parse.ts
    // (see src/shared/text_extraction.ts). Passed to the LLM as hints, not as
    // ground truth it must repeat unquestioned — see the AIA-1.0 prompt.
    const regexDimensions = parseDimensions([inscribedMarksNotes || "", catalogueNotes || ""]);
    const regexCatalogueRefs = extractCatalogueRefs(catalogueNotes || "");
    const regexEditionSize = detectEditionSize(inscribedMarksNotes || "");

    const regexHintsBlock = `REGEX_HINTS:
- Dimensions found: ${regexDimensions.length ? JSON.stringify(regexDimensions[0]) : "none"}
- Catalogue references found: ${regexCatalogueRefs.length ? regexCatalogueRefs.join(", ") : "none"}
- Edition size found: ${regexEditionSize ?? "none"}`;

    const userMessage = `${regexHintsBlock}

INSCRIBED_MARKS_NOTES: ${inscribedMarksNotes?.trim() || "(not provided)"}

PROVENANCE_NOTES: ${provenanceNotes?.trim() || "(not provided)"}

CONDITION_NOTES: ${conditionNotes?.trim() || "(not provided)"}

CATALOGUE_NOTES: ${catalogueNotes?.trim() || "(not provided)"}`;

    try {
      const result = await this.callClaude(
        STAGE1C_MODEL,
        APPRAISER_INPUT_SYSTEM_PROMPT,
        [{ type: "text", text: userMessage }],
        "report_appraiser_input_extraction",
        "Report the structured extraction of the appraiser's free-text notes.",
        APPRAISER_INPUT_SCHEMA
      );
      console.log(`[Timing] Stage 1c done — ${((Date.now() - t) / 1000).toFixed(1)}s`);
      return result as AppraiserInputResult;
    } catch (err: any) {
      console.warn(`[Stage 1c] Extraction failed — skipping: ${err.message}`);
      return EMPTY;
    }
  }

  // ---- Helpers ---------------------------------------------------------------

  protected projectVeaForAttribution(vea: VisualExtractionResult) {
    return {
      signatures: vea.signatures,
      titleInscriptions: vea.titleInscriptions,
      editionInfo: vea.editionInfo,
      printingTechniques: vea.printingTechniques,
      plateMark: {
        present: vea.plateMark?.present,
        clarity: vea.plateMark?.clarity,
        observationNotes: vea.plateMark?.observationNotes,
        plateMarkConfidence: vea.plateMark?.plateMarkConfidence,
      },
      composition: vea.composition,
      inkAndColour: {
        coloursPresent: vea.inkAndColour?.coloursPresent,
        colourMode: vea.inkAndColour?.colourMode,
        inkAndColourConfidence: vea.inkAndColour?.inkAndColourConfidence,
      },
      paper: {
        surfaceType: vea.paper?.surfaceType,
        watermarkVisible: vea.paper?.watermarkVisible,
        watermarkDescription: vea.paper?.watermarkDescription,
        paperConfidence: vea.paper?.paperConfidence,
      },
      dimensions: {
        sourceImage: vea.dimensions?.sourceImage,
        printedImageMM: vea.dimensions?.printedImageMM,
        fullSheetMM: vea.dimensions?.fullSheetMM,
        dimensionsConfidence: vea.dimensions?.dimensionsConfidence,
      },
      stampsAndLabels: vea.stampsAndLabels,
      overallExtractionConfidence: vea.overallExtractionConfidence,
      lowConfidenceFlags: vea.lowConfidenceFlags,
    };
  }

  // ---- Stage methods --------------------------------------------------------

  protected async runStage1VEA(
    input: AppraisalInput,
    stage1Model: string,
    ai: GoogleGenAI
  ): Promise<VisualExtractionResult> {
    const includeAux = this.config.includeAuxiliaryScans;
    const currency = input.currency || "USD";
    const systemPrompt = "You are a specialist Fine Art Print Visual Extraction Agent.";
    // No userNotes here, deliberately: VEA is vision-only and must not see
    // unverified human claims (see ADR-0004) — appraiser notes go to Stage 1c
    // instead. VISUAL_EXTRACTION_SYSTEM_PROMPT has no {userNotes} placeholder
    // to begin with, so this was already inert; omitted now for clarity.
    const textPrompt = resolveCustomPrompt(
      VISUAL_EXTRACTION_SYSTEM_PROMPT, currency, undefined,
      includeAux ? (input.supplementaryImages || []).map((i) => i.caption) : []
    );

    if (isClaude(stage1Model)) {
      const blocks = buildClaudeImageBlocks(input, includeAux);
      blocks.push({ type: "text", text: textPrompt });
      return this.callClaude(stage1Model, systemPrompt, blocks, "report_visual_extraction", "Report the structured visual extraction findings.", VISUAL_EXTRACTION_SCHEMA);
    } else {
      const parts = buildGeminiImageParts(input, includeAux);
      parts.push({ text: textPrompt });
      return this.callGemini(ai, stage1Model, systemPrompt, parts, VISUAL_EXTRACTION_SCHEMA, 0.1);
    }
  }

  protected buildHaltReport(vea: VisualExtractionResult, currency: string): PrintAnalysisReport {
    const sym = getCurrencySymbol(currency);
    const haltReason = vea.imageAuthenticity.haltReason || "Digital/printed reproduction detected.";
    return {
      likelyArtist: "Unknown Printmaker",
      artistConfidence: 0,
      artworkTitle: "[Reproduction Poster / Print Page Scan]",
      titleConfidence: 0,
      creationPeriod: "Modern",
      techniques: [],
      auctionEstimate: {
        lowEstimate: 0, highEstimate: 0, currency,
        formattedEstimate: `${sym}0 - ${sym}0 ${currency}`,
        valuationContext: `Appraisal halted: ${haltReason}`,
      },
      conditionNotes: {
        overallGrade: "Poor",
        issuesDetected: vea.imageAuthenticity.reproductionIndicatorsFound?.map(i => i.description) || ["Reproduction detected"],
        signatureStatus: "N/A",
        mattingAndMargins: "N/A",
        analysisDetails: `Halted: ${haltReason}`,
      },
      visualDescription: "Visual analysis halted due to digital reproduction detection.",
      historicalContext: "N/A",
      nextSteps: ["Verify the physical object scans instead of catalogue screenshots or bookplate pages."],
      isLikelyReproductionOrPoster: true,
      reproductionExplanation: haltReason,
      recentAuctionSales: [],
      visualEvidenceHighlights: vea.visualEvidenceHighlights || [],
      stage1Result: vea,
    };
  }

  /**
   * The shared Stage 2a input context — VEA projection + the Stage 1c and Stage 1b
   * hand-off blocks. Used by runStage2aTriage (ADR-0010's Attribution Evidence Agent).
   */
  protected buildStage2aContext(
    vea: VisualExtractionResult,
    userNotes?: string,
    appraiserInput?: AppraiserInputResult,
    visualSearch?: VisualSearchResult
  ): { notesBlock: string; appraiserInputBlock: string; visualSearchBlock: string; veaSlim: any } {
    const notesBlock = userNotes?.trim()
      ? `APPRAISER NOTES (provided by submitting user — treat as high-priority evidence for tradition identification and artist candidates):\n"${userNotes.trim()}"\n\n`
      : "";

    // Stage 1c (Appraiser Input Agent) — structured, trust-tagged claims from
    // the appraiser's notes. See ADR-0004. Additive to notesBlock above (the
    // raw compiled string), not a replacement — this gives Triage the same
    // claims with explicit hypothesis/documented_fact weighting instead of
    // undifferentiated prose.
    const ai1c = appraiserInput;
    const hasStructuredClaims = !!ai1c && (
      ai1c.claimedAttribution.status !== "absent" ||
      ai1c.inscriptionClaims.status !== "absent" ||
      ai1c.provenanceChain.length > 0 ||
      ai1c.conditionClaims.length > 0 ||
      ai1c.catalogueReferences.length > 0 ||
      ai1c.dimensionsClaim !== null ||
      !!ai1c.paperOrSupport
    );
    const editionSizeText = ai1c?.inscriptionClaims.editionSizeClaim != null
      ? `edition of ${ai1c.inscriptionClaims.editionSizeClaim}`
      : null;
    const dimensionsText = ai1c?.dimensionsClaim
      ? `${ai1c.dimensionsClaim.widthCm ?? "?"} x ${ai1c.dimensionsClaim.heightCm ?? "?"} cm (${ai1c.dimensionsClaim.kind ?? "unspecified"}) [source: ${ai1c.dimensionsClaim.source}]`
      : "None stated";
    const appraiserInputBlock = hasStructuredClaims && ai1c
      ? `\n\nSTAGE 1c APPRAISER INPUT AGENT — structured extraction of the appraiser's free-text notes. Each claim is tagged "hypothesis" (unverified assertion) or "documented_fact" (the note references supporting paperwork, not independently verified). Weigh documented_fact above hypothesis, and hypothesis no higher than VEA's own physical evidence — never silently prefer a claim over contradicting VEA observation:
  Claimed attribution  : ${ai1c.claimedAttribution.status !== "absent" ? `${ai1c.claimedAttribution.artist || "artist unstated"} — "${ai1c.claimedAttribution.title || "title unstated"}" (${ai1c.claimedAttribution.period || "period unstated"}, ${ai1c.claimedAttribution.technique || "technique unstated"}) [${ai1c.claimedAttribution.status}]` : "None stated"}
  Inscription claims   : ${ai1c.inscriptionClaims.status !== "absent" ? `${[ai1c.inscriptionClaims.signatureClaim, ai1c.inscriptionClaims.editionClaim, editionSizeText, ai1c.inscriptionClaims.monogramOrStampClaim].filter(Boolean).join("; ") || "stated but unspecific"} [${ai1c.inscriptionClaims.status}]` : "None stated"}
  Provenance chain     : ${ai1c.provenanceChain.length ? ai1c.provenanceChain.map(p => `${p.ownerOrEntity}${p.dateOrPeriod ? ` (${p.dateOrPeriod})` : ""} [${p.status}]`).join("; ") : "None stated"}
  Condition claims     : ${ai1c.conditionClaims.length ? ai1c.conditionClaims.map(c => `${c.claim} [${c.status}]`).join("; ") : "None stated"}
  Catalogue references : ${ai1c.catalogueReferences.length ? ai1c.catalogueReferences.map(c => c.ref).join(", ") : "None stated"}
  Dimensions           : ${dimensionsText}
  Paper / support      : ${ai1c.paperOrSupport || "None stated"}

INSTRUCTION: If any claim above conflicts with VEA's physical observations, record the conflict explicitly (e.g. in traditionNotes or a risk flag) rather than picking one silently.\n`
      : "";

    // Stage 1b (Visual Search) — see docs/adr/0003 item 2. Previously reached only
    // Stage 2b; now also available here so a strong reverse-image hit can influence
    // routing/candidates rather than surfacing only after a specialist config is
    // already picked. Same hypothesis-warning framing Stage 2b already uses below.
    const vs = visualSearch;
    const hasMatch = vs?.bestMatchArtist || vs?.bestMatchTitle;
    const hasPages = vs && (vs.webEntities.length > 0 || vs.pagesWithMatchingImages.length > 0);
    const visualSearchBlock = (hasMatch || hasPages)
      ? `\n\n${vs?.hypothesisWarning || ""}

STAGE 1b VISUAL SEARCH RESULT (Gemini ${this.config.stage1bModel || DEFAULT_STAGE1B_MODEL} reverse image search):
  Best match artist : ${vs?.bestMatchArtist || "No match found"}
  Best match title  : ${vs?.bestMatchTitle || "No match found"}
  Composition match : ${vs?.compositionMatch || "n/a"} (search step's own read of how close the retrieved reference image is)
  Confidence        : ${vs?.matchConfidence || "N/A"}
  Evidence basis    : ${vs?.evidenceBasis || "unspecified"} (visual = a reference image of the work was retrieved and scored; textual = only a name/title, no image scored; none = no match)
  Visual similarity : ${vs?.visualSimilarityScore != null ? `${(vs.visualSimilarityScore * 100).toFixed(0)}% — ${vs.visualSimilarityRationale}` : (vs?.visualSimilarityRationale || "Not scored (no reference image retrieved)")}

INSTRUCTION: Weigh this as evidence for your candidate shortlist and evidenceCorroboration, never as confirmed attribution. A visual-basis match with similarity >= 0.7 that agrees with VEA signature/technique evidence is corroboration; any disagreement with VEA's physical evidence must be recorded in evidenceCorroboration.conflicts, not silently resolved. A "textual" basis (a name with no scored image) is an unverified hypothesis only — do not let it drive a candidate above a low probability on its own.\n`
      : "";

    const veaSlim = this.projectVeaForAttribution(vea);
    return { notesBlock, appraiserInputBlock, visualSearchBlock, veaSlim };
  }

  /**
   * Stage 2a — Attribution Evidence Agent (ADR-0010 Decision 9.2; sole implementation as
   * of ADR-0014). One Claude call (query_ackg tool loop) fills the observation cells; the
   * deterministic two-pass tree (src/appraisal/two_pass_attribution.ts) evaluates them; the
   * result is assembled back into the legacy TriageResult shape (+ the Decision 7
   * artistAttribution / workIdentification / impressionAssessment fields) so Stage 2b and
   * the renderer are unchanged. Claude only (needs the query_ackg tool loop) — see
   * ADR-0014 for why a Gemini equivalent was not built and gemini-4stage was retired
   * rather than left pointed at a mode it cannot run.
   */
  protected async runStage2aTriage(
    vea: VisualExtractionResult,
    stage2aModel: string,
    userNotes?: string,
    appraiserInput?: AppraiserInputResult,
    visualSearch?: VisualSearchResult,
    stage1d?: Stage1dResult
  ): Promise<TriageResult> {
    if (vea.imageAuthenticity?.haltRecommended) {
      // VEA already halted — no original work to attribute. Skip the call; run the tree
      // on an empty evidence set (classifyTwoPass short-circuits on veaHaltRecommended).
      const empty = emptyEvidenceOutput(vea.overallExtractionConfidence ?? 0);
      const { triage, twoPass } = runEvidenceTree(empty, true, stage1d);
      console.log(`[Stage 2a evidence] VEA haltRecommended — tree not run; Scenario ${twoPass.scenario} (${twoPass.scenarioName})`);
      return triage;
    }

    const { notesBlock, appraiserInputBlock, visualSearchBlock, veaSlim } =
      this.buildStage2aContext(vea, userNotes, appraiserInput, visualSearch);
    const evidenceTool = {
      name: "report_attribution_evidence",
      description: "Report the observed attribution evidence cells (no verdicts, no routing).",
      schema: ATTRIBUTION_EVIDENCE_SCHEMA,
    };
    const buildUserText = (slim: unknown) =>
      `${notesBlock}Here is the structured Visual Extraction output from Stage 1. Observe the evidence and fill the report_attribution_evidence cells — do not adjudicate.\n\n${JSON.stringify(slim, null, 2)}${appraiserInputBlock}${visualSearchBlock}`;
    const evidenceOpts = { extraTools: [MultiStageAppraiser.QUERY_ACKG_WORK_TOOL], maxRounds: 5 };

    let ev: EvidenceAgentOutput;
    try {
      ev = (await this.callClaudeWithAckgTool(
        stage2aModel, ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT, buildUserText(veaSlim), 8192, evidenceTool, evidenceOpts,
      )) as EvidenceAgentOutput;
    } catch (err) {
      if (!(err instanceof AnthropicContentFilterError)) throw err;
      // Content filter tripped — most often on lurid free-text prose the model echoes back
      // (surrealist / figurative descriptions). Retry once with VEA's long prose fields
      // trimmed to their factual core; if it still fails, degrade to escalate rather than
      // crash the lot.
      console.warn(`[Stage 2a evidence] content-filtered — retrying with VEA prose trimmed`);
      try {
        ev = (await this.callClaudeWithAckgTool(
          stage2aModel, ATTRIBUTION_EVIDENCE_SYSTEM_PROMPT, buildUserText(trimVeaProse(veaSlim)), 8192, evidenceTool, evidenceOpts,
        )) as EvidenceAgentOutput;
      } catch (err2) {
        if (!(err2 instanceof AnthropicContentFilterError)) throw err2;
        console.warn(`[Stage 2a evidence] still content-filtered — emitting escalate-only result`);
        const degraded = emptyEvidenceOutput(vea.overallExtractionConfidence ?? 0, {
          reason: "Stage 2a evidence agent output blocked by content filtering on both attempts — needs manual triage.",
          narrative: "The evidence agent could not complete: its output was blocked by content-filtering policy twice. No automated attribution was produced; route to a human.",
        });
        return runEvidenceTree(degraded, false, stage1d).triage;
      }
    }

    const { triage, twoPass } = runEvidenceTree(ev, false, stage1d);
    const rd = triage.routingDecision;
    console.log(
      `[Stage 2a evidence] artist=${twoPass.artistAttribution.evidenceBasis} ${twoPass.artistAttribution.verdict}/${twoPass.artistAttribution.confidence ?? "-"} "${twoPass.artistAttribution.artistName ?? "-"}"` +
        ` | work=${twoPass.workIdentification ? `${twoPass.workIdentification.evidenceBasis} ${twoPass.workIdentification.verdict}/${twoPass.workIdentification.confidence ?? "-"}` : "(pass 2 not run)"}` +
        ` | impression=${twoPass.impressionAssessment?.divergence ?? "n/a"}`,
    );
    console.log(`[Stage 2a evidence] routing: Scenario ${rd.scenario} (${rd.scenarioName}) specialistConfig=${rd.specialistConfig}`);
    console.log(`[Stage 2a evidence] tree trace: ${twoPass.ruleTrace.join(" | ")}`);
    return triage;
  }

  protected async runStage2bSpecialist(
    vea: VisualExtractionResult,
    triage: TriageResult,
    stage2bModel: string,
    ai: GoogleGenAI,
    userNotes?: string,
    visualSearch?: VisualSearchResult
  ): Promise<AttributionResearchResult> {
    const specialistConfigKey = triage.routingDecision?.specialistConfig || "general_print_fallback";
    const specialistConfig = loadSpecialistConfig(specialistConfigKey);
    // ADR-0006: scenario (and its task profile) was decided deterministically in
    // runStage2aTriage — default to LowSignalEverywhere only for pre-ADR-0006 stored
    // triage results that predate the scenario field existing.
    const scenario = (triage.routingDecision?.scenario ?? Scenario.LowSignalEverywhere) as Scenario;
    const asaSystemPrompt = injectTaskProfile(
      injectSpecialistConfig(ATTRIBUTION_RESEARCH_SYSTEM_PROMPT, specialistConfig),
      scenario
    );
    const notesBlock = userNotes?.trim()
      ? `APPRAISER NOTES (provided by submitting user — treat as high-priority evidence for attribution and title identification):\n"${userNotes.trim()}"\n\n`
      : "";
    const veaSlim = this.projectVeaForAttribution(vea);

    const vs = visualSearch;
    const hasMatch = vs?.bestMatchArtist || vs?.bestMatchTitle;
    const hasPages = vs && (vs.webEntities.length > 0 || vs.pagesWithMatchingImages.length > 0);
    const visualSearchBlock = (hasMatch || hasPages)
      ? `\n\n${vs?.hypothesisWarning || ""}

STAGE 1b VISUAL SEARCH RESULT (Gemini ${this.config.stage1bModel || DEFAULT_STAGE1B_MODEL} reverse image search):
  Best match artist : ${vs?.bestMatchArtist || "No match found"}
  Best match title  : ${vs?.bestMatchTitle || "No match found"}
  Composition match : ${vs?.compositionMatch || "n/a"}
  Confidence        : ${vs?.matchConfidence || "N/A"}
  Evidence basis    : ${vs?.evidenceBasis || "unspecified"} (visual = a reference image of the work was retrieved and scored; textual = only a name/title, no image scored; none = no match)
  Visual similarity : ${vs?.visualSimilarityScore != null ? `${(vs.visualSimilarityScore * 100).toFixed(0)}% — ${vs.visualSimilarityRationale}` : (vs?.visualSimilarityRationale || "Not scored (no reference image retrieved)")}
  Best image URL    : ${vs?.bestMatchImageUrl || "None"}
  Other pages       : ${vs?.pagesWithMatchingImages?.slice(0, 5).join(", ") || "None"}

INSTRUCTION: Treat the above as a starting hypothesis. Cross-reference against VEA signatures, title inscriptions, and technique before accepting. If the visual similarity score is below 0.6, confidence is LOW, or evidence basis is "textual" or "none" (i.e. not genuinely confirmed against a reference image), treat with high scepticism — a "textual" basis means this is someone else's unverified written claim, not an independent visual match.\n`
      : "";

    const userText = `${notesBlock}TRIAGE OUTPUT (Stage 2a):\n${JSON.stringify(triage, null, 2)}\n\nVISUAL EXTRACTION OUTPUT (Stage 1):\n${JSON.stringify(veaSlim, null, 2)}${visualSearchBlock}\n\nConduct specialist attribution research per the injected specialist config and the triage routing above.`;

    console.log(`[4-Stage] Stage 2b model: "${stage2bModel}", isClaude=${isClaude(stage2bModel)}`);
    if (isClaude(stage2bModel)) {
      return this.callClaudeWithWebSearch(stage2bModel, asaSystemPrompt, userText, 8192);
    } else {
      return this.callGemini(ai, stage2bModel, asaSystemPrompt, [{ text: userText }], SPECIALIST_ATTRIBUTION_SCHEMA, this.config.temperature || 0.15, true);
    }
  }

  // NOTE (ADR-0006): this legacy 3-stage path uses resolveCustomPrompt, not
  // injectSpecialistConfig/injectTaskProfile — it already left an unresolved
  // "[SPECIALIST_CONFIG]" literal in ATTRIBUTION_RESEARCH_SYSTEM_PROMPT (a pre-existing,
  // separately-scoped bug), and now also carries an unresolved "[TASK_PROFILE]" literal for
  // the same reason. Deliberately left untouched — ADR-0006 and this session's routing work
  // is scoped to the 4-stage pipeline (runStage2aTriage/runStage2bSpecialist) only.
  protected async runStage2Attribution(
    vea: VisualExtractionResult,
    stage2Model: string,
    ai: GoogleGenAI,
    currency: string,
    userNotes?: string
  ): Promise<AttributionResearchResult> {
    const systemInstruction = resolveCustomPrompt(ATTRIBUTION_RESEARCH_SYSTEM_PROMPT, currency, userNotes);
    const userText = `Here is the JSON payload containing the raw Visual Extraction observations:\n\n${JSON.stringify(vea, null, 2)}`;
    if (isClaude(stage2Model)) {
      return this.callClaude(stage2Model, systemInstruction, [{ type: "text", text: userText }], "report_attribution_research", "Report the structured print attribution and market research findings.", ATTRIBUTION_RESEARCH_SCHEMA);
    } else {
      return this.callGemini(ai, stage2Model, systemInstruction, [{ text: userText }], ATTRIBUTION_RESEARCH_SCHEMA, this.config.temperature || 0.15, true);
    }
  }

  protected async runStage3Valuation(
    vea: VisualExtractionResult,
    attr: AttributionResearchResult,
    stage3Model: string,
    ai: GoogleGenAI,
    currency: string,
    userNotes?: string,
    testingExcludeSourceListing?: string
  ): Promise<Partial<PrintAnalysisReport>> {
    const systemInstruction = resolveCustomPrompt(VALUATION_REPORT_SYSTEM_PROMPT, currency, userNotes);
    const auctionComps = (attr as any).auctionComps;
    const compsNote = Array.isArray(auctionComps) && auctionComps.length > 0
      ? `\n\nAUCTION COMPS (collected during Stage 2b research — use these for valuation):\n${JSON.stringify(auctionComps, null, 2)}`
      : "\n\nAUCTION COMPS: None found during Stage 2b research — base valuation on condition and rarity factors alone.";
    // Backtest/eval-harness only — see AppraisalInput.testingExcludeSourceListing.
    // Stage 2b's web search can surface the exact listing this input's image/
    // description came from; using its own estimate or hammer price as a "comp"
    // would make the valuation circular, not independent, so this asks Stage 3 to
    // actively recognise and discard it rather than filtering comps mechanically
    // (Stage 2b's auctionComps are free-text research findings, not a structured
    // field reliably matchable by URL/id).
    const excludeSourceNote = testingExcludeSourceListing
      ? `\n\n⚠️ TESTING MODE — SOURCE LISTING EXCLUDED: This artwork's image and description were sourced directly from this auction listing: ${testingExcludeSourceListing}. If any entry in AUCTION COMPS above is that same listing (same auction house, matching sale/lot, or described as "the subject work" / "the identical work" / "the present lot"), you MUST exclude its estimate and price data from your valuation entirely — do not anchor on it, average it in, or cite it as a reason for your number. Value this work using only genuinely independent comps and evidence. If excluding it leaves no usable comps, say so explicitly in valuationContext and value from first principles as you would with zero comps.`
      : "";
    const userText = `Synthesise a valuation for the following print from Stage 1 and Stage 2b findings.\n\nSTAGE 1 VISUAL EXTRACTION (condition, technique, dimensions, paper):\n${JSON.stringify(vea, null, 2)}\n\nSTAGE 2b ATTRIBUTION RESEARCH (artist, edition, catalogue raisonné, rarity/discount factors, forgery risk):\n${JSON.stringify(attr, null, 2)}${compsNote}${excludeSourceNote}\n\n⚠️ CRITICAL: Output ONLY the valuation fields — auctionEstimate, recentAuctionSales, nextSteps, editionSizeAndPrintNumber, isLikelyReproductionOrPoster, reproductionExplanation. Do NOT search the web. Do NOT re-describe the artwork. Start your response with { and end with }.`;
    if (isClaude(stage3Model)) {
      console.log(`[4-Stage] Stage 3 pure reasoning (no web search) — model: ${stage3Model}`);
      return this.callClaude(stage3Model, systemInstruction, [{ type: "text", text: userText }], "report_valuation", "Report the structured print valuation synthesised from Stage 1 condition and Stage 2b findings.", STAGE3_VALUATION_ONLY_SCHEMA);
    } else {
      return this.callGemini(ai, stage3Model, systemInstruction, [{ text: userText }], STAGE3_VALUATION_ONLY_SCHEMA, this.config.temperature || 0.15, true);
    }
  }

  abstract appraise(input: AppraisalInput): Promise<PrintAnalysisReport>;

  // ---- Shared report assembly -----------------------------------------------

  protected assembleReport(
    vea: VisualExtractionResult,
    attr: AttributionResearchResult,
    valuation: Partial<PrintAnalysisReport>,
    currency: string
  ): PrintAnalysisReport {
    // Repair auctionEstimate — models sometimes return a raw string instead of an object
    if (typeof (valuation as any).auctionEstimate === "string") {
      const raw: string = (valuation as any).auctionEstimate;
      // Try JSON parse first (stringified object)
      let parsed = false;
      try { (valuation as any).auctionEstimate = JSON.parse(raw); parsed = true; } catch {}
      if (!parsed) {
        // Only extract numbers if the string looks like a simple price range e.g. "£400–£800"
        // For longer prose strings (explanations, caveats), store as valuationContext with no estimate
        const isSimpleRange = /^[\$£€]?\s*[\d,]+\s*[-–—to]+\s*[\$£€]?\s*[\d,]+/.test(raw.trim());
        const cur = raw.includes("£") ? "GBP" : raw.includes("€") ? "EUR" : "USD";
        if (isSimpleRange) {
          const nums = raw.match(/[\d,]+/g)?.map(n => parseInt(n.replace(/,/g, ""), 10)).filter(Boolean) || [];
          (valuation as any).auctionEstimate = {
            lowEstimate: nums[0] || 0,
            highEstimate: nums[1] || nums[0] || 0,
            currency: cur,
            formattedEstimate: raw,
            valuationContext: "",
          };
        } else {
          // Prose explanation — preserve as valuationContext, no numeric estimate
          (valuation as any).auctionEstimate = {
            lowEstimate: 0,
            highEstimate: 0,
            currency: cur,
            formattedEstimate: "Insufficient data",
            valuationContext: raw,
          };
        }
      }
    }
    const est = (valuation as any).auctionEstimate;
    if (est && typeof est === "object") {
      const toInt = (v: any) => typeof v === "string" ? parseInt(v.replace(/[^0-9]/g, ""), 10) || 0 : (v || 0);
      est.lowEstimate = toInt(est.lowEstimate);
      est.highEstimate = toInt(est.highEstimate);
    }

    const asa = attr as any;
    const likelyArtist = asa.attributionConclusion?.attributedArtist || asa.likelyArtist || "Unknown Printmaker";
    const artistConfidence = Math.round((asa.attributionConclusion?.attributionConfidence ?? (asa.artistConfidence ?? 0)) * (asa.attributionConclusion ? 100 : 1));
    const artworkTitle = asa.attributionConclusion?.workTitle || asa.artworkTitle || "[Untitled]";
    const titleConfidence = asa.titleConfidence ?? 50;
    const creationPeriod = asa.attributionConclusion?.dateOrPeriod || asa.creationPeriod || "Unknown";

    const technique = asa.attributionConclusion?.technique || vea.printingTechniques?.[0]?.technique || "Unknown";
    const techniqueConfidence = vea.printingTechniques?.[0]?.techniqueConfidence ?? 50;
    const techniques = [{
      technique,
      confidence: techniqueConfidence,
      evidenceIdentified: vea.printingTechniques?.[0]?.visualEvidence || [],
      description: `${technique} identified from visual extraction.`,
    }];

    const conditionNotes = {
      overallGrade: (vea.condition?.overallGrade as any) || "Good",
      issuesDetected: vea.condition?.defects?.map((d: any) => `${d.type} (${d.severity})`) || [],
      signatureStatus: vea.signatures?.[0]
        ? `${vea.signatures[0].type} — "${vea.signatures[0].transcription}" (${vea.signatures[0].medium})`
        : "No signature detected",
      mattingAndMargins: vea.plateMark?.observationNotes || "",
      analysisDetails: vea.condition?.restorationNotes || `Overall condition: ${vea.condition?.overallGrade || "N/A"}.`,
    };

    const visualDescription = [
      vea.composition?.subjectMatter,
      vea.composition?.visualStyle,
      vea.inkAndColour?.coloursPresent?.length ? `Colours: ${vea.inkAndColour.coloursPresent.join(", ")}.` : null,
    ].filter(Boolean).join(" ") || "Visual description not available.";

    const historicalContext = asa.attributionConclusion
      ? `${likelyArtist} — ${creationPeriod}. ${asa.attributionConclusion.attributionEvidenceChain?.join(" ") || ""}`
      : asa.historicalContext || "";

    const signatureAnalysis = vea.signatures?.map((s: any) =>
      `${s.type}: "${s.transcription}" — ${s.authenticityNotes}`
    ).join(". ") || "No signature scan provided.";

    const damageAnalysis = vea.condition?.defects?.map((d: any) =>
      `${d.category} / ${d.type} — ${d.severity}${d.affectsImageArea ? " (affects image area)" : ""}`
    ).join(". ") || "No significant damage detected.";

    const hasScaledDims = vea.dimensions?.sourceImage === "supplementary_scale_photo"
      && (vea.dimensions?.printedImageMM?.width || vea.dimensions?.fullSheetMM?.width);
    const inferredDimensions = hasScaledDims
      ? `Plate: ${vea.dimensions?.printedImageMM?.width ?? "?"}×${vea.dimensions?.printedImageMM?.height ?? "?"}mm, Sheet: ${vea.dimensions?.fullSheetMM?.width ?? "?"}×${vea.dimensions?.fullSheetMM?.height ?? "?"}mm`
      : "Dimensions not available — no scale reference in the images.";

    const editionRaw = (valuation as any).editionSizeAndPrintNumber;

    return {
      likelyArtist,
      artistConfidence,
      artworkTitle,
      titleConfidence,
      creationPeriod,
      techniques,
      auctionEstimate: (valuation as any).auctionEstimate || { lowEstimate: 0, highEstimate: 0, currency, formattedEstimate: "Speculative", valuationContext: "" },
      conditionNotes,
      visualDescription,
      historicalContext,
      nextSteps: (valuation as any).nextSteps || [],
      isLikelyReproductionOrPoster: (valuation as any).isLikelyReproductionOrPoster ?? false,
      reproductionExplanation: (valuation as any).reproductionExplanation || "",
      recentAuctionSales: (valuation as any).recentAuctionSales || [],
      inferredDimensions,
      signatureAnalysis,
      damageAnalysis,
      editionSizeAndPrintNumber: editionRaw && typeof editionRaw === "object"
        ? Object.values(editionRaw).filter(Boolean).join(", ")
        : (editionRaw || ""),
      visualEvidenceHighlights: vea.visualEvidenceHighlights || [],
    };
  }
}

// ---------------------------------------------------------------------------
// ThreeStageAppraiser — VEA → Attribution Research → Valuation
// ---------------------------------------------------------------------------

export class ThreeStageAppraiser extends MultiStageAppraiser {
  public async appraise(input: AppraisalInput): Promise<PrintAnalysisReport> {
    const ai = this.getClient();
    const currency = input.currency || "USD";
    const defaultModel = this.config.modelName;
    const stage1Model = this.config.stage1Model || defaultModel;
    const stage2Model = this.config.stage2Model || defaultModel;
    const stage3Model = this.config.stage3Model || defaultModel;

    const t0 = Date.now();
    console.log(`[Timing] Stage 1 (VEA) starting — model: ${stage1Model}`);
    const vea = await this.runStage1VEA(input, stage1Model, ai);
    console.log(`[Timing] Stage 1 (VEA) done — ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (vea.imageAuthenticity?.haltRecommended) {
      return this.buildHaltReport(vea, currency);
    }

    const t2 = Date.now();
    console.log(`[Timing] Stage 2 (Attribution) starting — model: ${stage2Model}`);
    const attr = await this.runStage2Attribution(vea, stage2Model, ai, currency, input.userNotes);
    console.log(`[Timing] Stage 2 (Attribution) done — ${((Date.now() - t2) / 1000).toFixed(1)}s`);

    const t3 = Date.now();
    console.log(`[Timing] Stage 3 (Valuation) starting — model: ${stage3Model}`);
    const valuation = await this.runStage3Valuation(vea, attr, stage3Model, ai, currency, input.userNotes, input.testingExcludeSourceListing);
    console.log(`[Timing] Stage 3 (Valuation) done — ${((Date.now() - t3) / 1000).toFixed(1)}s`);
    console.log(`[Timing] Total pipeline — ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const report = this.assembleReport(vea, attr, valuation, currency);
    report.stage1Result = vea;
    report.stage2Result = attr;
    report.modelUsed = `3-Stage [S1: ${stage1Model} | S2: ${stage2Model} | S3: ${stage3Model}]`;
    report.promptVersion = "3stage";
    return report;
  }
}

// ---------------------------------------------------------------------------
// FourStageAppraiser — VEA (+ optional Visual Search) → Triage → Specialist → Valuation
// ---------------------------------------------------------------------------

export class FourStageAppraiser extends MultiStageAppraiser {
  public async appraise(input: AppraisalInput): Promise<PrintAnalysisReport> {
    const ai = this.getClient();
    const currency = input.currency || "USD";
    const defaultModel = this.config.modelName;
    const stage1Model = this.config.stage1Model || defaultModel;
    const stage2aModel = this.config.stage2aModel!;
    const stage2bModel = this.config.stage2bModel || stage2aModel;
    const stage3Model = this.config.stage3Model || defaultModel;
    const runVisualSearch = this.config.enableVisualSearch !== false;
    const runEmbeddingMatch = this.config.enableEmbeddingMatch !== false;

    const emit = input.onProgress ?? (() => {});
    const t0 = Date.now();

    // Stage 1b (Visual Search), Stage 1c (Appraiser Input Agent), and Stage 1d
    // (image-embedding match) all have zero dependency on VEA — 1b/1d only need
    // the primary image, 1c only needs the appraiser's text — so all three
    // launch immediately, fully concurrent with Stage 1a rather than waiting
    // for VEA to finish first. (Stage 2a still needs VEA's output, so that one
    // genuinely can't start yet.) None of these three promises can reject —
    // each wraps its own errors internally and resolves to an empty/default
    // result — so no unhandled-rejection risk from starting them before
    // anything awaits them.
    emit({ stage: "stage1b", status: "start", message: "Searching global image databases for visual matches…", percent: 5 });
    const visualSearchPromise = runVisualSearch
      ? this.runStage1bVisionSearch(input.imageBase64, input.mimeType)
      : Promise.resolve(undefined);

    // ADR-0013 + 2026-09-06 voting amendment: this result is attached to the report for
    // visibility AND fed into runStage2aTriage as evidence source D (a HIGH-confidence
    // match votes; MEDIUM/LOW is a "don't know" — see two_pass_attribution.ts). Still
    // never passed into runStage2bSpecialist — the specialist prompt is unchanged.
    emit({ stage: "stage1d", status: "start", message: "Matching image embeddings against internal art graph…", percent: 5 });
    const embeddingMatchPromise = runEmbeddingMatch
      ? this.runStage1dEmbeddingMatch(input.imageBase64, input.mimeType)
      : Promise.resolve(undefined);

    emit({ stage: "stage1c", status: "start", message: "Extracting structured claims from appraiser notes…", percent: 5 });
    const appraiserInputPromise = this.runStage1cAppraiserInput({
      inscribedMarksNotes: input.inscribedMarksNotes,
      provenanceNotes: input.provenanceNotes,
      conditionNotes: input.conditionNotes,
      catalogueNotes: input.catalogueNotes,
    });

    emit({ stage: "stage1", status: "start", message: "Extracting visual attributes — medium, technique, condition…", percent: 5 });
    console.log(`[Timing] Stage 1 (VEA) starting — model: ${stage1Model}`);
    const vea = await this.runStage1VEA(input, stage1Model, ai);
    console.log(`[Timing] Stage 1 (VEA) done — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    emit({ stage: "stage1", status: "done", message: "Visual extraction complete", percent: 20 });

    if (vea.imageAuthenticity?.haltRecommended) {
      const halt = this.buildHaltReport(vea, currency);
      halt.stage1cResult = await appraiserInputPromise.catch(() => undefined);
      return halt;
    }

    // Stage 1b and Stage 1c were already launched above. Per docs/adr/0003 item 2,
    // Stage 2a (Triage) now also waits on Stage 1b's visual-search result (not
    // just Stage 1c's appraiser claims) before making its routing decision —
    // this is the ADR's accepted "blocking" tradeoff (Stage 1b's latency now
    // sits on Stage 2a's critical path, rather than 1b and 2a running fully in
    // parallel as before) in exchange for Triage actually being able to weigh a
    // strong reverse-image match instead of it only reaching Stage 2b afterward.
    // 2026-09-06: Stage 2a now also awaits Stage 1d for the same reason — its
    // HIGH-confidence DINOv2 match is evidence source D (two_pass_attribution.ts).
    emit({ stage: "stage2a", status: "start", message: "Triaging attribution complexity and routing to specialist…", percent: 24 });
    const [visualSearch, triageResult, appraiserInput, stage1d] = await Promise.all([
      visualSearchPromise,
      (async () => {
        const [appraiserInputResult, visualSearchResult, stage1dResult] = await Promise.all([
          appraiserInputPromise,
          visualSearchPromise,
          embeddingMatchPromise,
        ]);
        const t2a = Date.now();
        console.log(`[Timing] Stage 2a (Triage) starting — model: ${stage2aModel}`);
        const r = await this.runStage2aTriage(vea, stage2aModel, input.userNotes, appraiserInputResult, visualSearchResult, stage1dResult);
        console.log(`[Timing] Stage 2a (Triage) done — ${((Date.now() - t2a) / 1000).toFixed(1)}s`);
        emit({ stage: "stage2a", status: "done", message: "Triage complete — specialist routing confirmed", percent: 40 });
        return r;
      })(),
      appraiserInputPromise,
      embeddingMatchPromise,
    ]);
    emit({ stage: "stage1b", status: "done", message: "Visual search complete", percent: 42 });
    emit({ stage: "stage1c", status: "done", message: "Appraiser notes extraction complete", percent: 42 });
    emit({ stage: "stage1d", status: "done", message: "Image-embedding match complete", percent: 42 });

    const t2b = Date.now();
    emit({ stage: "stage2b", status: "start", message: "Specialist attribution — cross-referencing catalogues raisonnés and auction archives…", percent: 44 });
    console.log(`[Timing] Stage 2b (Specialist) starting — model: ${stage2bModel}`);
    const attr = await this.runStage2bSpecialist(vea, triageResult, stage2bModel, ai, input.userNotes, visualSearch ?? undefined);
    console.log(`[Timing] Stage 2b (Specialist) done — ${((Date.now() - t2b) / 1000).toFixed(1)}s`);
    emit({ stage: "stage2b", status: "done", message: "Attribution and comparable sales research complete", percent: 80 });

    const t3 = Date.now();
    emit({ stage: "stage3", status: "start", message: "Synthesising auction estimate and appraisal statement…", percent: 82 });
    console.log(`[Timing] Stage 3 (Valuation) starting — model: ${stage3Model}`);
    const valuation = await this.runStage3Valuation(vea, attr, stage3Model, ai, currency, input.userNotes, input.testingExcludeSourceListing);
    console.log(`[Timing] Stage 3 (Valuation) done — ${((Date.now() - t3) / 1000).toFixed(1)}s`);
    console.log(`[Timing] Total pipeline — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    emit({ stage: "stage3", status: "done", message: "Valuation complete — compiling certificate…", percent: 93 });

    const report = this.assembleReport(vea, attr, valuation, currency);
    report.stage1Result = vea;
    report.stage1cResult = appraiserInput;
    report.stage1dResult = stage1d;
    report.stage2Result = attr;
    report.stage2aResult = triageResult;
    const stage1bModel = this.config.stage1bModel || DEFAULT_STAGE1B_MODEL;
    report.modelUsed = `4-Stage [S1: ${stage1Model} | S1b: ${runVisualSearch ? stage1bModel : "skip"} | S1c: ${STAGE1C_MODEL} | S1d: ${runEmbeddingMatch ? "dinov2-large+clip" : "skip"} | S2a: ${stage2aModel} | S2b: ${stage2bModel} | S3: ${stage3Model}]`;
    report.promptVersion = "4stage";
    return report;
  }
}

// ---------------------------------------------------------------------------
// Appraiser configuration registry
// ---------------------------------------------------------------------------

export const appraiserConfigs: AppraisalMethodConfig[] = [
  {
    id: "gemini-standard",
    name: "Gemini Standard",
    description: "Baseline Gemini 3.5 Flash appraisal with academic hedonic repeat-sales pricing rules.",
    modelName: "gemini-3.5-flash",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-pro",
    name: "Gemini Pro (2.5)",
    description: "Higher quality appraisal using Gemini 2.5 Pro for complex printing techniques and inscriptions.",
    modelName: "gemini-2.5-pro",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-pro-latest",
    name: "Gemini Pro (Stable)",
    description: "Stable legacy professional appraisal using Gemini Pro (Stable) for high detail and structured extraction.",
    modelName: "gemini-pro-latest",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Preview)",
    description: "Next-generation professional reasoning model using Gemini 3.1 Pro Preview for maximum detail.",
    modelName: "gemini-3.1-pro-preview",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-creative",
    name: "Gemini Creative",
    description: "Standard model with a higher temperature (0.45) for richer background context and flexible ranges.",
    modelName: "gemini-3.5-flash",
    temperature: 0.45,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-strict",
    name: "Gemini Strict / Skeptic",
    description: "Extremely conservative appraisal model focusing aggressively on condition flaws and reproduction risks.",
    modelName: "gemini-3.5-flash",
    temperature: 0.05,
    promptKey: "strict",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-simplified",
    name: "Gemini Simplified",
    description: "Shorter, straightforward prompt relying on Gemini's general knowledge instead of complex auction guidelines.",
    modelName: "gemini-3.5-flash",
    temperature: 0.15,
    promptKey: "simplified",
    imageQuality: "original",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-low-quality",
    name: "Gemini Low Resolution",
    description: "Appraises using a heavily downsampled image (512px max dimension) to test accuracy with low-resolution inputs.",
    modelName: "gemini-3.5-flash",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "low",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-medium-quality",
    name: "Gemini Medium Resolution",
    description: "Appraises using a medium downsampled image (1024px max dimension) to test accuracy with standard inputs.",
    modelName: "gemini-3.5-flash",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "medium",
    includeAuxiliaryScans: true,
  },
  {
    id: "gemini-no-aux",
    name: "Gemini (No Aux Scans)",
    description: "Ignores any custom signature, damage, or scale closeups, appraising solely on the primary artwork scan.",
    modelName: "gemini-3.5-flash",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: false,
  },
  {
    id: "claude-sonnet",
    name: "Claude Sonnet (4.6)",
    description: "High-accuracy visual appraisals using Anthropic's Claude 4.6 Sonnet.",
    modelName: "claude-sonnet-4-6",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    provider: "anthropic",
  },
  {
    id: "claude-opus",
    name: "Claude Opus (4.8)",
    description: "Frontier reasoning appraisals using Anthropic's flagship Claude 4.8 Opus.",
    modelName: "claude-opus-4-8",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    provider: "anthropic",
  },
  {
    id: "gemini-3stage",
    name: "Gemini 3-Stage Pipeline",
    description: "Advanced 3-Stage appraisal pipeline separating Visual Extraction, Attribution Research, and Valuation.",
    modelName: "gemini-2.5-pro",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    stage1Model: "gemini-2.5-pro",
    stage2Model: "gemini-2.5-pro",
    stage3Model: "gemini-2.5-pro",
  },
  {
    id: "claude-3stage",
    name: "Claude 3-Stage Pipeline",
    description: "Advanced 3-Stage appraisal pipeline separating Visual Extraction, Attribution Research, and Valuation, powered by Anthropic Claude.",
    modelName: "claude-sonnet-4-6",
    temperature: 0.15,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    provider: "anthropic",
    stage1Model: "claude-sonnet-4-6",
    stage2Model: "claude-sonnet-4-6",
    stage3Model: "claude-sonnet-4-6",
  },
  {
    id: "claude-4stage",
    name: "Claude 4-Stage Pipeline (VEA + Evidence Agent + ASA + Valuation)",
    description: "Full 4-stage appraisal: Visual Extraction (Opus), Stage 2a Attribution Evidence Agent (Sonnet, ADR-0010) — one call fills observation cells, the deterministic two-pass tree evaluates them — Specialist Attribution with web search (Sonnet), and Valuation (Sonnet).",
    modelName: "claude-opus-4-8",
    temperature: 0.1,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    provider: "anthropic",
    stage1Model: "claude-opus-4-8",
    stage2aModel: "claude-sonnet-4-6",
    stage2bModel: "claude-sonnet-4-6",
    stage3Model: "claude-sonnet-4-6",
    enableVisualSearch: true,
  },
  {
    id: "claude-4stage-fast",
    name: "Claude 4-Stage Fast (Haiku Evidence Agent)",
    description: "Opus for vision (S1), Haiku for the Stage 2a Evidence Agent (S2a), Sonnet for specialist search (S2b), Haiku for valuation (S3). Faster and cheaper than standard 4-stage.",
    modelName: "claude-opus-4-8",
    temperature: 0.1,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    provider: "anthropic",
    stage1Model: "claude-opus-4-8",
    stage2aModel: "claude-haiku-4-5",
    stage2bModel: "claude-sonnet-4-6",
    stage3Model: "claude-haiku-4-5",
    enableVisualSearch: true,
  },
];

// ---------------------------------------------------------------------------
// Registry and factory
// ---------------------------------------------------------------------------

export const appraiserRegistry: Record<string, AppraisalMethod> = appraiserConfigs.reduce(
  (registry, config) => {
    if (config.stage2aModel) {
      registry[config.id] = new FourStageAppraiser(config);
    } else if (config.stage1Model || config.stage2Model) {
      registry[config.id] = new ThreeStageAppraiser(config);
    } else if (config.provider === "anthropic") {
      registry[config.id] = new ConfigurableClaudeAppraiser(config);
    } else {
      registry[config.id] = new ConfigurableGeminiAppraiser(config);
    }
    return registry;
  },
  {} as Record<string, AppraisalMethod>
);

export function getAppraiser(methodName: string = "gemini-standard", aiClient?: GoogleGenAI): AppraisalMethod {
  const appraiser = appraiserRegistry[methodName];
  if (!appraiser) throw new Error(`Unknown appraisal method: ${methodName}`);
  if (appraiser instanceof FourStageAppraiser) return new FourStageAppraiser(appraiser.config, aiClient);
  if (appraiser instanceof ThreeStageAppraiser) return new ThreeStageAppraiser(appraiser.config, aiClient);
  if (aiClient && !(appraiser instanceof ConfigurableClaudeAppraiser)) {
    return new ConfigurableGeminiAppraiser(appraiser.config, aiClient);
  }
  return appraiser;
}

export function getAppraiserFromConfig(config: AppraisalMethodConfig, aiClient?: GoogleGenAI): AppraisalMethod {
  if (config.stage2aModel) return new FourStageAppraiser(config, aiClient);
  if (config.stage1Model || config.stage2Model) return new ThreeStageAppraiser(config, aiClient);
  if (config.provider === "anthropic") return new ConfigurableClaudeAppraiser(config);
  return new ConfigurableGeminiAppraiser(config, aiClient);
}

// Re-export schemas for consumers that previously imported them from this file
export {
  VISUAL_EXTRACTION_SCHEMA,
  ATTRIBUTION_RESEARCH_SCHEMA,
  FINAL_REPORT_RESPONSE_SCHEMA,
  SPECIALIST_ATTRIBUTION_SCHEMA,
} from "./schemas";
