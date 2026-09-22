"""
PrintMasterAI — controlled nationality vocabulary.
Version: NATIONALITY-VOCAB-1.0

WHY. Artist.nationality holds 313 distinct values across 4,850 artists (measured 2026-09-22).
Beside the real demonyms it carries whatever an ingest parser found in that slot: centuries
("20th century" x45), birth years ("b.1967", "B. 1941"), people's names ("Zhu Dequn", "Romain de
Tirtoff"), roles ("Publisher", "the Elder"), French museum terms ("française" x145, "allemande"),
country names ("France", "Iraq") and typos ("Brtitish", "Japanse"). Anything that reads the field —
the merge agent's nationality features, the labelling pages, an LLM prompt — was comparing junk.

RULE. A value maps to one or more canonical demonyms from CANONICAL, or to nothing. Every
recognised spelling is listed explicitly in ALIASES: there is no similarity matching, so a new
typo stays unrecognised until someone adds it. Parsing is structural only:
  - a parenthetical is dropped ("britannique (allemande à la naissance)" -> British)
  - ", born X" / "born X" is a birthplace, not a nationality (kept separately)
  - "/" and "-" join dual nationalities ("German/American", "Iranian-American")
  - a trailing century ("American 20th century") is dropped
A value with no recognised part is `unrecognised`, with a reason category for the report.

This module does not write to the graph. Repairing Artist.nationality is a separate, reviewed step.
"""
import re
import unicodedata

CANONICAL = [
    "American", "British", "English", "Scottish", "Welsh", "Irish", "French", "German", "Italian",
    "Spanish", "Portuguese", "Dutch", "Flemish", "Belgian", "Swiss", "Austrian", "Czech", "Slovak",
    "Polish", "Hungarian", "Romanian", "Bulgarian", "Croatian", "Serbian", "Slovenian",
    "Montenegrin", "Albanian", "Greek", "Turkish", "Russian", "Ukrainian", "Latvian", "Lithuanian",
    "Estonian", "Finnish", "Swedish", "Norwegian", "Danish", "Icelandic", "Scandinavian",
    "Canadian", "Mexican", "Cuban", "Puerto Rican", "Haitian", "Guatemalan", "Panamanian",
    "Colombian", "Venezuelan", "Brazilian", "Argentine", "Chilean", "Uruguayan", "Bolivian",
    "Peruvian", "Japanese", "Chinese", "Korean", "Taiwanese", "Indian", "Pakistani", "Iranian",
    "Iraqi", "Israeli", "Palestinian", "Lebanese", "Syrian", "Egyptian", "Moroccan", "Algerian",
    "Tunisian", "Nigerian", "Ghanaian", "Kenyan", "Malian", "Zambian", "Zimbabwean",
    "South African", "Australian", "New Zealander", "Thai", "Vietnamese", "Filipino",
    "Indonesian", "Malaysian", "Singaporean", "First Nations", "Inuit", "Navajo",
]

# Exact spellings only (compared case- and accent-folded). Each entry was seen in the graph or is
# the country / French / plural form of a canonical demonym.
ALIASES = {
    # French (Navigart / Centre Pompidou)
    "francaise": "French", "francais": "French", "italienne": "Italian", "italien": "Italian",
    "allemande": "German", "allemand": "German", "belge": "Belgian", "suisse": "Swiss",
    "japonaise": "Japanese", "japonais": "Japanese", "espagnole": "Spanish", "espagnol": "Spanish",
    "canadienne": "Canadian", "canadien": "Canadian", "russe": "Russian", "americaine": "American",
    "americain": "American", "autrichienne": "Austrian", "autrichien": "Austrian",
    "polonaise": "Polish", "polonais": "Polish", "britannique": "British", "neerlandaise": "Dutch",
    "neerlandais": "Dutch", "hongroise": "Hungarian", "hongrois": "Hungarian",
    "tcheque": "Czech", "roumaine": "Romanian", "roumain": "Romanian", "chinoise": "Chinese",
    "chinois": "Chinese", "grecque": "Greek", "grec": "Greek", "portugaise": "Portuguese",
    "portugais": "Portuguese", "argentine": "Argentine", "bresilienne": "Brazilian",
    "bresilien": "Brazilian", "mexicaine": "Mexican", "mexicain": "Mexican",
    # country names
    "france": "French", "iraq": "Iraqi", "egypt": "Egyptian", "india": "Indian", "israel": "Israeli",
    "lebanon": "Lebanese", "new zealand": "New Zealander", "england": "English",
    "scotland": "Scottish", "wales": "Welsh", "ireland": "Irish", "germany": "German",
    "italy": "Italian", "spain": "Spanish", "japan": "Japanese", "china": "Chinese",
    "mexico": "Mexican", "usa": "American", "united states": "American",
    # variants and plurals
    "argentinian": "Argentine", "argentinean": "Argentine", "south korean": "Korean",
    "americans": "American", "new zealand": "New Zealander", "czechoslovak": "Czech",
    # typos seen in the graph
    "brtitish": "British", "briitsh": "British", "japanse": "Japanese", "ukranian": "Ukrainian",
}

_FOLD = {}


def _fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    return " ".join("".join(c for c in s if not unicodedata.combining(c)).lower().split())


for _c in CANONICAL:
    _FOLD[_fold(_c)] = _c
for _k, _v in ALIASES.items():
    _FOLD[_fold(_k)] = _v

_CENTURY = re.compile(r"\b(\d{1,2}(st|nd|rd|th)\s+century|century)\b", re.I)
_YEAR = re.compile(r"(^|\b)(b\.?\s*\d{4}|\d{4}|circa|fl\.?|n\.d\.)", re.I)
_ROLE = re.compile(r"\b(publisher|publishers|printers?|the elder|the younger|after|sir|hon|"
                   r"engraver|queen|lord|master)\b", re.I)


def parse(raw):
    """-> {"nationalities": [canonical...], "birthplace": str|None, "unrecognised": bool,
           "reason": str|None, "raw": raw}"""
    out = {"nationalities": [], "birthplace": None, "unrecognised": False, "reason": None, "raw": raw}
    if not raw or not str(raw).strip():
        return out
    s = re.sub(r"\([^)]*\)", " ", str(raw))
    m = re.search(r"(?:^|,)\s*born\s+([^,\d]+)", s, re.I)
    if m:
        out["birthplace"] = m.group(1).strip()
    s = re.split(r",|\bborn\b|\bdepuis\b", s, flags=re.I)[0]
    s = _CENTURY.sub(" ", s)
    for part in re.split(r"[/]|\s-\s|(?<=[a-z])-(?=[A-Z])", s):
        key = _fold(part)
        if not key:
            continue
        if key in _FOLD:
            if _FOLD[key] not in out["nationalities"]:
                out["nationalities"].append(_FOLD[key])
    if not out["nationalities"]:
        out["unrecognised"] = True
        low = str(raw).lower()
        out["reason"] = ("century" if _CENTURY.search(low) else
                         "date" if _YEAR.search(low) else
                         "role" if _ROLE.search(low) else
                         "placeholder" if low.strip() in ("?", "i", "dates unknown") else
                         "name or other")
    return out


def canonical(raw):
    """The canonical demonyms joined with ' / ', or None when unrecognised or empty."""
    n = parse(raw)["nationalities"]
    return " / ".join(n) if n else None
