# Parsing rule index

One line per **rule family** — one question asked of free-form catalogue prose. The shape these
follow, and why, is [ADR-0020](adr/0020-shared-parsing-rule-modules.md).

Read this before adding a regex to an ingest. If the question already has a family, extend the
family; do not add a fifth implementation of it.

## Families

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

Written 2026-09-20, at the end of the `EDITION-SIZE` work. Ordered by evidence, not appeal.

### Land what exists

1. **`fix/ingest-dims-copytype` → trunk.** `COPY-TYPE-1.1` plus the Roseberys dims repair. Trunk
   is merged into it and it now merges back cleanly; typecheck and six price/valuation suites
   pass. Its graph repair has **already been applied**, so code and graph stay out of step until
   this lands. Nothing else should be started on this family first.
2. **`feature/shared-parsing-rules` → trunk.** `EDITION-SIZE-1.0/1.1`, ADR-0020, this index, the
   fixture corpus, the applied graph repair and the rebuilt model. Note it carries a live
   calibration change (BLEND-2.4) whose weight shifts come from graph growth, not from the
   repair — see ADR-0020.

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
