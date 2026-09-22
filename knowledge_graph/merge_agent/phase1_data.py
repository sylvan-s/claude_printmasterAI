"""
PrintMasterAI — merge-review agent, Phase 1: records, features and the seed set.
Version: MERGE-AGENT-P1-DATA-1.1

Design: docs/plans/2026-09-22-artist-merge-active-learning-agent.md, Phase 1. Run with the
sklearn-1.6 venv (knowledge_graph/venv-embeddings/bin/python).

THE CONSTRAINT THAT SHAPES EVERYTHING HERE. A merge moves the absorbed node's works, images and
records onto the survivor, and nothing records which were whose. So a past merge's evidence
survives only where a snapshot caught both nodes BEFORE the merge. Records therefore come from,
in order of preference:
  1. artist_records.parquet   the 2026-09-15 extract of every Artist (dates, nationality, ULAN,
                              Wikidata, works, sources, trap flags)
  2. band_b_presnapshot_*     four whole-graph snapshots, 2026-09-12 and 2026-09-15 (dates, ULAN)
  3. artist_pairs_presnapshot_*   the pairs runs' own before-images (dates)
  4. MergeEvent mergedFrom*   ARTIST-MERGE-3.2 and later events carry the absorbed node's ULAN and dates
  5. the live graph           for nodes that still exist (survivors, live candidates, the gold set)

INTRINSIC FEATURES ONLY, in v1. Name, dates, identifiers, nationality, trap flags and the thinner
side's work count can be rebuilt for a merged pair. Shared works and DINOv2 similarity cannot: they
would be present for live negatives and missing for historical positives, and the model would learn
"missing means same". They join the model when enough LIVE pairs are labelled (active learning,
the gold set).

SEED (design doc § 3):
  positive  every Artist MergeEvent except survivorRenamed; weight 1.0 for human decisions and
            exact rules, 0.7 for fuzzy+image rules
  negative  rejected POSSIBLE_SAME_AS edges: 1.0 human, 0.8 rule
            HARD negatives from the live pool: same stripped surname AND a hard contradiction
            (ULAN ids differ, or birth or death years >= 10 apart); weight 0.8
            EASY negatives, weight 0.5: same surname, forenames disjoint, and no name rule fires
            (no subset, initials, typo, honorific or joined-words match). Chosen WITHOUT looking at
            dates or ULAN, because hard negatives are selected for having them, which alone would
            teach "dates present means different" (measured: 95% of hard negatives carry both birth
            years, against 69% of positives and 12% of gold `same` pairs).
Gold pairs are excluded from the seed by name pair, so the gold set stays a pure test set.
"""
import glob
import json
import math
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
import pandas as pd  # noqa: E402
import find_artist_merge_candidates as fam  # noqa: E402
from identity_candidates import connect, session  # noqa: E402
from phase0_blocks import block_squashed, block_surname_edit1, name_rules, stripped  # noqa: E402

KG_MAIN = os.path.expanduser("~/PycharmProjects/claude_printmasterAI/knowledge_graph")
# DATA-1.1 (active-learning round 3 audit): the model scored "Seguace di Stefano della Bella" ~
# "Stefano Della Bella" at 0.99 and "Edward Weston/Cole Weston" ~ "Edward Weston" at 1.00. The trap
# vocabulary was English-only and knew no "/" credit; auction catalogues write all of these.
COLLAB = re.compile(r"(\s&\s|\sand\s|\swith\s|\set\s|\s\+\s|;|\S/\S|\s/\s|\sund\s|\se\s)", re.I)
ATTRIB = re.compile(r"\b(after|school of|follower of|workshop|manner of|circle of|studio of|"
                    r"attributed to|d'apr[eè]s|nach|seguace di|scuola di|cerchia di|bottega|"
                    r"maniera di|alla maniera|atelier|entourage de|suiveur de|[ée]cole de|"
                    r"[ée]l[eè]ve de|umkreis|werkstatt|schule)\b", re.I)
# Generation markers: "Carl Wilhelm I Kolbe" (the Elder) vs "Carl Wilhelm Kolbe". One side marked
# and the other not, or the two marked differently, is the family trap in name form.
GENERATION = re.compile(r"\b(i|ii|iii|iv|elder|younger|the elder|the younger|jr|sr|junior|senior|"
                        r"le jeune|l'a[iî]n[ée]|p[eè]re|fils|d\.\s?[aä]\.|d\.\s?j\.)\b", re.I)
JUNK = re.compile(r"\b(publisher|published|printed by|printer|grouped|lot)\b", re.I)


# ---------------------------------------------------------------------------------- records

def _num(v):
    try:
        f = float(v)
        return None if math.isnan(f) else int(f)
    except (TypeError, ValueError):
        return None


def _uid(u):
    return (str(u).rstrip("/").split("/")[-1] or None) if u and str(u) not in ("nan", "None") else None


class RecordStore:
    """name -> the best available record for that name, before any merge absorbed it."""

    LIVE = """
    MATCH (a:Artist)
    OPTIONAL MATCH (a)-[:CREATED]->(w:ConceptualWork)
    WITH a, count(DISTINCT w) AS works
    RETURN a.name AS name, a.dateBorn_year AS born, a.dateDied_year AS died,
           a.nationality AS nat, a.ulanUrl AS ulan, a.wikidataUrl AS wikidata, works
    """
    EVENTS = """
    MATCH (e:MergeEvent {subject: 'Artist'})-[:MERGED_INTO]->(s:Artist)
    RETURN e.mergedFromName AS absorbed,
           CASE WHEN coalesce(e.survivorNameAtMerge, '') <> '' THEN e.survivorNameAtMerge
                ELSE s.name END AS survivor,
           s.name AS survivorNow, e.rule AS rule, e.decidedBy AS decidedBy,
           e.mergedFromUlan AS ulan, e.mergedFromBorn AS born, e.mergedFromDied AS died
    """

    def __init__(self, s):
        self.rec, self.src = {}, {}
        p = pd.read_parquet(f"{KG_MAIN}/artist_records.parquet")
        for r in p.itertuples():
            self._put(r.name, {"born": _num(r.born), "died": _num(r.died),
                               "nat": r.nationality if isinstance(r.nationality, str) else None,
                               "ulan": _uid(r.ulan_id) or _uid(r.ulan),
                               "wikidata": _uid(r.wikidata), "works": _num(r.works) or 0}, "parquet-0915")
        for f in sorted(glob.glob(f"{KG_MAIN}/band_b_presnapshot_*.json")):
            for a in json.load(open(f))["artists"]:
                self._put(a["name"], {"born": _num(a.get("born")), "died": _num(a.get("died")),
                                      "ulan": _uid(a.get("ulan"))}, os.path.basename(f)[:30])
        for f in sorted(glob.glob(f"{KG_MAIN}/artist_pairs_presnapshot_*.json")):
            for a in json.load(open(f)).get("artists", []):
                pr = a.get("props", {})
                self._put(a["name"], {"born": _num(pr.get("dateBorn_year")),
                                      "died": _num(pr.get("dateDied_year")),
                                      "works": _num(a.get("works"))}, "pairs-snapshot")
        self.events = [dict(r) for r in s.run(self.EVENTS)]
        for e in self.events:
            self._put(e["absorbed"], {"born": _num(e["born"]), "died": _num(e["died"]),
                                      "ulan": _uid(e["ulan"])}, "merge-event")
        self.live = {}
        for r in s.run(self.LIVE):
            if r["name"]:
                self.live[r["name"]] = {"born": _num(r["born"]), "died": _num(r["died"]),
                                        "nat": r["nat"], "ulan": _uid(r["ulan"]),
                                        "wikidata": _uid(r["wikidata"]), "works": r["works"] or 0}
                self._put(r["name"], self.live[r["name"]], "live")
        self.surname_count = Counter()
        for n in self.live:
            t = stripped(n)
            if t:
                self.surname_count[t[-1]] += 1

    def _put(self, name, rec, source):
        """Earlier sources win; a later source only fills fields still missing."""
        if not name:
            return
        cur = self.rec.setdefault(name, {"name": name})
        for k, v in rec.items():
            if v is not None and cur.get(k) is None:
                cur[k] = v
        self.src.setdefault(name, source)

    def get(self, name, live=False):
        if live and name in self.live:
            return {"name": name, **self.live[name]}
        return dict(self.rec.get(name, {"name": name}))


# --------------------------------------------------------------------------------- features

def jaro_winkler(a, b):
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    rng = max(la, lb) // 2 - 1
    ma, mb = [False] * la, [False] * lb
    m = 0
    for i, c in enumerate(a):
        for j in range(max(0, i - rng), min(lb, i + rng + 1)):
            if not mb[j] and b[j] == c:
                ma[i] = mb[j] = True
                m += 1
                break
    if not m:
        return 0.0
    t, k = 0, 0
    for i in range(la):
        if ma[i]:
            while not mb[k]:
                k += 1
            t += a[i] != b[k]
            k += 1
    j = (m / la + m / lb + (m - t / 2) / m) / 3
    p = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        p += 1
    return j + p * 0.1 * (1 - j)


def features(ra, rb, surname_count):
    a, b = ra["name"], rb["name"]
    na, nb = fam.normalize(a), fam.normalize(b)
    ta, tb = fam.tokens(a), fam.tokens(b)
    sa, sb = stripped(a), stripped(b)
    rules = name_rules(a, b)
    f = {
        "name_exact_norm": float(na == nb),
        "name_token_bag": float(sorted(ta) == sorted(tb)),
        "name_squashed": float(block_squashed(a, b)),
        "name_subset": float(bool(ta and tb) and (set(ta) <= set(tb) or set(tb) <= set(ta))),
        "name_honorific": float("honorific" in rules),
        "name_initialism": float("initialism" in rules),
        "name_typo": float("typo" in rules),
        "surname_equal": float(bool(sa and sb) and sa[-1] == sb[-1]),
        "surname_edit1": float(block_surname_edit1(a, b)),
        "jaro_winkler": jaro_winkler(na, nb),
        "token_jaccard": len(set(ta) & set(tb)) / max(len(set(ta) | set(tb)), 1),
        "n_tokens_diff": abs(len(ta) - len(tb)),
        "forename_initial_equal": float(bool(sa and sb) and sa[0][:1] == sb[0][:1]),
        "surname_log_count": math.log1p(surname_count.get(sa[-1], 0) if sa else 0),
    }
    for k in ("born", "died"):
        x, y = ra.get(k), rb.get(k)
        f[f"{k}_both"] = float(x is not None and y is not None)
        f[f"{k}_gap"] = float(abs(x - y)) if x is not None and y is not None else -1.0
        f[f"{k}_agree"] = float(x is not None and y is not None and abs(x - y) <= 2)
        f[f"{k}_conflict10"] = float(x is not None and y is not None and abs(x - y) >= 10)
    impossible = any(r.get("born") and r.get("died") and r["born"] > r["died"] for r in (ra, rb))
    f["dates_impossible"] = float(bool(impossible))
    ua, ub = ra.get("ulan"), rb.get("ulan")
    f["ulan_same"] = float(bool(ua and ub and ua == ub))
    f["ulan_conflict"] = float(bool(ua and ub and ua != ub))
    f["ulan_one_sided"] = float(bool(ua) != bool(ub))
    wa, wb = ra.get("wikidata"), rb.get("wikidata")
    f["wikidata_same"] = float(bool(wa and wb and wa == wb))
    f["wikidata_conflict"] = float(bool(wa and wb and wa != wb))
    xa, xb = (ra.get("nat") or "").lower(), (rb.get("nat") or "").lower()
    f["nat_same"] = float(bool(xa and xb and (xa in xb or xb in xa)))
    f["nat_conflict"] = float(bool(xa and xb and xa not in xb and xb not in xa))
    f["collab_either"] = float(bool(COLLAB.search(f" {a} ") or COLLAB.search(f" {b} ")))
    f["collab_one_sided"] = float(bool(COLLAB.search(f" {a} ")) != bool(COLLAB.search(f" {b} ")))
    f["attrib_either"] = float(bool(ATTRIB.search(a) or ATTRIB.search(b)))
    f["junk_either"] = float(bool(JUNK.search(a) or JUNK.search(b)))
    f["placeholder_either"] = float(fam._is_placeholder(ta) or fam._is_placeholder(tb))
    f["family_risk"] = float(f["surname_equal"] and f["born_conflict10"])
    ga = {m.group(1).lower() for m in GENERATION.finditer(a)}
    gb = {m.group(1).lower() for m in GENERATION.finditer(b)}
    f["generation_mismatch"] = float(ga != gb)
    wks = sorted([ra.get("works") or 0, rb.get("works") or 0])
    f["works_min_log"] = math.log1p(wks[0])
    f["works_max_log"] = math.log1p(wks[1])
    return f


FEATURES = list(features({"name": "a b"}, {"name": "a c"}, Counter()).keys())


# ------------------------------------------------------------------------------------ seed

def seed(store, gold_pairs):
    rows = []
    human_rules = {"humanPairs", "aliasShadowing", "kmIdentityRepair", "reappearedName", "wrapperName"}
    exact_rules = {"ulanCanonical", "caseFold", "nameNormalised", "nameNormalisedDateDispute"}
    for e in store.events:
        if e["rule"] == "survivorRenamed" or not e["absorbed"] or e["absorbed"] == e["survivor"]:
            continue
        pair = frozenset((e["absorbed"], e["survivor"]))
        if pair in gold_pairs:
            continue
        w = 1.0 if (e["decidedBy"] == "human" or e["rule"] in human_rules or e["rule"] in exact_rules) else 0.7
        rows.append({"a": e["absorbed"], "b": e["survivor"], "y": 1, "w": w,
                     "source": f"merge:{e['rule']}", "ra": store.get(e["absorbed"]),
                     "rb": store.get(e["survivor"])})
    return rows


def rejected_negatives(s, store, gold_pairs):
    q = """MATCH (x:Artist)-[p:POSSIBLE_SAME_AS {status:'rejected'}]-(y:Artist)
           WHERE x.name < y.name RETURN x.name AS a, y.name AS b, p.decidedBy AS by, p.decisionNote AS note"""
    out = []
    for r in s.run(q):
        if frozenset((r["a"], r["b"])) in gold_pairs:
            continue
        out.append({"a": r["a"], "b": r["b"], "y": 0, "w": 1.0 if r["by"] == "human" else 0.8,
                    "source": f"rejected:{r['by']}", "ra": store.get(r["a"], live=True),
                    "rb": store.get(r["b"], live=True)})
    return out


def hard_negatives(store, gold_pairs, limit, rng):
    by_last = defaultdict(list)
    for n in store.live:
        t = stripped(n)
        if t and not fam._is_placeholder(t):
            by_last[t[-1]].append(n)
    cands = []
    for members in by_last.values():
        members = sorted(members)[:80]
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                a, b = members[i], members[j]
                if frozenset((a, b)) in gold_pairs:
                    continue
                ra, rb = store.get(a, live=True), store.get(b, live=True)
                contra = []
                if ra.get("ulan") and rb.get("ulan") and ra["ulan"] != rb["ulan"]:
                    contra.append("ulan")
                for k in ("born", "died"):
                    if ra.get(k) is not None and rb.get(k) is not None and abs(ra[k] - rb[k]) >= 10:
                        contra.append(k)
                if contra:
                    cands.append({"a": a, "b": b, "y": 0, "w": 0.8,
                                  "source": "hard:" + "+".join(contra), "ra": ra, "rb": rb})
    rng.shuffle(cands)
    return cands[:limit], len(cands)


def easy_negatives(store, gold_pairs, limit, rng):
    by_last = defaultdict(list)
    for n in store.live:
        t = stripped(n)
        if t and len(t) >= 2 and not fam._is_placeholder(t):
            by_last[t[-1]].append(n)
    cands = []
    for members in by_last.values():
        members = sorted(members)[:80]
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                a, b = members[i], members[j]
                if frozenset((a, b)) in gold_pairs:
                    continue
                sa, sb = stripped(a), stripped(b)
                if set(sa[:-1]) & set(sb[:-1]) or set(sa) <= set(sb) or set(sb) <= set(sa):
                    continue
                if sa[0][:1] == sb[0][:1] or name_rules(a, b) or block_squashed(a, b):
                    continue
                cands.append({"a": a, "b": b, "y": 0, "w": 0.5, "source": "easy",
                              "ra": store.get(a, live=True), "rb": store.get(b, live=True)})
    rng.shuffle(cands)
    return cands[:limit], len(cands)


def gold_rows(store, gold, labels, include_ulan_sourced=False):
    out = []
    for gid, p in gold.items():
        lab = labels[gid]
        if lab["label"] not in ("same", "different"):
            continue
        if lab.get("labelSource") == "ulan" and not include_ulan_sourced:
            continue
        a, b = p["a"]["name"], p["b"]["name"]
        out.append({"id": gid, "a": a, "b": b, "y": int(lab["label"] == "same"), "w": 1.0,
                    "stratum": lab["stratum"], "source": "gold",
                    "ra": store.get(a, live=True), "rb": store.get(b, live=True)})
    return out


def candidate_pool(store, shared_pairs):
    """The Phase 0 pool (99.3% recall on known merges): same stripped surname (blocks capped at
    80 names), the five name rules, joined-words, surname one edit apart with the same forename
    initial, and shared work. Returns frozensets of live names."""
    names = sorted(store.live)
    pool = set(p for p in shared_pairs if len(p) == 2)
    by_last = defaultdict(list)
    for n in names:
        t = stripped(n)
        if t and not fam._is_placeholder(t):
            by_last[t[-1]].append(n)
    for members in by_last.values():
        members = members[:80]
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                pool.add(frozenset((members[i], members[j])))
    arts = [(n, fam.tokens(n)) for n in names]
    for a, b, _ in (fam.gen_key_collisions(arts, lambda t: " ".join(t) if len(t) >= 2 else None, "x")
                    + fam.gen_key_collisions(arts, lambda t: " ".join(fam.strip_honorifics(t)), "x")
                    + fam.gen_initialism(arts) + fam.gen_typo(arts)):
        if a != b:
            pool.add(frozenset((a, b)))
    squash = defaultdict(list)
    for n in names:
        k = fam.normalize(n).replace(" ", "")
        if len(k) >= 6:
            squash[k].append(n)
    for m in squash.values():
        for i in range(len(m)):
            for j in range(i + 1, len(m)):
                pool.add(frozenset((m[i], m[j])))
    by_ini = defaultdict(lambda: defaultdict(list))
    for n in names:
        t = stripped(n)
        if len(t) >= 2 and not fam._is_placeholder(t) and len(t[-1]) >= 5:
            by_ini[t[0][0]][t[-1]].append(n)
    for surn in by_ini.values():
        keys = sorted(surn)
        for i, x in enumerate(keys):
            for yk in keys[i + 1:]:
                if abs(len(x) - len(yk)) <= 1 and fam.damerau_levenshtein(x, yk, cap=2) == 1:
                    for na in surn[x]:
                        for nb in surn[yk]:
                            pool.add(frozenset((na, nb)))
    return [p for p in pool if len(p) == 2]
