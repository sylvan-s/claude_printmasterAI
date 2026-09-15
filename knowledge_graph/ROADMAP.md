# ACKG roadmap — planned, not started

Deferred data-quality/identity-resolution work found during other tasks, logged here rather
than swept into automatically (per this project's "don't auto-run a broad sweep" discipline).
Each entry names what was found, why it isn't fixed yet, and what already exists to build on.

---

## Consolidate `CatalogueRaisonne.numberingPrefix` in the graph itself

**Found:** 2026-09-15, while comparing Picasso's graph-cited catalogue count against the
real-world ~2,400-print oeuvre. Picasso alone cites catalogue names under roughly **160
distinct `numberingPrefix` strings** for what are really about 6-8 actual catalogues —
`Bloch`/`B.`/`Block`/`BLOCH`/`Boch`; `Baer`/`Ba.`/`Bear`; `Mourlot`/`M.`/`Moulot`/`Mourlout`;
`Czwiklitzer`/`Cz.`/`CZW`/`Czw`/`Cwicklitzer`/`Czwiktlitzer`; `Geiser`/`Gesier` — plus dozens
of one-off compound strings (`"Bloch 183, Baer 342"`) that should have parsed as two
citations, not one catalogue name. This inflates every "how many distinct works does the
graph know about" query and fragments `CatalogueRaisonne`/`CatalogueEntry` nodes that should
be one.

**Why it's not fixed already:** `catalogue_prefix.py` (built 2026-09-13, for exactly this
problem — its own docstring cites "2,319 prefixes... 1,486 with a single entry") only ever
canonicalises at READ time, inside `fit_splink_work_identity.py`'s own key-building. Its
docstring is explicit: *"NOTHING IS WRITTEN TO THE GRAPH."* It is not imported by
`catalogue_matching.py` or any `*_ingest.py` adapter, so every ingest keeps writing the raw,
unfolded prefix string, and the fragmentation just keeps growing.

**What already exists to build on:**
- `catalogue_prefix.py` — `fold_prefix()` (tier 1, mechanical: lowercase alphanumerics) and
  `canonical_prefix()` (tier 2, table-driven abbreviation lookup, per artist)
- `catalogue_prefix_aliases.csv` — 85 evidence-backed rows (one prefix dominates with ≥3
  shared works and ≥5x the runner-up, generated per artist so an ambiguous initial like
  Picasso's `B.` — Bloch by 82 shared works, Baer by 8 — never gets merged into the wrong
  catalogue). 4 Picasso rows already in the table: `B.`→Bloch, `Ba.`→Baer, `Cz.`→Czwiklitzer,
  `M.`→Mourlot.
- `check_catalogue_prefix_aliases.py` — regression guard: the alias table must stay
  unambiguous/acyclic (no transitive-closure merging of two real catalogues through a shared
  initial — the Cramer-30 corruption class), and canonicalisation must never destroy an
  already-agreeing key pair.

**What's still missing, and is the actual job:**
1. A real merge primitive for `CatalogueRaisonne`/`CatalogueEntry` nodes — moving `CONTAINS`
   and `DOCUMENTS` edges from the folded node onto the survivor, same shape as
   `merge_artists.py`'s `MERGE_PAIR` but for this node type (none exists yet).
2. Coverage for the **misspelling class** the alias table doesn't touch (`Block`, `Boch`,
   `Bear`, `Moulot`, `Mourlout`, `CZW`, `Cwicklitzer`, `Gesier`, ...) — genuinely different
   from the abbreviation class the table was built for, and cannot reuse its dominance-check
   generation as-is without a review pass, since a plain edit-distance/fuzzy approach is
   exactly the kind of matching this graph's catalogue identity has been corrupted by twice
   already (see `catalogue_matching.py`'s own docstring).
3. A pass over the compound-citation strings (`"Bloch 183, Baer 342"` parsed as one
   catalogue) — likely a `catalogue_matching.parse_catalogue_refs()` comma-splitting gap on
   these specific source rows, not something `catalogue_prefix.py` can fix at all since it
   operates on an already-split prefix.
4. Decide whether the fix applies going forward only (wire `canonical_prefix()` into
   `catalogue_matching.py`'s key-building so new ingests stop adding fragmentation) or also
   backfills the existing graph (a `merge_catalogue_prefix_aliases.py`-style one-off, run
   per-artist through the same evidence/dominance discipline, with a pre-snapshot before any
   `DETACH DELETE`).

**Scope discipline for whoever picks this up:** same rules `catalogue_prefix.py`,
`check_catalogue_prefix_aliases.py` and `catalogue_matching.py` already established — no
transitive closure across aliases, no fuzzy/edit-distance matching without an evidence-backed
dominance check per artist, under-merge rather than risk a false fold. Not a quick sweep.
