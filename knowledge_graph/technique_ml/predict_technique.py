"""
PrintMasterAI — inference: image (or embedding) → printmaking technique probabilities.
Version: TECHML-PREDICT-1.0

Two ways in, because the pipeline and the command line want different things:

  * `--image path|url` embeds locally with DINOv2-Large. Correct but pays torch's
    model load (~10s cold) on every invocation, so this is for spot checks.
  * `--embedding-service http://127.0.0.1:8008` reuses Stage 1d's already-running
    microservice (see embedding_service.py) instead of loading a second copy of the
    model. This is the path a pipeline stage should take.
  * `--image-id <elementId>` scores an image already embedded in the graph, which is
    how to inspect what the model says about the training corpus itself.

The output is per-technique probability plus the tuned decision at that technique's
own threshold. Multi-label: expect an etching+aquatint to come back with two
techniques above threshold, and treat the absence of any as "unrecognised process",
not as a vote for the most likely class.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/predict_technique.py \
        --image /path/to/print.jpg
    ... --image-id 4:abc:123 --json
"""

import argparse
import io
import json
import os

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, "artifacts", "technique_classifier.pt")


def load_bundle(path):
    bundle = torch.load(path, map_location="cpu", weights_only=False)
    from train_technique_classifier import build_model

    model = build_model(
        bundle["model_kind"],
        bundle["feature_mean"].shape[1],
        len(bundle["labels"]),
        bundle["hidden"],
        bundle["dropout"],
    )
    model.load_state_dict(bundle["state_dict"])
    model.eval()
    return model, bundle


def embed_local(image_source):
    """Embed one image with the same model the graph was embedded with."""
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModel

    if image_source.startswith("http://") or image_source.startswith("https://"):
        import requests
        raw = requests.get(image_source, timeout=30)
        raw.raise_for_status()
        image = Image.open(io.BytesIO(raw.content)).convert("RGB")
    else:
        image = Image.open(image_source).convert("RGB")

    name = "facebook/dinov2-large"
    processor = AutoImageProcessor.from_pretrained(name)
    encoder = AutoModel.from_pretrained(name)
    encoder.eval()
    with torch.no_grad():
        out = encoder(**processor(images=image, return_tensors="pt"))
    # CLS token, matching embed_images_dinov2.py / bm_embed_images.py.
    return out.last_hidden_state[:, 0, :].squeeze(0).numpy().astype(np.float32)


def embed_via_service(image_source, base_url):
    import requests

    response = requests.post(
        base_url.rstrip("/") + "/embed",
        json={"imageUrl": image_source} if image_source.startswith("http")
        else {"imagePath": os.path.abspath(image_source)},
        timeout=60,
    )
    response.raise_for_status()
    payload = response.json()
    vector = payload.get("dinov2") or payload.get("embedding")
    if vector is None:
        raise RuntimeError(f"Embedding service returned no DINOv2 vector: {payload.keys()}")
    return np.asarray(vector, dtype=np.float32)


def embed_from_graph(image_id):
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]),
    )
    try:
        with driver.session(database=os.environ["NEO4J_DATABASE"]) as session:
            record = session.run(
                "MATCH (img:DigitalImage) WHERE elementId(img) = $id "
                "RETURN img.embedding AS embedding", id=image_id,
            ).single()
    finally:
        driver.close()
    if record is None or record["embedding"] is None:
        raise RuntimeError(f"No embedded DigitalImage with elementId {image_id}")
    return np.asarray(record["embedding"], dtype=np.float32)


def predict(vector, model, bundle):
    v = vector / max(float(np.linalg.norm(vector)), 1e-8)
    x = (v[None, :] - bundle["feature_mean"]) / bundle["feature_std"]
    with torch.no_grad():
        probs = torch.sigmoid(model(torch.tensor(x.astype(np.float32)))).numpy()[0]
    rows = [
        {
            "technique": label,
            "probability": round(float(probs[i]), 4),
            "threshold": round(float(bundle["thresholds"][i]), 3),
            "predicted": bool(probs[i] >= bundle["thresholds"][i]),
        }
        for i, label in enumerate(bundle["labels"])
    ]
    return sorted(rows, key=lambda r: -r["probability"])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument("--image", help="local path or URL")
    source.add_argument("--image-id", help="elementId of an already-embedded DigitalImage")
    p.add_argument("--embedding-service", help="base URL of embedding_service.py")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--top", type=int, default=8)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    if args.image_id:
        vector = embed_from_graph(args.image_id)
    elif args.embedding_service:
        vector = embed_via_service(args.image, args.embedding_service)
    else:
        vector = embed_local(args.image)

    model, bundle = load_bundle(args.model)
    rows = predict(vector, model, bundle)
    predicted = [r["technique"] for r in rows if r["predicted"]]

    if args.json:
        print(json.dumps({"predicted": predicted, "scores": rows}, indent=2))
        return

    print(f"Predicted technique(s): {', '.join(predicted) if predicted else '(none above threshold)'}\n")
    print(f"{'technique':<28} {'prob':>7} {'thr':>6}   ")
    for row in rows[:args.top]:
        mark = "  <-" if row["predicted"] else ""
        print(f"{row['technique']:<28} {row['probability']:>7.3f} {row['threshold']:>6.2f}{mark}")


if __name__ == "__main__":
    main()
