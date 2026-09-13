"""
PrintMasterAI — ADR-0019 Phase 2: minimal RunPod pod control over the REST API.
Version: TECHML-RUNPOD-1.0

Creates, inspects and terminates the GPU pod the tile extraction runs on. Reads
RUNPOD_API_KEY from the environment (put it in the repo .env; never commit it). The pod
gets the SSH public key passed via --ssh-pubkey injected as SSH_PUBLIC_KEY, so no key
has to be registered on the RunPod account, and it exposes 22/tcp on a public IP so scp
and rsync work (the ssh.runpod.io proxy does not support them).

    python runpod_pod.py create --name printmaster-phase2 --ssh-pubkey ~/.ssh/runpod_ed25519.pub
    python runpod_pod.py status <podId>          # prints publicIp + mapped SSH port when ready
    python runpod_pod.py list
    python runpod_pod.py terminate <podId>       # DELETE — stops billing entirely

Endpoints: https://rest.runpod.io/v1/pods (POST/GET), /pods/{id} (GET/DELETE),
/pods/{id}/stop and /start (POST). GPU ids from docs.runpod.io/references/gpu-types.
"""

import argparse
import json
import os
import sys
import time

import requests

BASE = "https://rest.runpod.io/v1"
# Cheapest-first among cards with >= 24 GB; the API tries them in order under
# gpuTypePriority=custom. ViT-L fp16 at batch 32 needs ~6 GB, so any of these is plenty.
DEFAULT_GPUS = ["NVIDIA RTX A5000", "NVIDIA L4", "NVIDIA GeForce RTX 4090", "NVIDIA A40", "NVIDIA RTX A6000"]


def _headers():
    key = os.environ.get("RUNPOD_API_KEY")
    if not key:
        sys.exit("RUNPOD_API_KEY is not set (source the repo .env)")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def create(args):
    pubkey = open(os.path.expanduser(args.ssh_pubkey)).read().strip()
    body = {
        "name": args.name,
        "imageName": args.image,
        "gpuTypeIds": args.gpus.split(",") if args.gpus else DEFAULT_GPUS,
        "gpuTypePriority": "custom",
        "gpuCount": 1,
        "cloudType": args.cloud,
        "containerDiskInGb": args.disk,
        "volumeInGb": 0,
        "ports": ["22/tcp"],
        "env": {"SSH_PUBLIC_KEY": pubkey},
    }
    r = requests.post(f"{BASE}/pods", headers=_headers(), json=body, timeout=60)
    if r.status_code not in (200, 201):
        sys.exit(f"create failed: HTTP {r.status_code} {r.text[:500]}")
    pod = r.json()
    print(json.dumps({k: pod.get(k) for k in ("id", "name", "desiredStatus", "machine", "costPerHr")}, indent=2))
    print(f"pod id: {pod['id']}")
    return pod["id"]


def status(args):
    r = requests.get(f"{BASE}/pods/{args.pod_id}", headers=_headers(), timeout=60)
    if r.status_code != 200:
        sys.exit(f"status failed: HTTP {r.status_code} {r.text[:300]}")
    pod = r.json()
    ip, ports = pod.get("publicIp"), pod.get("portMappings") or {}
    ssh_port = ports.get("22")
    print(json.dumps({k: pod.get(k) for k in ("id", "name", "desiredStatus", "costPerHr", "publicIp", "portMappings",
                                               "gpu", "machine")}, indent=2, default=str))
    if ip and ssh_port:
        print(f"\nssh -i ~/.ssh/runpod_ed25519 -p {ssh_port} root@{ip}")
    return pod


def wait(args):
    for _ in range(60):
        r = requests.get(f"{BASE}/pods/{args.pod_id}", headers=_headers(), timeout=60)
        pod = r.json() if r.status_code == 200 else {}
        ip, ports = pod.get("publicIp"), pod.get("portMappings") or {}
        if ip and ports.get("22"):
            print(f"{ip} {ports['22']}")
            return
        time.sleep(10)
    sys.exit("pod did not get a public IP / SSH port within 10 minutes")


def list_pods(args):
    r = requests.get(f"{BASE}/pods", headers=_headers(), timeout=60)
    if r.status_code != 200:
        sys.exit(f"list failed: HTTP {r.status_code} {r.text[:300]}")
    for pod in r.json():
        print(pod.get("id"), pod.get("name"), pod.get("desiredStatus"), pod.get("costPerHr"), pod.get("publicIp"))


def terminate(args):
    r = requests.delete(f"{BASE}/pods/{args.pod_id}", headers=_headers(), timeout=60)
    print(f"terminate {args.pod_id}: HTTP {r.status_code} {r.text[:200]}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--name", default="printmaster-phase2")
    c.add_argument("--image", default="runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04")
    c.add_argument("--gpus", help="comma-separated gpuTypeIds in priority order")
    c.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
    c.add_argument("--disk", type=int, default=30)
    c.add_argument("--ssh-pubkey", default="~/.ssh/runpod_ed25519.pub")
    c.set_defaults(fn=create)
    for name, fn in (("status", status), ("wait", wait), ("terminate", terminate)):
        p = sub.add_parser(name)
        p.add_argument("pod_id")
        p.set_defaults(fn=fn)
    sub.add_parser("list").set_defaults(fn=list_pods)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
