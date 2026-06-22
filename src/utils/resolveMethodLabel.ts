export function resolveMethodLabel(approach: string, model: string): string {
  if (approach === "4stage" || model.includes("4-Stage")) {
    return model.toLowerCase().includes("claude") ? "Claude 4-Stage Pipeline" : "Gemini 4-Stage Pipeline";
  }
  if (approach === "3stage" || model.includes("3-Stage")) {
    return model.toLowerCase().includes("claude") ? "Claude 3-Stage Pipeline" : "Gemini 3-Stage Pipeline";
  }
  if (model === "gemini-3.5-flash" && approach === "standard") return "Gemini Standard";
  if (model === "gemini-2.5-pro" && approach === "standard") return "Gemini Pro (2.5)";
  if (model === "gemini-pro-latest" && approach === "standard") return "Gemini Pro (Stable)";
  if (model === "gemini-3.1-pro-preview" && approach === "standard") return "Gemini 3.1 Pro (Preview)";
  if (model === "gemini-3.5-flash" && approach === "creative") return "Gemini Creative";
  if (model === "gemini-3.5-flash" && approach === "strict") return "Gemini Strict / Skeptic";
  if (model === "gemini-3.5-flash" && approach === "simplified") return "Gemini Simplified";
  if (model === "claude-sonnet-4-6" && approach === "standard") return "Claude Sonnet (4.6)";
  if (model === "claude-opus-4-8" && approach === "standard") return "Claude Opus (4.8)";
  return `${approach.charAt(0).toUpperCase() + approach.slice(1)} - ${model}`;
}
