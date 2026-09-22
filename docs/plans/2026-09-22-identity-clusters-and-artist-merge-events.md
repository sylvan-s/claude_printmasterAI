# Identity clusters (`POSSIBLE_SAME_AS`) and Artist `MergeEvent` — scope

**Status:** scoped 2026-09-22. **A1 + A2 built 2026-09-22** (code only, no graph writes; see the schema doc, § 11.1). **A3 applied 2026-09-22**: 271 backfilled events from 18 snapshots (0 conflicts; 4 unresolved, Canaletto still split three ways). Merges with no snapshot (2026-09-06 case-dedup, 2026-09-05 manual, 2026-09-10 Roseberys 40) remain unrecorded. **A4 applied 2026-09-22**: 26 merges via `merge_artists.py pairs` (`artist_reappeared_names_pairs_2026-09-22.csv`): 17 same-person pairs, Van Gogh (the 9-work node carried ULAN 500337743, his uncle the art dealer; folded into the 500115588 node), Canaletto 3 -> 1, and 6 Roseberys multi-work-lot wrapper nodes into Mr Brainwash / Connor Brothers / Richard Wentworth. Bearden born 1914 -> 1911 (ULAN) and Peri 1971 -> 1899 (after his death) with superseded values kept; 'Sandy Sykes' removed from Janet Elizabeth Turner's aliases (two people, one shared Met work). Re-appeared-name count now 0. Part B is open. Every write step below
needs an explicit go-ahead.

## Why

The graph records merges that happened, and nothing else about identity:

- `(:MergeEvent)-[:MERGED_INTO]->(:ConceptualWork)`: 8,881 events. Every one targets a
  ConceptualWork.
- **Artist merges leave no trace.** No Artist carries merge properties, and there is no event
  node. The only record is in presnapshot JSONs, CSVs and git history.
- **Held-back candidates are not in the graph.** Spelling variants with plurals held, Splink
  band-B B4, token-subset names, `needsVision` poster pairs and triage holds all live in CSVs.
  Many are gitignored and regenerable, so they are not queryable and not durable.

## Finding made while scoping: Artist merges can be undone the way work merges could

Every ingest (`bonhams`, `roseberys`, `forum`, `swann`, `tate`, `met`, `bm`, `navigart`,
`picasso_paris`: 13 sites) does `MERGE (a:Artist {name: row.artistName})`. There is no
merged-name resolver. When a merge folds "Romare Howard Bearden" into "Romare Bearden", the
absorbed name goes into `alternateNames`. The next Swann re-ingest carrying that spelling then
creates a fresh node, silently. This is the same failure `check_merges_not_undone.py` guards
against for works, where all eight ingests had it until 2026-09-13.

Live check: **22 Artist nodes currently carry a name that is also the `name` of another live
Artist.** Examples: `Romare Bearden <- Romare Howard Bearden`, `Cecil Beaton <- Cecil Walter
Hardy Beaton`, `Stefano della Bella <- Stefano Della Bella`, `Théophile Alexandre Steinlen <-
Theophile Alexander Steinlen`. Some of these may be merges that were undone. Others, like
`Janet Elizabeth Turner <- Sandy Sykes`, look like alias pollution. They have not been
investigated; they are logged here per the defer-broad-sweeps rule.

This makes the Artist MergeEvent more than an audit nicety: **it is the thing a resolver would
look up.** `alternateNames` cannot do that job, because ingests also append raw display names
to it. A merged-away name and a mere display variant are indistinguishable there.

---

## Part A — Artist `MergeEvent`

### Shape

Reuse the label. Do not invent a new one; the rule vocabulary and the reader code already
exist. `§ 11` of `08_ackg_schema_definition.md` gets an Artist subsection.

```
MergeEvent {
  id,               # "<survivorName> <- <deletedName>" at fold time (never rewritten)
  subject: 'Artist',  # NEW, also backfilled onto the 8,881 work events as 'ConceptualWork'
  mergedFromName,   # the deleted node's name: THE lookup key (Artist has no stable id)
  mergedFromUlan,   # its ulanUrl if it had one
  mergedFromWikidata,
  mergedFromDates,  # "born-died" as it stood, since the survivor coalesces over them
  survivorNameAtMerge,  # survivor's name before any keepName rename
  rule, ruleVersion, decidedBy, evidence, confidence, repointedFrom, at
  backfilled,       # true on events reconstructed after the fact (Phase A3)
}
MergeEvent -[:MERGED_INTO]-> Artist
```

**Artist has no stable id.** Its identity key is `name`, and names change on a `keepName`
rename and on `ARTIST-NAME-REPAIR`. So the survivor must be found **by the edge, never by
`id`**. `mergedFromName` is the key a resolver or stale reference looks up.

Rule vocabulary, taken from the paths that exist:

| `rule` | `ruleVersion` | writer |
|---|---|---|
| `caseFold` | `CASE-DEDUP-1.0` | `merge_case_duplicate_artists.py` |
| `ulanCanonical` | `ARTIST-MERGE-3.x` `ulan-canon` | `merge_artists.py` |
| `nameNormalised` (B1) | `ARTIST-MERGE-3.x` `band-b` | `merge_artists.py` |
| `nameNormalisedDateDispute` (B2) | same | same |
| `nameFuzzyImageCorroborated` (B3) | same | same |
| `aliasShadowing` / `humanPairs` | `ARTIST-MERGE-3.x` `pairs` | `merge_artists.py` |
| `junkRepoint` | — | `repoint_junk_artist_works.py` |
| `malformedNameRepair` | `ARTIST-NAME-REPAIR-1.0` | `fix_malformed_artist_names.py` |
| `kmIdentityRepair` | — | `repair_km_artist_identity.py` |
| `legacyCandidateMerge` | — | `find_artist_merge_candidates.MERGE_QUERY` (should be retired; it drops two edge types) |

### Phases

**A1. Write events going forward (code only).** Extend `MERGE_PAIR` so it creates the event
**in the same transaction, before the `DETACH DELETE`**, as the work merger does. It should
also re-point any inbound `MERGED_INTO` on the dup onto the survivor and append to
`repointedFrom`. Add `MergeEvent` to the survivor's `HANDLED_TYPES` handling so
`assert_transferable` doesn't refuse it. Then route the other five Artist `DETACH DELETE`
sites through `merge_pair`, or delete them. *Test:* a dry-run fixture merge on a scratch
database; chained fold A→B→C leaves both events on C.

**A2. Resolver and guard.** Add `resolve_merged_artist_cypher(nameExpr)` next to
`catalogue_matching.resolve_merged_work_cypher`. It resolves by exact `mergedFromName` lookup
before the `MERGE` and follows the edge to the current survivor. Splice it into the 13 ingest
sites. Extend `check_merges_not_undone.py` with two checks: no Artist `MERGE` without the
resolver, and no live Artist whose `name` equals a MergeEvent's `mergedFromName`. This is an
exact lookup of a decision already made, so it does not weaken the no-fuzzy-matching rule.

**A3. Backfill history (graph write, ask first).** Reconstruct events from the presnapshot JSONs
(`band_b_*`, `ulan_canon_*`, `artist_pairs_*`, `km_artist_repair_*`), the CASE-DEDUP run, the
Splink band A+B run (237 pairs) and the alias-shadowing 25. Mark them `backfilled: true` with
whatever evidence the snapshot holds. Coverage will be partial: the 2026-09-06 case-dedup ran
as inlined Cypher. Report the count reconstructed against merges known from memory/ROADMAP;
don't claim completeness.

**A4. Triage the 22 re-appeared names** (separate task). Split them into undone merge → re-merge
through A1, alias pollution → remove the bad `alternateNames` entry, and genuinely different →
leave.

### Effort and risk

A1 and A2 are code changes of about a day, with the usual "verify every consumer of moved
code" grep. A2 touches all ingests; a differential re-ingest dry run on one house should show
zero new Artist nodes. A3 is a one-off write, about 1–2k nodes. Risk is low: event nodes add
information and don't change any existing edge.

---

## Part B — `POSSIBLE_SAME_AS`

### Shape

```
(:Artist)-[:POSSIBLE_SAME_AS {
    rule, ruleVersion,      # which generator proposed it
    score,                  # its own number (splink weight, cosine...); name the scale in `scoreKind`
    scoreKind,
    evidence,               # one line, same composition style as MergeEvent.evidence
    heldBecause,            # why it was NOT merged: 'pluralRule', 'B4 thin sample', 'tokenSubset<0.90'...
    status,                 # 'open' | 'rejected' | 'promoted'
    decidedBy, decidedAt,   # set when status leaves 'open'
    proposedAt
}]->(:Artist)
```

The same shape applies between `ConceptualWork` nodes.

- **One edge per unordered pair**, stored lower-id → higher-id so re-runs `MERGE` to the same
  edge. Queries treat it as undirected.
- **`rejected` is kept, not deleted.** A "these are different" verdict is the most expensive
  thing a human or model produces here, and it stops the next scan re-proposing the Calder
  trap. The edge becomes a durable negative.
- **`promoted`** edges disappear with the merge, because the dup is deleted. The MergeEvent
  takes over. Its `evidence` should cite the edge's rule and score so the path is traceable.

### Who writes it

Only scans that *hold back* candidates. A proposal that would have merged anyway goes straight
to merge. Initial writers:

| Generator | Subject | What gets an edge |
|---|---|---|
| `merge_artists.py band-b` | Artist | B3 below the image floor, B3b, B4 |
| `find_artist_candidates_by_shared_image.py` | Artist | `refusedBecause` rows (`artist_image_candidates.csv`, 125) |
| spelling-variant scan (SPELLING-VARIANT-1.0) | ConceptualWork | plural-rule and image-gate holds |
| `rank_title_collisions.py` | ConceptualWork | ranked but below the band |
| `reconcile_poster_conceptual_works.py` | ConceptualWork | `needsVision` / held routes |

`splink_poster_merge_candidates.csv` (23.6k rows) is **not** loaded wholesale. Most rows are
not candidates in any real sense, and the edge only means something if a generator decided the
pair was *close enough to hold*. Each generator gets a `--write-held` flag, default off.

### Who reads it

Readers are opt-in. This is deliberate: the reason merging beats clustering is that consumers
don't have to know about clusters, and that stays true.

- **Review queue**: `MATCH ()-[p:POSSIBLE_SAME_AS {status:'open'}]->() ...`, ordered by
  rule/score. It replaces reading scattered CSVs.
- **Scan dedup**: every candidate generator skips pairs that already have a `rejected` edge.
- **Optional, later:** Stage 3 comps *could* surface open-cluster sales as a flagged "possibly
  the same work" line in the waterfall, visible but not priced in. Out of scope here; it feeds
  live price predictions and needs its own ask.

**Not** readers: the price-model export, the priors, and the Stage 3 same-work comps tier.
They keep reading merged nodes only.

### Phases

**B1. Schema + writer helper.** `identity_candidates.py` with `write_held(sess, subject, pairs)`
and `set_status(...)`. Add a schema doc section. Add an index on the relationship `status`
(Neo4j 5 relationship property index), or scan by label as usual.

**B2. Backfill open holds from current scan outputs (graph write, ask first).** Re-run the five
generators in dry-run with `--write-held`, review the counts, then write. Expected order of
magnitude: low thousands of edges.

**B3. Status workflow.** Add a `merge_artists.py pairs`-style reviewed CSV →
`promote`/`reject`. Promote calls the existing merge primitive, so the MergeEvent is written
there.

**B4. Guard.** Add a `check_identity_candidates.py` that fails on an `open` edge whose
endpoint no longer exists (should be impossible because DETACH DELETE removes it, so this
catches a writer bug), a pair carrying both a MergeEvent and an open edge, or duplicate edges
per pair.

### Effort and risk

About a day for B1+B3+B4, plus half a day per generator for the `--write-held` flag. The graph
write in B2 is additive. The main risk is **an edge being read as identity by a future query
that forgets to filter `status`**. Mitigation: the name says *possible*, the schema doc says
readers are opt-in, and the guard can grep for `POSSIBLE_SAME_AS` in consumer code outside the
allow-list.

---

## Order

1. **A1 + A2** first: they close a live correctness hole (merges undone by re-ingest).
2. A4 triage of the 22.
3. A3 backfill.
4. Part B.

## Open questions

- Should the 8,881 existing work events get `subject: 'ConceptualWork'` backfilled, or should
  readers infer it from the target label? Backfilling is cleaner, costs one write, and needs an
  ask.
- Retire `find_artist_merge_candidates.MERGE_QUERY` outright? It moves only 3 of 6 edge types.
- Is B's negative-evidence use (`rejected`) wanted for works too, or only for artists, where
  the Calder-style trap is real?
