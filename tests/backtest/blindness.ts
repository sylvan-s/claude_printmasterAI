/**
 * Blind-run guard, shared by the backtest harnesses.
 *
 * A backtest is only meaningful if the pipeline could not read the answer off its
 * own input. The catalogue body sometimes restates the artist's name — Roseberys
 * in particular appends a marketing paragraph ("This is one of Lowry's most
 * celebrated prints...") after the factual lines — and that paragraph goes into
 * Stage 1c's catalogueNotes verbatim. When that happens the run is not blind, and
 * whatever it concludes about attribution proves nothing.
 *
 * This used to be a single `console.log` line, easy to scroll past: A0793 lot 46
 * ran, reported "Laurence Stephen Lowry" as a blind result, and the leak was only
 * caught afterwards by reading the stored notes. So the default is now a hard stop.
 * `--allow-leak` still lets a run through deliberately (useful when the point of
 * the run is something other than attribution — a Stage 3 valuation check, say),
 * but it is recorded in the result JSON so the output can never be mistaken later
 * for a clean blind result.
 *
 * Only ARTIST-NAME leaks gate the run. Printer, publisher and catalogue-raisonné
 * leaks are deliberately sent as notes (a human appraiser transcribing the lot
 * would type them), so they stay informational.
 */

/**
 * Prefixes emitted by both house parsers. Only the surname gates: a forename on
 * its own rarely identifies an artist, and gating on it would abort clean runs
 * (A0777/1, Paul Gauguin, whose catalogue essay mentions "the Paul Kovesdy
 * Gallery" and never names Gauguin).
 */
export const ARTIST_SURNAME_LEAK_PREFIX = "artist surname";
export const ARTIST_FORENAME_LEAK_PREFIX = "artist forename/middle name(s)";

export function findArtistNameLeak(leakRisks: string[]): string | undefined {
  return leakRisks.find((r) => r.startsWith(ARTIST_SURNAME_LEAK_PREFIX));
}

const RULE = "!".repeat(78);

/**
 * Aborts the process when the catalogue body names the artist, unless the caller
 * passed --allow-leak. Returns the leak description when a run was allowed to
 * proceed anyway (record it in the output), or null when the run is clean.
 */
export function assertBlindOrExit(
  leakRisks: string[],
  opts: { allowLeak: boolean; tag: string },
): string | null {
  const soft = leakRisks.find((r) => r.startsWith(ARTIST_FORENAME_LEAK_PREFIX));
  if (soft) {
    console.warn(`[${opts.tag}] Note: ${soft} — not gated (a forename alone rarely identifies), but worth an eye.`);
  }

  const leak = findArtistNameLeak(leakRisks);
  if (!leak) return null;

  if (!opts.allowLeak) {
    console.error(`\n${RULE}`);
    console.error(`[${opts.tag}] BLIND RUN ABORTED — the catalogue body names the artist.`);
    console.error(`  ${leak}`);
    console.error(`  Stage 1c would receive this text verbatim, so the pipeline's attribution`);
    console.error(`  would not be blind and the result would not be evidence of anything.`);
    console.error(`  Re-run with --allow-leak if you want this lot anyway (the leak is then`);
    console.error(`  recorded in result.json), or pick a lot whose body does not name the artist.`);
    console.error(`${RULE}\n`);
    process.exit(2);
  }

  console.warn(`\n${RULE}`);
  console.warn(`[${opts.tag}] NOT A BLIND RUN — --allow-leak was passed and the body names the artist.`);
  console.warn(`  ${leak}`);
  console.warn(`  Attribution output from this run is NOT evidence the pipeline identified the`);
  console.warn(`  artist unaided. Recorded as blindnessCompromised in result.json.`);
  console.warn(`${RULE}\n`);
  return leak;
}
