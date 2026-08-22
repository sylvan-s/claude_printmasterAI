/**
 * Met Museum lookup — keyless, no image fetch. See:
 *   - departmentId as a search filter undercounts badly (confirmed empirically:
 *     5 vs. a true ~900 for one artist). Search unfiltered, then filter the
 *     fetched objects client-side on `department`/`classification` instead.
 *   - No polite rate limiting is documented by the Met; we cap concurrency
 *     and object count to stay well under anything that would trigger one.
 */
import type { MuseumRecord, SourceResult } from "./types.js";

const SEARCH_URL = "https://collectionapi.metmuseum.org/public/collection/v1/search";
const OBJECT_URL = "https://collectionapi.metmuseum.org/public/collection/v1/objects";
const MAX_OBJECTS = 25;
const CONCURRENCY = 5;

interface MetObject {
  objectID: number;
  title: string | null;
  medium: string | null;
  dimensions: string | null;
  objectDate: string | null;
  objectName: string | null;
  portfolio: string | null;
  department: string | null;
  classification: string | null;
  artistDisplayName: string | null;
  objectURL: string | null;
}

function toRecord(o: MetObject): MuseumRecord {
  return {
    source: "met",
    collection: "The Metropolitan Museum of Art",
    recordUrl: o.objectURL || null,
    title: o.title || null,
    // Met has no free-text curatorial description field for most prints —
    // portfolio/objectName is the closest thing to context it offers.
    description: o.portfolio || o.objectName || null,
    medium: o.medium || null,
    dimensions: o.dimensions || null,
    inscription: null, // not present in Met's schema
    date: o.objectDate || null,
    artistAsCatalogued: o.artistDisplayName || null,
  };
}

async function fetchObject(id: number): Promise<MetObject | null> {
  try {
    const res = await fetch(`${OBJECT_URL}/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as MetObject;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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

export async function lookupMet(artist: string): Promise<SourceResult> {
  try {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: artist })}`;
    const res = await fetch(url);
    if (!res.ok) return { source: "met", ok: false, error: `search HTTP ${res.status}`, records: [] };
    const data = (await res.json()) as { total: number; objectIDs: number[] | null };
    const ids = (data.objectIDs || []).slice(0, MAX_OBJECTS);

    const objects = await mapWithConcurrency(ids, CONCURRENCY, fetchObject);
    const records = objects
      .filter((o): o is MetObject => o !== null)
      .filter((o) => o.department === "Drawings and Prints" || (o.classification || "").includes("Print"))
      .map(toRecord);

    return { source: "met", ok: true, records };
  } catch (err: any) {
    return { source: "met", ok: false, error: err.message, records: [] };
  }
}
