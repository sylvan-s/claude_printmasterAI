# Picasso museum collections as an ACKG source — survey and adapter design

**Date:** 2026-09-11
**Status:** Research findings + doc 09 §6 onboarding answers. No data loaded.
**Prompted by:** "Is there an official Picasso museum, and can we scrape catalogue data from it?"

---

## Summary

There are four. Only one is worth building an adapter against, and it turns out to be the
best-structured institutional print source this project has found so far — better than the
British Museum, and reachable through a documented JSON API rather than a browser-driven
cache.

| Museum | Holdings online | Access | Verdict |
|---|---|---|---|
| **Musée national Picasso-Paris** | 23,638 records, 21,002 with images; **2,223 prints** | Documented REST/JSON API (Navigart 3, vault `16`) | **Build the adapter** |
| Museu Picasso, Barcelona | ~4,251 works | Drupal + Solr HTML only, ~11–22 works/page, no catalogue-raisonné field found | Deferred — slow crawl, weaker records |
| Museo Picasso Málaga | 233 works | JS-rendered selection page | Not worth it |
| Kunstmuseum Pablo Picasso Münster | ~800 prints (world's largest Picasso lithograph holding) | **No object database at all** — editorial pages only | Nothing to ingest |

Münster is the frustrating one: on paper it is the single most relevant collection in the
world to this project, and it publishes no machine-readable catalogue whatsoever.

---

## 1. Access method and entity identity (doc 09 §6, q1)

`https://api.navigart.fr/16/artworks` — Navigart 3, the Videomuseum platform that also
serves several other French national collections. It is the same API the museum's own
public site consumes, unauthenticated, and **documented** at
`api.navigart.fr/getting_started.html` (the docs pages are `Disallow:`-ed in that host's
robots.txt, which is why they don't surface in search; the API itself is not).

Verified live, 2026-09-11:

- `?size=N&from=M` pagination; `size=200` accepted, deep paging to `from=23000` works.
- `?filters=tree_domain_all:Estampe` → `filteredCount: 2223`. Multiple filters join with `,,`.
- `totalCount: 23638`, `withimage` facet `21002`.
- Images: `https://images.navigart.fr/{px}/{file_name}`, where `{px}` is a number.
  `1000` returns a ~250KB JPEG; `2000` returns HTTP 415. 1000px on the long edge is the ceiling.

**Identity.** `artwork._id` is a stable 18-digit internal id (`160000000002742`), and
`inventory` carries the museum's own accession number (`MP2820`). Unlike Met's Object IDs
(doc 09 §4, which 404 against the live API even from a recent CSV), both look stable —
but that is an observation from one session, not something proven over time. The adapter
keys on `inventory` because it is the citable, human-checkable identifier; `_id` is kept
as a secondary property so a future re-fetch can go straight back to the record.

**Rate.** 23 requests at `size=100` pulls the entire print catalogue in well under a
minute. This is a genuinely bulk-capable source — the opposite of the BM's situation
(doc 09 §7), where the Cloudflare wall forced a hand-driven browser cache.

---

## 2. Why this source matters: what the records actually carry

Profiled across all 2,223 print records (full cache pulled and analysed, not sampled):

| Field | Coverage | What it is |
|---|---|---|
| `dimensions` | 99.7% | Two lines — sheet, then `(hors marge)` = plate/image. **1,745 records carry both.** |
| `inventory` | 99.6% | `MP####` accession |
| `mst` | 99.5% | Technique + support + printer, free text, French |
| `date_creation` | 99.6% | Often day-precise (`15 août 1937`) |
| `medias` | 95.3% | Image(s) with pixel dimensions and per-image copyright |
| `old_owners` | 85.6% | Provenance |
| **`number_catalogue`** | **79.1%** | **Catalogue raisonné citation** |
| `expositions` | 76.0% | Full exhibition history |
| `bibliography` | 49.7% | Literature |
| `inscriptions` | 44.4% | Signatures, annotations |
| `collaborators` | 38.5% | `Imprimeur : Atelier Lacourière et Frélaut, Paris (France)` |
| `tirage` | 25.4% | State + paper + edition fraction + printing notes |

Three things here have no equivalent in any source already in the graph:

**(a) 187 records are `Estampe, Matrice` — the actual plates.** Picasso's own coppers
(151), zinc (26), wood (3), linoleum, stone, celluloid. Doc 08 defines a `Matrix` node
with a `material` property; almost nothing in the graph populates it. `bm_ingest.py`
already has the routing for this (`LOAD_QUERY_MATRIX`, added for Trevelyan's cancelled
zinc plate) — here it is 187 records rather than 2, from the collection that holds the
artist's studio estate.

**(b) 1,027 records carry an explicit state marker.** `IIème état`, `Second état`,
`7ème état`, `IXème état`. Doc 08's `State` node has been essentially theoretical until
now. Auction data gives state only when the cataloguer bothered; this gives it for 46%
of the collection, from the institution that holds the plates the states were pulled from.

**(c) Printer attribution at scale.** Fort (1,218 mentions), Lacourière (509),
Mourlot (186), Crommelynck (153), Delâtre (44), plus Vollard (121) as publisher.
`EditionRun -[:PRINTED_BY]-> Publisher` was added for Roseberys and is thinly populated;
this fills it for the canonical Picasso print workshops.

---

## 3. The catalogue-raisonné finding

1,759 of 2,223 print records (79.1%) cite a catalogue raisonné. The prefixes:

```
Geiser-Baer   1143      Mourlot   182      CZW   5
Baer           355      + 63 multi-reference records
```

### 3.1 "Geiser-Baer" and "Baer" are the same numbering system

This matters because the graph already holds 198 `Baer` entries from auction data, and
if the two prefixes were treated as separate catalogues, 1,143 of Paris's 1,498 intaglio
citations would never join to any of them.

Checked rather than assumed. Both prefixes are used across overlapping number ranges
(Geiser-Baer 2–2014, Baer 141–2021) and **15 numbers are cited under both prefixes within
this one source**. For 14 of those 15, the records under each prefix share an identical
title and an identical creation date:

```
  #647   Baer        ×11 impressions  "Femme au fauteuil et au chapeau"  mars 1939
         Geiser-Baer ×30 impressions  "Femme au fauteuil et au chapeau"  mars 1939
  #651   Baer        ×37 impressions  "Tête de femme n°3. Portrait de Dora Maar"  1939
         Geiser-Baer ×1  impression   "Tête de femme n°3. Portrait de Dora Maar"  1939
```

These are impressions of one work, catalogued inconsistently by the museum itself.
Geiser catalogued Picasso's engraved work to 1931 and Baer continued the same sequence,
so the joint and short citations are two spellings of one numbering system.

**The one exception is real and must be excluded by hand.** `Baer 141` and
`Geiser-Baer 141` are different works:

```
  MP2115  Geiser-Baer 141  "La Pique"     7 juin 1929     Eau-forte sur cuivre, tirée par Fort
  MP3414  Baer 141         "La Colombe"   9 janvier 1949  Lavis sur zinc, tirée par Mourlot
```

MP3414 is a lithograph — zinc, wash, printed by Mourlot — and so cannot be in the
Geiser-Baer intaglio sequence at all. `Mourlot 141` already exists in the graph. This is
almost certainly a museum data-entry error where a Mourlot number was given a Baer
prefix. It is one record in 1,498; it gets a named exclusion in the adapter, not a
silent pass.

The adapter therefore normalizes the prefix `Geiser-Baer` → `Baer` via an explicit
two-entry alias map with MP3414 excluded by inventory number. This is an exact-string
alias on a hand-verified pair, the same shape as `bm_ingest.py`'s
`PILOT_ARTIST_RESOLUTION` — **not** a similarity match, and nothing in
`catalogue_matching.py`'s no-fuzzy-matching rule is relaxed.

### 3.2 The join to existing data is small — and that is the point

Honest numbers, computed against the live graph:

- Paris cites **665 distinct** Geiser-Baer/Baer numbers across 1,498 print records.
- The graph currently holds **198** `Baer` entries (185 distinct base numbers).
- Exact `entryNumber` match: **43**. Base-number match: **58** (136 Paris impressions).

The join is small because the graph's Picasso intaglio coverage is small, not because
the sources disagree. The value is the other direction: this source roughly **3.6×**
the graph's distinct Geiser-Baer/Baer spine, and adds 182 Mourlot citations, each one
attached to a museum-grade record with an image behind it. Auction lots arriving later
citing "Baer 653" then land on an entry that already has a state, a printer, a paper, a
plate, and a reference photograph.

### 3.3 Two parsing problems, one of them already live in the graph

**Paris uses commas for multiple references**, not semicolons:
`"Geiser-Baer 35, Bloch 34"`, `"Geiser-Baer 10, Bloch 8, D.B.R., p.283 (L'Abreuvoir), P.i.F., 1194"`.
`catalogue_matching.parse_catalogue_refs` splits on `;` only, so its
"last token = entry number" regex would turn `"Geiser-Baer 35, Bloch 34"` into
`catalogueName="Geiser-Baer 35, Bloch"`, `entryNumber="34"` — a confident-looking
garbage prefix of exactly the kind `NON_CATALOGUE_NAMES` exists to catch.

**This failure is already in the live graph.** A query over existing
`CatalogueRaisonne` nodes returns, among others:

```
  "Bloch 182, Baer"    "Bloch 1152, Baer"    "Vollard 140, Cramer bk."
  "Bloch 233, Baer"    "974, Cramer bk."     "Bloch 1284, Baer 1050, Czwiklitzer"
```

— ~20 malformed prefixes from Forum/Roseberys/Bonhams rows that cited multiple
catalogues comma-separated. Each is 1–2 entries, so the blast radius is small, but they
are wrong and they will keep accruing.

**Logged, not swept.** Fixing `parse_catalogue_refs` to split on commas is a change to a
module four adapters share, and it would need a re-verified backfill of all three
auction sources before it could be trusted — that is its own task with its own
validation, not a side-effect of a new adapter. The Paris adapter handles its own 63
multi-ref records locally (splitting on `,` and ` et ` before delegating each fragment to
the shared parser) and takes only the first reference for identity-keying, which is what
`build_conceptual_work_id` does anyway.

Three more fragment-level failures surfaced in the first dry run and are fixed in the
adapter (§10):

- **Trailing parenthetical titles** — `"P.i.F., 1041 (Femme d'arlequin se coiffant)"`
  parsed as prefix `1041 (Femme d'arlequin se`, entry `coiffant)`.
- **Space-separated `bis`/`ter`** — `"Geiser-Baer 111 bis"` parsed as prefix
  `Geiser-Baer 111`, entry `bis`. The same convention appears glued elsewhere in this
  source (`Baer 211bis`) and parses correctly, so the fix glues it.
- **Volume-style citations** — `"Z. VI, 282"` is Zervos volume VI no. 282, and Zervos
  catalogues Picasso's *paintings and drawings*, not the prints. The comma split cannot
  recover a volume+number pair. Dropped by a structural rule (an entry number must start
  with a digit), not a name blocklist.

And one that is a corruption risk rather than a cosmetic one: **MP3053 cites
`"Baer 1523 à 1779"`** — a range covering *La Célestine*, a 66-plate suite. That is the
portfolio-level citation `catalogue_matching.py`'s docstring point 2 warns about and the
Chagall "Cramer 30" incident came from. Dropped outright rather than resolved to either
endpoint.

**One alias deliberately NOT made.** The source spells Czwiklitzer's Picasso-poster
catalogue both `CZW` (5 records) and `Czwiklitzer` (2). They are almost certainly the
same catalogue — but unlike Geiser-Baer/Baer there is no overlapping number anywhere in
the data to confirm it against (41/55/47/27/25 vs 50/4, disjoint). An alias asserted on
plausibility rather than evidence is what caused both prior corruption incidents. Left
as two nodes.

---

## 4. Field mapping (doc 09 §6, q2)

| Source field | → ACKG | Type |
|---|---|---|
| `inventory` | `SourceRecord.accessionNumber`, `Impression.id` stem | DIRECT |
| `title_list` | `ConceptualWork.name` | DIRECT |
| `authors_list` | `Artist` (via hand-resolved ULAN, §6) | PRE-LINKED_AUTHORITY (ours, not theirs) |
| `date_creation` | `dateCreated` fuzzy-date shape | STRUCTURED_TRANSFORM |
| `dimensions` | `sheetDimensions` + `plateDimensions` | STRUCTURED_TRANSFORM |
| `number_catalogue` | `CatalogueRaisonne` / `CatalogueEntry` | STRUCTURED_TRANSFORM |
| `domain_denomination` | `Impression` vs `Matrix` routing | STRUCTURED_TRANSFORM |
| `mst` | `Technique`, `Matrix.material`, printer | **SEMANTIC_SPLIT** (§5) |
| `tirage` | `State`, `Paper`, `EditionRun.declaredSize`, `Impression.editionNumber` | **SEMANTIC_SPLIT** (§5) |
| `collaborators` | `Publisher` via `PRINTED_BY` | STRUCTURED_TRANSFORM |
| `medias[]` | `DigitalImage` | DIRECT |
| `old_owners` | `Impression.provenanceNote` | DIRECT (HTML-stripped) |
| `inscriptions` | `Impression.signed` + note | HEURISTIC_EXTRACTION |
| `expositions`, `bibliography` | — | **UNMAPPED** (§7) |
| `ensemble_id`, `related`, `recap_*` | — | **UNMAPPED** (§7) |

---

## 5. The two SEMANTIC_SPLIT rules, stated explicitly (doc 09 §6, q3)

### 5.1 `mst` conflates technique, matrix material, and printer

`"Aquatinte, grattoir et pointe sèche sur quatre cuivres, IIème état ... Epreuve
définitive tirée par Lacourière"` is four different ACKG concepts in one string.

Rule, applied in this order:
1. **Printer** — everything after `tirée par` / `tiré par` → `Publisher` + `PRINTED_BY`.
   `tirée par l'artiste` (537 records) resolves to the artist, not a workshop.
2. **Matrix material** — only when `domain_denomination` is `Estampe, Matrice`; taken
   from the material nouns (`cuivre`/`zinc`/`pierre`/`bois`/`linoléum`/`celluloïd`).
   On an `Epreuve` record the same nouns describe the plate the impression came from,
   not the impression, and are **not** mapped to the impression.
3. **Technique** — the remainder, French-normalized (§5.3), then handed to the shared
   `crosswalk_matching.extract_techniques`.

### 5.2 `tirage` conflates state, paper, edition size, and printing history

`"7ème état, triangle du cou teinté à l'aquatinte, épreuve sur vergé de Montval sans
filigrane"` — and separately, bare fractions (`/3`, `1/30`, `1/2`) that are edition
numbering with no other text at all.

Rule:
1. A leading ordinal — Roman (`IIème`, `IXème`, `Vème`, `Ier`) **or** French word
   (`Second`, `Quatrième`, `Cinquième`, `Sixième`) — → `State.traditionType: "western_plate_state"`
   with the source's own wording preserved. Both forms occur; matching only Roman
   numerals would miss a large minority.
2. `sur <paper>` → `Paper` (§5.3).
3. A bare `N/M` or `/M` fraction → `Impression.editionNumber` / `EditionRun.declaredSize`.
4. `filigrane <X>` → watermark note (doc 08 defers `Paper.watermarkNote` as free text;
   carried, not parsed).
5. Everything else stays in `Impression.rawMedium`-adjacent free text rather than being
   force-fit.

### 5.3 French vocabulary — and one false friend

This is the project's **first non-English source**. `crosswalk_matching`'s keyword lists
are English (`etching`, `drypoint`, `aquatint`, `wove`, `laid`); Paris says `eau-forte`,
`pointe sèche`, `aquatinte`, `vélin`, `vergé`.

**Design choice:** the French terms are *not* added to `crosswalk_matching`'s shared
lists. That module's own docstring warns about "the two divergent lists problem", and
adding French to a vocabulary five adapters share would change matching behaviour for
all of them without re-running any of their loads. Instead the Paris adapter
pre-translates its French free text into the English terms the shared crosswalk already
knows, then calls `extract_techniques` / `extract_papers` unchanged. One vocabulary,
one adapter carrying its own language problem.

**`vélin` does not mean "vellum".** French `vélin` is *wove paper* — `vélin d'Arches`,
`vélin de Montval` — while English "vellum" in `PAPER_KEYWORDS` is calfskin. 250 records
use it. Translating `vélin → vellum` would mislabel the single most common paper in the
collection. It maps to `wove`. `vergé` → `laid` (70), `Japon` → `japanese` (8).

---

## 6. Artist identity

The canonical node already exists and is the largest in the graph:

```
  Artist {name: "Pablo Picasso", ulanUrl: .../ulan/500009666,
          identityConfidence: "institutional", 1881–1973}   — 1,996 works
```

Paris's `authors_list` is `PICASSO Pablo` (surname-first, all-caps) — a blind
`MERGE (Artist {name: ...})` would create a second Picasso node. The adapter uses the
same hand-resolved map `bm_ingest.py` uses, covering only the handful of names these
2,223 records actually contain (Picasso; Degas ×12; González ×3; Tobey ×3).

Worth noting while here: the graph already carries nine `Artist` nodes matching
"picasso", seven of which are junk from auction free-text (`"AMENDMENT: edition was 400
not 500 as originally stated. Pablo Picasso"`, `"Pablo Picasso 1881-1973- Tête de Faune;
lithograph printed in colours on Richard de Bas"`). These are the non-artist `Artist`
nodes already tracked as open in the duplicate-artist work — **not touched by this
adapter**, logged here because they surfaced during the identity check.

---

## 7. What is UNMAPPED (doc 09 §6, q5)

- **`expositions`** (76%) — full exhibition histories, HTML `<ul>`. Genuinely valuable
  provenance signal; doc 08 has no `Exhibition` node and §5 defers one. Recorded, dropped.
- **`bibliography`** (49.7%) — same.
- **`ensemble_id` / `related` / `nb_elements`** (10.2%, 227 records) — portfolio/suite
  membership (Suite Vollard and friends). `ConceptualWork.seriesTitle` exists as a plain
  string (added for BM) but there is no part-of edge. Carried as `seriesTitle` where a
  title is available; the ensemble graph structure is dropped.
- **`recap_*`** — presentation-layer aggregates for the museum's own ensemble display.
  No ACKG meaning.
- **`comments`, `number_identification`, `description`** — free text, no home.

---

## 8. Data-quality caveats (doc 09 §6, q4)

- **9 records have essentially no fields** beyond an id and title — blank shells. Excluded.
- **112 records carry `image_unavailable`**; 2,119 have `medias`. The gap is not the
  same set, so presence of `medias` is the test, not absence of the flag.
- **Dates are frequently day-precise but sometimes `s.d.`** (sans date) or bracketed
  (`[1er mai 1939]` = inferred by the cataloguer). `s.d.` → no date; brackets →
  `precision: "circa"`, with the source's wording kept in `displayLabel`.
- **`date_creation` uses ` . ` as a range separator** (`fin 1936 . début 1937`), not a
  dash. A dash-only range parser silently returns a single year here.
- **Impression counts are heavily skewed** — `Baer 651` alone has 38 impressions in this
  one collection. The adapter creates one `Impression` per accession, which is correct,
  but any downstream "how many of these exist" statistic must not read collection depth
  as market scarcity. Flagged explicitly because this is a valuation-relevant trap.

---

## 9. Legal position — and a live tension with ADR-0002

**Copyright.** Picasso died 1973; the work is in copyright across the EU/UK/Spain until
end-2043. Every record carries `copyright: "© Succession Picasso"` (2,184 of the images);
only 13 images are `Domaine public`. Succession Picasso / Picasso Administration is among
the most actively enforced artist estates there is.

**Per-record rights flag.** 2,211 of 2,223 records carry
`artw_reproduction_rights: "Reproduction internet autorisée"`. This authorises *the
museum's* web reproduction. It is not a licence grant to a third party, and should not be
read as one.

**TDM reservation — and it is ambiguous.** `museepicassoparis.fr/robots.txt` carries
`Content-Signal: search=yes, ai-train=no, use=reference`, explicitly invoking Article 4
of the EU DSM Directive as a reservation of text-and-data-mining rights.
`www.navigart.fr` blocks GPTBot but reserves nothing generally, and `api.navigart.fr`
reserves only its own docs pages. So the museum's own host has opted out while the
platform serving the museum's data has not.

**Recommendation: treat the museum's reservation as the operative intent.** Routing
around an explicit opt-out on a hostname technicality is not a position worth defending
later, and the difference costs nothing here — the ingest is metadata-first either way.

**ADR-0002 tension, flagged rather than silently overridden.** ADR-0002 concluded that
"museum open-access data cannot supply reference images for the ~96% of the catalogue
that's still in copyright", citing a direct test in which *sampled Picasso objects were
0% public-domain at the Met*. That conclusion stands on its own terms. This source does
not overturn it — it is a specific, narrow exception in the other direction: a
copyright-restricted museum source whose **metadata** is uniquely authoritative for an
artist who is simultaneously in copyright and one of the highest-volume names in the
print market. ADR-0002's decisions 1–4 are about *images* and *commercial* use. Nothing
here changes either.

Reconciling that properly is an ADR amendment, not something a research note should
decide. **Written 2026-09-11** as [ADR-0002 Amendment 1](../docs/adr/0002-image-extraction-methodology-and-licensing.md)
— Decisions 5–9: metadata carve-out on the personal-research footing, image similarity
permitted but not built and fenced by four conditions, everything lapsing automatically on
any commercial footing, and no generalisation to other in-copyright museum sources.

**What the adapter does, on the current personal-research footing:**
- Metadata: ingested, rate-limited, cached locally, attributed to the museum on every
  `SourceRecord`.
- Images: `DigitalImage.sourceUrl` recorded with `license: "© Succession Picasso"` and
  `rightsReservation: "EU DSM Art.4 reserved (museepicassoparis.fr)"` set on every node,
  so nothing downstream can consume one without seeing the restriction. **No bulk image
  download is included in this adapter**, deliberately — unlike `bm_embed_images.py`,
  there is no companion embed script here. That is a separate decision with the
  ADR-0002 amendment attached to it, not a default.
- Nothing is redistributed or surfaced in any UI.

---

## 10. Dry-run verification

`picasso_paris_fetch.py` pulled the full catalogue (2,223 records, `filteredCount`
matched) and `picasso_paris_ingest.py --dry-run` mapped it without writing:

```
[CLASSIFY] impressions=2027 matrices=187 excluded_no_inventory=9
[TECHNIQUE] 22/2027 impressions have no resolvable technique
[MAPPED]    states=1029 catalogue_refs=1757 images=2111
```

Catalogue prefixes after normalization — every one a real catalogue, no parse residue:

```
Baer 1567    Mourlot 188    Bloch 53    P.i.F. 5    CZW 5    Czwiklitzer 2
```

**The French vocabulary work pays off:** 135 records had no English-matchable technique
before translation; 22 after. The remaining 22 are genuine vocabulary gaps, not parse
failures, and several are genuinely interesting — Picasso's one-off `erwinographie sur
verre`, González's `gravure sur tôle de fer`, `gravure au canif`, and two records that
are studio equipment (a press, an inking tray) rather than prints at all.

**Three bugs the dry run caught, all now fixed:**

1. **Dimensions were inverted** — 468 sheet / 1,742 plate, when the source clearly
   carries 2,217 sheet measurements. `_clean()` collapses all whitespace, which
   destroyed the newline separating the two measurement lines, so the sheet line
   inherited the `(hors marge)` marker belonging to the plate line. Now split on the raw
   newline first: **2,210 sheet / 1,742 plate**.
2. **Printer names ran on across the field seam** — concatenating `mst` and `tirage`
   before matching produced `"Lacourière Quatrième cuivre"`. Now matched per field, with
   a trailing ` en <year>` clause trimmed (`"Lacourière en 1937 ou 1938"`).
3. **The catalogue fragment failures** in §3.3 above.

Spot-check, MP2820 (the record this investigation started from):

```
  title    Tête de femme n°5. Portrait de Dora Maar
  sheet    45x34.4cm        plate  29.9x23.7cm
  state    IIème état (2)   printer  Lacourière
  refs     [{Baer, 653}]    watermark  "Picasso ou Vollard"
  techniques  Aquatint, Drypoint     paper  laid
```

---

## 10.1 Live single-record validation (2026-09-11)

The Cypher had never executed, so one impression (MP2820) was written through the
authenticated connection before any bulk run: **7 nodes, 13 relationships, 44 properties
set**. Read back:

```
  work     Tête de femme n°5. Portrait de Dora Maar      cat    [Baer-653]
  sheet    45x34.4cm     plate  29.9x23.7cm              state  IIème état
  printer  Lacourière    paper  [laid]                   signed false
  techniques [Drypoint, Aquatint]
  source   Musée national Picasso-Paris / MP2820
  image    rightsReservation = "EU DSM Art.4 reserved (museepicassoparis.fr)"
```

**One query caveat found while verifying.** Doc 08 lets `State -[:PRINTED_AS]-> EditionRun`
and `ConceptualWork -[:PRINTED_AS]-> EditionRun` both exist, and this adapter writes both,
so an unlabelled traversal `()-[:PRINTED_AS]->(er)` now matches a `State` as well as a
`ConceptualWork` and silently doubles rows. Any consumer walking `PRINTED_AS` upward must
label-qualify the start node. Not a data defect — a consequence of the schema's own
degradation option, first exercised here because nothing before populated `State`.

**One bug caught immediately before this write, worth recording because it would have been
invisible after the fact:** the draft set `Impression.signed` from the mere presence of the
`inscriptions` field. That field is populated on 987 records but is overwhelmingly about
annotations, not signatures — plate-state marks, `"Bon à tirer"`, dates, a printer's tally.
Only **35** records actually record a signature, and half of those use the French
cataloguing abbreviation `S.B.D.` (*signé en bas à droite*) rather than any form of the word
"signé". The draft would have marked 987 impressions signed. Signed-versus-unsigned is one
of the larger single price factors on a print, and these records are intended to feed Stage 3
comparables (ADR-0016), so the error would have propagated into valuations. Now matched
explicitly; the raw text is kept separately in `Impression.inscriptionNote`.

---

## 10.2 Full load — executed and verified (2026-09-11)

Loaded in 10 seconds (2,027 impressions + 187 matrices). Counts exact against the dry run:

| Check | Expected | Actual |
|---|---|---|
| `SourceRecord` (Musée national Picasso-Paris) | 2,214 | **2,214** |
| `Impression` | 2,027 | **2,027** |
| `Matrix` | 187 | **187** |
| `State` on impressions | 1,029 | **1,029** |
| `signed` | 35 | **35** |
| `techniqueResolved = false` | 22 | **22** |
| plate dimensions | 1,742 | **1,742** |
| `DigitalImage` with rights reservation | 2,111 | **2,111** (0 embedded) |

**The Geiser-Baer → Baer normalization is confirmed by the load itself**, not just by the
pre-load analysis. `Baer 647` ("Femme au fauteuil et au chapeau") came back as one
`ConceptualWork` with **41 impressions** — exactly the 11 filed under "Baer" plus the 30
filed under "Geiser-Baer". Without the alias those would be two unrelated works of 11 and
30. `Baer 651` likewise resolved to 38 (37 + 1).

**No over-merge.** The largest cluster is `Baer 287` "Flûtiste et dormeuse" — 46
impressions across **29 distinct states**, which is the museum holding the complete
working-proof sequence of one plate, not two different prints collapsed together. 295
works have more than one impression; every large cluster inspected is a single title under
a single catalogue entry.

**Cross-source join is better than predicted.** §3.2 estimated 43 exact / 58 base-number
matches against `Baer` alone. In the loaded graph **86 `CatalogueEntry` nodes now document
both a Picasso-Paris work and an auction-side work**, linking **99** auction
`ConceptualWork`s to museum records — Bloch and Mourlot join too, which §3.2 did not count.
Paris contributed 716 distinct `Baer` entries where the graph previously held 198.

Picasso's canonical `Artist` node went 1,996 → 3,262 works with no duplicate created.

### Two findings from the verification, logged not swept

**1. Five records strand Picasso in a composite `Artist` node.** Joint-authorship strings
that `ARTIST_RESOLUTION` doesn't cover fell through to the raw value, creating
`"PICASSO Pablo, GONZÁLEZ Julio"` (3 records), `"PICASSO Pablo, DALÍ Salvador"` (1) and
`"ÉLUARD Paul (GRINDEL Eugène, dit), PICASSO Pablo"` (1). These are new instances of the
composite/non-artist `Artist` pattern already tracked as open in the duplicate-artist work.
Small and contained, but they mean five collaborative Picasso works don't hang off his
canonical node.

Three further new artists loaded in the museum's surname-first format — `MARCOUSSIS Louis
(MARKUS Ludwik Kazimierz, dit)`, `TÀPIES Antoni`, `LASCAUX Elie`. They are legitimate new
nodes, but the format will not match an auction source's "Louis Marcoussis", so they are
latent duplicates the moment another source mentions them.

**2. `Matrix -[:HAS_STATE]-> State` never fires.** Confirmed against the source: **0 of
187** plate records carry a state marker, against 1,029 of 2,027 impressions. The branch is
correct per doc 08 and costs nothing, but on this data it is unexercised — worth knowing
before anyone builds a query that assumes plate states exist.

---

## 11. Not done

- **Load is done** (§10.2), and §9's ADR-0002 question is settled — see that ADR's
  *Amendment 1* (2026-09-11).
- **Image embedding: complete 2026-09-11.** `picasso_paris_embed_images.py` embedded
  2,106 images in 3,476s with **zero failures**; all **2,111/2,111** now carry a DINOv2
  (1024-dim) and CLIP image (512-dim) vector and the `embeddingCommercialUse = false`
  stamp. Scratch dir confirmed purged, no failure log written. The shared
  `clipTextEmbedding` space is unchanged at 91,685 vectors — no French text entered it,
  as intended. Graph-wide embedded images: 77,821. It operates under ADR-0002 Amendment 1
  Decision 7 and enforces it rather than documenting it: no `--keep-cache` flag at all,
  scratch purge in a `finally` plus an `atexit` hook, per-image deletion so at most one
  in-copyright file exists on disk at a time, a rights precondition that aborts if any
  node lost its `license`/`rightsReservation`, and an `embeddingCommercialUse = false`
  stamp that makes Decision 8's lapse executable in one query. CLIP *text* embedding is
  off by default — this source's description text is French and `clipTextEmbedding` is a
  shared space of which 91,487 of 91,685 vectors are English.
- **The five composite `Artist` nodes and three surname-first names from §10.2 are not
  merged or reformatted.**
- **`knowledge_graph/.env.example` is stale** — it describes the Aura shape
  (`NEO4J_DATABASE=your-instance-id`), but the live instance is Neo4j Community 5.26.30
  on Oracle, where the database is always `neo4j` and the URI scheme is `bolt://`.
  Copying it verbatim produces an auth/database failure. Confirmed during this load;
  not fixed, since it is shared config outside this task.
- The comma-separated multi-ref bug in `catalogue_matching.parse_catalogue_refs` (§3.3)
  is **not** fixed, and the ~20 malformed prefixes already in the graph are **not**
  cleaned up.
- No `Exhibition` node proposed for the 76% exhibition-history coverage, though this
  source makes the case for one better than anything else in the graph.
- Barcelona (~4,251 works) not attempted.
- ADR-0002 amendment not written.
