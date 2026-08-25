"""
PrintMasterAI — shared AAT crosswalk matching for Technique/Paper extraction
Version: CROSSWALK-MATCHING-1.0

Extracted out of met_ingest.py so a second source adapter (roseberys_ingest.py) doesn't
duplicate this vocabulary and risk drifting from it — exactly the "two divergent lists"
problem doc 09 was written to prevent, this time caught before it happened rather than
after. met_ingest.py imports from here now instead of defining its own copy.
"""

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
AAT_CROSSWALK_PATH = os.path.join(_HERE, "aat_crosswalk.json")

with open(AAT_CROSSWALK_PATH) as _f:
    AAT_CROSSWALK = json.load(_f)

# doc 09 §4: HEURISTIC_EXTRACTION vocabulary for free-text Medium/technique fields.
# Priority order matters — checked BEFORE any shorter/more generic name it could be
# confused with (e.g. "wood engraving" before "engraving", "offset lithograph" before
# "lithograph"). TECHNIQUE_SUPPRESSES then drops the generic match once a more specific
# one has already fired, since a plain substring scan would otherwise tag both.
TECHNIQUE_KEYWORDS = [
    ("Chine-collé", ["chine-collé", "chine colle", "chine-colle"]),
    ("Wood engraving", ["wood engraving"]),
    ("Offset lithograph", ["offset lithograph"]),
    ("Photolithograph", ["photolithograph"]),
    ("Screenprint / Serigraphy", ["screenprint", "screen print", "serigraphy", "silk screen", "silk-screen"]),
    ("Collage", ["collage"]),
    ("Letterpress", ["letterpress"]),
    ("Embossing", ["embossing"]),
    ("Linocut", ["linocut", "linoleum block"]),
    ("Woodcut", ["woodcut"]),
    ("Etching", ["etching"]),
    ("Drypoint", ["drypoint"]),
    ("Aquatint", ["aquatint"]),
    ("Mezzotint", ["mezzotint"]),
    ("Photogravure", ["photogravure"]),
    ("Giclée", ["giclee", "giclée"]),
    ("Engraving", ["engraving"]),      # generic — must stay after Wood engraving above
    ("Lithograph", ["lithograph"]),    # generic — must stay after Offset/Photolithograph above
]
TECHNIQUE_SUPPRESSES = {
    "Engraving": ["Wood engraving"],
    "Lithograph": ["Offset lithograph", "Photolithograph"],
}

# Aligned to doc 01's paperSurfaceType enum (wove, laid, japanese, BFK, vellum, card,
# fabric, other). chine-collé moved OUT of this list and into TECHNIQUE_KEYWORDS above
# — AAT files it as a process ("strengthening, stabilizing"), not a paper-type material,
# and this crosswalk follows that rather than doc 01's original placement.
PAPER_KEYWORDS = [
    ("wove", ["wove"]),
    ("laid", ["laid"]),
    ("japanese", ["japan paper", "japanese paper", "japon"]),
    ("BFK", ["bfk"]),
    ("vellum", ["vellum"]),
    ("card", ["card"]),
    ("fabric", ["fabric"]),
]


def _aat_lookup(category, name):
    entry = AAT_CROSSWALK.get(category, {}).get(name)
    return (entry or {}).get("aatId")


def extract_techniques(text):
    text_l = (text or "").lower()
    matched = {name for name, keywords in TECHNIQUE_KEYWORDS if any(kw in text_l for kw in keywords)}
    for generic, specifics in TECHNIQUE_SUPPRESSES.items():
        if generic in matched and matched & set(specifics):
            matched.discard(generic)
    results = [{"name": name, "aatId": _aat_lookup("printingTechniques", name)} for name in matched]
    return sorted(results, key=lambda x: x["name"])


def extract_papers(text):
    text_l = (text or "").lower()
    matched = {name for name, keywords in PAPER_KEYWORDS if any(kw in text_l for kw in keywords)}
    results = [{"name": name, "aatId": _aat_lookup("paperSurfaceType", name)} for name in matched]
    return sorted(results, key=lambda x: x["name"])
