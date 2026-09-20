/**
 * ROSEBERYS-HEADER-1.0 — the artist block, however the house laid it out.
 *
 * Every header below is a real A0793 lot. The defect this guards: `parseDescription` split the
 * artist line on commas and called everything after the first element a co-artist, so
 * "Giorgio de Chirico, Italian, 1888-1978" yielded additionalArtists ["Italian","1888-1978"]
 * and a null nationality. That hit 170 of A0793's 533 lots, and because the attributed-lot
 * runner excludes multi-artist lots, it silently removed them from the appraisal population
 * (lot 320 was refused as "several artists" on 2026-09-20).
 *
 * Its twin: when the metadata sat on line 0, the old line-1 nationality regex matched the
 * TITLE line instead ("Untitled, 1982" -> nationality "Untitled"), which then pushed title
 * selection one line down the record and returned the medium as the title.
 *
 *   npm run test:artist-header
 */
import assert from "node:assert/strict";
import { parseDescription, splitArtistHeader, isNationalityToken, isHonorificToken } from "../../benchmark/src/roseberys/parse";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e: any) { failed++; console.log(`  FAIL - ${name}\n         ${e?.message}`); }
}
/** The house delimits its lines with <br>, which is what the parser is fed. */
const lot = (...lines: string[]) => lines.join("<br>");

// ── the reported defect ────────────────────────────────────────────────────────
test("A0793/320: nationality and dates on the artist line are not co-artists", () => {
  const h = splitArtistHeader("Giorgio de Chirico,  Italian, 1888-1978");
  assert.deepEqual(h.names, ["Giorgio de Chirico"]);
  assert.equal(h.nationality, "Italian");
  assert.equal(h.lifeDates, "1888-1978");
});
test("A0793/146: post-nominals on the artist line are metadata, not a co-artist", () => {
  const h = splitArtistHeader("David Hockney, OM CH RA, British 1937-2026");
  assert.deepEqual(h.names, ["David Hockney"]);
  assert.equal(h.nationality, "British");
  assert.equal(h.lifeDates, "1937-2026");
});
test("A0793/123: post-nominals and nationality share one element", () => {
  const h = splitArtistHeader("Sir Peter Blake, CBE RDI RA British, b.1932");
  assert.deepEqual(h.names, ["Sir Peter Blake"]);
  assert.equal(h.nationality, "British");
  assert.equal(h.lifeDates, "b.1932");
});

// ── the shapes the house uses where life dates would go ────────────────────────
test("A0793/269: a century stands in for life dates", () => {
  const h = splitArtistHeader("Edd Pearman, British 21st Century");
  assert.deepEqual(h.names, ["Edd Pearman"]);
  assert.equal(h.nationality, "British");
  assert.equal(h.lifeDates, "21st Century");
});
test("A0793/339: a compound nationality survives as one value", () => {
  assert.equal(splitArtistHeader("Victor Vasarely, French/ Hungarian, 1906-1997").nationality, "French/Hungarian");
});
test("A0793/397: a compound written with spaces around the slash", () => {
  assert.equal(splitArtistHeader("Herbert Bayer, Austrian / American 1900-1985").nationality, "Austrian/American");
});
test("A0793/483: a two-word demonym is not read as a person", () => {
  const h = splitArtistHeader("Jacob Henrik Pierneef, South African, 1886-1957");
  assert.deepEqual(h.names, ["Jacob Henrik Pierneef"]);
  assert.equal(h.nationality, "South African");
});
test("A0793/379: the house types a stray period after the demonym", () => {
  const h = splitArtistHeader("Terry O'Neill, British. 1938-2019");
  assert.deepEqual(h.names, ["Terry O'Neill"]);
  assert.equal(h.nationality, "British");
});
test("A0793/531: a bracketed element is the preceding name's alias", () => {
  assert.deepEqual(splitArtistHeader("Mr Doodle, (Sam Cox)").names, ["Mr Doodle (Sam Cox)"]);
});

// ── what must NOT be peeled ────────────────────────────────────────────────────
test("A0793/400: a surname that is also a demonym survives", () => {
  // "French" is in NATIONALITY_WORDS; without the name-element guard this returns "John".
  assert.deepEqual(splitArtistHeader("John French, Irving Penn, Pierre Cardin").names,
    ["John French", "Irving Penn", "Pierre Cardin"]);
});
test("A0793/395: a demonym IS peeled when an alias bracket precedes it", () => {
  const h = splitArtistHeader("Weegee (Arthur Fellig) Polish, 1899-1968");
  assert.deepEqual(h.names, ["Weegee (Arthur Fellig)"]);
  assert.equal(h.nationality, "Polish");
});
test("A0793/275: genuine co-artists are still reported", () => {
  const h = splitArtistHeader("Rachel Whiteread, Anthea Hamilton, Michael Craig-Martin, British 21st Century");
  assert.deepEqual(h.names, ["Rachel Whiteread", "Anthea Hamilton", "Michael Craig-Martin"]);
});
test("A0793/46: the artist's own post-nominals stay on the name", () => {
  // The leak detector's surname guard is asserted against this string; stripping RBA RA here
  // would change what every downstream consumer matches on.
  assert.deepEqual(splitArtistHeader("Laurence Stephen Lowry RBA RA").names, ["Laurence Stephen Lowry RBA RA"]);
});

// ── the line-1 twin: a title line is not a nationality line ────────────────────
test("A0793/107: a title ending in a year does not become the nationality", () => {
  const p = parseDescription(lot("Joe Tilson, RA, British, 1928-2023", "Untitled, 1982;", "etching with aquatint in colours"));
  assert.equal(p.nationality, "British");
  assert.equal(p.title, "Untitled");
  assert.equal(p.year, "1982");
  assert.equal(p.medium, "etching with aquatint in colours");
});
test("A0793/217: and the medium is not returned as the title", () => {
  const p = parseDescription(lot("Damien Hirst, British b.1965", "Beautiful inside my head forever, 2008;", "digital poster in colours"));
  assert.equal(p.title, "Beautiful inside my head forever");
  assert.equal(p.medium, "digital poster in colours");
});
test("the house's canonical two-line layout is unchanged", () => {
  const p = parseDescription(lot("Pablo Picasso,", "Spanish 1881-1973,", "Le Cocu Magnifique, 1968;", "etching on BFK Rives wove"));
  assert.equal(p.artist, "Pablo Picasso");
  assert.equal(p.nationality, "Spanish");
  assert.equal(p.lifeDates, "1881-1973");
  assert.equal(p.title, "Le Cocu Magnifique");
  assert.equal(p.medium, "etching");        // " on <support>" is split off by design
  assert.equal(p.support, "BFK Rives wove");
});

// ── the primitives ─────────────────────────────────────────────────────────────
test("isNationalityToken accepts demonyms, compounds and phrases; rejects names", () => {
  for (const t of ["British", "Italian", "French/Hungarian", "South African", "British."])
    assert.equal(isNationalityToken(t), true, t);
  for (const t of ["Kate Garner", "Irving Penn", "Ayrton", ""])
    assert.equal(isNationalityToken(t), false, t);
});
test("isHonorificToken accepts post-nominal runs only", () => {
  for (const t of ["RA", "OM CH RA", "CBE RDI RA"]) assert.equal(isHonorificToken(t), true, t);
  for (const t of ["British", "Michael Ayrton", ""]) assert.equal(isHonorificToken(t), false, t);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
