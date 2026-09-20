/**
 * Gates for the Stage 2b comps write-back (ADR-0007's auction-comp slice).
 * Pure — the identity and dedupe gates need the graph and are exercised by a live run.
 *
 *   npm run test:research-comps
 */
import { gateComp, researchCompId, normaliseSaleDate, WRITEABLE_WORK_BASES } from "../../src/appraisal/knowledge_graph/write_research_comps";
import type { Stage2bComp } from "../../src/appraisal/comp_storability";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (l: string, c: boolean) => eq(l, c, true);

/** A comp that passes every pure gate; each case below breaks exactly one thing. */
const good: Stage2bComp = {
  artworkTitle: "Snigger, from Engravings with Sounds", artist: "John Baldessari",
  technique: "Archival inkjet print in colours", saleDate: "2026-06-23", auctionHouse: "Bonhams",
  listingUrl: "https://www.bonhams.com/auction/32236/lot/108/john-baldessari-snigger/",
  saleId: "32236", lotNumber: "108", priceAmount: 1000, priceCurrency: "GBP", priceBasis: "hammer",
  wasSoldInBroaderLot: false,
};

console.log("gateComp — hammer basis only");
{
  const g = gateComp(good);
  eq("a complete hammer comp passes", [g.ok, g.reason], [true, null]);
  eq("and is normalised", g.value, { listingUrl: good.listingUrl, house: "Bonhams", saleDate: "2026-06-23", price: 1000, basis: "hammer", currency: "GBP", saleId: "32236", lotNumber: 108, title: good.artworkTitle, technique: good.technique });

  // A premium-inclusive figure is REAL DATA and is kept — it just goes in the realised field,
  // which is what every ingested record already does. Refusing it (the first cut of this
  // module) threw away 4 of 4 comps on the first lots for no safety gain.
  const p = gateComp({ ...good, priceBasis: "premium_inclusive" });
  eq("premium-inclusive is admitted, and carries its basis", [p.ok, p.value?.basis, p.value?.price], [true, "premium_inclusive", 1000]);

  // What stays refused is a number nobody stated a basis for: it cannot go in either field
  // without a guess, and a guess is unrepairable later because nothing records it as one.
  eq("unknown basis is refused", gateComp({ ...good, priceBasis: "unknown" }).reason, "basis_unknown");
  eq("a missing basis is refused", gateComp({ ...good, priceBasis: null }).reason, "basis_unknown");
  eq("an unrecognised basis string is refused", gateComp({ ...good, priceBasis: "net" }).reason, "basis_unknown");
}

console.log("gateComp — the basis decides the field, never the value");
{
  // The whole point of admitting premium: the SAME number means different things, and the
  // record must say which. A hammer 1,000 and a realised 1,000 are not interchangeable.
  const h = gateComp({ ...good, priceBasis: "hammer" }).value!;
  const r = gateComp({ ...good, priceBasis: "premium_inclusive" }).value!;
  eq("same number, different basis", [h.price, r.price], [1000, 1000]);
  eq("and the basis is carried, not inferred", [h.basis, r.basis], ["hammer", "premium_inclusive"]);
  ok("both produce the same dedupe id — it is the SALE that is unique, not the basis", researchCompId(h) === researchCompId(r));
}

console.log("gateComp — the citation is the evidence and the key");
{
  eq("no URL", gateComp({ ...good, listingUrl: null }).reason, "no_citation_url");
  eq("a bare phrase is not a URL", gateComp({ ...good, listingUrl: "bonhams sale 32236" }).reason, "no_citation_url");
}

console.log("gateComp — a price must be a number with a currency");
{
  eq("no amount", gateComp({ ...good, priceAmount: null }).reason, "no_numeric_price");
  eq("zero is not a price", gateComp({ ...good, priceAmount: 0 }).reason, "no_numeric_price");
  eq("no currency", gateComp({ ...good, priceCurrency: null }).reason, "no_currency");
  eq("a currency symbol is not a code", gateComp({ ...good, priceCurrency: "£" }).reason, "no_currency");
  eq("a currency code is upper-cased", gateComp({ ...good, priceCurrency: "usd" }).value?.currency, "USD");
}

console.log("gateComp — a sale needs a date and a house");
{
  eq("no date", gateComp({ ...good, saleDate: null }).reason, "no_sale_date");
  eq("unparseable date", gateComp({ ...good, saleDate: "summer 2026" }).reason, "no_sale_date");
  eq("no house", gateComp({ ...good, auctionHouse: "  " }).reason, "no_auction_house");
  eq("a prose date is normalised", gateComp({ ...good, saleDate: "23 June 2026" }).value?.saleDate, "2026-06-23");
  eq("an ISO timestamp is truncated", normaliseSaleDate("2026-06-23T13:00:00+00:00"), "2026-06-23");
}

console.log("gateComp — a group lot price is not this work's price");
{
  eq("sold in a broader lot is refused", gateComp({ ...good, wasSoldInBroaderLot: true }).reason, "sold_in_broader_lot");
}

console.log("gateComp — a lot number that is not a number");
{
  eq("'108A' is kept as no lot number rather than guessed", gateComp({ ...good, lotNumber: "108A" }).value?.lotNumber, null);
  eq("and the comp still passes", gateComp({ ...good, lotNumber: "108A" }).ok, true);
}

console.log("researchCompId — deterministic, so a re-run updates rather than duplicates");
{
  const a = researchCompId(gateComp(good).value!);
  const b = researchCompId(gateComp({ ...good, listingUrl: good.listingUrl!.replace("https://www.", "http://") }).value!);
  eq("scheme and www do not change the id", a, b);
  ok("it is namespaced", a.startsWith("agentresearch-"));
  const other = researchCompId(gateComp({ ...good, listingUrl: "https://www.bonhams.com/auction/32236/lot/109/x/" }).value!);
  ok("a different lot is a different id", a !== other);
}

console.log("WRITEABLE_WORK_BASES — read-side identity levels must not drive a write");
{
  eq("the exact levels only", [...WRITEABLE_WORK_BASES], ["exact_title", "citation", "citation_and_title"]);
  ok("stripped_title is excluded", !WRITEABLE_WORK_BASES.includes("stripped_title" as any));
  ok("stripped_no_series is excluded", !WRITEABLE_WORK_BASES.includes("stripped_no_series" as any));
  ok("typo_title is excluded", !WRITEABLE_WORK_BASES.includes("typo_title" as any));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
