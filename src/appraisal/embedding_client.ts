/**
 * Client for Stage 1d's local Python embedding microservice
 * (knowledge_graph/embedding_service.py — docs/adr/0013-stage1d-image-embedding-evidence.md).
 *
 * Same optional-evidence discipline as runStage1bVisionSearch: any failure (timeout,
 * connection refused because the service isn't running, non-2xx, malformed JSON)
 * degrades to `null`, never throws — Stage 1d is shadow-run-only evidence, not
 * something that should be able to take down an appraisal.
 */

export interface EmbeddingVector {
  model: string;
  dim: number;
  vector: number[];
}

export interface EmbeddingVectors {
  dinov2: EmbeddingVector | null;
  clip: EmbeddingVector | null;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8008";
const DEFAULT_TIMEOUT_MS = 15_000;

function baseUrl(): string {
  return process.env.EMBEDDING_SERVICE_URL || DEFAULT_BASE_URL;
}

export async function getImageEmbeddings(
  imageBase64: string,
  mimeType?: string,
  opts: { timeoutMs?: number } = {},
): Promise<EmbeddingVectors | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mimeType }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[embedding_client] /embed returned ${res.status} — treating as unavailable`);
      return null;
    }
    const data = await res.json();
    return {
      dinov2: data?.dinov2 ?? null,
      clip: data?.clip ?? null,
    };
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? "timed out" : (err?.message ?? String(err));
    console.warn(`[embedding_client] embedding service unavailable (${reason}) — skipping Stage 1d`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkEmbeddingServiceHealth(timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
