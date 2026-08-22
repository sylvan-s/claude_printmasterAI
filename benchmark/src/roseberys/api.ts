/**
 * Roseberys public catalogue API client.
 *
 * Endpoint discovered from the site's own Vue frontend (`getLots()` in the
 * bidding page). Plain server-side POST works — no browser, no auth, no cookies.
 *
 * NOTE: the `keyword` parameter is rejected by a WAF rule for non-browser
 * clients. We never use it — we pull whole sales and index locally.
 */

const BASE = "https://www.roseberys.co.uk";
const LOTS_ENDPOINT = `${BASE}/index.php?option=com_bidding&format=json&task=commission.getLots`;

// lot.image is relative to the S3 asset bucket the commerce backend (Dynamics 365
// Business Central) actually serves images from — not BASE. Confirmed by inspecting
// a live lot page's rendered <img src>; the old `${BASE}/${lot.image}` construction
// 302-redirected to /404 for every lot.
const ASSET_BASE = "https://am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/roseberys/prod";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Raw lot as returned by the API. Only the fields we actually rely on. */
export interface RawLot {
  id: number;
  lot_number: number;
  total_lot_number: string;
  description: string;          // HTML, <br>-delimited
  low_estimate: number | null;
  high_estimate: number | null;
  reserve_price: number | null;
  /** TRUE hammer price. null when unsold. */
  rostrum_hammer: number | null;
  /** MISLEADING NAME: premium-inclusive price realised, as a comma string.
   *  Can be stale/non-null on unsold lots — never use it to infer `sold`. */
  hammer_price: string | null;
  sold: 0 | 1;
  passed: 0 | 1;
  withdrawn: 0 | 1;
  published: 0 | 1;
  got_arr: 0 | 1;               // Artist's Resale Right → artwork likely in copyright
  auction_id: number;
  image: string | null;         // relative path
  sef_link: string;
  watch_count?: number;
}

export interface LotPage {
  status: boolean;
  total_lots: number;
  lots: RawLot[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postLots(auctionId: number, page: number, perPage: number): Promise<LotPage> {
  const body = new URLSearchParams({
    per_page: String(perPage),
    current_page: String(page),
    auction_id: String(auctionId),
    lot_order: "lot_asc",
    sale_type: "",
    keyword: "",
    cate_arr: "[]",
    sub_cate_arr: "[]",
    makes_arr: "[]",
    models_arr: "[]",
    arr_values: "[]",
  });

  const res = await fetch(LOTS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": UA,
    },
    body,
  });

  if (!res.ok) throw new Error(`getLots ${auctionId} p${page}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error(`getLots ${auctionId} p${page}: empty response (WAF?)`);

  const json = JSON.parse(text) as LotPage;
  if (!json.status) throw new Error(`getLots ${auctionId} p${page}: status=false`);
  return json;
}

/**
 * Fetch every lot in a sale. 200/page is accepted, so a 522-lot sale is 3 calls.
 * `delayMs` throttles between pages — be a good guest.
 */
export async function fetchAuctionLots(
  auctionId: number,
  opts: { perPage?: number; delayMs?: number } = {},
): Promise<RawLot[]> {
  const perPage = opts.perPage ?? 200;
  const delayMs = opts.delayMs ?? 700;

  const first = await postLots(auctionId, 1, perPage);
  const total = first.total_lots ?? first.lots.length;
  const out = [...first.lots];

  const pages = Math.ceil(total / perPage);
  for (let p = 2; p <= pages; p++) {
    await sleep(delayMs);
    const next = await postLots(auctionId, p, perPage);
    out.push(...next.lots);
  }

  // Defensive: the API can repeat lots across pages if the sale is edited mid-pull.
  return [...new Map(out.map((l) => [l.id, l])).values()];
}

export function imageUrl(lot: RawLot): string | null {
  return lot.image ? `${ASSET_BASE}/${lot.image.replace(/^\/+/, "")}` : null;
}

export function lotUrl(lot: RawLot): string {
  return `${BASE}/${lot.sef_link.replace(/^\/+/, "")}`;
}

/** Buyer's premium implied by the two price fields on a single lot. */
export function impliedPremiumRatio(lot: RawLot): number | null {
  const realised = lot.hammer_price ? Number(String(lot.hammer_price).replace(/,/g, "")) : null;
  if (!lot.sold || !lot.rostrum_hammer || !realised) return null;
  return realised / lot.rostrum_hammer;
}

export const realisedOf = (lot: RawLot): number | null => {
  if (!lot.sold || !lot.hammer_price) return null;
  const n = Number(String(lot.hammer_price).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Auction bid increments — hammer prices land on these, premium-inclusive ones don't. */
function bidStep(v: number): number {
  if (v < 200) return 10;
  if (v < 500) return 20;
  if (v < 1000) return 50;
  if (v < 2000) return 100;
  if (v < 5000) return 200;
  if (v < 10000) return 500;
  return 1000;
}

const landsOnIncrement = (v: number): boolean => {
  const step = bidStep(v);
  return Math.abs(v - Math.round(v / step) * step) <= 1;
};

/** Premium ratios Roseberys has charged: 20%/25%/26% + VAT, plus 1.0 (already net). */
const CANDIDATE_RATIOS = [1.0, 1.2, 1.24, 1.25, 1.3, 1.312];

export interface PremiumInference {
  ratio: number;
  method: "observed" | "inferred" | "default";
  confidence: number;   // observed: 1. inferred: share of lots landing on a bid increment.
  sampleSize: number;
}

/**
 * Work out a sale's buyer's premium.
 *
 * `rostrum_hammer` (true hammer) is only populated on recent sales; older sales
 * carry results in `hammer_price` alone, which is premium-INCLUSIVE. The rate has
 * also changed over time (1.30 → 1.312), so it can't be hardcoded.
 *
 * Where both fields exist we read the ratio directly. Where only hammer_price
 * exists we infer it: dividing by the correct premium lands values back on
 * auction bid increments, dividing by the wrong one doesn't.
 */
export function inferSalePremium(lots: RawLot[]): PremiumInference {
  const observed = lots.map(impliedPremiumRatio).filter((r): r is number => r !== null);
  if (observed.length >= 5) {
    observed.sort((a, b) => a - b);
    const median = observed[Math.floor(observed.length / 2)];
    return { ratio: +median.toFixed(4), method: "observed", confidence: 1, sampleSize: observed.length };
  }

  const realised = lots.map(realisedOf).filter((v): v is number => v !== null);
  if (realised.length < 5) {
    return { ratio: 1.312, method: "default", confidence: 0, sampleSize: realised.length };
  }

  let best = { ratio: 1.312, score: -1 };
  for (const ratio of CANDIDATE_RATIOS) {
    const hits = realised.filter((v) => landsOnIncrement(v / ratio)).length;
    const score = hits / realised.length;
    if (score > best.score) best = { ratio, score };
  }
  return {
    ratio: best.ratio,
    method: "inferred",
    confidence: +best.score.toFixed(3),
    sampleSize: realised.length,
  };
}

/**
 * True hammer price for a lot, in the era-correct basis.
 * Prefers the explicit field; falls back to backing the premium out of realised.
 */
export function hammerOf(lot: RawLot, premiumRatio: number): number | null {
  if (!lot.sold) return null;
  if (lot.rostrum_hammer) return lot.rostrum_hammer;
  const realised = realisedOf(lot);
  if (!realised) return null;
  const derived = realised / premiumRatio;
  const step = bidStep(derived);
  return Math.round(derived / step) * step;   // snap to the nearest bid increment
}

export { BASE, UA };
