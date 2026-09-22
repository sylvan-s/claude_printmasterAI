/**
 * The Stage 2b escalation gate. Cases are the real outputs from the 2026-09-14 model
 * comparison, so a change that would have let the measured failure through fails here.
 *
 *   npm run test:stage2b-gate
 */
import { assessStage2bResearch, stage2bResearchFailed } from "../../src/appraisal/stage2b_gate";
import { isSpecificResultUrl } from "../../src/appraisal/comp_storability";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (l: string, c: boolean) => eq(l, c, true);
const cited = (t: string, p: number) => ({ artworkTitle: t, priceAmount: p, listingUrl: `https://www.bonhams.com/auction/1/lot/${p}/x/` });

console.log("escalates on the measured fabrication signature");
{
  // Verbatim shape from the Haiku arm on A0793/420: no URL, no basis, famous series, and the
  // same 1,875 recurring across three runs against three different titles.
  const g = assessStage2bResearch(
    { auctionComps: [
      { artworkTitle: "Untitled Film Still #96", priceAmount: 1875, priceBasis: "unknown", listingUrl: null },
      { artworkTitle: "Untitled (Centerfolds)", priceAmount: 2400, priceBasis: "unknown", listingUrl: null },
    ] },
    { searches: 1, graphSameWorkComps: 0 });
  ok("escalates", g.escalate);
  ok("names the reason", g.reasons.includes("uncited_comp"));
  ok("and says which comps, so the decision is auditable", g.detail.includes("Untitled Film Still #96") && g.detail.includes("1875"));
}

console.log("escalates on an uncited catalogue raisonné");
{
  const g = assessStage2bResearch(
    { auctionComps: [], catalogueRaisonne: { referenceFound: true, catalogueName: "Cramer", sourceUrl: null } },
    { searches: 2, graphSameWorkComps: 1 });
  eq("escalates for the same failure in another field", g.reasons, ["uncited_catalogue_raisonne"]);
  const withUrl = assessStage2bResearch(
    { auctionComps: [], catalogueRaisonne: { referenceFound: true, catalogueName: "Cramer", sourceUrl: "https://www.nga.gov/artworks/172477" } },
    { searches: 2, graphSameWorkComps: 1 });
  ok("a cited one passes", !withUrl.escalate);
  const noneFound = assessStage2bResearch(
    { auctionComps: [], catalogueRaisonne: { referenceFound: false, noCatalogueRaisonneExists: true } },
    { searches: 2, graphSameWorkComps: 1 });
  ok("'no catalogue exists' is a finding, not a failure", !noneFound.escalate);
}

console.log("silence is judged against whether there was a gap to close");
{
  // STEP 7 now tells Stage 2b to skip comp searches when the graph holds a same_work record, so
  // zero searches must NOT escalate there — gating on effort would punish the instruction.
  const covered = assessStage2bResearch({ auctionComps: [] }, { searches: 0, graphSameWorkComps: 3 });
  ok("no searches, but the graph already had the sale: passes", !covered.escalate);
  const gap = assessStage2bResearch({ auctionComps: [] }, { searches: 0, graphSameWorkComps: 0 });
  eq("no searches and no same-work sale: escalates", gap.reasons, ["no_search_despite_gap"]);
  const tried = assessStage2bResearch({ auctionComps: [] }, { searches: 1, graphSameWorkComps: 0 });
  ok("tried and found nothing: passes, because empty is an honest answer", !tried.escalate);
  // query_artsy_results (2026-09-22): a same-print sale from Artsy closes the gap as a graph
  // one does — the comparable was found by the cheap route, so no web search was owed.
  const viaArtsy = assessStage2bResearch({ auctionComps: [] }, { searches: 0, graphSameWorkComps: 0, artsySameWorkComps: 1 });
  ok("no searches, no graph sale, but Artsy had the same print: passes", !viaArtsy.escalate);
  const artsyNothing = assessStage2bResearch({ auctionComps: [] }, { searches: 0, graphSameWorkComps: 0, artsySameWorkComps: 0 });
  eq("Artsy called but no same-print sale anywhere, no search: still escalates", artsyNothing.reasons, ["no_search_despite_gap"]);
  const artsyUncited = assessStage2bResearch(
    { auctionComps: [{ artworkTitle: "Owl", priceAmount: 3584 }] },
    { searches: 0, graphSameWorkComps: 0, artsySameWorkComps: 1 });
  eq("an Artsy gap-closer does not excuse an uncited comp", artsyUncited.reasons, ["uncited_comp"]);
}

console.log("a URL must be able to show the sale (CITATION-URL-1.0)");
{
  // Verbatim from the first Artsy A/B, lot 389: an artist overview page cited for a price.
  const g = assessStage2bResearch(
    { auctionComps: [{ artworkTitle: "Three portraits", priceAmount: 2000, listingUrl: "https://www.artsy.net/artist/cindy-sherman" }] },
    { searches: 5, graphSameWorkComps: 0 });
  eq("an artist page is not a citation: escalates", g.reasons, ["uncited_comp"]);
  for (const u of [
    "https://www.artsy.net/artist/cindy-sherman/auction-results",
    "https://www.mutualart.com/Artist/Cindy-Sherman/1A2B3C",
    "https://www.artnet.com/artists/cindy-sherman/past-auction-results",
    "https://www.artnet.com/artists/cindy-sherman/",
    "https://www.google.com/search?q=cindy+sherman+three+portraits",
    "https://www.bonhams.com/search/?query=sherman",
    "https://www.christies.com/",
    "https://en.wikipedia.org/wiki/Cindy_Sherman",
  ]) ok(`not a result page: ${u}`, !isSpecificResultUrl(u));
  for (const u of [
    "https://www.artsy.net/auction-result/7377174",
    "https://www.artsy.net/artwork/cindy-sherman-untitled-1",
    "https://www.mutualart.com/Artwork/Three-portraits/9F8E7D",
    "https://www.artnet.com/artists/cindy-sherman/three-portraits-a-abc123",
    "https://www.bonhams.com/auction/32240/lot/12/cindy-sherman-three-portraits/",
    "https://www.christies.com/en/lot/lot-6123456",
    "https://www.roseberys.co.uk/bidding/A0785-prints-multiples-665/389-cindy-sherman",
    "https://www.someregionalhouse.de/katalog/123/los/45",
  ]) ok(`a result page: ${u}`, isSpecificResultUrl(u));
}

console.log("passes clean research");
{
  // The Sonnet arm on the same lots: every comp cited.
  const g = assessStage2bResearch(
    { auctionComps: [cited("Untitled (Mother)", 704), cited("Self Portrait with Sun Tan", 3900)],
      catalogueRaisonne: { referenceFound: false } },
    { searches: 4, graphSameWorkComps: 0 });
  eq("no reasons to escalate", [g.escalate, g.reasons], [false, []]);
  ok("and says what it checked", /2 comp\(s\), all cited/.test(g.detail) && /4 search/.test(g.detail));
}

console.log("never throws on a degraded or empty report");
{
  for (const [label, r] of [["null", null], ["empty object", {}], ["comps not an array", { auctionComps: "none" }]] as const) {
    const g = assessStage2bResearch(r, { searches: 2, graphSameWorkComps: 1 });
    ok(`${label} does not throw and does not escalate on nothing`, g.escalate === false);
  }
  const many = assessStage2bResearch({ auctionComps: [{ artworkTitle: "a" }, { artworkTitle: "b" }] }, { searches: 3, graphSameWorkComps: 2 });
  eq("two uncited comps, one reason", many.reasons, ["uncited_comp"]);
}

console.log("a cheap model that THREW is the strongest escalation signal");
{
  // Measured the first time the gate ran live: Haiku ended its turn on A0793/420 with a prose
  // summary instead of the required JSON, the parser raised, and the lot died. Under gating an
  // unusable result must escalate rather than kill the lot.
  const g = stage2bResearchFailed(new Error("Failed to parse web-search JSON output: No valid JSON object found in response"));
  eq("escalates with its own reason", [g.escalate, g.reasons], [true, ["research_failed"]]);
  ok("and carries what went wrong", /No valid JSON object found/.test(g.detail));
  ok("a non-Error is handled too", stage2bResearchFailed("socket hang up").detail.includes("socket hang up"));
  // Long provider errors must not flood the run log.
  ok("a very long message is trimmed", stage2bResearchFailed(new Error("x".repeat(900))).detail.length < 260);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
