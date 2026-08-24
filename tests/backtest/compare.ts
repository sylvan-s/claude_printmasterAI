// Part 2 of the backtest harness: diff the app's blind PrintAnalysisReport against
// the withheld Roseberys catalogue facts (ParsedLot + RawLot). Pure functions, no
// I/O — kept separate from run_backtest.ts so the comparison logic can be unit
// tested/reasoned about independently of the network/pipeline calls.

import type { PrintAnalysisReport } from "../../src/types";
import type { ParsedLot } from "../../benchmark/src/roseberys/parse";
import type { RawLot } from "../../benchmark/src/roseberys/api";

export type NameMatch = "exact" | "partial" | "none" | "no_data";
export type TitleMatch = "high" | "low" | "no_data";

export interface ArtistComparison {
  app: string | null;
  auction: string | null;
  auctionQualifier: string;
  match: NameMatch;
}

export interface TitleComparison {
  app: string | null;
  auction: string | null;
  similarity: number; // 0-1 token-overlap score
  match: TitleMatch;
}

export interface EstimateComparison {
  appLow: number | null;
  appHigh: number | null;
  appCurrency: string | null;
  auctionLow: number | null;
  auctionHigh: number | null;
  rangesOverlap: boolean | null;
  midpointRatio: number | null; // app midpoint / auction midpoint
  verdict: "match" | "material_difference" | "no_data";
}

export interface BacktestComparison {
  artist: ArtistComparison;
  title: TitleComparison;
  estimate: EstimateComparison;
  materialDifferences: string[];
  overallVerdict: "consistent" | "material_differences_found";
}

function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compare artist names. Substring containment catches "Picasso" vs "Pablo Picasso";
 *  token overlap catches surname-only matches even when word order/middle names differ. */
export function compareArtistNames(app: string | null, auction: string | null): NameMatch {
  const na = normalize(app);
  const nb = normalize(auction);
  if (!na || !nb) return "no_data";
  if (na === nb) return "exact";
  if (na.includes(nb) || nb.includes(na)) return "partial";
  const ta = new Set(na.split(" ").filter((t) => t.length >= 3));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 3));
  for (const t of ta) if (tb.has(t)) return "partial";
  return "none";
}

/** Jaccard-ish token overlap on titles. Titles vary more in wording/translation
 *  than artist names, so this is a similarity score rather than a strict match. */
export function titleSimilarity(app: string | null, auction: string | null): number {
  const na = normalize(app);
  const nb = normalize(auction);
  if (!na || !nb) return 0;
  const ta = new Set(na.split(" ").filter((w) => w.length > 2));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

const TITLE_SIMILARITY_THRESHOLD = 0.34;

function compareTitles(app: string | null, auction: string | null): TitleComparison {
  if (!app || !auction) {
    return { app, auction, similarity: 0, match: "no_data" };
  }
  const similarity = titleSimilarity(app, auction);
  return { app, auction, similarity, match: similarity >= TITLE_SIMILARITY_THRESHOLD ? "high" : "low" };
}

/** "Match" if the ranges overlap, or failing that if the midpoints are within 2x
 *  of each other — auction estimates are themselves a range, not a point value,
 *  so a strict range-overlap-only check would flag adjacent, non-contradictory
 *  ranges as material differences. */
function compareEstimates(
  appLow: number | null | undefined,
  appHigh: number | null | undefined,
  appCurrency: string | null | undefined,
  auctionLow: number | null,
  auctionHigh: number | null,
): EstimateComparison {
  const base = {
    appLow: appLow ?? null,
    appHigh: appHigh ?? null,
    appCurrency: appCurrency ?? null,
    auctionLow,
    auctionHigh,
  };
  if (appLow == null || appHigh == null || auctionLow == null || auctionHigh == null) {
    return { ...base, rangesOverlap: null, midpointRatio: null, verdict: "no_data" };
  }
  const rangesOverlap = appLow <= auctionHigh && auctionLow <= appHigh;
  const appMid = (appLow + appHigh) / 2;
  const auctionMid = (auctionLow + auctionHigh) / 2;
  const midpointRatio = auctionMid > 0 ? appMid / auctionMid : null;
  const withinFactorOfTwo = midpointRatio != null && midpointRatio >= 0.5 && midpointRatio <= 2;
  return {
    ...base,
    rangesOverlap,
    midpointRatio,
    verdict: rangesOverlap || withinFactorOfTwo ? "match" : "material_difference",
  };
}

export function compareResults(report: PrintAnalysisReport, groundTruth: ParsedLot, lot: RawLot): BacktestComparison {
  const artistMatch = compareArtistNames(report.likelyArtist, groundTruth.artist);
  const title = compareTitles(report.artworkTitle, groundTruth.title);
  const estimate = compareEstimates(
    report.auctionEstimate?.lowEstimate,
    report.auctionEstimate?.highEstimate,
    report.auctionEstimate?.currency,
    lot.low_estimate,
    lot.high_estimate,
  );

  const materialDifferences: string[] = [];
  if (artistMatch === "none") {
    materialDifferences.push(
      `Artist mismatch: app said "${report.likelyArtist}", catalogue says "${groundTruth.artist ?? "(unattributed)"}"${
        groundTruth.artistQualifier !== "certain" ? ` (${groundTruth.artistQualifier})` : ""
      }.`,
    );
  } else if (artistMatch === "no_data") {
    materialDifferences.push("Artist: insufficient data to compare (missing on one side).");
  }
  if (title.match === "low") {
    materialDifferences.push(
      `Title mismatch: app said "${report.artworkTitle}", catalogue says "${groundTruth.title ?? "(untitled)"}".`,
    );
  } else if (title.match === "no_data") {
    materialDifferences.push("Title: insufficient data to compare (missing on one side).");
  }
  if (estimate.verdict === "material_difference") {
    materialDifferences.push(
      `Estimate mismatch: app said ${estimate.appCurrency ?? ""} ${estimate.appLow}-${estimate.appHigh}, ` +
        `catalogue says GBP ${estimate.auctionLow}-${estimate.auctionHigh}.`,
    );
  }

  return {
    artist: {
      app: report.likelyArtist ?? null,
      auction: groundTruth.artist,
      auctionQualifier: groundTruth.artistQualifier,
      match: artistMatch,
    },
    title,
    estimate,
    materialDifferences,
    overallVerdict: materialDifferences.length > 0 ? "material_differences_found" : "consistent",
  };
}
