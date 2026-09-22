"""
PrintMasterAI — merge-review agent, Phase 1: the audit-disagreement adjudication set.
Version: MERGE-AGENT-P1-ADJ-1.0

Every distinct pair from the active-learning AUDITS (rounds 1..5) where the model scored above its
operating threshold but the LLM, after Policy A, did not say `same` (different / a relation /
unsure). A person labels them on a page shaped like the gold labeller, with neither the model score
nor the LLM answer shown. Ordered newest round first: rounds 4-5 audit the current model.

The labels serve twice: they re-score the audits with human ground truth, and they join training
as human labels (weight 1.0).

    knowledge_graph/venv-embeddings/bin/python merge_agent/phase1_adjudication_set.py
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phase1_data as D  # noqa: E402
from phase1_active import EVIDENCE, SHARED, ULAN_DB  # noqa: E402

OUT = os.path.join(HERE, "out")


def main():
    seen = {}
    for k in range(5, 0, -1):
        path = os.path.join(OUT, f"active_round{k}.json")
        if not os.path.exists(path):
            continue
        for r in json.load(open(path))["batch"]:
            if r["why"] == "audit" and r["final"] != "same":
                seen.setdefault(frozenset((r["a"], r["b"])), dict(r, round=k))
    drv = D.connect()
    with D.session(drv) as s:
        ev = {r["name"]: dict(r) for r in s.run(EVIDENCE) if r["name"]}
        shared = {frozenset((r["a"], r["b"])): dict(r) for r in s.run(SHARED)}
    drv.close()
    con = sqlite3.connect(ULAN_DB)

    def side(n):
        e = {k: v for k, v in ev.get(n, {"name": n}).items()}
        u = (e.get("ulan") or "").rstrip("/").split("/")[-1]
        row = con.execute("SELECT pref_name, bio FROM ulan_person WHERE ulan_id=?", (u,)).fetchone() if u else None
        e["ulanBio"] = f"{row[0]}: {row[1]}" if row else None
        return e
    docs, key = [], []
    for i, (pair, r) in enumerate(sorted(seen.items(), key=lambda kv: (-kv[1]["round"], -kv[1]["p"])), 1):
        sw = shared.get(pair)
        pid = f"adj{i:02d}"
        docs.append({"id": pid, "a": side(r["a"]), "b": side(r["b"]),
                     "sharedWorks": sw["n"] if sw else 0, "sharedTitles": sw["titles"] if sw else []})
        key.append({"id": pid, "round": r["round"], "p": r["p"], "level": r["level"],
                    "haiku": r["haiku"], "basis": r.get("basis"), "final": r["final"],
                    "a": r["a"], "b": r["b"]})
    con.close()
    json.dump(docs, open(os.path.join(OUT, "adjudication_pairs.json"), "w"), indent=1, default=str)
    json.dump(key, open(os.path.join(OUT, "adjudication_key.json"), "w"), indent=1, default=str)
    print(f"{len(docs)} pairs -> out/adjudication_pairs.json (page docs), out/adjudication_key.json (hidden key)")


if __name__ == "__main__":
    main()
