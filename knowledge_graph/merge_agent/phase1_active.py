"""
PrintMasterAI — merge-review agent, Phase 1: one active-learning round.
Version: MERGE-AGENT-P1-ACTIVE-1.1

    knowledge_graph/venv-embeddings/bin/python merge_agent/phase1_active.py --round N [--n 60]

Round N trains on the seed plus every earlier round's labels (out/active_round<k>.json), so the
audit always samples the CURRENT model's high band.

WHY. The seed model (phase1_model.py) failed the gold gate with one clear failure shape: same
forename, a surname one or two letters off, no dates ("Brian Wall" ~ "Brian Yale" scored 0.997).
Its out-of-fold AUC was 0.998 against 0.94 on gold: the seed is easier than the pool. The seed has
positives of that shape (typo merges) and no negatives of it, because hard negatives need a
contradiction and those pairs have none. Only labels on LIVE pool pairs supply them, which is what
the design's loop does when the gate fails.

SELECTION, from the live candidate pool (gold pairs, seed pairs and rejected edges excluded):
  half   uncertainty: closest to p = 0.5, spread across name levels
  half   AUDIT: a random sample of the high band (p >= operating threshold) outside the
         `strong` name level — where the false `same`s live. Uncertainty sampling alone never
         reaches them, because the model is confidently wrong there.
LABELS. Haiku 4.5 (prompt LLM-1.2) under Policy A (ulan_verify.apply_policy). same -> 1;
different / collaboration / after -> 0 (none is a merge); unsure -> dropped. Weight 0.7, below human.

Then the model is retrained on seed + these labels and re-scored on the gold set.
"""
import argparse
import json
import os
import random
import sqlite3
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402

import phase1_data as D  # noqa: E402
import phase1_model as M  # noqa: E402

OUT = os.path.join(HERE, "out")
ULAN_DB = os.path.expanduser("~/PycharmProjects/claude_printmasterAI/knowledge_graph/ulan_local.sqlite")

EVIDENCE = """
MATCH (a:Artist)
OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
WITH a, count(DISTINCT w) AS works, collect(DISTINCT w.name)[..6] AS titles
OPTIONAL MATCH (s:SourceRecord)-[:ATTRIBUTED_TO]->(a)
WITH a, works, titles, collect(DISTINCT split(s.id, '-')[0]) AS houses
RETURN a.name AS name, a.dateBorn_year AS born, a.dateDied_year AS died,
       a.nationality AS nat, a.ulanUrl AS ulan, a.wikidataUrl AS wikidata,
       coalesce(a.alternateNames, [])[..6] AS alts, works, titles, houses
"""
SHARED = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)<-[:CREATED]-(b:Artist)
WHERE a.name < b.name
RETURN a.name AS a, b.name AS b, count(DISTINCT w) AS n, collect(DISTINCT w.name)[..3] AS titles
"""


def name_level(a, b):
    f = D.features({"name": a}, {"name": b}, Counter())
    if f["name_exact_norm"] or f["name_token_bag"] or f["name_squashed"]:
        return "strong"
    if f["name_subset"]:
        return "subset"
    if f["name_typo"] or f["name_initialism"] or f["surname_edit1"] or f["jaro_winkler"] >= 0.88:
        return "fuzzy"
    return "weak"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--round", type=int, default=1)
    args = ap.parse_args()
    rng = random.Random(20260923 + args.round)

    gold = {p["id"]: p for p in json.load(open(os.path.join(OUT, "gold_sample.json")))["pairs"]}
    labels = json.load(open(os.path.join(OUT, "gold_labels.json")))
    gold_pairs = {frozenset((p["a"]["name"], p["b"]["name"])) for p in gold.values()}

    drv = D.connect()
    with D.session(drv) as s:
        store = D.RecordStore(s)
        pos = D.seed(store, gold_pairs)
        rej = D.rejected_negatives(s, store, gold_pairs)
        ev = {r["name"]: dict(r) for r in s.run(EVIDENCE) if r["name"]}
        shared = {frozenset((r["a"], r["b"])): dict(r) for r in s.run(SHARED)}
    drv.close()
    hard, _ = D.hard_negatives(store, gold_pairs, limit=3 * len(pos), rng=random.Random(20260922))
    easy, _ = D.easy_negatives(store, gold_pairs, limit=2 * len(pos), rng=random.Random(20260922))
    seed = pos + rej + hard + easy
    gtest = D.gold_rows(store, gold, labels)
    prior = []
    for k in range(1, args.round):
        for r in json.load(open(os.path.join(OUT, f"active_round{k}.json")))["batch"]:
            if r["final"] in ("same", "different", "collaboration", "after"):
                prior.append({"a": r["a"], "b": r["b"], "y": int(r["final"] == "same"), "w": 0.7,
                              "source": f"active{k}:{r['why']}", "ra": store.get(r["a"], live=True),
                              "rb": store.get(r["b"], live=True)})
    if prior:
        print(f"carrying {len(prior)} labels from rounds 1..{args.round - 1}")
    seed = seed + prior

    # ---------------------------------------------------------------- seed model and the pool
    X, y, w = M.matrix(seed, store), np.array([r["y"] for r in seed]), np.array([r["w"] for r in seed])
    oofp = M.oof(M.models()["gbt"], X, y, w, M.groups_for(seed))
    thr = M.pick_threshold(oofp, y)
    model = M.models()["gbt"]()
    model.fit(X, y, sample_weight=w)

    used = gold_pairs | {frozenset((r["a"], r["b"])) for r in seed}
    pool = [p for p in D.candidate_pool(store, set(shared)) if p not in used]
    prow = [{"a": a, "b": b, "ra": store.get(a, live=True), "rb": store.get(b, live=True)}
            for a, b in (sorted(p) for p in pool)]
    pp = model.predict_proba(M.matrix(prow, store))[:, 1]
    for r, p in zip(prow, pp):
        r["p"], r["level"] = float(p), name_level(r["a"], r["b"])
    print(f"live pool {len(prow):,} pairs after excluding gold/seed; seed-model threshold {thr:.3f}; "
          f"{int((pp >= thr).sum()):,} pairs score above it")
    print("   pool by name level:", dict(Counter(r["level"] for r in prow)))
    print("   above threshold by level:", dict(Counter(r["level"] for r in prow if r["p"] >= thr)))

    half = args.n // 2
    audit_band = [r for r in prow if r["p"] >= thr and r["level"] != "strong"]
    audit = rng.sample(audit_band, min(half, len(audit_band)))
    chosen = {(r["a"], r["b"]) for r in audit}
    unc = []
    for lvl in ("fuzzy", "subset", "weak", "strong"):
        cand = sorted((r for r in prow if r["level"] == lvl and (r["a"], r["b"]) not in chosen),
                      key=lambda r: abs(r["p"] - 0.5))
        unc += cand[: max(1, (args.n - len(audit)) // 4)]
    unc = unc[: args.n - len(audit)]
    for r in audit:
        r["why"] = "audit"
    for r in unc:
        r["why"] = "uncertain"
    batch = audit + unc
    print(f"selected {len(audit)} audit + {len(unc)} uncertainty pairs "
          f"(audit band: {len(audit_band):,} non-strong pairs above threshold)")

    # ------------------------------------------------------------------- label with Haiku + Policy A
    import anthropic
    import phase0_llm_calibration as L
    from ulan_verify import UlanIndex, apply_policy
    con = sqlite3.connect(ULAN_DB)

    def side(n):
        e = dict(ev.get(n, {"name": n}))
        u = (e.get("ulan") or "").rstrip("/").split("/")[-1]
        row = con.execute("SELECT pref_name, bio FROM ulan_person WHERE ulan_id=?", (u,)).fetchone() if u else None
        e["ulanBio"] = f"{row[0]}: {row[1]}" if row else None
        return e
    pairs = []
    for r in batch:
        sw = shared.get(frozenset((r["a"], r["b"])))
        pairs.append({"a": side(r["a"]), "b": side(r["b"]), "sharedWorks": sw["n"] if sw else 0,
                      "sharedTitles": sw["titles"] if sw else []})
    client = anthropic.Anthropic()
    with ThreadPoolExecutor(8) as ex:
        answers = list(ex.map(lambda p: L.ask(client, p), pairs))
    con.close()
    ix = UlanIndex()
    cost = sum(a["usage"][0] for a in answers) / 1e6 + 5 * sum(a["usage"][1] for a in answers) / 1e6
    al = []
    for r, p, a in zip(batch, pairs, answers):
        verdict = ix.verify(p["a"], p["b"])[0] if a["label"] == "same" else None
        final = apply_policy(a["label"], a.get("basis"), verdict)
        r.update(haiku=a["label"], basis=a.get("basis"), ulan=verdict, final=final, reason=a["reason"])
        if final in ("same", "different", "collaboration", "after"):
            al.append({"a": r["a"], "b": r["b"], "y": int(final == "same"), "w": 0.7,
                       "source": f"active:{r['why']}", "ra": r["ra"], "rb": r["rb"]})
    print(f"\nHaiku ({'$%.3f' % cost}): {dict(Counter(r['haiku'] for r in batch))}; after Policy A: "
          f"{dict(Counter(r['final'] for r in batch))}")
    for why in ("audit", "uncertain"):
        grp = [r for r in batch if r["why"] == why]
        s_ = sum(r["final"] == "same" for r in grp)
        dec = sum(r["final"] in ("same", "different", "collaboration", "after") for r in grp)
        print(f"   {why:9s}: {s_}/{dec} decided pairs labelled same"
              + (f"  -> AUDIT precision of the high band {s_}/{dec} = {s_ / dec:.0%} (95% low "
                 f"{M.wilson_low(s_, dec):.0%})" if why == "audit" and dec else ""))
    for r in audit:
        if r["final"] != "same":
            print(f"      audit, model p={r['p']:.2f} but {r['final']:13s} [{r['level']}] {r['a'][:30]!r} ~ {r['b'][:30]!r}")

    # --------------------------------------------------------------------------- retrain + gold
    print("\nRETRAIN with the active-learning labels (weight 0.7):")
    for label, rows in ((f"before round {args.round}", seed), (f"after round {args.round}", seed + al)):
        X2, y2, w2 = M.matrix(rows, store), np.array([r["y"] for r in rows]), np.array([r["w"] for r in rows])
        o = M.oof(M.models()["gbt"], X2, y2, w2, M.groups_for(rows))
        t = M.pick_threshold(o, y2)
        m = M.models()["gbt"]()
        m.fit(X2, y2, sample_weight=w2)
        Xg, yg = M.matrix(gtest, store), np.array([r["y"] for r in gtest])
        pg = m.predict_proba(Xg)[:, 1]
        sel = pg >= t
        tp, n = int(yg[sel].sum()), int(sel.sum())
        gate = n and tp / n >= 0.95 and M.wilson_low(tp, n) >= 0.90
        print(f"   {label:15s} OOF AUC {roc_auc_score(y2, o, sample_weight=w2):.3f}  GOLD AUC "
              f"{roc_auc_score(yg, pg):.3f}  gold same-calls {tp}/{n} = {tp / n:.1%} (low "
              f"{M.wilson_low(tp, n):.1%}), recall {tp / yg.sum():.1%}   {'PASS' if gate else 'FAIL'}")
        for r, s_, p in zip(gtest, sel, pg):
            if s_ and r["y"] == 0:
                print(f"      false same {r['id']} {p:.2f} {r['a'][:30]!r} ~ {r['b'][:30]!r}")

    json.dump({"version": "MERGE-AGENT-P1-ACTIVE-1.1", "round": args.round, "threshold": thr,
               "cost": round(cost, 4),
               "batch": [{k: v for k, v in r.items() if k not in ("ra", "rb")} for r in batch]},
              open(os.path.join(OUT, f"active_round{args.round}.json"), "w"), indent=1, default=str)
    print(f"\n-> {OUT}/active_round{args.round}.json")


if __name__ == "__main__":
    main()
