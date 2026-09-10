/**
 * Client-side web search for Stage 2b.
 *
 * Stage 2b has always searched through Anthropic's SERVER-side web_search tool, which works
 * but ties the stage to one provider and hides everything about the search itself. Doing the
 * search here instead buys four things the server-side tool cannot:
 *
 *   1. PORTABILITY. No Qwen model reachable through DashScope performs a web search under any
 *      invocation tested — Anthropic's web_search tool is accepted with a 200 and silently
 *      ignored, leaving the model to answer from training data. Measured: qwen-plus invented a
 *      GBP 3,486,000 Sotheby's sale for a print that trades at GBP 800-1,430; qwen3-max and
 *      qwen3-235b denied the work exists at all. With results supplied as content, the model
 *      only has to synthesise, which is the half Qwen is good at.
 *   2. VISIBILITY. What was searched, and what came back, is logged rather than opaque.
 *   3. CACHING. Stage 2b re-researches the same artist on every lot by them. A sale with 19
 *      Matisse lots currently pays for 19 identical opening searches.
 *   4. COST ACCOUNTING. Searches are counted, so the 53% of pipeline spend sitting in Stage 2b
 *      can be attributed between search and generation instead of guessed at.
 *
 * Tavily is the provider: built for LLM agents, returns cleaned page content rather than
 * SERP HTML, and has a free tier that covers a whole catalogue screen (2 searches per lot,
 * ~26 candidate lots per sale, against 1,000/month).
 *
 * The provider is deliberately behind one function. Swapping to Serper, Brave or Google CSE
 * means replacing `tavilySearch` and nothing else.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  /** Tavily's extracted page content, already cleaned of chrome. */
  content: string;
  score: number;
  publishedDate?: string | null;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  /** Provider-side credit usage, when reported — for cost accounting. */
  creditsUsed?: number | null;
  error?: string;
}

const TAVILY_URL = "https://api.tavily.com/search";

/**
 * Results are capped and truncated before they reach the model. An untruncated search
 * response is several thousand tokens and rides along in every later turn of the tool loop —
 * the same problem measured on Stage 2a, where 60 rendered graph rows were paid for and
 * unread. 5 results at ~700 chars each is roughly 900 tokens per search.
 */
export const MAX_RESULTS = 5;
export const MAX_CONTENT_CHARS = 700;

let searchCount = 0;
let creditsUsed = 0;

export function webSearchUsage(): { searches: number; credits: number } {
  return { searches: searchCount, credits: creditsUsed };
}

export function resetWebSearchUsage(): void {
  searchCount = 0;
  creditsUsed = 0;
}

/**
 * One search. Never throws — Stage 2b must degrade to "no results" rather than take the lot
 * down, the same discipline the ACKG queries follow.
 */
export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; searchDepth?: "basic" | "advanced" } = {},
): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { query, results: [], error: "TAVILY_API_KEY is not set — add it to .env (free key at app.tavily.com)." };
  }
  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        max_results: opts.maxResults ?? MAX_RESULTS,
        // "advanced" costs more credits and returns better-extracted content; auction results
        // are often in tables and lists that a basic extract mangles.
        search_depth: opts.searchDepth ?? "advanced",
        include_answer: false,   // the model does the synthesis; a provider answer would compete with it
        include_raw_content: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { query, results: [], error: `Tavily ${res.status}: ${body.slice(0, 200)}` };
    }
    const json: any = await res.json();
    searchCount++;
    if (typeof json?.usage?.credits === "number") creditsUsed += json.usage.credits;
    const results: WebSearchResult[] = (json?.results ?? []).map((r: any) => ({
      title: String(r.title ?? "").slice(0, 160),
      url: String(r.url ?? ""),
      content: String(r.content ?? "").slice(0, MAX_CONTENT_CHARS),
      score: Number(r.score ?? 0),
      publishedDate: r.published_date ?? null,
    }));
    return { query, results, creditsUsed: json?.usage?.credits ?? null };
  } catch (err: any) {
    return { query, results: [], error: `Tavily request failed: ${err?.message ?? err}` };
  }
}

/** Renders a search response as a tool_result for the model. */
export function formatSearchForModel(r: WebSearchResponse): string {
  if (r.error) {
    return `Web search unavailable (${r.error}). Treat this as a tooling failure, NOT as evidence that nothing exists — do not conclude the work is unrecorded because a search did not run.`;
  }
  if (r.results.length === 0) {
    return `No results for "${r.query}". That is absence of coverage in this search index, not evidence about the work. Try a narrower or differently-phrased query, or report the cells honestly empty.`;
  }
  const lines = [`${r.results.length} result(s) for "${r.query}":`];
  for (const x of r.results) {
    lines.push(
      `\n[${x.title}](${x.url})${x.publishedDate ? ` — ${x.publishedDate}` : ""}\n  ${x.content.replace(/\s+/g, " ")}`,
    );
  }
  lines.push(
    `\nCite the URL above for any figure you take from these results. A price you cannot point at a URL for is not a verified comparable — leave it out rather than reporting it.`,
  );
  return lines.join("\n");
}
