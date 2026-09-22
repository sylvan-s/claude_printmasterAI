/**
 * query_artsy_results (src/appraisal/artsy_results.ts), offline. The property that matters most
 * is the house filter: an ACKG house's sale reaching Stage 2b as an "independent" Artsy comp
 * counts one sale twice. Everything here runs without the network.
 *
 *   npm run test:artsy-results
 */
import {
  isAckgHouse, houseKeyTokens, filterAndTier, parseResultNode, titleKey, formatArtsyForModel,
  foldArtistName, artsyResultUrl, type ArtsyResultRow,
} from "../../src/appraisal/artsy_results";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (l: string, c: boolean) => eq(l, c, true);

let n = 0;
const row = (o: Partial<ArtsyResultRow>): ArtsyResultRow => ({
  id: String(++n), title: "Owl", organization: "Christie's", saleDate: "2025-03-01", saleTitle: null,
  lotNumber: String(n), mediumText: "Lithograph", dimensionText: null, dateText: null, currency: "GBP",
  boughtIn: false, estimateLow: null, estimateHigh: null, priceRealized: 1000, priceRealizedGBP: 1000,
  url: artsyResultUrl(String(n)), ...o,
});

console.log("the ACKG's own houses are removed, under every spelling Artsy uses");
{
  // The names as the graph holds them (2026-09-22), and the variants seen on Artsy.
  for (const h of [
    "Bonhams", "Bonhams Skinner", "Skinner", "Swann", "Swann Galleries", "Swann Auction Galleries",
    "Rosebery's", "Roseberys", "Roseberys London", "Forum Auctions", "Forum",
  ]) ok(`excluded: ${h}`, isAckgHouse(h));
  for (const h of [
    "Christie's", "Sotheby's", "Phillips", "Phillips de Pury & Company", "Kornfeld", "Artcurial",
    "Dorotheum", "Freeman's | Hindman", "Heritage Auctions", "Tate Ward", "Chiswick Auctions",
  ]) ok(`kept: ${h}`, !isAckgHouse(h));
  ok("a missing organisation is kept, not silently read as an ACKG house", !isAckgHouse(null));
  eq("house key folds apostrophes and drops city/legal noise", houseKeyTokens("Rosebery's London Ltd"), ["roseberys"]);
}

console.log("filterAndTier");
{
  const rows = [
    row({ title: "Owl, from Images (Wiseman 10)", organization: "Phillips", saleDate: "2025-06-01" }),
    row({ title: "Owl", organization: "Bonhams", saleDate: "2026-03-18" }),
    row({ title: "Horse and Rider IV", organization: "Christie's", saleDate: "2025-09-01" }),
    row({ title: "Owl", organization: "Rosebery's", saleDate: "2024-01-01" }),
  ];
  const f = filterAndTier(rows, { workTitle: "Owl" });
  eq("two ACKG-house rows dropped", f.droppedAckgHouse, 2);
  eq("same_work first, catalogue ref and series suffix ignored for the title match",
    f.rows.map((r) => [r.organization, r.tier]), [["Phillips", "same_work"], ["Christie's", "same_artist"]]);
  eq("the kept houses are reported for review", f.keptOrganizations, ["Christie's", "Phillips"]);

  const dupA = row({ title: "Owl", organization: "Artcurial", saleDate: "2017-04-05", lotNumber: "19" });
  const dupB = row({ title: "Hibou", organization: "Artcurial", saleDate: "2017-04-05", lotNumber: "19" });
  const d = filterAndTier([dupA, dupB, dupA], { workTitle: "Owl" });
  eq("house + date + lot duplicates collapse (Artcurial's French/English pairs)", [d.rows.length, d.droppedDuplicate], [1, 2]);

  const low = filterAndTier([row({ title: "Untitled" })], { workTitle: "Untitled" });
  eq("a low-information title never makes a same_work match", low.rows[0].tier, "same_artist");

  const exact = filterAndTier([row({ title: "Owl II" })], { workTitle: "Owl" });
  eq("near-miss titles are NOT same_work — exact identity only", exact.rows[0].tier, "same_artist");

  const cut = filterAndTier([row({ saleDate: "2025-01-01" }), row({ saleDate: "2025-06-01" })], { untilDate: "2025-06-01" });
  eq("backtest cut-off drops the sale date itself and later", [cut.rows.length, cut.droppedAfterCutoff], [1, 1]);

  const own = filterAndTier(
    [row({ organization: "Phillips", lotNumber: "46" }), row({ organization: "Christie's", lotNumber: "46" })],
    { excludeHouse: "Phillips", excludeLotNumber: 46 });
  eq("the lot's own listing is dropped, the same lot number at another house is not",
    [own.rows.map((r) => r.organization), own.droppedOwnLot], [["Christie's"], 1]);
}

console.log("parseResultNode");
{
  const r = parseResultNode({
    internalID: 7377173, title: "Owl", organization: "Christie's", saleDate: "2026-03-18T00:00:00.000Z",
    lotNumber: 30, currency: "GBP", boughtIn: false, estimate: { low: 200000, high: 300000 },
    priceRealized: { cents: 358400 },
  })!;
  eq("minor units become major, date trimmed, URL built", [r.priceRealized, r.estimateLow, r.saleDate, r.url],
    [3584, 2000, "2026-03-18", "https://www.artsy.net/auction-result/7377173"]);
  eq("GBP needs no conversion", r.priceRealizedGBP, 3584);
  const bi = parseResultNode({ internalID: 1, title: "x", boughtIn: true, priceRealized: { cents: 500 } })!;
  eq("a bought-in lot carries no price", bi.priceRealized, null);
  eq("a node without an id is rejected", parseResultNode({ title: "x" }), null);
}

console.log("identity folds");
{
  eq("artist fold: accents, case, punctuation", foldArtistName("Joan Miró"), foldArtistName("joan miro"));
  ok("artist fold keeps different names different", foldArtistName("After Joan Miro") !== foldArtistName("Joan Miro"));
  eq("title key strips a catalogue ref", titleKey("Horse and Rider IV (Wiseman 46)"), titleKey("Horse and Rider IV"));
}

console.log("model-facing text");
{
  const f = filterAndTier([row({ title: "Owl", organization: "Phillips" }), row({ organization: "Bonhams" })], { workTitle: "Owl" });
  const t = formatArtsyForModel({ slug: "elisabeth-frink", name: "Elisabeth Frink" }, f, 352);
  ok("states the premium-inclusive basis", /PREMIUM-INCLUSIVE/.test(t) && /premium_inclusive/.test(t));
  ok("says how many ACKG-house rows were removed", /Removed: 1 from houses already in the ACKG/.test(t));
  ok("carries the citable URL", t.includes("https://www.artsy.net/auction-result/"));
  ok("never shows the removed house's row", !/"house":"Bonhams"/.test(t));
  const empty = formatArtsyForModel({ slug: "x", name: "X" }, filterAndTier([]), 0);
  ok("empty is framed as coverage, not evidence", /coverage fact/.test(empty));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
