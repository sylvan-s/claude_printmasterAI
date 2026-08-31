/**
 * Manual smoke test for queryAckg / queryAckgWorks — no pipeline involvement.
 * Usage: npm run query:ackg -- --technique Etching --region British
 *        npm run query:ackg -- --works --artist Rembrandt --workTitle "Death of the Virgin"
 *        npm run query:ackg  (runs a couple of default test cases)
 */
import { queryAckg, queryAckgWorks, closeDriver } from "./index.js";
import type { AckgQueryParams } from "./types.js";

function parseArgs(argv: string[]): AckgQueryParams {
  const params: AckgQueryParams = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!key || value === undefined) continue;
    if (key === "periodStartYear" || key === "periodEndYear" || key === "limit") {
      (params as any)[key] = Number(value);
    } else if (
      key === "technique" || key === "paper" || key === "subject" ||
      key === "region" || key === "workTitle" || key === "artist"
    ) {
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
  if (argv.includes("--works")) {
    const p = parseArgs(argv.filter((a) => a !== "--works")) as any;
    console.log(`\n${"=".repeat(70)}\nworks query — ${JSON.stringify(p)}\n${"=".repeat(70)}`);
    const works = await queryAckgWorks(p);
    if (works.length === 0) console.log("(no catalogued works match)");
    for (const w of works) {
      console.log(`\n  "${w.workTitle}" — ${w.artistName}${w.dateLabel ? ` (${w.dateLabel})` : ""}  [${w.impressionCount} impression(s), ${w.provenanceLayers.join("+") || "?"}]`);
      console.log(`    techniques: ${w.techniques.join(", ") || "—"}`);
      if (w.rawMediums.length) console.log(`    media: ${w.rawMediums.join(" | ")}`);
      const dims = (label: string, ds: { w: number; h: number }[]) => (ds.length ? `${label} ${ds.map((d) => `${d.w}x${d.h}mm`).join(", ")}` : "");
      const dline = [dims("plate", w.plateDimsMm), dims("image", w.imageDimsMm), dims("sheet", w.sheetDimsMm)].filter(Boolean).join("  ");
      if (dline) console.log(`    dims: ${dline}`);
      if (w.editionSizes.length) console.log(`    editions: ${w.editionSizes.join(", ")}`);
    }
    await closeDriver();
    return;
  }
  if (argv.length > 0) {
    await run("CLI query", parseArgs(argv));
  } else {
    await run("Default test 1", { technique: "Etching", region: "British" });
    await run("Default test 2", { technique: "Woodblock", periodStartYear: 1600, periodEndYear: 1868 });
  }
  await closeDriver();
}

main().catch((e) => { console.error(e); process.exit(1); });
