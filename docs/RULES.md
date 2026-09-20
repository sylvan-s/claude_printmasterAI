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
