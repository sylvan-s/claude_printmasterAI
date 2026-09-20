/**
 * Pure tests for search_scope.ts and typo_tolerance.ts — the two read-side guards added on
 * 2026-09-13 after the A0793 run. Each case pins a real observation from that run.
 *
 *   npm run test:search-scope
 */
import { sanitizeSearchQuery, isExcludedUrl, filterExcludedResults, hasRef } from "../../src/appraisal/search_scope";
import { isTypoVariant, isSurnameTypoVariant, isDesignatorToken, osaDistanceAtMost } from "../../src/appraisal/knowledge_graph/typo_tolerance";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const ok = (label: string, cond: boolean) => eq(label, cond, true);

const ref = { house: "Roseberys London", saleId: "A0793", lotNumber: 530, listingUrl: "https://www.roseberys.co.uk/bidding/A0793-prints-multiples-673/530-nick-smith-radiant-baby-123" };

console.log("sanitizeSearchQuery");
{
  // The query Stage 2b actually sent on A0793/530.
  const r = sanitizeSearchQuery('Nick Smith "Radiant Baby" Roseberys lot 530 A0793 realised price sold', ref);
  ok("sale code, lot number and house removed", !/A0793/i.test(r.query) && !/lot 530/i.test(r.query) && !/roseberys/i.test(r.query));
  ok("the work survives", /Nick Smith "Radiant Baby"/.test(r.query) && /realised price sold/.test(r.query));
  eq("and it says what it removed", r.removed.length, 3);
  const keep = sanitizeSearchQuery('Picasso etching Roseberys auction result', ref);
  eq("the house alone is a legitimate search and is kept", keep.query, "Picasso etching Roseberys auction result");
  eq("no ref, no change", sanitizeSearchQuery("anything A0793 lot 530", null).query, "anything A0793 lot 530");
  eq("a query that is only identifiers is not emptied", sanitizeSearchQuery("A0793", ref).query, "A0793");
  eq("hasRef", [hasRef(null), hasRef({}), hasRef({ saleId: "A0793" })], [false, false, true]);
}

console.log("isExcludedUrl / filterExcludedResults");
{
  ok("the lot's own listing", isExcludedUrl(ref.listingUrl, ref));
  ok("same URL, http and trailing slash", isExcludedUrl("http://roseberys.co.uk/bidding/A0793-prints-multiples-673/530-nick-smith-radiant-baby-123/", ref));
  ok("a sibling lot in the same sale", isExcludedUrl("https://www.roseberys.co.uk/bidding/A0793-prints-multiples-673/12-other-lot", ref));
  ok("another sale at the same house is fine", !isExcludedUrl("https://www.roseberys.co.uk/bidding/A0785-prints-654/1-picasso", ref));
  ok("an unrelated site is fine", !isExcludedUrl("https://www.christies.com/lot/123", ref));
  const { results, dropped } = filterExcludedResults([{ url: ref.listingUrl! }, { url: "https://artprice.com/x" }], ref);
  eq("filter keeps the rest", [results.length, dropped.length], [1, 1]);
}

console.log("osaDistanceAtMost / isDesignatorToken");
{
  eq("substitution", osaDistanceAtMost("clegyr", "clegyd", 1), 1);
  eq("transposition counts as one", osaDistanceAtMost("clegry", "clegyr", 1), 1);
  eq("insertion", osaDistanceAtMost("thorgeson", "thorgerson", 1), 1);
  eq("two edits refused", osaDistanceAtMost("abcdef", "abxyef", 1), null);
  eq("identical", osaDistanceAtMost("same", "same", 1), 0);
  eq("designators", [isDesignatorToken("25"), isDesignatorToken("vii"), isDesignatorToken("V"), isDesignatorToken("man")], [true, true, true, false]);
}

console.log("isTypoVariant");
{
  ok("the A0793/67 case", isTypoVariant("clegry boia", "clegyr boia"));
  ok("an inserted letter", isTypoVariant("westminister abbey", "westminster abbey"));
  ok("identical is not a variant", !isTypoVariant("same title", "same title"));
  ok("roman numerals are never typos", !isTypoVariant("spinning man v", "spinning man vi"));
  ok("plate numbers are never typos", !isTypoVariant("composition pl 25", "composition pl 26"));
  ok("short tokens are not typos", !isTypoVariant("boia rock", "bois rock"));
  ok("two differing tokens", !isTypoVariant("the yellow house", "the mellow mouse"));
  ok("different word lengths", !isTypoVariant("harvest", "harvesting"));
  ok("token count must match", !isTypoVariant("westminster abbey", "westminster abbey ii"));
}

console.log("isSurnameTypoVariant");
{
  ok("the A0793/168 case", isSurnameTypoVariant("Storm Thorgeson", "Storm Thorgerson"));
  ok("with an initial", isSurnameTypoVariant("S Thorgeson", "Storm Thorgerson"));
  ok("identical surname is not a variant", !isSurnameTypoVariant("Pablo Picasso", "Paloma Picasso"));
  ok("different surnames", !isSurnameTypoVariant("Georges Braque", "Georges Rouault"));
  ok("single token", !isSurnameTypoVariant("Thorgeson", "Thorgerson"));
  ok("forename must still agree", !isSurnameTypoVariant("Peter Thorgeson", "Storm Thorgerson"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
