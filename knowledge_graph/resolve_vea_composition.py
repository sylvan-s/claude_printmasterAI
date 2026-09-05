"""
PrintMasterAI — VEA composition-observation resolver (Genre/Subject)
Version: VEA-COMPOSITION-RESOLVER-1.0

Takes VEA-1.0's `composition.subjectElements[]` / `composition.styleObservations[]`
(doc 01 §2I) and resolves them into ACKG Genre/Subject graph writes, per the design
worked through with the user: VEA emits free-worded atomic observations with evidence
and confidence, never touches AAT itself; this downstream step is what actually
applies the AAT crosswalk (aat_crosswalk.json's `stylesAndPeriods` category) — the
same "VEA never verifies, a separate step does" discipline already used for
technique/paper.

Style terms are matched against the crosswalk by exact-ish name (case-insensitive);
unmatched style terms are still recorded (as an ungrounded Genre node, aatId null),
never dropped — consistent with doc 09's UNMAPPED discipline. Subject terms currently
have NO AAT/Iconclass backing at all (flagged in conversation as a real gap — AAT's
Objects Facet doesn't cleanly cover iconographic subjects, and Getty's IA vocabulary,
which would be the correct authority, hasn't been evaluated yet) — so every Subject
node here is created ungrounded, same as the Oxen/Tower/Sun nodes already in the graph.

Usage as a library:
    from resolve_vea_composition import resolve_composition, COMPOSITION_LOAD_QUERY
    rows = resolve_composition(impression_id, vea_composition_json)
    session.run(COMPOSITION_LOAD_QUERY, rows=rows)
"""

import json

AAT_CROSSWALK_PATH = "aat_crosswalk.json"

with open(AAT_CROSSWALK_PATH) as _f:
    AAT_CROSSWALK = json.load(_f)

_STYLES = {
    k.lower(): v for k, v in AAT_CROSSWALK.get("stylesAndPeriods", {}).items()
    if not k.startswith("_")
}


def _style_aat_lookup(term):
    entry = _STYLES.get(term.strip().lower())
    return (entry or {}).get("aatId")


def resolve_composition(impression_id, composition):
    """
    impression_id: the graph id of the Impression these observations belong to
                    (must already exist — this does not create an Impression).
    composition: the `composition` object from a VEA-1.0 VisualExtractionResult,
                 specifically its subjectElements[] and styleObservations[] arrays.

    Returns a single row dict for use with COMPOSITION_LOAD_QUERY via UNWIND.
    """
    subjects = []
    for el in composition.get("subjectElements", []):
        term = (el.get("term") or "").strip()
        if not term:
            continue
        subjects.append({
            "name": term.title(),
            "count": el.get("count", 1),
            "confidence": el.get("confidence"),
            "aatId": None,  # no verified Subject/iconography authority wired in yet — see module docstring
        })

    styles = []
    for st in composition.get("styleObservations", []):
        term = (st.get("term") or "").strip()
        if not term:
            continue
        styles.append({
            "name": term,
            "confidence": st.get("confidence"),
            "aatId": _style_aat_lookup(term),
        })

    return {
        "impressionId": impression_id,
        "subjects": subjects,
        "styles": styles,
    }


COMPOSITION_LOAD_QUERY = """
UNWIND $rows AS row
MATCH (imp:Impression {id: row.impressionId})

WITH row, imp
UNWIND (CASE WHEN size(row.subjects) = 0 THEN [null] ELSE row.subjects END) AS subj
FOREACH (_ IN CASE WHEN subj IS NOT NULL THEN [1] ELSE [] END |
  MERGE (s:Subject {name: subj.name})
  MERGE (imp)-[d:DEPICTS]->(s)
  SET d.count = subj.count, d.confidence = subj.confidence
)

WITH row, imp
UNWIND (CASE WHEN size(row.styles) = 0 THEN [null] ELSE row.styles END) AS sty
FOREACH (_ IN CASE WHEN sty IS NOT NULL THEN [1] ELSE [] END |
  MERGE (g:Genre {name: sty.name})
  FOREACH (_ IN CASE WHEN sty.aatId IS NOT NULL THEN [1] ELSE [] END | SET g.aatId = sty.aatId)
  MERGE (imp)-[c:CLASSIFIED_AS]->(g)
  SET c.confidence = sty.confidence
)
"""
