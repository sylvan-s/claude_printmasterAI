"""
PrintMasterAI — merge-review agent: check an LLM's `same` against the local ULAN mirror.
Version: MERGE-AGENT-ULAN-VERIFY-1.0

WHY. In Phase 0 the LLM labeller called `same` on pairs the evidence on the page could not
settle, drawing on its own knowledge of artists (Percy Wyndham Lewis = Wyndham Lewis). Most such
calls are right, but an LLM's world knowledge is exactly where it confabulates, and a false
`same` becomes a false merge. So a `same` that rests on world knowledge is accepted only when
ULAN itself says both names belong to one person.

HOW, and why it is not fuzzy matching. ULAN lists every recorded name form of a person (1.1M
forms for 353k people in `ulan_local.sqlite`). A record name is looked up against those forms
with two exact tests:
  token bag   the same words once accents, case, punctuation, honorifics and the catalogue
              inversion ("Lewis, Percy Wyndham") are folded away
  initials    position by position each forename equal or an initial of the other, surname
              equal: the repo's `initialism` rule ("Giovanni B. Ghisi" = "Ghisi, Giovanni Battista")
A record that carries its own ULAN id contributes that id directly. Credit wrappers are stripped
first: the engraver side of "X after Y", "X (after Y)", and lot-grouping junk ("Grouped with
line 22. ...").

VERDICT for a pair:
  verified     both names resolve to exactly one shared ULAN id, and no record date contradicts
               that person's ULAN dates by more than 2 years
  conflict     both records carry ULAN ids and they differ, or a date contradicts
  ambiguous    the names share more than one ULAN id (a common name form such as 'Mantovano')
  unverified   no shared id
Only `verified` lets a world-knowledge `same` stand.
"""
import os
import re
import sqlite3
import unicodedata
from collections import defaultdict

ULAN_DB = os.path.expanduser("~/PycharmProjects/claude_printmasterAI/knowledge_graph/ulan_local.sqlite")

HONORIFICS = {"sir", "dame", "lord", "lady", "mr", "mrs", "ms", "dr", "prof", "rev", "saint", "st",
              "ra", "rbs", "rbsa", "re", "ri", "roi", "rsa", "rsw", "rws", "prba", "hrsa", "nea",
              "rba", "cbe", "obe", "mbe", "om", "ch", "kbe", "jr", "sr", "junior", "senior",
              "the", "younger", "elder", "ii", "iii"}
AFTER = re.compile(r"\s*\(?\bafter\b.*$", re.I)
LIFE = re.compile(r"\b(\d{4})\s*-\s*(?:ca\.\s*)?(\d{4})\b")
LOT_JUNK = re.compile(r"^\s*grouped\s+(with\s+)?line\s+\d+\.?\s*", re.I)


def _fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()


def tokens(name):
    """Word tokens of a name in natural order, with 'Surname, Forenames' un-inverted."""
    s = _fold(name)
    if s.count(",") == 1:
        last, first = s.split(",")
        if first.strip():
            s = f"{first} {last}"
    toks = [t for t in re.split(r"[^0-9a-z]+", s) if t]
    kept = [t for t in toks if t not in HONORIFICS]
    return kept if len(kept) >= 1 else toks


def core_name(name):
    """The person a credit string names: engraver side of an 'after' credit, junk prefix removed."""
    return AFTER.sub("", LOT_JUNK.sub("", name or "")).strip(" .,;")


class UlanIndex:
    def __init__(self, path=ULAN_DB):
        con = sqlite3.connect(path)
        self.bag = defaultdict(set)          # sorted token tuple -> ulan ids
        self.by_surname = defaultdict(list)  # surname -> [(tokens, ulan id)]
        for uid, name in con.execute("SELECT ulan_id, name FROM ulan_name"):
            t = tokens(name)
            if not t:
                continue
            self.bag[tuple(sorted(t))].add(uid)
            if len(t) >= 2:
                self.by_surname[t[-1]].append((t, uid))
        self.person = {r[0]: r[1:] for r in con.execute(
            "SELECT ulan_id, pref_name, bio, est_start, est_end FROM ulan_person")}
        con.close()

    def ids_for(self, name, own_ulan=None):
        ids = set()
        if own_ulan:
            ids.add(own_ulan.rstrip("/").split("/")[-1])
        t = tokens(core_name(name))
        if not t:
            return ids
        ids |= self.bag.get(tuple(sorted(t)), set())
        if len(t) >= 2:                       # initials: exact per position, surname equal
            for ut, uid in self.by_surname.get(t[-1], ()):
                if len(ut) != len(t) or ut == t:
                    continue
                if all(a == b or (len(a) == 1 and b.startswith(a)) or (len(b) == 1 and a.startswith(b))
                       for a, b in zip(t[:-1], ut[:-1])):
                    ids.add(uid)
        return ids

    def verify(self, a, b):
        """a, b: record dicts with name, ulan, born, died. Returns (verdict, ulan_id, detail)."""
        ua = (a.get("ulan") or "").rstrip("/").split("/")[-1] or None
        ub = (b.get("ulan") or "").rstrip("/").split("/")[-1] or None
        if ua and ub and ua != ub:
            return "conflict", None, f"records carry different ULAN ids {ua} / {ub}"
        ia, ib = self.ids_for(a["name"], ua), self.ids_for(b["name"], ub)
        shared = ia & ib
        if not shared:
            return "unverified", None, (f"no ULAN person carries both name forms "
                                        f"({len(ia)} / {len(ib)} candidates)")
        if len(shared) > 1:
            return "ambiguous", None, f"{len(shared)} ULAN people carry both name forms"
        uid = next(iter(shared))
        pref, bio, start, end = self.person.get(uid, (None, None, None, None))
        # Life dates come from the bio ("English painter, 1810-1894"); est_start/est_end are
        # estimates, and an 'active ...' bio carries no life dates to contradict.
        m = LIFE.search(bio or "")
        if m and "active" not in (bio or "").lower():
            life = {"born": int(m.group(1)), "died": int(m.group(2))}
            for rec in (a, b):
                for field in ("born", "died"):
                    v = rec.get(field)
                    if v and abs(int(v) - life[field]) > 2:
                        return "conflict", uid, f"{rec['name']} {field} {v} vs ULAN {pref}: {bio}"
        return "verified", uid, f"ULAN {uid} {pref}: {bio}"
