/**
 * Swann Auction Galleries — lot data client.
 *
 * swanngalleries.com is an Invaluable "private label" storefront (its own conditions-of-sale
 * PDF is served from image.invaluable.com/privatelabel/swanngalleries/...), but unlike
 * invaluable.com itself it carries NO anti-bot notice in robots.txt (`Disallow:` is empty)
 * and runs no session/bot-check gate — a materially different, much lower-risk surface than
 * the main Invaluable marketplace.
 *
 * Each auction catalogue page client-side POSTs to a same-origin Next.js route handler that
 * proxies a single Algolia query. Captured verbatim from a live page (window.fetch patched
 * in a real browser session, 2026-09-15) rather than guessed — the endpoint 500s on any
 * request body that omits a field the real frontend sends (facets/highlightTags/tagFilters
 * included), so BODY_TEMPLATE below is deliberately a full clone of that capture with only
 * `filters` (catalogRef) and `page`/`hitsPerPage` overridden per call. No cookies, no auth,
 * no session state required — verified via a cookie-free curl.
 *
 * `lotDescription` and `artistName` are requested via `facets`/highlighting rather than
 * `attributesToRetrieve` (adding them there causes the endpoint to 500 — this backend's
 * accepted-params set is stricter than plain Algolia). They only come back inside
 * `_highlightResult.<field>.value`; with an empty `query` that value is just the plain text
 * (no <b> match spans), so `hitText()` below is a safe, un-highlighted read.
 */

const ENDPOINT = "https://www.swanngalleries.com/pl-next/api/getAlgoliaResults";
const IMAGE_BASE = "https://image.invaluable.com/housePhotos";

/** Swann's house identifier on the shared Invaluable platform. Constant across all sales. */
const HOUSE_REF = "ELZAIXCMRM";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Verbatim shape of the request the live site issues — see module docstring. */
function buildBody(catalogRef: string, page: number, hitsPerPage: number) {
  return {
    requests: [
      {
        indexName: "archive_lotNumber_asc_prod",
        params: {
          attributesToRetrieve: [
            "dateTimeLocal",
            "lotTitle",
            "lotNumber",
            "lotRef",
            "photoPath",
            "currencySymbol",
            "currencyCode",
            "priceResult",
            "estimateLow",
            "estimateHigh",
            "bidCount",
            "bids",
            "watched",
            "winner",
            "subcategoryRef",
            "categoryName",
            "subcategoryName",
            "supercategoryName",
            "reservePrice",
            "currentBid",
            "endTimeUTCUnix",
            "closed",
          ],
          facets: ["artistName", "hierarchicalCategories.lvl0", "supercategoryName"],
          filters: `catalogRef:${catalogRef} AND ( channelIDs:1 OR channelIDs:3 OR channelIDs:4 ) AND houseRef:${HOUSE_REF}`,
          highlightPostTag: "__/ais-highlight__",
          highlightPreTag: "__ais-highlight__",
          hitsPerPage,
          maxValuesPerFacet: 301,
          page,
          query: "",
          tagFilters: "",
          typoTolerance: false,
        },
      },
    ],
    isCatalogTimed: false,
    isUpcoming: false,
    userID: "",
    oasHeaders: {},
  };
}

interface HighlightField {
  value: string;
}

interface AlgoliaHit {
  objectID: string;
  lotNumber: string;
  lotRef: string;
  lotTitle: string;
  photoPath: string | null;
  dateTimeLocal: string;
  currencyCode: string;
  currencySymbol: string;
  /** Realised (hammer + premium) price. 0 on unsold/bought-in lots — never a real "sold for 0". */
  priceResult: number;
  estimateLow?: number;
  estimateHigh?: number;
  bidCount?: number;
  currentBid?: number;
  reservePrice?: number;
  closed: boolean;
  /** Populated on newer sales only (see module docstring on this project's Bonhams/Forum
   *  adapters for the same era-split pattern). Absent entirely on older catalogues. */
  supercategoryName?: string;
  categoryName?: string;
  subcategoryName?: string;
  _highlightResult: Record<string, HighlightField | undefined>;
  lotInfo: {
    seoFriendlyLotRef: string;
    seoFriendlyLotTitle: string;
    isClosed: boolean;
  };
}

interface AlgoliaResponse {
  results: [
    {
      hits: AlgoliaHit[];
      nbHits: number;
      page: number;
      nbPages: number;
      hitsPerPage: number;
    },
  ];
}

export interface RawLot {
  objectID: string;
  lotNumber: string;
  lotRef: string;
  lotTitle: string;
  /** Full cataloguing text (condition, provenance, catalogue-raisonné refs). Only present
   *  via highlight — see module docstring. */
  lotDescription: string;
  /** Often "" — many catalogue records (Old Master print sales especially, at any era) never
   *  had a distinct artist field filled in; the artist then lives only inside
   *  `lotTitle`/`lotDescription` free text, same as Bonhams/Forum's older records. */
  artistName: string;
  photoUrl: string | null;
  dateTimeLocal: string;
  currencyCode: string;
  currencySymbol: string;
  priceResult: number;
  estimateLow: number | null;
  estimateHigh: number | null;
  closed: boolean;
  sold: boolean;
  supercategoryName: string;
  categoryName: string;
  subcategoryName: string;
  lotUrl: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hitText(hit: AlgoliaHit, field: string): string {
  return hit._highlightResult[field]?.value ?? "";
}

function mapHit(hit: AlgoliaHit): RawLot {
  const closed = hit.closed ?? hit.lotInfo?.isClosed ?? false;
  const priceResult = hit.priceResult ?? 0;
  return {
    objectID: hit.objectID,
    lotNumber: hit.lotNumber,
    lotRef: hit.lotRef,
    lotTitle: hitText(hit, "lotTitle") || hit.lotTitle,
    lotDescription: hitText(hit, "lotDescription"),
    artistName: hitText(hit, "artistName"),
    photoUrl: hit.photoPath ? `${IMAGE_BASE}/${hit.photoPath.replace(/^\/+/, "")}` : null,
    dateTimeLocal: hit.dateTimeLocal,
    currencyCode: hit.currencyCode,
    currencySymbol: hit.currencySymbol,
    priceResult,
    estimateLow: hit.estimateLow ?? null,
    estimateHigh: hit.estimateHigh ?? null,
    closed,
    // A lot only ever "sold" if it closed with a real realised price — closed-but-priceResult:0
    // is a bought-in/passed lot (confirmed against the site's own "Passed" label, 2026-09-15).
    sold: closed && priceResult > 0,
    supercategoryName: hit.supercategoryName ?? "",
    categoryName: hit.categoryName ?? "",
    subcategoryName: hit.subcategoryName ?? "",
    lotUrl: `https://www.swanngalleries.com/auction-lot/${hit.lotInfo.seoFriendlyLotTitle}_${hit.lotRef}`,
  };
}

async function postLots(catalogRef: string, page: number, hitsPerPage: number): Promise<AlgoliaResponse["results"][0]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(buildBody(catalogRef, page, hitsPerPage)),
  });
  if (!res.ok) throw new Error(`getAlgoliaResults ${catalogRef} p${page}: HTTP ${res.status}`);
  const json = (await res.json()) as AlgoliaResponse;
  return json.results[0];
}

/**
 * Fetch every lot in one sale's catalogue. hitsPerPage=1000 (Algolia's usual ceiling) covers
 * every Swann print sale seen so far (largest observed: 827 lots) in a single request; the
 * loop below only kicks in for a hypothetical sale bigger than that.
 */
export async function fetchCatalogLots(
  catalogRef: string,
  opts: { hitsPerPage?: number; delayMs?: number } = {},
): Promise<RawLot[]> {
  const hitsPerPage = opts.hitsPerPage ?? 1000;
  const delayMs = opts.delayMs ?? 500;

  const first = await postLots(catalogRef, 0, hitsPerPage);
  const hits = [...first.hits];

  for (let p = 1; p < first.nbPages; p++) {
    await sleep(delayMs);
    const next = await postLots(catalogRef, p, hitsPerPage);
    hits.push(...next.hits);
  }

  return hits.map(mapHit);
}

export { HOUSE_REF, IMAGE_BASE, UA };
