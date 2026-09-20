// Run the real appraisal pipeline once PER WORK of a multi-work lot.
//
// tests/backtest/run_backtest.ts feeds a lot's PRIMARY image and its WHOLE description. For a
// multi-work lot that is the wrong input twice over: the primary photo is usually a group shot
// of every print in the lot, and the description covers all of them. This harness takes
// knowledge_graph/roseberys_multi_work_parse.py's output instead and, for each work the gate
// passed, feeds the photo matched to THAT work plus only that work's own catalogue facts.
//
// Blindness follows the backtest's convention: the artist name and the title are never sent —
// they are what the pipeline is meant to reach on its own — and neither is the lot's estimate.
// What goes in is the physical description (technique, support, dimensions, edition) the way an
// appraiser holding that one sheet would transcribe it. Anything the catalogue states about the
// lot as a whole and does not attribute to an individual work (e.g. "one signed in pencil" over
// two sheets) is passed as exactly that — an ambiguous lot-level note — never resolved to a work.
//
// Usage (source .env first):
//   npx tsx tests/multi_work/run_multi_work_appraisal.ts --in parsed.json [--lot 20] [--method claude-4stage]

import dotenv from "dotenv";
dotenv.config();

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { appraiserConfigs, getAppraiserFromConfig, type AppraisalInput } from "../../src/appraisal/appraiser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_METHOD = "claude-4stage";

interface ParsedWork {
  position: number;
  artist: string | null;
  title: string | null;
  year: number | null;
  medium: string | null;
  support: string | null;
  dim_kind: string | null;
  width_cm: number | null;
  height_cm: number | null;
  edition_size: number | null;
  edition_number: string | null;
  signed: boolean | null;
  catalogue_refs: string | null;
  copies: number;
  evidence: string;
}

interface ParsedLot {
  sale: string;
  lot: number;
  url: string;
  entry: string;
  money: Record<string, number | boolean | null>;
  decision: string;
  reasons: string[];
  parser: string;
  photo_urls?: string[];
  text: { lot_kind: string; declared_count: number | null; works: ParsedWork[] };
  vision?: { assignments: { work_position: number; photo_index: number | null; confidence: string }[] };
}

function parseArgs(argv: string[]) {
  let infile: string | undefined, lot: number | undefined, method = DEFAULT_METHOD;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") infile = argv[++i];
    else if (argv[i] === "--lot") lot = Number(argv[++i]);
    else if (argv[i] === "--method") method = argv[++i];
    else throw new Error(`Unrecognised argument: ${argv[i]}`);
  }
  if (!infile) throw new Error("--in <parser output json> is required");
  return { infile, lot, method };
}

async function downloadImageBase64(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: res.headers.get("content-type") || "image/jpeg" };
}

/** The lot's body text with the header stripped: Roseberys puts artist, nationality and the
 *  title list in the opening lines, and sending those would tell the pipeline the two answers
 *  it exists to produce. Anything still naming a title or the artist's surname is dropped and
 *  reported, so a leak is visible in the run log rather than silent. */
function blindBody(lot: ParsedLot): { text: string; dropped: string[] } {
  const lines = lot.entry.split(/\nProvenance|\nNote:/)[0].split("\n").map((l) => l.trim()).filter(Boolean);
  const titles = lot.text.works.map((w) => (w.title || "").toLowerCase()).filter(Boolean);
  const surnames = lot.text.works
    .flatMap((w) => (w.artist || "").split(/\s+/))
    .filter((t) => t.length > 3)
    .map((t) => t.toLowerCase());
  const names = [...titles, ...surnames];
  const kept: string[] = [], dropped: string[] = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    (names.some((n) => low.includes(n)) ? dropped : kept).push(line);
  }
  return { text: kept.join("\n"), dropped };
}

/** This work's own physical facts — no artist, no title, no estimate. Lot-level statements that
 *  the catalogue does not pin to one work are reported as ambiguous rather than assigned. */
function workNotes(work: ParsedWork, lot: ParsedLot): string {
  const lines: string[] = [];
  const medium = [work.medium, work.support && !work.medium?.includes(work.support) ? `on ${work.support}` : null]
    .filter(Boolean).join(" ");
  if (medium) lines.push(medium);
  if (work.width_cm && work.height_cm) {
    lines.push(`${work.dim_kind && work.dim_kind !== "null" ? work.dim_kind : "dimensions"}: ${work.width_cm} x ${work.height_cm} cm`);
  }
  if (work.edition_number) lines.push(`numbered ${work.edition_number}`);
  if (work.edition_size) lines.push(`from an edition of ${work.edition_size}`);
  if (work.year) lines.push(`dated ${work.year}`);
  // Only report a signature when the catalogue pinned it to THIS work. The test is whether this
  // work's evidence quote differs from its siblings' — identical quotes mean the model had no
  // per-work evidence and guessed, which is what qwen-plus did on A0793 lot 20 ("one signed in
  // pencil" over two sheets). That guess reached Stage 1c as a documented claim, Stage 2a logged
  // it as a conflict against VEA's illegible read, and the lot routed to human escalation on a
  // fact the catalogue never stated. Same rule as roseberys_multi_work_ingest.py.
  const perWorkEvidence = new Set(lot.text.works.map((w) => w.evidence)).size === lot.text.works.length;
  if (work.signed === true && perWorkEvidence) lines.push("signed in pencil");
  else if (lot.text.works.some((w) => w.signed) && !perWorkEvidence) {
    lines.push("the catalogue states that one sheet in the lot is signed in pencil, without saying which");
  }
  const n = lot.text.works.length;
  lines.push(
    `This sheet was catalogued as one of ${n} works offered together in a single auction lot; ` +
    `the description below covers the whole lot, and only the parts naming this sheet apply to it.`,
  );
  const body = blindBody(lot);
  if (body.text) lines.push(`Lot description as printed (artist and titles withheld): ${body.text}`);
  return lines.join("\n");
}

async function main() {
  const { infile, lot: lotFilter, method } = parseArgs(process.argv.slice(2));
  const records: ParsedLot[] = JSON.parse(readFileSync(infile, "utf-8"));
  const lots = records.filter((r) => (lotFilter === undefined || r.lot === lotFilter));
  if (!lots.length) throw new Error(`No lot matched in ${infile}`);

  const config = appraiserConfigs.find((c) => c.id === method);
  if (!config) throw new Error(`Unknown method "${method}"`);
  const geminiKey = process.env.GEMINI_API_KEY;
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined;

  for (const lot of lots) {
    if (lot.decision !== "split" && lot.decision !== "single") {
      console.log(`[MultiWork] ${lot.sale} lot ${lot.lot}: decision is "${lot.decision}" — skipping (${lot.reasons.join("; ")})`);
      continue;
    }
    // A single lot (a complete portfolio, or one print with extras) has no vision pass, so its
    // one work takes the lot's primary photo — which for a portfolio is the right picture: the
    // group shot IS the object being sold.
    const photoFor = lot.decision === "single"
      ? new Map<number, number | null>(lot.text.works.map((w) => [w.position, 0]))
      : new Map<number, number | null>(
          (lot.vision?.assignments ?? []).map((a) => [a.work_position, a.photo_index]));
    const outDir = `${__dirname}/output/${lot.sale}-${lot.lot}`;
    mkdirSync(outDir, { recursive: true });

    for (const work of lot.text.works) {
      const idx = photoFor.get(work.position);
      const url = idx != null ? lot.photo_urls?.[idx] : undefined;
      if (!url) {
        console.log(`[MultiWork] work ${work.position} has no matched photo — skipping`);
        continue;
      }
      const unit = lot.text.lot_kind === "complete_portfolio"
        ? `portfolio of ${lot.text.declared_count ?? "?"} plates, priced whole`
        : `work ${work.position}/${lot.text.works.length}`;
      console.log(`\n[MultiWork] ${lot.sale} lot ${lot.lot} ${unit} — photo ${idx}`);
      const dropped = blindBody(lot).dropped;
      if (dropped.length) console.log(`[MultiWork] withheld from notes (names artist/title): ${JSON.stringify(dropped)}`);
      const { base64, mimeType } = await downloadImageBase64(url);
      const input: AppraisalInput = {
        imageBase64: base64,
        mimeType,
        currency: "GBP",
        catalogueNotes: workNotes(work, lot),
        testingExcludeSourceListing: `Roseberys, sale ${lot.sale}, lot ${lot.lot} (${lot.url})`,
      };
      // The attributed path verifies the house's own claim instead of deriving one, so it needs
      // the claim itself — and for a multi-work lot that claim is PER WORK: this work's title,
      // edition and share of the estimate, not the lot's. The blindness convention above does
      // not apply here; withholding the artist from the path whose whole job is to check the
      // artist would be testing nothing. An equal split is what the graph records for these
      // records, so it is what the claim states (see roseberys_multi_work_ingest.py).
      if (config.attributedLotPath) {
        // A portfolio is sold whole, so its claim carries the WHOLE estimate — dividing by the
        // plate count would price a plate the house never offered separately.
        const n = lot.decision === "single" ? 1 : lot.text.works.length;
        const perWork = (v: number | null | undefined) => (v == null ? null : Number(v) / n);
        input.catalogueAttribution = {
          artist: work.artist ?? "",
          artistQualifier: "certain",
          title: work.title,
          year: work.year != null ? String(work.year) : null,
          medium: work.medium,
          editionNote: work.edition_number ? `numbered ${work.edition_number}` : null,
          editionSize: work.edition_size,
          signed: work.signed,
          dimensions: work.width_cm && work.height_cm
            ? [{ kind: work.dim_kind || "sheet", widthCm: work.width_cm, heightCm: work.height_cm }]
            : null,
          catalogueRefs: work.catalogue_refs ? [work.catalogue_refs] : null,
          estimateLow: perWork(lot.money.estimateLow as number | null),
          estimateHigh: perWork(lot.money.estimateHigh as number | null),
          estimateCurrency: "GBP",
          house: "Roseberys London",
          saleId: lot.sale,
          lotNumber: lot.lot,
          lotUrl: lot.url,
          sourceExcerpt: `${lot.entry.split("\n").slice(0, 4).join(" ").trim()} — work ${work.position} of ${n} in the lot; the estimate shown is this work's ${Math.round(100 / n)}% share of the lot's.`,
        };
      }
      const appraiser = getAppraiserFromConfig(config, ai);
      const t0 = Date.now();
      const report = await appraiser.appraise(input);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const path = `${outDir}/work${work.position}.json`;
      writeFileSync(path, JSON.stringify({
        lot: `${lot.sale}-${lot.lot}`, workPosition: work.position,
        catalogueTitle: work.title, catalogueArtist: work.artist,
        photoIndex: idx, photoUrl: url, method, parser: lot.parser,
        lotEstimate: { low: lot.money.estimateLow, high: lot.money.estimateHigh },
        perWorkEstimateShare: {
          low: lot.money.estimateLow ? Number(lot.money.estimateLow) / lot.text.works.length : null,
          high: lot.money.estimateHigh ? Number(lot.money.estimateHigh) / lot.text.works.length : null,
        },
        notesSent: input.catalogueNotes, elapsedSeconds: Number(secs), report,
      }, null, 2));
      console.log(`[MultiWork] ${secs}s — says "${report.likelyArtist}" / "${report.artworkTitle}"`);
      console.log(`[MultiWork] catalogue says: "${work.artist}" / "${work.title}" -> ${path}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
