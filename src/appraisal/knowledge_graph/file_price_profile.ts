/**
 * Artist price profiles read from a committed priors build file instead of the graph
 * (2026-09-16, user direction: adopt the size-band model using the committed model file; the graph
 * is not written to). Stage 3a prices from knowledge_graph/pricing_ml/priors_stage3a/, built with
 * `build_priors.py --size-terms shape-bands+xl`; the graph's PricingModelRun keeps its own build
 * for everything else.
 *
 * Same profile shape and fallbacks as queryArtistPriceProfile: the artist's own entry (basis
 * "shrunk" or "prior", with neighbours) when the build has one, else the nationality × period
 * segment default. The graph is only READ, for the artist's stored name(s), nationality and birth
 * year. A graph hiccup falls back to the global segment default rather than failing the lot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDriver, getDatabase } from "./client.js";
import { lookupArtistNames } from "./artist_lookup.js";
import { multipliersFrom, pickSegmentDefault, segmentKey, type ArtistPriceProfile } from "./artist_price_profile.js";

export const STAGE3A_PRIORS_DIR = join(process.cwd(), "knowledge_graph/pricing_ml/priors_stage3a");

export interface PriorsBuild {
  version: string;
  built_at: string;
  reference_levels: Record<string, string>;
  continuous_medians: Record<string, number>;
  year_effects: Record<string, number>;
  artists: Record<string, { earlier_sales: number; basis: "shrunk" | "prior"; price_level_log: number; elasticities: Record<string, { value: number }>; neighbours: Record<string, number> }>;
  segment_defaults: Record<string, { price_level_log: number; elasticities: Record<string, number> }>;
}

const cache = new Map<string, PriorsBuild | null>();
/** The build JSON, read once per path. build_priors writes Python NaN in descriptor fields; strict JSON needs null. */
export function loadPriorsBuild(dir = STAGE3A_PRIORS_DIR): PriorsBuild | null {
  if (!cache.has(dir)) {
    try { cache.set(dir, JSON.parse(readFileSync(join(dir, "artist_elasticities.json"), "utf8").replace(/\bNaN\b/g, "null"))); }
    catch (err: any) { console.warn(`[file price profile] priors build unreadable at ${dir}: ${err?.message ?? err}`); cache.set(dir, null); }
  }
  return cache.get(dir)!;
}

/** A profile from the build for one graph artist name. Pure. `nationality`/`born` only matter without an own entry. */
export function profileFromBuild(build: PriorsBuild, name: string, nationality: string | null, born: number | null): ArtistPriceProfile | null {
  const common = {
    run: `${build.version}@${build.built_at}`,
    referenceLevels: build.reference_levels,
    continuousMedians: build.continuous_medians,
    yearEffects: build.year_effects,
  };
  const own = build.artists[name];
  if (own) {
    const elasticities = Object.fromEntries(Object.entries(own.elasticities).filter(([, v]) => v && Number.isFinite(v.value)).map(([c, v]) => [c, v.value]));
    return {
      ...common, canonicalName: name, level: own.price_level_log, elasticities, multipliers: multipliersFrom(elasticities),
      neighbours: Object.entries(own.neighbours ?? {}).map(([n, w]) => ({ name: n, weight: w })).sort((a, b) => b.weight - a.weight),
      basis: own.basis, earlierSales: own.earlier_sales, segment: null,
    };
  }
  const picked = pickSegmentDefault(build.segment_defaults, segmentKey(nationality, born));
  if (!picked) return null;
  const elasticities = Object.fromEntries(Object.entries(picked.value.elasticities ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
  return { ...common, canonicalName: name, level: picked.value.price_level_log, elasticities, multipliers: multipliersFrom(elasticities), neighbours: [], basis: "segment", earlierSales: null, segment: picked.key };
}

const ARTIST_FACTS = `
MATCH (a:Artist) WHERE a.name IN $names
RETURN a.name AS name, a.nationality AS nationality, a.dateBorn_year AS born
ORDER BY CASE WHEN a.dateBorn_year IS NULL THEN 1 ELSE 0 END, a.name
`;
const num = (v: unknown): number | null => (typeof v === "number" ? v : v && typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : null);

/** The file-based counterpart of queryArtistPriceProfile. Never throws. */
export async function queryArtistPriceProfileFromFile(canonicalName: string | null | undefined, dir = STAGE3A_PRIORS_DIR): Promise<ArtistPriceProfile | null> {
  const name = canonicalName?.trim();
  const build = loadPriorsBuild(dir);
  if (!name || !build) return null;
  if (build.artists[name]) return profileFromBuild(build, name, null, null);
  const session = getDriver().session({ database: getDatabase() });
  try {
    const { names } = await lookupArtistNames(session, name);
    const stored = names.find((n) => build.artists[n]);
    if (stored) return profileFromBuild(build, stored, null, null);
    if (!names.length) return profileFromBuild(build, name, null, null);
    const r = (await session.run(ARTIST_FACTS, { names })).records[0];
    return profileFromBuild(build, names[0], (r?.get("nationality") as string | null) ?? null, num(r?.get("born")));
  } catch (err: any) {
    console.warn(`[file price profile] graph read failed for "${name}", using the global segment default: ${err?.message ?? err}`);
    return profileFromBuild(build, name, null, null);
  } finally {
    await session.close();
  }
}
