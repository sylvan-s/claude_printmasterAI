import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import {
  PrintAnalysisReport,
  VisualExtractionResult,
  AttributionResearchResult,
  TriageResult,
} from "../types";
import {
  getPrompt,
  PromptKey,
  resolveCustomPrompt,
  VISUAL_EXTRACTION_SYSTEM_PROMPT,
  ATTRIBUTION_TRIAGE_SYSTEM_PROMPT,
  ATTRIBUTION_RESEARCH_SYSTEM_PROMPT,
  VALUATION_REPORT_SYSTEM_PROMPT,
  injectSpecialistConfig,
} from "./prompts";
import {
  translateSchemaToStandardJsonSchema,
  VISUAL_EXTRACTION_SCHEMA,
  ATTRIBUTION_RESEARCH_SCHEMA,
  TRIAGE_SCHEMA,
  SPECIALIST_ATTRIBUTION_SCHEMA,
  FINAL_REPORT_RESPONSE_SCHEMA,
  FINAL_REPORT_CLAUDE_SCHEMA,
  STAGE3_VALUATION_ONLY_SCHEMA,
} from "./schemas";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { lookupArtistAcrossMuseums, type ArtistLookupResult } from "./reference_lookup/index.js";

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
  matchConfidence?: "HIGH" | "MEDIUM" | "LOW" | null;
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

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 4096,
        system: systemInstruction,
        messages: [{ role: "user", content: contentBlocks }],
        tools: [{ name: toolName, description: toolDescription, input_schema: translateSchemaToStandardJsonSchema(inputSchema) }],
        tool_choice: { type: "tool", name: toolName },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
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

    const post = async (messages: any[], forceFinal: boolean) => {
      const doRequest = () => fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: maxTokens,
          system: systemInstruction,
          messages,
          tools,
          ...(forceFinal ? { tool_choice: { type: "none" } } : {}),
        }),
      });
      let response = await doRequest();
      // Retry once on transient 5xx (e.g. Cloudflare 520)
      if (response.status >= 500) {
        console.warn(`[Claude web-search] Transient ${response.status} — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
        response = await doRequest();
      }
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude web-search API request failed: ${response.status}: ${errorText}`);
      }
      return response.json();
    };

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

  // ---- Stage 1b — Gemini Visual Search ----------------------------------------

  // Uses Google Custom Search API (image search) to retrieve a direct image URL for a
  // known artist + title hypothesis. Falls back gracefully when keys are absent.
  // Fetch a reference thumbnail via the Wikimedia API using artist + title as search terms.
  // Returns base64-encoded image data ready for visual similarity scoring, or null if not found.
  private async fetchReferenceImageViaWikimedia(
    artist: string,
    title: string | null
  ): Promise<{ base64: string; mimeType: string; sourceUrl: string } | null> {
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

      // Prefer Commons (specific work match) over Wikipedia artist page
      const finalUrl = commonsThumbUrl || wikiArtistThumbUrl;
      if (!finalUrl) {
        console.log(`[Stage 1b] Wikimedia: no image found for "${fullQuery}"`);
        return null;
      }

      console.log(`[Stage 1b] Wikimedia thumbnail: ${finalUrl}`);
      const fetched = await this.fetchImageAsBase64(finalUrl);
      if (!fetched) {
        console.warn(`[Stage 1b] Wikimedia thumbnail fetch failed`);
        return null;
      }
      return { ...fetched, sourceUrl: finalUrl };
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
      const contentType = response.headers.get("content-type") || "image/jpeg";
      const mimeType = contentType.split(";")[0].trim();
      if (!mimeType.startsWith("image/")) {
        console.warn(`[Stage 1b] Image fetch returned non-image content-type: ${mimeType}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return { base64, mimeType };
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

Score their visual similarity from 0.0 to 1.0 using this scale:
  1.0 — Identical work, same impression, indistinguishable
  0.9 — Same work, minor photographic differences (angle, lighting)
  0.8 — Very likely same work or direct variant (same series, different state)
  0.7 — Strong visual match — same artist, same period, highly similar composition
  0.6 — Probable match — similar style and technique, plausible same artist
  0.5 — Possible match — shared tradition and technique but significant differences
  0.3 — Weak match — similar tradition only
  0.0 — No meaningful visual similarity

Focus on: composition, subject matter, colour palette, technique markers (line quality, ink texture), and signature/inscription placement.

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

    const searchPrompt = `You are a fine art reverse image search assistant. Examine this print carefully and use Google Search to identify the single most likely artist and artwork.

Prioritise evidence in this order:
1. Legible text in the image — signatures, title inscriptions, edition numbers, publisher stamps
2. Distinctive compositional elements unique to a known artist
3. Technique markers (etching, woodblock, lithograph characteristics)
4. Subject matter and visual style

Search across: Artnet, MutualArt, Catawiki, Christie's, Sotheby's, Bonhams, British Museum, V&A, Met, MoMA, Invaluable.

CRITICAL — after identifying the artist and title, you MUST use Google Search to find a direct image URL of this specific artwork. Follow these steps:
1. Search for "[artist name] [artwork title] print" on artnet.com, bonhams.com, christies.com, sothebys.com, invaluable.com, or pinterest.com
2. From the search results, find a page that shows an image of this specific work
3. Extract the direct .jpg, .jpeg, .png, or .webp image URL from that page — this is the URL of the image file itself, not the page URL
4. Set this as bestImageUrl — do NOT set it to null if you found a matching image

Return a single JSON object:
{
  "bestMatch": {
    "artist": "artist name or null",
    "title": "artwork title or null",
    "technique": "e.g. lithograph, etching, woodblock",
    "period": "e.g. 1960s or null",
    "confidence": "HIGH / MEDIUM / LOW",
    "reasoning": "Why this is the best match — cite specific visual evidence",
    "bestImageUrl": "direct image file URL ending in .jpg, .jpeg, .png, or .webp — must be the URL of the image file itself, NOT a webpage or homepage URL. Example: https://www.bonhams.com/lots/123/images/main.jpg — required if you found a match, null only if no image file URL was found",
    "sourceUrl": "URL of the page where the match was found"
  },
  "webEntities": ["key identifying terms found"],
  "pagesWithMatchingImages": ["up to 5 relevant page URLs"],
  "matchedUrls": [],
  "visuallySimilarUrls": []
}

If no confident match is found, set artist and title to null and confidence to LOW. Include only real URLs you retrieved from search results.`;

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
      console.log(`[Stage 1b] Raw response (first 400): ${text.slice(0, 400)}`);

      let parsed: any;
      try {
        parsed = parseCleanJson(text);
      } catch {
        console.warn("[Stage 1b] Could not parse JSON from Gemini — returning empty result");
        return EMPTY;
      }

      const best = parsed.bestMatch || {};
      console.log(`[Stage 1b] Best match: ${best.artist} — "${best.title}" (${best.confidence})`);
      console.log(`[Stage 1b] Gemini image URL: ${best.bestImageUrl || "none"}`);

      // Fetch a reference image via Wikimedia for visual similarity scoring.
      // Wikimedia is bot-friendly, no auth needed, and covers all major artists in this collection.
      let matchBase64: string | null = null;
      let matchMimeType: string | null = null;
      let similarityScore: number | null = null;
      let similarityRationale: string | null = null;

      if (best.artist && best.confidence !== "LOW") {
        const wikimedia = await this.fetchReferenceImageViaWikimedia(best.artist, best.title);
        if (wikimedia) {
          matchBase64 = wikimedia.base64;
          matchMimeType = wikimedia.mimeType;
        }
      }

      // Fall back to Gemini's suggested URL if Wikimedia found nothing and URL looks like an image file
      if (!matchBase64 && best.bestImageUrl) {
        const isImageUrl = /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(best.bestImageUrl);
        if (isImageUrl) {
          console.log("[Stage 1b] Wikimedia found nothing — trying Gemini's suggested image URL");
          const fetched = await this.fetchImageAsBase64(best.bestImageUrl);
          if (fetched) { matchBase64 = fetched.base64; matchMimeType = fetched.mimeType; }
        } else {
          console.log(`[Stage 1b] Gemini URL rejected (not a direct image file): ${best.bestImageUrl}`);
        }
      }

      if (matchBase64 && matchMimeType) {
        const label = `${best.artist || "Unknown"} — "${best.title || "Untitled"}"`;
        const sim = await this.scoreVisualSimilarity(ai, cleanBase64, mimeType, matchBase64, matchMimeType, label);
        similarityScore = sim.score;
        similarityRationale = sim.rationale;
        console.log(`[Stage 1b] Visual similarity score: ${similarityScore} — ${similarityRationale}`);
      } else {
        console.warn("[Stage 1b] Could not fetch reference image — similarity scoring skipped");
      }

      return {
        webEntities: parsed.webEntities || [],
        matchedUrls: parsed.matchedUrls || [],
        visuallySimilarUrls: parsed.visuallySimilarUrls || [],
        pagesWithMatchingImages: parsed.pagesWithMatchingImages || [],
        bestMatchArtist: best.artist || null,
        bestMatchTitle: best.title || null,
        bestMatchImageUrl: best.bestImageUrl || null,
        bestMatchImageBase64: matchBase64,
        bestMatchImageMimeType: matchMimeType,
        visualSimilarityScore: similarityScore,
        visualSimilarityRationale: similarityRationale,
        matchConfidence: best.confidence || null,
        hypothesisWarning: HYPOTHESIS_WARNING,
      };
    } catch (err: any) {
      console.warn(`[Stage 1b] Gemini visual search failed — skipping: ${err.message}`);
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
    const textPrompt = resolveCustomPrompt(
      VISUAL_EXTRACTION_SYSTEM_PROMPT, currency, input.userNotes,
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

  protected async runStage2aTriage(
    vea: VisualExtractionResult,
    stage2aModel: string,
    ai: GoogleGenAI,
    userNotes?: string
  ): Promise<TriageResult> {
    const notesBlock = userNotes?.trim()
      ? `APPRAISER NOTES (provided by submitting user — treat as high-priority evidence for tradition identification and artist candidates):\n"${userNotes.trim()}"\n\n`
      : "";
    const veaSlim = this.projectVeaForAttribution(vea);
    const userText = `${notesBlock}Here is the structured Visual Extraction output from Stage 1. Use it to triage the print tradition and route to the correct specialist config.\n\n${JSON.stringify(veaSlim, null, 2)}`;
    if (isClaude(stage2aModel)) {
      return this.callClaude(stage2aModel, ATTRIBUTION_TRIAGE_SYSTEM_PROMPT, [{ type: "text", text: userText }], "report_attribution_triage", "Report the structured attribution triage and routing decision.", TRIAGE_SCHEMA);
    } else {
      return this.callGemini(ai, stage2aModel, ATTRIBUTION_TRIAGE_SYSTEM_PROMPT, [{ text: userText }], TRIAGE_SCHEMA, 0.1);
    }
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
    const asaSystemPrompt = injectSpecialistConfig(ATTRIBUTION_RESEARCH_SYSTEM_PROMPT, specialistConfig);
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
  Confidence        : ${vs?.matchConfidence || "N/A"}
  Visual similarity : ${vs?.visualSimilarityScore != null ? `${(vs.visualSimilarityScore * 100).toFixed(0)}% — ${vs.visualSimilarityRationale}` : "Not scored (image not retrieved)"}
  Best image URL    : ${vs?.bestMatchImageUrl || "None"}
  Other pages       : ${vs?.pagesWithMatchingImages?.slice(0, 5).join(", ") || "None"}

INSTRUCTION: Treat the above as a starting hypothesis. Cross-reference against VEA signatures, title inscriptions, and technique before accepting. If the visual similarity score is below 0.6 or confidence is LOW, treat with high scepticism.\n`
      : "";

    const userText = `${notesBlock}TRIAGE OUTPUT (Stage 2a):\n${JSON.stringify(triage, null, 2)}\n\nVISUAL EXTRACTION OUTPUT (Stage 1):\n${JSON.stringify(veaSlim, null, 2)}${visualSearchBlock}\n\nConduct specialist attribution research per the injected specialist config and the triage routing above.`;

    console.log(`[4-Stage] Stage 2b model: "${stage2bModel}", isClaude=${isClaude(stage2bModel)}`);
    if (isClaude(stage2bModel)) {
      return this.callClaudeWithWebSearch(stage2bModel, asaSystemPrompt, userText, 8192);
    } else {
      return this.callGemini(ai, stage2bModel, asaSystemPrompt, [{ text: userText }], SPECIALIST_ATTRIBUTION_SCHEMA, this.config.temperature || 0.15, true);
    }
  }

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

    const inferredDimensions = vea.dimensions?.sourceImage !== "unavailable"
      ? `Plate: ${vea.dimensions?.printedImageMM?.width ?? "?"}×${vea.dimensions?.printedImageMM?.height ?? "?"}mm, Sheet: ${vea.dimensions?.fullSheetMM?.width ?? "?"}×${vea.dimensions?.fullSheetMM?.height ?? "?"}mm`
      : "Dimensions not available — no scale scan provided.";

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

    const emit = input.onProgress ?? (() => {});
    const t0 = Date.now();

    emit({ stage: "stage1", status: "start", message: "Extracting visual attributes — medium, technique, condition…", percent: 5 });
    console.log(`[Timing] Stage 1 (VEA) starting — model: ${stage1Model}`);
    const vea = await this.runStage1VEA(input, stage1Model, ai);
    console.log(`[Timing] Stage 1 (VEA) done — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    emit({ stage: "stage1", status: "done", message: "Visual extraction complete", percent: 20 });

    if (vea.imageAuthenticity?.haltRecommended) {
      return this.buildHaltReport(vea, currency);
    }

    // Stage 1b (visual search) + Stage 2a (triage) run in parallel
    emit({ stage: "stage1b", status: "start", message: "Searching global image databases for visual matches…", percent: 22 });
    emit({ stage: "stage2a", status: "start", message: "Triaging attribution complexity and routing to specialist…", percent: 24 });
    const [visualSearch, triageResult] = await Promise.all([
      runVisualSearch
        ? this.runStage1bVisionSearch(input.imageBase64, input.mimeType)
        : Promise.resolve(undefined),
      (async () => {
        const t2a = Date.now();
        console.log(`[Timing] Stage 2a (Triage) starting — model: ${stage2aModel}`);
        const r = await this.runStage2aTriage(vea, stage2aModel, ai, input.userNotes);
        console.log(`[Timing] Stage 2a (Triage) done — ${((Date.now() - t2a) / 1000).toFixed(1)}s`);
        emit({ stage: "stage2a", status: "done", message: "Triage complete — specialist routing confirmed", percent: 40 });
        return r;
      })(),
    ]);
    emit({ stage: "stage1b", status: "done", message: "Visual search complete", percent: 42 });

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
    report.stage2Result = attr;
    report.stage2aResult = triageResult;
    const stage1bModel = this.config.stage1bModel || DEFAULT_STAGE1B_MODEL;
    report.modelUsed = `4-Stage [S1: ${stage1Model} | S1b: ${runVisualSearch ? stage1bModel : "skip"} | S2a: ${stage2aModel} | S2b: ${stage2bModel} | S3: ${stage3Model}]`;
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
    name: "Claude 4-Stage Pipeline (VEA + ATA + ASA + Valuation)",
    description: "Full 4-stage appraisal: Visual Extraction (Opus), Attribution Triage (Sonnet), Specialist Attribution with web search (Sonnet), and Valuation (Sonnet).",
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
    name: "Claude 4-Stage Fast (Haiku Triage)",
    description: "Opus for vision (S1), Haiku for triage (S2a), Sonnet for specialist search (S2b), Haiku for valuation (S3). Faster and cheaper than standard 4-stage.",
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
  {
    id: "gemini-4stage",
    name: "Gemini 4-Stage Pipeline (VEA + ATA + ASA + Valuation)",
    description: "Full 4-stage appraisal: VEA on Gemini 2.5 Pro, Attribution Triage + Specialist on Gemini 3.1 Pro Preview, Valuation on Gemini 2.5 Pro.",
    modelName: "gemini-2.5-pro",
    temperature: 0.1,
    promptKey: "standard",
    imageQuality: "original",
    includeAuxiliaryScans: true,
    stage1Model: "gemini-2.5-pro",
    stage2aModel: "gemini-3.1-pro-preview",
    stage2bModel: "gemini-3.1-pro-preview",
    stage3Model: "gemini-2.5-pro",
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
  TRIAGE_SCHEMA,
  SPECIALIST_ATTRIBUTION_SCHEMA,
} from "./schemas";
