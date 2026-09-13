# ADR-0012: Local ULAN mirror, with an occupation filter and scheduled refresh

**Date:** 2026-08-31
**Status:** Partly implemented — see *Implementation status* at the foot of this file (2026-09-11). Steps 1–3 of the suggested order are done and in use; step 4 (swapping the live resolver's internals) and step 5 (scheduled refresh) are not.

---

## Context

`resolve_artist_identity.py`'s `_search_ulan()` queries Getty's live SPARQL endpoint
(`vocab.getty.edu/sparql`) for every single artist name resolved — this session's
backfill and verification work has hit that endpoint several thousand times across two
full runs plus the dedupe pass's dependent lookups. Two real, recurring problems came
out of that:

1. **The endpoint is flaky/slow under load** — the module docstring already documents
   one bug fixed this way (a 200-with-0-bytes response on an indented query string), and
   `_fetch_bio()`'s own comment records that joining biography text into the bulk search
   query made it take 60+ seconds, which is why bio is fetched separately, per-candidate,
   only for the top-ranked result.
2. **`_search_ulan()`'s query has no occupation filter at all** — confirmed this
   session by inspecting Rembrandt's live ULAN record: the query only constrains
   `a gvp:PersonConcept` ("is this any person"), with nothing narrowing to artists.
   This is the direct, traced cause of every name-collision bug found this session —
   Sidney Nolan's wrong candidate was a Russian sculptor and an American filmmaker;
   Graham Sutherland's wrong ULAN (already live in the graph before this session) was a
   British architect; John Flaxman's other two candidates were his own non-artist father
   and wife. The Wikidata side of the resolver already does this correctly
   (`_ARTIST_OCCUPATION_QIDS`, checked against P106) — ULAN has no equivalent.

**What ULAN actually exposes for occupation, confirmed by direct SPARQL inspection
this session:** `gvp:agentType` (multi-valued) and `gvp:agentTypePreferred` (the primary
role), both pointing to AAT (Art & Architecture Thesaurus) concept URIs. Rembrandt's
record carries painters (aat:300025136), etchers (aat:300025174), engravers/printmakers
(aat:300025165), printmakers (aat:300025164), draftsmen (aat:300112172), portraitists
(aat:300237351), and the general "artists (visual artists)" (aat:300025103) as his
preferred type — alongside non-artist roles (teacher, collector), which itself confirms
the predicate correctly distinguishes role types rather than being a blunt yes/no artist
flag. This is directly filterable the same way the Wikidata side already filters on
`P106 IN artist_occupation_set`.

**Why a local mirror, not just adding the filter to the live query:** Getty explicitly
publishes ULAN as a bulk download (N-Triples, full dataset) under the Open Data Commons
Attribution License (ODC-BY 1.0 — free, attribution-only), refreshed at least monthly
per Getty's own vocabulary-program documentation. This is Getty's intended distribution
channel for exactly this use case, not scraping. A local copy fixes the flakiness
problem at the root (no more live-endpoint dependency for the bulk of lookups), makes
the occupation filter and the bio join both cheap (local index scan instead of a network
round-trip that previously risked a 60-second timeout), and removes PrintMasterAI's
several-thousand-query-per-run load from Getty's shared public endpoint.

**Explicitly out of scope: a local Wikidata mirror.** Wikidata is 100M+ entities,
multi-hundred-GB even in dump form — mirroring it for a few thousand artist lookups is
wildly disproportionate. The `wbsearchentities`/`wbgetentities` API already in use is
Wikidata's own free, unlimited-for-reasonable-use hosted service; the graph already
caches what's been resolved (`wikidataUrl` on Artist nodes). No changes proposed there.

---

## Decision

### 1. Data source and format — VERIFIED 2026-08-31

Real download confirmed via `vocab.getty.edu`'s Documentation and Downloads section
(not the click-through-gated `ulandownloads.getty.edu` landing page, which doesn't
render via a scripted fetch — the direct file links work fine via plain HTTP/curl,
they're just not linked from a page a scraper can easily discover). Two options:

- `http://ulandownloads.getty.edu/VocabData/full.zip` — 638 MB compressed (includes
  precomputed transitive-closure predicates, e.g. `broaderExtended`)
- `http://ulandownloads.getty.edu/VocabData/explicit.zip` — **395 MB compressed,
  chosen** — only explicitly-asserted facts, no redundant closure. Downloaded and
  inspected this session.

**`explicit.zip` is not one N-Triples file — it's 22 separate predicate-scoped files,
totaling 8.8 GB uncompressed.** Most of that is irrelevant to this use case:
`RevisionHistory.nt` alone is 3.12 GB (pure edit-history metadata), and
`SourceRels.nt`/`RevisionHistorySource.nt`/`ContribRels.nt` add another ~1.5 GB of
citation/provenance data we don't need. The files actually relevant to name search +
occupation filtering + bio:

| File | Size | Contents (verified by direct inspection) |
|---|---|---|
| `ULANOut_1Subjects.nt` | 447 MB | `rdf:type` (confirms `PersonConcept`), `parentString`/`parentStringAbbrev` |
| `ULANOut_2Terms.nt` | 1.24 GB | name labels — two-hop: subject → `prefLabelGVP`/`altLabel` → term URI → `skosxl:literalForm` (the actual string) |
| `ULANOut_AgentTypes.nt` | 760 MB | `agentType`/`agentTypePreferred` → AAT role concept URIs — confirmed identical structure to the live-SPARQL result found earlier this session |
| `ULANOut_Biographies.nt` | 772 MB | biography text (the `_fetch_bio()` equivalent) |
| `ULANOut_WikidataAlignment.nt` | 9 MB | direct `skos:exactMatch` to a Wikidata QID per ULAN record — a bonus signal not in the original plan, could reduce reliance on live Wikidata lookups for records Getty has already aligned |

Core working set: **~3.2 GB uncompressed** across these 5 files (vs. 8.8 GB for
everything) — comfortably skip `RevisionHistory`, `SourceRels`, `ContribRels`,
`HierarchicalRels` (redundant — this is the "explicit" release specifically to avoid
needing it), `ScopeNotes`, `Sources`, `Nationality`/`Event` (optional nice-to-haves, not
in the core set), and the rest.

**Total person-record count: 355,775** (`rdf:type PersonConcept` in `1Subjects.nt`,
counted directly) — this is the real number, well below the ~1.5-3M rough prior
estimated before verification. Comfortably small for SQLite: no sharding, no exotic
indexing needed, sub-millisecond FTS lookups on ordinary hardware.

### 2. Storage: SQLite with FTS5, not Neo4j

This is reference/lookup data, not part of the ACKG's own domain graph — it doesn't need
graph traversal, and loading 1-3M extra nodes into the AuraDB Free instance (which
already holds the real ACKG) would compete with the project's actual data for a
constrained free-tier budget. A standalone SQLite file with the FTS5 full-text-search
extension is a better fit: fast name lookup (replacing `luc:term`), cheap to rebuild on
refresh, no server to run, and trivially portable between the local dev machine and any
future scheduled-job environment.

Proposed schema:

```sql
CREATE TABLE ulan_person (
    ulan_id TEXT PRIMARY KEY,          -- e.g. "500011051"
    pref_name TEXT NOT NULL,
    agent_types TEXT NOT NULL,         -- JSON array of AAT concept ids, e.g. ["300025136","300025164"]
    agent_type_preferred TEXT,         -- single AAT concept id
    bio TEXT,                          -- short biographyPreferred description, if present
    nationality_note TEXT,             -- best-effort, from broaderPreferred / parentString
    is_artist BOOLEAN NOT NULL         -- precomputed: any agent_type in the artist AAT set
);

CREATE TABLE ulan_name (
    ulan_id TEXT NOT NULL REFERENCES ulan_person(ulan_id),
    name TEXT NOT NULL                 -- every rdfs:label variant, incl. "Surname, First" form
);

CREATE VIRTUAL TABLE ulan_name_fts USING fts5(name, ulan_id UNINDEXED, content=ulan_name);
```

Filter to `PersonConcept` only at parse time (drops corporate bodies and the AAT-style
hierarchy/role concepts ULAN also bundles), which should shrink the working set
substantially before it ever reaches SQLite.

### 3. Occupation filter, precomputed

Reuse (and slightly extend, to also cover sculptor/illustrator/graphic-artist roles the
way Wikidata's `_ARTIST_OCCUPATION_QIDS` does) this session's confirmed artist-role AAT
set: `{300025103, 300025136, 300025164, 300025165, 300025174, 300112172, 300237351,
...}`. Compute `is_artist` once at build time per person, not per query — makes the
filter a zero-cost indexed boolean check instead of a repeated set-membership test.

### 4. Drop-in query interface — don't rewrite the consumers

`resolve_artist_identity.py`, `backfill_artist_ulan.py`, and
`verify_ambiguous_artists.py` should not need rewriting. Replace `_search_ulan()`'s body
to query the local SQLite FTS index instead of live SPARQL, keeping the exact same
return shape (`[{"ulan": {...}, "name": {...}}, ...]`) the callers already expect.
Same for `_fetch_bio()` — now a plain local `SELECT bio FROM ulan_person WHERE
ulan_id = ?`, no network round-trip, no timeout risk. `resolve_artist()`'s scoring logic,
confidence tiers, and the `wd_auto` fix from earlier this session are unaffected — this
change is scoped entirely to where the candidate list comes from, not how it's judged.

### 5. Scheduled refresh

This project already has a working precedent for scheduled external-service jobs: the
`sylvan-s/printmaster-keepalive` GitHub Action (pings Render/Supabase/Neo4j every 4 days
— see [[project-keepalive-infra]]). A similar scheduled job (GitHub Action, or an
Anthropic scheduled cloud routine via the `/schedule` skill) re-downloads Getty's dump,
rebuilds the SQLite file, and swaps it in — matching Getty's own "refreshed at least
monthly" cadence rather than inventing a faster one. Skip the rebuild if the dump's
`dcterms:modified` (already confirmed present on ULAN records — seen in the Rembrandt
predicate list this session) hasn't advanced since the last build.

---

## Consequences

**Benefits:**
- Removes the recurring live-endpoint flakiness that caused a real crash earlier this
  session and forced the bio-join workaround.
- The occupation filter becomes essentially free to apply, directly shrinking the
  ambiguous-candidate pool that `multiple_candidates` cases come from — this is the
  first fix that touches candidate *generation*, versus everything else this session
  (dedupe, bio+web-search verification) which worked on cleanup *after* ambiguous
  candidates were already generated.
- Removes PrintMasterAI's load from Getty's shared public endpoint — several thousand
  queries per full backfill run is a meaningful load on infrastructure this project
  doesn't own.
- Enables cheap richer local queries in the future (e.g. combining name-fuzzy-match with
  occupation and nationality in one local query) that would be impractical against the
  live endpoint given its timeout behavior.

**Costs:**
- A new piece of infrastructure to build and maintain: the download+parse+index
  pipeline, the SQLite file's storage/versioning, and the scheduled refresh job.
- Initial download size and parse time are unverified — could be a non-trivial one-time
  cost; needs a real number before committing further engineering time.
- The local mirror will lag Getty's live data by up to the refresh interval (~monthly at
  most) — acceptable for this use case (artist identity is near-static data), but worth
  stating explicitly since it's a real tradeoff versus the live endpoint's freshness.

---

## Not addressed by this ADR

- The exact scheduling mechanism (GitHub Action vs. `/schedule` cloud routine vs. local
  cron) — a real choice, not yet made.
- Where the built SQLite file lives (checked into the repo vs. gitignored-and-rebuilt vs.
  stored outside the repo entirely) — likely gitignored and rebuilt, given its size, but
  not decided here.
- Whether to also mirror AAT itself (needed only if human-readable role labels are
  wanted somewhere downstream — the occupation *filter* itself only needs the numeric
  AAT ids already enumerated, not their labels).
- ~~Confirming the real ULAN dump size/record count~~ — **done, see Decision §1.**

## Suggested implementation order

1. ~~**Verify the real download**~~ — **done 2026-08-31.** 395 MB compressed
   (`explicit.zip`), 8.8 GB uncompressed across 22 files, ~3.2 GB / 5 files actually
   needed, 355,775 person records. Downloaded and inspected; this is a same-day build,
   not a storage/time-budgeting problem.
2. **Parser + schema + build script** — N-Triples → filtered `PersonConcept` rows →
   SQLite, with the `is_artist` precomputation.
3. **Validate against known-good cases** — re-run this session's confirmed examples
   (Rembrandt, Sidney Nolan's 3-way collision, Graham Sutherland, Peter Max) through the
   local index and confirm the same candidates (plus correctly *excluded* non-artist
   name-twins) come back, before trusting it for anything live.
4. **Wire the drop-in adapter** — swap `_search_ulan()`/`_fetch_bio()` to the local
   source; re-run a small sample through the full `resolve_artist()` pipeline to confirm
   no behavior change beyond the intended occupation filtering.
5. **Set up the scheduled refresh.**

---

## Implementation status — 2026-09-11

**Built and in use.**

- `knowledge_graph/build_ulan_index.py` produces `ulan_local.sqlite`: 353,510 persons,
  1,110,528 names, 234,577 flagged `is_artist`, 21,414 `is_printmaker`, FTS5 name index.
  Streams from the zip via `zipfile.open`, so peak disk is the 395 MB download, not the
  8.8 GB uncompressed.
- **Extended 2026-09-11 to carry ULAN's structured life dates** (`gvp:estStart` /
  `gvp:estEnd`). They sit on the same biography node the build already resolved for
  `schema:description`, so this reads three predicates off one line stream rather than
  adding a pass. Coverage is **98% of artists (232,195 of 234,577)**, against 41%
  recoverable by parsing the biography text — "German painter, author, 1802-1867" parses,
  "painter, active before 1801" is a floruit and "Unknown artist" is nothing.
- `knowledge_graph/resolve_artist_ulan_local.py` is the first consumer: exact normalised
  name match, `is_artist` filter, and a date check, writing `Artist.ulanUrl`. First run
  resolved **361 artists**; the Navigart population went from 7% to 64% ULAN-linked.

**What the occupation filter was worth, measured.** §Context predicted the collisions it
would prevent. Observed on the first real run: 23 names had two or more ULAN *artist*
candidates and were refused outright (Charles Martin has five), and the date check caught
six more where a unique name match was the wrong person — "Suzanne Humbert" resolving to
ULAN's *Brooks, Marjorie*, "Louis Dauphin" to a 1607 namesake, "Anton Albers" to a 1765
one.

**One design correction, worth recording because it inverts the obvious approach.** The
date check first compared ULAN against the year already on the `Artist` node, and refused
17 matches. Four were refusals of the *correct* ULAN record because the node's own year was
wrong — the graph held Toulouse-Lautrec at b.1894 where ULAN and the Musée d'arts de Nantes
both say 1864, Laboureur at 1887 where both say 1877, Guillaumin at 1891 where both say
1841. A veto that trusts one possibly-wrong number to judge another is not a check. The
rule is now **agreement with at least one independent record** of that artist — the node's
year or the source institution's — and refusal only when it contradicts both. Refusals
dropped to 6, all of them cases where two independent records agree against ULAN.

**Still not done:** step 4 (repointing `resolve_artist_identity._search_ulan()` /
`_fetch_bio()` at the mirror, so the live path gets the occupation filter too) and step 5
(scheduled refresh). The `explicit.zip` release is dated 2026-01-04; a refresh is a
re-download and a 132-second rebuild.
