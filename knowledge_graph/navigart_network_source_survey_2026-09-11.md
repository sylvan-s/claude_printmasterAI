# The Navigart network as an ACKG source — survey

**Date:** 2026-09-11
**Status:** Survey. No adapter built, no data loaded.
**Relates to:** [`picasso_museum_source_survey_2026-09-11.md`](picasso_museum_source_survey_2026-09-11.md),
[ADR-0002 + Amendment 1](../docs/adr/0002-image-extraction-methodology-and-licensing.md),
[ADR-0017](../docs/adr/0017-work-title-identity-principal-name-and-aliases.md)

---

## Summary

`api.navigart.fr` is already in this project — `picasso_paris_fetch.py` pulls vault `16`
(Musée national Picasso-Paris). What that adapter did not record is that vault 16 is one of
**37 open, unauthenticated vaults on the same API**, holding **448,131 works** between them,
of which **33,807 are catalogued as `Estampe`** (plus ~1,780 more in three vaults that expose
no facets at all). 2,223 of those are the Picasso records already loaded; **~33,400 are new.**

Three findings decide whether this is worth building:

1. **The public-domain tier is real and large.** Across the eleven print collections profiled
   at full population (29,393 records, every record fetched, not sampled), **9,196 carry
   `copyright: "Domaine public"` and 5,523 of those also carry an image**, downloadable at
   1000px with no authentication. ADR-0002 §2 concluded that museum open access could only
   ever supply "the same ~4% pre-1955 tail"; measured against Met/Rijksmuseum that was right,
   but 5,523 free print images is roughly half the size of the entire Tate set already
   embedded (10,208) and carries **no NC condition** — a materially better licence position
   than anything currently in the index.
2. **The catalogue-raisonné field does not travel.** `number_catalogue` is 97% populated at
   Picasso-Paris and **0% everywhere else** (verified across full populations, not samples;
   the sole exception is Nantes at 1.8%, 73 records). The single most valuable thing the
   Picasso adapter brought back — the `CatalogueEntry` bridge ADR-0017 wanted — is
   publication-specific configuration, not a Navigart feature. **Do not assume it transfers.**
3. **The rest of the adapter does transfer.** The existing `_FR_TECHNIQUES` crosswalk resolves
   **82% of 29,393 print records' `mst` strings with no changes at all**, and the misses are a
   short repetitive tail (§6). Videomuseum runs one controlled vocabulary across all members.

**Recommendation: build a generalised fetcher, ingest the public-domain-plus-image tier first
(~5,500 records), and treat the in-copyright remainder as a second, separate decision.** The PD
tier needs none of ADR-0002 Amendment 1's reasoning — it is public domain, the museums assert
no TDM reservation (§8), and it is the only source found so far that adds *freely usable print
images* rather than metadata.

---

## 1. The network, measured

All figures from live calls on 2026-09-11. `Estampe` is the Videomuseum domain term for an
original print; the wider "print-ish" column adds `Design graphique` / `Affiche` /
`Reproduction photomécanique`, which are mostly **offset reproductions, not original
printmaking** — see §7.

| Vault | Institution (slug) | Works | `Estampe` | print-ish |
|---:|---|---:|---:|---:|
| 14 | **Cnap** (`collection.cnap.fr`) | 92,366 | **9,472** | 10,883 |
| 25 | **MAMC Strasbourg** (`mamcs`) | 18,499 | **4,140** | 5,543 |
| 11 | **Musée d'arts de Nantes** (`museedartsdenantes`) | 14,148 | **4,110** | 4,110 |
| 15 | **Centre Pompidou MNAM** (`collection.centrepompidou.fr`) | 128,810 | **3,871** | 7,655 |
| 16 | Musée national Picasso-Paris (`picassoparis`) | 23,638 | 2,223 | 2,256 | *(loaded)* |
| 24 | **MAMC+ Saint-Étienne** (`MAMC-saint-etienne-collections`) | 16,544 | **2,149** | 3,050 |
| 18 | **MAM Paris** (`mamparis`) | 16,163 | **2,073** | 2,160 |
| 26 | Musée Tomi Ungerer (`ungerer`) | 14,712 | 892 | 2,154 |
| 27 | Les Abattoirs (`lesabattoirs`) | 4,419 | 781 | 793 |
| 20 | Fonds d'art contemporain – Paris (`fac-pariscollections`) | 3,386 | 749 | 786 |
| 5 | Musée d'art moderne de Céret (`ceret`) | 3,424 | 522 | 598 |
| 21 | Musée Zadkine (`zadkine`) | 1,817 | 517 | 517 |
| 29, 28, 8, 38, 19, 12 | MAC VAL, LaM, MAC Lyon, Frac Normandie, Bourdelle, MAMAC Nice | — | 282, 252, 219, 200, 197, 171 | — |
| 3, 4, 22, 30–45 | CAPC Bordeaux, cdac93, Rochechouart, and 15 Frac collections | — | 3–162 each | — |
| **6, 23, 37** | **Grenoble, La Piscine Roubaix, Frac Franche-Comté** | 34,279 | **no facets** — est. ~1,780 by sampling | — |
| | **TOTAL (37 vaults)** | **448,131** | **33,807 + ~1,780** | **44,464** |

Vaults 6, 23 and 37 publish with the facet set empty, so `tree_domain_all` cannot filter them.
Their prints are reachable only by paging the whole vault and filtering on `domain`
client-side — 241 requests for La Piscine's 24,099 records, which is cheap enough to be a
detail rather than a blocker.

---

## 2. Public domain and images — the finding that matters

Full population, every record fetched:

| Vault | Institution | `Estampe` | `Domaine public` | with image | **PD *and* image** | median year | pre-1900 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 11 | Nantes | 4,110 | 1,925 (47%) | 2,455 (59%) | **1,385** | 1930 | 527 |
| 24 | MAMC+ Saint-Étienne | 2,149 | 1,226 (57%) | 2,120 (99%) | **1,212** | 1860 | 1,065 |
| 15 | Pompidou MNAM | 3,871 | 1,187 (31%) | 3,253 (84%) | **1,170** | 1959 | 72 |
| 25 | MAMC Strasbourg | 4,140 | 1,507 (36%) | 1,798 (43%) | **926** | 1920 | 507 |
| 14 | Cnap | 9,472 | 2,941 (31%) | 4,459 (47%) | **542** | 1958 | 825 |
| 18 | MAM Paris | 2,073 | 279 (13%) | 1,828 (88%) | **162** | 1961 | 0 |
| 20 | Fonds d'art contemporain Paris | 749 | 94 | 744 | **94** | 1972 | 3 |
| 5 | Céret | 522 | 25 | 449 | **20** | 1981 | 1 |
| 27 | Les Abattoirs | 781 | 12 | 745 | **12** | 1986 | 1 |
| 21 / 26 | Zadkine / Ungerer | 1,526 | 0 | 1,035 | **0** | 1964 / 1977 | 0 |
| | **Total profiled** | **29,393** | **9,196** | **19,886** | **5,523** | | **2,001** |

Named artists in the PD-heavy sets are squarely this project's subject matter: Piranesi (125 at
Nantes), Callot, Bresdin, Fantin-Latour, Tissot, Charles Le Brun, Laboureur (234), Auguste
Lepère (105 at Cnap), Max Klinger (160 at Strasbourg), Käthe Kollwitz, Félicien Rops,
Lovis Corinth.

**Images.** `https://images.navigart.fr/{px}/{file_name}`. Confirmed ceiling: `200` and `800`
work, **`1000` is the maximum** (`1200`/`1600` → 404, `2000` → 415), returning ~120KB JPEGs on
the long edge. `Access-Control-Allow-Origin: *`, 48h cache, no auth. 1000px is far above what
the DINOv2 pass consumes (224px), so the ceiling costs nothing here.

**Paris Musées caveat, in the project's favour.** Vaults 18 (MAM Paris), 21 (Zadkine), 19
(Bourdelle) and 20 belong to Paris Musées, which since 2020 publishes digital reproductions of
its public-domain works under **CC0, explicitly permitting commercial use**, at 300 DPI — but
through `parismuseescollections.paris.fr`, not through Navigart. For those four collections
Navigart is the better *catalogue*, and the Paris Musées portal is the better *image* source.
That is the only tier surveyed so far that would survive a move off the personal-research
footing.

---

## 3. Artist overlap with the ACKG

Print-subset author facets for twelve vaults, matched against all 8,033 `Artist` nodes
(name + `alternateNames`), normalised by accent-stripped sorted token set:

| Vault | Institution | distinct print artists | already in ACKG | prints by a known artist |
|---:|---|---:|---:|---:|
| 15 | Pompidou MNAM | 424 | 196 | 2,279 (58%) |
| 14 | Cnap | 2,164 | 337 | 2,205 (23%) |
| 25 | MAMC Strasbourg | 830 | 168 | 1,903 (45%) |
| 11 | Nantes | 779 | 208 | 1,764 (42%) |
| 24 | MAMC+ Saint-Étienne | 473 | 109 | 1,058 (49%) |
| 18 | MAM Paris | 560 | 138 | 943 (45%) |
| 21 | Zadkine | 8 | 1 | 483 (93%) |
| | **all twelve** | | | **13,450 / 31,616 = 42%** |

42% of records land on an artist the graph already knows, so they attach to existing
`Artist` nodes rather than creating a new island. The 58% that do not are dominated by
20th-century French printmakers with no auction presence in the Roseberys/Bonhams/Forum data —
new artists, but on-subject ones.

One known false positive: `Anonyme (sans précision)` normalises onto an ACKG `Anonymous`
node (396 records at Nantes). Any real adapter must exclude the `Anonyme*` family explicitly,
the same way the artist-dedup work already excludes non-artist `Artist` nodes.

---

## 4. Access mechanics not in the Picasso adapter

The Picasso fetcher uses `size`/`from`/`filters` only. The rest of the query surface, recovered
by reading the front-end bundle and watching its live XHR (it is not in
`api.navigart.fr/getting_started.html`):

- **Facet terms** — `?size=0&term=<facet>&term_order=count:desc&term_size=3000&term_from=0`.
  Without `term=`, `aggregations` returns totals only and an empty `terms` array, which reads
  like "no facet values" and is not.
- **Tree facets use `↹` (U+21B9) as the path separator**, and the filter must carry the **full
  path**, not the leaf. `filters=tree_domain_all:Estampe` returns `filteredCount: 0` on vault
  15 and 2,223 on vault 16 — because Pompidou's tree nests it as
  `Arts plastiques↹Estampe` and Picasso-Paris' does not. **A leaf-only filter fails silently
  with a zero count, not an error.** Any generalised fetcher must read each vault's tree first
  and filter on the key the tree returns.
- **Multiple filters join with `,,`**; full-text is `?q=`, not `query=` or `fulltext=`.
- **Vault → institution mapping.** `www.navigart.fr/robots.txt` lists one sitemap per vault,
  named `sitemap_<vault>_index.xml`; the URLs inside carry the publication slug. That is how
  every row in §1 was identified, and it is the only complete vault index found.
- **Per-publication facet config differs.** `withimage`, `artw_reproduction_rights` and
  `collection_department` exist on some vaults and not others; three vaults expose no facets
  at all. Field presence must be probed per vault, never assumed from vault 16.

Rate behaviour was unremarkable: `size=200` accepted everywhere, deep paging to `from=9400`
fine, ~100 sequential requests at 0.25s spacing with no throttling seen.

---

## 5. Field availability against the Picasso field map

Full-population coverage for the print subsets, against the mapping in the Picasso survey §4:

| Field | Picasso-Paris | Pompidou | Nantes | Cnap | Strasbourg | verdict |
|---|---:|---:|---:|---:|---:|---|
| `inventory` | 99.6% | 100% | 100% | 99% | 100% | transfers |
| `title_list` / `authors_list` | 100% | 100% | 89% | 100% | 100% | transfers |
| `date_creation` | 99.6% | 100% | 100% | 99% | 100% | transfers |
| `mst` | 99.5% | 98% | 99% | 98% | 100% | transfers |
| `dimensions` | 99.7% | 59% | 95% | 97% | 100% | transfers, weaker at Pompidou |
| `tirage` | 25.4% | 60% | 35% | 52% | 29% | transfers, **better** elsewhere |
| `inscriptions` | 44.4% | 68% | 64% | 96% | 64% | transfers, **better** elsewhere |
| `medias` | 95.3% | 84% | 60% | 47% | 43% | transfers, much weaker |
| `collaborators` (printer) | 38.5% | 11% | 22% | 50% | 10% | transfers, weaker |
| **`number_catalogue`** | **79.1%** | **0%** | **1.8%** | **0%** | **0%** | **does not transfer** |
| `old_owners` (provenance) | 85.6% | 0% | 2% | — | — | **does not transfer** |

So a generalised adapter still populates `Impression`, `Technique`, `Paper`, `State`,
`EditionRun`, `Matrix` and `DigitalImage` — but it does **not** reproduce the
`CatalogueEntry` bridge, and it does not feed ADR-0017's canonical-title problem with a
catalogue citation behind it. Titles arrive as institutional titles with no catalogue anchor,
which is a weaker authority tier than the 1,757 Picasso records supplied.

`tirage` and `inscriptions` being *better* populated outside Picasso-Paris is the compensating
find: those are the fields the `State` / `Paper` / `EditionRun` SEMANTIC_SPLIT rules read, and
they are the nodes ADR-0008 lists as thinly populated.

---

## 6. Technique resolution — the existing crosswalk mostly works

`resolve_techniques()` from `picasso_paris_ingest.py`, run unchanged over all 29,393 fetched
print records:

| Vault | resolved | Vault | resolved |
|---|---:|---|---:|
| Zadkine | 99% | MAM Paris | 89% |
| Nantes | 95% | Les Abattoirs | 88% |
| Fonds d'art contemporain Paris | 95% | Pompidou | 85% |
| MAMC Strasbourg | 94% | Cnap | 75% |
| MAMC+ Saint-Étienne | 90% | Céret | 63% |
| | | Tomi Ungerer | **3%** |
| | | **overall** | **82% (24,318 / 29,393)** |

The failure tail is short and repetitive — the top fifteen unresolved strings account for most
of it:

```
1324  (empty)                          102  Estampe
 562  Gravure                           96  Gravure en couleurs
 191  Reproduction offset               85  Reproduction offset en couleur sur papier
 139  Gravure sur papier                75  Impression xylographique sur papier de riz
 122  Impression offset                 67  Plaque gravée
                                        65  Bois (matrice)
                                        62  Cliché typographique sur papier
```

Three separate things are mixed in there and they want different handling:

- **Offset / typographic reproduction** (~500) is not original printmaking. It should route to
  an exclusion, not to a new `Technique` node — see §7.
- **`Plaque gravée`, `Bois (matrice)`** (~130) are matrices, and `picasso_paris_ingest.py`
  already has the `Matrix` routing for exactly this; it just keys off `domain_denomination`,
  which these vaults populate differently.
- **Bare `Gravure` / `Estampe` / `Gravure sur papier`** (~800) are genuinely non-specific —
  French `gravure` covers the whole intaglio-and-relief family. These should stay
  `techniqueResolved = false` rather than be forced to a guess, which is what the existing
  exclusion gate already does.

Adding roughly fifteen terms plus the matrix routing takes this to ~93% with the ambiguous
residue correctly flagged.

---

## 7. Data-quality caveats

- **`Design graphique` / `Affiche` is not printmaking.** It inflates the network total from
  33,807 to 44,464, and the Tomi Ungerer vault shows what is actually in it: 97% of its 1,009
  records are offset reproductions of illustrations. Filter on `Estampe` only.
- **Image coverage is much worse than at Picasso-Paris.** 95% there; 47% at Cnap, 43% at
  Strasbourg, 59% at Nantes. Record counts and *usable* record counts diverge sharply.
- **`artw_reproduction_rights` exists on only some vaults.** Where it does (Pompidou, 99%), it
  is worth reading: 3,411 "autorisée", 341 "en attente d'autorisation", **101 "non
  autorisée"**. A fetch that ignores it would pull 101 images the museum has explicitly marked
  as not cleared. Nantes, Cnap and Strasbourg do not publish the field at all, so absence is
  not permission.
- **Duplicate impressions across institutions are expected, not a bug.** Piranesi at Nantes and
  Piranesi at the Met are different impressions of the same conceptual work. Per the standing
  rule, merge on exact artist + title + year only — no similarity matching, and specifically
  not DINOv2 (that probe was rejected on 2026-09-10).
- **Names are `SURNAME Firstname`**, with `(REAL NAME, dit)` aliases inline —
  `MAN RAY (RADNITZKY Emmanuel, dit)`. The Picasso adapter's hand-resolved ULAN step does not
  scale to 2,164 distinct Cnap artists; this needs the existing `backfill_artist_ulan.py`
  path, not manual resolution.

---

## 8. Rights position, and a correction to ADR-0002 Amendment 1

Amendment 1 rests partly on this sentence: *"The platform actually serving the data
(`api.navigart.fr`) reserves nothing."* **As observed today, that is not accurate** (whether robots.txt changed since the amendment
was written, or was simply not checked, is not something this survey can tell).
`api.navigart.fr/robots.txt` now carries `Disallow: /` for `GPTBot`, `meta-externalagent`,
`meta-externalads`, `PetalBot`, `AhrefsBot` and `AdsBot-Google`; `www.navigart.fr/robots.txt`
disallows `GPTBot`. The generic `User-agent: *` block still disallows only the bare root and
the doc pages, so the `/{vault}/artworks` API paths remain open to an ordinary research client
— but "reserves nothing" should be corrected to "reserves against named AI crawlers, not
against general access", and the amendment's reasoning restated on that basis.

Where the other institutions differ from Picasso-Paris, they differ **in this project's
favour**:

- **No Content-Signal TDM reservation.** `museepicassoparis.fr/robots.txt` sets
  `Content-Signal: ai-train=no, use=reference` — an express Article 4 EU DSM reservation, and
  the reason that ingest ships no embed script. Checked today, `cnap.fr`,
  `centrepompidou.fr`, `musees.strasbourg.eu`, `mam.paris.fr`, `mamc.saint-etienne.fr` and
  `museedartsdenantes.fr` publish **no equivalent reservation**.
- **9,196 records are public domain**, so there is no `© Succession`-style rights holder
  behind them at all, and no estate with Succession Picasso's enforcement posture.
- **Article 14 of the EU DSM Directive** — transposed in France — provides that reproductions
  of public-domain visual works are not themselves protected unless the reproduction is an
  original work. That is the instrument that makes the 5,523 PD images usable, and it is a
  reading, not advice.

So the PD-plus-image tier needs neither Amendment 1's metadata/imagery distinction nor
Decision 7's embedding conditions: it is images of public-domain works, from institutions
asserting no reservation. The **in-copyright** remainder (`© Adagp, Paris` is the single
largest copyright string across these vaults) sits exactly where Picasso-Paris sits, and should
be treated under Decision 5 — metadata only, no image bytes — unless a separate decision is
taken.

---

## 9. Recommendation

**Tier 1 — build.** A generalised `navigart_fetch.py` (vault-parameterised, reads each vault's
own domain tree, honours `artw_reproduction_rights` where published) plus a
`navigart_ingest.py` generalised from `picasso_paris_ingest.py`. Load the **PD + image tier
first: ~5,523 records** across Nantes, Saint-Étienne, Pompidou, Strasbourg and Cnap. This is
the only tier that adds *freely usable images* to the embedding index, and the only one that
would survive a change of footing.

**Tier 2 — metadata only.** The ~24,000 in-copyright `Estampe` records, under ADR-0002
Decision 5, with `SourceRecord.institutionName` and per-image `license` /
`rightsReservation` carried structurally as the Picasso adapter already does. Attractive for
the `tirage`/`inscriptions` coverage (§5), not for catalogue identity (§5, `number_catalogue`
0%).

**Tier 3 — leave.** `Design graphique` / `Affiche`; the three unfaceted vaults; the fifteen
Frac collections (3–200 prints each, overwhelmingly contemporary, minimal ACKG overlap).

**Sequencing note.** Tier 1 is ~5,500 records and ~120 fetch requests plus an image pass; the
technique crosswalk needs ~15 terms added (§6) and the `Anonyme` exclusion (§3) before any of
it loads.

---

## 9.1 Tier 1 — built and loaded (2026-09-11)

Three scripts, following the fetch/resolve/ingest split the rest of this directory uses:

| File | What it does |
|---|---|
| `navigart_fetch.py` | Vault-parameterised fetch. Resolves each vault's own `Estampe` tree path before filtering (§4), applies the PD+image tier gate, honours `artw_reproduction_rights` where published. 33 vaults, one cache file each. |
| `navigart_resolve_artists.py` | Matches the 714 distinct author strings against the live ACKG on an exact normalised key, with a deterministic ladder for ACKG duplicate nodes and a hand-verified alias table. Writes `navigart_artist_resolution.json`. |
| `navigart_ingest.py` | Maps and loads. Shares every parsing rule with `picasso_paris_ingest.py` by importing it; adds the extended French technique table, the matrix prefix test, and the placeholder-accession gate. |

**Fetched:** 5,670 public-domain records carrying an image, from 13 of the 33 vaults.
**Loaded:** **5,598 records** — 5,509 impressions and **89 matrices** (woodblocks and copper
plates), every one with an image.

| Institution | Records | Matrices |
|---|---:|---:|
| Musée d'arts de Nantes | 1,377 | 3 |
| MAMC+ Saint-Étienne Métropole | 1,170 | — |
| Centre Pompidou, MNAM | 1,167 | 76 |
| Musée d'Art moderne et contemporain de Strasbourg | 922 | 1 |
| Centre national des arts plastiques | 538 | 1 |
| Musée d'Art Moderne de Paris | 160 | — |
| Musée Bourdelle | 105 | — |
| Fonds d'art contemporain – Paris Collections | 94 | — |
| LaM, Lille Métropole | 24 | 8 |
| Tomi Ungerer / Céret / Les Abattoirs / Frac Île-de-France | 41 | — |

Graph delta: `SourceRecord` +5,598, `Impression` +5,509, `Matrix` +89 (189 → 278, a 47%
increase on a node type doc 08 defined and almost nothing populated), `DigitalImage`
+5,598, `ConceptualWork` +5,598, `State` +102, `Artist` +519, `Publisher` +26.

**Technique resolution: 5,327 / 5,598 (95%)** — Etching 2,684, Lithograph 991, Woodcut
846, Engraving 419, Drypoint 405, Aquatint 350, then a long tail. The 271 unresolved are
in `navigart_unresolved_techniques.csv` and are almost entirely the deliberately-refused
bare `Gravure` / `Estampe` strings (§6).

**Artist attachment: 3,145 of 5,598 records (56%) attached to an `Artist` node that
already existed**, against the 42% estimated in §3 — the gap is the alias table and the
duplicate-breaking ladder, neither of which the estimate had. By rule, as written onto
`SourceRecord.artistMatchRule`: 2,163 exact normalised key, 546 hand-verified alias, 246
broken by work count, 190 broken by ULAN, and 2,453 creating one of 519 new artists. Piranesi 830 works, Dufy 488, Kandinsky 475,
Laboureur 221, Klinger 143, Doré 143, Tissot 77, Derain 68.

**Images verified live:** 40 randomly sampled image URLs, 40/40 HTTP 200, median 345KB at
the 1000px ceiling.

**Rights, as written:** every `DigitalImage` carries
`license = "Public domain (museum-asserted: copyright field = 'Domaine public'); reproduction per EU DSM Art.14"`
and a `rightsReservation` that is either the source's own flag (2,497 records: "Reproduction
internet autorisée") or the explicit string "no reproduction flag published by source"
(3,101). Absence of a flag is recorded as absence, never as clearance. A cross-check
against ACKG death years found **0 of 5,598 records** by an artist who died after 1955 —
i.e. nothing contradicts the museums' own public-domain assertion on the evidence
available (the ACKG knows a death year for 106 of the 636 artists).

### Three defects the first load exposed, and what they cost

The first run was **rolled back in full and re-run**, rather than patched in place, because
two of the three would otherwise have left the graph in a state that looked correct:

1. **A colliding identity key.** Two Nantes records both carry the literal accession
   `"à inventorier?"`. `Impression.id` is built from the accession, so they MERGE'd onto
   one node and one record silently overwrote the other — the load came back one row
   short of what it mapped, which is the only reason it was noticed. Now gated by
   `PLACEHOLDER_ACCESSIONS`; 4 records excluded.
2. **Hand-verified aliases that matched nothing.** Three of the ten entries in the alias
   table were keyed on a guessed spelling of the author string rather than the real one,
   and an alias that matches nothing fails *silently* — which created a second Rembrandt
   node carrying 29 works, and a second Henri Rivière carrying 21. The resolver now
   raises if any alias key matches no record in the caches.
3. **Role markers title-cased into names.** `authors_notice` is the display source, so
   "SANZIO Raffaello dit RAPHAËL" became the artist "Raffaello Sanzio Dit Raphaël". Eight
   nodes were affected. French role markers (`dit`, `dite`, `fils`, `père`, `aîné`,
   `jeune`) are now lower-cased; the name particles (`de`, `le`, `van`…) deliberately are
   not, because `authors_notice` shouts real surnames like "LE BAS".

The rollback deleted only what the load created — Artist nodes whose every neighbour was a
`navigart`-prefixed node, the navigart-prefixed nodes themselves, and Publishers that
became orphaned and were not orphaned before. Every label returned to its exact pre-load
count.

### Logged, not swept

- **An `Artist` node with `name = ""`** carrying 17 `alternateNames` of the form
  "(n/a) Giovanni Battista Piranesi", with 18 real works and 18 `SourceRecord`s attached.
  It is an ingest artifact from an earlier adapter. Dropped from this load's match index
  (it alone made Piranesi ambiguous) but **not repaired** — 18 works are attributed to a
  nameless artist and that is someone else's fix.
- **19 ACKG duplicate-`Artist` groups** were hit by this load and broken by the ladder in
  §9.1's resolver rather than merged: Laboureur ×3, Tissot ×3, Lepère ×2, Daumier ×2,
  Delacroix ×2, Raffaëlli ×2, Forain ×2, Haden ×2, Marcoussis ×2 and others. 436 records
  attached to one branch of a pair the graph has not merged, which grows that branch. The
  rows carry `SourceRecord.artistMatchRule` so the outstanding dedupe pass can find them.
- **Author order is not reliably maker-first.** "AUDRAN Benoît I, LE BRUN Charles" is
  Audran engraving Le Brun's design (maker first), but "SANZIO Raffaello dit RAPHAËL,
  BOURGEOIS Charles" is Bourgeois engraving after Raphael (designer first). The structured
  `authors` array types every contributor identically as `"artiste"` — there is no role
  field. 15 records are caught via an explicit `(d'après)` marker and recorded as
  `ATTRIBUTED_TO {qualifier: "after"}`; the remaining ~200 multi-author records take the
  first author as maker and keep the full string in
  `Impression.secondaryAuthorsNote`. Some of those are wrong and this adapter cannot tell
  which.
- **Another session was writing to the database while this load ran.** `CatalogueRaisonne`
  fell 2,958 → 2,319 and `CatalogueEntry` rose 22,044 → 22,273 mid-run, and this adapter
  creates neither node type. Identified afterwards from the commit log: `199a74d` (2026-09-11
  08:45) added `repair_comma_split_catalogue_entries.py`, which splits the mangled
  "Bloch 182, Baer"-shaped prefixes into real entries — fewer `CatalogueRaisonne`, more
  `CatalogueEntry`, exactly the observed direction. Harmless here (the write sets do not
  intersect), but no count in this document is a point-in-time truth about anything outside
  this adapter's own labels.
- **10 image URLs are shared by two records each** (5,598 image nodes, 5,588 distinct
  URLs). Probably one photograph covering a suite; not investigated.

---

## 10. Not done

- **Tier 2 (the ~24,000 in-copyright `Estampe` records) is not loaded.** `navigart_fetch.py
  --tier all` will fetch it; the ingest needs no change, but the decision does.
- **No embed pass.** The 5,598 images are pointed at, not downloaded — `DigitalImage.sourceUrl`
  only. A `navigart_embed_images.py` alongside the other adapters' embed scripts is the
  obvious next step and is the entire point of choosing the PD tier first; it was not
  written here.
- Image bytes: none downloaded beyond the ceiling probe and a 40-URL liveness sample.
- The three unfaceted vaults (Grenoble, La Piscine, Frac Franche-Comté) were estimated from
  3×100-record samples, not enumerated.
- Vaults 1, 2, 7, 9, 10, 13, 17 and 33 return HTTP 404 — private or retired publications; not chased.
- Whether `_id` and `inventory` are stable across re-fetches is still an observation from one
  session, exactly as the Picasso survey flagged.
- ULAN resolution for the ~2,900 distinct new artists is unscoped.
