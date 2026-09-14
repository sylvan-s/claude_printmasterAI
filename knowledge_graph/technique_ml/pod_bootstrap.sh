#!/bin/bash
# ADR-0019 Phase 2: bring up a RunPod box for extract_tile_embeddings.py. Steps: ssh + GPU
# check, CPU gate (refuses hosts under 6 effective cores -- an EU-RO-1 L4 measured 2.7),
# copy the bundle, pip install, deliver HF token from ~/.cache/huggingface/token over stdin,
# launch under nohup. Collect with pod_collect.sh; terminate ONLY after SAFE-TO-TERMINATE.
:
set -a; source ~/PycharmProjects/claude_printmasterAI/.env 2>/dev/null; set +a; set -u
HOST=$1; PORT=$2; KEY=$HOME/.ssh/runpod_ed25519   # usage: pod_bootstrap.sh <ip> <port> <bundle.tar.gz> [model] [out-dir]
MODEL=${4:-facebook/dinov3-vitl16-pretrain-lvd1689m}; OUTDIR=${5:-tiles}
BUNDLE=${3:?bundle.tar.gz path}
pod() { ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes root@$HOST "$@"; }
echo "--- ssh + gpu"
ok=0
for i in 1 2 3 4 5 6 8 10; do
  if pod "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader; python -c 'import torch;print(\"torch\",torch.__version__,\"cuda\",torch.cuda.is_available())'"; then ok=1; break; fi
  echo "  ssh not ready (attempt $i), waiting"; sleep 15
done
[ $ok = 1 ] || { echo "SSH FAILED — verbose:"; ssh -v -i "$KEY" -p "$PORT" -o BatchMode=yes root@$HOST true 2>&1 | grep -iE "authentic|denied|refused|closed|Offering|Server accepts" | head; exit 1; }
echo "--- cpu gate"
pod "python - <<'PY'
$(cat "$(dirname "$0")/pod_cpu_test.py")
PY" | tee /tmp/claude-501/pod_cpu.txt
CORES=$(grep -o "effective_cores=[0-9.]*" /tmp/claude-501/pod_cpu.txt | cut -d= -f2)
awk -v c="$CORES" 'BEGIN{exit !(c+0 < 6)}' && { echo "CPU GATE FAILED: effective cores $CORES < 6 — terminate this pod and pick another host"; exit 2; }
echo "--- copying bundle"
scp -q -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=accept-new "$BUNDLE" root@$HOST:/root/ || exit 1
echo "--- installing"
pod "mkdir -p /root/phase2 && cd /root/phase2 && tar xzf /root/phase2_bundle.tar.gz && cd phase2_bundle && pip install -q -r requirements-gpu.txt 2>&1 | tail -2; python -c 'import transformers,PIL,numpy;print(\"transformers\",transformers.__version__,\"pillow\",PIL.__version__,\"numpy\",numpy.__version__)'" || exit 1
echo "--- token"
tr -d '\n' < ~/.cache/huggingface/token | pod "umask 077; cat > /root/.hf_token; wc -c < /root/.hf_token" || exit 1
echo "--- launch"
pod 'cd /root/phase2/phase2_bundle && (OMP_NUM_THREADS=1 HF_TOKEN=$(cat /root/.hf_token) nohup python technique_ml/extract_tile_embeddings.py --manifest phase2_pilot_intaglio.jsonl --out-dir '"$OUTDIR"' --model '"$MODEL"' --workers $(nproc) > /root/phase2/phase2_bundle/extract.log 2>&1 < /dev/null &); sleep 30; tail -3 /root/phase2/phase2_bundle/extract.log; pgrep -f "^python technique_ml" >/dev/null && echo RUNNING || echo NOT-RUNNING'
