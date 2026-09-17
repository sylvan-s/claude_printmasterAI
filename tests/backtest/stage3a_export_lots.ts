/**
 * Stage 3a for a list of catalogued lots, exported for reports. No model call.
 *
 * Built for the A0793 evidence cards (2026-09-17): each lot's claim is the house's own catalogue
 * record, the graph evidence is read exactly as the attributed-lot path reads it (the lot's own
 * record excluded), and the result is the Stage 3a range, the share each witness carried, the
 * pricing model's attribute contributions and the waterfall.
 *
 *   npx tsx tests/backtest/stage3a_export_lots.ts --in lot_inputs.json --out stage3a_lots.json
 *
 * Input rows: { lot, canonical, claim: CatalogueAttribution }.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDriver } from "../../src/appraisal/knowledge_graph/index";
import { readLotGraphEvidence, assembleValuationEvidence } from "../../src/appraisal/valuation_evidence";
import { stage3aValuation, loadBlendCalibration } from "../../src/appraisal/stage3a_blend";
import { loadColumnMeans } from "../../src/appraisal/stage3a_waterfall";
import type { CatalogueAttribution } from "../../src/appraisal/attributed_lot";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const IN = arg("in")!;
const OUT = arg("out")!;

async function main() {
  const rows: { lot: number; canonical: string; claim: CatalogueAttribution }[] = JSON.parse(readFileSync(IN, "utf8"));
  const cal = loadBlendCalibration();
  const means = loadColumnMeans();
  if (!cal) throw new Error("blend calibration unreadable");
  const out: any[] = [];
  for (const r of rows) {
    const claim = r.claim;
    const after = claim.artistQualifier && claim.artistQualifier !== "certain";
    try {
      const graph = await readLotGraphEvidence({
        canonicalArtist: r.canonical, workTitle: claim.title ?? null, catalogueRefs: claim.catalogueRefs?.join("; ") ?? null,
        techniqueText: claim.medium ?? null, valuationDate: claim.saleDate!, attribution: after ? "after" : "direct",
        excludeSaleLot: { saleId: claim.saleId!, lotNumber: claim.lotNumber! }, excludeListingUrl: claim.lotUrl ?? null, via: "claim",
      });
      const ev = assembleValuationEvidence({
        builtAt: new Date().toISOString(), reportedArtist: claim.artist, canonicalArtist: r.canonical, claim, graph,
        targetHouse: { value: claim.house ?? null, source: "catalogue" }, valuationDate: { value: claim.saleDate!, source: "catalogue" },
      });
      const s3a = stage3aValuation(ev, cal, means);
      out.push({ lot: r.lot, canonical: r.canonical, stage3a: s3a, attrs: ev.attrs, identity: ev.identity, tierCounts: ev.comps.tierCounts,
                 profileBasis: (ev.profile as any)?.basis ?? null, warnings: ev.warnings });
      console.log(`lot ${r.lot} ${r.canonical}: ${s3a ? `£${s3a.lowGBP}-${s3a.highGBP} (median ${s3a.medianGBP}, ${s3a.evidenceTier}) weights ${s3a.witnesses.map((w) => `${w.source} ${w.effectiveWeight}`).join(", ")}` : "no price"}`);
    } catch (e: any) {
      out.push({ lot: r.lot, canonical: r.canonical, error: String(e?.message ?? e) });
      console.log(`lot ${r.lot}: ERROR ${e?.message ?? e}`);
    }
  }
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  await closeDriver();
}
main();
