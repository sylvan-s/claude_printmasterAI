/**
 * Forum Auctions catalogue API client.
 *
 * Forum runs the same auction platform as Roseberys (Auction Marketer / Joomla),
 * so the getLots endpoint is identical in shape — but several field SEMANTICS
 * differ, and getting them wrong would silently corrupt the data:
 *
 *   - lot_order must be "ASC" (Roseberys wanted "lot_asc"); the wrong value throws
 *     a raw SQL error.
 *   - hammer_price is the TRUE hammer here (Roseberys' hammer_price was
 *     premium-inclusive). No premium reconstruction is needed.
 *   - `sold` is an unreliable string "0"/"1". hammer_price > 0 is the authoritative
 *     sold signal — 112 of 411 lots in a sample sale were unsold despite sold="1".
 *   - per_page=500 returns a whole sale in one call.
 *
 * robots.txt sets crawl-delay: 15 — honoured by DELAY_MS below.
 */

const BASE = "https://www.forumauctions.co.uk";
const LOTS_ENDPOINT = `${BASE}/index.php?option=com_bidding&format=json&task=commission.getLots`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** robots.txt crawl-delay for forumauctions.co.uk. Respect it. */
export const DELAY_MS = 15_000;

export interface RawLot {
  id: number;
  lot_number: number;
  total_lot_number: string;
  description: string;          // HTML: <html><body><p>artist</p><p>title</p><p>body</p>
  low_estimate: number | null;
  high_estimate: number | null;
  reserve_price: number | null;
  /** TRUE hammer price (no buyer's premium). 0 or null when unsold. */
  hammer_price: number | string | null;
  /** Unreliable "0"/"1" string — do NOT use as the sold signal. */
  sold: string | number;
  passed: string | number;
  withdrawn: number;
  published: number;
  got_arr: number;              // Artist's Resale Right → artwork copyright likely live
  auction_id: number;
  image: string | null;
  sef_link: string;
}

export interface LotPage {
  status: boolean;
  message?: string;
  total_lots: number;
  lots: RawLot[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The one authoritative sold signal at Forum: a positive hammer price. */
export function hammerOf(lot: RawLot): number | null {
  const n = typeof lot.hammer_price === "string"
    ? Number(lot.hammer_price.replace(/,/g, ""))
    : lot.hammer_price;
  return n && Number.isFinite(n) && n > 0 ? n : null;
}

export const isSold = (lot: RawLot): boolean => hammerOf(lot) !== null;

async function postLots(auctionId: number, page: number, perPage: number): Promise<LotPage> {
  const body = new URLSearchParams({
    per_page: String(perPage),
    current_page: String(page),
    auction_id: String(auctionId),
    lot_order: "ASC",
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
  if (!text.trim()) throw new Error(`getLots ${auctionId} p${page}: empty (WAF?)`);

  const json = JSON.parse(text) as LotPage;
  if (!json.status) throw new Error(`getLots ${auctionId}: ${json.message ?? "status=false"}`);
  return json;
}

/** Whole sale in one call (per_page 500 covers the largest sales seen). */
export async function fetchAuctionLots(auctionId: number, perPage = 500): Promise<RawLot[]> {
  const first = await postLots(auctionId, 1, perPage);
  const total = first.total_lots ?? first.lots.length;
  const out = [...first.lots];

  const pages = Math.ceil(total / perPage);
  for (let p = 2; p <= pages; p++) {
    await sleep(DELAY_MS);
    out.push(...(await postLots(auctionId, p, perPage)).lots);
  }
  return [...new Map(out.map((l) => [l.id, l])).values()];
}

/** Sale date isn't in the API; it's in the sale-page <title> as "| DD-MM-YYYY". */
export async function fetchSaleDate(saleUrl: string): Promise<string | null> {
  const res = await fetch(saleUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<title>[^<]*\|\s*(\d{2})-(\d{2})-(\d{4})\s*<\/title>/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;   // → ISO yyyy-mm-dd
}

export function imageUrl(lot: RawLot): string | null {
  return lot.image ? `${BASE}/${lot.image.replace(/^\/+/, "")}` : null;
}

export function lotUrl(lot: RawLot): string {
  return `${BASE}/${lot.sef_link.replace(/^\/+/, "")}`;
}

export { BASE, UA };
