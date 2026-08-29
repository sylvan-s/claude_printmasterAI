/**
 * Render the stored pool fixture (tests/backtest/pool_output/) as readable text.
 *   npx tsx tests/backtest/show_pool.ts            # all lots
 *   npx tsx tests/backtest/show_pool.ts 1151_41    # one lot
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "tests/backtest/pool_output");
const only = process.argv[2];

function line(w = 90) {
  return "─".repeat(w);
}
function wrap(s: string, indent = 6, width = 100): string {
  const pad = " ".repeat(indent);
  const words = String(s).replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = pad;
  for (const w of words) {
    if ((cur + w).length > width) {
      out.push(cur);
      cur = pad + w + " ";
    } else cur += w + " ";
  }
  if (cur.trim()) out.push(cur);
  return out.join("\n");
}

const ids = readdirSync(DIR)
  .filter((d) => existsSync(join(DIR, d, "stage1.json")))
  .filter((d) => !only || d === only)
  .sort();

if (!ids.length) {
  console.error(only ? `no fixture for "${only}"` : "no fixtures in tests/backtest/pool_output/");
  process.exit(1);
}

let veaMs = 0;
let vsMs = 0;
let aiaMs = 0;
let halts = 0;

for (const id of ids) {
  const d = JSON.parse(readFileSync(join(DIR, id, "stage1.json"), "utf8"));
  const vea = d.stage1a_vea ?? {};
  const b = d.stage1b_visualSearch ?? {};
  const c = d.stage1c_appraiserInput ?? {};
  const t = d.timings ?? {};
  veaMs += t.veaMs ?? 0;
  vsMs += t.visualSearchMs ?? 0;
  aiaMs += t.appraiserInputMs ?? 0;
  if (vea.imageAuthenticity?.haltRecommended) halts++;

  console.log(`\n${line()}`);
  console.log(
    `${id}  —  ${d.groundTruth?.poolArtistName ?? "?"}  /  "${d.groundTruth?.poolTitle ?? "?"}"` +
      `   [${d.lot?.house}, ${d.lot?.techBucket}, ${d.lot?.bracket}, £${d.lot?.estimateLow}-${d.lot?.estimateHigh}]`,
  );
  console.log(`${line()}`);
  console.log(`  image      : ${d.imageUrl}`);
  console.log(`  1c notes   : ${JSON.stringify(d.appraiserInputNotes?.catalogueNotes ?? null)}`);
  if (d.appraiserInputNotes?.provenanceNotes) console.log(`  1c prov    : ${JSON.stringify(d.appraiserInputNotes.provenanceNotes)}`);

  console.log(`\n  STAGE 1a — VEA  (${vea.schemaVersion}, conf ${vea.overallExtractionConfidence}, ${((t.veaMs ?? 0) / 1000).toFixed(0)}s)`);
  const ia = vea.imageAuthenticity ?? {};
  console.log(`    authenticity : ${ia.classification}${ia.haltRecommended ? "   *** haltRecommended ***" : ""}`);
  console.log(`    techniques   : ${(vea.printingTechniques ?? []).map((x: any) => `${x.technique} (${x.techniqueConfidence})`).join(" | ") || "-"}`);
  console.log(`    signatures   : ${(vea.signatures ?? []).map((s: any) => `"${s.transcription}" [${s.type}, conf ${s.signatureConfidence}]`).join(" | ") || "-"}`);
  console.log(`    title inscr. : ${(vea.titleInscriptions ?? []).map((s: any) => `"${s.transcription}"`).join(" | ") || "-"}`);
  console.log(`    edition      : ${vea.editionInfoAbsent ? "absent" : (vea.editionInfo ?? []).map((e: any) => e.transcription).join(", ") || "-"}`);
  console.log(`    paper        : ${vea.paper?.paperType ?? "-"} / ${vea.paper?.colour ?? "-"}`);
  console.log(`    plate mark   : ${vea.plateMark?.present ?? "-"}`);
  const comp = vea.composition ?? {};
  console.log(`    subject      : ${comp.subjectCategory ?? "-"} — ${(comp.subjectMatter ?? "").slice(0, 120)}`);
  console.log(`    text in img  : ${JSON.stringify(comp.textWithinImage ?? null)}   date in img: ${JSON.stringify(comp.dateWithinImage ?? null)}`);
  if ((vea.lowConfidenceFlags ?? []).length) console.log(wrap(`low-conf flags: ${vea.lowConfidenceFlags.join("; ")}`, 4));

  console.log(`\n  STAGE 1b — Visual Search  (${((t.visualSearchMs ?? 0) / 1000).toFixed(0)}s)`);
  console.log(`    best match   : ${b.bestMatchArtist ?? "null"} — "${b.bestMatchTitle ?? "null"}"  (${b.confidence ?? b.matchConfidence ?? "?"})`);
  console.log(`    similarity   : ${b.visualSimilarityScore ?? "not scored"}${b.visualSimilarityRationale ? ` — ${b.visualSimilarityRationale}` : ""}`);
  console.log(`    evidenceBasis: ${b.evidenceBasis ?? "-"}`);
  if (b.hypothesisWarning) console.log(wrap(`⚠ ${b.hypothesisWarning}`, 4));
  console.log(`    web entities : ${(b.webEntities ?? []).join(", ") || "-"}`);

  console.log(`\n  STAGE 1c — Appraiser Input  (${((t.appraiserInputMs ?? 0) / 1000).toFixed(0)}s)`);
  console.log(`    claimedArtist: ${JSON.stringify(c.claimedAttribution?.artist ?? null)}  (${c.claimedAttribution?.status ?? "-"})`);
  console.log(`    claimed t/p/m: ${JSON.stringify([c.claimedAttribution?.title, c.claimedAttribution?.period, c.claimedAttribution?.technique])}`);
  const ins = c.inscriptionClaims ?? {};
  console.log(`    inscriptions : sig=${JSON.stringify(ins.signatureClaim)} edn=${JSON.stringify(ins.editionClaim)} size=${JSON.stringify(ins.editionSizeClaim)}`);
  console.log(`    provenance   : ${(c.provenanceChain ?? []).map((p: any) => p.ownerOrEntity).join(" → ") || "-"}`);
  console.log(`    catalogueRefs: ${(c.catalogueReferences ?? []).map((r: any) => r.ref).join(", ") || "-"}`);
  if ((c.lowConfidenceFlags ?? []).length) console.log(wrap(`low-conf flags: ${c.lowConfidenceFlags.join("; ")}`, 4));
}

const n = ids.length;
console.log(`\n${line()}`);
console.log(`${n} lots  —  VEA halts: ${halts}`);
console.log(
  `mean timings:  VEA ${(veaMs / n / 1000).toFixed(0)}s   |   Visual Search ${(vsMs / n / 1000).toFixed(0)}s   |   Appraiser Input ${(aiaMs / n / 1000).toFixed(0)}s`,
);
console.log(`Stage 2a (Triage) was NOT run — this fixture is Stages 1a/1b/1c only.`);
