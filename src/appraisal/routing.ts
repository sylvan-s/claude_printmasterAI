/**
 * Shared Stage 2a routing surface — the `Scenario` enum and specialist-config matching
 * used by the Attribution Evidence Agent (ADR-0010, `stage2a_evidence.ts`) to select
 * Stage 2b's specialist domain config. No LLM call, no network call.
 *
 * `routingDecision.tier` retired 2026-09-06: ADR-0006 originally kept it as a coarser,
 * backward-compatible derivative of `scenario` for downstream consumers. A full-repo audit
 * found nothing — inside or outside src/appraisal — ever read it back (UI report rendering,
 * Stage 3, storage, analytics all came back clean; the only outside reference was a backtest
 * script writing it to a debug JSON for humans to eyeball). Scenario alone already drives
 * Stage 2b's task-profile selection (see TASK_PROFILES in prompts.ts) and was the more
 * precise signal ADR-0006 itself said tier overlapped with. Removed rather than left as dead
 * weight two routing signals could still quietly drift apart on.
 *
 * Classic triage (`classifyTriageOutcome`, `CONFIDENT_THRESHOLD`/`MOVEMENT_THRESHOLD`/
 * `COMPETITIVE_MARGIN`, `hasWorkLevelMatch`, `countCompetitive`, `RoutingPlan`,
 * `applyDeterministicRouting`) retired 2026-09-06 (ADR-0014) — ADR-0010's Attribution
 * Evidence Agent + two-pass tree (`two_pass_attribution.ts`) is now the only Stage 2a
 * implementation; the one-shot-LLM-verdict path and everything exclusive to it (including
 * `gemini-4stage`, since evidence mode needs Claude's tool-calling loop and this project
 * chose not to build a Gemini equivalent) were removed rather than kept alongside a mode
 * with no remaining reason to exist. `two_pass_attribution.ts` already carries its own
 * independent `MOVEMENT_THRESHOLD` (was previously a separate, comment-synchronized
 * duplicate of this file's copy, not an import of it) — deleting this file's copy resolves
 * that duplication as a side effect, not a separate fix.
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

function topCandidate(triage: TriageResult) {
  const candidates = triage.candidateArtists ?? [];
  if (candidates.length === 0) return undefined;
  return candidates.find((c) => c.rank === 1) ?? candidates[0];
}

export function matchSpecialistConfig(triage: TriageResult): { key: string; matchedOn: "artistName" | "primaryTradition" | "fallback" } {
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
