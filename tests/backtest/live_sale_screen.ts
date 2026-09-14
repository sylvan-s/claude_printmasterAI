/**
 * Plan step 9 — live screen: are any A0793 (Roseberys, 23 Sept 2026) lots by "tailwind" artists
 * priced under what the priors model + the Roseberys factor would imply?
 *
 * The sale has no hammer yet (it hasn't happened), so this compares the model's Bonhams-
 * referenced fair-hammer prediction, adjusted by the fitted Roseberys factor, against the
 * PRINTED ESTIMATE MIDPOINT — not the same statistic as the backtest's hammer-vs-model check,
 * stated plainly. Attributes are read live from the graph (A0793 is already ingested, pre-sale,
 * per SourceRecord.saleId='A0793' — confirmed 364 of 534 lots resolved, no estimateLowGBP yet,
 * same Roseberys unsold-estimate gap task_c3f61cab is fixing). Estimates below are transcribed
 * from the live roseberys.co.uk listing (2026-09-14) for the specific lots checked — this is a
 * hand-picked subset (the 8 artists whose past sales clustered among the >=2x winners in
 * priors_undervaluation_screen.ts), not an automated pass over all 534 lots.
 *
 *   npx tsx tests/backtest/live_sale_screen.ts
 */
import { queryArtistPriceProfile, priorsModelPrediction, priceAttrsOfComparable } from "../../src/appraisal/knowledge_graph/index";

const ln = Math.log;
const SALE_DATE = "2026-09-23";
const ROSEBERYS_INTERCEPT = -0.128, ROSEBERYS_PRIORS_COEF = 0.990, ROSEBERYS_HOUSE_COEF = 0.022; // from priors_undervaluation_screen.ts's fit

interface Lot {
  lot: number; artist: string; title: string; lowEst: number; highEst: number;
  rawMedium: string; signed: boolean | null; editionSize: number | null; sheet: string | null; image: string | null; plate: string | null;
}
const LOTS: Lot[] = [
  { lot: 99, artist: "Richard Hamilton", title: "Motel II", lowEst: 400, highEst: 600, rawMedium: "etching", signed: true, editionSize: 40, sheet: "34.0x41.0cm", image: null, plate: null },
  { lot: 157, artist: "Patrick Hughes", title: "Golden Venice", lowEst: 5000, highEst: 7000, rawMedium: "digital print in colours", signed: true, editionSize: 60, sheet: null, image: null, plate: null },
  { lot: 185, artist: "Antony Gormley", title: "Untitled 'Kings College Portfolio'", lowEst: 300, highEst: 500, rawMedium: "lithograph", signed: true, editionSize: 100, sheet: "38.0x37.5cm", image: null, plate: null },
  { lot: 219, artist: "Damien Hirst", title: "Butterfly rainbow (small) 2020", lowEst: 400, highEst: 600, rawMedium: "laminated giclee print", signed: true, editionSize: 5150, sheet: "50.0x23.0cm", image: null, plate: null },
  { lot: 220, artist: "Damien Hirst", title: "Spin paintings", lowEst: 2000, highEst: 3000, rawMedium: "4 gouaches", signed: true, editionSize: null, sheet: null, image: null, plate: null },
  { lot: 221, artist: "Damien Hirst", title: "Use Money Cheat Death", lowEst: 400, highEst: 500, rawMedium: "offset lithograph in colours record sleeve", signed: false, editionSize: 670, sheet: "30.0x30.0cm", image: null, plate: null },
  { lot: 222, artist: "Damien Hirst", title: "Blizzard, from Where the Land Meets the Sea", lowEst: 3000, highEst: 5000, rawMedium: "laminated Giclée print", signed: true, editionSize: 500, sheet: null, image: "90.0x135.0cm", plate: null },
  { lot: 224, artist: "Damien Hirst", title: "Forever (small) 2020", lowEst: 400, highEst: 600, rawMedium: "laminated giclée print", signed: true, editionSize: 2573, sheet: "39.0x39.0cm", image: null, plate: null },
  { lot: 225, artist: "Damien Hirst", title: "Lysergic Acid Diethylamide (LSD)", lowEst: 10000, highEst: 15000, rawMedium: "offset lithograph in colours printed", signed: true, editionSize: 300, sheet: "109.0x126.7cm", image: null, plate: null },
  { lot: 238, artist: "David Shrigley", title: "I hate humans", lowEst: 1000, highEst: 1500, rawMedium: "10 colour screenprint with no varnish overlay", signed: true, editionSize: 125, sheet: "75.0x56.0cm", image: null, plate: null },
  { lot: 240, artist: "David Shrigley", title: "How Fast Can You Run?", lowEst: 300, highEst: 500, rawMedium: "offset lithographic poster", signed: false, editionSize: 250, sheet: "70.0x50.0cm", image: null, plate: null },
  { lot: 455, artist: "Keith Haring", title: "Montreux Jazz Festival (green)", lowEst: 300, highEst: 500, rawMedium: "offset lithograph in colours", signed: false, editionSize: null, sheet: "100.0x70.0cm", image: null, plate: null },
  { lot: 456, artist: "Keith Haring", title: "Montreux Jazz Festival (orange)", lowEst: 300, highEst: 500, rawMedium: "offset lithograph in colours", signed: false, editionSize: null, sheet: "100.0x70.0cm", image: null, plate: null },
  { lot: 509, artist: "Banksy", title: "'Last run' deck, and Clown state boards", lowEst: 1000, highEst: 1500, rawMedium: "plywood deck with screenprint in colour", signed: false, editionSize: null, sheet: null, image: null, plate: null },
  { lot: 510, artist: "Banksy", title: "Banksy spray can", lowEst: 8000, highEst: 12000, rawMedium: "metal cylindrical can with overspray, signed in white paint", signed: true, editionSize: null, sheet: null, image: null, plate: null },
  { lot: 512, artist: "Banksy", title: "Flag", lowEst: 6000, highEst: 8000, rawMedium: "screenprint", signed: false, editionSize: 1000, sheet: "50.0x70.0cm", image: null, plate: null },
  { lot: 513, artist: "Banksy", title: "Flower and Rat", lowEst: 1000, highEst: 1500, rawMedium: "Two monochrome screenprints", signed: false, editionSize: 3, sheet: null, image: null, plate: null },
  { lot: 514, artist: "Banksy", title: "Migrants in a Boat", lowEst: 250, highEst: 350, rawMedium: "screenprint in colours", signed: false, editionSize: null, sheet: "50.0x69.5cm", image: null, plate: null },
  { lot: 515, artist: "Banksy", title: "GDP Rat", lowEst: 700, highEst: 1000, rawMedium: "monochrome screenprint", signed: false, editionSize: null, sheet: "38.5x50.5cm", image: null, plate: null },
  { lot: 516, artist: "Banksy", title: "Tesco Petrol Bomb", lowEst: 1000, highEst: 1500, rawMedium: "offset lithograph in colours", signed: true, editionSize: null, sheet: "48.7x39.0cm", image: null, plate: null },
  { lot: 517, artist: "Banksy", title: "Welcome Mat", lowEst: 800, highEst: 1200, rawMedium: "hand-stitched welcome mat using fabric from life vests", signed: false, editionSize: null, sheet: null, image: null, plate: null },
];

async function main() {
  const rows: { lot: Lot; predictedMid: number; residual: number; basis: string }[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof queryArtistPriceProfile>>>();
  for (const lot of LOTS) {
    if (!cache.has(lot.artist)) cache.set(lot.artist, await queryArtistPriceProfile(lot.artist));
    const profile = cache.get(lot.artist)!;
    if (!profile) { console.log(`  no priors profile for ${lot.artist} — skipping lot ${lot.lot}`); continue; }
    const attrs = priceAttrsOfComparable({ techniques: [], signed: lot.signed, editionSize: lot.editionSize, rawMedium: lot.rawMedium, copyType: "numbered", plateDimensions: lot.plate, imageDimensions: lot.image, sheetDimensions: lot.sheet });
    const pred = priorsModelPrediction(attrs, profile, { saleDate: SALE_DATE, house: "Bonhams" });
    const predictedRoseberysLog = ROSEBERYS_INTERCEPT + ROSEBERYS_PRIORS_COEF * pred.mu + ROSEBERYS_HOUSE_COEF * 1;
    const estMidLog = ln((lot.lowEst + lot.highEst) / 2);
    rows.push({ lot, predictedMid: Math.exp(predictedRoseberysLog), residual: estMidLog - predictedRoseberysLog, basis: profile.basis });
  }
  rows.sort((a, b) => a.residual - b.residual);
  console.log(`\n${rows.length} lots scored (Bonhams-referenced priors fair value x Roseberys factor, vs printed estimate midpoint)\n`);
  console.log(`${"lot".padStart(4)}  ${"artist / title".padEnd(42)} ${"est mid".padStart(9)}  ${"model fair £".padStart(12)}  ${"ratio".padStart(7)}  basis`);
  for (const r of rows) {
    const estMid = (r.lot.lowEst + r.lot.highEst) / 2;
    const ratio = estMid / r.predictedMid;
    const flag = ratio < 0.8 ? " <-- looks cheap vs model" : ratio > 1.5 ? " (model thinks this is pricey)" : "";
    console.log(`${String(r.lot.lot).padStart(4)}  ${(r.lot.artist + " / " + r.lot.title).slice(0, 42).padEnd(42)} £${estMid.toFixed(0).padStart(8)}  £${r.predictedMid.toFixed(0).padStart(11)}  ${ratio.toFixed(2).padStart(6)}x  ${r.basis}${flag}`);
  }
}

main();
