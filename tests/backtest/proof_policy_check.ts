/**
 * Proof policy check (2026-09-16): on sold backtest lots the catalogue calls an artist's proof,
 * hors commerce or trial proof, price with and without the policy (edition neutral, proof premium
 * clamped to 5-10%) and score both on the hammer. Zero LLM; graph reads only. Also checks the
 * waterfall sum identity on every lot.
 *
 *   npx tsx tests/backtest/proof_policy_check.ts [--max 400]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { closeDriver, blendPrices, calibratedWitnesses, isPolicyProof } from "../../src/appraisal/knowledge_graph/index";
import { readLotGraphEvidence, assembleValuationEvidence, evidenceToBlendInputs } from "../../src/appraisal/valuation_evidence";
import { loadBlendCalibration, proofPolicyFor, stage3aValuation } from "../../src/appraisal/stage3a_blend";
import { loadColumnMeans } from "../../src/appraisal/stage3a_waterfall";

const argv = process.argv.slice(2);
const MAX = Number(argv[argv.indexOf("--max") + 1] || 400);
async function main() {
  const cal = loadBlendCalibration()!, means = loadColumnMeans()!, policy = proofPolicyFor(means);
  const rows: any[] = [];
  for (const f of ["roseberys", "forum", "bonhams"]) for (const l of readFileSync(`tests/backtest/comps_hammer/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.sold && r.hammer > 0 && r.blend && r.canonicalArtist && /artist'?s proof|\bA\.?P\.?\b|hors commerce|\bH\.?C\.?\b|trial proof|épreuve/i.test(`${r.medium ?? ""} ${r.editionNote ?? ""}`)) rows.push(r);
  }
  const split: Record<string, { n: number; off: number; on: number; geoOff: number; geoOn: number }> = {};
  const res = { n: 0, priorsOff: 0, priorsOn: 0, blendOff: 0, blendOn: 0, geoOff: 0, geoOn: 0, gapNotes: 0, byClass: {} as Record<string, number> };
  for (const row of rows.slice(0, MAX)) {
    const claim: any = { artist: row.artist, title: row.title, medium: row.medium, editionNote: row.editionNote, editionSize: row.editionSize, signed: row.signed, dimensions: row.widthCm && row.heightCm ? [{ kind: "sheet", widthCm: row.widthCm, heightCm: row.heightCm }] : null, catalogueRefs: row.catalogueRefs ? [row.catalogueRefs] : null, house: row.blend.inputs.targetHouse, saleId: String(row.saleId), lotNumber: Number(row.lotNumber), saleDate: row.saleDate };
    const graph = await readLotGraphEvidence({ canonicalArtist: row.canonicalArtist, workTitle: claim.title, catalogueRefs: row.catalogueRefs ?? null, techniqueText: claim.medium, valuationDate: row.saleDate, excludeSaleLot: { saleId: claim.saleId, lotNumber: claim.lotNumber }, excludeListingUrl: row.listingUrl ?? null, via: "claim" });
    const ev = assembleValuationEvidence({ builtAt: "check", reportedArtist: row.artist, canonicalArtist: row.canonicalArtist, claim, graph, targetHouse: { value: claim.house, source: "catalogue" }, valuationDate: { value: row.saleDate, source: "catalogue" } });
    if (!ev.profile || !isPolicyProof(ev.attrs.proof.value)) continue;
    const off = evidenceToBlendInputs(ev), on = evidenceToBlendInputs(ev, { proofPolicy: policy });
    const wOff = calibratedWitnesses(off, cal, "no_estimate").witnesses.find((w) => w.source === "priors_model");
    const wOn = calibratedWitnesses(on, cal, "no_estimate").witnesses.find((w) => w.source === "priors_model");
    const bOff = blendPrices(off, cal, "no_estimate"), bOn = blendPrices(on, cal, "no_estimate");
    if (!wOff || !wOn || !bOff || !bOn) continue;
    const y = Math.log(row.hammer);
    res.n++; res.byClass[ev.attrs.proof.value] = (res.byClass[ev.attrs.proof.value] ?? 0) + 1;
    const g = `${ev.attrs.proof.value === "artist_proof" ? "AP" : "HC/trial"}, edition ${ev.attrs.editionSize.value != null ? "stated" : "not stated"}`;
    const gg = (split[g] ??= { n: 0, off: 0, on: 0, geoOff: 0, geoOn: 0 });
    gg.n++; gg.off += Math.abs(Math.log(bOff.medianGBP) - y); gg.on += Math.abs(Math.log(bOn.medianGBP) - y); gg.geoOff += Math.log(bOff.medianGBP) - y; gg.geoOn += Math.log(bOn.medianGBP) - y;
    res.priorsOff += Math.abs(wOff.mu - y); res.priorsOn += Math.abs(wOn.mu - y);
    res.blendOff += Math.abs(Math.log(bOff.medianGBP) - y); res.blendOn += Math.abs(Math.log(bOn.medianGBP) - y);
    res.geoOff += Math.log(bOff.medianGBP) - y; res.geoOn += Math.log(bOn.medianGBP) - y;
    const s3 = stage3aValuation(ev, cal, means);
    if (s3?.waterfall?.notes.some((n) => n.includes("short"))) res.gapNotes++;
  }
  const f = (x: number) => (x / res.n).toFixed(3);
  console.log(`${rows.length} candidate lots by text; ${res.n} priced proofs ${JSON.stringify(res.byClass)}`);
  console.log(`  pricing-model witness MAE(log): without policy ${f(res.priorsOff)}  with ${f(res.priorsOn)}`);
  console.log(`  blended median MAE(log):        without policy ${f(res.blendOff)}  with ${f(res.blendOn)}`);
  console.log(`  blended median geo (pred/hammer): without x${Math.exp(res.geoOff / res.n).toFixed(2)}  with x${Math.exp(res.geoOn / res.n).toFixed(2)}`);
  console.log(`  waterfall gap notes: ${res.gapNotes}`);
  for (const [g, v] of Object.entries(split).sort()) console.log(`  ${g.padEnd(30)} n=${String(v.n).padStart(3)}  blend MAE ${(v.off / v.n).toFixed(3)} -> ${(v.on / v.n).toFixed(3)}  geo x${Math.exp(v.geoOff / v.n).toFixed(2)} -> x${Math.exp(v.geoOn / v.n).toFixed(2)}`);
  await closeDriver();
}
main();
