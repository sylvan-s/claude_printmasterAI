/**
 * queryArtistPriceProfile — an artist's stored price elasticities, and the pure helper that
 * turns them into the multiplier between two impressions of the same work.
 *
 * Plan docs/plans/2026-09-13-attributed-lot-valuation.md, step 6. The elasticities are built by
 * knowledge_graph/pricing_ml/build_priors.py (log-linear coefficients on log hammer, deflated by
 * pooled sale-year effects, reference levels dropped, shrunk toward the artist's ten nearest
 * donor artists) and written into the graph by knowledge_graph/write_price_priors.py — the ONLY
 * writer. This module reads; it never writes. Nothing here is wired into Stage 3 yet: that is
 * gated on the same-work-comps backtest (plan step 6 gate).
 *
 * Three tiers, by how much the graph knows about the artist:
 *   basis "shrunk"   >= 15 earlier sales: the artist's own fit shrunk toward the neighbour prior
 *   basis "prior"    5-14 earlier sales: the neighbour prior outright
 *   basis "segment"  fewer: the SEGMENT DEFAULT for the artist's nationality group x period,
 *                    read off the latest PricingModelRun — no Artist property is involved, so
 *                    `neighbours` is empty and `earlierSales` null. A segment profile is the
 *                    market's average, not the artist's; callers should say so in the report.
 *
 * `adjustmentBetween(lot, comp, profile)` is the learned replacement for the "60-70% unsigned
 * discount" Stage 3 was guessing: multiply a same-work comp's hammer by it to get the lot's
 * expected hammer, over the attributes that differ — signature class, proof class, edition
 * band, area band, process, and the continuous edition-size / sheet-area terms per doubling.
 * HOUSE is deliberately NOT an attribute here: the like-for-like house effect (Roseberys
 * x0.36-0.95 of Bonhams) is unresolved between arbitrage and selection until the cross-house
 * repeat-sale test (plan step 7), so it must not enter a verdict.
 *
 * The level conventions mirror train_price_model.py's feature parsers exactly — an attribute
 * the caller cannot determine takes the level the model would have given an uninformative
 * record: signature -> "unsigned" (the model has no unknown-signature level), proof -> "unknown",
 * process -> "other", edition/area -> band "unknown" with the continuous term at the training
 * median. Same-level attributes contribute nothing; a level the run never saw (e.g. a process
 * outside the ten the model knows) contributes nothing and is listed in `unknownColumns` so the
 * caller can see what the multiplier does NOT cover.
 */
import { getDriver, getDatabase } from "./client.js";
import { lookupArtistNames } from "./artist_lookup.js";

export type SignatureClass = "hand" | "initialled" | "plate" | "stamped" | "unsigned";
export type ProofClass = "numbered" | "artist_proof" | "edition_unnumbered" | "hors_commerce" | "trial_proof" | "unknown";
export type EditionBand = "<=30" | "31-75" | "76-150" | "151-300" | ">300" | "unknown";
export type AreaBand = "<150cm2" | "150-400" | "400-900" | "900-1800" | ">1800" | "unknown";
export type PriceProfileBasis = "shrunk" | "prior" | "segment";

/** The attributes of one impression, as far as the caller knows them. Null/undefined = unknown. */
export interface PriceAttrs {
  signature?: SignatureClass | null;
  proof?: ProofClass | null;
  /** Declared edition size (or parsed "x/N"). Drives both the band and the per-doubling term. */
  editionSize?: number | null;
  /** Sheet (else image/plate) area in cm². Drives both the band and the per-doubling term. */
  areaCm2?: number | null;
  /** Primary process word as train_price_model.py's PROCESSES: lithograph, etching, screenprint, ... or "offset". */
  process?: string | null;
  /** The object is a poster (train_price_model.is_poster). A 0/1 model column, not a level family. */
  poster?: boolean | null;
  /** Not the artist's own work ("after", "manner of", ...): the model's per-artist "after" column. */
  after?: boolean | null;
  /** An object multiple: printed or made on aluminium, Plexiglas, steel, canvas, wood..., or a cast object. */
  object?: boolean | null;
}

export interface ArtistPriceProfile {
  canonicalName: string;
  /** Intercept on deflated log hammer — the artist's price level, log GBP. */
  level: number;
  /** Log-linear coefficient per elasticity column, e.g. "signature_hand", "edition_log". */
  elasticities: Record<string, number>;
  /** exp(coefficient); for the continuous columns (edition_log, area_log) the multiplier PER DOUBLING. */
  multipliers: Record<string, number>;
  /** The donor artists whose elasticities formed the prior, with the weight each carried. */
  neighbours: { name: string; weight: number }[];
  /** PricingModelRun id the numbers came from — the staleness tag. */
  run: string;
  basis: PriceProfileBasis;
  earlierSales: number | null;
  /** Segment key when basis is "segment" ("british|modern"), else null. */
  segment: string | null;
  /** Reference level per attribute — the level whose coefficient is zero by construction. */
  referenceLevels: Record<string, string>;
  /** Training medians of the continuous terms, used when a side's edition/area is unknown. */
  continuousMedians: Record<string, number>;
  /** Pooled sale-year effects (log) the level was deflated by, keyed by year. A from-scratch
   *  prediction adds the effect for the lot's sale year back on (build_priors.predict); years
   *  after the training cut carry 0. */
  yearEffects: Record<string, number>;
}

export interface PriceAdjustment {
  /** Expected hammer(lot) / expected hammer(comp). Multiply the comp's hammer by this. */
  multiplier: number;
  logAdjustment: number;
  /** One entry per attribute that differed and moved the number. */
  factors: { attribute: string; lot: string; comp: string; factor: number }[];
  /** Columns a side needed that this run has no coefficient for — contributed nothing. */
  unknownColumns: string[];
}

const CONTINUOUS = new Set(["edition_log", "area_log", "area_log_xl"]);
const LN2 = Math.log(2);

// ── pure helpers (mirrors of train_price_model.py / build_priors.py) ────────────

export function editionBand(n: number | null | undefined): EditionBand {
  if (n == null || !Number.isFinite(n) || n <= 0) return "unknown";
  if (n <= 30) return "<=30";
  if (n <= 75) return "31-75";
  if (n <= 150) return "76-150";
  if (n <= 300) return "151-300";
  return ">300";
}

/**
 * The size bands a profile was fitted with. The shape bands (build_priors --size-terms shape-bands,
 * 2026-09-16) are cut where the measured price curve bends — flat below ~30 cm a side, rising to
 * ~42 cm, flat to ~87 cm, then a jump — and use 1800-7500 as the reference level, which is how a
 * profile built with them is recognised. Every other profile uses areaBand.
 */
export function areaBandFor(cm2: number | null | undefined, referenceLevels: Record<string, string> | null | undefined): string {
  if (referenceLevels?.area_band !== "1800-7500") return areaBand(cm2);
  if (cm2 == null || !Number.isFinite(cm2) || cm2 <= 0) return "unknown";
  if (cm2 < 400) return "<400";
  if (cm2 < 900) return "400-900";
  if (cm2 < 1800) return "900-1800";
  if (cm2 < 7500) return "1800-7500";
  return ">7500";
}

export function areaBand(cm2: number | null | undefined): AreaBand {
  if (cm2 == null || !Number.isFinite(cm2) || cm2 <= 0) return "unknown";
  if (cm2 < 150) return "<150cm2";
  if (cm2 < 400) return "150-400";
  if (cm2 < 900) return "400-900";
  if (cm2 < 1800) return "900-1800";
  return ">1800";
}

/** Birth-year period, as build_priors.period_of. */
export function periodOf(born: number | null | undefined): string {
  if (born == null || !Number.isFinite(born)) return "unknown";
  if (born < 1800) return "pre1800";
  if (born < 1880) return "c19";
  if (born < 1930) return "modern";
  return "contemporary";
}

/** Nationality group, as build_priors.descriptors + nat_group_of: checked in this order, first hit wins. */
export function nationalityGroup(nationality: string | null | undefined): string {
  const n = (nationality ?? "").toLowerCase();
  if (/brit|english|scot|welsh/.test(n)) return "british";
  if (n.includes("american")) return "american";
  if (/french|fran[cç]ais/.test(n)) return "french";
  if (n.includes("spanish")) return "spanish";
  if (n.includes("german")) return "german";
  return "other";
}

export function segmentKey(nationality: string | null | undefined, born: number | null | undefined): string {
  return `${nationalityGroup(nationality)}|${periodOf(born)}`;
}

/** Fallback chain over the run's segment defaults: exact cell, nationality marginal, period marginal, global. */
export function pickSegmentDefault<T>(defaults: Record<string, T>, key: string): { key: string; value: T } | null {
  const [nat, period] = key.split("|");
  for (const k of [key, `${nat}|any`, `any|${period}`, "any|any"]) {
    if (k in defaults) return { key: k, value: defaults[k] };
  }
  return null;
}

export function multipliersFrom(elasticities: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [col, v] of Object.entries(elasticities)) out[col] = Math.exp(CONTINUOUS.has(col) ? v * LN2 : v);
  return out;
}

function levelOf(attrs: PriceAttrs): Record<string, string> {
  return {
    signature: attrs.signature ?? "unsigned",
    proof: attrs.proof ?? "unknown",
    edition_band: editionBand(attrs.editionSize),
    area_band: areaBand(attrs.areaCm2),
    process: attrs.process ? attrs.process.toLowerCase() : "other",
  };
}

function logOr(value: number | null | undefined, median: number | undefined): number {
  if (value != null && Number.isFinite(value) && value > 0) return Math.log(value);
  return median ?? 0;
}

/**
 * Multiplier from the comp's hammer to the lot's expected hammer under the artist's elasticities.
 * Pure: no I/O, no graph. Order matters — adjustmentBetween(a, b) === 1 / adjustmentBetween(b, a).
 */
export function adjustmentBetween(lot: PriceAttrs, comp: PriceAttrs, profile: ArtistPriceProfile): PriceAdjustment {
  const lotL = levelOf(lot);
  const compL = levelOf(comp);
  const unknown = new Set<string>();
  const coef = (dim: string, level: string): number => {
    if (profile.referenceLevels[dim] === level) return 0;
    const col = `${dim}_${level}`;
    const v = profile.elasticities[col];
    if (v == null || !Number.isFinite(v)) { unknown.add(col); return 0; }
    return v;
  };
  const factors: PriceAdjustment["factors"] = [];
  let logAdj = 0;
  for (const dim of ["signature", "proof", "edition_band", "area_band", "process"]) {
    if (lotL[dim] === compL[dim]) continue;
    const delta = coef(dim, lotL[dim]) - coef(dim, compL[dim]);
    if (delta !== 0) factors.push({ attribute: dim, lot: lotL[dim], comp: compL[dim], factor: Math.exp(delta) });
    logAdj += delta;
  }
  const cont: [string, number | null | undefined, number | null | undefined][] = [
    ["edition_log", lot.editionSize, comp.editionSize],
    ["area_log", lot.areaCm2, comp.areaCm2],
  ];
  for (const [col, yes, no] of [["poster", "poster", "not a poster"], ["after", "after the artist", "the artist's own"], ["object", "object multiple", "print on paper"]] as const) {
    const b = profile.elasticities[col];
    if (b == null || !Number.isFinite(b) || !!lot[col] === !!comp[col]) continue;
    const delta = b * ((lot[col] ? 1 : 0) - (comp[col] ? 1 : 0));
    factors.push({ attribute: col, lot: lot[col] ? yes : no, comp: comp[col] ? yes : no, factor: Math.exp(delta) });
    logAdj += delta;
  }
  for (const [col, lv, cv] of cont) {
    // A build without the term (edition_log under --edition-terms bands) is not an unknown column.
    if (!(col in profile.elasticities)) continue;
    const beta = profile.elasticities[col];
    if (beta == null || !Number.isFinite(beta)) { if (lv != null || cv != null) unknown.add(col); continue; }
    const median = profile.continuousMedians[col];
    const delta = beta * (logOr(lv, median) - logOr(cv, median));
    if (delta !== 0) {
      factors.push({ attribute: col, lot: lv == null ? "median" : String(lv), comp: cv == null ? "median" : String(cv), factor: Math.exp(delta) });
      logAdj += delta;
    }
  }
  return { multiplier: Math.exp(logAdj), logAdjustment: logAdj, factors, unknownColumns: [...unknown].sort() };
}

// ── graph read ──────────────────────────────────────────────────────────────

// Same exact-match idiom as queryArtistDinoFloor: names come from lookupArtistNames (exact
// index hit, then folded equality, never CONTAINS) and the read runs from the artist_name index.
const ARTIST_QUERY = `
MATCH (a:Artist)
WHERE a.name IN $names AND a.priceElasticitiesRun IS NOT NULL
MATCH (run:PricingModelRun {id: a.priceElasticitiesRun})
OPTIONAL MATCH (a)-[r:PRICE_NEIGHBOUR {run: a.priceElasticitiesRun}]->(b:Artist)
WITH a, run, collect({name: b.name, weight: r.weight}) AS nbs
RETURN a.name AS name, a.priceLevelLog AS level, a.priceElasticities AS vec,
       a.priceEarlierSales AS earlier, a.priceElasticitiesBasis AS basis, a.priceElasticitiesRun AS run,
       run.elasticityColumns AS cols, run.referenceLevels AS refs, run.continuousMedians AS meds, run.yearEffects AS years, nbs
ORDER BY a.priceEarlierSales DESC
LIMIT 1
`;

const SEGMENT_QUERY = `
MATCH (a:Artist) WHERE a.name IN $names
WITH a ORDER BY CASE WHEN a.dateBorn_year IS NULL THEN 1 ELSE 0 END, a.name LIMIT 1
MATCH (run:PricingModelRun)
WITH a, run ORDER BY run.builtAt DESC LIMIT 1
RETURN a.name AS name, a.nationality AS nationality, a.dateBorn_year AS born, run.id AS run,
       run.elasticityColumns AS cols, run.referenceLevels AS refs, run.continuousMedians AS meds, run.yearEffects AS years,
       run.segmentDefaults AS segments
`;

const num = (v: unknown): number | null =>
  typeof v === "number" ? v : v && typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : null;

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

/** Never throws — a graph hiccup must leave the caller without a profile, not fail the lot. */
export async function queryArtistPriceProfile(canonicalName: string | null | undefined): Promise<ArtistPriceProfile | null> {
  const name = canonicalName?.trim();
  if (!name) return null;
  const session = getDriver().session({ database: getDatabase() });
  try {
    const { names } = await lookupArtistNames(session, name);
    if (names.length === 0) return null;

    const res = await session.run(ARTIST_QUERY, { names });
    if (res.records.length) {
      const r = res.records[0];
      const cols = (r.get("cols") as string[]) ?? [];
      const vec = ((r.get("vec") as unknown[]) ?? []).map(num);
      if (cols.length !== vec.length) {
        console.warn(`[queryArtistPriceProfile] "${name}": vector length ${vec.length} != ${cols.length} columns; ignoring`);
        return null;
      }
      const elasticities: Record<string, number> = {};
      cols.forEach((c, i) => { const v = vec[i]; if (v != null && Number.isFinite(v)) elasticities[c] = v; });
      const level = num(r.get("level"));
      if (level == null) return null;
      const neighbours = ((r.get("nbs") as { name: string | null; weight: unknown }[]) ?? [])
        .filter((n) => n.name != null)
        .map((n) => ({ name: String(n.name), weight: num(n.weight) ?? 0 }))
        .sort((x, y) => y.weight - x.weight);
      return {
        canonicalName: String(r.get("name")),
        level,
        elasticities,
        multipliers: multipliersFrom(elasticities),
        neighbours,
        run: String(r.get("run")),
        basis: (r.get("basis") as PriceProfileBasis) ?? "shrunk",
        earlierSales: num(r.get("earlier")),
        segment: null,
        referenceLevels: parseJson<Record<string, string>>(r.get("refs"), {}),
        continuousMedians: parseJson<Record<string, number>>(r.get("meds"), {}),
        yearEffects: parseJson<Record<string, number>>(r.get("years"), {}),
      };
    }

    const seg = await session.run(SEGMENT_QUERY, { names });
    if (!seg.records.length) return null;
    const r = seg.records[0];
    const defaults = parseJson<Record<string, { price_level_log: number; elasticities: Record<string, number> }>>(r.get("segments"), {});
    const key = segmentKey(r.get("nationality") as string | null, num(r.get("born")));
    const picked = pickSegmentDefault(defaults, key);
    if (!picked) return null;
    const elasticities: Record<string, number> = {};
    for (const [c, v] of Object.entries(picked.value.elasticities ?? {})) if (typeof v === "number" && Number.isFinite(v)) elasticities[c] = v;
    return {
      canonicalName: String(r.get("name")),
      level: picked.value.price_level_log,
      elasticities,
      multipliers: multipliersFrom(elasticities),
      neighbours: [],
      run: String(r.get("run")),
      basis: "segment",
      earlierSales: null,
      segment: picked.key,
      referenceLevels: parseJson<Record<string, string>>(r.get("refs"), {}),
      continuousMedians: parseJson<Record<string, number>>(r.get("meds"), {}),
      yearEffects: parseJson<Record<string, number>>(r.get("years"), {}),
    };
  } catch (err: any) {
    console.warn(`[queryArtistPriceProfile] failed for "${name}": ${err.message}`);
    return null;
  } finally {
    await session.close();
  }
}
