# Duplicate-Artist Multi-Attribution Audit — 2026-09-05

Read-only audit of the self-hosted ACKG (bolt://145.241.203.210:7687), prompted by the manual
Sidney Nolan dedupe where 6 name-variant Artist nodes turned out to already share nearly all of
their `CREATED` works with each other before any merge. This asks: how widespread is that pattern
graph-wide?

**No writes were made to the graph.** All queries below are `MATCH ... RETURN` reads.

## Method

```cypher
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
WITH w, collect(DISTINCT a) AS artists
WHERE size(artists) > 1
RETURN w.id, [x IN artists | x.name] AS artistNames
```

For every work with >1 distinct creating Artist node, the artist pair/set was classified as:

1. **`ulan_match`** — both nodes share the same resolved `ulanUrl` ID (unambiguous same-person).
2. **`core_subset`** — after stripping honorifics/post-nominals (Sir, Dame, RA, OBE, RDI, AC, …)
   and accents, one name's token set is a subset of the other's (e.g. "Peter Blake" ⊂ "Peter Blake RDI").
3. **`high_fuzzy`** — not a subset match, but `difflib` string-similarity ≥ 0.72 (misspellings,
   transliteration/accent differences, e.g. "Robert Rauchenberg" / "Robert Rauschenberg").
4. **`low_fuzzy`** — neither of the above; genuinely different-looking names sharing a work.

## Headline numbers

- **1,495 of 40,827 ConceptualWork nodes (3.7%)** are `CREATED` by more than one distinct Artist node.
- Of those, **1,470 works involve exactly 2 artists** (352 unique artist pairs); the remaining
  **25 works involve 3–20 distinct Artist nodes**.
- **Zero of the 352 pairs share a matching resolved `ulanUrl`** — in every duplicate pair, at most
  one of the two variants has ever been ULAN-resolved. The ULAN backfill/dedupe pass referenced in
  prior work did not catch these; they were introduced (or resolved) after that pass ran, since
  `identityResolvedAt` timestamps on affected nodes are as recent as 2026-08-31.

| Category | Pairs | Works | Verdict |
|---|---|---|---|
| `core_subset` (honorific/suffix variant) | 262 | 1,312 | Same person — pipeline bug |
| `high_fuzzy` (spelling/typo/accent variant) | 39 | 83 | Same person — pipeline bug |
| `low_fuzzy` (genuinely different name) | 51 | 75 | Mixed — see below |

**94.9% of the 2-artist-pair works (1,395 of 1,470) are the same real person attributed to two
different Artist nodes** — the same failure mode as the manual Sidney Nolan case, just not yet
manually caught.

## Which ingests are affected

| Source prefix | Total works | Multi-artist works | Rate |
|---|---:|---:|---:|
| **roseberys** | 13,237 | **1,381** | **10.4%** |
| met | 6,366 | 111 | 1.7% |
| bm | 222 | 3 | 1.4% |
| tate | 11,459 | 0 | 0% |
| forum | 9,540 | 0 | 0% |
| trevelyan | 3 | 0 | 0% |

**Roseberys is overwhelmingly the affected ingest** (92% of all multi-attributed works, and over 1
in 10 of its own catalogue). Tate and Forum show none at all — Forum's absence is notable given the
Nolan case originated there, suggesting Forum's variants were caught either by the earlier manual
dedupe or Forum's own ConceptualWork repair, while Roseberys' were not.

Cross-referencing the classification against source: **when the Met contributes a multi-artist
work, it's almost always `low_fuzzy`** (75 of Met's 111), i.e. genuinely-different-looking names —
mostly legitimate. **When Roseberys contributes one, it's almost always `core_subset`/`high_fuzzy`**
(1,379 of Roseberys' 1,381) — i.e. the duplicate-node bug.

## Root cause (confirmed by example)

Checked the raw `SourceRecord` attributions behind two cases:

- **Peter Blake / Peter Blake RDI** (205 shared works): different Roseberys lot records spell the
  same living artist's name with or without the post-nominal "RDI" depending on the auction
  catalogue entry. Artist entity resolution matches on the literal name string, so each spelling
  gets its own node instead of resolving to the existing one.
- **Zoran Music / Zoran Mušić / Zoran Mu&scaron;ić** (`roseberys-a0785-lot16`): here it's worse —
  a **single SourceRecord** (`roseberys-a0785-lot16-record`) is `ATTRIBUTED_TO` all three spelling
  variants, one of which is a raw, un-decoded HTML entity (`&scaron;`) left in the name string. This
  is a text-cleaning bug in the Roseberys ingest, not just a cross-record naming inconsistency.

**Conclusion: the Roseberys ingest/backfill does exact-string Artist entity resolution with no
name normalization (honorifics, accents, HTML-entity decoding, or fuzzy matching) before creating
or linking an Artist node.** This is a distinct pipeline stage from the catalogue-record→
ConceptualWork merge logic that intentionally avoids fuzzy matching — that policy is about not
over-merging different physical impressions into one work, and shouldn't be read as covering artist
identity resolution too. This finding suggests Artist resolution needs its own
normalization/fuzzy step, gated by human review before merging, not by loosening the
catalogue-merge policy.

Given the affected nodes' recent `identityResolvedAt` dates, this most likely traces to the
Roseberys catalogue-refs backfill that added ~572 works (12,665 → 13,237, per prior session notes) —
worth confirming against that backfill's run log if a fix is scoped.

## The 3–20-artist works (25 works) — mostly NOT the same bug

| Artists | Count | Example | Assessment |
|---:|---:|---|---|
| 20 | 1 | `met-691045` — Stevens, Spero, Ringgold, Schapiro, Schneemann… | Legit — feminist artist-collective print portfolio |
| 17 | 1 | `met-717072` — Zalce, Covarrubias, Méndez, Escobedo… | Legit — Taller de Gráfica Popular (Mexican printmaker collective) portfolio |
| 13 | 1 | `met-384450` — Baldessari, Ruscha, Kitaj, McCarthy… | Legit — LA artists' portfolio |
| 12 | 1 | `met-864837` — Xu Bing, Mutu, Celmins, Mehretu, Serra… | Legit — group portfolio |
| 11 | 2 | `met-375953/957` — Dine, Rosenquist, Warhol, Lichtenstein… | Legit — Pop Art portfolio (duplicated ConceptualWork, separate issue) |
| 10 | 2 | `bm-P_1942-0418-1-1-10`, `met-696840` (mathematicians/scientists print) | Legit — group portfolios |
| 9, 7, 6, 4, 3 | 18 | Recurring TGP rosters (Zalce, Méndez, Anguiano, O'Higgins…); Victory Garden Collective x5 | Legit — same collective, different combinations, each a real co-created print |
| **3** | **1** | **`roseberys-a0785-lot16` — "Zoran Music" / "Zoran Mušič" / "Zoran Mušić"** | **Same bug as above — one person, 3 spelling/encoding variants** |

**24 of these 25 works are genuine multi-creator collaborative artworks** (mostly Met's Taller de
Gráfica Popular and American artist-collective print portfolios, correctly modeled as one work with
many creators) — not duplicate-artist bugs. Only `roseberys-a0785-lot16` belongs with the main
finding.

## The 51 `low_fuzzy` pairs (75 works) — needs a case-by-case call, not a bulk fix

Unlike the bulk `core_subset`/`high_fuzzy` population, these are a mixed bag and should **not** be
auto-merged:

- **Legitimate artist duos**: Christo & Jeanne-Claude, Jake & Dinos Chapman (Chapman Brothers) —
  correctly two people, correctly co-attributed.
- **Print publisher/workshop modeled as co-creator**: Cirrus Editions, Harlan & Weaver Inc.,
  Flowers Graphics, Brodsky Center for Innovative Editions, "The Print Shop", WPA — these are
  workshops/publishers, not artists. Whether they belong as a second `CREATED` node or should
  instead be a `PRINTED_BY`/`PUBLISHED_BY` relationship is a data-modeling question, separate from
  the duplicate-node bug.
- **Possible genuine misattribution / uncertain cataloguing**: mostly in the Met's Mexican
  printmaking collection (e.g. "Anonymous, Mexican 20th century" paired with a named TGP artist on
  one work) — these look like source-catalogue ambiguity rather than an ACKG pipeline defect.

75 of the 78 `low_fuzzy` works trace back to Met source records; only 2 are Roseberys and 1 is BM.

## Recommendation

1. **Priority fix scope: Roseberys only.** 262 `core_subset` + 39 `high_fuzzy` pairs (301 pairs,
   1,395 works) plus the one Zoran Music 3-way case are safe to treat like the Sidney Nolan merge —
   same real person, split across nodes by a literal-string-match gap in artist entity resolution.
2. **Fix should live in artist resolution, not catalogue merging** — normalize accents/HTML
   entities, strip a known post-nominal/honorific list, and re-check against existing Artist nodes
   (ideally re-running the ULAN/Wikidata resolver on the *normalized* string) before creating a new
   node. [[feedback_catalogue_identity_no_fuzzy_matching]] governs merging catalogue records into
   one work and should stay exact-match; this is a different stage.
3. **Do not bulk-merge the 51 `low_fuzzy` pairs or the 24 legitimate multi-creator works** — they
   need individual review (some are correct, some are a modeling-choice question about publishers
   vs. artists), unlike the >94% majority which is a clear-cut duplicate.
4. Worth spot-checking whether the Roseberys catalogue-refs backfill (12,665 → 13,237 works) is
   the actual source of the recent duplicates, using that backfill's run log/timestamps.
