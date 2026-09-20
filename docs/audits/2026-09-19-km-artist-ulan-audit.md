# King & McGaw artist nodes carrying a Getty ULAN — audit and proposal

**Date:** 2026-09-19 · **Status:** §§1–8 are the original read-only proposal. It was then partly approved and applied; **§9 records what was done and what is still open.**
**Scope:** `Artist` nodes whose every work has id `km-cw-…` (the King & McGaw ingest, `knowledge_graph/king_mcgaw_ingest.py`).

## 1. Result in one paragraph

116 Artist nodes own only King & McGaw works; **113 of them carry a ULAN url**. I could confirm the ULAN as the right person for **46** (137 works). For **64** (238 works) the ULAN is either a different person, or the KM name is not a person at all (collection label, firm, two-person credit, title-in-the-name, an "after X" credit); I propose removing `ulanUrl` from those and keeping the node. 3 more (4 works) are stub ULAN records I can neither confirm nor reject and propose leaving alone. Three further nodes (Mirrorpix, VeeBee, Kelways) already have no ULAN, which is what the correct state looks like.

The wrong ULANs are not random noise. **82 of the 113 are tier `multiple_candidates`, and 62 of those are wrong or meaningless**; the resolver's own documentation says only `high_confidence_auto` is safe to write, but the ingest writes whatever it returns.

## 2. Root cause (one line each, with the code)

1. `resolve_artist_identity.resolve_artist()` returns `resolvedUlanUrl = candidates[0]["ulanUrl"]` **for every confidence tier**, including `multiple_candidates` and even `unresolved` (`P J Bellenger` is stored at score 0.49 with tier `unresolved`). The docstring is explicit that only `high_confidence_auto` is safe to write.
2. `king_mcgaw_ingest.prepare_item_record()` (line ~147) takes `resolved_ulan` with **no check on `confidence`** and uses it as the Artist key, and `cypher_ingest_batch` stores it with `SET a.ulanUrl = coalesce(a.ulanUrl, row.artist.ulanUrl)`.
3. The name scorer over-rewards shared given names. It picks *Fitler, Edwin Henry* (an American politician, 1825–1896) for "Sir Edwin Henry Landseer" (0.894) over *Landseer, Edwin* (0.850), and *Pisano, Nicola* for "Nicola King". The correct record is often present in the local ULAN mirror one or two ranks down.
4. Because the ingest matches `coalesce(byUlan, byWiki, byName)`, **a wrong ULAN also pools unrelated source names onto one node** — see §3.

## 3. Evidence that this has already done damage

**a. Four nodes already pool works from more than one King & McGaw artist**, every one of them a `multiple_candidates` node (slug = the artist segment of the product URL):

| Node | Slugs found on its works |
|---|---|
| Eric (ULAN 500116076 "Riel, Eric") | `eric` ×1, `eric-ravilious` ×1 — two different people |
| J. Howard Miller (500001822 "Miller, John") | `j-howard-miller` ×1, `john-wilsher` ×3 |
| Original Film Posters (500453728 "Sankofa Film & Video") | `original-film-posters` ×2, `original-film-stills` ×3 |
| After Hans Holbein the Younger (500005259, Holbein's own) | `after-hans-holbein-the-younger` ×1, `hans-holbein-the-younger` ×2 |

These are the failure the task brief predicted, already realised. Nulling the ULAN stops further pooling but does **not** un-pool these; splitting them is a separate write (§6, step 3).

**b. The merge tooling would spread a wrong ULAN.** `merge_artists.py` (line ~207) does `canon.ulanUrl = coalesce(canon.ulanUrl, dup.ulanUrl)`. If a real, ULAN-less artist node is merged with a KM node that holds a wrong ULAN — in either direction — the survivor inherits the wrong identifier. Live examples with a wrong ULAN on the KM side: `Edwin Landseer` and `Edwin Henry Landseer` (both ULAN-less) against KM's "Sir Edwin Henry Landseer", and `Michelangelo Buonarroti` against KM's "Michelangelo". The reverse also holds for the *right* ULANs, which is the good case and the reason to keep them: ULAN-less `John Hassall`, `Kawase Hasui`, `Goya` (226 works), `Edward Coley Burne-Jones` (7) and `Lawrence Alma-Tadema` (7) are the same people as KM nodes in group A, so a merge there would be correct.

**c. The correct ULAN is sometimes already on a different node.** KM's "Christopher Richard Wynne Nevinson" holds 500225911 (*Seddon, Christopher Richard*), while the real 206-work node "Christopher Richard Wynne Nevinson ARA" holds 500031355 (*Nevinson, Christopher*, 1889–1946). Giving the KM node the right id would violate the `artist_ulanurl` uniqueness constraint (a loud failure, at least); the right fix is a merge, not a re-key.

**d. Mixed nodes are out of scope.** The 45 *mixed* nodes (KM works plus another source) got their ULAN from other ingests; none is `multiple_candidates`. They are out of scope.

## 4. Groups and proposals

| Group | What it is | Nodes | Works | Proposal |
|---|---|--:|--:|---|
| **A** Real person, ULAN confirmed | A1 `high_confidence_auto` (11), A2 `single_candidate_strong` with full-name match (18), A3 `multiple_candidates` but confirmed by name and dates, and by work titles where I checked (17) | 46 | 137 | **KEEP** the ulanUrl. Optionally correct the stale tier on A3 (§7) |
| **B** Collection labels, brands, firms | Anonymous, Original Film Posters, Cinema Greats, The National Archives, Thai Fine Art, The Yokohama Nursery Co Ltd, Ladybird Books, Bassano Ltd, Gillman & Co | 9 | 57 | **NULL** the ulanUrl, keep the node. Exclusion is a separate call (§5) |
| **C** Title-in-the-name (parse defect) | `<title> by <artist>` used as the artist name | 5 | 5 | **NULL** now; repair the names/works separately (they belong to Jeremy Mayes, Hannah Cole, John Atkinson Grimshaw, and to the two label nodes) |
| **D** Multi-person credit | "Adam and Maurice-Pillard Verneuil", "Em. Rodigas and R A Rolfe" | 2 | 3 | **NULL** — a joint credit has no single ULAN |
| **E** "After X" credit | `After Hans Holbein the Younger`: the ULAN is Holbein's, the node is the copyist's credit | 1 | 3 | **NULL**, matching how `Joshua Reynolds After`, `Richard Earlom after Peter Paul Rubens` etc. carry none; and it is pooled with Holbein's own works |
| **F** Unverifiable stub record | ULAN record is a bare stub (e.g. "artist, active 20th century") | 3 | 4 | **HOLD** — leave untouched; revisit with a proper ULAN search |
| **G** Real person, ULAN is someone else | different person, wrong era, or a namesake | 47 | 170 | **NULL** |
| **H** No ULAN today | Mirrorpix (14), VeeBee (4), Kelways (1) | 3 | 19 | none — already correct |

Nothing here proposes **excluding a slug**. The Rare Theatre Posters exclusion rested on two facts I could check on the listing pages (no designer credit; six of eight listings sharing one mockup image). For the group-B labels the graph shows every listing has its own image (e.g. Anonymous 29/29 distinct) and I did **not** open the KM pages, so I cannot say whether a designer is credited. `original-film-posters`, `original-film-stills` and `cinema-greats` (**9** works between them: 5 + 4; this section originally said 11, which was an arithmetic error) are the closest analogues and the ones worth a spot-check before deciding; that is your call.

## 5. Per-group detail

### Group A — keep (46 nodes)

A1 and A2 are exact or near-exact name matches (0.94–1.00) to a ULAN person whose dates are plausible for the named artist; I did not check each work title. A3 are the `multiple_candidates` nodes that turn out to be right; each is the same person by name (allowing for a middle name or "Sir"), with dates that fit and, for the ones I could check, works that fit (Hassall's *Skegness is SO Bracing* is John Hassall's 1908 poster; Grobon's and Snelling's titles are botanical plates and Redouté is a botanical illustrator; Van Eyck picked the 1390–1441 painter, not the 1927–88 namesake). Two caveats: Jan Van Eyck and Diego Velázquez were tied with a namesake and the resolver got them right by rank, not by evidence; and A2 includes *William Hooker* (9 works), which I accepted on name and dates alone (I did not look at its titles).

**A1 — high_confidence_auto**

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score |
|---|--:|---|---|---|--:|
| Alice Dalton Brown | 9 | high | 500084506 | Brown, Alice Dalton — American painter, born 1939 | 1.00 |
| Vilhelm Hammershoi | 3 | high | 500000827 | Hammershøi, Vilhelm — Danish painter, 1864-1916 | 0.98 |
| Gerard Hoffnung | 2 | high | 500015583 | Hoffnung, Gerard — British cartoonist and humorist, 1925-1959 | 1.00 |
| Akseli Gallen-Kallela | 1 | high | 500015305 | Gallen-Kallela, Akseli — Finnish painter and graphic artist, 1865-1931 | 1.00 |
| Alesso Baldovinetti | 1 | high | 500115745 | Baldovinetti, Alesso — Italian painter, ca. 1425-1499 | 1.00 |
| Caspar David Friedrich | 1 | high | 500116242 | Friedrich, Caspar David — German painter, 1774-1840 | 1.00 |
| Gertrude Jekyll | 1 | high | 500012954 | Jekyll, Gertrude — English landscape architect and gardener, 1843-1932 | 1.00 |
| Lucy Willis | 1 | high | 500181809 | Willis, Lucy — British painter, born 1954 | 1.00 |
| Patrick Branwell Brontë | 1 | high | 500017403 | Brontë, Patrick Branwell — British painter, 1817-1848 | 1.00 |
| Sir Lawrence Alma-Tadema | 1 | high | 500008100 | Alma-Tadema, Lawrence — Dutch and British painter, 1836-1912 | 1.00 |
| Victor Gabriel Gilbert | 1 | high | 500026933 | Gilbert, Victor Gabriel — French painter, 1847-1935 | 1.00 |

**A2 — single_candidate_strong**

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score |
|---|--:|---|---|---|--:|
| John Atkinson Grimshaw | 15 | strong | 500027946 | Grimshaw, John Atkinson — English painter, 1836-1893 | 1.00 |
| William Hooker | 9 | strong | 500694330 | Hooker, William — English painter, 1779-1832 | 1.00 |
| John William Waterhouse | 8 | strong | 500027032 | Waterhouse, John William — British painter, 1849-1917 | 1.00 |
| Sir Peter Paul Rubens | 5 | strong | 500002921 | Rubens, Peter Paul — Flemish painter, 1577-1640 | 1.00 |
| Charles Joseph Hullmandel | 4 | strong | 500041156 | Hullmandel, Charles Joseph — English lithographer and draftsman, 1789-1850 | 1.00 |
| Frida Kahlo | 3 | strong | 500030701 | Kahlo, Frida — Mexican painter, 1907-1954 | 1.00 |
| Abram Games | 2 | strong | 500184250 | Games, Abram — British artist, 1914-1996 | 1.00 |
| Dora Carrington | 2 | strong | 500005242 | Carrington, Dora — English painter and decorative artist, 1893-1932 | 1.00 |
| James Sowerby | 2 | strong | 500005666 | Sowerby, James — English printmaker and naturalist, ca. 1740/1857-ca. 1803/1822 | 1.00 |
| Paolo Uccello | 2 | strong | 500003110 | Uccello, Paolo — Italian painter, 1397-1475 | 1.00 |
| Alfred Wallis | 1 | strong | 500029935 | Wallis, Alfred — English painter, 1855-1942 | 1.00 |
| Charles C. Ebbets | 1 | strong | 500608665 | Ebbets, Charles — American photographer, 1905-1978 | 0.94 |
| Francisco de Goya | 1 | strong | 500118936 | Goya, Francisco de — Spanish painter, 1746-1828 | 1.00 |
| Gerda Wegener | 1 | strong | 500010464 | Wegener, Gerda — Danish painter, designer, 1885-1940, active in France | 1.00 |
| Italo Valenti | 1 | strong | 500019588 | Valenti, Italo — Swiss painter, 1912-1995 | 1.00 |
| Jan Jansz Treck | 1 | strong | 500017864 | Treck, Jan Jansz. — Dutch painter, ca.1606-1652 | 1.00 |
| Jan Van Os | 1 | strong | 500000843 | Os, Jan van — Dutch painter and poet, 1744-1808 | 1.00 |
| Sir Joshua Reynolds | 1 | strong | 500004539 | Reynolds, Joshua — English painter, collector, 1723-1792 | 1.00 |

**A3 — multiple_candidates, confirmed**

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score | note |
|---|--:|---|---|---|--:|---|
| Pierre Joseph Celestin Redouté | 17 | multiple | 500005678 | Redouté, Pierre Joseph — French illustrator of Flemish birth, 1759-1840 | 0.90 |  |
| Lillian Snelling | 16 | multiple | 500032153 | Snelling, Lilian — British painter, 1879-1972 | 0.96 |  |
| Henry Charles Andrews | 4 | multiple | 500027916 | Andrews, Henry Charles — English botanical illustrator, active 1799-1828 | 1.00 |  |
| Diego Velázquez | 2 | multiple | 500016881 | Velázquez, Diego — Spanish painter, 1599-1660 | 1.00 | twin-tied, right one picked |
| Francois Frederic Grobon | 2 | multiple | 500042643 | Grobon, François-Frédéric — French painter, born 1815, died 1901 or 1902 | 0.92 |  |
| Jan Van Eyck | 2 | multiple | 500116209 | Eyck, Jan van — Netherlandish painter, ca.1390-1441 | 1.00 | twin-tied, right one picked |
| Jan van Huysum | 2 | multiple | 500001494 | Huysum, Jan van — Dutch painter and draftsman, 1682-1749 | 1.00 |  |
| Balthasar van der Ast | 1 | multiple | 500029053 | Ast, Balthasar van der — Dutch still life painter, 1593 or 1594-1657 | 1.00 |  |
| Claude Stanfield Moore | 1 | multiple | 500021260 | Moore, Claude Thomas Stanfield — British painter, 1853-1901 | 0.82 |  |
| Emile Cardinaux | 1 | multiple | 500021057 | Cardinaux, Emil — Swiss painter and graphic artist, 1877-1936 | 0.98 |  |
| Francois Le Vaillant | 1 | multiple | 500095492 | Le Vaillant, François — French ornithologist, author, illustrator, 1753-1824 | 1.00 |  |
| Franz Michael Regenfuss | 1 | multiple | 500003396 | Regenfus, Franz Michael — German engraver, before 1713-1780 | 0.99 |  |
| Hassall | 1 | multiple | 500001686 | Hassall, John — British painter, illustrator, designer, 1868-1948 | 0.69 |  |
| Hasui Kawase | 1 | multiple | 500333884 | Kawase, Hasui — Japanese printmaker, 1883-1957 | 1.00 |  |
| Paolo Caliari Veronese | 1 | multiple | 500021218 | Veronese, Paolo — Italian painter, 1528-1588 | 0.88 |  |
| Samuel John Peploe | 1 | multiple | 500017759 | Peploe, Samuel John — Scottish painter, 1871-1935 | 1.00 |  |
| Sir Edward Coley Burne-Jones | 1 | multiple | 500001381 | Burne-Jones, Edward — English painter, 1833-1898 | 0.85 |  |

### Group B — collection labels, brands and firms → NULL (9 nodes)

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score | note |
|---|--:|---|---|---|--:|---|
| Anonymous | 29 | multiple | 500462488 | Anonymous — Unknown artist | 1.00 | ULAN has two exact 'Anonymous' records; this one is arbitrary |
| The National Archives | 7 | multiple | 500437036 | National Art Foundation — American owner | 0.69 | a source archive, not a creator |
| Thai Fine Art | 6 | multiple | 500605650 | Thai Thang An — Vietnamese watercolorist, 1948- | 0.77 | ULAN pick is a Vietnamese watercolorist 'Thai Thang An' |
| Original Film Posters ⚑ pooled | 5 | multiple | 500453728 | Sankofa Film & Video — corporate body | 0.62 | pools `original-film-stills` works |
| Cinema Greats | 4 | multiple | 500454550 | Mexican Cinema Project — corporate body | 0.59 |  |
| Bassano Ltd | 2 | multiple | 500015945 | Bassano, Leandro — Italian painter, 1557-1622 | 0.88 | a photographic studio; ULAN pick is Leandro Bassano (1557–1622) |
| The Yokohama Nursery Co Ltd | 2 | multiple | 500449627 | Robert Simpson & Co., Ltd. — Canadian owner, fl. 1929 | 0.76 | a company; ULAN pick is a Canadian retailer |
| Gillman & Co | 1 | multiple | 500470147 | Gillow & Co. — Institution | 0.91 | a firm; ULAN pick is furniture-maker Gillow & Co. |
| Ladybird Books | 1 | multiple | 500352301 | Burning Books — artist | 0.72 |  |

### Group C — title-in-the-name parse defect → NULL (5 nodes)

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score |
|---|--:|---|---|---|--:|
| Moonlight, from the Steps of the Grand Hotel by John Atkinson Grimshaw | 1 | multiple | 500158331 | Master of the Marientafeln from Munich — German artist, active 1450-1455 | 0.64 |
| Rail by Anonymous | 1 | multiple | 500351388 | Bachelors Anonymous — artist | 0.72 |
| Tram by The National Archives | 1 | multiple | 500617482 | Tram Phuc Duyen — Vietnamese painter, 1923- | 0.68 |
| a Canal 2 by Jeremy Mayes | 1 | multiple | 500105302 | Bailey, Jeremy — British architect, active late 20th century | 0.61 |
| the Sea by Hannah Cole | 1 | multiple | 500470220 | Linens by Dewan — Institution | 0.66 |

### Group D — multi-person credit → NULL (2 nodes)

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score |
|---|--:|---|---|---|--:|
| Adam and Maurice-Pillard Verneuil | 2 | multiple | 500394726 | Wiener, Adam and Droste — artist, active 20th century | 0.80 |
| Em. Rodigas and R A Rolfe | 1 | multiple | 500019496 | Breton, Emile Adélard — French painter, draftsman, and engraver, 1831-1902 | 0.70 |

### Group E — "After X" credit → NULL (1 node)

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score |
|---|--:|---|---|---|--:|
| After Hans Holbein the Younger ⚑ pooled | 3 | multiple | 500005259 | Holbein, Hans, the younger — German painter, 1497/1498-1543, active in Switzerland and England | 0.87 |

### Group F — unverifiable stubs → HOLD (3 nodes)

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score | note |
|---|--:|---|---|---|--:|---|
| Pieter Brueghel The Younger | 2 | multiple | 500400084 | Brueghel, Pieter — Flemish artist | 0.88 | the record is a generic 'Brueghel, Pieter' stub; ULAN also has separate II and III entries |
| Hannah 'Gluck' Gluckstein | 1 | multiple | 500376124 | Glück, H. — artist, active 20th century | 0.84 | the record is the stub 'Glück, H.', est. 1800–2100, cannot be tied to Gluck (1895–1978) |
| Jan Beerstraaten | 1 | multiple | 500419469 | Beerstraten, J. — Dutch artist | 0.92 | probably the right painter (*Castle of Muiden in Winter*) but the record is the stub 'Beerstraten, J.' |

### Group G — real person, ULAN is someone else → NULL (47 nodes)

The test was: does the ULAN person's name match, and do their dates/medium fit the works? For all of these it fails — typically a namesake sharing a forename ("Nicola King" → the 13th-century sculptor Nicola Pisano; "Keri Bevan" → Irwin Bevan, flourished 1900–24, for modern London prints; "J Bisson" → a French painter who died in 1737, for a 1930 rum poster; "Charles Burton" → a painter active 1819–42, for a 1930 motor-show poster; "Sir Edwin Henry Landseer" → an American politician). Nodes marked ⚑ are pooled (§3a).

| KM name | works | resolver tier | ULAN | ULAN preferred name — bio | name score | note |
|---|--:|---|---|---|--:|---|
| Marion McConaghie | 16 | multiple | 500379282 | Lachaise, Marion — French mixed-media artist and video artist, born 1966 | 0.85 |  |
| Lydia Penrose | 14 | multiple | 500685003 | Jägers, Lydia — Dutch graphic artist, contemporary | 0.85 |  |
| Keri Bevan | 11 | multiple | 500757161 | Bevan, Irwin — English artist, flourished 1900-1924 | 0.81 |  |
| Nicola King | 10 | multiple | 500004862 | Pisano, Nicola — Italian sculptor and architect, born 1220/1225, died 1278/1287 | 0.85 |  |
| Jeremy Mayes | 9 | multiple | 500197746 | Ramsey, Jeremy — British artist, born 1932, active 1956 | 0.88 |  |
| Christopher James Dayman | 8 | multiple | 500073778 | James, Christopher — American photographer, born 1947 | 0.90 |  |
| Jane Robbins | 8 | multiple | 500330712 | Robbins, Andrea — American photographer, born 1963 | 0.87 |  |
| Eduardo Benito | 7 | multiple | 500678324 | Cantero, Benito — Spanish photographer, flourished 1950-1974 | 0.82 |  |
| Erin Clark | 7 | multiple | 500521638 | Clark, Gerod — American architect, 1937-1975 | 0.83 |  |
| Sam Toft | 7 | multiple | 500037063 | Tata, Sam — Indian photographer, born 1911, active in China, India and Canada | 0.87 |  |
| Jeremy Harnell | 6 | multiple | 500632897 | Harvey, Jeremy — English designer, 1945- | 0.92 |  |
| Hannah Cole | 5 | multiple | 500058487 | Vowles, Hannah — British artist and critic, born 1952 | 0.90 |  |
| Nick Cranston | 5 | multiple | 500476115 | Cornish, Nick — British photojournalist, 1966-2017 | 0.87 |  |
| Barbara Cotton | 4 | multiple | 500132603 | Cotton, Alan — British artist, born 1936 | 0.81 |  |
| Caroline Maria Applebee | 4 | multiple | 500579481 | Ellerbeck, Caroline — Dutch artist, 1975- | 0.82 |  |
| Ellen Giggenbach | 4 | multiple | 500353137 | Sebring, Ellen — artist | 0.83 |  |
| J. Howard Miller ⚑ pooled | 4 | multiple | 500001822 | Miller, John — British painter, active 1876-1909 | 0.75 | pools `john-wilsher` ×3 — Ray Charles/Muddy Waters posters are not Miller's |
| Albert Moore | 3 | multiple | 500224431 | Moore, Robert — Australian architect, contemporary | 0.87 | the node also has Wikidata Q1399837; the ULAN is an Australian architect |
| Isabelle Carr | 3 | multiple | 500046155 | Carr, Leslie — British draftsman, active 20th century | 0.85 |  |
| Aldo Cosomati | 2 | multiple | 500064756 | Coutine, Aldo — French architect, active mid- to late 20th century, Mans | 0.88 |  |
| Bella Freud | 2 | multiple | 500351434 | Feldman, Bella — artist | 0.88 |  |
| Eric ⚑ pooled | 2 | multiple | 500116076 | Riel, Eric — American artist, contemporary | 0.68 | pools two artists (`eric`, `eric-ravilious`); name is a truncation |
| Harriet Meserole | 2 | multiple | 500464064 | Kriegel, Harriet — American filmmaker, contemporary | 0.84 |  |
| Kem McNair | 2 | multiple | 500011956 | McNair, James — American artist, active 1965 | 0.80 |  |
| Michelangelo | 2 | multiple | 500094712 | Spada, Michelangelo — Italian painter, active ca. 1730 | 0.69 | ULAN pick is a c.1730 painter; a 'Michelangelo Buonarroti' node (1 work) exists |
| Sir Edwin Henry Landseer | 2 | multiple | 500447639 | Fitler, Edwin Henry — American politician and merchant, 1825-1896 | 0.89 | correct record exists: 500004856 *Landseer, Edwin*; 2 ULAN-less Landseer nodes elsewhere |
| Adeline Meilliez | 1 | multiple | 500034446 | Herder, Adeline — American sculptor, active ca. 1976 | 0.83 |  |
| Adolphe William Bouguereau | 1 | multiple | 500635690 | Lambrecht, Adolphe William — Belgian painter, 1876-1940 | 0.86 | correct record exists: 500011205 *Bouguereau, William-Adolphe* |
| Alex Zeilinger | 1 | multiple | 500729166 | Lindeboom, Alex — Dutch artist, 1942- | 0.78 |  |
| Alfred George Stevens | 1 | multiple | 500028090 | Stannard, Alfred George — English landscapist, genre painter, and still life painter, 1828-1885 | 0.90 | 'Stevens, Alfred' 500030207 exists but I could not tell which Stevens is meant |
| Barrie Clark | 1 | multiple | 500019266 | Cook, Barrie — English painter, sculptor, 1929-2020 | 0.87 |  |
| Bridget Davies | 1 | multiple | 500724660 | Gillespie, Bridget — English watercolorist, 1962- | 0.84 |  |
| Carlo Egler | 1 | multiple | 500005063 | Gennari, Carlo — Italian lawyer, painter, 1712-1790 | 0.83 |  |
| Charles Burton | 1 | multiple | 500201008 | Burton, Charles — American painter, active 1819-1842 | 1.00 |  |
| Charles Paine | 1 | multiple | 500094475 | France, Charles — British artist, active 1881-1892 | 0.88 |  |
| Christopher Richard Wynne Nevinson | 1 | multiple | 500225911 | Seddon, Christopher Richard — British architect, contemporary | 0.82 | correct id 500031355 is already on the 206-work node — merge, don't re-key |
| Denise Duplock | 1 | multiple | 500193159 | Dutton, Denise —  sculptor, 20th century | 0.87 |  |
| Frederick Ramsdell | 1 | multiple | 500119096 | Campbell, Frederick — American painter, born 1926 | 0.90 |  |
| Gillian Condy | 1 | multiple | 500097329 | Lowndes, Gillian — British ceramicist, born 1936 | 0.87 |  |
| Henry Clarke | 1 | multiple | 500347065 | Clarke, Shirley — American filmmaker, 1919-1997 | 0.83 |  |
| J Bisson | 1 | strong | 500107019 | Bisson, Jacques — French painter, died 1737 | 0.84 |  |
| Kelly Hall | 1 | multiple | 500198079 | Kelly, Paul — British artist, born 1968 | 0.87 |  |
| Orla Kiely | 1 | multiple | 500120933 | Barry, Orla — Irish installation artist, photographer, and writer, born 1969 | 0.79 |  |
| P J Bellenger | 1 | unresolved | 500041587 | Bellenger, Albert — French printmaker 1846-after 1914 | 0.49 | tier was `unresolved` (0.49) yet the ULAN was written |
| P de Pannemaeker | 1 | multiple | 500679748 | De Campigneulles — French photographer, flourished 1850-1874 | 0.66 |  |
| Patrick Adam | 1 | multiple | 500676320 | Landmann, Patrick — French photographer, 1955- | 0.90 |  |
| Pierre Joseph Buchoz | 1 | multiple | 500440401 | Bultos, Pierre Joseph — Belgian owner, 1759- | 0.92 | no ULAN record with this surname surfaced at all |

## 6. Proposed write plan — all of it needs your go-ahead

**Step 0 — stop the source (precondition; without it a re-ingest puts the wrong ULANs back).** `SET a.ulanUrl = coalesce(a.ulanUrl, …)` re-applies whatever the resolver returns the next time `king_mcgaw_ingest.py` runs, and the resolver returns a candidate at every tier. I have not touched the resolver. The smallest ingest-side change is to accept `resolved_ulan` in `prepare_item_record()` only for `high_confidence_auto`, or for `single_candidate_strong` with the stored name score ≥ 0.98 (that rule keeps all of A1 and 17 of A2's 18, drops *Charles C. Ebbets* at 0.94 — a correct match — and rejects the one `single_candidate_strong` failure, J Bisson at 0.84). Everything else falls through to the existing `wikidataUrl` / `name:` key. Belt and braces for the labels: a small denylist of non-person names next to `king_mcgaw_exclusions.py`. **Trade-off:** the gate also drops A3 (17 real people at tier `multiple_candidates`) on a fresh ingest, so they'd need a small verified-override table (name → ULAN) to keep theirs.

**Step 1 — null the ULAN on B, C, D, E, G (64 nodes).** Per node: `REMOVE a.ulanUrl`, `SET a.identityConfidence = 'unresolved'`, and record the old value under a property that is *not* an identity key (`a.ulanUrlRetracted`, plus a reason/timestamp). Match on `elementId` **and** the expected current `ulanUrl` **and** re-assert "all works are `km-cw-`" inside the write, so it cannot touch anything that changed since this audit. Write a pre-snapshot JSON first (the repo's `km_artist_removal_presnapshot_*.json` convention) so it can be rolled back exactly.

**Step 2 — canonical-URL guard.** Removal is guard-safe: `is_canonical(None)` is True, `artist_ulanurl` permits missing values, and `check_ulan_url_canonical.py` layer 3 only looks at non-null values. Layer 2 (no hand-built ULAN URLs) is respected because the write script only deletes and copies an existing canonical string. Run the guard before and after. I did not run it in this audit; my own query found 0 non-canonical values and 0 ids shared between nodes across the whole graph, which is what its layer 3 asserts.

**Step 3 — undo the pooling (separate approval).** Split the four pooled nodes by slug (§3a). After Step 1 these can't grow, but the mixed works remain.

**Step 4 — optional, separate approval.** Merge the correct-person duplicates (Nevinson → the 206-work node; Landseer, Bouguereau, Michelangelo, Hassall, Kawase, Burne-Jones, Alma-Tadema, Goya, Veronese and the like) via the existing tooling, and repair group C's names. Do that with exact-field evidence only; the fuzzy-matching feedback in this repo applies to identity decisions generally.

## 7. Decisions I need from you

1. Approve Step 1 as written (64 nodes), or trim groups (e.g. keep G's contemporary artists nulled but leave the historical ones for re-resolution).
2. Approve an ingest-side confidence gate (Step 0) — and choose gate-plus-override-table or gate-only. Without it, Step 1 does not last.
3. Whether to relabel the A3 tier. Their stored `identityConfidence` says `multiple_candidates`, which is untrue after verification; a value like `manual_verified` would keep any future `identityConfidence`-based filter honest, but it introduces a new tier value.
4. Whether `original-film-posters` / `original-film-stills` / `cinema-greats` deserve the exclusion treatment after a spot-check of the KM pages.
5. Group F: leave as-is (proposed), or null.

## 8. Method and limits

- **Population:** `MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)`, keep artists where every `cw.id` starts `km-cw-`. 116 nodes, 113 with a ULAN, all canonical, none sharing an id.
- **ULAN names** come from the local mirror `knowledge_graph/ulan_local.sqlite` (built 2026-09-11), not live Getty; `Artist.ulanNameResolved` is null on all 113. The mirror has all 113 ids.
- **Candidate replay** used the resolver's own `_search_ulan` and `_name_match_score` against the mirror, without the Wikidata step. The stored ULAN was the replay's top candidate in 108 of 113 cases (the rest sit at rank 1–2, mostly ties on score), so the replay reproduces the ingest well, but it is a replay.
- **Verdicts** rest on name, ULAN dates/medium, and the first work titles. I did not open the King & McGaw listing pages, so group B's "no designer credit" is unchecked, and A-group confirmations are not independent of the name match beyond dates and titles.
- **Not audited:** the 45 mixed nodes; nodes whose works are not `km-cw-`.
- Everything touching the data was read-only (read-mode Neo4j sessions; the SQLite mirror opened `mode=ro`). The only things created are this document and the git worktree/branch it lives on (`audit/km-artist-ulan`); the audit scripts are in the session scratchpad, not the repo.

## 9. Outcome — applied 2026-09-19

Decisions taken: null the 64 (groups B, C, D, E, G); null the 3 stub records (group F); exclude the film-poster and cinema labels; review the 17 confirmed-at-`multiple_candidates` nodes (group A3) together before touching them.

**Exclusion.** Between the proposal and this write, another session had already excluded and removed `Original Film Posters` (5 works; slugs `original-film-posters` and `original-film-stills`) — it is in `king_mcgaw_exclusions.py` with its own reasoning. This step therefore added only **`cinema-greats`**: slug and name added to `king_mcgaw_exclusions.py`, and 4 works, 4 source records, 4 edition runs, 4 images and the `Cinema Greats` artist removed with `remove_km_artist_records.py` (snapshot `km_artist_removal_presnapshot_2026-09-19T095920.json`, all preconditions passed). The four listing pages were **not** opened, so unlike the other two entries this exclusion rests on the label being a collection name, and says so in the module. `check_poster_evidence_isolation.py`: all live checks ok.

**Nulling: 65 nodes, not 67.** 64 + 3 stubs = 67, minus the two label nodes the exclusions had already deleted (`Original Film Posters`, `Cinema Greats`) = 65 (G 47, B 7, C 5, F 3, D 2, E 1). Done by `knowledge_graph/retract_km_artist_ulan.py` (KM-ULAN-RETRACT-1.0) from `km_ulan_retraction_plan_2026-09-19.json`. Every node was re-verified against the live graph first (one node of that name, ulanUrl still the audited value, King & McGaw-only): 65 verified, 0 refused, 65 retracted. Each node keeps its `name` and works, loses `ulanUrl`, gets `identityConfidence = 'unresolved'`, and records the old values in `ulanUrlRetracted`, `ulanUrlRetractedReason`, `ulanUrlRetractedAt`, `identityConfidencePrior`. Rollback: `python3 retract_km_artist_ulan.py --rollback km_ulan_retraction_presnapshot_2026-09-19T100259.json`.

**Checks after the write.** `check_ulan_url_canonical.py`: all three layers pass (0 non-canonical, 0 shared ids). 114 King & McGaw-only nodes remain (116 less the 2 deleted): 46 with a ULAN — exactly group A — and 65 with a retraction record; none has both.

**Group A3 — kept and relabelled (17 nodes).** Reviewed against every work title (17 nodes, 55 works): every one is a recognisable work by the named artist and the ULAN dates fit (Las Meninas and the Rokeby Venus; the Arnolfini Portrait; Burne-Jones's *Pomona*, 1884; Veronese's *Family of Darius*; Cardinaux's Palace Hotel St. Moritz poster; Hassall's *Skegness is SO Bracing*; Redouté's and Snelling's botanical plates). Weakest: Claude Stanfield Moore (one Thames view, name and dates only), Francois Frederic Grobon (two horticultural plates). On the owner's decision all 17 keep their `ulanUrl` (untouched) and `identityConfidence` went from `multiple_candidates` to **`manual_verified`**, with `identityConfidencePrior`, `identityVerifiedAt` and `identityVerifiedBasis` recorded. Done by `knowledge_graph/verify_km_artist_ulan.py` (KM-ULAN-VERIFY-1.0) from `km_ulan_verify_plan_2026-09-19.json`; the live graph held exactly these 17 as `multiple_candidates`-with-a-ULAN, 17 verified, 0 refused. Rollback: `python3 verify_km_artist_ulan.py --rollback km_ulan_verify_presnapshot_2026-09-19T101129.json`. `manual_verified` is a new tier value; no code in the repo filters on a fixed set of tiers and every ingest writes the field with `coalesce`, so nothing overwrites it. It is documented in `08_ackg_schema_definition.md`. The `check_ulan_url_canonical.py` guard passes again after this write.

**Final state of the 114 King & McGaw-only nodes:** 65 `unresolved` with a retraction record and no ULAN · 3 `unresolved` with no ULAN (Mirrorpix, VeeBee, Kelways) · 18 `single_candidate_strong` · 11 `high_confidence_auto` · 17 `manual_verified`. No `multiple_candidates` remains on any of them.

**Still open.**
1. **Not durable.** The ingest is unchanged (§6 step 0), so re-ingesting these artists writes the wrong ULANs back, and can re-resolve the 17 verified names to a different candidate (the tier survives, since ingests use `coalesce`, but the ULAN is only protected while it is already set). No gate was requested or added. If one is, the 17 names in `km_ulan_verify_plan_2026-09-19.json` are its override table.
2. ~~Pooled nodes~~ — split, see §10.
3. **Merges not done because they are not exact matches:** Bouguereau, Michelangelo (mononym), Edwin Landseer, the Nevinson typo variants (`Christopher R. W. Nevinson`, `Christopher Ricahrd Wynne Nevinson`), `Hans Holbein Younger`, and two ULAN-less nodes that are now exact duplicates of survivors — `Edward Burne-Jones` (of `Edward Coley Burne-Jones`) and `Francisco Goya` (of `Francisco José de Goya`). The other 11 pairs are done, see §10.

## 10. Pooled-node split and duplicate merges — applied 2026-09-19

Both run by `knowledge_graph/repair_km_artist_identity.py` (KM-ARTIST-REPAIR-1.0) from reviewed plans. Each subcommand first rehearses the whole change inside a transaction, restores it with the rollback code, checks the touched nodes came back byte-for-byte, and discards the transaction; only then does `--apply` commit. Both rehearsals passed before their commits.

**Split (6 works).** The `ConceptualWork` ids already carried the true artist, so only the Artist and `ATTRIBUTED_TO` edges moved (qualifier `direct` preserved). *Cuckmere Haven, 1939* → the existing `Eric Ravilious` (24 → 25 works, ULAN 500014911 untouched); *B B King*, *Muddy Waters*, *Ray Charles* → new `John Wilsher`; *The Ambassadors*, *A Lady with a Squirrel and a Starling* → new `Hans Holbein The Younger` (both created with exactly the raw catalog's spelling, no ULAN). This corrects §3a: under Holbein the "After" credit is *King Henry VIII*, not the Lady with a Squirrel. `Eric` (1 work), `J. Howard Miller` (1) and `After Hans Holbein the Younger` (1) now hold only their own. `posterWorkCount`/`hasPosterCatalog` recomputed on all six touched nodes (`candidate_title_merges.py` selects poster works by that flag). Rollback: `python3 repair_km_artist_identity.py split --rollback km_artist_repair_split_presnapshot_2026-09-19T102822.json`.

**Merges (11 pairs).** The King & McGaw-only node was folded into the node for the same person with `merge_artists.merge_pair` (ARTIST-MERGE-3.1, from `fix/artist-merge-qualifier`; needs the repo's `venv-splink` interpreter for `jellyfish`). Every pair is exact under the repo's own name normalisation or is a name recorded on the KM node's verified ULAN record; per-pair evidence is in `km_duplicate_merge_plan_2026-09-19.json`. One candidate was rejected on inspection: `Sir Joshua Reynolds` ↔ `J.R` matched only because a ULAN alternate name is bare initials, and `J.R` is a 1971-born artist.

| Survivor | Folded in | ULAN on survivor |
|---|---|---|
| Christopher Richard Wynne Nevinson ARA (207 works) | Christopher Richard Wynne Nevinson | 500031355, kept |
| Edwin Henry Landseer | Sir Edwin Henry Landseer | none |
| Edward Coley Burne-Jones | Sir Edward Coley Burne-Jones | 500001381, inherited, `manual_verified` |
| Lawrence Alma-Tadema | Sir Lawrence Alma-Tadema | 500008100, inherited, `high_confidence_auto` |
| Charles Hullmandel | Charles Joseph Hullmandel | 500041156, inherited, `single_candidate_strong` |
| Emil Cardinaux | Emile Cardinaux | 500021057, inherited, `manual_verified` |
| Francisco José de Goya (227 works) | Francisco de Goya | 500118936, inherited, `single_candidate_strong` |
| John Hassall | Hassall | 500001686, inherited, `manual_verified` |
| Kawase Hasui | Hasui Kawase | 500333884, inherited, `manual_verified` |
| Paolo Veronese | Paolo Caliari Veronese | 500021218, inherited, `manual_verified` |
| Pierre-Joseph Redouté (18 works) | Pierre Joseph Celestin Redouté | 500005678, inherited, `manual_verified` |

Where a ULAN moved from the deleted node to the survivor it was removed from the deleted node first (`artist_ulanurl` is a uniqueness constraint), then set on the survivor with the deleted node's tier; the survivor's old tier is in `identityConfidencePrior` and the source in `ulanInheritedFrom`. Aliases are kept in `alternateNames`. Rollback: `venv-splink/bin/python repair_km_artist_identity.py merge --rollback km_artist_repair_merge_presnapshot_2026-09-19T102858.json` — exercised only inside the rehearsal, never against committed data.

**Checks after both writes.** `check_ulan_url_canonical.py`: all three layers pass. `check_poster_evidence_isolation.py`: all live checks ok. All 11 deleted nodes confirmed gone; every survivor's work count is its old count plus the folded node's.
