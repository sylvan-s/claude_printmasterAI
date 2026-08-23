# ADR-0005: Institutional search tool — findings and production readiness

**Date:** 2026-08-22
**Status:** R&D complete on this branch — **not recommended to merge** until the "Before shipping" items below are addressed.
**Branch:** `institutional_search` (created from `new_prompting_strategy` @ `ccd6fab`)

---

## What this branch contains

A structured, text-only lookup tool (`src/appraisal/reference_lookup/`) that queries the Met, Rijksmuseum, and the UK Museum Data Service by artist name, wired into Stage 2b (Specialist Attribution) as a Claude tool call alongside the existing native web search. Built and tested across the session that produced commits `f324811`..`ccd6fab`:

- `met.ts`, `rijksmuseum.ts`, `mds.ts`, `relevance.ts`, `types.ts`, `index.ts`, `cli.ts` — the lookup module itself.
- `appraiser.ts` — `lookup_museum_collections` tool added to `callClaudeWithWebSearch`; the single-round "answer once then force-finalize" pattern was rewritten into a proper bounded loop (`MAX_ROUNDS = 4`) after it was found to break outright when a client tool call and a pending server-side web search landed in the same turn.
- `prompts.ts` — `ATTRIBUTION_RESEARCH_SYSTEM_PROMPT` updated to describe the tool and its real limitations.
- Also on this branch (earlier in the same session, prerequisite work): a real bug fix to the Roseberys own-catalogue image scraper (`benchmark/src/roseberys/`) and ADR-0002, which sets the licensing boundary this tool operates inside — text/metadata only, no image fetching, because museum image licenses (CC-BY-NC-ND/SA) don't cover commercial use and don't apply to bare facts the way they apply to pixels.

## Empirical findings — real before/after comparisons

Not simulated: both used the actual stored `stage1Result`/`stage2aResult` from completed production appraisals in the Supabase database, re-run live through the real `runStage2bSpecialist` code path.

**Agathe Sorel, "Après la Moisson"** — confidence dropped 0.70 → 0.62. The tool surfaced two independent Government Art Collection records for this exact title, both consistently showing edition 46/50, directly contradicting the "16/50" figure the old web-search-only run had stated as settled fact. The new run correctly demoted this to an explicit open question instead of picking one number. **This is the tool working as intended** — more caution, better sourcing, not a false improvement.

**Elizabeth/Elisabeth Frink, three items** — confidence moved flat-to-down in all three (0.32→0.33, 0.62→0.58, 0.52→0.32). Diagnosed why, not just observed: Claude queried the tool with **two different spellings of the artist's own name across the three items** ("Elizabeth" for one, "Elisabeth" — the actual dominant form in this dataset, 460 records vs. 12 — for another), entirely by its own unprompted choice, and neither run's result set (capped at 12 records per source) happened to contain the institution's actual holdings for the specific titles in question (Dorset Museum holds the real "Canterbury Tales II" series and multiple "Dog"-titled works, confirmed by direct query, but not within the first 12 records returned for either spelling).

**Net read:** four real test cases is nowhere near enough to call this validated. One clearly worked as designed; three showed the tool having negligible-to-no effect because of two specific, now well-understood gaps (below) — not because structured museum data is inherently unhelpful for those artists.

---

## Before shipping to production

These are concrete, not general caution — each is something this session's testing directly exposed.

1. **Name-variant handling is incomplete.** Honorifics/post-nominals are stripped (`cleanArtistQuery`). Spelling variants (Elizabeth/Elisabeth) and nicknames (Liz/Elizabeth) are not — and the Frink case shows this isn't an edge case, it's the difference between 12 and 460 real records for one specific well-known artist. Needs either a small variant-expansion step (query multiple forms, merge results) or explicit prompt instruction to try alternates when the first query returns sparse results.

2. **The 12-records-per-source cap can hide exactly the record that matters.** Reasonable as a context-budget guard for typical cases; wrong for prolific/well-documented artists (460 raw MDS records for Frink). Needs either a materially higher cap with smarter truncation (e.g. keep records whose title fuzzy-matches a hint from VEA/triage), or — better — give the tool a second parameter (title/keyword) so Claude can narrow *within* an artist's holdings once it knows there's a large result set, rather than being stuck with an arbitrary first-12 slice.

3. **Claude's choice of query form is non-deterministic and unaudited by default.** Nothing currently surfaces *which* spelling/form was actually queried unless you go digging in the tool_result content, as this ADR's authors had to. Worth logging the actual query string issued, per call, so this is visible without re-running things by hand.

4. **Scope is Claude-only.** Gemini's search path (`callGemini`) doesn't have this tool — it's a shared helper used by other stages, and Google's function-calling API needs its own loop, not attempted here.

5. **No British Museum or Tate coverage**, and this is deliberate, not an oversight to just go fix: BM's `/api/_search` is Cloudflare-gated against scripted access (a real, working manual browser-relay pattern exists — see ADR-0002 — but it isn't a live tool call), and Tate's images/data carry CC-BY-NC-ND terms that block commercial embedding without a separate license. Both institutions hold real, relevant contemporary-market coverage per earlier testing; neither is reachable from inside an automated pipeline right now without either a licensing conversation or a materially different (slower, human-gated) integration.

6. **Rijksmuseum's keyless API is a very recent discovery** (this session) — it replaced a key-gated system that existed for years. No track record yet on its stability, rate limits, or whether it stays keyless. Worth a periodic smoke check, not just a one-time "it works."

7. **Cost/latency not benchmarked.** The tool-use loop can now run up to 4 rounds; each round is a full Claude request, and each `lookup_museum_collections` call fans out to up to 3 external APIs with their own latency (and the Met one is throttling-sensitive — it happened mid-session here). No measurement yet of what this adds per appraisal at volume, and Met specifically has no documented rate limit to design against, only observed behavior.

8. **A separate, systemic finding surfaced by this testing, unrelated to the museum tool itself:** the Triage stage's `routingDecision.specialistConfig` field named a config file that doesn't exist in the codebase in **4 out of 4** real appraisals checked (`school_of_paris_modern`, `british_modernist`, `british_modernist_with_escalation`, `frink_prints_british_modernist` — only `ukiyo_e_edo_general`, `rembrandt_etchings`, and `general_print_fallback` actually exist). `loadSpecialistConfig` silently falls back every time. This means the tiered-specialist-routing design as currently shipped is not actually functioning — every appraisal checked ran on the generic fallback regardless of how specific the routing decision sounded. Worth its own investigation; flagged here because it was found in the course of validating this branch's work and materially affects how much weight to put on any single appraisal's stated specialist config.

9. **Text/metadata-only scope needs to stay a deliberate constraint, not quietly erode.** If this tool is ever extended to pull images (e.g. to compare against DINOv2-style embeddings — see ADR-0002), the licensing analysis changes completely and needs redoing before that happens, not after.
