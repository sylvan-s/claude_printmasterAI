/**
 * Deterministic two-pass attribution classifier — ADR-0010.
 *
 * ADR-0010's logic tree is evaluated here as pure functions over a set of "evidence
 * cells" (ArtistEvidence / WorkEvidence). Per ADR-0010 Decision 9, a single Sonnet call
 * fills those cells (forms the hypothesis, runs the query_ackg loop, judges Stage 1b
 * consistency, resolves identities); this module does the rest — no LLM, no network,
 * fully unit-testable (tests/two_pass_attribution/).
 *
 * NOT wired into the live pipeline yet. runStage2aTriage / classifyTriageOutcome
 * (src/appraisal/routing.ts) are unchanged. `mapTwoPassToScenario()` returns the same
 * ADR-0006 Scenario enum and is the intended bridge when Decision 8 is implemented.
 *
 * Run the tests: npm run test:two-pass
 */
import { Scenario, SCENARIO_NAMES } from "./routing";

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
export const DIM_MATERIAL_PCT = 0.1; // beyond tolerance but below this = "minor"; at/above = "material"
export const KOEUVRE_DISCRIMINATING_MIN = 3; // K_oeuvre matchCount that counts as "uniquely discriminating" for a one-band lift on an n=1 candidate

// ───────────────────────────────────────────────────────────────────────────────
// Confidence bands
// ───────────────────────────────────────────────────────────────────────────────
export type Confidence = "HIGH" | "MEDIUM_HIGH" | "MEDIUM" | "LOW";
const BANDS: Confidence[] = ["LOW", "MEDIUM", "MEDIUM_HIGH", "HIGH"];
function liftBand(c: Confidence, by = 1): Confidence {
  return BANDS[Math.min(BANDS.length - 1, BANDS.indexOf(c) + by)];
}

// ───────────────────────────────────────────────────────────────────────────────
// Name normalization — the deterministic fallback matcher (ADR-0010 "Not addressed":
// production resolves via ULAN/Wikidata id first; this is the string fallback).
// ───────────────────────────────────────────────────────────────────────────────
const HONORIFICS = new Set([
  "sir", "dame", "ra", "ara", "pra", "re", "are", "rws", "arws", "rba", "arba",
  "rsa", "rsw", "neac", "re.", "hon", "obe", "cbe", "mbe", "kt", "jr", "sr",
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
]);
const NATIONALITY_WORDS = new Set([
  "british", "english", "scottish", "welsh", "irish", "french", "german", "dutch",
  "flemish", "italian", "spanish", "american", "japanese", "chinese", "korean",
  "swiss", "belgian", "austrian", "russian", "danish", "norwegian", "swedish",
  "czech", "polish", "hungarian", "mexican", "chilean", "brazilian", "canadian",
]);

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
export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t)),
    );
  const ta = norm(a);
  const tb = norm(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// ───────────────────────────────────────────────────────────────────────────────
// PASS 1 — ARTIST
// ───────────────────────────────────────────────────────────────────────────────
// V = VEA, R = reverse image search, A = appraiser input. K = ACKG work-level anchor —
// see ADR-0010 Decision 4a amendment (2026-08-29): an ACKG work whose title matches an
// observed title AND is catalogued to a single artist is independent enough to VOTE.
// K_oeuvre population COUNTS still only corroborate (never vote).
export type SourceTag = "V" | "R" | "A" | "K";

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
    }
  | { kind: "silent" } // V: no nameable authorship signal
  | { kind: "no_match" } // R: reverse search found nothing
  | { kind: "absent" }; // A: no appraiser notes / no attribution claim

export interface ArtistEvidence {
  vea: NamingSource; // V
  reverseImageSearch: NamingSource; // R — needs sim >= SIM_ARTIST_VOTE and consistency to vote
  appraiser: NamingSource; // A — documented_fact votes; hypothesis does not
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
  kSubjectNote?: string;
  /** ADR-0010 Decision 4a amendment: the ACKG holds a work whose title matches an observed
   *  title (V_t / R_t / A_t) AND is catalogued to exactly one artist. This VOTES in the
   *  artist pass (titleSim >= TAU_TITLE), unlike the K_oeuvre population count. null when
   *  there is no such work-level artist+title match. */
  ackgWorkAnchor: { artist: string; identityKey?: string | null; titleSim: number } | null;
}

export interface ArtistVerdict {
  verdict: "attributed" | "candidate" | "not_attributed" | "conflict";
  artistName: string | null;
  confidence: Confidence | null;
  evidenceBasis: string; // "A1".."A11"
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

  // K — ACKG work-level anchor (Decision 4a amendment). Only a title match at or above
  // TAU_TITLE, catalogued to a named artist, is independent enough to count.
  if (ev.ackgWorkAnchor && ev.ackgWorkAnchor.artist && ev.ackgWorkAnchor.titleSim >= TAU_TITLE) {
    votes.push({ source: "K", raw: ev.ackgWorkAnchor.artist, identityKey: ev.ackgWorkAnchor.identityKey ?? null });
    trace.push(
      `K votes: ACKG holds "${ev.ackgWorkAnchor.artist}" for a title-matched work (titleSim=${ev.ackgWorkAnchor.titleSim.toFixed(2)} >= ${TAU_TITLE})`,
    );
  } else if (ev.ackgWorkAnchor) {
    trace.push(
      `K dropped: ackgWorkAnchor titleSim=${(ev.ackgWorkAnchor.titleSim ?? 0).toFixed(2)} < ${TAU_TITLE} or no artist — corroboration only`,
    );
  }

  return { votes, appraiserHypothesis };
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

  // A1 — n >= 3 (all of V/R/A, or three of V/R/A/K, agree — Decision 4a amendment adds K)
  if (ag.n >= 3) {
    const f = ev.kOeuvreMatchCount === 0 ? ["noMatchingOeuvre"] : [];
    if (f.length) trace.push(`K_oeuvre = 0 — noted, not downgraded (A1)`);
    return base("attributed", ag.dominantRaw, "HIGH", "A1", f);
  }

  // A2 / A3 / A4 — n = 2
  if (ag.n === 2) {
    if (ev.kOeuvreMatchCount != null && ev.kOeuvreMatchCount >= 1) {
      return base("attributed", ag.dominantRaw, "HIGH", "A2", ["ackgCorroborated"]);
    }
    if (ev.kId === "true" || ev.kId === "unknown") {
      return base("attributed", ag.dominantRaw, "MEDIUM_HIGH", "A3", ["recognisedArtist_noMatchingOeuvre"]);
    }
    return base("attributed", ag.dominantRaw, "MEDIUM", "A4", ["artistNotInACKG"]);
  }

  // A5..A9 — n = 1 (or appraiser-hypothesis-only)
  if (ag.n === 1) {
    const only = ag.dominantVotes[0];
    let v: ArtistVerdict;
    if (only.source === "V") {
      const low = (ev.veaSignatureConfidence ?? 1) < 0.6;
      v = base("candidate", only.raw, low ? "LOW" : "MEDIUM", "A5", ["singleSourceVEA"]);
    } else if (only.source === "R") {
      const sim = ev.reverseImageSearch.kind === "names" ? ev.reverseImageSearch.sim ?? 0 : 0;
      if (sim >= SIM_ARTIST_STRONG) v = base("candidate", only.raw, "MEDIUM", "A6", ["singleSourceImageMatch"]);
      else v = base("candidate", only.raw, "LOW", "A7", ["weakImageMatchOnly"]);
    } else if (only.source === "K") {
      // ADR-0010 Decision 4a amendment: an ACKG work-level artist+title match, alone,
      // makes a MEDIUM candidate (never "attributed" without a direct V/R/A signal).
      v = base("candidate", only.raw, "MEDIUM", "A8K", ["ackgWorkAnchor"]);
    } else {
      // A: only a documented_fact appraiser claim
      v = base("candidate", only.raw, "MEDIUM", "A8", ["appraiserDocumentedOnly"]);
    }
    return applyCorroborationLifts(v, ev, appraiserHypothesis, trace);
  }

  // A9 — the only signal is an appraiser hypothesis
  if (appraiserHypothesis && appraiserHypothesis.kind === "names") {
    return base("not_attributed", null, "LOW", "A9", ["appraiserHypothesisUncorroborated"]);
  }

  // A11 — nothing
  return base("not_attributed", null, null, "A11", []);
}

/** ADR-0010 Decision 3 layered rules: ACKG (uniquely discriminating) and a corroborating
 *  appraiser hypothesis can each lift an *already-established* candidate/attributed verdict
 *  by at most one band. Never lifts "not_attributed". */
function applyCorroborationLifts(
  v: ArtistVerdict,
  ev: ArtistEvidence,
  appraiserHypothesis: NamingSource | null,
  trace: string[],
): ArtistVerdict {
  if (v.verdict === "not_attributed" || v.verdict === "conflict" || v.confidence === null) return v;
  let conf = v.confidence;
  const lifts: string[] = [];

  if ((ev.kOeuvreMatchCount ?? 0) >= KOEUVRE_DISCRIMINATING_MIN) {
    conf = liftBand(conf);
    lifts.push(`K_oeuvre=${ev.kOeuvreMatchCount} (>= ${KOEUVRE_DISCRIMINATING_MIN}) lifts one band`);
  }
  if (
    lifts.length === 0 && // ACKG and hypothesis don't stack — one band max, total
    appraiserHypothesis &&
    appraiserHypothesis.kind === "names" &&
    v.artistName &&
    nameSimilarity(appraiserHypothesis.raw, v.artistName) >= TAU_NAME
  ) {
    conf = liftBand(conf);
    lifts.push(`corroborating appraiser hypothesis lifts one band`);
  }

  if (conf !== v.confidence) {
    for (const l of lifts) trace.push(l);
    trace.push(`confidence ${v.confidence} -> ${conf}`);
    return { ...v, confidence: conf };
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
// PASS 2 — CONCEPTUAL WORK — ADR-0010 Decision 5 (T1..T7)
// ───────────────────────────────────────────────────────────────────────────────
export type TitleSourceTag = "V_t" | "R_t" | "A_t";
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
  kWork: KWorkResult | null; // null = not queried / no hit
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

/** ADR-0010 Decision 5 — the T1..T7 table. */
export function classifyWorkPass(ev: WorkEvidence): WorkVerdict {
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

  // T1 — all three sources agree
  if (ag.n === 3) return mk("identified", ag.dominantRaw, "HIGH", "T1");

  // T2 / T4 — two agree. The physical-vs-catalogued divergence that used to split T2/T3
  // is now entirely the impression layer's job (Decision 5b, Part A): classifyImpression
  // runs after this for any identified/candidate work and sets impressionAssessment.
  if (ag.n === 2) {
    if (k && k.titleSim >= TAU_TITLE) return mk("identified", ag.dominantRaw, "HIGH", "T2");
    return mk("identified", ag.dominantRaw, "MEDIUM", "T4"); // no / weak K_work corroboration
  }

  // T5 — single source
  if (ag.n === 1) {
    const conf: Confidence = k && k.titleSim >= TAU_TITLE ? "MEDIUM" : "LOW";
    return mk("candidate", ag.dominantRaw, conf, "T5");
  }

  // ── ag.n === 0: sources conflict or are all silent ────────────────────────────
  // T8K (Part B) — a strong ACKG embedding match to a specific catalogued work
  // identifies it even when the title SOURCES give no consensus. This is what rescues
  // the "same series, sources name different works" case (e.g. Hirst Empresses).
  if (k && k.titleSim >= TAU_TITLE_ANCHOR) {
    trace.push(`T8K: K_work embedding match (titleSim=${k.titleSim.toFixed(2)} >= ${TAU_TITLE_ANCHOR}) identifies the work despite no source consensus`);
    return mk("identified", k.matchedWorkTitle ?? ag.dominantRaw, "MEDIUM", "T8K");
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
}

export interface DimensionComparison {
  match: "true" | "false" | "UNASSESSABLE";
  comparedOn: "plate" | "image" | null;
  direction: "larger" | "smaller" | "equal" | null; // observed vs catalogue
  severity: "within_tolerance" | "minor" | "material" | null;
  note: string;
}

function compareDims(
  obs: { w: number; h: number },
  cat: { w: number; h: number },
  pct: number,
  mmFloor: number,
  on: "plate" | "image",
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
  return {
    match: "UNASSESSABLE",
    comparedOn: null,
    direction: null,
    severity: null,
    note: "no like-for-like dimension pair (only sheet on one side, or a side missing)",
  };
}

export interface ImpressionEvidence {
  /** VEA's observed printing technique name(s). */
  observedTechniques: string[];
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

  let divergence: ImpressionAssessment["divergence"];
  if (
    tech.match === "false" &&
    ev.observedIsPhotomechanical &&
    tech.catalogueIsOriginalProcess
  ) {
    divergence = "reproduction";
    trace.push("observed technique is photomechanical, catalogued work is a hand-pulled original -> reproduction / poster");
  } else if (tech.match === "false") {
    divergence = "medium_divergence";
    trace.push("observed technique family differs from the catalogued record -> different production (reproduction after / other medium)");
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
export const MOVEMENT_THRESHOLD = 0.5; // mirrors routing.ts

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
    work = classifyWorkPass(input.workEvidence);
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
