# ADR-0002: Image extraction methodology and cross-institution licensing constraints

**Date:** 2026-08-22
**Status:** Accepted. Amended 2026-09-11 (see *Amendment 1*): the Findings' "museum open-access
data cannot supply reference images for in-copyright artists" holds for images and for commercial
use, but does not reach institutional **metadata**, which Decisions 1–4 never addressed.

---

## Context

Evaluating a DINOv2-embedding reference index for two related but distinct use cases:

1. **Artist attribution** — "who made this print" — via similarity search against a labeled reference set.
2. **"Have we sold something like this before"** — near-duplicate/comp retrieval against Roseberys' own historical catalogue.

Building either requires a reference image bank. This ADR records what was actually verified about where that bank can legitimately come from, and the extraction bugs found and fixed along the way.

---

## Findings

### 1. Roseberys' own catalogue — the primary source

`benchmark/src/roseberys/extract.ts` (+ `api.ts`) pulls the full historical catalogue via Roseberys' own bidding API (`com_bidding&task=commission.getLots`), not scraped HTML. As extracted: **16,536 lots, 3,502 unique artists, 82% (13,565) with a populated image URL**, spanning 2016–2026.

No licensing constraint applies here — it's Roseberys' own photography and data.

**Bug found and fixed:** `imageUrl()` was building URLs against `www.roseberys.co.uk`, which 302-redirects every request to `/404`. The real asset host, confirmed by inspecting a live lot page's rendered `<img src>`, is a separate public S3 bucket: `am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/roseberys/prod/...`. This had nothing to do with bot protection — an early direct test against the same wrong URL returned an AWS WAF challenge response once and a plain 404 another time, which read as a bot block until the actual redirect target (`/404`) was inspected directly. Fixed in `api.ts`; verified end-to-end with a real `--images` run (403/506 images downloaded from sale A0785, confirmed as genuine WebP files, not error pages).

**Multi-image discovery:** the bulk `getLots` API exposes exactly one `image` field per lot. Every individual lot page, however, server-renders **two** distinct images per lot (confirmed 8/8 in a sample) — same lot GUID folder, two different image-file GUIDs. Visual inspection of one pair showed image A is the print itself (unframed, cropped to sheet) and image B is the same print shown framed/matted. Recommendation: keep using only the primary (unframed) image for embedding — a framed shot has a materially different visual signature (mat, frame, lighting) that would embed away from a bare-sheet query photo rather than toward it. Pulling the second image at scale would also mean one HTTP request per lot (~16,536) instead of the current paginated bulk calls (~166) — a much larger job, not currently justified by the use case.

**Catalogue composition** (bears directly on the licensing section below): bucketing all 3,502 artists by death year —

| Bucket | Artists | Lots | Share of lots |
|---|---|---|---|
| Living / no death year | 2,209 | 9,544 | 57.7% |
| Died 2000–2026 | 492 | 2,633 | 15.9% |
| Died 1955–1999 | 588 | 3,672 | 22.2% |
| Died 1900–1954 | 198 | 653 | 3.9% |
| Died before 1900 | 15 | 31 | 0.2% |

**~96% of the catalogue by lot volume is by artists still in copyright.** Only the ~4.1% tail (pre-1955 deaths — Whistler, Toulouse-Lautrec, Degas, Munch, etc.) is realistically public-domain-eligible.

**Free evaluation set, already in the data:** 2,364 distinct (artist, title) pairs recur more than once across the catalogue (6,215 lots total) — the same print photographed independently at different sales over the years. Usable as ground truth for near-duplicate retrieval quality without needing external labels.

### 2. Public-domain museum APIs (Met, Rijksmuseum) — small supplementary tier only

Both are free, open, CC0-licensed for public-domain holdings, and confirmed working. But per the copyright-year analysis above, they can only ever cover the same ~4% pre-1955 tail — direct testing against the Met API confirmed this empirically: sampled Whistler (d.1903) objects were 66% flagged `isPublicDomain: true`; sampled Picasso (d.1973) objects were 0% in the same check. **Museum open-access data cannot supply reference images for the ~96% of the catalogue that's still in copyright, regardless of whether the museum physically holds a matching work.**

Operational note: the Met API's `departmentId` filter undercounts badly (returned 5 for a Whistler query where a 53-object sample showed the true figure is closer to ~900 in Drawings and Prints alone) — sample-and-extrapolate rather than trust it directly.

### 3. British Museum — two different systems, only one usable

The BM's old Linked-Open-Data/SPARQL endpoint is effectively dead (widely reported as unreliable, tracked by a public uptime-monitoring bot). A separate, current endpoint — `britishmuseum.org/api/_search`, which actually powers their live site search — is alive and returns real image URLs (`media.britishmuseum.org/media/{location}`, again a different host from the collection API, same pattern as the Roseberys bug above). It's Cloudflare-gated against scripted requests (403 on direct `requests.get`).

An existing script (`bm_artist_lookup.py`, from the Agathe Sorel research project) works around this legitimately: generate a JS snippet, paste into the browser console at britishmuseum.org, let an already-authenticated real browser session do the fetching and self-download the JSON, then parse it locally. Verified working — returned 30 real Agathe Sorel records with live image URLs. This is a manual, one-artist-at-a-time workflow, not a bulk pipeline.

### 4. Museum Data Service (MDS) — real and keyless, metadata only

`museumdata.uk` (launched Sept 2024, aggregating UK museum collections) has a working, keyless public API (`get-api-token` → `extract` endpoint pagination). Verified with the same Agathe Sorel query: 10 records across two institutions (Ashmolean, Ben Uri Gallery). Confirmed by inspecting the raw JSON directly: **there is no image/media field anywhere in the record structure** — metadata and a link back to the source institution's own record only. Useful for existence/provenance cross-referencing; not an image source.

### 5. Cross-auction-house data (Christie's, Sotheby's, etc.) — no open path found

No equivalent open API identified. Aggregators that already do this (Artnet Price Database, MutualArt, Artprice, Invaluable) present as paid subscription products for human search, with no confirmed public developer API for any of them. One vendor (AuctionAsk) advertises a developer API; not evaluated beyond its landing page. Scraping competitor sites directly was not attempted.

---

## Legal considerations

**The controlling constraint across every non-Roseberys source is commercial-use licensing, not technical access.** Confirmed directly from policy pages and real returned data, not assumed:

- **Tate:** metadata is CC0, but images are CC-BY-NC-ND (non-commercial, no derivatives) at low resolution; commercial use requires a separate license via Tate Images. Most contemporary/modern artist reproduction rights are cleared through DACS (ArtImage product), also CC-BY-NC-ND only.
- **British Museum:** terms of use state explicitly — "you must obtain permission for all commercial use of British Museum content." Most images are CC-BY-NC-SA.
- **Museum Data Service:** confirmed on real returned records — `license: "CC BY-NC"`.
- **Met / Rijksmuseum:** the small in-copyright fraction of their holdings (anything not flagged public domain) carries the same restriction; only the flagged-PD subset is genuinely free to use.

**Why this matters for a DINOv2 index specifically:** generating an embedding from a CC-BY-NC-licensed image and using it to power a paid comparison/attribution tool is commercial use under any of these licenses, independent of how the image is technically processed. The **ND** (NoDerivatives) term on the Tate/DACS images is arguably a second, separate blocker — an embedding is a transformation of the image into a new representation — though this specific question (does generating an ML embedding count as a "derivative work" under ND) is genuinely unsettled and is the same question underlying current AI/copyright litigation generally; not something to rely on an informal reading of.

**Net effect on architecture:**
- The DINOv2 reference index should be built primarily from Roseberys' own catalogue — no licensing blocker, ~13,565 images already extractable.
- Museum public-domain data (Met/Rijksmuseum, PD-flagged only) can supplement the small pre-1955 tier, nothing more.
- BM/Tate/MDS lookups are useful as **on-demand, per-artist provenance/existence checks** (keyed off a lot's own artist field, queried at inference time) — not as bulk index-building sources, and not for embedding into a commercial-facing product without a separate paid license from Tate Images / DACS / the British Museum's commercial licensing desk.
- Cross-auction-house comps require either a licensing conversation with an aggregator (Artnet, MutualArt, etc.) or a direct arrangement with peer auction houses — this is a business-development task, not an engineering one, and nothing should be built against competitor sites without that sign-off first.

---

## Decision

1. Build the DINOv2 reference index from Roseberys' own catalogue as the primary and, for the bulk of the business (living/post-2000 artists), only viable source.
2. Do not scrape or bulk-index Tate, British Museum, or MDS imagery for use in a commercial-facing tool without first securing explicit commercial licensing from the relevant rights holder (Tate Images, DACS ArtImage, or the British Museum's commercial licensing team).
3. Use the existing BM/MDS per-artist lookup scripts as on-demand provenance/due-diligence checks only, gated to internal use, not as index-building infrastructure.
4. Treat cross-auction-house comps as blocked pending a licensing decision; do not build a scraper against competitor auction sites.

---

## Amendment 1 — in-copyright institutional metadata, and the narrow image-similarity carve-out (2026-09-11)

### What prompted this

The Musée national Picasso-Paris publishes its catalogue through a documented, unauthenticated
JSON API, and 2,214 print records from it are now in the graph
(`knowledge_graph/picasso_paris_ingest.py`; survey note
`knowledge_graph/picasso_museum_source_survey_2026-09-11.md`). That sits awkwardly against this
ADR's Findings §2, which concluded from a direct test — *sampled Picasso objects were 0%
public-domain at the Met* — that "museum open-access data cannot supply reference images for the
~96% of the catalogue that's still in copyright".

That conclusion is not overturned, and this amendment does not weaken it. It is about a
distinction the original ADR had no occasion to draw, because every source it examined was being
evaluated as an **image** source.

### What still stands, unchanged

Decisions 1–4 are about images and about commercial use. All four remain in force:

- The DINOv2 reference index is still built primarily from Roseberys' own catalogue.
- No Tate/BM/MDS **imagery** is bulk-indexed for a commercial-facing tool without licensing.
- Cross-auction-house comps remain blocked pending a licensing conversation.
- The Findings' copyright-year analysis — ~96% of the catalogue by lot volume is by artists still
  in copyright — is unaffected.

### The distinction this amendment adds

**Metadata is not imagery.** What Picasso-Paris supplies, and what this project uses it for, is a
body of *facts about prints*: that Geiser-Baer 653 is titled *Tête de femme n°5. Portrait de Dora
Maar*, that it is a IIème état, that the plate is 29.9 × 23.7 cm, that Lacourière pulled it, that
the paper is a vergé de Montval with a Picasso/Vollard watermark. Titles, dates, dimensions,
states, printers, accession numbers and catalogue-raisonné citations are facts, not the
copyrighted expression of the artwork. They are the museum's reconciliation work, not Picasso's
composition.

**The uses are consistency-checking, not publication.** Specifically:

1. **Work-name consistency.** [ADR-0017](0017-work-title-identity-principal-name-and-aliases.md)
   records that this graph has no canonical titles to defer to — `CatalogueEntry` carries a
   `number` and nothing else on all 21,293 nodes. Picasso-Paris supplies an institutional title
   against an explicit catalogue citation for 1,757 records, which is exactly the authority tier
   ADR-0017 Decision 2 wanted and could not find.
2. **Cross-source cataloguing alignment.** 86 `CatalogueEntry` nodes now document both a
   Picasso-Paris record and an auction-side record, bridging 99 auction works to museum records.
   That is a correctness check on the auction houses' own citations, in the direction that
   matters: a museum record contradicting a lot's catalogue number is evidence about the lot.
3. **Image similarity** — see the conditions below, which are stricter.

**Nothing is reproduced.** No Picasso work or image is displayed, published, redistributed,
exported, or surfaced in any interface. The graph holds `DigitalImage.sourceUrl` — a pointer to
the museum's own hosting — not image bytes.

### Where this genuinely goes further than Decisions 1–4, stated plainly

Tate (10,208 embedded images) and the British Museum (2,507) are **already** in this project's
embedding index, and both are CC-BY-NC. So embedding non-commercially-licensed museum imagery on
the personal-research footing is not a new category of decision here — it is one already taken
twice, under this ADR's own Decision 3 reading.

Picasso-Paris is nonetheless a step beyond that, in two specific ways, and pretending otherwise
would make this amendment useless:

- **There is no licence grant at all.** Tate and BM publish under CC-BY-NC — a licence with a
  non-commercial condition. Picasso-Paris images carry `© Succession Picasso` and a per-record
  flag reading *"Reproduction internet autorisée"*, which authorises **the museum's** web
  reproduction and is not a grant to anyone else.
- **There is an express TDM reservation.** `museepicassoparis.fr/robots.txt` sets
  `Content-Signal: ai-train=no, use=reference`, invoking Article 4 of the EU DSM Directive. The
  platform actually serving the data (`api.navigart.fr`) reserves nothing, but this project
  treats the museum's own reservation as the operative intent rather than routing around an
  opt-out on a hostname technicality. That reservation is why the ingest takes metadata only and
  ships no embed script.

Succession Picasso is also among the most actively enforcing artist estates there is. That is a
practical risk factor independent of the legal analysis, and it argues for the conservative
reading at every fork.

### Decision

Extending, not replacing, Decisions 1–4:

**5. In-copyright institutional metadata may be ingested and used for identity and
consistency work**, on the current personal-research, non-commercial footing. This covers
titles, dates, dimensions, states, techniques, papers, printers, provenance, accession numbers
and catalogue-raisonné citations. It does not extend to reproducing the museum's own descriptive
prose at length, which is authored text rather than fact.

**6. Attribution is mandatory and structural.** Every such record carries
`SourceRecord.institutionName` and `accessionNumber`, and every `DigitalImage` carries
`license` and `rightsReservation`, so nothing downstream can consume one without seeing the
restriction. This is already implemented for all 2,214 records and 2,111 image nodes.

**7. Image similarity over in-copyright museum images is permitted on the personal-research
footing, but is NOT currently built, and requires all of the following if it is.** No embed
script ships with the Picasso-Paris adapter, deliberately — unlike every other adapter here,
which pairs with one. Conditions:

   a. Only the derived embedding is retained. Source images are cached transiently for the
      embedding pass and deleted, matching `--keep-cache` defaulting to off elsewhere.
   b. No image bytes enter the graph, any export, or any interface.
   c. Embeddings are used for retrieval and comparison only — never to reconstruct, generate, or
      approximate the image.
   d. The result is never displayed to anyone but the operator.

   **The unsettled question is acknowledged, not resolved.** This ADR's Legal considerations
   already flagged that whether an ML embedding is a "derivative" is genuinely open and is the
   same question underlying current AI/copyright litigation. Condition (a)–(d) reduce exposure;
   they do not answer it. Proceeding is a risk accepted on a non-commercial footing, not a risk
   shown to be absent.

**8. All of 5–7 lapse automatically the moment this project takes money.** Not "should be
reviewed" — lapse. A paid appraisal tool using this data requires a licence from Succession
Picasso / ADAGP, in the same way Decision 2 requires one from Tate Images / DACS / the BM. The
metadata carve-out in Decision 5 is the more defensible half and might survive a licensing
conversation; the image carve-out in Decision 7 should be assumed not to.

**9. This carve-out is Picasso-Paris-specific and does not generalise.** It is not a precedent
for ingesting any in-copyright museum source. The next such source gets its own assessment,
because the terms differ per institution — as this ADR's Findings §2–§4 already demonstrated for
four of them.

### What this is not

A legal opinion. It records a decision, the reasoning behind it, and the specific facts checked —
so that a future reader can see what was known at the time and re-decide on better information,
rather than inheriting a conclusion with no visible basis.

---

## Amendment 2 — Decision 7 exercised for the Navigart network (2026-09-11)

Decision 7 said the in-copyright image-similarity path was "NOT currently built". For the
Navigart network it now is, in `knowledge_graph/navigart_embed_images.py --tier
in-copyright`. **Picasso-Paris is unchanged and remains metadata-only** — no embed script
ships with that adapter and none is added here.

### Why this network and not that one

The distinction is the TDM reservation, not the copyright status, which is the same for
both. `museepicassoparis.fr/robots.txt` sets `Content-Signal: ai-train=no, use=reference`,
an express Article 4 EU DSM reservation, and Amendment 1 recorded that this project treats
the museum's own reservation as the operative intent. Checked 2026-09-11 across the
contributing institutions — cnap.fr, centrepompidou.fr, musees.strasbourg.eu,
mam.paris.fr, mamc.saint-etienne.fr, museedartsdenantes.fr — **none publishes an equivalent
reservation.** So nothing here routes around an opt-out; there is no opt-out to route
around. Succession Picasso's enforcement posture, cited in Amendment 1 as an independent
practical risk factor, also has no counterpart across a network of 33 public collections.

### The four conditions, as mechanisms

- **7(a) transient cache.** `--keep-cache` is REFUSED in combination with this tier — the
  script exits citing 7(a) — rather than merely defaulting off. Each file is deleted in
  the `finally` of its own iteration, with an `atexit` purge so a crash or Ctrl-C cannot
  leave a downloaded set behind.
- **7(b) no bytes in the graph.** `_assert_no_bytes` runs on every row before every write.
- **7(c)/(d) retrieval only, operator only.** Unenforceable from inside a script, so every
  node is stamped `embeddingCommercialUse = false` plus a Decision 7 basis string. The
  whole tier is then purgeable in one query if the footing changes:
      MATCH (i:DigitalImage) WHERE i.embeddingCommercialUse = false
      REMOVE i.embedding, i.clipImageEmbedding, i.embeddingBasis, i.embeddingCommercialUse

### The tiers are mutually exclusive by construction

There is no `--tier both`. A run embeds the public-domain population (stamped
`embeddingCommercialUse = true`, surviving that purge) or the in-copyright one (stamped
`false`), never a silent union — so the flag is unambiguous for every vector the script
writes. The candidate query re-derives the tier from `SourceRecord.sourceCopyright` rather
than trusting the ingest, so pointing the script at the wrong population skips rather than
embeds.

Scope as run: **13,471 in-copyright images** across the 33 vaults, against 5,598 in the
public-domain tier.

### A near-miss worth recording

The first edit adding the tier switch did not apply — an indentation mismatch in the
search string — so the query silently stayed public-domain-only while the CLI reported
`tier=in-copyright`. The smoke run therefore embedded the one remaining PUBLIC-DOMAIN
image and stamped it `embeddingCommercialUse = false` with the Decision 7 basis. It was
caught because "Found 1 image" was implausible against 13,472 candidates, and the node was
repaired. Recorded because the failure mode is the dangerous direction for a rights gate:
a patch that does not apply leaves the code doing something defensible while the operator
believes it is doing something else. The tier is now asserted in the query and verified by
counting candidates per tier before any run.
