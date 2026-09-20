/**
 * Pull Swann Galleries' print-relevant sale history into a flat catalogue file, mirroring
 * Roseberys' discover-then-pull shape (benchmark/src/roseberys/) and Bonhams'
 * tests/backtest/_pull_bonhams_catalogue.ts output convention (one JSON array of lot rows).
 *
 * Scope: sales dated within the last N years (default 10, per 2026-09-15 request) whose
 * title or department matches /print/i — see discover.ts's filterByKeyword() docstring for
 * why that's title-driven rather than a fixed department-ID list.
 *
 * This writes the RAW pull only — no artist/identity resolution, no catalogue-raisonné
 * parsing, no Neo4j writes. That's the same deliberate split Roseberys/Bonhams/Forum each
 * have between their benchmark/src pull tooling and knowledge_graph/*_ingest.py; a Swann
 * ingest adapter is a separate follow-up, not attempted here.
 *
 * Usage:
 *   npx tsx benchmark/src/swann/pull.ts                  # last 10 years, print sales
 *   npx tsx benchmark/src/swann/pull.ts --years 5
 *   npx tsx benchmark/src/swann/pull.ts --keyword print --out benchmark/data/swann/catalogue.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { discoverPastAuctions, filterByKeyword } from "./discover.ts";
import { fetchCatalogLots, type RawLot } from "./api.ts";

interface Args {
  years: number;
  keyword: string;
  out: string;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  return {
    years: Number(get("--years", "10")),
    // Word-bounded: a plain "print" substring also catches Swann's "Printed & Manuscript
    // Americana" / "Early Printed Books" sales — antiquarian books, not fine-art prints. See
    // discover.ts's filterByKeyword() docstring.
    keyword: get("--keyword", "\\bprints?\\b"),
    out: get("--out", "benchmark/data/swann/catalogue.json"),
    delayMs: Number(get("--delay-ms", "500")),
  };
}

interface CatalogueRow extends RawLot {
  saleCatalogRef: string;
  saleNumber: number | null;
  saleTitle: string;
  saleDepartment: string;
  saleDate: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceDate = new Date();
  sinceDate.setFullYear(sinceDate.getFullYear() - args.years);

  console.log(`Discovering sales since ${sinceDate.toISOString().slice(0, 10)} matching /${args.keyword}/i ...`);
  const allSales = await discoverPastAuctions({ sinceDate, delayMs: args.delayMs });
  const sales = filterByKeyword(allSales, args.keyword);
  console.log(`${allSales.length} sales in window, ${sales.length} match "${args.keyword}"`);

  const rows: CatalogueRow[] = [];
  const failures: { catalogRef: string; title: string; error: string }[] = [];

  for (const [i, sale] of sales.entries()) {
    process.stdout.write(
      `[${i + 1}/${sales.length}] Sale ${sale.saleNumber ?? "?"} — ${sale.title} (${sale.date.toISOString().slice(0, 10)}) ... `,
    );
    try {
      const lots = await fetchCatalogLots(sale.catalogRef, { delayMs: args.delayMs });
      for (const lot of lots) {
        rows.push({
          ...lot,
          saleCatalogRef: sale.catalogRef,
          saleNumber: sale.saleNumber,
          saleTitle: sale.title,
          saleDepartment: sale.department,
          saleDate: sale.date.toISOString().slice(0, 10),
        });
      }
      console.log(`${lots.length} lots`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${message}`);
      failures.push({ catalogRef: sale.catalogRef, title: sale.title, error: message });
    }
    await new Promise((r) => setTimeout(r, args.delayMs));
  }

  mkdirSync(args.out.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(args.out, JSON.stringify(rows));

  const sold = rows.filter((r) => r.sold).length;
  console.log(`\nWrote ${rows.length} lots from ${sales.length - failures.length}/${sales.length} sales to ${args.out}`);
  console.log(`  sold: ${sold}  unsold/passed: ${rows.length - sold}`);
  if (failures.length) {
    console.log(`  ${failures.length} sale(s) failed to pull:`);
    for (const f of failures) console.log(`    ${f.catalogRef} (${f.title}): ${f.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
