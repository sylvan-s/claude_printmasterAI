/**
 * Unit tests for src/appraisal/knowledge_graph/dimension_parse.ts.
 * No Neo4j, no network. Plain node:assert via tsx.
 *
 * Run: npm run test:kg-parse
 */
import assert from "node:assert/strict";
import { parseAckgDimMm } from "../../src/appraisal/knowledge_graph/dimension_parse";

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

test("Forum/V&A mm form: 380x518mm", () => {
  assert.deepEqual(parseAckgDimMm("380x518mm"), { w: 380, h: 518 });
});

test("Roseberys cm form: 80.0x58.0cm -> mm", () => {
  assert.deepEqual(parseAckgDimMm("80.0x58.0cm"), { w: 800, h: 580 });
});

test("Roseberys cm form: 41.0x32.4cm -> mm", () => {
  assert.deepEqual(parseAckgDimMm("41.0x32.4cm"), { w: 410, h: 324 });
});

test("Met inches-with-parenthetical-cm: takes the cm, converts to mm", () => {
  assert.deepEqual(parseAckgDimMm("15-7/8 x 17-15/16 inches (40.4 x 45.5 cm)"), { w: 404, h: 455 });
});

test("Met 'in.' abbreviation with double space before paren", () => {
  assert.deepEqual(parseAckgDimMm("9-7/8 x 8-3/8 in.  (25.1 x 21.3 cm)"), { w: 251, h: 213 });
});

test("Met whole-inch with paren", () => {
  assert.deepEqual(parseAckgDimMm("11 x 14 inches (27.9 x 35.5 cm)"), { w: 279, h: 355 });
});

test("bare inches, no paren: convert 25.4x", () => {
  const d = parseAckgDimMm("10 x 8 in.");
  assert.ok(d && Math.abs(d.w - 254) < 0.5 && Math.abs(d.h - 203.2) < 0.5);
});

test("× (unicode multiplication sign) is accepted", () => {
  assert.deepEqual(parseAckgDimMm("300×400mm"), { w: 300, h: 400 });
});

test("null / empty / junk -> null", () => {
  assert.equal(parseAckgDimMm(null), null);
  assert.equal(parseAckgDimMm(""), null);
  assert.equal(parseAckgDimMm("dimensions not recorded"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
