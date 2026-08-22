/**
 * Manual smoke test / demo for the cross-institution lookup.
 * Usage: npm run lookup:artist -- "Artist Name" ["Second Artist" ...]
 * Defaults to two known test cases if no artist is given.
 */
import { lookupArtistAcrossMuseums } from "./index.js";

async function run(artist: string) {
  console.log(`\n${"=".repeat(70)}\n${artist}\n${"=".repeat(70)}`);
  const result = await lookupArtistAcrossMuseums(artist);
  for (const s of result.sources) {
    if (!s.ok) {
      console.log(`\n[${s.source}] FAILED: ${s.error}`);
      continue;
    }
    console.log(`\n[${s.source}] ${s.records.length} record(s)`);
    for (const r of s.records.slice(0, 3)) {
      console.log(`  - ${r.title || "(untitled)"} | ${r.medium || "?"} | ${r.dimensions || "?"} | ${r.date || "?"}`);
      if (r.inscription) console.log(`    inscription: ${r.inscription}`);
      if (r.collection) console.log(`    collection: ${r.collection}`);
    }
    if (s.records.length > 3) console.log(`  … and ${s.records.length - 3} more`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const artists = args.length ? args : ["Agathe Sorel", "James McNeill Whistler"];
  for (const artist of artists) await run(artist);
}

main().catch((e) => { console.error(e); process.exit(1); });
