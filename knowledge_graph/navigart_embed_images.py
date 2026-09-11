"""
PrintMasterAI — DINOv2/CLIP embeddings for the Navigart public-domain tier
Version: NAVIGART-EMBED-0.1

Same architecture as `picasso_paris_embed_images.py` / `bm_embed_images.py`: a pure
embedding pass that reads `DigitalImage.sourceUrl` back out of the graph and never
re-opens the ingest's cache. The graph is the handoff between ingest and embed.

Survey and load record: `knowledge_graph/navigart_network_source_survey_2026-09-11.md`.

## Why this one is allowed to do what the Picasso adapter's is not

`picasso_paris_embed_images.py` runs under ADR-0002 Amendment 1 **Decision 7**, a narrow
carve-out for in-copyright museum imagery: no `--keep-cache` flag at all, images deleted
between iterations, and every vector stamped `embeddingCommercialUse = false` so the whole
set is purgeable in one query the moment this project takes money.

This tier is different in kind, not in degree. Every record it touches is one the holding
museum itself marks `copyright: "Domaine public"` — the museum's assertion about its own
holding, not our inference from a death date — and a cross-check at load time found 0 of
5,598 records by an artist who died after 1955 among the 106 artists whose death year the
graph knows. None of the contributing museums publishes a `Content-Signal` TDM reservation
(survey §8); Picasso-Paris does, which is why that adapter is metadata-only.

So:

  - **`--keep-cache` exists here** (off by default). Keeping a local copy of a
    public-domain reproduction is not the thing Decision 7(a) forbids, and a cached set
    is what makes a model swap cheap later.
  - **`embeddingCommercialUse` is written `true`.** That property exists to answer one
    question — *which vectors have to go when the footing changes* — and the answer for
    this tier is none. Writing `false` here would be more conservative-looking and less
    honest: it would hide 5,598 clean vectors inside the purge set and defeat the entire
    reason for loading the public-domain tier first.

    What that `true` rests on, stated so a later reader can re-derive it rather than
    inherit it: the work is out of copyright per the museum's own field, and Art. 14 of
    the EU DSM Directive provides that a reproduction of a public-domain visual work is
    not itself protected unless the reproduction is an original work. The residual risk
    is a museum asserting originality in its own photograph of a flat print — a claim
    Art. 14 is specifically aimed at, but not one any court has settled for these
    institutions. This is the project's recorded reading, not legal advice, and it is
    reversible in one query:
        MATCH (i:DigitalImage) WHERE i.embeddingBasis STARTS WITH "Navigart"
        SET i.embeddingCommercialUse = false

## The gate that matters: this script re-derives the tier, it does not trust the ingest

`navigart_fetch.py --tier all` will happily fetch the ~24,000 IN-COPYRIGHT `Estampe`
records, and `navigart_ingest.py` will load them unchanged — that is a deliberate
affordance, and it is also the obvious way this script could one day be pointed at imagery
it has no business embedding. So the candidate query does not select "Navigart images". It
selects, independently and from scratch:

  - `SourceRecord.sourceCopyright` starting "Domaine public", and
  - a `rightsReservation` that is not one of the source's own blocking flags
    ("non autorisée", "en attente d'autorisation"), and
  - both `license` and `rightsReservation` present at all.

If Tier 2 is ever loaded, this script skips every one of those records silently and
correctly, and says how many it skipped. A licence condition that is re-checked at the
point of use is a mechanism; one that is checked upstream and assumed downstream is a
comment.

It still ABORTS, rather than skipping, if any Navigart image node is missing
`license`/`rightsReservation` outright — that means an ingest regression dropped the
attribution ADR-0002 Amendment 1 Decision 6 requires to be structural, and embedding
unlabelled museum imagery is not something to do quietly.

## CLIP text embedding is OFF by default, same reason as Picasso-Paris

`target.clipTextEmbedding` is a single shared vector space, overwhelmingly built from
English text. This source's description field (`Impression.rawMedium`) is French —
"Eau-forte, tirage sur papier filigrané" — and CLIP's text encoder is English-trained.
Writing French vectors into a space queried in English degrades retrieval for every other
corpus. The image vectors have no such problem: DINOv2 and CLIP-image don't read the
caption. Opt in with `--with-text-embedding` if you have a reason.

Pipeline, one pass per image:
  1. Download into a scratch dir (purged at exit unless --keep-cache).
  2. DINOv2-Large embedding (facebook/dinov2-large, 1024-dim).
  3. CLIP image embedding (openai/clip-vit-base-patch32, 512-dim).
  4. CLIP text embedding — only with --with-text-embedding.

Image host: `images.navigart.fr`, plain https, no bot wall, valid TLS chain, 1000px ceiling
already baked into the stored URL by `navigart_ingest.py` — no rewriting here.

Same isolated-venv/native-arm64 requirement as the other embed scripts — see
`embed_images_dinov2.py`'s docstring for why Anaconda's Python is ~2x slower here.

Usage:
    venv-embeddings/bin/python3 navigart_embed_images.py --all --limit 5    # smoke test
    venv-embeddings/bin/python3 navigart_embed_images.py --all
    venv-embeddings/bin/python3 navigart_embed_images.py --all --institution "Musée d'arts de Nantes"
"""

import argparse
import atexit
import json
import os
import shutil
import time
from collections import Counter
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

DINOV2_MODEL_NAME = "facebook/dinov2-large"
DINOV2_DIM = 1024
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"
CLIP_DIM = 512

SOURCE_ID_PREFIX = "navigart"
PUBLIC_DOMAIN_PREFIX = "Domaine public"
# The source's own per-record flags that are NOT a clearance. Kept identical to
# navigart_fetch.BLOCKED_REPRODUCTION_FLAGS rather than imported, because this file must
# stay runnable as a standalone rights gate even if the fetcher changes underneath it.
BLOCKED_REPRODUCTION_FLAGS = ("non autoris", "en attente")

SCRATCH_DIR = "tmp_navigart_images"
FAILURE_LOG_PATH = "navigart_embed_images_failures.json"
USER_AGENT = ("PrintMasterAI-Research/1.0 (+mailto:sylvansitkey07@gmail.com; "
              "non-commercial academic research)")

EMBEDDING_BASIS = ("Navigart public-domain tier — museum-asserted 'Domaine public' + "
                   "EU DSM Art.14; no TDM reservation published by source")

KEEP_CACHE = False  # set from --keep-cache before the run starts

# WHERE must come directly after the primary MATCH, before any OPTIONAL MATCH — a WHERE
# placed after an OPTIONAL MATCH scopes to filtering THAT pattern, not the row set, so a
# false condition still returns the row with null optionals instead of excluding it. Found
# live 2026-09-06 in bm_embed_images.py and embed_tate_images.py (doc 09 §7.3), where it
# made --force effectively always-on. Same shape, same placement, deliberately.
#
# Every condition below the `force` line is the rights gate from the module docstring,
# re-derived here rather than inherited from the ingest.
FETCH_CANDIDATES_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(target)<-[:DOCUMENTS]-(src:SourceRecord)
WHERE src.id STARTS WITH $sourcePrefix
  AND ($force OR img.embedding IS NULL)
  AND img.license IS NOT NULL
  AND img.rightsReservation IS NOT NULL
  AND src.sourceCopyright STARTS WITH $publicDomainPrefix
  AND NONE(flag IN $blockedFlags WHERE toLower(img.rightsReservation) CONTAINS flag)
  AND ($institution IS NULL OR src.institutionName = $institution)
OPTIONAL MATCH (er:EditionRun)-[:INCLUDES]->(target)
OPTIONAL MATCH (cw:ConceptualWork)-[:PRINTED_AS]->(er)
RETURN img.id AS imgId, img.sourceUrl AS sourceUrl, target.id AS targetId,
       src.institutionName AS institution,
       coalesce(target.rawMedium, target.description) AS description, cw.name AS title
ORDER BY imgId
"""

# Decision 6 precondition + the tier split, in one pass. `labelled` counts images carrying
# both rights properties; `publicDomain` counts those that also pass the tier gate. A
# labelled/total mismatch is an ABORT (an ingest regression); a publicDomain/labelled gap
# is normal and expected the moment Tier 2 is loaded — it is reported, not fatal.
RIGHTS_AUDIT_QUERY = """
MATCH (img:DigitalImage)-[:SHOWS]->(target)<-[:DOCUMENTS]-(src:SourceRecord)
WHERE src.id STARTS WITH $sourcePrefix
RETURN count(img) AS total,
       count(CASE WHEN img.license IS NOT NULL AND img.rightsReservation IS NOT NULL
             THEN 1 END) AS labelled,
       count(CASE WHEN src.sourceCopyright STARTS WITH $publicDomainPrefix
                   AND NONE(flag IN $blockedFlags
                            WHERE toLower(coalesce(img.rightsReservation, "")) CONTAINS flag)
             THEN 1 END) AS publicDomain
"""

WRITE_EMBEDDING_QUERY = """
UNWIND $rows AS row
MATCH (img:DigitalImage {id: row.imgId})
SET img.embedding = row.dinoEmbedding,
    img.embeddingModel = row.dinoModel,
    img.embeddingDim = row.dinoDim,
    img.embeddedAt = row.embeddedAt,
    img.clipImageEmbedding = row.clipImageEmbedding,
    img.clipImageEmbeddingModel = row.clipModel,
    img.clipImageEmbeddingDim = row.clipDim,
    img.clipEmbeddedAt = row.embeddedAt,
    img.embeddingBasis = row.embeddingBasis,
    img.embeddingCommercialUse = true
WITH row
MATCH (target {id: row.targetId})
FOREACH (_ IN CASE WHEN row.clipTextEmbedding IS NOT NULL THEN [1] ELSE [] END |
    SET target.clipTextEmbedding = row.clipTextEmbedding,
        target.clipTextEmbeddingModel = row.clipModel,
        target.clipTextEmbeddingDim = row.clipDim,
        target.clipTextSource = row.textSource
)
"""


def _purge_scratch():
    if not KEEP_CACHE:
        shutil.rmtree(SCRATCH_DIR, ignore_errors=True)


atexit.register(_purge_scratch)


def _driver():
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def audit_rights():
    driver = _driver()
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            return dict(session.run(
                RIGHTS_AUDIT_QUERY, sourcePrefix=SOURCE_ID_PREFIX,
                publicDomainPrefix=PUBLIC_DOMAIN_PREFIX,
                blockedFlags=list(BLOCKED_REPRODUCTION_FLAGS)).single())
    finally:
        driver.close()


def fetch_candidates(force=False, limit=None, institution=None):
    driver = _driver()
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            rows = [dict(r) for r in session.run(
                FETCH_CANDIDATES_QUERY, force=force, sourcePrefix=SOURCE_ID_PREFIX,
                publicDomainPrefix=PUBLIC_DOMAIN_PREFIX,
                blockedFlags=list(BLOCKED_REPRODUCTION_FLAGS),
                institution=institution)]
    finally:
        driver.close()
    return rows[:limit] if limit else rows


def load_models():
    import torch  # noqa: F401 — lazy so --help doesn't pay torch's import cost
    from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor

    dino_processor = AutoImageProcessor.from_pretrained(DINOV2_MODEL_NAME)
    dino_model = AutoModel.from_pretrained(DINOV2_MODEL_NAME)
    dino_model.eval()

    clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME)
    clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
    clip_model.eval()

    return dino_processor, dino_model, clip_processor, clip_model


def download_to_scratch(url, dest_path, retries=3, backoff_seconds=2.0, timeout=30):
    if KEEP_CACHE and os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
        return
    last_error = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if r.status_code == 200:
                with open(dest_path, "wb") as f:
                    f.write(r.content)
                return
            last_error = f"HTTP {r.status_code}"
        except Exception as e:
            last_error = str(e)
        if attempt < retries - 1:
            time.sleep(backoff_seconds * (attempt + 1))
    raise RuntimeError(last_error)


def embed_dinov2(processor, model, image):
    import torch
    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        outputs = model(**inputs)
    return outputs.last_hidden_state[:, 0, :].squeeze(0).tolist()


def embed_clip_image(processor, model, image):
    import torch
    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        features = model.get_image_features(**inputs)
    return features.squeeze(0).tolist()


def embed_clip_text(processor, model, text):
    import torch
    inputs = processor(text=[text], return_tensors="pt", truncation=True, padding=True)
    with torch.no_grad():
        features = model.get_text_features(**inputs)
    return features.squeeze(0).tolist()


def _assert_no_bytes(row):
    """Cheap, but worth a mechanism: every value bound for the graph must be a float
    vector or a scalar, never bytes. Kept even though this tier's licence does not
    require it — the check costs nothing and the failure it catches is silent."""
    for key, value in row.items():
        if isinstance(value, (bytes, bytearray, memoryview)):
            raise RuntimeError(f"refusing to write binary data to the graph: {key}")
        if isinstance(value, list) and value and not isinstance(value[0], float):
            raise RuntimeError(f"refusing to write a non-float vector to the graph: {key}")


def _write_chunk_with_retry(rows, retries=4, backoff_seconds=5.0):
    if not rows:
        return
    for row in rows:
        _assert_no_bytes(row)
    last_error = None
    for attempt in range(retries):
        driver = _driver()
        try:
            with driver.session(database=NEO4J_DATABASE) as session:
                session.run(WRITE_EMBEDDING_QUERY, rows=rows).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def run_embeddings(candidates, chunk_size=10, with_text_embedding=False):
    from PIL import Image

    os.makedirs(SCRATCH_DIR, exist_ok=True)
    dino_processor, dino_model, clip_processor, clip_model = load_models()

    total = len(candidates)
    start = time.time()
    write_buffer, failures, text_embedded_count = [], [], 0
    per_institution = Counter()

    try:
        for i, c in enumerate(candidates):
            dest_path = os.path.join(SCRATCH_DIR, f"{c['imgId']}.jpg")
            try:
                download_to_scratch(c["sourceUrl"], dest_path)
                image = Image.open(dest_path).convert("RGB")

                dino_vec = embed_dinov2(dino_processor, dino_model, image)
                clip_img_vec = embed_clip_image(clip_processor, clip_model, image)

                clip_text_vec, text_source = None, None
                if with_text_embedding:
                    text = c.get("description") or c.get("title")
                    text_source = ("description" if c.get("description")
                                   else ("title" if c.get("title") else None))
                    if text:
                        clip_text_vec = embed_clip_text(clip_processor, clip_model, text)
                        text_embedded_count += 1
            except Exception as e:
                failures.append({"imgId": c["imgId"], "url": c["sourceUrl"],
                                 "institution": c.get("institution"), "error": str(e)})
                print(f"[SKIP] {c['imgId']}: {e}", flush=True)
                continue
            finally:
                if os.path.exists(dest_path) and not KEEP_CACHE:
                    os.remove(dest_path)

            per_institution[c.get("institution")] += 1
            write_buffer.append({
                "imgId": c["imgId"],
                "targetId": c["targetId"],
                "dinoEmbedding": dino_vec,
                "dinoModel": DINOV2_MODEL_NAME,
                "dinoDim": DINOV2_DIM,
                "clipImageEmbedding": clip_img_vec,
                "clipTextEmbedding": clip_text_vec,
                "clipModel": CLIP_MODEL_NAME,
                "clipDim": CLIP_DIM,
                "textSource": text_source,
                "embeddingBasis": EMBEDDING_BASIS,
                "embeddedAt": datetime.now(timezone.utc).isoformat(),
            })
            if len(write_buffer) >= chunk_size:
                _write_chunk_with_retry(write_buffer)
                write_buffer = []

            if (i + 1) % 25 == 0 or i + 1 == total:
                rate = (i + 1) / max(1e-6, time.time() - start)
                eta = (total - i - 1) / max(1e-6, rate)
                print(f"[PROGRESS] {i + 1}/{total} ({len(failures)} failed) "
                      f"{rate:.2f} img/s eta={eta / 60:.0f}m", flush=True)

        _write_chunk_with_retry(write_buffer)
    finally:
        _purge_scratch()

    embedded = total - len(failures)
    print(f"[DONE] embedded={embedded} failed={len(failures)} "
          f"text_embedded={text_embedded_count} elapsed={time.time() - start:.0f}s",
          flush=True)
    for inst, n in per_institution.most_common():
        print(f"    {n:>6}  {inst}", flush=True)
    print(f"[RIGHTS] {embedded} node(s) stamped embeddingCommercialUse=true, "
          f"basis={EMBEDDING_BASIS!r}", flush=True)

    if failures:
        with open(FAILURE_LOG_PATH, "w") as f:
            json.dump(failures, f, indent=2)
        print(f"[DONE] {len(failures)} failures logged to {FAILURE_LOG_PATH}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true",
                        help="Embed all qualifying Navigart public-domain DigitalImage nodes")
    parser.add_argument("--limit", type=int, help="Cap the number of images (test run)")
    parser.add_argument("--force", action="store_true", help="Re-embed even if already set")
    parser.add_argument("--institution", help="Restrict to one SourceRecord.institutionName")
    parser.add_argument("--chunk-size", type=int, default=10, help="Neo4j write batch size")
    parser.add_argument("--keep-cache", action="store_true",
                        help="Keep the downloaded images in the scratch dir. Permitted here "
                             "because this tier is public domain; the Picasso-Paris embed "
                             "script deliberately has no such flag — see module docstring")
    parser.add_argument("--with-text-embedding", action="store_true",
                        help="Also write target.clipTextEmbedding. OFF by default: this "
                             "source's description text is French and clipTextEmbedding is a "
                             "single shared, overwhelmingly English space — see docstring")
    args = parser.parse_args()

    if not args.all:
        parser.error("Provide --all (optionally with --limit/--force/--institution/...)")

    KEEP_CACHE = args.keep_cache

    audit = audit_rights()
    if audit["total"] != audit["labelled"]:
        raise SystemExit(
            f"ABORT: {audit['total'] - audit['labelled']} of {audit['total']} Navigart "
            f"DigitalImage nodes are missing license/rightsReservation. ADR-0002 "
            f"Amendment 1 Decision 6 requires those to be present before any image is "
            f"embedded. Re-run navigart_ingest.py to restore them.")
    print(f"[RIGHTS] {audit['labelled']}/{audit['total']} Navigart images carry "
          f"license + rightsReservation", flush=True)
    skipped = audit["total"] - audit["publicDomain"]
    if skipped:
        print(f"[RIGHTS] {skipped} image(s) are NOT in the public-domain tier and will be "
              f"skipped — this is expected if Tier 2 has been loaded, and is the gate "
              f"working, not a failure", flush=True)

    candidates = fetch_candidates(force=args.force, limit=args.limit,
                                  institution=args.institution)
    print(f"Found {len(candidates)} image(s) to embed (force={args.force}, "
          f"keep_cache={KEEP_CACHE}, with_text_embedding={args.with_text_embedding})",
          flush=True)
    run_embeddings(candidates, chunk_size=args.chunk_size,
                   with_text_embedding=args.with_text_embedding)
