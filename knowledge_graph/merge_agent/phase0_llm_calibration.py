"""
PrintMasterAI — merge-review agent, Phase 0: calibrate the LLM labeller against the gold set.
Version: MERGE-AGENT-P0-LLM-1.1

The design doc's Phase 0 gate: the LLM may label a stratum for the agent only if it agrees with
the human gold labels at >= 95% on that stratum. Haiku 4.5 is the candidate (13/14 of Opus on the
2026-09-10 vision adjudication at ~10x less).

EVIDENCE PARITY. The model sees exactly what the labelling page showed the person — names, dates,
nationality, ULAN id + local-mirror bio, Wikidata id, source houses, aliases, work count, sample
titles, works credited to both — plus the trap list written out. It never sees the stratum.

LABELS. same | different | collaboration | after | unsure, the page's five. Agreement is scored
three ways, because they answer different questions:
  identity    pairs the person called same/different: does Haiku agree? Its `unsure` is an
              abstention, reported as coverage, not counted as agreement.
  same-precision  of the pairs Haiku calls `same`, how many did the person call `same` — the
              number that matters, since a false `same` is a false merge.
  relation    pairs the person called collaboration/after: does Haiku see the relation?
Pairs the person left `unsure` have no ground truth; what Haiku says there is listed, unscored.

    python3 merge_agent/phase0_llm_calibration.py --labels <dir of labels/*.json> [--workers 8]
"""
import argparse
import glob
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
import anthropic  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = "claude-haiku-4-5"
LABELS = ["same", "different", "collaboration", "after", "unsure"]

SYSTEM = """You review pairs of Artist records from a knowledge graph of fine-art prints built \
from museum and auction-house catalogues. For each pair decide how the two records relate.

Answer with exactly one label:
- same: both records are the same real individual (or the same established group) under two \
spellings, name forms, or catalogue conventions.
- different: two different people or entities.
- collaboration: one record is a joint credit that INCLUDES the other (e.g. "Paul Eluard and Pablo \
Picasso" vs "Pablo Picasso"). Neither same nor different.
- after: one record credits a reproductive engraver/printmaker working AFTER a designer, and the \
other record is that designer or that engraver (e.g. "Francis Holl after William Powell Frith" vs \
"William Powell Frith"). Neither same nor different.
- unsure: the evidence given cannot settle it.

Composite credits (joint credits, "X after Y"):
- two spellings of the SAME composite credit (e.g. "Edgar Degas And George W. Thornley" vs \
"Edgar Degas and George Thornley") are `same`.
- a composite vs one of its own parties is `collaboration` or `after`.
- two composites that differ in a party (two different engravers after one designer) are \
`different`.

Known traps — do not call these `same`:
- family members sharing a surname (father/son, grandparents, siblings), e.g. Alexander Calder vs \
Alexander Milne Calder; check birth years.
- a collaboration or duo credit vs one of its members.
- "after X", "school of X", "workshop of X", "circle of X", "follower of X" vs X.
- publisher, printer or sale-note strings recorded as if they were artists.
- a common surname with different forenames.
Missing dates or ULAN ids are not evidence either way. Use the ULAN bio when present. Your own \
knowledge of well-known artists is allowed, but say when you rely on it.

Keep the reason to one or two sentences."""

SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "enum": LABELS},
        "reason": {"type": "string"},
    },
    "required": ["label", "reason"],
    "additionalProperties": False,
}


def side(tag, p):
    alts = [a for a in (p.get("alts") or []) if a and a != p["name"]]
    titles = [t for t in (p.get("titles") or []) if t]
    dates = "no dates" if p.get("born") is None and p.get("died") is None else \
        f"{p.get('born') or '?'}–{p.get('died') or ''}"
    return "\n".join([
        f"Record {tag}: {p['name']}",
        f"  dates: {dates}",
        f"  nationality: {p.get('nat') or 'unknown'}",
        f"  ULAN: {(p.get('ulan') or 'none').rstrip('/').split('/')[-1]}"
        + (f" — {p['ulanBio']}" if p.get("ulanBio") else ""),
        f"  Wikidata: {(p.get('wikidata') or 'none').rstrip('/').split('/')[-1]}",
        f"  sources: {', '.join(p.get('houses') or []) or 'none'}",
        f"  aliases: {' · '.join(alts) if alts else 'none'}",
        f"  works: {p.get('works') or 0}" + (f"; e.g. {' | '.join(titles)}" if titles else ""),
    ])


def prompt(pair):
    shared = (f"\nWorks credited to both records: {pair['sharedWorks']} "
              f"({' | '.join(pair.get('sharedTitles') or [])})") if pair.get("sharedWorks") else ""
    return f"{side('A', pair['a'])}\n\n{side('B', pair['b'])}{shared}\n\nHow do A and B relate?"


def ask(client, pair, retries=4):
    for attempt in range(retries):
        try:
            r = client.messages.create(
                model=MODEL, max_tokens=400, system=SYSTEM,
                messages=[{"role": "user", "content": prompt(pair)}],
                extra_body={"output_config": {"format": {"type": "json_schema", "schema": SCHEMA}}},
            )
            if r.stop_reason == "refusal":
                return {"label": "unsure", "reason": "model refused", "refused": True,
                        "usage": [r.usage.input_tokens, r.usage.output_tokens]}
            text = next(b.text for b in r.content if b.type == "text")
            out = json.loads(text)
            out["usage"] = [r.usage.input_tokens, r.usage.output_tokens]
            return out
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
            time.sleep(2 ** attempt + 1)
    return {"label": "unsure", "reason": "call failed after retries", "failed": True, "usage": [0, 0]}


def wilson_low(k, n, z=1.96):
    if n == 0:
        return float("nan")
    p = k / n
    d = 1 + z * z / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--labels", required=True, help="directory holding labels/<gNNN>.json")
    ap.add_argument("--gold", default=os.path.join(HERE, "out", "gold_sample.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "out", "llm_calibration_haiku.json"))
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    gold = {p["id"]: p for p in json.load(open(args.gold))["pairs"]}
    human = {}
    for f in glob.glob(os.path.join(args.labels, "labels", "*.json")) or glob.glob(os.path.join(args.labels, "*.json")):
        d = json.load(open(f))
        human[os.path.basename(f)[:-5]] = d.get("data", d)
    ids = sorted(set(gold) & set(human))
    print(f"{len(ids)} labelled pairs; human: {dict(Counter(human[i]['label'] for i in ids))}")

    client = anthropic.Anthropic()
    with ThreadPoolExecutor(args.workers) as ex:
        res = dict(zip(ids, ex.map(lambda i: ask(client, gold[i]), ids)))
    tin = sum(r["usage"][0] for r in res.values())
    tout = sum(r["usage"][1] for r in res.values())
    cost = tin / 1e6 * 1.0 + tout / 1e6 * 5.0
    print(f"Haiku: {dict(Counter(r['label'] for r in res.values()))}; "
          f"{tin:,} in / {tout:,} out tokens, ${cost:.3f}; "
          f"failed {sum(bool(r.get('failed')) for r in res.values())}, "
          f"refused {sum(bool(r.get('refused')) for r in res.values())}")

    # ---------------------------------------------------------------- identity pairs (same/different)
    by = defaultdict(lambda: Counter())
    rows = []
    for i in ids:
        h, m, st = human[i]["label"], res[i]["label"], gold[i]["stratum"]
        rows.append({"id": i, "stratum": st, "human": h, "haiku": m, "reason": res[i]["reason"],
                     "a": gold[i]["a"]["name"], "b": gold[i]["b"]["name"]})
        if h in ("same", "different"):
            by[st]["n"] += 1
            if m == "unsure":
                by[st]["abstain"] += 1
            elif m in ("collaboration", "after"):
                by[st]["relation"] += 1
            else:
                by[st]["committed"] += 1
                by[st]["agree"] += (m == h)

    print("\nIDENTITY — pairs the person called same/different")
    print(f"   {'stratum':14s} {'n':>3s} {'commit':>6s} {'agree':>6s} {'rate':>6s} {'95% low':>8s}  gate")
    tot = Counter()
    for st in sorted(by):
        c = by[st]
        rate = c["agree"] / c["committed"] if c["committed"] else float("nan")
        low = wilson_low(c["agree"], c["committed"])
        gate = "PASS" if c["committed"] and rate >= 0.95 else "fail"
        print(f"   {st:14s} {c['n']:3d} {c['committed']:6d} {c['agree']:6d} {rate:6.1%} {low:8.1%}  {gate}"
              + (f"   (abstained {c['abstain']}, called a relation {c['relation']})"
                 if c["abstain"] or c["relation"] else ""))
        tot.update(c)
    print(f"   {'ALL':14s} {tot['n']:3d} {tot['committed']:6d} {tot['agree']:6d} "
          f"{tot['agree'] / tot['committed']:6.1%} {wilson_low(tot['agree'], tot['committed']):8.1%}")

    said_same = [r for r in rows if r["haiku"] == "same" and r["human"] in LABELS]
    true_same = [r for r in said_same if r["human"] == "same"]
    print(f"\nSAME-PRECISION — Haiku said `same` {len(said_same)}x; the person agreed {len(true_same)}x "
          f"({len(true_same) / max(len(said_same), 1):.1%}, 95% low "
          f"{wilson_low(len(true_same), len(said_same)):.1%})")
    for r in said_same:
        if r["human"] != "same":
            print(f"   false same [{r['human']}] {r['id']} {r['a'][:38]!r} ~ {r['b'][:38]!r}: {r['reason'][:120]}")
    missed = [r for r in rows if r["human"] == "same" and r["haiku"] != "same"]
    print(f"   person said same, Haiku didn't: {len(missed)} "
          f"({dict(Counter(r['haiku'] for r in missed))})")

    rel = [r for r in rows if r["human"] in ("collaboration", "after")]
    print(f"\nRELATION — the person called {len(rel)} pairs collaboration/after")
    print(f"   Haiku exact: {sum(r['haiku'] == r['human'] for r in rel)}, "
          f"any relation: {sum(r['haiku'] in ('collaboration', 'after') for r in rel)}, "
          f"said same: {sum(r['haiku'] == 'same' for r in rel)}, "
          f"said different: {sum(r['haiku'] == 'different' for r in rel)}, "
          f"unsure: {sum(r['haiku'] == 'unsure' for r in rel)}")
    for r in rel:
        if r["haiku"] not in ("collaboration", "after"):
            print(f"   [{r['human']}->{r['haiku']}] {r['a'][:40]!r} ~ {r['b'][:40]!r}")

    uns = [r for r in rows if r["human"] == "unsure"]
    print(f"\nUNSCORED — the person left {len(uns)} unsure; Haiku said {dict(Counter(r['haiku'] for r in uns))}")

    print("\nDISAGREEMENTS on identity pairs")
    for r in rows:
        if r["human"] in ("same", "different") and r["haiku"] in ("same", "different") and r["haiku"] != r["human"]:
            print(f"   [{r['stratum']}] human {r['human']}, Haiku {r['haiku']}: {r['a'][:36]!r} ~ {r['b'][:36]!r}"
                  f"\n        {r['reason'][:160]}")

    json.dump({"version": "MERGE-AGENT-P0-LLM-1.1", "model": MODEL, "cost": round(cost, 4),
               "tokens": [tin, tout], "rows": rows,
               "identity": {k: dict(v) for k, v in by.items()}},
              open(args.out, "w"), indent=1)
    print(f"\n-> {args.out}")


if __name__ == "__main__":
    main()
