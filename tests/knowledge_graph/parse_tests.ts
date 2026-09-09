/**
 * Unit tests for the ACKG parsing / normalization helpers (no Neo4j, no network).
 *
 * Run: npm run test:kg-parse
 */
import assert from "node:assert/strict";
import { parseAckgDimMm } from "../../src/appraisal/knowledge_graph/dimension_parse";
import { normalizeTitleForEmbedding, isLowInformationTitle } from "../../src/appraisal/knowledge_graph/title_normalize";
import { titleSimFromCosine, COSINE_FLOOR, COSINE_CEIL } from "../../src/appraisal/knowledge_graph/embed_text";
import { parseExcludedListing } from "../../src/appraisal/knowledge_graph/query_comparables";
import { formatCatalogueRaisonneBlock, MIN_WORKS_FOR_DERIVED_CR, type ArtistCatalogueRaisonne } from "../../src/appraisal/knowledge_graph/catalogue_raisonne";
import { formatEditionRunsForClaude, type EditionQueryResult, type EditionWorkFact } from "../../src/appraisal/knowledge_graph/edition_runs";
import { foldAccents, cypherFold } from "../../src/appraisal/knowledge_graph/unaccent";
import { catalogueMergeKey } from "../../src/appraisal/knowledge_graph/catalogue_raisonne";

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

// ── backtest self-match guard (ADR-0016) ────────────────────────────────────
// testingExcludeSourceListing is PROSE, not a URL. The first cut of the comps guard
// passed it straight into an exact URL comparison, so it silently matched nothing — a
// hole that only became load-bearing once Roseberys sale dates were backfilled and
// Roseberys lots (which ARE the backtest pool) entered the comps corpus.

test("parseExcludedListing pulls both keys out of the harness's prose string", () => {
  const prose =
    "Roseberys, sale A0777, lot 42 (https://www.roseberys.co.uk/bidding/A0777-prints-multiples-657/42-julian-trevelyan-tower-oxen-613230)";
  const p = parseExcludedListing(prose);
  assert.equal(
    p.listingUrl,
    "https://www.roseberys.co.uk/bidding/A0777-prints-multiples-657/42-julian-trevelyan-tower-oxen-613230",
  );
  assert.deepEqual(p.saleLot, { saleId: "A0777", lotNumber: 42 });
});

test("parseExcludedListing does not swallow the closing paren into the URL", () => {
  const p = parseExcludedListing("sale A1, lot 7 (https://example.com/a/b)");
  assert.equal(p.listingUrl, "https://example.com/a/b");
});

test("parseExcludedListing degrades to nulls rather than throwing", () => {
  assert.deepEqual(parseExcludedListing(null), { listingUrl: null, saleLot: null });
  assert.deepEqual(parseExcludedListing(""), { listingUrl: null, saleLot: null });
  assert.deepEqual(parseExcludedListing("no keys in here"), { listingUrl: null, saleLot: null });
});

test("parseExcludedListing finds a bare URL with no sale/lot phrasing", () => {
  const p = parseExcludedListing("https://www.roseberys.co.uk/bidding/x/1-y-2");
  assert.equal(p.listingUrl, "https://www.roseberys.co.uk/bidding/x/1-y-2");
  assert.equal(p.saleLot, null);
});


// ---- Stage 2b catalogue raisonné index block ---------------------------------------

function cr(over: Partial<ArtistCatalogueRaisonne> = {}): ArtistCatalogueRaisonne {
  return {
    artistName: "Elisabeth Frink", queriedAs: "Elisabeth Frink",
    references: [], unconfirmedCitations: [], unconfirmedCount: 0,
    noneKnown: false, noneKnownCheckedAt: null, totalWorks: 342, ...over,
  };
}

test("CR block: no lookups renders nothing at all (no wasted tokens)", () => {
  assert.equal(formatCatalogueRaisonneBlock([]), "");
  assert.equal(formatCatalogueRaisonneBlock([null, null]), "");
});

test("CR block: an established reference is named with its citation count", () => {
  const out = formatCatalogueRaisonneBlock([cr({
    references: [{ numberingPrefix: "Wiseman", title: null, works: 175, basis: "derived" }],
  })]);
  assert.match(out, /"Wiseman" \| cited by 175 catalogued work\(s\)/);
  assert.match(out, /do not spend a web search asking which catalogue raisonné exists/);
});

test("CR block: an artist with citations but none above threshold is not given a reference", () => {
  const out = formatCatalogueRaisonneBlock([cr({
    artistName: "Banksy", queriedAs: "Banksy", totalWorks: 788,
    unconfirmedCitations: [{ numberingPrefix: "V.", title: null, works: 1, basis: "derived" }],
    unconfirmedCount: 1,
  })]);
  assert.match(out, /No catalogue raisonné citations ingested for this artist/);
  assert.match(out, /Do not cite these without verifying/);
});

test("CR block: the unconfirmed tail is summarised by count, never listed in full", () => {
  // Picasso really does have 295 of these; listing them cost more context than the block saves.
  const out = formatCatalogueRaisonneBlock([cr({
    references: [{ numberingPrefix: "Bloch", title: null, works: 520, basis: "derived" }],
    unconfirmedCitations: [
      { numberingPrefix: "M.A.", title: null, works: 1, basis: "derived" },
      { numberingPrefix: "Czw", title: null, works: 2, basis: "derived" },
    ],
    unconfirmedCount: 295,
  })]);
  assert.match(out, /Plus 295 thinly-cited citation\(s\)/);
  assert.ok(out.length < 1200, `block should stay compact, was ${out.length} chars`);
});

test("CR block: a recorded none-known result tells the specialist not to re-search", () => {
  const out = formatCatalogueRaisonneBlock([cr({
    artistName: "Banksy", queriedAs: "Banksy", noneKnown: true,
    noneKnownCheckedAt: "2026-09-09T10:00:00.000Z",
  })]);
  assert.match(out, /NO CATALOGUE RAISONNÉ KNOWN/);
  assert.match(out, /checked 2026-09-09/);
  assert.match(out, /Do not spend searches re-establishing this/);
});

test("CR block: a written-back reference carries its research provenance", () => {
  const out = formatCatalogueRaisonneBlock([cr({
    references: [{
      numberingPrefix: "Wiseman", title: "The Prints of Elisabeth Frink", works: 0,
      basis: "recorded", sourceUrl: "https://example.org/frink",
    }],
  })]);
  assert.match(out, /recorded by earlier Stage 2b research — https:\/\/example\.org\/frink/);
  assert.match(out, /The Prints of Elisabeth Frink/);
});

test("CR block: the graph's canonical spelling is shown when it differs from the query", () => {
  const out = formatCatalogueRaisonneBlock([cr({ artistName: "Pablo Picasso", queriedAs: "Picasso" })]);
  assert.match(out, /Pablo Picasso \(queried as "Picasso"\)/);
});

test("MIN_WORKS_FOR_DERIVED_CR is above 1 — a single citation is the documented noise case", () => {
  assert.ok(MIN_WORKS_FOR_DERIVED_CR > 1);
});


// ---- Stage 2b edition tool result -------------------------------------------------

function work(over: Partial<EditionWorkFact> = {}): EditionWorkFact {
  return { workTitle: "The Beach Boys", matchType: "exact", declaredSizes: [50], runCount: 1,
           years: [1964], impressions: 3, copyTypes: { numbered: 3 }, ...over };
}
function ed(over: Partial<EditionQueryResult> = {}): EditionQueryResult {
  const works = over.works ?? [work()];
  return {
    artistName: "Peter Blake", queriedAs: "Peter Blake", workTitle: "The Beach Boys",
    works, multiEditionWorks: works.filter(w => w.declaredSizes.length > 1).map(w => w.workTitle),
    copyTypeTotals: { numbered: 3 }, coverageNote: "partial coverage", ...over,
  };
}

test("editions: a null result reads as missing coverage, not as a finding", () => {
  const out = formatEditionRunsForClaude(null);
  assert.match(out, /Absence of coverage, not evidence about the edition/);
});

test("editions: one size on one work raises no multi-edition warning", () => {
  const out = formatEditionRunsForClaude(ed());
  assert.doesNotMatch(out, /SEVERAL DECLARED SIZES/);
  assert.match(out, /declaredSize: 50/);
});

test("editions: two sizes on ONE work is the signal, and says do not average", () => {
  const out = formatEditionRunsForClaude(ed({ works: [work({ declaredSizes: [100, 400] })] }));
  assert.match(out, /SEVERAL DECLARED SIZES ON ONE WORK/);
  assert.match(out, /Do not average them or pick one/);
  assert.match(out, /lettered editions/);
  assert.match(out, /declaredSize: 100 \/ 400/);
});

test("editions: differing sizes across DIFFERENT works raise no warning", () => {
  // The bug this guards: an artist-wide sample of Banksy returned 150 and 750 for two
  // unrelated prints and reported it as competing editions of one image.
  const out = formatEditionRunsForClaude(ed({
    workTitle: null,
    works: [work({ workTitle: "Laugh Now", declaredSizes: [150] }),
            work({ workTitle: "Weston Super Mare", declaredSizes: [750] })],
  }));
  assert.doesNotMatch(out, /SEVERAL DECLARED SIZES/);
  assert.match(out, /DIFFERENT works, so their sizes are not comparable/);
});

test("editions: proofs are flagged as outside the numbered edition", () => {
  const out = formatEditionRunsForClaude(ed({ copyTypeTotals: { numbered: 20, AP: 4, BAT: 1 } }));
  assert.match(out, /AP=4/);
  assert.match(out, /sit OUTSIDE the numbered edition/);
});

test("editions: a provenance note ingested as a title is truncated, not dumped", () => {
  const long = "Note: " + "x".repeat(500);
  const out = formatEditionRunsForClaude(ed({ works: [work({ workTitle: long })] }));
  assert.ok(out.length < 900, `expected a compact block, got ${out.length} chars`);
  assert.match(out, /…/);
});


// ---- accent folding ---------------------------------------------------------------

test("foldAccents fixes the measured miss: Peintre et Modele == Peintre et Modèle", () => {
  assert.equal(foldAccents("Peintre et Modèle"), foldAccents("Peintre et Modele"));
  assert.equal(foldAccents("Peintre et Modèle"), "peintre et modele");
});

test("foldAccents handles codepoints NFD cannot decompose", () => {
  // ø, æ, œ, ß, ð, đ, ł are single indivisible codepoints — NFD alone leaves them intact.
  assert.equal(foldAccents("Munch Løten"), "munch loten");
  assert.equal(foldAccents("Æsop"), "aesop");
  assert.equal(foldAccents("Œuvre"), "oeuvre");
  assert.equal(foldAccents("Straße"), "strasse");
  assert.equal(foldAccents("Łódź"), "lodz");
});

test("foldAccents covers the artist names this graph actually holds", () => {
  assert.equal(foldAccents("Joan Miró"), "joan miro");
  assert.equal(foldAccents("Käthe Kollwitz"), "kathe kollwitz");
  assert.equal(foldAccents("Édouard Manet"), "edouard manet");
});

test("foldAccents leaves plain ASCII untouched apart from case", () => {
  assert.equal(foldAccents("The Beach Boys"), "the beach boys");
});

test("cypherFold folds the stored side to match the folded parameter", () => {
  const expr = cypherFold("cw.name");
  assert.ok(expr.startsWith("replace("), "should be a replace() chain");
  assert.ok(expr.includes("toLower(cw.name)"), "should lowercase the property first");
  assert.ok(expr.includes("'è','e'"), "should fold e-grave");
  assert.ok(expr.includes("'ß','ss'"), "should carry multi-char expansions");
});

test("the TS and Cypher sides fold the SAME table, so they cannot drift", () => {
  // Every mapping foldAccents applies must also appear in the generated Cypher.
  const expr = cypherFold("x");
  for (const ch of ["à", "é", "ï", "ô", "ü", "ñ", "ç", "ø", "æ", "œ", "ß", "ł"]) {
    assert.ok(expr.includes(`'${ch}',`), `Cypher chain missing ${ch}`);
    assert.notEqual(foldAccents(ch), ch, `TS fold missing ${ch}`);
  }
});

// ---- catalogue merge key ----------------------------------------------------------

test("catalogueMergeKey folds a trailing year: Wiseman 1998 -> Wiseman", () => {
  // The observed fork: the graph held "Wiseman" (106 entries), Stage 2b wrote "Wiseman 1998".
  assert.equal(catalogueMergeKey("Wiseman 1998"), catalogueMergeKey("Wiseman"));
  assert.equal(catalogueMergeKey("Bloch 1899"), catalogueMergeKey("Bloch"));
  assert.equal(catalogueMergeKey("Physick, 1963"), catalogueMergeKey("Physick"));
});

test("catalogueMergeKey does NOT merge catalogues differing by a word", () => {
  // "Cramer" and "Cramer Books" are genuinely different catalogues.
  assert.notEqual(catalogueMergeKey("Cramer"), catalogueMergeKey("Cramer Books"));
  assert.notEqual(catalogueMergeKey("Wiseman"), catalogueMergeKey("Wiseman Supplement"));
});

test("catalogueMergeKey strips only ONE trailing year, never an interior number", () => {
  assert.equal(catalogueMergeKey("Bloch 1899"), "bloch");
  // An entry number that is not year-shaped is left alone.
  assert.equal(catalogueMergeKey("Delteil 42"), "delteil 42");
  // A catalogue whose name genuinely ends in a non-year number keeps it.
  assert.equal(catalogueMergeKey("Kelpra Prints"), "kelpra prints");
});

test("catalogueMergeKey is accent- and case-insensitive", () => {
  assert.equal(catalogueMergeKey("Ginestet & Pouillon"), catalogueMergeKey("ginestet & pouillon"));
  assert.equal(catalogueMergeKey("Reuße 2001"), catalogueMergeKey("Reusse"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
