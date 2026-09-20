/**
 * Same-suite sibling selection (pure). `npm run test:suite-comps`
 */
import { suiteSiblings, isGenericCataloguePrefix, type CatalogueEntryRow } from "../../src/appraisal/knowledge_graph/suite_comps";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); } }

const entries: CatalogueEntryRow[] = [
  { key: "vallier|153", label: "Vallier 153", works: ["oiseau", "fleurs", "profile"] },
  { key: "vallier|154", label: "Vallier 154", works: ["other"] },
  { key: "mourlot|214", label: "Mourlot 214", works: ["m214a", "m214b"] },
];
eq("generic prefixes are recognised after folding", ["No.", "Nr", "N°", "Cat.", "#", "p.", "Pl.", "fig.", "P.", "Vallier", "Bloch", "M."].map(isGenericCataloguePrefix), [true, true, true, true, true, true, true, true, true, false, false, false]);
eq("siblings from the lot's own work: every other work under its entry", [...suiteSiblings(entries, ["oiseau"], null, "Oiseau Bleu")], [["fleurs", "Vallier 153"], ["profile", "Vallier 153"]]);
eq("siblings from a printed citation when the work did not resolve", [...suiteSiblings(entries, [], "Mourlot 214", "Untitled")].map(([w]) => w), ["m214a", "m214b"]);
eq("citation in the title brackets counts too", [...suiteSiblings(entries, [], null, "Oiseau Bleu [Vallier 153]")].map(([w]) => w), ["oiseau", "fleurs", "profile"]);
eq("the lot's own works are never siblings", [...suiteSiblings(entries, ["m214a"], null, null)].map(([w]) => w), ["m214b"]);
eq("no entry, no citation: no siblings", suiteSiblings(entries, ["unrelated"], null, "Untitled").size, 0);
eq("a generic printed citation is ignored", suiteSiblings([{ key: "no|458", label: "No. 458", works: ["a", "b"] }], [], "No. 458", null).size, 0);
console.log(`\nsuite comps tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
