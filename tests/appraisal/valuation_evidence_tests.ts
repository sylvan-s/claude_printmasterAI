/**
 * Pure-function tests for valuation_evidence.ts: attribute sourcing and precedence, the ingest
 * copy-type rule, evidence assembly, and the evidence -> blend-inputs mapping. No graph.
 *
 *   npm run test:valuation-evidence
 */
import { lotAttrsWithSources, assembleValuationEvidence, evidenceToBlendInputs, attrsValues, type LotGraphEvidence } from "../../src/appraisal/valuation_evidence";
import { detectCopyType, proofClass } from "../../src/appraisal/knowledge_graph/price_attrs";
import type { ArtistPriceProfile } from "../../src/appraisal/knowledge_graph/artist_price_profile";

let passed = 0, failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
function ok(label: string, cond: boolean) { if (cond) passed++; else { failed++; console.log(`  FAIL ${label}`); } }

// ── the ingest copy-type rule ──────────────────────────────────────────────────
{
  eq("no proof wording -> numbered", detectCopyType("numbered from the edition of 100"), "numbered");
  eq("artist's proof wins", detectCopyType("an artist's proof aside from the edition of 50"), "AP");
  eq("hors commerce", detectCopyType("inscribed HC"), "HC");
  eq("bare 'bon' is BAT, mirrored from the ingests (carbon, ribbon)", detectCopyType("on carbon paper"), "BAT");
  eq("'numbered from the edition of 100' is numbered through the copy type, not edition_unnumbered", proofClass(detectCopyType("numbered from the edition of 100"), "numbered from the edition of 100"), "numbered");
}

// ── attributes with provenance ─────────────────────────────────────────────────
const vea: any = {
  overallExtractionConfidence: 0.8,
  signatures: [{ type: "hand_signed" }],
  editionInfo: [{ type: "fractional", transcription: "12/75" }],
  dimensions: { printedImageMM: { width: 300, height: 400 }, fullSheetMM: { width: 500, height: 600 } },
  printingTechniques: [{ technique: "Screenprint" }],
  condition: { overallGrade: "GOOD", defects: [{ type: "foxing", severity: "MINOR", affectsImageArea: false }] },
};
const appraiser: any = {
  inscriptionClaims: { signatureClaim: "pencil, lower right", editionClaim: "AP", editionSizeClaim: 90 },
  dimensionsClaim: { widthCm: 20, heightCm: 25, kind: "sheet" },
  claimedAttribution: { technique: null },
  catalogueReferences: [],
  conditionClaims: [{ claim: "light stain to margin" }],
};
{
  const fromVea = lotAttrsWithSources({ vea });
  eq("VEA only: every attribute sourced from the image", Object.fromEntries(Object.entries(fromVea).map(([k, v]) => [k, [v.value, v.source]])), {
    signature: ["hand", "vea"], proof: ["numbered", "vea"], editionSize: [75, "vea"], areaCm2: [1200, "vea"], process: ["screenprint", "vea"],
  });
  const withNotes = lotAttrsWithSources({ vea, appraiserInput: appraiser });
  eq("appraiser notes outrank the image", [withNotes.signature.source, withNotes.proof.value, withNotes.editionSize.value, withNotes.areaCm2.value], ["appraiser", "artist_proof", 90, 500]);
  eq("a keyword-free signature claim still reads as hand-signed", withNotes.signature.value, "hand");
  const claim: any = { artist: "X", title: "T", medium: "Etching with aquatint", editionNote: "signed and numbered from the edition of 50", signed: true, editionSize: 50, dimensions: [{ kind: "sheet", widthCm: 50, heightCm: 60 }, { kind: "plate", widthCm: 30, heightCm: 40 }] };
  const withClaim = lotAttrsWithSources({ vea, appraiserInput: appraiser, claim });
  eq("the catalogue outranks everything; plate before sheet", Object.fromEntries(Object.entries(withClaim).map(([k, v]) => [k, [v.value, v.source]])), {
    signature: ["hand", "catalogue"], proof: ["numbered", "catalogue"], editionSize: [50, "catalogue"], areaCm2: [1200, "catalogue"], process: ["aquatint", "catalogue"],
  });
  const nothing = lotAttrsWithSources({ vea: { overallExtractionConfidence: 0 } as any });
  eq("VEA not run and no other source: all defaulted", Object.values(nothing).map((v) => v.source), ["default", "default", "default", "default", "default"]);
  eq("defaults are the training reference levels", [nothing.signature.value, nothing.proof.value, nothing.editionSize.value, nothing.areaCm2.value, nothing.process.value], ["unsigned", "numbered", null, null, "other"]);
  const s2b = lotAttrsWithSources({ attr: { attributionConclusion: { technique: "lithograph" } } as any });
  eq("Stage 2b supplies the process when nothing better does", [s2b.process.value, s2b.process.source], ["lithograph", "stage2b"]);
  const textOnly = lotAttrsWithSources({ claim: { artist: "X", medium: "etching with hand-colouring, signed and numbered 173/250 in pencil, 16.5x16cm" } as any });
  eq("size printed only in the medium line is read", [Math.round(textOnly.areaCm2.value!), textOnly.areaCm2.note], [264, "parsed from the medium text"]);
  const silk = lotAttrsWithSources({ claim: { artist: "X", medium: "Silkscreen printed in colors on Coventry Rag paper" } as any });
  eq("silkscreen maps to screenprint through the graph vocabulary", silk.process.value, "screenprint");
  const silly = lotAttrsWithSources({ appraiserInput: { ...appraiser, inscriptionClaims: {}, dimensionsClaim: { widthCm: 900, heightCm: 2 } } });
  eq("implausible dimensions are not used", silly.areaCm2.source, "default");
}

// ── assembly and blend inputs ──────────────────────────────────────────────────
const profile: ArtistPriceProfile = {
  canonicalName: "X", level: 6, elasticities: { signature_hand: Math.log(2), edition_log: 0, area_log: 0 }, multipliers: {}, neighbours: [], run: "t", basis: "shrunk",
  earlierSales: 40, segment: null, referenceLevels: { signature: "unsigned", proof: "numbered", edition_band: "76-150", area_band: "400-900", process: "lithograph", house: "Bonhams" },
  continuousMedians: { edition_log: Math.log(100), area_log: Math.log(600) }, yearEffects: { "2024": 0.1 },
};
const comp = (tier: string, hammer: number | null, house: string, date: string): any => ({ tier, hammerPriceGBP: hammer, priceRealisedGBP: hammer ? hammer * 1.25 : null, saleDate: date, institutionName: house, saleId: "s", lotNumber: 1, workTitle: "T", listingUrl: null, techniques: [], signed: true, editionSize: 50, rawMedium: "etching", copyType: "numbered", plateDimensions: null, imageDimensions: null, sheetDimensions: null });
const graph: LotGraphEvidence = {
  profile,
  identity: { workIds: ["w1"], basis: "exact_title", matchedName: "T", ambiguousAt: null, via: "claim" },
  workFacts: { sellThrough: { sold: 3, unsold: 1 } } as any,
  comps: {
    comparables: [comp("same_work", 1000, "Bonhams", "2023-01-01"), comp("same_work", 800, "Forum Auctions", "2022-01-01"), comp("same_artist_technique", 500, "Bonhams", "2021-01-01"), comp("same_artist_technique", null, "Roseberys London", "2021-01-01"), comp("same_artist", 300, "Bonhams", "2020-01-01")],
    summary: {} as any, coverageNote: "test coverage",
  },
  suite: [],
  query: { sinceDate: "2014-06-01", untilDate: "2024-06-01", limit: 60, technique: "Etching", workTitle: "T" },
  warnings: [],
};
{
  const claim: any = { artist: "X", title: "T", medium: "Etching", editionNote: "signed", signed: true, estimateLow: 900, estimateHigh: 1200, estimateCurrency: "GBP", house: "Forum Auctions", saleDate: "2024-06-01" };
  const ev = assembleValuationEvidence({
    builtAt: "2026-09-16T00:00:00Z", reportedArtist: "X", canonicalArtist: "X", claim, vea, graph,
    targetHouse: { value: "Forum Auctions", source: "catalogue" }, valuationDate: { value: "2024-06-01", source: "catalogue" },
  });
  eq("tier counts include a comp with no hammer", ev.comps.tierCounts, { same_work: 2, same_suite: 0, same_artist_technique: 2, same_artist: 1 });
  const withSuite = assembleValuationEvidence({
    builtAt: "t", reportedArtist: "X", canonicalArtist: "X", claim, vea, graph: { ...graph, suite: [{ hammerGBP: 700, currency: "GBP", saleDate: "2022-05-01", house: "Bonhams", work: "sib", workTitle: "Sibling plate", entry: "Vallier 153", listingUrl: null }] },
    targetHouse: { value: "Forum Auctions", source: "catalogue" }, valuationDate: { value: "2024-06-01", source: "catalogue" },
  });
  eq("suite comps join as their own tier with the joining entry", [withSuite.comps.tierCounts.same_suite, withSuite.comps.items.find((c) => c.tier === "same_suite")!.entry], [1, "Vallier 153"]);
  eq("and reach the blend as sameSuite", evidenceToBlendInputs(withSuite).sameSuite, [{ hammerGBP: 700, saleDate: "2022-05-01", house: "Bonhams", currency: "GBP", fxLogShift: 0 }]);
  eq("printed estimate kept for display", ev.printedEstimate, { low: 900, high: 1200, currency: "GBP" });
  eq("condition from the image, appraiser claims alongside", [ev.condition.grade, ev.condition.defects[0], ev.condition.source], ["GOOD", "foxing (minor)", "vea"]);
  const b = evidenceToBlendInputs(ev);
  eq("the estimate never reaches the blend", [b.estimate, b.house], [null, null]);
  eq("same-work hammers carry their houses", b.sameWork.map((c) => [c.hammerGBP, c.house]), [[1000, "Bonhams"], [800, "Forum Auctions"]]);
  eq("tier n counts every comp; the median and comps only hammered ones", [b.sameArtistTechnique!.n, b.sameArtistTechnique!.medianHammerGBP, b.sameArtistTechnique!.comps!.length], [2, 500, 1]);
  eq("target house and date pass through", [b.targetHouse, b.saleDate], ["Forum Auctions", "2024-06-01"]);
  ok("priors computed from the evidence attributes: signed, 2024 effect", !!b.priors && Math.abs(b.priors.mu - (6 + Math.log(2) + 0.1)) < 1e-9);
  eq("attrsValues flattens the sourced attributes", attrsValues(ev.attrs).signature, "hand");
  eq("sell-through from the work facts", b.sellThrough, { sold: 3, unsold: 1 });
  const noProfile = evidenceToBlendInputs({ ...ev, profile: null });
  eq("no profile -> no priors witness", noProfile.priors, null);
}

console.log(`\nvaluation_evidence tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
