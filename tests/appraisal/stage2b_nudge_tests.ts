/**
 * The in-loop search nudge (src/appraisal/stage2b_nudge.ts).
 *
 * What is actually being protected here is the gate. The nudge exists to convert "did not try"
 * into an attempt while the cheap model is still cheap; it must never become a way for a silent
 * model to pass a check it would otherwise fail, and it must never fire where it cannot help.
 */
import { shouldNudgeForSearch, SEARCH_NUDGE_TEXT, type NudgeState } from "../../src/appraisal/stage2b_nudge.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(name); }
  else { failed++; console.error(`FAIL: ${name}`); }
}

const base: NudgeState = { researchGap: true, searchesMade: 0, nudged: false, round: 0, maxRounds: 4 };
const on = (o: Partial<NudgeState>) => shouldNudgeForSearch({ ...base, ...o });

check("fires on the measured case: a real gap, nothing searched, rounds left", on({}));

// --- the four conditions, each necessary ---------------------------------
check(
  "silent on no gap — with a same-work sale in the graph, zero searches is correct (STEP 7)",
  !on({ researchGap: false }),
);
check(
  "silent once a search has run — the nudge is about not trying, not about trying harder",
  !on({ searchesMade: 1 }),
);
check(
  "never fires twice, however many rounds remain",
  !on({ nudged: true }),
);
check(
  "silent on the last round, where there is no round left in which to search",
  !on({ round: 3 }),
);
check(
  "still fires on the second-to-last round, where one round remains",
  on({ round: 2 }),
);

// --- boundary arithmetic -------------------------------------------------
check("round is zero-based against maxRounds: round 0 of 1 cannot act", !on({ round: 0, maxRounds: 1 }));
check("a two-round budget still allows a nudge on round 0", on({ round: 0, maxRounds: 2 }));
check("a spent budget never nudges", !on({ round: 9, maxRounds: 4 }));

// --- the wording carries the gate's own constraints ----------------------
// A nudged model must not be able to satisfy the nudge by inventing a comparable: the gate's
// uncited_comp reason is the measured fabrication signature, and the nudge asks for a search
// precisely in the situation where fabrication was observed.
check(
  "the nudge demands a search",
  /web_search/.test(SEARCH_NUDGE_TEXT),
);
check(
  "the nudge forecloses an uncited price rather than inviting one",
  /do NOT supply a price you cannot point at a URL for/.test(SEARCH_NUDGE_TEXT),
);
check(
  "the nudge offers an honest empty answer as the alternative",
  /unresolvedQuestions/.test(SEARCH_NUDGE_TEXT),
);
check(
  "the nudge states the gap it is reacting to, so the model knows why it is being asked",
  /NO record of this work ever selling/.test(SEARCH_NUDGE_TEXT),
);

// --- purity --------------------------------------------------------------
const frozen: NudgeState = { researchGap: true, searchesMade: 0, nudged: false, round: 1, maxRounds: 4 };
const snapshot = JSON.stringify(frozen);
shouldNudgeForSearch(frozen);
check("the predicate does not mutate its input", JSON.stringify(frozen) === snapshot);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
