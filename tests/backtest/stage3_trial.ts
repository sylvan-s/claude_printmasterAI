/**
 * Stage 3 unit trial (plan docs/plans/2026-09-16-stage3-blend-valuation.md, phase 4).
 *
 * Isolates Stage 3. No Stage 1 or Stage 2 model runs: each lot's Stage 3 inputs are rebuilt in
 * code from its catalogue record and the graph, as the attributed-lot path builds them when
 * Stage 2b is skipped. The Stage 2a evidence tree is a STUB that agrees with the catalogue's
 * artist at HIGH (these are single-artist, unqualified catalogued lots): attribution is not what
 * is under test, and every arm sees the same stub.
 *
 * Four arms on the same lots, scored on the realised hammer:
 *   A  old Stage 3 LLM, as today — sees the printed estimate (attributed-lot prompt)
 *   B  old Stage 3 LLM, printed estimate withheld
 *   C  Stage 3a — the deterministic pricing-model + comps blend (no LLM)
 *   D  new price-model-informed LLM — given Stage 3a's range, witnesses, house factor, model
 *      contributions and caveats, no printed estimate; may depart from the range only on a
 *      named, quoted catalogue fact
 *
 *   npx tsx tests/backtest/stage3_trial.ts --per-house 50 --seed 5 --since 2022-01-01 [--limit 4] [--concurrency 4]
 *   npx tsx tests/backtest/stage3_trial.ts --report
 *
 * Output: tests/backtest/comps_hammer/stage3_trial.jsonl (resumable: lots already written are skipped).
 */
import "dotenv/config";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import {
  AttributedLotAppraiser, appraiserConfigs, usageSummary, resetUsage,
} from "../../src/appraisal/appraiser";
import {
  queryAuctionComparables, queryArtistPriceProfile, queryWorkFacts, resolveWorkIdentity, closeDriver,
} from "../../src/appraisal/knowledge_graph/index";
import {
  verifyAttributedLot, routeAttributedLot, synthesizeAttributionResult, mergeClaimIntoAppraiserInput, emptyAppraiserInput,
  buildAttributedLotValuationBlock, veaNotRun, type CatalogueAttribution, type WorkResolution,
} from "../../src/appraisal/attributed_lot";
import { VALUATION_ATTRIBUTED_LOT_SUFFIX } from "../../src/appraisal/prompts";
import { mapTechniqueToAckgVocabulary } from "../../src/appraisal/stage2a_query_plan";
import { readLotGraphEvidence, assembleValuationEvidence } from "../../src/appraisal/valuation_evidence";
import { stage3aValuation, loadBlendCalibration, type Stage3aResult } from "../../src/appraisal/stage3a_blend";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PER_HOUSE = Number(arg("per-house", "50"));
const SEED = Number(arg("seed", "5"));
const SINCE = arg("since", "2022-01-01")!;
const LIMIT = Number(arg("limit", "0"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const OUT = arg("out", "tests/backtest/comps_hammer/stage3_trial.jsonl")!;
const D = "tests/backtest/comps_hammer";
const HOUSE_FILES = [`${D}/roseberys_n2500_blend_house.jsonl`, `${D}/forum_n2500_blend_house.jsonl`];
const STAGE3_COMPS_SINCE = "2015-01-01";
const STAGE3_COMPS_LIMIT = 40;

const config = appraiserConfigs.find((c) => c.id === "claude-4stage-attributed")!;
const MODEL = arg("model", config.stage3Model!)!;

/** Exposes the protected Stage 3 call and the raw Claude call without running any other stage. */
class TrialAppraiser extends AttributedLotAppraiser {
  stage3(...a: Parameters<AttributedLotAppraiser["runStage3Valuation"]>) { return this.runStage3Valuation(...a); }
  claude(...a: Parameters<AttributedLotAppraiser["callClaude"]>) { return this.callClaude(...a); }
}
const appraiser = new TrialAppraiser(config);

// ── arm D: the price-model-informed agent ───────────────────────────────────────

const ARM_D_SYSTEM = `You are the valuation agent in a fine art print appraisal pipeline. A calibrated pricing model has already priced this lot from the knowledge graph: the artist's log-linear price model (signature, proof, edition, size, technique, sale house, sale year) blended with realised hammer prices of the same work and of similar works by the same artist. Its 80% range held 75-85% of realised hammers when tested on houses it was not fitted on.

Your job is to state the auction estimate (hammer basis, GBP) and explain it.

RULES
1. Start from the model's range. Keep lowEstimate and highEstimate inside the model's 80% range unless the catalogue text states a price-relevant fact the model cannot see. Facts the model CANNOT see: an explicit rarity statement ("one of N recorded impressions"), a named state or trial/cancelled plate, a posthumous or restrike printing, a stated defect or restoration, notable provenance, a portfolio/set of several sheets, a printed signature mistaken for a hand signature. Facts the model ALREADY priced (never adjust for these again): signature class, proof class, edition size, sheet size, technique, the sale house, the sale year, the comps listed.
2. Every departure from the model range must name the fact, quote the catalogue words, and give a multiplier. No quote, no departure.
3. You may narrow the range toward the median when the evidence is strong (several recent same-work sales) and the catalogue raises nothing; you may not widen it for vague uncertainty.
4. There is no printed estimate. Do not invent one.
Return only the tool call.`;

const ARM_D_SCHEMA = {
  type: "object",
  properties: {
    lowEstimate: { type: "integer", description: "Low end, hammer basis, GBP, plain integer." },
    highEstimate: { type: "integer", description: "High end, hammer basis, GBP, plain integer." },
    departures: {
      type: "array",
      items: { type: "object", properties: { fact: { type: "string" }, quote: { type: "string" }, multiplier: { type: "number" } }, required: ["fact", "quote", "multiplier"] },
      description: "Each departure from the model range, with the quoted catalogue words. Empty when the estimate stays within the range.",
    },
    keyDrivers: { type: "array", items: { type: "string" }, description: "The 2-4 factors that most set this price, in plain words." },
    narrative: { type: "string", description: "Three to five sentences a client can read." },
  },
  required: ["lowEstimate", "highEstimate", "departures", "keyDrivers", "narrative"],
};

function armDUserText(claim: CatalogueAttribution, s3a: Stage3aResult, attrs: Record<string, { value: unknown; source: string }>): string {
  const catalogue = {
    artist: claim.artist, title: claim.title, year: claim.year, medium: claim.medium, editionNote: claim.editionNote,
    editionSize: claim.editionSize, signed: claim.signed, dimensions: claim.dimensions, catalogueRefs: claim.catalogueRefs, house: claim.house, saleDate: claim.saleDate,
  };
  const model = {
    range80GBP: [s3a.lowGBP, s3a.highGBP], medianGBP: s3a.medianGBP, strongestEvidence: s3a.evidenceTier,
    witnesses: s3a.witnesses, saleHouseFactor: s3a.house, modelContributionsLog: s3a.priorsContributions,
    attributesAsPriced: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, `${v.value ?? "unknown"} (${v.source})`])),
    divergenceBetweenWitnesses: s3a.divergence, pSells: s3a.pSells, caveats: s3a.caveats, condition: s3a.condition,
  };
  return `CATALOGUE ENTRY (verbatim fields):\n${JSON.stringify(catalogue)}\n\nPRICING MODEL RESULT:\n${JSON.stringify(model)}\n\nState the estimate.`;
}

// ── lots ───────────────────────────────────────────────────────────────────────

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function selectLots(): any[] {
  const out: any[] = [];
  for (const f of HOUSE_FILES) {
    const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.sold && r.hammer > 0 && r.lowEst > 0 && r.highEst > 0 && r.canonicalArtist && r.blend && !r.error && r.saleDate >= SINCE && r.qualifier === "certain");
    const rnd = mulberry32(SEED);
    out.push(...rows.map((r) => [rnd(), r] as const).sort((a, b) => a[0] - b[0]).slice(0, PER_HOUSE).map(([, r]) => r));
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

function claimOf(row: any, withEstimate: boolean): CatalogueAttribution {
  return {
    artist: row.artist, artistQualifier: "certain", title: row.title, medium: row.medium, editionNote: row.editionNote,
    editionSize: row.editionSize, signed: row.signed,
    dimensions: row.widthCm && row.heightCm ? [{ kind: "sheet", widthCm: row.widthCm, heightCm: row.heightCm }] : null,
    catalogueRefs: row.catalogueRefs ? [row.catalogueRefs] : null,
    estimateLow: withEstimate ? row.lowEst : null, estimateHigh: withEstimate ? row.highEst : null, estimateCurrency: "GBP",
    house: row.blend.inputs.targetHouse, saleId: String(row.saleId), lotNumber: Number(row.lotNumber), saleDate: row.saleDate, lotUrl: row.listingUrl ?? null,
  };
}

/** The Stage 3 inputs the attributed-lot path builds when Stage 2b is skipped, in code. */
async function stage3Inputs(row: any, claim: CatalogueAttribution) {
  const canonical: string = row.canonicalArtist;
  const saleLot = { saleId: claim.saleId!, lotNumber: claim.lotNumber! };
  const profile = await queryArtistPriceProfile(canonical);
  const wi = await resolveWorkIdentity({ artistName: canonical, title: claim.title ?? "", catalogueRefs: claim.catalogueRefs?.join("; ") ?? null, excludeSaleLot: saleLot });
  const work: WorkResolution = { via: "claim", basis: wi.basis, workIds: wi.workIds, matchedNames: wi.matchedNames, ambiguousAt: wi.ambiguousAt, ambiguousNames: wi.ambiguousNames };
  const workFacts = wi.workIds.length ? await queryWorkFacts(wi.workIds, { excludeSaleLot: saleLot, excludeSaleId: claim.saleId ?? null, untilDate: claim.saleDate ?? null }) : null;
  const comps = await queryAuctionComparables({
    artistName: canonical, conceptualWorkIds: wi.workIds, workTitle: claim.title ?? null, technique: mapTechniqueToAckgVocabulary(claim.medium),
    sinceDate: STAGE3_COMPS_SINCE, untilDate: claim.saleDate ?? null, excludeListingUrl: claim.lotUrl ?? null, excludeSaleLot: saleLot, excludeSaleId: claim.saleId ?? null, limit: STAGE3_COMPS_LIMIT,
  });
  const triageStub: any = {
    artistAttribution: { artistName: canonical, verdict: "attributed", confidence: "HIGH", contradictingIdentities: [], artistIdentity: { canonicalArtistName: canonical } },
    impressionAssessment: null, routingDecision: { scenario: 1, scenarioName: "trial stub: catalogued single-artist lot" },
  };
  const vea = veaNotRun();
  const verification = verifyAttributedLot({ claim, canonicalArtist: canonical, triage: triageStub, vea, stage1d: null, work, workFacts });
  const routing = routeAttributedLot(verification, comps.summary.tierCounts.same_work);
  const attr = synthesizeAttributionResult({ claim, canonicalArtist: canonical, verification, workFacts, triage: triageStub });
  const appraiserInput = mergeClaimIntoAppraiserInput(emptyAppraiserInput(), claim);
  const block = buildAttributedLotValuationBlock({ claim, verification, routing, comps, workFacts, profile, appraiserInput });
  return { canonical, vea, attr, appraiserInput, block, work, routing };
}

const exclusionProse = (claim: CatalogueAttribution) => `${claim.house}, sale ${claim.saleId}, lot ${claim.lotNumber}${claim.lotUrl ? ` (${claim.lotUrl})` : ""}`;

async function llmArm(row: any, withEstimate: boolean) {
  const claim = claimOf(row, withEstimate);
  const s = await stage3Inputs(row, claim);
  const v: any = await appraiser.stage3(
    s.vea, s.attr, MODEL, undefined as any, "GBP", undefined, exclusionProse(claim), s.appraiserInput, s.canonical,
    { workIds: s.work.workIds, untilDate: claim.saleDate ?? null, block: s.block, systemSuffix: VALUATION_ATTRIBUTED_LOT_SUFFIX },
  );
  const e = v?.auctionEstimate ?? {};
  return { low: e.lowEstimate ?? null, high: e.highEstimate ?? null, reasoning: e.valuationReasoning ?? null, context: e.valuationContext ?? null, stage2bWouldRun: !s.routing.stage2bSkipped, routingReason: s.routing.reason };
}

async function processLot(row: any) {
  const key = row.key;
  const claim = claimOf(row, false);
  const cal = loadBlendCalibration()!;
  const graph = await readLotGraphEvidence({
    canonicalArtist: row.canonicalArtist, workTitle: claim.title ?? null, catalogueRefs: claim.catalogueRefs?.join("; ") ?? null, techniqueText: claim.medium ?? null,
    valuationDate: row.saleDate, excludeSaleLot: { saleId: claim.saleId!, lotNumber: claim.lotNumber! }, excludeListingUrl: claim.lotUrl ?? null, via: "claim",
  });
  const ev = assembleValuationEvidence({
    builtAt: "trial", reportedArtist: row.artist, canonicalArtist: row.canonicalArtist, claim, graph,
    targetHouse: { value: claim.house ?? null, source: "catalogue" }, valuationDate: { value: row.saleDate, source: "catalogue" },
  });
  const c = stage3aValuation(ev, cal);
  const errors: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch (e: any) { errors.push(`${label}: ${e?.message ?? e}`); return null; } };
  const a = await safe("A", () => llmArm(row, true));
  const b = await safe("B", () => llmArm(row, false));
  const d = c ? await safe("D", async () => {
    const r: any = await appraiser.claude(MODEL, ARM_D_SYSTEM, [{ type: "text", text: armDUserText(claim, c, ev.attrs as any) }], "report_price_model_estimate", "Report the estimate, departures and narrative.", ARM_D_SCHEMA);
    return { low: r.lowEstimate, high: r.highEstimate, departures: r.departures, keyDrivers: r.keyDrivers, narrative: r.narrative };
  }) : null;
  return {
    key, house: claim.house, saleDate: row.saleDate, artist: row.artist, title: row.title, medium: row.medium,
    hammer: row.hammer, printed: [row.lowEst, row.highEst],
    A: a, B: b, C: c ? { low: c.lowGBP, high: c.highGBP, median: c.medianGBP, tier: c.evidenceTier, caveats: c.caveats } : null, D: d, errors,
  };
}

// ── report ─────────────────────────────────────────────────────────────────────

function report() {
  const rows = readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ln = Math.log;
  const arms: [string, (r: any) => { pred: number; lo: number; hi: number } | null][] = [
    ["A old LLM, printed estimate shown", (r) => r.A?.low > 0 ? { pred: Math.sqrt(r.A.low * r.A.high), lo: r.A.low, hi: r.A.high } : null],
    ["B old LLM, estimate withheld", (r) => r.B?.low > 0 ? { pred: Math.sqrt(r.B.low * r.B.high), lo: r.B.low, hi: r.B.high } : null],
    ["C Stage 3a (deterministic)", (r) => r.C ? { pred: r.C.median, lo: r.C.low, hi: r.C.high } : null],
    ["D price-model-informed LLM", (r) => r.D?.low > 0 ? { pred: Math.sqrt(r.D.low * r.D.high), lo: r.D.low, hi: r.D.high } : null],
    ["ref: printed midpoint x0.82", (r) => ({ pred: ((r.printed[0] + r.printed[1]) / 2) * 0.82, lo: r.printed[0], hi: r.printed[1] })],
  ];
  const scored = rows.filter((r) => arms.slice(0, 4).every(([, f]) => f(r)));
  const line = (label: string, sub: any[], f: (r: any) => any) => {
    const pts = sub.map((r) => ({ ...f(r), y: r.hammer }));
    if (!pts.length) return;
    const e = pts.map((p) => ln(p.pred / p.y));
    const mae = e.reduce((t, x) => t + Math.abs(x), 0) / e.length;
    const geo = Math.exp(e.reduce((t, x) => t + x, 0) / e.length);
    const w2 = e.filter((x) => Math.abs(x) <= ln(2)).length / e.length;
    const cover = pts.filter((p) => p.y >= p.lo && p.y <= p.hi).length / pts.length;
    const widths = pts.map((p) => p.hi / p.lo).sort((x, y) => x - y);
    console.log(`  ${label.padEnd(36)} n=${String(pts.length).padStart(3)}  MAE(log) ${mae.toFixed(3)}  geo ${geo.toFixed(2)}  within 2x ${(100 * w2).toFixed(0).padStart(3)}%  hammer in range ${(100 * cover).toFixed(0).padStart(3)}%  median high/low ${widths[widths.length >> 1].toFixed(2)}x`);
  };
  console.log(`${rows.length} lots in ${OUT}; all four arms answered on ${scored.length}; errors on ${rows.filter((r) => r.errors?.length).length}`);
  console.log(`\n── All lots with every arm ──`);
  for (const [label, f] of arms) line(label, scored, f);
  for (const h of [...new Set(scored.map((r) => r.house))]) {
    console.log(`\n── ${h} ──`);
    for (const [label, f] of arms) line(label, scored.filter((r) => r.house === h), f);
  }
  for (const t of [...new Set(scored.map((r) => r.C.tier))].sort()) {
    const sub = scored.filter((r) => r.C.tier === t);
    console.log(`\n── strongest evidence: ${t} ──`);
    for (const [label, f] of arms) line(label, sub, f);
  }
  const dep = scored.filter((r) => r.D.departures?.length);
  console.log(`\nArm D departed from the model range on ${dep.length}/${scored.length} lots; B's range sits inside C's on ${scored.filter((r) => r.B.low >= r.C.low && r.B.high <= r.C.high).length}.`);
  for (const r of dep.slice(0, 8)) console.log(`  ${r.key} hammer ${r.hammer}: C ${r.C.low}-${r.C.high} -> D ${r.D.low}-${r.D.high}; ${r.D.departures.map((x: any) => `${x.fact} x${x.multiplier} ("${String(x.quote).slice(0, 60)}")`).join("; ")}`);
}

async function main() {
  if (argv.includes("--report")) return report();
  const lots = selectLots();
  const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);
  const todo = lots.filter((r) => !done.has(r.key));
  console.log(`${lots.length} lots selected (${PER_HOUSE}/house since ${SINCE}, seed ${SEED}); ${done.size} already done; running ${todo.length} with ${MODEL}, concurrency ${CONCURRENCY}`);
  resetUsage();
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const row = todo[i++];
      const t = Date.now();
      const r = await processLot(row);
      appendFileSync(OUT, JSON.stringify(r) + "\n");
      console.log(`  ${r.key}: hammer ${r.hammer} | A ${r.A?.low}-${r.A?.high} | B ${r.B?.low}-${r.B?.high} | C ${r.C?.low}-${r.C?.high} | D ${r.D?.low}-${r.D?.high}${r.errors.length ? ` | ERR ${r.errors.join("; ").slice(0, 120)}` : ""} (${((Date.now() - t) / 1000).toFixed(0)}s, spend so far $${usageSummary().totalUsd.toFixed(2)})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const u = usageSummary();
  console.log(`\nspend $${u.totalUsd.toFixed(3)}: ${Object.values(u.byLabel).map((b) => `${b.label} ${b.calls} calls $${b.costUsd.toFixed(3)}`).join("; ")}`);
  await closeDriver();
  report();
}
main();
