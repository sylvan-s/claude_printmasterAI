/**
 * typo_tolerance — one-edit variant detection for READ-SIDE matching only.
 *
 * The ACKG's write rule is unchanged and absolute: catalogue records are merged into one
 * ConceptualWork on EXACT field equality, never on similarity (`catalogue_matching.py`;
 * fuzzy merging caused two real corruption incidents). Nothing in this module may be used to
 * merge, write or dedupe. It exists because the READ side has the opposite failure: a single
 * mistyped character in a house's catalogue makes an exact lookup miss a work or an artist
 * that is plainly there, and the pipeline then pays for a specialist web search, or reports a
 * "conflict" between two spellings of one name. Measured on Roseberys A0793 (2026-09-13):
 * "Storm Thorgeson" (graph: Thorgerson) produced a tree CONFLICT and Scenario 5; "Clegry
 * Boia" (graph: Clegyr Boia) left the work unresolved until Stage 2b spelled it correctly.
 *
 * The tolerance is deliberately the narrowest one that catches those: ONE edit, by optimal
 * string alignment — a substitution, an insertion, a deletion, or a transposition of two
 * adjacent characters (a transposition is TWO edits under plain Levenshtein, and typing
 * "Clegry" for "Clegyr" is exactly that, so plain Levenshtein does not cover the case this
 * was built for).
 *
 * Three guards keep it from eating real distinctions, all of them cases the plan already
 * records as price-moving:
 *   - designator tokens must be IDENTICAL on both sides. A token that is a number ("25") or a
 *     pure roman numeral ("V", "VII") names WHICH plate, state or impression this is:
 *     "Spinning Man V" vs "Spinning Man VII" and "pl. 25" vs "pl. 26" are different works and
 *     are one edit apart. They are refused here, not tolerated.
 *   - the token that differs must be long enough that one character is not most of it
 *     (`minTokenLength`, default 5) — "Boia" / "Bois" is not a typo, it is a different word.
 *   - the strings must otherwise be token-for-token equal: at most one token pair may be
 *     inexact, and every other token must match exactly.
 */

/** Optimal string alignment distance, short-circuited at `max`. Counts an adjacent
 *  transposition as one edit; unlike full Damerau-Levenshtein it does not allow edits to
 *  cross a transposed pair, which is irrelevant at max=1 and keeps it allocation-light. */
export function osaDistanceAtMost(a: string, b: string, max = 1): number | null {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return null;
  const n = a.length, m = b.length;
  let prev2: number[] = [], prev: number[] = new Array(m + 1), cur: number[] = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return null;
    prev2 = prev; prev = cur; cur = new Array(m + 1);
  }
  const d = prev[m];
  return d <= max ? d : null;
}

const DESIGNATOR = /^(?:\d+[a-z]?|[ivxlcdm]+)$/i;

/** A token that names WHICH plate, state or impression — never tolerated as a typo. */
export function isDesignatorToken(token: string): boolean {
  return DESIGNATOR.test(token);
}

const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/).filter(Boolean);

export interface TypoOptions {
  /** Shortest differing token that may still be called a typo. */
  minTokenLength?: number;
  /** Shortest whole string (letters and digits only) the check will consider at all. */
  minLength?: number;
}

/**
 * Is `a` the same string as `b` apart from a single typing slip?
 *
 * True only when every token matches exactly except one pair, that pair is one OSA edit
 * apart, neither side of it is a designator, it is long enough to carry the difference, and
 * the designator tokens on both sides are identical. Order-independent and case-insensitive.
 * Two identical strings return false — this answers "is it a VARIANT", and a caller that
 * wants equality has already tested for it.
 */
export function isTypoVariant(a: string | null | undefined, b: string | null | undefined, opts: TypoOptions = {}): boolean {
  const minTok = opts.minTokenLength ?? 5;
  const minLen = opts.minLength ?? 6;
  const ta = tokenize(a ?? ""), tb = tokenize(b ?? "");
  if (!ta.length || ta.length !== tb.length) return false;
  if (ta.join("").length < minLen || tb.join("").length < minLen) return false;
  let diffs = 0;
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] === tb[i]) continue;
    if (++diffs > 1) return false;
    if (isDesignatorToken(ta[i]) || isDesignatorToken(tb[i])) return false;
    if (Math.max(ta[i].length, tb[i].length) < minTok) return false;
    if (osaDistanceAtMost(ta[i], tb[i], 1) !== 1) return false;
  }
  return diffs === 1;
}

/**
 * The surname variant of the same test, for artist names: the LAST token is the surname, and
 * a typo there is tolerated when every other token matches exactly or is an initial of its
 * counterpart. "Storm Thorgeson" / "Storm Thorgerson" passes; "Paloma Picasso" / "Pablo
 * Picasso" does not (the surname is identical and the forenames are different people).
 */
export function isSurnameTypoVariant(a: string | null | undefined, b: string | null | undefined, opts: TypoOptions = {}): boolean {
  const ta = tokenize(a ?? ""), tb = tokenize(b ?? "");
  if (ta.length < 2 || tb.length < 2) return false;
  const sa = ta[ta.length - 1], sb = tb[tb.length - 1];
  if (sa === sb) return false;
  if (!isTypoVariant(sa, sb, { minTokenLength: opts.minTokenLength ?? 5, minLength: opts.minLength ?? 5 })) return false;
  const ra = ta.slice(0, -1), rb = tb.slice(0, -1);
  if (ra.length !== rb.length) return false;
  return ra.every((t, i) => t === rb[i] || (t.length === 1 && rb[i].startsWith(t)) || (rb[i].length === 1 && t.startsWith(rb[i])));
}
