/**
 * Citation extraction from catalogue descriptions — the shared extractor and Forum's own copy.
 *
 * Every string below is real: page-cited catalogues (Czwiklitzer for Picasso's posters, Littmann
 * for Haring, Sorlier for Chagall) were dropped entirely because the entry token had to start with
 * a digit, so "(Czwiklitzer p.437)" never left the title (Roseberys A0793/305, 2026-09-17).
 *
 *   npm run test:catalogue-refs
 */
import assert from "node:assert/strict";
import { extractCatalogueRefs } from "../../src/shared/text_extraction";
import { extractCatalogueRefs as forumExtract } from "../../benchmark/src/forum/parse";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}
const both = (text: string) => [extractCatalogueRefs(text), forumExtract(text)];

test("page citation, no space", () => {
  for (const got of both("Le Clown et l'Harlequin (Czwiklitzer p.437)")) assert.deepEqual(got, ["Czwiklitzer p.437"]);
});
test("page citation, with space", () => {
  for (const got of both("International Volunteer Day (Littmann p. 93)")) assert.deepEqual(got, ["Littmann p. 93"]);
});
test("plural page marker", () => {
  for (const got of both("Une Femme (Sorlier pp. 12)")) assert.deepEqual(got, ["Sorlier pp. 12"]);
});
test("ordinary entry citation still parses", () => {
  for (const got of both("Exposition Vallauris [Bloch 1300]")) assert.deepEqual(got, ["Bloch 1300"]);
});
test("roman entry still parses", () => {
  for (const got of both("Composition (Corlett III.10)")) assert.deepEqual(got, ["Corlett III.10"]);
});
test("a colourway is not a citation", () => {
  for (const got of both("Cats (Pink)")) assert.deepEqual(got, []);
});
test("a plate designator is not a citation", () => {
  for (const got of both("Moïse (pl. 25)")) assert.deepEqual(got, []);
});
test("a bare page reference is not a citation", () => {
  for (const got of both("Head of a Woman (p. 258)")) assert.deepEqual(got, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
