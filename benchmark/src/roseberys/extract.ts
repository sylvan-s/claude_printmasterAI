/**
 * Roseberys extractor — one parser, two outputs.
 *
 *   1. catalogue.csv   → the search extract for Roseberys staff (opens in Excel)
 *   2. lots/*.json     → benchmark lot records for issue #12
 *
 * Usage:
 *   npm run bench:fetch -- --auction 665
 *   npm run bench:fetch -- --all-prints
 *   npm run bench:fetch -- --auction 665 --benchmark --images
 *
 * Flags:
 *   --auction <id>    one sale by auction_id
 *   --all-prints      every Prints & Multiples sale in the sitemap (43 as of 2026-08)
 *   --department <kw> slug keyword to match (default "print"); use with --all-prints
 *   --benchmark       also emit benchmark lot records (facts only, no raw prose)
 *   --images          download lot images into the gitignored cache + checksums
 *   --out <dir>       output root (default benchmark/data)
 *   --keep-raw        retain the raw API dump instead of deleting after extraction
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { fetchAuctionLots, imageUrl, lotUrl, impliedPremiumRatio, UA, type RawLot } from "./api.js";
import { discoverAuctions, filterByKeyword, type AuctionRef } from "./discover.js";
import { parseDescription, type ParsedLot } from "./parse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "..", "data");

/* ------------------------------------------------------------------- CLI */

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    auction: get("--auction") ? Number(get("--auction")) : undefined,
    allPrints: argv.includes("--all-prints"),
    department: get("--department") ?? "print",
    benchmark: argv.includes("--benchmark"),
    images: argv.includes("--images"),
    keepRaw: argv.includes("--keep-raw"),
    out: get("--out") ?? DEFAULT_OUT,
  };
}

/* ------------------------------------------------------------------- CSV */

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))];
  // BOM so Excel reads UTF-8 correctly — without it, Miró and Dürer arrive mangled.
  return "﻿" + lines.join("\r\n");
}

/* ------------------------------------------------------- row construction */

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

function catalogueRow(lot: RawLot, p: ParsedLot, sale: AuctionRef | null) {
  // rostrum_hammer is the TRUE hammer. hammer_price is premium-inclusive and can
  // be stale on unsold lots — `sold` is the only authoritative flag.
  const hammer = lot.sold ? lot.rostrum_hammer : null;
  const realised = lot.sold ? num(lot.hammer_price) : null;
  const dim = p.dimensions[0];

  return {
    sale_code: sale?.saleCode ?? "",
    auction_id: lot.auction_id,
    lot_number: lot.lot_number,
    artist: p.artist ?? "",
    artist_qualifier: p.artistQualifier,
    other_artists: p.additionalArtists.join("; "),
    nationality: p.nationality ?? "",
    life_dates: p.lifeDates ?? "",
    title: p.title ?? "",
    year: p.year ?? "",
    medium: p.medium ?? "",
    support: p.support ?? "",
    dim_kind: dim?.kind ?? "",
    width_cm: dim?.widthCm ?? "",
    height_cm: dim?.heightCm ?? "",
    edition_size: p.editionSize ?? "",
    edition_note: p.edition ?? "",
    signed: p.signed ? "yes" : "no",
    framed: p.framed ? "yes" : "no",
    printer: p.printer ?? "",
    publisher: p.publisher ?? "",
    catalogue_refs: p.catalogueRefs.join("; "),
    multi_work: p.isMultiWork ? (p.multiWorkReason ?? "yes") : "",
    arr: lot.got_arr ? "yes" : "no",
    low_estimate: lot.low_estimate ?? "",
    high_estimate: lot.high_estimate ?? "",
    reserve: lot.reserve_price ?? "",
    hammer,
    price_realised_inc_premium: realised,
    sold: lot.sold ? "sold" : "unsold",
    // The number valuers actually want: performance against top estimate.
    ratio_to_high_est:
      hammer && lot.high_estimate ? +(hammer / lot.high_estimate).toFixed(3) : "",
    ratio_to_low_est:
      hammer && lot.low_estimate ? +(hammer / lot.low_estimate).toFixed(3) : "",
    provenance: p.provenance ?? "",
    lot_url: lotUrl(lot),
    image_url: imageUrl(lot) ?? "",
  };
}

/** Benchmark record per issue #12. Facts only — raw catalogue prose is NOT retained. */
function benchmarkRecord(lot: RawLot, p: ParsedLot, sale: AuctionRef | null) {
  const dims = p.dimensions;
  const pickDim = (k: string) => dims.find((d) => d.kind.includes(k));
  const fmt = (d?: { widthCm: number | null; heightCm: number | null }) =>
    d?.widthCm && d?.heightCm ? `${d.widthCm} x ${d.heightCm} cm` : null;

  return {
    lotId: `RB-${sale?.saleCode || lot.auction_id}-${lot.lot_number}`,
    sourceSale: sale ? `${sale.saleCode} (auction_id ${lot.auction_id})` : String(lot.auction_id),
    lotNumber: String(lot.lot_number),
    imageRef: { url: imageUrl(lot), sha256: null as string | null, cachedAs: null as string | null },

    // INPUT — supplied in both run modes. Physical facts only.
    observed: {
      sheetDimensions: fmt(pickDim("sheet")),
      plateDimensions: fmt(pickDim("plate")),
      imageDimensions: fmt(pickDim("image")),
      medium: p.medium,
      support: p.support,
      inscriptions: p.inscriptions,
      editionSize: p.editionSize,
      framed: p.framed,
    },

    // LABEL — withheld in blind mode.
    houseAttribution: {
      artist: p.artist,
      artistQualifier: p.artistQualifier,
      additionalArtists: p.additionalArtists,
      title: p.title,
      date: p.year,
      catalogueRefs: p.catalogueRefs,
    },

    // LABEL — valuation outcome. hammer is rostrum_hammer, NOT premium-inclusive.
    outcome: {
      currency: "GBP",
      estimateLow: lot.low_estimate,
      estimateHigh: lot.high_estimate,
      reserve: lot.reserve_price,
      hammerPrice: lot.sold ? lot.rostrum_hammer : null,
      priceRealisedIncPremium: lot.sold ? num(lot.hammer_price) : null,
      sold: Boolean(lot.sold),
      premiumInclusive: false,
    },

    // Rights posture — ARR flags an artwork whose artist copyright is likely live.
    rights: { artistResaleRight: Boolean(lot.got_arr) },

    expectedSpecialistConfig: null as string | null, // assigned during stratification
    reviewFlags: {
      isMultiWork: p.isMultiWork,
      multiWorkReason: p.multiWorkReason,
      leakRisks: p.leakRisks,     // must be cleared by hand before blind-mode use
      needsReview: p.leakRisks.length > 0 || !p.artist || !p.medium,
    },
  };
}

/* ------------------------------------------------------------------ images */

async function downloadImage(url: string, destDir: string, name: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`image ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const ext = url.split(".").pop()?.split("?")[0] || "webp";
  const filename = `${name}.${ext}`;
  await writeFile(join(destDir, filename), buf);
  return { sha256, filename, bytes: buf.length };
}

/* -------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.auction && !args.allPrints) {
    console.error("Specify --auction <id> or --all-prints. See header for flags.");
    process.exit(1);
  }

  await mkdir(args.out, { recursive: true });
  const rawDir = join(args.out, "raw");
  await mkdir(rawDir, { recursive: true });

  console.log("Discovering auctions via sitemap...");
  const all = await discoverAuctions();
  const byId = new Map(all.map((a) => [a.auctionId, a]));
  console.log(`  ${all.length} auctions in sitemap`);

  const targets: AuctionRef[] = args.allPrints
    ? filterByKeyword(all, args.department)
    : [byId.get(args.auction!) ?? { auctionId: args.auction!, slug: "", saleCode: "", url: "" }];

  console.log(`Target sales: ${targets.length}`);

  const csvRows: Record<string, unknown>[] = [];
  const benchRecords: ReturnType<typeof benchmarkRecord>[] = [];

  for (const sale of targets) {
    process.stdout.write(`  ${sale.saleCode || sale.auctionId} (${sale.auctionId}) ... `);
    let lots: RawLot[];
    try {
      lots = await fetchAuctionLots(sale.auctionId);
    } catch (err: any) {
      console.log(`FAILED: ${err.message}`);
      continue;
    }

    await writeFile(join(rawDir, `${sale.auctionId}.json`), JSON.stringify(lots, null, 2));

    let live = 0;
    for (const lot of lots) {
      if (lot.withdrawn || !lot.published) continue;
      live++;
      const parsed = parseDescription(lot.description || "");
      csvRows.push(catalogueRow(lot, parsed, sale));
      if (args.benchmark && !parsed.isMultiWork) {
        benchRecords.push(benchmarkRecord(lot, parsed, sale));
      }
    }

    const ratios = lots.map(impliedPremiumRatio).filter((r): r is number => r !== null);
    const medianRatio = ratios.length
      ? ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)].toFixed(3)
      : "n/a";
    console.log(`${live} lots (premium ratio ~${medianRatio})`);
  }

  // 1. The Roseberys gift.
  const csvPath = join(args.out, "catalogue.csv");
  await writeFile(csvPath, toCsv(csvRows), "utf8");
  console.log(`\n✓ ${csvRows.length} rows → ${csvPath}`);

  // 2. Benchmark corpus.
  if (args.benchmark) {
    const lotsDir = join(args.out, "lots");
    await mkdir(lotsDir, { recursive: true });

    if (args.images) {
      const imgDir = join(args.out, "images");
      await mkdir(imgDir, { recursive: true });
      console.log(`Downloading ${benchRecords.length} images...`);
      for (const rec of benchRecords) {
        if (!rec.imageRef.url) continue;
        try {
          const { sha256, filename } = await downloadImage(rec.imageRef.url, imgDir, rec.lotId);
          rec.imageRef.sha256 = sha256;
          rec.imageRef.cachedAs = filename;
        } catch (err: any) {
          console.warn(`  ! ${rec.lotId}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 250)); // be a good guest
      }
    }

    for (const rec of benchRecords) {
      await writeFile(join(lotsDir, `${rec.lotId}.json`), JSON.stringify(rec, null, 2));
    }

    const needsReview = benchRecords.filter((r) => r.reviewFlags.needsReview).length;
    console.log(`✓ ${benchRecords.length} benchmark records → ${lotsDir}`);
    console.log(`  ${needsReview} flagged for manual review before blind-mode use`);
  }

  // Raw dumps are a re-derivation aid, not a corpus. Drop unless asked to keep.
  if (!args.keepRaw && existsSync(rawDir)) {
    await rm(rawDir, { recursive: true, force: true });
    console.log("  (raw API dumps discarded — pass --keep-raw to retain)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
