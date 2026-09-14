/**
 * Attributed-lot entry path — docs/plans/2026-09-13-attributed-lot-valuation.md, step 2.
 *
 * The pipeline was built to DISCOVER an attribution blind. The real use case hands it one:
 * an auction lot whose catalogue already prints the artist and title. This module turns
 * that from discovery into VERIFICATION and pricing:
 *
 *   1. `mergeClaimIntoAppraiserInput` — the catalogue's artist/title/technique/dimensions/
 *      edition/citations enter the Stage 2a plan as `documented_fact` claims (they are what
 *      the house printed, not a guess). The evidence tree still runs: a documented_fact
 *      appraiser claim VOTES (two_pass_attribution.ts, source A) but is one source, so the
 *      strict Scenario-1 pair is unreachable from the claim alone — a house's attribution
 *      cannot short-circuit the tree.
 *   2. `verifyAttributedLot` — does the physical evidence agree with the ConceptualWork node
 *      the claim resolves to? Artist (identity + tree verdict), work (ADR-0017 identity),
 *      image (Stage 1d), technique (VEA vs catalogued), dimensions (tree + catalogue vs
 *      node), edition (claimed size vs the node's edition runs). Divergences are named.
 *   3. `routeAttributedLot` — resolved node + same-work comps + nothing diverging + not a
 *      Scenario 2/4/5 lot → Stage 2b is SKIPPED and Stage 3 reasons over facts already on
 *      the table. Otherwise Stage 2b runs exactly as today.
 *   4. `synthesizeAttributionResult` — the ASA-shaped attribution Stage 3 expects, built
 *      from the claim, the graph and the verification when 2b did not run.
 *   5. `buildAttributedLotValuationBlock` — the Stage 3 evidence block. The measured
 *      anchor is the catalogue estimate x 0.82 (step 1: MAE(log) 0.24-0.29 against 0.40-0.53
 *      for same-work comps); the graph supplies liquidity and a divergence flag; the
 *      artist's fitted attribute multipliers are NOT applied (step 6 gate failed) — comp
 *      attribute differences are listed as facts only.
 *
 * Everything here is pure except where a function's name says query; the appraiser wires it.
 */
import type {
  AppraiserInputResult,
  ASAAttributionResult,
  Stage1dResult,
  TriageResult,
  VisualExtractionResult,
} from "../types.js";
import type { AuctionComparable, ComparablesResult } from "./knowledge_graph/query_comparables.js";
import type { WorkFacts } from "./knowledge_graph/query_work_facts.js";
import type { WorkIdentityBasis } from "./knowledge_graph/work_identity.js";
import { foldAccents, normalizeTitleKey } from "./knowledge_graph/unaccent.js";
import { isSurnameTypoVariant } from "./knowledge_graph/typo_tolerance.js";
import { priceAttrsOfComparable, priceAttrsOfLot } from "./knowledge_graph/price_attrs.js";
import { adjustmentBetween, type ArtistPriceProfile, type PriceAttrs } from "./knowledge_graph/artist_price_profile.js";
import { mapTechniqueToAckgVocabulary } from "./stage2a_query_plan.js";

// ── input ─────────────────────────────────────────────────────────────────────

export type ArtistQualifier = "certain" | "attributed" | "circle" | "studio" | "follower" | "after" | "manner" | "school" | "unknown" | string;

/** The lot as the house printed it. Everything optional but the artist. */
export interface CatalogueAttribution {
  artist: string;
  /** "certain" is the house's unqualified attribution; anything else ("after", "attributed",
   *  "circle"...) is NOT an authorship claim and never votes as one. */
  artistQualifier?: ArtistQualifier | null;
  title?: string | null;
  year?: string | null;
  /** The medium line as printed ("etching and aquatint in colours on wove"). */
  medium?: string | null;
  editionNote?: string | null;
  editionSize?: number | null;
  signed?: boolean | null;
  dimensions?: Array<{ kind: string; widthCm: number | null; heightCm: number | null }> | null;
  catalogueRefs?: string[] | null;
  estimateLow?: number | null;
  estimateHigh?: number | null;
  estimateCurrency?: string | null;
  house?: string | null;
  saleId?: string | null;
  lotNumber?: number | null;
  /** ISO date. For a past sale it cuts comps and sell-through so nothing later leaks in. */
  saleDate?: string | null;
  lotUrl?: string | null;
  /** The header lines as printed — recorded as the claim's source excerpt. */
  sourceExcerpt?: string | null;
}

/**
 * A schema-shaped VisualExtractionResult standing for "Stage 1a was not run". The attributed
 * path does not run the vision stage: everything it would read (technique, signature,
 * edition, dimensions, condition) is what the house printed and Stage 1c already carries,
 * and a frontier vision model looking at a catalogued image is a leakage surface — it can
 * recognise the sale. `haltRecommended` stays false; confidence 0 plus the flag tells Stage
 * 2a it is looking at an absence of observation, not an observation of absence.
 */
export function veaNotRun(): VisualExtractionResult {
  return {
    schemaVersion: "VEA-1.1",
    inspectionTimestamp: new Date().toISOString(),
    imagesReceived: { primaryScan: false, supplementaryScanCount: 0 },
    imageAuthenticity: { haltRecommended: false } as any,
    titleInscriptions: [], signatures: [], editionInfo: [], editionInfoAbsent: true, printingTechniques: [],
    plateMark: {} as any, dimensions: {} as any, paper: {} as any, condition: {} as any, inkAndColour: {} as any,
    stampsAndLabels: [], composition: {} as any, photographicQuality: {} as any, visualEvidenceHighlights: [],
    overallExtractionConfidence: 0,
    lowConfidenceFlags: [
      "Stage 1a (Visual Extraction Agent) WAS NOT RUN in this appraisal — no image was examined and no " +
        "physical observation exists. Every field below is empty because nothing was looked at, NOT " +
        "because the work lacks those features. Technique, signature, edition, dimensions and condition " +
        "come from the catalogue (Stage 1c) instead.",
    ],
    provisionalOutput: true,
  } as VisualExtractionResult;
}

// ── 1. the claim enters Stage 2a as documented_fact ────────────────────────────

export function emptyAppraiserInput(): AppraiserInputResult {
  return {
    schemaVersion: "AIA-1.0",
    inputReceived: { inscribedMarksNotes: false, provenanceNotes: false, conditionNotes: false, catalogueNotes: false },
    claimedAttribution: { artist: null, title: null, period: null, technique: null, status: "absent", sourceField: null, sourceExcerpt: null },
    inscriptionClaims: { signatureClaim: null, editionClaim: null, editionSizeClaim: null, monogramOrStampClaim: null, status: "absent" },
    provenanceChain: [],
    conditionClaims: [],
    catalogueReferences: [],
    literatureOrExhibitionClaims: [],
    dimensionsClaim: null,
    paperOrSupport: null,
    rawNotes: { inscribedMarksNotes: null, provenanceNotes: null, conditionNotes: null, catalogueNotes: null },
    overallExtractionConfidence: 1,
    lowConfidenceFlags: [],
  };
}

export function isAuthorshipClaim(q: ArtistQualifier | null | undefined): boolean {
  return !q || q === "certain";
}

/** Prefer image/plate dims for the claim (what the tree compares first), else sheet. */
export function primaryDimension(dims: CatalogueAttribution["dimensions"]): { kind: string; widthCm: number | null; heightCm: number | null } | null {
  if (!dims?.length) return null;
  const rank = (k: string) => (/image|plate|block/i.test(k) ? 0 : /sheet/i.test(k) ? 1 : 2);
  return [...dims].filter((d) => d.widthCm != null || d.heightCm != null).sort((a, b) => rank(a.kind) - rank(b.kind))[0] ?? null;
}

/**
 * Overlay the catalogue's structured claim on whatever Stage 1c extracted from the free-text
 * notes. The claim WINS on attribution/edition/dimensions/citations (it is the house's
 * printed record); provenance and condition claims stay Stage 1c's.
 */
export function mergeClaimIntoAppraiserInput(base: AppraiserInputResult | null | undefined, claim: CatalogueAttribution): AppraiserInputResult {
  const out: AppraiserInputResult = JSON.parse(JSON.stringify(base ?? emptyAppraiserInput()));
  const authorship = isAuthorshipClaim(claim.artistQualifier);
  const header = claim.sourceExcerpt ?? [claim.artistQualifier && !authorship ? `${claim.artistQualifier} ${claim.artist}` : claim.artist, claim.title, claim.year].filter(Boolean).join(", ");
  out.inputReceived.catalogueNotes = true;
  out.claimedAttribution = {
    // A qualified attribution ("after Picasso") is recorded with its qualifier so the plan
    // still queries the named artist's oeuvre, but the evidence cell override never turns it
    // into an authorship vote — see AttributedLotAppraiser.overrideEvidenceCells.
    artist: authorship ? claim.artist : `${claim.artistQualifier} ${claim.artist}`,
    title: claim.title ?? null,
    period: claim.year ?? null,
    technique: claim.medium ?? null,
    status: "documented_fact",
    sourceField: "catalogueNotes",
    sourceExcerpt: header || null,
  };
  const editionText = [claim.editionNote, claim.editionSize ? `edition of ${claim.editionSize}` : null].filter(Boolean).join("; ");
  if (claim.editionSize != null || claim.editionNote || claim.signed != null) {
    out.inscriptionClaims = {
      signatureClaim: claim.signed == null ? out.inscriptionClaims.signatureClaim : claim.signed ? "signed (per catalogue)" : "unsigned (per catalogue)",
      editionClaim: editionText || out.inscriptionClaims.editionClaim,
      editionSizeClaim: claim.editionSize ?? out.inscriptionClaims.editionSizeClaim,
      monogramOrStampClaim: out.inscriptionClaims.monogramOrStampClaim,
      status: "documented_fact",
    };
  }
  const dim = primaryDimension(claim.dimensions);
  if (dim) out.dimensionsClaim = { widthCm: dim.widthCm, heightCm: dim.heightCm, kind: dim.kind, source: "regex" };
  if (claim.catalogueRefs?.length) {
    const have = new Set(out.catalogueReferences.map((r) => r.ref));
    for (const ref of claim.catalogueRefs) if (!have.has(ref)) out.catalogueReferences.push({ ref, source: "regex" });
  }
  return out;
}

// ── 2. verification ────────────────────────────────────────────────────────────

export type CheckStatus = "agrees" | "diverges" | "unassessable";

export interface WorkResolution {
  /** "claim": resolved from the catalogue's title/citations; "image_match": from the Stage 1d
   *  best-match title (workTitleFromImageMatch), then resolved by exact graph name. */
  via?: "claim" | "image_match";
  basis: WorkIdentityBasis | null;
  workIds: string[];
  matchedNames: string[];
  ambiguousAt: WorkIdentityBasis | null;
  ambiguousNames: string[];
}

export interface AttributedLotVerification {
  artist: {
    claimed: string; qualifier: ArtistQualifier; canonical: string | null; inGraph: boolean;
    treeVerdict: string | null; treeConfidence: string | null; treeArtist: string | null; contradictingIdentities: string[];
    status: "agrees" | "unresolved" | "diverges" | "not_in_graph";
  };
  work: {
    claimedTitle: string | null; resolvedName: string | null; basis: WorkIdentityBasis | null; via: "claim" | "image_match" | null; nodeCount: number;
    ambiguousAt: WorkIdentityBasis | null; impressionCount: number | null;
    status: "resolved" | "ambiguous" | "unresolved";
  };
  image: {
    bestArtist: string | null; bestTitle: string | null; dino: number | null; confidence: string | null;
    status: "agrees" | "different_work_same_artist" | "different_artist" | "no_match" | "not_run";
  };
  technique: { observed: string | null; claimed: string | null; catalogued: string[]; treeMatch: string | null; status: CheckStatus };
  dimensions: { claimed: string | null; observedSource: string | null; treeMatch: string | null; catalogueVsNode: CheckStatus; status: CheckStatus };
  edition: { claimedSize: number | null; cataloguedSizes: number[]; status: "agrees" | "unseen_edition" | "unassessable" };
  impressionDivergence: string | null;
  scenario: number | null;
  /** A tree "conflict" that resolved to spelling variants of the claimed artist, if any. */
  spellingNote: string | null;
  divergences: string[];
  verdict: "verified" | "partially_verified" | "divergent" | "unverifiable";
}

const fold = (s: string | null | undefined) => foldAccents((s ?? "").trim()).toLowerCase();
const sameName = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && fold(a) === fold(b);

const NAME_NOISE = /[.,()\[\]"']/g;
const tokensOf = (s: string) => fold(s).replace(NAME_NOISE, " ").split(/\s+/).filter(Boolean);

/**
 * Are two artist strings the same person for VERIFICATION purposes? Exact (accent-folded)
 * equality, equality of their graph identities when both resolved, or — for the model's
 * abbreviated spellings ("G Braque", "P. Picasso") — the same surname with a compatible
 * first name or initial. An illegible or single-token read ("E. [illegible]") never matches:
 * one letter is not a name. `sameArtist` below adds one typed slip in the surname. This is a
 * read-side comparison, never a merge rule.
 */
export function namesCompatible(a: string | null | undefined, b: string | null | undefined, canonicalA?: string | null, canonicalB?: string | null): boolean {
  if (!a || !b) return false;
  if (sameName(a, b)) return true;
  if (canonicalA && canonicalB && sameName(canonicalA, canonicalB)) return true;
  const ta = tokensOf(a), tb = tokensOf(b);
  if (!ta.length || !tb.length) return false;
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false;
  // A bare surname ("Picasso") is the same person as "Pablo Picasso"; a one- or two-letter
  // token is an initial, not a name, and never matches on its own.
  if (ta.length === 1 || tb.length === 1) {
    const single = ta.length === 1 ? ta[0] : tb[0];
    return single.length >= 3;
  }
  const fa = ta[0], fb = tb[0];
  if (fa === fb) return true;
  return (fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb));
}

/** `namesCompatible`, plus a single typing slip in the surname — a house's catalogue is typed
 *  by hand ("Storm Thorgeson" for the graph's "Thorgerson", Roseberys A0793/168). */
export function sameArtist(a: string | null | undefined, b: string | null | undefined, canonicalA?: string | null, canonicalB?: string | null): boolean {
  return namesCompatible(a, b, canonicalA, canonicalB) || isSurnameTypoVariant(a, b);
}

/** Citations in brackets and a trailing ", from <series>" removed, then normalised. */
function coreTitleKey(title: string): string {
  const stripped = title
    .replace(/\s*[\[(][^\])]*\b(?:[A-Z][A-Za-z&.\s-]{1,25}\s+[\dIVX][\d.\-IVXa-z]*)[^\])]*[\])]\s*/g, " ")
    .replace(/,\s*from\s+(?:the\s+)?[^,]+$/i, "");
  return normalizeTitleKey(stripped);
}

/**
 * When the claim's title does not resolve, the Stage 1d best match can name the node: same
 * artist as the claim, a usable DINOv2 score, and the lot's title is the graph title's core
 * (the graph name often carries the series and the citation the house dropped — "Auti Te
 * Pape (Women at the River), from the Noa Noa Suite (Guérin 96; Kornfeld 16.II.D.b)" against
 * a catalogue "Auti Te Pape (Women at the River)"). Returns the graph title to resolve by
 * EXACT name, or null. Read-side only.
 */
export function workTitleFromImageMatch(claim: CatalogueAttribution, stage1d: Stage1dResult | null | undefined, canonicalArtist: string | null, minDino = 0.8): string | null {
  const bestTitle = stage1d?.bestMatchConceptualWorkTitle ?? stage1d?.candidateMatches?.[0]?.conceptualWorkTitle ?? null;
  const bestArtist = stage1d?.bestMatchArtist ?? stage1d?.candidateMatches?.[0]?.artistName ?? null;
  const dino = stage1d?.dinov2SimilarityScore ?? stage1d?.candidateMatches?.[0]?.dinov2Similarity ?? null;
  if (!bestTitle || !bestArtist || !claim.title) return null;
  if (dino == null || dino < minDino) return null;
  if (!namesCompatible(bestArtist, claim.artist, null, canonicalArtist) && !sameName(bestArtist, canonicalArtist)) return null;
  const lotKey = normalizeTitleKey(claim.title);
  if (!lotKey || lotKey.length < 6) return null;
  // Exact after stripping the series suffix and bracketed citations — never a prefix match,
  // which would accept a series sibling ("Auti Te Pape II") for "Auti Te Pape".
  return coreTitleKey(bestTitle) === lotKey || normalizeTitleKey(bestTitle) === lotKey ? bestTitle : null;
}

/**
 * The attributed-lot rule for the Stage 2a misattributionRisk cell (plan step 4, applied
 * here first): the model's boolean is kept ONLY when some source actually names someone
 * other than the claimed artist — the agent's dominant candidate, the VEA signature read, or
 * the reverse-image search. With nobody else named, "misattribution risk" on a house-
 * attributed lot is the unstable model-set boolean ADR-0018 identified (4 of 5 unstable
 * lots), and it would route every lot to Scenario 2. forgeryRisk is never touched.
 */
export function deriveMisattributionRisk(
  ev: { artistEvidence?: { dominantCandidateName?: string; veaNamesArtist?: boolean; veaArtistName?: string; reverseImageNamesArtist?: boolean; reverseImageArtistName?: string }; riskFlags?: { misattributionRisk?: boolean } },
  claim: CatalogueAttribution,
  canonicalArtist?: string | null,
): { keep: boolean; reason: string } {
  const flagged = !!ev.riskFlags?.misattributionRisk;
  if (!flagged) return { keep: false, reason: "agent did not flag it" };
  const a = ev.artistEvidence ?? {};
  const others: string[] = [];
  const isOther = (n: string | undefined) => !!n?.trim() && !namesCompatible(n, claim.artist, null, canonicalArtist) && !sameName(n, canonicalArtist);
  if (isOther(a.dominantCandidateName)) others.push(`dominant candidate "${a.dominantCandidateName}"`);
  if (a.veaNamesArtist && isOther(a.veaArtistName)) others.push(`VEA signature "${a.veaArtistName}"`);
  if (a.reverseImageNamesArtist && isOther(a.reverseImageArtistName)) others.push(`reverse image "${a.reverseImageArtistName}"`);
  return others.length
    ? { keep: true, reason: `another artist is named: ${others.join(", ")}` }
    : { keep: false, reason: `no source names anyone but "${claim.artist}"` };
}
const techKey = (s: string | null | undefined) => fold(mapTechniqueToAckgVocabulary(s) ?? s);
const techOverlap = (a: string | null, list: string[]) => !!a && list.some((t) => { const k = techKey(t); return k === techKey(a) || k.includes(techKey(a)) || techKey(a).includes(k); });

function dimsAgree(claim: { widthCm: number | null; heightCm: number | null }, cat: [number, number][], tol: number): CheckStatus {
  if (claim.widthCm == null || claim.heightCm == null || !cat.length) return "unassessable";
  const w = claim.widthCm, h = claim.heightCm;
  const near = (a: number, b: number) => Math.abs(a - b) <= tol * Math.max(a, b);
  return cat.some(([cw, ch]) => (near(w, cw) && near(h, ch)) || (near(w, ch) && near(h, cw))) ? "agrees" : "diverges";
}

export function verifyAttributedLot(input: {
  claim: CatalogueAttribution;
  canonicalArtist: string | null;
  triage: TriageResult | null;
  vea: VisualExtractionResult | null;
  stage1d: Stage1dResult | null | undefined;
  work: WorkResolution | null;
  workFacts: WorkFacts | null;
  /** The graph identity of the tree's settled artist, when it resolved (triage.artistAttribution.artistIdentity). */
  treeArtistCanonical?: string | null;
}): AttributedLotVerification {
  const { claim, canonicalArtist, triage, vea, stage1d, work, workFacts, treeArtistCanonical } = input;
  const qualifier: ArtistQualifier = claim.artistQualifier || "certain";
  const divergences: string[] = [];
  /** Set when a tree "conflict" turned out to be two spellings of the claimed artist. */
  let spellingNote: string | null = null;

  // artist
  const aa = triage?.artistAttribution ?? null;
  const treeArtist = aa?.artistName ?? null;
  let artistStatus: AttributedLotVerification["artist"]["status"];
  if (!canonicalArtist) artistStatus = "not_in_graph";
  else if (!aa || aa.verdict === "not_attributed") artistStatus = "unresolved";
  else if (aa.verdict === "conflict") {
    // A conflict between two SPELLINGS of the claimed artist is not a conflict about who made
    // the print. It is a catalogue typo, and treating it as a divergence sends an otherwise
    // clean lot to a specialist search (measured, A0793/168).
    const contradicting = aa.contradictingIdentities ?? [];
    const others = contradicting.filter((n) => !sameArtist(n, claim.artist, null, canonicalArtist) && !sameName(n, canonicalArtist));
    if (contradicting.length > 0 && others.length === 0) {
      artistStatus = "agrees";
      spellingNote = `the evidence tree reported competing identities (${contradicting.join(", ")}) that are spelling variants of the catalogue's "${claim.artist}" — read as one artist`;
    } else {
      artistStatus = "diverges";
      divergences.push(`artist: the evidence tree reports a CONFLICT (${others.join(", ") || "competing identities"}) against the catalogue's "${claim.artist}"`);
    }
  }
  else if (treeArtist && !sameArtist(treeArtist, claim.artist, treeArtistCanonical ?? null, canonicalArtist) && !sameName(treeArtist, canonicalArtist)) { artistStatus = "diverges"; divergences.push(`artist: the evidence tree attributes to "${treeArtist}", the catalogue says "${claim.artist}"`); }
  else artistStatus = "agrees";

  // work
  const workStatus: AttributedLotVerification["work"]["status"] = work?.workIds.length ? "resolved" : work?.ambiguousAt ? "ambiguous" : "unresolved";

  // image (Stage 1d)
  let imageStatus: AttributedLotVerification["image"]["status"] = "not_run";
  const best = stage1d?.candidateMatches?.[0] ?? null;
  const bestArtist = stage1d?.bestMatchArtist ?? best?.artistName ?? null;
  const bestTitle = stage1d?.bestMatchConceptualWorkTitle ?? best?.conceptualWorkTitle ?? null;
  const dino = stage1d?.dinov2SimilarityScore ?? best?.dinov2Similarity ?? null;
  const conf = stage1d?.matchConfidence ?? null;
  if (stage1d) {
    if (!bestArtist) imageStatus = "no_match";
    else if (sameName(bestArtist, canonicalArtist) || sameArtist(bestArtist, claim.artist, null, canonicalArtist)) {
      const names = [...(work?.matchedNames ?? []), ...(workFacts?.names ?? []), claim.title ?? ""].filter(Boolean).map(normalizeTitleKey);
      imageStatus = bestTitle && names.includes(normalizeTitleKey(bestTitle)) ? "agrees" : "different_work_same_artist";
    } else if (conf === "HIGH") { imageStatus = "different_artist"; divergences.push(`image: the nearest catalogued image (DINOv2 ${dino?.toFixed(3) ?? "?"}, HIGH) is by "${bestArtist}", not "${claim.artist}"`); }
    else imageStatus = "no_match";
  }

  // technique
  const techRows = [...(vea?.printingTechniques ?? [])].sort((a, b) => (b.techniqueConfidence ?? 0) - (a.techniqueConfidence ?? 0));
  const observedTech = techRows[0]?.technique ?? null;
  const claimedTech = claim.medium ?? null;
  const catalogued = workFacts?.techniques ?? [];
  const treeTech = triage?.impressionAssessment?.techniqueMatch ?? null;
  let techStatus: CheckStatus = "unassessable";
  if (treeTech === "true") techStatus = "agrees";
  else if (treeTech === "false") techStatus = "diverges";
  else if (observedTech && catalogued.length) techStatus = techOverlap(observedTech, catalogued) ? "agrees" : "diverges";
  else if (observedTech && claimedTech) techStatus = techOverlap(observedTech, [claimedTech]) ? "agrees" : "diverges";
  if (techStatus === "diverges") divergences.push(`technique: observed "${observedTech ?? "?"}" against catalogued ${catalogued.length ? catalogued.join("/") : `"${claimedTech}"`}`);

  // dimensions
  const dim = primaryDimension(claim.dimensions);
  const treeDim = triage?.impressionAssessment?.dimensionMatch ?? null;
  let catVsNode: CheckStatus = "unassessable";
  if (dim && workFacts) {
    const cat = /sheet/i.test(dim.kind) ? workFacts.sheetDimsCm : [...workFacts.imageDimsCm, ...workFacts.plateDimsCm];
    catVsNode = dimsAgree(dim, cat, /sheet/i.test(dim.kind) ? 0.08 : 0.05);
    if (catVsNode === "unassessable" && workFacts.sheetDimsCm.length && !/sheet/i.test(dim.kind)) catVsNode = "unassessable";
  }
  let dimStatus: CheckStatus = "unassessable";
  if (treeDim === "true") dimStatus = "agrees";
  else if (treeDim === "false") dimStatus = "diverges";
  else dimStatus = catVsNode;
  if (dimStatus === "diverges") divergences.push(`dimensions: ${treeDim === "false" ? "observed measurements do not match the catalogued work" : `the catalogue's ${dim?.widthCm} x ${dim?.heightCm} cm (${dim?.kind}) matches none of the node's recorded ${dim && /sheet/i.test(dim.kind) ? "sheet" : "image/plate"} sizes`}`);

  // edition
  const sizes = workFacts?.editionSizes ?? [];
  const editionStatus: AttributedLotVerification["edition"]["status"] =
    claim.editionSize == null || !sizes.length ? "unassessable" : sizes.includes(claim.editionSize) ? "agrees" : "unseen_edition";

  // impression divergence from the tree
  const impDiv = triage?.impressionAssessment?.divergence ?? null;
  if (impDiv && ["later_edition", "medium_divergence", "reproduction"].includes(impDiv)) divergences.push(`impression: the evidence tree reports ${impDiv}`);

  const scenario = triage?.routingDecision?.scenario ?? null;
  let verdict: AttributedLotVerification["verdict"];
  if (divergences.length) verdict = "divergent";
  else if (artistStatus === "not_in_graph" || (artistStatus === "unresolved" && workStatus !== "resolved")) verdict = "unverifiable";
  else if (workStatus === "resolved" && (imageStatus === "agrees" || techStatus === "agrees" || dimStatus === "agrees")) verdict = "verified";
  else verdict = "partially_verified";

  return {
    artist: { claimed: claim.artist, qualifier, canonical: canonicalArtist, inGraph: !!canonicalArtist, treeVerdict: aa?.verdict ?? null, treeConfidence: aa?.confidence ?? null, treeArtist, contradictingIdentities: aa?.contradictingIdentities ?? [], status: artistStatus },
    work: { claimedTitle: claim.title ?? null, resolvedName: work?.matchedNames[0] ?? workFacts?.names[0] ?? null, basis: work?.basis ?? null, via: work?.via ?? null, nodeCount: work?.workIds.length ?? 0, ambiguousAt: work?.ambiguousAt ?? null, impressionCount: workFacts?.impressionCount ?? null, status: workStatus },
    image: { bestArtist, bestTitle, dino, confidence: conf, status: imageStatus },
    technique: { observed: observedTech, claimed: claimedTech, catalogued, treeMatch: treeTech, status: techStatus },
    dimensions: { claimed: dim ? `${dim.widthCm ?? "?"} x ${dim.heightCm ?? "?"} cm (${dim.kind})` : null, observedSource: vea?.dimensions?.sourceImage ?? null, treeMatch: treeDim, catalogueVsNode: catVsNode, status: dimStatus },
    edition: { claimedSize: claim.editionSize ?? null, cataloguedSizes: sizes, status: editionStatus },
    impressionDivergence: impDiv,
    scenario,
    spellingNote,
    divergences,
    verdict,
  };
}

// ── 3. routing ─────────────────────────────────────────────────────────────────

export interface AttributedLotRouting {
  stage2bSkipped: boolean;
  reason: string;
  scenario: number | null;
  sameWorkComps: number;
}

/** Stage 2b fires only on Scenario 2/4/5, on divergence, on a qualified attribution, or when
 *  the graph has no same-work comps for the resolved node. */
export function routeAttributedLot(v: AttributedLotVerification, sameWorkComps: number): AttributedLotRouting {
  const s = v.scenario;
  const why: string[] = [];
  if (!isAuthorshipClaim(v.artist.qualifier)) why.push(`qualified attribution "${v.artist.qualifier}"`);
  if (v.verdict === "divergent") why.push(`verification divergent (${v.divergences.length})`);
  if (v.verdict === "unverifiable") why.push("verification unverifiable");
  if (v.work.status !== "resolved") why.push(`work ${v.work.status}`);
  if (sameWorkComps < 1) why.push("no same-work comps in the graph");
  if (s === 2 || s === 4 || s === 5) why.push(`Scenario ${s}`);
  const skip = why.length === 0;
  return {
    stage2bSkipped: skip,
    reason: skip
      ? `resolved node (${v.work.basis}) + ${sameWorkComps} same-work comp(s) + verification ${v.verdict} + Scenario ${s ?? "?"}`
      : `Stage 2b required: ${why.join("; ")}`,
    scenario: s,
    sameWorkComps,
  };
}

// ── 4. synthesised attribution when 2b is skipped ──────────────────────────────

export const ATTRIBUTED_LOT_SPECIALIST_KEY = "attributed_lot_graph_verified";

export function synthesizeAttributionResult(input: {
  claim: CatalogueAttribution;
  canonicalArtist: string | null;
  verification: AttributedLotVerification;
  workFacts: WorkFacts | null;
  triage: TriageResult | null;
}): ASAAttributionResult {
  const { claim, canonicalArtist, verification: v, workFacts, triage } = input;
  const level: ASAAttributionResult["attributionConclusion"]["attributionLevel"] =
    v.verdict === "verified" && v.artist.treeConfidence === "HIGH" ? "definitive" : "probable";
  const confidence = v.verdict === "verified" ? (v.artist.treeConfidence === "HIGH" ? 0.92 : 0.85) : 0.75;
  const chain = [
    `Catalogue attribution "${claim.artist}"${claim.title ? ` — "${claim.title}"` : ""} entered as a documented_fact claim`,
    v.artist.canonical ? `Artist resolved in the ACKG as "${v.artist.canonical}"; evidence tree ${v.artist.treeVerdict}/${v.artist.treeConfidence ?? "-"}` : "Artist not in the ACKG",
    v.work.resolvedName ? `Work resolved to catalogued "${v.work.resolvedName}" via ${v.work.basis}${v.work.impressionCount != null ? ` (${v.work.impressionCount} recorded impressions)` : ""}` : "Work not resolved",
    `Image: ${v.image.status}${v.image.dino != null ? ` (DINOv2 ${v.image.dino.toFixed(3)})` : ""}; technique: ${v.technique.status}; dimensions: ${v.dimensions.status}; edition: ${v.edition.status}`,
  ];
  const refs = claim.catalogueRefs ?? [];
  return {
    schemaVersion: "ASA-1.0",
    specialistConfigUsed: ATTRIBUTED_LOT_SPECIALIST_KEY,
    attributionConclusion: {
      attributedArtist: canonicalArtist ?? claim.artist,
      attributedArtistNative: null,
      attributionLevel: level,
      attributionConfidence: confidence,
      attributionEvidenceChain: chain,
      attributionCounterEvidence: v.divergences,
      workTitle: v.work.resolvedName ?? claim.title ?? null,
      workTitleNative: null,
      dateOrPeriod: claim.year ?? null,
      technique: claim.medium ?? v.technique.catalogued[0] ?? null,
      confirmedSeriesName: null,
    },
    catalogueRaisonne: {
      referenceFound: refs.length > 0,
      catalogueName: null,
      plateOrCatalogueNumber: refs.length ? refs.join("; ") : null,
      catalogueEditionInfo: workFacts?.editionSizes.length ? `Recorded edition sizes for this work: ${workFacts.editionSizes.join(", ")}` : null,
      humanReferenceRequired: false,
    },
    reprintForgeryAssessment: { reprintForgeryRisk: triage?.riskFlags?.reprintRisk || triage?.riskFlags?.forgeryRisk ? "MEDIUM" : "LOW", physicalExaminationRecommended: !!triage?.riskFlags?.physicalExaminationRequired },
    seriesAndEditionIdentification: {
      seriesConfirmed: false,
      seriesName: null,
      editionType: "unknown",
      editionNotes: [claim.editionNote, claim.editionSize ? `edition of ${claim.editionSize} (catalogue)` : null, v.edition.status === "unseen_edition" ? `the graph has not recorded an edition of ${claim.editionSize} for this work (seen: ${v.edition.cataloguedSizes.join(", ")})` : null].filter(Boolean).join("; ") || null,
    },
    valuationRelevantFindings: {
      impressionPeriod: null,
      conditionNotes: null,
      rarityFactors: [],
      discountFactors: [],
      keyValueDrivers: [claim.signed ? "signed per catalogue" : claim.signed === false ? "unsigned per catalogue" : null, claim.editionSize ? `edition of ${claim.editionSize}` : null].filter((x): x is string => !!x),
    },
    researchConfidenceSummary: { overallAttributionConfidence: confidence, humanEscalationRequired: false, humanEscalationReason: null, physicalExaminationRequired: !!triage?.riskFlags?.physicalExaminationRequired },
    unresolvedQuestions: [],
    attributionChallengeAssessment: { skepticModeEngaged: false, verdict: "NOT_APPLICABLE", challengeNarrative: null },
    auctionComps: [],
  };
}

// ── 5. the Stage 3 evidence block ──────────────────────────────────────────────

/** Measured 2026-09-13 on 2 x 2,500 Roseberys/Forum lots (plan step 1). */
export const ESTIMATE_DRIFT = 0.82;

/** A lone same-work comp older than this is history, not a read on today's market: the
 *  divergence base rates were measured over lots whose comps sat inside the sale's own
 *  10-year window, and a single stale sale is the thinnest possible slice of that. Roseberys
 *  A0793/64 cut 41% off the anchor on one 2017 hammer. */
export const LONE_COMP_MAX_AGE_YEARS = 3;

/** Years between an ISO date and the lot's sale (or today, for an upcoming lot). */
export function compAgeYears(compDate: string | null | undefined, saleDate: string | null | undefined): number | null {
  if (!compDate) return null;
  const t = Date.parse(compDate.slice(0, 10));
  if (Number.isNaN(t)) return null;
  const ref = saleDate ? Date.parse(saleDate.slice(0, 10)) : Date.now();
  if (Number.isNaN(ref)) return null;
  return (ref - t) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Does the same-work comp set carry a directional signal at all?
 *
 * Two or more prior sales always do. ONE does only when it is recent: the measured base rates
 * ("comps >1.5x the anchor -> 33% above high", "<0.67x -> 62% below low") come from a bucket
 * analysis over lots with same-work comps, and a single sale from years ago is a weaker
 * instrument than that analysis ever tested. Below the bar the comp is still shown to Stage 3
 * as evidence — it just does not arrive labelled as a directional flag.
 */
export function divergenceSignalUsable(comps: { saleDate: string | null }[], saleDate: string | null | undefined): { usable: boolean; reason: string } {
  if (comps.length >= 2) return { usable: true, reason: `${comps.length} prior sales` };
  if (comps.length === 0) return { usable: false, reason: "no same-work sales" };
  const age = compAgeYears(comps[0].saleDate, saleDate);
  if (age == null) return { usable: false, reason: "the single prior sale carries no date" };
  return age <= LONE_COMP_MAX_AGE_YEARS
    ? { usable: true, reason: `one prior sale, ${age.toFixed(1)} years old` }
    : { usable: false, reason: `the only prior sale is ${age.toFixed(1)} years old (over ${LONE_COMP_MAX_AGE_YEARS})` };
}

/** The lot's pricing attributes by the trainer's rules — plate/image dimensions before sheet,
 *  as train_price_model.dims_cm reads them, so a comp and the lot are banded the same way. */
export function lotPriceAttrs(claim: CatalogueAttribution): PriceAttrs {
  const use = primaryDimension(claim.dimensions);
  return priceAttrsOfLot({
    text: [claim.medium, claim.editionNote].filter(Boolean).join(", "),
    signed: claim.signed ?? null,
    editionSize: claim.editionSize ?? null,
    widthCm: use?.widthCm ?? null,
    heightCm: use?.heightCm ?? null,
  });
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const gbp = (n: number) => Math.round(n).toLocaleString("en-GB");

export function describeCompDifferences(lot: PriceAttrs, comp: AuctionComparable): string[] {
  const c = priceAttrsOfComparable(comp);
  const out: string[] = [];
  if (lot.signature !== c.signature) out.push(`signature ${c.signature} vs lot ${lot.signature}`);
  if (lot.proof !== c.proof && lot.proof !== "unknown" && c.proof !== "unknown") out.push(`proof ${c.proof} vs lot ${lot.proof}`);
  if (lot.editionSize != null && c.editionSize != null && lot.editionSize !== c.editionSize) out.push(`edition ${c.editionSize} vs lot ${lot.editionSize}`);
  if (lot.areaCm2 != null && c.areaCm2 != null && Math.abs(Math.log(lot.areaCm2 / c.areaCm2)) > Math.log(1.3)) out.push(`sheet area ${Math.round(c.areaCm2)} vs lot ${Math.round(lot.areaCm2)} cm²`);
  if (lot.process !== c.process && lot.process !== "other" && c.process !== "other") out.push(`process ${c.process} vs lot ${lot.process}`);
  return out;
}

/** Appearances needed for the SECOND limb of the liquidity rule (a work that has sold before). */
export const LIQUIDITY_MIN_APPEARANCES = 3;

/**
 * Does this work's auction history carry a measured warning about clearing?
 *
 * Measured 2026-09-14 on the 941 backtest lots that had any prior history of the same work,
 * base unsold rate 30%. Two limbs, and the union separates 208 lots at 43% unsold from 733 at
 * 27%:
 *
 *   NEVER SOLD (0 sales, any number of appearances) — n=158, 41% unsold. Holds on both houses
 *     against their own bases: Forum 57% against 37%, Roseberys 36% against 25%. It fires from
 *     a single failed appearance (n=123, 41%) as strongly as from several (n=35, 40%), so the
 *     appearance count is not what carries it — never having cleared is.
 *   THIN RECORD (>=3 appearances, under 50%, but sold at least once) — n=50, 48% unsold.
 *
 * The first limb is why this function was rewritten. It originally required 3+ appearances for
 * either case, which caught the 57-lot thin-record cohort and missed all 158 never-sold lots —
 * including Bonhams 32240's Baldessari, offered twice at ~GBP 4,000 and unsold both times,
 * where Stage 3 reached for the concern anyway and had to route around the verdict to express
 * it. The threshold was assumed; this one is measured.
 *
 * The verdict is computed here and the block carries the ANSWER rather than the rule, because
 * stating a threshold and leaving the model to apply it does not work: it wrote "with only 2
 * prior appearances, this is ordinary auction noise rather than a measured signal (base rates
 * require 3+ appearances)" and then took 10% off anyway.
 */
export function liquidityVerdict(sellThrough: { sold: number; unsold: number } | null | undefined): {
  applies: boolean; n: number; rate: number | null; limb: "never_sold" | "thin_record" | null; line: string;
} {
  const st = sellThrough;
  const n = st ? st.sold + st.unsold : 0;
  if (!st || n === 0) {
    return { applies: false, n: 0, rate: null, limb: null, line: `LIQUIDITY: no prior auction appearance of this work is recorded in the graph. MEASURED SIGNAL: NO — there is no history to read, which is a coverage fact and NOT evidence that the work is hard to sell. Take no liquidity adjustment.` };
  }
  const rate = st.sold / n;
  const pc = Math.round(rate * 100);
  const head = `LIQUIDITY: this work appeared at auction ${n} time${n === 1 ? "" : "s"} before; sold ${st.sold}, unsold ${st.unsold} (${pc}% sell-through).`;
  if (st.sold === 0) {
    return { applies: true, n, rate, limb: "never_sold", line: `${head} MEASURED SIGNAL: YES — this work has NEVER cleared at auction. Measured on 941 lots: works with no prior sale go unsold 41% of the time against a 30% base, and the count of failed attempts barely matters (41% after one, 40% after two or more). Hold the lowEstimate at or below the anchor and name this as the reason. Note also what the house itself did with its estimate across those attempts, if the block shows it.` };
  }
  if (n >= LIQUIDITY_MIN_APPEARANCES && rate < 0.5) {
    return { applies: true, n, rate, limb: "thin_record", line: `${head} MEASURED SIGNAL: YES — ${n} appearances at under 50%, having sold at least once, is the cohort where 48% of lots go unsold against a 30% base (n=50). Hold the lowEstimate at or below the anchor and name this as the reason.` };
  }
  const why = n < LIQUIDITY_MIN_APPEARANCES
    ? `it has sold before, and ${n} prior appearance${n === 1 ? "" : "s"} is below the ${LIQUIDITY_MIN_APPEARANCES} the thin-record cohort was measured on`
    : `it has sold before and ${pc}% sell-through is at or above the 50% that cohort was measured below`;
  return { applies: false, n, rate, limb: null, line: `${head} MEASURED SIGNAL: NO — ${why}. Measured, this sits at the 27-28% base rate, i.e. ordinary auction noise. Take NO liquidity adjustment: an adjustment whose evidence cites this history is invalid, whatever it is labelled. Put the history in evidenceAgainst instead.` };
}

/**
 * What the lot's condition evidence actually is, and what may not be deducted for.
 *
 * Stage 1a is off on this path by design, and the model kept converting that into a 10-20%
 * discount ("Condition uncertainty ... Stage 1a did not run"). The house set its estimate
 * without a hands-on report from us either, so the anchor already carries that state; taking it
 * off again double-counts. The block therefore states the condition FACTS and closes the door.
 */
export function conditionEvidenceLines(claim: CatalogueAttribution, appraiserInput?: AppraiserInputResult | null): string[] {
  const out: string[] = [];
  const stated: string[] = [];
  const note = claim.editionNote ?? "";
  for (const phrase of ["framed", "unframed", "the full sheet", "trimmed", "laid down", "mounted"]) {
    if (new RegExp(`\\b${phrase}\\b`, "i").test(`${note} ${claim.medium ?? ""}`)) stated.push(phrase);
  }
  const claims = (appraiserInput?.conditionClaims ?? []).map((c) => `${c.claim} [${c.status}]`);
  out.push(`CONDITION EVIDENCE (Stage 1a, the visual extraction agent, is OFF on this path BY DESIGN — it is not missing, and the catalogue states what it would have read):`);
  out.push(`    catalogue wording: ${stated.length ? stated.join(", ") : "nothing about condition beyond the medium line"}`);
  out.push(`    appraiser condition notes: ${claims.length ? claims.join("; ") : "none supplied"}`);
  out.push(`    Price the facts above — "framed" and "the full sheet" and any defect named are each worth a named adjustment. But take NO adjustment for the absence of a hands-on examination, for Stage 1a not running, or for an unpublished condition report: the house priced this lot without a report from you too, so the anchor already reflects that. An adjustment whose evidence cites the lack of examination is invalid. Uncertainty about condition belongs in confidence, evidenceAgainst and whatWouldChangeIt, never in the number.`);
  return out;
}

/** The fitted multipliers that bear on THIS lot's attributes, as reference lines. */
export function describeProfileForLot(profile: ArtistPriceProfile, lot: PriceAttrs): string[] {
  const out: string[] = [];
  const line = (col: string, label: string) => {
    const m = profile.multipliers[col];
    if (m != null && Number.isFinite(m)) out.push(`${label}: x${m.toFixed(2)} vs the reference level (${col})`);
  };
  const ref = profile.referenceLevels;
  if (lot.signature && lot.signature !== ref.signature) line(`signature_${lot.signature}`, `signature ${lot.signature}`); else if (lot.signature) out.push(`signature ${lot.signature}: reference level`);
  if (lot.proof && lot.proof !== ref.proof) line(`proof_${lot.proof}`, `proof class ${lot.proof}`);
  const eb = lot.editionSize != null ? (lot.editionSize <= 30 ? "<=30" : lot.editionSize <= 75 ? "31-75" : lot.editionSize <= 150 ? "76-150" : lot.editionSize <= 300 ? "151-300" : ">300") : "unknown";
  if (eb !== ref.edition_band) line(`edition_band_${eb}`, `edition band ${eb}`);
  if (profile.multipliers.edition_log != null) out.push(`edition size: x${profile.multipliers.edition_log.toFixed(2)} per doubling`);
  if (lot.process && lot.process !== ref.process) line(`process_${lot.process}`, `process ${lot.process}`);
  if (profile.multipliers.area_log != null) out.push(`sheet/plate area: x${profile.multipliers.area_log.toFixed(2)} per doubling`);
  return out;
}

export function buildAttributedLotValuationBlock(input: {
  claim: CatalogueAttribution;
  verification: AttributedLotVerification;
  routing: AttributedLotRouting;
  comps: ComparablesResult | null;
  workFacts: WorkFacts | null;
  /** The artist's log-linear price profile (plan step 6). Rendered as REFERENCE, never applied. */
  profile?: ArtistPriceProfile | null;
  /** Stage 1c's extraction, for the condition claims the catalogue carried. */
  appraiserInput?: AppraiserInputResult | null;
}): string {
  const { claim, verification: v, routing, comps, workFacts, profile, appraiserInput } = input;
  const lines: string[] = [];
  lines.push(`ATTRIBUTED-LOT EVIDENCE (the catalogue's own claim, verified against the knowledge graph in code):`);
  lines.push(`  Lot: ${[claim.house, claim.saleId ? `sale ${claim.saleId}` : null, claim.lotNumber != null ? `lot ${claim.lotNumber}` : null, claim.saleDate ? `(${claim.saleDate})` : null].filter(Boolean).join(" ") || "unspecified"}`);
  lines.push(`  Catalogue attribution: ${claim.artistQualifier && claim.artistQualifier !== "certain" ? `${claim.artistQualifier} ` : ""}${claim.artist}${claim.title ? ` — "${claim.title}"` : ""}${claim.year ? `, ${claim.year}` : ""}${claim.medium ? `; ${claim.medium}` : ""}`);

  const mid = claim.estimateLow && claim.estimateHigh ? (claim.estimateLow + claim.estimateHigh) / 2 : null;
  if (mid) {
    lines.push(`  Printed estimate: ${gbp(claim.estimateLow!)} - ${gbp(claim.estimateHigh!)} ${claim.estimateCurrency ?? "GBP"} (midpoint ${gbp(mid)}).`);
    lines.push(`  MEASURED ANCHOR: midpoint x ${ESTIMATE_DRIFT} = ${gbp(mid * ESTIMATE_DRIFT)} ${claim.estimateCurrency ?? "GBP"}. On 3,240 sold Roseberys/Forum lots the house's midpoint scaled by this drift predicted the hammer with MAE(log) 0.24-0.29 and landed within 2x 91-95% of the time; the same-work comp median managed 0.40-0.53 and 78-89%, and blending the comps in made it WORSE. The estimate already prices the plate, state, edition and condition of THIS lot.`);
  } else {
    lines.push(`  Printed estimate: none supplied — anchor on the same-work hammer evidence below, if any, else on the Stage 2b findings.`);
  }

  lines.push(`  VERIFICATION (verdict: ${v.verdict.toUpperCase()}):`);
  lines.push(`    artist   : ${v.artist.status}${v.artist.canonical ? ` — graph identity "${v.artist.canonical}"` : ""}; evidence tree ${v.artist.treeVerdict ?? "n/a"}/${v.artist.treeConfidence ?? "-"}${v.artist.qualifier !== "certain" ? ` [QUALIFIED: ${v.artist.qualifier}]` : ""}${v.spellingNote ? `; ${v.spellingNote}` : ""}`);
  lines.push(`    work     : ${v.work.status}${v.work.resolvedName ? ` — "${v.work.resolvedName}" via ${v.work.basis}${v.work.via === "image_match" ? " (node named by the Stage 1d image match, resolved by exact title)" : ""}${v.work.impressionCount != null ? `, ${v.work.impressionCount} recorded impressions` : ""}` : ""}${v.work.ambiguousAt ? ` (ambiguous at ${v.work.ambiguousAt})` : ""}`);
  lines.push(`    image    : ${v.image.status}${v.image.bestArtist ? ` — nearest "${v.image.bestArtist}"${v.image.bestTitle ? ` / "${v.image.bestTitle}"` : ""}${v.image.dino != null ? ` DINOv2 ${v.image.dino.toFixed(3)}` : ""}${v.image.confidence ? ` ${v.image.confidence}` : ""}` : ""}`);
  lines.push(`    technique: ${v.technique.status} — observed ${v.technique.observed ?? "n/a"}; catalogued ${v.technique.catalogued.join("/") || "n/a"}; house says ${v.technique.claimed ?? "n/a"}`);
  lines.push(`    dimensions: ${v.dimensions.status} — catalogue ${v.dimensions.claimed ?? "n/a"}; tree ${v.dimensions.treeMatch ?? "n/a"}; catalogue-vs-node ${v.dimensions.catalogueVsNode}`);
  lines.push(`    edition  : ${v.edition.status} — claimed ${v.edition.claimedSize ?? "n/a"}; node has ${v.edition.cataloguedSizes.join(", ") || "none recorded"}`);
  for (const d of v.divergences) lines.push(`    ! ${d}`);
  lines.push(`  ROUTING: Stage 2b ${routing.stage2bSkipped ? "SKIPPED" : "RAN"} — ${routing.reason}`);

  const sw = (comps?.comparables ?? []).filter((c) => c.tier === "same_work");
  const swHammers = sw.map((c) => c.hammerPriceGBP).filter((h): h is number => h != null && h > 0);
  const swMed = median(swHammers);
  if (sw.length) {
    lines.push(`  SAME-WORK HAMMER EVIDENCE: ${sw.length} prior sale(s) of this work, median hammer ${swMed != null ? gbp(swMed) : "n/a"} GBP, range ${swHammers.length ? `${gbp(Math.min(...swHammers))} - ${gbp(Math.max(...swHammers))}` : "n/a"}, latest ${comps?.summary.latestSale ?? "?"}.`);
    if (mid && swMed != null) {
      const r = swMed / (mid * ESTIMATE_DRIFT);
      const signal = divergenceSignalUsable(sw, claim.saleDate);
      const flag = !signal.usable
        ? `NOT a directional signal — ${signal.reason}. Treat this sale as one data point about the work, not as evidence that the house has mispriced the lot; stay near the anchor unless something else moves you.`
        : r > 1.5 ? "COMPS WELL ABOVE the estimate (>1.5x the drift anchor): on Roseberys such lots went above the high estimate 33% of the time (base 19%) and unsold 9% (base 22%); on Forum the buckets barely moved."
        : r < 0.67 ? "COMPS WELL BELOW the estimate (<0.67x the drift anchor): on Roseberys 62% of such lots hammered below the low estimate (base 36%)."
        : "comps in line with the estimate (0.67-1.5x the drift anchor): no directional signal beyond the anchor.";
      lines.push(`    same-work median / drift anchor = ${r.toFixed(2)} — ${flag}`);
    }
    const lotAttrs = lotPriceAttrs(claim);
    const diffs = sw.slice(0, 8).map((c) => {
      const d = describeCompDifferences(lotAttrs, c);
      const adj = profile ? adjustmentBetween(lotAttrs, priceAttrsOfComparable(c), profile) : null;
      const implied = adj && adj.factors.length ? ` [model-implied comp->lot factor x${adj.multiplier.toFixed(2)}: ${adj.factors.map((f) => `${f.attribute} x${f.factor.toFixed(2)}`).join(", ")}]` : "";
      return `${c.saleDate?.slice(0, 10) ?? "?"} ${c.institutionName ?? "?"} hammer ${c.hammerPriceGBP != null ? gbp(c.hammerPriceGBP) : "?"}: ${d.join(", ") || "same signature/edition/size class as the lot"}${implied}`;
    });
    lines.push(`    attribute differences vs this lot${profile ? " (with the pricing model's implied factor, for reference)" : ""}:`);
    for (const d of diffs) lines.push(`      - ${d}`);
  } else {
    lines.push(`  SAME-WORK HAMMER EVIDENCE: none in the graph for this work${v.work.status === "resolved" ? " (resolved node has no prior priced auction sale)" : ""}. Tier 2/3 comps below are a plausibility band, not a price.`);
  }

  if (profile) {
    const lotAttrs = lotPriceAttrs(claim);
    const ref = describeProfileForLot(profile, lotAttrs);
    lines.push(`  PRICING MODEL REFERENCE (log-linear hammer model, knowledge_graph/pricing_ml; artist basis "${profile.basis}"${profile.earlierSales != null ? `, ${profile.earlierSales} earlier sales` : ""}${profile.segment ? `, segment default ${profile.segment}` : ""}${profile.neighbours.length ? `; prior from ${profile.neighbours.slice(0, 3).map((n) => n.name).join(", ")}` : ""}):`);
    lines.push(`    this lot's attributes: signature ${lotAttrs.signature}, proof ${lotAttrs.proof}, edition ${lotAttrs.editionSize ?? "unknown"}, area ${lotAttrs.areaCm2 != null ? Math.round(lotAttrs.areaCm2) + " cm²" : "unknown"}, process ${lotAttrs.process}`);
    for (const r of ref) lines.push(`    - ${r}`);
    lines.push(`    How to use it: as DIRECTION and MAGNITUDE reference for the adjustments you name (signature, edition size, sheet size, process). Measured 2026-09-13 on 654 lots: multiplying same-work comps by these factors did NOT beat the raw comp median (MAE(log) 0.40->0.44 Roseberys, 0.53->0.57 Forum), so never apply them as arithmetic to a comp or to the anchor; cite them in valuationReasoning.adjustments as the evidence for a direction.`);
  }

  lines.push(`  ${liquidityVerdict(workFacts?.sellThrough).line}`);
  lines.push(`  ${conditionEvidenceLines(claim, appraiserInput).join("\n    ")}`);
  return lines.join("\n");
}

// ── report attachment ──────────────────────────────────────────────────────────

export interface AttributedLotReport {
  claim: CatalogueAttribution;
  verification: AttributedLotVerification;
  routing: AttributedLotRouting;
  compsSummary: ComparablesResult["summary"] | null;
  sellThrough: WorkFacts["sellThrough"] | null;
  driftAnchor: number | null;
}
