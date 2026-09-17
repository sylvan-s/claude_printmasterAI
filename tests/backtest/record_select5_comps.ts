/**
 * Re-record the backtest lots' comparables with the five-comp tiered selection (select_comps.ts,
 * 2026-09-17), so the blend calibration can be refitted on what live Stage 3a now sees. Read-only.
 *
 * Per lot: the lot's own CLIP vector from its graph image (by listing URL), its work identity as the
 * live path resolves it (the lot's own record excluded), its technique class from the medium line, and
 * the SIMILAR ARTISTS from the backtest-cut model (priors_stage3a_gate), so no held-out sale leaks in.
 *
 *   npx tsx tests/backtest/record_select5_comps.ts [--concurrency 6] [--limit 50]
 * writes tests/backtest/comps_hammer/select5_comps.jsonl: { key, clip, process, tierCounts, sameWork, sameArtistTechnique, sameArtist }
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectComparables } from "../../src/appraisal/knowledge_graph/select_comps";
import { queryArtistPriceProfileFromFile } from "../../src/appraisal/knowledge_graph/file_price_profile";
import { getDriver, getDatabase } from "../../src/appraisal/knowledge_graph/client";
import { resolveWorkIdentity, closeDriver, primaryProcess } from "../../src/appraisal/knowledge_graph/index";
import { mapTechniqueToAckgVocabulary } from "../../src/appraisal/stage2a_query_plan";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const CONC = Number(arg("concurrency", "6"));
const LIMIT = Number(arg("limit", "0"));
const D = "tests/backtest/comps_hammer";
const GATE = join(process.cwd(), "knowledge_graph/pricing_ml/priors_stage3a_gate");
const OUT = `${D}/select5_comps.jsonl`;

async function lotVector(url: string | null, saleId: string, lot: number): Promise<number[] | null> {
  const s = getDriver().session({ database: getDatabase() });
  try {
    const r = url
      ? await s.run(`MATCH (src:SourceRecord {listingUrl: $url})-[:DOCUMENTS]->(imp)<-[:SHOWS]-(img:DigitalImage) WHERE img.clipImageEmbedding IS NOT NULL RETURN img.clipImageEmbedding AS v LIMIT 1`, { url })
      : await s.run(`MATCH (src:SourceRecord {saleId: $sid})-[:DOCUMENTS]->(imp)<-[:SHOWS]-(img:DigitalImage) WHERE src.lotNumber = $lot AND img.clipImageEmbedding IS NOT NULL RETURN img.clipImageEmbedding AS v LIMIT 1`, { sid: saleId, lot });
    return r.records[0]?.get("v") ?? null;
  } finally { await s.close(); }
}

async function main() {
  const rows: any[] = [];
  for (const f of ["forum", "roseberys", "bonhams"]) for (const l of readFileSync(`${D}/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.sold && r.hammer > 0 && r.blend && r.canonicalArtist && !r.error) rows.push(r);
  }
  const todo = LIMIT ? rows.slice(0, LIMIT) : rows;
  const out: string[] = new Array(todo.length);
  let done = 0, withClip = 0, failed = 0;
  const t0 = Date.now();
  const worker = async (slot: number) => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const r = todo[i];
      try {
        const saleLot = { saleId: String(r.saleId), lotNumber: Number(r.lotNumber) };
        const [vec, profile, wi] = await Promise.all([
          lotVector(r.listingUrl ?? null, saleLot.saleId, saleLot.lotNumber),
          queryArtistPriceProfileFromFile(r.canonicalArtist, GATE),
          r.title ? resolveWorkIdentity({ artistName: r.canonicalArtist, title: r.title, catalogueRefs: r.catalogueRefs ?? null, excludeSaleLot: saleLot }) : Promise.resolve({ workIds: [] as string[] } as any),
        ]);
        const process = r.medium ? primaryProcess([mapTechniqueToAckgVocabulary(r.medium), r.medium]) : null;
        const since = `${Number(r.saleDate.slice(0, 4)) - 10}${r.saleDate.slice(4, 10)}`;
        const res = await selectComparables({
          artist: r.canonicalArtist, workIds: wi.workIds ?? [], process, clipVector: vec, neighbours: (profile?.neighbours ?? []).map((n) => n.name),
          sinceDate: since, untilDate: r.saleDate.slice(0, 10), attribution: "direct", excludeSaleLot: saleLot, excludeListingUrl: r.listingUrl ?? null,
        });
        if (vec) withClip++;
        const pick = (tier: string) => res.comparables.filter((c) => c.tier === tier && (c.hammerPriceGBP ?? 0) > 0).map((c) => ({ hammerGBP: c.hammerPriceGBP!, saleDate: c.saleDate, house: c.institutionName, artist: (c as any).artist ?? null, clip: (c as any).clipSimilarity ?? null }));
        const block = (tier: string) => { const cs = pick(tier); if (!cs.length) return null; const h = cs.map((c) => c.hammerGBP).sort((a, b) => a - b); return { n: cs.length, medianHammerGBP: h.length % 2 ? h[h.length >> 1] : (h[h.length / 2 - 1] + h[h.length / 2]) / 2, comps: cs }; };
        out[i] = JSON.stringify({ key: r.key, clip: !!vec, process, workIds: (wi.workIds ?? []).length, tierCounts: res.summary.tierCounts, sameWork: pick("same_work"), sameArtistTechnique: block("same_artist_technique"), sameArtist: block("same_artist") });
      } catch (e: any) {
        failed++;
        out[i] = JSON.stringify({ key: r.key, error: String(e?.message ?? e) });
      }
      if (++done % 250 === 0) console.log(`  ${done}/${todo.length} (${withClip} with a CLIP vector, ${failed} failed) ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, (_, k) => worker(k)));
  writeFileSync(OUT, out.join("\n") + "\n");
  console.log(`wrote ${todo.length} lots to ${OUT}: ${withClip} with a CLIP vector, ${failed} failed, ${Math.round((Date.now() - t0) / 1000)}s`);
  await closeDriver();
}
main();
