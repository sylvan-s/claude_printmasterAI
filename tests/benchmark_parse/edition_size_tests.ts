/**
 * Edition-size extraction: an imperial dimension fraction must never become an edition size
 * (no network, no LLM, no Neo4j).
 *
 * The regression that prompted this file: both the Forum parser and the shared
 * detectEditionSize() fell back to a bare /\d+\/(\d+)/ when there was no "edition of N", so
 * "510 x 647mm (20 x 25 3/8in)" gave an edition of 8. On 2026-09-17 that had put 1,442 priced
 * Forum sales (Hockney's offset lithographs, Rembrandt etchings, ...) into the <=30 edition band.
 *
 * Run: npm run test:edition-size
 */
import assert from "node:assert/strict";
import { parseDescription as parseForum } from "../../benchmark/src/forum/parse";
import { parseDescription as parseRoseberys } from "../../benchmark/src/roseberys/parse";
import { detectEditionSize } from "../../src/shared/text_extraction";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err: any) { failed++; console.error(`  FAIL - ${name}\n         ${err.message}`); }
}
const forum = (body: string) => parseForum(`<p>David Hockney (b.1937)</p><p>Dog 43</p><p>${body}</p>`).editionSize;

// [body text, expected edition size]
const CASES: [string, number | null][] = [
  // dimensions only: the bug
  ["Offset lithograph printed in colours, on wove paper, 530 x 648mm (20 7/8 x 25 1/2in) (framed)", null],
  ["Offset lithograph printed in colours, 1995, 419 x 297mm (16 1/2 x 11 3/4in)", null],
  ["Etching, circa 1640, a later impression, sheet 95 x 64mm (3 3/4 x 2 1/2in)", null],
  ["Screenprint in colours, signed in pencil, 700 x 500mm (27 1/2 x 19 5/8in)", null],
  ["Lithograph, 1980, a proof before the edition, 613 x 625mm (24 1/8 x 24 5/8in)", null],
  // real numbering must still read
  ["Lithograph in sepia, 1980, signed, dated and numbered 21/30 in pencil, 613 x 625mm (24 1/8 x 24 5/8in)", 30],
  ["Etching, signed and numbered '12/50' in pencil, 250 x 200mm (9 7/8 x 7 7/8in)", 50],
  ["Screenprint, numbered in pencil 3/8, on wove paper", 8],
  ["Screenprint, No. 45/250, on wove paper, 500 x 700mm (19 5/8 x 27 1/2in)", 250],
  ["Etching, 1982, signed, titled, dated and numbered from the edition of 80 in pencil, 510 x 647mm (20 x 25 3/8in)", 80],
  // "edition of" wins over a later fraction
  ["Aquatint, from the edition of 150, 300 x 400mm (11 3/4 x 15 3/4in)", 150],
];

for (const [body, want] of CASES) {
  test(`Forum: ${want ?? "none"} <- ${body.slice(0, 70)}`, () => assert.equal(forum(body), want));
  test(`shared detectEditionSize: ${want ?? "none"} <- ${body.slice(0, 60)}`, () => assert.equal(detectEditionSize(body), want));
}

test("Roseberys (shared helper): cm dimensions with a fraction elsewhere give no edition", () => {
  const lot = parseRoseberys(`<p>David Hockney (British, b.1937)</p><p>Dog 43;</p><p>offset lithograph printed in colours, 20 1/2 x 25 1/2in (52 x 65cm)</p>`);
  assert.equal(lot.editionSize, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
