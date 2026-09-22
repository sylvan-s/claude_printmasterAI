/**
 * Artsy auction results for Stage 2b — other houses' sales, with the ACKG's own houses removed.
 *
 * WHY THIS EXISTS. Stage 2b's most expensive habit is web-searching for comparables: one search
 * on an A0793 lot wrote ~22k cache tokens and read ~46k, because page extracts ride along in
 * every later turn of the tool loop. Artsy's auction-results database answers the same
 * question — "has this print sold elsewhere, and for what?" — as structured rows at a few
 * hundred tokens, and covers exactly the houses the graph lacks (Christie's, Sotheby's,
 * Phillips, Kornfeld, Artcurial, Dorotheum ...).
 *
 * WHAT IT MUST NEVER DO is hand Stage 2b a sale the graph already holds. Stage 3 values from the
 * graph; the same sale arriving again as an "independent" Artsy comp counts one sale twice, on a
 * premium-inclusive basis the second time — the double-counting STEP 7 of the specialist prompt
 * already forbids for graph records. So every house with priced records in the ACKG is filtered
 * out IN CODE (see ACKG_HOUSE_KEYS), never by asking the model.
 *
 * ENDPOINT. metaphysics-cdn.artsy.net/v2, the GraphQL API Artsy's own site uses. No token. Its
 * terms of use forbid bulk collection, so this is kept to targeted calls: at most two HTTP
 * requests per tool call (artist lookup, then results), with sub-queries batched as aliases.
 * Current use is personal and non-commercial; if that changes this tool has to come out.
 *
 * IDENTITY IS EXACT-MATCH ONLY. Artsy never merges entities — "Andy Warhol", "After Andy
 * Warhol" and "Andy Warhol & Jean-Michel Basquiat" are separate artists — and its search has no
 * fuzzy matching. An artist is accepted only when its name folds to exactly one of the names
 * asked for; a work is "same_work" only when its title folds to exactly the asked title. This
 * is the same rule the ACKG merge work follows after two fuzzy-matching corruption incidents.
 *
 * Never throws: a failed call degrades to a "no results" message, like every other 2b tool.
 */
import { gbpRate } from "./knowledge_graph/fx_series.js";
import { normalizeTitleForEmbedding, isLowInformationTitle } from "./knowledge_graph/title_normalize.js";
import { normalizeTitleKey } from "./knowledge_graph/unaccent.js";

export const ARTSY_ENDPOINT = "https://metaphysics-cdn.artsy.net/v2";
/** Rows fetched per sub-query. Artsy's page cap is 100; 50 recent print results is plenty to
 *  find a same-work sale and read the market, and bounds the response. */
const FETCH_PER_QUERY = 50;
/** Rows handed to the model — the same tightness as STAGE2B_COMPS_LIMIT for graph comps. */
export const MAX_ROWS_TO_MODEL = 12;
const TIMEOUT_MS = 15_000;

// ---- house filter -------------------------------------------------------------------------

/**
 * ARTSY-HOUSE-FILTER-1.0. Houses with priced SourceRecords in the ACKG, as normalised keys.
 * Read off the graph 2026-09-22:
 *   Bonhams 52,189 · Swann Auction Galleries 14,074 · Roseberys London 12,754 ·
 *   Forum Auctions 6,228 · Skinner 1,617
 * An Artsy organisation is excluded when its key CONTAINS every token of one of these keys, so
 * "Bonhams Skinner" (the post-merger name) is caught by both, "Rosebery's" by roseberys, and
 * "Swann Galleries" by swann. Add a house here when it is ingested with prices.
 */
export const ACKG_HOUSE_KEYS: ReadonlyArray<string> = ["bonhams", "swann", "roseberys", "forum", "skinner"];

/** Tokens that carry no house identity: legal forms, "auctions", "galleries", city names. */
const HOUSE_NOISE = new Set([
  "auction", "auctions", "auctioneers", "gallery", "galleries", "house", "and", "co", "company",
  "ltd", "limited", "inc", "llc", "sa", "ag", "gmbh", "plc", "the", "de", "london", "new", "york",
]);

/** Fold a house name to its identity tokens: "Rosebery's" and "Roseberys London" -> ["roseberys"]. */
export function houseKeyTokens(name: string): string[] {
  const s = (name ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  return s.split(" ").filter((t) => t && !HOUSE_NOISE.has(t));
}

/** True when the organisation is one of the ACKG's priced houses. */
export function isAckgHouse(organization: string | null | undefined, keys: ReadonlyArray<string> = ACKG_HOUSE_KEYS): boolean {
  const tokens = new Set(houseKeyTokens(organization ?? ""));
  if (!tokens.size) return false;
  return keys.some((k) => houseKeyTokens(k).every((t) => tokens.has(t)));
}

// ---- rows -------------------------------------------------------------------------------

export interface ArtsyResultRow {
  id: string;
  title: string;
  organization: string | null;
  saleDate: string | null;
  saleTitle: string | null;
  lotNumber: string | null;
  mediumText: string | null;
  dimensionText: string | null;
  dateText: string | null;
  currency: string | null;
  boughtIn: boolean;
  estimateLow: number | null;
  estimateHigh: number | null;
  /** Premium-inclusive, as the house published it, in `currency` major units. */
  priceRealized: number | null;
  priceRealizedGBP: number | null;
  url: string;
}

export type ArtsyTier = "same_work" | "same_artist";

export interface ArtsyTieredRow extends ArtsyResultRow { tier: ArtsyTier }

/** The public page for one auction result — the citation the Stage 2b gate requires. */
export function artsyResultUrl(id: string): string {
  return `https://www.artsy.net/auction-result/${encodeURIComponent(id)}`;
}

/** Minor units -> major. Artsy returns estimates and prices as integer cents/pence. */
const major = (cents: unknown): number | null =>
  typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? cents / 100 : null;

export function parseResultNode(n: any): ArtsyResultRow | null {
  if (!n || n.internalID == null || typeof n.title !== "string") return null;
  const currency = typeof n.currency === "string" ? n.currency : null;
  const saleDate = typeof n.saleDate === "string" ? n.saleDate.slice(0, 10) : null;
  const boughtIn = n.boughtIn === true;
  const priceRealized = boughtIn ? null : major(n.priceRealized?.cents);
  let priceRealizedGBP: number | null = null;
  if (priceRealized != null && currency) {
    const fx = gbpRate(currency, saleDate);
    if (fx) priceRealizedGBP = Math.round(priceRealized / fx.rate);
  }
  return {
    id: String(n.internalID),
    title: n.title,
    organization: n.organization ?? null,
    saleDate,
    saleTitle: n.saleTitle ?? null,
    lotNumber: n.lotNumber != null ? String(n.lotNumber) : null,
    mediumText: n.mediumText ?? null,
    dimensionText: n.dimensionText ?? null,
    dateText: n.dateText ?? null,
    currency,
    boughtIn,
    estimateLow: major(n.estimate?.low),
    estimateHigh: major(n.estimate?.high),
    priceRealized,
    priceRealizedGBP,
    url: artsyResultUrl(String(n.internalID)),
  };
}

/** The title identity key: catalogue refs, years and series suffixes peeled, then folded. */
export function titleKey(raw: string): string {
  return normalizeTitleKey(normalizeTitleForEmbedding(raw));
}

// ---- same-work rule (ARTSY-SAME-WORK-1.1) ---------------------------------------------------
//
// 1.0 compared title keys alone, and the first A/B (2026-09-22) showed why that is not enough:
// Juan Gris "Nature Morte (K.34)" peels to "nature morte", which matched 16 different Gris still
// lifes as the same print. A false same_work is not harmless — it closes the research gap, which
// silences the search nudge and the gate. So 1.1 adds two conditions, both exact:
//   - CATALOGUE NUMBERS DECIDE WHEN BOTH SIDES HAVE THEM. "K.34" and "Kahnweiler 34" agree (same
//     initial, same number); "Wiseman 10" and "Wiseman 46" do not, whatever the titles say.
//   - A GENERIC TITLE NEEDS A MATCHING CATALOGUE NUMBER. "Nature morte", "Portrait", "Paysage"
//     name a genre, not a print; without agreeing numbers such a row stays same_artist.

/**
 * Catalogue references in a title, as initial + number: "(K.34)" and "(Kahnweiler 34)" -> "k34";
 * "(W. 28-30a; 60-62)" -> w28, w30a, w60, w62; "(Bloch 330, Baer 377/II/B/a)" -> b330, b377.
 * Only parenthesised text is read, where house catalogues put refs; bare numbers in a title
 * ("Party No. 10") are part of the title, not a reference.
 */
export function catalogueRefKeys(raw: string): Set<string> {
  const out = new Set<string>();
  const folded = (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const m of folded.matchAll(/\(([^()]*)\)/g)) {
    const inner = m[1];
    // A reference is a catalogue word/initial followed by its number, then any run of further
    // numbers ("28-30a; 60-62") that belong to the same catalogue.
    for (const ref of inner.matchAll(/([A-Za-z][A-Za-z]*)\.?\s*(\d+[a-z]?(?:\s*[-,;\/]\s*\d+[a-z]?)*)/g)) {
      const initial = ref[1][0].toLowerCase();
      if (/^(?:from|pl|plate|no|nr|ed|edition|state|vol|p|pp)$/i.test(ref[1])) continue;
      for (const n of ref[2].matchAll(/\d+[a-z]?/g)) out.add(`${initial}${n[0].toLowerCase()}`);
    }
  }
  return out;
}

/** Title keys that name a genre or subject rather than a print. Folded as titleKey folds. */
export const GENERIC_TITLE_KEYS: ReadonlySet<string> = new Set([
  "still life", "nature morte", "stillleben", "naturaleza muerta", "natura morta", "bodegon",
  "portrait", "self portrait", "autoportrait", "autoritratto", "portrait of a woman", "portrait of a man",
  "landscape", "paysage", "landschaft", "paesaggio", "paisaje", "seascape", "marine",
  "head", "tete", "tete de femme", "head of a woman", "woman", "femme", "femmes", "women",
  "nude", "nu", "nus", "female nude", "reclining nude", "seated nude", "standing nude", "nu couche",
  "seated woman", "femme assise", "mother and child", "couple", "figure", "figures", "personnage",
  "personnages", "composition", "abstraction", "abstract", "abstract composition", "study",
  "flowers", "fleurs", "bouquet", "bouquet de fleurs", "vase of flowers", "vase de fleurs",
  "horse", "horses", "cheval", "chevaux", "bird", "birds", "oiseau", "oiseaux", "fish", "poisson",
  "cat", "chat", "dog", "chien", "face", "faces", "visage", "visages", "the sea", "la mer",
  "sun", "soleil", "moon", "lune", "city", "ville", "street scene", "interior", "interieur",
]);

/** ARTSY-SAME-WORK-1.1: is this Artsy row the same print as the asked title? */
export function isSameWork(askedTitle: string, rowTitle: string): boolean {
  if (!askedTitle || isLowInformationTitle(askedTitle)) return false;
  const core = titleKey(askedTitle);
  if (!core || titleKey(rowTitle) !== core) return false;
  const a = catalogueRefKeys(askedTitle), b = catalogueRefKeys(rowTitle);
  if (a.size && b.size) return [...a].some((k) => b.has(k));
  return !GENERIC_TITLE_KEYS.has(core);
}

export interface FilterOptions {
  /** Title of the work under appraisal, for the same_work tier. Low-information titles are ignored. */
  workTitle?: string | null;
  /** The lot's own listing: its house and lot number. A row matching both is treated as the
   *  lot itself and dropped (no sale code on Artsy rows to be more precise with). */
  excludeHouse?: string | null;
  excludeLotNumber?: string | number | null;
  /** Backtest cut-off: drop rows sold on or after this ISO date, so a pool lot never sees its
   *  own outcome or anything later. */
  untilDate?: string | null;
}

export interface FilterOutcome {
  rows: ArtsyTieredRow[];
  droppedAckgHouse: number;
  droppedDuplicate: number;
  droppedOwnLot: number;
  droppedAfterCutoff: number;
  /** Houses kept that are not on any known list — logged so the exclusion list can be reviewed. */
  keptOrganizations: string[];
}

/**
 * Everything between Artsy's response and the model, as one pure function so it can be tested
 * without the network: ACKG houses out, duplicates out, the lot itself out, tiered, ordered.
 */
export function filterAndTier(raw: ArtsyResultRow[], opts: FilterOptions = {}): FilterOutcome {
  const out: FilterOutcome = { rows: [], droppedAckgHouse: 0, droppedDuplicate: 0, droppedOwnLot: 0, droppedAfterCutoff: 0, keptOrganizations: [] };
  const seen = new Set<string>();
  const asked = opts.workTitle ?? null;
  const excludeLot = opts.excludeLotNumber != null ? String(opts.excludeLotNumber).trim().toLowerCase() : null;
  const orgs = new Set<string>();

  for (const r of raw) {
    // Same result reached by both sub-queries, or Artsy's own duplicates (Artcurial lists some
    // lots twice, French and English titles) — house + date + lot identifies the sale.
    const dupKey = r.lotNumber && r.saleDate && r.organization
      ? `${houseKeyTokens(r.organization).join(" ")}|${r.saleDate}|${r.lotNumber.toLowerCase()}`
      : `id:${r.id}`;
    if (seen.has(dupKey) || seen.has(`id:${r.id}`)) { out.droppedDuplicate++; continue; }
    seen.add(dupKey); seen.add(`id:${r.id}`);

    if (isAckgHouse(r.organization)) { out.droppedAckgHouse++; continue; }
    if (opts.untilDate && r.saleDate && r.saleDate >= opts.untilDate.slice(0, 10)) { out.droppedAfterCutoff++; continue; }
    if (opts.excludeHouse && excludeLot && r.lotNumber?.trim().toLowerCase() === excludeLot &&
        houseKeyTokens(opts.excludeHouse).every((t) => houseKeyTokens(r.organization ?? "").includes(t))) {
      out.droppedOwnLot++; continue;
    }

    const tier: ArtsyTier = asked && isSameWork(asked, r.title) ? "same_work" : "same_artist";
    out.rows.push({ ...r, tier });
    if (r.organization) orgs.add(r.organization);
  }

  // same_work first, then newest; a sold row outranks a bought-in one of the same date.
  out.rows.sort((a, b) =>
    (a.tier === b.tier ? 0 : a.tier === "same_work" ? -1 : 1) ||
    (b.saleDate ?? "").localeCompare(a.saleDate ?? "") ||
    Number(a.boughtIn) - Number(b.boughtIn));
  out.keptOrganizations = [...orgs].sort();
  return out;
}

// ---- network ----------------------------------------------------------------------------

let callCount = 0;
let requestCount = 0;
let sameWorkRowCount = 0;

/**
 * Per-run counters, read by the Stage 2b gate the same way it reads webSearchUsage(). `sameWork`
 * is what lets an Artsy same-print sale close the research gap — see stage2b_gate.ts.
 */
export function artsyUsage(): { calls: number; requests: number; sameWork: number } {
  return { calls: callCount, requests: requestCount, sameWork: sameWorkRowCount };
}

export function resetArtsyUsage(): void {
  callCount = 0;
  requestCount = 0;
  sameWorkRowCount = 0;
}

async function gql(query: string): Promise<any> {
  requestCount++;
  const res = await fetch(ARTSY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Artsy HTTP ${res.status}`);
  const body = await res.json();
  if (body?.errors?.length && !body?.data) throw new Error(`Artsy: ${body.errors[0]?.message ?? "query error"}`);
  return body.data;
}

/** A GraphQL string literal. JSON's escaping is valid GraphQL string escaping. */
const lit = (s: string) => JSON.stringify(s);

/** Name fold for exact artist identity: case, accents, punctuation and spacing only. */
export function foldArtistName(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Artsy's slug for the artist, accepted only on an exact folded-name match with one of `names`.
 * One request: every name is searched as an alias of the same query.
 */
export async function resolveArtsyArtist(names: string[]): Promise<{ slug: string; name: string } | null> {
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 4);
  if (!uniq.length) return null;
  const wanted = new Set(uniq.map(foldArtistName));
  const q = uniq
    .map((n, i) => `s${i}: searchConnection(query: ${lit(n)}, first: 10, entities: [ARTIST]) { edges { node { ... on Artist { slug name } } } }`)
    .join("\n");
  const data = await gql(`{ ${q} }`);
  for (let i = 0; i < uniq.length; i++) {
    for (const e of data?.[`s${i}`]?.edges ?? []) {
      const node = e?.node;
      if (node?.slug && typeof node.name === "string" && wanted.has(foldArtistName(node.name))) {
        return { slug: node.slug, name: node.name };
      }
    }
  }
  return null;
}

const RESULT_FIELDS = `totalCount edges { node { internalID title organization saleDate saleTitle lotNumber
  mediumText dimensionText dateText currency boughtIn estimate { low high } priceRealized { cents } } }`;

/** Print results for the artist: a title-keyword sub-query (when a usable title is given) and
 *  an artist-wide recent sample, in ONE request. */
export async function fetchArtsyResults(slug: string, workTitle?: string | null): Promise<{ rows: ArtsyResultRow[]; totalPrintResults: number | null }> {
  const common = `first: ${FETCH_PER_QUERY}, categories: ["Print"], sort: DATE_DESC`;
  const keyword = workTitle && !isLowInformationTitle(workTitle) ? normalizeTitleForEmbedding(workTitle) : null;
  const parts = [`recent: auctionResultsConnection(${common}) { ${RESULT_FIELDS} }`];
  if (keyword) parts.push(`work: auctionResultsConnection(${common}, keyword: ${lit(keyword)}) { ${RESULT_FIELDS} }`);
  const data = await gql(`{ artist(id: ${lit(slug)}) { ${parts.join("\n")} } }`);
  const a = data?.artist ?? {};
  const nodes = [...(a.work?.edges ?? []), ...(a.recent?.edges ?? [])].map((e: any) => e?.node);
  return {
    rows: nodes.map(parseResultNode).filter((r): r is ArtsyResultRow => r !== null),
    totalPrintResults: typeof a.recent?.totalCount === "number" ? a.recent.totalCount : null,
  };
}

// ---- the tool -----------------------------------------------------------------------------

export interface ArtsyToolInput {
  /** Names to try, most authoritative first (Stage 2a's canonical name, alternates, as asked). */
  artistNames: string[];
  workTitle?: string | null;
  excludeHouse?: string | null;
  excludeLotNumber?: string | number | null;
  untilDate?: string | null;
}

export interface ArtsyToolOutcome {
  content: string;
  sameWork: number;
  rows: number;
  logLine: string;
}

const money = (v: number | null, cur: string | null) =>
  v == null ? null : `${cur ?? ""} ${Math.round(v).toLocaleString("en-GB")}`.trim();

export function formatArtsyForModel(
  artist: { slug: string; name: string },
  f: FilterOutcome,
  totalPrintResults: number | null,
): string {
  const shown = f.rows.slice(0, MAX_ROWS_TO_MODEL);
  const sameWork = f.rows.filter((r) => r.tier === "same_work").length;
  const lines = [
    `Artsy auction results for "${artist.name}" (artsy.net/artist/${artist.slug}; ${totalPrintResults ?? "?"} print results on Artsy in total).`,
    `${f.rows.length} result(s) from houses NOT in the ACKG after filtering — ${sameWork} same_work, ${f.rows.length - sameWork} same_artist. ` +
      `Removed: ${f.droppedAckgHouse} from houses already in the ACKG (Bonhams, Skinner, Swann, Roseberys, Forum — query_ackg_comparables covers those), ` +
      `${f.droppedDuplicate} duplicate(s)${f.droppedOwnLot ? `, ${f.droppedOwnLot} for this lot's own listing` : ""}${f.droppedAfterCutoff ? `, ${f.droppedAfterCutoff} dated on/after the cut-off` : ""}.`,
    "Prices are PREMIUM-INCLUSIVE as published (record priceBasis \"premium_inclusive\"); GBP is at the sale-date ECB rate. " +
      "Artsy under-records unsold lots, so a missing bought-in is not evidence of a sale. A shared title can still be a different " +
      "object — single sheet vs complete set, signed vs unsigned, a different size — so check medium and dimensions before treating a row as this print. " +
      "These are sales the graph did not return: a row you rely on belongs in auctionComps with url as its listingUrl.",
  ];
  if (!shown.length) {
    lines.push("No results from houses outside the ACKG. That is a coverage fact about Artsy, not evidence about the work.");
    return lines.join("\n");
  }
  lines.push(JSON.stringify(shown.map((r) => ({
    tier: r.tier,
    title: r.title,
    house: r.organization,
    saleDate: r.saleDate,
    lot: r.lotNumber,
    medium: r.mediumText,
    dimensions: r.dimensionText,
    date: r.dateText,
    estimate: r.estimateLow != null || r.estimateHigh != null ? `${money(r.estimateLow, r.currency) ?? "?"} – ${money(r.estimateHigh, r.currency) ?? "?"}` : null,
    realised: r.boughtIn ? "bought in" : money(r.priceRealized, r.currency),
    realisedGBP: r.priceRealizedGBP,
    url: r.url,
  }))));
  if (f.rows.length > shown.length) lines.push(`… and ${f.rows.length - shown.length} more not shown.`);
  return lines.join("\n");
}

/** The whole tool call. Counts toward artsyUsage(); never throws. */
export async function runArtsyTool(input: ArtsyToolInput): Promise<ArtsyToolOutcome> {
  callCount++;
  try {
    const artist = await resolveArtsyArtist(input.artistNames);
    if (!artist) {
      return {
        content: `Artsy has no artist whose name exactly matches ${input.artistNames.map((n) => `"${n}"`).join(" / ")}. ` +
          "Artsy search has no fuzzy matching and keeps \"After X\" / \"Attributed to X\" as separate artists, so this is a lookup miss, not evidence about the work.",
        sameWork: 0, rows: 0, logLine: "no exact artist match",
      };
    }
    const { rows, totalPrintResults } = await fetchArtsyResults(artist.slug, input.workTitle);
    const f = filterAndTier(rows, input);
    const sameWork = f.rows.filter((r) => r.tier === "same_work").length;
    sameWorkRowCount += sameWork;
    return {
      content: formatArtsyForModel(artist, f, totalPrintResults),
      sameWork,
      rows: f.rows.length,
      logLine: `${artist.slug}: ${f.rows.length} kept (${sameWork} same_work), dropped ${f.droppedAckgHouse} ACKG-house / ${f.droppedDuplicate} dup` +
        (f.keptOrganizations.length ? `; houses kept: ${f.keptOrganizations.join(", ")}` : ""),
    };
  } catch (err: any) {
    return { content: `Artsy lookup failed: ${err?.message ?? err}. Treat as no data.`, sameWork: 0, rows: 0, logLine: `failed: ${err?.message ?? err}` };
  }
}
