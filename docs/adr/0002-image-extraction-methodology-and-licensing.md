# ADR-0002: Image extraction methodology and cross-institution licensing constraints

**Date:** 2026-08-22
**Status:** Accepted

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
