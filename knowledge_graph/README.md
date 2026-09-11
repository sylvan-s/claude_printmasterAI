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
- `met_ingest.py`, `roseberys_ingest.py`, `forum_ingest.py`, `tate_ingest.py` — bulk ingestion adapters for the Met Open Access, Roseberys, Forum Auctions, and Tate Collection catalogue extracts respectively. Each is self-contained; run with `--all` or `--sale`/`--object-ids`/`--artists`/`--accession-numbers` for a scoped load. See each file's module docstring for source-specific data-quality handling.
- `bm_ingest.py` — pilot-scale adapter for the British Museum Collection Online (31 genuine Rembrandt etchings so far). Loads from a local JSON cache, not a live fetch — the site is behind a Cloudflare managed challenge with no scriptable bulk access; see doc 09 §7 for the full access-method and licensing (CC BY-NC-SA, non-commercial) write-up before extending this one.
- `bm_embed_images.py` — pure DINOv2-Large/CLIP embedding pass over `DigitalImage` nodes already in the graph (`bm_ingest.py` creates them directly, same pattern as `forum_ingest.py`'s `LOAD_QUERY` — the graph is the handoff, not a shared cache file). Unlike the main site, BM's image files are served from an unprotected CDN subdomain (`media.britishmuseum.org`) — plain `requests` works for the download step even though the catalogue scrape needs a browser. See doc 09 §7.1/§7.3/§7.4.
- `embed_images_dinov2.py` — writes DINOv2-small visual-similarity embeddings onto Roseberys/Forum `DigitalImage` nodes (Tate and Met have none to embed — see the script's own docstring). Needs its own isolated venv (`requirements-embeddings.txt`), not this toolkit's base `neo4j`/`pandas` env — see the script's docstring for why. **Deprecated** as of ADR-0013: the graph has standardized on DINOv2-Large; any node this script embedded on DINOv2-small has since had those properties stripped, pending re-embedding on DINOv2-Large instead.
- `embedding_service.py` — Stage 1d's request-time inference microservice (docs/adr/0013-stage1d-image-embedding-evidence.md): loads DINOv2-Large + CLIP once and serves embeddings for a single submission image over localhost HTTP, so the TypeScript pipeline can get a query vector without shelling out to Python per request. Same isolated venv as the two scripts above. See "Running the embedding service" below.
- `setup_vector_index.py` — one-time (idempotent) creation of the two Neo4j native vector indexes Stage 1d queries against (`digitalImageDinov2Embedding`, `digitalImageClipEmbedding`). Plain `neo4j`-driver script, runs in the toolkit's base env, no venv-embeddings/torch needed.
- `catalogue_matching.py` — shared catalogue-raisonne-citation parsing and the exact `ConceptualWork` identity key (artist + catalogue + entry + exact normalized title), used by `forum_ingest.py` and `roseberys_ingest.py`. Every part of its strictness was earned by a confirmed corruption incident; read its docstring before loosening anything.
- `find_duplicate_work_clusters.py` — **scan-only** report of duplicate `ConceptualWork` nodes keyed on exact artist + normalized title + year, the gap `catalogue_matching.py` cannot cover (it only fires on lots citing a catalogue raisonne). 12,089 clusters / 19,974 surplus nodes as of 2026-09-10. Triages into catalogue-number conflicts, one-institution portfolio suspects, image dissent, null-year and large-cluster buckets, plus the separate shared-Impression backfill defect. Has no `--merge` mode by design. A DINOv2 similarity key was probed for this job on 2026-09-10 and rejected on measurement (44% recall at >= 0.98) — see the module docstring for the numbers.
- `probe_geometric_verification.py` — **run once, 2026-09-11, and rejected.** Tested SIFT + RANSAC geometric verification as the confirmation step after DINOv2 retrieval, on 1,040 labelled pairs. It loses to the embedding it was meant to confirm (AUC 0.843 vs DINOv2's 0.977) and is at chance on states (0.498), because a state is the same matrix. Picasso's shared trompe-l'oeil border block returns 590 inliers between two different linocuts that DINOv2 correctly scores 0.523. Write-up: `geometric_verification_probe_2026-09-11.md`.
- `aat_crosswalk.json` — verified Getty AAT ID lookup table (never LLM-generated — see `resolve_artist_identity.py`'s docstring for why that matters).

## Running the embedding service

Stage 1d (the TypeScript appraisal pipeline) calls this over localhost HTTP at request time —
it needs to be running alongside the Node server for Stage 1d to produce a result (it degrades
to an empty/skipped result, not a crash, if the service is down — see `embedding_client.ts`).

```
knowledge_graph/venv-embeddings/bin/pip install -r knowledge_graph/requirements-embeddings.txt
knowledge_graph/venv-embeddings/bin/uvicorn embedding_service:app --app-dir knowledge_graph --host 127.0.0.1 --port 8008
curl http://127.0.0.1:8008/health
```

One-time setup of the Neo4j vector indexes it queries against:
```
set -a; source knowledge_graph/.env; set +a
python3 knowledge_graph/setup_vector_index.py
```
