"""
One-off follow-up to analyze_printmaker_filter_impact.py: for the 101 artists with zero
printmaker-tagged ULAN candidate, check whether Wikidata's own artist-occupation-filtered
search (_search_wikidata, already in resolve_artist_identity.py — P31=human AND P106 in
the artist-occupation set) finds anything for them. Live Wikidata calls, but only 101 —
a one-time batch, not the per-run bulk pattern this project moved away from.
"""
import json
import time

from resolve_artist_identity import strip_honorifics, _search_wikidata, _name_match_score

names = json.load(open("no_printmaker_candidate_names.json"))
print(f"{len(names)} names to check\n")

results = []
for i, name in enumerate(names, 1):
    stripped = strip_honorifics(name)
    try:
        wd = _search_wikidata(stripped)
    except Exception as e:
        wd = []
        print(f"  [{i}/{len(names)}] {name!r}: ERROR {e}")
    for w in wd:
        w["matchScore"] = _name_match_score(stripped, w["label"])
    wd.sort(key=lambda w: w["matchScore"], reverse=True)

    best = wd[0]["matchScore"] if wd else 0.0
    runner = wd[1]["matchScore"] if len(wd) > 1 else 0.0
    if not wd:
        cls = "no_candidates"
    elif best >= 0.92 and best - runner >= 0.15:
        cls = "auto"
    elif best >= 0.85 and best - runner >= 0.10:
        cls = "strong"
    elif best >= 0.60:
        cls = "multiple"
    else:
        cls = "no_candidates"

    has_ulan_via_wd = bool(wd and wd[0].get("ulanIdFromWikidata"))
    results.append({
        "name": name, "class": cls, "candidate_count": len(wd),
        "top_label": wd[0]["label"] if wd else None,
        "top_score": best,
        "ulan_via_wikidata": wd[0].get("ulanIdFromWikidata") if wd else None,
    })
    print(f"  [{i}/{len(names)}] {name!r}: {cls}"
          + (f" -> {wd[0]['label']!r} ({best})" if wd else ""))
    time.sleep(0.3)

from collections import Counter
c = Counter(r["class"] for r in results)
print("\n=== Wikidata-side classification for the 101 ===")
for k, v in c.most_common():
    print(f"  {k:15s} {v:5d}")

pulled_in = sum(1 for r in results if r["class"] in ("auto", "strong"))
print(f"\nConfidently pulled in by Wikidata (auto/strong): {pulled_in} of {len(names)}")
still_nothing = sum(1 for r in results if r["class"] == "no_candidates")
print(f"Still nothing on either side (ULAN printmaker AND Wikidata): {still_nothing} of {len(names)}")

json.dump(results, open("wikidata_coverage_for_no_printmaker.json", "w"), indent=1)
print("\nFull results -> wikidata_coverage_for_no_printmaker.json")
