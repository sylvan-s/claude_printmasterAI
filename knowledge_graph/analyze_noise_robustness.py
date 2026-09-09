"""
PrintMasterAI — attribute Stage 1b/1d noise losses to specific degradations

Joins `tests/backtest/output/noise_robustness.json` (the paired clean/degraded run) with
`tests/backtest/noisy_pool/MANIFEST.json` (what `build_noisy_pool.py` actually drew for
each lot: severity 0-1 and the list of filters applied), and answers the question the
headline hit rates cannot: *which* noise costs the accuracy.

Two views per stage:

  - by severity quartile — is the damage graded, or is there a cliff?
  - per filter, retention **with** vs **without** it, over the same eligible lots.

The with/without swing is observational, not a controlled ablation: the mixed pool draws
filters independently but severity scales every magnitude at once, so a filter that tends
to co-occur with a high severity roll will look worse than it is. Treat a swing as a
ranking signal worth an ablation, not an effect size. `--min-n` guards the thinnest cells.

Usage:
    knowledge_graph/venv-embeddings/bin/python knowledge_graph/analyze_noise_robustness.py
    ... --results tests/backtest/output/noise_robustness.json --append   # write into the .md
"""

import argparse
import collections
import json
import os
import re
import statistics
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RESULTS = os.path.join(REPO, "tests", "backtest", "output", "noise_robustness.json")
DEFAULT_MANIFEST = os.path.join(REPO, "tests", "backtest", "noisy_pool", "MANIFEST.json")


def normalize_artist(name):
    """Mirrors normalizeArtist/artistsMatch in run_noise_robustness.ts — keep in step."""
    if not name:
        return ""
    s = name.lower().replace(".", "").replace(",", "")
    s = re.sub(r"\b(sir|dame|van|von|de|der)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()


def artists_match(a, b):
    na, nb = normalize_artist(a), normalize_artist(b)
    return bool(na and nb and (na == nb or na in nb or nb in na))


def load_rows(results_path, manifest_path, recipe):
    results = json.load(open(results_path, encoding="utf-8"))
    variants = json.load(open(manifest_path, encoding="utf-8"))["variants"]
    rows = []
    for r in results["rows"]:
        e = r["entry"]
        lid = f"{e['saleId']}_{e['lotNumber']}"
        meta = variants.get(f"{lid}/{recipe}")
        if not meta:
            continue
        clean_1d = r["clean"].get("stage1d") or []
        noisy_1d = r["noisy"].get("stage1d") or []
        ck = {m["key"] for m in clean_1d}
        nk = {m["key"] for m in noisy_1d}
        top = lambda ms: ms[0]["dino"] if ms and ms[0].get("dino") is not None else None
        rows.append({
            "lid": lid,
            "severity": meta.get("severity"),
            "applied": meta.get("applied", []),
            "clean_1b": artists_match((r["clean"].get("stage1b") or {}).get("artist"), e["artistName"]),
            "noisy_1b": artists_match((r["noisy"].get("stage1b") or {}).get("artist"), e["artistName"]),
            "clean_1d": any(artists_match(m.get("artist"), e["artistName"]) for m in clean_1d),
            "noisy_1d": any(artists_match(m.get("artist"), e["artistName"]) for m in noisy_1d),
            "overlap": len(ck & nk) / len(ck) if ck else None,
            "dino_drop": (top(noisy_1d) - top(clean_1d)) if top(clean_1d) is not None and top(noisy_1d) is not None else None,
        })
    return rows


def quartiles(rows, key, value):
    """Mean of `value` over severity quartiles of `rows`."""
    rows = sorted([r for r in rows if r["severity"] is not None and value(r) is not None], key=lambda r: r["severity"])
    if len(rows) < 8:
        return []
    q = len(rows) // 4
    out = []
    for i, (lo, hi) in enumerate([(0, q), (q, 2 * q), (2 * q, 3 * q), (3 * q, len(rows))]):
        b = rows[lo:hi]
        out.append((i + 1, b[0]["severity"], b[-1]["severity"], statistics.mean(value(r) for r in b), len(b)))
    return out


def by_filter(rows, value, min_n):
    """(filter, mean-with, n-with, mean-without, n-without, swing), worst swing first."""
    rows = [r for r in rows if value(r) is not None]
    out = []
    for f in sorted({f for r in rows for f in r["applied"]}):
        w = [r for r in rows if f in r["applied"]]
        wo = [r for r in rows if f not in r["applied"]]
        if len(w) < min_n or len(wo) < min_n:
            continue
        a, b = statistics.mean(value(r) for r in w), statistics.mean(value(r) for r in wo)
        out.append((f, a, len(w), b, len(wo), a - b))
    return sorted(out, key=lambda x: x[5])


def section(title, rows, value, min_n, unit="%"):
    L = [f"### {title}", ""]
    q = quartiles(rows, "severity", value)
    if q:
        L.append("| severity quartile | range | value | n |")
        L.append("|---|---|---|---|")
        for i, lo, hi, mean, n in q:
            L.append(f"| Q{i} | {lo:.2f}–{hi:.2f} | {mean * 100:.0f}{unit} | {n} |")
        L.append("")
    fs = by_filter(rows, value, min_n)
    if fs:
        L.append("| filter | with | without | swing |")
        L.append("|---|---|---|---|")
        for f, a, na, b, nb, sw in fs:
            L.append(f"| `{f}` | {a * 100:.0f}{unit} (n={na}) | {b * 100:.0f}{unit} (n={nb}) | {sw * 100:+.0f}pp |")
        L.append("")
    return L


def main():
    ap = argparse.ArgumentParser(description="Attribute Stage 1b/1d noise losses to specific degradations")
    ap.add_argument("--results", default=DEFAULT_RESULTS)
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--recipe", default="mixed")
    ap.add_argument("--min-n", type=int, default=6, help="skip a filter unless both cells have this many lots")
    ap.add_argument("--append", action="store_true", help="append the section to the report .md alongside --results")
    args = ap.parse_args()

    rows = load_rows(args.results, args.manifest, args.recipe)
    if not rows:
        sys.exit(f"no lots matched recipe '{args.recipe}' in {args.manifest}")

    L = ["## Which degradations cost what", ""]
    L.append(
        f"{len(rows)} lots. Observational, not a controlled ablation — severity scales every filter's magnitude at "
        f"once, so a swing ranks suspects for an ablation rather than measuring an effect. Cells under n={args.min_n} "
        f"are dropped."
    )
    L.append("")

    # Stage 1b: of the lots it got right clean, how many did it hold?
    held = [r for r in rows if r["clean_1b"]]
    L += section(f"Stage 1b artist retention ({len(held)} lots correct on the clean image)",
                 held, lambda r: 1.0 if r["noisy_1b"] else 0.0, args.min_n)
    # Stage 1d: coverage-independent retrieval stability
    L += section("Stage 1d top-3 retrieval stability", rows, lambda r: r["overlap"], args.min_n)

    lost = [r for r in rows if r["clean_1b"] and not r["noisy_1b"]]
    if lost:
        base = collections.Counter(f for r in rows for f in r["applied"])
        c = collections.Counter(f for r in lost for f in r["applied"])
        L.append(f"### The {len(lost)} lots Stage 1b lost")
        L.append("")
        L.append("| filter | in lost lots | pool base rate | lift |")
        L.append("|---|---|---|---|")
        for f, n in c.most_common():
            a, b = n / len(lost), base[f] / len(rows)
            L.append(f"| `{f}` | {n}/{len(lost)} ({a * 100:.0f}%) | {b * 100:.0f}% | {(a - b) * 100:+.0f}pp |")
        L.append("")
        kept = [r for r in rows if r["clean_1b"] and r["noisy_1b"]]
        L.append(
            f"Median severity — lost **{statistics.median(r['severity'] for r in lost):.2f}** vs held "
            f"**{statistics.median(r['severity'] for r in kept):.2f}**."
        )
        L.append("")

    text = "\n".join(L)
    print(text)
    if args.append:
        md = os.path.splitext(args.results)[0] + ".md"
        body = open(md, encoding="utf-8").read()
        marker = "\n## Which degradations cost what"
        if marker in body:  # idempotent — replace a previous run's section
            body = body[: body.index(marker)]
        head, sep, per_lot = body.partition("\n## Per lot")
        open(md, "w", encoding="utf-8").write(head.rstrip() + "\n\n" + text + sep + per_lot)
        print(f"\nappended to {md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
