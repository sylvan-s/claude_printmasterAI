/**
 * Stage 2a — the deterministic ACKG query plan ("query builder").
 *
 * WHAT THIS REPLACES
 * ------------------
 * Until now the Attribution Evidence Agent decided, per run, *which* graph queries to
 * issue and with *what* parameters: whether to call query_ackg at all, what technique
 * string to pass, whether to bother with query_ackg_work, and which number to transcribe
 * back into kWorkTitleSim. Every one of those is a free choice, and free choices are the
 * measured variance source. Sonnet 4.6 agrees with its own majority verdict 80% of the
 * time on a fixed lot set; the cheaper models 35-50%. A large part of that spread is not
 * disagreement about evidence — it is disagreement about whether to go and look.
 *
 * The worst case is silent: an agent that never calls query_ackg_work leaves kWorkQueried
 * false and kWorkTitleSim -1, which switches off the entire title cascade in
 * two_pass_attribution. No error, no warning, just a lot decided on less evidence than the
 * one before it.
 *
 * So the queries move into code. Given the structured Stage 1a/1b/1c/1d outputs, this
 * module derives a candidate set, derives the query parameters, runs every query, and
 * hands the model the ANSWERS. The model is left with the part that is genuinely
 * judgement — which candidate is dominant, what tradition and period this is, what the
 * risks are — and the K_* / catalogue_* cells are written by code from the graph's actual
 * response rather than transcribed by a model that may or may not have asked.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not name an artist from a monogram, read a tradition, or weigh conflicting
 * evidence. Where code cannot derive a candidate (an illegible or symbolic signature with
 * nothing structured behind it), the candidate is simply absent from the plan and the model
 * may still name one — `lookupLateCandidate` then runs the SAME fixed queries for that
 * name. One shape of query, however the name arrived.
 *
 * Pure/impure split is strict: buildStage2aQueryPlan() touches no network and is unit
 * tested (tests/stage2a_query_plan/). executeStage2aQueryPlan() does the I/O.
 */
import type {
  VisualExtractionResult,
  AppraiserInputResult,
  Stage1dResult,
} from "../types.js";
import {
  queryAckg,
  queryAckgWorks,
  scoreWorkTitleMatches,
  resolveArtistIdentity,
  normalizeTitleForEmbedding,
  parseAckgDimMm,
  foldAccents,
  type ArtistIdentity,
} from "./knowledge_graph/index.js";
import type { AckgWorkMatch, AckgCandidate, DimMm } from "./knowledge_graph/index.js";
import {
  techniqueFamily,
  dimsWithinTolerance,
  TAU_DIM_PLATE_PCT, TAU_DIM_PLATE_MM,
  TAU_DIM_IMAGE_PCT, TAU_DIM_IMAGE_MM,
  TAU_DIM_SHEET_PCT, TAU_DIM_SHEET_MM,
} from "./two_pass_attribution.js";
import type { WH } from "./stage2a_evidence.js";

// ───────────────────────────────────────────────────────────────────────────────
// Controlled vocabularies
//
// queryAckg/queryAckgWorks match technique and paper as case-insensitive SUBSTRINGS of
// the stored node name. A synonym that is not a substring returns zero rows with no
// error — "Silkscreen" against a graph that stores "Screenprint / Serigraphy" looks
// exactly like an artist who made no screenprints. The model was previously told this in
// prose and asked to comply; here it is enforced.
// ───────────────────────────────────────────────────────────────────────────────

/** Ordered: the first pattern that matches wins, so compounds precede their parts
 *  ("wood engraving" before "engraving", "offset lithograph" before "lithograph"). */
const TECHNIQUE_VOCABULARY: Array<[RegExp, string]> = [
  [/offset/i, "Offset lithograph"],
  [/wood\s*-?\s*engrav/i, "Wood engraving"],
  [/screen\s*-?print|serigraph|silk\s*-?screen/i, "Screenprint"],
  [/photogravure|photo\s*-?gravure/i, "Photogravure"],
  [/aquatint/i, "Aquatint"],
  [/mezzotint/i, "Mezzotint"],
  [/drypoint|dry\s*-?point/i, "Drypoint"],
  [/etch/i, "Etching"],
  [/litho/i, "Lithograph"],
  [/woodcut|wood\s*-?block/i, "Woodcut"],
  [/linocut|linoleum/i, "Linocut"],
  [/engrav/i, "Engraving"],
  [/monotype|monoprint/i, "Monotype"],
  [/gicl[eé]e|inkjet|pigment\s+print/i, "Giclee"],
  [/emboss/i, "Embossing"],
  [/collage/i, "Collage"],
  [/intaglio/i, "Intaglio"],
];

/** Paper surface types the graph actually stores. VEA's `surfaceType` already uses these
 *  literals for the most part; anything outside the list (chine_colle, unknown, free text)
 *  is dropped rather than passed through to return zero. */
const PAPER_VOCABULARY = ["wove", "laid", "japanese", "bfk", "card", "vellum", "fabric"];

export function mapTechniqueToAckgVocabulary(raw: string | null | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  for (const [re, canonical] of TECHNIQUE_VOCABULARY) if (re.test(s)) return canonical;
  return null;
}

export function mapPaperToAckgVocabulary(raw: string | null | undefined): string | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s || s === "unknown") return null;
  const hit = PAPER_VOCABULARY.find((p) => s.includes(p));
  return hit ? (hit === "bfk" ? "BFK" : hit) : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Period parsing
// ───────────────────────────────────────────────────────────────────────────────

export interface PeriodRange {
  startYear: number;
  endYear: number;
  basis: string;
}

/**
 * Parse Stage 1c's free-text period claim into a year range.
 *
 * A bare year is widened by ±2. Catalogued `dateCreated_year` and a claimed date routinely
 * disagree by a year or two (publication vs. execution vs. the date printed on the sheet),
 * and an exact-year filter turns that disagreement into a zero — which reads downstream as
 * "this artist made nothing like this", the one thing kOeuvreMatchCount must never say by
 * accident. A circa is widened by ±5, which is what "circa" means.
 */
export function parseClaimedPeriod(raw: string | null | undefined): PeriodRange | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const plausible = (y: number) => y >= 1400 && y <= 2100;

  const range = s.match(/(\d{4})\s*(?:-|–|—|to)\s*(\d{4})/);
  if (range) {
    const a = Number(range[1]), b = Number(range[2]);
    if (plausible(a) && plausible(b) && a <= b) return { startYear: a, endYear: b, basis: `explicit range ${a}-${b}` };
  }
  const decade = s.match(/(\d{3}0)\s*'?s\b/);
  if (decade) {
    const a = Number(decade[1]);
    if (plausible(a)) return { startYear: a, endYear: a + 9, basis: `decade ${a}s` };
  }
  const circa = s.match(/\b(?:c|ca|circa)\.?\s*(\d{4})/i);
  if (circa) {
    const a = Number(circa[1]);
    if (plausible(a)) return { startYear: a - 5, endYear: a + 5, basis: `circa ${a} widened ±5` };
  }
  const bare = s.match(/\b(\d{4})\b/);
  if (bare) {
    const a = Number(bare[1]);
    if (plausible(a)) return { startYear: a - 2, endYear: a + 2, basis: `stated ${a} widened ±2` };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Title handling
// ───────────────────────────────────────────────────────────────────────────────

/**
 * The substring pre-filter for a work query. `queryAckgWorks` is ORDER BY impressionCount
 * and LIMIT-ed, so an artist-only query drops a low-impression target work before it is
 * ever scored — the pre-filter is what gets it into the candidate set.
 *
 * Longest word of 4+ characters: long words are rarer, and a rare word is a better
 * substring filter than a common one. Shared with executeGraphTool so the loop and the
 * plan cannot drift apart.
 */
export function titlePreFilter(observedTitle: string | null | undefined): string | undefined {
  return (
    // Folded first — see titleProbeFilter.
    foldAccents(observedTitle || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .sort((a, b) => b.length - a.length)[0] || undefined
  );
}

/**
 * A tighter substring filter for the artist-blind title probe.
 *
 * `titlePreFilter` takes one long word, which is right for widening an artist-scoped query
 * but wrong here: "The Beach Boys" reduces to "beach", and 12 artists catalogue a title
 * containing "beach". The probe then resolves to nobody and kWorkBackPropArtist is empty —
 * not because the title names nobody, but because the question was asked too loosely. The
 * catalogued title is matched with CONTAINS, so the whole title minus a leading article is
 * both far more selective and still a substring of "The Beach Boys (signed)".
 */
export function titleProbeFilter(observedTitle: string | null | undefined): string | null {
  // Fold BEFORE stripping punctuation. Stripping first deletes an accented letter outright
  // — "Le Petit Équilibrist" became "petit quilibrist", which is not a substring of the
  // folded stored title "le petit equilibrist", so the probe missed the very work it was
  // asked about. The graph folds both sides; so must this.
  const core = foldAccents(observedTitle || "")
    .toLowerCase()
    .replace(/^(?:the|a|an|le|la|les|un|une|der|die|das)\s+/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return core.length >= 4 ? core : null;
}

/** Titles VEA reads off the sheet. Anything classified as an edition mark, a signature or a
 *  publisher line is not a title, and the classification field is what says so. */
const TITLE_CLASSIFICATIONS = /title|series|caption|cartouche/i;
const VEA_TITLE_MIN_CONFIDENCE = 0.5;

function veaInImageTitle(vea: VisualExtractionResult): { title: string; legible: boolean } | null {
  const rows = vea.titleInscriptions ?? [];
  for (const r of rows) {
    const conf = typeof r.titleConfidence === "string" ? Number(r.titleConfidence) : r.titleConfidence;
    const text = (r.transcription || "").trim();
    if (!text) continue;
    if (!TITLE_CLASSIFICATIONS.test(r.classification || "")) continue;
    if (!Number.isFinite(conf) || (conf as number) < VEA_TITLE_MIN_CONFIDENCE) continue;
    return { title: text, legible: true };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Candidate derivation
// ───────────────────────────────────────────────────────────────────────────────

export type CandidateSource = "appraiser" | "reverse_image" | "embedding" | "vea_signature";

export interface PlannedCandidate {
  /** The name as the source gave it — resolution to a canonical spelling happens at
   *  execution, against the graph, never here. */
  name: string;
  source: CandidateSource;
  detail: string;
}

/** Edition marks, dates and annotations that ride along in a signature transcription. */
const SIGNATURE_NOISE =
  /\b(?:\d+\s*\/\s*\d+|[ivxlc]+\s*\/\s*[ivxlc]+|a\.?p\.?|h\.?c\.?|e\.?a\.?|p\.?p\.?|bat|t\.?p\.?|ed\.?|no\.?|\d{4})\b/gi;

/**
 * Recover an artist name from a signature transcription — conservatively.
 *
 * This exists so the common case ("David Hockney", "Picasso 47/50") does not need a model,
 * not to compete with one. A monogram, an illegible mark or anything that does not reduce
 * to a short run of alphabetic tokens returns null, and that candidate is then the model's
 * to name. Being wrong here is worse than being absent: a wrong name is queried, comes back
 * with support, and corroborates itself.
 */
export function artistNameFromSignature(transcription: string | null | undefined): string | null {
  let s = (transcription || "").trim();
  if (!s) return null;
  if (/illegible|indistinct|unknown|unclear|not\s+legible/i.test(s)) return null;
  s = s.replace(SIGNATURE_NOISE, " ").replace(/["'“”‘’()\[\]]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[,;:.\-–—\s]+|[,;:.\-–—\s]+$/g, "").trim();
  if (!s) return null;
  // Stripping an edition mark can leave its punctuation behind ("Peter Blake, A.P." ->
  // "Peter Blake ."). A token carrying no letter is debris, not a name part.
  const tokens = s.split(/\s+/).filter((t) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(t));
  if (tokens.length < 1 || tokens.length > 4) return null;
  // Every token must read as a name part: letters, optionally an initial's dot or a hyphen.
  if (!tokens.every((t) => /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.\-]*$/.test(t))) return null;
  const alpha = s.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  if (alpha.length < 4) return null;
  // At least one substantial token — "P. P." is a monogram, not a name.
  if (!tokens.some((t) => t.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "").length >= 3)) return null;
  return s;
}

const SIGNATURE_AUTHORSHIP_TYPES = new Set(["hand_signed", "plate_signed", "stamp"]);
const SIGNATURE_MIN_CONFIDENCE = 0.5;

// ───────────────────────────────────────────────────────────────────────────────
// The plan
// ───────────────────────────────────────────────────────────────────────────────

/**
 * No period bounds — deliberately, and measured (2026-09-11, A0793/122, Peter Blake,
 * Screenprint + wove, A0793 excluded):
 *
 *     strict 1962-1966   66 artists   Blake=  1   142 artists clear KOEUVRE_DISCRIMINATING_MIN
 *     null-tolerant     383 artists   Blake=127
 *     no period         400 artists   Blake=229
 *
 * The strict filter is not measuring period. `cw.dateCreated_year` is absent on 26,435 of
 * 86,585 ConceptualWorks (30.5%) — and on 289 of Peter Blake's 532 (54%) — and the Cypher
 * comparison drops a null. So a period range silently discards every undated work and the
 * count that comes back measures date COVERAGE, not œuvre. Blake falls from 229 to 1, which
 * reads downstream as "this artist is not catalogued working like this" and fails
 * corroboration at KOEUVRE_DISCRIMINATING_MIN = 3.
 *
 * Making the predicate null-tolerant fixes the silent discard but barely narrows anything
 * (Blake 127), so period is not doing discriminating work either way. Between a filter that
 * manufactures false absence and one that does nothing, the system's own rule decides it:
 * absence of population data is never evidence against a candidate, so the filter that
 * fabricates absence is the one that goes.
 *
 * The consequence is that kOeuvreMatchCount is now high for almost any real artist — 319 of
 * 400 returned artists clear 3 on this query. KOEUVRE_DISCRIMINATING_MIN was already an
 * unfitted placeholder (ADR-0010 Decision 4) and needs refitting against this distribution.
 * It is left alone here so that refit is its own measurable change rather than a side
 * effect of this one.
 */
export interface ObservedDims {
  kind: "plate" | "image" | "sheet";
  mm: WH;
  basis: string;
}

/**
 * Stage 1c's dimensionsClaim, converted to mm — no judgement, and crucially no re-typing.
 *
 * This exists because of a real failure the first deterministic run produced. The catalogue
 * side of the dimension comparison is written from the graph rows; the observed side was
 * still the model's transcription, and on A0793/2 the model had transposed BOTH sides
 * (observed 163x222 against catalogue 163x222) where Stage 1c states width 22.2cm, height
 * 16.3cm. Transposed on both sides the comparison still passed, because `compareDims` is
 * axis-strict and the error cancelled. Correcting only the catalogue side broke the
 * cancellation and produced a 36.2% "material" divergence on a print that matches its
 * catalogue record exactly.
 *
 * Whether "width first" is semantically right is a separate question — the auction convention
 * is arguably height first, and both the parser and Stage 1c read the first number as width.
 * What matters to an axis-strict comparison is that the two sides agree, and the only way to
 * guarantee that is for one source to fill both.
 */
export function observedDimsFromClaim(appraiserInput: AppraiserInputResult | null | undefined): ObservedDims | null {
  const c = appraiserInput?.dimensionsClaim;
  if (!c || c.widthCm == null || c.heightCm == null) return null;
  const k = (c.kind || "").toLowerCase();
  const kind: ObservedDims["kind"] | null =
    /plate/.test(k) ? "plate" : /image/.test(k) ? "image" : /sheet/.test(k) ? "sheet" : null;
  // An unspecified kind is not a sheet measurement by default. Guessing which dimension was
  // measured is the kind of invention this module exists to remove — leave it to the model.
  if (!kind) return null;
  return {
    kind,
    mm: { width: Math.round(c.widthCm * 10 * 10) / 10, height: Math.round(c.heightCm * 10 * 10) / 10 },
    basis: `Stage 1c dimensionsClaim ${c.widthCm}x${c.heightCm}cm (${c.kind}) [source: ${c.source}]`,
  };
}

export interface OeuvreQuerySpec {
  technique?: string;
  paper?: string;
}

export interface Stage2aQueryPlan {
  candidates: PlannedCandidate[];
  /** null when the constraint gate refuses it — see `oeuvreRefusal`. */
  oeuvre: OeuvreQuerySpec | null;
  oeuvreRefusal: string | null;
  /**
   * The title the work match is SCORED against. Only ever something read off the object
   * (Stage 1c's claim, or VEA's in-image inscription) — never Stage 1b's guess. Scoring
   * 1b's own proposed title against the graph and calling the result corroboration is
   * circular: 1b proposed it because it looked like that work.
   */
  observedTitle: string | null;
  observedTitleSource: "appraiser" | "vea_in_image" | null;
  observedTitleLegibleInImage: boolean;
  /** May come from Stage 1b — retrieval only, never scored. */
  retrievalTitle: string | null;
  /** Parsed from Stage 1c's claim, reported to the model as context. NOT a query filter —
   *  see OeuvreQuerySpec. */
  claimedPeriod: PeriodRange | null;
  /** The object's own measurement, straight from Stage 1c's structured dimensionsClaim.
   *  null when Stage 1c stated none, or stated one without saying which dimension it is. */
  observedDims: ObservedDims | null;
  observedTechnique: string | null;
  /** Whether the technique filter is an OBSERVATION (VEA saw it) or a CLAIM (Stage 1c said
   *  so). It filters the graph either way, but the block says which, because a claim that
   *  narrows the œuvre count is a claim corroborating itself. */
  observedTechniqueSource: "vea" | "appraiser_claim" | null;
  observedTechniques: string[];
  /** Substring filter for the artist-blind title probe: tighter than `titlePreFilter`,
   *  which takes a single word and so matches every title containing it. */
  titleProbeFilter: string | null;
  trace: string[];
}

const MAX_PLANNED_CANDIDATES = 4;

export function buildStage2aQueryPlan(input: {
  vea: VisualExtractionResult;
  visualSearch?: { bestMatchArtist?: string | null; bestMatchTitle?: string | null; evidenceBasis?: string } | null;
  appraiserInput?: AppraiserInputResult | null;
  stage1d?: Stage1dResult | null;
}): Stage2aQueryPlan {
  const { vea, visualSearch, appraiserInput, stage1d } = input;
  const trace: string[] = [];

  // ---- candidates ----------------------------------------------------------
  const seen = new Set<string>();
  const candidates: PlannedCandidate[] = [];
  const add = (name: string | null | undefined, source: CandidateSource, detail: string) => {
    const n = (name || "").trim();
    if (!n) return;
    const key = foldAccents(n);
    if (seen.has(key)) {
      trace.push(`candidate "${n}" (${source}) already present — not duplicated`);
      return;
    }
    if (candidates.length >= MAX_PLANNED_CANDIDATES) {
      trace.push(`candidate "${n}" (${source}) dropped — plan capped at ${MAX_PLANNED_CANDIDATES}`);
      return;
    }
    seen.add(key);
    candidates.push({ name: n, source, detail });
  };

  const claim = appraiserInput?.claimedAttribution;
  if (claim && claim.status !== "absent" && claim.artist) {
    add(claim.artist, "appraiser", `Stage 1c claimedAttribution [${claim.status}]`);
  }

  const veaSig = (vea.signatures ?? [])
    .filter((s) => SIGNATURE_AUTHORSHIP_TYPES.has(s.type) && (s.signatureConfidence ?? 0) >= SIGNATURE_MIN_CONFIDENCE)
    .sort((a, b) => (b.signatureConfidence ?? 0) - (a.signatureConfidence ?? 0));
  for (const s of veaSig) {
    const name = artistNameFromSignature(s.transcription);
    if (name) {
      add(name, "vea_signature", `VEA ${s.type} "${s.transcription}" (conf ${s.signatureConfidence})`);
      break;
    }
    trace.push(`VEA ${s.type} "${s.transcription}" did not reduce to a plain name — left for the model to read`);
  }

  if (visualSearch?.bestMatchArtist) {
    add(visualSearch.bestMatchArtist, "reverse_image", `Stage 1b best match [basis ${visualSearch.evidenceBasis || "unspecified"}]`);
  }

  const embeddingArtists = new Set<string>();
  for (const m of stage1d?.candidateMatches ?? []) {
    if (!m.artistName) continue;
    const k = foldAccents(m.artistName);
    if (embeddingArtists.has(k)) continue;
    embeddingArtists.add(k);
    add(m.artistName, "embedding", `Stage 1d match dino=${m.dinov2Similarity?.toFixed(3) ?? "n/a"}`);
  }

  if (candidates.length === 0) trace.push("no candidate name is derivable from structured Stage 1 output — the model names it, and lookupLateCandidate runs the same queries for whatever it names");

  // ---- observed technique --------------------------------------------------
  const techRows = [...(vea.printingTechniques ?? [])].sort(
    (a, b) => (b.techniqueConfidence ?? 0) - (a.techniqueConfidence ?? 0),
  );
  const observedTechniques = techRows.map((t) => t.technique).filter(Boolean);
  let observedTechnique: string | null = null;
  for (const t of techRows) {
    const mapped = mapTechniqueToAckgVocabulary(t.technique);
    if (mapped) {
      observedTechnique = mapped;
      if (mapped.toLowerCase() !== (t.technique || "").toLowerCase()) {
        trace.push(`technique "${t.technique}" mapped to graph vocabulary "${mapped}"`);
      }
      break;
    }
  }
  let observedTechniqueSource: Stage2aQueryPlan["observedTechniqueSource"] = observedTechnique ? "vea" : null;
  if (!observedTechnique && observedTechniques.length) {
    trace.push(`VEA technique(s) ${observedTechniques.join(", ")} map to nothing in the graph's vocabulary — technique filter omitted rather than passed through to return zero`);
  }
  // VEA is the observation of record, but it does not always produce one: a catalogue-only
  // lot can reach Stage 2a with printingTechniques empty while Stage 1c carries "silkscreen
  // print in colours" from the notes. Refusing the œuvre query in that case throws away the
  // only technique anyone has. So fall back to the claim — and mark it as a claim.
  if (!observedTechnique) {
    const claimed = mapTechniqueToAckgVocabulary(claim?.technique);
    if (claimed) {
      observedTechnique = claimed;
      observedTechniqueSource = "appraiser_claim";
      trace.push(`VEA observed no technique; Stage 1c CLAIMS "${claim?.technique}" -> "${claimed}" — used as a filter, recorded as a claim not an observation`);
    }
  }

  // ---- observed title ------------------------------------------------------
  const claimTitle = claim && claim.status !== "absent" ? (claim.title || "").trim() : "";
  const inImage = veaInImageTitle(vea);
  let observedTitle: string | null = null;
  let observedTitleSource: Stage2aQueryPlan["observedTitleSource"] = null;
  if (claimTitle) {
    observedTitle = claimTitle;
    observedTitleSource = "appraiser";
  } else if (inImage) {
    observedTitle = inImage.title;
    observedTitleSource = "vea_in_image";
  }
  const retrievalTitle = observedTitle || (visualSearch?.bestMatchTitle || "").trim() || null;
  if (!observedTitle && retrievalTitle) {
    trace.push(`no title was read off the object; Stage 1b's "${retrievalTitle}" is used to RETRIEVE rows but is not scored against them — scoring 1b's own hypothesis would be circular`);
  }

  // ---- oeuvre query --------------------------------------------------------
  let paper = mapPaperToAckgVocabulary(vea.paper?.surfaceType);
  if (!paper) {
    const claimedPaper = mapPaperToAckgVocabulary(appraiserInput?.paperOrSupport);
    if (claimedPaper) {
      paper = claimedPaper;
      trace.push(`VEA read no usable paper surface; Stage 1c claims "${appraiserInput?.paperOrSupport}" -> "${claimedPaper}"`);
    }
  }
  const period = parseClaimedPeriod(claim?.period);
  let oeuvre: OeuvreQuerySpec | null = null;
  let oeuvreRefusal: string | null = null;
  if (!observedTechnique && !paper) {
    oeuvreRefusal =
      "no technique or paper survives the controlled vocabulary, so the only available filter would be a period range — " +
      "which narrows nothing and returns the graph's most prolific artists. Not run; kOeuvreMatchCount stays -1.";
    trace.push(`oeuvre query refused: ${oeuvreRefusal}`);
  } else {
    oeuvre = {
      ...(observedTechnique ? { technique: observedTechnique } : {}),
      ...(paper ? { paper } : {}),
    };
    trace.push(
      `oeuvre query: ${JSON.stringify(oeuvre)}` +
        (period ? ` — Stage 1c claims ${period.basis}, NOT applied as a filter (see OeuvreQuerySpec: it would drop every undated work)` : " (no period claimed)"),
    );
  }

  return {
    candidates,
    oeuvre,
    oeuvreRefusal,
    titleProbeFilter: titleProbeFilter(observedTitle),
    claimedPeriod: period,
    observedDims: observedDimsFromClaim(appraiserInput),
    observedTitle,
    observedTitleSource,
    observedTitleLegibleInImage: !!inImage,
    retrievalTitle,
    observedTechnique,
    observedTechniqueSource,
    observedTechniques,
    trace,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Execution
// ───────────────────────────────────────────────────────────────────────────────

export interface WorkFacts {
  queried: boolean;
  /** Rescaled embedding similarity of the best match to `plan.observedTitle`. -1 when there
   *  was no observed title to score against — absence of a question, not a low answer. */
  titleSim: number;
  titleSimBasis: string;
  matchedTitle: string;
  /** The artist the graph catalogues that title to, when the title probe resolves to
   *  exactly one. "" otherwise — including when several artists catalogue the title. */
  backPropArtist: string;
  catalogueTechniques: string[];
  catalogueMediumRaw: string;
  cataloguePlateMm: WH;
  catalogueImageMm: WH;
  catalogueSheetMm: WH;
  editionSizes: number[];
  rowsReturned: number;
  rowsAfterMerge: number;
  /** The next few ranked rows. The model needs to see the rivals to judge kSubject and to
   *  notice when the "best" match only won by a hair — a single row hides both. */
  topRows: Array<{ title: string; sim: number; techniques: string[]; impressions: number }>;
}

export interface CandidateFacts {
  candidate: PlannedCandidate;
  /** The graph's own spelling, once resolved. Honorifics and accents are absorbed here —
   *  "Sir Peter Blake" reaching queryAckgWorks unresolved returned 0 comps where "Peter
   *  Blake" returned 40, and 35 artists holding 4,859 works carry honorific aliases. */
  identity: ArtistIdentity | null;
  queriedAs: string;
  kId: "true" | "unknown";
  kIdBasis: string;
  /** -1 when the oeuvre query was refused. 0 is a real absence-of-population signal. */
  oeuvreMatchCount: number;
  oeuvreProvenanceTags: string[];
  /** Catalogued titles from the œuvre query. The subject fit (kSubject) is a judgement over
   *  this list — code cannot map VEA's free-text subject onto the graph's Subject nodes
   *  without guessing, and guessing is what this module exists to remove. */
  sampleWorks: string[];
  work: WorkFacts;
}

export interface Stage2aGraphFacts {
  plan: Stage2aQueryPlan;
  candidates: CandidateFacts[];
  /** Artists the graph catalogues the observed title to, irrespective of candidate. This is
   *  the genuine Decision 4a back-propagation probe: the per-candidate work query is scoped
   *  to an artist and so can only ever confirm the artist it was given. */
  titleProbe: { title: string; artists: AckgCandidate[]; truncated: boolean } | null;
  errors: string[];
  trace: string[];
}

/** Big enough that a candidate with real support is not cut off by the LIMIT before we can
 *  read its count; small enough to stay one cheap query. `truncated` reports the risk. */
const OEUVRE_LIMIT = 500;
const WORK_ROW_LIMIT = 60;
const TITLE_PROBE_LIMIT = 12;

function modalDim(dims: DimMm[]): WH {
  if (!dims.length) return { width: 0, height: 0 };
  const counts = new Map<string, { n: number; d: DimMm }>();
  for (const d of dims) {
    const k = `${d.w}x${d.h}`;
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, d });
  }
  let best = { n: 0, d: dims[0] };
  for (const e of counts.values()) if (e.n > best.n) best = e;
  return { width: best.d.w, height: best.d.h };
}

/**
 * Collapse un-merged re-ingests of the same work.
 *
 * The graph carries duplicate ConceptualWork nodes for the same work — a known, tracked
 * condition, not an anomaly — and the evidence prompt handled it by asking the model to
 * "merge near-identical titles". That is a judgement call made differently on different
 * runs. Here it is an equality test on the normalized title key plus the folded artist
 * name: the same rule the D_t runner-up gate uses, so a duplicate cannot masquerade as a
 * rival work in one place and as the same work in another.
 */
export function mergeDuplicateWorkRows(works: AckgWorkMatch[]): AckgWorkMatch[] {
  const groups = new Map<string, AckgWorkMatch>();
  for (const w of works) {
    const key = `${foldAccents(w.artistName || "")}|${normalizeTitleForEmbedding(w.workTitle || "")}`;
    const head = groups.get(key);
    if (!head) {
      groups.set(key, { ...w, techniques: [...w.techniques], rawMediums: [...w.rawMediums],
        plateDimsMm: [...w.plateDimsMm], imageDimsMm: [...w.imageDimsMm], sheetDimsMm: [...w.sheetDimsMm],
        editionSizes: [...w.editionSizes], provenanceLayers: [...w.provenanceLayers] });
      continue;
    }
    head.impressionCount += w.impressionCount;
    head.techniques = [...new Set([...head.techniques, ...w.techniques])];
    head.rawMediums = [...new Set([...head.rawMediums, ...w.rawMediums])];
    head.plateDimsMm.push(...w.plateDimsMm);
    head.imageDimsMm.push(...w.imageDimsMm);
    head.sheetDimsMm.push(...w.sheetDimsMm);
    head.editionSizes = [...new Set([...head.editionSizes, ...w.editionSizes])];
    head.provenanceLayers = [...new Set([...head.provenanceLayers, ...w.provenanceLayers])] as AckgWorkMatch["provenanceLayers"];
    if (!head.dateLabel && w.dateLabel) head.dateLabel = w.dateLabel;
    if (!head.titleEmbedding && w.titleEmbedding) head.titleEmbedding = w.titleEmbedding;
  }
  return [...groups.values()];
}

const EMPTY_WORK_FACTS: WorkFacts = {
  queried: false, titleSim: -1, titleSimBasis: "none", matchedTitle: "", backPropArtist: "",
  catalogueTechniques: [], catalogueMediumRaw: "", cataloguePlateMm: { width: 0, height: 0 },
  catalogueImageMm: { width: 0, height: 0 }, catalogueSheetMm: { width: 0, height: 0 },
  editionSizes: [], rowsReturned: 0, rowsAfterMerge: 0, topRows: [],
};

/**
 * How close two title similarities must be before the embedding is treated as unable to
 * separate them.
 *
 * Not a guess — measured on the graph's own titles. The title embedding is blind to exactly
 * the tokens that distinguish siblings in a numbered series: "pl. 25" vs "pl. 26" scores
 * 1.000, "2e planche" vs "3e planche" 0.983, "I hate humans" vs "I Hate Human Beings"
 * 1.000. A band of 0.03 covers that failure without reaching titles the model can actually
 * tell apart ("Flag" vs "Silver Flag" is 0.874, "Cats (Pink)" vs "Cats (Black)" 0.633 —
 * both far outside).
 */
export const TITLE_TIE_BAND = 0.03;

const DIM_TOLERANCE: Record<ObservedDims["kind"], [number, number]> = {
  plate: [TAU_DIM_PLATE_PCT, TAU_DIM_PLATE_MM],
  image: [TAU_DIM_IMAGE_PCT, TAU_DIM_IMAGE_MM],
  sheet: [TAU_DIM_SHEET_PCT, TAU_DIM_SHEET_MM],
};

const rowDims = (w: AckgWorkMatch, kind: ObservedDims["kind"]): DimMm[] =>
  kind === "plate" ? w.plateDimsMm : kind === "image" ? w.imageDimsMm : w.sheetDimsMm;

/**
 * Break a title tie on the object's measurement.
 *
 * Measured case, A0793/113 (Elisabeth Frink). Stage 1c gives the title as a bare "Spinning
 * man"; the graph catalogues eight siblings, and the embedding scores "Spinning Man V" at
 * 1.00 because it cannot see the roman numeral. The object measures 600x830mm. Spinning Man
 * V is catalogued at 800x575 — a third out, which the tree correctly read as later_edition
 * and routed to Scenario 2, buying an adversarial authentication pass. Spinning Man VII is
 * 575x805: 4.3% and 3.1% out, inside the 8% sheet tolerance. The series genuinely contains
 * both orientations, recorded correctly — the wrong sibling was simply picked upstream,
 * where nothing could see the measurement.
 *
 * This is a REPAIR, not a reranking. It fires only when the top row fails the tolerance
 * test and another row inside the tie band passes it: a top row that already matches is
 * never disturbed, and a row outside the band is never promoted however well it measures.
 * Dimensions get to choose between works the title says are the same, and nothing more.
 */
export function breakTitleTieOnDimensions(
  ranked: AckgWorkMatch[],
  observed: ObservedDims | null,
  trace: string[],
): AckgWorkMatch[] {
  if (!observed || ranked.length < 2) return ranked;
  const best = ranked[0];
  if (best.titleSim == null) return ranked;

  const [pct, mmFloor] = DIM_TOLERANCE[observed.kind];
  const obs = { w: observed.mm.width, h: observed.mm.height };
  const fit = (w: AckgWorkMatch) => {
    let bestFit: { within: boolean; relMax: number } | null = null;
    for (const d of rowDims(w, observed.kind)) {
      const r = dimsWithinTolerance(obs, d, pct, mmFloor);
      if (!bestFit || r.relMax < bestFit.relMax) bestFit = r;
    }
    return bestFit;
  };

  const bestFit = fit(best);
  if (!bestFit) return ranked; // nothing catalogued to compare against — say nothing
  if (bestFit.within) return ranked; // the title winner also measures right; leave it alone

  const band = ranked.filter((w) => w.titleSim != null && best.titleSim! - w.titleSim! <= TITLE_TIE_BAND);
  if (band.length < 2) return ranked;

  let promoted: { w: AckgWorkMatch; relMax: number } | null = null;
  for (const w of band.slice(1)) {
    const f = fit(w);
    if (f?.within && (!promoted || f.relMax < promoted.relMax)) promoted = { w, relMax: f.relMax };
  }
  if (!promoted) {
    trace.push(
      `title tie: ${band.length} row(s) within ${TITLE_TIE_BAND} of "${best.workTitle}" and none matches the object's ` +
        `${observed.kind} ${observed.mm.width}x${observed.mm.height}mm — top row left as it is`,
    );
    return ranked;
  }

  trace.push(
    `title tie broken on dimensions: "${best.workTitle}" scores ${best.titleSim!.toFixed(2)} but its catalogued ` +
      `${observed.kind} is ${(bestFit.relMax * 100).toFixed(1)}% off the object's ${observed.mm.width}x${observed.mm.height}mm; ` +
      `"${promoted.w.workTitle}" (${promoted.w.titleSim!.toFixed(2)}) is ${(promoted.relMax * 100).toFixed(1)}% off — promoted. ` +
      `The embedding cannot see what separates these titles; the measurement can.`,
  );
  return [promoted.w, ...ranked.filter((w) => w !== promoted!.w)];
}

/** One candidate's work query, with the fallback ladder the tool loop used to run by hand. */
async function runWorkQuery(
  artist: string,
  plan: Stage2aQueryPlan,
  excludeSaleId: string | null,
  trace: string[],
): Promise<WorkFacts> {
  const retrieval = plan.retrievalTitle;
  const preFilter = titlePreFilter(retrieval);
  let works = await queryAckgWorks({ artist, workTitle: preFilter, excludeSaleId, limit: WORK_ROW_LIMIT });
  if (works.length === 0 && preFilter) {
    trace.push(`work query "${artist}" + "${preFilter}" returned nothing — retrying artist-only`);
    works = await queryAckgWorks({ artist, excludeSaleId, limit: WORK_ROW_LIMIT });
  }
  const rowsReturned = works.length;
  if (rowsReturned === 0) return { ...EMPTY_WORK_FACTS, queried: true };

  const merged = mergeDuplicateWorkRows(works);
  if (merged.length !== rowsReturned) {
    trace.push(`work rows for "${artist}": ${rowsReturned} -> ${merged.length} after merging un-merged re-ingests`);
  }

  let ranked = merged;
  if (plan.observedTitle) {
    const obsFam = plan.observedTechnique ? techniqueFamily(plan.observedTechnique) : null;
    ranked = await scoreWorkTitleMatches(plan.observedTitle, merged, {
      techniqueIncompatible: obsFam
        ? (w) => w.techniques.length > 0 && !w.techniques.some((t) => techniqueFamily(t) === obsFam)
        : undefined,
    });
  }

  ranked = breakTitleTieOnDimensions(ranked, plan.observedDims, trace);

  const best = ranked[0];
  return {
    queried: true,
    titleSim: plan.observedTitle && best?.titleSim != null ? best.titleSim : -1,
    titleSimBasis: plan.observedTitle ? (best?.titleSimBasis ?? "none") : "no observed title",
    matchedTitle: plan.observedTitle ? (best?.workTitle ?? "") : "",
    backPropArtist: "",
    catalogueTechniques: best?.techniques ?? [],
    catalogueMediumRaw: best?.rawMediums?.[0] ?? "",
    cataloguePlateMm: modalDim(best?.plateDimsMm ?? []),
    catalogueImageMm: modalDim(best?.imageDimsMm ?? []),
    catalogueSheetMm: modalDim(best?.sheetDimsMm ?? []),
    editionSizes: best?.editionSizes ?? [],
    rowsReturned,
    rowsAfterMerge: merged.length,
    topRows: ranked.slice(0, 5).map((w) => ({
      title: w.workTitle,
      sim: w.titleSim ?? -1,
      techniques: w.techniques,
      impressions: w.impressionCount,
    })),
  };
}

/** Resolve identity, count the œuvre, look up the work. Everything one candidate needs. */
async function factsForCandidate(
  candidate: PlannedCandidate,
  plan: Stage2aQueryPlan,
  oeuvreRows: AckgCandidate[] | null,
  oeuvreTruncated: boolean,
  excludeSaleId: string | null,
  trace: string[],
): Promise<CandidateFacts> {
  let identity: ArtistIdentity | null = null;
  try {
    identity = await resolveArtistIdentity(candidate.name);
  } catch (err: any) {
    trace.push(`identity resolution failed for "${candidate.name}": ${err?.message ?? err}`);
  }
  const queriedAs = identity?.canonicalName ?? candidate.name;
  if (identity && foldAccents(identity.canonicalName) !== foldAccents(candidate.name)) {
    trace.push(`"${candidate.name}" resolved to the graph's "${identity.canonicalName}" (matched on ${identity.matchedOn})`);
  }

  // kId asks whether an institutional authority record exists. The graph can answer "yes"
  // — it holds the ULAN and Wikidata URLs. It can never answer "no": an artist absent from
  // ULAN is overwhelmingly a coverage fact (ULAN is ~1.3% Japan), not a statement that no
  // authority record exists anywhere. So this cell emits "true" or "unknown" and never
  // "false", which is a narrowing of what the model was previously free to assert.
  const hasAuthority = !!(identity?.ulanUrl || identity?.wikidataUrl);
  const kId: "true" | "unknown" = hasAuthority ? "true" : "unknown";
  const kIdBasis = hasAuthority
    ? `authority record in the graph: ${[identity?.ulanUrl, identity?.wikidataUrl].filter(Boolean).join(", ")}`
    : identity
      ? `the graph holds this artist (${identity.workCount} work(s)) but records no ULAN/Wikidata URL`
      : "the artist is not in the graph — absence of coverage, not absence of an authority record";

  let oeuvreMatchCount = -1;
  let oeuvreProvenanceTags: string[] = [];
  let sampleWorks: string[] = [];
  if (oeuvreRows) {
    const row = oeuvreRows.find((r) => foldAccents(r.artistName) === foldAccents(queriedAs));
    // A truncated result set cannot support a zero. The query returns artists ordered by
    // support count and cut at the limit, so an artist missing from a full page may simply
    // have fallen off the end — and 0 reads downstream as measured absence, which is the
    // one thing this cell must never say by accident. -1 is the sentinel for "not assessed".
    oeuvreMatchCount = row ? row.supportCount : oeuvreTruncated ? -1 : 0;
    if (!row && oeuvreTruncated) {
      trace.push(`"${queriedAs}" is absent from a truncated œuvre result — recorded as not assessed (-1), not as zero`);
    }
    sampleWorks = row?.sampleWorks ?? [];
    oeuvreProvenanceTags = row
      ? [
          ...(row.institutionalSupportCount > 0 ? ["institutional"] : []),
          ...(row.auctionSupportCount > 0 ? ["auction_history"] : []),
        ]
      : [];
  }

  let work = { ...EMPTY_WORK_FACTS };
  try {
    work = await runWorkQuery(queriedAs, plan, excludeSaleId, trace);
  } catch (err: any) {
    trace.push(`work query failed for "${queriedAs}": ${err?.message ?? err}`);
  }

  return { candidate, identity, queriedAs, kId, kIdBasis, oeuvreMatchCount, oeuvreProvenanceTags, sampleWorks, work };
}

export async function executeStage2aQueryPlan(
  plan: Stage2aQueryPlan,
  excludeSaleId: string | null = null,
): Promise<Stage2aGraphFacts> {
  const trace: string[] = [];
  const errors: string[] = [];

  let oeuvreRows: AckgCandidate[] | null = null;
  let oeuvreTruncated = false;
  if (plan.oeuvre) {
    try {
      oeuvreRows = await queryAckg({ ...plan.oeuvre, excludeSaleId, limit: OEUVRE_LIMIT });
      oeuvreTruncated = oeuvreRows.length >= OEUVRE_LIMIT;
      if (oeuvreTruncated) {
        trace.push(`oeuvre query hit the ${OEUVRE_LIMIT}-row limit — an absent candidate is recorded as not-assessed, never as zero`);
      }
      trace.push(`oeuvre query returned ${oeuvreRows.length} artist row(s)`);
    } catch (err: any) {
      errors.push(`oeuvre query failed: ${err?.message ?? err}`);
    }
  }

  let titleProbe: Stage2aGraphFacts["titleProbe"] = null;
  const tight = plan.titleProbeFilter;
  const loose = titlePreFilter(plan.observedTitle);
  if (plan.observedTitle && (tight || loose)) {
    try {
      let used = tight ?? loose!;
      let artists = await queryAckg({ workTitle: used, excludeSaleId, limit: TITLE_PROBE_LIMIT });
      if (artists.length === 0 && loose && loose !== used) {
        trace.push(`title probe "${used}" matched nothing — widening to "${loose}"`);
        used = loose;
        artists = await queryAckg({ workTitle: used, excludeSaleId, limit: TITLE_PROBE_LIMIT });
      }
      titleProbe = { title: plan.observedTitle, artists, truncated: artists.length >= TITLE_PROBE_LIMIT };
      trace.push(`title probe "${used}": ${artists.length} artist(s) catalogue a title containing it`);
    } catch (err: any) {
      errors.push(`title probe failed: ${err?.message ?? err}`);
    }
  }

  const candidates: CandidateFacts[] = [];
  for (const c of plan.candidates) {
    candidates.push(await factsForCandidate(c, plan, oeuvreRows, oeuvreTruncated, excludeSaleId, trace));
  }

  // Back-propagation is only meaningful from the artist-blind probe. A single artist
  // cataloguing the title is a name the title itself supplies; several is a name it does
  // not, and the honest cell for that is "".
  if (titleProbe && titleProbe.artists.length === 1 && !titleProbe.truncated) {
    const only = titleProbe.artists[0].artistName;
    for (const cf of candidates) cf.work.backPropArtist = only;
    trace.push(`title probe resolves to exactly one artist — kWorkBackPropArtist = "${only}"`);
  } else if (titleProbe) {
    trace.push(
      `title probe resolves to ${titleProbe.artists.length} artist(s)${titleProbe.truncated ? " (truncated)" : ""} — kWorkBackPropArtist left empty, the title names nobody on its own`,
    );
  }

  return { plan, candidates, titleProbe, errors, trace: [...plan.trace, ...trace] };
}

/**
 * The escape hatch. When the model names a candidate the plan did not derive — a monogram
 * it could read and `artistNameFromSignature` could not — the same fixed queries run for
 * that name. The point is not that the model never names a candidate; it is that the model
 * never chooses a QUERY.
 */
export async function lookupLateCandidate(
  name: string,
  facts: Stage2aGraphFacts,
  excludeSaleId: string | null = null,
): Promise<CandidateFacts | null> {
  const n = (name || "").trim();
  if (!n) return null;
  const trace: string[] = [];
  let oeuvreRows: AckgCandidate[] | null = null;
  let oeuvreTruncated = false;
  if (facts.plan.oeuvre) {
    try {
      oeuvreRows = await queryAckg({ ...facts.plan.oeuvre, excludeSaleId, limit: OEUVRE_LIMIT });
      oeuvreTruncated = oeuvreRows.length >= OEUVRE_LIMIT;
    } catch {
      oeuvreRows = null;
    }
  }
  const cf = await factsForCandidate(
    { name: n, source: "vea_signature", detail: "named by the evidence agent; not derivable from structured Stage 1 output" },
    facts.plan, oeuvreRows, oeuvreTruncated, excludeSaleId, trace,
  );
  if (facts.titleProbe && facts.titleProbe.artists.length === 1 && !facts.titleProbe.truncated) {
    cf.work.backPropArtist = facts.titleProbe.artists[0].artistName;
  }
  facts.candidates.push(cf);
  facts.trace.push(`late lookup for "${n}" (named by the model, absent from the plan)`, ...trace);
  return cf;
}

/** Find the facts for whatever name the model settled on, folded-equal or alias-equal. */
export function factsForName(facts: Stage2aGraphFacts, name: string | null | undefined): CandidateFacts | null {
  const n = foldAccents((name || "").trim());
  if (!n) return null;
  return (
    facts.candidates.find((c) => foldAccents(c.candidate.name) === n || foldAccents(c.queriedAs) === n) ??
    facts.candidates.find((c) => (c.identity?.alternateNames ?? []).some((a) => foldAccents(a) === n)) ??
    null
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Presentation and cell application
// ───────────────────────────────────────────────────────────────────────────────

const dimText = (d: WH) => (d.width && d.height ? `${d.width}x${d.height}mm` : "—");

/** The block that replaces the tool loop in the Stage 2a prompt: the answers, not the tools. */
export function renderStage2aGraphFacts(facts: Stage2aGraphFacts): string {
  const p = facts.plan;
  const lines: string[] = [
    "\n\nACKG GRAPH FACTS — already looked up for you, deterministically, before this call.",
    "These are the graph's actual answers. You have no graph tools and do not need them: every",
    "K_* and catalogue_* cell below is written into your report by code from these rows, so a",
    "value you transcribe differently will be overwritten. Read them as evidence and spend your",
    "judgement on which candidate is dominant, the tradition, the period, and the risks.",
    "",
    `Observed technique (graph vocabulary): ${p.observedTechnique ? `${p.observedTechnique} [${p.observedTechniqueSource === "appraiser_claim" ? "Stage 1c CLAIM, not a VEA observation" : "VEA observation"}]` : "none — nothing VEA or Stage 1c gives maps to what the graph stores"}`,
    `Object's own measurement: ${p.observedDims ? `${p.observedDims.kind} ${p.observedDims.mm.width}x${p.observedDims.mm.height}mm — ${p.observedDims.basis}. This is written into observedDimSource/observed${p.observedDims.kind[0].toUpperCase()}${p.observedDims.kind.slice(1)}Mm by code; width is the FIRST number, matching how the catalogue rows above are read.` : "Stage 1c states none, or none you can attribute to a specific dimension — fill the observed cells yourself from whatever source you have."}`,
    `Observed title scored against the graph: ${p.observedTitle ? `"${p.observedTitle}" (source: ${p.observedTitleSource})` : "none read off the object"}`,
    `Period claimed by Stage 1c: ${p.claimedPeriod ? `${p.claimedPeriod.startYear}-${p.claimedPeriod.endYear} (${p.claimedPeriod.basis})` : "none"} — context only; it is not a filter on the œuvre count below, because 30.5% of catalogued works carry no year and a date filter would drop them all`,
    p.oeuvre
      ? `Œuvre query run: ${JSON.stringify(p.oeuvre)} (all years)`
      : `Œuvre query NOT run — ${p.oeuvreRefusal}`,
  ];

  if (facts.titleProbe) {
    const t = facts.titleProbe;
    lines.push(
      "",
      `TITLE PROBE — which artists does the graph catalogue "${t.title}" to? (artist-blind, so this is the only place a title can NAME someone)`,
      t.artists.length === 0
        ? "  no catalogued work matches this title — absence of coverage, not evidence the work is wrong"
        : t.artists
            .slice(0, 8)
            .map((a) => `  ${a.artistName} — ${a.supportCount} matching work(s) [inst ${a.institutionalSupportCount} / auction ${a.auctionSupportCount}]`)
            .join("\n"),
    );
  }

  if (facts.candidates.length === 0) {
    lines.push("", "CANDIDATES: none could be derived from the structured Stage 1 output. Name the artist from",
      "the evidence if you can — the same queries will then be run for whatever you name.");
  }

  for (const c of facts.candidates) {
    lines.push(
      "",
      `CANDIDATE "${c.candidate.name}" — from ${c.candidate.source} (${c.candidate.detail})`,
      `  queried as      : "${c.queriedAs}"${c.identity ? ` [graph canonical, ${c.identity.workCount} catalogued work(s)${c.identity.ambiguousMatchCount > 1 ? `, ${c.identity.ambiguousMatchCount} duplicate node(s)` : ""}]` : " [not in the graph]"}`,
      `  kId             : ${c.kId} — ${c.kIdBasis}`,
      `  kOeuvre count   : ${c.oeuvreMatchCount === -1 ? "-1 (not assessed — the œuvre query was not run, or this artist fell outside a truncated result)" : c.oeuvreMatchCount}` +
        (c.oeuvreProvenanceTags.length ? ` [${c.oeuvreProvenanceTags.join(", ")}]` : ""),
      `  catalogued e.g. : ${c.sampleWorks.length ? c.sampleWorks.join(" | ") : "—"}`,
      c.work.queried
        ? `  work match      : ${c.work.matchedTitle ? `"${c.work.matchedTitle}"` : "no title scored"}` +
          (c.work.titleSim >= 0 ? ` — computed title similarity ${c.work.titleSim.toFixed(2)} (${c.work.titleSimBasis})` : " — not scored (no observed title)") +
          `\n  catalogued      : techniques ${c.work.catalogueTechniques.join(", ") || "—"}` +
          `\n                    medium "${c.work.catalogueMediumRaw || "—"}"` +
          `\n                    plate ${dimText(c.work.cataloguePlateMm)}  image ${dimText(c.work.catalogueImageMm)}  sheet ${dimText(c.work.catalogueSheetMm)}` +
          (c.work.editionSizes.length ? `\n                    editions ${c.work.editionSizes.join(", ")}` : "") +
          `\n  rows            : ${c.work.rowsReturned} returned, ${c.work.rowsAfterMerge} after merging duplicate work nodes` +
          (c.work.topRows.length > 1
            ? `\n  ranked rows     :\n` +
              c.work.topRows
                .map((r) => `    ${r.sim >= 0 ? r.sim.toFixed(2) : "  — "}  "${r.title}" [${r.techniques.join(", ") || "no technique"}, ${r.impressions} impr.]`)
                .join("\n")
            : "")
        : "  work match      : the work query returned nothing for this artist",
    );
  }

  if (facts.errors.length) lines.push("", `QUERY ERRORS (cells left at their not-assessed sentinel): ${facts.errors.join("; ")}`);
  return lines.join("\n");
}

export interface CellOverride {
  cell: string;
  reported: unknown;
  authoritative: unknown;
}

/**
 * Write the graph's answers into the evidence cells, over whatever the model put there.
 *
 * Returns the disagreements. They are the measurement: a model that transcribes the block
 * faithfully produces an empty list, and one that does not tells us exactly where and how
 * much. Previously this was unobservable — a mis-transcribed kWorkTitleSim was
 * indistinguishable from a real one.
 */
export function applyCandidateFacts(ev: any, cf: CandidateFacts): CellOverride[] {
  const out: CellOverride[] = [];
  const set = (obj: any, cell: string, value: unknown) => {
    // Never assign into a non-object. A model can return a whole evidence block as a JSON
    // string (Haiku did, to impressionEvidence); normalizeEvidenceBlocks parses those back,
    // but writing a cell must not be the thing that discovers it failed to.
    if (!obj || typeof obj !== "object") return;
    const prev = obj[cell];
    const same = JSON.stringify(prev) === JSON.stringify(value);
    if (!same) out.push({ cell, reported: prev, authoritative: value });
    obj[cell] = value;
  };

  const a = ev?.artistEvidence;
  set(a, "kId", cf.kId);
  set(a, "kOeuvreMatchCount", cf.oeuvreMatchCount);
  set(a, "kOeuvreProvenanceTags", cf.oeuvreProvenanceTags);

  const w = ev?.workEvidence;
  set(w, "kWorkQueried", cf.work.queried);
  set(w, "kWorkTitleSim", cf.work.titleSim);
  set(w, "kWorkMatchedTitle", cf.work.matchedTitle);
  set(w, "kWorkBackPropArtist", cf.work.backPropArtist);

  // impressionEvidence.assessable stays the model's call — it is a judgement about whether
  // a Conceptual Work was identified at all, not a graph fact. The catalogue side of the
  // comparison is a graph fact, and is written here whether or not the model asked for it.
  const i = ev?.impressionEvidence;
  set(i, "catalogueTechniques", cf.work.catalogueTechniques);
  set(i, "catalogueMediumRaw", cf.work.catalogueMediumRaw);
  set(i, "cataloguePlateMm", cf.work.cataloguePlateMm);
  set(i, "catalogueImageMm", cf.work.catalogueImageMm);
  set(i, "catalogueSheetMm", cf.work.catalogueSheetMm);

  return out;
}

/**
 * Write the object's own measurement into the observed cells, from Stage 1c.
 *
 * Separate from applyCandidateFacts because it is not candidate-specific — and it MUST run
 * whenever the catalogue side is being written, or the two halves of an axis-strict
 * comparison come from different hands. See ObservedDims.
 */
export function applyObservedDims(ev: any, plan: Stage2aQueryPlan): CellOverride[] {
  const d = plan.observedDims;
  const i = ev?.impressionEvidence;
  if (!d || !i) return [];
  const out: CellOverride[] = [];
  const set = (cell: string, value: unknown) => {
    const prev = i[cell];
    if (JSON.stringify(prev) !== JSON.stringify(value)) out.push({ cell, reported: prev, authoritative: value });
    i[cell] = value;
  };
  const target = d.kind === "plate" ? "observedPlateMm" : d.kind === "image" ? "observedImageMm" : "observedSheetMm";
  set(target, d.mm);
  set("observedDimSource", "appraiser");
  return out;
}

/** Clear the graph cells to their not-assessed sentinels — used when no candidate resolves,
 *  so a model's remembered numbers cannot survive into the tree unbacked. */
export function clearGraphCells(ev: any): CellOverride[] {
  return applyCandidateFacts(ev, {
    candidate: { name: "", source: "vea_signature", detail: "" },
    identity: null, queriedAs: "", kId: "unknown", kIdBasis: "no candidate resolved",
    oeuvreMatchCount: -1, oeuvreProvenanceTags: [], sampleWorks: [], work: { ...EMPTY_WORK_FACTS },
  });
}
