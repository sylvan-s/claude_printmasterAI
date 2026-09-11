/**
 * Deterministic two-pass attribution classifier — ADR-0010.
 *
 * ADR-0010's logic tree is evaluated here as pure functions over a set of "evidence
 * cells" (ArtistEvidence / WorkEvidence). Per ADR-0010 Decision 9, a single Sonnet call
 * fills those cells (forms the hypothesis, runs the query_ackg loop, judges Stage 1b
 * consistency, resolves identities); this module does the rest — no LLM, no network,
 * fully unit-testable (tests/two_pass_attribution/).
 *
 * Wired into the live pipeline via src/appraisal/stage2a_evidence.ts's `runEvidenceTree`,
 * which the sole Stage 2a implementation (`runStage2aTriage` in appraiser.ts; ADR-0014
 * retired the older classic-triage path) calls after the evidence agent fills the cells.
 * `mapTwoPassToScenario()` returns the same ADR-0006 `Scenario` enum from routing.ts.
 *
 * Run the tests: npm run test:two-pass
 */
import { Scenario, SCENARIO_NAMES } from "./routing";
// HONORIFICS lives in src/shared so the blind-mode leak detectors in benchmark/
// share one vocabulary with this matcher rather than drifting copies.
import { HONORIFICS, NATIONALITY_WORDS } from "../shared/text_extraction";

// ───────────────────────────────────────────────────────────────────────────────
// UNTUNED PLACEHOLDER THRESHOLDS — ADR-0010 Decision 4.
// None of these are fitted to anything. Same "backtest before trust" discipline
// routing.ts's constants owe (ADR-0006). Revisit once tests/backtest/ has run with
// the two-pass classifier in place.
// ───────────────────────────────────────────────────────────────────────────────
export const TAU_NAME = 0.9; // normalized-name similarity to count two sources as one identity (fallback when neither carries a ULAN/Wikidata id)
export const SIM_ARTIST_VOTE = 0.75; // Stage 1b sim floor to count as an artist vote
export const SIM_ARTIST_STRONG = 0.85; // Stage 1b sim for a MEDIUM (vs LOW) single-source artist candidate
export const SIM_WORK_VOTE = 0.85; // Stage 1b sim floor to count as a Conceptual Work (title) vote
export const TAU_TITLE = 0.8; // K_work.titleSim floor for a K_work hit to count / vote — on the rescaled 0..1 title-similarity from embed_text.titleSimFromCosine (gemini-embedding-001)
export const TAU_TITLE_ANCHOR = 0.85; // higher floor for a standalone K_work-anchored work identification (T8K) when the title SOURCES give no consensus
export const TAU_TITLE_AGREE = 0.5; // local token-set-Jaccard floor for two title SOURCES to "agree" — still token-based (embeddings score the catalogue match, not source-vs-source; Part B follow-up)
export const TAU_DIM_PLATE_PCT = 0.03; // plate-mark dimension tolerance
export const TAU_DIM_PLATE_MM = 2; // ...with an absolute floor
export const TAU_DIM_IMAGE_PCT = 0.05; // image/composition dimension tolerance
export const TAU_DIM_IMAGE_MM = 3; // ...with an absolute floor
/** Sheet tolerance, deliberately far wider: the sheet is the paper, and the paper gets
 *  trimmed, deckled and remargined. Two impressions of one work routinely differ by
 *  centimetres at the sheet where the plate is identical to the millimetre. Admitted as a
 *  comparison at all because 287 of 443 A0793 lots (65%) state ONLY a sheet size — a weak
 *  signal that exists beats a strong one that does not. */
export const TAU_DIM_SHEET_PCT = 0.08;
export const TAU_DIM_SHEET_MM = 10;
export const DIM_MATERIAL_PCT = 0.1; // beyond tolerance but below this = "minor"; at/above = "material"
export const KOEUVRE_DISCRIMINATING_MIN = 3; // K_oeuvre matchCount that counts as "uniquely discriminating" for a one-band lift on an n=1 candidate

// ───────────────────────────────────────────────────────────────────────────────
// Confidence bands
// ───────────────────────────────────────────────────────────────────────────────
export type Confidence = "HIGH" | "MEDIUM_HIGH" | "MEDIUM" | "LOW";
const BANDS: Confidence[] = ["LOW", "MEDIUM", "MEDIUM_HIGH", "HIGH"];
function liftBand(c: Confidence, by = 1): Confidence {
  // Clamped at BOTH ends. Only ever called with by=+1 until 2026-09-09; corroboration can
  // now move a band down, and an unclamped index would return BANDS[-1] === undefined.
  return BANDS[Math.max(0, Math.min(BANDS.length - 1, BANDS.indexOf(c) + by))];
}

// ───────────────────────────────────────────────────────────────────────────────
// Name normalization — the deterministic fallback matcher (ADR-0010 "Not addressed":
// production resolves via ULAN/Wikidata id first; this is the string fallback).
// ───────────────────────────────────────────────────────────────────────────────

export function normalizeName(raw: string): { key: string; tokens: string[] } {
  let s = raw;
  // "Surname, First"  ->  "First Surname"
  if (s.includes(",")) {
    const [a, b] = s.split(",", 2);
    s = `${b.trim()} ${a.trim()}`;
  }
  s = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[().]/g, " ")
    .replace(/[^a-z0-9\s'-]/g, " ");
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter(
      (t) =>
        t.length > 1 && // drops single-letter initials ("E. Munch" -> ["munch"])
        !HONORIFICS.has(t) &&
        !NATIONALITY_WORDS.has(t) &&
        !/^b?\.?\d/.test(t) && // life dates, "b.1938", "1910-1988"
        !/^\d{3,4}-?\d{0,4}$/.test(t),
    );
  return { key: tokens.slice().sort().join(" "), tokens };
}

/**
 * Overlap coefficient over normalized token sets — `intersection / min(|a|, |b|)`.
 * Overlap rather than Jaccard because the common divergences between two references
 * to the same artist are middle names / initials / honorific residue ("Julian Otto
 * Trevelyan" vs "Julian Trevelyan"), which Jaccard punishes and overlap tolerates.
 * Two genuinely different artists still fall well short (a shared forename gives
 * `1 / 2 = 0.5`, below TAU_NAME). This is the string fallback — production resolves
 * via ULAN/Wikidata id first (ADR-0010 "Not addressed").
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).tokens);
  const tb = new Set(normalizeName(b).tokens);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/** Local, deterministic title similarity — the placeholder for the embedding cosine
 *  ADR-0010 Decision 9.1 commits to. Token-set Jaccard after light normalization
 *  (lowercase, strip punctuation, drop plate/series qualifier words). */
const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "off", "from", "and", "at", "in", "on", "to", "with",
  "no", "plate", "pl", "suite", "series", "for", "le", "la", "les", "un", "une",
  "des", "du", "der", "die", "das", "el", "los", "las",
]);
function titleTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t)),
  );
}

function intersectionSize(ta: Set<string>, tb: Set<string>): number {
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}

export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = intersectionSize(ta, tb);
  return inter / (ta.size + tb.size - inter);
}

/**
 * Overlap coefficient over the same tokens — `intersection / min(|a|, |b|)`.
 *
 * Used ONLY to compare a catalogued title against an agreed one (see
 * `kWorkCorroborates`), never to cluster two title SOURCES against each other. The
 * asymmetry is deliberate: a catalogued ACKG title is routinely the plain title plus a
 * series or plate qualifier — "Cold Water about to Hit the Prince" vs "Cold Water about
 * to Hit the Prince, from 'Illustrations for Six Fairy Tales from the Brothers Grimm'" —
 * which Jaccard punishes (0.45, below TAU_TITLE_AGREE) for containing MORE information
 * about the same work. This is the same reasoning `nameSimilarity` already applies to
 * artist names, and for the same reason.
 *
 * Guard: overlap is trusted only when the shorter side carries at least two informative
 * tokens. A single-token title ("Untitled", "Composition") is contained by half the
 * catalogue, so those fall back to Jaccard.
 */
const TITLE_OVERLAP_MIN_TOKENS = 2;
export function titleContainment(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const smaller = Math.min(ta.size, tb.size);
  if (smaller < TITLE_OVERLAP_MIN_TOKENS) return titleSimilarity(a, b);
  return intersectionSize(ta, tb) / smaller;
}

// ───────────────────────────────────────────────────────────────────────────────
// PASS 1 — ARTIST
// ───────────────────────────────────────────────────────────────────────────────
// V = VEA, R = reverse image search, A = appraiser input. K = ACKG work-level anchor —
// see ADR-0010 Decision 4a amendment (2026-08-29): an ACKG work whose title matches an
// observed title AND is catalogued to a single artist is independent enough to VOTE.
// K_oeuvre population COUNTS still only corroborate (never vote).
// D — Stage 1d DINOv2/CLIP nearest-neighbour match against the ACKG's own indexed image
// corpus (ADR-0013). ADR-0013 deliberately withheld voting rights pending backtest; this
// amendment (2026-09-06) grants them, gated to a HIGH matchConfidence only — MEDIUM/LOW
// are a "don't know", not a vote (see eligibleVotes below).
export type SourceTag = "V" | "R" | "A" | "K" | "D";

/** One naming source's state. `identityKey` is a ULAN/Wikidata URI when the model
 *  resolved one; otherwise agreement falls back to normalizeName/nameSimilarity. */
export type NamingSource =
  | {
      kind: "names";
      raw: string;
      identityKey?: string | null;
      /** Stage 1b only. */
      sim?: number;
      /** Appraiser only. */
      trust?: "documented_fact" | "hypothesis";
      /** Stage 1d (D) only — Stage 1d's own self-reported match confidence band. */
      matchConfidence?: "HIGH" | "MEDIUM" | "LOW";
      /** Stage 1d (D) only — the BEST DINOv2 similarity anywhere in this artist's rows. */
      dinoSimilarity?: number;
      /** Stage 1d (D) only — the BEST CLIP similarity anywhere in this artist's rows.
       *  Scored on its own scale; never averaged with dino (they are different measures). */
      clipSimilarity?: number;
    }
  | { kind: "silent" } // V: no nameable authorship signal
  | { kind: "no_match" } // R / D: search found nothing (or wasn't run)
  | { kind: "absent" }; // A: no appraiser notes / no attribution claim

export interface ArtistEvidence {
  vea: NamingSource; // V
  reverseImageSearch: NamingSource; // R — needs sim >= SIM_ARTIST_VOTE and consistency to vote
  appraiser: NamingSource; // A — documented_fact votes; hypothesis does not
  /** Stage 1d — DINOv2/CLIP match against the ACKG's own image index (ADR-0013 + 2026-09-06
   *  voting amendment). Only `matchConfidence === "HIGH"` votes; MEDIUM/LOW count as "don't
   *  know" (dropped in eligibleVotes, no corroboration effect either). */
  embeddingMatch: NamingSource; // D
  /** Model judgement (ADR-0010 Decision 2): does R's hypothesis contradict the VEA read
   *  (technique / period / signature characters / medium)? null when R has no match. */
  stage1bConsistentWithVea: boolean | null;
  /** VEA saw a legible hand-signature OR an in-image title/series cartouche implying authorship. */
  veaAuthorshipSignalLegible: boolean;
  /** VEA signatureConfidence for the mark the artist name was read from, if any. */
  veaSignatureConfidence: number | null;
  // ── ACKG corroboration for the dominant candidate (model fills these after its
  //    query_ackg loop) ──
  kId: "true" | "false" | "unknown";
  kOeuvreMatchCount: number | null; // null = not queried
  kSubject: "TYPICAL" | "OCCASIONAL" | "ATYPICAL" | "UNASSESSABLE";
  /** Scoped style comparison for the dominant candidate. Built in code (a graph query run
   *  before the tree), never by the agent. null when unavailable. Exclusion only. */
  styleConsistency?: StyleConsistencyEvidence | null;
  kSubjectNote?: string;
  /** ADR-0010 Decision 4a amendment: the ACKG holds a work whose title matches an observed
   *  title (V_t / R_t / A_t) AND is catalogued to exactly one artist. This VOTES in the
   *  artist pass (titleSim >= TAU_TITLE), unlike the K_oeuvre population count. null when
   *  there is no such work-level artist+title match. */
  ackgWorkAnchor: { artist: string; identityKey?: string | null; titleSim: number } | null;
  /** This artist's own DINOv2 work-identity floor (Artist.dinoBackgroundP99). Absent for most
   *  artists, in which case the global D_T_DINO_FLOOR applies — see dinoFloorFor. */
  artistDinoFloor?: number | null;
}

export interface ArtistVerdict {
  verdict: "attributed" | "candidate" | "not_attributed" | "conflict";
  artistName: string | null;
  confidence: Confidence | null;
  evidenceBasis: string; // "A1".."A11", or "A6D" (2026-09-06: lone HIGH-confidence Stage 1d match)
  agreementSet: SourceTag[];
  kId: "true" | "false" | "unknown";
  kOeuvreMatchCount: number | null;
  subjectCorroboration: "typical" | "occasional" | "atypical" | "unassessable";
  subjectNote: string;
  flags: string[];
  /** Competing identities that lost — logged, never silently dropped (Principle 8). */
  contradictingIdentities: string[];
  ruleTrace: string[];
}

interface Vote {
  source: SourceTag;
  raw: string;
  identityKey: string | null;
}

/** Which sources are eligible to vote, applying the Stage 1b gate and the
 *  hypothesis-is-not-a-vote rule (ADR-0010 Decision 2 / 4b). */
function eligibleVotes(ev: ArtistEvidence, trace: string[]): { votes: Vote[]; appraiserHypothesis: NamingSource | null } {
  const votes: Vote[] = [];
  let appraiserHypothesis: NamingSource | null = null;

  if (ev.vea.kind === "names") {
    votes.push({ source: "V", raw: ev.vea.raw, identityKey: ev.vea.identityKey ?? null });
  }

  if (ev.reverseImageSearch.kind === "names") {
    const sim = ev.reverseImageSearch.sim ?? 0;
    const consistent = ev.stage1bConsistentWithVea === true;
    if (sim >= SIM_ARTIST_VOTE && consistent) {
      votes.push({ source: "R", raw: ev.reverseImageSearch.raw, identityKey: ev.reverseImageSearch.identityKey ?? null });
    } else {
      trace.push(
        `R dropped from vote: sim=${sim.toFixed(2)} (floor ${SIM_ARTIST_VOTE}), consistentWithVea=${ev.stage1bConsistentWithVea} — kept as a note, not a vote`,
      );
    }
  }

  if (ev.appraiser.kind === "names") {
    if (ev.appraiser.trust === "documented_fact") {
      votes.push({ source: "A", raw: ev.appraiser.raw, identityKey: ev.appraiser.identityKey ?? null });
    } else {
      appraiserHypothesis = ev.appraiser;
      trace.push(`A is a hypothesis — corroborates / breaks ties, but is not a vote`);
    }
  }

  // K does NOT vote (2026-09-09 amendment, superseding Decision 4a's amendment).
  //
  // The ACKG is not a witness to authorship — it is the reference the witnesses are checked
  // against. Its "vote" was an artist back-propagated from a title match, and that title came
  // from V_t / R_t / A_t / D_t, so counting it as an independent source double-counted the
  // very sources it derives from. It produced a concrete false positive: on Roseberys
  // A0793/148 the verdict was A2 attributed/HIGH on agreementSet ["K","D"], where K's artist
  // came from a title match to "Reclining Figure" — the wrong work entirely. A bad title
  // match manufactured a second independent-looking vote and carried the verdict to HIGH.
  //
  // The anchor is now read by corroborateArtist() below, where a title match can raise
  // confidence in a candidate a real source named, but can never name one by itself.
  if (ev.ackgWorkAnchor?.artist) {
    trace.push(
      `K does not vote — ACKG corroborates, it does not witness (anchor "${ev.ackgWorkAnchor.artist}", titleSim=${(ev.ackgWorkAnchor.titleSim ?? 0).toFixed(2)})`,
    );
  }

  // D — Stage 1d DINOv2/CLIP match (2026-09-06 amendment to ADR-0013). Only a HIGH
  // matchConfidence votes; MEDIUM/LOW is a "don't know" — dropped entirely, not even kept
  // as a corroborating note, since an uncalibrated embedding score below HIGH isn't known
  // to mean anything yet (ADR-0013's own "Not addressed" section).
  // D votes at ANY confidence as of 2026-09-09, carrying its measured similarity so the
  // scoring weighs it rather than discarding it.
  //
  // The HIGH-only gate was throwing away correct answers. Across five A0793 lots Stage 1d's
  // top-1 was the RIGHT artist all five times, and three were dropped for missing the
  // dino >= 0.90 leg while CLIP independently agreed at 0.937-0.946:
  //
  //     Frink   dino 0.974  clip 0.974  HIGH    -> voted, correct
  //     Banksy  dino 0.991  clip 0.980  HIGH    -> voted, correct
  //     Blake   dino 0.886  clip  null  MEDIUM  -> dropped, correct
  //     Villon  dino 0.876  clip 0.946  MEDIUM  -> dropped, correct
  //     Picasso dino 0.851  clip 0.937  MEDIUM  -> dropped, correct
  //
  // A weak match is now a weak vote, not silence: sourceConfidence() reports the measured
  // similarity and CONFIDENCE_MEAN_FLOOR demotes a band built on it. Note there is no floor
  // at all — Stage 1d always returns a top candidate, so D always votes; a poor match should
  // surface as a LOW-confidence candidate rather than as "no evidence".
  if (ev.embeddingMatch.kind === "names") {
    const { dinoOk, clipOk, scored } = embeddingSignals(ev.embeddingMatch);
    const d = ev.embeddingMatch.dinoSimilarity;
    const c = ev.embeddingMatch.clipSimilarity;
    const shown = `dino=${d?.toFixed(3) ?? "—"} clip=${c?.toFixed(3) ?? "—"}`;
    if (!scored) {
      // No numbers at all — fall back to the band Stage 1d self-reported.
      const band = D_BAND_CONFIDENCE[ev.embeddingMatch.matchConfidence ?? "LOW"] ?? D_BAND_CONFIDENCE.LOW;
      if (band >= D_VOTE_FLOOR) {
        votes.push({ source: "D", raw: ev.embeddingMatch.raw, identityKey: ev.embeddingMatch.identityKey ?? null });
        trace.push(`D votes on its self-reported ${ev.embeddingMatch.matchConfidence} band (no similarity scores supplied)`);
      } else {
        trace.push(`D dropped: no similarity scores and band ${ev.embeddingMatch.matchConfidence ?? "unknown"} is below the floor`);
      }
    } else if (dinoOk || clipOk) {
      // The artist counts as matched when ANY example in their corpus matches on EITHER
      // measure — the scores below are the best each measure found across that artist's rows.
      votes.push({ source: "D", raw: ev.embeddingMatch.raw, identityKey: ev.embeddingMatch.identityKey ?? null });
      trace.push(
        `D votes: ${shown} — ${dinoOk && clipOk ? "both measures agree" : dinoOk ? "DINOv2 only" : "CLIP only"}`,
      );
    } else {
      trace.push(`D dropped: ${shown} — neither clears its own floor (dino ${DINO_ARTIST_FLOOR} / clip ${CLIP_ARTIST_FLOOR})`);
    }
  }

  return { votes, appraiserHypothesis };
}

/**
 * Each naming source's OWN confidence, normalised to 0..1 (2026-09-09).
 *
 * "Agreement primary, confidence modulates": the number of agreeing sources still sets the
 * base band, but a verdict resting on sources that are themselves unsure should not read the
 * same as one resting on confident ones.
 *
 * V and R report real numbers. A and D are ordinal and mapped to placeholders — flagged as
 * such because, like every other threshold in this file, they are unfitted (ADR-0010
 * Decision 4). D only reaches here at HIGH, and A only when documented_fact, so both are
 * already gated above; the values below express "how much does a source that cleared its
 * gate contribute", not the gate itself.
 */
/**
 * Mean confidence of the agreeing sources below which the base band is demoted one.
 *
 * Deliberately 0.8 and not something lower: each source's vote GATE already floors its
 * confidence — R only votes at sim >= SIM_ARTIST_VOTE (0.75), A only when documented_fact
 * (0.85), D only at HIGH (0.9). A floor beneath those could never fire on anything except a
 * lone weak V, which A5 already sends to LOW on its own. Set above the gates, the rule
 * separates a pair that barely cleared its thresholds from a pair that cleared them
 * comfortably — which is the distinction "confidence modulates" is actually for.
 *
 * The MEAN, not the max: two sources scraping past their gates should not read like one
 * confident source plus a passenger.
 */
export const CONFIDENCE_MEAN_FLOOR = 0.8;
const A_DOCUMENTED_CONFIDENCE = 0.85; // ordinal placeholder — paperwork cited, not verified
/**
 * DINOv2 and CLIP are different measures on different scales and are never averaged.
 * Each gets its own floor, read off its own behaviour on the A0793 + A0793/148 candidate
 * lists:
 *
 *              dino    clip     artist is
 *     Banksy   0.991   0.980    correct
 *     Frink    0.974   0.974    correct
 *     Blake    0.886   0.863    correct   (clip depressed by a large colour-balance shift)
 *     Villon   0.876   0.946    correct
 *     Picasso  0.851   0.937    correct
 *     Whistler 0.801   0.940    WRONG     (a rival row on the Hockney lot)
 *
 * DINOv2 separates widely — 0.851 correct against 0.801 wrong. CLIP is compressed and high:
 * a wrong artist still scores 0.940, so its floor has to sit up at 0.95 to mean anything, and
 * even then it is the weaker witness. Hence the asymmetry in the confidences below.
 *
 * UNFITTED, and thin — a handful of lots. The floors sit in observed gaps, not on a curve.
 */
export const DINO_ARTIST_FLOOR = 0.84;
export const CLIP_ARTIST_FLOOR = 0.95;

/** Both measures agree the artist is present — the strongest embedding evidence available. */
const D_BOTH_CONFIDENCE = 0.9;
/** DINOv2 alone. Solid: it is the instance-level discriminator and separates cleanly. */
const D_DINO_ONLY_CONFIDENCE = 0.8;
/** CLIP alone. Weak: it scores wrong artists at 0.94, so on its own it says little. */
const D_CLIP_ONLY_CONFIDENCE = 0.7;
/** Last resort, when Stage 1d supplied a band but no numbers at all. */
const D_BAND_CONFIDENCE: Record<string, number> = { HIGH: 0.9, MEDIUM: 0.75, LOW: 0.55 };

/** Which of the two measures, independently, say this artist is present. */
export function embeddingSignals(src: NamingSource): { dinoOk: boolean; clipOk: boolean; scored: boolean } {
  if (src.kind !== "names") return { dinoOk: false, clipOk: false, scored: false };
  const d = src.dinoSimilarity;
  const c = src.clipSimilarity;
  return {
    dinoOk: d != null && d >= DINO_ARTIST_FLOOR,
    clipOk: c != null && c >= CLIP_ARTIST_FLOOR,
    scored: d != null || c != null,
  };
}

/**
 * Measured similarity below which Stage 1d does not vote at all.
 *
 * Stage 1d always returns a top candidate, so without a floor D would name somebody on every
 * lot no matter how poor the match. 0.7 sits below every correct match observed on the A0793
 * lots (0.886, 0.894, 0.911, 0.974, 0.985) and above the band fallback for a LOW result
 * (0.55) — so a genuinely weak match is silence again, while the MEDIUM-band matches the old
 * HIGH-only gate was discarding still vote.
 */
export const D_VOTE_FLOOR = 0.7;

/**
 * Stage 1d's floor for the WORK vote — DINOv2 ONLY, deliberately not the dino/clip mean the
 * artist vote uses.
 *
 * Recognising whose hand made something and recognising WHICH print it is are different
 * problems, and CLIP is the wrong instrument for the second. On the A0793 lots CLIP scored
 * 0.937 and 0.946 against Picasso and Villon prints that were the WRONG WORKS by the right
 * artists — it recognises style and medium, not the specific image. DINOv2 is the
 * instance-level discriminator (ADR-0013's whole reason for using it), and on the same lots
 * it orders correctly where the dino/clip mean does not:
 *
 *              dino    clip    mean     match is
 *     Banksy   0.991   0.980   0.985    same work
 *     Frink    0.974   0.974   0.974    same work
 *     Blake    0.886   null    0.886    SAME WORK  (Tate P04038 — visually confirmed)
 *     Villon   0.876   0.946   0.911    different work
 *     Picasso  0.851   0.937   0.894    different work
 *
 * On dino every same-work match sits above every different-work match. On the mean Blake
 * falls BELOW both wrong matches, because his clip score was null and the wrong matches got
 * lifted by high clip scores. Blake's 0.886 is a correct same-work match degraded by nothing
 * more than colour balance and photography — the two images are plainly the same print.
 *
 * Below this floor Stage 1d still names the ARTIST (that vote keeps the mean and its own
 * lower floor); only the work stays unresolved, which is the honest answer rather than a
 * confident wrong title propagating into Stage 2b's research and Stage 3's comparables.
 *
 * UNFITTED, and thin: five lots, with only 0.010 between the lowest same-work match (0.886)
 * and the highest different-work one (0.876). The number is placed in that gap; do not read
 * it as calibrated.
 */
export const D_T_DINO_FLOOR = 0.88;

/**
 * The floor actually applied, given the artist's own background distribution when the graph
 * holds one (Artist.dinoBackgroundP99, written by knowledge_graph/artist_dino_background.py).
 *
 * D_T_DINO_FLOOR above is global, and its own comment admits it is unfitted: five lots, 0.010
 * between the lowest same-work match and the highest different-work one. Measured over 37,905
 * image pairs from 400 artists (knowledge_graph/analyse_dino_threshold.py), it turns out to be
 * a reasonable CENTRE — the median artist's 1%-false-positive point is 0.875 — and a poor
 * CONSTANT, because that point ranges from 0.533 to 1.000 across the 977 artists who have
 * enough embedded output to measure. 473 need a higher floor, 504 a lower one.
 *
 *   Damien Hirst   0.919    0.88 admits DIFFERENT works of his as the same print
 *   Elisabeth Frink 0.857
 *   Peter Blake    0.735    0.88 REFUSES matches that are genuinely the same print,
 *   Banksy         0.710    discarding evidence the graph actually holds
 *
 * On duplicate-filtered labels, normalising to the artist's own distribution lifts average
 * precision from 0.895 to 0.953, and a logistic fit weights the normalised score over the raw
 * one by roughly 3:1 (+8.06 against +2.59).
 *
 * Falls back to the global floor whenever the graph has no background for this artist — 977
 * of 8,033 artists have one, so the fallback is the common path and must stay silent and safe.
 */
export function dinoFloorFor(artistFloor?: number | null): { floor: number; basis: "artist" | "global" } {
  return artistFloor != null && Number.isFinite(artistFloor) && artistFloor > 0
    ? { floor: artistFloor, basis: "artist" }
    : { floor: D_T_DINO_FLOOR, basis: "global" };
}

/** The measured similarity behind a Stage 1d source, or its band fallback. */
export function embeddingSourceConfidence(
  measured: number | undefined,
  band: "HIGH" | "MEDIUM" | "LOW" | undefined,
): number {
  if (measured != null) return measured;
  return D_BAND_CONFIDENCE[band ?? "LOW"] ?? D_BAND_CONFIDENCE.LOW;
}
const V_ILLEGIBLE_CAP = 0.5; // a reconstructed mark cannot be a confident read

export function sourceConfidence(v: Vote, ev: ArtistEvidence): number {
  switch (v.source) {
    case "V": {
      const c = ev.veaSignatureConfidence ?? 0.5;
      return ev.veaAuthorshipSignalLegible ? c : Math.min(c, V_ILLEGIBLE_CAP);
    }
    case "R":
      return ev.reverseImageSearch.kind === "names" ? ev.reverseImageSearch.sim ?? 0 : 0;
    case "A":
      return A_DOCUMENTED_CONFIDENCE;
    case "D": {
      if (ev.embeddingMatch.kind !== "names") return 0;
      const { dinoOk, clipOk, scored } = embeddingSignals(ev.embeddingMatch);
      if (!scored) return D_BAND_CONFIDENCE[ev.embeddingMatch.matchConfidence ?? "LOW"] ?? D_BAND_CONFIDENCE.LOW;
      if (dinoOk && clipOk) return D_BOTH_CONFIDENCE;
      if (dinoOk) return D_DINO_ONLY_CONFIDENCE;
      if (clipOk) return D_CLIP_ONLY_CONFIDENCE;
      return 0;
    }
    default:
      return 0;
  }
}

/**
 * Scoped style comparison against ONE candidate's catalogued output, with near-identical
 * matches removed (knowledge_graph/query.ts `queryArtistStyleConsistency`).
 *
 * EXCLUSION ONLY. Measured on A0793/148 excluding identity matches, the correct artist came
 * THIRD (Hockney 0.782, Moore 0.792, Picasso 0.799) — between plausible candidates it cannot
 * discriminate, because it is measuring tradition and medium family, not authorship. What it
 * does separate is the stylistically alien candidate (Banksy 0.666, Hirst 0.623). So it may
 * withhold corroboration and raise a flag; it may never lift a band or pick between
 * candidates.
 */
export interface StyleConsistencyEvidence {
  artistName: string;
  comparedWorks: number;
  meanTopSimilarity: number;
  /** Catalogue descriptions of the nearest works, where the ingest kept them. Narrative
   *  supporting evidence for the report — never scored. */
  supportingText: string[];
}

/**
 * Mean top-N similarity below which a candidate's output is "stylistically alien" to the
 * object. UNFITTED — read off a single lot, where plausible candidates clustered at
 * 0.78-0.80 and alien ones at 0.62-0.67. Needs the fixture pool before it is trusted.
 */
export const STYLE_ALIEN_BELOW = 0.72;
/** Fewer embedded works than this and the comparison is too thin to act on either way. */
export const STYLE_MIN_COMPARED = 20;

export type CorroborationLevel = "strong" | "moderate" | "weak" | "none";

/**
 * How far each corroboration level moves the band the agreement count established.
 * Chosen to preserve the pre-2026-09-09 spread at n=2 — corroborated HIGH, thin
 * MEDIUM_HIGH, uncorroborated MEDIUM — now driven by the cascade rather than by raw
 * kOeuvre/kId counts. Unfitted, like every threshold here (ADR-0010 Decision 4).
 */
export const CORROBORATION_BAND_DELTA: Record<CorroborationLevel, number> = {
  strong: 1,
  moderate: 1,
  weak: 0,
  none: -1,
};

export interface Corroboration {
  level: CorroborationLevel;
  basis: string;
  notes: string[];
}

/**
 * What the ACKG says about a candidate a real source already named (2026-09-09).
 *
 * A cascade, cheapest and most discriminating first:
 *
 *   1. SAME TITLE. If the graph catalogues a title-matched work to this artist, that is the
 *      strongest corroboration available and the rest adds nothing — take it and stop.
 *   2. Otherwise fall back to what the graph knows about the artist's OUTPUT: are they
 *      catalogued working in this technique/period (kOeuvre), and is this subject typical of
 *      them (kSubject)? Both -> moderate, one -> weak, neither -> none.
 *
 * Absence is never evidence against (the graph's coverage is partial by construction), so
 * "none" only ever withholds a lift — it never lowers a band.
 */
export function corroborateArtist(
  ev: ArtistEvidence,
  artistName: string | null,
  trace: string[],
): Corroboration {
  const notes: string[] = [];
  if (!artistName) return { level: "none", basis: "noCandidate", notes };

  // 1 — same title, and catalogued to THIS artist.
  const anchor = ev.ackgWorkAnchor;
  if (anchor?.artist && anchor.titleSim >= TAU_TITLE) {
    if (nameSimilarity(anchor.artist, artistName) >= TAU_NAME) {
      trace.push(
        `corroboration STRONG: ACKG catalogues a title-matched work (titleSim=${anchor.titleSim.toFixed(2)}) to "${anchor.artist}"`,
      );
      return applyStyleExclusion({ level: "strong", basis: "ackgTitleMatch", notes: [`titleSim=${anchor.titleSim.toFixed(2)}`] }, ev, artistName, trace);
    }
    // A title match pointing at someone else is a real disagreement, not a null result.
    notes.push(`ackgTitleMatchNamesDifferentArtist:${anchor.artist}`);
    trace.push(
      `corroboration: ACKG's title match names "${anchor.artist}", not "${artistName}" — not corroboration; falling through to oeuvre checks`,
    );
  }

  // 2 — fall back to the artist's catalogued output.
  const techniqueOk = (ev.kOeuvreMatchCount ?? 0) >= KOEUVRE_DISCRIMINATING_MIN;
  const subjectOk = ev.kSubject === "TYPICAL";
  if (techniqueOk) notes.push(`kOeuvre=${ev.kOeuvreMatchCount}`);
  if (subjectOk) notes.push("subjectTypical");

  if (techniqueOk && subjectOk) {
    trace.push(`corroboration MODERATE: catalogued in this technique/period (${ev.kOeuvreMatchCount}) and subject is typical`);
    return applyStyleExclusion({ level: "moderate", basis: "ackgOeuvreAndSubject", notes }, ev, artistName, trace);
  }
  if (techniqueOk || subjectOk) {
    trace.push(`corroboration WEAK: only ${techniqueOk ? "technique/period" : "subject"} corroborates`);
    return applyStyleExclusion({ level: "weak", basis: techniqueOk ? "ackgOeuvre" : "ackgSubject", notes }, ev, artistName, trace);
  }
  trace.push(`corroboration NONE: ACKG adds nothing for "${artistName}" (absence is not evidence against)`);
  return applyStyleExclusion({ level: "none", basis: "ackgSilent", notes }, ev, artistName, trace);
}

/**
 * One-directional style check. Can only take corroboration AWAY.
 *
 * A confirmed title match ("strong") is documentary evidence that this artist made a work of
 * this name; stylistic distance from the rest of their output does not outweigh that, so
 * strong is never vetoed — the flag is still recorded for the report.
 */
function applyStyleExclusion(
  c: Corroboration,
  ev: ArtistEvidence,
  artistName: string,
  trace: string[],
): Corroboration {
  const sc = ev.styleConsistency;
  if (!sc || nameSimilarity(sc.artistName, artistName) < TAU_NAME) return c;
  if (sc.comparedWorks < STYLE_MIN_COMPARED) {
    trace.push(`style check skipped: only ${sc.comparedWorks} embedded work(s) for "${artistName}" (need ${STYLE_MIN_COMPARED})`);
    return c;
  }
  if (sc.meanTopSimilarity >= STYLE_ALIEN_BELOW) {
    return { ...c, notes: [...c.notes, `styleConsistent:${sc.meanTopSimilarity.toFixed(3)}`] };
  }
  const notes = [...c.notes, `styleInconsistentWithCandidate:${sc.meanTopSimilarity.toFixed(3)}`];
  if (c.level === "strong") {
    trace.push(
      `style: "${artistName}" output is distant (mean-top ${sc.meanTopSimilarity.toFixed(3)} < ${STYLE_ALIEN_BELOW}) — flagged, but a catalogued title match is not overridden`,
    );
    return { ...c, notes };
  }
  trace.push(
    `style EXCLUSION: nothing in "${artistName}"'s ${sc.comparedWorks} catalogued works resembles this object (mean-top ${sc.meanTopSimilarity.toFixed(3)} < ${STYLE_ALIEN_BELOW}) — corroboration withheld`,
  );
  return { level: "none", basis: "styleInconsistent", notes };
}

function sameIdentity(a: Vote, b: Vote): boolean {
  if (a.identityKey && b.identityKey) return a.identityKey === b.identityKey;
  return nameSimilarity(a.raw, b.raw) >= TAU_NAME;
}

interface Agreement {
  dominantRaw: string | null;
  dominantVotes: Vote[];
  n: number;
  distinctIdentities: number;
  losers: string[];
}

function agree(votes: Vote[]): Agreement {
  if (votes.length === 0) return { dominantRaw: null, dominantVotes: [], n: 0, distinctIdentities: 0, losers: [] };
  // cluster votes by identity
  const clusters: Vote[][] = [];
  for (const v of votes) {
    const c = clusters.find((cl) => sameIdentity(cl[0], v));
    if (c) c.push(v);
    else clusters.push([v]);
  }
  clusters.sort((a, b) => b.length - a.length);
  const top = clusters[0];
  const tie = clusters.length > 1 && clusters[1].length === top.length;
  return {
    dominantRaw: tie ? null : top[0].raw,
    dominantVotes: tie ? [] : top,
    n: tie ? 0 : top.length,
    distinctIdentities: clusters.length,
    losers: clusters.slice(tie ? 0 : 1).flatMap((c) => c.map((v) => v.raw)),
  };
}

function subjectFields(ev: ArtistEvidence): Pick<ArtistVerdict, "subjectCorroboration" | "subjectNote" | "flags"> {
  const map: Record<ArtistEvidence["kSubject"], ArtistVerdict["subjectCorroboration"]> = {
    TYPICAL: "typical",
    OCCASIONAL: "occasional",
    ATYPICAL: "atypical",
    UNASSESSABLE: "unassessable",
  };
  const flags = ev.kSubject === "ATYPICAL" ? ["subjectAtypicalForArtist"] : [];
  return { subjectCorroboration: map[ev.kSubject], subjectNote: ev.kSubjectNote ?? "", flags };
}

/**
 * ADR-0010 Decision 3 — the A1..A11 table. Pure function; evaluate top to bottom.
 */
export function classifyArtistPass(ev: ArtistEvidence): ArtistVerdict {
  const trace: string[] = [];
  const { votes, appraiserHypothesis } = eligibleVotes(ev, trace);
  const ag = agree(votes);
  const { subjectCorroboration, subjectNote, flags: subjectFlags } = subjectFields(ev);

  const base = (
    verdict: ArtistVerdict["verdict"],
    artistName: string | null,
    confidence: Confidence | null,
    evidenceBasis: string,
    extraFlags: string[] = [],
  ): ArtistVerdict => {
    trace.push(
      `-> ${evidenceBasis} verdict=${verdict} artist=${artistName ?? "(none)"} confidence=${confidence ?? "-"}` +
        (extraFlags.length ? ` flags=[${extraFlags.join(", ")}]` : ""),
    );
    return {
      verdict,
      artistName,
      confidence,
      evidenceBasis,
      agreementSet: ag.dominantVotes.map((v) => v.source),
      kId: ev.kId,
      kOeuvreMatchCount: ev.kOeuvreMatchCount,
      subjectCorroboration,
      subjectNote,
      flags: [...subjectFlags, ...extraFlags],
      contradictingIdentities: ag.losers,
      ruleTrace: trace,
    };
  };

  trace.push(
    `votes=[${votes.map((v) => `${v.source}:${v.raw}`).join(", ")}] n=${ag.n} distinctIdentities=${ag.distinctIdentities}`,
  );

  // Override: documented_fact appraiser claim contradicting a legible VEA signature is always A10.
  if (
    ev.appraiser.kind === "names" &&
    ev.appraiser.trust === "documented_fact" &&
    ev.vea.kind === "names" &&
    ev.veaAuthorshipSignalLegible &&
    nameSimilarity(ev.appraiser.raw, ev.vea.raw) < TAU_NAME
  ) {
    trace.push(`OVERRIDE: documented_fact appraiser claim "${ev.appraiser.raw}" contradicts legible VEA signature "${ev.vea.raw}"`);
    return base("conflict", null, null, "A10", ["attributionConflict"]);
  }

  // A10 — competing identities, none dominant
  if (ag.distinctIdentities >= 2 && ag.dominantRaw === null) {
    return base("conflict", null, null, "A10", ["attributionConflict"]);
  }

  // ── Scoring (2026-09-09): agreement sets the base band, the agreeing sources' own
  // confidence modulates it, then ACKG corroboration lifts it. K no longer votes.
  const agreeingConfidences = ag.dominantVotes.map((v) => ({ source: v.source, conf: sourceConfidence(v, ev) }));
  const meanConf = agreeingConfidences.length
    ? agreeingConfidences.reduce((t, c) => t + c.conf, 0) / agreeingConfidences.length
    : 0;
  const weakSources = agreeingConfidences.length > 0 && meanConf < CONFIDENCE_MEAN_FLOOR;
  if (agreeingConfidences.length) {
    trace.push(
      `sourceConfidence=[${agreeingConfidences.map((c) => `${c.source}:${c.conf.toFixed(2)}`).join(", ")}] ` +
        `mean=${meanConf.toFixed(2)}${weakSources ? ` < ${CONFIDENCE_MEAN_FLOOR} — agreeing sources only just cleared their gates` : ""}`,
    );
  }

  /** base band -> weak-source demotion -> corroboration lift, capped at HIGH. */
  const scored = (verdict: ArtistVerdict["verdict"], baseBand: Confidence, basis: string, flags: string[] = []) => {
    let band = baseBand;
    if (weakSources) {
      band = liftBand(band, -1);
      trace.push(`mean source confidence ${meanConf.toFixed(2)} < ${CONFIDENCE_MEAN_FLOOR} — base band ${baseBand} demoted to ${band}`);
    }
    const corr = corroborateArtist(ev, ag.dominantRaw, trace);
    // A claim the reference corroborates is firmer than one it is silent on. "none" holding
    // a band lower is NOT treating absence as evidence against the artist — the verdict and
    // the named candidate are untouched; only the certainty attached to them moves.
    // Corroboration can only LOWER a band at n === 2, which is the one place the graph is
    // genuinely the tie-breaker: two sources agreeing with the reference behind them is a
    // different claim from two sources agreeing about an artist it has never heard of —
    // the distinction A2/A3/A4 has always drawn.
    //   n >= 3: agreement is its own justification (the pre-2026-09-09 A1 rule, "K_oeuvre = 0
    //           — noted, not downgraded"). Three witnesses are not made doubtful by a graph
    //           that does not hold them.
    //   n === 1: the band already encodes that source's own confidence, and single-source
    //           lots are exactly where coverage gaps bite — demoting again double-penalises.
    const rawDelta = CORROBORATION_BAND_DELTA[corr.level];
    const delta = rawDelta < 0 && ag.n !== 2 ? 0 : rawDelta;
    if (delta !== rawDelta) {
      trace.push(`corroboration ${corr.level} withheld from lowering the band at n=${ag.n} (absence is not evidence against)`);
    }
    if (delta !== 0) {
      const moved = liftBand(band, delta);
      if (moved !== band) {
        trace.push(`corroboration ${corr.level} (${corr.basis}) moves ${band} -> ${moved}`);
      }
      band = moved;
    }
    return base(verdict, ag.dominantRaw, band, basis, [...flags, `corroboration:${corr.level}:${corr.basis}`, ...corr.notes]);
  };

  // A1 — n >= 3 (any three-plus of V/R/A/D agree)
  if (ag.n >= 3) return scored("attributed", "HIGH", "A1");

  // A2 / A3 / A4 — n = 2, separated by how well the ACKG corroborates. The codes are kept
  // (routing, scenarios and the report renderer read them) but their meaning is now the
  // corroboration cascade rather than raw kOeuvre/kId counts.
  if (ag.n === 2) {
    const corr = corroborateArtist(ev, ag.dominantRaw, []); // peek to pick the code; scored() re-derives and traces
    // A2/A3/A4 keep their pre-existing bands (HIGH / MEDIUM_HIGH / MEDIUM); what selects
    // between them is now the corroboration cascade.
    const code = corr.level === "strong" || corr.level === "moderate" ? "A2" : corr.level === "weak" ? "A3" : "A4";
    return scored("attributed", "MEDIUM_HIGH", code);
  }

  // A5..A9 — n = 1 (or appraiser-hypothesis-only). The base band is set by WHICH source is
  // speaking and how sure it is; the corroboration cascade then moves it, exactly as at n=2.
  // (A8K is gone — K no longer votes, so an ACKG title match alone names nobody.)
  if (ag.n === 1) {
    const only = ag.dominantVotes[0];
    let code: string;
    let band: Confidence;
    let flags: string[];
    if (only.source === "V") {
      const low = (ev.veaSignatureConfidence ?? 1) < 0.6;
      code = "A5";
      band = low ? "LOW" : "MEDIUM";
      flags = ["singleSourceVEA"];
    } else if (only.source === "R") {
      const sim = ev.reverseImageSearch.kind === "names" ? ev.reverseImageSearch.sim ?? 0 : 0;
      code = sim >= SIM_ARTIST_STRONG ? "A6" : "A7";
      band = sim >= SIM_ARTIST_STRONG ? "MEDIUM" : "LOW";
      flags = [sim >= SIM_ARTIST_STRONG ? "singleSourceImageMatch" : "weakImageMatchOnly"];
    } else if (only.source === "D") {
      code = "A6D";
      band = "MEDIUM";
      flags = ["singleSourceEmbeddingMatch"];
    } else {
      code = "A8";
      band = "MEDIUM";
      flags = ["appraiserDocumentedOnly"];
    }
    return applyHypothesisLift(scored("candidate", band, code, flags), ev, appraiserHypothesis, trace);
  }

  // A9 — the only signal is an appraiser hypothesis
  if (appraiserHypothesis && appraiserHypothesis.kind === "names") {
    return base("not_attributed", null, "LOW", "A9", ["appraiserHypothesisUncorroborated"]);
  }

  // A11 — nothing
  return base("not_attributed", null, null, "A11", []);
}

/**
 * The appraiser's HYPOTHESIS (not a documented fact, so not a vote) still counts for
 * something when it names the candidate the real sources landed on. One band, and only on an
 * already-established verdict — never lifts not_attributed or conflict.
 *
 * ACKG corroboration used to be applied here too; as of 2026-09-09 it is part of the main
 * scoring path (corroborateArtist + CORROBORATION_BAND_DELTA) so that every branch — n=1 and
 * n>=2 alike — is corroborated the same way rather than only the single-source ones.
 */
function applyHypothesisLift(
  v: ArtistVerdict,
  ev: ArtistEvidence,
  appraiserHypothesis: NamingSource | null,
  trace: string[],
): ArtistVerdict {
  if (v.verdict === "not_attributed" || v.verdict === "conflict" || v.confidence === null) return v;
  if (
    appraiserHypothesis &&
    appraiserHypothesis.kind === "names" &&
    v.artistName &&
    nameSimilarity(appraiserHypothesis.raw, v.artistName) >= TAU_NAME
  ) {
    const lifted = liftBand(v.confidence);
    if (lifted !== v.confidence) {
      trace.push(`corroborating appraiser hypothesis lifts ${v.confidence} -> ${lifted}`);
      return { ...v, confidence: lifted, flags: [...v.flags, "appraiserHypothesisCorroborates"] };
    }
  }
  return v;
}

// ───────────────────────────────────────────────────────────────────────────────
// PASS-2 GATE — ADR-0010 Decision 3 gate + Decision 6 in-image-title exception
// ───────────────────────────────────────────────────────────────────────────────
const MEDIUM_OR_BETTER: Confidence[] = ["MEDIUM", "MEDIUM_HIGH", "HIGH"];

export function passTwoGate(
  artist: ArtistVerdict,
  veaInImageTitleLegible: boolean,
): { runPass2: boolean; mode: "gated" | "in_image_title" | null; reason: string } {
  const gated =
    artist.verdict === "attributed" ||
    (artist.verdict === "candidate" && artist.confidence != null && MEDIUM_OR_BETTER.includes(artist.confidence));
  if (gated) return { runPass2: true, mode: "gated", reason: `artist verdict ${artist.verdict}/${artist.confidence ?? "-"}` };
  if (veaInImageTitleLegible)
    return { runPass2: true, mode: "in_image_title", reason: "legible in-image title (Decision 6 exception)" };
  return { runPass2: false, mode: null, reason: `artist verdict ${artist.verdict}/${artist.confidence ?? "-"}, no in-image title` };
}

// ───────────────────────────────────────────────────────────────────────────────
// PASS 2 — CONCEPTUAL WORK — ADR-0010 Decision 5 (T1..T7), + D_t (2026-09-08)
// ───────────────────────────────────────────────────────────────────────────────
export type TitleSourceTag = "V_t" | "R_t" | "A_t" | "D_t";
export type TitleSource = { kind: "names"; raw: string } | { kind: "silent" };

export interface KWorkResult {
  /** Rescaled 0..1 title similarity between the observed title and the best-matching
   *  catalogued ConceptualWork (embed_text.titleSimFromCosine over gemini-embedding-001). */
  titleSim: number;
  /** The catalogued title the observed title matched. */
  matchedWorkTitle?: string | null;
  /** Decision 6 back-prop: when the matched work is catalogued to exactly one artist. */
  backPropArtist?: string | null;
}

export interface WorkEvidence {
  titleVea: TitleSource; // V_t
  titleReverseImageSearch: TitleSource & { sim?: number }; // R_t — needs sim >= SIM_WORK_VOTE
  titleAppraiser: TitleSource; // A_t
  /** D_t — the catalogued title of Stage 1d's best DINOv2/CLIP match. Same HIGH-only gate
   *  as the artist pass's D vote: an uncalibrated embedding score below HIGH is a "don't
   *  know", not a weak yes (ADR-0013 "Not addressed"). Stage 1d already carried this title
   *  in `bestMatchConceptualWorkTitle`; before the 2026-09-08 amendment only its ARTIST was
   *  read, so on A0793 lot 148 the top three 1d candidates all named the correct Hockney
   *  work and the work pass still resolved to a different one off K_work alone. */
  titleEmbeddingMatch: TitleSource & {
    matchConfidence?: "HIGH" | "MEDIUM" | "LOW";
    /** The dino/clip mean, kept for reporting. NOT what gates the work vote. */
    embeddingConfidence?: number;
    /** DINOv2 similarity alone — the instance-level signal the work vote is gated on. */
    dinoSimilarity?: number;
  }; // D_t
  kWork: KWorkResult | null; // null = not queried / no hit
  /** This artist's own DINOv2 work-identity floor (Artist.dinoBackgroundP99), carried onto the
   *  work evidence because that is where the D_t gate reads it. Absent for most artists, in
   *  which case the global D_T_DINO_FLOOR applies — see dinoFloorFor. */
  artistDinoFloor?: number | null;
}

export interface WorkVerdict {
  verdict: "identified" | "candidate" | "unresolved" | "conflict";
  conceptualWorkTitle: string | null;
  confidence: Confidence | null;
  evidenceBasis: string; // "T1".."T7"
  agreementSet: TitleSourceTag[];
  backPropArtist: string | null;
  ruleTrace: string[];
}

interface TitleVote {
  source: TitleSourceTag;
  raw: string;
}

function eligibleTitleVotes(ev: WorkEvidence, trace: string[]): TitleVote[] {
  const votes: TitleVote[] = [];
  if (ev.titleVea.kind === "names") votes.push({ source: "V_t", raw: ev.titleVea.raw });
  if (ev.titleReverseImageSearch.kind === "names") {
    const sim = ev.titleReverseImageSearch.sim ?? 0;
    if (sim >= SIM_WORK_VOTE) votes.push({ source: "R_t", raw: ev.titleReverseImageSearch.raw });
    else trace.push(`R_t dropped: sim=${sim.toFixed(2)} < ${SIM_WORK_VOTE}`);
  }
  if (ev.titleAppraiser.kind === "names") votes.push({ source: "A_t", raw: ev.titleAppraiser.raw });
  // D_t votes at any confidence for the same reason D does (see eligibleVotes). Pass 2 has
  // no band-modulation step of its own, so a lone low-confidence D_t is capped in the T5
  // branch rather than being allowed to read like a confident identification.
  if (ev.titleEmbeddingMatch.kind === "names") {
    const dino = ev.titleEmbeddingMatch.dinoSimilarity;
    if (dino == null) {
      trace.push(`D_t dropped from vote: no DINOv2 score — work identity is not scored on CLIP`);
    } else {
      // The floor is the artist's own when the graph holds their background, else global.
      // Which one was used is traced: a lot refused at 0.919 and a lot refused at 0.880 are
      // different claims, and the reader must be able to tell them apart.
      const { floor, basis } = dinoFloorFor(ev.artistDinoFloor);
      const label = basis === "artist" ? `${floor.toFixed(3)} (this artist's p99)` : `${floor.toFixed(3)} (global)`;
      if (dino >= floor) {
        votes.push({ source: "D_t", raw: ev.titleEmbeddingMatch.raw });
        trace.push(`D_t votes: dino ${dino.toFixed(3)} >= ${label}`);
      } else {
        trace.push(
          `D_t dropped from vote: dino ${dino.toFixed(3)} < ${label} — close enough to place the ` +
            `artist, not close enough to say WHICH print`,
        );
      }
    }
  }
  return votes;
}

function agreeTitles(votes: TitleVote[]): { dominantRaw: string | null; n: number; distinct: number; set: TitleSourceTag[] } {
  if (votes.length === 0) return { dominantRaw: null, n: 0, distinct: 0, set: [] };
  const clusters: TitleVote[][] = [];
  for (const v of votes) {
    const c = clusters.find((cl) => titleSimilarity(cl[0].raw, v.raw) >= TAU_TITLE_AGREE);
    if (c) c.push(v);
    else clusters.push([v]);
  }
  clusters.sort((a, b) => b.length - a.length);
  const top = clusters[0];
  const tie = clusters.length > 1 && clusters[1].length === top.length;
  return {
    dominantRaw: tie ? null : top[0].raw,
    n: tie ? 0 : top.length,
    distinct: clusters.length,
    set: tie ? [] : top.map((v) => v.source),
  };
}

/**
 * Does the K_work hit corroborate the title the SOURCES actually agreed on?
 *
 * `k.titleSim` scores the OBSERVED title (what VEA/the appraiser described) against the
 * nearest catalogued title. It says nothing about whether that catalogued work is the
 * work the voters named. Before the 2026-09-08 amendment T2/T5 read the score alone, so
 * a strong match to a DIFFERENT work lifted the confidence band anyway: on A0793 lot 148
 * VEA's "reclining figure beneath valance" matched a Hockney work literally titled
 * "Reclining Figure" at titleSim 1.00, and that perfect score would have "corroborated"
 * a verdict of "Cold Water about to Hit the Prince".
 *
 * Agreement is tested with `titleContainment` against TAU_TITLE_AGREE, not the Jaccard
 * used to cluster two title SOURCES: a catalogued title legitimately carries a series or
 * plate qualifier the sources omit, and that extra information should not read as
 * disagreement. See titleContainment for the guard against generic one-word titles.
 *
 * A hit with no `matchedWorkTitle` recorded does NOT corroborate. That is deliberately
 * stricter than the old behaviour: a confidence band should rest on evidence someone can
 * point at, and an unverifiable corroborator is not that. It is traced, not silent.
 */
function kWorkCorroborates(k: KWorkResult | null, dominantRaw: string | null, trace: string[]): boolean {
  if (!k || k.titleSim < TAU_TITLE || !dominantRaw) return false;
  if (!k.matchedWorkTitle) {
    trace.push(`K_work titleSim=${k.titleSim.toFixed(2)} not counted as corroboration: no matchedWorkTitle recorded`);
    return false;
  }
  const agreement = titleContainment(k.matchedWorkTitle, dominantRaw);
  if (agreement >= TAU_TITLE_AGREE) return true;
  trace.push(
    `K_work titleSim=${k.titleSim.toFixed(2)} not counted as corroboration: it matched "${k.matchedWorkTitle}", ` +
      `but the sources agreed on "${dominantRaw}" (agreement=${agreement.toFixed(2)} < ${TAU_TITLE_AGREE})`,
  );
  return false;
}

/**
 * Per-source confidence for a TITLE vote, mirroring `sourceConfidence` in Pass 1.
 * V_t and A_t are ordinal placeholders; R_t and D_t report real numbers.
 */
const V_T_LEGIBLE_CONFIDENCE = 0.9; // a clean in-image title/series cartouche
const V_T_INFERRED_CONFIDENCE = 0.8; // a title VEA read but did not flag as cleanly legible
const A_T_CONFIDENCE = 0.85; // the appraiser's stated title (Stage 1c owns this cell)

export function titleSourceConfidence(
  source: TitleSourceTag,
  ev: WorkEvidence,
  veaInImageTitleLegible = false,
): number {
  switch (source) {
    case "V_t":
      return veaInImageTitleLegible ? V_T_LEGIBLE_CONFIDENCE : V_T_INFERRED_CONFIDENCE;
    case "R_t":
      return ev.titleReverseImageSearch.kind === "names" ? ev.titleReverseImageSearch.sim ?? 0 : 0;
    case "A_t":
      return A_T_CONFIDENCE;
    case "D_t":
      // dino alone, matching the gate — CLIP does not speak to work identity.
      return ev.titleEmbeddingMatch.kind === "names" ? ev.titleEmbeddingMatch.dinoSimilarity ?? 0 : 0;
    default:
      return 0;
  }
}

/**
 * Does the ACKG's record of the candidate work match the object in front of us?
 *
 * The Pass 1 cascade asks "is this artist consistent with what we see"; this asks the same of
 * a *work*, using the physical facts the graph holds about it. Both comparisons already
 * existed — `classifyTechniqueMatch` and `classifyDimensionMatch` were built for the
 * impression layer (Decision 5b) and are reused verbatim here, one layer earlier.
 *
 *   1. CONTRADICTION FIRST. A catalogued technique or dimension that actively disagrees is
 *      evidence the candidate title is WRONG, not merely uncorroborated — unlike Pass 1,
 *      where the graph can only ever withhold support. A work catalogued as a 345x210mm
 *      etching is not a 600x450mm screenprint, whatever the title matcher scored.
 *   2. Otherwise technique and dimensions agreeing -> strong; one agreeing, the other
 *      unassessable -> moderate; neither assessable -> fall through to
 *   3. the embedding title similarity (`kWork`), the weakest of the three because it
 *      compares words rather than the object.
 *
 * "Subject" is deliberately absent. At work level the only subject signal available is image
 * similarity to that specific work — which IS D_t. Using it here would corroborate a vote
 * with its own evidence, the circularity this design removed from K in Pass 1.
 */
export function corroborateWork(
  ev: WorkEvidence,
  impression: ImpressionEvidence | null,
  dominantTitle: string | null,
  trace: string[],
): Corroboration {
  const notes: string[] = [];
  if (!dominantTitle) return { level: "none", basis: "noCandidate", notes };

  let tech: TechniqueComparison["match"] = "unassessable";
  let dim: DimensionComparison["match"] = "UNASSESSABLE";
  if (impression) {
    tech = classifyTechniqueMatch({
      observedTechniques: impression.observedTechniques,
      observedIsPhotomechanical: impression.observedIsPhotomechanical,
      catalogueTechniques: impression.catalogueTechniques,
      catalogueMediumRaw: impression.catalogueMediumRaw,
    }).match;
    dim = classifyDimensionMatch(impression.dimensions).match;
    notes.push(`technique:${tech}`, `dimensions:${dim}`);
  }

  // 1 — an active contradiction says the candidate work is wrong.
  if (tech === "false" || dim === "false") {
    const which = [tech === "false" ? "technique" : null, dim === "false" ? "dimensions" : null]
      .filter(Boolean)
      .join(" and ");
    trace.push(`work corroboration CONTRADICTED: catalogued ${which} disagree with the object for "${dominantTitle}"`);
    return { level: "none", basis: `workContradictedBy_${which.replace(/ /g, "_")}`, notes: [...notes, "workPhysicallyContradicted"] };
  }

  // 2 — the physical record agrees.
  if (tech === "true" && dim === "true") {
    trace.push(`work corroboration STRONG: catalogued technique AND dimensions both match "${dominantTitle}"`);
    return { level: "strong", basis: "ackgWorkTechniqueAndDimensions", notes };
  }
  if (tech === "true" || dim === "true") {
    trace.push(`work corroboration MODERATE: catalogued ${tech === "true" ? "technique" : "dimensions"} matches, the other is unassessable`);
    return { level: "moderate", basis: tech === "true" ? "ackgWorkTechnique" : "ackgWorkDimensions", notes };
  }

  // 3 — nothing physical to go on; fall back to the title matcher.
  if (kWorkCorroborates(ev.kWork, dominantTitle, trace)) {
    return { level: "weak", basis: "ackgWorkTitleSim", notes: [...notes, `titleSim=${ev.kWork!.titleSim.toFixed(2)}`] };
  }
  trace.push(`work corroboration NONE: nothing in the ACKG supports "${dominantTitle}" (absence is not evidence against)`);
  return { level: "none", basis: "ackgWorkSilent", notes };
}

/** ADR-0010 Decision 5 — the T1..T7 table. */
export interface WorkPassOptions {
  /** The impression cells, read one layer earlier than Decision 5b uses them, so the
   *  catalogued technique/dimensions can corroborate the TITLE and not only the impression. */
  impression?: ImpressionEvidence | null;
  veaInImageTitleLegible?: boolean;
}

export function classifyWorkPass(ev: WorkEvidence, opts: WorkPassOptions = {}): WorkVerdict {
  const trace: string[] = [];
  const votes = eligibleTitleVotes(ev, trace);
  const ag = agreeTitles(votes);
  const k = ev.kWork;
  trace.push(`titleVotes=[${votes.map((v) => `${v.source}:${v.raw}`).join(", ")}] n=${ag.n} distinct=${ag.distinct}`);

  const mk = (
    verdict: WorkVerdict["verdict"],
    title: string | null,
    confidence: Confidence | null,
    basis: string,
  ): WorkVerdict => {
    trace.push(`-> ${basis} verdict=${verdict} work=${title ?? "(none)"} confidence=${confidence ?? "-"}`);
    return {
      verdict,
      conceptualWorkTitle: title,
      confidence,
      evidenceBasis: basis,
      agreementSet: ag.set,
      backPropArtist: k?.backPropArtist ?? null,
      ruleTrace: trace,
    };
  };

  // ── Scoring, mirroring Pass 1: agreement sets the base band, the agreeing sources' own
  // confidence modulates it, then ACKG corroboration (technique / dimensions / title
  // similarity) moves it. ──
  const agreeingConfidences = ag.set.map((src) => ({
    source: src,
    conf: titleSourceConfidence(src, ev, opts.veaInImageTitleLegible),
  }));
  const meanConf = agreeingConfidences.length
    ? agreeingConfidences.reduce((t, c) => t + c.conf, 0) / agreeingConfidences.length
    : 0;
  const weakSources = agreeingConfidences.length > 0 && meanConf < CONFIDENCE_MEAN_FLOOR;
  if (agreeingConfidences.length) {
    trace.push(
      `titleSourceConfidence=[${agreeingConfidences.map((c) => `${c.source}:${c.conf.toFixed(2)}`).join(", ")}] ` +
        `mean=${meanConf.toFixed(2)}${weakSources ? ` < ${CONFIDENCE_MEAN_FLOOR}` : ""}`,
    );
  }

  const scoredWork = (verdict: WorkVerdict["verdict"], baseBand: Confidence, basis: string) => {
    let band = baseBand;
    if (weakSources) {
      band = liftBand(band, -1);
      trace.push(`mean title-source confidence ${meanConf.toFixed(2)} < ${CONFIDENCE_MEAN_FLOOR} — ${baseBand} demoted to ${band}`);
    }
    const corr = corroborateWork(ev, opts.impression ?? null, ag.dominantRaw, trace);
    // Same asymmetry as Pass 1: silence only withholds, at n === 2 where the graph is the
    // tie-breaker. But a CONTRADICTION is different — physical disagreement is real evidence
    // the title is wrong, so it lowers the band at any n.
    const contradicted = corr.notes.includes("workPhysicallyContradicted");
    const rawDelta = CORROBORATION_BAND_DELTA[corr.level];
    // Unlike Pass 1, silence also lowers a SINGLE-source work verdict. Naming an artist from
    // one source is a reasonable candidate; naming which of their prints this is, from one
    // source, with nothing in the record supporting it, is not. (Pass 1 protects n === 1
    // because coverage gaps bite hardest there; here the same uncertainty is the point.)
    const delta = contradicted ? -1 : rawDelta < 0 && ag.n >= 3 ? 0 : rawDelta;
    if (delta !== 0) {
      const moved = liftBand(band, delta);
      if (moved !== band) trace.push(`work corroboration ${contradicted ? "contradiction" : corr.level} moves ${band} -> ${moved}`);
      band = moved;
    }
    const v = mk(verdict, ag.dominantRaw, band, basis);
    return { ...v, ruleTrace: trace };
  };

  // T1 — three or more sources agree (mirrors A1's `n >= 3`).
  if (ag.n >= 3) return scoredWork("identified", "HIGH", "T1");

  // T2 / T4 — two agree, separated by how well the ACKG's record of the work corroborates.
  if (ag.n === 2) {
    const peek = corroborateWork(ev, opts.impression ?? null, ag.dominantRaw, []);
    const code = peek.level === "strong" || peek.level === "moderate" ? "T2" : "T4";
    return scoredWork("identified", "MEDIUM_HIGH", code);
  }

  // T5 — single source.
  if (ag.n === 1) return scoredWork("candidate", "MEDIUM", "T5");

  // ── ag.n === 0: sources conflict or are all silent ────────────────────────────
  // T8K (Part B) — a strong ACKG embedding match to a specific catalogued work
  // identifies it even when the title SOURCES give no consensus. This is what rescues
  // the "same series, sources name different works" case (e.g. Hirst Empresses).
  if (k && k.titleSim >= TAU_TITLE_ANCHOR) {
    // T8K identifies a work on title similarity alone, with no source consensus behind it —
    // the weakest basis in the table, and the one that resolved A0793/148 to the wrong work.
    // It now answers to the same physical record as every other path: a contradiction blocks
    // it outright, and with nothing corroborating it degrades to a LOW candidate rather than
    // a MEDIUM identification.
    const corr = corroborateWork(ev, opts.impression ?? null, k.matchedWorkTitle ?? ag.dominantRaw, trace);
    if (corr.notes.includes("workPhysicallyContradicted")) {
      trace.push(`T8K withheld: the catalogued record of "${k.matchedWorkTitle}" contradicts the object`);
    } else {
      // T8K's own evidence IS the embedding title similarity, already gated at
      // TAU_TITLE_ANCHOR — so the physical record can only ADD to it here. A negative delta
      // would double-penalise, and the kWork title fallback would be self-referential
      // anyway (the "candidate title" in this branch IS k.matchedWorkTitle, so comparing
      // the two always agrees). Contradiction is handled above, by withholding T8K outright.
      const level = corr.level === "strong" || corr.level === "moderate" ? corr.level : "weak";
      const band = liftBand("MEDIUM", CORROBORATION_BAND_DELTA[level]);
      trace.push(
        `T8K: K_work embedding match (titleSim=${k.titleSim.toFixed(2)} >= ${TAU_TITLE_ANCHOR}) identifies the work despite no source consensus` +
          ` — corroboration ${level} -> ${band}`,
      );
      return mk(band === "LOW" ? "candidate" : "identified", k.matchedWorkTitle ?? ag.dominantRaw, band, "T8K");
    }
  }

  // T6 — title sources present but pointing at different works, none dominant
  if (votes.length > 0 && ag.distinct >= 2 && ag.dominantRaw === null) return mk("conflict", null, null, "T6");

  // T7 — no usable title evidence
  return mk("unresolved", null, null, "T7");
}

// ───────────────────────────────────────────────────────────────────────────────
// IMPRESSION — ADR-0010 Decision 5b + Decision 9.1 (K_work: real catalogued
// technique + dimensions from queryAckgWorks, compared here in code)
// ───────────────────────────────────────────────────────────────────────────────

/** Printmaking process families — the bucket a technique belongs to. Two techniques
 *  match iff they share a family. */
export type TechFamily = "intaglio" | "planographic" | "relief" | "screen" | "photomechanical" | "other";

const TECH_FAMILY_KEYWORDS: Array<[TechFamily, RegExp]> = [
  ["photomechanical", /giclee|giclée|inkjet|digital pigment|digital print|iris print|halftone|photogravure|photolith|collotype|offset|photo-?mechanical|c-?print|chromogenic|laser|dye sublimation|pigment print/i],
  ["intaglio", /etch|engrav|drypoint|dry-point|aquatint|mezzotint|burin|intaglio|soft-?ground|roulette|stipple|sugar-?lift/i],
  ["planographic", /lithograph|litho|planograph|zincograph|transfer litho|chromolith/i],
  ["relief", /woodcut|wood engrav|linocut|lino cut|linoleum|relief|xylograph|chiaroscuro woodcut|metalcut/i],
  ["screen", /screenprint|screen print|serigraph|silkscreen|silk-?screen|pochoir|stencil/i],
];

export function techniqueFamily(name: string): TechFamily {
  const s = (name || "").toLowerCase();
  for (const [fam, re] of TECH_FAMILY_KEYWORDS) if (re.test(s)) return fam;
  return "other";
}

/** Map a set of technique names + a free-text medium string to the families present. */
function familiesOf(names: string[], rawMedium = ""): TechFamily[] {
  const fams = new Set<TechFamily>();
  for (const n of names) {
    const f = techniqueFamily(n);
    if (f !== "other") fams.add(f);
  }
  // rawMedium often carries the process where the Technique node is missing/coarse
  for (const [fam, re] of TECH_FAMILY_KEYWORDS) if (rawMedium && re.test(rawMedium)) fams.add(fam);
  return [...fams];
}

export interface TechniqueComparison {
  match: "true" | "false" | "unassessable";
  observedFamilies: TechFamily[];
  catalogueFamilies: TechFamily[];
  /** The catalogued work is itself a hand-pulled original process (so an observed
   *  photomechanical read means a reproduction, not just this medium). */
  catalogueIsOriginalProcess: boolean;
  note: string;
}

/** Decision 9.1's "technique/period-incompatibility rules table". Pure; no model. */
export function classifyTechniqueMatch(input: {
  observedTechniques: string[];
  observedIsPhotomechanical: boolean;
  catalogueTechniques: string[];
  catalogueMediumRaw?: string;
}): TechniqueComparison {
  const obs = new Set(familiesOf(input.observedTechniques));
  if (input.observedIsPhotomechanical) obs.add("photomechanical");
  const cat = familiesOf(input.catalogueTechniques, input.catalogueMediumRaw ?? "");
  const catSet = new Set(cat);
  const catalogueIsOriginalProcess = cat.some((f) => f !== "photomechanical" && f !== "other");

  if (cat.length === 0)
    return {
      match: "unassessable",
      observedFamilies: [...obs],
      catalogueFamilies: cat,
      catalogueIsOriginalProcess: false,
      note: "no catalogued technique to compare against",
    };
  if (obs.size === 0)
    return {
      match: "unassessable",
      observedFamilies: [],
      catalogueFamilies: cat,
      catalogueIsOriginalProcess,
      note: `catalogue is ${cat.join("/")}, but the observed technique is unread`,
    };

  const overlap = [...obs].some((f) => catSet.has(f));
  return {
    match: overlap ? "true" : "false",
    observedFamilies: [...obs],
    catalogueFamilies: cat,
    catalogueIsOriginalProcess,
    note: `observed ${[...obs].join("/")} vs catalogue ${cat.join("/")} -> ${overlap ? "same family" : "different family"}`,
  };
}

export interface DimensionEvidence {
  /** Where the "observed" measurement comes from. "appraiser" = Stage 1c stated
   *  dimensions (the pipeline's dimension source of record). "vea_scaled" = VEA with a
   *  scale reference (±15-20%, compared with a note). "none" = nothing usable → UNASSESSABLE. */
  observedSource: "appraiser" | "vea_scaled" | "none";
  workIsIntaglio: boolean;
  observedPlateMm?: { w: number; h: number } | null;
  observedImageMm?: { w: number; h: number } | null;
  cataloguePlateMm?: { w: number; h: number } | null;
  catalogueImageMm?: { w: number; h: number } | null;
  /** Sheet, compared last and at TAU_DIM_SHEET_* tolerance. */
  observedSheetMm?: { w: number; h: number } | null;
  catalogueSheetMm?: { w: number; h: number } | null;
}

export interface DimensionComparison {
  match: "true" | "false" | "UNASSESSABLE";
  comparedOn: "plate" | "image" | "sheet" | null;
  direction: "larger" | "smaller" | "equal" | null; // observed vs catalogue
  severity: "within_tolerance" | "minor" | "material" | null;
  note: string;
}

function compareDims(
  obs: { w: number; h: number },
  cat: { w: number; h: number },
  pct: number,
  mmFloor: number,
  on: "plate" | "image" | "sheet",
  scaledCaveat: boolean,
): DimensionComparison {
  const dw = obs.w - cat.w;
  const dh = obs.h - cat.h;
  const effPct = scaledCaveat ? Math.max(pct, 0.18) : pct; // VEA-scaled: widen to swallow ±15-20% noise
  const tolW = Math.max(cat.w * effPct, mmFloor);
  const tolH = Math.max(cat.h * effPct, mmFloor);
  const within = Math.abs(dw) <= tolW && Math.abs(dh) <= tolH;
  const relMax = Math.max(Math.abs(dw) / cat.w, Math.abs(dh) / cat.h);
  const direction = dw + dh > 0.5 ? "larger" : dw + dh < -0.5 ? "smaller" : "equal";
  const severity = within ? "within_tolerance" : relMax < DIM_MATERIAL_PCT ? "minor" : "material";
  return {
    match: within ? "true" : "false",
    comparedOn: on,
    direction,
    severity,
    note: `${on}: observed ${obs.w}x${obs.h}mm vs catalogue ${cat.w}x${cat.h}mm (rel diff ${(relMax * 100).toFixed(1)}%, tol ${(effPct * 100).toFixed(0)}%/${mmFloor}mm${scaledCaveat ? ", VEA-scaled" : ""}) -> ${within ? "within" : severity}`,
  };
}

/** Plate mark primary; image fallback; sheet never; UNASSESSABLE without an observed
 *  measurement or without a like-for-like pair. */
export function classifyDimensionMatch(d: DimensionEvidence): DimensionComparison {
  if (d.observedSource === "none")
    return { match: "UNASSESSABLE", comparedOn: null, direction: null, severity: null, note: "no usable observed dimension (Stage 1c silent, no VEA scale reference)" };
  const scaled = d.observedSource === "vea_scaled";
  if (d.workIsIntaglio && d.observedPlateMm && d.cataloguePlateMm)
    return compareDims(d.observedPlateMm, d.cataloguePlateMm, TAU_DIM_PLATE_PCT, TAU_DIM_PLATE_MM, "plate", scaled);
  if (d.observedImageMm && d.catalogueImageMm)
    return compareDims(d.observedImageMm, d.catalogueImageMm, TAU_DIM_IMAGE_PCT, TAU_DIM_IMAGE_MM, "image", scaled);
  // Sheet last, and only if nothing better exists — trimming makes it the weakest of the
  // three, but for most auction lots it is the only measurement stated.
  if (d.observedSheetMm && d.catalogueSheetMm) {
    const r = compareDims(d.observedSheetMm, d.catalogueSheetMm, TAU_DIM_SHEET_PCT, TAU_DIM_SHEET_MM, "sheet", scaled);
    return { ...r, note: `${r.note} (sheet comparison — trimming and margins make this the weakest dimension)` };
  }
  return {
    match: "UNASSESSABLE",
    comparedOn: null,
    direction: null,
    severity: null,
    note: "no like-for-like dimension pair (nothing stated on one side, or different kinds)",
  };
}

export interface ImpressionEvidence {
  /** Observed printing technique name(s) — from VEA when it ran, otherwise Stage 1c's
   *  stated technique (see observedTechniqueSource). */
  observedTechniques: string[];
  /** Where observedTechniques came from. "appraiser" is a CLAIM, not an observation: an
   *  auction description saying "etching" is reliable about the family but is not the same
   *  as VEA seeing a plate mark, so it must not on its own drive a reproduction verdict. */
  observedTechniqueSource?: "vea" | "appraiser" | "none";
  /** VEA read the technique as photomechanical (halftone dots / offset / giclée). */
  observedIsPhotomechanical: boolean;
  /** Catalogued technique(s) for the identified work, from queryAckgWorks. */
  catalogueTechniques: string[];
  /** The most informative catalogued rawMedium string, if any. */
  catalogueMediumRaw?: string;
  dimensions: DimensionEvidence;
}

export interface ImpressionAssessment {
  divergence: "none" | "variant_sheet" | "later_edition" | "medium_divergence" | "reproduction";
  dimensionMatch: "true" | "false" | "UNASSESSABLE";
  techniqueMatch: "true" | "false" | "unassessable";
  notes: string;
  ruleTrace: string[];
}

/** ADR-0010 Decision 5b. Runs after Pass 2 for any identified/candidate work. */
export function classifyImpression(ev: ImpressionEvidence): ImpressionAssessment {
  const trace: string[] = [];
  const tech = classifyTechniqueMatch({
    observedTechniques: ev.observedTechniques,
    observedIsPhotomechanical: ev.observedIsPhotomechanical,
    catalogueTechniques: ev.catalogueTechniques,
    catalogueMediumRaw: ev.catalogueMediumRaw,
  });
  trace.push(tech.note);
  const dim = classifyDimensionMatch(ev.dimensions);
  trace.push(dim.note);

  // An appraiser-STATED technique is a claim about the medium, not an observation of the
  // object. It is reliable enough about the process family to corroborate a work (see
  // corroborateWork), but calling something a reproduction is a serious verdict that should
  // rest on VEA actually seeing halftone dots — not on a catalogue description disagreeing
  // with the graph. Claimed techniques therefore cap out at medium_divergence.
  const techniqueIsClaimOnly = ev.observedTechniqueSource === "appraiser";
  let divergence: ImpressionAssessment["divergence"];
  if (
    tech.match === "false" &&
    ev.observedIsPhotomechanical &&
    tech.catalogueIsOriginalProcess &&
    !techniqueIsClaimOnly
  ) {
    divergence = "reproduction";
    trace.push("observed technique is photomechanical, catalogued work is a hand-pulled original -> reproduction / poster");
  } else if (tech.match === "false") {
    divergence = "medium_divergence";
    trace.push(
      techniqueIsClaimOnly
        ? "stated technique family differs from the catalogued record -> medium divergence (a CLAIMED technique cannot establish a reproduction on its own)"
        : "observed technique family differs from the catalogued record -> different production (reproduction after / other medium)",
    );
  } else if (dim.match === "true" || dim.match === "UNASSESSABLE" || tech.match === "unassessable") {
    divergence = "none";
    trace.push(`technique ${tech.match}; dimensions ${dim.match} -> no divergence`);
  } else if (dim.severity === "minor") {
    divergence = "variant_sheet";
    trace.push("technique matches; dimensions off but minor -> trimmed / variant sheet");
  } else if (dim.direction === "larger") {
    divergence = "later_edition";
    trace.push("technique matches; dimensions materially larger -> possible later / enlarged edition or restrike");
  } else {
    divergence = "variant_sheet";
    trace.push("technique matches; dimensions materially off -> variant / trimmed sheet");
  }

  return {
    divergence,
    dimensionMatch: dim.match,
    techniqueMatch: tech.match,
    notes: trace.join(" | "),
    ruleTrace: trace,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO MAPPING — ADR-0010 Decision 8 (bridge to ADR-0006's Scenario enum)
// ───────────────────────────────────────────────────────────────────────────────
export const MOVEMENT_THRESHOLD = 0.5;

/** ADR-0010's two-pass verdicts ADD structure; they do not replace the triage LLM's
 *  Section-2D risk flags. `forgeryRisk` / `misattributionRisk` still trigger Scenario 2
 *  (ADR-0006), including when the cause is a signature-medium conflict rather than an
 *  impression divergence — carried through here so that case can't fall between the tables. */
export interface RiskFlagsLite {
  forgeryRisk: boolean;
  misattributionRisk: boolean;
}

export function mapTwoPassToScenario(input: {
  artist: ArtistVerdict;
  work: WorkVerdict | null;
  impression: ImpressionAssessment | null;
  traditionConfidence: number;
  competingTitleCount?: number;
  riskFlags?: RiskFlagsLite;
}): { scenario: Scenario; scenarioName: string; rationale: string } {
  const { artist, work, impression, traditionConfidence } = input;
  const pick = (s: Scenario, rationale: string) => ({ scenario: s, scenarioName: SCENARIO_NAMES[s], rationale });

  // Order matters — risk/divergence/conflict before a confident-looking match (ADR-0006).
  if (input.riskFlags?.forgeryRisk || input.riskFlags?.misattributionRisk)
    return pick(
      Scenario.ElevatedAuthenticationRisk,
      `riskFlags: forgeryRisk=${!!input.riskFlags?.forgeryRisk} misattributionRisk=${!!input.riskFlags?.misattributionRisk}`,
    );

  if (impression && (impression.divergence === "later_edition" || impression.divergence === "medium_divergence" || impression.divergence === "reproduction"))
    return pick(Scenario.ElevatedAuthenticationRisk, `impressionAssessment.divergence=${impression.divergence}`);

  if (artist.verdict === "conflict" || work?.verdict === "conflict" || (input.competingTitleCount ?? 0) >= 2)
    return pick(Scenario.CompetingCandidates, "artist or work verdict = conflict / competing candidates");

  // Scenario 1 is the ONLY no-skeptic, tier-1 route — reachable only by the strict pair:
  // a real attribution (A1/A2 — i.e. >= 2 independent voting sources) at HIGH, a Conceptual
  // Work IDENTIFIED at HIGH, and no impression divergence. Everything short of that (a lone
  // MEDIUM candidate, a LOW/MEDIUM work verdict, an A3/A5/A6/A8K single-source read) is
  // "specialist confirms" = Scenario 3. ADR-0006's core warning is that a thinly-corroborated
  // attribution must not be fast-pathed as clean.
  if (
    (artist.evidenceBasis === "A1" || artist.evidenceBasis === "A2") &&
    artist.verdict === "attributed" &&
    artist.confidence === "HIGH" &&
    work?.verdict === "identified" &&
    work.confidence === "HIGH" &&
    (!impression || impression.divergence === "none")
  )
    return pick(Scenario.ConfirmedClean, "A1/A2 attributed HIGH + work IDENTIFIED HIGH + no impression divergence");

  if (artist.flags.includes("recognisedArtist_noMatchingOeuvre"))
    return pick(Scenario.ArtistConfirmedWorkUnresolved, "A3 recognisedArtist_noMatchingOeuvre -> Scenario 3 + mandatory oeuvre check");

  const artistOk =
    artist.verdict === "attributed" ||
    (artist.verdict === "candidate" && artist.confidence != null && MEDIUM_OR_BETTER.includes(artist.confidence));
  if (artistOk && (!work || work.verdict === "unresolved"))
    return pick(Scenario.ArtistConfirmedWorkUnresolved, "artist ok, work unresolved");

  if (artistOk && work && (work.verdict === "identified" || work.verdict === "candidate"))
    return pick(
      Scenario.ArtistConfirmedWorkUnresolved,
      "artist ok + work identified/candidate but not the strict clean pair -> specialist confirms",
    );

  if (artist.verdict === "not_attributed" && traditionConfidence >= MOVEMENT_THRESHOLD)
    return pick(Scenario.MovementOnly, `not attributed, traditionConfidence ${traditionConfidence} >= ${MOVEMENT_THRESHOLD}`);

  return pick(Scenario.LowSignalEverywhere, "not attributed, low tradition confidence");
}

// ───────────────────────────────────────────────────────────────────────────────
// ASSEMBLE — run the whole tree (ADR-0010 Decisions 1, 3, 3b, 5, 5b, 6, 8)
// ───────────────────────────────────────────────────────────────────────────────
export interface TwoPassInput {
  artistEvidence: ArtistEvidence;
  workEvidence: WorkEvidence;
  impressionEvidence: ImpressionEvidence | null;
  veaInImageTitleLegible: boolean;
  traditionConfidence: number;
  /** The triage LLM's Section-2D flags — still consumed for Scenario 2 routing (ADR-0006). */
  riskFlags?: RiskFlagsLite;
  /** VEA Section 0 halt — a digital reproduction / not-an-original-print. When true the
   *  tree is not run: there is no work to attribute. Routes straight to escalation. */
  veaHaltRecommended?: boolean;
}

export interface TwoPassResult {
  artistAttribution: ArtistVerdict;
  pass2Ran: boolean;
  pass2Mode: "gated" | "in_image_title" | null;
  workIdentification: WorkVerdict | null;
  impressionAssessment: ImpressionAssessment | null;
  scenario: Scenario;
  scenarioName: string;
  ruleTrace: string[];
}

export function classifyTwoPass(input: TwoPassInput): TwoPassResult {
  const trace: string[] = [];

  // VEA Section 0 halt short-circuits everything — a reproduction / poster / catalogue
  // scan has no original work to attribute. Neither pass runs; go straight to escalation.
  if (input.veaHaltRecommended) {
    trace.push("VEA haltRecommended — digital reproduction / not an original print; tree not run");
    const artistAttribution: ArtistVerdict = {
      verdict: "not_attributed",
      artistName: null,
      confidence: null,
      evidenceBasis: "VEA-halt",
      agreementSet: [],
      kId: input.artistEvidence.kId,
      kOeuvreMatchCount: input.artistEvidence.kOeuvreMatchCount,
      subjectCorroboration: "unassessable",
      subjectNote: "",
      flags: ["veaHalt"],
      contradictingIdentities: [],
      ruleTrace: trace,
    };
    return {
      artistAttribution,
      pass2Ran: false,
      pass2Mode: null,
      workIdentification: null,
      impressionAssessment: null,
      scenario: Scenario.LowSignalEverywhere,
      scenarioName: SCENARIO_NAMES[Scenario.LowSignalEverywhere],
      ruleTrace: [...trace, `SCENARIO: ${Scenario.LowSignalEverywhere} (VEA halt -> escalate)`],
    };
  }

  // Pass 1
  let artist = classifyArtistPass(input.artistEvidence);
  trace.push(`PASS 1: ${artist.evidenceBasis} ${artist.verdict}/${artist.confidence ?? "-"} (${artist.artistName ?? "-"})`);

  // Gate
  const gate = passTwoGate(artist, input.veaInImageTitleLegible);
  trace.push(`GATE: runPass2=${gate.runPass2} mode=${gate.mode ?? "-"} (${gate.reason})`);

  let work: WorkVerdict | null = null;
  let impression: ImpressionAssessment | null = null;

  if (gate.runPass2) {
    work = classifyWorkPass(input.workEvidence, {
      impression: input.impressionEvidence,
      veaInImageTitleLegible: input.veaInImageTitleLegible,
    });
    // Splice in the work pass's own trace, not just its conclusion. Which title sources
    // voted, and why a K_work hit was or wasn't counted as corroboration, is the part
    // you need when a work verdict looks wrong — and it used to be dropped here.
    for (const line of work.ruleTrace) if (!line.startsWith("-> ")) trace.push(`  pass2: ${line}`);
    trace.push(`PASS 2: ${work.evidenceBasis} ${work.verdict}/${work.confidence ?? "-"} (${work.conceptualWorkTitle ?? "-"})`);

    // Decision 6 — one bounded work -> artist back-propagation. A Conceptual Work
    // identified from an in-image title, catalogued to a single artist, is itself a
    // work-anchored attribution basis. Capped one band below the work's own confidence
    // (a work-derived attribution never claims HIGH without direct artist evidence).
    if (
      gate.mode === "in_image_title" &&
      work.verdict === "identified" &&
      work.backPropArtist &&
      (artist.verdict === "not_attributed" || artist.verdict === "candidate")
    ) {
      const cap: Confidence = work.confidence === "HIGH" ? "MEDIUM_HIGH" : "MEDIUM";
      if (BANDS.indexOf(cap) > BANDS.indexOf(artist.confidence ?? "LOW")) {
        const clash =
          artist.artistName && nameSimilarity(artist.artistName, work.backPropArtist) < TAU_NAME
            ? [artist.artistName]
            : [];
        trace.push(
          `BACK-PROP: work "${work.conceptualWorkTitle}" (${work.evidenceBasis}) is catalogued to "${work.backPropArtist}" -> attributed/${cap} (was ${artist.evidenceBasis}/${artist.confidence ?? "-"})`,
        );
        artist = {
          verdict: "attributed",
          artistName: work.backPropArtist,
          confidence: cap,
          evidenceBasis: "A-backprop",
          agreementSet: [],
          kId: artist.kId,
          kOeuvreMatchCount: artist.kOeuvreMatchCount,
          subjectCorroboration: artist.subjectCorroboration,
          subjectNote: artist.subjectNote,
          flags: ["backPropagatedFromWork"],
          contradictingIdentities: clash,
          ruleTrace: [
            ...artist.ruleTrace,
            `back-propagation: work-anchored attribution to "${work.backPropArtist}", capped at ${cap}`,
          ],
        };
      } else {
        trace.push(`BACK-PROP: work identifies "${work.backPropArtist}" but does not lift the verdict`);
      }
    }

    // Impression check runs whenever Pass 2 landed on a real work (identified or candidate)
    // and there is catalogued evidence to compare the object against — the divergence is
    // about the physical object vs the record, independent of which T-row fired.
    if (input.impressionEvidence && (work.verdict === "identified" || work.verdict === "candidate")) {
      impression = classifyImpression(input.impressionEvidence);
      trace.push(`IMPRESSION: ${impression.divergence} (dimMatch=${impression.dimensionMatch}, techMatch=${impression.techniqueMatch})`);
    }
  }

  const { scenario, scenarioName, rationale } = mapTwoPassToScenario({
    artist,
    work,
    impression,
    traditionConfidence: input.traditionConfidence,
    riskFlags: input.riskFlags,
  });
  trace.push(`SCENARIO: ${scenario} ${scenarioName} (${rationale})`);

  return {
    artistAttribution: artist,
    pass2Ran: gate.runPass2,
    pass2Mode: gate.mode,
    workIdentification: work,
    impressionAssessment: impression,
    scenario,
    scenarioName,
    ruleTrace: trace,
  };
}
