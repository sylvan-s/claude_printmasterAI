"""
PrintMasterAI — dataset assembly, artist-grouped splitting and artist de-biasing.
Version: TECHML-DATA-1.0

Everything in this module exists to stop the classifier from taking the two shortcuts
this corpus makes available:

  1. Learn the artist, not the technique. 34 artists own 31% of the labelled images
     (Picasso alone has 1,187) and most artists work in one or two processes, so
     "recognise the Picasso, answer lithograph" scores well on a random split and is
     worthless on a new artist. Countered three ways: artists are the split *group*
     (no artist is ever in both train and test), training images are capped per
     (artist, technique) so no one hand dominates the gradient, and the headline
     metric weights each held-out artist equally.

  2. Learn the photographer, not the print. Every image comes from Bonhams, Tate or
     the British Museum, each with its own studio conventions, and nine labels are
     100% single-institution. Countered by reporting per-institution scores and a
     source-leakage probe rather than by reweighting — the confound is real and worth
     seeing, not worth hiding.

Split sizes default to 70/15/15 by *artist*, not by image, so the realised image
counts drift a little from those ratios. That is expected and is reported.
"""

import numpy as np

DEFAULT_MIN_CLASS_COUNT = 150
DEFAULT_PER_ARTIST_CAP = 40


def load_dataset(path):
    """Read the .npz written by export_dataset.py into a plain dict of arrays."""
    raw = np.load(path, allow_pickle=True)
    return {
        "X": raw["X"].astype(np.float32),
        "image_id": raw["image_id"],
        "artist_id": raw["artist_id"],
        "artist_name": raw["artist_name"],
        "work_id": raw["work_id"],
        "institution": raw["institution"],
        "technique_sets": [s.split("|") if s else [] for s in raw["techniques"]],
    }


def build_label_matrix(technique_sets, min_count=DEFAULT_MIN_CLASS_COUNT):
    """Binarise the technique sets, keeping only labels with enough support.

    Classes below `min_count` can't be split three ways and still leave a testable
    number of held-out *artists*, so they're dropped from the label space rather than
    scored on a handful of examples. An image whose only technique was dropped is
    removed from the dataset entirely (returned mask), because keeping it as an
    all-zero row would teach the model that a genuine mezzotint is "none of the above".
    """
    counts = {}
    for techs in technique_sets:
        for t in techs:
            counts[t] = counts.get(t, 0) + 1
    labels = sorted([t for t, c in counts.items() if c >= min_count])
    index = {t: i for i, t in enumerate(labels)}

    Y = np.zeros((len(technique_sets), len(labels)), dtype=np.float32)
    for row, techs in enumerate(technique_sets):
        for t in techs:
            if t in index:
                Y[row, index[t]] = 1.0
    keep = Y.sum(axis=1) > 0
    dropped_labels = sorted(
        [(t, c) for t, c in counts.items() if c < min_count], key=lambda kv: -kv[1]
    )
    return Y, labels, keep, dropped_labels


def group_stratified_split(Y, groups, ratios=(0.70, 0.15, 0.15), seed=13):
    """Split by group (artist) while keeping every label present in all three folds.

    Plain random group assignment reliably strands a rare label — with ~50 artists
    holding all the mezzotints, a coin flip can put every one of them in train. This
    is greedy iterative stratification over groups: artists carrying the scarcest
    label are placed first, each into whichever fold is furthest below its target for
    that label. Returns an array of 0/1/2 (train/val/test) per row.
    """
    rng = np.random.default_rng(seed)
    unique_groups, inverse = np.unique(groups, return_inverse=True)
    n_groups, n_labels = len(unique_groups), Y.shape[1]

    group_label_counts = np.zeros((n_groups, n_labels), dtype=np.int64)
    group_sizes = np.zeros(n_groups, dtype=np.int64)
    for row, g in enumerate(inverse):
        group_label_counts[g] += Y[row].astype(np.int64)
        group_sizes[g] += 1

    ratios = np.asarray(ratios, dtype=np.float64)
    targets = np.outer(ratios, Y.sum(axis=0))          # per fold, per label
    size_targets = ratios * len(Y)
    achieved = np.zeros_like(targets)
    achieved_sizes = np.zeros(len(ratios), dtype=np.float64)

    label_totals = Y.sum(axis=0)
    # Scarcest label an artist carries decides their priority; ties broken by how many
    # images they bring (biggest first, so the hard-to-place bulk lands early) and then
    # randomly, so the split isn't an artefact of alphabetical artist order.
    jitter = rng.random(n_groups)
    priority = []
    for g in range(n_groups):
        present = np.nonzero(group_label_counts[g])[0]
        rarest = label_totals[present].min() if len(present) else np.inf
        priority.append((rarest, -group_sizes[g], jitter[g], g))
    priority.sort()

    group_fold = np.zeros(n_groups, dtype=np.int64)
    for rarest, _, _, g in priority:
        present = np.nonzero(group_label_counts[g])[0]
        deficits = targets - achieved
        if len(present):
            # Prefer the fold most short of this artist's rarest label; fall back to
            # overall size deficit when that is already balanced.
            rarest_label = present[np.argmin(label_totals[present])]
            score = deficits[:, rarest_label]
            if np.ptp(score) < 1e-9:
                score = deficits[:, present].sum(axis=1)
        else:
            score = np.zeros(len(ratios))
        if np.ptp(score) < 1e-9:
            score = size_targets - achieved_sizes
        fold = int(np.argmax(score))
        group_fold[g] = fold
        achieved[fold] += group_label_counts[g]
        achieved_sizes[fold] += group_sizes[g]

    return group_fold[inverse]


def cap_per_artist(Y, groups, fold_ids, cap=DEFAULT_PER_ARTIST_CAP, seed=13):
    """Downsample the training fold so no artist floods any one technique.

    The cap is per (artist, technique-set), not per artist: Picasso keeps up to `cap`
    lithographs *and* up to `cap` etchings, so capping trims his volume without
    flattening the range of processes he actually worked in. Only the training fold is
    touched — val and test keep every image, since the artist-balanced metric handles
    prolificacy there and throwing away test data would only add noise.
    """
    rng = np.random.default_rng(seed)
    keep = np.ones(len(Y), dtype=bool)
    buckets = {}
    for row in np.nonzero(fold_ids == 0)[0]:
        key = (groups[row], Y[row].tobytes())
        buckets.setdefault(key, []).append(row)
    for rows in buckets.values():
        if len(rows) > cap:
            drop = rng.permutation(rows)[cap:]
            keep[drop] = False
    return keep


def artist_sample_weights(groups, alpha=0.5):
    """Per-image training weight ~ 1/n_artist^alpha.

    A second, softer pass at the same bias as the cap, for the imbalance that survives
    it. alpha=0 is off, alpha=1 gives every artist exactly equal total weight (which
    over-corrects — a single-image artist then counts as much as one with 40, and the
    rare-artist noise dominates), so the default square root sits between the two.
    """
    unique, inverse, counts = np.unique(groups, return_inverse=True, return_counts=True)
    w = 1.0 / np.power(counts[inverse].astype(np.float64), alpha)
    return (w / w.mean()).astype(np.float32)


def artist_eval_weights(groups):
    """Per-image evaluation weight giving every held-out artist one equal vote."""
    unique, inverse, counts = np.unique(groups, return_inverse=True, return_counts=True)
    w = 1.0 / counts[inverse].astype(np.float64)
    return (w / w.mean()).astype(np.float32)
