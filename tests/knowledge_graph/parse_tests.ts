/**
 * Unit tests for the ACKG parsing / normalization helpers (no Neo4j, no network).
 *
 * Run: npm run test:kg-parse
 */
import assert from "node:assert/strict";
import { parseAckgDimMm } from "../../src/appraisal/knowledge_graph/dimension_parse";
import { normalizeTitleForEmbedding, isLowInformationTitle } from "../../src/appraisal/knowledge_graph/title_normalize";
import { titleSimFromCosine, COSINE_FLOOR, COSINE_CEIL } from "../../src/appraisal/knowledge_graph/embed_text";

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

// ── title normalization ─────────────────────────────────────────────────────

test("strips a trailing catalogue-raisonné ref and folds diacritics", () => {
  assert.equal(normalizeTitleForEmbedding("Le Taureau (Bloch 330, Baer 377/II/B/a)"), "le taureau");
  assert.equal(normalizeTitleForEmbedding("Heath with Juniper (Herdman 5202)"), "heath with juniper");
  assert.equal(normalizeTitleForEmbedding("Académie des Beaux Arts (Field 75-7M&L 514a)"), "academie des beaux arts");
  assert.equal(normalizeTitleForEmbedding("Nūr Jahān (H10-2, from The Empresses)"), "nur jahan");
  assert.equal(normalizeTitleForEmbedding("Composition (pl. 3)"), "composition");
});

test("strips a trailing year and a leading list ordinal", () => {
  assert.equal(normalizeTitleForEmbedding("A Dangerous Idea (Box set), 2019"), "a dangerous idea (box set)");
  assert.equal(normalizeTitleForEmbedding("4. White Horizontal, Black Verticals"), "white horizontal, black verticals");
});

test("keeps a leading fraction (not a list ordinal)", () => {
  assert.equal(normalizeTitleForEmbedding("1/4 Black Diagonal"), "1/4 black diagonal");
});

test("strips series/collection suffixes so the distinctive title carries the embedding", () => {
  assert.equal(normalizeTitleForEmbedding("Nur Jahan, from The Empresses"), "nur jahan");
  assert.equal(normalizeTitleForEmbedding("H10-1. Wu Zetian, from the Empresses"), "wu zetian");
  assert.equal(normalizeTitleForEmbedding("Taureau et Cheval, from La Suite Vollard"), "taureau et cheval");
  assert.equal(normalizeTitleForEmbedding("Blue Nude, Portfolio II"), "blue nude");
});

test("does NOT strip a colon-prefixed series (different shape) or a bare title", () => {
  assert.equal(
    normalizeTitleForEmbedding("Thirty-six Views of Mount Fuji: Fine Wind, Clear Morning"),
    "thirty-six views of mount fuji: fine wind, clear morning",
  );
  assert.equal(normalizeTitleForEmbedding("The Great Wave off Kanagawa"), "the great wave off kanagawa");
});

test("strips wrapping smart quotes; blank input -> empty string, not a crash", () => {
  assert.equal(normalizeTitleForEmbedding("“The Great Wave”"), "the great wave");
  assert.equal(normalizeTitleForEmbedding("   "), "");
});

test("isLowInformationTitle flags Untitled / bare composition", () => {
  assert.equal(isLowInformationTitle("Untitled"), true);
  assert.equal(isLowInformationTitle("Untitled composition"), true);
  assert.equal(isLowInformationTitle("Sans titre"), true);
  assert.equal(isLowInformationTitle("The Great Wave off Kanagawa"), false);
});

// ── cosine rescale ──────────────────────────────────────────────────────────

test("titleSimFromCosine maps the empirical band to 0..1", () => {
  assert.equal(titleSimFromCosine(COSINE_FLOOR), 0);
  assert.equal(titleSimFromCosine(COSINE_CEIL), 1);
  assert.ok(titleSimFromCosine(0.6) === 0); // clamped
  assert.ok(titleSimFromCosine(0.99) === 1); // clamped
  const mid = titleSimFromCosine((COSINE_FLOOR + COSINE_CEIL) / 2);
  assert.ok(Math.abs(mid - 0.5) < 1e-9);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
