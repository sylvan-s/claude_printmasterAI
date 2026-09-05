# Source Ingestion Mapping — Semantic Crosswalk Layer
## A reusable framework for mapping any new source onto the ACKG schema
**Doc 09 of the Artwork Classifier Analysis series. Companion to the Linked Art research note (doc 06) and the ACKG schema definition (doc 08).**

---

**This document describes the rules. [`met_ingest.py`](met_ingest.py) is what actually
enforces them** — a standalone, re-runnable script, not scratchpad code. If this doc
and that script ever disagree, the script is what actually ran; treat the doc as stale
and update it to match a deliberate code change. The original pilot load used
inline scratchpad code that implemented the field mapping but *not* the tags
SEMANTIC_SPLIT rule below — that gap is exactly what prompted this doc and the script
that now supersedes it.

## Purpose and scope

Doc 06 established a crosswalk-table discipline for one narrow case: mapping a
controlled-vocabulary *term* (e.g. "etching") to a verified AAT URI, never trusting an
LLM-generated ID. Loading real sources into the ACKG (doc 08) surfaced a wider version
of the same problem: every source has its own raw schema, and deciding how each field
maps onto the graph — directly, via transformation, via heuristic parsing, or not at
all — has so far been figured out ad hoc, per source, and recorded only as loose notes
in doc 08 §6. That doesn't scale past the third source.

This doc generalizes doc 06's discipline into a **mapping-type taxonomy** (§1) that
classifies *how much a mapping can be trusted*, then applies it to the three sources
already ingested — V&A (§2), Roseberys (§3), Met Open Access (§4) — as worked
examples, and closes with a template (§6) for onboarding the next one.

---

## 1. The mapping-type taxonomy

Every raw field in a source maps onto the ACKG in one of six ways. The type is not
cosmetic — it determines how much a downstream consumer (`query_ackg`, a human
reviewing the seed data) should trust the resulting graph element without further
verification.

| Type | Meaning | Trust level |
|---|---|---|
| **DIRECT** | Raw field copied straight into a graph property, no interpretation | Full — it's the source's own data, unchanged |
| **STRUCTURED_TRANSFORM** | Deterministic reformatting of already-structured source data (date-shape flattening, dimension-string regex parsing) | Full — reversible, no information invented |
| **PRE-LINKED_AUTHORITY** | Source already supplies a controlled-vocabulary/authority URI (ULAN, Wikidata, AAT) | Full — this is the institution's own reconciliation, not ours to re-verify |
| **HEURISTIC_EXTRACTION** | Free text parsed into a graph element via keyword/pattern matching, with no controlled vocabulary backing it yet | Provisional — flag as unverified until cross-checked against AAT per doc 06 §4 |
| **SEMANTIC_SPLIT** | A single source field actually conflates two or more distinct ACKG concepts and must be classified before mapping, not mapped 1:1 | Depends on the disambiguation rule's own accuracy — state the rule explicitly, don't leave it implicit |
| **UNMAPPED** | Field exists in the source but has no current home in the schema | N/A — record it as deferred (matching doc 08 §5's discipline), never silently drop it |

The Subject/Genre mixup that prompted this doc is a textbook **SEMANTIC_SPLIT**: Met's
`tags` field was mapped 1:1 onto `Subject` (`Impression -[:DEPICTS]-> Subject`) as if
every tag meant the same kind of thing. It doesn't — see §4.

---

## 2. Source adapter: Victoria & Albert Museum (institutional record)

- **Access method:** individual collection page (`collections.vam.ac.uk/item/...`), manually fetched
- **Entity identity:** accession number (e.g. `CIRC.252-1958`) — unique within the V&A, used as `SourceRecord.accessionNumber`
- **Volume so far:** 1 record (§4.1 of doc 08)

| V&A field | Maps to | Type |
|---|---|---|
| Accession number | `SourceRecord.accessionNumber` | DIRECT |
| Title/description | `ConceptualWork.name` | DIRECT (note: V&A gave a *descriptive*, not formal, title — see doc 08 §4.2's identity-resolution warning) |
| Date | `ConceptualWork.dateCreated` / `EditionRun.dateRange` | STRUCTURED_TRANSFORM |
| Medium/technique | `Technique` (Etching, Aquatint) | STRUCTURED_TRANSFORM — V&A's "Etching and aquatint (colour)" split cleanly on "and," no heuristic needed |
| Edition number | `Impression.editionNumber`, `copyType` | DIRECT |
| Dimensions | `Impression.sheetDimensions`/`imageDimensions` | STRUCTURED_TRANSFORM |
| Collection image URL | `DigitalImage.sourceUrl` | DIRECT |

No SEMANTIC_SPLIT or HEURISTIC_EXTRACTION cases in this source — V&A's fields were
already close to the ACKG's own granularity, likely because Linked Art/CIDOC-CRM
influence (doc 06) runs through V&A's own cataloguing.

---

## 3. Source adapter: Roseberys (auction listing)

- **Access method:** live auction-catalogue web page, browser-fetched
- **Entity identity:** auction code + lot number (e.g. `A0777` lot 42) — used as
  `SourceRecord.lotNumber` plus `institutionName: "Roseberys London"`
- **Volume so far:** 2 records (Lots 42–43, doc 08 §4.2)

| Roseberys field | Maps to | Type |
|---|---|---|
| Auction code (e.g. "A0777") | `SourceRecord.saleId` | DIRECT — **was missing from the schema until this revision**; only existed baked into the node's own `id` string ("roseberys-a0777-lot42-record"), not as a real property, so "all lots in sale A0777" was not actually a queryable question. Fixed retroactively — see backfill note below. |
| Lot number | `SourceRecord.lotNumber` | DIRECT |
| Estimate ("£300 - £500") | `SourceRecord.estimateLow`/`estimateHigh` | STRUCTURED_TRANSFORM (split on "-") — **also missing until this revision**, despite every Roseberys lot pulled so far having one |
| Artist name + dates | `Artist` (merge key) | DIRECT |
| Title | `ConceptualWork.name` | DIRECT |
| Date | `ConceptualWork.dateCreated` | STRUCTURED_TRANSFORM |
| "etching and aquatint..." | `Technique` | STRUCTURED_TRANSFORM (Roseberys phrasing is consistently comma/"and"-delimited — cleaner than Met's free text) |
| "signed and inscribed A/P... aside from the edition of 50" | `Impression.copyType`, `EditionRun.declaredSize` | HEURISTIC_EXTRACTION — the "aside from the edition of N" phrasing is a Roseberys house-style convention, not a universal auction-catalogue format; a different auction house's phrasing would need its own rule, not reuse of this one |
| "printed by X" | `EditionRun -[:PUBLISHED_BY]-> Publisher` | DIRECT once the phrase is located, but *finding* the phrase in free-form lot description text is itself heuristic |
| Price realised | `SourceRecord.priceRealised` | DIRECT |
| Provenance line | *(currently unmapped)* | UNMAPPED — doc 08 §5 already defers structured provenance to a free-text field; Roseberys' "Provenance: The Agathe Sorel and Gabor Sitkey Print Collection" line is exactly the kind of data that field exists for |

## 3.1 Source adapter: Roseberys bulk catalogue (`roseberys_ingest.py`)

A second, much larger Roseberys source — a 10-year structured extract (`catalogue.csv`,
16,536 lots across 43 sales, 2016–2026), not the live per-lot web page above. Already
parsed into columns by an external tool, with a documented "Read me" sheet stating real
parsing coverage (artist/title/medium ~89–100%, dimensions ~87%, edition size ~57%) —
this is DIRECT/STRUCTURED_TRANSFORM for most fields, not the HEURISTIC_EXTRACTION the
live-page adapter above needed, *except* for two real data-quality problems found and
handled before any load ran:

- **~248 rows are catalogue narrative/section-header text** ("Lots 153-175 are from the
  private collection...") mis-parsed as if they were lot records, with garbage in
  `artist`/`nationality`/`life_dates`. Filtered via `is_narrative_row()`: nationality
  populated + life_dates is a bare 4-digit year (no hyphen, no b./d. prefix) — verified
  precise against the full dataset, with one known likely false positive (a real artist,
  "Joseph Pennell, American, 1858", missing the "b." prefix the rest of the data uses).
- **~3,619 rows (22%) are multi-work lots** ("together with a further etching by the
  same hand...", portfolios up to 26 prints) that a naive one-row-one-`Impression`
  mapping would silently collapse into a single, wrong `ConceptualWork` — losing
  distinct titles, techniques, editions, and even distinct catalogue numbers per work
  (one real example has three different Cramer catalogue numbers under one lot).
  **Excluded from this load** (2026-08-24 decision) rather than mismodeled — every
  excluded row (both categories) is preserved in `roseberys_excluded_rows.csv`, tagged
  with its exclusion reason, not silently dropped. Multi-work parsing (splitting the
  free text into per-work records) is a separate follow-up task, not attempted here.
- `artist_qualifier` is a clean, pre-structured column (certain/attributed/circle/
  studio/follower/after) — **PRE-STRUCTURED**, no heuristic prefix-parsing needed,
  unlike the live-page adapter's qualifier handling above. Required extending doc 08's
  qualifier enum with `studio_of`/`follower_of` rather than force-fitting into existing
  values.
- `printer` and `publisher` are separate columns — mapped to distinct `PRINTED_BY`/
  `PUBLISHED_BY` edges (doc 08 schema addition) rather than one `PUBLISHED_BY` edge
  doing double duty.
- HTML entities were found un-decoded in the source (77 artist names, 57 titles —
  e.g. "Mu&scaron;i&#269;" for "Mušič"). Fixed with `html.unescape()` on every text
  field, found during piloting, not assumed absent.
- Artist identity: no ULAN/Wikidata supplied, same as the live-page adapter — merges
  by `name`, `identityConfidence: "unresolved"`. ~3,502 unique artist names across the
  full dataset; live ULAN reconciliation at that volume was explicitly ruled out given
  the endpoint's demonstrated unreliability (see `resolve_artist_identity.py`).

### Known open issue, logged for later — honorific-fragmented Artist identities (not yet swept)

Found 2026-08-24 while verifying the contaminated-row cleanup, not from a deliberate
audit: **Laurence Stephen Lowry was split across 7 separate `Artist` nodes** —
honorifics `strip_honorifics()` didn't yet cover (`RBA`, `LG`, `NS`), a genuine
spelling variant in Roseberys' own source data ("Lawrence" vs "Laurence"), and three
nodes left orphaned by the contaminated-row deletion rather than removed. This
directly corrupted the revenue analysis reported earlier in this project — Lowry's
true total was **£396,959 across 133 lots**, not the £371,780/126 lots first
reported. A second, smaller case (David Hockney, `OM`/`RTO` prefix) confirmed the
same failure mode. Both were fixed by hand (merged nodes, extended the postnominal
list) — **but the fix was reactive, found by chance, not from a systematic check.**

**Not yet done: a full sweep across all ~2,859 Artist nodes for the same pattern.**
Given Lowry alone moved by ~7% just from one omitted honorific set, other high-volume
artists in this graph likely have the same undetected fragmentation, silently
understating their true support counts and revenue totals wherever it exists. This is
a real, unresolved data-quality risk sitting in the graph right now, not a
theoretical one — flagged here explicitly so it isn't forgotten, per the user's
instruction to log and revisit rather than fix immediately (2026-08-24).

Suggested approach when this is picked up: group Artist nodes by a normalized
surname+given-name key (stripping ALL-CAPS trailing tokens generically, not just the
known postnominal list) and flag any group with more than one node for review, rather
than continuing to discover these one artist at a time.

### Fixed 2026-08-25 — WAF-blocked lot image URLs (also covers Forum Auctions)

Discovered while building a DINOv2 embedding proof-of-concept: the `image_url` column's
`www.roseberys.co.uk/lot_images/large/...` / `www.forumauctions.co.uk/lot_images/large/...`
URLs are **not dead** (unlike Tate's — see §4.2) but return an AWS WAF Bot Control
`202 challenge` to any non-browser client. Live-inspecting a real lot page in a browser
found the actual asset one hop away on a public, unauthenticated S3 bucket, same two UUIDs,
just `xlarge` instead of `large`:
`am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/{roseberys|forum}/prod/lot_images/xlarge/...`
— confirmed reachable via plain `curl`, no browser session needed once rewritten.

**Retroactively fixed** for all 20,291 already-loaded `DigitalImage` nodes (10,255
Roseberys + 10,036 Forum, both exact 100% matches against the old prefix, no outliers) via
a bulk `SET img.sourceUrl = replace(...)`, verified live against a fresh random sample.
**Fixed going forward** too: `roseberys_ingest.py`'s and `forum_ingest.py`'s `_fix_lot_image_url()`
now rewrite the URL at ingest time, so this doesn't need a repeat retroactive fix.

(Forum Auctions doesn't yet have its own numbered adapter section in this doc — a
pre-existing gap, not introduced here — so this fix is logged against the Roseberys
section it's structurally identical to.)

---

## 4. Source adapter: Met Open Access (bulk CSV + REST API)

- **Access method:** bulk CSV (`MetObjects.csv`, Git-LFS hosted) for discovery/filtering,
  REST API (`collectionapi.metmuseum.org`) per object for full detail + image
- **Entity identity:** `Object ID` — used as `met-{objectId}` across `ConceptualWork`/
  `EditionRun`/`Impression`/`SourceRecord` ids
- **Volume so far:** 38 records (Lichtenstein, Motherwell pilot batch)

| Met field | Maps to | Type |
|---|---|---|
| `Object ID` | id prefix for `ConceptualWork`/`Impression`/etc. | DIRECT |
| `Accession Number` | `SourceRecord.accessionNumber` | DIRECT |
| `Artist ULAN URL`, `Artist Wikidata URL` | `Artist.ulanUrl`, `Artist.wikidataUrl` | **PRE-LINKED_AUTHORITY** — populated on ~65% of the 20th-century-born print slice; use as-is, no verification needed |
| `Artist Begin/End Date` | `Artist.dateBorn`/`dateDied` | STRUCTURED_TRANSFORM |
| `objectBeginDate`/`objectEndDate` (API) | `ConceptualWork.dateCreated` | STRUCTURED_TRANSFORM |
| `Classification` | filter criterion, not a graph property | DIRECT, but **load-bearing**: `Department` looked like the obvious filter and is wrong (§ finding: a "Drawings and Prints"-department object classified as "Books"; a "Prints"-classified object filed under Photographs department) |
| `Medium` | `Technique`, `Paper` | **HEURISTIC_EXTRACTION** — keyword-matched against a small vocabulary list; correctly left decorative substrates (Rowlux, rag board) unmatched as Paper in the pilot, but this is pattern-matching, not a verified crosswalk. Raw string preserved on `Impression.rawMedium` regardless, so nothing is lost where the heuristic falls short |
| `dimensions` | `Impression.sheetDimensions`/`imageDimensions` | STRUCTURED_TRANSFORM (regex on a semi-consistent "sheet: ... image: ..." pattern) |
| `tags` | `Subject` **and** `Genre` | **SEMANTIC_SPLIT** — see below |
| `primaryImage` | `DigitalImage.sourceUrl` | DIRECT when present — but empty on all 38 pilot records; expect near-zero coverage for non-public-domain (i.e. most 20th-century) works. **Confirmed (not assumed): this is not an API-only restriction.** Live-checked one non-public-domain object's page directly on metmuseum.org — it shows the identical "No image available" placeholder the API implies, while a public-domain object in the same collection shows a full image with download/share controls. The Met withholds display identically across both channels; there is no "check the website instead" workaround. The image most likely exists internally (the object has a full catalog record) but is deliberately not shown publicly pending rights clearance — not verified, since neither public channel exposes anything about internal digitization status. |
| `artistPrefix` | `ATTRIBUTED_TO.qualifier` | STRUCTURED_TRANSFORM (keyword match against "after"/"circle of"/"attributed to"/etc. — none triggered in the pilot, untested against a real case) |

### The tags SEMANTIC_SPLIT rule

Met's flat `tags` list conflates two different kinds of thing:

- **Genre/classificatory tags** — describe *what kind of work this is*: Abstraction,
  Landscapes, Christmas (an occasion/thematic category, not depicted content)
- **Iconographic subject tags** — describe *what's depicted*: Oxen, Tower, Windsor
  Castle, Sun, Farmer/agricultural labour

This mirrors a real distinction between two Getty/art-historical vocabularies — AAT's
genre/style facet vs. Iconclass's iconographic-subject facet — so the split is
principled, not arbitrary tidiness.

**v1 disambiguation rule (pragmatic, not yet AAT-verified):** a small curated list of
known genre/style/occasion terms (Abstraction, Landscape, Portrait, Still Life,
Genre Scene, Seascape, Christmas, and similar) routes a tag to `Genre`
(`Impression -[:CLASSIFIED_AS]-> Genre`); everything else routes to `Subject`
(`Impression -[:DEPICTS]-> Subject`, as already defined in doc 08).

**Checked, not just proposed — and it doesn't fully work as hoped.** Met's `Tags AAT_URL`
field (present alongside `term` on every tag object) was live-checked against three
actual pilot tags: "Abstraction" resolves to AAT's **Associated Concepts Facet**
(`vocab.getty.edu/aat/300056508`, under "forms of expression (artistic concept)") — a
clean, verifiable Genre signal. But "Landscapes" resolves to AAT's **Objects Facet**
(`vocab.getty.edu/aat/300132294`, "natural landscapes") — the *same facet* as "Sun"
(`vocab.getty.edu/aat/300379806`, also Objects Facet), which is a genuine `Subject`.
AAT treats "landscape" as an environment/place type, not an art genre, so **facet
position alone cannot reliably discriminate Genre from Subject** — it would correctly
catch "Abstraction" and then misclassify "Landscapes" right alongside it.

**The actual rule in force is a curated term list**, not a facet lookup — implemented
as `GENRE_TERMS` in `met_ingest.py`, not left as prose in this doc. It covers the
standard, stable fine-art/print genre categories (portrait, landscape, still life,
genre scene, seascape, nude, etc.) and checks each incoming tag against it before
falling back to `Subject`. AAT facet position remains a useful *secondary* signal for
auditing whether a new term probably belongs on the list (Associated Concepts Facet is
a strong Genre hint), but it is not the automated decision rule.

---

## 4.1 Source adapter: VEA-1.0 itself (the pipeline's own first-party observations)

Not an external source — but VEA's `composition.subjectElements[]`/`styleObservations[]`
(doc 01 §2I) feed the graph through the exact same discipline as everything else here,
via [`resolve_vea_composition.py`](resolve_vea_composition.py).

- **Entity identity:** an existing `Impression.id` — this resolver does not create
  Impressions, only attaches `Subject`/`Genre` observations to one that already exists
  (or, for an incoming unattributed submission mid-triage, a bare `Impression` node
  with no `ConceptualWork`/`Artist` chain yet — that absence *is* the triage question).
- `subjectElements[].term` → `Subject` node, `DEPICTS {count, confidence}` — **HEURISTIC_EXTRACTION
  with no crosswalk at all**: unlike technique, there is currently no verified AAT/IA
  backing for iconographic subjects (see conversation: AAT's Objects Facet doesn't
  cleanly separate Subject from Genre, and Getty's IA — Iconography Authority — is the
  correct candidate authority but hasn't been evaluated). Every `Subject` node created
  this way is ungrounded, same status as Oxen/Tower/Sun already in the graph.
- `styleObservations[].term` → `Genre` node, `CLASSIFIED_AS {confidence}` — **PRE-LINKED_AUTHORITY
  when the term matches `aat_crosswalk.json`'s `stylesAndPeriods` category** (Cubism,
  Surrealism, Impressionism verified so far), **HEURISTIC_EXTRACTION otherwise** (still
  recorded, `aatId` left null).
- Verified end-to-end with a synthetic test fixture (not real data, deleted after the
  test): a mock "two cubist female figures" submission correctly matched a mock
  reference work sharing the same Genre/Subject tags, via the exact `query_ackg`-shaped
  Cypher doc 07 always intended — the mechanism this whole layer exists to support.

## 4.2 Source adapter: Tate Collection bulk CSV (`tate_ingest.py`)

- **Access method:** bulk CSV from `tategallery/collection` on GitHub (CC0) —
  `artwork_data.csv` (69,201 rows) + `artist_data.csv` (3,532 artists). **Confirmed frozen**,
  not a live feed: the repo's own README states it hasn't been actively maintained since
  October 2014 — the same category of limitation as the Met's own point-in-time CSV extract.
- **Entity identity:** `accession_number` — confirmed unique across all 69,201 rows, used as
  `tate-{accession}` across `ConceptualWork`/`EditionRun`/`Impression`/`SourceRecord` ids.
  Genuinely simple compared to Roseberys/Forum: one row is one artwork with one
  `(artist, role)` pair, no multi-constituent parsing needed.
- **Artist identity:** no ULAN/Wikidata column in this source (confirmed) — merges by
  `name`, `identityConfidence: "unresolved"`, same policy as Roseberys/Forum.
- Tate's institutional-layer position per doc 09/ADR-0003: strong for British and Western
  artists generally, but still one Western institution's holdings — does not close the
  non-Western coverage gap already documented for Met/ULAN (Japan ~1.3% of ULAN records),
  since Tate's own collection carries the same skew.

Three real adaptations were required, found and handled before the first load ran:

- **No classification flag.** Met has `Classification` containing "Print"; Tate's `medium`
  is free text only ("Etching and aquatint on paper"). Filtered with the same
  `extract_techniques()` crosswalk every other adapter already uses — no new vocabulary —
  which means coverage depends on the existing technique keyword list; a genuinely novel
  print technique with no keyword match is silently excluded, not misclassified, the same
  shape of limitation doc 09 already documents for HEURISTIC_EXTRACTION mappings elsewhere.
- **Reversed name convention.** Artist names arrive "Surname, Firstname" ("Blake, Robert") —
  the opposite of every other source in this graph. Reversed via `_parse_tate_artist_name()`
  before merging, or this source would silently fragment every artist already in the graph
  under a second, differently-formatted node. 65 of 3,532 artists have no comma (single
  names — "Matta", "Absalon"); the literal placeholder "Anonymous" is excluded rather than
  merged as if it were a real person (though it never actually occurs in the print-qualifying
  rows — confirmed by direct check, zero rows).
- **`artistRole` reconciled against the existing qualifier vocabulary** (`QUALIFIER_MAP`).
  One value is deliberately **not** mapped and excluded outright: "formerly attributed to"
  (Tate itself no longer holds this attribution, so ingesting it as live would insert a fact
  the source institution has already disavowed). Three more structurally ambiguous roles
  ("and other artists", "and a pupil", "and assistants") name no specific second party and
  are excluded rather than guessed at.

**Filters applied in sequence, each logged and none silently dropped** (`load_catalogue()`):

| Filter | Rows excluded | Reason |
|---|---:|---|
| Disavowed/ambiguous attribution role | 33 | see above — "formerly attributed to" and the three ambiguous multi-party roles |
| Non-print medium | 56,696 | paintings, sculpture, drawings, etc. — this graph scopes to prints |
| Generic period/nationality placeholder ("British (?) School", "British School 18th century") | 159 | not an individually-attributable artist — can never be the answer to "who made this" |
| Deprioritized artists (Turner) | 1,469 | see "Known deliberate exclusion" below |
| **Qualifying rows** | **10,844** | |

**Fully ingested 2026-08-25** — all 10,844 qualifying rows are loaded (confirmed via
`SourceRecord {institutionName: "Tate"}` count matching exactly). Added 3,785 nodes on top
of Turner's freed headroom (752 new rows × 4 base nodes + 722 `DigitalImage` + 55 new
`Artist` nodes — estimated in advance from the actual filtered/deduplicated row set, not
extrapolated from a single chunk, and landed exactly on the predicted figure), bringing the
graph to 199,167 of AuraDB Free's 200,000-node ceiling — 833 nodes of headroom remain.

### Known deliberate exclusion — J.M.W. Turner

Not a data-quality problem, an explicit ingestion-priority decision, made and logged
2026-08-25 against a real hard constraint: AuraDB Free's **200,000-node ceiling**. This graph
crossed that ceiling during Tate ingestion, so every further row genuinely competes with
every other row for scarce node budget — the same discipline applied earlier in this project
to pruning Met's zero-metadata/zero-artist works.

The question that surfaced Turner specifically was a methodological one developed this
session: *for an artist who already has significant representation in the graph, does one
more record actually add information that supports attribution, or is it redundant?* Raw
support-count totals turned out to be a poor signal on their own — an artist's **source-layer
diversity** (institutional vs. auction-history) and **attribute-slice saturation** within
their own existing profile are the real test. Checked directly against Turner's profile
(not assumed from his headline volume): his existing ~908 loaded Tate works were **100%
institutional/Tate-sourced, with zero auction-history presence** — his own source-layer was
already fully saturated. Each further Turner row was therefore low marginal value, while the
same node budget spent on the ~566 remaining rows for artists with *zero* existing coverage of
any kind (see the per-artist source-layer re-ranking pass this session applied to the
remaining Tate queue) added genuinely new attribution-support population data.

Given that, and given the ceiling was already binding, the decision went one step further
than simply excluding Turner from future loads: **the 908 already-loaded Turner records were
deleted from the graph entirely** (`DETACH DELETE`, 2026-08-25) — 4,538 nodes (908 Tate works
× 5 nodes each, including 906 `DigitalImage` nodes) plus the now-orphaned Turner `Artist` node
itself (0% auction-history presence meant no other relationship kept it alive), freeing 4,539
nodes of headroom. This is a retroactive prune, not just a block on further growth — Turner's
prior inclusion is judged to have been the lowest per-node value use of a now-scarce resource,
not merely no-longer-a-priority.

`tate_ingest.py`'s `_DEPRIORITIZED_ARTISTS_RAW` set (`{"Turner, Joseph Mallord William"}`)
enforces the future-blocking half of this decision at the CSV-filter stage, referencing this
section (§4.2) directly in its code comment. **Revisit this exclusion** once AuraDB headroom
stops being the binding constraint (e.g. an upgrade to a paid tier, judged too expensive for
this personal project as of 2026-08-25 — see the pricing discussion this session), or if a
future need specifically requires Turner population data for attribution support.

### Known deliberate exclusion — dead `thumbnailUrl` values (`DigitalImage` nodes removed)

Discovered 2026-08-25 while assessing whether DINOv2 could be run over the ACKG's images
for visual-similarity embeddings: **every one of the 8,942 `DigitalImage` nodes created
from Tate's `thumbnailUrl` column pointed at a dead link.** A random sample of 42 URLs
(`http://www.tate.org.uk/art/images/work/...`) returned **42/42 HTTP 404s** — Tate has
restructured its site since the `tategallery/collection` CSV was frozen in 2014, and the
old image-serving path no longer resolves at all. Checked, not assumed: Tate's homepage
and search are live (confirmed `200`), so the images likely exist somewhere under a new
URL scheme, but no current public API, IIIF manifest, or guessable path was found — and
Tate's own website terms of use restrict bulk downloading/reproduction of site content
regardless, with real image licensing gated behind the separate commercial Tate Images
picture library.

Since the stored URLs are non-functional and provide no path toward finding the *correct*
current URL (the site restructure changed the scheme entirely, so the old link is not a
useful clue), keeping 8,942 dead `DigitalImage` nodes cost real node budget for zero
working value — the same logic as every other prune in this project, just applied to a
node type rather than a `ConceptualWork`. **All 8,942 were deleted** (`DETACH DELETE`,
2026-08-25), freeing 8,942 nodes (headroom rose from 833 to 9,775 — over 10x). Nothing of
future value was lost: `SourceRecord.accessionNumber` (untouched by this deletion) is what
a correct future re-fetch would key off, not the dead thumbnail URL.

`tate_ingest.py`'s `LOAD_QUERY` no longer materializes a `DigitalImage` node at all (the
`FOREACH` block was removed, replaced with a code comment referencing this section) — so a
future re-run of the loader (e.g. a maintenance fix) won't silently recreate the dead
nodes. `map_row()` still computes `imageUrl` from the raw column in case a real image
source is ever found and this needs re-enabling.

**Also checked and ruled out as a cause, for completeness:** the Met's separate lack of
image coverage (0 `DigitalImage` nodes across all 6,366 ingested Met records, confirmed via
a live spot-check against the real Met Collection API — 0/46 sampled objects, including
every genuinely pre-1900 work in the corpus, have `isPublicDomain: true` or a populated
`primaryImage`) is an unrelated, separate limitation — Met's images were never fetched at
all (a deliberate v2.0 tradeoff, see `met_ingest.py`'s own header comment), not fetched-then-
gone-stale like Tate's. Not pruned, since there was nothing to prune — no `DigitalImage`
nodes were ever created for Met in the first place.

## 5. Schema addition: `Genre` node

```
Genre {name}
Impression -[:CLASSIFIED_AS]-> Genre
```

Structurally identical to `Subject` (a controlled-vocab node, AAT-linkable once a
crosswalk exists) — the distinction is semantic, not structural. This is the first
schema addition made *because* the mapping layer caught a real error, rather than from
reasoning about the schema in the abstract.

---

## 6. Template: onboarding a new source

For any future source, answer these before writing a single line of ingestion code:

1. **Access method and entity identity** — how is a record uniquely referenced, and
   does that identity stay stable over time? (Met's Object IDs can 404 against the live
   API even from a recent CSV snapshot — identity stability isn't guaranteed.)
2. **Field-by-field mapping table**, each row tagged with one of the six types in §1.
   A source dominated by DIRECT/STRUCTURED_TRANSFORM/PRE-LINKED_AUTHORITY rows is
   cheap and low-risk to ingest at volume. A source dominated by HEURISTIC_EXTRACTION
   or SEMANTIC_SPLIT rows needs a pilot batch and manual review before any bulk load —
   exactly the discipline already used for both Trevelyan and the Met pilot.
3. **Any SEMANTIC_SPLIT fields** — state the disambiguation rule explicitly and in
   writing (as §4 does above), not as an implicit assumption buried in ingestion code.
4. **Known data-quality caveats** — sparse fields, stale identifiers, house-style
   phrasing conventions that won't transfer to another source of the same broad type
   (Roseberys' "aside from the edition of N" is Roseberys' convention, not a universal
   auction-catalogue pattern).
5. **What's UNMAPPED** — record it, don't drop it silently.

---

## 7. Source adapter: British Museum Collection Online (pilot, `bm_ingest.py`)

- **Access method — the first real exception to every prior adapter's assumption.**
  britishmuseum.org sits behind a Cloudflare managed challenge: a plain `requests`/
  `curl` client gets a 403 "Just a moment..." interstitial, and `cloudscraper`
  (TLS-impersonation) was tried and also blocked — confirmed by direct test, not
  assumed. A real browser session (this session's own Browser pane) solves the
  challenge exactly as a human visitor would and reads the site's own internal,
  undocumented `/api/_search` + `/api/_object` endpoints and server-rendered object
  pages fine. There is **no scriptable bulk access** the way Met's CSV, Tate's CSV, or
  Roseberys/Forum's per-lot pages offered. This adapter is therefore pilot-scale by
  necessity, not by choice: `bm_ingest.py` loads from a local JSON cache
  (`benchmark/data/bm/rembrandt_pilot.json`) hand-captured via a real browser session,
  not a live fetch. Scaling this to a Met/Tate-style bulk load would need real browser
  automation (Playwright, solving the same challenge unattended) — a materially bigger
  lift, slower per-record than any other adapter here, and a heavier sustained
  automated footprint against a bot-management system built specifically to stop it.
  **Deliberately not built** — flagged as an open decision for if/when bulk BM coverage
  is actually wanted, not attempted speculatively.
- **The old published SPARQL/Linked Data endpoint is dead**, not just deprecated —
  `collection.britishmuseum.org` (the CIDOC-CRM/ResearchSpace one, previously
  documented in museum-API literature) returned connection-refused on a direct check
  2026-09-05. The current britishmuseum.org/collection is a full site rebuild with no
  published developer API; what this adapter uses is the site's own frontend-internal
  API, same category of access as Roseberys/Forum's per-lot pages, not a sanctioned
  integration point.
- **Licensing: CC BY-NC-SA 4.0, non-commercial** — a real difference from Met/Tate
  (CC0). Decision (2026-09-05, this session, with the user): proceed for this project's
  current personal/research status, revisit before any commercial launch. Recorded here
  once rather than re-litigated per future BM ingest run.
- **Entity identity:** BM's own unique object id (e.g. `P_F-6-65`), used as
  `bm-{id}` — confirmed stable across the search API and the object page for every
  pilot record.
- **Data quality is the best of any adapter so far** — closer to V&A's institutional
  record than Met's free text:

| BM field | Maps to | Type |
|---|---|---|
| `Museum number` | `SourceRecord.accessionNumber` | DIRECT |
| `Producer name` (role-prefixed: "Print made by: Rembrandt", "After: Jan Lievens") | `Artist` + `ATTRIBUTED_TO.qualifier` | STRUCTURED_TRANSFORM via `ROLE_QUALIFIER_MAP` — a role with no confident mapping (e.g. "Drawn by: ... (calligraphy)" for a secondary hand, no slot in doc 08's qualifier enum) is logged and skipped, not force-fit |
| `Technique` | `Technique` (AAT via `crosswalk_matching`) | **DIRECT/near-STRUCTURED_TRANSFORM** — arrives pre-segmented ("etching", "drypoint"), unlike Met's paragraph medium string; running it through the shared crosswalk is a formality here, not a real heuristic risk |
| `Subjects` | `Subject` | **DIRECT** — pre-segmented and already iconographic-only; no SEMANTIC_SPLIT needed the way Met's flat `tags` field needed one |
| `Dimensions` ("Height: N millimetres"/"Width: N millimetres") | `Impression.sheetDimensions` | STRUCTURED_TRANSFORM, but see caveat below |
| `Production date` ("1658", "1632 (circa)") | `ConceptualWork.dateCreated` (fuzzy date shape) | STRUCTURED_TRANSFORM |
| `Bibliographic references` ("New Hollstein (Dutch & Flemish) / The New Hollstein: ... (306.VI) (Rembrandt)") | `CatalogueRaisonne`/`CatalogueEntry` | STRUCTURED_TRANSFORM via `parse_bibliographic_ref` |
| `Department` | filter criterion ("Prints and Drawings") | DIRECT |

- **First real confirmation of doc 08 principle 4 with live data.** A single pilot
  record commonly carries FOUR or FIVE distinct catalogue raisonné entries at once
  (New Hollstein, Hind 1923, White & Boon 1969, Hinterding et al. 2000, sometimes also
  Muller for portrait sitters) — doc 08 reasoned about "multiple authorities can each
  number the same work differently" from a design perspective before any adapter had
  actually populated more than one raisonné per work (Forum's `catalogue_refs` gave one
  ref per row). All four/five now coexist correctly on the same `ConceptualWork`.
- **Dimension-type ambiguity, flagged not resolved.** Unlike Roseberys' `dim_kind`
  column, BM's object page does not label whether its one `Dimensions` field is a
  sheet, plate, or image measurement. Defaulted to `sheetDimensions` (same fallback
  Forum uses for an unlabelled `dim_kind`), but for Old Master intaglio prints a
  plate-mark measurement is at least as common a cataloguing convention — this is an
  unverified assumption, not a checked mapping, and should be revisited against BM's
  own measurement documentation before this adapter's output is trusted for
  dimension-based matching (the same kind of signal doc 08 §4.2's Trevelyan
  entity-resolution case leaned on).
- **Artist identity — confirmed live, not assumed, before writing a single MERGE.**
  BM's producer strings are bare names ("Rembrandt", not "Rembrandt van Rijn"). A query
  against the live graph before this pilot ran found the canonical node is
  `Artist{name:"Rembrandt van Rijn", ulanUrl:.../500011051}` with 241 works, plus three
  separate orphaned name-string nodes from other sources' contaminated rows — a blind
  `MERGE (Artist {name: "Rembrandt"})` would have created a **fifth** distinct node,
  exactly the fragmentation failure mode this graph has hit and fixed repeatedly (see
  [[project_ackg_status]]). `bm_ingest.py`'s `PILOT_ARTIST_RESOLUTION` hand-resolves the
  handful of names this pilot needs to their real `ulanUrl` — a pilot-scale expedient,
  not a general mechanism; a full-scale BM ingest would route new names through
  `resolve_artist_identity.py`'s real ULAN/Wikidata pipeline instead.
- **Institutional framing, not market framing.** Nearly every pilot record's
  description contains the word "counterproof" — BM's Rembrandt holdings are unusually
  rich in counterproofs (mirror-image proofs pulled to check a plate state during
  cataloguing/study), not typical sale impressions. Same category of caveat as Tate's
  institutional-vs-auction distinction (doc 09 §4.2's Turner discussion): this source is
  strong evidence for *attribution and state/catalogue identity*, weak-to-irrelevant
  evidence for *market comparables* — a counterproof's existence says nothing about a
  numbered edition impression's likely hammer price.
- **A real Cypher bug found and fixed during this pilot, worth remembering for any
  future adapter.** `UNWIND` over an empty list silently drops that row from the rest
  of the query pipeline — every clause after it never runs for that row. 8 of the 31
  pilot records have no `Subjects` field; the first version of `LOAD_QUERY` UNWOUND
  `row.subjects` unguarded, which silently dropped those 8 records' `CatalogueRaisonne`/
  `CatalogueEntry` writes entirely (not just the missing subjects) since that UNWIND sat
  upstream of the catalogue-ref section in the same query. Caught by a live post-load
  verification count (23/31 New Hollstein entries instead of 31/31), not assumed
  correct from a successful run with no errors — `forum_ingest.py` already guards its
  own optional `papers` list this same way (`CASE WHEN size(...)=0 THEN [null] ELSE
  ... FOREACH null-check`), a pattern this adapter should have copied from the start
  rather than rediscovering the hard way. Fixed by applying the same guard to every
  optional multi-valued UNWIND in the query (producers, techniques, subjects,
  catalogueRefs); re-verified with a full delete-and-reload, confirmed 31/31 records
  now carry their New Hollstein/Hind/White & Boon entries.
- **Loaded 2026-09-05:** 31 genuine Rembrandt-etched prints (filtered from a sample of
  60 search hits to exclude "After: Rembrandt" secondary works by other printmakers) —
  `SourceRecord{institutionName: "British Museum"}` count confirms 31/31. Rembrandt's
  `CREATED` work count went 241 → 272 with zero node duplication (verified).

### 7.1 Images + DINOv2/CLIP embeddings (`bm_embed_images.py`)

Extended the same day, once asked whether images were available. Two more access-method
findings, same "confirm before assuming" discipline as §7 itself:

- **All 31 pilot Impressions have images** (`multimedia` present on every one, checked
  via `/api/_object`, cached to `benchmark/data/bm/rembrandt_pilot_images.json`).
- **Unlike the main site, the image files are NOT behind Cloudflare.** The bytes are
  served from a separate `media.britishmuseum.org` CDN subdomain — confirmed reachable
  with plain `requests`/`curl`, no challenge. Same "escape to an unguarded asset host"
  shape as Roseberys/Forum's WAF-blocked-but-not-dead image CDN (§3.1) — only the
  *discovery* step (finding the image's location string) needs a browser session; the
  *download* step is a normal script. This meaningfully changes the earlier "no
  scriptable bulk access" conclusion for images specifically, though not for metadata —
  worth remembering if BM coverage is ever expanded: a future scrape could use the
  browser only to harvest image locations + IDs, then script the rest.
- `media.britishmuseum.org`'s TLS chain doesn't verify (missing intermediate cert,
  confirmed with `curl -v`, not a local trust-store issue) — BM's own page markup
  (`og:image` meta tags) links to this host over plain `http://`, not https, so
  `bm_embed_images.py` does the same rather than disabling certificate verification on
  an https connection.
- Pipeline mirrors `embed_tate_images.py` exactly: DINOv2-Large (1024-dim) + CLIP image
  (openai/clip-vit-base-patch32, 512-dim) + CLIP text embedding of the Impression's
  `rawMedium` (BM's own descriptive prose, already stored by `bm_ingest.py`). `license`
  ("CC BY-NC-SA 4.0") and `credit` ("© The Trustees of the British Museum") are set on
  every `DigitalImage` node — populating the field doc 08 §2 added for exactly this
  NC-licensing situation, not left null the way the first metadata-only pass left it.
- **Run 2026-09-05: 31/31 images created and embedded, zero failures** — verified live
  (`embedding`/`clipImageEmbedding`/`clipTextEmbedding` all populated, correct 1024/512
  dims, `license` set on all 31).

## 7.2 Julian Trevelyan test load — four bugs found and fixed (2026-09-06)

A 29-record live pull of BM's Julian Trevelyan holdings (this project's own doc 08 §4.1/
4.2 worked example) was used as a regression case against `bm_ingest.py`, surfacing four
real issues, all fixed and verified before the real load:

1. **"Made by" producer role was unmapped** — BM catalogues an artist's own printing
   plate as a separate object from the impressions pulled from it, attributed "Made by:
   <artist>" rather than "Print made by:". This role wasn't in `ROLE_QUALIFIER_MAP`, so
   the artist's own attribution to their own plate was silently dropped. Added as `direct`.
2. **No print-type prefilter.** BM's `object_type=print` search facet returned a loose
   drawing sheet (`Technique: drawn`) alongside genuine prints — would have loaded as a
   bare, technique-less `Impression`. `classify_record()` now excludes any record whose
   `Technique` field yields zero recognized printmaking techniques after the AAT
   crosswalk — logged as `[EXCLUDED]`, same discipline as Forum's `is_print_medium`.
3. **No `Matrix` routing.** Same search facet also returned Trevelyan's own cancelled
   zinc printing plate and a plaster cast pulled from it (`Materials: zinc alloy`/
   `plaster`, no printmaking technique at all — a plate isn't printed, it's what a
   technique is applied *to*). These are genuine doc 08 `Matrix` nodes that
   `bm_ingest.py` had never actually populated. `classify_record()` checks `Materials`
   against a `PLATE_MATERIALS` set before the technique check, routing matches through
   a new `LOAD_QUERY_MATRIX` (`Artist -[:MADE_MATRIX]-> Matrix`).
4. **No entity resolution across accession records for the same work** — BM holds two
   separate accession numbers (`1980,1011.20` and `1987,0516.75`) for two impressions of
   the identical Trevelyan plate ("The Tenements of Mind"), both citing the identical
   Turner 1998 catalogue number 47 (confirmed by BM's own curatorial note). The old
   `map_record` keyed `ConceptualWork` off the accession number, creating two separate
   `ConceptualWork` nodes for one composition — the exact failure mode doc 08 §4.2
   already documents for Roseberys/V&A. Fixed: `ConceptualWork.id` is now keyed off the
   *first* catalogue-raisonné entry (`catalogueName`+`entryNumber` — a literal identity
   match, not a similarity heuristic) when one exists, falling back to the accession
   number otherwise (graceful degradation, doc 08 §4.1). `EditionRun`/`Impression` stay
   per-accession-record regardless — only the abstract-work identity is deduplicated.

**Verified live after the fix, not assumed correct from a clean run:** re-ran the
existing 31-record Rembrandt pilot cache through the fixed code as a regression check —
identical classification (31/31 still `print`, 0 excluded/matrix) — but the fix also
correctly caught a **real, previously undetected duplicate already sitting in the live
graph**: `bm-P_F-5-198` and `bm-P_1868-0822-683` (both "New Hollstein (Dutch & Flemish)
199") are two BM accession numbers for one Rembrandt composition, currently loaded as
two separate `ConceptualWork` nodes from the original pilot load. **Not yet fixed** —
flagged here rather than silently reloading Rembrandt data the user didn't ask about.

**Trevelyan load, 2026-09-06:** 26 prints + 2 matrix objects loaded (1 loose drawing
sheet correctly excluded). Trevelyan's `CREATED` count went 169 → 194 (25 distinct new
works, not 26 — the shared-catalogue-entry merge worked as intended). Verified live:
the shared `ConceptualWork` (`bm-cw-Turner_1998-47`) carries both accession numbers
under two separate `EditionRun`/`Impression` pairs; both `Matrix` nodes carry
`material`/`description` and a `MADE_MATRIX` edge from the existing canonical Trevelyan
`Artist` node (no fragmentation — BM's bare "Julian Trevelyan" string happens to exactly
match this graph's existing canonical name, unlike Rembrandt's case).

**Images checked, none exist for this set.** Unlike the Rembrandt pilot (31/31 imaged),
all 28 loaded Trevelyan objects — spanning every accession lot involved (1942, 1980,
1985, 1986, 1987, and the 1984 Asia-department outlier) — have **no digitized image at
all**: confirmed two ways, the `/api/_object` response's `multimedia` field is absent
entirely (not empty — the key doesn't exist), and the object page itself renders no
image tab/UI. Not a bug in the discovery step (which still needs the browser, per the
module docstring — only the image *download*, once a location is known, bypasses it via
`media.britishmuseum.org`) — a genuine BM digitization-coverage gap for this artist's
holdings. `bm_embed_images.py` was not run against this set; there is nothing to embed.
Worth remembering before assuming image coverage generalizes from the Rembrandt
pilot — BM's Old Master highlights and its wider 20th-century holdings are not
digitized to the same degree.

### 7.3 Image discovery folded into the catalogue scrape (2026-09-06)

Investigating the Trevelyan no-images finding above led to a real efficiency question:
how much of what the separate `/api/_object`-based image discovery step was fetching is
already sitting in the exact same object-detail-page HTML the catalogue-text scrape
pulls? Checked directly, not assumed: the page's own `<meta property="og:image">` tag is
non-empty exactly when `/api/_object`'s `multimedia` field is present, empty string when
it's absent — confirmed against 2 known-has (Rembrandt) and 6 known-none (Trevelyan)
records, zero mismatches. The URL itself resolves to the same UUID folder + base
filename `/api/_object` returns, just the `preview_` size variant instead of `large_`/
`max_` — and swapping the size prefix downloads a real, larger image via plain `curl`,
confirmed live (200, 138KB, no browser needed for that step, as already established).

**So the separate discovery round-trip (and the separate `rembrandt_pilot_images.json`
cache file it produced) was avoidable overhead, not a fundamental necessity** — folded
in: `parseFields()`'s scraping convention (documented in `bm_ingest.py`'s docstring) now
captures `ogImage: {url, width, height}` (or `null`) in the same page fetch as the
`dt`/`dd` catalogue fields, on every cache file going forward. `rembrandt_pilot.json`
was migrated in place (its 31 `ogImage` values backfilled from the now-deleted
`rembrandt_pilot_images.json`, no re-scrape needed since the data was already captured);
`trevelyan_test.json` got `ogImage: null` on all 29 records (already confirmed live).
`bm_embed_images.py` was rewritten to read `ogImage` directly from whichever cache
`bm_ingest.py` also loads (`--cache-path`, same convention) instead of a separate image
cache file, and to upsize the `preview_` URL to `large_` itself. Not caught until this
migration: what BM calls `og:image:width/height` describes the `preview` size, not the
`large` one this script actually downloads — never trusted for real dimensions anyway
(read from the downloaded bytes via `PIL` instead), so this didn't need a fix, just
noting the meta tags' own dimensions aren't reusable at face value.

**A second, unrelated bug found and fixed along the way, while verifying the rewrite
against the already-embedded Rembrandt set:** `bm_embed_images.py`'s
`FETCH_CANDIDATES_QUERY` had `WHERE $force OR img.embedding IS NULL` positioned
immediately after the *second* `OPTIONAL MATCH` rather than the primary `MATCH` — a
`WHERE` right after an `OPTIONAL MATCH` scopes to filtering that pattern's own match,
not the overall row set, so a false condition there still returns the row (with the
optional fields null) instead of excluding it. This made `--force` effectively
always-on: a plain re-run re-embedded all 31 already-embedded Rembrandt images instead
of finding 0 candidates — caught by treating "0 candidates" as the expected regression
result and getting 31 instead, not by assuming a clean exit meant correct. Fixed by
moving `WHERE` directly after the primary `MATCH`. **Checked and confirmed in
`embed_tate_images.py`'s identically-shaped `FETCH_QUERY` too (2026-09-06)** — live
test against the real Tate set (10,208/10,208 already embedded) with the original
query returned all 10,208 as candidates instead of 0 with `force=False`, i.e. a plain
`python3 embed_tate_images.py --all` re-run would have silently re-downloaded and
re-embedded the entire Tate image set every time, directly contradicting that script's
own "Idempotent — safe to re-run" assumption. Fixed the same way (`WHERE` moved
directly after the primary `MATCH`); re-verified both `force=False` → 0 and
`force=True` → 10,208 via the real `fetch_candidates()` function, not just the raw
query.

### 7.4 Architectural correction: `bm_ingest.py` creates `DigitalImage`, not `bm_embed_images.py` (2026-09-06)

§7.3's fold-in still had `bm_embed_images.py` re-opening `bm_ingest.py`'s own cache
file a second time to create `DigitalImage` nodes before embedding them — pointed out
directly: doc 08 already defines `DigitalImage.sourceUrl` for exactly this, and
`forum_ingest.py`'s own `LOAD_QUERY` already creates `DigitalImage` in the same pass as
the rest of the catalogue data, whenever a row has an image URL (`FOREACH (_ IN CASE
WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END | MERGE (img:DigitalImage ...))`).
`embed_images_dinov2.py` then only ever reads `sourceUrl` back from Neo4j — it never
touches Forum's CSV again. **The graph is the handoff between ingest and embed in
every other adapter in this toolkit; the BM pair was the one exception, not by design,
just because images weren't in the cache yet when `bm_ingest.py` was first written.**

Fixed to match: `bm_ingest.py`'s `map_record()` now computes `imageUrl`/`imageLicense`/
`imageCredit`/`imageWidth`/`imageHeight` from a record's `ogImage` (via
`_upsize_og_image_url()`, the same `preview_`→`large_` substitution §7.3 established),
and both `LOAD_QUERY` and `LOAD_QUERY_MATRIX` gained a `FOREACH`-guarded `DigitalImage`
block identical in shape to Forum's. `bm_embed_images.py` dropped
`create_digital_images()`, `load_cache()`, and `--cache-path` entirely — it's now a
pure embedding pass over whatever `DigitalImage` nodes already exist in the graph,
matching `embed_images_dinov2.py`'s shape exactly.

**Re-verified against the live graph, not just a clean script exit:** re-ran
`bm_ingest.py` on both the Rembrandt and Trevelyan caches after the change — Rembrandt
correctly re-`MERGE`d onto the same 31 `DigitalImage` nodes `bm_embed_images.py` had
created under the old architecture (same `id` convention, `objectId + "-image"`), with
zero duplication and all 31 embeddings left untouched (`bm_ingest.py`'s `DigitalImage`
block never sets `embedding`); Trevelyan correctly created zero `DigitalImage` nodes
(0/28 have `ogImage`). `bm_embed_images.py --all` with no arguments then correctly
found 0 candidates (already embedded) without reading any cache file at all; a forced
`--force --limit 3` smoke test confirmed the full download→DINOv2→CLIP→write pipeline
still works end-to-end through the graph-only path.

### 7.5 Third artist test: Stanley William Hayter (2026-09-06)

97 records pulled live (agent=`Stanley William Hayter`, exact producer-string match to
the existing canonical `Artist` node — no `PILOT_ARTIST_RESOLUTION` entry needed, same
lucky exact match as Trevelyan's). 96 genuine after excluding one non-Hayter false
positive from the search sample (a John Varley drawing sharing a dealer/agent facet).
Loaded cleanly through the now-corrected pipeline (§7.4): 1 drawing excluded (`Drawn
by:`, no printmaking technique), 96 prints loaded, 0 matrix objects this time, 8 real
`ConceptualWork` merges (accession groups of 2-4 sharing one catalogue entry — a bigger
merge rate than Rembrandt/Trevelyan's 1 each, consistent with Hayter's own catalogue
covering many states/impressions per plate). Hayter's `CREATED` count went 179 → 263
(+84, exactly matching 96 records minus the 12 works the 8 merge-groups collapsed).
Total BM `SourceRecord` count: 155 (31 Rembrandt + 28 Trevelyan + 96 Hayter).

**A real entity-fragmentation risk caught before writing, not after.** BM's citation
"Black & Moorhead 1992 / The Prints of Stanley William Hayter" would have created a
**sixth** spelling variant of Hayter's own catalogue raisonné — the graph already
carried five ("Black & Moorehead", "Black and Moorehead", "Black & Moorhead" [13
entries — the de facto canonical spelling], "Black & Moorheard", "Moorehead") as known,
pre-existing debt from prior Forum/Roseberys loads, confirmed live before writing a
single Hayter row rather than discovered after. Root cause: BM bakes the year into its
citation name ("Black & Moorhead **1992**") where Forum/Roseberys didn't, and
`parse_bibliographic_ref` extracts `year` as a separate field but was never stripping
it back out of the name used as the merge key. Fixed narrowly — a
`CATALOGUE_NAME_RESOLUTION` map (same pattern as `PILOT_ARTIST_RESOLUTION`) resolves
BM's exact citation string onto the existing 13-entry node — **not** a general
year-stripping rule, since Rembrandt's own citations ("Hind 1923", "White & Boon 1969")
embed a year the same way and already have real loaded nodes keyed on that exact
string; changing the key rule retroactively would fragment those against a
differently-keyed future run. The other 5 pre-existing Hayter-catalogue variants were
**not** touched at ingest time — logged, not swept, per [[feedback_defer_broad_sweeps]].

**Fixed on explicit request, 2026-09-06 (later the same session).** Merged all 5
pre-existing spelling variants ("Black & Moorehead", "Black and Moorehead",
"Black & Moorheard", "Moorehead", plus the canonical "Black & Moorhead") into one
node. **`apoc.refactor.mergeNodes` is not available on the self-hosted Oracle Neo4j
instance** (confirmed live — `Neo.ClientError.Procedure.ProcedureNotFound`; only the
GDS plugin was installed during the Aura→Oracle migration, not APOC's refactor
procedures) — merged manually instead, safe here because `CatalogueRaisonne` only has
outgoing `CONTAINS` edges: for each duplicate, `MATCH (dup)-[:CONTAINS]->(ce) MERGE
(canon)-[:CONTAINS]->(ce)` then `DETACH DELETE dup`, one duplicate at a time (not
batched — the dedupe/merge pass in [[project_ackg_status]] already found batching
multiple dups against one target in a single query drops alternate-name data on
sequential APOC calls; doing it as separate statements avoids that class of bug even
though this merge didn't use APOC at all). All 5 raw spellings preserved on the
survivor's new `alternateNames` property (a schema addition — `CatalogueRaisonne` had
no equivalent to `Artist.alternateNames` before this) rather than discarded. The 9
`CatalogueEntry` children carried over from the 4 non-canonical nodes still had their
old id prefix (e.g. `Moorehead-317`) — confirmed no collision against the canonical
node's existing 96 entries first, then renamed all 9 to the `Black & Moorhead-`
convention for consistency.

**Verified entry-number collisions before merging, not after** — checked whether any
of the 4 duplicates' entry numbers already existed under the canonical node (zero
found; the two catalogues' number ranges don't overlap). **Surfaced a bigger, separate
issue while checking this, correctly left untouched**: even within "Black & Moorhead"
alone, 5 entry numbers (182, 284, 303, 319, 35) already had TWO different
`ConceptualWork` nodes each — duplicate Forum listings of the same print (re-sold
across different auctions) that were never merged, because `forum_ingest.py` keys
`ConceptualWork` by lot id, not by catalogue entry — the identical root cause doc 09
§7.2 fixed for `bm_ingest.py`, still live and unfixed in Forum's much larger dataset.
Out of scope for what was asked (fixing the raisonné-name spelling, not Forum's
ConceptualWork identity model) — flagged here, not fixed, per
[[feedback_defer_broad_sweeps]].

**Final state, verified live:** exactly one `CatalogueRaisonne{numberingPrefix:
"Black & Moorhead"}` node, 105 distinct `CatalogueEntry` children (96 from this
session's BM load + 9 carried over), zero orphaned entries, zero missing
`DOCUMENTS` links.

**Images: 0/96, third data point confirming Trevelyan's finding wasn't an outlier.**
Checked two ways again, not assumed from the pattern: `/api/_object`'s `multimedia`
field absent on every spot-checked record, including a broader cross-lot sample (not
just the first few, which shared one accession lot). One initial spot-check on an
excluded (non-Hayter) record briefly suggested a scraping bug — resolved by confirming
that record wasn't actually one of the 96 genuine Hayter records at all, just a false
lead from testing an ID that shouldn't have been checked in the first place. `bm_ingest.py`
correctly created 0 `DigitalImage` nodes; `bm_embed_images.py --all` correctly found 0
candidates. Three-for-three now on major/large BM print holdings outside the
specifically-digitized Old Master highlights (Rembrandt) lacking images — worth treating
"undigitized by default" as the working assumption for any future BM pull, checking
Old-Master-highlight status as the exception rather than the rule.

## 7.6 `forum_ingest.py`'s own duplicate `ConceptualWork` bug: fixed and backfilled (2026-09-06)

§7.5's Hayter merge surfaced that the exact same "multiple accession/lot records citing
one catalogue entry create separate `ConceptualWork` nodes" bug already fixed for
`bm_ingest.py` (§7.2) was still live, unfixed, in `forum_ingest.py`'s much larger
dataset — `forum_ingest.py` keys `ConceptualWork` by lot id, never by catalogue entry.
Fixed the script and backfilled the already-loaded graph, on explicit request.

**The script fix is NOT a straight copy of `bm_ingest.py`'s — it needed to be stricter.**
`bm_ingest.py`'s version keys `ConceptualWork` by `catalogueName + entryNumber` alone.
Validating the Forum backfill found that unsafe for Forum's data specifically: bare
catalogue-name prefixes like "Cramer" and "Cristea" are dealer/cataloguer names Forum's
own data reuses across MULTIPLE different artists — confirmed live, "Cramer 56"
collided Henry Moore with Pablo Picasso, "Cramer 99" collided Moore with Chagall,
"Cristea 12/24/31/75" collided Patrick Caulfield with Gillian Ayres or Ben Nicholson.
Catalogue+entry alone would have silently merged different artists' work onto one
`ConceptualWork`. Fixed by folding the artist's own cleaned name into the key
(`forum-cw-{artist}-{catalogue}-{entry}`) — this makes that class of collision
structurally impossible going forward, since different artists always produce
different keys even citing the identical catalogue+number. (`bm_ingest.py`'s own key
was NOT changed to match — BM's data never exhibited this problem, and retroactively
changing an already-shipped key scheme would fragment the Rembrandt/Trevelyan/Hayter
data already loaded under it against a differently-keyed future run.)

**The backfill needed real validation, not blind trust in the regex parse — confirmed
by finding actual corruption risks before touching anything.** Sized the raw scope
first: 327 catalogue entries had 909 duplicate `ConceptualWork` nodes (582 to merge
away) under the OLD catalogue-only grouping. Before merging anything:
1. **Artist-scoping the key** (above) mechanically resolved the Cramer/Cristea
   cross-artist cases, narrowing to 320 groups, 570 to merge.
2. **A name-similarity check across every remaining group** (normalized text,
   `SequenceMatcher` ratio) caught a second, different failure mode: some bare
   citations are genuinely NOT artwork identifiers at all. `parse_catalogue_refs`'s
   naive "last token = entry number" regex had already mis-parsed plain descriptive
   text into fake catalogue names *before* today — "No. 458" (an EDITION number,
   confirmed live: 5 completely different STIK colourway prints all happened to cite
   it), "Set of 8" (a title phrase shared by four unrelated artists — Shrigley, Fries,
   Dylan, Opie). Separately, "Lugt" numbers catalogue **collector/provenance marks**,
   not artworks — two different prints legitimately sharing a Lugt number is correct,
   not a bug, so that whole prefix was excluded from identity-matching regardless of
   this specific check. 11 groups were flagged this way.
3. **Flagged groups were not simply dropped** — 9 of the 11 had a genuine duplicate
   pair or triple *inside* them, hidden behind one outlier with different wording (a
   portfolio-level citation covering several distinct plates, e.g. Chagall's "Cramer
   22" covers 4 different La Fontaine Fables plates, only some of which were actually
   re-sold twice). Recovered those via exact-normalized-title sub-matching — safe
   because it only merges when the title text matches exactly, never on similarity
   alone. Left exactly 3 groups with no safe merge at all (Dalí's "Atomo"/"Moscas" —
   genuinely different prints; two Dürer groups where one page-level "Meder" citation
   covers several different Passion/Apocalypse subjects).
4. **A real collision was caught by testing the plan before running it, not after**:
   two distinct exact-title sub-groups under the same (artist, catalogue, entry) key
   — Chagall's two different "Cramer 22" pairs — both computed the identical
   canonical id, which would have thrown a uniqueness-constraint error (or worse,
   silently merged two different plates) had it not used a `MATCH`/`SET`-based manual
   merge (no APOC on this instance, see [[project_ackg_oracle_migration]]) that fails
   loudly on a live constraint check. Fixed by giving those specific recovered
   sub-groups the survivor's own pre-existing id instead of the generic naming scheme.

**Final validated set: 318 groups, 870 works, 552 to merge away** (309 clean
artist+catalogue+entry matches + 9 recovered exact-title sub-groups). Executed as two
passes (rename survivors, then redirect-`CREATED`/`PRINTED_AS`/`DATED_TO`-then-
`DETACH DELETE` each duplicate — same manual pattern as §7.5's `CatalogueRaisonne`
merge, no APOC available). **551 actually deleted, not 552** — investigated rather
than dismissed as noise: one work (`forum-166358`, a Helen Phillips print) carried TWO
separate catalogue citations ("Croissance IV" and "Story 105") that both independently
identified the same real duplicate pair, so it appeared in the plan twice; the survivor
node's `id` got set twice (once per citation) and the first of the two identical merge
operations became a harmless no-op once the id it was matching on had already been
overwritten by the second. Confirmed live: the work is correctly merged, not lost.

**Verified live, every check against the pre-migration baseline, not just a clean
script exit:**
- `ConceptualWork` count: 10,050 → 9,499 (exactly 551 fewer).
- Zero `Impression`/`EditionRun` loss: `PRINTED_AS` edge count unchanged at exactly
  10,050 before and after (every merged duplicate's `EditionRun` correctly re-parented
  onto its survivor, none dropped).
- `CREATED` correctly consolidated to exactly 9,499 (one per surviving node — expected,
  since every merge shares the same artist by construction, so the redirect's `MERGE`
  collapses onto the survivor's own pre-existing edge rather than duplicating it).
- `DATED_TO` dropped by 549 of the expected 551 (the 2-edge difference reflects a
  couple of merged pairs whose recorded date years genuinely differed slightly between
  lots — an accepted, minor real-world data variance, not a bug).
- Re-ran the artist-scoped duplicate check afterward: the only remaining multi-work
  groups are exactly the intentionally-excluded ones from step 3/the fully-excluded
  ones from step 4 above, each narrowed to precisely its correct residual count (e.g.
  Chagall's "Cramer 22" went from 6 raw works to the expected 4 — 2 genuine pairs
  merged down to 2 nodes, 2 genuinely distinct plates left untouched) — nothing merged
  that shouldn't have been, nothing left merged that should have been split.

## 7.7 §7.6's fix corrupted data: found, repaired, and replaced with `catalogue_matching.py` (2026-09-06)

§7.6's "final validated set" above was itself wrong, discovered only after re-auditing
it against a stricter rule while building the equivalent Roseberys fix (§7.8) — a
reminder that "verified live" against the checks that occurred to you at the time is
not the same as actually correct, and this graph needed a second, real repair on top of
the first one.

**The `SequenceMatcher`-based validation step (§7.6 step 2/3) was itself unsafe.** Its
`norm()` function stripped ALL parenthetical text (`re.sub(r'\([^)]*\)', '', s)`) before
comparing titles, meant to strip catalogue-citation parentheticals like "(Cramer 22)" —
but this also erased genuinely distinguishing details living inside other parens:
- **5 different Stik "Holding Hands" colourway prints** (Yellow/Orange/Orange/Red/Red)
  were wrongly merged into one `ConceptualWork` — their only distinguishing text was the
  colour name, itself parenthetical, stripped by `norm()` before the similarity check
  ever ran. (This also confirmed "No. 458," already flagged as suspicious in §7.6, was
  never a catalogue citation at all — an edition number.)
- **Chagall's "Cramer 30" portfolio citation wrongly merged 6 genuinely different Bible
  plates** — Samson and Delilah, Aaron et le Chandelier, Joshua Before Jericho, Jacob's
  Ladder, Lot and His Daughters, Isaiah — because their titles shared enough common
  scaffolding text ("...from Bible (Cramer 30)") to clear the 0.5 similarity threshold
  despite depicting different subjects. Portfolio/series-level catalogue numbering
  covering several distinct plates by the same artist, already known from §7.6's Dalí/
  Dürer exclusions, turned out to also produce false positives, not just false negatives.

**Repair process — recomputed the entire 318-group plan against a strict, non-fuzzy
ground truth**: exact full normalized-title match only, no similarity threshold, no
parenthetical stripping. Found 308 of the 318 executed groups were actually correct;
diffed against the executed plan to isolate exactly 33 bad groups. Two-pass repair:
1. **Fix pass** — created 59 new, correctly-split `ConceptualWork` nodes with proper
   `PRINTED_AS`/`CREATED`/`DOCUMENTS` edges, anchored on `EditionRun.id` (`{originalId}-
   er`, never touched by §7.6's migration, so a reliable per-lot anchor to rebuild from).
2. **Cleanup pass** — pruned 35 stale `PRINTED_AS` edges left on 15 reused nodes and
   deleted 18 fully-orphaned old merge-artifact nodes. **Blocked once by the Claude Code
   Bash permission classifier** (a large destructive Neo4j write) — explained the action
   to the user and got explicit confirmation before retrying, same as the original §7.6
   migration's own two blocks.
3. **A second bug surfaced mid-repair**: the 15 *reused* nodes (correct membership, just
   needed to keep some but not all of their pre-repair impressions) had their name/date
   properties updated with `coalesce()`, which by design keeps the OLD value when one
   already exists — so they kept their wrong pre-repair name instead of adopting their
   now-correct partition's name (confirmed live: a Chagall node correctly held only its
   4 "Samson and Delilah" impressions but still displayed "Lot and His Daughters").
   Fixed with a forced-overwrite pass — 45 properties corrected across 15 nodes.

**Final verified counts**: `ConceptualWork` 9,499 → **9,540** (+59 new, −18 deleted, exact
arithmetic match). `EditionRun` unchanged at exactly 10,050, zero orphaned, zero
double-linked. Cross-checked all 307 remaining merged nodes' constituent impressions
against cached original per-lot titles — zero mismatches.

**Root-cause fix, not a patch**: built `catalogue_matching.py`, a module shared with
`roseberys_ingest.py` (§7.8), whose `normalize_title()` deliberately does *not* strip
parentheticals, and whose `build_conceptual_work_id()` requires the normalized title as
part of the identity key *itself* — not a post-hoc similarity check layered on top. No
fuzzy threshold is used anywhere in it, by design: under-merging (two listings of the
same real work that drifted slightly in title text staying as separate nodes) leaves the
graph correct, just not maximally deduplicated; over-merging corrupts it. `forum_ingest.py`
was updated to call this shared module instead of its own inline (and, it turned out,
non-`genuine_refs()`-filtered) key computation — a live regression check against the full
11,391-row CSV found zero unsafe collisions under the new module, only 9 same-key/
different-title cases, all confirmed pure punctuation/quote-mark drift on the identical
work, not a repeat of the Stik/Chagall pattern.

One more gap found but deliberately NOT fixed here, flagged instead: `forum_ingest.py`'s
`LOAD_QUERY` still stores the *raw, unfiltered* `catalogueRefs` list for
`CatalogueRaisonne`/`CatalogueEntry` node creation, not the `genuine_refs()`-filtered
one used for identity-keying — so confirmed-junk citations ("No. 458", "American
1928-1987") can still land as bogus catalogue nodes in the graph, even though they can
no longer corrupt `ConceptualWork` identity. `roseberys_ingest.py` (§7.8) does not
repeat this gap — it applies `genuine_refs()` once, up front, before either use.

## 7.8 Roseberys catalogue-raisonné parsing and duplicate-`ConceptualWork` fix, built and backfilled (2026-09-06)

Roseberys' bulk adapter (§3.1) had the same two gaps Forum had before §7.6/§7.7: `catalogue_refs`
was stored only as a raw, unparsed string (`catalogueRefsRaw`) — never instantiated as real
`CatalogueRaisonne`/`CatalogueEntry` nodes — and `ConceptualWork` was keyed purely per-lot
(`row.objectId`), so the same edition print resold across different Roseberys sales over the
10-year extract sat as separate `ConceptualWork` nodes forever, never sharing one identity.

Built using `catalogue_matching.py` (§7.7) from the start, rather than re-deriving and
re-learning the two corruption incidents that module encodes. `map_row()` now calls
`genuine_refs()` once up front and reuses that same filtered list for both identity-keying
(`build_conceptual_work_id()`) and `CatalogueRaisonne`/`CatalogueEntry` storage — closing the
gap flagged above that `forum_ingest.py` still has.

**Scope, computed by dry-running `map_row()` over the full 12,700-row post-filter CSV before
any live write**: 731 rows carry a genuine catalogue ref; these collapse to 628 distinct
catalogue-keyed `ConceptualWork` ids, of which 86 are real multi-lot groups (189 old per-lot
rows absorbed, net reduction of 103) — the other 542 are singleton citations with no actual
duplicate to merge. Spot-checked the largest groups (up to 6 lots) before executing: all
legitimate same-work resales across different sale codes (e.g. Richard Hamilton's "Whitley
Bay" [Lullin 61] resold across 6 separate Roseberys sales), plus one same-sale case (Terry
Frost's "Red Yellow and Black" [Kemp 169], sale A0547 lots 2/3/4) that checked out as three
genuinely different physical proofs — Artist's Proof, Printer's Proof, and a pair of unsigned
trial proofs — of the same edition correctly sharing one `ConceptualWork` while keeping
separate `EditionRun`/`Impression` nodes per lot, exactly as doc 08's model intends. Only 11
catalogue-keyed ids showed more than one distinct raw title among their member rows, and every
one was confirmed pure punctuation/quote-mark drift on the identical work (curly vs straight
quotes, brackets vs parens) — not a repeat of §7.7's false-merge pattern.

**Execution, simpler than Forum's repair because `EditionRun`/`Impression`/`SourceRecord` ids
never change** (still derived from the unchanged per-lot `objectId` — only `ConceptualWork.id`
changes for the 189 affected rows):
1. Re-ran `roseberys_ingest.py`'s own `LOAD_QUERY` over all 12,700 filtered rows. Idempotent
   for the ~12,511 unaffected rows; created the 628 new catalogue-keyed `ConceptualWork` nodes
   (and their `CatalogueRaisonne`/`CatalogueEntry` nodes) for the rest, live count confirmed
   13,426 total (was 12,665).
2. Verified, before deleting anything, that every one of the 189 now-superseded old per-lot
   `ConceptualWork` nodes carried only the expected edge shape — `{CREATED, PRINTED_AS}` (6
   nodes) or `{CREATED, PRINTED_AS, DATED_TO}` (183 nodes), nothing else, confirmed via a live
   query grouped across all 189 ids in one pass.
3. `DATED_TO`→`Period` is added by a separate enrichment pass, not by `LOAD_QUERY` itself — so
   simply deleting the old nodes would have silently dropped this real data for 183 of them.
   Migrated each old node's `DATED_TO` edge onto its replacement first (183 migrated), then
   re-verified each new node already held the correct `CREATED`/`PRINTED_AS` edge set from
   step 1 before allowing any delete — the repair script aborts before deleting anything if a
   single verification fails. **Blocked once by the Claude Code Bash permission classifier**
   (a large Neo4j write); explained the action to the user and got explicit confirmation
   before retrying, same pattern as both §7.7 blocks.
4. `DETACH DELETE`d the 189 old nodes: 561 relationships removed, matching `183×3 + 6×2`
   exactly.

**Verified live**: `ConceptualWork` total 13,426 → 13,237, exact match to `13,426 − 189`.
`EditionRun`/`Impression`/`SourceRecord` counts identical before and after (12,807 each, as
expected since their ids were never touched). Spot-checked the Richard Hamilton 6-lot group
post-repair: correct artist, all 6 `EditionRun` ids present, `DATED_TO` correctly pointing at
the "1960s" `Period` node, and confirmed all 4 sampled old node ids no longer exist.

**Found but deliberately not fixed here, spun off separately**: `roseberys_ingest.py`'s
`base_id` scheme (`sale_code` + `lot_number`) assumes that pair is unique per lot — a full
groupby over the 12,700-row filtered CSV found exactly one collision, sale `A0503` lot 7,
holding two completely unrelated works (Braque's "The Bird" and Matisse's "The Dancer").
Confirmed already merged onto one live `Impression`/`EditionRun`/`SourceRecord` node today —
pre-existing, unrelated to the catalogue-refs fix above, narrow enough in scope (1 pair out of
12,700 rows) that it doesn't need the same base-id redesign Forum's own docstring already
documents for its own, much larger (54-row) version of the identical problem.

## 7.9 Fourth artist test: Agathe Sorel, with real BM-scale timing measurements (2026-09-06)

First BM artist test explicitly run to gather throughput numbers for a full-catalogue
scaling estimate, not just to validate correctness. 30 print records found via BM's own
`object_type=print` search facet (a single page, no pagination needed), all 30 correctly
classified as prints, 0 excluded, 0 unmapped producer roles, 0 warnings — the cleanest
regression result of any artist tested so far. Two real bugs found and fixed, both
confirmed against Sorel's own data before being generalized, and both regression-checked
against Rembrandt/Trevelyan/Hayter's existing caches to confirm zero behavior change for
already-loaded artists:

1. **`classify_record()`'s technique check has a real blind spot**: BM's own structured
   `Technique` field can itself carry a non-standard descriptor with no AAT crosswalk
   entry — 3 of Sorel's "Catalana Blanca" digital-lithograph prints have `Technique:
   ["digitally generated"]`, which `extract_techniques()` doesn't recognize, wrongly
   excluding 3/30 genuine prints (BM's own `object_type=print` facet already returned
   them as prints). The real technique ("Lithograph from computer-generated image") sits
   only in free-text `Description`. Fixed with `resolve_techniques()`: check the
   `Technique` field first, fall back to scanning `Description` only when that field
   alone yields nothing recognized — same free-text-technique-extraction principle Met's
   adapter already uses, just as a fallback rather than the primary path here. Computed
   once in `map_record()` and passed into `classify_record()` so classification and the
   stored `techniques` list can never drift apart.
2. **`_upsize_og_image_url()`'s `preview_`→`large_` substitution, verified only against
   Rembrandt's images, does NOT hold for Sorel's**: `large_` 404s for all 28 of her
   images, across every folder-date prefix her records span (`2026_5/...` and
   `2015_1/...` alike) — only `preview_`/`small_` resolve. Found via the embedding
   script's own download step (`HTTP 404` on the first smoke-test batch), not caught at
   ingest time, since the substitution was never actually verified per-image, only
   assumed from one earlier check. Fixed by adding a live HEAD-request check inside
   `_upsize_og_image_url()` itself (`media.britishmuseum.org` isn't behind Cloudflare, so
   this is scriptable) — falls back to the original, confirmed-working `preview_` URL on
   anything but a 200. Re-ran the already-loaded ingest (idempotent `MERGE`, corrected
   the 28 `DigitalImage.sourceUrl` values in place) before re-attempting the embed.
   Regression-checked: Rembrandt's own images still resolve `large_` correctly for
   28/31 of them (the other 3 now correctly fall back to `preview_` too — this was
   silently wrong before, just never triggered since the smoke test only sampled 3
   images out of 31).

**Timing measurements** (this session's actual runtimes, not projected):
- **Search**: 18s for a single BM `object_type=print` + keyword search (30 hits, no
  Cloudflare challenge encountered — page loaded past it directly, cookie-consent
  banner dismissed via one click).
- **Scrape** (per-object catalogue fields + `og:image`, via the browser-driven
  `scrapeObject()` JS pattern in this file's own docstring): 47s total for 30 objects in
  two batches (10 then 20) — **~1.5–1.7s/object**, consistent across batch sizes.
- **Ingest** (map + write to Neo4j, including the new per-image HEAD verification added
  above): 10-15s for 30 records (28 of them requiring a HEAD check) — **~0.3–0.5s/
  record**, HEAD-check latency dominates.
- **Embed** (download + DINOv2-Large + CLIP image + CLIP text, per image): 27s for 28
  images — **~1.0s/image**, plus a small one-time model-load cost (a few seconds,
  amortized across a run, not per-image).
- **Total for this run**: ~87s of actual scrape+ingest+embed compute time for 30
  objects/28 images, excluding the time spent diagnosing the two bugs above.

**Scaling implication, not yet a decision**: at ~1.5-2s/object end-to-end (scrape+ingest)
plus ~1s/image for embedding, a few-thousand-object pull is a few-hour job, not a
multi-day one — well within reach of hand-driven browser batches (10-20 objects per
`javascript_tool` call, as used here) without needing Playwright automation, PROVIDED
Cloudflare continues to not challenge the search/object pages the way it did during
initial pilot testing (not guaranteed — this session encountered zero challenges across
all 30+61 object fetches, but earlier sessions this same week did hit the interstitial on
first contact; worth treating as variable, not assumed-clear, on any future run).
**Update, same day**: the real denominator was found after all — BM's `/api/_search`
endpoint returns a full `object_type` terms aggregation over its ENTIRE collection
(2,722,760 objects total) regardless of the query's own hit-count cap, and the `print`
bucket (the same facet every artist test in this section uses) is **516,376** — not
estimated, read directly from a live `object.buckets` aggregation (`doc_count_error_
upper_bound: 4,424`, i.e. accurate to within <1%). Adjacent, likely-overlapping-in-intent
buckets: `photographic print` 38,561, `satirical print` 31,083, `print study` 9,253,
`matrix` 34,316, `impression` 11,610 — none included in the 516,376 headline figure,
since that's scoped to exactly the facet this project's own searches use.

At this session's measured rates (~1.5–1.7s/object scrape + ~0.3–0.5s/object ingest),
516,376 objects is **~290 hours of raw scrape+ingest throughput** (~12 days if it ran
continuously and unattended) — before any embedding time, which can't be estimated the
same way since image coverage swung from 0% (Trevelyan, Hayter) to 93-100% (Sorel,
Rembrandt) across just 4 artists tested, no reliable average yet. This throughput figure
is optimistic, not a realistic full-run estimate: it assumes away (1) that this is
currently a manual, browser-driven, per-artist-search process, not an unattended crawl —
scaling to 516k objects needs either a systematic non-keyword crawl strategy or real
automation, i.e. exactly the Playwright decision this section has flagged as open and
unmade since the pilot began; (2) Cloudflare behavior, confirmed variable
session-to-session (zero challenges this run, but hit on first contact in earlier
sessions) — sustained high-volume traffic is exactly what a bot-management wall exists
to catch; (3) the CC BY-NC-SA non-commercial licensing checkpoint already logged, unaffected by scale but still unresolved for any future commercial use.

**Verified live, both before and after each fix**: 30 `ConceptualWork` (0 catalogue-refs
present in Sorel's BM data at all — every record fell back to the per-accession id,
unlike Rembrandt/Trevelyan/Hayter which all had `Bibliographic references`), 30
`Impression`, 28 `DigitalImage` all with confirmed-correct `sourceUrl` after the fix, all
28 fully embedded (DINOv2 + CLIP image + CLIP text, zero failures). Artist identity: a
pre-existing "Agathe Sorel" node already had a `ulanUrl` set (`500087942`) from a prior
Forum/Roseberys ULAN backfill — the bare-name string matched exactly, so no
`PILOT_ARTIST_RESOLUTION` entry was needed; the existing `ulanUrl` was correctly
preserved via `coalesce()`.

**Found but deliberately not fixed, spun off as a background task instead**: every
BM-sourced `ConceptualWork.name` (not just Sorel's, going back to the Rembrandt pilot —
~180+ nodes total) carries a literal `"Object: "` label prefix baked in from BM's own
multi-part Title field (`"Object: Salts"` instead of `"Salts"`) — never stripped by
`map_record()`. Confirmed pre-existing and consistent across the whole BM dataset, not
new to this run; fixing it only for Sorel would make her data inconsistent with
everything else already loaded, so it needs its own backfill across all BM-sourced nodes,
not an ad hoc fix here.

## 7.10 Ten-artist BM extraction: Roseberys→BM-verified priority list, fully loaded (2026-09-06)

Executed the priority list from §"BM extraction prioritization" in `project_ackg_status.md`
(memory) — the 10 Roseberys artists with the strongest verified BM 1900+/imaged coverage, not
the highest raw Roseberys lot volume (see [[reference_bm_search_api]] for how that list was
derived). Order: Eric Gill, R.B. Kitaj, Jim Dine, Anthony Gross, Stanley Anderson, Henry Moore,
Paul Nash, Richard Hamilton, Tom Phillips, Ed Ruscha. Run as a single background agent working
artist-by-artist (scrape → direct-producer+1900+ filter → ingest → verify per artist, one
consolidated embedding pass at the end), following the exact process this doc's own §7.9 (Agathe
Sorel) established, just at 50x the scale.

**Final totals**: 1,613 raw BM candidates (via `agent[]=<name>&object[]=print&image=true`,
paginated) → 1,582 survived the direct-producer-role + production-date-1900+ filter (a real,
non-trivial cut — Henry Moore lost 18%, matching the estimate `project_ackg_status.md` already
recorded from the earlier sampling pass) → 1,582 scraped, 0 Cloudflare challenges the entire run
→ 21 excluded at ingest time → **1,313 `ConceptualWork` nodes loaded** (166 via catalogue-entry
merges) → **1,561 `DigitalImage` nodes created and fully embedded** (`embedded=1561 failed=0`,
~1.0s/image, matching §7.9's rate almost exactly).

**Two more artist-identity fragmentation cases found and fixed, same pattern as Rembrandt/Sidney
Nolan**: R.B. Kitaj (5 pre-existing name-variant nodes; BM's bare "R B Kitaj" would have grown a
sixth) and Stanley Anderson ("Stanley Anderson" vs "Stanley Anderson RA RE" — a genuine 10-vs-10
work-count tie broken by which node actually carries a real ULAN, not by name length or
formatting). Both added to `PILOT_ARTIST_RESOLUTION` in `bm_ingest.py`, checked against the live
graph before writing, matching the established discipline. The other 8 artists had unambiguous
canonical nodes already.

**One real crosswalk bug fixed live**: "Photomechanical print" was entirely missing from
`crosswalk_matching.py`/`aat_crosswalk.json`, silently excluding 7 of Richard Hamilton's real BM
prints (his "artist postcard" works, which BM itself classifies as prints). Added with
`aatId: null` (no confirmed AAT concept id — same honest-gap convention already used for
"Giclée"), regression-checked against all 5 pre-existing BM caches with zero behavior change.

**A second, larger crosswalk gap found but deliberately NOT fixed**: digital/inkjet print
process terms ("digitally generated", "digital print", "Epson inkjet digital print", "digital
dye sublimation print") excluded 7 more Richard Hamilton records and 6 of Tom Phillips's 7
exclusions — confirmed systematic across at least two artists, not a one-off, but no AAT id could
be verified with confidence in-session. Per this project's own no-guessing rule, spun off as its
own background task (`task_cb3d23ee`) for a dedicated, properly-sourced pass rather than adding
an unverified id here.

**The pre-existing `"Object: "` title-prefix bug (§7.9) now covers a much larger set** — all
1,313 `ConceptualWork` nodes added this run inherit it, alongside the ~180 from the four earlier
BM artists. Still not fixed here (task already queued, per [[feedback_defer_broad_sweeps]]), but
the eventual backfill scope just grew roughly 8x.

## 7.11 Second 10-artist BM batch: Roseberys→BM priority list continued, fully loaded (2026-09-06)

Executed the second half of the priority list from `project_ackg_status.md`'s BM extraction
prioritization memory (§7.10 covered the first 10). Order: Paula Rego, Terry Frost, Edward Bawden,
Edward Wadsworth, Michael Rothenstein, Peter Blake, Henri Matisse, Josef Albers, Gilbert & George,
Hughie O'Donoghue. Run as a single background agent, same artist-by-artist process as §7.10
(scrape → direct-producer+1900+ filter → ingest → verify per artist, one consolidated embedding
pass at the end), at roughly 1/8th the scale (10 artists, ~220 candidates vs. §7.10's ~1,600).

**Final totals**: 220 raw BM candidates (`agent[]=<name>&object[]=print&image=true`, single page
per artist, all under BM's 100-hit cap) → 212 survived the direct-producer-role + production-date-
1900+ filter (Peter Blake lost 2 to a "Drawn by:" role, Henri Matisse lost 5 — 4 of which were
actually R.B. Kitaj prints the `agent[]` facet's "associated names" also caught, 1 an "After:"
reproduction credit — both confirmed genuine, not name collisions with a different person) → 212
scraped, 0 Cloudflare challenges the entire run → **0 records excluded at ingest time** (2 initial
Josef Albers exclusions resolved by a crosswalk fix, see below) → **209 `ConceptualWork` nodes
loaded** (3 via genuine catalogue-entry merges: Paula Rego x2, Edward Wadsworth x1) → **212
`DigitalImage` nodes created and fully embedded** (`embedded=212 failed=0`), 100% image coverage
across all 10 artists (unusually high — every artist this batch happened to have image=true
records with genuinely resolvable URLs, no `preview_`-only fallbacks needed).

**Artist identity: all 10 artists had a single, unambiguous canonical node already** — no
`PILOT_ARTIST_RESOLUTION` entries needed this batch (unlike R.B. Kitaj/Stanley Anderson in §7.10).
Checked live before every ingest, per the established discipline, not skipped because the pattern
hadn't recurred recently.

**Two real, previously-latent bugs found and fixed in `bm_ingest.py` itself** (not just crosswalk
gaps — see below), both confirmed via `--dry-run` before any write and regression-checked against
all 21 pre-existing BM caches (5 from the pilot/pre-§7.10 era, 16 from §7.10) with zero exclusion-
count or merge-count drift:

1. **`bm_ingest.py` never adopted `catalogue_matching.build_conceptual_work_id()`'s title-inclusive
   identity keying** — the fix `forum_ingest.py`/`roseberys_ingest.py` already needed after doc 09
   §7.6/§7.7's real corruption incidents (a portfolio/page-level citation can legitimately cover
   several different plates). `bm_ingest.py` still keyed `ConceptualWork.id` off bare
   `catalogueName + entryNumber` alone. Every earlier BM artist's catalogue system (New Hollstein,
   Hind, White & Boon, Hinterding, Turner, Black & Moorhead, Danilowitz, Sidey) happened to number
   per-work already, so this was never actually wrong before — until Edward Bawden's "Howes 1988 /
   Edward Bawden: A Retrospective Survey (p.10)" citation, which cites a PAGE number, not a
   per-work entry: 10 genuinely distinct "Fifteen Engravings 1927-29" portfolio engravings (Kew
   Gardens, Reverie, Southcliffe Beach, Liverpool Street Station, Tortoise, The Jetty Beach, Lane
   in Moonlight, Marine Parade, Round Trip, The Pagoda Kew) all cited "(p.10)" and would have
   wrongly collapsed into ONE `ConceptualWork`. Fixed by importing and using
   `catalogue_matching.build_conceptual_work_id()` in `bm_ingest.py`'s `map_record()`, matching
   forum/roseberys exactly — same-page citations for different-titled works now correctly stay
   separate. A second, distinct case of the identical underlying problem surfaced immediately
   after in Josef Albers's data (below).
2. **The `ConceptualWork` title fallback chain skipped the `Series:` field** — when a record's
   `Title` carries only a `Series:` label (no `Object:` title), `map_record()` fell straight from
   the (absent) Object title to a `Description[:120] + "..."` truncation. Josef Albers's
   "Formulation: Articulation I" and "Formulation: Articulation II" — a genuine two-part portfolio
   pair, each with ONLY a `Series:` Title entry — have near-identical boilerplate Descriptions that
   are byte-identical for their first 120 characters (only diverging in text the truncation cut
   off). Both records also cite the same catalogue appendix reference ("Danilowitz 2001 ...
   (Appx.C)"), so the identical truncated title fed an identical key into
   `build_conceptual_work_id()` even after fix #1, wrongly merging two different portfolios.
   Fixed: the fallback chain now tries `Series:` before the truncated `Description`, since Series
   is real structured data and IS the distinguishing name for exactly this case. Confirmed live
   post-fix: `bm-cw-Josef_Albers-Danilowitz_2001-Appx.C-formulation_articulation_i` and `...-ii`
   are now two separate `ConceptualWork` nodes, as they should be.

**Three real crosswalk gaps found and fixed live**, all verified against vocab.getty.edu before
adding (search results, not memory), same discipline as Monotype/Photomechanical print/Digital
print in §7.9/§7.10:

- **"Stencil printing"** — Michael Rothenstein's "The love machine" (Technique: `["stencil
  printing", "photorelief", "colour"]`) had neither term recognized, wrongly excluding a real,
  editioned print. `aat:300435282` "stencil printing" (Activities Facet, exact term match) added.
- **"Photorelief"** — same Rothenstein record. No exact-string AAT concept exists for BM's own
  abbreviation, but `aat:300155634` "relief photomechanical processes" (Activities Facet, scope
  note "Photomechanical processes using relief printing surfaces") is a genuine process-level
  match — used rather than an unmapped/`aatId: null` entry since a real match was confirmed.
- **"relief" (bare)** — two genuine, editioned Josef Albers cork relief-prints ("Inscribed"/
  "Involute", Danilowitz cat. nos. 114/115, editions of 25) carry bare `Technique: ["relief"]`,
  unrecognized. `aat:300053285` "relief printing" (Activities Facet, direct parent "printing
  (process)") added, suppressed against "Photorelief" (which itself contains the substring
  "relief") via `TECHNIQUE_SUPPRESSES`.

None of this batch's records hit the digital/inkjet print crosswalk gap flagged as a background
task in §7.10 (`task_cb3d23ee`) — confirmed not applicable to these 10 artists, not assumed.

**The pre-existing `"Object: "` title-prefix bug (§7.9) grew again** — all 209 `ConceptualWork`
nodes added this run inherit it. Still not fixed here, same queued backlog as §7.10.

## Next steps

1. Migrate the 3 miscategorized Met tags (Abstraction, Landscapes, Christmas) from
   `Subject` to the new `Genre` node type in the live graph.
2. Once a fourth source is ingested, check whether this doc's taxonomy still holds
   without modification — that's the real test of whether it's a reusable framework
   or just a description of three sources.
3. **British Museum bulk-scale decision (not yet made):** decide whether BM coverage
   stays at hand-curated pilot scale (a curated reference set for specific specialist
   configs — Rembrandt done, Dürer/Hogarth/ukiyo-e plausible next) or justifies building
   a Playwright-based scraper to solve the Cloudflare challenge unattended. The pilot's
   data quality (best-structured source in this graph, first real multi-catalogue-
   raisonné confirmation) argues for more coverage; the access-method cost and the
   NC-licensing question argue for staying deliberate rather than defaulting to bulk.
4. Resolve the BM dimension-type ambiguity (sheet vs. plate vs. image) noted in §7
   before trusting `bm_ingest.py`'s output for dimension-based work matching at scale.
5. **Europeana checked as a possible route into BM's data (2026-09-05) — not adopted,
   but a real lead for OTHER institutions.** `api.europeana.eu`'s REST Search API
   (`record/v2/search.json`, public demo key `wskey=api2demo` works for testing) is
   live and genuinely indexes British Museum content, but confirmed thin:
   `DATA_PROVIDER:"British Museum"` returns exactly **2 records** (old William Blake
   prints, images on Dropbox links, a one-off contribution rather than an ongoing
   feed) — not worth building an adapter for. **Rijksmuseum, by contrast, is strong**:
   `Rembrandt AND DATA_PROVIDER:"Rijksmuseum"` returns **6,248 results** under
   **Public Domain Mark 1.0** (more permissive than BM's CC BY-NC-SA, matching Met/
   Tate's existing CC0-equivalent status here) — the strongest concrete next-source
   candidate if BM's pilot-scale limits are ever revisited, and it would double as
   coverage for the world's largest Rembrandt print collection. Full findings/query
   syntax in the `reference_europeana_api` memory — re-run the same
   `DATA_PROVIDER`-filtered live check (not a keyword search, which wildly overcounts
   with other institutions' records that merely reference the one you're checking)
   before building anything against it, and compare against going directly to
   `data.rijksmuseum.nl` (Rijksmuseum's own open-data API) rather than assuming
   Europeana's copy is the better route.
6. **ResearchSpace revisited (2026-09-06) — the general BM endpoint is confirmed dead,
   but a narrower live instance was found that's directly relevant to the ukiyo-e
   specialist config.** ResearchSpace no longer hosts one monolithic BM-collection
   SPARQL endpoint; `public.researchspace.org` (the old general demo) returns HTTP 503
   with a self-signed TLS cert — genuinely abandoned, not transient. But ResearchSpace
   now hosts several narrower project-specific instances, and **one is live and
   directly usable**: `https://latehokusai.researchspace.org/sparql` — a real SPARQL
   1.1 endpoint, **not behind Cloudflare** (plain `curl`/`requests` work, no browser
   workaround needed, unlike everything else BM-related in this doc). 14,320 typed
   entities fusing BM + Met + other institutions' late Hokusai holdings: 834
   `impression` (≈ our `Impression`), 1,550 `printdesign` (≈ `ConceptualWork`), 724
   `woodenprintingblocks` (finer than this graph's own `Matrix` node currently models),
   plus paintings/books/bookvolumes. Hokusai's own actor node carries
   `wikidata.org/wiki/Q5586` directly (live-verified) — genuine PRE-LINKED_AUTHORITY
   data mapping straight onto `Artist.wikidataUrl`, zero name-resolution guesswork
   needed, unlike every other ukiyo-e-adjacent source in this graph so far. Real
   structured fields confirmed on a live sample: dimensions in both inches and cm,
   materials, technique strings, full production/design event chain with place+date.
   BM-originated images serve through a working IIIF Image API v2 endpoint (confirmed
   `info.json`, 5538×3926px, no auth); Met-originated images link to their own CDN
   instead. **Not yet adopted — two things need checking before it is:** (1) no
   explicit rights/licence statement found in the static page (likely client-rendered;
   needs an in-browser check, unlike BM's own site and Europeana where rights were
   confirmed directly), (2) the raw-TIFF host `images.researchspace.org` returned 503
   (degraded/down) even though the IIIF proxy works — don't assume both image paths are
   equally reliable. Full findings in the `reference_researchspace_hokusai` memory.
   This is a materially stronger candidate than the general BM pilot (§7) specifically
   for ukiyo-e coverage, precisely because it doesn't need the Cloudflare workaround at
   all.
