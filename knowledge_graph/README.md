# ACKG — Art Context Knowledge Graph

Standalone Python toolkit that builds and populates the Art Context Knowledge Graph
(ACKG) referenced in `docs/adr/0003-knowledge-graph-grounded-triage.md` — a Neo4j
property graph of artists, works, editions, techniques, and auction/institutional
source records, intended as the queryable evidence layer behind Stage 2a triage
(`query_ackg()`, not yet built — see that ADR for the remaining integration scope).

This directory is independent of the TypeScript appraisal pipeline in `src/` — it has
its own dependencies (`neo4j`, `pandas`) and is run standalone, not imported by the
app. `resolve_vea_composition.py` is the one exception meant to eventually be called
from the pipeline, but note it currently targets an older VEA composition shape
(`subjectElements[]`/`styleObservations[]`) than the live `VEA-1.1` schema
(`subjectMatter`/`subjectCategory`/`visualStyle` — see `src/appraisal/schemas.ts`) and
needs updating before use.

## Setup

```
pip install neo4j pandas
cp knowledge_graph/.env.example knowledge_graph/.env   # fill in real AuraDB values
set -a; source knowledge_graph/.env; set +a
```

## Files

- `08_ackg_schema_definition.md` — the graph schema: node/edge types, properties, design rationale.
- `09_source_ingestion_semantic_layer.md` — per-source field-mapping documentation (doc-to-code contract for the ingest scripts below).
- `crosswalk_matching.py` — shared Getty AAT lookups for printing technique / paper, used by all three ingest scripts.
- `resolve_artist_identity.py` — live ULAN/Wikidata identity resolution against Getty's SPARQL endpoint.
- `resolve_vea_composition.py` — maps a VEA composition observation into Subject/Genre graph writes (see the staleness note above).
- `met_ingest.py`, `roseberys_ingest.py`, `forum_ingest.py` — bulk ingestion adapters for the Met Open Access CSV, Roseberys, and Forum Auctions catalogue extracts respectively. Each is self-contained; run with `--all` or `--sale`/`--object-ids`/`--artists` for a scoped load. See each file's module docstring for source-specific data-quality handling.
- `aat_crosswalk.json` — verified Getty AAT ID lookup table (never LLM-generated — see `resolve_artist_identity.py`'s docstring for why that matters).
