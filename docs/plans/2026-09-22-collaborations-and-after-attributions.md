# Collaborations and "after" attributions as structure, not artist names: scope

**Status:** scoped 2026-09-22. Nothing built; **no graph writes.** Every write step needs a
go-ahead, and the pricing step needs its own.

## Why

Labelling the merge agent's gold set showed that the hardest pairs are not "same or different".
One node **contains** the other:

- `Pablo Picasso` vs `Paul Eluard and Pablo Picasso` (a collaboration)
- `Francis Frith` vs `Francis Holl after William Powell Frith` (an engraver working after a
  designer)

Neither *same* nor *different* is true, and 13 of the 26 collaboration-name pairs were labelled
*unsure*. The cause is structural. An auction catalogue writes a multi-person credit as one
string, and the ingest makes that string one Artist node.

## What the graph holds today (measured 2026-09-22)

| Shape | Count | Notes |
|---|---|---|
| Works with 2+ `CREATED` artists | 176 (up to 20 on one work) | The graph *can* already carry several makers per work |
| SourceRecords `ATTRIBUTED_TO` 2+ artists | 178 | Likewise |
| `ATTRIBUTED_TO {qualifier: 'after'}` | 4,585 | "After X" is already modelled at the **record** level and used by pricing (BLEND-1.10: per-artist after factor, excluded from direct comps) |
| `CREATED` edge properties | **none** | No role (designer, engraver, author) anywhere |
| **Artist nodes named as a collaboration or "after" credit** | **351** | 1,031 records (658 priced), 808 works, 6 with price priors |

The 351, classified by rule. This is a rough first pass, and Phase 1 refines it:

| Class | Nodes | Priced records | Example |
|---|---|---|---|
| after: engraver + designer, designer **not** a node | 110 | 100 | `A Legrand after J B Huet` |
| after: engraver + designer, designer **is** a node | 40 | 39 | `David Lucas after John Constable` |
| after: `After X`, no engraver named | 1 | 0 | `After Hans Holbein the Younger` |
| collab: no member is a node | 82 | 179 | `A Poiteau and P Turpin` |
| collab: some members are nodes | 79 | 115 | `Ai Weiwei & Yang Lian` |
| collab: every member is a node | 28 | 220 | `Andy Warhol & Jean-Michel Basquiat` |
| publisher/printer string | 7 | 3 | `Publisher: Bowles & Carver` |
| workshop / circle | 3 | 2 | `Andrea Mantegna And Workshop` |
| parser artefact | 1 | 0 | `Grouped with line 22. Giacomo Manzú` |

**Where they come from:** Bonhams (97 after, 88 collab), Swann (54 after), Roseberys (61
collab) and Forum (50 collab). Museum sources rarely produce them, because they already record
makers with roles.

**Also found:** `SourceRecord` keeps **no raw artist string**. So once a node is merged or
decomposed, what the catalogue actually printed is lost. This affected Phase 0 too: a merged
pair's evidence cannot be recovered from the live graph.

---

## Target model

The principle is the same one that makes `POSSIBLE_SAME_AS` safe: **existing readers must not
change meaning silently.** Every price, comp and prior query reads `CREATED`. Putting a Reynolds
mezzotint on Reynolds' `CREATED` would make it a Reynolds comp without anyone deciding that. So
new relationships get new types, and readers opt in.

```
(:Artist)-[:CREATED]->(:ConceptualWork)             the maker, unchanged: engraver of an 'after' print,
                                                    each co-creator of a genuine collaboration
(:Artist)-[:DESIGNED]->(:ConceptualWork)            NEW: the 'after' artist (invenit/pinxit/delineavit)
(:Artist)-[:MEMBER_OF]->(:Artist {kind:'group'})    NEW: a persistent group with its own identity
(:ConceptualWork)-[:PUBLISHED_BY]->(:Publisher)     exists; publisher strings move here
(:SourceRecord {artistAsCatalogued})                NEW property: the credit string exactly as printed
```

| Class | Becomes |
|---|---|
| after, engraver + designer | engraver `CREATED` the work; designer `DESIGNED` it; the combined node dissolves. The record keeps `ATTRIBUTED_TO {qualifier:'after'}` to the designer, which pricing already reads |
| collab, ad hoc (two people on one work) | each member `CREATED` the work; the combined node dissolves |
| collab, persistent group (Gilbert & George, Allora & Calzadilla, Connor Brothers) | stays one Artist node with `kind:'group'`; members `MEMBER_OF` it |
| publisher string | `PUBLISHED_BY`; the Artist node dissolves |
| workshop / circle | the master, with the existing qualifier (`circle_of`…); the node dissolves |
| parser artefact | to the real artist (the malformed-names repair path) |

**How a group is recognised:** ULAN's `agent_type` is `corporate body`, a known duo list, or a
reviewer's call. It is never inferred from the `&` alone. Warhol & Basquiat is two people;
Gilbert & George is one practice.

**Dissolving uses the existing guards.** A decomposition is not a merge, but it does delete a
node, so it writes a `MergeEvent`-style record: `rule: 'decomposed'`, pointing at the
members/designer. The resolver can then send a re-ingested combined string to the right place,
and `check_merges_not_undone.py` catches it coming back.

---

## "After" when the name does not say so

The rule above handles credits that literally say *after*. The harder case is a record crediting
only the engraver (or only the designer) for a reproductive print. The clues:

| Signal | What it can do | Caveat measured here or earlier |
|---|---|---|
| **Dates**: designer active before or during the engraver | Rules out impossible orderings; a strong negative when the engraver predates the designer | Necessary, not sufficient. Of 7 dated after-pairs, the engraver was born later in 5, but 2 were contemporaries (Marcantonio after Raphael is the classic case) |
| **Work-level image match**: the print's DINOv2 nearest neighbours are the designer's works, or other prints after them | The strongest signal. Reproductive prints copy a specific composition, and DINOv2 is an instance matcher (AUC 0.977 on dedup) | The designer's paintings are mostly not in this corpus; matches will be other prints after the same design |
| **Artist-level subject / CLIP similarity** between engraver and designer | Supporting evidence | A reproductive engraver works after *many* designers, so their oeuvre is diluted. The 2026-09-19 poster probe found CLIP "theme" similarity was generic poster-likeness that a placebo matched too, so it needs a placebo control (random same-period pairs) |
| **Text**: `after`, `d'après`, `nach`, `pinxit / sculpsit / invenit / fecit / del. / sc. / exc.` in title, medium or inscription | Cheap, exact, and often present | Parse, don't fuzzy-match |
| **ULAN**: printmaker vs painter roles; the local mirror's bio | Prior on who designs and who engraves | Missing for most engravers here (110 of the 150 designers aren't nodes) |

These become features of the merge agent's model and a separate *reproductive-print detector*.
Its output is a proposed `DESIGNED` edge for review, never an automatic write.

---

## Merge-agent integration

- The gold-set page now has two relation labels, **Collaboration** and **After**. The 41 pairs
  with collaboration or after names are queued for re-review.
- Relation-labelled pairs are a **separate class**. They are excluded from same/different
  precision and from LLM calibration, and the agent routes them to the decomposition queue.
  They never become a merge or a rejection.
- `POSSIBLE_SAME_AS` keeps its vocabulary. A decomposition proposal is its own record, not a
  new edge status.

## Pricing impact (needs its own decision)

- **After nodes:** 139 priced records currently sit on 150 combined nodes with no priors. Their
  designer's after-pool and the engraver's corpus never see them. Decomposition moves them into
  both, which is what the after factor was built for.
- **Collaboration nodes:** 514 priced records. The open question is whether a co-created
  Warhol & Basquiat sale should count as a Warhol comp. That needs a rule, probably its own
  factor, or exclusion from direct comps as with *after*.
- **6 nodes carry priors,** and a priors rebuild follows any decomposition.

Per the standing rule, nothing that feeds live prices changes without your approval of that step.

## Phases

| Phase | What | Writes? |
|---|---|---|
| 1. Classify | All 351 nodes: rules first, Haiku for the residue, then a reviewed CSV (class, members/designer, group or not) | no |
| 2. Schema and guards | `DESIGNED`, `MEMBER_OF`, `kind:'group'`, `SourceRecord.artistAsCatalogued`. Merge functions carry the new edges; guards; § 14 in the schema doc | code only |
| 3. Backfill `artistAsCatalogued` | From the combined node names before anything dissolves | graph write, ask |
| 4. Decompose | Per class, dry run then apply, each dissolved node leaving a `decomposed` record | graph write, ask |
| 5. Ingest | Bonhams / Swann / Roseberys / Forum parsers split credits at load and resolve through the decomposition records. This overlaps the Roseberys multi-work-lots branch | code |
| 6. Pricing | Decide how co-created and after sales count, then rebuild the priors | ask |
| 7. Unmarked-after detector | A probe: dates + DINOv2 instance match + CLIP with a placebo, scored on the relabelled gold pairs | no; proposals for review |

## Open decisions

1. `DESIGNED` as a new relationship type (recommended), or a `role` property on `CREATED`. A
   role property silently changes every `CREATED` reader.
2. The group test: ULAN `corporate body` plus a reviewed list, or also let the LLM propose.
3. Whether co-created works count as comps for each member.
4. Phase 5 before or after the Roseberys multi-work-lots branch lands.
