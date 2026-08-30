/**
 * One-off fixture surgery. The stored Stage 1 fixtures predate the `c9e8861` VEA change
 * ("never estimate dimensions without a scale reference"): their stage1a_vea.dimensions
 * still carry `estimated_from_PRIMARY_SCAN` guesses (±15-20%), which the Attribution
 * Evidence Agent then compares against the appraiser's real figure and logs as a false
 * conflict. For this backtest, dimensions come from Stage 1c (the appraiser) only.
 *
 * Rather than re-run VEA (Opus, £), this rewrites every pool_output/<id>/stage1.json in
 * place so dimensions read as "no_scale_reference" with null measurements — the shape a
 * post-c9e8861 VEA run would produce for these lots. Idempotent.
 *
 *   npx tsx tests/backtest/strip_vea_dimensions.ts          # apply
 *   npx tsx tests/backtest/strip_vea_dimensions.ts --dry    # list what would change
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "tests/backtest/pool_output");
const DRY = process.argv.includes("--dry");

const CLEARED = {
  sourceImage: "no_scale_reference",
  printedImageMM: null,
  fullSheetMM: null,
  marginCondition: "original",
  dimensionsConfidence: 0,
};

let changed = 0;
let clean = 0;
for (const id of readdirSync(DIR).sort()) {
  const p = join(DIR, id, "stage1.json");
  if (!existsSync(p)) continue;
  const f = JSON.parse(readFileSync(p, "utf8"));
  const d = f?.stage1a_vea?.dimensions;
  if (!d) {
    clean++;
    continue;
  }
  const hadMeasurements = !!(d.printedImageMM || d.fullSheetMM) || d.sourceImage !== "no_scale_reference";
  if (!hadMeasurements) {
    clean++;
    continue;
  }
  console.log(
    `${id}: sourceImage=${d.sourceImage} printedImageMM=${JSON.stringify(d.printedImageMM)} fullSheetMM=${JSON.stringify(d.fullSheetMM)} -> cleared`,
  );
  if (!DRY) {
    f.stage1a_vea.dimensions = { ...CLEARED };
    f.stage1a_vea.__dimensionsStrippedForBacktest = true;
    writeFileSync(p, JSON.stringify(f, null, 2));
  }
  changed++;
}

console.log(`\n${DRY ? "[dry run] " : ""}${changed} fixture(s) ${DRY ? "would be" : ""} updated, ${clean} already clean`);
