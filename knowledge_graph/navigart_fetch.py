"""
PrintMasterAI — Navigart network catalogue fetch (Navigart 3 API)
Version: NAVIGART-FETCH-0.1

Generalises `picasso_paris_fetch.py` from one vault to the whole Videomuseum network.
Survey and the numbers behind every choice here:
`knowledge_graph/navigart_network_source_survey_2026-09-11.md`.

Same split-from-ingest discipline as every other adapter in this directory: this writes
a local JSON cache and nothing else, so a mapping bug can be fixed and re-run against
identical input without re-hitting someone else's server.

Four things this has to do that the single-vault Picasso fetcher did not:

  1. **Resolve the domain filter per vault.** `tree_domain_all` is a TREE and the filter
     wants the FULL path with `↹` (U+21B9) between levels. `filters=tree_domain_all:Estampe`
     returns `filteredCount: 0` on Pompidou (which nests it as `Arts plastiques↹Estampe`)
     and 2,223 on Picasso-Paris (which does not nest it). **A wrong path fails silently
     with a zero count, not an error** — which is exactly how a short read becomes a
     quietly smaller ingest. So the tree is read first, per vault, and the filter is
     built from the key the API itself returned.

  2. **Read facet terms at all.** Without `?term=<facet>&term_size=N`, `aggregations`
     comes back with totals and an EMPTY `terms` array, which reads like "this vault has
     no domain values". It has them; they just aren't sent unless asked for. Not in
     `api.navigart.fr/getting_started.html`; recovered from the front-end's own XHR.

  3. **Filter to the public-domain tier.** The default tier here is PD + image, which is
     the tier ADR-0002 has no licensing problem with (survey §8). `copyright` is a free
     string, so the test is a prefix match on "Domaine public" — the museums' own
     assertion about their own holdings, not our inference from a death date.

  4. **Honour `artw_reproduction_rights` where it is published.** Some vaults carry a
     per-record reproduction flag; Pompidou marks 101 of its prints "Reproduction
     internet non autorisée" and 341 "en attente d'autorisation". Both are excluded.
     Most vaults do not publish the field at all — and **absence is not permission**, it
     is silence, so it is recorded per record rather than defaulted to "cleared".

Public domain is asserted here at the level of the WORK, from the museum's own
`copyright` field. The separate question of whether the museum's photograph of a
public-domain print attracts its own copyright is answered by Art. 14 of the EU DSM
Directive (reproductions of public-domain visual works are not protected unless the
reproduction is itself original), as recorded in survey §8.

Usage:
    python knowledge_graph/navigart_fetch.py --list                  # vault inventory
    python knowledge_graph/navigart_fetch.py --vault 11              # one vault, PD+image
    python knowledge_graph/navigart_fetch.py --all                   # every vault, PD+image
    python knowledge_graph/navigart_fetch.py --vault 11 --tier all   # no PD/image filter
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_HOST = "https://api.navigart.fr"
USER_AGENT = "PrintMasterAI/0.1 (research; contact via repository)"
PAGE_SIZE = 200
SLEEP_SECONDS = 0.3
DOMAIN_LABEL = "Estampe"
TREE_SEPARATOR = "↹"

CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "benchmark", "data", "navigart",
)

# vault -> (front-end slug, institution name as it will be written to
# SourceRecord.institutionName). Slugs came from `www.navigart.fr/robots.txt`, which
# lists one sitemap per vault named `sitemap_<vault>_index.xml`; the URLs inside carry
# the slug. That is the only complete vault index found — there is no publications
# endpoint (`/publications/` 404s).
#
# Vault 16 (Picasso-Paris) is deliberately ABSENT: it is already loaded by
# `picasso_paris_ingest.py`, which carries source-specific rules this generic adapter
# does not have (the Geiser-Baer/Baer prefix alias, the comma-separated catalogue
# splitter, the MP3414 exclusion). Re-ingesting it through here would file its 1,759
# catalogue citations differently from the ones already in the graph.
#
# Vaults 6 (Grenoble), 23 (La Piscine) and 37 (Frac Franche-Comté) are also absent: they
# publish with the facet set EMPTY, so `tree_domain_all` cannot filter them at all and
# their prints (~1,780 by sampling) are reachable only by paging the whole vault and
# filtering client-side. That is a different fetch shape and is deliberately out of scope
# here rather than bolted on — survey §1 and §10.
VAULTS = {
    3:  ("cdac93", "Centre d'arts plastiques de Seine-Saint-Denis"),
    4:  ("capc", "CAPC musée d'art contemporain de Bordeaux"),
    5:  ("ceret", "Musée d'art moderne de Céret"),
    8:  ("mac-lyon", "Musée d'art contemporain de Lyon"),
    11: ("museedartsdenantes", "Musée d'arts de Nantes"),
    12: ("mamac", "MAMAC Nice"),
    14: ("cnap", "Centre national des arts plastiques"),
    15: ("centrepompidou", "Centre Pompidou, Musée national d'art moderne"),
    18: ("mamparis", "Musée d'Art Moderne de Paris"),
    19: ("bourdelle", "Musée Bourdelle"),
    20: ("fac-pariscollections", "Fonds d'art contemporain – Paris Collections"),
    21: ("zadkine", "Musée Zadkine"),
    22: ("rochechouart", "Musée départemental d'art contemporain de Rochechouart"),
    24: ("MAMC-saint-etienne-collections", "MAMC+ Saint-Étienne Métropole"),
    25: ("mamcs", "Musée d'Art moderne et contemporain de Strasbourg"),
    26: ("ungerer", "Musée Tomi Ungerer"),
    27: ("lesabattoirs", "Les Abattoirs, Musée – Frac Occitanie Toulouse"),
    28: ("lam", "LaM, Lille Métropole Musée d'art moderne"),
    29: ("macval", "MAC VAL"),
    30: ("macs", "Musée des arts contemporains du Grand-Hornu"),
    31: ("fracal", "Frac Alsace"),
    32: ("fracaq", "Frac Nouvelle-Aquitaine MÉCA"),
    34: ("fracbo", "Frac Bourgogne"),
    35: ("fracbr", "Frac Bretagne"),
    36: ("fracca", "Frac Corse"),
    38: ("frac-normandie", "Frac Normandie"),
    39: ("fracidf", "Frac Île-de-France"),
    40: ("frac-om", "Frac Outre-mer"),
    41: ("fracartothequenouvelleaquitaine", "Frac-Artothèque Nouvelle-Aquitaine"),
    42: ("fraclo", "Frac des Pays de la Loire"),
    43: ("fracgrandlarge", "Frac Grand Large — Hauts-de-France"),
    44: ("fracpi", "Frac Poitou-Charentes"),
    45: ("fracsud", "Frac Sud — Cité de l'art contemporain"),
}

# Vault-published per-record reproduction flags that are NOT a clearance. Matched as a
# lowercase substring because the field is free text and also occurs as a two-value list.
BLOCKED_REPRODUCTION_FLAGS = ("non autoris", "en attente")


def _get(url, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} attempts: {url} -> {last}")


def _api(vault, **params):
    return _get(f"{API_HOST}/{vault}/artworks?" + urllib.parse.urlencode(params))


def discover_domain_key(vault, label=DOMAIN_LABEL):
    """Returns the FULL tree path for `label` in this vault's own domain tree, or None
    if the vault publishes no `tree_domain_all` facet. See module docstring point 1 — the
    leaf label alone is NOT a usable filter value on a vault that nests it."""
    data = _api(vault, size=0, term="tree_domain_all", term_order="count:desc",
                term_size=400)
    tree = (data.get("aggregations", {}).get("tree_domain_all") or {}).get("terms") or []
    found = []

    def walk(nodes):
        for node in nodes:
            if node.get("label") == label:
                found.append((node["key"], node["doc_count"]))
            walk(node.get("children") or [])

    walk(tree)
    if not found:
        return None, 0
    # One vault could in principle file the same leaf label under two parents; take the
    # largest and say so rather than silently picking the first.
    found.sort(key=lambda x: -x[1])
    if len(found) > 1:
        print(f"[WARN] vault {vault}: {len(found)} '{label}' nodes {found} — using the largest",
              flush=True)
    return found[0]


def keep_record(artwork, tier):
    """The tier gate. Returns (keep, reason)."""
    flags = artwork.get("artw_reproduction_rights")
    if flags:
        text = " ".join(flags) if isinstance(flags, list) else str(flags)
        if any(b in text.lower() for b in BLOCKED_REPRODUCTION_FLAGS):
            return False, "reproduction_not_cleared"
    if tier == "all":
        return True, None
    copyright_text = (artwork.get("copyright") or "").strip().lower()
    if not copyright_text.startswith("domaine public"):
        return False, "in_copyright"
    medias = artwork.get("medias") or []
    if not medias or not medias[0].get("file_name"):
        return False, "no_image"
    return True, None


def fetch_vault(vault, tier="pd-image", limit=None):
    slug, institution = VAULTS[vault]
    key, expected_in_tree = discover_domain_key(vault)
    if key is None:
        print(f"[SKIP] vault {vault} ({slug}) publishes no tree_domain_all facet", flush=True)
        return None

    kept, reasons, seen, expected = [], {}, 0, None
    for start in range(0, 200_000, PAGE_SIZE):
        page = _api(vault, size=PAGE_SIZE, **{"from": start},
                    filters=f"tree_domain_all:{key}")
        if expected is None:
            expected = page.get("filteredCount")
            print(f"[FETCH] vault {vault} ({slug}) key={key!r} filteredCount={expected} "
                  f"(tree said {expected_in_tree})", flush=True)
            if not expected:
                # Module docstring point 1: this is the silent-zero failure mode, and it
                # is a bug in the filter, not an empty collection.
                raise RuntimeError(
                    f"vault {vault}: filter {key!r} matched 0 records but the domain tree "
                    f"reports {expected_in_tree}. Do not treat this as an empty vault.")
        results = page.get("results") or []
        if not results:
            break
        for r in results:
            payload = r["_source"]["ua"]
            seen += 1
            ok, reason = keep_record(payload.get("artwork") or {}, tier)
            if ok:
                kept.append(payload)
            else:
                reasons[reason] = reasons.get(reason, 0) + 1
        if limit and len(kept) >= limit:
            kept = kept[:limit]
            break
        if seen >= expected:
            break
        time.sleep(SLEEP_SECONDS)

    if not limit and expected is not None and seen != expected:
        print(f"[WARN] vault {vault}: saw {seen} of {expected} — short read, do not ingest "
              f"this cache without checking why", flush=True)

    os.makedirs(CACHE_DIR, exist_ok=True)
    out = os.path.join(CACHE_DIR, f"v{vault}_{slug}_{DOMAIN_LABEL.lower()}_{tier}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"vault": vault, "slug": slug, "institution": institution,
                   "domainKey": key, "tier": tier, "fetchedFrom": expected,
                   "records": kept}, f, ensure_ascii=False)
    print(f"[DONE] vault {vault} ({slug}): kept {len(kept)}/{seen} "
          f"excluded={reasons} -> {out}", flush=True)
    return {"vault": vault, "slug": slug, "kept": len(kept), "seen": seen,
            "excluded": reasons, "path": out}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", type=int, action="append",
                        help="Vault id (repeatable). Omit with --all for every vault.")
    parser.add_argument("--all", action="store_true", help="Every vault in VAULTS")
    parser.add_argument("--tier", default="pd-image", choices=("pd-image", "all"),
                        help="pd-image (default): public-domain records that carry an "
                             "image. all: every Estampe record, rights flags still honoured.")
    parser.add_argument("--limit", type=int, help="Cap kept records per vault")
    parser.add_argument("--list", action="store_true",
                        help="Print the vault inventory and exit")
    args = parser.parse_args()

    if args.list:
        for v, (slug, name) in sorted(VAULTS.items()):
            print(f"{v:>4}  {slug:<34} {name}")
        raise SystemExit

    targets = sorted(VAULTS) if args.all else (args.vault or [])
    if not targets:
        parser.error("Provide --vault N (repeatable), --all, or --list")

    summary = []
    for v in targets:
        try:
            result = fetch_vault(v, tier=args.tier, limit=args.limit)
            if result:
                summary.append(result)
        except Exception as e:
            print(f"[ERROR] vault {v}: {e}", flush=True)

    total = sum(s["kept"] for s in summary)
    print(f"\n[SUMMARY] {len(summary)} vault(s), {total} record(s) kept at tier={args.tier}")
    for s in sorted(summary, key=lambda x: -x["kept"]):
        print(f"  {s['vault']:>4}  {s['slug']:<34} {s['kept']:>6} / {s['seen']}")
