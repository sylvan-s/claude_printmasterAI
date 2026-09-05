/**
 * Exercise the ADR-0010 two-pass classifier against real pipeline data.
 *
 * The classifier's true input (evidence cells) is produced by the Sonnet "evidence
 * agent" of ADR-0010 Decision 9.2, which is NOT built. So this is a COARSE adapter:
 * it derives approximate evidence cells from the artefacts a completed 4-stage run
 * already leaves in tests/backtest/output/<lot>/result.json — VEA (stage1Result),
 * the appraiser extraction (stage1cResult), and the current triage LLM's own
 * TriageResult (stage2aResult). The reconstruction of the Stage 1b vote and the
 * K_* signals is lossy and flagged inline.
 *
 * Purpose: sanity-check the classifier's verdicts and routing on real lots, and
 * surface where it diverges from the current deterministic router.
 *
 * Run: npx tsx tests/two_pass_attribution/run_against_backtest.ts [N]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyTwoPass,
  nameSimilarity,
  normalizeName,
  TAU_NAME,
  type TwoPassInput,
  type NamingSource,
} from "../../src/appraisal/two_pass_attribution";
import { SCENARIO_NAMES } from "../../src/appraisal/routing";

const OUTPUT_DIR = join(process.cwd(), "tests/backtest/output");
const N = Number(process.argv[2] ?? 10);

// deterministic shuffle (mulberry32) so "10 random" is reproducible
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample<T>(arr: T[], n: number, seed: number): T[] {
  const r = rng(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

const ILLEGIBLE = /illegible|unclear|indistinct|not (?:legible|clear)|\bn\/?a\b|^\W*$/i;
function legibleName(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s.replace(/\[[^\]]*\]/g, "").replace(/[0-9]/g, "").trim();
  if (cleaned.length < 3 || ILLEGIBLE.test(s)) return null;
  return cleaned;
}

// ── the coarse adapter ───────────────────────────────────────────────────────
function reportToTwoPassInput(report: any): { input: TwoPassInput; notes: string[] } {
  const notes: string[] = [];
  const vea = report.stage1Result ?? {};
  const triage = report.stage2aResult ?? {};
  const c1 = report.stage1cResult ?? {};
  const top = (triage.candidateArtists ?? [])[0] ?? {};
  const ec = triage.evidenceCorroboration ?? { stage1bAgreement: null, ackgAgreement: null, conflicts: [] };

  // V — only a legibly-transcribed VEA signature names an artist
  const sigs: any[] = vea.signatures ?? [];
  const legibleSig = sigs.map((s) => ({ n: legibleName(s.transcription), c: s.signatureConfidence ?? 0 })).find((x) => x.n);
  const maxSigConf = Math.max(0, ...sigs.map((s) => s.signatureConfidence ?? 0));
  const vSource: NamingSource = legibleSig ? { kind: "names", raw: legibleSig.n! } : { kind: "silent" };
  if (!legibleSig && sigs.length) notes.push(`V silent — signature present but not a legible name ("${sigs[0].transcription}")`);

  // R — reconstructed from evidenceCorroboration.stage1bAgreement (lossy: a real
  // below-threshold Stage 1b hypothesis can't be recovered from these artefacts).
  let rSource: NamingSource = { kind: "no_match" };
  let s1bConsistent: boolean | null = ec.stage1bAgreement;
  if (ec.stage1bAgreement === true && top.artistName) {
    rSource = { kind: "names", raw: top.artistName, sim: 0.82 };
    notes.push("R reconstructed: stage1bAgreement=true -> vote for top candidate @ sim~0.82");
  } else if (ec.stage1bAgreement === false && top.artistName) {
    rSource = { kind: "names", raw: top.artistName, sim: 0.2 };
    notes.push("R reconstructed: stage1bAgreement=false -> below-threshold / inconsistent, dropped");
  }

  // A — appraiser claimed attribution
  const claimed = c1.claimedAttribution ?? {};
  const aSource: NamingSource =
    claimed.artist && claimed.status !== "absent"
      ? { kind: "names", raw: claimed.artist, trust: claimed.status === "documented_fact" ? "documented_fact" : "hypothesis" }
      : { kind: "absent" };

  // K_* — proxies from the top candidate's ACKG fields
  const kOeuvre = typeof top.ackgSupportCount === "number" ? top.ackgSupportCount : null;
  const tags: string[] = top.ackgProvenanceTags ?? [];
  const kId: "true" | "false" | "unknown" = tags.includes("institutional") ? "true" : "unknown";
  if (kOeuvre == null) notes.push("K_oeuvre null (not queried / unavailable in artefact)");

  // Title sources
  const twi: string | null = vea.composition?.textWithinImage ?? null;
  const titleVea: WorkTitle = twi && /[a-z]{3}/i.test(twi) ? { kind: "names", raw: twi } : { kind: "silent" };
  const titleAppraiser: WorkTitle = claimed.title ? { kind: "names", raw: claimed.title } : { kind: "silent" };
  // R_t — try to pull a quoted title from the triage narrative near a Stage 1b mention
  let titleRis: WorkTitle & { sim?: number } = { kind: "silent" };
  const narrative = JSON.stringify(top.supportingEvidence ?? []) + JSON.stringify(ec.conflicts ?? []);
  const m = narrative.match(/Stage 1b[^"]*"([^"]{4,80})"|"([^"]{4,80})"[^"]*Stage 1b/);
  if (m) {
    titleRis = { kind: "names", raw: (m[1] || m[2])!, sim: 0.7 };
    notes.push(`R_t reconstructed from narrative: "${(m[1] || m[2])!}" @ sim~0.7`);
  }

  const input: TwoPassInput = {
    artistEvidence: {
      vea: vSource,
      reverseImageSearch: rSource,
      appraiser: aSource,
      stage1bConsistentWithVea: s1bConsistent,
      veaAuthorshipSignalLegible: maxSigConf >= 0.5 || !!legibleSig,
      veaSignatureConfidence: sigs.length ? maxSigConf : null,
      kId,
      kOeuvreMatchCount: kOeuvre,
      kSubject: "UNASSESSABLE",
      ackgWorkAnchor: null,
    },
    workEvidence: {
      titleVea,
      titleReverseImageSearch: titleRis,
      titleAppraiser,
      kWork: null,
    },
    impressionEvidence: null,
    veaInImageTitleLegible: titleVea.kind === "names",
    traditionConfidence: triage.traditionIdentification?.traditionConfidence ?? 0,
    riskFlags: {
      forgeryRisk: !!triage.riskFlags?.forgeryRisk,
      misattributionRisk: !!triage.riskFlags?.misattributionRisk,
    },
  };
  return { input, notes };
}
type WorkTitle = { kind: "names"; raw: string } | { kind: "silent" };

// ── run ──────────────────────────────────────────────────────────────────────
const lots = readdirSync(OUTPUT_DIR).filter((d) => {
  try {
    return readFileSync(join(OUTPUT_DIR, d, "result.json"), "utf8").length > 0;
  } catch {
    return false;
  }
});
const picked = sample(lots, N, 42);

console.log(`\nADR-0010 two-pass classifier vs. real pipeline data`);
console.log(`pool: ${lots.length} completed backtest lots | sampled: ${picked.length} (seed 42)\n`);
console.log(
  [
    "lot".padEnd(11),
    "ground truth".padEnd(20),
    "two-pass artist".padEnd(24),
    "basis".padEnd(11),
    "artist?".padEnd(8),
    "work".padEnd(14),
    "2pass scenario".padEnd(30),
    "router scenario",
  ].join(" | "),
);
console.log("-".repeat(160));

let artistHit = 0;
let scenarioMatch = 0;
const rows: any[] = [];

for (const lot of picked) {
  const result = JSON.parse(readFileSync(join(OUTPUT_DIR, lot, "result.json"), "utf8"));
  const gt = result.groundTruth ?? {};
  const routerScenario: number = result.report?.stage2aResult?.routingDecision?.scenario ?? 0;
  const { input, notes } = reportToTwoPassInput(result.report);
  const r = classifyTwoPass(input);

  const twoPassArtist = r.artistAttribution.artistName;
  const hit = twoPassArtist && gt.artist ? nameSimilarity(twoPassArtist, gt.artist) >= TAU_NAME : false;
  if (hit) artistHit++;
  if (r.scenario === routerScenario) scenarioMatch++;

  rows.push({ lot, gt: gt.artist, r, notes, routerScenario, hit });

  console.log(
    [
      lot.padEnd(11),
      String(gt.artist ?? "-").slice(0, 20).padEnd(20),
      String(twoPassArtist ?? "-").slice(0, 24).padEnd(24),
      `${r.artistAttribution.evidenceBasis}/${(r.artistAttribution.confidence ?? "-").slice(0, 4)}`.padEnd(11),
      (hit ? "YES" : "no").padEnd(8),
      `${r.workIdentification?.evidenceBasis ?? "-"}/${r.workIdentification?.verdict ?? "-"}`.slice(0, 14).padEnd(14),
      `${r.scenario} ${r.scenarioName}`.slice(0, 30).padEnd(30),
      `${routerScenario} ${SCENARIO_NAMES[routerScenario as 1] ?? "?"}`,
    ].join(" | "),
  );
}

console.log("-".repeat(160));
console.log(
  `\nartist matched ground truth: ${artistHit}/${picked.length}   |   ` +
    `two-pass scenario == current router scenario: ${scenarioMatch}/${picked.length}\n`,
);

console.log("Per-lot detail\n");
for (const { lot, gt, r, notes, routerScenario, hit } of rows) {
  console.log(`  ${lot}  (ground truth: ${gt ?? "-"})`);
  console.log(`    artist : ${r.artistAttribution.evidenceBasis} ${r.artistAttribution.verdict}/${r.artistAttribution.confidence ?? "-"} "${r.artistAttribution.artistName ?? "-"}"  ${hit ? "(matches GT)" : ""}`);
  if (r.artistAttribution.contradictingIdentities.length)
    console.log(`             contradicting: ${r.artistAttribution.contradictingIdentities.join(", ")}`);
  console.log(`    work   : ${r.workIdentification ? `${r.workIdentification.evidenceBasis} ${r.workIdentification.verdict}/${r.workIdentification.confidence ?? "-"}` : "(pass 2 not run)"}`);
  console.log(`    scenario: two-pass ${r.scenario} (${r.scenarioName})  vs  router ${routerScenario} (${SCENARIO_NAMES[routerScenario as 1] ?? "?"})`);
  for (const n of notes) console.log(`    adapter: ${n}`);
  console.log();
}
