/**
 * Pure-function tests for work_identity.ts — the lot -> ConceptualWork identity key and
 * citation parser. Every case below is a real string from the 2026-09-13 tier-1 miss probe or
 * a documented corruption incident; none is invented.
 *
 *   npm run test:work-identity
 */
import {
  titleIdentityKey,
  titleIdentityKeyNoSeries,
  isIdentifyingTitle,
  citationsInTitle,
  citationsInRefs,
  foldPrefix,
  titleIdentityKeyNoArticle,
  resolveWorkIdentity,
  type WorkRow,
} from "../../src/appraisal/knowledge_graph/work_identity";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const same = (a: string, b: string) => titleIdentityKey(a) === titleIdentityKey(b);

// ── citations are stripped from the key ──────────────────────────────────────
eq("Kemp in parens", same("Moonshine (Cristea 62)", "Moonshine"), true);
eq("Bloch in brackets", same("Exposition Vallauris [Bloch 1300]", "Exposition Vallauris"), true);
eq("two citations, semicolon", same("Reine de Joie (Adhémar 5; Wittrock P3)", "Reine de Joie"), true);
eq("two citations, comma", same("\"La Melodie Acide\", Plate VI (Mourlot 1217, Cramer Books 248)", "La Melodie Acide, Plate VI"), true);
eq("state citation", same("Le Chapeau Épinglé, 3e planche (Delteil/Stella 8)", "Le Chapeau Epinglé, 3e planche"), true);
eq("leading Hirst number", same("H7-3. Butterfly Heart (Large)", "Butterfly Heart (Large)"), true);
eq("trailing year", same("\"Regatta\" 1999", "Regatta"), true);
eq("bracketed year", same("Change (2011)", "Change"), true);
eq("punctuation only", same("Work No. 233", "Work No.233"), true);
eq("case and accents", same("And I am alone in my house", "And I Am Alone In My House"), true);

// ── designators are NOT stripped (ADR-0017: plate, state, series, colourway are identity) ──
eq("series numeral kept", same("Foxwatch Series 1", "Foxwatch Series VI"), false);
eq("colourway kept", same("Cats (Pink)", "Cats (Black)"), false);
eq("size kept", same("Butterfly Heart (Large)", "Butterfly Heart (Small)"), false);
eq("plate designator kept", same("Moïse sauvé des eaux (pl. 25)", "Moïse sauvé des eaux (pl. 26)"), false);
eq("planche kept", same("Le Chapeau Épinglé, 2e planche", "Le Chapeau Épinglé, 3e planche"), false);
eq("state kept", same("Le Chapeau épinglé II (2nd state)", "Le Chapeau épinglé II (3rd state)"), false);
eq("roman state kept", same("Spinning Man V", "Spinning Man VII"), false);
eq("series word in parens kept", same("Flag (Series I)", "Flag (Series II)"), false);

// ── the series suffix is ignored only at the weakest level, and only if something is left ──
eq("from-series stripped at level 4", titleIdentityKeyNoSeries("The Tree (from the Islands Series)"), "the tree");
eq("from-series comma form", titleIdentityKeyNoSeries("Why You Can't Tell #1, from The Suite of Nine Prints"), "why you can t tell 1");
eq("no suffix -> empty (level adds nothing)", titleIdentityKeyNoSeries("The Tree"), "");
eq("residual must be identifying", titleIdentityKeyNoSeries("Plate 3, from Suite Vollard"), "");
eq("level 3 keeps the suffix", same("The Tree (from the Islands Series)", "The Tree"), false);

// ── identifying titles ───────────────────────────────────────────────────────
eq("Untitled alone is not", isIdentifyingTitle("Untitled"), false);
eq("Untitled (qualifier) is", isIdentifyingTitle("Untitled (Kiss)"), true);
eq("Untitled (long qualifier) is", isIdentifyingTitle("Untitled (Grecque après tremblement de terre)"), true);
eq("Sans titre (x) is", isIdentifyingTitle("Sans titre (Bleu)"), true);
eq("plate 4 is not", isIdentifyingTitle("Plate 4"), false);
eq("ordinary title is", isIdentifyingTitle("Mona Lisa"), true);
eq("symbol is not", isIdentifyingTitle("§"), false);
eq("citation-only Untitled strips to a non-identifying residual", isIdentifyingTitle(titleIdentityKey("Untitled (SF 314, Lembark 270)")), false);
eq("Untitled (Bronze) with citation keeps its qualifier", titleIdentityKey("Untitled (Bronze) (Tommasini 27)"), "untitled bronze");
eq("…and that residual is identifying", isIdentifyingTitle(titleIdentityKey("Untitled (Bronze) (Tommasini 27)")), true);

// ── citation parsing ─────────────────────────────────────────────────────────
eq("refs column", citationsInRefs("Kemp 158").map((c) => [c.prefix, c.number]), [["kemp", "158"]]);
eq("refs column, ampersand prefix", citationsInRefs("M&L 193; Bloch 1244").map((c) => [c.prefix, c.number]), [["ml", "193"], ["bloch", "1244"]]);
eq("title citation", citationsInTitle("Alhambra (Kemp 62)").map((c) => [c.prefix, c.number]), [["kemp", "62"]]);
eq("title citation, multi", citationsInTitle("Reine de Joie (Adhémar 5; Wittrock P3)").map((c) => [c.prefix, c.number]), [["adhemar", "5"], ["wittrock", "p3"]]);
eq("title citation, slashes", citationsInTitle("Le chapeau épinglé, 3e planche (Delteil/Stella 8)").map((c) => [c.prefix, c.number]), [["delteilstella", "8"]]);
eq("state suffix number", citationsInTitle("Femme (Baer 377/II/B/a)").map((c) => [c.prefix, c.number]), [["baer", "377/ii/b/a"]]);
eq("colourway is not a citation", citationsInTitle("Cats (Pink)"), []);
eq("plate is not a citation", citationsInTitle("Moïse (pl. 25)"), []);
eq("year is not a citation", citationsInTitle("Change (2011)"), []);
eq("prefix fold", foldPrefix("F./S."), "fs");
eq("prefix fold spaces", foldPrefix("Cramer Books"), "cramerbooks");

eq("page citation (poster catalogue)", citationsInTitle("Le Clown et l'Harlequin (Czwiklitzer p.437)").map((c) => [c.prefix, c.number]), [["czwiklitzer", "p.437"]]);
eq("page citation is stripped from the key", titleIdentityKey("Le Clown et l'Harlequin (Czwiklitzer p.437)"), titleIdentityKey("Le clown et l'harlequin"));
eq("pl. is still not a citation", citationsInTitle("Moïse (pl. 25)"), []);

// ── leading article (A0793/305) ──────────────────────────────────────────────
eq("article dropped", titleIdentityKeyNoArticle("Le Clown et l'Harlequin"), titleIdentityKeyNoArticle("Clown et l'Harlequin"));
eq("English article", titleIdentityKeyNoArticle("The Tree"), "tree");
eq("no article -> key unchanged", titleIdentityKeyNoArticle("Clown et l'Harlequin"), titleIdentityKey("Clown et l'Harlequin"));
eq("article alone leaves nothing identifying", titleIdentityKeyNoArticle("The Print 3"), "");

// ── resolution on real A0793 shapes (works passed in, no graph) ──────────────
const work = (id: string, name: string, docs: [string, number, string][] = [], cits: [string, string][] = []): WorkRow => ({
  id, name, aliases: [], docs: docs.map(([saleId, lotNumber, title]) => ({ saleId, lotNumber, title })),
  citations: cits.map(([prefix, number]) => ({ prefix, number, raw: `${prefix} ${number}` })),
});
async function resolverCases() {
  // A0793/2: the lot's own spelling matches exactly; Swann's "Équilibriste" sales must join.
  const villon = [
    work("roseberys-a0793-lot2", "Le Petit Équilibrist", [["A0793", 2, "Le Petit Équilibrist"], ["A0765", 12, "Le Petit Équilibrist"]]),
    work("bonhams-gp287", "Le petit Equilibrist", [["15090", 40, "Le petit Equilibrist"]], [["ginestetpouillon", "287"]]),
    work("swann-1", "Le Petit Équilibriste", [["2637", 101, "Le Petit Équilibriste"]]),
    work("swann-2", "Le Petit Équilibriste", [["2600", 88, "Le Petit Équilibriste"]]),
    work("other", "Le Petit Cheval", [["1", 1, "Le Petit Cheval"]]),
  ];
  const r2 = await resolveWorkIdentity({ artistName: "Jacques Villon", title: "Le Petit Équilibrist", works: villon, excludeSaleLot: { saleId: "A0793", lotNumber: 2 } });
  eq("lot 2: basis stays exact_title", r2.basis, "exact_title");
  eq("lot 2: Swann spelling variants are read", [...r2.workIds].sort(), ["bonhams-gp287", "roseberys-a0793-lot2", "swann-1", "swann-2"]);
  eq("lot 2: writes stay on the exact matches", [...r2.strictWorkIds].sort(), ["bonhams-gp287", "roseberys-a0793-lot2"]);

  // A variant carrying a DIFFERENT number in the same catalogue is a different plate.
  const withConflict = [...villon.slice(0, 2), work("swann-gp288", "Le Petit Équilibriste", [["9", 9, "Le Petit Équilibriste"]], [["ginestetpouillon", "288"]])];
  const rc = await resolveWorkIdentity({ artistName: "Jacques Villon", title: "Le Petit Équilibrist", works: withConflict, excludeSaleLot: { saleId: "A0793", lotNumber: 2 } });
  eq("contradicting citation keeps a variant out", rc.workIds.includes("swann-gp288"), false);

  // Designators still separate plates: "Spinning Man V" never widens to "Spinning Man VII".
  const frink = [work("v", "Spinning Man V", [["1", 1, "Spinning Man V"]]), work("vii", "Spinning Man VII", [["2", 2, "Spinning Man VII"]])];
  const rf = await resolveWorkIdentity({ artistName: "Elisabeth Frink", title: "Spinning Man V", works: frink });
  eq("roman designator is not widened", rf.workIds, ["v"]);

  // A0793/305: Roseberys drops the article; Forum adds it and a page citation.
  const picasso = [
    work("forum-clown", "Le Clown et l'Harlequin (Czwiklitzer p.437)", [["1188", 20, "Le Clown et l'Harlequin (Czwiklitzer p.437)"]]),
    work("swann-clown", "Le clown et l'harlequin", [["2651", 300, "Le clown et l'harlequin"]]),
    work("dakar", "Musée Dynamique - Dakar", [["19", 1, "Musée Dynamique - Dakar"]]),
  ];
  const r305 = await resolveWorkIdentity({ artistName: "Pablo Picasso", title: "Clown et l'Harlequin", works: picasso });
  eq("lot 305: resolves on the article level", r305.basis, "article_title");
  eq("lot 305: both houses' records", [...r305.workIds].sort(), ["forum-clown", "swann-clown"]);
}

resolverCases().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
