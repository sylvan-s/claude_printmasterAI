/**
 * Past-sale discovery via the public "Past Auctions" archive.
 *
 * swanngalleries.com's sitemap_index.xml (Yoast, WordPress) carries no auction/lot URLs at
 * all — only posts, pages and artist bios — so unlike Roseberys there's no sitemap shortcut.
 * The sanctioned-by-omission route instead is /auctions/past-auctions/?pg=N: a plain,
 * un-authenticated, robots.txt-open HTML listing (30 sales/page, reverse-chronological, back
 * to 2001) that already carries every field discovery needs in server-rendered markup —
 * no client-side rendering or JS execution required, unlike the lot data itself (see api.ts).
 *
 * Each entry is one `<div class="widget-event plab-event-item" data-event-ref="...">` block;
 * `data-event-ref` is exactly the `catalogRef` api.ts's Algolia filter needs — confirmed by
 * cross-checking against a catalogue page's own embedded `"ref":"..."` value, same string.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LISTING_URL = "https://www.swanngalleries.com/auctions/past-auctions/";
const ENTRIES_PER_PAGE = 30; // observed constant; used only to size the sinceDate stop-check

export interface AuctionRef {
  catalogId: number;
  /** The Algolia `catalogRef` filter value — pass straight to api.ts's fetchCatalogLots(). */
  catalogRef: string;
  saleNumber: number | null;
  /** The sale's own title, e.g. "Old Master Through Modern Prints" — distinct from department. */
  title: string;
  /** Swann's department taxonomy label, e.g. "Fine Art", "Fine Art Prints", "Prints & Drawings". */
  department: string;
  date: Date;
  viewLotsUrl: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const BLOCK_RE = /<div class="widget-event plab-event-item[^"]*"[\s\S]*?data-event-id="(\d+)"\s*[\r\n]+\s*data-event-ref="([A-Za-z0-9]+)"[\s\S]*?<\/article>/g;
const DATE_RE = /class="event__date">([^<]+)</;
const TITLE_RE = /class="event__title">\s*([^<]+?)\s*</;
// The department label is wrapped in an <a> when Swann's taxonomy has a live archive page for
// it, but renders as bare text otherwise (e.g. "Modern & Post-War Art" on some older sales) —
// the <a> wrapper must stay optional or ~1/4 of entries silently lose their sale number.
const DEPT_RE = /class="event__department">[\s\S]*?(?:<a[^>]*>)?\s*([^<]+?)\s*(?:<\/a>)?\s*-\s*Sale\s*(\d+)/;
const VIEW_LOTS_RE = /class="btn btn-primary btn-cta--view_lots" href="([^"]+)"/;

function parseListingPage(html: string): AuctionRef[] {
  const out: AuctionRef[] = [];
  for (const m of html.matchAll(BLOCK_RE)) {
    const [block, catalogId, catalogRef] = m;
    const dateMatch = DATE_RE.exec(block);
    const titleMatch = TITLE_RE.exec(block);
    const deptMatch = DEPT_RE.exec(block);
    const viewLotsMatch = VIEW_LOTS_RE.exec(block);
    if (!dateMatch || !titleMatch || !viewLotsMatch) continue;

    const date = new Date(dateMatch[1]);
    if (Number.isNaN(date.getTime())) continue;

    out.push({
      catalogId: Number(catalogId),
      catalogRef,
      saleNumber: deptMatch ? Number(deptMatch[2]) : null,
      title: titleMatch[1].replace(/&amp;/g, "&"),
      department: (deptMatch?.[1] ?? "").replace(/&amp;/g, "&"),
      date,
      viewLotsUrl: viewLotsMatch[1],
    });
  }
  return out;
}

/**
 * Page through the Past Auctions archive (newest first) until every entry on a page falls
 * before `sinceDate`, then stop — cheap, since the archive is already in reverse-chronological
 * order and a 10-year pull only needs ~15-20 of the ~600+ total pages across all 25 years.
 */
export async function discoverPastAuctions(
  opts: { sinceDate?: Date; maxPages?: number; delayMs?: number } = {},
): Promise<AuctionRef[]> {
  const sinceDate = opts.sinceDate ?? new Date(0);
  const maxPages = opts.maxPages ?? 200;
  const delayMs = opts.delayMs ?? 500;

  const out: AuctionRef[] = [];
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(delayMs);
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}?pg=${page}`;
    const html = await getText(url);
    const entries = parseListingPage(html);
    if (entries.length === 0) break; // past the last real page

    out.push(...entries);
    if (entries.every((e) => e.date < sinceDate)) break;
  }

  return out.filter((e) => e.date >= sinceDate);
}

/**
 * Filter to print-relevant sales by keyword, same convention as Roseberys'
 * filterByKeyword() — match on title/department rather than a fixed department-ID allowlist,
 * since Swann's "Fine Art Prints" department (current) and "Prints & Drawings" (legacy name,
 * still used on older sales) both need to match, and per-sale titles are the more reliable
 * signal than the department taxonomy, which has been renamed at least once (see
 * discoverPastAuctions()'s docstring on the archive spanning 2001-present).
 *
 * Unlike Roseberys, a plain substring match on "print" is a real false-positive trap here:
 * Swann also runs "Printed & Manuscript Americana" and "Early Printed Books" sales — rare
 * antiquarian BOOKS, not fine-art prints, a different collecting category entirely (confirmed
 * by pulling both: their lots are books/pamphlets/broadsides, no `priceResult` in the same
 * fine-art-print range). The default keyword is therefore word-bounded ("Prints"/"Print" as
 * a whole word) so it matches "Old Master Through Modern Prints" and "...Prints & Drawings"
 * but not "Printed ...".
 */
export function filterByKeyword(auctions: AuctionRef[], keyword = "\\bprints?\\b"): AuctionRef[] {
  const re = new RegExp(keyword, "i");
  return auctions.filter((a) => re.test(a.title) || re.test(a.department));
}

export { ENTRIES_PER_PAGE, UA };
