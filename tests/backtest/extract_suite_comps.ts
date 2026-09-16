/**
 * Same-suite comps for every sold backtest lot (2026-09-16 test of a "same book / suite" comp tier).
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
import { closeDriver, resolveWorkIdentity, citationsInRefs, citationsInTitle, foldPrefix } from "../../src/appraisal/knowledge_graph/index";
import { getDriver, getDatabase } from "../../src/appraisal/knowledge_graph/client";

const D = "tests/backtest/comps_hammer";
const OUT = `${D}/suite_comps.jsonl`;
const CONCURRENCY = 6;

const ENTRIES = `
MATCH (a:Artist {name: $artist})-[:CREATED]->(w:ConceptualWork)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
RETURN cr.numberingPrefix AS prefix, toString(ce.number) AS number, elementId(ce) AS entry, collect(DISTINCT w.id) AS works
`;
const SALES = `
MATCH (w:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
WHERE w.id IN $ids AND s.sourceType = 'auction' AND s.sold = true AND s.hammerPriceGBP > 0 AND s.saleDate IS NOT NULL
  AND substring(s.saleDate, 0, 10) >= $since AND substring(s.saleDate, 0, 10) < $until
  AND NOT (s.saleId = $saleId AND s.lotNumber = $lotNumber)
RETURN DISTINCT s.hammerPriceGBP AS hammer, substring(s.saleDate, 0, 10) AS date, s.institutionName AS house, w.id AS work
`;
const entryCache = new Map<string, { key: string; label: string; works: string[] }[]>();

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
      const s = getDriver().session({ database: getDatabase() });
      try {
        const wi = await resolveWorkIdentity({ artistName: r.canonicalArtist, title: r.title ?? "", catalogueRefs: r.catalogueRefs ?? null, excludeSaleLot: saleLot });
        workIds = wi.workIds;
        const cites = new Set([...citationsInRefs(r.catalogueRefs), ...citationsInTitle(r.title ?? "")].map((c) => `${c.prefix}|${c.number}`));
        if (!entryCache.has(r.canonicalArtist)) {
          const er = await s.run(ENTRIES, { artist: r.canonicalArtist });
          entryCache.set(r.canonicalArtist, er.records.map((x) => ({ key: `${foldPrefix(String(x.get("prefix") ?? ""))}|${String(x.get("number")).toLowerCase()}`, label: `${x.get("prefix")} ${x.get("number")}`, works: x.get("works") as string[] })));
        }
        // The lot's entries: those documenting its own resolved works, or matching a citation it prints.
        const entries = entryCache.get(r.canonicalArtist)!.filter((e) => e.works.some((w) => workIds.includes(w)) || cites.has(e.key));
        const siblings = new Map<string, string>();
        for (const e of entries) for (const w of e.works) if (!workIds.includes(w)) siblings.set(w, e.label);
        if (siblings.size) {
          const until = r.saleDate.slice(0, 10);
          const since = `${Number(until.slice(0, 4)) - 10}${until.slice(4)}`;
          const res = await s.run(SALES, { ids: [...siblings.keys()], since, until, saleId: saleLot.saleId, lotNumber: saleLot.lotNumber });
          comps = res.records.map((x) => ({ hammerGBP: x.get("hammer"), saleDate: x.get("date"), house: x.get("house"), work: x.get("work"), entry: siblings.get(x.get("work")) }));
        }
      } catch (e: any) { error = String(e?.message ?? e); }
      finally { await s.close(); }
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
