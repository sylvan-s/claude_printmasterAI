"""
PrintMasterAI — scan-only report of duplicate ConceptualWork nodes, keyed on an EXACT
artist + normalized-title + year identity, with DINOv2 used only to dissent.
Version: DUPWORK-SCAN-1.0

Why this exists. `catalogue_matching.py` already keys work identity on artist + catalogue
name + entry number + exact normalized title, and that is the only merge rule this graph
has. It cannot fire on a lot that cites no catalogue raisonne, which is most of them, so
the same print sold repeatedly accumulates one ConceptualWork node per lot. Measured
2026-09-10: 11,817 clusters covering 31,189 work nodes, i.e. 19,372 surplus nodes. The
worst single case is David Hockney's "Little Boodge" (1993) at 47 nodes — 47 genuine
separate Forum lots of one offset lithograph, each with its own Impression, all pointing
at the same stock photograph.

This script only REPORTS. There is no --merge, deliberately. Every merge rule in this
graph's history that was not read by a human before it ran corrupted something (see
`catalogue_matching.py`'s docstring for the Chagall "Cramer 30" and Stik "No. 458"
incidents), and the clusters here are bigger and blunter than those were.

WHAT THE KEY IS, AND WHY IT IS NOT AN IMAGE-SIMILARITY KEY
----------------------------------------------------------
The key is `(artist.name, normalize_title(work.name), work.dateCreated_year)`, all exact.
`normalize_title` is imported from `catalogue_matching` rather than redefined, for the
same reason that module was extracted in the first place — two copies of an identity rule
drift, and this one must keep that module's specific refusal to strip parentheticals (a
colour-variant detail in parentheses was the only thing distinguishing five different Stik
prints that an earlier fix wrongly merged).

A DINOv2 threshold was probed as the identity signal on 2026-09-10 and rejected on
measurement, NOT on principle:

  - Recall. Over 400 pairs of distinct ConceptualWork nodes sharing one artist, an
    identical distinctive title, and genuinely different photographs, only 44% scored
    >= 0.98, 65% >= 0.95 and 75% >= 0.90. Mean 0.927, minimum 0.595.
  - The case that prompted the work. Four separate nodes for Henry Moore's "Animal Heads"
    (1975) — three Roseberys lots and the Tate impression, provably one lithograph — score
    0.921 to 0.976 pairwise. NOT ONE PAIR clears 0.98. An image-keyed sweep merges none of
    them; this script's exact key merges all four.
  - Precision is not free either. In an 800-image sample, 355 cross-node pairs cleared
    0.98; 124 were same-artist-different-title and 2 were different-artist. Confirmed
    false positives at that level: Bawden's "Covent Garden, Foreign Fruit Market" vs
    "Covent Garden Flower Market" (0.9881, two different prints), Picasso's "One plate
    from Faunes et Flore d'Antibes" vs the portfolio node (0.9993 — the Chagall Cramer-30
    plate-into-portfolio mode again), Hamerton's "Etching and Etchers" vs Whistler's
    "Billingsgate" (0.9848, a book containing the plate).

The cause is structural: DINOv2 embeds the PHOTOGRAPH, not the print. Framed vs unframed,
margins in or cropped out, auction lot shot vs flat institutional scan — each moves the
vector further than a different plate in the same series does.

So DINOv2 appears here in one role only: DISSENT. A cluster whose own images disagree with
each other is surfaced for review instead of being proposed. Because ~20% of genuine
duplicates score below the 0.85 default floor, a dissent is "look at this", never "these
are different" — read it the way `find_artist_merge_candidates.py` asks THIN pairs to be
read. Scores come from Neo4j's `vector.similarity.cosine`, which returns (1 + cos) / 2 and
NOT raw cosine: unrelated pairs in this graph floor at 0.486 and average 0.584. Do not
carry a threshold across from `find_artist_merge_candidates.py`, which scores raw cosine
in numpy — 0.85 here is raw cosine 0.70.

THE CHECK THAT OUTRANKS THE IMAGES
----------------------------------
Before any image score is consulted, a cluster is rejected outright if two of its nodes
cite the SAME catalogue raisonne and DIFFERENT entry numbers. That is deterministic
evidence of two different prints, and the graph already holds it: Moore's null-year
"Seated Figure" cluster spans Cramer 13, 292, 567 and 578, and "Two Reclining Figures"
spans Cramer 205, 440, 466, 468 and 669. An exact artist+title key with no catalogue check
folds each of those into one node — the Chagall "Cramer 30" corruption running in reverse.
`NON_CATALOGUE_NAMES` is imported from `catalogue_matching` rather than restated, and Lugt
being in it matters most here: Lugt numbers catalogue collector MARKS, so two prints
carrying different Lugt numbers is expected and says nothing about the artwork.

A second, weaker deterministic check follows it: two nodes from the SAME institution with
DIFFERENT accession numbers. Warhol's "Mao Tse-Tung" (1972) at the Met clusters 9 nodes
under one title with no image coverage and no catalogue entry — nothing else in this
script could see the problem — but the accessions read `1974.645(1)`, `(2)`, `(3)`, `(4)`
... and `1974.645.1-10`: nine of the ten plates plus the portfolio-level record. It is
reported separately rather than as a hard conflict because an institution can legitimately
hold two impressions of one print under two accessions.

WHAT IS QUARANTINED RATHER THAN PROPOSED
----------------------------------------
  1. Placeholder titles. Tate and the British Museum record whole portfolios under one
     placeholder — "[no title]" covers 139 different Thomas Schutte prints of 2001 and 90
     Paolozzi prints of 1967; "[title not known]" covers 60 unrelated Gainsborough sheets.
     These are the single most dangerous input to any title-keyed rule and are excluded
     from candidate generation entirely, the same category as
     `find_artist_merge_candidates.py`'s PLACEHOLDER_SURNAMES.
  2. Null years. With no year the key is artist + title alone, which is materially weaker
     — a title reused across a career collapses into one node. Reported separately.
  3. Large clusters. Past --max-cluster the cluster is as likely to be a series or an
     edition-variant family as a repeat seller. Reported separately WITH its image
     evidence so the reviewer can tell which; "Little Boodge" at 47 nodes is genuine,
     and that is exactly why cluster size cannot be an automatic reject either.

A SEPARATE DEFECT THIS ALSO REPORTS
-----------------------------------
566 Impressions currently hang off TWO ConceptualWork nodes at once — a per-accession or
per-lot node AND a canonical `...-cw-<catalogue>-<entry>` node left behind by a
catalogue-refs backfill. 535 are Roseberys (e.g. `roseberys-a0467-lot85` under both
`roseberys-a0467-lot85` and `roseberys-cw-Henry_Moore-Cramer-376-three_heads_cramer_376`)
and 31 are British Museum (under `bm-cw-New_Hollstein_(Dutch_&_Flemish)-NNN`). This is a
bad backfill, not a missing merge rule, and its remedy is different: re-point and delete
the surplus node, do not fold two real lots together. It is reported in its own section
because any comp query that starts from ConceptualWork double-counts these — measured 125
rows for 94 distinct Henry Moore lots, ~25% inflation.

Usage:
    python3 find_duplicate_work_clusters.py --scan
    python3 find_duplicate_work_clusters.py --scan --artist "Henry Moore"
    python3 find_duplicate_work_clusters.py --scan --min-cluster 3 --limit 50
    python3 find_duplicate_work_clusters.py --scan --json dup_work_clusters.json
"""

import argparse
import json
import os
import unicodedata
from collections import Counter, defaultdict

from neo4j import GraphDatabase

from catalogue_matching import NON_CATALOGUE_NAMES, normalize_title


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")

# Titles that are cataloguing placeholders, not identities. Every entry below is a
# confirmed real bucket in THIS graph, with the damage it would do if keyed on:
#   "[no title]"        Tate's convention — 139 different Schutte prints (2001) share it,
#                       90 Paolozzi (1967), 50 Le Brun (1990), 49 Baselitz (1995).
#   "[title not known]" British Museum's — 60 Gainsborough sheets, 55 Francis Barlow.
#   "untitled"          auction-house convention — 68 Sam Francis, 45 Jim Dine (2012).
# Compared after normalize_title(), which strips the brackets, so the stored forms are
# their normalized ones.
PLACEHOLDER_TITLES = {
    "no title",
    "title not known",
    "untitled",
    "untitled composition",
    "composition",
    "unknown",
    "n a",
}

# Titles shorter than this after normalization carry too little signal to key on even when
# they are not placeholders ("iii", "no 7"). Reported under EXCLUDED, not silently dropped.
MIN_TITLE_CHARS = 4

# Neo4j-scale (1 + cos)/2 floor below which a cluster's own images are treated as
# DISSENTING. 0.85 here is raw cosine 0.70. Chosen from the measured distribution: 80% of
# known-duplicate pairs clear it, so a cluster falling below is unusual enough to warrant
# eyes — and the 20% it catches wrongly are why this is a review flag, never a reject.
DEFAULT_DISSENT_FLOOR = 0.85

# Clusters at or above this size are quarantined for review rather than proposed. 113
# clusters in this graph are >= 10. Not a reject: "Little Boodge" (47) is genuine.
DEFAULT_MAX_CLUSTER = 10

# Images pulled per work when scoring a cluster, and works sampled per cluster. The signal
# wanted is "do these nodes' pictures agree at all", so a sample is enough; without a cap
# the 47-node clusters dominate runtime for no extra information.
MAX_IMAGES_PER_WORK = 1
MAX_WORKS_SCORED = 8


ALL_WORKS_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork)
WHERE w.name IS NOT NULL AND trim(w.name) <> ''
RETURN a.name AS artist, w.name AS title, w.dateCreated_year AS year, w.id AS workId
"""

# Everything a reviewer needs to adjudicate one cluster without opening the graph: which
# source each node came from, whether its lot sold and for how much, and its own image.
CLUSTER_DETAIL_QUERY = """
UNWIND $workIds AS wid
MATCH (w:ConceptualWork {id: wid})
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
OPTIONAL MATCH (s:SourceRecord)-[:DOCUMENTS]->(i)
OPTIONAL MATCH (i)-[:SHOWS]-(d:DigitalImage) WHERE d.embedding IS NOT NULL
OPTIONAL MATCH (ce:CatalogueEntry)-[:DOCUMENTS]->(w)
OPTIONAL MATCH (cr:CatalogueRaisonne)-[:CONTAINS]->(ce)
RETURN w.id AS workId,
       collect(DISTINCT i.id)[0..5] AS impressionIds,
       count(DISTINCT i) AS impressions,
       collect(DISTINCT s.institutionName)[0..5] AS houses,
       collect(DISTINCT s.priceRealisedGBP)[0..5] AS realisedGBP,
       collect(DISTINCT d.id)[0..$maxImages] AS imageIds,
       collect(DISTINCT {entryId: ce.id, number: ce.number, prefix: cr.numberingPrefix}) AS catalogueEntries,
       collect(DISTINCT {institution: s.institutionName, accession: s.accessionNumber,
                         sourceType: s.sourceType}) AS accessions
"""

# Cosine is computed server-side so 1024-float vectors never cross the wire. Returns the
# Neo4j (1 + cos)/2 score, NOT raw cosine — see the module docstring.
CLUSTER_SIM_QUERY = """
UNWIND $pairs AS p
MATCH (x:DigitalImage {id: p[0]}), (y:DigitalImage {id: p[1]})
RETURN p[0] AS a, p[1] AS b, vector.similarity.cosine(x.embedding, y.embedding) AS sim
"""

# The Roseberys catalogue-refs backfill left a per-lot node and a canonical
# `...-cw-...-Cramer-NNN` node both pointing at one Impression. Different defect, different
# remedy — see the module docstring.
SHARED_IMPRESSION_QUERY = """
MATCH (w:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i:Impression)
WITH i, collect(DISTINCT w.id) AS workIds
WHERE size(workIds) > 1
RETURN i.id AS impressionId, workIds
ORDER BY impressionId
"""


def artist_key(name):
    """Accent-strip + casefold, used ONLY to spot clusters that a duplicate Artist node is
    splitting. Never used as the merge key itself — artist identity is
    find_artist_merge_candidates.py's job, and folding two artist names together here
    would silently do that job without its per-rule evidence gates."""
    decomposed = unicodedata.normalize("NFKD", name or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    cleaned = "".join(ch if ch.isalnum() else " " for ch in stripped)
    return " ".join(cleaned.lower().split())


def build_clusters(rows, artist_filter=None):
    """Group work nodes on the exact key. Returns (clusters, excluded_counter)."""
    buckets = defaultdict(list)
    excluded = Counter()

    for r in rows:
        if artist_filter and r["artist"] != artist_filter:
            continue
        title = normalize_title(r["title"])
        if title in PLACEHOLDER_TITLES:
            excluded[f"placeholder title: {title!r}"] += 1
            continue
        if len(title.replace(" ", "")) < MIN_TITLE_CHARS:
            excluded[f"title under {MIN_TITLE_CHARS} chars: {title!r}"] += 1
            continue
        buckets[(r["artist"], title, r["year"])].append(r["workId"])

    clusters = []
    for (artist, title, year), work_ids in buckets.items():
        unique = sorted(set(work_ids))
        if len(unique) > 1:
            clusters.append({
                "artist": artist,
                "title": title,
                "year": year,
                "workIds": unique,
                "size": len(unique),
            })
    clusters.sort(key=lambda c: (-c["size"], c["artist"], c["title"]))
    return clusters, excluded


def find_artist_split_clusters(rows, artist_filter=None):
    """Clusters that WOULD form if two Artist nodes differing only by normalization were
    one node. Reported so the artist merge is run first, never acted on here."""
    wanted = artist_key(artist_filter) if artist_filter else None
    buckets = defaultdict(set)
    for r in rows:
        if wanted and artist_key(r["artist"]) != wanted:
            continue
        title = normalize_title(r["title"])
        if title in PLACEHOLDER_TITLES or len(title.replace(" ", "")) < MIN_TITLE_CHARS:
            continue
        if r["year"] is None:
            continue
        buckets[(artist_key(r["artist"]), title, r["year"])].add(r["artist"])
    return sorted(
        ({"artistKey": k[0], "title": k[1], "year": k[2], "artistNames": sorted(names)}
         for k, names in buckets.items() if len(names) > 1),
        key=lambda x: x["artistKey"],
    )


def fetch_details(session, clusters, max_images):
    work_ids = sorted({wid for c in clusters for wid in c["workIds"][:MAX_WORKS_SCORED]})
    if not work_ids:
        return {}
    result = session.run(CLUSTER_DETAIL_QUERY, workIds=work_ids, maxImages=max_images)
    return {r["workId"]: dict(r) for r in result}


def score_clusters(session, clusters, details):
    """Attach minSim/maxSim per cluster. Clusters with fewer than two embedded images get
    None — no coverage is NOT a dissent, exactly as a THIN artist pair is not a rejection."""
    pairs = []
    owner = {}
    for idx, c in enumerate(clusters):
        imgs = []
        for wid in c["workIds"][:MAX_WORKS_SCORED]:
            imgs.extend(details.get(wid, {}).get("imageIds") or [])
        imgs = sorted(set(imgs))
        c["embeddedImages"] = len(imgs)
        for i in range(len(imgs) - 1):
            for j in range(i + 1, len(imgs)):
                pairs.append([imgs[i], imgs[j]])
                owner[(imgs[i], imgs[j])] = idx

    sims = defaultdict(list)
    for batch_start in range(0, len(pairs), 2000):
        batch = pairs[batch_start:batch_start + 2000]
        for rec in session.run(CLUSTER_SIM_QUERY, pairs=batch):
            sims[owner[(rec["a"], rec["b"])]].append(rec["sim"])

    for idx, c in enumerate(clusters):
        vals = sims.get(idx)
        c["minSim"] = round(min(vals), 4) if vals else None
        c["maxSim"] = round(max(vals), 4) if vals else None
    return clusters


def catalogue_refs_for(work_detail):
    """{catalogue name (casefolded) -> set of entry numbers} for one work node.

    The catalogue name comes from `CatalogueRaisonne.numberingPrefix` where the CONTAINS
    edge exists (21,293 of 26,193 entries), and otherwise from stripping the trailing
    `-{number}` off `CatalogueEntry.id` — `{"number": "471-481", "id": "Cramer-471-481"}`
    is a real node, so splitting the id on its last hyphen would read that range as
    catalogue "Cramer-471", entry "481". NON_CATALOGUE_NAMES is applied here for the same
    reason catalogue_matching.py applies it before identity-keying, and Lugt being in that
    set matters most: Lugt numbers catalogue collector MARKS, so two prints carrying
    different Lugt numbers is expected and is not evidence about the artwork at all."""
    refs = defaultdict(set)
    for entry in work_detail.get("catalogueEntries") or []:
        number = entry.get("number")
        entry_id = entry.get("entryId")
        if not number or not entry_id:
            continue
        prefix = entry.get("prefix")
        if not prefix:
            suffix = f"-{number}"
            prefix = entry_id[: -len(suffix)] if entry_id.endswith(suffix) else entry_id
        prefix = (prefix or "").strip().lower()
        if not prefix or prefix in NON_CATALOGUE_NAMES:
            continue
        refs[prefix].add(str(number).strip())
    return refs


def catalogue_conflict(cluster, details):
    """Deterministic negative evidence: two nodes in the cluster cite the SAME catalogue
    and DIFFERENT entry numbers, so they are different prints that merely share a title.

    This outranks the image score and is checked first. It is not hypothetical — Henry
    Moore's null-year 'Seated Figure' cluster holds Cramer 13, 292, 567 and 578 under one
    title, and Moore's 'Two Reclining Figures' holds Cramer 205, 440, 466, 468 and 669.
    An exact artist+title key with no catalogue check would fold each of those into one
    node, which is the Chagall 'Cramer 30' corruption running in reverse."""
    seen = defaultdict(set)
    for wid in cluster["workIds"][:MAX_WORKS_SCORED]:
        for prefix, numbers in catalogue_refs_for(details.get(wid, {})).items():
            seen[prefix] |= numbers
    return sorted(
        (f"{prefix} {sorted(numbers)}" for prefix, numbers in seen.items() if len(numbers) > 1)
    )


def accession_conflict(cluster, details):
    """Second deterministic check: two nodes from the SAME institution carrying DIFFERENT
    accession numbers. An institution assigns one accession per object, so this is nearly
    always a portfolio whose plates all share one title.

    The case that forced this rule: Warhol's "Mao Tse-Tung" (1972) at the Met clusters 9
    nodes under one title with no image coverage and no catalogue entry, so neither the
    image score nor `catalogue_conflict` could see anything wrong — but the accessions are
    `1974.645(1)`, `(2)`, `(3)`, `(4)` ... and `1974.645.1-10`. Those are nine of the ten
    plates PLUS the portfolio-level record. Folding them into one node is the Chagall
    "Cramer 30" corruption exactly.

    Applied to institutional records only. Auction sourceType is the opposite situation by
    construction — N lots under one title is N sales of one print, which is the whole
    reason this script exists — and auction SourceRecords carry no accessionNumber anyway.

    Weaker than `catalogue_conflict` and reported separately rather than folded into it: an
    institution CAN legitimately hold two impressions of one print under two accessions
    (Tate does), so this is 'probably different plates', not 'certainly'."""
    by_institution = defaultdict(set)
    for wid in cluster["workIds"][:MAX_WORKS_SCORED]:
        for row in details.get(wid, {}).get("accessions") or []:
            if row.get("sourceType") != "institutional":
                continue
            institution, accession = row.get("institution"), row.get("accession")
            if institution and accession:
                by_institution[institution].add(str(accession).strip())
    return sorted(
        f"{institution} {sorted(accs)[:4]}"
        for institution, accs in by_institution.items() if len(accs) > 1
    )


def _fmt_cluster(c, details):
    year = c["year"] if c["year"] is not None else "----"
    sim = "no image coverage" if c["minSim"] is None else f"sim {c['minSim']:.3f}-{c['maxSim']:.3f}"
    head = (f"  [{c['size']:>2} nodes] {c['artist']!r} / {c['title']!r} ({year})  {sim}")
    lines = [head]
    if c.get("catalogueConflict"):
        lines.append(f"        CATALOGUE CONFLICT: {'; '.join(c['catalogueConflict'])}")
    if c.get("accessionConflict"):
        lines.append(f"        ACCESSION CONFLICT: {'; '.join(c['accessionConflict'])}")
    for wid in c["workIds"][:MAX_WORKS_SCORED]:
        d = details.get(wid, {})
        houses = ", ".join(h for h in (d.get("houses") or []) if h) or "-"
        prices = [p for p in (d.get("realisedGBP") or []) if p is not None]
        price = ("GBP " + "/".join(f"{p:.0f}" for p in prices)) if prices else "unsold/na"
        lines.append(f"        {wid:<62} {d.get('impressions', 0)}imp  {houses:<22} {price}")
    if c["size"] > MAX_WORKS_SCORED:
        lines.append(f"        ... and {c['size'] - MAX_WORKS_SCORED} more node(s)")
    return "\n".join(lines)


def run_scan(session, artist_filter=None, min_cluster=2, max_cluster=DEFAULT_MAX_CLUSTER,
             dissent_floor=DEFAULT_DISSENT_FLOOR, limit=None, out_json=None):
    rows = [dict(r) for r in session.run(ALL_WORKS_QUERY)]
    print(f"ConceptualWork nodes with an artist and a title: {len(rows)}")

    clusters, excluded = build_clusters(rows, artist_filter=artist_filter)
    clusters = [c for c in clusters if c["size"] >= min_cluster]
    surplus = sum(c["size"] - 1 for c in clusters)
    print(f"Clusters on exact (artist, normalized title, year): {len(clusters)}")
    print(f"Work nodes inside them: {sum(c['size'] for c in clusters)} "
          f"({surplus} surplus node(s) if every cluster were folded to one)\n")

    print("=== EXCLUDED FROM CANDIDATE GENERATION (placeholder / too-short titles) ===")
    for label, n in excluded.most_common(12):
        print(f"  {n:>6}  {label}")
    if not excluded:
        print("  none")
    print()

    scored_pool = clusters if limit is None else clusters[:limit]
    details = fetch_details(session, scored_pool, MAX_IMAGES_PER_WORK)
    score_clusters(session, scored_pool, details)

    proposed, dissent, null_year, large, conflict, portfolio = [], [], [], [], [], []
    for c in scored_pool:
        c["catalogueConflict"] = catalogue_conflict(c, details)
        c["accessionConflict"] = accession_conflict(c, details)
        if c["catalogueConflict"]:
            conflict.append(c)
        elif c["accessionConflict"]:
            portfolio.append(c)
        elif c["size"] >= max_cluster:
            large.append(c)
        elif c["year"] is None:
            null_year.append(c)
        elif c["minSim"] is not None and c["minSim"] < dissent_floor:
            dissent.append(c)
        else:
            proposed.append(c)

    print(f"=== CATALOGUE CONFLICT — same catalogue, different entry numbers: DIFFERENT "
          f"WORKS, do not merge ({len(conflict)}) ===")
    print("    Deterministic, and it outranks every other signal here. Checked first.")
    for c in conflict:
        print(_fmt_cluster(c, details))

    print(f"\n=== ONE INSTITUTION, SEVERAL ACCESSIONS — probably a portfolio's plates "
          f"sharing a title ({len(portfolio)}) ===")
    print("    Weaker than a catalogue conflict: an institution can hold two impressions of")
    print("    one print. Read the accessions — '(1)', '(2)', '(3)' is a portfolio.")
    for c in portfolio:
        print(_fmt_cluster(c, details))

    print(f"\n=== PROPOSED — exact key, year present, no catalogue or accession conflict, "
          f"images do not dissent ({len(proposed)}) ===")
    for c in proposed:
        print(_fmt_cluster(c, details))

    print(f"\n=== IMAGES DISSENT (min sim < {dissent_floor}) — review, NOT a rejection ({len(dissent)}) ===")
    print("    ~20% of known-duplicate pairs score below this floor; a low score on a")
    print("    different photograph of the same print is normal. Read as 'look at this'.")
    for c in dissent:
        print(_fmt_cluster(c, details))

    print(f"\n=== NULL YEAR — key is artist + title only, weaker ({len(null_year)}) ===")
    for c in null_year:
        print(_fmt_cluster(c, details))

    print(f"\n=== LARGE CLUSTER (>= {max_cluster} nodes) — series or repeat seller? ({len(large)}) ===")
    for c in large:
        print(_fmt_cluster(c, details))

    splits = find_artist_split_clusters(rows, artist_filter=artist_filter)
    print(f"\n=== BLOCKED BY A SPLIT ARTIST NODE ({len(splits)}) — run "
          f"find_artist_merge_candidates.py first ===")
    for s in splits[:25]:
        print(f"  {s['title']!r} ({s['year']}): {s['artistNames']}")
    if len(splits) > 25:
        print(f"  ... and {len(splits) - 25} more")

    shared = [dict(r) for r in session.run(SHARED_IMPRESSION_QUERY)]
    print(f"\n=== SEPARATE DEFECT: one Impression on several ConceptualWork nodes "
          f"({len(shared)}, graph-wide — not narrowed by --artist) ===")
    print("    A backfill artefact, not a missing merge rule. Re-point and delete the")
    print("    surplus node; do NOT fold two real lots together here.")
    for s in shared[:15]:
        print(f"  {s['impressionId']:<40} {s['workIds']}")
    if len(shared) > 15:
        print(f"  ... and {len(shared) - 15} more")

    if out_json:
        with open(out_json, "w") as f:
            json.dump({
                "catalogueConflict": conflict,
                "institutionalPortfolioSuspect": portfolio,
                "proposed": proposed,
                "imagesDissent": dissent,
                "nullYear": null_year,
                "largeCluster": large,
                "blockedByArtistSplit": splits,
                "sharedImpression": shared,
                "excluded": dict(excluded),
            }, f, indent=2, ensure_ascii=False)
        print(f"\nFull results saved to {out_json}")

    return proposed, dissent, null_year, large, conflict, portfolio


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", action="store_true",
                        help="Report duplicate-work clusters. The only mode — this script never writes.")
    parser.add_argument("--artist", help="Restrict to one Artist node's exact name")
    parser.add_argument("--min-cluster", type=int, default=2, help="Smallest cluster to report")
    parser.add_argument("--max-cluster", type=int, default=DEFAULT_MAX_CLUSTER,
                        help="At or above this size, quarantine for review instead of proposing")
    parser.add_argument("--dissent-floor", type=float, default=DEFAULT_DISSENT_FLOOR,
                        help="Neo4j-scale (1+cos)/2 min-sim below which a cluster is flagged for review")
    parser.add_argument("--limit", type=int, help="Score and print only the first N clusters (largest first)")
    parser.add_argument("--json", dest="out_json", help="Also save full results to this path")
    args = parser.parse_args()

    if not args.scan:
        parser.error("Provide --scan (this script has no write mode by design)")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            run_scan(session,
                     artist_filter=args.artist,
                     min_cluster=args.min_cluster,
                     max_cluster=args.max_cluster,
                     dissent_floor=args.dissent_floor,
                     limit=args.limit,
                     out_json=args.out_json)
    finally:
        driver.close()
