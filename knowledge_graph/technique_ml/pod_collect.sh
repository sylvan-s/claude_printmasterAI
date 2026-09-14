#!/bin/bash
# Copy the extraction shards off the pod as a tar stream (no rsync dependency), verify them
# locally, and ONLY THEN print SAFE-TO-TERMINATE. Never terminates anything itself.
set -u
HOST=$1; PORT=$2; DEST=${3:-$HOME/PycharmProjects/claude_printmasterAI-deepdive/knowledge_graph/technique_ml/data/tiles_pilot}; REMOTE=${4:-tiles}
KEY=$HOME/.ssh/runpod_ed25519
mkdir -p "$DEST"
echo "--- streaming tiles/ from pod"
ssh -i "$KEY" -p "$PORT" -o BatchMode=yes root@$HOST "cd /root/phase2/phase2_bundle && tar czf - $REMOTE extract.log" | tar xzf - -C "$DEST" --strip-components=0 || { echo "COPY FAILED"; exit 1; }
[ -d "$DEST/$REMOTE" ] && { mv "$DEST"/$REMOTE/* "$DEST"/ && rmdir "$DEST/$REMOTE"; }
du -sh "$DEST"; ls "$DEST" | head -20
echo "--- verify"
~/PycharmProjects/claude_printmasterAI/knowledge_graph/venv-embeddings/bin/python - "$DEST" <<'PY' 2>&1 | grep -v -i warn
import glob, sys, numpy as np
d = sys.argv[1]; n = fine = 0; ids = set(); bad = 0
for p in sorted(glob.glob(d + "/tiles_*.npz")):
    z = np.load(p); n += len(z["image_ids"]); fine += int(z["has_fine"].sum()); ids.update(z["image_ids"].tolist())
    assert z["primary_cls"].shape[1:] == (16, 1024), p
    assert np.isfinite(z["primary_cls"]).all() and np.isfinite(z["fine_cls"]).all(), f"NON-FINITE values in {p}"
    bad += int((np.abs(z["primary_cls"].astype(np.float32)).sum((1, 2)) == 0).sum())
print(f"shards: {n} images ({len(ids)} unique), {fine} with fine scale, {bad} empty rows")
print("failures logged:", sum(1 for _ in open(d + "/failures.jsonl")))
assert n > 0 and bad == 0 and len(ids) == n
print("SAFE-TO-TERMINATE")
PY
