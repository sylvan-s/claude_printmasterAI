/**
 * Rijksmuseum lookup — data.rijksmuseum.nl, NO API KEY NEEDED.
 *
 * The classic www.rijksmuseum.nl/api required a self-service key; the
 * Rijksmuseum has since replaced it with data.rijksmuseum.nl, a keyless
 * Linked Art API — confirmed directly from their current docs ("No API key
 * is needed") and live-tested (creator=Rembrandt van Rijn + technique=etching
 * returned 1,319 real results). No account to register, nothing to gate.
 *
 * The `creator` search param is a scoped field match, not a broad full-text
 * search like Met's `q` or MDS's `q` — so unlike those two sources, this one
 * doesn't need the surname false-positive filter from relevance.ts. Object
 * records don't carry a plain artist-name string back (creator is expressed
 * as a Person URI, which would need a second resolve call per record to get
 * a name), so artistAsCatalogued is set to the query itself — safe here
 * specifically because the search was already scoped to that creator.
 *
 * Response shape is Linked Art JSON-LD (CIDOC-CRM) — considerably more
 * nested than Met/MDS. `referred_to_by` mixes two very different things
 * under the SAME generically-named "brief text" sub-classification: genuine
 * short inscriptions/marks (top-level classified_as 300435414) and full
 * curatorial description text (300444174) — confirmed live on the Rijks'
 * Night Watch record, which came back as a 2,345-character essay in the
 * `inscription` field before this filter existed. Only 300435414 entries
 * are used for `inscription`; `description` stays null rather than risk
 * surfacing museum-authored prose at length — see ADR-0002 on quoting vs.
 * fact-extraction from these sources.
 */
import type { MuseumRecord, SourceResult } from "./types.js";

const SEARCH_URL = "https://data.rijksmuseum.nl/search/collection";
const MAX_OBJECTS = 25;
const CONCURRENCY = 5;
const EN_LANG_ID = "http://vocab.getty.edu/aat/300388277";
const INSCRIPTION_TYPE_ID = "http://vocab.getty.edu/aat/300435414";
/** Defensive cap on any extracted field — a safety net, not the primary
 *  control (the classified_as filter above is what actually keeps
 *  curatorial essays out of `inscription`). */
const MAX_FIELD_LEN = 300;

function cap(s: string | null): string | null {
  if (!s) return s;
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) + "…" : s;
}

interface LangText {
  type?: string;
  content?: string;
  language?: { id: string }[];
  classified_as?: { id?: string }[];
}
interface Notation {
  "@language": string;
  "@value": string;
}
interface LinkedArtObject {
  id: string;
  identified_by?: LangText[];
  referred_to_by?: LangText[];
  dimension?: {
    value?: string;
    classified_as?: { notation?: Notation[] }[];
  }[];
  produced_by?: {
    technique?: { notation?: Notation[] }[];
    timespan?: { identified_by?: LangText[]; begin_of_the_begin?: string };
  };
}

function pickByLang(items: LangText[] | undefined): string | null {
  if (!items?.length) return null;
  const en = items.find((i) => i.content && i.language?.some((l) => l.id === EN_LANG_ID));
  return en?.content || items.find((i) => i.content)?.content || null;
}

function pickNotation(notations: Notation[] | undefined): string | null {
  if (!notations?.length) return null;
  return notations.find((n) => n["@language"] === "en")?.["@value"] || notations[0]?.["@value"] || null;
}

function toRecord(obj: LinkedArtObject, queryArtist: string): MuseumRecord {
  const titles = (obj.identified_by || []).filter((e) => e.type === "Name");
  const medium = (obj.produced_by?.technique || [])
    .map((t) => pickNotation(t.notation))
    .filter((v): v is string => Boolean(v));
  const dimensions = (obj.dimension || [])
    .map((d) => {
      const label = pickNotation(d.classified_as?.[0]?.notation);
      return d.value && label ? `${label}: ${d.value} cm` : null;
    })
    .filter((v): v is string => Boolean(v));
  const inscriptions = (obj.referred_to_by || [])
    .filter((r) => r.classified_as?.some((c) => c.id === INSCRIPTION_TYPE_ID))
    .map((r) => r.content)
    .filter((v): v is string => Boolean(v));
  const date = pickByLang(obj.produced_by?.timespan?.identified_by)
    || obj.produced_by?.timespan?.begin_of_the_begin?.slice(0, 4)
    || null;

  return {
    source: "rijksmuseum",
    collection: "Rijksmuseum",
    recordUrl: obj.id,
    title: cap(pickByLang(titles)),
    description: null, // deliberately not populated — see module header
    medium: medium.length ? cap([...new Set(medium)].join("; ")) : null,
    dimensions: dimensions.length ? cap(dimensions.join("; ")) : null,
    inscription: inscriptions.length ? cap([...new Set(inscriptions)].slice(0, 3).join("; ")) : null,
    date,
    // Safe to set directly here — `creator` is a scoped field search, unlike
    // Met/MDS's full-text `q`. See module header.
    artistAsCatalogued: queryArtist,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function resolveObject(id: string): Promise<LinkedArtObject | null> {
  try {
    const res = await fetch(id, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as LinkedArtObject;
  } catch {
    return null;
  }
}

export async function lookupRijksmuseum(artist: string): Promise<SourceResult> {
  try {
    // type=print keeps this scoped to what the tool is for — without it,
    // a search for e.g. Rembrandt returns paintings (The Night Watch, The
    // Syndics) ahead of any prints, which isn't the point of this tool.
    const searchParams = new URLSearchParams({ creator: artist, type: "print" });
    const res = await fetch(`${SEARCH_URL}?${searchParams}`);
    if (!res.ok) return { source: "rijksmuseum", ok: false, error: `search HTTP ${res.status}`, records: [] };
    const data = (await res.json()) as { orderedItems?: { id: string }[] };
    const ids = (data.orderedItems || []).slice(0, MAX_OBJECTS).map((i) => i.id);

    const objects = await mapWithConcurrency(ids, CONCURRENCY, resolveObject);
    const records = objects
      .filter((o): o is LinkedArtObject => o !== null)
      .map((o) => toRecord(o, artist));

    return { source: "rijksmuseum", ok: true, records };
  } catch (err: any) {
    return { source: "rijksmuseum", ok: false, error: err.message, records: [] };
  }
}
