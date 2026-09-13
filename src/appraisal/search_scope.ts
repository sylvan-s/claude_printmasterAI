/**
 * search_scope — keep Stage 2b's web search away from the lot it is valuing.
 *
 * Stage 2b researches the WORK; the one page it must never read is the listing for the lot
 * under appraisal. Reading it is circular on any lot and is outright leakage on a past one:
 * the page carries the hammer price the valuation is being scored against. Until now the only
 * guard was a sentence in Stage 3's prompt asking the model to recognise and discard its own
 * listing, which is a request, not a filter — and on Roseberys A0793/530 Stage 2b searched
 * `Nick Smith "Radiant Baby" Roseberys lot 530 A0793 realised price sold`, i.e. went looking
 * for exactly that page by sale code and lot number.
 *
 * Two mechanisms, because either alone leaks:
 *   - `sanitizeSearchQuery` removes the sale code, the lot number and the consigning house
 *     from the query before it is sent, so the search is for the work rather than the lot.
 *   - `filterExcludedResults` drops any result whose URL is the lot's own listing (or the same
 *     sale's page), which catches the case where a generic query surfaces it anyway.
 *
 * Both are reported to the caller so a run can show what was removed rather than silently
 * differing from what the model asked for.
 */

export interface ExcludedListingRef {
  /** Auction house as printed, e.g. "Roseberys London". */
  house?: string | null;
  /** Sale code, e.g. "A0793". */
  saleId?: string | null;
  lotNumber?: number | null;
  /** The lot's own URL, when known. */
  listingUrl?: string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function hasRef(ref: ExcludedListingRef | null | undefined): ref is ExcludedListingRef {
  return !!ref && !!(ref.saleId || ref.lotNumber != null || ref.listingUrl || ref.house);
}

/**
 * Strip the lot's own identifiers out of a search query.
 *
 * The house name is removed only alongside a sale code or lot number — "Roseberys" on its own
 * is a legitimate thing to search for ("Picasso etching Roseberys result"), and stripping every
 * mention of the consigning house would cost the model a real source of comparables. What is
 * never legitimate is naming THIS sale and THIS lot.
 */
export function sanitizeSearchQuery(query: string, ref: ExcludedListingRef | null | undefined): { query: string; removed: string[] } {
  if (!hasRef(ref) || !query.trim()) return { query, removed: [] };
  const removed: string[] = [];
  let out = query;
  const drop = (re: RegExp, label: string) => {
    if (re.test(out)) { out = out.replace(re, " "); removed.push(label); }
  };
  if (ref.saleId?.trim()) drop(new RegExp(`\\b${esc(ref.saleId.trim())}\\b`, "gi"), `sale code ${ref.saleId.trim()}`);
  if (ref.lotNumber != null) drop(new RegExp(`\\blots?\\s*#?\\s*${ref.lotNumber}\\b`, "gi"), `lot ${ref.lotNumber}`);
  // Only now, and only because the query was naming this specific sale or lot.
  if (removed.length && ref.house?.trim()) {
    const first = ref.house.trim().split(/\s+/)[0];
    drop(new RegExp(`\\b${esc(first)}('s)?\\b`, "gi"), `house ${first}`);
  }
  // Collapse the gap a removal left, and tidy a comma or bracket it stranded. NOT the quote
  // character: a space before an opening `"` is load-bearing in a phrase search.
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,)])/g, "$1").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return { query: out || query, removed };
}

const normUrl = (u: string): string => {
  try {
    const p = new URL(u.trim());
    return `${p.host.replace(/^www\./i, "")}${p.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
  }
};

/** Is this URL the lot's own listing, or the same sale's page on the same host? */
export function isExcludedUrl(url: string | null | undefined, ref: ExcludedListingRef | null | undefined): boolean {
  if (!url || !hasRef(ref)) return false;
  const u = normUrl(url);
  if (!u) return false;
  if (ref.listingUrl) {
    const own = normUrl(ref.listingUrl);
    if (own && (u === own || u.startsWith(`${own}/`))) return true;
    // Same host and the same sale segment — the sale's own index page and its sibling lots.
    if (ref.saleId?.trim()) {
      const host = own.split("/")[0];
      if (u.split("/")[0] === host && new RegExp(`(^|/)${esc(ref.saleId.trim().toLowerCase())}(-|/|$)`).test(u)) return true;
    }
    return false;
  }
  return !!ref.saleId?.trim() && new RegExp(`(^|/)${esc(ref.saleId.trim().toLowerCase())}(-|/|$)`).test(u);
}

export function filterExcludedResults<T extends { url: string }>(results: T[], ref: ExcludedListingRef | null | undefined): { results: T[]; dropped: T[] } {
  if (!hasRef(ref)) return { results, dropped: [] };
  const dropped = results.filter((r) => isExcludedUrl(r.url, ref));
  return dropped.length ? { results: results.filter((r) => !dropped.includes(r)), dropped } : { results, dropped: [] };
}
