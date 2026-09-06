/**
 * Stage 1d only (DINOv2/CLIP embedding match, top 3) against N random images from the
 * backtest test pool — no Stage 1b (skips the Gemini reverse-image-search call
 * entirely, unlike run_stage1d_comparison.ts, since this is specifically about
 * tracking Stage 1d's own hit rate as Bonhams embedding coverage grows).
 *
 * Usage: npx tsx tests/backtest/run_stage1d_only.ts [--n 20] [--concurrency 4]
 *
 * Requires the embedding service running (knowledge_graph/embedding_service.py).
 * No GEMINI_API_KEY needed.
 */
import dotenv from "dotenv";
dotenv.config();

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { FourStageAppraiser, appraiserConfigs } from "../../src/appraisal/appraiser";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index.js";

interface PoolEntry {
  house: string;
  saleId: string;
  lotNumber: number;
  artistName: string;
  title: string;
  imageUrl: string;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const N = parseInt(arg("n", "20"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "4"), 10);

function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface RowResult {
  entry: PoolEntry;
  fetchOk: boolean;
  stage1d?: { top: { artist: string; title: string | null; dino: number | null; clip: number | null }[] };
  error?: string;
}

function normalizeArtist(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(sir|dame|van|von|de|der)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function artistsMatch(a: string, b: string): boolean {
  const na = normalizeArtist(a);
  const nb = normalizeArtist(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function main() {
  const pool: PoolEntry[] = JSON.parse(readFileSync("tests/backtest/test_pool_100.json", "utf8"));
  const picked = sample(pool, N);
  console.log(`Sampled ${picked.length} of ${pool.length} pool entries.\n`);

  const config = appraiserConfigs.find((c) => c.id === "claude-4stage")!;
  const appraiser = new FourStageAppraiser(config) as any; // reach protected stage methods — established pattern

  const results = await runWithConcurrency(picked, CONCURRENCY, async (entry, i) => {
    const label = `[${i + 1}/${picked.length}] ${entry.artistName} — "${entry.title}"`;
    console.log(`${label} — fetching image...`);
    const fetched = await appraiser.fetchImageAsBase64(entry.imageUrl);
    if (!fetched) {
      console.warn(`${label} — image fetch FAILED, skipping`);
      return { entry, fetchOk: false } as RowResult;
    }
    try {
      const d = await appraiser.runStage1dEmbeddingMatch(fetched.base64, fetched.mimeType);
      console.log(`${label} — done. 1d top: ${d.bestMatchArtist ?? "none"}`);
      return {
        entry,
        fetchOk: true,
        stage1d: {
          top: (d.candidateMatches ?? []).slice(0, 3).map((c: any) => ({
            artist: c.artistName, title: c.conceptualWorkTitle, dino: c.dinov2Similarity, clip: c.clipSimilarity,
          })),
        },
      } as RowResult;
    } catch (err: any) {
      console.warn(`${label} — ERROR: ${err.message}`);
      return { entry, fetchOk: true, error: err.message } as RowResult;
    }
  });

  mkdirSync("tests/backtest/output", { recursive: true });
  writeFileSync("tests/backtest/output/stage1d_only.json", JSON.stringify(results, null, 2));
  console.log(`\nWrote tests/backtest/output/stage1d_only.json`);

  const lines: string[] = [];
  lines.push("| # | Actual | Stage 1d top 3 | Hit? |");
  lines.push("|---|---|---|---|");
  let hits = 0;
  results.forEach((r, i) => {
    const actual = `${r.entry.artistName} — *${r.entry.title}*`;
    if (!r.fetchOk) { lines.push(`| ${i + 1} | ${actual} | _image fetch failed_ | — |`); return; }
    if (r.error) { lines.push(`| ${i + 1} | ${actual} | _error: ${r.error}_ | — |`); return; }
    const top = r.stage1d!.top;
    const hit = top.some((c) => artistsMatch(c.artist, r.entry.artistName));
    if (hit) hits++;
    const dCell = top.length
      ? top.map((c) => `${c.artist} — *${c.title ?? "?"}* (dino=${c.dino?.toFixed(3) ?? "—"}, clip=${c.clip?.toFixed(3) ?? "—"})`).join("<br>")
      : "_no match_";
    lines.push(`| ${i + 1} | ${actual} | ${dCell} | ${hit ? "**YES**" : "no"} |`);
  });
  const scored = results.filter((r) => r.fetchOk && !r.error).length;
  lines.push("");
  lines.push(`**Hit rate: ${hits}/${scored} (${scored ? ((hits / scored) * 100).toFixed(1) : "0"}%)** — correct artist anywhere in Stage 1d's top 3.`);
  const table = lines.join("\n");
  writeFileSync("tests/backtest/output/stage1d_only.md", table);
  console.log(`Wrote tests/backtest/output/stage1d_only.md\n`);
  console.log(table);

  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
