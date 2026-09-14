/**
 * Uncited Stage 2b comps must not reach Stage 3 (partitionCitedComps / describeUncitedComps).
 *
 * The specialist prompt already says a price with no URL behind it is not a comparable. This is
 * where that becomes enforcement rather than instruction. The cases below are the real ones:
 * Haiku's uncited Cindy Sherman figures, measured 2026-09-14, and the cited comps Sonnet
 * returned on the same lots which must still get through.
 *
 *   npm run test:comp-citation
 */
import { partitionCitedComps, describeUncitedComps } from "../../src/appraisal/comp_storability";
import type { Stage2bComp } from "../../src/appraisal/comp_storability";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (l: string, c: boolean) => eq(l, c, true);

// Verbatim from the Haiku arm of the Stage 2b comparison: no URL, no stated basis, famous
// series at small-print prices. On a re-run the same 1875 reappeared against a different title.
const haikuUncited: Stage2bComp[] = [
  { artworkTitle: "Untitled Film Still #96", auctionHouse: "Bonhams London", saleDate: "2023-05-16", priceAmount: 1875, priceCurrency: "GBP", priceBasis: "unknown", listingUrl: null },
  { artworkTitle: "Untitled (Centerfolds)", auctionHouse: "Sotheby's London", saleDate: "2022-11-08", priceAmount: 2400, priceCurrency: "GBP", priceBasis: "unknown", listingUrl: null },
];
// From the Sonnet arm of the same lot: cited, and must survive.
const sonnetCited: Stage2bComp[] = [
  { artworkTitle: "Untitled (Mother)", auctionHouse: "Bonhams", saleDate: "2024-12-03", priceAmount: 704, priceCurrency: "GBP", priceBasis: "premium_inclusive", listingUrl: "https://www.bonhams.com/auction/28424/lot/88/cindy-sherman-untitled/" },
];

console.log("partitionCitedComps");
{
  const p = partitionCitedComps([...sonnetCited, ...haikuUncited]);
  eq("cited through, uncited held back", [p.cited.length, p.uncited.length], [1, 2]);
  eq("and it is the cited one that survives", p.cited[0].artworkTitle, "Untitled (Mother)");

  // The gate is the CITATION alone. Basis is the write-back's problem; over-filtering here
  // would discard findings that are true.
  const unknownBasis = partitionCitedComps([{ ...sonnetCited[0], priceBasis: "unknown" }]);
  eq("a cited comp with an unstated basis still gets through", unknownBasis.cited.length, 1);

  eq("no comps at all", partitionCitedComps([]), { cited: [], uncited: [] });
  eq("a non-array never throws", partitionCitedComps(null), { cited: [], uncited: [] });
  eq("undefined never throws", partitionCitedComps(undefined), { cited: [], uncited: [] });
}

console.log("what counts as a citation");
{
  const url = (u: unknown) => partitionCitedComps([{ artworkTitle: "x", listingUrl: u as any }]).cited.length === 1;
  ok("an https URL", url("https://www.bonhams.com/auction/1/lot/2/x/"));
  ok("an http URL", url("http://example.com/lot/2"));
  ok("empty string is not a citation", !url(""));
  ok("null is not a citation", !url(null));
  ok("a bare domain is not a citation", !url("bonhams.com"));
  ok("an instruction is not a citation", !url("search Bonhams for the 2023 sale"));
  ok("a sale reference is not a citation", !url("Bonhams, sale 28424, lot 88"));
  ok("a URL with no dot in the host is not a citation", !url("https://localhost/lot/2"));
}

console.log("describeUncitedComps — the omission is reported, never silent");
{
  const d = describeUncitedComps(haikuUncited);
  ok("it says how many were withheld", d.includes("2 further web finding(s) were WITHHELD"));
  ok("it names them, so the omission is auditable", d.includes("Untitled Film Still #96") && d.includes("Bonhams London") && d.includes("1875"));
  ok("it says why", /no citation URL/.test(d));
  // A stage that found several figures it could not cite is telling you about its own quality.
  ok("it tells the valuation what to infer", /thin/.test(d) && /weigh the rest accordingly/.test(d));
  eq("nothing withheld, nothing said", describeUncitedComps([]), "");
  const many = describeUncitedComps(Array.from({ length: 9 }, (_, i) => ({ artworkTitle: `w${i}` })));
  ok("a long list is capped rather than flooding the prompt", (many.match(/"w\d"/g) ?? []).length === 6);
  ok("an untitled comp still gets named as such", describeUncitedComps([{ priceAmount: 100 }]).includes('"untitled"'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
