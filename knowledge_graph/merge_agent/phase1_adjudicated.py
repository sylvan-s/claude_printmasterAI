"""
PrintMasterAI — merge-review agent, Phase 1: re-score the audits with the human adjudication, retrain.
Version: MERGE-AGENT-P1-ADJ-SCORE-1.0

    knowledge_graph/venv-embeddings/bin/python merge_agent/phase1_adjudicated.py --labels <dir>

The adjudication set (phase1_adjudication_set.py) is every audit pair where the model said `same`
and the LLM, after Policy A, did not. A person labelled them without seeing either answer.

1. AUDITS RE-SCORED. For each round's audit, truth is the human label where one exists, else the
   LLM's `same` (those pairs were never disputed). Human `unsure` pairs are left out.
2. THE LABELLER. How often the LLM's non-`same` was right, by what it said.
3. RETRAIN. Seed + active-learning labels with the human labels overriding the LLM's (weight 1.0;
   pairs the LLM had left `unsure` and a person decided are added). Gold is scored before and after.
"""
import argparse
import glob
import json
import os
import random
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402

import phase1_data as D  # noqa: E402
import phase1_model as M  # noqa: E402

OUT = os.path.join(HERE, "out")
DECIDED = ("same", "different", "collaboration", "after")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--labels", required=True)
    args = ap.parse_args()

    key = {k["id"]: k for k in json.load(open(os.path.join(OUT, "adjudication_key.json")))}
    human = {}
    for f in glob.glob(os.path.join(args.labels, "labels", "*.json")) or glob.glob(os.path.join(args.labels, "*.json")):
        d = json.load(open(f))
        human[os.path.basename(f)[:-5]] = d.get("data", d)
    adj = {frozenset((k["a"], k["b"])): dict(k, human=human[i]["label"], note=human[i].get("note", ""))
           for i, k in key.items() if i in human}
    print(f"{len(adj)} adjudicated pairs; human labels: {dict(Counter(v['human'] for v in adj.values()))}")
    json.dump({i: {**key[i], "human": human[i]["label"], "note": human[i].get("note", "")} for i in key if i in human},
              open(os.path.join(OUT, "adjudication_labels.json"), "w"), indent=1, default=str)

    # ------------------------------------------------------------------ 1. audits re-scored
    rounds = {}
    for k in range(1, 6):
        rounds[k] = json.load(open(os.path.join(OUT, f"active_round{k}.json")))["batch"]
    print("\nAUDIT PRECISION of the model's high band — as scored by the LLM, then with human truth")
    print(f"   {'round':6s} {'LLM-scored':>14s} {'human-scored':>16s} {'95% low':>8s}")
    pooled = [0, 0]
    for k, batch in rounds.items():
        a = [r for r in batch if r["why"] == "audit"]
        llm = [r["final"] for r in a if r["final"] in DECIDED]
        truth = []
        for r in a:
            h = adj.get(frozenset((r["a"], r["b"])))
            t = h["human"] if h else r["final"]
            if t in DECIDED:
                truth.append(t)
        s1, n1 = sum(x == "same" for x in llm), len(llm)
        s2, n2 = sum(x == "same" for x in truth), len(truth)
        if k >= 4:
            pooled[0] += s2
            pooled[1] += n2
        print(f"   {k:<6d} {s1:3d}/{n1:<3d} {s1 / n1:5.0%}   {s2:3d}/{n2:<3d} {s2 / n2:5.0%}   {M.wilson_low(s2, n2):7.1%}")
    print(f"   rounds 4+5 pooled (current features), human-scored: {pooled[0]}/{pooled[1]} = "
          f"{pooled[0] / pooled[1]:.1%}, 95% low {M.wilson_low(*pooled):.1%}")

    # ------------------------------------------------------------------ 2. the labeller
    tab = Counter((v["final"], v["human"]) for v in adj.values())
    print("\nLLM (after Policy A) vs person, on the disputed pairs:")
    for (llm, hum), n in sorted(tab.items(), key=lambda t: -t[1]):
        print(f"   LLM {llm:13s} person {hum:13s} {n}")
    wrong_diff = [v for v in adj.values() if v["final"] == "different" and v["human"] == "same"]
    print(f"   LLM said different, person said same: {len(wrong_diff)} — "
          + "; ".join(f"{v['a'][:22]}~{v['b'][:22]}" for v in wrong_diff[:8]))
    unsure_same = sum(v["final"] == "unsure" and v["human"] == "same" for v in adj.values())
    print(f"   LLM/Policy A left unsure, person said same: {unsure_same}")

    # ------------------------------------------------------------------ 3. retrain
    gold = {p["id"]: p for p in json.load(open(os.path.join(OUT, "gold_sample.json")))["pairs"]}
    labels = json.load(open(os.path.join(OUT, "gold_labels.json")))
    gold_pairs = {frozenset((p["a"]["name"], p["b"]["name"])) for p in gold.values()}
    drv = D.connect()
    with D.session(drv) as s:
        store = D.RecordStore(s)
        pos = D.seed(store, gold_pairs)
        rej = D.rejected_negatives(s, store, gold_pairs)
    drv.close()
    hard, _ = D.hard_negatives(store, gold_pairs, limit=3 * len(pos), rng=random.Random(20260922))
    easy, _ = D.easy_negatives(store, gold_pairs, limit=2 * len(pos), rng=random.Random(20260922))
    seed = pos + rej + hard + easy
    gtest = D.gold_rows(store, gold, labels)

    def al_rows(use_human):
        out, seen = [], set()
        for k, batch in rounds.items():
            for r in batch:
                pair = frozenset((r["a"], r["b"]))
                if pair in seen:
                    continue
                h = adj.get(pair) if use_human else None
                lab, w, src = (h["human"], 1.0, "human") if h else (r["final"], 0.7, "llm")
                if lab not in DECIDED:
                    continue
                seen.add(pair)
                out.append({"a": r["a"], "b": r["b"], "y": int(lab == "same"), "w": w,
                            "source": f"{src}:r{k}", "ra": store.get(r["a"], live=True),
                            "rb": store.get(r["b"], live=True)})
        return out

    print("\nRETRAIN (features DATA-1.2), gold scored at the OOF-chosen operating point:")
    Xg, yg = M.matrix(gtest, store), np.array([r["y"] for r in gtest])
    res = {}
    for label, rows in (("LLM labels only", seed + al_rows(False)),
                        ("with human adjudication", seed + al_rows(True))):
        X, y, w = M.matrix(rows, store), np.array([r["y"] for r in rows]), np.array([r["w"] for r in rows])
        o = M.oof(M.models()["gbt"], X, y, w, M.groups_for(rows))
        t = M.pick_threshold(o, y)
        m = M.models()["gbt"]()
        m.fit(X, y, sample_weight=w)
        pg = m.predict_proba(Xg)[:, 1]
        sel = pg >= t
        tp, n = int(yg[sel].sum()), int(sel.sum())
        gate = n and tp / n >= 0.95 and M.wilson_low(tp, n) >= 0.90
        src = Counter(r["source"].split(":")[0] for r in rows if ":" in r["source"] and r["source"].split(":")[0] in ("llm", "human"))
        print(f"   {label:24s} {len(rows)} rows {dict(src)}; OOF AUC {roc_auc_score(y, o, sample_weight=w):.3f}; "
              f"GOLD AUC {roc_auc_score(yg, pg):.3f}; same-calls {tp}/{n} = {tp / n:.1%} (low "
              f"{M.wilson_low(tp, n):.1%}), recall {tp / yg.sum():.1%}  {'PASS' if gate else 'FAIL'}")
        for r, s_, p in zip(gtest, sel, pg):
            if s_ and r["y"] == 0:
                print(f"      false same {r['id']} {p:.2f} {r['a'][:30]!r} ~ {r['b'][:30]!r}")
        res[label] = {"tp": tp, "n": n, "recall": tp / yg.sum(), "gold_auc": roc_auc_score(yg, pg), "thr": t}
    json.dump({"version": "MERGE-AGENT-P1-ADJ-SCORE-1.0", "retrain": res}, open(os.path.join(OUT, "phase1_adjudicated_results.json"), "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
