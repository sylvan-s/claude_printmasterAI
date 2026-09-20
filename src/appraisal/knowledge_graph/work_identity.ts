/**
 * Lot → ConceptualWork identity: which catalogued work is THIS lot?
 *
 * Step 3 of docs/plans/2026-09-13-attributed-lot-valuation.md, first slice. The hammer
 * backtest put tier-1 (same_work) comp coverage at 13-15% of lots, and the misses were not
 * exotic: "Moonshine (Cristea 62)" against a work named "Moonshine", "H7-3. Butterfly Heart
 * (Large)" against "Butterfly Heart (Large)", "Reine de Joie (Adhémar 5; Wittrock P3)" against
 * "Reine de Joie". The comps query matched a lot's title against a work's principal name after
 * punctuation folding and nothing else, so an embedded citation or a trailing year was enough
 * to lose the strongest comparable there is.
 *
 * This module resolves a lot to work ids in TypeScript, where the parsing can be tested, and
 * hands the ids to Cypher, which stays exact. Four levels, tried in order; the first that
 * yields an UNAMBIGUOUS answer wins, and an ambiguous level refuses rather than falling
 * through to a weaker one:
 *
 *   exact_title        — the lot's folded title equals a work's name, alias or source title
 *   citation           — the lot cites "Bloch 1244" and exactly one work-name cluster carries it
 *   citation_and_title — the citation covers several works (a series entry) but the stripped
 *                        title picks exactly one of them
 *   stripped_title     — equal after removing embedded citations, trailing years, leading
 *                        catalogue numbers — and the residual must still be an identifying
 *                        title: "Untitled (SF 314, Lembark 270)" strips to "Untitled", which
 *                        names nothing and must not meet the artist's generic "Untitled" node
 *   stripped_no_series — additionally ignoring a ", from <series>" suffix
 *   article_title      — equal once a leading article is dropped on both sides: Roseberys
 *                        catalogues "Clown et l'Harlequin", Forum and Swann "Le Clown et
 *                        l'Harlequin" (A0793/305)
 *
 * A TITLE-LEVEL HIT IS WIDENED TO ITS SPELLING VARIANTS. The first level that answers wins, but
 * the same print is often recorded under two spellings by different houses, and stopping at the
 * first answer keeps only one of them: A0793/2 "Le Petit Équilibrist" matched Roseberys' and
 * Bonhams' nodes exactly and never reached Swann's three "Le Petit Équilibriste" sales, so the
 * lot priced with no same-work comps at all. After a title level resolves, works whose key is a
 * one-slip typo variant or a leading-article variant of the resolved key are added — unless
 * they carry a catalogue citation that contradicts the lot's or the matched works' (same
 * catalogue, different number), which is how two different plates are told apart. Citation
 * levels are never widened: a citation is already the identity.
 *
 * WHAT IS DELIBERATELY NOT STRIPPED, and why. `title_normalize.ts` exists for the title
 * EMBEDDING and removes series/portfolio designators and plate/state parentheticals so a
 * short title is not drowned by a long shared suffix. As an IDENTITY key that is exactly
 * wrong: measured on the tier-1 misses, it equated "Foxwatch Series 1" with "Foxwatch Series
 * VI". ADR-0017 records the same lesson from the graph side — plate, state and series
 * designators are identity discriminators, and the Stik colourways were corrupted by
 * stripping parentheticals. So here a parenthetical is removed only when it has the SHAPE OF
 * A CITATION (a catalogue prefix followed by a number) and its prefix is not a plate / state /
 * number / series / edition word. "(Pink)", "(Large)", "(pl. 25)", "(Series I)", "(2nd state)"
 * all survive.
 *
 * AMBIGUITY REFUSES. A citation can cover several plates ("Cramer 30" is the whole of
 * Chagall's Bible — catalogue_matching.py's confirmed corruption), and a stripped key can meet
 * two works that differ only in what was stripped. At every level the matched works are
 * grouped by their own identity key; more than one distinct key means the level cannot say
 * which work this is, and the result is `ambiguous` with no ids. Under-matching leaves a
 * valuation at tier 2; over-matching anchors it on the wrong print.
 *
 * READ-ONLY. Nothing here writes, merges, or is an identity key for ingest. The standing rule
 * against fuzzy catalogue-identity matching is about writes; this is a per-lot read whose
 * basis is reported with the result so a caller can weight it.
 */
import { getDriver, getDatabase } from "./client.js";
import { isTypoVariant } from "./typo_tolerance.js";
import { foldAccents, normalizeTitleKey } from "./unaccent.js";
import { isLowInformationTitle } from "./title_normalize.js";

export type WorkIdentityBasis = "exact_title" | "citation" | "citation_and_title" | "stripped_title" | "stripped_no_series" | "article_title" | "typo_title";

export interface WorkIdentity {
  /** Every work id to READ evidence from: the matched works plus their spelling variants. */
  workIds: string[];
  /** The ids the level itself matched, before spelling variants were added. The only ids a WRITE may use. */
  strictWorkIds: string[];
  basis: WorkIdentityBasis | null;
  /** The catalogued name the lot resolved to (one per matched work id, deduped). */
  matchedNames: string[];
  /** A level matched more than one distinct work and was refused. Which level is named. */
  ambiguousAt: WorkIdentityBasis | null;
  ambiguousNames: string[];
  candidatesConsidered: number;
  queriedTitle: string;
  identityKey: string;
  citations: Citation[];
}

export interface Citation {
  /** Prefix folded to lowercase alphanumerics: "Bloch" -> "bloch", "F./S." -> "fs". */
  prefix: string;
  /** Entry number lowercased as printed: "1244", "11bis", "377/ii". */
  number: string;
  raw: string;
}

// ── title keys ────────────────────────────────────────────────────────────────

/** Prefix words that make a parenthetical a designator, not a citation. */
const NOT_A_CITATION_PREFIX = /^(pl|plate|planche|no|nos|number|state|etat|état|series|serie|ed|edition|vol|volume|fig|figure|part|book|sheet|set|from|after|circa|c)\b/i;

/**
 * A bracketed segment with the shape of a catalogue citation: one or more "Prefix Number"
 * items separated by ; or , — "(Kemp 62)", "[Bloch 1244]", "(Adhémar 5; Wittrock P3)",
 * "(Mourlot 1217, Cramer Books 248)", "(Baer 377/II/B/a)". The prefix must start with a
 * letter and the item must carry a digit.
 */
/** A poster catalogue cites a PAGE ("Czwiklitzer p.437"), so the number may carry "p." / "pp.". */
/** "Prefix Number" — prefix starts with a letter (any script) and may contain . & ' / - and
 *  spaces ("Delteil/Stella", "Cramer Books", "F./S."); number is digits with an optional
 *  letter prefix/suffix and slash-separated state parts ("P3", "11bis", "377/II/B/a"). */
const CITATION_ITEM = /^(\p{L}[\p{L}.&'’\/\-\s]{0,30}?)\s+((?:pp?\.\s?)?[A-Za-z]?\d{1,5}[A-Za-z]{0,3}(?:\/[A-Za-z0-9]+)*)\s*$/u;
const BRACKETED = /[\[(]([^\[\]()]*)[\])]/g;

function citationItems(inner: string): Citation[] {
  const out: Citation[] = [];
  for (const part of inner.split(/[;,]/)) {
    const m = part.trim().match(CITATION_ITEM);
    if (!m) return [];                        // one non-citation item disqualifies the bracket
    if (NOT_A_CITATION_PREFIX.test(m[1].trim())) return [];
    out.push({ prefix: foldPrefix(m[1]), number: m[2].toLowerCase(), raw: part.trim() });
  }
  return out;
}

/** Same first-tier fold as knowledge_graph/catalogue_prefix.py: lowercase alphanumerics. */
export function foldPrefix(prefix: string): string {
  return foldAccents(prefix).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Citations embedded in a title's brackets. */
export function citationsInTitle(title: string): Citation[] {
  const out: Citation[] = [];
  for (const m of (title ?? "").matchAll(BRACKETED)) out.push(...citationItems(m[1]));
  return out;
}

/** Citations from a catalogue's own refs field: "Kemp 158", "M&L 193; Bloch 1244". */
export function citationsInRefs(refs: string | null | undefined): Citation[] {
  if (!refs) return [];
  const out: Citation[] = [];
  for (const part of refs.split(/[;,\n]/)) {
    const m = part.trim().match(CITATION_ITEM);
    if (m && !NOT_A_CITATION_PREFIX.test(m[1].trim())) out.push({ prefix: foldPrefix(m[1]), number: m[2].toLowerCase(), raw: part.trim() });
  }
  return out;
}

/** Strip a bracketed segment only when every item in it has citation shape. */
function stripCitationBrackets(title: string): string {
  return title.replace(BRACKETED, (whole, inner) => (citationItems(inner).length ? " " : whole));
}

const TRAILING_YEAR = /[\s,]+(?:circa\s+|c\.?\s*)?(1[5-9]\d{2}|20[0-4]\d)\s*$/i;
const BRACKETED_YEAR = /\s*[\[(]\s*(?:circa\s+|c\.?\s*)?(1[5-9]\d{2}|20[0-4]\d)\s*[\])]\s*$/i;
/** "H7-3. ", "H10-1 ", "10-1. " — Hirst H-numbers and similar leading catalogue numbers. */
const LEADING_CAT_NUM = /^\s*[A-Za-z]{0,2}\s?\d{1,4}[-.]\d{1,3}[a-z]?\.?\s+/;
/** Leading list ordinal "4. " / "12) ". */
const LEADING_ORDINAL = /^\s*\d{1,3}[.)]\s+/;
/** ", from The Empresses" / " (from the Islands Series)" — a context, kept out of the key
 *  only at the weakest level, and only when the residual is still an identifying title. */
const TRAILING_FROM = /[,;:]?\s*[\[(]?\s*\bfrom\s+(the\s+)?[^\[\]()]{2,60}[\])]?\s*$/i;

/** Level-3 key: exact key after removing embedded citations, years and leading catalogue numbers. */
export function titleIdentityKey(raw: string): string {
  let s = (raw ?? "").trim();
  s = stripCitationBrackets(s);
  s = s.replace(BRACKETED_YEAR, "").replace(TRAILING_YEAR, "");
  s = s.replace(LEADING_ORDINAL, "").replace(LEADING_CAT_NUM, "");
  s = s.replace(/^["'‘’“”]+|["'‘’“”]+$/g, "");
  return normalizeTitleKey(s);
}

const LEADING_ARTICLE = /^(the|a|an|le|la|les|l|un|une|il|lo|gli|el|los|las|der|die|das)\s+/;

/** Level-5 key: level 3 with a leading article removed. "" when there is none or nothing identifying is left. */
export function titleIdentityKeyNoArticle(raw: string): string {
  return articleless(titleIdentityKey(raw));
}

/** Drop a leading article from an identity key; "" when there is none or the rest names nothing. */
export function articleless(key: string): string {
  const without = key.replace(LEADING_ARTICLE, "");
  if (without === key) return key;
  return isIdentifyingTitle(without) ? without : "";
}

/** Level-4 key: level 3 with a trailing ", from <series>" removed. "" when nothing identifying is left. */
export function titleIdentityKeyNoSeries(raw: string): string {
  let s = (raw ?? "").trim();
  s = stripCitationBrackets(s);
  s = s.replace(BRACKETED_YEAR, "").replace(TRAILING_YEAR, "");
  s = s.replace(LEADING_ORDINAL, "").replace(LEADING_CAT_NUM, "");
  const without = s.replace(TRAILING_FROM, "");
  if (without === s) return "";                 // no series suffix: the level adds nothing
  const key = normalizeTitleKey(without.replace(/^["'‘’“”]+|["'‘’“”]+$/g, ""));
  return isIdentifyingTitle(key) ? key : "";
}

/**
 * A title that can name a work. `isLowInformationTitle` rejects "Untitled (Kiss)" because it
 * starts with "untitled"; the parenthetical is the identity ("Untitled (Blue)" and "Untitled
 * (Kiss)" are different prints), so an "Untitled" with a non-empty qualifier is identifying.
 */
export function isIdentifyingTitle(title: string): boolean {
  const s = (title ?? "").trim();
  if (s.length < 3) return false;
  if (/^(plate|pl\.?|planche|composition|abstract|figure|fig\.?|study|print|image|sheet|no\.?)\s*(no\.?\s*)?[\d]+[a-z]?\s*$/i.test(s)) return false;
  if (/^(plate|planche|figure|composition|study|print)\s+[ivxlc]+\s*$/i.test(s)) return false;
  if (/^(untitled|sans titre|ohne titel|senza titolo|no title)\s*[\[(]\s*[^\])]{2,}\s*[\])]/i.test(s)) return true;
  if (/^(untitled|sans titre|ohne titel|senza titolo|no title)\s+\S/i.test(s) && !/^(untitled|sans titre|ohne titel|senza titolo|no title)\s+(print|composition|abstract|\d+)\s*$/i.test(s)) return true;
  return !isLowInformationTitle(s);
}

// ── resolution ────────────────────────────────────────────────────────────────

export interface WorkRow {
  id: string;
  name: string;
  aliases: string[];
  /** One entry per documenting record: which sale/lot asserted which title. */
  docs: Array<{ saleId: string | null; lotNumber: number | null; title: string | null }>;
  citations: Citation[];
}

const WORKS_QUERY = `
MATCH (a:Artist) WHERE a.name = $artistName
MATCH (a)-[:CREATED]->(cw:ConceptualWork)
CALL { WITH cw
  OPTIONAL MATCH (cw)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)
  RETURN collect(DISTINCT {saleId: s.saleId, lotNumber: s.lotNumber, title: i.sourceTitle}) AS docs }
CALL { WITH cw
  OPTIONAL MATCH (cw)<-[:DOCUMENTS]-(ce:CatalogueEntry)<-[:CONTAINS]-(cr:CatalogueRaisonne)
  RETURN collect(DISTINCT CASE WHEN ce IS NULL THEN null ELSE [cr.numberingPrefix, ce.number] END) AS cits }
RETURN cw.id AS id, cw.name AS name, coalesce(cw.alternateTitles, []) AS aliases, docs, cits
`;

export async function fetchArtistWorks(canonicalArtistName: string): Promise<WorkRow[]> {
  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(WORKS_QUERY, { artistName: canonicalArtistName });
    return res.records.map((r) => ({
      id: String(r.get("id")),
      name: String(r.get("name") ?? ""),
      aliases: ((r.get("aliases") as unknown[]) ?? []).filter((x): x is string => typeof x === "string"),
      docs: ((r.get("docs") as any[]) ?? [])
        .filter((d) => d && (d.saleId != null || d.lotNumber != null || d.title != null))
        .map((d) => ({
          saleId: d.saleId == null ? null : String(d.saleId),
          lotNumber: d.lotNumber == null ? null : Number(d.lotNumber?.toNumber?.() ?? d.lotNumber),
          title: typeof d.title === "string" ? d.title : null,
        })),
      citations: ((r.get("cits") as unknown[]) ?? [])
        .filter((c): c is [string, string] => Array.isArray(c) && typeof c[0] === "string" && c[1] != null)
        .map(([p, n]) => ({ prefix: foldPrefix(p), number: String(n).toLowerCase(), raw: `${p} ${n}` })),
    }));
  } finally {
    await session.close();
  }
}

/** Group matched works by their own identity key; one group = unambiguous. */
function decide(
  level: WorkIdentityBasis,
  matched: WorkRow[],
  keyOf: (w: WorkRow) => string,
): { ok: true; ids: string[]; names: string[] } | { ok: false; names: string[] } | null {
  if (!matched.length) return null;
  const groups = new Map<string, WorkRow[]>();
  for (const w of matched) (groups.get(keyOf(w)) ?? groups.set(keyOf(w), []).get(keyOf(w))!).push(w);
  if (groups.size === 1) return { ok: true, ids: matched.map((w) => w.id), names: [...new Set(matched.map((w) => w.name))] };
  return { ok: false, names: [...groups.values()].map((g) => g[0].name) };
}

/**
 * Resolve a lot to the artist's ConceptualWork ids. `artistName` must be the graph's own
 * spelling (resolveArtistIdentity first). Pass the pre-fetched works when calling repeatedly
 * for one artist.
 */
export async function resolveWorkIdentity(input: {
  artistName: string;
  title: string;
  catalogueRefs?: string | null;
  works?: WorkRow[];
  /**
   * Backtest only: the lot being valued is itself already in the graph, so its own node
   * would match itself at exact_title and the weaker levels would never be exercised. A
   * work documented ONLY by this sale/lot is dropped, and this lot's own source title is
   * not used as a name. A production lot is not in the graph yet; this makes the backtest
   * see what production sees.
   */
  excludeSaleLot?: { saleId: string; lotNumber: number } | null;
}): Promise<WorkIdentity> {
  const title = (input.title ?? "").trim();
  const citations = [...citationsInRefs(input.catalogueRefs), ...citationsInTitle(title)];
  const exactKey = normalizeTitleKey(title);
  const key = titleIdentityKey(title);
  const keyNoSeries = titleIdentityKeyNoSeries(title);
  const base: WorkIdentity = {
    workIds: [], strictWorkIds: [], basis: null, matchedNames: [], ambiguousAt: null, ambiguousNames: [],
    candidatesConsidered: 0, queriedTitle: title, identityKey: key, citations,
  };
  if (!input.artistName?.trim()) return base;
  const ex = input.excludeSaleLot ?? null;
  const isOwn = (d: WorkRow["docs"][number]) => !!ex && d.saleId === ex.saleId && d.lotNumber === ex.lotNumber;
  const allWorks = input.works ?? (await fetchArtistWorks(input.artistName));
  // Drop a work documented only by the excluded lot; keep the rest with that lot's title removed.
  const works = ex ? allWorks.filter((w) => !w.docs.length || w.docs.some((d) => !isOwn(d))) : allWorks;
  base.candidatesConsidered = works.length;
  if (!works.length) return base;

  const identifying = isIdentifyingTitle(title);
  const keyIdentifying = key.length >= 3 && isIdentifyingTitle(key);
  const sourceTitlesOf = (w: WorkRow) => w.docs.filter((d) => !isOwn(d)).map((d) => d.title).filter((t): t is string => !!t);
  // The principal name may itself be the excluded lot's own wording (a node made from this
  // lot and later merged); if no OTHER record asserted that name, it is not evidence.
  const nameOf = (w: WorkRow): string | null => {
    if (!ex) return w.name;
    const ownTitles = w.docs.filter(isOwn).map((d) => d.title).filter(Boolean);
    if (!ownTitles.length) return w.name;
    const others = sourceTitlesOf(w);
    return ownTitles.some((t) => normalizeTitleKey(t!) === normalizeTitleKey(w.name)) && !others.some((t) => normalizeTitleKey(t) === normalizeTitleKey(w.name)) ? null : w.name;
  };
  const namesOf = (w: WorkRow) => [nameOf(w), ...w.aliases, ...sourceTitlesOf(w)].filter((t): t is string => !!t);
  const TITLE_LEVELS: WorkIdentityBasis[] = ["exact_title", "stripped_title", "stripped_no_series", "article_title", "typo_title"];
  const conflicts = (w: WorkRow, against: Citation[]) =>
    w.citations.some((c) => against.some((x) => x.prefix === c.prefix && x.number !== c.number))
    && !w.citations.some((c) => against.some((x) => x.prefix === c.prefix && x.number === c.number));
  const widen = (ids: string[], names: string[]) => {
    const matched = works.filter((w) => ids.includes(w.id));
    const keys = new Set(matched.flatMap((w) => [w.name, ...w.aliases].map((t) => titleIdentityKey(t))).concat(key ? [key] : []));
    const cited = [...citations, ...matched.flatMap((w) => w.citations)];
    const variantOf = (k: string) => [...keys].some((m) => k === m || isTypoVariant(k, m) || (!!articleless(k) && articleless(k) === articleless(m)));
    const extra = works.filter((w) => !ids.includes(w.id) && namesOf(w).some((t) => variantOf(titleIdentityKey(t))) && !conflicts(w, cited));
    return { ids: [...ids, ...extra.map((w) => w.id)], names: [...new Set([...names, ...extra.map((w) => w.name)])] };
  };
  const finish = (level: WorkIdentityBasis, d: ReturnType<typeof decide>): WorkIdentity | null => {
    if (!d) return null;
    if (d.ok && TITLE_LEVELS.includes(level)) {
      const wide = widen(d.ids, d.names);
      return { ...base, workIds: wide.ids, strictWorkIds: d.ids, basis: level, matchedNames: wide.names };
    }
    if (d.ok) return { ...base, workIds: d.ids, strictWorkIds: d.ids, basis: level, matchedNames: d.names };
    return { ...base, ambiguousAt: level, ambiguousNames: d.names };
  };

  // 1. exact folded title against name / alias / source title
  if (identifying && exactKey) {
    const r = finish("exact_title", decide("exact_title", works.filter((w) => namesOf(w).some((t) => normalizeTitleKey(t) === exactKey)), (w) => titleIdentityKey(w.name)));
    if (r) return r;
  }
  // 2. catalogue citation — one work-name cluster only; if the citation spans several works
  //    (a series entry), the stripped title may still single one out.
  const strippedHit = (ws: WorkRow[]) => (keyIdentifying ? ws.filter((w) => namesOf(w).some((t) => titleIdentityKey(t) === key)) : []);
  if (citations.length) {
    const hit = works.filter((w) => w.citations.some((c) => citations.some((x) => x.prefix === c.prefix && x.number === c.number)));
    const d = decide("citation", hit, (w) => titleIdentityKey(w.name));
    if (d?.ok) return finish("citation", d)!;
    if (d && !d.ok) {
      const narrowed = decide("citation_and_title", strippedHit(hit), (w) => titleIdentityKey(w.name));
      if (narrowed?.ok) return finish("citation_and_title", narrowed)!;
      return finish("citation", d)!;
    }
  }
  // 3. stripped key equality — the RESIDUAL must be identifying, not just the raw title
  if (keyIdentifying) {
    const r = finish("stripped_title", decide("stripped_title", strippedHit(works), (w) => titleIdentityKey(w.name)));
    if (r) return r;
  }
  // 4. stripped key with the series suffix ignored, on either side
  if (keyNoSeries) {
    const sideKey = (t: string) => titleIdentityKeyNoSeries(t) || titleIdentityKey(t);
    const r = finish("stripped_no_series", decide("stripped_no_series", works.filter((w) => namesOf(w).some((t) => sideKey(t) === keyNoSeries)), (w) => titleIdentityKey(w.name)));
    if (r) return r;
  }
  // 5. leading article dropped on both sides
  const keyArticle = keyIdentifying ? articleless(key) : "";
  if (keyArticle) {
    const r = finish("article_title", decide("article_title", works.filter((w) => namesOf(w).some((t) => articleless(titleIdentityKey(t)) === keyArticle)), (w) => articleless(titleIdentityKey(w.name))));
    if (r) return r;
  }
  // 6. LAST, and only after every exact level has missed: one typing slip in the title.
  //    A house's catalogue is typed by hand and a single wrong character ("Clegry Boia" for
  //    "Clegyr Boia", Roseberys A0793/67) otherwise costs a specialist web search to recover.
  //    isTypoVariant refuses anything where a plate/state designator differs, so series
  //    siblings cannot be reached this way. Read-side evidence only; it never merges.
  if (keyIdentifying) {
    const hit = works.filter((w) => namesOf(w).some((t) => isTypoVariant(titleIdentityKey(t), key)));
    const r = finish("typo_title", decide("typo_title", hit, (w) => titleIdentityKey(w.name)));
    if (r) return r;
  }
  return base;
}
