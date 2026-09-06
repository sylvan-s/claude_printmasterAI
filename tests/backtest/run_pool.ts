/**
 * Batch-run Stage 1a (VEA) + Stage 1b (Visual Search) + Stage 1c (Appraiser Input)
 * against the stratified test pool (tests/backtest/test_pool_100.json), and store
 * the results as a reusable fixture. Triage versions are then evaluated against the
 * stored fixture with no further pipeline runs — see run_pool_triage.ts (TBD).
 *
 * Only Stages 1a/1b/1c run — nothing downstream. The three run concurrently per lot,
 * exactly as FourStageAppraiser does.
 *
 *   npm run test:pool -- --limit 10                 # 10 lots (default)
 *   npm run test:pool -- --limit 99 --concurrency 3 # whole pool
 *   npm run test:pool -- --resume                   # skip lots already done
 *   npm run test:pool -- --method gemini-3stage     # Gemini VEA instead of Opus
 *
 * Output: tests/backtest/pool_output/<saleId>_<lot>/stage1.json  (gitignored)
 */
import dotenv from "dotenv";
dotenv.config();

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import {
  FourStageAppraiser,
  appraiserConfigs,
  type AppraisalInput,
  type AppraisalMethodConfig,
} from "../../src/appraisal/appraiser";

import { resolveSaleRef } from "../../benchmark/src/roseberys/discover";
import { fetchLotByNumber as rosFetchLot, imageUrl as rosImageUrl, lotUrl as rosLotUrl } from "../../benchmark/src/roseberys/api";
import { parseDescription as rosParse } from "../../benchmark/src/roseberys/parse";
import { fetchAuctionLots as forumFetchAuction, imageUrl as forumImageUrl, lotUrl as forumLotUrl, type RawLot as ForumRawLot } from "../../benchmark/src/forum/api";
import { parseDescription as forumParse } from "../../benchmark/src/forum/parse";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POOL_PATH = join(__dirname, "test_pool_100.json");
const OUT_ROOT = join(__dirname, "pool_output");

// ── args ─────────────────────────────────────────────────────────────────────
function intArg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
function strArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const LIMIT = intArg("limit", 10);
const OFFSET = intArg("offset", 0);
const CONCURRENCY = intArg("concurrency", 3);
const METHOD = strArg("method", "claude-4stage");
const HOUSE_FILTER = strArg("house", "");
const RESUME = process.argv.includes("--resume");
const FETCH_ONLY = process.argv.includes("--fetch-only"); // resolve + download image, skip all LLM calls
const SHUFFLE_SEED = intArg("shuffle", 0); // >0 = seeded shuffle before slicing (spread across houses/techniques)

interface PoolLot {
  house: string;
  techBucket: string;
  bracket: string;
  saleId: string;
  lotNumber: number;
  listingUrl: string;
  auctionInternalId?: number | null;
  estimateLow: number;
  estimateHigh: number;
  artistName: string; // ground-truth — never fed to the pipeline
  title: string; // ground-truth
  // TESTPOOL-1.1: image + structured lot fields straight from the ACKG, so a run
  // needs no live auction-site round-trip.
  imageUrl?: string | null;
  datePeriod?: string | null;
  techniques?: string[];
  papers?: string[];
  rawMedium?: string | null;
  dimensions?: string | null;
  dimKind?: "plate" | "sheet" | "image" | null;
  copyType?: string | null;
  editionSize?: number | null;
  signed?: boolean | null;
  catalogueRefsRaw?: string | null;
  provenanceNote?: string | null;
}

// ── a FourStageAppraiser that stops after Stage 1 ─────────────────────────────
class Stage1PoolRunner extends FourStageAppraiser {
  async runStage1Only(input: AppraisalInput) {
    const stage1Model = this.config.stage1Model || this.config.modelName;
    const runVisualSearch = this.config.enableVisualSearch !== false;
    const ai = (this as any).getClient() as GoogleGenAI;

    const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
      const t0 = Date.now();
      const value = await fn();
      return { value, ms: Date.now() - t0 };
    };

    const veaP = timed(() => (this as any).runStage1VEA(input, stage1Model, ai));
    const vsP = runVisualSearch
      ? timed(() => (this as any).runStage1bVisionSearch(input.imageBase64, input.mimeType))
      : Promise.resolve({ value: undefined, ms: 0 });
    const aiaP = timed(() =>
      (this as any).runStage1cAppraiserInput({
        inscribedMarksNotes: input.inscribedMarksNotes,
        provenanceNotes: input.provenanceNotes,
        conditionNotes: input.conditionNotes,
        catalogueNotes: input.catalogueNotes,
      }),
    );

    const [vea, vs, aia] = await Promise.all([veaP, vsP, aiaP]);
    return {
      stage1Model,
      stage1bModel: this.config.stage1bModel || "gemini-3.7-flash",
      vea: vea.value,
      visualSearch: vs.value,
      appraiserInput: aia.value,
      timings: { veaMs: vea.ms, visualSearchMs: vs.ms, appraiserInputMs: aia.ms },
    };
  }
}

// ── fetch a lot's image + catalogue, routed by house ─────────────────────────
const forumAuctionCache = new Map<string, ForumRawLot[]>();

const MIN_IMAGE_BYTES = 6000; // guard against placeholder / broken images
const MAX_IMAGE_BYTES = 4_500_000; // Anthropic rejects images over ~5MB; fall back to the smaller CDN variant

/** Derive the media type from the URL extension. The S3 bucket Roseberys serves lot
 *  images from returns `binary/octet-stream` for `.webp`, which both the Anthropic and
 *  Gemini APIs reject — so trust the extension, not the Content-Type header. */
function mimeFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return (
    { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif" }[ext ?? ""] ??
    "image/jpeg"
  );
}

async function fetchImageOnce(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchImage(url: string): Promise<{ base64: string; mimeType: string }> {
  let buf = await fetchImageOnce(url);
  if (buf.length > MAX_IMAGE_BYTES && url.includes("/xlarge/")) {
    const smaller = url.replace("/xlarge/", "/large/");
    try {
      const alt = await fetchImageOnce(smaller);
      if (alt.length >= MIN_IMAGE_BYTES && alt.length <= MAX_IMAGE_BYTES) buf = alt;
    } catch {
      /* keep xlarge; the size check below will decide */
    }
  }
  if (buf.length < MIN_IMAGE_BYTES) throw new Error(`image too small (${buf.length}B) — likely a placeholder: ${url}`);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${(buf.length / 1e6).toFixed(1)}MB) even at /large/: ${url}`);
  return { base64: buf.toString("base64"), mimeType: mimeFromUrl(url) };
}

/** Surname-overlap check: pool ground-truth artist vs the parsed live lot. A mismatch
 *  means saleId/lotNumber resolved to the wrong lot (stale ACKG numbering) — warn, skip. */
function lotIdentityMatches(poolArtist: string, parsedArtist: string | null): boolean {
  if (!parsedArtist) return true; // blind harness: parser often has no artist line — not a mismatch signal
  const surnames = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 3),
    );
  const a = surnames(poolArtist);
  const b = surnames(parsedArtist);
  for (const t of a) if (b.has(t)) return true;
  return false;
}

async function fetchLot(lot: PoolLot) {
  if (lot.house === "Roseberys London") {
    const auction = await resolveSaleRef(lot.saleId);
    if (!auction) throw new Error(`Roseberys: could not resolve sale ${lot.saleId}`);
    const raw = await rosFetchLot(auction.auctionId, String(lot.lotNumber));
    if (!raw) throw new Error(`Roseberys: lot ${lot.lotNumber} not in sale ${lot.saleId}`);
    const img = rosImageUrl(raw);
    if (!img) throw new Error(`Roseberys: lot ${lot.lotNumber} has no image`);
    return { descriptionHtml: raw.description, imageUrl: img, lotUrl: rosLotUrl(raw), groundTruth: rosParse(raw.description) };
  }
  // Forum
  let lots = forumAuctionCache.get(lot.saleId);
  if (!lots) {
    lots = await forumFetchAuction(Number(lot.saleId));
    forumAuctionCache.set(lot.saleId, lots);
  }
  const target = String(lot.lotNumber).trim().toLowerCase();
  const raw = lots.find(
    (l) => String(l.lot_number).trim().toLowerCase() === target || String(l.total_lot_number).trim().toLowerCase() === target,
  );
  if (!raw) throw new Error(`Forum: lot ${lot.lotNumber} not in auction ${lot.saleId}`);
  const img = forumImageUrl(raw);
  if (!img) throw new Error(`Forum: lot ${lot.lotNumber} has no image`);
  return { descriptionHtml: raw.description, imageUrl: img, lotUrl: forumLotUrl(raw), groundTruth: forumParse(raw.description) };
}

type Notes = Pick<AppraisalInput, "inscribedMarksNotes" | "provenanceNotes" | "conditionNotes" | "catalogueNotes">;

/** Build the Stage 1c appraiser note from the ACKG's structured lot fields — the offline
 *  equivalent of transcribing the catalogue body. `rawMedium` often already contains the
 *  full catalogue sentence ("screenprint in colours, signed in pencil, edition of 40,
 *  sheet 64 x 90cm"); use it verbatim when so, otherwise assemble from the parts. */
function synthesizeNotes(lot: PoolLot): Notes {
  const raw = (lot.rawMedium ?? "").trim();
  let catalogue: string;
  if (raw.length > 40 && raw.includes(",")) {
    catalogue = raw;
  } else {
    const parts: string[] = [];
    const medium = raw || lot.techniques?.[0];
    const support = lot.papers?.[0];
    if (medium) parts.push(support ? `${medium} on ${support}` : medium);
    if (lot.datePeriod && !/^(null|none)$/i.test(lot.datePeriod)) parts.push(lot.datePeriod);
    const edn = [lot.copyType, lot.editionSize ? `from an edition of ${lot.editionSize}` : null].filter(Boolean);
    if (edn.length) parts.push(edn.join(", "));
    if (lot.signed === true) parts.push("signed");
    else if (lot.signed === false) parts.push("not hand-signed");
    if (lot.dimensions) parts.push(`${lot.dimKind ?? "sheet"} ${lot.dimensions}`);
    catalogue = parts.filter(Boolean).join(",\n");
  }
  if (lot.catalogueRefsRaw) catalogue += `\n\nCatalogue reference(s): ${lot.catalogueRefsRaw}`;
  // defensive: never let the artist's own name into the notes (the header line the
  // real harness withholds — it shouldn't be in `rawMedium`, but strip it if it is)
  const surname = lot.artistName.split(/\s+/).pop() ?? "";
  if (surname.length > 3) catalogue = catalogue.replace(new RegExp(`\\b${surname}\\b`, "gi"), "[artist]");
  return {
    catalogueNotes: catalogue.trim() || undefined,
    provenanceNotes: lot.provenanceNote?.trim() || undefined,
    inscribedMarksNotes: undefined,
    conditionNotes: undefined,
  };
}

interface Resolved {
  imageUrl: string;
  lotUrl: string;
  source: "ackg" | "live";
  notes: Notes;
  groundTruth: Record<string, unknown>;
}

/** TESTPOOL-1.1: if the pool record carries an image URL (from DigitalImage.sourceUrl),
 *  run fully offline — no auction-site round-trip. Fall back to the live API only for a
 *  pre-1.1 pool JSON. */
async function resolveLot(lot: PoolLot): Promise<Resolved> {
  if (lot.imageUrl) {
    return {
      imageUrl: lot.imageUrl,
      lotUrl: lot.listingUrl,
      source: "ackg",
      notes: synthesizeNotes(lot),
      groundTruth: {
        artist: lot.artistName,
        title: lot.title,
        year: lot.datePeriod ?? null,
        medium: lot.rawMedium ?? null,
        support: lot.papers?.[0] ?? null,
        dimensions: lot.dimensions ?? null,
        dimKind: lot.dimKind ?? null,
        editionSize: lot.editionSize ?? null,
        signed: lot.signed ?? null,
        provenance: lot.provenanceNote ?? null,
        catalogueRefs: lot.catalogueRefsRaw ?? null,
        source: "ackg",
      },
    };
  }
  const f = await fetchLot(lot);
  if (!lotIdentityMatches(lot.artistName, f.groundTruth.artist)) {
    throw new Error(`wrong-lot: pool "${lot.artistName}" vs live "${f.groundTruth.artist}" — stale ACKG lot numbering`);
  }
  const refsLine = f.groundTruth.catalogueRefs.length
    ? `Catalogue reference(s): ${f.groundTruth.catalogueRefs.join(", ")}`
    : null;
  return {
    imageUrl: f.imageUrl,
    lotUrl: f.lotUrl,
    source: "live",
    notes: {
      inscribedMarksNotes: f.groundTruth.inscriptions || undefined,
      provenanceNotes: f.groundTruth.provenance || undefined,
      conditionNotes: (f.groundTruth as { condition?: string | null }).condition || undefined,
      catalogueNotes: [f.groundTruth.bodyLines.join("\n"), refsLine].filter(Boolean).join("\n\n") || undefined,
    },
    groundTruth: { ...f.groundTruth, source: "live" },
  };
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const retryable = /\b(429|5\d\d|ECONNRESET|ETIMEDOUT|fetch failed|overloaded)\b/i.test(msg);
      if (i < attempts - 1 && retryable) {
        const wait = 10_000 * (i + 1);
        console.warn(`  ${label}: ${msg.slice(0, 120)} — retry in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// ── run ──────────────────────────────────────────────────────────────────────
const config: AppraisalMethodConfig | undefined = appraiserConfigs.find((c) => c.id === METHOD);
if (!config) {
  console.error(`Unknown --method "${METHOD}". Options: ${appraiserConfigs.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

const geminiKey = process.env.GEMINI_API_KEY;
const runner = new Stage1PoolRunner(config, geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined);

const allLots: PoolLot[] = JSON.parse(readFileSync(POOL_PATH, "utf8"));
let queue = allLots.filter((l) => !HOUSE_FILTER || l.house.toLowerCase().includes(HOUSE_FILTER.toLowerCase()));
if (SHUFFLE_SEED > 0) {
  let s = SHUFFLE_SEED;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
}
queue = queue.slice(OFFSET, OFFSET + LIMIT);

const outId = (l: PoolLot) => `${l.saleId}_${l.lotNumber}`;
if (RESUME) {
  const before = queue.length;
  queue = queue.filter((l) => !existsSync(join(OUT_ROOT, outId(l), "stage1.json")));
  console.log(`--resume: ${before - queue.length} already done, ${queue.length} to run`);
}

console.log(`\ntest pool Stage 1a/1b/1c fixture`);
console.log(`method: ${METHOD}  |  lots: ${queue.length}  |  concurrency: ${CONCURRENCY}\n`);

let done = 0;
let failed = 0;
const started = Date.now();

async function runOne(lot: PoolLot): Promise<void> {
  const id = outId(lot);
  const dir = join(OUT_ROOT, id);
  try {
    const res = await withRetry(`${id} resolve`, () => resolveLot(lot));
    const { base64, mimeType } = await withRetry(`${id} image`, () => fetchImage(res.imageUrl));
    if (FETCH_ONLY) {
      done++;
      const n = res.notes;
      console.log(
        `  ok  ${id.padEnd(14)} ${String(lot.artistName).slice(0, 22).padEnd(23)} [${res.source}] img ${(base64.length / 1365).toFixed(0)}KB  ` +
          `notes:${[n.inscribedMarksNotes && "inscr", n.provenanceNotes && "prov", n.catalogueNotes && "cat"].filter(Boolean).join("/") || "none"}`,
      );
      return;
    }
    const input: AppraisalInput = { imageBase64: base64, mimeType, currency: "GBP", ...res.notes };

    const t0 = Date.now();
    const r = await withRetry(`${id} pipeline`, () => runner.runStage1Only(input));
    const totalMs = Date.now() - t0;

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stage1.json"),
      JSON.stringify(
        {
          lot: {
            house: lot.house,
            saleId: lot.saleId,
            lotNumber: lot.lotNumber,
            listingUrl: lot.listingUrl,
            lotUrl: res.lotUrl,
            techBucket: lot.techBucket,
            bracket: lot.bracket,
            estimateLow: lot.estimateLow,
            estimateHigh: lot.estimateHigh,
          },
          groundTruth: { ...res.groundTruth, poolArtistName: lot.artistName, poolTitle: lot.title },
          resolvedFrom: res.source,
          method: METHOD,
          models: { stage1a: r.stage1Model, stage1b: r.stage1bModel, stage1c: "claude-haiku-4-5" },
          imageUrl: res.imageUrl,
          appraiserInputNotes: {
            inscribedMarksNotes: input.inscribedMarksNotes ?? null,
            provenanceNotes: input.provenanceNotes ?? null,
            conditionNotes: input.conditionNotes ?? null,
            catalogueNotes: input.catalogueNotes ?? null,
          },
          stage1a_vea: r.vea,
          // drop the retrieved reference image's base64 — big, and not needed to
          // evaluate triage against the fixture (the URL is kept)
          stage1b_visualSearch: r.visualSearch
            ? { ...(r.visualSearch as Record<string, unknown>), bestMatchImageBase64: undefined }
            : null,
          stage1c_appraiserInput: r.appraiserInput,
          timings: { ...r.timings, totalMs },
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    done++;
    const halt = (r.vea as any)?.imageAuthenticity?.haltRecommended ? " [VEA halt]" : "";
    console.log(
      `  ok  ${id.padEnd(14)} ${String(lot.artistName).slice(0, 22).padEnd(23)} ` +
        `vea ${(r.timings.veaMs / 1000).toFixed(0)}s / 1b ${(r.timings.visualSearchMs / 1000).toFixed(0)}s / 1c ${(r.timings.appraiserInputMs / 1000).toFixed(0)}s${halt}` +
        `  (${done + failed}/${queue.length})`,
    );
  } catch (err: any) {
    failed++;
    console.error(`  FAIL ${id.padEnd(14)} ${String(err?.message ?? err).slice(0, 160)}`);
  }
}

// simple concurrency pool
const work = [...queue];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
    while (work.length) {
      const lot = work.shift();
      if (lot) await runOne(lot);
    }
  }),
);

console.log(
  `\n${done} ok, ${failed} failed  —  ${((Date.now() - started) / 60000).toFixed(1)} min  —  written to tests/backtest/pool_output/\n`,
);
if (failed > 0) process.exitCode = 1;
