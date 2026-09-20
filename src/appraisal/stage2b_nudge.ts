/**
 * Ask the cheap model once, before replacing it.
 *
 * Measured across the backtest logs on 2026-09-14, Stage 2b escalated Haiku -> Sonnet eight
 * times. Six of those eight read "no web search was made, and the graph holds no same-work
 * sale": the model called the graph tools, got nothing back, and wrote its report anyway. The
 * remaining two were a reply that contained no JSON at all (handled separately by the re-ask
 * in appraiser.ts).
 *
 * Escalation re-runs the WHOLE stage on the stronger model — every search repeated, the prefix
 * re-primed — which is a heavy remedy for a model that simply did not try. When the gap is
 * noticed mid-loop instead, the cheap model still has its graph results in context, the prompt
 * prefix is already cached, and rounds remain. One turn saying "the search was the job" costs a
 * fraction of a Sonnet run.
 *
 * THIS DOES NOT SOFTEN THE GATE. The nudge changes what the cheap model is given a chance to do;
 * `assessStage2bResearch` still judges what it actually produced, on exactly the same terms, and
 * still escalates when the answer is unverifiable. The only cases removed are the ones where
 * asking was enough — which is why the nudge is capped at one and why it insists on
 * unresolvedQuestions rather than a price, so a nudged model cannot buy its way past the gate by
 * inventing the comparable it was told to look for.
 */

export interface NudgeState {
  /** The graph returned no same-work sale, so finding a comparable was the task. */
  researchGap: boolean;
  /** Web searches executed so far in this run. */
  searchesMade: number;
  /** Whether the single nudge has already been spent. */
  nudged: boolean;
  /** Zero-based round the loop is in. */
  round: number;
  /** The loop's round budget. */
  maxRounds: number;
}

/**
 * A nudge is warranted only when all four hold: there is a real gap, nothing was searched, the
 * nudge is unspent, and a round remains to act on it. The last is what keeps the nudge from
 * being pointless — spending the final round telling a model to search leaves it no round in
 * which to search, and the stage would finalise identically while costing one extra turn.
 */
export function shouldNudgeForSearch(s: NudgeState): boolean {
  return s.researchGap && s.searchesMade === 0 && !s.nudged && s.round < s.maxRounds - 1;
}

/** The nudge itself. Names the gap, names the task, and forecloses inventing the answer. */
export const SEARCH_NUDGE_TEXT =
  "Before you finalise: you have not run a web search, and the knowledge graph holds NO record " +
  "of this work ever selling. Finding a comparable sale, or establishing that none is public, " +
  "was the task for this lot — an answer without it is not a finding. Run at least one " +
  "web_search now. If the searches return nothing usable, say so explicitly in " +
  "unresolvedQuestions and do NOT supply a price you cannot point at a URL for.";
