/**
 * Rijksmuseum lookup — requires a free API key (self-service registration at
 * rijksmuseum.nl; account creation isn't something to automate on someone's
 * behalf, so this is gated on RIJKSMUSEUM_API_KEY being set manually).
 *
 * UNVERIFIED: no key was available to test against live. Implemented against
 * the documented public REST API shape (rijksmuseum.nl/api/en/collection).
 * Confirm field names against a real response before relying on this — Met
 * and MDS below are both live-tested; this one isn't yet.
 *
 * Collection metadata license: CC BY (attribution) for the basic set per
 * Rijksmuseum's own developer docs — notably not NC-restricted like MDS.
 */
import type { MuseumRecord, SourceResult } from "./types.js";

const SEARCH_URL = "https://www.rijksmuseum.nl/api/en/collection";
const MAX_OBJECTS = 25;

interface RijksArtObject {
  objectNumber: string;
  title: string | null;
  longTitle: string | null;
  principalOrFirstMaker: string | null;
  links?: { self?: string };
}

interface RijksArtObjectDetail {
  artObject: {
    objectNumber: string;
    title: string | null;
    description: string | null;
    physicalMedium: string | null;
    subTitle: string | null; // often carries dimensions as free text
    dating?: { presentingDate?: string | null };
    principalOrFirstMaker: string | null;
    inscriptions?: { inscription?: string }[];
    links?: { self?: string };
  };
}

function toRecord(detail: RijksArtObjectDetail["artObject"]): MuseumRecord {
  return {
    source: "rijksmuseum",
    collection: "Rijksmuseum",
    recordUrl: detail.links?.self || null,
    title: detail.title || null,
    description: detail.description || null,
    medium: detail.physicalMedium || null,
    dimensions: detail.subTitle || null,
    inscription: detail.inscriptions?.map((i) => i.inscription).filter(Boolean).join("; ") || null,
    date: detail.dating?.presentingDate || null,
    artistAsCatalogued: detail.principalOrFirstMaker || null,
  };
}

export async function lookupRijksmuseum(artist: string): Promise<SourceResult> {
  const apiKey = process.env.RIJKSMUSEUM_API_KEY;
  if (!apiKey) {
    return {
      source: "rijksmuseum",
      ok: false,
      error: "RIJKSMUSEUM_API_KEY not set — register at rijksmuseum.nl for a free key",
      records: [],
    };
  }

  try {
    const searchParams = new URLSearchParams({
      key: apiKey,
      q: artist,
      type: "print",
      ps: String(MAX_OBJECTS),
    });
    const res = await fetch(`${SEARCH_URL}?${searchParams}`);
    if (!res.ok) return { source: "rijksmuseum", ok: false, error: `search HTTP ${res.status}`, records: [] };
    const data = (await res.json()) as { artObjects: RijksArtObject[] };

    const details = await Promise.all(
      data.artObjects.map(async (o) => {
        try {
          const dRes = await fetch(
            `${SEARCH_URL}/${o.objectNumber}?${new URLSearchParams({ key: apiKey })}`,
          );
          if (!dRes.ok) return null;
          const d = (await dRes.json()) as RijksArtObjectDetail;
          return d.artObject;
        } catch {
          return null;
        }
      }),
    );

    const records = details.filter((d): d is RijksArtObjectDetail["artObject"] => d !== null).map(toRecord);
    return { source: "rijksmuseum", ok: true, records };
  } catch (err: any) {
    return { source: "rijksmuseum", ok: false, error: err.message, records: [] };
  }
}
