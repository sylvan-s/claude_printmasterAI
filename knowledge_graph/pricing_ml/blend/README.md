# Price blend calibration

Plan step 8 (`docs/plans/2026-09-13-attributed-lot-valuation.md`). The committed artefact
`calibration.json` is what `src/appraisal/knowledge_graph/price_blend.ts` needs to turn the
price witnesses of one lot — catalogue estimate, same-work hammers, tier 2/3 comp medians,
the artist priors model — into one posterior over log hammer. It is produced by

    npm run backtest:comps-hammer -- --source roseberys --limit 2500 --seed 11 --resolve-work --blend --out tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl
    npm run backtest:comps-hammer -- --source forum     --limit 2500 --seed 11 --resolve-work --blend --out tests/backtest/comps_hammer/forum_n2500_blend.jsonl
    npm run backtest:blend-gate   -- --fit tests/backtest/comps_hammer/roseberys_n2500_blend.jsonl --test tests/backtest/comps_hammer/forum_n2500_blend.jsonl

and is the ONLY writer. The pipeline never writes it.

What it holds, per witness: `bias` (median of log hammer minus the witness's raw mean on the
fit lots) and `sigma` (1.4826 x MAD of the de-biased residual), keyed by regime — house for the
estimate, comp-count band (`1`, `2`, `3+`) for same-work comps, profile basis for the priors
model, `all` as the pooled fallback (a key needs 20 fit lots to stand on its own). Per regime
(`with_estimate`, `no_estimate`): the pool `weights` fitted by coordinate descent on MAE(log)
of the posterior median, and a `temperature` fitted so the 80% interval covers 80% of the fit
lots. `df` is the Student-t degrees of freedom every witness uses on the grid.

Fit on one house, score on the other. Roseberys lots can match earlier Roseberys sales of the
same print (legitimate, same-house); Forum records carry no realised prices, so a Forum lot's
witnesses all come from other houses — the honest number.

Goes stale on the same events as the priors (bulk ingest, artist merge, a new
`PricingModelRun`): re-run the three commands above and commit the new JSON.
