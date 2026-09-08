/**
 * Run Stage 2a (the ADR-0010 Attribution Evidence Agent — the sole Stage 2a
 * implementation as of ADR-0014) — and, optionally, the coarse fixture-adapter two-pass
 * classifier for comparison — against the stored Stage 1a/1b/1c fixture
 * (tests/backtest/pool_output/<id>/stage1.json).
 *
 * The fixture is fixed, so this isolates the triage stage: change the evidence prompt or
 * the two-pass tree thresholds, re-run, diff — with no VEA / Visual Search / Appraiser
 * Input cost.
 *
 *   npm run test:pool:triage                       # every fixture, claude-sonnet-4-6
 *   npm run test:pool:triage -- --limit 5
 *   npm run test:pool:triage -- --two-pass         # also run classifyTwoPass (coarse fixture adapter), for comparison
 *   npm run test:pool:triage -- --model claude-haiku-4-5
 *   npm run test:pool:triage -- --resume
 *
 * Writes tests/backtest/pool_output/<id>/triage.json  (gitignored).
 *
 * NOT RUN by CI or by the pool build — invoke explicitly. Each lot is one live triage
 * call (~130-260s of query_ackg loop — ADR-0009) plus a Neo4j round-trip.
 */
import dotenv from "dotenv";
dotenv.config();

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { FourStageAppraiser, appraiserConfigs } from "../../src/appraisal/appraiser";
import type { VisualExtractionResult, AppraiserInputResult, TriageResult } from "../../src/types";
import { SCENARIO_NAMES, Scenario } from "../../src/appraisal/routing";
import {
  classifyTwoPass,
  nameSimilarity,
  TAU_NAME,
  SIM_ARTIST_VOTE,
  SIM_WORK_VOTE,
  type TwoPassInput,
  type NamingSource,
} from "../../src/appraisal/two_pass_attribution";

const DIR = join(process.cwd(), "tests/backtest/pool_output");

function intArg(n: string, d: number) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
}
function strArg(n: string, d: string) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const LIMIT = intArg("limit", 999);
const CONCURRENCY = intArg("concurrency", 2);
const MODEL = strArg("model", "claude-sonnet-4-6");
const TWO_PASS = process.argv.includes("--two-pass");
const RESUME = process.argv.includes("--resume");

// ── expose the protected triage method ───────────────────────────────────────
class TriageRunner extends FourStageAppraiser {
  runTriage(vea: VisualExtractionResult, appraiserInput?: AppraiserInputResult, visualSearch?: any) {
    return (this as any).runStage2aTriage(vea, MODEL, undefined, appraiserInput, visualSearch) as Promise<TriageResult>;
  }
}

// ── coarse fixture -> two-pass evidence-cell adapter ─────────────────────────
// ADR-0010 Decision 9.2 puts a Sonnet "evidence agent" here; until it exists this
// maps the fixture + the fresh TriageResult into the cells. Lossy — flagged in output.
const ILLEGIBLE = /illegible|unclear|indistinct|no signature|not (?:legible|visible)|^\W*$/i;
function legibleName(s: string | null | undefined): string | null {
  if (!s) return null;
  const c = s.replace(/\[[^\]]*\]/g, "").replace(/\d/g, "").trim();
  return c.length >= 3 && !ILLEGIBLE.test(s) ? c : null;
}

function toTwoPassInput(vea: any, vs: any, aia: any, triage: TriageResult): { input: TwoPassInput; notes: string[] } {
  const notes: string[] = [];
  const sigs: any[] = vea.signatures ?? [];
  const legSig = sigs.map((s) => ({ n: legibleName(s.transcription), c: s.signatureConfidence ?? 0 })).find((x) => x.n);
  const maxSigConf = Math.max(0, ...sigs.map((s) => s.signatureConfidence ?? 0));

  const vSource: NamingSource = legSig ? { kind: "names", raw: legSig.n! } : { kind: "silent" };

  // R — from the reworked Stage 1b: use the real visualSimilarityScore, and treat
  // evidenceBasis "visual" as consistent-with-VEA (a scored artwork comparison).
  let rSource: NamingSource = { kind: "no_match" };
  let s1bConsistent: boolean | null = null;
  if (vs?.bestMatchArtist) {
    const sim = typeof vs.visualSimilarityScore === "number" ? vs.visualSimilarityScore : 0;
    rSource = { kind: "names", raw: vs.bestMatchArtist, sim };
    s1bConsistent = vs.evidenceBasis === "visual";
    notes.push(`R: "${vs.bestMatchArtist}" sim=${sim} basis=${vs.evidenceBasis} -> consistentWithVea=${s1bConsistent}`);
  }

  const claimed = aia?.claimedAttribution ?? {};
  const aSource: NamingSource =
    claimed.artist && claimed.status !== "absent"
      ? { kind: "names", raw: claimed.artist, trust: claimed.status === "documented_fact" ? "documented_fact" : "hypothesis" }
      : { kind: "absent" };

  const top: any = (triage.candidateArtists ?? [])[0] ?? {};
  const kOeuvre = typeof top.ackgSupportCount === "number" ? top.ackgSupportCount : null;
  const kId: "true" | "false" | "unknown" = (top.ackgProvenanceTags ?? []).includes("institutional") ? "true" : "unknown";

  const twi: string | null = vea.composition?.textWithinImage ?? null;
  const titleInscr: string | null = (vea.titleInscriptions ?? [])[0]?.transcription ?? null;
  const veaTitle = legibleName(titleInscr) || (twi && /[a-z]{4}/i.test(twi) ? twi : null);

  const input: TwoPassInput = {
    artistEvidence: {
      vea: vSource,
      reverseImageSearch: rSource,
      appraiser: aSource,
      // The coarse fixture adapter doesn't carry Stage 1d data through this function's
      // inputs — this comparison mode predates the D vote, and D is fed to the real
      // evidence agent path separately (see runTriage). "no_match" == not modeled here.
      embeddingMatch: { kind: "no_match" },
      stage1bConsistentWithVea: s1bConsistent,
      veaAuthorshipSignalLegible: maxSigConf >= 0.5 || !!legSig || !!veaTitle,
      veaSignatureConfidence: sigs.length ? maxSigConf : null,
      kId,
      kOeuvreMatchCount: kOeuvre,
      kSubject: "UNASSESSABLE",
      ackgWorkAnchor: null,
    },
    workEvidence: {
      titleVea: veaTitle ? { kind: "names", raw: veaTitle } : { kind: "silent" },
      titleReverseImageSearch: vs?.bestMatchTitle
        ? { kind: "names", raw: vs.bestMatchTitle, sim: typeof vs.visualSimilarityScore === "number" ? vs.visualSimilarityScore : 0 }
        : { kind: "silent" },
      titleAppraiser: claimed.title ? { kind: "names", raw: claimed.title } : { kind: "silent" },
      // This adapter models no Stage 1d (see embeddingMatch above) — D_t stays silent.
      titleEmbeddingMatch: { kind: "silent" },
      kWork: null,
    },
    impressionEvidence: null,
    veaInImageTitleLegible: !!veaTitle,
    traditionConfidence: triage.traditionIdentification?.traditionConfidence ?? 0,
    veaHaltRecommended: !!vea.imageAuthenticity?.haltRecommended,
    riskFlags: {
      forgeryRisk: !!triage.riskFlags?.forgeryRisk,
      misattributionRisk: !!triage.riskFlags?.misattributionRisk,
    },
  };
  return { input, notes };
}

// ── run ──────────────────────────────────────────────────────────────────────
const config = { ...appraiserConfigs.find((c) => c.id === "claude-4stage")! };
const geminiKey = process.env.GEMINI_API_KEY;
const runner = new TriageRunner(config, geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : undefined);

let ids = readdirSync(DIR)
  .filter((d) => existsSync(join(DIR, d, "stage1.json")))
  .sort()
  .slice(0, LIMIT);
if (RESUME) {
  const before = ids.length;
  ids = ids.filter((d) => !existsSync(join(DIR, d, "triage.json")));
  console.log(`--resume: ${before - ids.length} already done, ${ids.length} to run`);
}

console.log(`\nStage 2a triage over the fixture`);
console.log(`model: ${MODEL}  |  lots: ${ids.length}  |  concurrency: ${CONCURRENCY}  |  two-pass adapter comparison: ${TWO_PASS}\n`);

const rows: any[] = [];
let done = 0;
let failed = 0;
const started = Date.now();

async function runOne(id: string) {
  const f = JSON.parse(readFileSync(join(DIR, id, "stage1.json"), "utf8"));
  const gtArtist: string = f.groundTruth?.poolArtistName ?? "?";
  try {
    const t0 = Date.now();
    const triage = await runner.runTriage(f.stage1a_vea, f.stage1c_appraiserInput, f.stage1b_visualSearch);
    const ms = Date.now() - t0;

    const rd = triage.routingDecision ?? ({} as any);
    const top: any = (triage.candidateArtists ?? [])[0] ?? {};
    const artistHit = top.artistName && gtArtist !== "?" ? nameSimilarity(top.artistName, gtArtist) >= TAU_NAME : false;

    // The evidence agent already ran the real two-pass tree — read it straight off.
    const a = triage.artistAttribution;
    const w = triage.workIdentification;
    const twoPass: any = a
      ? {
          scenario: rd.scenario,
          scenarioName: rd.scenarioName,
          artist: `${a.evidenceBasis} ${a.verdict}/${a.confidence ?? "-"} "${a.artistName ?? "-"}"`,
          work: w ? `${w.evidenceBasis} ${w.verdict}/${w.confidence ?? "-"}` : "(pass 2 not run)",
          impression: triage.impressionAssessment?.divergence ?? "n/a",
          agreesWithRouter: true,
          source: "evidence-agent",
        }
      : null;

    // --two-pass: additionally run the coarse fixture-adapter classification (built from
    // the fixture's own fields, not the evidence agent's tool-call output) and compare it
    // against the real evidence agent's scenario above — a check on whether the adapter
    // still tracks the real thing, not a replacement for it.
    let twoPassAdapterComparison: any = null;
    if (TWO_PASS) {
      const { input, notes } = toTwoPassInput(f.stage1a_vea, f.stage1b_visualSearch, f.stage1c_appraiserInput, triage);
      const r = classifyTwoPass(input);
      twoPassAdapterComparison = {
        scenario: r.scenario,
        scenarioName: r.scenarioName,
        artist: `${r.artistAttribution.evidenceBasis} ${r.artistAttribution.verdict}/${r.artistAttribution.confidence ?? "-"} "${r.artistAttribution.artistName ?? "-"}"`,
        work: r.workIdentification
          ? `${r.workIdentification.evidenceBasis} ${r.workIdentification.verdict}/${r.workIdentification.confidence ?? "-"}`
          : "(pass 2 not run)",
        agreesWithRouter: r.scenario === rd.scenario,
        adapterNotes: notes,
        ruleTrace: r.ruleTrace,
      };
    }

    writeFileSync(
      join(DIR, id, "triage.json"),
      JSON.stringify(
        {
          lot: f.lot,
          groundTruthArtist: gtArtist,
          model: MODEL,
          durationMs: ms,
          routing: {
            scenario: rd.scenario,
            scenarioName: rd.scenarioName ?? SCENARIO_NAMES[rd.scenario as Scenario],
            specialistConfig: rd.specialistConfig,
            humanEscalationRequired: rd.humanEscalationRequired,
            routingRationale: rd.routingRationale,
          },
          topCandidate: {
            artistName: top.artistName ?? null,
            candidateProbability: top.candidateProbability ?? null,
            ackgSupportCount: top.ackgSupportCount ?? null,
          },
          artistMatchesGroundTruth: artistHit,
          candidateArtists: (triage.candidateArtists ?? []).map((c: any) => ({
            rank: c.rank,
            artistName: c.artistName,
            candidateProbability: c.candidateProbability,
          })),
          evidenceCorroboration: triage.evidenceCorroboration ?? null,
          riskFlags: triage.riskFlags ?? null,
          twoPass,
          twoPassAdapterComparison,
          triageResult: triage,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    done++;
    rows.push({ id, gtArtist, ms, scenario: rd.scenario, artistHit, twoPass: twoPassAdapterComparison });
    console.log(
      `  ok  ${id.padEnd(13)} ${gtArtist.slice(0, 20).padEnd(21)} ${(ms / 1000).toFixed(0)}s  ` +
        `Sc.${rd.scenario} ${(rd.scenarioName ?? "").slice(0, 22).padEnd(23)} ` +
        `top="${(top.artistName ?? "-").slice(0, 20)}" ${artistHit ? "MATCH" : ""}` +
        (twoPassAdapterComparison ? `  | 2pass Sc.${twoPassAdapterComparison.scenario}${twoPassAdapterComparison.agreesWithRouter ? "=" : "≠"}` : "") +
        `  (${done + failed}/${ids.length})`,
    );
  } catch (err: any) {
    failed++;
    console.error(`  FAIL ${id.padEnd(13)} ${String(err?.message ?? err).slice(0, 160)}`);
  }
}

const work = [...ids];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
    while (work.length) {
      const id = work.shift();
      if (id) await runOne(id);
    }
  }),
);

// ── summary ──────────────────────────────────────────────────────────────────
const ok = rows.length;
if (ok) {
  const meanMs = rows.reduce((a, r) => a + r.ms, 0) / ok;
  const scDist: Record<number, number> = {};
  for (const r of rows) scDist[r.scenario] = (scDist[r.scenario] ?? 0) + 1;
  const hits = rows.filter((r) => r.artistHit).length;

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${ok} ok, ${failed} failed  —  ${((Date.now() - started) / 60000).toFixed(1)} min`);
  console.log(`Stage 2a mean duration: ${(meanMs / 1000).toFixed(0)}s   (min ${(Math.min(...rows.map((r) => r.ms)) / 1000).toFixed(0)}s, max ${(Math.max(...rows.map((r) => r.ms)) / 1000).toFixed(0)}s)`);
  console.log(`artist matches ground truth: ${hits}/${ok}`);
  console.log(
    `router scenario distribution: ${Object.entries(scDist)
      .map(([s, n]) => `Sc.${s} ${SCENARIO_NAMES[Number(s) as Scenario]}=${n}`)
      .join("  ")}`,
  );
  if (TWO_PASS) {
    const agree = rows.filter((r) => r.twoPass?.agreesWithRouter).length;
    console.log(`two-pass scenario == router scenario: ${agree}/${ok}   (thresholds: SIM_ARTIST_VOTE=${SIM_ARTIST_VOTE}, SIM_WORK_VOTE=${SIM_WORK_VOTE})`);
  }
  console.log(`written to tests/backtest/pool_output/<id>/triage.json`);
}
if (failed) process.exitCode = 1;
