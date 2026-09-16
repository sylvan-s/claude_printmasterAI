/**
 * Stage 3 check of a priors build variant (2026-09-16: size bands only vs bands + per-doubling
 * area). Re-prices every sold backtest lot through the blend with each build's artist profiles,
 * read from the build JSON (no graph write), from identical lot attributes parsed from the catalogue
 * fields. Calibration is fitted on lots sold before --split (the priors' own cut) and scored after.
 * Zero LLM, zero graph.
 *
 *   npx tsx tests/backtest/priors_variant_check.ts --a <dir>/artist_elasticities.json --b <dir>/artist_elasticities.json
 */
import { readFileSync } from "node:fs";
import {
  priorsModelPrediction, priceAttrsOfLot, fitBlendCalibration, blendPrices, calibratedWitnesses, isPolicyProof, DEFAULT_PROOF_PREMIUM,
  type BlendInputs, type FitRow, type ArtistPriceProfile,
} from "../../src/appraisal/knowledge_graph/index";
import type { HouseOffsets } from "../../src/appraisal/knowledge_graph/price_blend";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SPLIT = arg("split", "2024-07-01")!;
const D = "tests/backtest/comps_hammer";
const means = JSON.parse(readFileSync("knowledge_graph/pricing_ml/priors/column_means.json", "utf8"));
const offsets: HouseOffsets = { ...JSON.parse(readFileSync("knowledge_graph/pricing_ml/blend/house_offsets.json", "utf8")), timeAdjust: "prior_year" };

function profilesFrom(path: string) {
  // build_priors writes Python NaN in descriptor fields; strict JSON needs null.
  const db = JSON.parse(readFileSync(path, "utf8").replace(/\bNaN\b/g, "null"));
  const seg = db.segment_defaults["any|any"];
  const toProfile = (name: string, level: number, el: Record<string, number>, basis: string, earlier: number | null): ArtistPriceProfile => ({
    canonicalName: name, level, elasticities: el, multipliers: {}, neighbours: [], run: `${db.version}@${db.built_at}`, basis: basis as any, earlierSales: earlier, segment: basis === "segment" ? "any|any" : null,
    referenceLevels: db.reference_levels, continuousMedians: db.continuous_medians, yearEffects: db.year_effects,
  });
  return {
    version: db.version,
    get(name: string): ArtistPriceProfile {
      const a = db.artists[name];
      if (a) return toProfile(name, a.price_level_log, Object.fromEntries(Object.entries(a.elasticities).map(([c, v]: any) => [c, v.value])), a.basis, a.earlier_sales);
      return toProfile(name, seg.price_level_log, seg.elasticities, "segment", null);
    },
  };
}

function main() {
  const variants = [arg("a")!, arg("b")!].map(profilesFrom);
  const rows: any[] = [];
  for (const f of ["forum", "roseberys", "bonhams"]) for (const l of readFileSync(`${D}/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.sold && r.hammer > 0 && r.blend && r.canonicalArtist && !r.error) rows.push(r);
  }
  const policy = { columnMeans: means.columns, premium: DEFAULT_PROOF_PREMIUM };
  const results: Record<string, any> = {};
  for (const v of variants) {
    const fitRows: FitRow[] = [];
    const tagged = rows.map((r) => {
      const attrs = priceAttrsOfLot({ text: [r.medium, r.editionNote].filter(Boolean).join(", "), signed: r.signed, editionSize: r.editionSize, widthCm: r.widthCm, heightCm: r.heightCm });
      const profile = v.get(r.canonicalArtist);
      const pred = priorsModelPrediction(attrs, profile, { saleDate: r.saleDate, house: r.blend.inputs.targetHouse, proofPolicy: policy });
      const inputs: BlendInputs = { ...r.blend.inputs, estimate: null, priors: { mu: pred.mu, basis: profile.basis, earlierSales: profile.earlierSales, contributions: pred.contributions } };
      return { r, attrs, row: { inputs, hammerGBP: r.hammer } as FitRow };
    });
    for (const t of tagged) if (t.r.saleDate < SPLIT) fitRows.push(t.row);
    const cal = fitBlendCalibration(fitRows, { version: v.version, fittedOn: "variant check", df: 5, houseOffsets: offsets });
    const test = tagged.filter((t) => t.r.saleDate >= SPLIT);
    const score = (sub: typeof test) => {
      let n = 0, mae = 0, geo = 0, cover = 0, priorsMae = 0, pn = 0;
      for (const t of sub) {
        const b = blendPrices(t.row.inputs, cal, "no_estimate");
        const w = calibratedWitnesses(t.row.inputs, cal, "no_estimate").witnesses.find((x) => x.source === "priors_model");
        const y = Math.log(t.r.hammer);
        if (w) { pn++; priorsMae += Math.abs(w.mu - y); }
        if (!b) continue;
        n++; const e = Math.log(b.medianGBP) - y; mae += Math.abs(e); geo += e;
        if (y >= Math.log(b.p10GBP) && y <= Math.log(b.p90GBP)) cover++;
      }
      return { n, mae: mae / n, geo: Math.exp(geo / n), cover: cover / n, priorsMae: priorsMae / pn };
    };
    const band = (t: any) => t.attrs.areaCm2 == null ? "size unknown" : t.attrs.areaCm2 < 400 ? "under 400 cm²" : t.attrs.areaCm2 < 1800 ? "400-1,800 cm²" : t.attrs.areaCm2 < 4000 ? "1,800-4,000 cm²" : "over 4,000 cm²";
    const groups: Record<string, typeof test> = { all: test };
    for (const t of test) {
      (groups[t.r.blend.inputs.targetHouse] ??= []).push(t);
      (groups[band(t)] ??= []).push(t);
      if (isPolicyProof(t.attrs.proof)) (groups["proofs (AP/HC/trial)"] ??= []).push(t);
    }
    results[v.version] = Object.fromEntries(Object.entries(groups).map(([g, sub]) => [g, score(sub)]));
    console.log(`${v.version}: fitted on ${fitRows.length} lots before ${SPLIT}; scored ${test.length} after`);
  }
  const [A, B] = variants.map((v) => results[v.version]);
  console.log(`\n${"group".padEnd(24)} ${"n".padStart(5)}   blend MAE(log) ${variants[0].version} -> ${variants[1].version}   80% cover   geo   | pricing-model witness MAE`);
  for (const g of Object.keys(A)) {
    const a = A[g], b = B[g];
    console.log(`${g.padEnd(24)} ${String(a.n).padStart(5)}   ${a.mae.toFixed(3)} -> ${b.mae.toFixed(3)} (${(b.mae - a.mae >= 0 ? "+" : "") + (b.mae - a.mae).toFixed(3)})   ${(100 * a.cover).toFixed(0)}% -> ${(100 * b.cover).toFixed(0)}%   x${a.geo.toFixed(2)} -> x${b.geo.toFixed(2)}   | ${a.priorsMae.toFixed(3)} -> ${b.priorsMae.toFixed(3)}`);
  }
}
main();
