/**
 * Deterministic Stage 2a→2b routing — ADR-0006.
 *
 * Replaces the LLM-declared `routingDecision.tier`/`specialistConfig`/`routingRationale`/
 * `alternativeConfig` with a pure function operating on TriageResult's already-structured
 * fields. No LLM call, no network call — fully unit-testable (see tests/routing/).
 *
 * Why: ADR-0005 finding #8 found the LLM inventing specialist-config names that don't exist
 * on disk (only 2 of the 26 names the old prompt offered were real files). The fix isn't a
 * bigger list — it's removing the LLM's ability to invent a name at all. Code decides the
 * route; the LLM's only job is to honestly populate the evidence fields this reads.
 *
 * `routingDecision.tier` retired 2026-09-06: ADR-0006 originally kept it as a coarser,
 * backward-compatible derivative of `scenario` for downstream consumers. A full-repo audit
 * found nothing — inside or outside src/appraisal — ever read it back (UI report rendering,
 * Stage 3, storage, analytics all came back clean; the only outside reference was a backtest
 * script writing it to a debug JSON for humans to eyeball). Scenario alone already drives
 * Stage 2b's task-profile selection (see TASK_PROFILES in prompts.ts) and was the more
 * precise signal ADR-0006 itself said tier overlapped with. Removed rather than left as dead
 * weight two routing signals could still quietly drift apart on.
 */
import { existsSync } from "fs";
import { join } from "path";
import type { TriageResult } from "../types";

const SPECIALIST_CONFIGS_DIR = join(process.cwd(), "src/appraisal/specialist_configs");
const FALLBACK_CONFIG_KEY = "general_print_fallback";

export enum Scenario {
  ConfirmedClean = 1,
  ElevatedAuthenticationRisk = 2,
  ArtistConfirmedWorkUnresolved = 3,
  MovementOnly = 4,
  CompetingCandidates = 5,
  LowSignalEverywhere = 6,
}

export const SCENARIO_NAMES: Record<Scenario, string> = {
  [Scenario.ConfirmedClean]: "Confirmed, clean",
  [Scenario.ElevatedAuthenticationRisk]: "Elevated authentication risk",
  [Scenario.ArtistConfirmedWorkUnresolved]: "Artist confirmed, work unresolved",
  [Scenario.MovementOnly]: "Movement/style only",
  [Scenario.CompetingCandidates]: "Competing candidates",
  [Scenario.LowSignalEverywhere]: "Low signal everywhere",
};

// ---------------------------------------------------------------------------
// UNTUNED PLACEHOLDER THRESHOLDS — ADR-0006's own "Not addressed" section defers real
// tuning to backtest data against known-attribution items, same discipline ADR-0003 called
// for on ACKG. Do not treat these as final; revisit once tests/backtest/ has been run
// against a real known-attribution corpus with these rules in place.
// ---------------------------------------------------------------------------
export const CONFIDENT_THRESHOLD = 0.65; // topCandidateProbability cutoff for "artist confirmed"
export const MOVEMENT_THRESHOLD = 0.5; // traditionConfidence cutoff for "movement only" vs. low signal
export const COMPETITIVE_MARGIN = 0.15; // candidateProbability gap counted as "comparable" to the top

// Hand-authored, not fuzzy-matched against each config's free-text `domain` field (too
// fragile to guarantee determinism). Add a registry entry whenever a new specialist config
// file is added — tests/routing/run_routing_tests.ts asserts every key here resolves to a
// real file, so a forgotten file (not a forgotten registry entry) fails loudly in CI/test,
// never silently at runtime.
interface SpecialistConfigRule {
  key: string;
  traditionKeywords: string[];
  artistKeywords: string[];
}
const SPECIALIST_CONFIG_REGISTRY: SpecialistConfigRule[] = [
  { key: "rembrandt_etchings", traditionKeywords: ["rembrandt", "old master intaglio", "dutch golden age"], artistKeywords: ["rembrandt"] },
  { key: "ukiyo_e_edo_general", traditionKeywords: ["ukiyo-e", "ukiyo e", "edo", "japanese woodblock", "utagawa"], artistKeywords: [] },
];

export interface RoutingPlan {
  scenario: Scenario;
  scenarioName: string;
  specialistConfig: string;
  specialistConfigMatchedOn: "artistName" | "primaryTradition" | "fallback";
  skepticModeEngaged: boolean;
  routingRationale: string;
  /** Every rule evaluated, in order — not just the one that fired. The literal audit trail
   *  ADR-0006 calls for ("why scenario 5" as a boolean trace, not an LLM's rationale text). */
  ruleTrace: string[];
}

function topCandidate(triage: TriageResult) {
  const candidates = triage.candidateArtists ?? [];
  if (candidates.length === 0) return undefined;
  return candidates.find((c) => c.rank === 1) ?? candidates[0];
}

function topCandidateProbability(triage: TriageResult): number {
  return topCandidate(triage)?.candidateProbability ?? 0;
}

export function countCompetitive(candidateArtists: TriageResult["candidateArtists"], margin = COMPETITIVE_MARGIN): number {
  if (!candidateArtists || candidateArtists.length === 0) return 0;
  const maxProb = Math.max(...candidateArtists.map((c) => c.candidateProbability));
  return candidateArtists.filter((c) => c.candidateProbability >= maxProb - margin).length;
}

/**
 * Known simplification versus ADR-0006's stated ideal: the ADR's Scenario 1 trigger
 * references ACKG's `sampleWorks` matching "the specific piece," but `sampleWorks`
 * (src/appraisal/knowledge_graph/types.ts AckgCandidate) is never persisted onto
 * TriageResult — it only exists transiently inside Stage 2a's live query_ackg tool loop.
 * This classifier only receives the finalized TriageResult, so it uses the closest available
 * proxy instead: real ACKG support (from either provenance layer) is a reasonable stand-in
 * for "a work-level match exists." Weaker than the ADR's ideal (title/dimensions weren't
 * actually compared) — documented here, not silently substituted. See ADR-0006's
 * implementation note addendum.
 *
 * Broadened 2026-08-26: originally required institutional-layer support specifically, on the
 * theory that institutional records map more reliably to a specific catalogued work. On
 * reflection this didn't hold up — ackgSupportCount is already an artist/technique/period
 * population-support signal, not a verified title match, regardless of which layer it comes
 * from. Restricting to institutional-only bought a source-trust distinction, not real
 * specificity, and needlessly narrowed how often Scenario 1 could ever be reached. Any real
 * support now counts.
 */
export function hasWorkLevelMatch(candidate: TriageResult["candidateArtists"][number] | undefined): boolean {
  if (!candidate) return false;
  return (candidate.ackgSupportCount ?? 0) > 0 && (candidate.ackgProvenanceTags ?? []).length > 0;
}

export function matchSpecialistConfig(triage: TriageResult): { key: string; matchedOn: RoutingPlan["specialistConfigMatchedOn"] } {
  const artistName = topCandidate(triage)?.artistName?.toLowerCase() ?? "";
  const primaryTradition = triage.traditionIdentification?.primaryTradition?.toLowerCase() ?? "";

  for (const rule of SPECIALIST_CONFIG_REGISTRY) {
    if (artistName && rule.artistKeywords.some((kw) => artistName.includes(kw))) {
      return { key: rule.key, matchedOn: "artistName" };
    }
  }
  for (const rule of SPECIALIST_CONFIG_REGISTRY) {
    if (primaryTradition && rule.traditionKeywords.some((kw) => primaryTradition.includes(kw))) {
      return { key: rule.key, matchedOn: "primaryTradition" };
    }
  }
  return { key: FALLBACK_CONFIG_KEY, matchedOn: "fallback" };
}

export function classifyTriageOutcome(triage: TriageResult): RoutingPlan {
  const trace: string[] = [];
  const riskFlags = triage.riskFlags ?? {
    forgeryRisk: false, reprintRisk: false, editionComplexityRisk: false,
    misattributionRisk: false, authenticationBodyExists: false, physicalExaminationRequired: false,
  };
  const conflicts = triage.evidenceCorroboration?.conflicts ?? [];
  const candidates = triage.candidateArtists ?? [];
  const topProb = topCandidateProbability(triage);
  const top = topCandidate(triage);
  const traditionConfidence = triage.traditionIdentification?.traditionConfidence ?? 0;
  const competitive = countCompetitive(candidates);

  let scenario: Scenario;

  // authenticationBodyExists deliberately excluded (2026-08-26) — redefined as a fact flag
  // (does a catalogue raisonné/foundation exist for this artist), not a risk signal. It was
  // found true in 7 of 8 real backtest lots regardless of actual outcome, because most
  // historically documented printmakers have one — including it here made Scenario 2 fire
  // near-universally rather than discriminating. See ADR-0006's implementation note.
  const elevatedRisk = riskFlags.forgeryRisk || riskFlags.misattributionRisk;
  trace.push(`riskFlags.forgeryRisk=${riskFlags.forgeryRisk} misattributionRisk=${riskFlags.misattributionRisk} (authenticationBodyExists=${riskFlags.authenticationBodyExists}, excluded from trigger — fact flag, not risk) → elevatedRisk=${elevatedRisk}`);
  if (elevatedRisk) {
    scenario = Scenario.ElevatedAuthenticationRisk;
  } else {
    const contested = conflicts.length > 0 || competitive >= 2;
    trace.push(`evidenceCorroboration.conflicts=${conflicts.length} competitiveCandidates=${competitive} → contested=${contested}`);
    if (contested) {
      scenario = Scenario.CompetingCandidates;
    } else {
      const confident = topProb >= CONFIDENT_THRESHOLD;
      const workMatch = hasWorkLevelMatch(top);
      trace.push(`topCandidateProbability=${topProb.toFixed(2)} (threshold ${CONFIDENT_THRESHOLD}) → confident=${confident}; hasWorkLevelMatch=${workMatch}`);
      if (confident && workMatch) {
        scenario = Scenario.ConfirmedClean;
      } else if (confident) {
        scenario = Scenario.ArtistConfirmedWorkUnresolved;
      } else {
        const movementConfident = traditionConfidence >= MOVEMENT_THRESHOLD;
        trace.push(`traditionConfidence=${traditionConfidence.toFixed(2)} (threshold ${MOVEMENT_THRESHOLD}) → movementConfident=${movementConfident}`);
        scenario = movementConfident ? Scenario.MovementOnly : Scenario.LowSignalEverywhere;
      }
    }
  }

  const { key: specialistConfig, matchedOn: specialistConfigMatchedOn } = matchSpecialistConfig(triage);
  const scenarioName = SCENARIO_NAMES[scenario];
  const skepticModeEngaged = scenario === Scenario.ElevatedAuthenticationRisk || scenario === Scenario.CompetingCandidates;

  trace.push(`→ Scenario ${scenario} (${scenarioName}), specialistConfig="${specialistConfig}" (matched on ${specialistConfigMatchedOn})`);

  return {
    scenario,
    scenarioName,
    specialistConfig,
    specialistConfigMatchedOn,
    skepticModeEngaged,
    routingRationale: trace[trace.length - 1],
    ruleTrace: trace,
  };
}

/**
 * Splices classifyTriageOutcome's output onto a raw (just-returned-from-the-LLM)
 * TriageResult, preserving the LLM's own genuinely-assessed humanEscalationRequired/Reason.
 * Call this once, right after Stage 2a's LLM call returns, before the result is used or
 * stored anywhere — see runStage2aTriage in appraiser.ts.
 */
export function applyDeterministicRouting(raw: TriageResult): TriageResult {
  const plan = classifyTriageOutcome(raw);
  raw.routingDecision = {
    ...raw.routingDecision,
    scenario: plan.scenario,
    scenarioName: plan.scenarioName,
    specialistConfig: plan.specialistConfig,
    routingRationale: plan.routingRationale,
  };
  return raw;
}

/** Test-only helper: confirms every registry key (and the fallback) resolves to a real
 *  specialist_configs/*.json file, so a forgotten file fails loudly instead of silently
 *  falling back at runtime (the exact ADR-0005 finding #8 failure mode, now unreachable). */
export function assertSpecialistConfigRegistryIsValid(): void {
  const keys = [...SPECIALIST_CONFIG_REGISTRY.map((r) => r.key), FALLBACK_CONFIG_KEY];
  for (const key of keys) {
    const filePath = join(SPECIALIST_CONFIGS_DIR, `${key}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Specialist config registry references "${key}" but ${filePath} does not exist`);
    }
  }
}
