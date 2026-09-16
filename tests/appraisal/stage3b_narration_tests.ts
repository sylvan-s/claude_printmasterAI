/**
 * The Stage 3b figure guard and allowed-figure list. `npm run test:stage3b`
 */
import { checkFigures, allowedFigures, narrationText, type AllowedFigure } from "../../src/appraisal/stage3b_narration";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); } }

const allowed: AllowedFigure[] = [
  { label: "low", value: 960, kind: "money" }, { label: "high", value: 5600, kind: "money" }, { label: "median", value: 2300, kind: "money" },
  { label: "signature", value: 2.1, kind: "multiplier" }, { label: "house", value: 0.92, kind: "multiplier" },
  { label: "weight", value: 60, kind: "percent" }, { label: "comps", value: 13, kind: "count" }, { label: "latest", value: 2023, kind: "year" },
];
eq("allowed money, with separators and currency symbol", checkFigures("A range of £960–£5,600 with a median of £2,300.", allowed), []);
eq("multipliers in x and × forms", checkFigures("Hand signature x2.1; house ×0.92", allowed), []);
eq("allowed percent, count, year and small numbers", checkFigures("The model carries 60% of the weight; 13 sales, latest 2023, two or 3 prints.", allowed), []);
eq("an invented price is rejected", checkFigures("It could fetch £3,500.", allowed), ["3,500"]);
eq("an invented multiplier is rejected", checkFigures("Aquatint adds x1.4.", allowed), ["x1.4"]);
eq("an invented percent is rejected", checkFigures("A 25% premium.", allowed), ["25%"]);
eq("rounding within 1% of a money figure passes", checkFigures("about £2,310", allowed), []);
eq("an unlisted year is rejected", checkFigures("last sold in 2019", allowed), ["2019"]);
eq("narrationText joins every free-text field", narrationText({ headline: "h", narrative: "n", keyDrivers: [{ factor: "f", direction: "up", explanation: "e" }], caveats: ["c"] }), "h\nn\nf e\nc");

const r: any = {
  lowGBP: 961, medianGBP: 2283, highGBP: 5557, evidenceTier: "same_artist_technique",
  witnesses: [{ source: "priors_model", basis: "log-linear model, shrunk basis, 25 earlier sales", priceGBP: 1829, effectiveWeight: 0.6 }, { source: "same_work", basis: "3 prior sales of this work, latest 2023-05-01", priceGBP: 3000, effectiveWeight: 0.4 }],
  house: { multiplier: 0.919 }, printedEstimate: { low: 1200, high: 1800, currency: "GBP" },
  waterfall: { bars: [{ label: "Artist", kind: "factor", multiplier: 0.38, toGBP: 417 }, { label: "Fair-value median", kind: "total", multiplier: 1, toGBP: 2283 }] },
};
const est: any = { lowEstimate: 960, highEstimate: 5600, currency: "GBP", valuationReasoning: { anchorValue: 2300 } };
const list = allowedFigures(r, est, 1);
eq("witness counts and years become allowed figures", ["25", "3", "2023"].every((n) => list.some((a) => String(a.value) === n)), true);
eq("waterfall multipliers and running prices are allowed", [0.38, 420].every((v) => list.some((a) => a.value === v)), true);
eq("printed estimate figures are allowed as reference", [1200, 1800].every((v) => list.some((a) => a.value === v)), true);
const withEv = allowedFigures({ ...r, waterfall: { bars: [{ label: "Average sold print (31,920 auction sales)", kind: "baseline", multiplier: 1, toGBP: 1091 }, ...r.waterfall.bars] } }, est, 1, { comps: { items: [{ tier: "same_work", hammerGBP: 1000, saleDate: "2022-03-01", house: "Bonhams" }] }, valuationDate: { value: "2024-06-01" } } as any);
eq("derived figures: training count, 80% range, multiplier as % change, comp hammer and years", [checkFigures("Built on 31,920 sales, an 80% range; the artist sits 62% below average; it sold for £1,000 in 2022 and is valued in 2024.", withEv)], [[]]);
const labelled = allowedFigures({ ...r, waterfall: { bars: [{ label: "Edition: 850 (catalogue)", kind: "factor", multiplier: 0.9, toGBP: 500 }, { label: "Size: 2688 cm² (catalogue)", kind: "factor", multiplier: 1.1, toGBP: 550 }] } }, est, 1);
eq("attribute values printed in chart labels are allowed", checkFigures("an edition of 850 at 2,688 cm²", labelled), []);
eq("the proof premium band may be quoted", checkFigures("a modest proof premium of 5–10%", allowedFigures(r, est, 1)), []);
eq("still rejects an invented percent", checkFigures("a 38% discount", withEv), ["38%"]);
eq("USD conversion rounds witness prices", allowedFigures(r, { ...est, currency: "USD" }, 1.35).find((a) => a.label.startsWith("priors model price"))!.value, 2500);

console.log(`\nstage3b narration tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
