## Agent skills

### Issue tracker

Issues live in GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` at root + `docs/adr/`. See `docs/agents/domain.md`.

### Appraisal pipeline architecture

3-stage / 4-stage pipeline (VEA → Triage → Specialist → Valuation), stage
responsibilities, model assignments. See `PIPELINE.md` and `CONTEXT.md`.

### Benchmark & auction-house extractors

Ground-truth data collection (`benchmark/`) for evaluating the pipeline —
Roseberys and Forum Auctions extractors, why they're separate modules, what's
committed vs gitignored, the PDF export/Puppeteer workflow, and git remotes.
See `docs/agents/benchmark.md`.
