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
  return lot.image ? `${BASE}/${lot.image.replace(/^\/+/, "")}` : null;
}

export function lotUrl(lot: RawLot): string {
  return `${BASE}/${lot.sef_link.replace(/^\/+/, "")}`;
}

/** Buyer's premium implied by the two price fields. ~1.312 for this house. */
export function impliedPremiumRatio(lot: RawLot): number | null {
  const realised = lot.hammer_price ? Number(String(lot.hammer_price).replace(/,/g, "")) : null;
  if (!lot.sold || !lot.rostrum_hammer || !realised) return null;
  return realised / lot.rostrum_hammer;
}

export { BASE, UA };
