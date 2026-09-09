/**
 * One-off comparison: Stage 1b (reverse image search, single best match) vs.
 * Stage 1d (DINOv2/CLIP embedding match, top 3) run independently (no full
 * pipeline) against N random images from the backtest test pool.
 *
 * Caveat (see docs/adr/0013-stage1d-image-embedding-evidence.md): the test pool is
 * 100% Roseberys/Forum Auctions lots, and neither house is embedded in the ACKG's
 * image index — Bonhams (40,224) + Tate (10,208) + British Museum (2,507), 52,939
 * images verified 2026-09-07. The lot's own image file is therefore never in the
 * index — there is no self-match. The exact *work* is still often reachable, though:
 * prints are editions, and Bonhams/Tate/BM frequently hold another impression of the
 * same ConceptualWork, which is indexed. Measured over the pool, Stage 1d returns the
 * correct work in its top 3 for 24.2% of lots. So this script is a partial accuracy
 * benchmark bounded by edition overlap, not the pure stylistic-neighbour dump the
 * original caveat described.
 *
 * Usage: npx tsx tests/backtest/run_stage1d_comparison.ts [--n 20] [--concurrency 4]
 *
 * Requires the embedding service running (knowledge_graph/embedding_service.py)
 * and GEMINI_API_KEY set.
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
  stage1b?: { artist: string | null; title: string | null; similarity: number | null; compositionMatch: string | null; confidence: string | null };
  stage1d?: { top: { artist: string; title: string | null; dino: number | null; clip: number | null }[] };
  error?: string;
}

async function main() {
  const pool: PoolEntry[] = JSON.parse(readFileSync("tests/backtest/test_pool_100.json", "utf8"));
  const picked = sample(pool, N);
  console.log(`Sampled ${picked.length} of ${pool.length} pool entries.\n`);

  const config = appraiserConfigs.find((c) => c.id === "claude-4stage")!;
  const appraiser = new FourStageAppraiser(config) as any; // reach protected stage methods — established pattern (see run_stage1c.ts)

  const results = await runWithConcurrency(picked, CONCURRENCY, async (entry, i) => {
    const label = `[${i + 1}/${picked.length}] ${entry.artistName} — "${entry.title}"`;
    console.log(`${label} — fetching image...`);
    const fetched = await appraiser.fetchImageAsBase64(entry.imageUrl);
    if (!fetched) {
      console.warn(`${label} — image fetch FAILED, skipping`);
      return { entry, fetchOk: false } as RowResult;
    }
    try {
      const [b, d] = await Promise.all([
        appraiser.runStage1bVisionSearch(fetched.base64, fetched.mimeType),
        appraiser.runStage1dEmbeddingMatch(fetched.base64, fetched.mimeType),
      ]);
      console.log(`${label} — done. 1b: ${b.bestMatchArtist ?? "none"} / 1d top: ${d.bestMatchArtist ?? "none"}`);
      return {
        entry,
        fetchOk: true,
        stage1b: {
          artist: b.bestMatchArtist ?? null,
          title: b.bestMatchTitle ?? null,
          similarity: b.visualSimilarityScore ?? null,
          compositionMatch: b.compositionMatch ?? null,
          confidence: b.matchConfidence ?? null,
        },
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
  writeFileSync("tests/backtest/output/stage1d_comparison.json", JSON.stringify(results, null, 2));
  console.log(`\nWrote tests/backtest/output/stage1d_comparison.json`);

  // Markdown summary table
  const lines: string[] = [];
  lines.push("| # | Actual | Stage 1b (single best) | Stage 1d top 3 |");
  lines.push("|---|---|---|---|");
  results.forEach((r, i) => {
    const actual = `${r.entry.artistName} — *${r.entry.title}*`;
    if (!r.fetchOk) { lines.push(`| ${i + 1} | ${actual} | _image fetch failed_ | _image fetch failed_ |`); return; }
    if (r.error) { lines.push(`| ${i + 1} | ${actual} | _error: ${r.error}_ | _error_ |`); return; }
    const b = r.stage1b!;
    const bCell = b.artist
      ? `${b.artist} — *${b.title ?? "?"}* (sim=${b.similarity ?? "—"}, ${b.compositionMatch}, ${b.confidence})`
      : "_no match_";
    const dCell = r.stage1d!.top.length
      ? r.stage1d!.top.map((c) => `${c.artist} — *${c.title ?? "?"}* (dino=${c.dino?.toFixed(3) ?? "—"}, clip=${c.clip?.toFixed(3) ?? "—"})`).join("<br>")
      : "_no match_";
    lines.push(`| ${i + 1} | ${actual} | ${bCell} | ${dCell} |`);
  });
  const table = lines.join("\n");
  writeFileSync("tests/backtest/output/stage1d_comparison.md", table);
  console.log(`Wrote tests/backtest/output/stage1d_comparison.md\n`);
  console.log(table);

  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
