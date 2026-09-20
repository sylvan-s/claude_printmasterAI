# How we read source data

The corpus of what we know about handling data from each source: what each one does that no
other does, which rule reads it, and what has already gone wrong. The point is that this can be
**interrogated** — by source or by question — and **applied consistently** when a new source or
a new field arrives, instead of being rediscovered per ingest.

It is deliberately not a model-accuracy document. Most entries here are correctness, not
precision: a rule that reads an inch fraction as an edition of 8 is wrong whether or not the
model notices.

Three views of the same corpus:

- **[By source](#by-source)** — start here when adding or debugging one source.
- **[By rule family](#by-rule-family)** — start here when adding a rule. One family is one
  question asked of catalogue prose; the shape they follow is
  [ADR-0020](adr/0020-shared-parsing-rule-modules.md). If the question already has a family,
  extend it; do not add another implementation of it.
- **[Guards](#guards)** — the executable half. Each exists because of a specific silent defect.

**Status: about a third built.** Two of six families have a shared module. The other four are
still one implementation per source, which is the condition this corpus exists to end.

## By source

What each source does that the others do not. "Defects" are ones that reached the graph.

| source | reads | house quirks and defects | guards |
|---|---|---|---|
| **Bonhams** (+ Skinner, same adapter) | `bonhams_parsing.py` → `bonhams_ingest.py` | API `gbp_*_estimate` holds the **sold price** post-sale, not the estimate (54,890 rows repaired). Artist field can **lead with a parenthetical** (`(n/a) Andy Warhol`), blanking the name and poisoning nationality/dates. Roman-numeral impression numbers. Suffixed edition numbers (`48/50A`, `14/250P`). | `check_bonhams_estimate_gbp.py`, `check_bonhams_name_parsing.py` |
| **Swann** | `swann_parsing.py` → `swann_ingest.py`, **shares Bonhams' edition rule** | Sells drawings and unique works alongside prints. Aliased artist names created **shadow duplicate** Artist nodes (Joan Miró); the exact-first resolver picks them. Hammer is derived, not given. | — (resolver guard still open) |
| **Roseberys** | TypeScript `benchmark/src/roseberys/parse.ts` → `roseberys_ingest.py` | Edition size comes from the **TS extract column**, not the Python rule. Nationality on its own line, title terminated with `;`, dimensions in **cm**. Multi-work lots. **Suspected height × width transposition — unconfirmed, blocks the dimensions family.** | `check_roseberys_estimate_gbp.py`, `check_roseberys_dimensions.py` (on `fix/ingest-dims-copytype`) |
| **Forum** | TypeScript `benchmark/src/forum/parse.ts` → `forum_ingest.py` | Dimensions in **mm**, not cm. Read inch fractions as edition sizes (`25 1/2in` → 2), 1,442 priced sales mis-banded. **Sale dates missing on all 6,228 sold+priced rows**, so the comps query silently drops them. Edition text lives in `edition_note`, not `rawMedium`. | `check_forum_edition_fractions.py`, `check_forum_sale_dates.py` |
| **King & McGaw** (retail) | `king_mcgaw_fetch.py` → `king_mcgaw_ingest.py` | Retail, not auction: **must stay out of price, edition and image evidence** (`originalVerified`, `limited_edition_poster`). Throttles at 8 workers and serves **degraded 200s**. Its ULAN assignments were wrong often enough to need an audit. | `check_poster_evidence_isolation.py` (on the KM branch) |
| **Museums** (Met, BM, Tate, Navigart, Picasso Paris) | per-source ingests | No prices — reference and image evidence only. Navigart's `tirage` carries **bare fractions** (`/30`) with different semantics from auction edition text. Titles: merged works keep the **catalogue raisonné** title, not the museum's. | `check_conceptual_work_title_property.py` |

### Cross-source rules

These are not house concerns and must never be forked per source: Getty ULAN URL form
(`check_ulan_url_canonical.py`), catalogue-prefix canonicalisation
(`check_catalogue_prefix_aliases.py`), page-form citations (`check_page_form_citations.py`),
honorifics and post-nominals (`src/shared/text_extraction.ts`), merges not being undone by a
re-ingest (`check_merges_not_undone.py`).

## Adding a new source

The checklist this corpus exists to make possible. Work it in order.

1. **Read [By source](#by-source) first.** Most "new" quirks are a quirk another house already
   has. Pick the closest existing adapter and say in the module docstring which one and why.
2. **Route every rule family through its shared module.** A new adapter must not define its own
   `detect_copy_type` or edition regex. Where a family is still unformed, extend the closest
   existing implementation rather than adding another.
3. **Establish what the source means by each field before parsing it.** The Bonhams estimate bug
   and the Navigart `tirage` fractions were both semantic, not syntactic: the regex worked, the
   field did not mean what it looked like.
4. **Add the source's cases to the family fixture corpora**, with the `why` filled in.
5. **State the units and the field-of-record** in the module docstring — cm against mm, which
   field holds the edition text, whether the price is hammer or premium-inclusive.
6. **Write the guard when the rule is adopted, not after the incident.** Every guard listed here
   exists because something broke first.
7. **Add a row to [By source](#by-source).** An undocumented source is the state this corpus
   exists to end.

## By rule family

| rule ID | question | Python | TS mirror | fixtures | guards |
|---|---|---|---|---|---|
| `COPY-TYPE-1.1` | proof class: AP / HC / PP / BAT / TP / numbered | `knowledge_graph/copy_type.py` | `src/appraisal/knowledge_graph/price_attrs.ts` `detectCopyType` | — | `check_copy_type_bat.py` |
| `EDITION-SIZE-1.1` | declared size of the run | `knowledge_graph/edition_size.py` | `src/shared/text_extraction.ts` `detectEditionSize` (narrow), `price_attrs.ts` `editionSizeOf` (wide) | `tests/fixtures/edition_size.jsonl` | `check_edition_thousands.py`, `check_forum_edition_fractions.py` |
| *(unformed)* | signed / signature class | `bonhams_parsing.detect_signed`, `train_price_model.signature_class` | `price_attrs.ts` `signatureClass` | — | — |
| *(unformed)* | dimensions | per-house | `text_extraction.parseDimensions`, `forum/parse.ts` | — | `check_roseberys_dimensions.py` |
| *(unformed)* | catalogue raisonné refs | `catalogue_matching.py` | `text_extraction.extractCatalogueRefs` | — | `check_catalogue_prefix_aliases.py` |
| *(unformed)* | artist qualifier (`after`, `attributed`, `circle`) | per-ingest | `ArtistQualifier` in both benchmark parsers | — | — |

`COPY-TYPE-1.1` is on `fix/ingest-dims-copytype`, not yet merged to trunk, and its graph repair
has already been applied — code and graph are out of step until it lands.

**Not a family:** `picasso_paris_ingest.extract_edition` reads bare `/30` fractions from
Navigart's `tirage` field. Different input, different semantics — see ADR-0020.

## Running the fixture runners

Both read `tests/fixtures/edition_size.jsonl`. Both must pass.

```bash
npm run test:edition-size && npm run test:edition-size-py
```

`EDITION-SIZE-1.1` keeps **two** rules, deliberately unreconciled: `size_from_text_ingest`
(bonhams + swann ingests) and `size_from_text_model` (the price model and, mirrored,
`price_attrs.ts`). They still disagree: `one of N`/`approx` are model-only, and the model's trailing `\b` loses
suffixed edition numbers (`48/50A`, `20/25"`) that the ingest rule reads. The table is in
ADR-0020 and asserted in `knowledge_graph/edition_size_test.py`.

## Guards

Every guard below exists because of a specific silent defect, and its docstring records the
incident and the row count. They are the executable half of this index; a guard that stops
matching reality fails loudly, which is why they have not drifted the way prose has.

```bash
set -a; source knowledge_graph/.env; set +a && python3 knowledge_graph/check_edition_thousands.py
```

`check_bonhams_estimate_gbp.py`, `check_bonhams_name_parsing.py`, `check_catalogue_prefix_aliases.py`,
`check_conceptual_work_title_property.py`, `check_edition_thousands.py`,
`check_forum_edition_fractions.py`, `check_image_embedding_properties.py`,
`check_merges_not_undone.py`, `check_page_form_citations.py`, `check_price_priors_fresh.py`,
`check_roseberys_estimate_gbp.py`, `check_ulan_url_canonical.py`, `check_wikidata_coverage.py`

## Scope of this index

Parsing families only. The wider rule-ID namespace — `BLEND-*` (valuation blend),
`PRICING-PRIORS-*`, `ARTIST-MERGE-*`, `KM-*`, and roughly forty others — is recorded in ADRs and
commit messages but is not indexed here yet. Those are decisions and repairs rather than parsing
rules; indexing them is a separate job.

---

## Next steps

Written 2026-09-20. **The objective is corpus coverage and interrogability, not model accuracy.**
A family is "done" when one module holds the rule, a fixture corpus binds its mirrors, a guard
defends it, and the source rows in [By source](#by-source) point at it — not when a gate score
moves. Ordered by evidence, not appeal.

### Land what exists

1. **`fix/ingest-dims-copytype` → trunk.** `COPY-TYPE-1.1` plus the Roseberys dims repair. Trunk
   is merged into it and it now merges back cleanly; typecheck and six price/valuation suites
   pass. Its graph repair has **already been applied**, so code and graph stay out of step until
   this lands. Nothing else should be started on this family first.
2. **`feature/shared-parsing-rules` → trunk.** `EDITION-SIZE-1.0/1.1`, ADR-0020, this index, the
   fixture corpus, the applied graph repair and the rebuilt model. Note it carries a live
   calibration change (BLEND-2.4) whose weight shifts come from graph growth, not from the
   repair — see ADR-0020.

### Close the corpus gaps

These are the coverage holes, and they matter more than any single rule fix:

- **Four of six families are still one implementation per source** — signature class, dimensions,
  catalogue refs, artist qualifier. That is the condition this document exists to end.
- **Only one family has a fixture corpus.** `tests/fixtures/edition_size.jsonl` is the only place
  two languages are held to the same cases. Every family needs one.
- **[By source](#by-source) is hand-maintained and will rot.** Nothing checks that an adapter's
  row matches what it does. The cheapest fix is a test asserting every `*_ingest.py` has a row.

### Next rule families, in order

3. **Signature class.** `bonhams_parsing.detect_signed`, `train_price_model.signature_class`,
   `price_attrs.ts signatureClass`. Feeds the price model, has a parity argument already written
   in `price_attrs.ts`, and is the same three-implementation shape edition size had. The obvious
   next family.
4. **Artist qualifier** (`after`, `attributed`, `circle`, `studio`, `follower`). `ArtistQualifier`
   is declared identically in both benchmark parsers and the `after` factor is live in pricing.
5. **Dimensions — BLOCKED, do not start.** A suspected Roseberys height x width transposition is
   still unconfirmed. Unifying on top of it would bake it in. Confirm or kill that first.
   `forum/parse.ts` also argues, correctly, that dimension logic is genuinely house-specific in a
   way edition size is not — so this family may never fully merge.

### Structural work worth doing

6. **Stop re-parsing downstream.** The measured lesson from the trailing-`\b` divergence: the fix
   was worth almost nothing precisely *because* the ingest stores the value once and the
   downstream fallback almost never fires. The durable fix for this whole class is fewer
   re-parses, not more synchronised regexes. `train_price_model.edition_size` re-reads
   `rawMedium` only when the graph has no declared size; the closer that fallback gets to
   never firing, the less the mirrors matter.
7. **Verify a move over every function that shares the code, not just the one you changed.**
   `EDITION-SIZE-1.0` shipped a `train_price_model` that could not import, because the
   differential exercised `edition_size()` and not `proof_class()`, which shared the same regex.
   A differential that does not cover every consumer is not a differential.
8. **Index the non-parsing rule IDs.** `BLEND-*`, `PRICING-PRIORS-*`, `ARTIST-MERGE-*`, `KM-*` and
   ~40 others live in ADRs and commit messages only. They are decisions and repairs rather than
   parsing rules, so they need a different index shape from this file — but they need one.
9. **Guards at adoption, not after the incident.** Every `check_*.py` exists because something
   broke first. When a rule is adopted with a measured basis, it should get its guard then.

### Things already decided — do not re-open without new evidence

- **The trailing `\b`** in the model rule: measured over 89,451 auction rows, moves 15 rows of
  which only 4 reach the model, one a regression. Not adopted. ADR-0020.
- **The dimension guard on the ingest rule**: measured, loses 15 rows, buys nothing. Rejected.
- **No codegen between the Python rules and their TypeScript mirrors.** Regex semantics differ
  between the languages; the shared fixture corpus is the binding mechanism.
