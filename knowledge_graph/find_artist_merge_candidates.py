"""
PrintMasterAI — Artist-node merge-candidate detection: token-subset name matching,
corroborated by DINOv2 image-embedding cross-similarity
Version: ARTIST-MERGE-CANDIDATES-1.0

Complements the exact-normalization checks already run in this graph's history
(honorific-stripping, ALL-CAPS case-folding) with a genuinely different, complementary
technique: those both rely on one name being a clean prefix/suffix of the other after
stripping a known suffix/casing difference. Real name variants are often NOT a clean
prefix/suffix relationship — a middle name gets inserted in the middle ("Roberto Matta"
vs "Roberto Sébastian Matta"), which no substring check catches. **Token-set
containment** does: treat each name as a bag of words and flag pairs where one
artist's word-set is a subset of the other's, regardless of word order or position.
Grouped by surname first (the last token) to keep this cheap and avoid an O(n^2) scan
across the whole Artist label.

**This alone is not enough to trust as an auto-merge signal — confirmed by two real
false-positive traps found live, 2026-09-06, not designed defensively in the
abstract:**
  1. "Alexander Calder" (556 works) vs "Alexander Milne Calder" (1 work) — passes the
     name check, but Alexander Milne Calder was a real, different person: the famous
     mobile-sculptor's own grandfather, three generations of Calder sculptors sharing
     a name pattern.
  2. "Camille Pissarro" (32 embedded works) vs "Orovida Camille Pissarro" (10 embedded
     works) — Orovida was Camille Pissarro's own granddaughter, a distinct artist with
     her own separate career (1893-1968), found only by running this check broadly,
     not by looking for it.

**DINOv2 cross-similarity between the two candidate nodes' own already-embedded
DigitalImage vectors turns out to be a genuinely discriminating corroborating signal
for exactly this — CLIP does not.** Confirmed live against the two known cases above
plus the real Roberto Matta split (same person, 4-way name-variant fragmentation):
Matta's real split scored DINOv2 max=0.934 across name-variant pairs; Calder and
Pissarro/Orovida (both confirmed different real people) scored 0.522 and 0.408
respectively. CLIP stayed high (~0.75-0.80) regardless of true identity in every case
tested — not discriminating here, likely because CLIP's embedding leans more on broad
semantic/content category than the fine-grained stylistic "hand" signature DINOv2
captures. So this script scores DINOv2 only, not CLIP.

**Coverage caveat:** only pairs where BOTH sides have at least one embedded
`DigitalImage` can be scored at all — currently that means Bonhams/Tate/British Museum
only (Roseberys/Forum have no DINOv2/CLIP coverage). Pairs with only 1-2 images per
side are statistically noisy — a low score there means "not enough data," not
"confirmed different." Don't over-read a thin-sample low score as a rejection.

Same "no fuzzy matching, always generate candidates for review rather than auto-merge"
discipline as catalogue_matching.py and every prior artist-dedup pass in this graph's
history (see feedback_catalogue_identity_no_fuzzy_matching memory) — `--merge` only
acts on pairs whose DINOv2 max similarity clears `--threshold` (default 0.80, the
value that cleanly separated every genuine match from every known false positive in
the pairs checked so far); everything else is left for a human to look at via `--scan`.

Canonical node per merged pair is chosen the same way as every other merge this
session: (has ulanUrl, has wikidataUrl, most CREATED works) in that priority order —
computed live per pair, never assumed from which name happens to be "shorter" or
"longer".

Usage:
    python3 find_artist_merge_candidates.py --scan                        # report only, no writes
    python3 find_artist_merge_candidates.py --scan --json out.json        # also save full results
    python3 find_artist_merge_candidates.py --merge --threshold 0.80      # execute merges for scored pairs >= threshold
    python3 find_artist_merge_candidates.py --merge --threshold 0.80 --dry-run   # print what would merge, no writes

**2026-09-06 — spelling-variant generators added.** The token-subset rule above only fires
when one name's word-set is a strict subset of the other's AND they share a last token, so
it structurally cannot see the largest duplicate class in the graph: the same name spelled
two ways. A DINOv2 neighbour sweep over all 30,965 embedded Bonhams lot images (cosine
>= 0.95, neighbour lots attributed to differently-named Artist nodes) surfaced ~120
conflicting name pairs, the large majority of which this script was blind to. Four further
candidate generators now run alongside it, each tagging its pairs with a `rule`:

  `normalized_equal` — identical after NFKD accent-stripping, punctuation removal, case
      folding and whitespace collapse. NOT fuzzy: this is exact matching under a
      normalization, the same discipline as catalogue_matching.py. Catches
      "Axel Hütte"/"Axel Hutte", "Antoni Tàpies"/"Antoni Tapies", "Albrecht Dürer"/"Durer",
      "O. Winston Link"/"O.Winston Link", "R B Kitaj"/"R.B. Kitaj".
  `honorific` — equal after also stripping post-nominals/titles (OM, RA, ARA, PRA, RGI,
      DLitt, CBE, Sir, Dame, ...) and trailing life-dates. Catches
      "Elizabeth Blackadder RGI DLitt"/"Elizabeth Blackadder", "Dame Barbara Hepworth"/
      "Barbara Hepworth", "Andy Warhol 1928-1987"/"Andy Warhol", "Ben, OM Nicholson"/
      "Ben Nicholson".
  `initialism` — same surname, and every forename token of the shorter name is a single
      letter matching the initial of the corresponding token in the longer. Catches
      "F. Bartolozzi"/"Francesco Bartolozzi", "G. B. Passeri"/"Giovanni Battista Passeri",
      "Stanley R Badmin"/"Stanley Roy Badmin", "Gordon H. Grant"/"Gordon Hope Grant".
  `typo` — the only genuinely fuzzy generator, and deliberately the tightest: same token
      count, normalized length >= 8, and Damerau-Levenshtein distance <= 2 over the whole
      name (transposition counted as one edit, since transposition is the dominant typo
      class in auction cataloguing). Blocked on sharing at least one exact token so it does
      not degenerate into an O(n^2) scan. Catches "Takashi Murakama"/"Murakami",
      "José Luis Ceuvas"/"Cuevas", "Elisabeth"/"Elizabeth Frink", "Mark Toby"/"Tobey",
      "Richard Linder"/"Lindner", "Anthony"/"Antony Gormley".

The same-token-count requirement on `typo` is what keeps the two known false-positive traps
out by construction: "Alexander Calder"/"Alexander Milne Calder" and "Camille Pissarro"/
"Orovida Camille Pissarro" differ in token count, so `typo` never proposes them (they reach
the report through `token_subset` and are rejected on their DINOv2 score, as before). Two
further real different-people pairs found in the 2026-09-06 sweep are excluded the same way
— "John James Audubon"/"John Woodhouse Audubon" and "Teruko Yokoi"/"Tomoe Yokoi" have equal
token counts but edit distances of 7 and 4. `typo` still proposes at least one pair that is
plausibly two real people ("Alan Jones"/"Allen Jones"), which is precisely why nothing here
auto-merges below the DINOv2 gate.

Scoring is now vectorised with numpy and capped at MAX_VECS_PER_ARTIST images per side —
the previous pure-Python O(n*m) cosine over every image an artist has was fine for a handful
of hand-picked pairs but not for the few hundred these generators produce.
"""

import argparse
import json
import os
import unicodedata
from collections import defaultdict

import numpy as np
from neo4j import GraphDatabase


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

# Surnames (last token of the normalized name) that are placeholder buckets, not real
# individual identities — confirmed real cases found in this graph, not guessed:
# "Anonymous, Nth century"/"British Nth Century" (a nationality-qualified anonymous
# placeholder, not one coherent identity), "Various Artists"/"Various ... Artists"
# (multi-artist lot placeholders). Excluded from candidate generation entirely, same
# category as "Monogrammist"/"Master" already excluded from the honorific sweep.
PLACEHOLDER_SURNAMES = {"artists", "century", "unknown", "known"}

DEFAULT_THRESHOLD = 0.80

# Cap on how many of an artist's embedded images are pulled for scoring. The signal we want
# is "do ANY two works by these two nodes look like the same hand", so a sample is enough;
# without a cap a pair like Picasso (>1,000 embedded works) alone would dominate runtime.
MAX_VECS_PER_ARTIST = 15

# Post-nominals, honorifics and titles that appear as standalone tokens in this graph's
# artist names. Stripped only when a token matches one of these exactly (after
# normalization), and only when >= 2 tokens survive.
HONORIFICS = {
    "sir", "dame", "lady", "lord", "the", "hon",
    "om", "cbe", "obe", "mbe", "kbe", "cvo", "kcvo", "gbe",
    "ra", "ara", "pra", "ppra", "re", "are", "rws", "arws", "rba", "rbs", "rdi",
    "rsa", "arsa", "prsa", "rsw", "rgi", "rp", "roi", "rwa", "neac", "frsa", "fba",
    "dlitt", "dphil", "hrsa", "hrsw", "ps", "sma", "rcaanciennes",
    # Academic title, confirmed on one node: 'Professor Karl-Otto Götz' vs 'Karl Otto Gotz'.
    # Without it `_noise` ties at 0 and preferred_name()'s token-count rule promotes the
    # titled form, making the canonical name worse rather than better.
    "professor", "prof",
}

# Auction-cataloguing prefixes: NOT titles, so deliberately kept out of HONORIFICS, but
# stripped by strip_honorifics() for the same reason — they are junk a canonical name must
# not inherit. Confirmed, not guessed: 'RTO' heads 19 Artist nodes in this graph
# ('RTO Jonas Wood', 'RTO Reg Butler', 'RTO Sir William Nicholson', and the frankly
# non-artist 'RTO TO BE AUTHENTICATED'). Before this was added, a dry run planned
# 'RTO Jonas Wood' -> 'Jonas Wood' followed by a rename of the survivor BACK to
# 'RTO Jonas Wood'. Extend only from a confirmed case, same discipline as
# catalogue_matching.py's NON_CATALOGUE_NAMES.
CATALOGUING_PREFIXES = {"rto"}

# Trailing life-date / birth-year noise: "Andy Warhol 1928-1987", "... b. 1968",
# "... born 1942". Matched as whole tokens after normalization.
_YEARISH = {"b", "born", "c", "circa", "active", "fl"}

# Tokens too common to use as a blocking key for the `typo` generator — comparing every
# pair sharing "van" or "de" would put the scan back into O(n^2).
TYPO_BLOCK_MAX_BUCKET = 300

RULE_PRIORITY = ["normalized_equal", "honorific", "initialism", "token_subset", "typo"]

# Per-rule floors on the DINOv2 score, applied on top of --threshold (the higher of the two
# wins). Not every rule carries the same name-side risk, so one global gate is wrong.
#
# `normalized_equal`, `honorific` and `initialism` are deterministic: two names that are
# identical after accent-stripping, or that differ only by a post-nominal, or where one
# abbreviates the other's forenames, are the same *name*. The image score is there to catch
# the rare case of two different people who genuinely share a name, so 0.80 is enough.
#
# `token_subset` is different in kind. One name being a strict superset of the other is
# precisely how a *relative's* name differs — a middle name inserted in the middle — and it
# is the rule that generated both known false-positive traps in this graph's history
# ("Alexander Calder"/"Alexander Milne Calder", grandfather and grandson; "Camille
# Pissarro"/"Orovida Camille Pissarro", grandfather and granddaughter). There the name
# signal is not evidence of shared identity at all, so the images have to carry the whole
# claim. 0.90 is a judgement call, NOT a calibrated number: the two known traps scored 0.522
# and 0.408 and the one known-genuine split (Matta) scored 0.934, so nothing in the
# available ground truth speaks to the 0.80-0.90 band. Held-back pairs are not discarded —
# they surface in the scan report for review.
RULE_THRESHOLDS = {"token_subset": 0.90}


def threshold_for(rule, base):
    return max(base, RULE_THRESHOLDS.get(rule, base))

EMBEDDINGS_QUERY = """
UNWIND $names AS nm
MATCH (a:Artist {name: nm})
CALL {
    WITH a
    MATCH (a)-[:CREATED]->(:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(imp:Impression)<-[:SHOWS]-(img:DigitalImage)
    WHERE img.embedding IS NOT NULL
    RETURN img.embedding AS e
    LIMIT $maxVecs
}
RETURN nm AS name, collect(e) AS embeddings
"""

ALL_ARTISTS_QUERY = """
MATCH (a:Artist)
OPTIONAL MATCH (a)-[:CREATED]->(cw)
RETURN a.name AS name, a.ulanUrl AS ulan, a.wikidataUrl AS wikidata, count(DISTINCT cw) AS works
"""

MERGE_QUERY = """
MATCH (dup:Artist {name: $dupName})
MATCH (canon:Artist {name: $canonName})
WITH canon, dup, coalesce(canon.alternateNames,[]) + coalesce(dup.alternateNames,[]) + [dup.name, canon.name] AS combined
UNWIND combined AS x
WITH canon, dup, collect(DISTINCT x) AS deduped
SET canon.alternateNames = deduped
WITH canon, dup
OPTIONAL MATCH (dup)-[:CREATED]->(cw2:ConceptualWork)
FOREACH (x IN CASE WHEN cw2 IS NULL THEN [] ELSE [cw2] END | MERGE (canon)-[:CREATED]->(x))
WITH canon, dup
OPTIONAL MATCH (dup)-[:FROM_REGION]->(reg:Region)
FOREACH (x IN CASE WHEN reg IS NULL THEN [] ELSE [reg] END | MERGE (canon)-[:FROM_REGION]->(x))
WITH canon, dup
OPTIONAL MATCH (src:SourceRecord)-[:ATTRIBUTED_TO]->(dup)
FOREACH (x IN CASE WHEN src IS NULL THEN [] ELSE [src] END | MERGE (x)-[:ATTRIBUTED_TO]->(canon))
WITH dup
DETACH DELETE dup
"""


RENAME_QUERY = """
MATCH (a:Artist {name: $fromName})
SET a.name = $toName
RETURN a.name AS name
"""


def normalize(name):
    """Accent-strip, drop punctuation, casefold, collapse whitespace. The single
    normalization every generator below agrees on."""
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    cleaned = "".join(ch if ch.isalnum() else " " for ch in stripped)
    return " ".join(cleaned.lower().split())


def tokens(name):
    return normalize(name).split()


def strip_honorifics(toks):
    """Drop post-nominals/titles, auction-cataloguing prefixes and trailing life-date
    noise, but never reduce a name below two tokens — "Sir Frank Short" -> "frank short",
    "RTO Jonas Wood" -> "jonas wood", "Christo" stays "christo"."""
    out = [t for t in toks if t not in HONORIFICS and t not in CATALOGUING_PREFIXES]
    while len(out) > 2 and (out[-1].isdigit() or out[-1] in _YEARISH):
        out = out[:-1]
    if len(out) < 2:
        return toks
    return out


def damerau_levenshtein(a, b, cap=3):
    """Optimal string alignment distance, i.e. Levenshtein plus adjacent transposition as
    a single edit. Bails out at `cap` — we only ever care whether it is <= 2."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > cap:
            return cap + 1
        prev2, prev = prev, cur
    return prev[len(b)]


def _is_placeholder(toks):
    return not toks or toks[-1] in PLACEHOLDER_SURNAMES


def gen_key_collisions(artists, keyfn, rule):
    """Generic generator: any two artists whose key collides are a candidate pair."""
    buckets = defaultdict(list)
    for name, toks in artists:
        if _is_placeholder(toks):
            continue
        key = keyfn(toks)
        if key:
            buckets[key].append(name)
    pairs = []
    for members in buckets.values():
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                pairs.append((members[i], members[j], rule))
    return pairs


def gen_initialism(artists):
    """One name abbreviates the other's forenames to initials. Position by position each
    forename must either be identical or be a single letter that the longer name's token
    starts with, and at least one position must actually be an abbreviation. Surnames are
    bucketed on their first four characters and allowed to differ by one edit, so the
    common "initials AND a misspelt surname" case ("J A McNeil Whistler" vs
    "James Abbott McNeill Whistler") is still reachable."""
    buckets = defaultdict(list)
    for name, toks in artists:
        toks = strip_honorifics(toks)
        if _is_placeholder(toks) or len(toks) < 2:
            continue
        buckets[toks[-1][:4]].append((name, toks))

    pairs = []
    for members in buckets.values():
        for i in range(len(members)):
            for j in range(len(members)):
                if i == j:
                    continue
                (na, ta), (nb, tb) = members[i], members[j]
                if na == nb or len(ta) != len(tb):
                    continue
                if damerau_levenshtein(ta[-1], tb[-1], cap=2) > 1:
                    continue
                fa, fb = ta[:-1], tb[:-1]
                if not fa or fa == fb:
                    continue
                abbreviated = False
                ok = True
                for x, y in zip(fa, fb):
                    if x == y:
                        continue
                    if len(x) == 1 and len(y) > 1 and y.startswith(x):
                        abbreviated = True
                        continue
                    ok = False
                    break
                if ok and abbreviated:
                    pairs.append((na, nb, "initialism"))
    return pairs


def gen_typo(artists):
    """Same token count, normalized length >= 8, Damerau-Levenshtein <= 2. Blocked on
    sharing at least one exact token so this stays linear-ish."""
    index = defaultdict(list)
    for idx, (name, toks) in enumerate(artists):
        if _is_placeholder(toks):
            continue
        for t in set(toks):
            index[t].append(idx)

    seen, pairs = set(), []
    for tok, members in index.items():
        if len(members) > TYPO_BLOCK_MAX_BUCKET:
            continue
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                key = (members[i], members[j])
                if key in seen:
                    continue
                seen.add(key)
                na, ta = artists[members[i]]
                nb, tb = artists[members[j]]
                if len(ta) != len(tb):
                    continue
                sa, sb = " ".join(ta), " ".join(tb)
                if sa == sb or min(len(sa), len(sb)) < 8:
                    continue
                if damerau_levenshtein(sa, sb) <= 2:
                    pairs.append((na, nb, "typo"))
    return pairs


def find_candidate_pairs(session):
    """Runs every generator, then collapses duplicates so each unordered name pair appears
    once, tagged with its highest-priority rule."""
    rows = [dict(r) for r in session.run(ALL_ARTISTS_QUERY)]
    info = {r["name"]: r for r in rows if r["name"]}
    artists = [(r["name"], tokens(r["name"])) for r in rows if r["name"]]

    raw = []
    raw += gen_key_collisions(artists, lambda t: " ".join(t) if len(t) >= 2 else None, "normalized_equal")
    raw += gen_key_collisions(artists, lambda t: " ".join(strip_honorifics(t)), "honorific")
    raw += gen_initialism(artists)
    raw += gen_typo(artists)

    # The original token-subset rule, unchanged in meaning, evaluated here so every rule
    # shares one normalization and one output shape.
    subset_buckets = defaultdict(list)
    for name, toks in artists:
        if _is_placeholder(toks) or len(toks) < 2:
            continue
        subset_buckets[toks[-1]].append((name, toks))
    for members in subset_buckets.values():
        for i in range(len(members)):
            for j in range(len(members)):
                if i == j:
                    continue
                (na, ta), (nb, tb) = members[i], members[j]
                if len(ta) + 1 == len(tb) and all(t in tb for t in ta):
                    raw.append((na, nb, "token_subset"))

    best = {}
    for a, b, rule in raw:
        if a == b:
            continue
        key = tuple(sorted((a, b)))
        prio = RULE_PRIORITY.index(rule)
        if key not in best or prio < best[key][0]:
            best[key] = (prio, rule)

    pairs = []
    for (a, b), (_, rule) in best.items():
        ia, ib = info[a], info[b]
        pairs.append({
            "rule": rule,
            "nameA": a, "worksA": ia["works"],
            "nameB": b, "worksB": ib["works"],
        })
    pairs.sort(key=lambda r: (RULE_PRIORITY.index(r["rule"]), r["nameA"]))
    return pairs, info


def fetch_embeddings(session, names, batch=40):
    out = {}
    for i in range(0, len(names), batch):
        chunk = names[i:i + batch]
        for r in session.run(EMBEDDINGS_QUERY, names=chunk, maxVecs=MAX_VECS_PER_ARTIST):
            if r["embeddings"]:
                out[r["name"]] = r["embeddings"]
    return out


def _unit(vecs):
    m = np.asarray(vecs, dtype=np.float32)
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return m / norms


def score_pairs(pairs, embeddings):
    cache = {}
    scored, unscored = [], []
    for p in pairs:
        va, vb = embeddings.get(p["nameA"]), embeddings.get(p["nameB"])
        if not va or not vb:
            unscored.append(p)
            continue
        for nm, v in ((p["nameA"], va), (p["nameB"], vb)):
            if nm not in cache:
                cache[nm] = _unit(v)
        sims = cache[p["nameA"]] @ cache[p["nameB"]].T
        scored.append({
            **p,
            "nA": len(va), "nB": len(vb),
            "meanSim": float(sims.mean()), "maxSim": float(sims.max()),
        })
    scored.sort(key=lambda r: -r["maxSim"])
    return scored, unscored


def pick_canonical(info, nameA, nameB):
    """Which NODE survives: has ULAN, then has Wikidata, then most works. Deliberately
    unchanged — an external identifier is the one thing a merge cannot re-derive, so the
    node holding it must be the one that lives.

    This says nothing about which *name string* should survive, and the two answers often
    differ: 'Dame Barbara Hepworth' holds the ULAN but 'Barbara Hepworth' is the name we
    want to keep. See preferred_name()."""
    def score(nm):
        i = info[nm]
        return (1_000_000 if i["ulan"] else 0) + (100_000 if i["wikidata"] else 0) + 10 * i["works"]

    if score(nameA) >= score(nameB):
        return nameA, nameB
    return nameB, nameA


def _noise(name):
    """How much junk a name string carries: post-nominals and titles ('Dame Barbara
    Hepworth', 'Ben, OM Nicholson', 'Elizabeth Blackadder RGI DLitt'), trailing life-dates
    ('Andy Warhol 1928-1987'), and asterisked abbreviations ('T* Hollins and J* C*
    Stadler')."""
    toks = tokens(name)
    return (len(toks) - len(strip_honorifics(toks))) + (2 if "*" in name else 0)


def _initials(name):
    """Count of tokens that are a bare initial. 'J A McNeil Whistler' scores 2,
    'James A McNeil Whistler' scores 1 — both are four tokens, so token count alone cannot
    separate them."""
    return sum(1 for t in tokens(name) if len(t) == 1)


def _diacritics(name):
    return sum(1 for ch in unicodedata.normalize("NFKD", name) if unicodedata.combining(ch))


def preferred_name(info, nameA, nameB):
    """Which name STRING the survivor should carry, independent of which node survives.

    Ordered, deterministic, no fuzziness:
      1. less honorific/life-date/asterisk noise
      2. where the two normalize to the same string, the one that keeps its diacritics
         ('Maurice Estève' over 'Maurice Esteve', 'Axel Hütte' over 'Axel Hutte')
      3. fewer bare initials ('James A McNeil Whistler' over 'J A McNeil Whistler',
         'Gordon Hope Grant' over 'Gordon H. Grant')
      4. more name tokens, i.e. the more complete form ('Cyril Edward Power' over 'Cyril
         Power', 'Henri Privat-Livemont' over 'Privat Livemont')
      5. more works, as a proxy for which spelling the catalogue data actually favours
         ('Elisabeth Frink' over 'Elizabeth Frink')
      6. lexicographic, purely so the result is stable
    """
    na, nb = _noise(nameA), _noise(nameB)
    if na != nb:
        return nameA if na < nb else nameB

    if normalize(nameA) == normalize(nameB):
        da, db = _diacritics(nameA), _diacritics(nameB)
        if da != db:
            return nameA if da > db else nameB

    ia, ib = _initials(nameA), _initials(nameB)
    if ia != ib:
        return nameA if ia < ib else nameB

    ta = len(strip_honorifics(tokens(nameA)))
    tb = len(strip_honorifics(tokens(nameB)))
    if ta != tb:
        return nameA if ta > tb else nameB

    wa, wb = info[nameA]["works"], info[nameB]["works"]
    if wa != wb:
        return nameA if wa > wb else nameB

    return min(nameA, nameB)


def plan_pair(info, nameA, nameB):
    """(surviving node, node to delete, name the survivor should end up with)."""
    canon, dup = pick_canonical(info, nameA, nameB)
    return canon, dup, preferred_name(info, nameA, nameB)


def _fmt(r, info):
    canon, dup, display = plan_pair(info, r["nameA"], r["nameB"])
    ids = []
    if info[canon]["ulan"]:
        ids.append("ULAN")
    if info[canon]["wikidata"]:
        ids.append("WD")
    tag = ("[" + "+".join(ids) + "]") if ids else ""
    rename = f"  RENAME -> {display!r}" if display != canon else ""
    thin = " THIN" if min(r["nA"], r["nB"]) < 3 else ""
    return (f"  {r['maxSim']:.3f} n={r['nA']}x{r['nB']}{thin:<5} {r['rule']:<16} "
            f"{dup!r} ({info[dup]['works']}w)  ->  {canon!r} ({info[canon]['works']}w) {tag}{rename}")


def run_scan(session, out_json=None, threshold=DEFAULT_THRESHOLD):
    pairs, info = find_candidate_pairs(session)
    by_rule = defaultdict(int)
    for p in pairs:
        by_rule[p["rule"]] += 1
    print(f"Total candidate pairs (after excluding placeholder surnames): {len(pairs)}")
    for rule in RULE_PRIORITY:
        print(f"    {rule:<18} {by_rule[rule]}")

    names = sorted({p["nameA"] for p in pairs} | {p["nameB"] for p in pairs})
    embeddings = fetch_embeddings(session, names)
    print(f"\nArtists with >=1 embedded image among candidates: {len(embeddings)} / {len(names)}")
    scored, unscored = score_pairs(pairs, embeddings)
    print(f"Scored (both sides have embeddings): {len(scored)}")
    print(f"Unscored (no embedding coverage on one/both sides): {len(unscored)}\n")

    passes = [r for r in scored if r["maxSim"] >= threshold_for(r["rule"], threshold)]
    held = [r for r in scored
            if r["maxSim"] >= threshold and r["maxSim"] < threshold_for(r["rule"], threshold)]

    print(f"=== STYLE-CORROBORATED (max DINOv2 sim >= {threshold}) — proposed merges ===")
    for r in passes:
        print(_fmt(r, info))

    if held:
        floors = ", ".join(f"{k} >= {v}" for k, v in sorted(RULE_THRESHOLDS.items()))
        print(f"\n=== HELD BACK BY PER-RULE FLOOR ({floors}) — clears {threshold} but not its "
              f"rule's floor, review by hand ===")
        for r in held:
            print(_fmt(r, info))

    print(f"\n=== AMBIGUOUS (0.55 <= max < {threshold}) — manual review ===")
    for r in scored:
        if 0.55 <= r["maxSim"] < threshold:
            print(_fmt(r, info))

    # A low score is only evidence of "different people" when both sides have enough
    # embedded images for the comparison to mean anything. Pairs marked THIN (fewer than 3
    # images on one side) routinely score near zero while being obviously the same person
    # by name — "Willam"/"William Seaby", "Matt"/"Mat Collishaw" — because the one image
    # each node holds is simply a different work. Read THIN low scores as "no evidence",
    # never as a rejection.
    print("\n=== STYLE DOES NOT CORROBORATE (max < 0.55) — different people, OR too thin to tell ===")
    for r in scored:
        if r["maxSim"] < 0.55:
            print(_fmt(r, info))

    print(f"\n=== NO EMBEDDING COVERAGE ({len(unscored)} pairs, name-only signal) ===")
    for p in unscored:
        by = defaultdict(list)
        by[p["rule"]].append(p)
        print(f"  {'':5} {p['rule']:<16} {p['nameA']!r} ({p['worksA']}w) <-> {p['nameB']!r} ({p['worksB']}w)")

    if out_json:
        with open(out_json, "w") as f:
            json.dump({"scored": scored, "unscored": unscored}, f, indent=2, ensure_ascii=False)
        print(f"\nFull results saved to {out_json}")

    return scored, unscored


def run_merge(session, threshold, dry_run=False, only_rules=None, exclude_names=None):
    """`only_rules` restricts the run to one or more rule families; `exclude_names` drops
    any pair naming a listed artist. Both exist because the families carry very different
    risk — a 2026-09-10 dry run of all 133 pairs was accepted for `normalized_equal` only,
    with `typo` and `token_subset` held back over four pairs that looked like different
    people on one-image-each evidence ('Pieter Cramer'/'Pierre Cramer',
    'John Sperling'/'Josh Sperling', 'Robert Parker'/'Robert Andrew Parker',
    'William Seaby'/'Allen William Seaby')."""
    pairs, info = find_candidate_pairs(session)
    names = sorted({p["nameA"] for p in pairs} | {p["nameB"] for p in pairs})
    embeddings = fetch_embeddings(session, names)
    scored, _ = score_pairs(pairs, embeddings)

    to_merge = [r for r in scored if r["maxSim"] >= threshold_for(r["rule"], threshold)]
    if only_rules:
        skipped_rule = [r for r in to_merge if r["rule"] not in only_rules]
        to_merge = [r for r in to_merge if r["rule"] in only_rules]
        print(f"--rule {','.join(sorted(only_rules))}: {len(skipped_rule)} pair(s) in other "
              f"families are NOT merged by this run.")
    if exclude_names:
        blocked = [r for r in to_merge
                   if r["nameA"] in exclude_names or r["nameB"] in exclude_names]
        to_merge = [r for r in to_merge if r not in blocked]
        for r in blocked:
            print(f"[EXCLUDED] {r['nameA']!r} <-> {r['nameB']!r} — named in --exclude-name")
    held = [r for r in scored
            if r["maxSim"] >= threshold and r["maxSim"] < threshold_for(r["rule"], threshold)]
    print(f"{len(to_merge)} pair(s) clear their rule's DINOv2 threshold (base {threshold}, "
          f"per-rule floors {RULE_THRESHOLDS}).")
    if held:
        print(f"{len(held)} pair(s) held back by a per-rule floor and NOT merged:")
        for r in held:
            print(f"    {r['maxSim']:.3f} {r['rule']:<16} {r['nameA']!r} <-> {r['nameB']!r}")
    print()

    # Clusters of three or more nodes ('Axel Hutte'/'Axel Hütte'/'Alex Hütte',
    # 'Felix Buhot'/'Félix Buhot'/'Félix Hilaire Buhot') produce several pairs that overlap.
    # Once the first pair is applied, a later pair may name a node that has been deleted or
    # renamed, and its MATCH would silently find nothing. Track where every name has ended
    # up and re-resolve both sides before acting.
    alias = {}

    def resolve(name):
        seen = set()
        while name in alias and name not in seen:
            seen.add(name)
            name = alias[name]
        return name

    merged = renamed = skipped = 0
    for r in to_merge:
        a, b = resolve(r["nameA"]), resolve(r["nameB"])
        if a == b:
            print(f"[SKIP] {r['nameA']!r} / {r['nameB']!r} — already unified as {a!r} by an earlier pair")
            skipped += 1
            continue

        canon, dup, display = plan_pair(info, a, b)
        rename = f", then rename -> {display!r}" if display != canon else ""
        thin = " [THIN SAMPLE]" if min(r["nA"], r["nB"]) < 3 else ""
        label = f"{dup!r} -> {canon!r}{rename} (rule={r['rule']}, maxSim={r['maxSim']:.3f}, n={r['nA']}x{r['nB']}){thin}"

        if dry_run:
            print(f"[DRY RUN] merge {label}")
        else:
            counters = session.run(MERGE_QUERY, dupName=dup, canonName=canon).consume().counters
            if not counters.nodes_deleted:
                print(f"[SKIP] {dup!r} -> {canon!r} — one side no longer present in the graph")
                skipped += 1
                continue
            print(f"[MERGED] {label}")
        merged += 1

        # `works` is only used for tie-breaking, so an upper-bound sum is good enough here;
        # shared works would be double-counted.
        info[canon] = {**info[canon], "works": info[canon]["works"] + info[dup]["works"]}

        if display != canon:
            if not dry_run:
                # Artist.name is under a UNIQUENESS constraint, so this can only run once the
                # dup node holding that string is actually gone — never inside MERGE_QUERY.
                session.run(RENAME_QUERY, fromName=canon, toName=display).consume()
                print(f"[RENAMED] {canon!r} -> {display!r}")
            info[display] = info[canon]
            renamed += 1

        # Both original names now denote the one surviving node, whatever it ended up
        # called. Mapping `dup -> canon` instead would build a cycle whenever the survivor
        # takes the deleted node's name string (`display == dup`), which is exactly what
        # happens in the Buhot cluster.
        for old_name in (dup, canon):
            if old_name != display:
                alias[old_name] = display

    verb = "would be" if dry_run else "were"
    print(f"\n{merged} pair(s) {verb} merged, {renamed} survivor(s) {verb} renamed, {skipped} skipped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", action="store_true", help="Report candidate pairs and DINOv2 scores, no writes")
    parser.add_argument("--merge", action="store_true", help="Execute merges for pairs scoring >= --threshold")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help="DINOv2 max-similarity cutoff for --merge")
    parser.add_argument("--dry-run", action="store_true", help="With --merge, print what would happen without writing")
    parser.add_argument("--rule", action="append", default=[], metavar="RULE",
                        help=f"With --merge, restrict to one rule family (repeatable). One of {RULE_PRIORITY}.")
    parser.add_argument("--exclude-name", action="append", default=[], metavar="NAME",
                        help="With --merge, skip any pair naming this artist (repeatable).")
    parser.add_argument("--json", dest="out_json", help="With --scan, also save full results to this path")
    parser.add_argument("--rule-threshold", action="append", default=[], metavar="RULE=VALUE",
                        help="Override a per-rule DINOv2 floor, e.g. --rule-threshold token_subset=0.95. "
                             "Repeatable. Set to 0 to disable a rule's floor entirely.")
    args = parser.parse_args()

    for rule in args.rule:
        if rule not in RULE_PRIORITY:
            parser.error(f"--rule expects one of {RULE_PRIORITY}, got {rule!r}")

    for override in args.rule_threshold:
        rule, _, value = override.partition("=")
        if rule not in RULE_PRIORITY or not value:
            parser.error(f"--rule-threshold expects RULE=VALUE with RULE in {RULE_PRIORITY}, got {override!r}")
        RULE_THRESHOLDS[rule] = float(value)

    if not args.scan and not args.merge:
        parser.error("Provide --scan or --merge")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            if args.scan:
                run_scan(session, out_json=args.out_json, threshold=args.threshold)
            if args.merge:
                run_merge(session, threshold=args.threshold, dry_run=args.dry_run,
                          only_rules=set(args.rule) or None,
                          exclude_names=set(args.exclude_name) or None)
    finally:
        driver.close()
