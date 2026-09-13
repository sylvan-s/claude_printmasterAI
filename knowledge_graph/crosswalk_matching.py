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
    # Photographic-print processes — found missing 2026-09-06 while onboarding the
    # Bonhams Group adapter (bonhams_ingest.py): a systematic scan of ~3,000 sampled
    # Bonhams/Skinner single-work lots found ~17% had no recognized technique at all,
    # and "gelatin silver print" alone accounted for the large majority of that gap.
    # None of Met/Tate/Roseberys/Forum/BM (the sources this crosswalk was built against
    # so far) carried meaningful photography volume, so this vocabulary was never
    # exercised against it before. Kept before the printmaking-process entries below so
    # a compound phrase like "sepia-toned gelatin silver print" still matches on the
    # substring regardless of list order (no suppression conflict with anything below —
    # these are process names, not umbrella/specific pairs the way Lithograph/Intaglio
    # are). AAT ids intentionally left null/unverified — this project's usual discipline
    # is to confirm an id with a live vocab.getty.edu lookup before adding it (see the
    # Collotype/Monotype/etc. entries below for that pattern); not done here yet given
    # time constraints, so these are recorded as a genuine open gap in aat_crosswalk.json
    # rather than a guessed id.
    ("Gelatin silver print", ["gelatin silver"]),
    ("Platinum print", ["platinum print", "platinum-palladium", "platinum palladium"]),
    ("Chromogenic print", ["chromogenic print", "chromogenic prints", "c-print", "c print"]),
    ("Cibachrome print", ["cibachrome", "ilfochrome"]),
    ("Pigment print", ["pigment print", "pigment prints", "archival pigment"]),
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
    ("Crayon manner", ["crayon manner", "crayon-manner", "chalk manner"]),  # found missing
                                        # 2026-09-11 auditing the Navigart public-domain load — two
                                        # 18th-c Saint-Étienne intaglios ("Manière de crayon
                                        # (sanguine) sur papier vergé", one by Demarteau le Jeune)
                                        # resolved to no technique at all. A distinct roulette-based
                                        # intaglio process, not a chalk DRAWING — the whole point of
                                        # it is imitating one. AAT id verified live (300178621,
                                        # broader term "intaglio printing processes") before adding,
                                        # per this project's usual discipline. No existing record in
                                        # the graph matches these keywords, so adding it changes no
                                        # other adapter's output — checked before the edit.
    ("Photogravure", ["photogravure"]),
    ("Collotype", ["collotype"]),      # found missing 2026-09-06 investigating 4 records in a
                                        # Sir Muirhead Bone BM pull dropped by the technique gate
                                        # (doc 09 §7.13/§7.14) — all four "Collotype reproduction
                                        # of drawing" (WWI documentary work). AAT id verified live
                                        # (300053204, "collotype (process)") before adding, not
                                        # guessed — see aat_crosswalk.json. Recognizing it here
                                        # only answers "was a real printmaking process used," per
                                        # this project's own established distinction (doc 09
                                        # §7.14) — it deliberately does NOT judge whether a given
                                        # collotype print is a reproduction or an original
                                        # composition; that's a separate, content-level question.
    ("Photomechanical print", ["photomechanical print", "photomechanical prints"]),  # found missing
                                        # 2026-09-06 investigating a 14/76-record [EXCLUDED] result in
                                        # a Richard Hamilton BM test pull — see aat_crosswalk.json note.
    ("Inkjet print", ["inkjet", "ink jet", "ink-jet"]),  # found missing 2026-09-06 in the same
                                        # Hamilton pull as Photomechanical print above (7 more
                                        # excluded records) — must stay before Digital print below,
                                        # see TECHNIQUE_SUPPRESSES.
    ("Dye sublimation print", ["dye sublimation", "dye diffusion thermal transfer"]),  # same pull —
                                        # must stay before Digital print below, see TECHNIQUE_SUPPRESSES.
    ("Digital print", ["digital print", "digitally generated", "digital photographic process"]),
                                        # generic/umbrella — same pull as Inkjet/Dye sublimation
                                        # print above; unmapped at process level, see
                                        # aat_crosswalk.json note. Must stay after the two specific
                                        # entries above — see TECHNIQUE_SUPPRESSES.
    ("Giclée", ["giclee", "giclée"]),
    ("Monotype", ["monotype"]),        # found missing 2026-09-06 investigating an 11/22-record
                                        # silent [EXCLUDED] result in a Sidney Nolan BM test pull
                                        # — same has_print_technique()-style silent-exclusion
                                        # failure mode as Intaglio/Sorel below, just never
                                        # triggered before since no prior artist tested had
                                        # monotype-technique prints. AAT id verified live
                                        # (300053277, "monotype (planographic process)") before
                                        # adding, not guessed — see aat_crosswalk.json.
    ("Engraving", ["engraving"]),      # generic — must stay after Wood engraving above
    ("Lithograph", ["lithograph"]),    # generic — must stay after Offset/Photolithograph above
    ("Intaglio", ["intaglio"]),        # umbrella process term — see TECHNIQUE_SUPPRESSES;
                                        # found missing 2026-08-26 investigating why Agathe
                                        # Sorel (real Tate intaglio prints, medium literally
                                        # "Intaglio print on paper") had no Artist node —
                                        # 832 Tate rows / 107 artists were silently excluded
                                        # by has_print_technique() for this exact reason.
    ("Stencil printing", ["stencil printing"]),  # found missing 2026-09-06 investigating a
                                        # 1-record [EXCLUDED] result in a Michael Rothenstein
                                        # BM pull (10-artist priority-list batch #2) — see
                                        # aat_crosswalk.json note.
    ("Photorelief", ["photorelief", "photo relief", "photo-relief"]),  # same Rothenstein
                                        # record as Stencil printing above — see
                                        # aat_crosswalk.json note.
    ("Relief printing", ["relief"]),   # bare word, matching BM's own bare Technique value
                                        # ("relief") on two genuine cork relief-prints —
                                        # found missing 2026-09-06 investigating a Josef
                                        # Albers BM pull (10-artist priority-list batch #2)
                                        # — see aat_crosswalk.json note. Generic — must stay
                                        # after Photorelief above and suppressed by
                                        # TECHNIQUE_SUPPRESSES against it, since "photorelief"
                                        # itself contains the substring "relief".
]
TECHNIQUE_SUPPRESSES = {
    "Engraving": ["Wood engraving"],
    "Lithograph": ["Offset lithograph", "Photolithograph"],
    "Relief printing": ["Photorelief"],
    # Same reasoning as Intaglio below: a medium string naming a specific digital process
    # ("Colour Epson inkjet digital print") shouldn't ALSO get the generic "Digital print"
    # tag — only a bare "digitally generated"/"digital print" (no named process) should.
    "Digital print": ["Inkjet print", "Dye sublimation print"],
    # A medium string naming a specific intaglio method ("Etching and aquatint") shouldn't
    # ALSO get the generic "Intaglio" tag — only bare "Intaglio print on paper" (no named
    # method) should resolve to the umbrella term itself.
    "Intaglio": ["Etching", "Drypoint", "Aquatint", "Mezzotint", "Photogravure", "Engraving",
                 "Wood engraving", "Crayon manner"],
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
