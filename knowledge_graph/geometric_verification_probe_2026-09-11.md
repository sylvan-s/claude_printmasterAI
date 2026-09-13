# Geometric verification as a work-identity confirmer — probe

**Date:** 2026-09-11
**Status:** Probed and **rejected**. No tooling adopted, no graph change.
**Script:** [`probe_geometric_verification.py`](probe_geometric_verification.py)
**Relates to:** [`find_image_similar_work_candidates.py`](find_image_similar_work_candidates.py),
[ADR-0017](../docs/adr/0017-work-title-identity-principal-name-and-aliases.md),
[ADR-0009 Amendment 1](../docs/adr/0009-graph-analytics-precomputed-confidence.md)

---

## The proposal

`find_image_similar_work_candidates.py` uses DINOv2 for **retrieval** and refuses to promote on
similarity alone. Its own measurement is why: true pairs top out at 0.973 while different-work
pairs reach 0.985, so no threshold separates the classes. Promotion therefore requires an exact
**metadata** corroborator — a shared catalogue base number, a T1/T2 title match, or year plus
technique — which leaves three populations unreachable, the largest being **634 auction Picasso
works citing no catalogue at all**.

The standing proposal (from a 2026-08-31 session, captured in memory as
`two_stage_image_similarity`) was to supply the missing half of a classic instance-retrieval
architecture: coarse global descriptor to retrieve, then **local features plus a RANSAC
homography to confirm**, scoring on inlier count. Its appeal was precise — an inlier count is
not a fuzzy similarity. It asserts that one matrix produced both images, so it could stand as
an independent corroborator without touching `catalogue_matching.py`'s prohibition.

That proposal was written for **phone-to-catalogue** matching (a noisy query photo against clean
scans). This probe tests it on the **catalogue-to-catalogue** dedup problem, which is a different
and, on the face of it, easier case.

## Method

1,040 pairs in five classes, SIFT at 1024px, Lowe ratio 0.75, `findHomography` with RANSAC at
5px, scored on inlier count and on inliers/good-matches. DINOv2 cosine computed in numpy on the
same pairs — **raw cosine, not Neo4j's `(1+cos)/2`**.

| class | n | what it is |
|---|---:|---|
| `P_cross_source` | 124 | same work, institutional image vs auction image — the dedup case |
| `P_same_source` | 60 | same work, two images from one source — matcher sanity floor |
| `N_state` | 12 | **same matrix, different work** — the class that decides the question |
| `N_same_cat` | 150 | adjacent base numbers under one prefix — different plates of one portfolio |
| `N_random` | 80 | no shared citation — the floor |
| `N_same_entry` | 614 | `--hard`: distinct works citing the *same* base number. **Contaminated** with unmerged true duplicates (dino reaches 1.000), so read as a disagreement map, never as labels |

## Result — rejected, for two independent reasons

### 1. It loses to the embedding it was meant to confirm

| score | AUC, same work vs different work |
|---|---:|
| **DINOv2 raw cosine** | **0.977** |
| SIFT inlier ratio | 0.885 |
| SIFT inlier count | 0.843 |

The premise — that a lone embedding stays in a mushy band and geometry sharpens it — is false on
this corpus. DINOv2 is already the stronger discriminator.

### 2. It is at chance on states

| score | AUC, same work vs **state of that work** |
|---|---:|
| DINOv2 raw cosine | 0.575 |
| SIFT inlier count | **0.498** — chance |

No operating point fixes this, because it is not a tuning failure: **a state *is* the same
matrix**, so the thing geometry measures is exactly the thing that cannot discriminate here.

```
Notepad Doodle 3 (State I)  vs  (State III)        1,030 inliers, ratio 0.91
Suckers, state I            vs  state II             446 inliers, ratio 0.97
In Horne's house - state II vs  state V              214 inliers, ratio 0.81
```

At `inliers >= 50 AND ratio >= 0.95` — strict enough to cost 65% of true pairs — 8% of state
pairs still fire.

## The confound the original design missed

The 2026-08-31 design argued that frame, matting and wall "just become outliers that RANSAC
rejects." That holds for a **photographic** frame. It is false when **the frame is part of the
print**. Picasso's 1962-63 linocut portraits are printed inside one shared painted trompe-l'œil
border block covering roughly 60% of the sheet:

| pair | SIFT | DINOv2 |
|---|---|---|
| *La Dame à la Collerette* (Bloch 1147) vs *L'Homme à la Fraise* (Bloch 1148) | **590 inliers, ratio 0.76** | **0.523** — correctly low |
| *Exposition Vallauris* vs *Exposition 55 Vallauris* (Bloch 1267/1268) | 620 inliers, ratio 0.81 | 0.634 |
| *Scène Familiale* vs *La Dame à la Collerette* (Bloch 1146/1147) | 397 inliers, ratio 0.83 | 0.533 |

Three of the four hardest false positives are this one family. Geometry fails precisely where the
embedding succeeds, so it is not useful even as a second opinion.

## What it is genuinely good at

Recorded so the rejection is not overstated. Once both images show the same image region the
inlier ratio goes near-binary. The *L'Écuyère* family — one work spelled six ways across sources
— returns **2,400+ inliers at ratio 0.99** while cosine sits at 0.81-0.89, inside the overlap
band. That is *confidence on a pair already retrieved*, not discrimination between pairs, and it
does not justify the dependency.

## Corrected while running

Keypoint starvation on sparse line etchings was predicted **before** the run and is not the
problem: only **4%** of images yield under 100 SIFT keypoints, and the missed positives had a
median of 174. The misses are crop and scale differences, not texture poverty. Recorded rather
than quietly dropped, because the prediction was stated as a reason to expect failure and it was
the wrong reason.

## Consequence for the dedup plan

No image-only signal separates a state from its own work. **ADR-0017 Decision 1** — decompose
`plateDesignation` and `state` out of the title — is therefore not a prerequisite that would make
geometry safe. It is the answer, and no image model substitutes for it.

Third image-side approach to fail this way, after the 2026-09-10 DINOv2 threshold sweep
(44% recall at >= 0.98) and the GDS feature-Jaccard attempt recorded in ADR-0009 Amendment 1.
