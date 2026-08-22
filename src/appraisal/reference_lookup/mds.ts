/**
 * Museum Data Service lookup — keyless, aggregates multiple UK institutions.
 * Ported from the existing Python prototype (signature_analysis/mds_artist_lookup.py),
 * verified against it on the same test artist.
 *
 * No image field exists anywhere in MDS records (confirmed by inspecting raw
 * JSON directly) — metadata only. License on real records observed as
 * "CC BY-NC"; treat as fact-extraction only, not for reproducing prose verbatim.
 */
import type { MuseumRecord, SourceResult } from "./types.js";
import { matchesArtist } from "./relevance.js";

const TOKEN_URL = "https://museumdata.uk/get-api-token/get_api_token.php";
const EXTRACT_URL = "https://mds-data-1.ciim.k-int.com/api/v1/extract";

function randomUid(n = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

interface MdsUnit {
  label?: string;
  value?: string;
  units?: MdsUnit[];
}

interface MdsRawRecord {
  "@document"?: { units?: MdsUnit[] };
  "@admin"?: { uid?: string; data_source?: { organisation?: string } };
}

function findUnits(units: MdsUnit[], labelLower: string): MdsUnit[] {
  const out: MdsUnit[] = [];
  for (const u of units) {
    if ((u.label || "").toLowerCase() === labelLower) out.push(u);
    if (u.units) out.push(...findUnits(u.units, labelLower));
  }
  return out;
}

/** Some contributing institutions return raw HTML in field values (seen live
 *  on inscription text — a literal `<DIV STYLE="...">` wrapper). Strip it. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function val(units: MdsUnit[], labelLower: string): string | null {
  const found = findUnits(units, labelLower)
    .map((f) => f.value)
    .filter((v): v is string => Boolean(v))
    .map(stripHtml)
    .filter((v) => v.length > 0);
  return found.length ? found.join("; ") : null;
}

function toRecord(rec: MdsRawRecord): MuseumRecord {
  const units = rec["@document"]?.units || [];
  const admin = rec["@admin"] || {};
  const uid = admin.uid || "";

  return {
    source: "mds",
    collection: admin.data_source?.organisation || null,
    recordUrl: uid ? `https://museumdata.uk/objects/${uid}` : null,
    title: val(units, "title") || val(units, "brief description"),
    description: val(units, "brief description"),
    medium: val(units, "material"),
    dimensions: val(units, "dimension"),
    inscription: val(units, "inscription content"),
    date: val(units, "object production date"),
    artistAsCatalogued: val(units, "object production person"),
  };
}

async function getResumeToken(artist: string): Promise<string> {
  const url = `${TOKEN_URL}?${new URLSearchParams({ user_id: randomUid(), institution: "", q: artist })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
  const data = await res.json();
  if (!data.resume) throw new Error(`token endpoint error: ${data.message || JSON.stringify(data)}`);
  return data.resume as string;
}

async function fetchAllRecords(token: string): Promise<MdsRawRecord[]> {
  const records: MdsRawRecord[] = [];
  let url: string | null = `${EXTRACT_URL}?resume=${token}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`extract endpoint HTTP ${res.status}`);
    const data = await res.json();
    records.push(...(data.data || []));
    url = data.has_next ? data.next_url : null;
  }
  return records;
}

export async function lookupMds(artist: string): Promise<SourceResult> {
  try {
    const token = await getResumeToken(artist);
    const raw = await fetchAllRecords(token);
    const records = raw.map(toRecord).filter((r) => matchesArtist(r.artistAsCatalogued, artist));
    return { source: "mds", ok: true, records };
  } catch (err: any) {
    return { source: "mds", ok: false, error: err.message, records: [] };
  }
}
