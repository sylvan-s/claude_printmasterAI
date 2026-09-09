/**
 * Catalogue raisonné lookup and write-back for Stage 2b.
 *
 * Stage 2b spends web searches rediscovering facts the ACKG already holds. On the
 * 2026-09-09 A0793 attributed run it web-searched its way to "Wiseman 2-9" for Frink and
 * "Bloch 1899" for Picasso — both of which are already in the graph, ingested as
 * `CatalogueRaisonne` nodes from Roseberys/Forum catalogue citations, reachable with one
 * read. This module makes the graph the first port of call and the web the fallback.
 *
 * Two directions:
 *
 *   READ  — `queryCatalogueRaisonneForArtist` returns which catalogues raisonnés cite this
 *           artist's works, ranked by how many distinct works each covers.
 *   WRITE — `recordCatalogueRaisonneFinding` persists what Stage 2b had to go and find, so
 *           the next lot by the same artist reads it instead of searching for it. Per
 *           ADR-0007's operating principle this is called by deterministic code reading
 *           Stage 2b's already-structured ASA cells, never by the model deciding in the
 *           moment what is "worth writing".
 *
 * Two kinds of evidence, deliberately kept apart:
 *
 *   DERIVED   — inferred from ingested citations along
 *               (Artist)-[:CREATED]->(ConceptualWork)<-[:DOCUMENTS]-(CatalogueEntry)
 *               <-[:CONTAINS]-(CatalogueRaisonne). Strong when many works cite the same
 *               catalogue; noise when one does. `parse_catalogue_refs`' "last token = entry
 *               number" heuristic produces confident-looking garbage on descriptive text
 *               (knowledge_graph/catalogue_matching.py docstring, point 3) — Banksy's sole
 *               "V." citation, from a single work, is exactly that. Hence
 *               `MIN_WORKS_FOR_DERIVED_CR`: below it the citation is reported as unconfirmed
 *               rather than presented to the specialist as an established reference.
 *   RECORDED  — written back by this module from Stage 2b's own research, linked
 *               (CatalogueRaisonne)-[:CATALOGUES]->(Artist) with provenance on the
 *               relationship. Always reported, since a human-authored research finding needs
 *               no corroborating count.
 *
 * A NEGATIVE result is stored too, and is the more valuable of the two for budget: Banksy
 * has no catalogue raisonné and never will, but every Banksy lot re-runs the same fruitless
 * searches. `catalogueRaisonneStatus: "none_known"` on the Artist records that the question
 * was asked and answered.
 *
 * Write safety: this module MATCHes artists, it never MERGEs them. Creating an Artist from a
 * name Stage 2b typed is precisely how the duplicate-artist problem got started (a stray
 * `{name: "Picasso"}` alongside `"Pablo Picasso"`), and an unresolvable name is not worth
 * that. It also never touches ConceptualWork identity, the surface both confirmed ACKG
 * corruption incidents ran through.
 */
import { getDriver, getDatabase } from "./client.js";
import { foldAccents } from "./unaccent.js";

/**
 * Distinct works that must cite a catalogue before a DERIVED citation is presented as an
 * established reference. Set at 3 from the observed data: it keeps Wiseman (175 works,
 * Frink), Bloch (519, Picasso), M.C.A. Tokyo (76, Hockney) and Ginestet/Pouillon (5, Villon),
 * and drops Banksy's single "V." — the one confirmed-noise row in the set. Unfitted beyond
 * those five artists.
 */
export const MIN_WORKS_FOR_DERIVED_CR = 3;

/** How many catalogues to report per artist. Beyond this the tail is long and thin. */
export const MAX_CR_REPORTED = 6;

/** Example unconfirmed citations to name before falling back to a bare count. Picasso alone
 *  has 300+ of them — printing the list cost more context than the whole block saves, which
 *  is the opposite of the point. */
export const MAX_UNCONFIRMED_SHOWN = 3;

/**
 * Groups spelling variants of one catalogue: punctuation and spacing only, never fuzzy.
 * "Ginestet & Pouillon" / "Ginestet/Pouillon" / "Ginestet-Pouillon" are one catalogue cited
 * three ways and fragment into three below-threshold rows without this. Abbreviations are
 * deliberately NOT collapsed — "B." really is Bloch and "Ba." really is Baer, but resolving
 * that needs a similarity judgement, and every fuzzy catalogue-identity rule this project has
 * tried has corrupted something (knowledge_graph/catalogue_matching.py, points 1-2). The
 * unmerged abbreviation costs one row in a prompt block; a wrong merge costs correctness.
 */
function variantKey(prefix: string): string {
  return prefix.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface CatalogueRaisonneRef {
  /** The citation shorthand, as ingested — "Bloch", "Wiseman", "M.C.A. Tokyo". */
  numberingPrefix: string;
  /** Full title where a source carried one; most ingested rows have only the prefix. */
  title: string | null;
  /** Distinct ConceptualWorks citing it. 0 for a RECORDED-only reference. */
  works: number;
  basis: "derived" | "recorded";
  /** RECORDED only — where Stage 2b found it. */
  sourceUrl?: string | null;
}

export interface ArtistCatalogueRaisonne {
  /** The graph's canonical spelling, which may differ from the name queried. */
  artistName: string;
  queriedAs: string;
  /** Citations meeting MIN_WORKS_FOR_DERIVED_CR, plus everything RECORDED. */
  references: CatalogueRaisonneRef[];
  /** A sample of derived citations below the threshold — reported as weak, never as
   *  established, and capped at MAX_UNCONFIRMED_SHOWN. */
  unconfirmedCitations: CatalogueRaisonneRef[];
  unconfirmedCount: number;
  /** Set when a previous run concluded no catalogue raisonné exists for this artist. */
  noneKnown: boolean;
  noneKnownCheckedAt: string | null;
  /** Total catalogued works, so an empty result can be read as "no citations ingested"
   *  rather than "artist not in the graph". */
  totalWorks: number;
}

const LOOKUP = `
MATCH (a:Artist)
WHERE toLower(a.name) = toLower($artist)
   OR any(alt IN coalesce(a.alternateNames, []) WHERE toLower(alt) = toLower($artist))
WITH a LIMIT 1
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
WITH a, count(DISTINCT w) AS totalWorks
OPTIONAL MATCH (a)-[:CREATED]->(dw:ConceptualWork)<-[:DOCUMENTS]-(:CatalogueEntry)
              <-[:CONTAINS]-(dcr:CatalogueRaisonne)
WITH a, totalWorks,
     collect(DISTINCT {cr: dcr, work: dw}) AS derivedPairs
OPTIONAL MATCH (rcr:CatalogueRaisonne)-[rel:CATALOGUES]->(a)
WITH a, totalWorks, derivedPairs,
     collect(DISTINCT {prefix: rcr.numberingPrefix, title: rcr.title, url: rel.sourceUrl}) AS recorded
RETURN a.name AS artistName,
       totalWorks,
       a.catalogueRaisonneStatus AS crStatus,
       a.catalogueRaisonneCheckedAt AS crCheckedAt,
       [p IN derivedPairs WHERE p.cr IS NOT NULL |
          {prefix: p.cr.numberingPrefix, title: p.cr.title}] AS derived,
       [r IN recorded WHERE r.prefix IS NOT NULL] AS recorded
`;

function toNum(value: unknown): number {
  if (value && typeof value === "object" && "toNumber" in (value as any)) return (value as any).toNumber();
  return typeof value === "number" ? value : 0;
}

/**
 * Which catalogues raisonnés the ACKG associates with this artist. Returns null when the
 * artist is not in the graph at all — distinct from an artist who is present with no
 * citations, which returns an object with empty `references`. Never throws: this is optional
 * evidence and a graph hiccup must not take down Stage 2b.
 */
export async function queryCatalogueRaisonneForArtist(
  artistName: string,
): Promise<ArtistCatalogueRaisonne | null> {
  if (!artistName?.trim()) return null;
  const session = getDriver().session({ database: getDatabase() });
  try {
    const res = await session.run(LOOKUP, { artist: artistName.trim() });
    const rec = res.records[0];
    if (!rec) return null;

    // The derived rows come back one per (catalogue, work) pair; fold to a count per
    // catalogue here rather than in Cypher, where the double OPTIONAL MATCH makes the
    // grouping awkward to read.
    const counts = new Map<string, { display: string; surfaces: Map<string, number>; title: string | null; works: number }>();
    for (const d of (rec.get("derived") as { prefix: string; title: string | null }[]) ?? []) {
      if (!d?.prefix) continue;
      const key = variantKey(d.prefix);
      if (!key) continue;
      const cur = counts.get(key) ?? { display: d.prefix, surfaces: new Map(), title: d.title ?? null, works: 0 };
      cur.works += 1;
      cur.surfaces.set(d.prefix, (cur.surfaces.get(d.prefix) ?? 0) + 1);
      if (!cur.title && d.title) cur.title = d.title;
      counts.set(key, cur);
    }
    // Display the most-cited spelling of each catalogue, not whichever row came back first.
    for (const v of counts.values()) {
      v.display = [...v.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    const derived: CatalogueRaisonneRef[] = [...counts.values()]
      .map((v) => ({ numberingPrefix: v.display, title: v.title, works: v.works, basis: "derived" as const }))
      .sort((a, b) => b.works - a.works);

    const recorded: CatalogueRaisonneRef[] = ((rec.get("recorded") as any[]) ?? [])
      .filter((r) => r?.prefix)
      .map((r) => ({
        numberingPrefix: r.prefix as string,
        title: (r.title as string) ?? null,
        works: counts.get(variantKey(r.prefix))?.works ?? 0,
        basis: "recorded" as const,
        sourceUrl: (r.url as string) ?? null,
      }));

    // A catalogue that is both ingested and re-found by research is one catalogue; the
    // RECORDED row wins, since it carries the research provenance.
    const recordedPrefixes = new Set(recorded.map((r) => variantKey(r.numberingPrefix)));
    const strongDerived = derived.filter(
      (d) => d.works >= MIN_WORKS_FOR_DERIVED_CR && !recordedPrefixes.has(variantKey(d.numberingPrefix)),
    );

    const unconfirmed = derived.filter(
      (d) => d.works < MIN_WORKS_FOR_DERIVED_CR && !recordedPrefixes.has(variantKey(d.numberingPrefix)),
    );

    return {
      artistName: rec.get("artistName") as string,
      queriedAs: artistName.trim(),
      references: [...recorded, ...strongDerived].slice(0, MAX_CR_REPORTED),
      unconfirmedCitations: unconfirmed.slice(0, MAX_UNCONFIRMED_SHOWN),
      unconfirmedCount: unconfirmed.length,
      noneKnown: rec.get("crStatus") === "none_known",
      noneKnownCheckedAt: (rec.get("crCheckedAt") as string) ?? null,
      totalWorks: toNum(rec.get("totalWorks")),
    };
  } catch (err: any) {
    console.warn(`[queryCatalogueRaisonneForArtist] failed for "${artistName}": ${err.message}`);
    return null;
  } finally {
    await session.close();
  }
}

/** Renders one or more lookups as the block injected into Stage 2b's user text. */
export function formatCatalogueRaisonneBlock(results: (ArtistCatalogueRaisonne | null)[]): string {
  const found = results.filter((r): r is ArtistCatalogueRaisonne => !!r);
  if (found.length === 0) return "";

  const lines: string[] = [
    "",
    "",
    "ACKG CATALOGUE RAISONNÉ INDEX (read from the knowledge graph — no search was spent on this):",
  ];
  for (const r of found) {
    lines.push(`\n  ${r.artistName}${r.queriedAs !== r.artistName ? ` (queried as "${r.queriedAs}")` : ""} — ${r.totalWorks} catalogued work(s) in the graph`);
    if (r.noneKnown) {
      lines.push(`    NO CATALOGUE RAISONNÉ KNOWN — a previous run researched this and found none exists${r.noneKnownCheckedAt ? ` (checked ${r.noneKnownCheckedAt.slice(0, 10)})` : ""}. Do not spend searches re-establishing this.`);
    }
    if (r.references.length === 0 && !r.noneKnown) {
      lines.push("    No catalogue raisonné citations ingested for this artist.");
    }
    for (const c of r.references) {
      const parts = [`"${c.numberingPrefix}"`];
      if (c.title) parts.push(c.title);
      parts.push(c.basis === "recorded"
        ? `recorded by earlier Stage 2b research${c.sourceUrl ? ` — ${c.sourceUrl}` : ""}`
        : `cited by ${c.works} catalogued work(s)`);
      lines.push(`    - ${parts.join(" | ")}`);
    }
    if (r.unconfirmedCount > 0) {
      lines.push(`    Plus ${r.unconfirmedCount} thinly-cited citation(s) below the ${MIN_WORKS_FOR_DERIVED_CR}-work threshold (e.g. ${r.unconfirmedCitations.map((c) => `"${c.numberingPrefix}"`).join(", ")}) — mostly compound-citation parse noise. Do not cite these without verifying.`);
    }
  }
  lines.push(
    "",
    "HOW TO USE THIS: these are the catalogues raisonnés the graph already associates with the",
    "candidate artist(s), with the count of works citing each. Treat a listed catalogue as the",
    "established reference for that artist and go straight to pinning THIS work's entry number",
    "within it — do not spend a web search asking which catalogue raisonné exists. Spend your",
    "searches only on what is genuinely absent above.",
  );
  return lines.join("\n");
}

// ---- Write-back ------------------------------------------------------------------

/**
 * A trailing publication year is not a different catalogue.
 *
 * Observed live on 2026-09-09: the graph already held "Wiseman" for Elisabeth Frink with 106
 * ingested entries, Stage 2b researched the same catalogue and reported it as "Wiseman 1998",
 * and the write-back created a SECOND CatalogueRaisonne node with zero entries. Two nodes,
 * one catalogue — node duplication of exactly the kind this project has had to repair before.
 *
 * The rule is deliberately narrow: strip one trailing 4-digit year and compare the rest
 * exactly (accent- and case-folded). It merges "Wiseman 1998" onto "Wiseman" and leaves
 * genuinely distinct catalogues alone — "Cramer" and "Cramer Books" differ by a word, not a
 * year, so they stay separate. No similarity score is involved anywhere, which is the
 * standing rule for catalogue identity.
 */
export function catalogueMergeKey(prefix: string): string {
  return foldAccents(prefix.trim().replace(/[\s,]*\b(1[5-9]\d{2}|20\d{2})\s*$/, "").trim());
}

export interface CatalogueRaisonneFinding {
  artistName: string;
  /** The catalogue's citation shorthand — "Bloch", "Wiseman". MERGEd on the same key the
   *  Python ingest uses (`numberingPrefix`), so a re-found catalogue unifies with the
   *  ingested node rather than duplicating it. */
  catalogueName?: string | null;
  /** Full title, where Stage 2b reported one. Never overwrites an ingested title. */
  title?: string | null;
  sourceUrl?: string | null;
  /** True when Stage 2b researched the question and concluded no catalogue raisonné exists. */
  foundNone?: boolean;
}

export type CatalogueRaisonneWriteOutcome =
  | "written"
  | "recorded_none"
  | "skipped_disabled"
  | "skipped_no_artist"
  | "skipped_nothing_to_write"
  | "failed";

/**
 * Persist what Stage 2b had to research. Idempotent: re-running an appraisal for the same
 * artist and catalogue updates the provenance timestamp and writes nothing new.
 *
 * `SKIP_ACKG_WRITEBACK=1` disables it — for backtests and pool runs, where the point is to
 * measure the pipeline against a fixed graph rather than to improve the graph mid-measurement.
 */
export async function recordCatalogueRaisonneFinding(
  finding: CatalogueRaisonneFinding,
): Promise<CatalogueRaisonneWriteOutcome> {
  if (process.env.SKIP_ACKG_WRITEBACK === "1") return "skipped_disabled";
  const artist = finding.artistName?.trim();
  if (!artist) return "skipped_no_artist";

  const catalogue = finding.catalogueName?.trim();
  if (!catalogue && !finding.foundNone) return "skipped_nothing_to_write";

  const session = getDriver().session({ database: getDatabase() });
  try {
    if (finding.foundNone) {
      // Only mark "none known" on an artist that has no citations at all. An artist whose
      // works already cite a catalogue plainly has one, and Stage 2b failing to find it is a
      // search failure, not a fact about the literature.
      const res = await session.run(
        `MATCH (a:Artist)
         WHERE toLower(a.name) = toLower($artist)
            OR any(alt IN coalesce(a.alternateNames, []) WHERE toLower(alt) = toLower($artist))
         WITH a LIMIT 1
         OPTIONAL MATCH (a)-[:CREATED]->(:ConceptualWork)<-[:DOCUMENTS]-(:CatalogueEntry)
                       <-[:CONTAINS]-(cr:CatalogueRaisonne)
         WITH a, count(DISTINCT cr) AS existing
         WHERE existing = 0
         SET a.catalogueRaisonneStatus = 'none_known',
             a.catalogueRaisonneCheckedAt = $now,
             a.catalogueRaisonneCheckedBy = 'stage2b'
         RETURN a.name AS name`,
        { artist, now: new Date().toISOString() },
      );
      return res.records.length > 0 ? "recorded_none" : "skipped_nothing_to_write";
    }

    // Does this artist already have a catalogue that differs from the reported name only by
    // a trailing year? If so, attach to THAT node and enrich it, rather than forking a
    // near-duplicate. Both the ingested (derived) and previously-recorded nodes are checked.
    const existing = await session.run(
      `MATCH (a:Artist)
       WHERE toLower(a.name) = toLower($artist)
          OR any(alt IN coalesce(a.alternateNames, []) WHERE toLower(alt) = toLower($artist))
       WITH a LIMIT 1
       OPTIONAL MATCH (a)-[:CREATED]->(:ConceptualWork)<-[:DOCUMENTS]-(:CatalogueEntry)
                     <-[:CONTAINS]-(dcr:CatalogueRaisonne)
       OPTIONAL MATCH (rcr:CatalogueRaisonne)-[:CATALOGUES]->(a)
       WITH collect(DISTINCT dcr.numberingPrefix) + collect(DISTINCT rcr.numberingPrefix) AS all
       RETURN [p IN all WHERE p IS NOT NULL] AS prefixes`,
      { artist },
    );
    const key = catalogueMergeKey(catalogue);
    const mergeOnto = ((existing.records[0]?.get("prefixes") as string[]) ?? [])
      .find((p) => p !== catalogue && catalogueMergeKey(p) === key);
    if (mergeOnto) {
      console.log(`[recordCatalogueRaisonneFinding] "${catalogue}" folds onto existing "${mergeOnto}" for ${artist} — same catalogue, differing only by a trailing year`);
    }
    const catalogueKey = mergeOnto ?? catalogue;

    const res = await session.run(
      // MATCH the artist, never MERGE — see the module docstring on duplicate artists.
      `MATCH (a:Artist)
       WHERE toLower(a.name) = toLower($artist)
          OR any(alt IN coalesce(a.alternateNames, []) WHERE toLower(alt) = toLower($artist))
       WITH a LIMIT 1
       MERGE (cr:CatalogueRaisonne {numberingPrefix: $catalogue})
       SET cr.title = coalesce(cr.title, $title)
       MERGE (cr)-[rel:CATALOGUES]->(a)
       ON CREATE SET rel.discoveredBy = 'stage2b', rel.discoveredAt = $now
       SET rel.lastConfirmedAt = $now,
           rel.sourceUrl = coalesce($sourceUrl, rel.sourceUrl)
       REMOVE a.catalogueRaisonneStatus
       RETURN a.name AS name`,
      {
        artist,
        catalogue: catalogueKey,
        title: finding.title?.trim() || null,
        sourceUrl: finding.sourceUrl?.trim() || null,
        now: new Date().toISOString(),
      },
    );
    return res.records.length > 0 ? "written" : "skipped_no_artist";
  } catch (err: any) {
    console.warn(`[recordCatalogueRaisonneFinding] failed for "${artist}": ${err.message}`);
    return "failed";
  } finally {
    await session.close();
  }
}
