"""
PrintMasterAI — merge-review agent, Phase 1: seed model, grouped CV, calibration, gold gate.
Version: MERGE-AGENT-P1-MODEL-1.0

    knowledge_graph/venv-embeddings/bin/python merge_agent/phase1_model.py

Gate (design doc, Phase 1): on the gold set, precision at the operating point >= 0.95 AND its
95% Wilson lower bound >= 0.90. The operating point is chosen on out-of-fold seed predictions,
never on the gold set, so the gold numbers are an honest test.

The gold set is quoted WITHOUT its ULAN-sourced labels (they share evidence with ULAN features).

Checks for the trap this data invites — positives come from pre-merge snapshots, negatives from
the live graph:
  - feature missingness by class (a feature missing mostly for one class is a leak)
  - a SOURCE PROBE: can the features tell a snapshot record from a live one, holding class fixed?
"""
import json
import math
import os
import random
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

import phase1_data as D  # noqa: E402

OUT = os.path.join(HERE, "out")


def wilson_low(k, n, z=1.96):
    if n == 0:
        return float("nan")
    p = k / n
    d = 1 + z * z / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


def groups_for(rows):
    """Connected components over names, so pairs sharing a node never straddle a fold."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for r in rows:
        ra, rb = find(r["a"]), find(r["b"])
        if ra != rb:
            parent[ra] = rb
    ids = {}
    return np.array([ids.setdefault(find(r["a"]), len(ids)) for r in rows])


def matrix(rows, store):
    X = np.array([[D.features(r["ra"], r["rb"], store.surname_count)[k] for k in D.FEATURES] for r in rows])
    return X


def models():
    """Factories: every fit gets a fresh estimator."""
    return {
        "logistic": lambda: make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=2000)),
        "gbt": lambda: HistGradientBoostingClassifier(max_depth=3, learning_rate=0.08, max_iter=250,
                                                      min_samples_leaf=15, l2_regularization=1.0),
    }


def oof(model_fn, X, y, w, g, k=5):
    p = np.zeros(len(y))
    for tr, te in GroupKFold(k).split(X, y, g):
        m = model_fn()
        m.fit(X[tr], y[tr], **({"logisticregression__sample_weight": w[tr]}
                               if hasattr(m, "steps") else {"sample_weight": w[tr]}))
        p[te] = m.predict_proba(X[te])[:, 1]
    return p


def pick_threshold(p, y, target=0.97, min_pos=20):
    """Lowest threshold whose OOF precision >= target (more recall), over >= min_pos positives."""
    order = np.argsort(-p)
    best = None
    tp = fp = 0
    for i in order:
        tp += y[i]
        fp += 1 - y[i]
        if tp >= min_pos and tp / (tp + fp) >= target:
            best = p[i]
    return best if best is not None else 1.0


def main():
    rng = random.Random(20260922)
    gold = {p["id"]: p for p in json.load(open(os.path.join(OUT, "gold_sample.json")))["pairs"]}
    labels = json.load(open(os.path.join(OUT, "gold_labels.json")))
    gold_pairs = {frozenset((p["a"]["name"], p["b"]["name"])) for p in gold.values()}

    drv = D.connect()
    with D.session(drv) as s:
        store = D.RecordStore(s)
        pos = D.seed(store, gold_pairs)
        rej = D.rejected_negatives(s, store, gold_pairs)
    drv.close()
    hard, n_hard = D.hard_negatives(store, gold_pairs, limit=3 * len(pos), rng=rng)
    easy, n_easy = D.easy_negatives(store, gold_pairs, limit=2 * len(pos), rng=rng)
    train = pos + rej + hard + easy
    gtest = D.gold_rows(store, gold, labels)
    print(f"seed: {len(pos)} positives, {len(rej)} rejected-edge negatives, {len(hard)} hard negatives "
          f"(of {n_hard:,} available)")
    print(f"   positive sources: {dict(Counter(r['source'] for r in pos).most_common(8))}")
    print(f"   hard-negative contradictions: {dict(Counter(r['source'] for r in hard))}")
    print(f"   easy negatives (weight 0.5, chosen without dates): {len(easy)} of {n_easy:,} available")
    print(f"gold test (same/different, ULAN-sourced excluded): {len(gtest)} pairs, "
          f"{sum(r['y'] for r in gtest)} same")

    X, y, w = matrix(train, store), np.array([r["y"] for r in train]), np.array([r["w"] for r in train])
    g = groups_for(train)
    Xg, yg = matrix(gtest, store), np.array([r["y"] for r in gtest])

    # --- leak checks
    print("\nMISSINGNESS by class (share of pairs with the field on BOTH sides)")
    for f in ("born_both", "died_both"):
        j = D.FEATURES.index(f)
        print(f"   {f:10s} positives {X[y == 1, j].mean():5.1%}   negatives {X[y == 0, j].mean():5.1%}   "
              f"gold same {Xg[yg == 1, j].mean():5.1%}   gold different {Xg[yg == 0, j].mean():5.1%}")
    for f in ("ulan_same", "ulan_one_sided", "nat_same"):
        j = D.FEATURES.index(f)
        print(f"   {f:14s} positives {X[y == 1, j].mean():5.1%}   negatives {X[y == 0, j].mean():5.1%}   "
              f"gold same {Xg[yg == 1, j].mean():5.1%}   gold different {Xg[yg == 0, j].mean():5.1%}")

    results = {}
    for name, fn in models().items():
        p = oof(fn, X, y, w, g)
        auc = roc_auc_score(y, p, sample_weight=w)
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(p, y, sample_weight=w)
        thr_raw = pick_threshold(p, y)
        m = fn()
        m.fit(X, y, **({"logisticregression__sample_weight": w} if hasattr(m, "steps") else {"sample_weight": w}))
        pg = m.predict_proba(Xg)[:, 1]
        cal = iso.predict(pg)
        gauc = roc_auc_score(yg, pg)
        sel = pg >= thr_raw
        tp, n_sel = int(yg[sel].sum()), int(sel.sum())
        prec = tp / n_sel if n_sel else float("nan")
        rec = tp / yg.sum()
        results[name] = {"oof_auc": auc, "gold_auc": gauc, "thr": float(thr_raw), "tp": tp, "sel": n_sel,
                         "prec": prec, "low": wilson_low(tp, n_sel), "recall": rec, "model": m,
                         "pg": pg, "cal": cal}
        print(f"\n== {name}: OOF AUC {auc:.3f}   GOLD AUC {gauc:.3f}")
        print(f"   operating point (OOF precision >= 0.97): raw score >= {thr_raw:.3f}")
        print(f"   GOLD at that point: {tp}/{n_sel} same-calls correct = precision {prec:.1%} "
              f"(95% low {wilson_low(tp, n_sel):.1%}), recall {rec:.1%} of {int(yg.sum())} same")
        gate = n_sel and prec >= 0.95 and wilson_low(tp, n_sel) >= 0.90
        print(f"   GATE (precision >= 95% and low >= 90%): {'PASS' if gate else 'FAIL'}")
        by = defaultdict(lambda: [0, 0, 0])
        for r, s_, pr in zip(gtest, sel, pg):
            by[r["stratum"]][0] += 1
            by[r["stratum"]][1] += int(s_)
            by[r["stratum"]][2] += int(s_ and r["y"] == 1)
        print("   by stratum (pairs / predicted same / correct):",
              "  ".join(f"{k} {v[0]}/{v[1]}/{v[2]}" for k, v in sorted(by.items())))
        for r, s_, pr in zip(gtest, sel, pg):
            if s_ and r["y"] == 0:
                print(f"   FALSE SAME  {r['id']} {pr:.3f} {r['a'][:34]!r} ~ {r['b'][:34]!r}")
        missed = sorted([(pr, r) for r, s_, pr in zip(gtest, sel, pg) if not s_ and r["y"] == 1],
                        key=lambda t: -t[0])
        print(f"   missed same ({len(missed)}), highest scores first:",
              "; ".join(f"{r['id']} {pr:.2f} {r['a'][:22]}~{r['b'][:22]}" for pr, r in missed[:8]))

    # --- source probe: the SAME negative pairs featurised from pre-merge snapshot records and from
    # live records. If a classifier can tell the two apart, snapshot-vs-live is itself a signal and
    # the positives (snapshot-built) differ from the negatives (live-built) for reasons that are
    # not identity.
    both = [r for r in hard if r["a"] in store.rec and r["b"] in store.rec
            and store.src.get(r["a"]) != "live" and store.src.get(r["b"]) != "live"]
    if len(both) >= 40:
        snap = [dict(r, ra=store.get(r["a"]), rb=store.get(r["b"])) for r in both]
        Xs, Xl = matrix(snap, store), matrix(both, store)
        Xp = np.vstack([Xs, Xl])
        yp = np.r_[np.ones(len(Xs)), np.zeros(len(Xl))]
        gp = np.r_[np.arange(len(Xs)), np.arange(len(Xl))]
        pp = np.zeros(len(yp))
        for tr, te in GroupKFold(5).split(Xp, yp, gp):
            mdl = HistGradientBoostingClassifier(max_depth=3, max_iter=150).fit(Xp[tr], yp[tr])
            pp[te] = mdl.predict_proba(Xp[te])[:, 1]
        diff = (Xs != Xl).any(axis=1).mean()
        print(f"\nSOURCE PROBE on {len(both)} hard negatives featurised both ways: "
              f"AUC snapshot-vs-live {roc_auc_score(yp, pp):.3f} (0.5 = indistinguishable); "
              f"{diff:.1%} of pairs change any feature")
        chg = Counter(D.FEATURES[j] for i in range(len(Xs)) for j in np.nonzero(Xs[i] != Xl[i])[0])
        print("   features that change most:", dict(chg.most_common(6)))

    lr = results["logistic"]["model"]
    coefs = lr.named_steps["logisticregression"].coef_[0]
    top = sorted(zip(D.FEATURES, coefs), key=lambda t: -abs(t[1]))[:14]
    print("\nlogistic coefficients (standardised), largest first:")
    print("   " + "  ".join(f"{f} {c:+.2f}" for f, c in top))

    json.dump({"version": "MERGE-AGENT-P1-MODEL-1.0", "n_train": len(train), "n_pos": len(pos),
               "n_gold": len(gtest), "features": D.FEATURES,
               "results": {k: {kk: vv for kk, vv in v.items() if kk not in ("model", "pg", "cal")}
                           for k, v in results.items()},
               "gold_scores": {k: {r["id"]: float(s_) for r, s_ in zip(gtest, v["pg"])}
                               for k, v in results.items()}},
              open(os.path.join(OUT, "phase1_model_results.json"), "w"), indent=1, default=float)
    print(f"\n-> {OUT}/phase1_model_results.json")


if __name__ == "__main__":
    main()
