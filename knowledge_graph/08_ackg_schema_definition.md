# ACKG Schema Definition v1
## Node/edge model for the Art Context Knowledge Graph — property-graph implementation
**Doc 08 of the Artwork Classifier Analysis series. Companion to VEA-1.0 (doc 01), ATA-1.0 (doc 02), the Linked Art research note (doc 06), and the ACKG design proposal (doc 07).**

---

## Purpose and scope

Doc 07 proposed the Art Context Knowledge Graph (ACKG) as the evidence source behind
`query_ackg(technique, period, paper, region, subject, ...)` — an external, queryable
alternative to ATA's hardcoded tradition/period lookup tables — and named "define the ACKG
schema and a minimal seed dataset" as its step 2. This doc is that schema: the concrete node
and edge types, worked against real records rather than designed in the abstract.

Per doc 06's Neo4j recommendation (§ Implementation Approaches), this is a **property graph**,
not an RDF triplestore: CIDOC-CRM/Linked Art classes are flattened into typed node labels and
edges, with AAT/ULAN/Wikidata URIs kept as node properties for interoperability rather than as
the primary query structure. AAT/ULAN IDs are never emitted by an LLM at inference time — per
doc 06's recommendation (b), they are resolved through a deterministic, human-verified crosswalk
table applied downstream of VEA/ATA.

The model below was developed interactively against real cases: a V&A institutional record and
two lots from Roseberys sale A0777 (the Agathe Sorel and Gabor Sitkey Print Collection),
cross-checked against the Rembrandt and ukiyo-e specialist configs (doc 04). It is scoped to
what those cases actually needed — several plausible extensions (watermark, provenance/custody
chain) were considered and explicitly deferred; see § 5.

---

## 1. Design principles

These recurred often enough while building the model that they should be stated once, up front,
rather than re-derived at every node:

1. **Computed, not stored.** Support counts (`query_ackg`'s ranking signal) and posthumous/
   lifespan-plausibility checks are comparisons/aggregations run at query time over existing
   graph data, never precomputed fields — nothing to keep in sync as the graph grows.
2. **Attribution qualifiers are a correctness trap, not a detail.** "After X" means *not by X*.
   Qualified attributions (`circle_of`, `after`, `manner_of`, `school_of`, `attributed_to`,
   `studio_of`, `follower_of`) are real edges with a `qualifier` property, but only `direct`
   (and arguably `attributed_to`) count toward an artist's own support count — weaker
   qualifiers roll up to `Movement` instead. `studio_of`/`follower_of` were added directly
   from Roseberys' own catalogue vocabulary (`artist_qualifier`: certain/attributed/circle/
   studio/follower/after) rather than force-fitting them into the nearest existing value —
   "studio of" and "follower of" are established, distinct art-market terms, not synonyms
   for `school_of`/`manner_of`.
3. **Attach at whatever level the source actually documents — never stub a placeholder node.**
   `EditionRun` and `CatalogueEntry` can both attach to `ConceptualWork`, `Matrix`, or `State`
   depending on what a given source records. A 20th-century multiple with no recorded plate/state
   data (the common case — see § 4) attaches `EditionRun` straight to `ConceptualWork`, rather
   than inventing an "unknown Matrix" node to keep a rigid chain intact.
4. **Multiple authorities can each number the same work differently.** An established artist can
   have more than one catalogue raisonné (Rembrandt: White & Boon 1969 vs. Hinterding's New
   Hollstein 2013; Trevelyan: Turner 1998), each with its own numbering system and sometimes its
   own recorded medium/dimensions for the same work. This is a many-to-many relationship, not a
   single "catalogue number" field.
5. **Never collapse an approximate date into a bare integer.** See § 3.
6. **AAT/ULAN IDs are trusted only when live-verified, never from model memory.** Confirmed
   directly in this project: two AAT IDs given by an external LLM-generated research note were
   spot-checked against vocab.getty.edu before being trusted, and one didn't resolve to any
   concept at all while the other resolved to a different, related-but-distinct term than
   claimed (see Appendix A). This is exactly the hallucination risk doc 06 §4 predicted.
7a. **Artist identity is keyed by authority URI, not by name string — `name` is a
   property, never the merge key.** `MERGE (a:Artist {name: ...})`, used until this
   revision, means the same real person under different name forms across sources
   ("Liz Frink" / "Elisabeth Frink" / "Dame Elizabeth Frink RA") creates separate
   nodes, fragmenting `query_ackg`'s support counts across duplicates of one artist —
   exactly backwards, since well-documented artists with long careers or honorific
   accumulation are the ones most likely to appear under multiple forms. The merge key
   is now `ulanUrl`, falling back to `wikidataUrl`, falling back to `name` only when
   neither authority ID is known. Every known name form is kept in `alternateNames`,
   not discarded. Honorifics/post-nominals ("Dame," "RA," "CH," "DBE") must be
   stripped before any name-based lookup — they are titles, not name content.
   Confirmed live (`resolve_artist_identity.py`): this reconciliation is not fully
   automatable. ULAN's own variant list didn't include "Liz Frink"; a bare surname
   search returned two unrelated people sharing "Boussidan"; and two of five test
   artists (David Ferry, Madame Hassia) had no ULAN presence at all, where a naive
   Wikipedia fallback returned an unrelated poet and, separately, a Greek mountain
   range for a bare-name match — a wrong confident match, which is worse than an
   honest "unresolved." `identityConfidence` records which situation applies:
   `institutional` (the source itself supplied the authority ID, e.g. Met),
   `cross_verified` (independently confirmed against a second authority, e.g.
   Trevelyan against both ULAN and Wikidata), `single_source` (one authority match,
   not independently cross-checked), or `unresolved` (name-only, no authority ID —
   a legitimate, honestly-recorded end state, not a defect to hide).

7. **One evidence-record shape covers every source of a claim, published or not.** An auction
   listing, a museum accession record, a dealer/marketplace listing (Artsy, a gallery site), and
   an appraiser's own direct-inspection note are all structurally the same thing: one record,
   about one specific work, from one named source, carrying a reliability signal. They differ by
   a `sourceType`/`reliabilityTier` property, not by node type — see `SourceRecord`, § 2. Adding a
   new discrete node type every time a new kind of source shows up doesn't scale; this is also
   where doc 07 §2.2's "Stream C: Appraiser direct input" (with its `hypothesis` vs
   `documented_fact` status flag) actually lives in the graph — it was designed in doc 07 but had
   no node until this revision.
8. **A photograph of an object is not the same relationship as what the object depicts.** An
   image showing an `Impression` (`SHOWS`) and that impression's subject matter (`DEPICTS`,
   Impression → `Subject`) are different edges for a reason — CRM keeps them distinct too
   (`P138 represents` vs `P62 depicts`). Collapsing both into one relationship would make "what
   does this image show" and "what is this print a picture of" indistinguishable.

---

## 2. Node types

| Node | Layer | Key properties |
|---|---|---|
| `Artist` | Identity | `dateBorn`, `dateDied` (fuzzy date shape, § 3), `ulanUrl`/`wikidataUrl` (identity key — see below), `alternateNames`, `identityConfidence`, `nationality` |
| `Movement` | Identity | name, period |
| `Publisher` | Identity | name — covers original publishers, print workshops, *and* historical restrike/estate publishers (Basan, Mariette) under one type |
| `ConceptualWork` | Work | `dateCreated` (fuzzy date shape) |
| `Matrix` | Work | material (copper/zinc/stone/block) |
| `State` | Work | `traditionType` — tradition-agnostic: covers both Western plate-states and ukiyo-e printing generations |
| `EditionRun` | Work | `declaredSize`, `dateRange` (fuzzy date shape) |
| `Impression` | Instance | `editionNumber`, `copyType` (numbered / AP / HC / PP / BAT / TP — local enum, no AAT equivalent per doc 06 §2.6), sheet/image dimensions, `signed` (bool), `provenanceNote` (free text, deferred — § 5) |
| `Technique` | Controlled vocab | AAT URI |
| `Paper` | Controlled vocab | AAT URI, `watermarkNote` (free text, deferred — § 5) |
| `ConditionType` | Controlled vocab | AAT URI |
| `Subject` | Controlled vocab | AAT/Iconclass URI |
| `SourceRecord` | Evidence | `sourceType` (auction \| institutional \| dealer_listing \| online_marketplace \| specialist_opinion \| direct_inspection), `reliabilityTier`, plus type-specific fields: `saleId`/`lotNumber`/`saleDate`/`estimateLow`/`estimateHigh`/`reserve`/`hammerPrice`/`hammerBasis` (reported \| derived)/`premiumRatioUsed`/`priceRealised`/`priceCurrency`/`sold`/`listingUrl`/`auctionInternalId` (auction), `institutionName`/`accessionNumber` (institutional), `listingUrl` (dealer_listing/online_marketplace), `author`/`statusFlag: hypothesis\|documented_fact`/`basis` (specialist_opinion/direct_inspection) |
| `CatalogueRaisonne` | Evidence | title, author(s), year, numbering-system prefix |
| `CatalogueEntry` | Evidence | `number`, `recordedMedium`, `recordedDimensions`, `describedStates` |
| `DigitalImage` | Media | `sourceUrl`, `imageType` (primary \| signature \| verso \| detail \| catalogue_plate \| listing_photo), `license` |

`SourceRecord` and `CatalogueRaisonne` are the evidence layers doc 07 §2.3 needs kept distinct
for provenance-weighted trust — `sourceType` and `reliabilityTier` carry that weighting for
`SourceRecord`, while `CatalogueRaisonne` stands apart as its own type because of its two-tier
publication/entry shape (§ 3) and is generally the most authoritative source when present.
`statusFlag` only applies to the two appraiser-originated `sourceType`s (`specialist_opinion`,
`direct_inspection`) — it's how doc 07's "a hypothesis must not outrank contradicting physical
evidence" rule gets enforced structurally rather than left to prompt instructions. `author` on
those two types is a plain string for v1, not a link to a `Person` node — no other part of the
schema currently needs a generic person entity distinct from `Artist`, so this avoids adding a
node type to hold one field.

---

## 3. Edge types

```
Artist -[:CREATED]-> ConceptualWork
Artist -[:MADE_MATRIX]-> Matrix
ConceptualWork -[:REALIZED_AS]-> Matrix
Matrix -[:HAS_STATE]-> State

State -[:PRINTED_AS]-> EditionRun            (or Matrix/ConceptualWork directly — principle 3)
EditionRun -[:PUBLISHED_BY]-> Publisher
EditionRun -[:PRINTED_BY]-> Publisher        (distinct role, added for Roseberys bulk data — printer pulls the impression, publisher commissions/sells it; both can be present and different)
EditionRun -[:INCLUDES]-> Impression

Impression -[:USES_TECHNIQUE]-> Technique     (multi-valued — see § 4)
Impression -[:PRINTED_ON]-> Paper
Impression -[:HAS_CONDITION]-> ConditionType
Impression -[:DEPICTS {count, confidence}]-> Subject          (multi-valued)
Impression -[:CLASSIFIED_AS {confidence}]-> Genre              (multi-valued, added post-hoc — see doc 09)

Artist -[:ASSOCIATED_WITH]-> Movement

SourceRecord -[:DOCUMENTS]-> ConceptualWork | Matrix | Impression
SourceRecord -[:ATTRIBUTED_TO {qualifier: direct|attributed_to|circle_of|after|manner_of|school_of|studio_of|follower_of}]-> Artist

CatalogueRaisonne -[:CONTAINS]-> CatalogueEntry
CatalogueEntry -[:DOCUMENTS]-> ConceptualWork | Matrix | State

DigitalImage -[:SHOWS]-> Impression | ConceptualWork | CatalogueEntry
```

`SourceRecord -[:DOCUMENTS]->` replaces what was previously two separate edges
(`Impression -[:SOLD_AT]-> AuctionRecord` and `InstitutionalRecord -[:DOCUMENTS]->`) — a sale is
now just a `SourceRecord` with `sourceType: auction` and its `saleDate`/`lotNumber`/
`priceRealised` properties populated, rather than needing its own edge verb.

---

## 3.1 Date shape (applies to every date property above)

Not a node or edge — a property convention, applied uniformly to `Artist.dateBorn/dateDied`,
`ConceptualWork.dateCreated`, and `EditionRun.dateRange`, rather than solved per-field:

```
{ year, endYear?, precision: "exact" | "circa" | "range" | "before" | "after", displayLabel }
```

- `displayLabel` preserves the source's own wording verbatim ("c.1970", "1927-30") — the same
  observe-don't-fabricate discipline VEA already follows for other fields.
- `precision` distinguishes **fuzziness about one point** (`circa 1970` → `year:1970,
  precision:circa`) from **a genuine multi-year span** (a plate worked on 1927-30 →
  `year:1927, endYear:1930, precision:range`) — collapsing both into a bare integer loses real
  information.
- Consistency and posthumous checks (§1, principle 1) must compare against the **outer bound**,
  not the point value — `circa 1970` should widen tolerance against an artist's death year, not
  tighten it.
- This is deliberately lighter than CIDOC-CRM's `E52 Time-Span` (which uses a four-value
  inner/outer bound interval algebra) — full interval algebra is more machinery than this schema
  needs, consistent with Linked Art's own "90% of use cases, 10% of the complexity" design
  principle (doc 06 §1).

Full CRM interval algebra was considered and rejected for the same reason several other
extensions were deferred — see § 5.

---

## 4. Worked examples

### 4.1 V&A CIRC.252-1958 — the graceful-degradation case

A Trevelyan print, 1958, untitled/descriptive record only: "print in red depicting a farmer
ploughing the field with two oxen," etching and aquatint (colour), numbered 9/50, image
380×518mm, sheet 500×626mm, no publisher stated.

```
Artist(Julian Trevelyan) -[:CREATED]-> ConceptualWork("Farmer ploughing with oxen", {year:1958, precision:exact})
ConceptualWork -[:PRINTED_AS]-> EditionRun {declaredSize:50, dateRange:{year:1958}}
EditionRun -[:INCLUDES]-> Impression {editionNumber:9, sheet:"500x626mm", image:"380x518mm"}
Impression -[:USES_TECHNIQUE]-> Technique(Etching)
Impression -[:USES_TECHNIQUE]-> Technique(Aquatint)
Impression -[:DEPICTS]-> Subject(Farmer/agricultural labour)
Impression -[:DEPICTS]-> Subject(Oxen)
SourceRecord {sourceType:institutional, institutionName:"V&A", accessionNumber:"CIRC.252-1958"} -[:DOCUMENTS]-> Impression
DigitalImage {sourceUrl:"collections.vam.ac.uk/item/O1036700/...", imageType:primary} -[:SHOWS]-> Impression
```

Confirms three things: `Matrix`/`State` go entirely unpopulated here — normal for a 20th-century
multiple, since no source records which physical plate or what state it came from —
`USES_TECHNIQUE` is naturally multi-valued (a graph edge per technique, not a single field),
which matters for later matching logic since combined techniques (here, etching *and* aquatint
on one plate) are the norm, not the exception, for Atelier 17-trained printmakers — and this
record actually has a usable `DigitalImage`: the V&A collection page serves an image directly
against this accession number, so `sourceUrl` isn't hypothetical here, it's the real page fetched
to build this example.

### 4.2 Roseberys A0777 Lot 42 vs. Lot 43 — the entity-resolution warning

Two Trevelyan lots in the same sale, both etching-and-aquatint, both from an edition of 50-ish,
both featuring rural/architectural subjects:

| | Lot 42 | Lot 43 |
|---|---|---|
| Title | "Tower & Oxen" | "Windsor Castle" |
| Date | 1961 | 1969 |
| Edition | A/P aside from edition of 50 | Signed proof aside from edition of 75 |
| Sheet | 800×580mm | plate 350×465mm |
| Publisher/printer | — | Printed by Agathe Sorel |

And separately, Lot 42 against the V&A print (§4.1) — same artist, same combined technique,
same declared edition size (50), both featuring oxen, but a 3-year date gap and a sheet-size
difference too large to be trimming variance. All three are distinct `ConceptualWork`s.

**The finding:** matching on artist + medium + subject keyword ("oxen") alone would have wrongly
merged the V&A print and Lot 42. The actual distinguishing signal was dimensions and date, not
subject. Any ingestion/entity-resolution logic built on this graph needs to weight identifying
properties (title, date, dimensions) above shared subject matter — subject overlap between two
works by a prolific travel-suite printmaker is expected, not evidence of identity.

Lot 43 also gives a concrete instance of `EditionRun -[:PUBLISHED_BY]-> Publisher` where the
"publisher" is actually the printer of record (Agathe Sorel) rather than a commercial publishing
house — the node type doesn't need to distinguish printer/publisher/atelier roles for this to
work, since the edge just states who was responsible for that specific run.

---

## 5. Explicitly deferred for v1

Each of these was raised, reasoned about, and deliberately left out — not overlooked:

- **Watermark as its own node.** Real dating value for Old Master intaglio (Hinterding's
  Rembrandt catalogue uses watermark analysis directly) but low value for the Trevelyan seed
  case. Kept as a free-text `watermarkNote` property on `Paper` until a concrete query needs it
  structured.
- **Provenance/custody chain (`Collection`, Lugt marks).** Doc 06 flagged Lugt marks as needing
  a custom extension; doc 04 confirms provenance is a real valuation driver ("major historical
  collection documentation: 15-30% premium"). Kept as a free-text `provenanceNote` property on
  `Impression` for v1 rather than a `Collection` node with dated custody edges — loses the
  "which other lots share this collection" query, acceptable for a first seed pass.
- **Period and Region as nodes.** Kept as properties (on `Impression`/`Artist`) rather than
  shared nodes — no identified cross-cutting query need yet, unlike `Subject`, which earned node
  status because it's genuinely shared/queryable vocabulary the same way `Technique`/`Paper` is.
- **Full CIDOC-CRM `E52 Time-Span` interval algebra.** See § 3.1.

None of these require a structural change to add later — `Watermark` and `Collection` would
slot in as new controlled-vocab/evidence nodes without disturbing anything above, following the
same pattern `EditionRun` and `CatalogueEntry` already established.

---

## Appendix A — AAT verification log

Two AAT IDs from an external (Gemini) research note were live-checked against vocab.getty.edu
before being trusted, per principle 6:

| Claimed | Claimed as | Actual |
|---|---|---|
| `300041348` | aquatint | **Does not resolve to any AAT concept.** Real ID for "aquatint (printing process)" is `300053242`. |
| `300053225` | intaglio printing | Resolves, but to **"engraving (printing process)"** — a related but distinct term, not the umbrella category claimed. |

Combined with doc 06's own verified IDs (etching `300053241`, foxing `300078853`), this is the
starting fragment of the deterministic crosswalk table doc 06 §4 recommends building — each
entry manually verified once against a live fetch, then reused without re-verification.

---

## 6. Implementation notes from the first live load

Doc 08's schema was loaded into a real AuraDB Free instance (see
`AURA_DB_CREDENTIALS.md`) with the two worked examples from § 4 plus Lot 43, seeding
22 nodes / 31 relationships. Two things only became visible at that point, not from
reasoning about the schema on paper:

- **The § 3.1 date shape must be flattened — Neo4j property values can't be nested
  objects.** `{year, endYear, precision, displayLabel}` isn't storable as one property
  value; each field becomes a separate flat property instead
  (`dateCreated_year`, `dateCreated_precision`, `dateCreated_displayLabel`, etc.). The
  conceptual shape in § 3.1 is still the right mental model — this is a physical
  storage detail, not a schema change — but any future write against this graph needs
  to know the convention is "flatten with an underscore," not "store the object."
- **`mcp-neo4j-cypher`'s write tool rejects DDL.** `CREATE CONSTRAINT` statements
  fail against the tool with "Only write queries are allowed for write-query" — the
  server appears to classify by query shape and only permits plain data-write
  clauses. Schema-level statements (constraints, indexes) need a direct driver
  connection instead; data writes (`MERGE`/`SET`) work fine through the MCP tool.

- **Met Open Access pilot (38 objects: Lichtenstein, Motherwell) confirms the schema
  scales to institutional bulk data, with two things worth knowing before a full load.**
  `Classification` (not `Department`) is the correct print filter — a "Drawings and
  Prints"-department object turned up classified "Books," and a "Prints"-classified
  object turned up in the Photographs department. Artist `ULAN`/`Wikidata` URIs arrive
  pre-populated on ~65% of 20th-century-born print records — real institutional
  reconciliation, not guessed. But `Medium` is unstructured free text far messier than
  VEA's controlled enum ("Iridescent silver Mylar collage on opaque black Rowlux...
  mounted on composition board") — keyword-matching against a small technique/paper
  vocabulary got a plausible read on all 38 records in the pilot, correctly leaving
  decorative substrates (Rowlux, rag board) unmatched as `Paper` rather than
  misclassifying them, but this is heuristic extraction, not a verified crosswalk.
  `Impression.rawMedium` preserves the original string on every record regardless, so
  nothing is lost where structured extraction falls short. Separately: `primaryImage`
  was empty on all 38 pilot records (none are public domain) — expect near-zero
  `DigitalImage` coverage from this source for 20th-century artists specifically.

## 7. Schema addition: `DigitalImage.embedding`

Added 2026-08-25 for the DINOv2 visual-similarity proof-of-concept (see doc 09's Roseberys
section for the WAF/URL-rewrite finding that made this viable at all). Four new flat
properties on the existing `DigitalImage` type, no new node/edge type needed:

```
DigitalImage {
  ...,
  embedding: LIST<FLOAT>,     -- CLS-token pooled output, model-dependent length
  embeddingModel: STRING,     -- e.g. "facebook/dinov2-small" — always record which
  embeddingDim: INTEGER,      -- redundant with size(embedding) but cheap to filter on
  embeddedAt: STRING          -- ISO date, so a future re-embed (bigger model, fine-
                              -- tuned variant) can target only stale/missing vectors
}
```

Scope: **Roseberys and Forum Auctions only.** Tate has zero working images (dead URLs,
nodes pruned — doc 09 §4.2) and Met has zero `DigitalImage` nodes at all (never fetched —
`met_ingest.py`'s own header comment). Storing this costs no node/relationship budget
(AuraDB Free's 200k/400k limits count nodes and relationships, not property size) — at
384 dims × 8-byte Neo4j floats, the full ~20,291-image set costs roughly 61MB, which is
noise against what a 190k-node graph already stores.

Explicitly **not** an attribution signal by itself — DINOv2 is a general-purpose visual-
similarity model (composition/palette/texture), not trained to distinguish artists' hands.
Confirmed empirically in the POC: the top cosine-similarity match across a 20-image sample
was two different artists sharing a visual style, not a same-artist pair. Treat `embedding`
as one corroborating evidence type for Stage 2a's fusion logic (doc 07 §2.3's "never
averaged away" rule) alongside the graph's existing text/provenance evidence, not a
standalone artist classifier — a real attribution-specific signal would need calibration
against known-artist pairs, not just a bigger off-the-shelf checkpoint.

## 8. Schema addition: `Period` and `Region` nodes

Added 2026-08-26 for the ADR-0009 (`docs/adr/0009-graph-analytics-precomputed-confidence.md`)
similarity-index prototype (`knowledge_graph/gds_prototype.py`). This directly reverses § 5's
"Period and Region as nodes" deferral — that deferral was explicitly conditioned on "no
identified cross-cutting query need yet," and the similarity prototype is exactly that need:
node-similarity/FastRP require graph *neighbours* to compare artists by, and a bare property
can't be a shared neighbour two different artists both point to. Confirmed the alternative
doesn't work before reaching for this: `apoc.create.vNode({bucket: 1970})` called three times
in the same session returned three different internal ids, so a virtual-node workaround would
give every artist a *private* period node sharing nothing — no tie-breaking signal at all.

```
Period { decade: INTEGER, label: STRING }     -- e.g. {decade: 1970, label: "1970s"}
Region { name: STRING }                        -- e.g. {name: "British"}

ConceptualWork -[:DATED_TO]-> Period
Artist -[:FROM_REGION]-> Region                -- multi-valued, see below
```

Built by `add_period_region_nodes.py`, idempotent (`MERGE` on both node and edge), run once
against the live graph: **52 `Period` nodes / 35,485 `DATED_TO` edges**, **134 `Region` nodes /
3,354 `FROM_REGION` edges**. Against the pre-run budget of 190,225/200,000 nodes and
292,939/400,000 relationships, this is a small, deliberate write, not a rounding error to wave
away — flagged and confirmed against headroom before running, not assumed safe.

`Period` binning is `floor(dateCreated_year / 10) * 10`; `dateCreated_year == 0` (21 records —
a placeholder for "unknown," never a real year, same pattern as other "don't fabricate a value"
rules throughout this doc) is excluded rather than binned into a bogus "0s" decade.

`Region` needed real cleanup, not a direct `MERGE` on `Artist.nationality` — that property is
unstructured free text, not a controlled vocabulary (unlike `Technique`/`Paper`/`Subject`,
which are). A live query against this project's actual data returned 211 distinct raw values,
including plain typos (`AMerican`, `Britsh`, `Brtitish`, `Japanse`, `Ukranian`), compound
dual-nationality strings (`American/British`, `American, born Australia`, `Swiss, born
France`), and at least one outright data-entry error (`Bristol` — a UK city, not a nationality,
excluded outright). `add_period_region_nodes.py` splits each raw value on `/`, `,`, and the
literal `" born "` marker, applies a small explicit typo-correction map for the misspellings
actually observed, and drops the one confirmed-junk value — collapsing 211 raw strings to 134
real `Region` names. Compound values become **multiple** `FROM_REGION` edges (a genuinely
dual-nationality artist keeps both), the same multi-valued pattern `USES_TECHNIQUE` already
established, not a forced pick-one. Nothing else is silently dropped: an unrecognized fragment
still becomes its own `Region` node — this is a documented judgment call, not a verified
crosswalk in the § 1 principle-6 sense, since nationality has no equivalent live-checkable
authority list the way AAT does for technique/paper terms.

## Next steps

Per doc 07 §5's roadmap, this doc completes step 2 ("define the ACKG schema and a minimal seed
dataset" — schema half done; seed dataset is the remaining half of that step). Suggested
immediate next actions:

1. Seed seven or so real `ConceptualWork`/`Impression` records from this doc's worked examples
   (§4.1, §4.2) plus a small Rembrandt/ukiyo-e slice, to get a graph with actual traversable data
   before building the `query_ackg` tool against it (doc 07 step 3).
2. Source Turner's actual 1998 catalogue number for lots 42/43 to populate a live
   `CatalogueEntry` — currently only reasoned about, not yet instantiated with a real value.
3. ~~Build out the AAT crosswalk table~~ **Done for the core technique vocabulary** —
   see [`aat_crosswalk.json`](aat_crosswalk.json): 13 of 14 `printingTechniques` entries
   verified (Giclée has no AAT process-level concept, recorded as unmapped rather than
   forced), plus `wove`/`laid` paper and `Foxing`. `Technique`/`Paper`/`ConditionType`
   nodes created going forward should carry the verified `aatId` from that file as a
   property — not yet wired into `met_ingest.py`'s `Technique`/`Paper` creation, which
   still creates bare-name nodes with no AAT URI attached. Remaining gaps: `japanese`,
   `BFK`, `chine-collé`, `card`, `fabric` paper types, and most condition defects beyond
   Foxing, are still unverified. `vellum` was checked and found genuinely ambiguous in
   AAT itself (splits into parchment vs. paper concepts) — not a verification gap, a
   real disambiguation problem needing a rule, not a lookup.
4. Populate real `SourceRecord{sourceType: dealer_listing}` and `DigitalImage` nodes from the
   dealer/marketplace pages already surfaced while researching this doc (modernprints.co.uk,
   Goldmark) and from the Roseberys lot photos themselves, to check the consolidated
   `SourceRecord` shape against a `sourceType` this doc reasoned about but hasn't yet populated
   with a real record.
