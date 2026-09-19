# Roseberys multi-work lots — plan and pilot

2026-09-19 · branch `feature/roseberys-multi-work-lots` · parser `knowledge_graph/roseberys_multi_work_parse.py` (ROSEBERYS-MULTI-0.2)

## Problem

3,619 of 16,536 Roseberys lots (2,358 sold) are flagged `multi_work` by the extractor's regex
(`benchmark/src/roseberys/parse.ts` `detectMultiWork`) and have been held out of the ACKG since
2026-08-24. The flag is a candidate filter, not a verdict:

- some flagged lots are ONE work whose note mentions a set (A0777 lot 242, a Miró maquette);
- about 490 are one print sold with a book, certificate, box or invite;
- some are N identical impressions of one edition, where an equal split is exact;
- some name every work ("(i) … (ii) …", semicolon title lists, titles in brackets);
- some give a count and a series or portfolio title only ("the complete portfolio of eleven
  screenprints") — these cannot be split into identifiable works.

Only the primary image comes through the API. The lot page lists every photo in the lot's own S3
folder (the parent directory of `lot.image`). Itemised lots usually carry one photo per work plus a
group shot first. Older sales often have one photo, and 617 flagged lots have none.

## Agreed decisions (2026-09-19)

1. Split prices do NOT reach comps or the price model yet. Both read `whole_lot` records only by
   default. Whether to include split prices is a separate, gated test. Identical copies are the
   candidate exception, because their equal split is exact.
2. Complete portfolios with unnamed plates are held back as under-described.
3. Field names are house-neutral so Forum, Bonhams and Swann can use them later. Scope is
   Roseberys only for now.
4. Price rule: split the hammer (and estimates, and price realised) equally across the works.

## Schema — one SourceRecord per work

Every price consumer (`pricing_ml/export_sales.py`, `query_comparables.ts`) reads
`s.hammerPriceGBP` via `(i:Impression)<-[:DOCUMENTS]-(s:SourceRecord)`. If one lot-level
record documented N impressions, each impression would show the full lot price. So each
work gets its own SourceRecord carrying its share in the normal fields, plus provenance of the
split:

| Field | Meaning |
|---|---|
| `hammerPrice`, `priceRealised`, `estimateLow`, `estimateHigh` | this work's share |
| `priceAllocation` | `whole_lot` (every existing record, implicit when null) · `equal_split` · `whole_lot_with_ancillary` |
| `allocationShare` | e.g. 0.2 |
| `lotWorkCount`, `lotPart` | N works in the lot, this work's position |
| `lotHammerPrice`, `lotPriceRealised`, `lotEstimateLow`, `lotEstimateHigh` | the published whole-lot figures |
| `lotRecordId` | shared by the sibling records of one lot, e.g. `roseberys-a0777-lot148-record` |
| `lotParseMethod` | parser version + model, e.g. `ROSEBERYS-MULTI-0.2:claude-opus-5` |
| `lotAncillaryItems` | extras sold with a single work (book, certificate…) |

IDs: `roseberys-a0777-lot148-w3` (Impression), `…-w3-record` (SourceRecord), `…-w3-image`
(DigitalImage, from the matched photo). `lotNumber` stays the published lot number. The FX
backfill needs no change, because the split sits in the normal fields.

## Parser

1. **Text pass** (Opus 5, structured JSON): classify the lot as `single_work`,
   `single_work_with_ancillary`, `multi_work`, `identical_copies` or `under_described`. Extract the
   declared count and, per work: title, year, artist, medium, support, dimensions, edition, signed
   and catalogue ref, plus the exact phrase each came from. "Respectively" lists are resolved per
   work; "largest sheet" dimensions are assigned to no single work.
2. **Vision pass** (Opus 5, only for split candidates): all of the lot's photos (≤16, 900px),
   numbered. The model says what each photo shows and picks one photo per work, with a confidence.
3. **Gate** (`validate()`, code): single → full price; under-described → hold. Split only if the
   works found equal the declared count, every work has a title (except identical copies), there
   are ≤12 works, and every work gets its own photo at medium/high confidence with no photo shared.
   Otherwise hold, with the reason recorded.

## Pilot — 40 sold lots, hand-labelled

Stratified across the regex's sizing classes, 18 sales, including the known awkward cases
(Miró maquette, Band Aid screenprint with ephemera, Craxton sheet with nine images, Kusama pumpkins,
Banksy Glastonbury set, Sorel portfolio). Artefacts, not committed (Roseberys copyright):
`benchmark/data/roseberys_multi_work_pilot/`.

| | Opus 5 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| Lot kind correct | **38/40** | 34/40 | 27/40 |
| Harmful decisions (price on the wrong unit) | **0** | 2 | 8 |
| Work count right, when it split | 19/19 | 18/18 | 18/18 |
| Decisions: split / single / hold | 15 / 11 / 14 | 16 / 10 / 14 | 20 / 12 / 8 |
| Cost for 40 lots | $1.97 | $1.10 | $0.32 |

- **Haiku** over-uses `identical_copies`: it would split "a set of four posters" and "four
  etchings from a series" into copies of one work. It also put a 15-print Kitaj portfolio's price
  on one print. Its photo confidence is uncalibrated: on 3 of the 5 disputed lots checked by eye it
  swapped works while reporting "high" confidence.
- **Opus** read the pencil titles and the edition numbers on the sheets (Richardson "Beer for
  Breakfast", Maillol II/XX, the red-printed woodcut) and was right on every disputed match
  checked by eye (Richardson, Maillol, Topolski, Hockney, Rayson). Sonnet agreed with Opus on 62 of
  67 photo assignments.
- **Opus's two misses**: Tracey Emin with a certificate went to `single_work_with_ancillary`
  instead of `single_work` (same decision, full price). The Kusama pumpkins in yellow and red were
  called identical copies instead of two colourways. The prompt was fixed in 0.2 and 4 lots were
  re-checked: all correct.
- **Opus holds (14)**: 10 under-described (portfolios, unnamed sets), 3 low-confidence photo
  matches (Nash's 8cm wood engravings, three Malthouse "Untitled", two Thornton sheets with the
  same title), and 1 where only a group photo exists (Banksy Glastonbury, 9 posters, 1 photo). All
  are correct holds under the agreed rule.

Of the 19 lots labelled as genuinely itemised multi-work, Opus split 15 correctly and held 4 on
photo grounds.

**Cost at full scale** (Opus, measured $0.049/lot): about $180 for all 3,619 flagged lots, or
about $90 through the Batch API. The vision pass is only paid for split candidates.

## Next steps

1. Filter consumers to `coalesce(s.priceAllocation, 'whole_lot') = 'whole_lot'` in
   `export_sales.py` and `query_comparables.ts` (identical copies are handled by the later test).
   This must land BEFORE any graph write.
2. Full run through the Batch API. Spot-check 30 split lots by eye before any write.
3. Ingest writer: extend `roseberys_ingest.py` with the per-work mapping, reusing `map_row`'s
   identity keying per work. Dry-run count first; the graph write needs its own approval.
4. Put the `single` outcomes (≈490 lots) back into the normal single-work load with
   `lotAncillaryItems`.
5. Later, gated: test whether `equal_split` prices help comps or the model.
