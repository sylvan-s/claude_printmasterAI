/**
 * Forum Auctions extractor.
 *
 * Emits catalogue.csv with the SAME column schema as the Roseberys extract, plus
 * `source` and `sale_date`, so the two can be concatenated for PrintMaster AI.
 *
 *   npm run forum:fetch -- --auction 32
 *   npm run forum:fetch -- --all-prints
 *   npm run forum:fetch -- --all-prints --no-dates      (skip the per-sale date fetch)
 *
 * Honours robots.txt crawl-delay: 15s between every request.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchAuctionLots, fetchSaleDate, hammerOf, isSold, imageUrl, lotUrl, DELAY_MS,
  type RawLot,
} from "./api.js";
import { discoverAuctions, filterPrintSales, type AuctionRef } from "./discover.js";
import { parseDescription, type ParsedLot } from "./parse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "..", "data", "forum");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same column order as the Roseberys catalogue.csv, prefixed with source + date.
const COLUMNS = [
  "source", "sale_date", "sale_code", "auction_id", "lot_number", "artist", "title", "year",
  "medium", "support", "width_cm", "height_cm", "edition_size",
  "signed", "framed", "low_estimate", "high_estimate", "hammer",
  "price_realised_inc_premium", "sold", "ratio_to_high_est", "ratio_to_low_est",
  "artist_qualifier", "other_artists", "nationality", "life_dates",
  "dim_kind", "edition_note", "printer", "publisher", "catalogue_refs",
  "multi_work", "arr", "reserve", "hammer_basis", "premium_ratio_used",
  "provenance", "lot_url", "image_url",
];

function parseArgs(argv: string[]) {
  const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    auction: get("--auction") ? Number(get("--auction")) : undefined,
    allPrints: argv.includes("--all-prints"),
    noDates: argv.includes("--no-dates"),
    keepRaw: argv.includes("--keep-raw"),
    out: get("--out") ?? DEFAULT_OUT,
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: Record<string, unknown>[]): string {
  const lines = ["﻿" + COLUMNS.join(",")];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n");
}

function row(lot: RawLot, p: ParsedLot, sale: AuctionRef, saleDate: string | null) {
  // Forum's hammer_price IS the true hammer — no premium reconstruction.
  // Premium-inclusive figure isn't published per-lot, so leave it blank.
  const hammer = hammerOf(lot);
  const dim = p.dimensions[0];
  return {
    source: "Forum",
    sale_date: saleDate ?? "",
    sale_code: sale.saleCode,
    auction_id: lot.auction_id,
    lot_number: lot.lot_number,
    artist: p.artist ?? "",
    title: p.title ?? "",
    year: p.year ?? "",
    medium: p.medium ?? "",
    support: p.support ?? "",
    width_cm: dim?.widthCm ?? "",
    height_cm: dim?.heightCm ?? "",
    edition_size: p.editionSize ?? "",
    signed: p.signed ? "yes" : "no",
    framed: p.framed ? "yes" : "no",
    low_estimate: lot.low_estimate ?? "",
    high_estimate: lot.high_estimate ?? "",
    hammer: hammer ?? "",
    price_realised_inc_premium: "",       // not published per-lot at Forum
    sold: isSold(lot) ? "sold" : "unsold",
    ratio_to_high_est: hammer && lot.high_estimate ? +(hammer / lot.high_estimate).toFixed(3) : "",
    ratio_to_low_est: hammer && lot.low_estimate ? +(hammer / lot.low_estimate).toFixed(3) : "",
    artist_qualifier: p.artistQualifier,
    other_artists: p.additionalArtists.join("; "),
    nationality: p.nationality ?? "",
    life_dates: p.lifeDates ?? "",
    dim_kind: dim?.kind ?? "",
    edition_note: p.edition ?? "",
    printer: p.printer ?? "",
    publisher: p.publisher ?? "",
    catalogue_refs: p.catalogueRefs.join("; "),
    multi_work: p.isMultiWork ? (p.multiWorkReason ?? "yes") : "",
    arr: lot.got_arr ? "yes" : "no",
    reserve: lot.reserve_price || "",
    hammer_basis: hammer ? "reported" : "",   // always reported at Forum, never derived
    premium_ratio_used: "",
    provenance: p.provenance ?? "",
    lot_url: lotUrl(lot),
    image_url: imageUrl(lot) ?? "",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.auction && !args.allPrints) {
    console.error("Specify --auction <id> or --all-prints.");
    process.exit(1);
  }

  await mkdir(args.out, { recursive: true });
  const rawDir = join(args.out, "raw");
  await mkdir(rawDir, { recursive: true });

  console.log("Discovering auctions via sitemaps (15s crawl-delay honoured)...");
  const all = await discoverAuctions();
  const byId = new Map(all.map((a) => [a.auctionId, a]));
  console.log(`  ${all.length} auctions found`);

  const targets: AuctionRef[] = args.allPrints
    ? filterPrintSales(all)
    : [byId.get(args.auction!) ?? { auctionId: args.auction!, slug: "", saleCode: "", url: "" }];
  console.log(`Target sales: ${targets.length}${args.allPrints ? " (prints & editions)" : ""}`);

  const rows: Record<string, unknown>[] = [];
  let first = true;
  for (const sale of targets) {
    if (!first) await sleep(DELAY_MS);
    first = false;

    process.stdout.write(`  ${sale.saleCode || sale.auctionId} (${sale.auctionId}) ... `);
    let lots: RawLot[];
    try {
      lots = await fetchAuctionLots(sale.auctionId);
    } catch (err: any) {
      console.log(`FAILED: ${err.message}`);
      continue;
    }

    let saleDate: string | null = null;
    if (!args.noDates && sale.url) {
      await sleep(DELAY_MS);
      try { saleDate = await fetchSaleDate(sale.url); } catch { /* non-fatal */ }
    }

    await writeFile(join(rawDir, `${sale.auctionId}.json`), JSON.stringify(lots, null, 2));

    let live = 0, sold = 0;
    for (const lot of lots) {
      if (lot.withdrawn || !lot.published) continue;
      live++;
      if (isSold(lot)) sold++;
      rows.push(row(lot, parseDescription(lot.description || ""), sale, saleDate));
    }
    console.log(`${String(live).padStart(3)} lots · ${String(sold).padStart(3)} sold · ${saleDate ?? "date n/a"}`);
  }

  const csvPath = join(args.out, "catalogue.csv");
  await writeFile(csvPath, toCsv(rows), "utf8");
  console.log(`\n✓ ${rows.length} rows → ${csvPath}`);

  if (!args.keepRaw && existsSync(rawDir)) {
    await rm(rawDir, { recursive: true, force: true });
    console.log("  (raw API dumps discarded — pass --keep-raw to retain)");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
