/**
 * The Stage 3b figure guard and allowed-figure list. `npm run test:stage3b`
 */
import { checkDirections, checkFigures, allowedFigures, narrationText, type AllowedFigure } from "../../src/appraisal/stage3b_narration";

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
const withEv = allowedFigures({ ...r, waterfall: { bars: [{ label: "Average house estimate (60,899 auction lots)", kind: "baseline", multiplier: 1, toGBP: 1091 }, ...r.waterfall.bars] } }, est, 1, { comps: { items: [{ tier: "same_work", hammerGBP: 1000, saleDate: "2022-03-01", house: "Bonhams" }] }, valuationDate: { value: "2024-06-01" } } as any);
eq("derived figures: training count, 80% range, multiplier as % change, comp hammer and years", [checkFigures("Built on 60,899 lots, an 80% range; the artist sits 62% below average; it sold for £1,000 in 2022 and is valued in 2024.", withEv)], [[]]);
const labelled = allowedFigures({ ...r, waterfall: { bars: [{ label: "Edition: 850 (catalogue)", kind: "factor", multiplier: 0.9, toGBP: 500 }, { label: "Size: 2688 cm² (catalogue)", kind: "factor", multiplier: 1.1, toGBP: 550 }] } }, est, 1);
eq("attribute values printed in chart labels are allowed", checkFigures("an edition of 850 at 2,688 cm²", labelled), []);
eq("the proof premium band may be quoted", checkFigures("a modest proof premium of 5–10%", allowedFigures(r, est, 1)), []);
eq("still rejects an invented percent", checkFigures("a 38% discount", withEv), ["38%"]);
eq("USD conversion rounds witness prices", allowedFigures(r, { ...est, currency: "USD" }, 1.35).find((a) => a.label.startsWith("priors model price"))!.value, 2500);

// ── direction check (2026-09-17) ────────────────────────────────────────────────
{
  const bars = [
    { key: "baseline", label: "David Hockney, lithograph: reference", kind: "baseline", multiplier: 1 },
    { key: "signature", label: "Signature: hand (catalogue)", kind: "factor", multiplier: 1 },
    { key: "impression", label: "Impression status: numbered impression (catalogue)", kind: "factor", multiplier: 1 },
    { key: "edition", label: "Edition: 30 (catalogue)", kind: "factor", multiplier: 0.75 },
    { key: "calibration", label: "Model calibration to house estimates", kind: "factor", multiplier: 0.84 },
    { key: "comps", label: "Market comps: same artist technique", kind: "comps", multiplier: 0.78 },
    { key: "total", label: "Fair-value median", kind: "total", multiplier: 1 },
  ];
  const n = (narrative: string, keyDrivers: any[] = [], headline = "Fair value.") => ({ headline, narrative, keyDrivers });
  // the real Hockney narration that got it backwards
  const hockney = "This lot is hand-signed and numbered, matching the reference, but has a smaller edition of 30, which adds value in the model. The pricing model yields 3,000 GBP.";
  eq("the Hockney 'smaller edition adds value' sentence is rejected", checkDirections(n(hockney), bars).length, 1);
  eq("the same sentence, right way round, passes", checkDirections(n("This lot matches the reference, but its smaller edition of 30 reduces the price in the model."), bars), []);
  eq("comps 'well below the model' agrees with a x0.78 comps step", checkDirections(n("Realised sales of Hockney lithographs show a median of 1,100 GBP, well below the model, and pull the fair value down."), bars), []);
  eq("comps said to push the price up is rejected", checkDirections(n("The market comps push the price up."), bars).length, 1);
  eq("a negated phrase is not judged", checkDirections(n("The edition does not add value here."), bars), []);
  eq("a sentence with no step mention is not judged", checkDirections(n("Prices rose sharply in 2021."), bars), []);
  eq("a matching step (x1.00) is not judged", checkDirections(n("The signature adds value."), bars), []);
  eq("a key driver marked up against a down step is rejected", checkDirections(n("Fine.", [{ factor: "Edition size", direction: "up", explanation: "Editions of 30 are scarcer." }]), bars).length, 1);
  eq("a key driver marked down against a down step passes", checkDirections(n("Fine.", [{ factor: "Edition: 30", direction: "down", explanation: "A smaller edition than the reference reduces this artist's prices." }]), bars), []);
  const unsignedBars = [{ key: "signature", label: "Signature: unsigned (catalogue)", kind: "factor", multiplier: 0.65 }, { key: "comps", label: "Market comps", kind: "comps", multiplier: 1.1 }];
  eq("live false positive: 'hand-signed sell for more; this lot is unsigned, a 35% discount' passes", checkDirections(n("Hand-signed impressions of this artist sell for more; this lot is unsigned, a 35% discount to the reference."), unsignedBars), []);
  eq("'signed impressions carry a premium' about an unsigned lot agrees", checkDirections(n("Signed impressions carry a premium this lot does not share."), unsignedBars), []);
  eq("'the unsigned signature adds value' is still rejected", checkDirections(n("Being unsigned adds value here."), unsignedBars).length, 1);
  // live false positives from the 20-lot check, 2026-09-17
  const liveBars = [{ key: "comps", label: "Market comps", kind: "comps", multiplier: 0.72 }, { key: "year", label: "Market level: 2023", kind: "factor", multiplier: 1.16 },
                    { key: "house", label: "Sale house: Roseberys London", kind: "factor", multiplier: 0.8 }, { key: "calibration", label: "Model calibration to house estimates", kind: "factor", multiplier: 0.84 },
                    { key: "signature", label: "Signature: unsigned (catalogue)", kind: "factor", multiplier: 0.96 }];
  eq("comps subject, market level named in passing: not the year step", checkDirections(n("One realised sale of a Bazaine lithograph at Roseberys London, re-based to 2023 market level, pulls the estimate down 28% to a fair-value median of 160 GBP."), liveBars), []);
  eq("'which raises' goes to the year; 'house-level discount' goes to the house", checkDirections(n("The valuation year 2022 was a stronger market than 2025, which raises the price by 30%, but this is offset by Roseberys London's house-level discount and the model's calibration to the house's own estimate practice."), liveBars), []);
  eq("unsigned vs hand-signed reference, 'reducing value': both levels named, not judged", checkDirections(n("This impression is unsigned, whereas the reference print is hand-signed, reducing value by 4%."), liveBars), []);
  const lv = allowedFigures({ ...r, waterfall: { bars: [{ key: "house", label: "Sale house: Roseberys London", kind: "factor", multiplier: 0.92, toGBP: 900 }] } } as any, est, 1);
  eq("live figure gaps: 'prices at 92% of Bonhams' level' and 'large (42–87 cm a side)' are allowed", checkFigures("Roseberys London prices at 92% of Bonhams' level; the reference is large (42–87 cm a side).", lv), []);
  const live2 = [{ key: "comps", label: "Market comps: same work, same artist", kind: "comps", multiplier: 1.82 }, { key: "calibration", label: "Model calibration to house estimates", kind: "factor", multiplier: 0.31 },
                 { key: "year", label: "Market level: 2023", kind: "factor", multiplier: 1.16 }];
  eq("'calibrated to ... comparable lots ...; this lowers': the subject is calibration", checkDirections(n("The pricing model is calibrated to Roseberys London's own estimate levels for comparable lots, which are lower than the segment default; this lowers the price by 69%."), live2), []);
  eq("'a same-technique sale ... re-based to the valuation year pulls the price down': the subject is the comp", checkDirections(n("A same-artist, same-technique sale from 2019 re-based to Roseberys London and the valuation year pulls the price down by 22%, from 500 GBP to 390 GBP."), [{ key: "comps", label: "Market comps", kind: "comps", multiplier: 0.78 }, ...live2.slice(1)]), []);
  // 30-lot live check: correct sentences naming several steps are not judged
  const live3 = [{ key: "comps", label: "Market comps: same artist technique", kind: "comps", multiplier: 1.14 }, { key: "year", label: "Market level: 2023", kind: "factor", multiplier: 1.16 },
                 { key: "house", label: "Sale house: Roseberys London", kind: "factor", multiplier: 0.92 }, { key: "calibration", label: "Model calibration to house estimates", kind: "factor", multiplier: 0.84 },
                 { key: "signature", label: "Signature: unsigned (catalogue)", kind: "factor", multiplier: 0.6 }];
  for (const sentence of [
    "Forum Auctions' 15% discount and the 2023 market level adjust the model price to 3,900 GBP.",
    "The 80% range, 4,400–16,000 GBP, reflects the strength of the same-work comps and the modest uncertainty from the unsigned status and house-level discount.",
    "The market comps—a realised sale of the same artist's screenprint technique, re-based to Roseberys and the valuation year 2023—further pull the estimate down to a fair-value median of 390 GBP.",
    "The pricing model is shrunk toward Roseberys London's own estimates for comparable lots, reducing the price by 16%.",
    "Roseberys London prices at 92% of Bonhams' level for comparable lots, lowering the price by 8%.",
  ]) eq(`multi-step sentence not judged: ${sentence.slice(0, 50)}`, checkDirections(n(sentence), live3), []);
  const live4 = [{ key: "comps", label: "Market comps: same work", kind: "comps", multiplier: 1.29 }, { key: "house", label: "Sale house: Forum Auctions", kind: "factor", multiplier: 0.85 },
                 { key: "year", label: "Market level: 2022", kind: "factor", multiplier: 1.3 }, { key: "calibration", label: "Model calibration to house estimates", kind: "factor", multiplier: 0.84 }];
  eq("comp 're-based to Forum Auctions ... pull the price up' is about the comp", checkDirections(n("Forever (Large) re-based to Forum Auctions and market-adjusted to 2026 pull the price up by 29%, to 1,200 GBP; this is the strongest evidence, weighted at 67%."), live4), []);
  eq("'set to 2022 prices ... higher than 2025 Bonhams baseline' is not judged as the house", checkDirections(n("The valuation is set to 2022 prices, which were 30% higher than 2025 Bonhams baseline; this pulls the fair value up from the model's 2025 reference."), live4), []);
  eq("'shrunk toward house estimates for comparable lots, reducing' is calibration, and agrees", checkDirections(n("The pricing model is shrunk toward house estimates for comparable lots, reducing the price by 16%."), live4), []);
  eq("...and calibration said to raise the price is still caught", checkDirections(n("The pricing model is shrunk toward house estimates for comparable lots, raising the price."), live4).length, 1);
  eq("calibration adjusting down agrees", checkDirections(n("Model calibration to house estimates lowers the model price."), bars), []);
}

console.log(`\nstage3b narration tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
