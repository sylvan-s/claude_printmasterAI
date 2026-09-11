# ADR-0017: Work titles — decompose first, then a principal name and an alias set

**Date:** 2026-09-10
**Status:** Proposed, partially implemented. The scan tooling has landed
(`knowledge_graph/find_duplicate_work_clusters.py`, commit c71de50) and decisions 2-4 are applied
by `knowledge_graph/merge_duplicate_work_clusters.py` (commit 0f818b2), which has written
`alternateTitles` and `Impression.sourceTitle` for the first time. Decision 1 (decomposition) is
not implemented. Amended 2026-09-11 (see *Amendment 1*): Decision 2's institutional tier must
exclude ingest fallback titles, not only placeholders.

There is no canonical listing of artwork titles. The closest thing is the catalogue raisonné, and
this graph does not hold catalogue titles at all — only entry numbers. Meanwhile the same print
accumulates one `ConceptualWork` node per lot, each carrying a differently-worded title, and
19,974 of those nodes are surplus.

This ADR sets out how a work gets a **principal name** and how the other wordings are kept as
aliases. It is the identity-layer counterpart to
[ADR-0016](0016-ackg-realised-prices-as-primary-comparables.md), whose tier-1 comps match on
exact title within an artist and therefore inherit every problem below. It does not revisit
[ADR-0010](0010-two-pass-attribution-artist-then-work.md)'s attribution passes, and it leaves the
standing prohibition on fuzzy catalogue-identity matching (`catalogue_matching.py`) fully intact.

---

## Context

**1. The catalogue raisonné is in the graph as a numbering system, not as titles.**
`CatalogueEntry` carries exactly two properties, `number` and `id`, on all 21,293 nodes. There is
no title field. `CatalogueRaisonne` carries `numberingPrefix` on 2,957 nodes, a `title` on **50**,
and `alternateNames` on **one**. So the source we would most want to defer to is not available to
defer to.

Nor is a catalogue entry a work identifier at book level. **1,172** Chagall works are documented
by an entry numbered 30 under a Cramer-prefixed catalogue, carrying **1,046 distinct titles** —
that entry is the whole of *La Bible*. This is the same hazard `catalogue_matching.py`'s docstring
records from the Forum backfill, seen from the other side.

**2. Most title variation is not alias variation. It is identity buried in the string.**
Renoir's *Le Chapeau Épinglé* occupies **62 `ConceptualWork` nodes with 50 distinct title
strings** (46 after case- and accent-folding). Those strings are not 46 names for one print. They
describe at least three different prints and several states:

```
Le chapeau épinglé
Le Chapeau Épinglé, 3e planche
Le Chapeau Épinglé, 2e planche
Le chapeau épinglé (La fille de Berthe Morisot et sa cousine), 1re planche (Delteil/Stella 6), c.
Le Chapeau épinglé II (La fille de Berthe Morisot et sa cousine), 2nd state (Delteil 7II), c.
Le chapeau épinglé, 3e planche (The Pinned Hat, 3rd Plate) (Delteil/Stella 8), c.
```

One string is carrying six typed facts: the work title, an alternative title, a translation, a
plate designation, a state, and a catalogue citation. Two of those six — plate and state — are
**identity discriminators**, and they sell at different prices. Any scheme that treats the whole
string as a name, and the differences as aliases, silently merges different prints.

The sources also disagree on the discriminators themselves: Forum attaches "Delteil 8" to both
*2e planche* and *3e planche* in different lots, and Chagall's *Moïse sauvé des eaux* appears as
`pl. 25` and `pl. 26`, *Les ténèbres sur l'Egypte* as `pl. 30` and `pl. 31`. A plate number is
therefore not a safe key on its own either.

**3. Measured shape of the corpus** (91,291 `ConceptualWork` nodes with a title):

| Pattern | Count | What it means |
|---|---:|---|
| Parenthetical of 4+ chars | 13,508 | Mixed: aliases, translations, **and** colourway/state/plate qualifiers |
| Series clause (`from …`) | 12,239 | Portfolio membership, sometimes present, sometimes not |
| Plate number (`pl. N`) | 1,329 | Identity, and inconsistently recorded |
| Embedded catalogue citation | 847 | `(Delteil 8)`, `[Vallier 181]` — belongs in `CatalogueEntry` |
| Lot-descriptive opener (`Six etchings…`) | 707 | Describes the lot, not the work |
| State designation | 151 | Identity — Hamilton's "In Horne's house – state I…V" is five objects |

Decomposition already exists, but from one source only: `seriesTitle` is set on 577 nodes, all
British Museum, and `catalogueRefsRaw` on 562.

**4. Placeholder titles are not titles.** `[no title]` covers 139 different Thomas Schütte prints
of 2001 and 90 Paolozzi of 1967; `[title not known]` covers 60 unrelated Gainsborough sheets.
Graph-wide the folded placeholder buckets are `untitled` 2,106, `no title` 1,667,
`title not known` 514, `composition` 89, `untitled composition` 47.

**5. An image-similarity key was probed for this job and rejected on measurement** (2026-09-10,
recorded in `find_duplicate_work_clusters.py`'s docstring). Over 400 pairs of distinct work nodes
sharing an artist, an identical distinctive title and genuinely different photographs, only 44%
score ≥0.98 on DINOv2, 65% ≥0.95, 75% ≥0.90; mean 0.927, minimum 0.595. The four *Animal Heads*
nodes score 0.921–0.976 pairwise, so no pair clears 0.98. DINOv2 embeds the photograph, not the
print.

## Decision

**1. Decompose the title string into typed components before naming anything.**
A work's `name` is the residue after the discriminators and citations are lifted out. Add to
`ConceptualWork`:

- `plateDesignation` — `3e planche`, `pl. 12`
- `state` — `2nd state`, `state III`

and route embedded citations to the existing `CatalogueEntry` nodes rather than leaving them in
the title. `seriesTitle` already exists and should be populated by every adapter, not just BM.

Without this step no alias scheme can work, because `…, 3e planche` and `…, 2e planche` are
indistinguishable as names while being different prints.

**2. The principal name is chosen by source precedence, not by vote alone.**

1. The catalogue raisonné's own title, once ingested. Not possible today — see *Not addressed*.
2. An institutional title (Tate, BM, Met), **excluding that institution's placeholders**.
3. Otherwise the most frequently asserted decomposed form across auction sources.

Tie-breaks, in order, reusing the rule `find_artist_merge_candidates.py` already applies to
artist names: prefer the form that **keeps its diacritics**; then the form with no embedded
citation; then the form with no lot-descriptive opener.

Where a work has an original-language title and a translation, the **original language is
principal** and the translation is an alias. This matches what the institutional sources here
already do and keeps the principal name stable when an English-speaking house omits the gloss.

**3. Aliases live in `ConceptualWork.alternateTitles: [String]`.**
This deliberately mirrors `Artist.alternateNames` rather than introducing a `(:Title)` node
model. Arrays lose language tags; that cost is accepted until multilingual search is an actual
requirement, at which point the array can be promoted without re-deciding the identity rules.

**4. The raw string stays on the record that asserted it: `Impression.sourceTitle`.**
Provenance belongs to the assertion, not to the merged work. This means merging four nodes into
one destroys nothing, a future ingest can match an incoming lot against what a house actually
called it, and "which house called it what" remains answerable. It is also the honest place for
the strings that are not titles at all — lot-descriptive openers and `Untitled (A0250 lot 70)`.

**5. Aliases are harvested by exactly two mechanisms.**

- **At merge time**, from the clusters `find_duplicate_work_clusters.py` already produces. Free;
  introduces no new signal and no new risk.
- **From a parenthetical gloss**, only where the parenthetical is ≥2 words **and in a different
  language from the head title**. A shape test is not sufficient and must not be used: of the
  13,508 parentheticals, sampled contents include `(The organza dress)` and
  `(Portrait of Felix Man)` — real aliases — alongside `(Black)`, `(Hand-Colored)`, `(Flax)`,
  `(Colour variant)`, `(Series I)`, `(Pl. LXXII)` and `(Station IV)`, every one of which is
  identity. Stripping parentheticals unconditionally is what corrupted the Stik colourways.

**6. `titleEmbedding` is never an identity trigger.**
It is present on 90,928 nodes and is permitted as a ranking or **dissent** signal only — the same
demoted role DINOv2 was given in decision 5 of the scan tooling. Title similarity as an identity
key is precisely the mechanism that merged six different Chagall Bible plates.

## Consequences

Tier-1 comps under [ADR-0016](0016-ackg-realised-prices-as-primary-comparables.md) get materially
better and materially safer at the same time. Better, because a work that today splits across
four nodes (Henry Moore's *Animal Heads*, 1975 — three Roseberys lots and the Tate impression)
resolves to one, so its realised prices land in one comp set. Safer, because *Le Chapeau
Épinglé*'s three plates stop looking like one title, which is currently a live mis-anchoring
risk: tier 1 matches on exact title within an artist, and 62 nodes share that title text.

Ingest adapters take on real work. Every one of them must decompose rather than store the lot's
title verbatim, and adapters disagree about where the discriminators sit in the string. Expect
the decomposition regexes to be as fragile as `catalogue_matching.py`'s citation parser, and to
need the same discipline: a confirmed-bad list extended only from real cases, never
speculatively.

The alias set becomes a matching surface, which is a new failure mode. An alias wrongly admitted
propagates: the next ingest matches against it, and the error compounds instead of staying local
to one node. This is the argument for keeping decision 5's two mechanisms narrow and for never
promoting `titleEmbedding` to a trigger.

## Not addressed

- **Ingesting catalogue titles.** This is the single highest-leverage fix and it is not in scope
  here. Until an entry carries a title, decision 2's first tier is inert and the principal name
  is decided by institutions and vote-counting. Sourcing and licensing for catalogue text has not
  been assessed at all.
- **No merge is authorised by this ADR.** `find_duplicate_work_clusters.py` remains scan-only.
  Which of its 7,640 proposed clusters are genuinely one work is a review question, and the 384
  catalogue conflicts and 550 one-institution-many-accessions clusters are explicit non-merges.
- **State modelling is left open.** Two states of one plate share an image and a matrix but are
  different objects to a cataloguer and to a buyer. Whether they are two `ConceptualWork` nodes,
  or one work with state-bearing `EditionRun`s, is not settled here; decision 1 only ensures the
  state stops hiding inside the title.
- **The language test in decision 5 is unspecified.** "Different language from the head title"
  needs an implementation and a measured error rate on short strings; nothing here has been
  calibrated.
- **566 Impressions still hang off two `ConceptualWork` nodes** (535 Roseberys, 31 British
  Museum), left by a catalogue-refs backfill. That is a bad backfill rather than a titling
  problem, and it is the structural cause of the comps fan-out that
  [ADR-0016](0016-ackg-realised-prices-as-primary-comparables.md)'s *Amendment 1* item 2 collapses
  per `SourceRecord`. It needs its own repair.
- **52 clusters are blocked behind split `Artist` nodes** and should be cleared by
  `find_artist_merge_candidates.py` before any title work touches them.
- **No backtest.** The valuation effect of correcting work identity is unmeasured, and
  `tests/backtest/compare.ts` compares against auction estimates, so it cannot attribute a change
  to this specifically.

---

## Amendment 1 — Decision 2's institutional tier must exclude ingest fallbacks, not just placeholders (2026-09-11)

Decision 2 ranks an institutional title above any auction title, "excluding that institution's
placeholders". Running the first two artist folds showed that exclusion is drawn too narrowly.

**What surfaced.** Of the 108 Rembrandt clusters folded on 2026-09-11, 25 took an institutional
title — the first time tier 2 fired at all, Picasso's 194 clusters having held zero institutional
records. All 25 produced names like:

```
A nude woman bathing with her feet in a brook; with the legs cut off above the ankles,
seated in frontal view, leaning o...
Christ carried to the tomb; counterproof. c.1645 Etching, with...
```

Median length 123 characters against 36 for the frequency tier, every one containing a `;`, and
8 of 25 carrying the medium inside the title.

**The first diagnosis was wrong and is worth recording as such**, because it would have produced
a bad rule. These are not a British Museum cataloguing convention: graph-wide, BM titles average
**25 characters with 3% containing a semicolon**, against Tate's 19 and the Met's 27. A
length-or-semicolon heuristic would have been fitted to 25 clusters and misfired everywhere else.

They are `bm_ingest.py`'s own documented graceful degradation. Line 612:

```python
"title": title or series or (description[:120] + "..." if description and len(description) > 120
                             else description) or f"Untitled ({object_id})",
```

For a BM record carrying neither an `Object:` title nor a `Series:` entry, the ingest substitutes
a truncated description — `description[:120] + "..."`, exactly 123 characters. **78 works
graph-wide** are in that state, 30 of them Rembrandt. The substitution is correct behaviour and
should stay: it is the same graceful-degradation principle doc 08 §4.1 sets out, and the comment
above that line records a real corruption it already prevented. The error is downstream, in
treating its output as an institutional *title* and ranking it first.

**Decision 2 is amended.** The institutional tier excludes, in addition to that institution's
placeholders, any title that is an **ingest fallback**. A fallback is identified by the exact
signature of the code that produced it, never by shape:

- length exactly 123 **and** ending `...` — `bm_ingest.py`'s `description[:120] + "..."`;
- matching `Untitled (<sale-code> lot <n>)` — `roseberys_ingest.py:219` and
  `forum_ingest.py:247`'s fallback, **1,493 works graph-wide**, by far the larger population.
  The BM line's own final `Untitled (<object_id>)` branch is also tested for but never actually
  fires: the description fallback catches those records first, and zero works match it.

Only the ID-shaped parentheticals. 2,818 works are named `Untitled (...)` and the overwhelming
majority are real descriptive titles — `Untitled (Nepal Relief)`, `Untitled (Self Portrait)`,
`Untitled (Natura Morta)` — which must survive untouched.

A cluster whose only institutional candidates are fallbacks falls through to tier 3 and is named
from the auction sources, which is the better title in exactly this case. The same exclusion
applies **within** tier 3, where the sale-lot fallbacks actually live — an auction cluster must
not be named `Untitled (A0305 lot 308)` when any member carries a real title. If every candidate
in a cluster is a fallback, the exclusion is lifted rather than leaving the work nameless.

**Why the signature and not the shape.** 137 titles end in `...`, but only those 78 are
fallbacks. The other 59 are genuine works whose titles really do end in an ellipsis — Tate holds
`Sounds Barely Heard ...`, `Someone, Somewhere ...`, `Both the Garden Style ...`. A bare
"ends with `...`" rule would demote all 59. Tying the test to the producing constant is the only
version that separates them.

**Accepted brittleness.** The `123` is `bm_ingest.py`'s `120` plus three dots. If that constant
changes, this test silently stops matching and caption titles start winning tier 2 again. The
honest fix is for the ingest to mark the substitution explicitly — a
`ConceptualWork.titleIsFallback` boolean, or not writing the description into `name` at all and
letting `rawDescription` carry it — at which point this rule should be replaced rather than
retuned. Not done here because it is an ingest change requiring a re-run, and the 78 affected
works do not justify one on their own.

**What this does not fix.** The under-merge stays: `Woman Bathing her Feet at a Brook` (auction)
and `A nude woman bathing with her feet in a brook; ...` (BM fallback) are the same print in two
clusters, because their normalized titles differ and the exact key never proposes them. Only
Decision 1's decomposition, or an ingested catalogue title, closes that.
