/**
 * Unit tests for the Phase 0 comp-storability gates (no network, no Neo4j).
 *
 * Run: npm run test:comp-storability
 */
import assert from "node:assert/strict";
import {
  assessComp,
  assessComps,
  normalizePriceBasis,
  formatCompStorability,
  type Stage2bComp,
} from "../../src/appraisal/comp_storability";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL - ${name}\n         ${err.message}`);
  }
}

/** A comp that clears all three gates. */
function good(over: Partial<Stage2bComp> = {}): Stage2bComp {
  return {
    artworkTitle: "Flag (Silver)",
    artist: "Banksy",
    auctionHouse: "Bonhams",
    listingUrl: "https://www.bonhams.com/auction/12345/lot/46/",
    saleId: "12345",
    lotNumber: "46",
    priceAmount: 17212,
    priceCurrency: "GBP",
    priceBasis: "premium_inclusive",
    ...over,
  };
}

test("a fully-specified comp is storable", () => {
  const a = assessComp(good());
  assert.equal(a.storable, true);
  assert.equal(a.keyKind, "listing_url");
  assert.deepEqual(a.reasons, []);
});

test("house + saleId + lotNumber is a key when the URL is missing", () => {
  const a = assessComp(good({ listingUrl: null }));
  assert.equal(a.keyKind, "house_sale_lot");
  assert.equal(a.storable, true);
});

test("saleId and lot without the house do not identify a sale", () => {
  const a = assessComp(good({ listingUrl: null, auctionHouse: null }));
  assert.equal(a.keyKind, "none");
  assert.equal(a.storable, false);
  assert.ok(a.reasons.includes("no_key"));
});

test("a non-URL string is not a key", () => {
  // Observed failure mode: the model describes where it looked instead of linking it.
  for (const bad of ["search Bonhams for lot 46", "bonhams", "n/a", "", "  "]) {
    assert.equal(assessComp(good({ listingUrl: bad })).keyKind, "house_sale_lot", `for ${JSON.stringify(bad)}`);
  }
  assert.equal(assessComp(good({ listingUrl: "ftp://x.com/a" })).keyKind, "house_sale_lot");
});

test("a price echoed as a formatted string is not a numeric price", () => {
  // The whole point of priceAmount is that it is not "£5,245.51".
  const a = assessComp(good({ priceAmount: "£5,245.51" as any }));
  assert.equal(a.hasNumericPrice, false);
  assert.ok(a.reasons.includes("no_numeric_price"));
});

test("zero, negative, NaN and null prices are all rejected", () => {
  for (const p of [0, -100, NaN, null, undefined]) {
    assert.equal(assessComp(good({ priceAmount: p as any })).hasNumericPrice, false, `for ${p}`);
  }
});

test("currency must be an ISO code, not a symbol or a name", () => {
  assert.equal(assessComp(good({ priceCurrency: "gbp" })).hasCurrency, true, "case is normalised");
  for (const c of ["£", "pounds", "GB", "GBPX", null]) {
    assert.equal(assessComp(good({ priceCurrency: c as any })).hasCurrency, false, `for ${c}`);
  }
});

test('"unknown" basis blocks storage — the gate that matters most', () => {
  // A comp wrongly marked "hammer" understates every valuation built on it by the
  // buyer's premium; "unknown" is the honest answer and is kept out of the store.
  const a = assessComp(good({ priceBasis: "unknown" }));
  assert.equal(a.hasDeterminateBasis, false);
  assert.equal(a.storable, false);
  assert.ok(a.reasons.includes("basis_unknown"));
});

test("an absent, empty or unrecognised basis degrades to unknown, never to a guess", () => {
  for (const b of [null, undefined, "", "unclear", "hammer price maybe", "PREMIUM"]) {
    assert.equal(normalizePriceBasis(b), "unknown", `for ${JSON.stringify(b)}`);
  }
});

test("basis is recognised case- and separator-insensitively", () => {
  assert.equal(normalizePriceBasis("Hammer"), "hammer");
  assert.equal(normalizePriceBasis("premium inclusive"), "premium_inclusive");
  assert.equal(normalizePriceBasis("Premium-Inclusive"), "premium_inclusive");
});

test("the three gates are independent — one comp can fail several", () => {
  const a = assessComp({ artworkTitle: "x", artist: "y" });
  assert.deepEqual(a.reasons.sort(), ["basis_unknown", "no_iso_currency", "no_key", "no_numeric_price"].sort());
  assert.equal(a.storable, false);
});

test("assessComps counts each gate separately and splits the basis", () => {
  const r = assessComps([
    good(),
    good({ priceBasis: "hammer" }),
    good({ priceBasis: "unknown" }),
    good({ listingUrl: null, saleId: null }),
    { artworkTitle: "junk" },
  ]);
  assert.equal(r.total, 5);
  // storable: the two fully-specified comps. #3 fails on basis, #4 on key (saleId is
  // null so the house+sale+lot triple is incomplete), #5 on everything.
  assert.equal(r.storable, 2);
  assert.equal(r.withKey, 3);
  assert.equal(r.withNumericPrice, 4);
  assert.equal(r.withDeterminateBasis, 3);
  assert.deepEqual(r.basisCounts, { hammer: 1, premium_inclusive: 2, unknown: 2 });
  assert.equal(r.reasonCounts.no_key, 2);
});

test("assessComps tolerates a missing, null or non-array auctionComps", () => {
  for (const v of [undefined, null, "none", {}]) {
    const r = assessComps(v);
    assert.equal(r.total, 0);
    assert.equal(r.storable, 0);
  }
});

test("the report line carries the ratios Phase 0 is measuring", () => {
  const line = formatCompStorability(assessComps([good(), good({ priceBasis: "unknown" })]));
  assert.match(line, /1\/2 storable \(50%\)/);
  assert.match(line, /unknown=1/);
  assert.equal(formatCompStorability(assessComps([])), "0 comps");
});

test("a real ACKG-shaped comp round-trips as storable", () => {
  // Mirrors an actual SourceRecord: premium-inclusive realised price, GBP, real listing.
  const a = assessComp({
    artworkTitle: "Peintre et Modèle",
    artist: "Pablo Picasso",
    auctionHouse: "Bonhams",
    listingUrl: "https://www.bonhams.com/auction/28394/lot/112/",
    priceAmount: 5245.51,
    priceCurrency: "GBP",
    priceBasis: "premium_inclusive",
    saleDate: "2026-04-13",
  });
  assert.equal(a.storable, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
