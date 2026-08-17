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
} from "./schemas";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname_esm = dirname(fileURLToPath(import.meta.url));
const SPECIALIST_CONFIGS_DIR = join(__dirname_esm, "specialist_configs");

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface AppraisalInput {
  imageBase64: string;
  mimeType?: string;
  userNotes?: string;
  signatureBase64?: string;
  signatureMimeType?: string;
  damageBase64?: string;
  damageMimeType?: string;
  scaleBase64?: string;
  scaleMimeType?: string;
  currency?: string;
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

  // Try direct parse first
  try { return JSON.parse(clean); } catch {}

  // Extract first {...} block from prose-wrapped output
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(clean.slice(firstBrace, lastBrace + 1));
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

const AUX_LABEL_SIGNATURE = "--- AUXILIARY SPECIMEN SCAN: CLOSEUP OF THE ARTIST SIGNATURE OR EMBOSSMENT MARK ---";
const AUX_LABEL_DAMAGE = "--- AUXILIARY SPECIMEN SCAN: CLOSEUP OF POTENTIAL PAPER DAMAGE, STAINING, OR SURFACE WEAR ---";
const AUX_LABEL_SCALE = "--- AUXILIARY SPECIMEN SCAN: DENSITY SCALE REFERENCE PHOTO WITH COIN PLACED ADJACENT TO SHEET --- Use the coin as a standard size scale (e.g. standard penny or quarter coin diameter) to mathematically infer sheet/print dimensions of this artwork.";

function buildGeminiImageParts(input: AppraisalInput, includeAux: boolean): any[] {
  const parts: any[] = [];
  parts.push({
    inlineData: {
      data: input.imageBase64.replace(/^data:image\/\w+;base64,/, ""),
      mimeType: input.mimeType || "image/jpeg",
    },
  });
  if (includeAux && input.signatureBase64) {
    parts.push({ text: AUX_LABEL_SIGNATURE });
    parts.push({ inlineData: { data: input.signatureBase64.replace(/^data:image\/\w+;base64,/, ""), mimeType: input.signatureMimeType || "image/jpeg" } });
  }
  if (includeAux && input.damageBase64) {
    parts.push({ text: AUX_LABEL_DAMAGE });
    parts.push({ inlineData: { data: input.damageBase64.replace(/^data:image\/\w+;base64,/, ""), mimeType: input.damageMimeType || "image/jpeg" } });
  }
  if (includeAux && input.scaleBase64) {
    parts.push({ text: AUX_LABEL_SCALE });
    parts.push({ inlineData: { data: input.scaleBase64.replace(/^data:image\/\w+;base64,/, ""), mimeType: input.scaleMimeType || "image/jpeg" } });
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
  if (includeAux && input.signatureBase64) {
    blocks.push({ type: "text", text: AUX_LABEL_SIGNATURE });
    blocks.push({ type: "image", source: { type: "base64", media_type: input.signatureMimeType || "image/jpeg", data: input.signatureBase64.replace(/^data:image\/\w+;base64,/, "") } });
  }
  if (includeAux && input.damageBase64) {
    blocks.push({ type: "text", text: AUX_LABEL_DAMAGE });
    blocks.push({ type: "image", source: { type: "base64", media_type: input.damageMimeType || "image/jpeg", data: input.damageBase64.replace(/^data:image\/\w+;base64,/, "") } });
  }
  if (includeAux && input.scaleBase64) {
    blocks.push({ type: "text", text: AUX_LABEL_SCALE });
    blocks.push({ type: "image", source: { type: "base64", media_type: input.scaleMimeType || "image/jpeg", data: input.scaleBase64.replace(/^data:image\/\w+;base64,/, "") } });
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

    let textPrompt: string;
    if (this.config.promptText) {
      textPrompt = resolveCustomPrompt(this.config.promptText, currency, input.userNotes, includeAux && !!input.signatureBase64, includeAux && !!input.damageBase64, includeAux && !!input.scaleBase64);
    } else {
      textPrompt = getPrompt(this.config.promptKey, currency, input.userNotes, includeAux && !!input.signatureBase64, includeAux && !!input.damageBase64, includeAux && !!input.scaleBase64);
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

    let textPrompt: string;
    if (this.config.promptText) {
      textPrompt = resolveCustomPrompt(this.config.promptText, currency, input.userNotes, includeAux && !!input.signatureBase64, includeAux && !!input.damageBase64, includeAux && !!input.scaleBase64);
    } else {
      textPrompt = getPrompt(this.config.promptKey, currency, input.userNotes, includeAux && !!input.signatureBase64, includeAux && !!input.damageBase64, includeAux && !!input.scaleBase64);
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
// ThreeStageAppraiser — 3-stage and 4-stage pipelines
// ---------------------------------------------------------------------------

export class ThreeStageAppraiser implements AppraisalMethod {
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

  // ---- Low-level API callers ------------------------------------------------

  private async callGemini(
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

  private async callClaude(
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

  private async callClaudeWithWebSearch(
    modelName: string,
    systemInstruction: string,
    userText: string
  ): Promise<any> {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY environment variable is defined.");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 8192,
        system: systemInstruction,
        messages: [{
          role: "user",
          content: userText + "\n\n⚠️ CRITICAL: Your entire response must be a single valid JSON object matching the OUTPUT SCHEMA above. Do not write any prose, explanation, or text outside the JSON object. Start your response with { and end with }.",
        }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude web-search API request failed: ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (data.stop_reason === "max_tokens") {
      throw new Error("Claude (web-search) hit max_tokens limit — response was truncated. Try a simpler query or increase max_tokens.");
    }

    const textBlocks = data.content?.filter((b: any) => b.type === "text") || [];
    if (!textBlocks.length) throw new Error("Claude (web-search) returned no text blocks.");

    const lastText = textBlocks[textBlocks.length - 1].text as string;
    console.log("[4-Stage] ASA raw response (first 300):", lastText?.slice(0, 300));
    try {
      return parseCleanJson(lastText);
    } catch (err: any) {
      console.error("[4-Stage] Failed to parse ASA JSON. Raw text:", lastText);
      throw new Error(`Failed to parse ASA JSON output: ${err.message}`);
    }
  }

  // ---- Stage methods --------------------------------------------------------

  private async runStage1VEA(
    input: AppraisalInput,
    stage1Model: string,
    ai: GoogleGenAI
  ): Promise<VisualExtractionResult> {
    const includeAux = this.config.includeAuxiliaryScans;
    const currency = input.currency || "USD";
    const systemPrompt = "You are a specialist Fine Art Print Visual Extraction Agent.";
    const textPrompt = resolveCustomPrompt(
      VISUAL_EXTRACTION_SYSTEM_PROMPT, currency, input.userNotes,
      includeAux && !!input.signatureBase64,
      includeAux && !!input.damageBase64,
      includeAux && !!input.scaleBase64
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

  private buildHaltReport(vea: VisualExtractionResult, currency: string): PrintAnalysisReport {
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

  private async runStage2aTriage(
    vea: VisualExtractionResult,
    stage2aModel: string,
    ai: GoogleGenAI,
    userNotes?: string
  ): Promise<TriageResult> {
    const notesBlock = userNotes?.trim()
      ? `APPRAISER NOTES (provided by submitting user — treat as high-priority evidence for tradition identification and artist candidates):\n"${userNotes.trim()}"\n\n`
      : "";
    const userText = `${notesBlock}Here is the structured Visual Extraction output from Stage 1. Use it to triage the print tradition and route to the correct specialist config.\n\n${JSON.stringify(vea, null, 2)}`;
    if (isClaude(stage2aModel)) {
      return this.callClaude(stage2aModel, ATTRIBUTION_TRIAGE_SYSTEM_PROMPT, [{ type: "text", text: userText }], "report_attribution_triage", "Report the structured attribution triage and routing decision.", TRIAGE_SCHEMA);
    } else {
      return this.callGemini(ai, stage2aModel, ATTRIBUTION_TRIAGE_SYSTEM_PROMPT, [{ text: userText }], TRIAGE_SCHEMA, 0.1);
    }
  }

  private async runStage2bSpecialist(
    vea: VisualExtractionResult,
    triage: TriageResult,
    stage2bModel: string,
    ai: GoogleGenAI,
    userNotes?: string
  ): Promise<AttributionResearchResult> {
    const specialistConfigKey = triage.routingDecision?.specialistConfig || "general_print_fallback";
    const specialistConfig = loadSpecialistConfig(specialistConfigKey);
    const asaSystemPrompt = injectSpecialistConfig(ATTRIBUTION_RESEARCH_SYSTEM_PROMPT, specialistConfig);
    const notesBlock = userNotes?.trim()
      ? `APPRAISER NOTES (provided by submitting user — treat as high-priority evidence for attribution and title identification):\n"${userNotes.trim()}"\n\n`
      : "";
    const userText = `${notesBlock}TRIAGE OUTPUT (Stage 2a):\n${JSON.stringify(triage, null, 2)}\n\nVISUAL EXTRACTION OUTPUT (Stage 1):\n${JSON.stringify(vea, null, 2)}\n\nConduct specialist attribution research per the injected specialist config and the triage routing above.`;

    console.log(`[4-Stage] Stage 2b model: "${stage2bModel}", isClaude=${isClaude(stage2bModel)}`);
    if (isClaude(stage2bModel)) {
      return this.callClaudeWithWebSearch(stage2bModel, asaSystemPrompt, userText);
    } else {
      return this.callGemini(ai, stage2bModel, asaSystemPrompt, [{ text: userText }], SPECIALIST_ATTRIBUTION_SCHEMA, this.config.temperature || 0.15, true);
    }
  }

  private async runStage2Attribution(
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

  private async runStage3Valuation(
    vea: VisualExtractionResult,
    attr: AttributionResearchResult,
    stage3Model: string,
    ai: GoogleGenAI,
    currency: string,
    userNotes?: string
  ): Promise<PrintAnalysisReport> {
    const systemInstruction = resolveCustomPrompt(VALUATION_REPORT_SYSTEM_PROMPT, currency, userNotes);
    const userText = `Synthesize these two structured inputs to generate the final appraisal report.\n\nSTAGE 1 VISUAL EXTRACTION RESULTS:\n${JSON.stringify(vea, null, 2)}\n\nSTAGE 2 ATTRIBUTION & MARKET RESEARCH RESULTS:\n${JSON.stringify(attr, null, 2)}`;
    if (isClaude(stage3Model)) {
      return this.callClaude(stage3Model, systemInstruction, [{ type: "text", text: userText }], "report_print_analysis", "Report the final structured art print analysis and appraisal details.", FINAL_REPORT_RESPONSE_SCHEMA);
    } else {
      return this.callGemini(ai, stage3Model, systemInstruction, [{ text: userText }], FINAL_REPORT_RESPONSE_SCHEMA, this.config.temperature || 0.15, true);
    }
  }

  // ---- Orchestrator --------------------------------------------------------

  public async appraise(input: AppraisalInput): Promise<PrintAnalysisReport> {
    const ai = this.getClient();
    const currency = input.currency || "USD";
    const defaultModel = this.config.modelName;
    const stage1Model = this.config.stage1Model || defaultModel;
    const stage3Model = this.config.stage3Model || defaultModel;

    // Stage 1 — Visual Extraction
    const vea = await this.runStage1VEA(input, stage1Model, ai);

    if (vea.imageAuthenticity?.haltRecommended) {
      return this.buildHaltReport(vea, currency);
    }

    // Stage 2 — Attribution (3-stage path or 4-stage path)
    let attr: AttributionResearchResult;
    let triageResult: TriageResult | undefined;

    if (this.config.stage2aModel) {
      // 4-stage: Triage → Specialist
      triageResult = await this.runStage2aTriage(vea, this.config.stage2aModel, ai, input.userNotes);
      const stage2bModel = this.config.stage2bModel || this.config.stage2aModel;
      attr = await this.runStage2bSpecialist(vea, triageResult, stage2bModel, ai, input.userNotes);
    } else {
      // 3-stage: direct attribution research
      const stage2Model = this.config.stage2Model || defaultModel;
      attr = await this.runStage2Attribution(vea, stage2Model, ai, currency, input.userNotes);
    }

    // Stage 3 — Valuation
    const finalReport = await this.runStage3Valuation(vea, attr, stage3Model, ai, currency, input.userNotes);

    // Defensively repair stringified JSON fields some models return
    if (typeof finalReport.conditionNotes === "string") {
      try { (finalReport as any).conditionNotes = JSON.parse(finalReport.conditionNotes as any); } catch {}
    }
    if (typeof finalReport.auctionEstimate === "string") {
      try { (finalReport as any).auctionEstimate = JSON.parse(finalReport.auctionEstimate as any); } catch {}
    }

    // Attach stage outputs and pipeline metadata
    finalReport.stage1Result = vea;
    finalReport.stage2Result = attr;

    if (triageResult) {
      finalReport.stage2aResult = triageResult;
      finalReport.modelUsed = `4-Stage [S1: ${stage1Model} | S2a: ${this.config.stage2aModel} | S2b: ${this.config.stage2bModel || this.config.stage2aModel} | S3: ${stage3Model}]`;
      finalReport.promptVersion = "4stage";
    } else {
      finalReport.modelUsed = `3-Stage [S1: ${stage1Model} | S2: ${this.config.stage2Model || defaultModel} | S3: ${stage3Model}]`;
      finalReport.promptVersion = "3stage";
    }

    return finalReport;
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
  },
];

// ---------------------------------------------------------------------------
// Registry and factory
// ---------------------------------------------------------------------------

export const appraiserRegistry: Record<string, AppraisalMethod> = appraiserConfigs.reduce(
  (registry, config) => {
    if (config.stage1Model || config.stage2aModel) {
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
  if (appraiser instanceof ThreeStageAppraiser) {
    return new ThreeStageAppraiser(appraiser.config, aiClient);
  }
  if (aiClient && !(appraiser instanceof ConfigurableClaudeAppraiser)) {
    return new ConfigurableGeminiAppraiser(appraiser.config, aiClient);
  }
  return appraiser;
}

export function getAppraiserFromConfig(config: AppraisalMethodConfig, aiClient?: GoogleGenAI): AppraisalMethod {
  if (config.stage1Model || config.stage2aModel) return new ThreeStageAppraiser(config, aiClient);
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
