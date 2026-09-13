/**
 * Blind-mode leak detection tests for the auction-house catalogue parsers
 * (no network, no LLM, no Neo4j).
 *
 * These guard the property the whole blind backtest rests on: if a catalogue body
 * names the artist, `parseDescription()` must say so. The regression that prompted
 * this file — Roseberys A0793 lot 46, "Laurence Stephen Lowry RBA RA" — passed a
 * blind run with no warning because the detector took the LAST whitespace token of
 * the artist header as the surname, got "RA", and discarded it as too short.
 *
 * Run: npm run test:leak-detection
 */
import assert from "node:assert/strict";
import { parseDescription as parseRoseberys } from "../../benchmark/src/roseberys/parse";
import { parseDescription as parseForum } from "../../benchmark/src/forum/parse";
import { artistNameLeakTokens, artistSurnameToken, HONORIFICS, NATIONALITY_WORDS } from "../../src/shared/text_extraction";

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

const surnameLeak = (risks: string[]) => risks.find((r) => r.startsWith("artist surname"));
const forenameLeak = (risks: string[]) => risks.find((r) => r.startsWith("artist forename/middle name(s)"));

// ── artistNameLeakTokens ────────────────────────────────────────────────────

test("post-nominals are not name tokens", () => {
  assert.deepEqual(artistNameLeakTokens("Laurence Stephen Lowry RBA RA"), ["Laurence", "Stephen", "Lowry"]);
});

test("honorific prefixes and long post-nominal chains are stripped", () => {
  assert.deepEqual(artistNameLeakTokens("Sir Frank Brangwyn RA RWS"), ["Frank", "Brangwyn"]);
  assert.deepEqual(artistNameLeakTokens("Henry Moore OBE CBE"), ["Henry", "Moore"]);
});

test("initials and life dates are dropped, not treated as name tokens", () => {
  assert.deepEqual(artistNameLeakTokens("L. S. Lowry 1887-1976"), ["Lowry"]);
});

test("short surnames remain untested — documented residual gap, not a silent one", () => {
  assert.deepEqual(artistNameLeakTokens("Hans Arp"), ["Hans"]);
  assert.deepEqual(artistNameLeakTokens("Otto Dix"), ["Otto"]);
});

test("null / empty input -> no tokens, not a crash", () => {
  assert.deepEqual(artistNameLeakTokens(null), []);
  assert.deepEqual(artistNameLeakTokens(undefined), []);
  assert.deepEqual(artistNameLeakTokens("   "), []);
});

test("HONORIFICS is the shared vocabulary, not a local copy", () => {
  for (const h of ["ra", "rba", "rws", "obe", "sir", "dame", "iii"]) assert.ok(HONORIFICS.has(h), h);
});

test("nationality words are not name tokens", () => {
  // Roseberys' comma-split artist line puts "British" into additionalArtists as if
  // it were a co-artist, so without this any body saying "British" is a surname leak.
  assert.deepEqual(artistNameLeakTokens("British"), []);
  assert.equal(artistSurnameToken("Austrian"), null);
  assert.ok(NATIONALITY_WORDS.has("british"));
});

test("REGRESSION: a body describing a 'British' school does not read as a surname", () => {
  const html = `<p>Gary Hume RA,<br />British b.1962,<br /><br />Yellow Window, 2000;<br /><br />screenprint in colours,<br />a key work of the British pop tradition.</p>`;
  const risks = parseRoseberys(html).leakRisks;
  assert.equal(surnameLeak(risks), undefined, `got: ${JSON.stringify(risks)}`);
});

// ── Roseberys ───────────────────────────────────────────────────────────────

// The actual A0793 lot 46 description, trimmed to the lines that matter.
const A0793_46 = `<p class=" wpt_title">Laurence Stephen Lowry RBA RA,&nbsp;<br />British 1887-1976,&nbsp;<br /><br />Going to the Match, 1972;&nbsp;<br /><br />offset lithograph in colours on paper,&nbsp;<br />signed in pencil, after the original painting of 1953,&nbsp;<br />from the edition of 300,&nbsp;<br />image 53 x 68 cm,&nbsp;<br />(framed)&nbsp;</p>
<p class=" wpt_title">This is one of Lowry's most celebrated prints, capturing crowds of football supporters walking towards a stadium in his instantly recognisable figurative style.&nbsp;</p>`;

test("REGRESSION A0793/46: 'Lowry RBA RA' header + body naming Lowry is flagged", () => {
  const p = parseRoseberys(A0793_46);
  assert.equal(p.artist, "Laurence Stephen Lowry RBA RA");
  const risk = surnameLeak(p.leakRisks);
  assert.ok(risk, `expected an artist-name leak risk, got: ${JSON.stringify(p.leakRisks)}`);
  assert.match(risk!, /Lowry/);
});

test("a middle name in the body is reported, but as the non-gating risk", () => {
  const html = `<p>Laurence Stephen Lowry RBA RA,<br />British 1887-1976,<br /><br />Going to the Match, 1972;<br /><br />offset lithograph in colours on paper,<br />after a composition by Stephen.</p>`;
  const risks = parseRoseberys(html).leakRisks;
  const soft = forenameLeak(risks);
  assert.ok(soft && /Stephen/.test(soft), `expected Stephen reported, got: ${JSON.stringify(risks)}`);
  assert.equal(surnameLeak(risks), undefined, "a middle name alone must not trip the surname gate");
});

test("REGRESSION A0777/1: a forename matching an unrelated gallery does not gate the run", () => {
  // "the Paul Kovesdy Gallery" in a collection essay; Gauguin is never named.
  const html = `<p>Paul Gauguin,<br />French 1848-1903,<br /><br />Noa Noa, 1894;<br /><br />monochrome woodcut on japan paper,<br />exhibited at the Paul Kovesdy Gallery in New York.</p>`;
  const risks = parseRoseberys(html).leakRisks;
  assert.equal(surnameLeak(risks), undefined, "must not abort a blind run on a forename collision");
  assert.ok(forenameLeak(risks), "but the collision should still be reported");
});

test("surname token is the last one after post-nominals", () => {
  assert.equal(artistSurnameToken("Laurence Stephen Lowry RBA RA"), "Lowry");
  assert.equal(artistSurnameToken("Vincent van Gogh"), "Gogh");
  assert.equal(artistSurnameToken("Sir Frank Brangwyn RA RWS"), "Brangwyn");
  assert.equal(artistSurnameToken(null), null);
});

test("a clean body raises no artist-name leak", () => {
  const html = `<p>Pablo Picasso,<br />Spanish 1881-1973,<br /><br />Le Cocu Magnifique, 1968;<br /><br />etching on BFK Rives wove,<br />signed in pencil,<br />from the edition of 200,<br />image 22 x 32 cm.</p>`;
  assert.equal(surnameLeak(parseRoseberys(html).leakRisks), undefined);
});

test("a co-artist named in the body is flagged too", () => {
  const html = `<p>Georges Braque, Pablo Picasso,<br />French 1882-1963,<br /><br />Oiseau Bleu, 1960;<br /><br />etching and aquatint in blue,<br />after the Picasso of the same year.</p>`;
  const risk = surnameLeak(parseRoseberys(html).leakRisks);
  assert.ok(risk && /Picasso/.test(risk), `expected Picasso flagged, got: ${risk}`);
});

test("matching is case-insensitive and word-boundaried", () => {
  const shouty = `<p>Laurence Stephen Lowry RBA RA,<br />British 1887-1976,<br /><br />Going to the Match, 1972;<br /><br />offset lithograph,<br />a LOWRY of the northern industrial scene.</p>`;
  assert.ok(surnameLeak(parseRoseberys(shouty).leakRisks), "uppercase LOWRY should match");

  // "Moore" must not be found inside "Moorehead"/"moored".
  const substring = `<p>Henry Moore OM CH,<br />British 1898-1986,<br /><br />Reclining Figure, 1970;<br /><br />lithograph in colours,<br />from a barge moored on the canal.</p>`;
  assert.equal(surnameLeak(parseRoseberys(substring).leakRisks), undefined, "'moored' must not count as 'Moore'");
});

test("REGRESSION A0785/290: a surname hiding in the provenance line is flagged", () => {
  // provenance is split out of `body`, but the harnesses send it to Stage 1c as
  // provenanceNotes, so a name there is just as much a leak.
  const html = `<p>Pablo Picasso,<br />Spanish 1881-1973,<br /><br />Tete de femme, 1962;<br /><br />monochrome lithograph on wove,<br />signed and dated in the plate,<br />sheet 77.8 x 55.8 cm,<br />Provenance<br />This Tete de femme, is a classic, very collectable Picasso motif.</p>`;
  const p = parseRoseberys(html);
  assert.ok(p.provenance && /Picasso/.test(p.provenance), "fixture must put Picasso in provenance, not body");
  const risk = surnameLeak(p.leakRisks);
  assert.ok(risk && /Picasso/.test(risk), `expected Picasso flagged, got: ${JSON.stringify(p.leakRisks)}`);
});

// ── Forum ───────────────────────────────────────────────────────────────────

test("Forum: post-nominal header + body naming the artist is flagged", () => {
  const html = `<p>Laurence Stephen Lowry RBA RA (1887-1976)</p><p>Going to the Match</p><p>Offset lithograph, 1972, signed in pencil, on wove paper, 530 x 680mm, one of Lowry's best-known images (framed)</p>`;
  const risk = surnameLeak(parseForum(html).leakRisks);
  assert.ok(risk && /Lowry/.test(risk), `expected Lowry flagged, got: ${JSON.stringify(parseForum(html).leakRisks)}`);
});

test("Forum: a clean body raises no artist-name leak", () => {
  const html = `<p>Norman Ackroyd (b.1938)</p><p>Wasdale Screes</p><p>Etching, 1982, signed, titled, dated and numbered from the edition of 80 in pencil, on wove paper, with full margins, 510 x 647mm (unframed)</p>`;
  assert.equal(surnameLeak(parseForum(html).leakRisks), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
