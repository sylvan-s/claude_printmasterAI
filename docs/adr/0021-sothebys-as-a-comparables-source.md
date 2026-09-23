# ADR-0021: Sotheby's as a comparables source

**Date:** 2026-09-23
**Status:** Proposed. Pilot built (`knowledge_graph/sothebys_pilot.py`, read-only). **Blocked on a
permission decision** — see *Consent gate*. Nothing ingested, no graph writes.

Sotheby's is absent from the ACKG and from every source feeding it. This ADR proposes adding it
as a sixth auction house, scoped to artists the graph already holds, and records the three
things that make it different from the existing five: a premium-only price basis, a higher
market tier, and an access route we have not been granted.

Extends [ADR-0016](0016-ackg-realised-prices-as-primary-comparables.md) (graph realised prices as
Stage 3's primary comparables) and inherits its sale-date FX rule. Identity follows
[ADR-0017](0017-work-title-identity-principal-name-and-aliases.md) unchanged.

---

## Context

**1. The gap is large.** The graph holds 58,472 priced sold rows across five institutions
(Bonhams, Swann, Roseberys, Forum, plus museum records). Sotheby's site index carries
**60,474 lots in its Prints department, 52,732 of them sold**, with estimates, sale prices,
dates, locations and catalogue-raisonné references in the lot titles. Ingesting the sold print
rows would roughly double the priced corpus.

**2. It answers questions the existing corpus cannot.** Probed 2026-09-23:

- Picasso *Carmen*, the complete 1949 book: **seven sold** at Sotheby's (£6,600, £7,800, £8,125,
  €6,000, €7,200, €16,800, $18,000) against one unsold. The graph holds none of these, and the
  whole market elsewhere yielded four results.
- Single Carmen plates make **$7,200** and **€3,720** at Sotheby's against ~$2,250 at Bonhams,
  Swann and Clars — a gap large enough to change a valuation, and invisible without them.
- Ai Weiwei: Sotheby's sells *Artist's Hand* ten times over at $4,032–$11,340 and has never
  touched the cheap multiples Roseberys lives on. The two catalogues are near-disjoint.

**3. Why a corpus, not a lookup.** A comp fetched at appraisal time serves one appraisal. An
ingested row enters the export → priors → calibration chain and changes every valuation after
it. Concretely: per-artist price-model fits are singular in 237 of 334 cases, which is a sample
size problem; repeat-sale pairs, the pooled time index and the Stage 3a house offsets all need
the same work observed more than once; and unsold lots (which the index carries) are what the
estimate-as-target work depends on. None of that can be assembled from per-appraisal fetches.

**4. The access route is undocumented.** Sotheby's publishes no API. `api.sothebys.com` and
`clientapi.sothebys.com` do not resolve. What exists is the Algolia index behind their own site
search (`bsp_dotcom_prod_en`, app `O28SY4Q7WU`), whose search key is embedded in their pages,
and a GraphQL router at `clientapi.prod.sothelabs.com/graphql` with introspection disabled.
See `reference_artsy_api` for the equivalent position on Artsy.

---

## Decision

### Scope: artists already in the graph

Ingest Sotheby's lots **only for artists that already resolve to an Artist node**, not the whole
Prints department. Rationale:

- Identity resolution is safest where we already hold an authority record (ULAN) and title
  aliases to match against.
- The compounding benefits — repeat-sale pairs, cross-house offsets, per-artist priors — accrue
  only where the artist is already represented. A Sotheby's-only artist adds a row to the corpus
  and nothing to the model.
- It bounds the extraction, which matters while the permission question is open.

Artists outside that set stay a live Stage 2b lookup, as Artsy already is.

### Price basis: premium-inclusive, declared as such

`hammerPrice` exists in the index but is always null. `salePrice` is the published
premium-inclusive figure — the same basis as Artsy's `priceRealized` and as the repaired Bonhams
`priceRealised`. Therefore:

- Write `priceRealised` / `priceRealisedGBP` (FX at sale date, per ADR-0016).
- Leave `hammerPrice` / `hammerPriceGBP` **null**. Do not derive a hammer by dividing by an
  assumed premium: Sotheby's rates vary by year, location and price band, and a fabricated
  hammer would be indistinguishable downstream from a real one.
- `query_comparables.ts` already accepts a row with realised-but-no-hammer, so Stage 3 needs no
  change. Anything that keys on hammer alone simply will not see these rows, which is correct.

### Both departments

The same work is catalogued under **Prints** in London and New York and under **Books &
Manuscripts** in Paris — complete Picasso books sit in the latter. Filtering on
`departments:"Prints"` alone loses roughly half the Carmen record. Ingest both, and record the
department on the SourceRecord.

### Known index defects to guard at parse time

Established by probe, each needs a guard and a check script:

| Defect | Guard |
|---|---|
| `salePrice` is populated on some **UNSOLD** rows (a Carmen book at £6,250, a *Torero* at $9,375) — it is a bid level, not a result | Never read `salePrice` without `soldStatus == "SOLD"`; hard-fail if an unsold row carries a price into `priceRealised` |
| `artistName` is **not a filterable attribute** — `filters=artistName:"Ai Weiwei"` returns 0 while free text returns 196 | Scope artists through the query string; post-filter on exact `artistName` equality |
| Free-text search collides on names — `sorel` returns 90 lots, all Sorel **Etrog** | Exact `artistName` match, never substring |
| Title case and form are inconsistent (`pablo picasso \| three works: ...`, `Picasso, Proper Merimee`) | Normalise for matching only; store the original |
| Algolia caps pagination (typically 1,000 hits per query) | Slice extraction by `endDate` ranges, verify counts against `nbHits` |
| Currencies include HKD, which the ECB cache does not carry | HKD via its USD peg, flagged in `fxSource`; fail on any currency with no rate |

### Gates before adoption

1. **Pilot** (this ADR's script): match rate against existing ConceptualWorks, defect counts,
   tier profile. No writes.
2. **Leave-one-house-out**, as the Stage 3a house offsets were gated. Sotheby's sells a higher
   tier — their Ai Weiwei prints start where Roseberys' finish — so a naive pool could pull
   mid-market valuations up. The offset term must be fitted and shown to hold before adoption.
3. **Model rebuild** through the real chain (`reference_pricing_model_build_recipe`), compared
   against the current model, not assumed better.

### Consent gate

**Nothing is extracted in bulk until the access question is settled.** Their terms-of-use page
could not be located (the obvious URLs 404), so the specific clauses are unverified. A site's
own search key is a convenience for looking up a lot; it is not a grant to collect 50,000
records. The pilot reads a few hundred rows for a handful of named artists — targeted lookups of
the kind a person could do by hand. Bulk extraction should follow a request to Sotheby's, not
precede it. This mirrors the position recorded for Artsy, where the terms are explicit.

---

## Consequences

**Gained:** a near-doubling of the priced corpus; the first top-tier house in the graph; more
cross-house pairs for house offsets; deeper per-artist samples where fits are currently singular;
unsold lots for sell-through work; and a corpus that can be interrogated rather than queried one
lot at a time.

**Accepted:** no hammer prices from this source; a tier skew that must be modelled rather than
ignored; a parse surface with six known defects; and a dependency on an undocumented endpoint
that can change or close without notice — which is an argument for holding the data once
extracted, not for extracting it repeatedly.

**Rejected:** ingesting the whole Prints department (unbounded, and most of it adds rows without
adding model signal); deriving hammer from an assumed premium (fabricates a field Stage 3
trusts); and live-only use (serves the appraisal, never the model).

---

## Pilot results (2026-09-23)

`knowledge_graph/sothebys_pilot.py`, read only, eight artists chosen by priced-row count in the
graph. **3,405 Sotheby's lots, 2,836 sold (83%).**

| Artist | Lots | In print depts | Exact-title match | Median Sotheby's* | Median graph £ |
|---|---:|---:|---:|---:|---:|
| Andy Warhol | 545 | 371 | **66.0%** | 69,850 | 8,037 |
| Joan Miró | 552 | 321 | 38.3% | 18,750 | 3,038 |
| Pablo Picasso | 475 | 364 | 31.9% | 13,970 | 3,875 |
| David Hockney | 582 | 450 | 31.3% | 17,640 | 2,280 |
| John Piper | 305 | 13 | 30.8% | 8,750 | 900 |
| Marc Chagall | 417 | 234 | 22.6% | 20,160 | 3,074 |
| Salvador Dalí | 527 | 92 | 21.7% | 22,800 | 1,475 |
| Rembrandt van Rijn | 2 | 2 | 100% | 4,625 | 2,645 |

\* mixed-currency median, indicative only — GBP 1,451 / USD 1,447 / EUR 444 / HKD 48 / CHF 8 /
SGD 5 / AUD 2 across the sample.

**Match rate: 704 of 1,847 print-department lots, 38.1%**, by exact title equality after
normalisation (case, accents, bracketed catalogue refs). The denominator matters: measured
against *all* lots it is 25%, but a Frink bronze or a Dalí oil having no ConceptualWork is
correct behaviour, not a miss.

### What the pilot establishes

**1. The tier gap is real and large.** Median Sotheby's sale price runs 4–9x the median realised
price the graph already holds for the same artist (Hockney 17,640 vs £2,280; Warhol 69,850 vs
£8,037). These rows cannot simply join the comps pool — gate 2 (leave-one-house-out) is not a
formality.

**2. Identity resolution works where the corpus is deep.** Warhol matches 66% because the graph
holds his editions densely and Sotheby's writes F. & S. numbers into the title. The weak
performers are weak for understandable reasons: Dalí's lots are mostly Impressionist & Modern
paintings, Piper's are Modern British (only 13 of 305 are prints), Chagall's split between
Prints and Impressionist & Modern.

**3. Department scoping must be per artist, not global.** John Piper: 274 lots in Modern British
& Irish Art against 13 in Prints. Filtering globally on Prints would take the wrong 13.

**4. Two defects confirmed at scale.**

- **123 unsold rows carry a price** (4.3% of lots) — the `salePrice`-on-UNSOLD trap, now
  measured rather than assumed. Any ingest that reads `salePrice` without checking `soldStatus`
  would import 123 fictitious results in this sample alone.
- **`strip_honorifics` misses dotted post-nominals.** Sotheby's writes "Dame Elisabeth Frink,
  R.A." on 83 of 98 Frink lots; the shared helper rstrips only a trailing dot, so "R.A." becomes
  "R.A" and never matches the post-nominal set. Before the pilot stripped dots itself it found
  25 Frink lots instead of 304 — a 92% loss. **This is a defect in
  `knowledge_graph/resolve_artist_identity.py`, which roseberys_ingest and others import**, so it
  is not confined to this work. Logged separately; not patched here.

**5. Artist name forms need a resolution step.** Rembrandt returns 2 lots because Sotheby's
writes "Rembrandt Harmenszoon van Rijn" (44) and "Rembrandt Harmensz. van Rijn" (16), neither of
which equals the graph's "Rembrandt van Rijn". The 2,307 free-text hits include Rembrandt
Bugatti and "Circle of Rembrandt…", so loosening the match is not the answer — an alias table
per ADR-0017 is.

### Like-for-like price comparison (matched works only)

Artist-median against artist-median compares different objects. This pairs a Sotheby's SOLD
print-department lot against the graph's median realised price **for the same ConceptualWork**,
converted to GBP at the sale date (ADR-0016 basis; HKD via its USD peg).

| Artist | Paired lots | Sotheby's median | Graph median | Ratio | IQR | Sotheby's dearer |
|---|---:|---:|---:|---:|---|---:|
| Andy Warhol | 128 | £35,832 | £10,495 | **2.86** | 1.33–8.75 | 85% |
| John Piper | 4 | £4,250 | £1,980 | 1.82 | 1.56–2.24 | 100% |
| Marc Chagall | 40 | £6,642 | £4,518 | 1.56 | 0.95–2.18 | 73% |
| David Hockney | 95 | £11,248 | £8,125 | 1.56 | 0.91–3.23 | 73% |
| Joan Miró | 82 | £10,527 | £6,016 | 1.26 | 0.99–2.10 | 72% |
| Pablo Picasso | 41 | £6,985 | £9,548 | **0.98** | 0.60–1.39 | 49% |
| Salvador Dalí | 11 | £7,797 | £10,062 | **0.81** | 0.75–2.06 | 36% |
| **All** | **402** | — | — | **1.62** | 0.97–3.47 | 73% |

**The tier gap is not uniform — it is an artist-level effect.** On the same works Sotheby's is
1.6x the existing corpus overall, but Picasso and Dalí come out at parity or below while Warhol
is 2.9x. A single global house offset would misprice both ends; this argues for the offset being
fitted per artist where data allows, exactly as the attribute multipliers already are.

**Two limits on this number, both instructive:**

- **Title equality cannot tell an edition from a unique work.** Before restricting pairs to
  print departments, Warhol's "Self portrait" paired a £14.8m Sotheby's canvas against a £312
  graph row. Fixed by department scoping — but it means ingest must carry the department, and
  pairing logic must never rely on title alone.
- **Nor can it tell a signed edition from a poster of the same image.** The surviving extremes
  are all that shape: *The Scream (Green)* £448,000 vs £416, *Queen Elizabeth II* £327,600 vs
  £546, *Mick Jagger 1975 (poster)* £115,531 vs £223. This is the unmodelled-reproductions
  problem already recorded in the priors review, now visible across houses. Restricting to pairs
  whose graph side rests on 2+ sales moves the medians only modestly (Warhol 2.86 -> 2.46,
  Hockney 1.56 -> 1.43), so the effect is real, but the tails are not usable as comps without a
  technique/signature class check.

### Recommendation

The match rate is high enough to be worth doing for deep-corpus artists and too low to justify a
blanket ingest. Proceed **artist by artist**, starting with those above 30%, once the consent
gate is cleared — and fix the honorific defect first, since it silently shrinks every artist's
candidate set.
