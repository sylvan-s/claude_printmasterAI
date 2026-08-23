/**
 * Targeted LLM fallback for lots the regex parser genuinely fails on.
 *
 * Ported from extract_roseberys_structured.py's extraction prompt (used
 * standalone on the 56-lot Agathe Sorel research sale). This is scoped
 * narrower on purpose: only called when parseDescription() couldn't find an
 * artist or medium at all. It is NOT for leakRisks-flagged lots — those are
 * flagged for blind-benchmark redaction (the prose names the artist/printer/
 * publisher), which re-extraction can't fix since the failure isn't in the
 * parsing, it's a property of the source text itself.
 *
 * Zero API calls unless a lot actually fails regex parsing — on the one real
 * sale tested (A0785, 403 lots), that was 0/403, so treat this as a safety
 * net for malformed listings on other sales, not a routine cost.
 */

const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT =
  "You are a specialist in fine art auction cataloguing. Extract structured " +
  "fields from an auction lot description. Respond ONLY with valid JSON — " +
  "no commentary, no markdown fences.";

export interface LlmFallbackResult {
  artist: string | null;
  medium: string | null;
  condition: string | null;
}

function buildPrompt(lotNumber: number, description: string): string {
  return `Extract the following fields from this auction lot description for Lot ${lotNumber}.

LOT DESCRIPTION:
${description}

Return a JSON object with exactly these keys:
{
  "artist": "Full artist name, or null if genuinely not statable.",
  "medium": "Medium/technique, e.g. 'etching', 'lithograph', 'screenprint', or null.",
  "condition": "Condition notes, or null if not stated."
}`;
}

function parseJsonResponse(raw: string): LlmFallbackResult {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.split("```")[1] ?? text;
    if (text.startsWith("json")) text = text.slice(4);
    text = text.trim();
  }
  const parsed = JSON.parse(text);
  return {
    artist: parsed.artist ?? null,
    medium: parsed.medium ?? null,
    condition: parsed.condition ?? null,
  };
}

/** Single lot, single attempt — caller decides whether/how to retry. */
export async function llmFallbackExtract(
  lotNumber: number,
  description: string,
): Promise<LlmFallbackResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — required for --llm-fallback");
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(lotNumber, description) }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text ?? "";
  return parseJsonResponse(raw);
}
