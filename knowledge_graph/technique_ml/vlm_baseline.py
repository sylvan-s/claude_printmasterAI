"""
PrintMasterAI — ADR-0019: what does a frontier VLM read from the pixels alone?
Version: TECHML-VLM-BASELINE-1.0

The question raised on 2026-09-13: when a frontier model names a print's technique, is it
reading burr and grain, or recognising the work and recalling the catalogue? This scores
Claude Opus 5 on the same held-out artists the tile model was scored on, with everything it
could look up removed: the image is cropped to the localised print area (margins, signatures,
mount labels gone), downscaled to the API's 1568 px cap, and sent with no metadata at all —
a forced choice over the same 21 techniques, as structured JSON.

Sample: 300 images stratified by target class from the 2026-09-07 test artists — 60 each of
etching-only, aquatint (± etching), drypoint (± etching), engraving, and 60 spread over the
other families — so the fine-grain intaglio comparison has n≈60 per class.

Two phases (the batch takes up to an hour):
    python vlm_baseline.py submit  --manifest ... --out-dir artifacts/vlm_baseline   # ~$3.50 via Batch API
    python vlm_baseline.py score   --out-dir artifacts/vlm_baseline
"""

import argparse
import base64
import io
import json
import os
import random
import sys
import time

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze_confusions import FAMILY  # noqa: E402
from dataset import artist_eval_weights  # noqa: E402
from hires import USER_AGENT, choose_dimensions  # noqa: E402
from tiling import locate_print_area  # noqa: E402
from train_tile_head import bootstrap_artists, weighted_auroc, weighted_f1  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
Image.MAX_IMAGE_PIXELS = 60_000_000
MODEL = "claude-opus-5"
TECHNIQUES = sorted(FAMILY)
FAMILIES = sorted(set(FAMILY.values()))
STRATA = {
    "etching-only": lambda t: t == {"Etching"},
    "aquatint": lambda t: "Aquatint" in t and "Drypoint" not in t,
    "drypoint": lambda t: "Drypoint" in t and "Aquatint" not in t,
    "engraving": lambda t: "Engraving" in t,
    "other-families": lambda t: len(t) == 1 and FAMILY.get(next(iter(t))) not in (None, "Intaglio"),
}

SYSTEM = ("You are a print-room connoisseur examining a photograph of a printed impression. Identify the "
          "printmaking process from the surface evidence visible in the image only: line character and endings, "
          "tone structure (grain, reticulation, rocked ground, halftone screen, flat colour), ink relief, plate "
          "marks, paper texture. Do not rely on recognising the work or the artist; there is no caption.")
USER = ("Classify this print. Choose the process family and the specific technique(s) from these lists only.\n"
        f"Families: {', '.join(FAMILIES)}.\nTechniques: {', '.join(TECHNIQUES)}.\n"
        "A print may combine techniques (e.g. etching with aquatint, or etching with drypoint). Give every "
        "technique you believe is present, a confidence from 0 to 1 for the overall answer, and one sentence "
        "of surface evidence.")
SCHEMA = {"type": "object",
          "properties": {"family": {"type": "string", "enum": FAMILIES},
                         "techniques": {"type": "array", "items": {"type": "string", "enum": TECHNIQUES}, "minItems": 1},
                         "confidence": {"type": "number"},
                         "evidence": {"type": "string"}},
          "required": ["family", "techniques", "confidence", "evidence"], "additionalProperties": False}


def sample_rows(manifest, held_out, per_stratum, seed):
    rows = [json.loads(l) for l in open(manifest)]
    test_artists = set(json.load(open(held_out))["test_artists"])
    rows = [r for r in rows if r["artistId"] in test_artists]
    rng = random.Random(seed)
    rng.shuffle(rows)
    out, seen = [], set()
    for name, pred in STRATA.items():
        picked, per_artist = [], {}
        for r in rows:
            if r["imageId"] in seen or not pred(set(r["techniques"])):
                continue
            if per_artist.get(r["artistId"], 0) >= 3:      # keep the stratum artist-diverse
                continue
            per_artist[r["artistId"]] = per_artist.get(r["artistId"], 0) + 1
            picked.append(r); seen.add(r["imageId"])
            if len(picked) >= per_stratum:
                break
        for r in picked:
            r["_stratum"] = name
        out += picked
        print(f"  {name:15s} {len(picked)} images, {len(per_artist)} artists")
    return out


def crop_b64(row):
    r = requests.get(row["hiresUrl"], headers={"User-Agent": USER_AGENT}, timeout=90)
    r.raise_for_status()
    im = Image.open(io.BytesIO(r.content)).convert("RGB")
    box, _ = locate_print_area(im)
    im = im.crop(box)
    s = 1568 / max(im.size)
    if s < 1:
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii"), im.size


def submit(args):
    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    os.makedirs(args.out_dir, exist_ok=True)
    print("sampling:")
    rows = sample_rows(args.manifest, args.held_out, args.per_stratum, args.seed)
    reqs, kept = [], []
    t0 = time.time()
    for i, r in enumerate(rows):
        try:
            b64, size = crop_b64(r)
        except Exception as e:
            print(f"  skip {r['imageId']}: {type(e).__name__}")
            continue
        r["_sent_size"] = list(size)
        kept.append(r)
        reqs.append(Request(custom_id=r["imageId"].replace(":", "_")[-40:], params=MessageCreateParamsNonStreaming(
            model=MODEL, max_tokens=2048, system=SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                {"type": "text", "text": USER}]}])))
        if (i + 1) % 50 == 0:
            print(f"  prepared {i + 1}/{len(rows)} ({time.time() - t0:.0f}s)", flush=True)
    with open(os.path.join(args.out_dir, "sample.jsonl"), "w") as f:
        for r in kept:
            f.write(json.dumps({k: v for k, v in r.items()}) + "\n")
    # Chunked: this venv's LibreSSL drops a single ~150 MB POST with "bad record mac".
    client = anthropic.Anthropic(max_retries=5)
    batch_ids = []
    for i in range(0, len(reqs), args.chunk):
        chunk = reqs[i:i + args.chunk]
        for attempt in range(4):
            try:
                batch = client.messages.batches.create(requests=chunk)
                break
            except anthropic.APIConnectionError as e:
                print(f"  chunk {i // args.chunk}: connection error ({e}), retry {attempt + 1}", flush=True)
                time.sleep(5 * (attempt + 1))
        else:
            raise SystemExit("could not submit a chunk after 4 attempts")
        batch_ids.append(batch.id)
        print(f"  submitted chunk {i // args.chunk + 1}/{(len(reqs) + args.chunk - 1) // args.chunk}: {batch.id} ({len(chunk)} requests)", flush=True)
    json.dump({"batch_ids": batch_ids, "n": len(reqs), "model": MODEL, "submitted": time.strftime("%Y-%m-%dT%H:%M:%S")},
              open(os.path.join(args.out_dir, "batch.json"), "w"), indent=2)
    print(f"submitted {len(batch_ids)} batches, {len(reqs)} requests")


def score(args):
    import anthropic
    client = anthropic.Anthropic()
    meta = json.load(open(os.path.join(args.out_dir, "batch.json")))
    sample = {json.loads(l)["imageId"].replace(":", "_")[-40:]: json.loads(l) for l in open(os.path.join(args.out_dir, "sample.jsonl"))}
    while True:
        bs = [client.messages.batches.retrieve(bid) for bid in meta["batch_ids"]]
        if all(b.processing_status == "ended" for b in bs):
            break
        print(f"  ended {sum(b.processing_status == 'ended' for b in bs)}/{len(bs)} batches; processing "
              f"{sum(b.request_counts.processing for b in bs)}, succeeded {sum(b.request_counts.succeeded for b in bs)}", flush=True)
        time.sleep(60)
    print(f"all batches ended: succeeded {sum(b.request_counts.succeeded for b in bs)}, errored {sum(b.request_counts.errored for b in bs)}, "
          f"expired {sum(b.request_counts.expired for b in bs)}")
    results, usage_in, usage_out = [], 0, 0
    with open(os.path.join(args.out_dir, "responses.jsonl"), "w") as f:
        for res in (r for bid in meta["batch_ids"] for r in client.messages.batches.results(bid)):
            row = sample.get(res.custom_id)
            rec = {"custom_id": res.custom_id, "imageId": row["imageId"] if row else None, "type": res.result.type}
            if res.result.type == "succeeded":
                msg = res.result.message
                usage_in += msg.usage.input_tokens; usage_out += msg.usage.output_tokens
                text = next((c.text for c in msg.content if c.type == "text"), "")
                try:
                    rec["answer"] = json.loads(text)
                except Exception:
                    rec["answer"] = None; rec["raw"] = text[:300]
            else:
                rec["error"] = str(getattr(res.result, "error", ""))[:200]
            results.append(rec)
            f.write(json.dumps(rec) + "\n")
    cost = usage_in / 1e6 * 5 / 2 + usage_out / 1e6 * 25 / 2
    print(f"tokens in {usage_in:,} out {usage_out:,} -> batch cost ≈ ${cost:.2f}")

    ok = [r for r in results if r.get("answer") and r["imageId"] in {v["imageId"] for v in sample.values()}]
    by_id = {v["imageId"]: v for v in sample.values()}
    rows = [by_id[r["imageId"]] for r in ok]
    groups = np.array([r["artistId"] for r in rows])
    Ytrue = np.array([[1.0 if t in r["techniques"] else 0.0 for t in TECHNIQUES] for r in rows], np.float32)
    Ypred = np.array([[1.0 if t in r["answer"]["techniques"] else 0.0 for t in TECHNIQUES] for r in ok], np.float32)
    conf = np.array([float(r["answer"].get("confidence", 0.5)) for r in ok])
    score_soft = Ypred * conf[:, None] + (1 - Ypred) * (1 - conf[:, None]) * 0.0   # presence x confidence
    fam_true = np.array([FAMILY[next(iter(set(r["techniques"]) & set(TECHNIQUES)))] if set(r["techniques"]) & set(TECHNIQUES) else "?" for r in rows])
    fam_pred = np.array([r["answer"]["family"] for r in ok])
    w = artist_eval_weights(groups)
    lines = [f"# VLM baseline — {MODEL}, {len(ok)} images from the 2026-09-07 held-out artists, pixels only ({time.strftime('%Y-%m-%d')})", "",
             f"Batch cost ≈ ${cost:.2f} ({usage_in:,} in / {usage_out:,} out tokens). Images cropped to the localised print area, ≤1568 px, no metadata.", ""]
    fam_acc = float((w * (fam_true == fam_pred)).sum() / w.sum())
    lines.append(f"- artist-weighted family accuracy: **{fam_acc:.3f}** (tile model family macro-F1 on the same artists: 0.662)")
    fam_f1 = []
    for fam in FAMILIES:
        yt, yp = (fam_true == fam).astype(np.float32), (fam_pred == fam).astype(np.float32)
        if yt.sum() >= 5:
            f1 = weighted_f1(yt, yp, w, 0.5); fam_f1.append(f1)
            lines.append(f"  - {fam}: n={int(yt.sum())} F1 {f1:.3f}")
    lines.append(f"- family macro-F1 over families with ≥5 test images: **{np.mean(fam_f1):.3f}**")
    lines.append("")
    lines.append("| technique | n | precision | recall | F1 [5–95%] | AUROC (presence×confidence) | tile model within-family F1 |")
    lines.append("|---|---:|---:|---:|---|---:|---:|")
    two_stage = json.load(open(os.path.join(HERE, "artifacts", "two_stage_tiles.json")))["stage_b"]
    out_json = {"n": len(ok), "cost_usd": round(cost, 2), "family_accuracy": fam_acc, "family_macro_f1": float(np.mean(fam_f1)), "techniques": {}}
    for c, t in enumerate(TECHNIQUES):
        n = int(Ytrue[:, c].sum())
        if n < 5:
            continue
        m = np.array([[c]])
        bs = bootstrap_artists(Ytrue[:, [c]], Ypred[:, [c]], groups, np.array([0.5]), 500, 13)
        tp = (w * ((Ypred[:, c] == 1) & (Ytrue[:, c] == 1))).sum(); fp = (w * ((Ypred[:, c] == 1) & (Ytrue[:, c] == 0))).sum(); fn = (w * ((Ypred[:, c] == 0) & (Ytrue[:, c] == 1))).sum()
        prec, rec = tp / (tp + fp + 1e-9), tp / (tp + fn + 1e-9)
        f1 = weighted_f1(Ytrue[:, c], Ypred[:, c], w, 0.5)
        auc = weighted_auroc(Ytrue[:, c], score_soft[:, c], w)
        ts = two_stage.get(t, {}).get("within_family_F1_test")
        lines.append(f"| {t} | {n} | {prec:.2f} | {rec:.2f} | {f1:.3f} [{bs[0,0,0]:.2f}–{bs[0,0,2]:.2f}] | {auc:.3f} | {ts if ts is not None else '—'} |")
        out_json["techniques"][t] = {"n": n, "precision": float(prec), "recall": float(rec), "F1": float(f1), "F1_ci": [float(bs[0,0,0]), float(bs[0,0,2])], "AUROC": float(auc), "tile_within_family_F1": ts}
    lines.append("")
    lines.append("Note: the tile-model column is within-family F1 on its full held-out set; the VLM column is on this 300-image "
                 "class-stratified sample of the same artists, so prevalences differ — compare AUROC-style rankings and the "
                 "precision/recall shape, not raw F1.")
    open(os.path.join(args.out_dir, "vlm_baseline.md"), "w").write("\n".join(lines) + "\n")
    json.dump(out_json, open(os.path.join(args.out_dir, "vlm_baseline.json"), "w"), indent=2)
    print("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["submit", "score"])
    ap.add_argument("--manifest", default=os.path.join(HERE, "data", "phase2_full.jsonl"))
    ap.add_argument("--held-out", default=os.path.join(HERE, "artifacts", "held_out_artists_2026-09-07.json"))
    ap.add_argument("--out-dir", default=os.path.join(HERE, "artifacts", "vlm_baseline"))
    ap.add_argument("--per-stratum", type=int, default=60)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--chunk", type=int, default=30)
    args = ap.parse_args()
    (submit if args.cmd == "submit" else score)(args)


if __name__ == "__main__":
    main()
