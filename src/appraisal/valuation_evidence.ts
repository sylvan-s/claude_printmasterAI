/**
 * ValuationEvidence — everything Stage 3 needs to price a lot, prepared and structured at the
 * end of Stage 2 (plan docs/plans/2026-09-16-stage3-blend-valuation.md, phase 3).
 *
 * Built in code, never by a model. Every attribute says where it came from, so the contribution
 * chart can say "signature: hand-signed (catalogue)" and a reader can see which facts were
 * defaulted. It is persisted on the report (`PrintAnalysisReport.valuationEvidence`).
 *
 * The graph reads here are the ones the blend was CALIBRATED on (tests/backtest/
 * comps_hammer_backtest.ts --blend): comps from a 10-year window before the valuation date, up
 * to 60 of them, work identity resolved first, the artist's price profile (from the committed Stage 3a
 * model file, knowledge_graph/pricing_ml/priors_stage3a). They are deliberately
 * NOT Stage 3's current LLM reads (from 2015, 40 comps): a price computed from inputs the
 * calibration never saw would carry intervals that were never measured. Nothing here reads
 * `evidence` back into the LLM Stage 3 — that switch is phase 4.
 *
 * Two parts:
 *   readLotGraphEvidence   async, the graph reads (profile, work identity, work facts, comps)
 *   assembleValuationEvidence / evidenceToBlendInputs   pure
 */
import type { AppraiserInputResult, AttributionResearchResult, VisualExtractionResult } from "../types.js";
import type { Stage2bComp } from "./comp_storability.js";
import type { CatalogueAttribution } from "./attributed_lot.js";
import {
  queryAuctionComparables,
  queryArtistPriceProfile,
  queryWorkFacts,
  resolveWorkIdentity,
  priceAttrsOfComparable,
  priorsModelPrediction,
  signatureClass,
  proofClass,
  detectCopyType,
  dimsCm,
  editionSizeOf,
  primaryProcess,
  type ArtistPriceProfile,
  type BlendInputs,
  type ComparablesResult,
  type PriceAttrs,
  type WorkFacts,
} from "./knowledge_graph/index.js";
import type { ProofPolicy } from "./knowledge_graph/price_blend.js";
import type { SignatureClass, ProofClass } from "./knowledge_graph/artist_price_profile.js";
import type { WorkIdentityBasis } from "./knowledge_graph/work_identity.js";
import { mapTechniqueToAckgVocabulary } from "./stage2a_query_plan.js";
import { queryArtistPriceProfileFromFile, loadPriorsBuild } from "./knowledge_graph/file_price_profile.js";

export const VALUATION_EVIDENCE_VERSION = "VE-1.0";
/** The calibrated comps window and cap (comps_hammer_backtest.ts WINDOW_YEARS / limit). */
export const EVIDENCE_COMPS_WINDOW_YEARS = 10;
export const EVIDENCE_COMPS_LIMIT = 60;

export type EvidenceSource = "catalogue" | "appraiser" | "stage2b" | "vea" | "graph" | "input" | "default";
export interface Sourced<T> { value: T; source: EvidenceSource; note?: string }

export interface EvidenceComp {
  tier: "same_work" | "same_artist_technique" | "same_artist";
  hammerGBP: number | null;
  realisedGBP: number | null;
  saleDate: string | null;
  house: string | null;
  saleId: string | null;
  lotNumber: number | null;
  workTitle: string | null;
  listingUrl: string | null;
  attrs: PriceAttrs;
}

export interface ValuationEvidence {
  schemaVersion: typeof VALUATION_EVIDENCE_VERSION;
  builtAt: string;
  artist: { reported: string | null; canonical: string | null };
  /** The artist's log-linear price profile, whole: Stage 3a needs every coefficient. */
  profile: ArtistPriceProfile | null;
  attrs: {
    signature: Sourced<SignatureClass>;
    proof: Sourced<ProofClass>;
    editionSize: Sourced<number | null>;
    areaCm2: Sourced<number | null>;
    process: Sourced<string>;
  };
  /** The house the price is AT (graph institution name). Null value: no house chosen, pooled offset. */
  targetHouse: Sourced<string | null>;
  /** The date the price is for: the sale date of a catalogued lot, else today. Cuts comps. */
  valuationDate: Sourced<string>;
  identity: { workIds: string[]; basis: WorkIdentityBasis | null; matchedName: string | null; ambiguousAt: WorkIdentityBasis | null; via: "claim" | "stage2b" | "none" };
  comps: {
    query: { sinceDate: string; untilDate: string; limit: number; technique: string | null; workTitle: string | null };
    items: EvidenceComp[];
    tierCounts: Record<EvidenceComp["tier"], number>;
    coverageNote: string;
  };
  /** Stage 2b's cited web comps: display and corroboration only, never a witness. */
  webComps: Stage2bComp[];
  condition: { grade: string | null; defects: string[]; appraiserClaims: string[]; source: EvidenceSource };
  sellThrough: { sold: number; unsold: number } | null;
  /** The house's printed estimate. Display and divergence only (user decision 2026-09-16). */
  printedEstimate: { low: number; high: number; currency: string } | null;
  /** Graph reads that failed or were skipped, in words. Empty on a clean build. */
  warnings: string[];
}

// ── attributes, with provenance ──────────────────────────────────────────────────

const VEA_SIGNATURE: Record<string, SignatureClass> = { hand_signed: "hand", plate_signed: "plate", stamp: "stamped" };
const VEA_PROOF: Record<string, ProofClass> = { fractional: "numbered", AP: "artist_proof", HC: "hors_commerce", TP: "trial_proof", BAT: "trial_proof", PP: "trial_proof" };
const veaRan = (vea: VisualExtractionResult | null | undefined): boolean => !!vea && (vea.overallExtractionConfidence ?? 0) > 0;

/**
 * The lot's pricing attributes, by precedence: the catalogue's own claim, then the appraiser's
 * notes (Stage 1c), then Stage 2b's conclusion (process only), then what the image shows (Stage
 * 1a), else the model's reference/unknown level marked "default". Each attribute uses the same
 * classifiers the trainer used (price_attrs.ts), so the lot is banded the way the calibration
 * lots were.
 */
export function lotAttrsWithSources(input: {
  claim?: CatalogueAttribution | null;
  appraiserInput?: AppraiserInputResult | null;
  attr?: AttributionResearchResult | null;
  vea?: VisualExtractionResult | null;
}): ValuationEvidence["attrs"] {
  const { claim, appraiserInput: ai, vea } = input;
  const conclusion = (input.attr as any)?.attributionConclusion ?? null;
  const claimText = claim ? [claim.medium, claim.editionNote].filter(Boolean).join(", ") : "";

  let signature: Sourced<SignatureClass> = { value: "unsigned", source: "default", note: "no signature evidence; model reference level" };
  if (claim && (claim.signed != null || /sign|initial/i.test(claimText))) signature = { value: signatureClass(claim.signed ?? null, claimText), source: "catalogue" };
  else if (ai?.inscriptionClaims?.signatureClaim) {
    // A signature claim is a signature by definition; "pencil, lower right" carries no keyword,
    // so it reads as hand-signed unless the text itself names a stamp, plate or initials.
    const t = ai.inscriptionClaims.signatureClaim;
    signature = { value: signatureClass(null, /sign|initial|stamp/i.test(t) ? t : `signed ${t}`), source: "appraiser", note: t };
  }
  else if (veaRan(vea) && vea!.signatures?.length) {
    const hit = vea!.signatures.map((s) => VEA_SIGNATURE[s.type]).find(Boolean);
    if (hit) signature = { value: hit, source: "vea" };
  }

  // Every training lot went through the ingests' copy type, which defaults to "numbered" when
  // no proof wording is present (detectCopyType). The lot is classified the same way, so the
  // default here is numbered too, not "unknown".
  let proof: Sourced<ProofClass> = { value: proofClass("numbered", ""), source: "default", note: "no proof wording: the ingests' default copy type" };
  const aiEd = ai?.inscriptionClaims?.editionClaim ?? null;
  if (claim && claimText) proof = { value: proofClass(detectCopyType(claimText, claim.title), claimText), source: "catalogue" };
  else if (aiEd) proof = { value: proofClass(detectCopyType(aiEd), aiEd), source: "appraiser", note: aiEd };
  else if (veaRan(vea) && vea!.editionInfo?.length) {
    const hit = vea!.editionInfo.map((e) => VEA_PROOF[e.type]).find(Boolean);
    if (hit) proof = { value: hit, source: "vea" };
  }

  let editionSize: Sourced<number | null> = { value: null, source: "default", note: "unknown; the model uses its training median" };
  const claimEd = claim ? editionSizeOf(claim.editionSize ?? null, claimText) : null;
  if (claimEd != null) editionSize = { value: claimEd, source: "catalogue" };
  else if (ai?.inscriptionClaims?.editionSizeClaim) editionSize = { value: ai.inscriptionClaims.editionSizeClaim, source: "appraiser" };
  else if (veaRan(vea)) {
    const n = (vea!.editionInfo ?? []).map((e) => editionSizeOf(null, e.transcription)).find((x) => x != null);
    if (n != null) editionSize = { value: n, source: "vea", note: "read from the edition inscription" };
  }

  // Plate/image before sheet, as train_price_model.dims_cm and lotPriceAttrs read them.
  let areaCm2: Sourced<number | null> = { value: null, source: "default", note: "unknown; the model uses its training median" };
  const dims = claim?.dimensions ?? [];
  const pick = ["plate", "image", "sheet"].map((k) => dims.find((d) => d.kind?.toLowerCase().includes(k))).find((d) => d?.widthCm && d?.heightCm) ?? dims.find((d) => d.widthCm && d.heightCm);
  const sane = (w: number | null | undefined, h: number | null | undefined) => w != null && h != null && w > 1 && w < 400 && h > 1 && h < 400;
  const textDims = claim ? dimsCm(claim.medium, claim.editionNote) : null;
  if (pick && sane(pick.widthCm, pick.heightCm)) areaCm2 = { value: pick.widthCm! * pick.heightCm!, source: "catalogue", note: pick.kind };
  // Houses often print the size only inside the medium line ("..., 16.5x16cm"); the trainer's
  // dims_cm read that text too. The first match wins, which puts a stated plate before a sheet.
  else if (textDims) areaCm2 = { value: textDims[0] * textDims[1], source: "catalogue", note: "parsed from the medium text" };
  else if (ai?.dimensionsClaim && sane(ai.dimensionsClaim.widthCm, ai.dimensionsClaim.heightCm)) areaCm2 = { value: ai.dimensionsClaim.widthCm! * ai.dimensionsClaim.heightCm!, source: "appraiser", note: ai.dimensionsClaim.kind ?? undefined };
  else if (veaRan(vea) && vea!.dimensions) {
    const mm = [vea!.dimensions.printedImageMM, vea!.dimensions.fullSheetMM].find((d) => d?.width && d?.height);
    if (mm && sane(mm.width! / 10, mm.height! / 10)) areaCm2 = { value: (mm.width! / 10) * (mm.height! / 10), source: "vea", note: mm === vea!.dimensions.printedImageMM ? "image" : "sheet" };
  }

  let process: Sourced<string> = { value: "other", source: "default" };
  // Through the graph's technique vocabulary first ("silkscreen" -> Screenprint), as the
  // training lots' techniques were, then the raw words.
  const proc = (t: string | null | undefined) => (t ? primaryProcess([mapTechniqueToAckgVocabulary(t), t]) : "other");
  const claimProc = proc(claim?.medium);
  if (claimProc !== "other") process = { value: claimProc, source: "catalogue" };
  else if (proc(conclusion?.technique) !== "other") process = { value: proc(conclusion.technique), source: "stage2b", note: conclusion.technique };
  else if (proc(ai?.claimedAttribution?.technique) !== "other") process = { value: proc(ai!.claimedAttribution.technique), source: "appraiser" };
  else if (veaRan(vea) && vea!.printingTechniques?.length) {
    const p = proc(vea!.printingTechniques.map((t) => t.technique).join(", "));
    if (p !== "other") process = { value: p, source: "vea" };
  }
  return { signature, proof, editionSize, areaCm2, process };
}

export const attrsValues = (a: ValuationEvidence["attrs"]): PriceAttrs => ({
  signature: a.signature.value, proof: a.proof.value, editionSize: a.editionSize.value, areaCm2: a.areaCm2.value, process: a.process.value,
});

// ── graph reads ────────────────────────────────────────────────────────────────

export interface LotGraphEvidence {
  profile: ArtistPriceProfile | null;
  identity: ValuationEvidence["identity"];
  workFacts: WorkFacts | null;
  comps: ComparablesResult | null;
  query: ValuationEvidence["comps"]["query"];
  warnings: string[];
}

const minusYears = (iso: string, years: number): string => {
  const d = new Date(iso.slice(0, 10)); d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
};

/**
 * The calibrated reads for one lot. Never throws: a failed read becomes a warning and a null,
 * and the valuation proceeds on what was read.
 */
export async function readLotGraphEvidence(input: {
  canonicalArtist: string | null;
  workTitle: string | null;
  catalogueRefs?: string | null;
  /** The lot's medium line or Stage 2b technique, mapped to graph vocabulary for tier 2. */
  techniqueText: string | null;
  valuationDate: string;
  /** Backtest / past-sale guards: the lot's own record never evidences itself. */
  excludeSaleLot?: { saleId: string; lotNumber: number } | null;
  excludeListingUrl?: string | null;
  via: "claim" | "stage2b";
}): Promise<LotGraphEvidence> {
  const warnings: string[] = [];
  const technique = input.techniqueText ? mapTechniqueToAckgVocabulary(input.techniqueText) : null;
  const query = { sinceDate: minusYears(input.valuationDate, EVIDENCE_COMPS_WINDOW_YEARS), untilDate: input.valuationDate.slice(0, 10), limit: EVIDENCE_COMPS_LIMIT, technique, workTitle: input.workTitle };
  const out: LotGraphEvidence = { profile: null, identity: { workIds: [], basis: null, matchedName: null, ambiguousAt: null, via: "none" }, workFacts: null, comps: null, query, warnings };
  const artist = input.canonicalArtist;
  if (!artist) { warnings.push("no graph identity for the artist: no profile, no comps"); return out; }
  // Stage 3a prices from the committed model file (priors_stage3a, 2026-09-16), not the graph's
  // PricingModelRun; the graph profile is only a fallback when the file is missing.
  try {
    out.profile = await queryArtistPriceProfileFromFile(artist);
    if (!out.profile && !loadPriorsBuild()) {
      warnings.push("Stage 3a model file unreadable: using the graph's price profile");
      out.profile = await queryArtistPriceProfile(artist);
    }
  } catch (e: any) { warnings.push(`price profile read failed: ${e?.message ?? e}`); }
  if (input.workTitle?.trim()) {
    try {
      const wi = await resolveWorkIdentity({ artistName: artist, title: input.workTitle, catalogueRefs: input.catalogueRefs ?? null, excludeSaleLot: input.excludeSaleLot ?? null });
      out.identity = { workIds: wi.workIds, basis: wi.basis, matchedName: wi.matchedNames[0] ?? null, ambiguousAt: wi.ambiguousAt, via: wi.workIds.length ? input.via : "none" };
    } catch (e: any) { warnings.push(`work identity failed: ${e?.message ?? e}`); }
  }
  if (out.identity.workIds.length) {
    try { out.workFacts = await queryWorkFacts(out.identity.workIds, { excludeSaleLot: input.excludeSaleLot ?? null, untilDate: query.untilDate }); }
    catch (e: any) { warnings.push(`work facts read failed: ${e?.message ?? e}`); }
  }
  try {
    out.comps = await queryAuctionComparables({
      artistName: artist, conceptualWorkIds: out.identity.workIds, workTitle: input.workTitle, technique,
      sinceDate: query.sinceDate, untilDate: query.untilDate, limit: query.limit,
      excludeSaleLot: input.excludeSaleLot ?? null, excludeListingUrl: input.excludeListingUrl ?? null,
    });
  } catch (e: any) { warnings.push(`comparables read failed: ${e?.message ?? e}`); }
  return out;
}

// ── assembly (pure) ────────────────────────────────────────────────────────────

export function assembleValuationEvidence(input: {
  builtAt: string;
  reportedArtist: string | null;
  canonicalArtist: string | null;
  claim?: CatalogueAttribution | null;
  appraiserInput?: AppraiserInputResult | null;
  attr?: AttributionResearchResult | null;
  vea?: VisualExtractionResult | null;
  graph: LotGraphEvidence;
  targetHouse: Sourced<string | null>;
  valuationDate: Sourced<string>;
  webComps?: Stage2bComp[];
}): ValuationEvidence {
  const { graph, claim, vea, appraiserInput } = input;
  const items: EvidenceComp[] = (graph.comps?.comparables ?? []).map((c) => ({
    tier: c.tier, hammerGBP: c.hammerPriceGBP ?? null, realisedGBP: c.priceRealisedGBP ?? null, saleDate: c.saleDate ?? null,
    house: c.institutionName ?? null, saleId: c.saleId ?? null, lotNumber: c.lotNumber ?? null, workTitle: c.workTitle ?? null,
    listingUrl: c.listingUrl ?? null, attrs: priceAttrsOfComparable(c),
  }));
  const tierCounts = { same_work: 0, same_artist_technique: 0, same_artist: 0 };
  for (const c of items) tierCounts[c.tier]++;
  const veaCondition = veaRan(vea) ? vea!.condition : null;
  return {
    schemaVersion: VALUATION_EVIDENCE_VERSION,
    builtAt: input.builtAt,
    artist: { reported: input.reportedArtist, canonical: input.canonicalArtist },
    profile: graph.profile,
    attrs: lotAttrsWithSources({ claim, appraiserInput, attr: input.attr, vea }),
    targetHouse: input.targetHouse,
    valuationDate: input.valuationDate,
    identity: graph.identity,
    comps: { query: graph.query, items, tierCounts, coverageNote: graph.comps?.coverageNote ?? "comparables not read" },
    webComps: input.webComps ?? [],
    condition: {
      grade: veaCondition?.overallGrade ?? null,
      defects: (veaCondition?.defects ?? []).map((d) => `${d.type} (${d.severity.toLowerCase()}${d.affectsImageArea ? ", in the image" : ""})`),
      appraiserClaims: (appraiserInput?.conditionClaims ?? []).map((c) => c.claim),
      source: veaCondition ? "vea" : appraiserInput?.conditionClaims?.length ? "appraiser" : "default",
    },
    sellThrough: graph.workFacts?.sellThrough ?? null,
    printedEstimate: claim?.estimateLow && claim?.estimateHigh ? { low: claim.estimateLow, high: claim.estimateHigh, currency: claim.estimateCurrency ?? "GBP" } : null,
    warnings: graph.warnings,
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * The blend's inputs, exactly as the backtest harness records them for a calibration lot.
 * The printed estimate is NOT passed (user decision 2026-09-16: model + comps only).
 */
export function evidenceToBlendInputs(ev: ValuationEvidence, opts: { proofPolicy?: ProofPolicy | null } = {}): BlendInputs {
  const tierComps = (tier: EvidenceComp["tier"]) =>
    ev.comps.items.filter((c) => c.tier === tier && c.hammerGBP != null && c.hammerGBP > 0).map((c) => ({ hammerGBP: c.hammerGBP!, saleDate: c.saleDate, house: c.house }));
  const tierBlock = (tier: "same_artist_technique" | "same_artist") => {
    const all = ev.comps.items.filter((c) => c.tier === tier);
    const hammers = tierComps(tier);
    const med = median(hammers.map((c) => c.hammerGBP));
    return all.length > 0 && med != null ? { n: all.length, medianHammerGBP: med, comps: hammers } : null;
  };
  const pred = ev.profile ? priorsModelPrediction(attrsValues(ev.attrs), ev.profile, { saleDate: ev.valuationDate.value, house: ev.targetHouse.value, proofPolicy: opts.proofPolicy }) : null;
  return {
    saleDate: ev.valuationDate.value.slice(0, 10),
    house: null,
    estimate: null,
    targetHouse: ev.targetHouse.value,
    sameWork: tierComps("same_work"),
    sameArtistTechnique: tierBlock("same_artist_technique"),
    sameArtist: tierBlock("same_artist"),
    priors: pred && ev.profile ? { mu: pred.mu, basis: ev.profile.basis, earlierSales: ev.profile.earlierSales, contributions: pred.contributions } : null,
    sellThrough: ev.sellThrough,
    recentSameHouseAppearance: null,
  };
}
