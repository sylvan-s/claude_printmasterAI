/**
 * Same-suite comps for every sold backtest lot, via the live read (src/appraisal/knowledge_graph/suite_comps.ts,
 * generic catalogue prefixes excluded), for fitting the calibration.
 * Read-only against the graph. A suite sibling is another ConceptualWork by the same artist
 * documented by the SAME CatalogueEntry (exact catalogue prefix + number), e.g. every plate of
 * Braque's Le Tir a l'arc under Vallier 153. Exact fields only, no title similarity.
 *
 * The lot's own works come from resolveWorkIdentity (with the lot's own record excluded); its
 * catalogue entries are those works' entries plus any entry whose folded prefix + number equals a
 * citation parsed from its refs/title (foldPrefix, as work identity matches citations). Sibling
 * sales: sold, hammer-priced, in the 10 years before the lot, never the lot itself.
 *
 *   npx tsx tests/backtest/extract_suite_comps.ts   -> tests/backtest/comps_hammer/suite_comps.jsonl (resumable)
 */
import "dotenv/config";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { closeDriver, resolveWorkIdentity, querySuiteComps, artistCatalogueEntries, type CatalogueEntryRow } from "../../src/appraisal/knowledge_graph/index";
import { getDriver, getDatabase } from "../../src/appraisal/knowledge_graph/client";

const D = "tests/backtest/comps_hammer";
const OUT = `${D}/suite_comps.jsonl`;
const CONCURRENCY = 6;

const entryCache = new Map<string, CatalogueEntryRow[]>();

async function main() {
  const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);
  const rows: any[] = [];
  for (const f of ["forum", "roseberys", "bonhams"]) for (const l of readFileSync(`${D}/${f}_n2500_blend_house.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.sold && r.hammer > 0 && r.blend && r.canonicalArtist && !r.error && !done.has(r.key)) rows.push(r);
  }
  console.log(`${rows.length} lots to extract (${done.size} done)`);
  let i = 0, n = 0, withSuite = 0;
  const worker = async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const saleLot = { saleId: String(r.saleId), lotNumber: Number(r.lotNumber) };
      let comps: any[] = [], workIds: string[] = [], error: string | null = null;
      try {
        const wi = await resolveWorkIdentity({ artistName: r.canonicalArtist, title: r.title ?? "", catalogueRefs: r.catalogueRefs ?? null, excludeSaleLot: saleLot });
        workIds = wi.workIds;
        if (!entryCache.has(r.canonicalArtist)) {
          const s = getDriver().session({ database: getDatabase() });
          try { entryCache.set(r.canonicalArtist, await artistCatalogueEntries(s, r.canonicalArtist)); } finally { await s.close(); }
        }
        const until = r.saleDate.slice(0, 10);
        const since = `${Number(until.slice(0, 4)) - 10}${until.slice(4)}`;
        // The live Stage 3a read (suite_comps.ts), with generic catalogue prefixes excluded.
        const res = await querySuiteComps({ artist: r.canonicalArtist, workIds, catalogueRefs: r.catalogueRefs ?? null, title: r.title ?? null, sinceDate: since, untilDate: until, excludeSaleLot: saleLot, excludeListingUrl: r.listingUrl ?? null, entries: entryCache.get(r.canonicalArtist) });
        comps = res.comps; error = res.error;
      } catch (e: any) { error = String(e?.message ?? e); }
      appendFileSync(OUT, JSON.stringify({ key: r.key, workIds: workIds.length, comps, error }) + "\n");
      n++; if (comps.length) withSuite++;
      if (n % 250 === 0) console.log(`  ${n}/${rows.length}, ${withSuite} with suite comps`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`done: ${n} lots, ${withSuite} with suite comps`);
  await closeDriver();
}
main();
