/**
 * Edition-size extraction: an imperial dimension fraction must never become an edition size
 * (no network, no LLM, no Neo4j).
 *
 * The regression that prompted this file: both the Forum parser and the shared
 * detectEditionSize() fell back to a bare /\d+\/(\d+)/ when there was no "edition of N", so
 * "510 x 647mm (20 x 25 3/8in)" gave an edition of 8. On 2026-09-17 that had put 1,442 priced
 * Forum sales (Hockney's offset lithographs, Rembrandt etchings, ...) into the <=30 edition band.
 *
 * Cases live in tests/fixtures/edition_size.jsonl, shared with the Python runner
 * (knowledge_graph/edition_size_test.py). See ADR-0020.
 *
 * Run: npm run test:edition-size
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDescription as parseForum } from "../../benchmark/src/forum/parse";
import { parseDescription as parseRoseberys } from "../../benchmark/src/roseberys/parse";
import { detectEditionSize } from "../../src/shared/text_extraction";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err: any) { failed++; console.error(`  FAIL - ${name}\n         ${err.message}`); }
}
const forum = (body: string) => parseForum(`<p>David Hockney (b.1937)</p><p>Dog 43</p><p>${body}</p>`).editionSize;

// Cases come from tests/fixtures/edition_size.jsonl — the SAME file
// knowledge_graph/edition_size_test.py reads. That shared file is the only thing holding the
// TypeScript mirrors and the Python rules together; there is no codegen, by ADR-0020.
//
// `expect` is what the MODEL rule (train_price_model.size_from_text_model, mirrored by
// price_attrs.ts editionSizeOf) must return. detectEditionSize is a narrower variant that does
// not read "one of N impressions" or the approximately/circa qualifiers and applies no five-digit
// cap, so the DIVERGENCE- cases are asserted against the ADR-0020 table instead.
interface Fixture { id: string; text: string; expect: number | null; why: string }
const FIXTURES: Fixture[] = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/edition_size.jsonl"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

// What detectEditionSize / the Forum parser return where they differ from `expect`.
const NARROW_VARIANT: Record<string, number | null> = {
  "DIVERGENCE-one-of-impressions": null,
  "DIVERGENCE-one-of-copies": null,
  "DIVERGENCE-edition-of-approximately": null,
  "DIVERGENCE-edition-of-circa": null,
  "DIVERGENCE-roman-numerator-arabic-denom": null,
};

for (const f of FIXTURES) {
  const want = f.id in NARROW_VARIANT ? NARROW_VARIANT[f.id] : f.expect;
  test(`Forum: ${want ?? "none"} <- ${f.id}`, () => assert.equal(forum(f.text), want));
  test(`shared detectEditionSize: ${want ?? "none"} <- ${f.id}`, () => assert.equal(detectEditionSize(f.text), want));
}

test("Roseberys (shared helper): cm dimensions with a fraction elsewhere give no edition", () => {
  const lot = parseRoseberys(`<p>David Hockney (British, b.1937)</p><p>Dog 43;</p><p>offset lithograph printed in colours, 20 1/2 x 25 1/2in (52 x 65cm)</p>`);
  assert.equal(lot.editionSize, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
