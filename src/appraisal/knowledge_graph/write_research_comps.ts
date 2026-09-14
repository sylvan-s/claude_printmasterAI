/**
 * Stage 2b comps write-back — ADR-0007's auction-comp slice, hammer basis only.
 *
 * Every realised price Stage 2b finds on the web is used for one appraisal and thrown away.
 * The same work researched next month is researched from scratch. This makes those findings
 * durable — and does so under the narrowest gate the evidence supports, because the ACKG has
 * twice been corrupted by writes that asserted more than was known, and a bad price is worse
 * than no price: it is unrepairable later because nothing records which rows were guesses.
 *
 * WHAT IS WRITTEN, AND WHAT IS DELIBERATELY NOT.
 *
 * A comp becomes ONE SourceRecord linked straight to the ConceptualWork:
 *
 *     (:SourceRecord {sourceType:'agent_research', reliabilityTier:'agent_derived'})
 *        -[:PRICES]->(:ConceptualWork)
 *        -[:ATTRIBUTED_TO]->(:Artist)
 *
 * No Impression and no EditionRun are created. Every ingested auction record hangs off an
 * Impression because the catalogue describes a specific physical sheet — its edition number,
 * its signature, its margins. A web search result tells us a sale of THIS WORK happened at a
 * price; it does not tell us which edition run, and inventing an Impression to hold the price
 * would assert exactly the thing we did not learn. Linking to the work says what we know.
 *
 * That shape is also the containment. `queryAuctionComparables` walks
 * ConceptualWork -> EditionRun -> Impression <- SourceRecord and filters on
 * `sourceType = 'auction'`, so a PRICES-linked agent_research record is structurally
 * unreachable from it. These rows cannot silently become peers of Bonhams data; a consumer
 * has to ask for them by name (see queryResearchComps), which is ADR-0007 Decision 4's
 * segregated support count applied to prices.
 *
 * THE GATES, in the order they are applied. Each one exists because of a specific failure:
 *
 *   1. basis === "hammer".  The graph's comparables are hammer-anchored (ADR-0016). A
 *      premium-inclusive figure written as though it were hammer overstates by 25-30%, which
 *      is the class of error repair_bonhams_price_realised.py had to undo across 39,914 rows.
 *      Measured on the first lots to reach this code, every comp came back premium_inclusive,
 *      so this gate rejects nearly everything today. That is the gate working, not failing.
 *   2. a citation URL.  ADR-0007 Decision 3: a finding with nothing behind it is an assertion,
 *      not a record. No URL, no write, and the URL is also the dedupe key.
 *   3. a numeric price and a currency.  ADR-0016 records a real hammerPrice field reading
 *      "Estimate GBP 3,000-3,500 (hammer price not publicly disclosed)".
 *   4. a sale date and a house.  ADR-0007 Decision 1.
 *   5. the artist MATCHes an existing Artist node.  Never MERGE — ADR-0007 Decision 5 and
 *      doc09 3.1's honorific fragmentation. An artist the graph does not know is skipped.
 *   6. the work resolves on an UNAMBIGUOUS EXACT basis — exact_title, citation, or
 *      citation_and_title. The stripped-title and typo-tolerant levels exist for reading and
 *      must not drive a write: the no-fuzzy-identity rule is about writes, and this is a write.
 *   7. the sale is not already in the graph, by URL or by house + sale + lot. A real ingested
 *      record is better data than a web extract of the same sale.
 *
 * GBP is not computed here. The record carries the native hammer price, its currency and the
 * sale date; hammerPriceGBP is set only when the currency is already GBP. Everything else is
 * left for knowledge_graph/backfill_fx_gbp.py, which owns sale-date FX for every house and
 * would otherwise be competing with a second converter.
 */
import { getDriver, getDatabase } from "./client.js";
import { lookupArtistNames } from "./artist_lookup.js";
import type { Stage2bComp } from "../comp_storability.js";
import type { WorkIdentityBasis } from "./work_identity.js";

/** The identity levels a WRITE may rest on. Read-side levels are deliberately absent. */
export const WRITEABLE_WORK_BASES: readonly WorkIdentityBasis[] = ["exact_title", "citation", "citation_and_title"];

export type CompRejection =
  | "basis_not_hammer" | "no_citation_url" | "no_numeric_price" | "no_currency"
  | "no_sale_date" | "no_auction_house" | "sold_in_broader_lot";

export interface CompGateResult {
  ok: boolean;
  reason: CompRejection | null;
  /** Normalised, only when ok. */
  value: {
    listingUrl: string; house: string; saleDate: string; hammer: number; currency: string;
    saleId: string | null; lotNumber: number | null; title: string | null; technique: string | null;
  } | null;
}

const normUrl = (u: string): string => {
  try { const p = new URL(u.trim()); return `${p.host.replace(/^www\./i, "")}${p.pathname.replace(/\/+$/, "")}`.toLowerCase(); }
  catch { return u.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase(); }
};

/**
 * ISO yyyy-mm-dd, or null. A sale date that will not parse is not a sale date.
 *
 * Two traps, both found by the tests rather than by reading:
 *   - `Date.parse("23 June 2026")` yields LOCAL midnight, and `toISOString()` then rolls it
 *     back a day in any timezone ahead of UTC. Under BST that wrote 2026-06-22 for a sale on
 *     the 23rd. The date is therefore formatted from local components, never through UTC.
 *   - V8's parser is lenient enough to accept strings that name no day at all, so "summer
 *     2026" came back as a date. A sale happens ON a day; a string carrying only a year and a
 *     season is a period, and is refused rather than rounded to one.
 */
export function normaliseSaleDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (!/\b\d{4}\b/.test(s) || !/\b([1-9]|[12]\d|3[01])\b/.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Gates 1-4, pure. Identity and dedupe are gates 5-7 and need the graph.
 *
 * `wasSoldInBroaderLot` is rejected outright rather than adjusted: the price belongs to a
 * group of objects and the apportionment is the model's guess, which is not a fact about this
 * work.
 */
export function gateComp(c: Stage2bComp): CompGateResult {
  const fail = (reason: CompRejection): CompGateResult => ({ ok: false, reason, value: null });
  if (c.priceBasis !== "hammer") return fail("basis_not_hammer");
  if (c.wasSoldInBroaderLot === true) return fail("sold_in_broader_lot");
  const listingUrl = c.listingUrl?.trim();
  if (!listingUrl || !/^https?:\/\//i.test(listingUrl)) return fail("no_citation_url");
  const hammer = typeof c.priceAmount === "number" && Number.isFinite(c.priceAmount) && c.priceAmount > 0 ? c.priceAmount : null;
  if (hammer == null) return fail("no_numeric_price");
  const currency = c.priceCurrency?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return fail("no_currency");
  const saleDate = normaliseSaleDate(c.saleDate);
  if (!saleDate) return fail("no_sale_date");
  const house = c.auctionHouse?.trim();
  if (!house) return fail("no_auction_house");
  const lotRaw = c.lotNumber == null ? null : String(c.lotNumber).trim();
  const lotNumber = lotRaw && /^\d+$/.test(lotRaw) ? Number(lotRaw) : null;
  return {
    ok: true, reason: null,
    value: { listingUrl, house, saleDate, hammer, currency, saleId: c.saleId?.trim() || null, lotNumber,
             title: c.artworkTitle?.trim() || null, technique: c.technique?.trim() || null },
  };
}

/** Deterministic, so a re-run of the same appraisal updates rather than duplicates. */
export function researchCompId(v: NonNullable<CompGateResult["value"]>): string {
  const slug = normUrl(v.listingUrl).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return `agentresearch-${slug}`;
}

export interface WriteResearchCompsInput {
  comps: Stage2bComp[];
  /** Graph's own spelling. The write MATCHes it and never creates it. */
  canonicalArtistName: string;
  /** Resolved ConceptualWork ids, and the basis they were resolved on. */
  conceptualWorkIds: string[];
  workBasis: WorkIdentityBasis | null;
  /** Traceable back to the run that wrote it — ADR-0007 Decision 2. */
  originatingAppraisalId: string;
  /** ADR-0007 Decision 1: only a settled attribution contributes. */
  attributionLevel?: string | null;
  dryRun?: boolean;
}

export interface WriteResearchCompsResult {
  written: number;
  skipped: { reason: string; listingUrl?: string | null; title?: string | null }[];
  /** Set when the whole batch was refused before any comp was examined. */
  refusedBatch: string | null;
}

const ALREADY_PRESENT = `
MATCH (src:SourceRecord)
WHERE (src.listingUrl IS NOT NULL AND toLower(replace(replace(src.listingUrl,'https://',''),'http://','')) CONTAINS $urlKey)
   OR ($saleId IS NOT NULL AND $lotNumber IS NOT NULL AND src.saleId = $saleId AND src.lotNumber = $lotNumber AND src.institutionName = $house)
RETURN src.id AS id, src.sourceType AS sourceType LIMIT 1`;

const WRITE = `
MATCH (a:Artist) WHERE a.name IN $names WITH a LIMIT 1
MATCH (cw:ConceptualWork) WHERE cw.id IN $workIds
MERGE (src:SourceRecord {id: $id})
  ON CREATE SET src.sourceType = 'agent_research',
                src.reliabilityTier = 'agent_derived',
                src.discoveredBy = 'stage2b',
                src.discoveredAt = $now
SET src.institutionName = $house,
    src.saleId = $saleId,
    src.lotNumber = $lotNumber,
    src.saleDate = $saleDate,
    src.listingUrl = $listingUrl,
    src.citationUrl = $listingUrl,
    src.sold = true,
    src.hammerPrice = $hammer,
    src.hammerBasis = 'stated',
    src.priceCurrency = $currency,
    src.hammerPriceGBP = $hammerGBP,
    src.researchTitle = $title,
    src.researchTechnique = $technique,
    src.originatingAppraisalId = $appraisalId,
    src.lastConfirmedAt = $now
MERGE (src)-[:PRICES]->(cw)
MERGE (src)-[:ATTRIBUTED_TO]->(a)
RETURN src.id AS id`;

/**
 * Write the storable comps. Never throws: a graph failure must leave the appraisal intact,
 * because the write-back is a side effect of the valuation and not part of producing it.
 */
export async function writeResearchComps(input: WriteResearchCompsInput): Promise<WriteResearchCompsResult> {
  const out: WriteResearchCompsResult = { written: 0, skipped: [], refusedBatch: null };
  const level = (input.attributionLevel ?? "").toLowerCase();
  if (level !== "definitive" && level !== "probable") {
    out.refusedBatch = `attribution level "${input.attributionLevel ?? "none"}" is not definitive or probable`;
    return out;
  }
  if (!input.canonicalArtistName?.trim()) { out.refusedBatch = "no canonical artist"; return out; }
  if (!input.conceptualWorkIds.length) { out.refusedBatch = "work did not resolve"; return out; }
  if (!input.workBasis || !WRITEABLE_WORK_BASES.includes(input.workBasis)) {
    out.refusedBatch = `work identity basis "${input.workBasis ?? "none"}" is read-side only; a write needs ${WRITEABLE_WORK_BASES.join(" / ")}`;
    return out;
  }
  if (!input.comps.length) { out.refusedBatch = "no comps returned"; return out; }

  const session = getDriver().session({ database: getDatabase() });
  try {
    const { names } = await lookupArtistNames(session, input.canonicalArtistName);
    if (!names.length) { out.refusedBatch = `artist "${input.canonicalArtistName}" is not in the graph — never created here`; return out; }
    for (const comp of input.comps) {
      const g = gateComp(comp);
      if (!g.ok || !g.value) { out.skipped.push({ reason: g.reason!, listingUrl: comp.listingUrl, title: comp.artworkTitle }); continue; }
      const v = g.value;
      const present = await session.run(ALREADY_PRESENT, { urlKey: normUrl(v.listingUrl), saleId: v.saleId, lotNumber: v.lotNumber, house: v.house });
      if (present.records.length) {
        out.skipped.push({ reason: `already in the graph as ${present.records[0].get("sourceType")} (${present.records[0].get("id")})`, listingUrl: v.listingUrl, title: v.title });
        continue;
      }
      if (input.dryRun) { out.written++; continue; }
      const res = await session.run(WRITE, {
        names, workIds: input.conceptualWorkIds, id: researchCompId(v), house: v.house,
        saleId: v.saleId, lotNumber: v.lotNumber, saleDate: v.saleDate, listingUrl: v.listingUrl,
        hammer: v.hammer, currency: v.currency,
        // GBP is backfill_fx_gbp.py's job for every other currency; setting it here from a
        // guessed rate is how two converters start disagreeing.
        hammerGBP: v.currency === "GBP" ? v.hammer : null,
        title: v.title, technique: v.technique, appraisalId: input.originatingAppraisalId,
        now: new Date().toISOString(),
      });
      if (res.records.length) out.written++;
      else out.skipped.push({ reason: "artist or work vanished between check and write", listingUrl: v.listingUrl });
    }
  } catch (err: any) {
    out.refusedBatch = `write failed: ${err?.message ?? err}`;
  } finally {
    await session.close();
  }
  return out;
}

export interface ResearchComp {
  workId: string; workTitle: string | null; house: string | null; saleDate: string | null;
  hammerPrice: number | null; hammerPriceGBP: number | null; currency: string | null;
  listingUrl: string | null; originatingAppraisalId: string | null; discoveredAt: string | null;
}

const READ = `
MATCH (src:SourceRecord {sourceType:'agent_research'})-[:PRICES]->(cw:ConceptualWork)
WHERE cw.id IN $workIds AND src.hammerPrice IS NOT NULL
RETURN cw.id AS workId, cw.name AS workTitle, src.institutionName AS house, src.saleDate AS saleDate,
       src.hammerPrice AS hammerPrice, src.hammerPriceGBP AS hammerPriceGBP, src.priceCurrency AS currency,
       src.listingUrl AS listingUrl, src.originatingAppraisalId AS originatingAppraisalId, src.discoveredAt AS discoveredAt
ORDER BY src.saleDate DESC`;

/**
 * Read back what the pipeline has learned about a work's prices. Deliberately a SEPARATE call
 * from queryAuctionComparables rather than a flag on it: ADR-0007 Decision 4 requires these to
 * be counted apart from institutional and auction support, and a consumer that wants them must
 * say so. Never throws.
 */
export async function queryResearchComps(workIds: string[]): Promise<ResearchComp[]> {
  if (!workIds.length) return [];
  const session = getDriver().session({ database: getDatabase() });
  try {
    const num = (v: any) => (v == null ? null : typeof v === "number" ? v : v.toNumber?.() ?? null);
    const res = await session.run(READ, { workIds });
    return res.records.map((r) => ({
      workId: String(r.get("workId")), workTitle: r.get("workTitle") ?? null, house: r.get("house") ?? null,
      saleDate: r.get("saleDate") ?? null, hammerPrice: num(r.get("hammerPrice")), hammerPriceGBP: num(r.get("hammerPriceGBP")),
      currency: r.get("currency") ?? null, listingUrl: r.get("listingUrl") ?? null,
      originatingAppraisalId: r.get("originatingAppraisalId") ?? null, discoveredAt: r.get("discoveredAt") ?? null,
    }));
  } catch (err: any) {
    console.warn(`[queryResearchComps] failed: ${err?.message ?? err}`);
    return [];
  } finally {
    await session.close();
  }
}
