/**
 * Forum Auctions auction discovery via the public sitemaps.
 *
 * robots.txt lists three sitemaps. Auction-level URLs are /bidding/{slug}-{id}
 * with no further path segment; lot-level URLs have an extra /{lot-slug} and are
 * ignored. The auction_id is the trailing integer of the slug.
 */

import { UA, DELAY_MS } from "./api.js";

export interface AuctionRef {
  auctionId: number;
  slug: string;       // e.g. "1009-editions-and-works-on-paper"
  saleCode: string;   // leading code, e.g. "1009"
  url: string;
}

const SITEMAPS = [
  "https://www.forumauctions.co.uk/sitemap/sitemap1.xml",
  "https://www.forumauctions.co.uk/sitemap/sitemap2.xml",
  "https://www.forumauctions.co.uk/sitemap/sitemap3.xml",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export async function discoverAuctions(): Promise<AuctionRef[]> {
  const seen = new Map<number, AuctionRef>();

  for (let i = 0; i < SITEMAPS.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const xml = await getText(SITEMAPS[i]);
    // <loc> may be wrapped in CDATA on some maps.
    const locs = [...xml.matchAll(/<loc>(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/loc>/g)].map((m) => m[1]);

    for (const loc of locs) {
      // Auction-level only: /bidding/{slug}-{id}  with no further "/" after the id.
      const m = loc.match(/\/bidding\/([A-Za-z0-9][A-Za-z0-9-]*?)-(\d+)\/?$/);
      if (!m) continue;
      const slug = m[1];
      const auctionId = Number(m[2]);
      const saleCode = slug.match(/^([A-Za-z0-9]+)/)?.[1] ?? "";
      if (!seen.has(auctionId)) seen.set(auctionId, { auctionId, slug, saleCode, url: loc });
    }
  }

  return [...seen.values()].sort((a, b) => a.auctionId - b.auctionId);
}

/**
 * Prints, editions & multiples sales.
 *
 * Forum's slugs are inconsistent, and the naive "edition|print|modern" match
 * bleeds into the BOOKS department — "online-sale-books-and-works-on-paper",
 * "modern-literature", "modern-first-editions" are books, not prints. Include the
 * print vocabulary, then explicitly exclude the books/literature markers.
 */
export function filterPrintSales(auctions: AuctionRef[]): AuctionRef[] {
  const include = /(prints?|editions?|multiples|modern-contemporary|urban-art|grosvenor)/i;
  const excludeBooks =
    /(books|literature|manuscript|library|first-edition|childrens|and-works-on-paper|works-works-on-paper)/i;
  return auctions.filter((a) => include.test(a.slug) && !excludeBooks.test(a.slug));
}
