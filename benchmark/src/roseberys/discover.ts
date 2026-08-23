/**
 * Auction discovery via the public sitemap.
 *
 * robots.txt explicitly advertises /sitemap.xml, which makes this the sanctioned
 * enumeration route — no crawling of listing pages required. Auction ids are the
 * trailing integer of each /bidding/{slug}-{id} URL.
 */

import { UA } from "./api.js";

export interface AuctionRef {
  auctionId: number;
  slug: string;       // e.g. "A0785-prints-multiples"
  saleCode: string;   // e.g. "A0785"
  url: string;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Every auction the sitemap knows about (~360 at time of writing). */
export async function discoverAuctions(): Promise<AuctionRef[]> {
  const index = await getText("https://www.roseberys.co.uk/sitemap.xml");
  const childMaps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  const locs: string[] = [];
  for (const child of childMaps) {
    const xml = await getText(child);
    locs.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }

  const seen = new Map<number, AuctionRef>();
  for (const loc of locs) {
    const m = loc.match(/\/bidding\/([A-Za-z0-9][A-Za-z0-9-]*?)-(\d+)\/?$/);
    if (!m) continue;
    const slug = m[1];
    const auctionId = Number(m[2]);
    const saleCode = slug.match(/^(A\d+)/)?.[1] ?? "";
    if (!seen.has(auctionId)) seen.set(auctionId, { auctionId, slug, saleCode, url: loc });
  }

  return [...seen.values()].sort((a, b) => a.auctionId - b.auctionId);
}

/**
 * Filter to a department by slug keyword. Prints & Multiples has appeared under
 * several names over the years ("modern-contemporary-prints", "prints-multiples",
 * "artsy-prints-multiples", "online-..."), so match on "print" rather than an
 * exact slug.
 */
export function filterByKeyword(auctions: AuctionRef[], keyword = "print"): AuctionRef[] {
  const re = new RegExp(keyword, "i");
  return auctions.filter((a) => re.test(a.slug));
}
