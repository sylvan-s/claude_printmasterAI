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

## Next steps

1. Migrate the 3 miscategorized Met tags (Abstraction, Landscapes, Christmas) from
   `Subject` to the new `Genre` node type in the live graph.
2. Once a fourth source is ingested, check whether this doc's taxonomy still holds
   without modification — that's the real test of whether it's a reusable framework
   or just a description of three sources.
