"""
PrintMasterAI — Navigart network ingestion into the ACKG (Neo4j)
Version: NAVIGART-INGEST-0.1

Loads the PUBLIC-DOMAIN tier of the Videomuseum/Navigart network — records the holding
museum itself marks `copyright: "Domaine public"` AND publishes an image for. Survey,
with the full-population numbers behind every figure quoted here:
`knowledge_graph/navigart_network_source_survey_2026-09-11.md`.

Reads the caches written by `navigart_fetch.py` and the name mapping written by
`navigart_resolve_artists.py`. Never the live API.

## Why a second Navigart adapter rather than a flag on the first

`picasso_paris_ingest.py` carries four rules that are true of Picasso-Paris and of no
other vault: the Geiser-Baer/Baer prefix alias, the comma-separated catalogue-reference
splitter, the MP3414 exclusion, and a five-name hand-written artist map. Vault 16 stays
with that adapter. This one covers the other 33 and shares the *parsing* — dates,
dimensions, state, edition, printer, papers, watermark — by importing it, so there is one
implementation of each rule rather than two that drift.

## What is different here, and why

1. **No catalogue references are mapped at all.** `number_catalogue` is 97% populated at
   Picasso-Paris and 0% across the rest of the network. In this tier exactly 14 records
   of 5,670 carry the field, and every one of them is a BARE NUMBER with no catalogue
   name — "478", "n° 709". Handing those to `parse_catalogue_refs` would manufacture
   prefix-less `CatalogueRaisonne` nodes of exactly the "974, Cramer bk." shape already
   polluting the graph from the auction adapters. Fourteen records are not worth adding
   to that, so the field is dropped and recorded as UNMAPPED.

2. **Artist identity comes from a generated, auditable mapping, not a hand-written
   dict.** 714 distinct names over 33 collections is past the scale of the five-entry
   tables in `bm_ingest.py`/`picasso_paris_ingest.py`. See `navigart_resolve_artists.py`
   for the matching rule (exact normalised key, never similarity) and for the three
   refusals. Records whose author was refused are EXCLUDED from the load and written to
   `navigart_excluded_records.csv` — 68 of 5,670, almost all anonymous primaries and
   bare single-surname names.

3. **Multi-author strings resolve on the first author only**, with the full raw string
   kept on the impression as `secondaryAuthorsNote`. "AUDRAN Benoît I, LE BRUN Charles"
   is Audran engraving after Le Brun's design; Navigart puts the maker first but does not
   say what the others did — only 14 of 217 such records carry any role marker at all
   ("d'après"). A second `CREATED` edge inferred from an unstated role would be a
   fabricated fact, so the string is carried and the edge is not drawn.

4. **The matrix test is a prefix, not an equality.** Picasso-Paris spells it
   `domain_denomination == "Estampe, Matrice"`; the rest of the network qualifies the
   material inline — `Estampe, Matrice bois` (74 records here), `Estampe, Matrice cuivre`
   (13). An equality test silently routes all 87 woodblocks and copper plates through the
   impression pipeline as if they were prints.

5. **The French technique table is extended, locally.** `picasso_paris_ingest`'s
   `_FR_TECHNIQUES` resolves 92% of this tier unchanged. The additions below close most
   of the rest and were all read off the actual unresolved tail, not anticipated. They
   are defined HERE rather than pushed into the Picasso adapter's table because that
   table is calibrated against a Picasso catalogue and this one is not: `_FR_EXTRA` is
   layered on top at call time, so neither adapter can silently change the other's
   output. The same "one vocabulary, the adapter with the language problem carries it"
   discipline as the shared English crosswalk.

   What is deliberately NOT added: bare `Gravure` (21 records), `Gravure sur papier`
   (15), `Gravure en couleur(s)` (4) and bare `Estampe` (79). French *gravure* covers the
   whole intaglio-and-relief family; forcing it to "Engraving" would assert a specific
   process the museum did not. Those load with `techniqueResolved = false`, exactly as
   the Picasso adapter treats its own vocabulary gaps, and land in
   `navigart_unresolved_techniques.csv`.

## Rights

Every record here is public domain *as asserted by the holding museum about its own
holding* — not inferred by us from a death date. Survey §8 records the rest of the
position: none of the contributing museums publishes a `Content-Signal` TDM reservation
(unlike Picasso-Paris, which does and is therefore metadata-only), and Art. 14 of the EU
DSM Directive provides that reproductions of public-domain visual works are not
themselves protected unless the reproduction is original.

`DigitalImage.license` and `.rightsReservation` are still written on every image node —
`rightsReservation` carries the source's own per-record reproduction flag verbatim where
the vault publishes one, and says so explicitly where it does not. Absence of a flag is
recorded as absence, never as clearance.

Usage:
    python knowledge_graph/navigart_ingest.py --dry-run
    python knowledge_graph/navigart_ingest.py --vault 11 --limit 50
    python knowledge_graph/navigart_ingest.py --all
"""

import argparse
import csv
import glob
import json
import os
import re
import time

from neo4j import GraphDatabase

from crosswalk_matching import extract_techniques
from catalogue_matching import build_conceptual_work_id, resolve_merged_work_cypher
from picasso_paris_ingest import (
    _clean, _fr_normalize, _FR_TECHNIQUES, _LITHO_MARKS, _LITHO_MATRICES, _PRINTER_RE,
    _SIGNATURE_RE, extract_edition, extract_matrix_material, extract_printer,
    extract_state, extract_watermark, parse_date_creation, parse_dimensions,
    resolve_papers,
)
from navigart_fetch import VAULTS, CACHE_DIR
from navigart_resolve_artists import split_authors
from ulan_url import canonical_ulan_url

HERE = os.path.dirname(os.path.abspath(__file__))
RESOLUTION_PATH = os.path.join(HERE, "navigart_artist_resolution.json")
UNRESOLVED_TECHNIQUES_PATH = os.path.join(HERE, "navigart_unresolved_techniques.csv")
EXCLUDED_PATH = os.path.join(HERE, "navigart_excluded_records.csv")

IMAGE_SIZE_PX = 1000  # 1200 -> 404, 2000 -> 415. Long-edge ceiling, verified per survey §2.
IMAGE_LICENSE = ("Public domain (museum-asserted: copyright field = 'Domaine public'); "
                 "reproduction per EU DSM Art.14")
NO_FLAG_PUBLISHED = "no reproduction flag published by source"

# Front-ends that are NOT served under www.navigart.fr/<slug>/ — these two publish on
# their own domains and the navigart.fr path 404s. Checked live, both shapes.
LISTING_BASE = {
    14: "https://collection.cnap.fr",
    15: "https://collection.centrepompidou.fr",
}

# Module docstring point 5. Layered ON TOP of picasso_paris_ingest._FR_TECHNIQUES at call
# time; that table is never mutated. Every entry below was read off the unresolved tail
# of the actual 5,670-record fetch.
_FR_EXTRA = {
    # "typographie" is already in the base table but the adjectival form is what this
    # network actually writes: "Cliché typographique sur papier" (72 records) is an
    # impression pulled from a photo-engraved relief block.
    "typographique": "letterpress",
    "cliché typographique": "letterpress",
    # "bois de fil" (long-grain -> woodcut) is in the base table; "bois de bout" is
    # end-grain, which is wood engraving and a different process. Must precede the bare
    # "bois sur papier" fallback, which `_fr_normalize` guarantees by sorting keys
    # longest-first.
    "bois de bout": "wood engraving",
    "bois sur papier": "woodcut",
    "pointe-sèche": "drypoint",             # hyphenated variant of the base table's entry
    "taille douce": "intaglio",             # umbrella term; the shared crosswalk suppresses
    "taille-douce": "intaglio",             # it when a named intaglio method is also present
    "gravure sur cuivre": "engraving",
    # "Manière de crayon (sanguine) sur papier vergé" is crayon-manner ENGRAVING — a roulette
    # intaglio process whose entire purpose is imitating a chalk drawing, which is exactly why
    # it read as a drawing to the non-print audit and why it resolved to nothing. Must precede
    # nothing in particular, but note `_LITHO_MARKS` contains "crayon": the litho rule needs a
    # lithographic MATRIX ("sur pierre"/"sur zinc") alongside it, and these say "sur papier
    # vergé", so there is no false lithograph here.
    "manière de crayon": "crayon manner",
    "maniere de crayon": "crayon manner",
    "algraphie": "lithograph",              # aluminium-plate lithography
    "report sur pierre": "lithograph",
    "reproduction photomécanique": "photomechanical print",
    "photomécanique": "photomechanical print",
    "phototypie": "collotype",
    "héliogravure": "photogravure",
}

_MATRIX_PREFIX = "Estampe, Matrice"        # docstring point 4
_DAPRES_RE = re.compile(r"d['’]apr[eè]s", re.IGNORECASE)

# `inventory` is this adapter's identity key — `Impression.id` is built from it — so a
# placeholder in that field is not a harmless blank, it is a COLLIDING key. Two Nantes
# records both carry the literal string "à inventorier?" ("to be inventoried?"), and in
# the first load they MERGE'd onto one Impression node: one record silently overwrote the
# other and the load came back one row short of what was mapped. Exact strings, read off
# the data — not a pattern, because a pattern over accession formats across 33
# institutions would throw away real accessions.
PLACEHOLDER_ACCESSIONS = {"à inventorier", "à inventorier?", "non inv.", "sans numéro",
                          "sans numero", "n.c.", "?"}


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set — see knowledge_graph/.env.example")
    return value


def resolve_techniques(mst):
    """Same three steps as the Picasso adapter's — strip the printer clause so
    'tirée par Fort' contributes no vocabulary, translate French to the shared English
    crosswalk's terms, delegate — with `_FR_EXTRA` layered over the base table."""
    if not mst:
        return [], False
    body = _PRINTER_RE.sub(" ", mst.lower())
    table = dict(_FR_TECHNIQUES)
    table.update(_FR_EXTRA)
    normalized = _fr_normalize(body, table)
    if (any(mark in body for mark in _LITHO_MARKS)
            and any(mx in body for mx in _LITHO_MATRICES)):
        normalized += " lithograph "
    techniques = extract_techniques(normalized)
    return techniques, bool(techniques)


def load_resolution():
    if not os.path.exists(RESOLUTION_PATH):
        raise RuntimeError(
            f"{RESOLUTION_PATH} not found. Run "
            f"`python knowledge_graph/navigart_resolve_artists.py` first — it needs the "
            f"live graph, so it cannot be regenerated from the cache alone.")
    payload = json.load(open(RESOLUTION_PATH, encoding="utf-8"))
    return payload["resolution"], payload["refused"]


def load_caches(vaults=None, tier="pd-image"):
    """Returns [(vault, slug, institution, [ua payloads])]."""
    out = []
    for path in sorted(glob.glob(os.path.join(CACHE_DIR, f"*_{tier}.json"))):
        payload = json.load(open(path, encoding="utf-8"))
        if vaults and payload["vault"] not in vaults:
            continue
        if not payload["records"]:
            continue
        out.append((payload["vault"], payload["slug"], payload["institution"],
                    payload["records"]))
    if not out:
        raise RuntimeError(
            f"No non-empty caches at tier={tier} in {CACHE_DIR}. Run "
            f"`python knowledge_graph/navigart_fetch.py --all` first.")
    return out


def listing_url(vault, slug, artwork_slug):
    base = LISTING_BASE.get(vault, f"https://www.navigart.fr/{slug}")
    return f"{base}/artwork/{artwork_slug}" if artwork_slug else None


def is_after(artwork, primary):
    """True when the print is AFTER the primary-listed author rather than by them.

    `authors_list` order is normally maker-first ("AUDRAN Benoît I, LE BRUN Charles" —
    Audran engraved Le Brun's design), and the structured `authors` array types every
    contributor identically as "artiste", so there is no role field to read. But three
    Nantes records invert it: "SANZIO Raffaello dit RAPHAËL, BOURGEOIS Charles" is
    Bourgeois engraving after Raphael, and the only evidence for that in the record is
    `recap_authors`, which spells the primary out as "SANZIO Raffaello dit RAPHAËL
    (d'après)". Matched as an exact substring against the primary's own name, so it fires
    on those three and nothing else — checked across all 5,670 records.

    The wider limitation stands and is NOT solved here: where the order is inverted and
    `recap_authors` says nothing, the designer is recorded as the maker. Survey §10."""
    raw = artwork.get("authors_list") or ""
    if _DAPRES_RE.search(raw):
        return True
    recap = artwork.get("recap_authors") or ""
    return bool(re.search(re.escape(primary) + r"\s*\(d['’]apr[eè]s\)", recap))


def classify(artwork, resolution):
    inventory = (artwork.get("inventory") or "").strip()
    if not inventory or inventory.lower() in PLACEHOLDER_ACCESSIONS:
        return "excluded_no_inventory"
    raw = (artwork.get("authors_list") or "").strip()
    if raw not in resolution:
        return "excluded_unresolved_artist"
    if (artwork.get("domain_denomination") or "").strip().startswith(_MATRIX_PREFIX):
        return "matrix"
    return "impression"


def map_record(record, vault, slug, resolution):
    artwork = record["artwork"]
    inventory = _clean(artwork.get("inventory"))
    object_id = f"navigart{vault}-{re.sub(r'[^A-Za-z0-9.-]', '_', inventory)}"

    raw_author = (artwork.get("authors_list") or "").strip()
    artist = resolution[raw_author]
    authors = split_authors(raw_author)
    secondary = ", ".join(authors[1:]) or None

    title = _clean(artwork.get("title_list")) or f"Untitled ({inventory})"
    mst = _clean(artwork.get("mst"))
    tirage = _clean(artwork.get("tirage"))

    date = parse_date_creation(artwork.get("date_creation"))
    sheet_dims, plate_dims = parse_dimensions(artwork.get("dimensions"))
    techniques, technique_resolved = resolve_techniques(mst)
    state_number, state_label = extract_state(f"{mst or ''} {tirage or ''}")
    edition_number, edition_size = extract_edition(tirage)

    # Docstring point 1: no catalogue refs from this source, so the conceptual-work id
    # falls back to the object id and every impression here is its own work. That is the
    # honest shape — without a catalogue citation there is nothing to join impressions
    # on, and joining them on title alone is the fuzzy identity matching this project
    # has been burned by.
    conceptual_work_id = build_conceptual_work_id(
        source_prefix=f"navigart{vault}",
        artist_name=artist["canonicalName"],
        title=title,
        catalogue_refs=[],
        fallback_id=object_id,
    )

    medias = artwork.get("medias") or []
    image_url = None
    if medias and medias[0].get("file_name"):
        image_url = (medias[0]["url_template"]
                     .replace("{size}", str(IMAGE_SIZE_PX))
                     .replace("{file_name}", medias[0]["file_name"]))

    flags = artwork.get("artw_reproduction_rights")
    if isinstance(flags, list):
        flags = " + ".join(flags)
    reservation = _clean(flags) or NO_FLAG_PUBLISHED

    printer = None
    collaborators = _clean(artwork.get("collaborators"))
    if collaborators and collaborators.lower().startswith("imprimeur"):
        printer = _clean(collaborators.split(":", 1)[1]) if ":" in collaborators else None
    printer = printer or extract_printer((mst, tirage))

    inscriptions = _clean(artwork.get("inscriptions"))
    return {
        "objectId": object_id,
        "conceptualWorkId": conceptual_work_id,
        "navigartId": artwork.get("_id"),
        "accessionNumber": inventory,
        "artistName": artist["canonicalName"],
        "artistRawName": raw_author,
        "artistUlanUrl": canonical_ulan_url(artist.get("ulanUrl")),
        "artistMatchRule": artist["matchRule"],
        "secondaryAuthorsNote": secondary,
        "afterArtist": is_after(artwork, authors[0]),
        "title": title,
        "dateYear": date["year"],
        "dateEndYear": date["endYear"],
        "datePrecision": date["precision"],
        "dateDisplayLabel": date["displayLabel"],
        "rawMedium": mst,
        "techniques": techniques,
        "techniqueResolved": technique_resolved,
        "papers": resolve_papers(mst, tirage),
        "watermarkNote": extract_watermark(f"{mst or ''} {tirage or ''}"),
        "sheetDimensions": sheet_dims,
        "plateDimensions": plate_dims,
        "stateNumber": state_number,
        "stateLabel": state_label,
        "stateId": (f"{conceptual_work_id}-state-{state_number}"
                    if state_number is not None else None),
        "editionNumber": edition_number,
        "editionSize": edition_size,
        "printer": printer,
        "matrixMaterial": extract_matrix_material(mst)
                          or extract_matrix_material(artwork.get("domain_denomination")),
        "provenanceNote": _clean(artwork.get("old_owners")),
        "inscriptionNote": inscriptions,
        "signed": bool(_SIGNATURE_RE.search(inscriptions or "")),
        "acquisition": _clean(artwork.get("acquisition")),
        "imageUrl": image_url,
        "imageLicense": IMAGE_LICENSE,
        "imageRightsReservation": reservation,
        "sourceCopyright": _clean(artwork.get("copyright")),
        "listingUrl": listing_url(vault, slug, artwork.get("slug")),
    }


# ---------------------------------------------------------------- Cypher
# Same node/edge shapes as picasso_paris_ingest.py, minus the CatalogueRaisonne tail
# (docstring point 1). Every SET on a shared node coalesces so a second source cannot
# overwrite a value an earlier one established.

_COMMON_TAIL = """
FOREACH (_ IN CASE WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END |
  MERGE (img:DigitalImage {id: row.objectId + "-image"})
  SET img.sourceUrl = row.imageUrl,
      img.imageType = "primary",
      img.license = row.imageLicense,
      img.rightsReservation = row.imageRightsReservation
  MERGE (img)-[:SHOWS]->(target)
)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "institutional",
    src.institutionName = $institutionName,
    src.accessionNumber = row.accessionNumber,
    src.listingUrl = row.listingUrl,
    src.sourceCopyright = row.sourceCopyright,
    src.artistMatchRule = row.artistMatchRule
MERGE (src)-[:DOCUMENTS]->(target)
MERGE (src)-[att:ATTRIBUTED_TO]->(artist)
SET att.qualifier = CASE WHEN row.afterArtist THEN "after" ELSE "direct" END
"""

LOAD_QUERY_IMPRESSION = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.ulanUrl = coalesce(artist.ulanUrl, row.artistUlanUrl),
    artist.identityConfidence = coalesce(artist.identityConfidence,
        CASE WHEN row.artistUlanUrl IS NOT NULL THEN "institutional" ELSE "unresolved" END),
    artist.alternateNames = CASE
        WHEN row.artistRawName IS NOT NULL AND NOT row.artistRawName IN coalesce(artist.alternateNames, [])
        THEN coalesce(artist.alternateNames, []) + row.artistRawName
        ELSE artist.alternateNames
    END

""" + resolve_merged_work_cypher("row.conceptualWorkId", ["row", "artist"]) + """
SET cw.name = coalesce(cw.name, row.title),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_endYear = coalesce(cw.dateCreated_endYear, row.dateEndYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, row.datePrecision),
    cw.dateCreated_displayLabel = coalesce(cw.dateCreated_displayLabel, row.dateDisplayLabel)
MERGE (artist)-[:CREATED]->(cw)

MERGE (er:EditionRun {id: row.objectId + "-er"})
SET er.dateRange_year = row.dateYear,
    er.dateRange_precision = row.datePrecision,
    er.declaredSize = row.editionSize
MERGE (cw)-[:PRINTED_AS]->(er)

FOREACH (_ IN CASE WHEN row.stateId IS NOT NULL THEN [1] ELSE [] END |
  MERGE (st:State {id: row.stateId})
  SET st.stateNumber = row.stateNumber,
      st.displayLabel = coalesce(st.displayLabel, row.stateLabel),
      st.traditionType = "western_plate_state"
  MERGE (st)-[:PRINTED_AS]->(er)
)

FOREACH (_ IN CASE WHEN row.printer IS NOT NULL THEN [1] ELSE [] END |
  MERGE (printer:Publisher {name: row.printer})
  MERGE (er)-[:PRINTED_BY]->(printer)
)

MERGE (imp:Impression {id: row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.plateDimensions = row.plateDimensions,
    imp.rawMedium = row.rawMedium,
    imp.techniqueResolved = row.techniqueResolved,
    imp.stateLabel = row.stateLabel,
    imp.editionNumber = row.editionNumber,
    imp.copyType = "numbered",
    imp.signed = row.signed,
    imp.inscriptionNote = row.inscriptionNote,
    imp.provenanceNote = row.provenanceNote,
    imp.secondaryAuthorsNote = row.secondaryAuthorsNote
MERGE (er)-[:INCLUDES]->(imp)

WITH row, artist, cw, imp AS target

UNWIND (CASE WHEN size(row.techniques) = 0 THEN [null] ELSE row.techniques END) AS tech
FOREACH (_ IN CASE WHEN tech IS NOT NULL THEN [1] ELSE [] END |
  MERGE (t:Technique {name: tech.name})
  SET t.aatId = CASE WHEN tech.aatId IS NOT NULL THEN tech.aatId ELSE t.aatId END
  MERGE (target)-[:USES_TECHNIQUE]->(t)
)

WITH DISTINCT row, artist, cw, target
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END,
      p.watermarkNote = coalesce(row.watermarkNote, p.watermarkNote)
  MERGE (target)-[:PRINTED_ON]->(p)
)

WITH DISTINCT row, artist, cw, target
""" + _COMMON_TAIL

LOAD_QUERY_MATRIX = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.ulanUrl = coalesce(artist.ulanUrl, row.artistUlanUrl),
    artist.identityConfidence = coalesce(artist.identityConfidence,
        CASE WHEN row.artistUlanUrl IS NOT NULL THEN "institutional" ELSE "unresolved" END)

""" + resolve_merged_work_cypher("row.conceptualWorkId", ["row", "artist"]) + """
SET cw.name = coalesce(cw.name, row.title),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, row.datePrecision),
    cw.dateCreated_displayLabel = coalesce(cw.dateCreated_displayLabel, row.dateDisplayLabel)
MERGE (artist)-[:CREATED]->(cw)

MERGE (mx:Matrix {id: row.objectId})
SET mx.material = row.matrixMaterial,
    mx.rawMedium = row.rawMedium,
    mx.provenanceNote = row.provenanceNote
MERGE (artist)-[:MADE_MATRIX]->(mx)
MERGE (cw)-[:REALIZED_AS]->(mx)

FOREACH (_ IN CASE WHEN row.stateId IS NOT NULL THEN [1] ELSE [] END |
  MERGE (st:State {id: row.stateId})
  SET st.stateNumber = row.stateNumber,
      st.displayLabel = coalesce(st.displayLabel, row.stateLabel),
      st.traditionType = "western_plate_state"
  MERGE (mx)-[:HAS_STATE]->(st)
)

WITH row, artist, cw, mx AS target
""" + _COMMON_TAIL


def _write_chunk_with_retry(query, rows, institution, retries=4, backoff_seconds=5.0):
    last_error = None
    for attempt in range(retries):
        driver = GraphDatabase.driver(
            _require_env("NEO4J_URI"),
            auth=(_require_env("NEO4J_USER"), _require_env("NEO4J_PASSWORD")))
        try:
            with driver.session(database=_require_env("NEO4J_DATABASE")) as session:
                session.run(query, rows=rows, institutionName=institution).consume()
            return
        except Exception as e:
            last_error = e
            print(f"[WRITE RETRY {attempt + 1}/{retries}] {e}", flush=True)
            if attempt < retries - 1:
                time.sleep(backoff_seconds * (attempt + 1))
        finally:
            driver.close()
    raise RuntimeError(f"Chunk write failed after {retries} attempts: {last_error}")


def _report_paths(vaults, limit):
    """The two CSVs are review artifacts covering the WHOLE network, and `run()` rewrites
    them from whatever it just processed. A scoped run (`--vault 24`, `--limit 50`) would
    therefore silently replace 269 unresolved-technique rows across 13 institutions with
    the 7 from one vault — a partial file that looks complete, which is the same failure
    shape as the silent-zero domain filter this adapter already guards against. It
    happened: a one-vault re-run on 2026-09-11 truncated both files and the truncation was
    committed before anyone read the line counts.

    So a scoped run writes scope-suffixed files and leaves the canonical ones alone."""
    if not vaults and not limit:
        return UNRESOLVED_TECHNIQUES_PATH, EXCLUDED_PATH, None
    scope = ("v" + "-".join(str(v) for v in sorted(vaults))) if vaults else "scoped"
    if limit:
        scope += f"-limit{limit}"
    suffix = f".{scope}.csv"
    return (UNRESOLVED_TECHNIQUES_PATH.replace(".csv", suffix),
            EXCLUDED_PATH.replace(".csv", suffix), scope)


def run(vaults=None, limit=None, dry_run=False, chunk_size=200, tier="pd-image"):
    resolution, refused = load_resolution()
    caches = load_caches(vaults, tier=tier)
    unresolved_path, excluded_path, scope = _report_paths(vaults, limit)
    if tier != "pd-image":
        # The review CSVs are per-tier for the same reason they are per-scope: a tier-2
        # run must not overwrite the public-domain tier's record with its own.
        suffix = f".{tier}.csv"
        unresolved_path = unresolved_path.replace(".csv", suffix)
        excluded_path = excluded_path.replace(".csv", suffix)

    all_mapped, excluded_rows, unresolved_rows = [], [], []
    totals = {"impression": 0, "matrix": 0, "excluded_no_inventory": 0,
              "excluded_unresolved_artist": 0}

    for vault, slug, institution, records in caches:
        if limit:
            records = records[:limit]
        buckets = {"impression": [], "matrix": [],
                   "excluded_no_inventory": [], "excluded_unresolved_artist": []}
        for record in records:
            buckets[classify(record.get("artwork") or {}, resolution)].append(record)
        for kind in totals:
            totals[kind] += len(buckets[kind])

        for kind in ("excluded_no_inventory", "excluded_unresolved_artist"):
            for record in buckets[kind]:
                artwork = record.get("artwork") or {}
                raw = (artwork.get("authors_list") or "").strip()
                excluded_rows.append([
                    institution, artwork.get("inventory"), artwork.get("title_list"),
                    raw, kind,
                    (refused.get(raw) or {}).get("reason") or "",
                ])

        mapped = {kind: [map_record(r, vault, slug, resolution) for r in buckets[kind]]
                  for kind in ("impression", "matrix")}
        for row in mapped["impression"] + mapped["matrix"]:
            if not row["techniqueResolved"]:
                unresolved_rows.append([institution, row["accessionNumber"], row["title"],
                                        row["rawMedium"]])
        all_mapped.append((vault, institution, mapped))
        print(f"[CLASSIFY] v{vault:<3} {institution[:42]:<42} "
              f"impressions={len(mapped['impression']):>5} matrices={len(mapped['matrix']):>4} "
              f"excluded={len(buckets['excluded_no_inventory']) + len(buckets['excluded_unresolved_artist'])}",
              flush=True)

    rows = [r for _, _, m in all_mapped for r in m["impression"] + m["matrix"]]
    print(f"\n[MAPPED] {len(rows)} rows | "
          f"states={sum(1 for r in rows if r['stateId'])} "
          f"printers={sum(1 for r in rows if r['printer'])} "
          f"images={sum(1 for r in rows if r['imageUrl'])} "
          f"techniques_resolved={sum(1 for r in rows if r['techniqueResolved'])} "
          f"sheet_dims={sum(1 for r in rows if r['sheetDimensions'])} "
          f"editions={sum(1 for r in rows if r['editionSize'])}", flush=True)
    print(f"[EXCLUDED] {totals['excluded_no_inventory']} no inventory, "
          f"{totals['excluded_unresolved_artist']} unresolved artist", flush=True)

    with open(excluded_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["institution", "accessionNumber", "title", "authorsRaw",
                         "bucket", "refusalReason"])
        writer.writerows(excluded_rows)
    with open(unresolved_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["institution", "accessionNumber", "title", "rawMedium"])
        writer.writerows(unresolved_rows)
    print(f"[FILES] {len(excluded_rows)} -> {excluded_path}\n"
          f"        {len(unresolved_rows)} -> {unresolved_path}", flush=True)
    if scope:
        print(f"[FILES] scoped run ({scope}) — the network-wide "
              f"{os.path.basename(UNRESOLVED_TECHNIQUES_PATH)} and "
              f"{os.path.basename(EXCLUDED_PATH)} were left untouched. Regenerate them with "
              f"`--dry-run` over all vaults.", flush=True)

    if dry_run:
        print("[DRY RUN] nothing written", flush=True)
        return all_mapped

    for vault, institution, mapped in all_mapped:
        for kind, query in (("impression", LOAD_QUERY_IMPRESSION),
                            ("matrix", LOAD_QUERY_MATRIX)):
            batch = mapped[kind]
            for chunk_start in range(0, len(batch), chunk_size):
                chunk = batch[chunk_start:chunk_start + chunk_size]
                _write_chunk_with_retry(query, chunk, institution)
                print(f"[PROGRESS] v{vault} {kind} "
                      f"{chunk_start + len(chunk)}/{len(batch)}", flush=True)
    print("[DONE]", flush=True)
    return all_mapped


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", type=int, action="append", help="Vault id (repeatable)")
    parser.add_argument("--all", action="store_true", help="Every cached vault")
    parser.add_argument("--limit", type=int, help="Cap records per vault")
    parser.add_argument("--dry-run", action="store_true", help="Map and report, no writes")
    parser.add_argument("--tier", default="pd-image", choices=("pd-image", "all"),
                        help="Which navigart_fetch.py caches to load. 'all' is the "
                             "in-copyright tier — metadata only under ADR-0002 "
                             "Amendment 1 Decision 5.")
    args = parser.parse_args()

    if not args.all and not args.vault and not args.dry_run:
        parser.error("Provide --all, --vault N, or --dry-run")

    run(vaults=args.vault, limit=args.limit, dry_run=args.dry_run, tier=args.tier)
