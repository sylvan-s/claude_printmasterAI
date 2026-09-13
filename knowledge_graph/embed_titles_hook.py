"""
Post-ingest hook: embed titles for works a large batch ingest just created.

WHY. query_ackg_work ranks candidate ConceptualWorks by title similarity, and a work with
no `titleEmbedding` is scored by token overlap instead — which loses to any embedded rival
regardless of which title actually matches better. So a freshly ingested work is, in
practice, unfindable by title until something embeds it. On 2026-09-09 that had drifted to
56% of the graph, and the appraisal pipeline resolved Roseberys A0793 lot 148 to the wrong
Hockney work because all three rows for the right one were unembedded while two unrelated
works were.

`.github/workflows/embed-titles-daily.yml` is the real backstop — it is idempotent, and it
covers ingests run ad hoc, interrupted ingests, and manual graph edits. This hook exists
only to close the up-to-24h window between a big ingest and that cron, so the graph is not
quietly degraded for a day after a bulk load.

DELIBERATELY BEST-EFFORT. The rows are already committed to Neo4j by the time this runs;
failing the ingest because a follow-on embed could not start would be worse than the gap it
is closing. Every failure path here logs and returns. The cron still catches it.

  SKIP_TITLE_EMBED=1   skip the hook entirely (CI, tests, offline runs)
"""

import os
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKFILL_SCRIPT = "src/appraisal/knowledge_graph/backfill_title_embeddings.ts"

# Below this, leave it to the daily workflow — spinning up npm/tsx costs more than the
# handful of rows a small incremental ingest adds is worth.
LARGE_BATCH_MIN_ROWS = 500


def embed_new_titles(row_count, *, dry_run=False, min_rows=LARGE_BATCH_MIN_ROWS):
    """Run the incremental title backfill after a large batch ingest. Never raises."""
    if dry_run:
        return
    if os.environ.get("SKIP_TITLE_EMBED"):
        print("[EMBED] SKIP_TITLE_EMBED set — skipping title backfill", flush=True)
        return
    if row_count < min_rows:
        print(
            f"[EMBED] {row_count} row(s) below the {min_rows}-row large-batch threshold — "
            f"leaving to the daily workflow",
            flush=True,
        )
        return
    if shutil.which("npx") is None:
        print("[EMBED] npx not on PATH — skipping; the daily workflow will cover it", flush=True)
        return
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        print("[EMBED] no GEMINI_API_KEY / GOOGLE_API_KEY in env — skipping; "
              "the daily workflow will cover it", flush=True)
        return

    print(f"[EMBED] {row_count} row(s) ingested — backfilling title embeddings for any "
          f"work still missing one...", flush=True)
    try:
        subprocess.run(["npx", "tsx", BACKFILL_SCRIPT], cwd=REPO_ROOT, check=True)
        print("[EMBED] title backfill complete", flush=True)
    except (subprocess.CalledProcessError, OSError) as err:
        print(f"[EMBED] title backfill did not complete ({err}) — the ingested rows are "
              f"safely in the graph; the daily workflow will retry", flush=True)
