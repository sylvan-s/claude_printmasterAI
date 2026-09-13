# ADR-0016: ACKG realised prices become Stage 3's primary comparables

**Date:** 2026-09-09
**Status:** Accepted, implemented. Amended same day (see *Amendment 1*). Not yet backtested.

Stage 3 valued prints from `auctionComps` alone — free-text findings written out by Stage 2b's
web research. The ACKG's own 39,916 dated, sold auction records were never read by the
valuation stage at all. This makes the graph the **primary** comparables source and demotes
web research to fallback.

Depends on two repairs landed immediately before it (both below). Builds on
[ADR-0003](0003-knowledge-graph-grounded-triage.md) (the graph as a deliberate tool call, not a
context dump) and leaves [ADR-0006](0006-deterministic-stage2b-routing-and-skeptic-integration.md)
routing and [ADR-0015](0015-artist-attribution-confidence-and-corroboration.md) attribution
untouched — this changes only what Stage 3 reads.

---

## Context

Three facts, established by tracing every ACKG read path on 2026-09-08:

**1. No price data reached valuation.** All five ACKG query functions `appraiser.ts` imports
(`queryAckg`, `queryAckgWorks`, `scoreWorkTitleMatches`, `queryArtistStyleConsistency`,
`queryImageEmbeddingMatches`) return names, authority URLs, support **counts**, techniques,
dimensions, edition sizes, `sourceTypes` and embeddings. Not one returns `priceRealised`,
`hammerPrice` or `estimateLow`. `tests/backtest/compare.ts` likewise compares against the
benchmark lots' own `low_estimate`/`high_estimate` from the live Roseberys/Forum APIs.

**2. The free-text comps are weak.** They are prose, not fields, and frequently carry no usable
number. A real backtest artifact (`tests/backtest/output/A0777_9/result.json`) records a comp
whose `hammerPrice` is the string `"Estimate £3,000–£3,500 (hammer price not publicly
disclosed)"`. Nothing downstream can validate, deduplicate, or currency-normalise them, and the
only defence against a lot valuing itself from its own listing was to *ask the model* to notice.

**3. The graph holds a real corpus — but it was wrong, and it was in the wrong currencies.**

- **Wrong:** `bonhams_ingest.py` read `pricing.hammer_premium` (a premium-INCLUSIVE total, the
  figure Bonhams' pages print as "Sold for X inc. premium") as if it were the premium AMOUNT,
  and wrote `priceRealised = hammer + total`. Every sold Bonhams and Skinner row was inflated by
  exactly one hammer price. 39,914 rows, repaired by
  `knowledge_graph/repair_bonhams_price_realised.py`. **Wiring comps in before that repair would
  have fed a ~2x inflation straight into every valuation it touched.**
- **Wrong currency:** 24,469 of the dated rows are USD/EUR/CAD/AUD. Restricting comps to GBP
  would have discarded ~61% of the corpus, and for many print artists the US market is deeper.

Coverage was initially narrower than the raw record counts suggest. At the time of writing only
Bonhams (2003–2026) and Skinner (2022–2026) carried a `saleDate` at all: Roseberys' was null on
12,743 of 12,745 rows and Forum's on all 10,050, and Forum has zero `priceRealised` besides.
**The dated comparables corpus was exactly the set that was inflated** — which is why the repair
was a precondition, not a side-quest. Roseberys' dates were recovered the same day; see
*Amendment 1*.

## Decision

**1. GBP normalisation at the sale date, precomputed onto the node.**
`knowledge_graph/backfill_fx_gbp.py` writes `priceRealisedGBP`, `hammerPriceGBP`, `fxRateToGBP`,
`fxRateDate` and `fxSource` from ECB daily reference rates (via frankfurter.app, cached to
`fx_gbp_ecb.json` so re-runs and CI need no network and the exact rates stay auditable). The ECB
does not publish on weekends or TARGET holidays, so a sale takes the nearest **preceding**
publication day — the rate standing when the lot actually sold.

Not at query time, and not from Bonhams' own `gbp_low_estimate`. `bonhams_ingest.py` docstring
item 4 already refused the latter on the grounds that an estimate-time rate can be stale; that
objection is now measurable — sale 15403 (2007-11-06, hammer US$1,800) carries a
`gbp_low_estimate` of 1331.01, which is US$1,800 at ~1.35, a 2026 rate applied to a 2007 sale
when GBP/USD stood at 2.0875. Precomputing also keeps valuation deterministic and offline-testable.

**2. `queryAuctionComparables()` — tiered, exact-match only.**
Tier 1 `same_work` (matching ConceptualWork id, or an exact case/whitespace-insensitive title
match within the same artist); tier 2 `same_artist_technique`; tier 3 `same_artist`. Never
similarity. This follows the project's standing rule against fuzzy catalogue-identity matching —
the two ACKG corruption incidents that rule exists to prevent both came from similarity-based
work merging, and a mis-tiered comp would silently anchor a valuation to the wrong print.

Tier-1-by-title is suppressed for low-information titles (`isLowInformationTitle`), which would
otherwise collapse every "Untitled" print by an artist into one bogus same-work set.

**Tiering happens in Cypher, before `LIMIT`.** Ranking by recency and tiering afterwards in TS
would let a tier-1 comp fall outside the limit window for any artist with enough recent sales —
discarding the single most relevant comparable. (This was a real bug in the first cut, caught in
smoke testing.)

**3. Self-match exclusion is structural.** Roseberys and Forum lots are both in the graph and in
the backtest pool, so a pool lot can match its own `SourceRecord` and value itself from its own
realised price. `excludeListingUrl`/`excludeSaleLot` filter this in Cypher. This is strictly
stronger than the free-text path, which could only ask the model to recognise its own source
listing in prose.

**4. Stage 3 reads ACKG comps first, web comps second.** The prompt now weights them explicitly:
anchor on ACKG realised prices, weight by tier, and never let a web-research figure override a
`same_work` realised price. Web comps corroborate or fill gaps, and are the sole basis only when
the graph returns nothing.

**5. Absence is coverage, not signal.** Both the query's `coverageNote` and the prompt state that
an empty comp set reflects the graph's Bonhams/Skinner-only dated coverage and is **not** evidence
that a work is unsaleable. Stage 3 is instructed never to reason downward from missing comps.

**6. Graph failure degrades, never fails.** The comps query is wrapped in try/catch; a Neo4j
outage logs a warning and falls back to the old web-only path rather than taking down a valuation.

## Consequences

Valuations for graph-covered artists become anchored to real, dated, premium-inclusive realised
prices rather than to prose. Where an artist has repeat sales of the same print the effect is
large: "Ojai Festival" (Hockney) returns 9 `same_work` sales spanning 2024–2026 in a £787–£1,742
band — close to a direct market price, where the previous path offered an unverifiable sentence.

Currency conversion becomes a real dependency with a real failure mode. A rate is fetched once
and cached; if the cache is stale the fallback is the nearest preceding cached day, which drifts
silently for recent sales. `--refresh-rates` must be run periodically.

Comp quality is now visible, and imperfect. Smoke testing surfaced "The Erotic Arts by Peter
Webb" as a Hockney etching comp — a book containing a Hockney print, ingested as a work by him.
Tier 2/3 comps inherit every attribution and titling weakness of the underlying ingest; tier 1 is
the only tier that is exact by construction.

## Not addressed

- **No backtest yet.** The valuation effect is unmeasured. `tests/backtest/compare.ts` compares
  against auction *estimates*, so it will register a change in accuracy but cannot attribute it
  to the comps change specifically.
- **Forum's missing `saleDate` and `priceRealised`.** 10,050 records remain excluded from comps.
  Unlike Roseberys (now fixed, *Amendment 1*), Forum has no realised price in its source at all,
  so dating it alone would not make it usable.
- **53 Roseberys rows** have `priceRealised > hammerPrice × 1.35` (implied premium 35–112%,
  avg 44%). A different adapter and different fields from the Bonhams bug; unexplained, logged.
- **The comps window (`2015-01-01`) and limit (40) are unfitted**, chosen on judgement about
  print-market drift, not measured against outcomes.
- **No inflation or market-index adjustment.** A 2015 sale enters at its nominal GBP value.
- **Tier 1 by exact title is narrow by design** — it will not match "Ojai Festival (Baggott 81)"
  against "Ojai Festival". Callers that resolve a ConceptualWork id should pass it.


---

## Amendment 1 — Roseberys sale dates recovered (2026-09-09, same day)

`roseberys_ingest.py` never mapped a sale date because `catalogue.csv` has no date column —
only `sale_code` and `auction_id`. The dates were recovered from Roseberys' own 43 sale pages
(43 fetches, not 12,745) by `knowledge_graph/backfill_roseberys_sale_dates.py` and cached to
`roseberys_sale_dates.json`.

Each `/bidding/<slug>` page states its date twice — ISO in `<title>`, prose in the body. Both
are parsed and required to **agree**; a sale whose two sources disagree is skipped, not guessed,
because a wrong sale date is worse than a null one (a null is visibly excluded from comps,
whereas a wrong date silently mis-weights them). All 43 agreed. The fetch is additionally
checked against A0777 = 2026-04-16, which the earlier live-page pilot had recorded
independently; it matched.

**12,745 records dated, 43 distinct dates, spanning 2014-10-04 to 2026-07-01.** Note that is
2014, not the 2016 the ingest docstring claims. Roseberys' A-codes are not strictly
chronological — three sales invert under both `sale_code` and `auction_id` ordering (A0379,
A0587, A0680). Two were verified directly against their live pages, weekday included; the dates
are correct and the codes are simply allocated ahead of scheduling.

**Comparables corpus: 39,916 → 48,078 (+20.5%).** Now Bonhams 38,663, Roseberys 8,164,
Skinner 1,251.

Two bugs in this ADR's own first cut surfaced only once Roseberys entered the corpus, both now
fixed and both regression-tested where testable:

1. **The self-match guard was inert.** `testingExcludeSourceListing` is prose
   (`Roseberys, sale A0777, lot 42 (https://...)`), and it was passed straight into an exact
   URL equality check, so it matched nothing. This was harmless only by accident — Roseberys was
   excluded from comps for want of dates, and the backtest pool *is* Roseberys lots. Fixed with
   `parseExcludedListing()`, which extracts both the URL and a structured `saleId`/`lotNumber`;
   both guards are now applied, since URL matching is exact but format-fragile. Covered by four
   cases in `tests/knowledge_graph/parse_tests.ts`.
2. **The comps match fanned out.** A `SourceRecord` whose `Impression` is reachable by more than
   one `ConceptualWork`/`EditionRun` path was returned once per path, so one real sale counted
   as several comparables and dragged the median toward whichever lots happened to duplicate
   (~4% excess: 120 rows for 115 distinct records on one artist). The query now collapses to one
   row per `SourceRecord`, keeping its strongest tier.
