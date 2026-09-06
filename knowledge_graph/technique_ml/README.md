# Printmaking-technique classifier

Predicts which printing process(es) produced an image, from the DINOv2-Large
embeddings already stored on `DigitalImage` nodes in the ACKG. Multi-label — 13% of
labelled impressions carry more than one technique (etching + aquatint being the
canonical pair), so this is one sigmoid per technique with its own tuned threshold,
never a softmax over mutually-exclusive classes.

Read [`artifacts/EVALUATION.md`](artifacts/EVALUATION.md) before using it. The short
version: six of twenty-one techniques are usable on artists the model has never seen,
and the headline number is less than half what a conventionally-evaluated version of
the same model would have claimed.

## Why the evaluation protocol is most of the work

The corpus offers two shortcuts that a standard train/test split rewards:

**Learn the artist, not the technique.** 34 artists own 31% of the labelled images
(Picasso alone has 1,187 of 44,927), and most printmakers work in one or two
processes. "Recognise the Picasso, answer lithograph" scores well on a random split
and is worthless on a new artist. Countered by making the *artist* the split group —
no artist appears in both train and test — capping training images per (artist,
technique) so no single hand dominates the gradient, and reporting an
**artist-balanced macro-F1** in which every held-out artist gets one equal vote
regardless of how prolific they are.

The size of that shortcut is measured, not assumed: `--compare-random-split` trains
the identical head on a conventional image-level split. It scores 0.579 macro-F1
against 0.275 on held-out artists. That +0.30 gap *is* the artist-memorisation
effect, and it is the number this model would have reported if evaluated the usual
way.

**Learn the photographer, not the print.** Every image comes from Bonhams, Tate or
the British Museum, each with its own studio conventions, and five surviving labels
appear from a single institution only. A probe trained on the same features predicts
the source institution with 0.907 accuracy (0.734 majority baseline), so those
classes are partly scored on lighting rather than process. This is reported and the
affected classes are flagged in the per-technique table rather than reweighted away —
the confound is real and worth seeing.

Splitting by artist turns out to do nearly all the de-biasing work on its own:
disabling both the cap and the artist sample weights moves artist-balanced macro-F1
only from 0.298 to 0.288. They are kept because they are free, but the grouped split
is the load-bearing part.

## Files

- `export_dataset.py` — pulls every embedded + technique-labelled `DigitalImage` out
  of Neo4j with its artist, work and institution keys, into `data/dataset.npz`
  (44,927 x 1024 float32, ~170 MB, ~3 min over the Oracle instance).
- `dataset.py` — label binarisation, the group-stratified splitter, per-artist
  capping and the sample/eval weighting. The de-biasing lives here.
- `train_technique_classifier.py` — trains the head, tunes per-class thresholds on
  validation, and writes `artifacts/technique_classifier.pt`, `evaluation.json` and
  `EVALUATION.md`.
- `predict_technique.py` — inference for a new image, an image URL, or an
  `elementId` already embedded in the graph.

## Running it

```
set -a; source .env; set +a
knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/export_dataset.py
knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/train_technique_classifier.py --compare-random-split
```

Training is ~50s on CPU; there is no GPU path because the embeddings are frozen and
the head is tiny. Needs the same `venv-embeddings` as the rest of the embedding
toolkit, plus `scikit-learn`.

Inference:

```
knowledge_graph/venv-embeddings/bin/python knowledge_graph/technique_ml/predict_technique.py --image print.jpg
```

`--image` loads DINOv2-Large locally (~10s cold start). A pipeline stage should pass
`--embedding-service http://127.0.0.1:8008` instead, to reuse the Stage 1d
microservice rather than loading a second copy of the encoder.

## Reading the output

The model emits a probability per technique plus a decision at that technique's own
tuned threshold. Treat "nothing above threshold" as *unrecognised process*, not as a
vote for the highest-scoring class — precision on the tail classes is poor enough
that forcing a top-1 answer would be actively misleading. Only the six techniques
listed in the evaluation's "What is actually usable" section should feed a downstream
decision.

## Known limitations

**The tail does not work.** Aquatint (F1 0.20), drypoint (0.11), collage, monotype,
embossing, letterpress and photogravure are all at or near no-signal on unseen
artists. What works is the processes with a distinctive *overall* look — the flat
opaque colour fields of a screenprint, the tonal range of a gelatin silver print, the
line character of an engraving.

**That pattern points at resolution, and the pointer is measurable.** The failing
classes are the ones whose evidence is fine surface grain: aquatint's resin tone,
drypoint's burr. The embeddings are whole-image DINOv2 at 224px, which is exactly
where that grain is destroyed. The "Can it see plate texture?" probe in the
evaluation tests this directly — restricted to images already labelled etching, so
the easy negatives are gone, the model still ranks aquatint at 1.79x chance and
drypoint at 1.55x. Weak, but not zero: the grain information survives downsampling in
trace amounts, which suggests re-embedding at native resolution (tiled crops, pooled
per image) would pay off rather than being hopeless. That is the highest-value next
experiment, and it is a change to the *embedding* pass, not to this head — a bigger
classifier on these features will not recover what the resize threw away
(`--hidden 1024` scores slightly worse than the 512 default).

**`Offset lithograph` is a labelling problem, not a modelling one** (F1 0.01). It is
Bonhams-only, overlaps `Lithograph` semantically, and only 11 test artists carry it.
It should probably be merged into `Lithograph` or dropped from the label space.

**Eleven techniques never enter the label space at all** — everything under the
150-image floor, listed at the foot of the evaluation. `Chine-collé` (21) and
`Photorelief` (5) cannot be learned or fairly scored from this corpus at present.

**Labels are attributed, not verified.** They come from auction-house and museum
catalogue text, which is where the ACKG's existing cataloguing-accuracy caveats
apply. The model can only be as right as the cataloguer was.
