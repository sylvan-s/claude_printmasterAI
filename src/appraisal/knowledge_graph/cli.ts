/**
 * Manual smoke test for queryAckg — no pipeline involvement.
 * Usage: npm run query:ackg -- --technique Etching --region British
 *        npm run query:ackg  (runs a couple of default test cases)
 */
import { queryAckg, closeDriver } from "./index.js";
import type { AckgQueryParams } from "./types.js";

function parseArgs(argv: string[]): AckgQueryParams {
  const params: AckgQueryParams = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!key || value === undefined) continue;
    if (key === "periodStartYear" || key === "periodEndYear" || key === "limit") {
      (params as any)[key] = Number(value);
    } else if (key === "technique" || key === "paper" || key === "subject" || key === "region" || key === "workTitle") {
      (params as any)[key] = value;
    }
  }
  return params;
}

async function run(label: string, params: AckgQueryParams) {
  console.log(`\n${"=".repeat(70)}\n${label} — ${JSON.stringify(params)}\n${"=".repeat(70)}`);
  const candidates = await queryAckg(params);
  if (candidates.length === 0) {
    console.log("(no candidates — zero population support for this filter combination)");
    return;
  }
  for (const c of candidates) {
    console.log(
      `  ${c.artistName} — support=${c.supportCount} ` +
      `(institutional=${c.institutionalSupportCount}, auction=${c.auctionSupportCount})`
    );
    if (c.sampleWorks.length) console.log(`    e.g. ${c.sampleWorks.join(" | ")}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    await run("CLI query", parseArgs(argv));
  } else {
    await run("Default test 1", { technique: "Etching", region: "British" });
    await run("Default test 2", { technique: "Woodblock", periodStartYear: 1600, periodEndYear: 1868 });
  }
  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
