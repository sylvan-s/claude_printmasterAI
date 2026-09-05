/**
 * Text embeddings for ACKG title matching — ADR-0010 Decision 9.1, Part B.
 *
 * Model: gemini-embedding-001 (Google), taskType SEMANTIC_SIMILARITY, 768 dims,
 * L2-normalized on the way out so cosine == dot product. The evidence agent's
 * K_work title match (Pass 2) and the one-time ConceptualWork.name backfill both
 * go through here.
 *
 * gemini-embedding-001's raw cosines sit in a compressed band — two unrelated short
 * titles land ~0.72-0.76, near-identical ~0.96-0.98. `titleSimFromCosine` rescales
 * that band to a 0..1 score so TAU_TITLE etc. are interpretable. The floor/ceiling
 * are calibration constants — revisit against tests/backtest/.
 */
import { GoogleGenAI } from "@google/genai";

export const TITLE_EMBED_MODEL = "gemini-embedding-001";
export const TITLE_EMBED_DIM = 768;

// Empirical cosine band for gemini-embedding-001 on short print titles (SEMANTIC_SIMILARITY).
export const COSINE_FLOOR = 0.72; // two unrelated titles
export const COSINE_CEIL = 0.96; // same title, trivial variation

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY / GOOGLE_API_KEY not set — text embeddings unavailable.");
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function l2normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** cosine == dot product for L2-normalized inputs (which embedTexts always returns). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

/** Map a raw gemini-embedding-001 cosine onto an interpretable 0..1 title-similarity. */
export function titleSimFromCosine(cos: number): number {
  const s = (cos - COSINE_FLOOR) / (COSINE_CEIL - COSINE_FLOOR);
  return Math.max(0, Math.min(1, s));
}

/**
 * Embed a batch of texts. Returns L2-normalized 768-d vectors in input order.
 * Retries transient errors (429 / 5xx / network) with backoff.
 */
export async function embedTexts(
  texts: string[],
  opts: { taskType?: string; maxAttempts?: number } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { taskType = "SEMANTIC_SIMILARITY", maxAttempts = 4 } = opts;
  const ai = client();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await ai.models.embedContent({
        model: TITLE_EMBED_MODEL,
        contents: texts,
        config: { taskType, outputDimensionality: TITLE_EMBED_DIM },
      });
      const embs = res.embeddings ?? [];
      if (embs.length !== texts.length)
        throw new Error(`embedContent returned ${embs.length} vectors for ${texts.length} inputs`);
      return embs.map((e) => l2normalize(e.values ?? []));
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const retryable = /429|rate|quota|resource.exhausted|deadline|unavailable|500|502|503|504|fetch failed|ECONN|ETIMEDOUT/i.test(msg);
      if (!retryable || attempt >= maxAttempts) break;
      const wait = Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.warn(`[embed_text] transient "${msg.slice(0, 120)}" — retry ${attempt}/${maxAttempts - 1} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`embedTexts failed after ${maxAttempts} attempts: ${(lastErr as any)?.message ?? lastErr}`);
}

/** Convenience: one text -> one vector. */
export async function embedText(text: string, opts?: { taskType?: string }): Promise<number[]> {
  return (await embedTexts([text], opts))[0];
}
