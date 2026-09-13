/**
 * Times every Artist-name lookup in src/appraisal/knowledge_graph against the live graph, on a
 * one-work artist, two large artists, an alias spelling and a miss. Read-only. Written for the
 * 2026-09-13 artist_lookup.ts change; the before/after numbers are in that commit message.
 * Run from the repo root so dotenv finds .env:
 *   RUNS=5 npx tsx scripts/time_artist_lookups.ts [label]
 */
import { performance } from "node:perf_hooks";
import { getDriver, getDatabase, closeDriver } from "../src/appraisal/knowledge_graph/client.js";
import { queryArtistDinoFloor } from "../src/appraisal/knowledge_graph/artist_dino_floor.js";
import { resolveArtistIdentity } from "../src/appraisal/knowledge_graph/artist_identity.js";
import { queryCatalogueRaisonneForArtist } from "../src/appraisal/knowledge_graph/catalogue_raisonne.js";
import { queryEditionRuns } from "../src/appraisal/knowledge_graph/edition_runs.js";
import { queryAckgWorks, queryArtistStyleConsistency } from "../src/appraisal/knowledge_graph/query.js";

const label = process.argv[2] ?? "run";
const ARTISTS = ["Terry Willson", "Damien Hirst", "Pablo Picasso", "Hirst, Damien", "No Such Artist Zzz"];
const RUNS = Number(process.env.RUNS ?? 3);

const s = getDriver().session({ database: getDatabase() });
const vecRes = await s.run(
  `MATCH (a:Artist {name:'Damien Hirst'})-[:CREATED]->()-[:PRINTED_AS]->()-[:INCLUDES]->(i)<-[:SHOWS]-(img:DigitalImage)
   WHERE img.embedding IS NOT NULL RETURN img.embedding AS v LIMIT 1`);
const vec = vecRes.records[0].get("v") as number[];
await s.close();

type Fn = { name: string; run: (artist: string) => Promise<unknown>; summary: (r: any) => string };
const fns: Fn[] = [
  { name: "queryArtistDinoFloor", run: (a) => queryArtistDinoFloor(a), summary: (r) => r ? `floor=${r.floor.toFixed(3)} ${r.canonicalName}` : "null" },
  { name: "resolveArtistIdentity", run: (a) => resolveArtistIdentity(a), summary: (r) => r ? `${r.canonicalName} via ${r.matchedOn} works=${r.workCount} amb=${r.ambiguousMatchCount}` : "null" },
  { name: "queryCatalogueRaisonneForArtist", run: (a) => queryCatalogueRaisonneForArtist(a), summary: (r) => r ? `${r.artistName} refs=${r.references.length} works=${r.totalWorks}` : "null" },
  { name: "queryEditionRuns", run: (a) => queryEditionRuns({ artistName: a }), summary: (r) => r ? `${r.artistName} works=${r.works.length}` : "null" },
  { name: "queryEditionRuns(title)", run: (a) => queryEditionRuns({ artistName: a, workTitle: "Butterfly" }), summary: (r) => r ? `${r.artistName} works=${r.works.length}` : "null" },
  { name: "queryAckgWorks", run: (a) => queryAckgWorks({ artist: a }), summary: (r) => `rows=${r.length}` },
  { name: "queryAckgWorks(title)", run: (a) => queryAckgWorks({ artist: a, workTitle: "Butterfly" }), summary: (r) => `rows=${r.length}` },
  { name: "queryArtistStyleConsistency", run: (a) => queryArtistStyleConsistency(a, vec), summary: (r) => r ? `compared=${r.comparedWorks} excl=${r.identityMatchesExcluded}` : "null" },
];

const rows: { fn: string; artist: string; medianMs: number; minMs: number; summary: string }[] = [];
for (const fn of fns) {
  for (const artist of ARTISTS) {
    await fn.run(artist); // warm-up
    const times: number[] = [];
    let last: any;
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      last = await fn.run(artist);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    rows.push({ fn: fn.name, artist, medianMs: Math.round(times[Math.floor(RUNS / 2)]), minMs: Math.round(times[0]), summary: fn.summary(last) });
  }
}
console.log(`\n== ${label} ==`);
console.log("fn".padEnd(32), "artist".padEnd(20), "median".padStart(7), "min".padStart(7), " result");
for (const r of rows) console.log(r.fn.padEnd(32), r.artist.padEnd(20), String(r.medianMs).padStart(7), String(r.minMs).padStart(7), " " + r.summary);
await closeDriver();
