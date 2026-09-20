"""
PrintMasterAI — Roseberys multi-work lot ingest (per-work records)
Version: ROSEBERYS-MULTI-INGEST-0.1

Takes roseberys_multi_work_parse.py's output and writes ONE Impression + SourceRecord per work,
each carrying its share of the lot's money, per docs/plans/2026-09-19-roseberys-multi-work-lots.md.

Why per work and not one lot-level record with N DOCUMENTS edges: every price consumer
(pricing_ml/export_sales.py, query_comparables.ts) reads `s.hammerPriceGBP` from the record
attached to the impression. A lot-level record would hand each of the N impressions the whole
lot's price. So the split sits in the ordinary price fields and the allocation is recorded
alongside it:

    priceAllocation   whole_lot (every pre-existing record, null) | equal_split |
                      whole_lot_with_ancillary
    allocationShare   1/N
    lotWorkCount      N                 lotPart         this work's position
    lotHammerPrice / lotPriceRealised / lotEstimateLow / lotEstimateHigh / lotReserve
                      the published whole-lot figures, kept verbatim
    lotRecordId       shared by the sibling records of one lot
    lotParseMethod    parser version + model

Consumers must filter to whole_lot before any equal_split record with a PRICE lands — that gate
is step 1 of the plan and is NOT done yet. Unsold lots are safe to load ahead of it: both
consumers require a price > 0, so an estimate-only record cannot reach them.

`signed` is dropped unless the catalogue attributed it to that work specifically: "one signed in
pencil" over two sheets says nothing about WHICH, and a model asked for a per-work boolean will
happily guess (qwen-plus did, on A0793 lot 20). The test is whether the work's evidence quote
differs from its siblings' — identical quotes mean the model had no per-work evidence to read.

ARTIST RESOLUTION BEFORE CREATION. A bare `MERGE (a:Artist {name: ...})` creates a node for
any spelling it has not seen, which is how A0793 lot 29 landed under "Elizabeth Frink" — two
works, no ULAN — while the graph's 291 Frink works sit under "Elisabeth Frink", the artist's
own spelling. Nothing failed; the records were simply invisible as same-artist to the entire
corpus, and the valuation only got the right priors because Stage 2b resolves the artist
independently. So this script resolves first: an exact name or a recorded alternateName is
used as-is, and a name that merely LOOKS like an existing artist refuses the run and names the
candidates. It never picks a near match on its own — that is how the alias-shadowing dupes got
made. --allow-new-artist is the deliberate override for a genuinely new artist.

THE DERIVED PRICE FIELDS ARE WRITTEN HERE TOO. Every comps query reads `hammerPriceGBP` and
`saleDate`, not `hammerPrice` — and both are normally produced by separate backfills
(`backfill_fx_gbp.py`, `backfill_roseberys_sale_dates.py`) that run over a whole source after
ingest. A per-lot ingest sits outside that flow, so on 2026-09-20 the Sorel portfolio from
A0777 lot 52 was written with its £440 hammer and was STILL invisible: no hammerPriceGBP, no
saleDate, so `select_comps` could not see it and the A0793 lot 30 valuation ran with zero
comps — the exact evidence the ingest had just been extended to capture. Same shape as the
embedding gap above: the record is right, the field the consumer reads is missing.

Roseberys prices are GBP, so the conversion is the identity and the contract is the one
backfill_fx_gbp.py writes: rate 1.0, GBP fields equal to native, and a non-positive value left
unset rather than stored as zero.

IMAGES ARE EMBEDDED IN THE SAME RUN. Every other Roseberys image reaches the vector index
because the sale-scoped embedder (roseberys_embed_images.py) runs over a whole sale after
ingest. A per-work ingest writes DigitalImage nodes OUTSIDE that flow, so on 2026-09-20 it
left A0793 lot 20's two images as the only unembedded impressions in a 366-impression sale —
and the defect surfaced only when the spelling-variant scan parked a four-work cluster in
`noImage` because of one of them. A half-indexed image raises no error: Stage 1d and every
similarity rule simply never see it. So this script now calls the same embedder for the images
it wrote, checks the service is reachable BEFORE writing anything, and reports any image it
could not embed rather than exiting quietly. --no-embed skips it deliberately.

Writes a pre-snapshot of everything it will touch before touching it, like the other repair
scripts here. --dry-run (the default) writes nothing.

Usage (source .env first):
    python3 roseberys_multi_work_ingest.py --in parsed.json
    python3 roseberys_multi_work_ingest.py --in parsed.json --execute
"""

import argparse
import difflib
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import requests
from neo4j import GraphDatabase

import roseberys_embed_images as embedder
from crosswalk_matching import extract_techniques, extract_papers
from resolve_artist_identity import strip_honorifics
from catalogue_matching import parse_catalogue_refs, genuine_refs, build_conceptual_work_id, \
    resolve_merged_work_cypher

INGEST_VERSION = "ROSEBERYS-MULTI-INGEST-0.2"
HOUSE = "Roseberys London"
SALE_DATES_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "roseberys_sale_dates.json")


def sale_date_for(sale_code):
    """The sale's date from backfill_roseberys_sale_dates.py's cache. An upcoming sale is not in
    it yet, which is why --sale-date exists; a null date only costs the record its place in the
    comps query, and an unsold lot has no price to contribute anyway."""
    try:
        with open(SALE_DATES_CACHE) as fh:
            return (json.load(fh).get("sales", {}).get(sale_code) or {}).get("saleDate")
    except FileNotFoundError:
        return None


def gbp(value):
    """backfill_fx_gbp.py's rule: a non-positive figure is a placeholder, not a value."""
    return float(value) if value is not None and float(value) > 0 else None


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source .env first.")
    return value


def check_embedding_service():
    """Reachable before the write, so a missing service is a refusal rather than a silent gap."""
    try:
        r = requests.get(f"{embedder.EMBED_SERVICE_URL}/health", timeout=10)
        r.raise_for_status()
        models = r.json().get("models", {})
    except Exception as exc:
        raise RuntimeError(
            f"the embedding service at {embedder.EMBED_SERVICE_URL} is not reachable ({exc}). "
            "Start it, or pass --no-embed to write the records and embed later with "
            "`roseberys_embed_images.py --sale <SALE>`.")
    print(f"[EMBED] service ok, models={models}", flush=True)


def embed_written_images(rows):
    """Embed exactly the images this run wrote, through the same service and the same write
    query the sale-scoped embedder uses — an indexed vector and a Stage 1d query vector have to
    come from identical model weights (ADR-0015)."""
    wanted = [r for r in rows if r["imageUrl"]]
    if not wanted:
        print("[EMBED] no images to embed")
        return
    done, failed = [], []
    for row in wanted:
        img_id = row["objectId"] + "-image"
        try:
            raw, mime, _ = embedder.image_bytes({"sourceUrl": row["imageUrl"]})
            dino, clip = embedder.embed(raw, mime)
            done.append({"imgId": img_id, "dino": dino["vector"], "dinoModel": dino.get("model"),
                         "dinoDim": len(dino["vector"]), "clip": clip["vector"],
                         "clipModel": clip.get("model"), "clipDim": len(clip["vector"]),
                         "now": datetime.now(timezone.utc).isoformat()})
        except Exception as exc:
            failed.append((img_id, str(exc)))
    if done:
        embedder.write_chunk(done)
    print(f"[EMBED] embedded={len(done)} failed={len(failed)}")
    for img_id, why in failed:
        print(f"  [EMBED-FAIL] {img_id}: {why}")
    if failed:
        print("  re-run: python3 roseberys_embed_images.py --sale <SALE>")


def _fold_name(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z ]+", " ", s.lower()).strip()


ARTIST_LOOKUP_QUERY = """
MATCH (a:Artist)
RETURN a.name AS name, coalesce(a.alternateNames, []) AS alternateNames,
       a.ulanUrl IS NOT NULL AS hasUlan
"""


def resolve_artists(session, names, allow_new=False):
    """name-as-parsed -> the Artist name to write. Raises on a near miss (see docstring)."""
    rows = session.run(ARTIST_LOOKUP_QUERY).data()
    exact = {r["name"]: r["name"] for r in rows}
    alias = {}
    for r in rows:
        for alt in r["alternateNames"]:
            alias.setdefault(_fold_name(alt), r["name"])
    folded = {}
    for r in rows:
        folded.setdefault(_fold_name(r["name"]), r["name"])

    resolved, problems = {}, []
    for name in sorted(set(names)):
        if name in exact:
            resolved[name] = name
            continue
        key = _fold_name(name)
        if key in folded:
            resolved[name] = folded[key]
            print(f"[ARTIST] {name!r} -> {folded[key]!r} (same name, different case or accents)")
            continue
        if key in alias:
            resolved[name] = alias[key]
            print(f"[ARTIST] {name!r} -> {alias[key]!r} (recorded alternateName)")
            continue
        close = difflib.get_close_matches(key, list(folded), n=4, cutoff=0.9)
        if close and not allow_new:
            problems.append((name, [folded[c] for c in close]))
            continue
        if close:
            print(f"[ARTIST] creating {name!r} despite near matches {[folded[c] for c in close]} "
                  f"(--allow-new-artist)")
        resolved[name] = name
    if problems:
        lines = [f"  {n!r} looks like existing artist(s): {', '.join(repr(c) for c in cands)}"
                 for n, cands in problems]
        raise RuntimeError(
            "refusing to create an Artist node that resembles one already in the graph:\n"
            + "\n".join(lines)
            + "\nMerge the duplicate first (merge_artists.py pairs), or pass --allow-new-artist "
              "if this really is a different person.")
    return resolved


def _share(value, n):
    return round(float(value) / n, 2) if value is not None else None


def build_rows(record):
    """One parser result -> one row per work. Returns (rows, skip_reason).

    `single` lots produce ONE row at the FULL lot price, not a share: a lot the gate called one
    work is one work. That covers a complete portfolio, which the house issues, sells and prices
    as a single object — splitting it would invent n titles and divide the money on no evidence,
    while holding it loses a real comp (the same Sorel portfolio sold at A0777 lot 52 for £440
    and was invisible to the A0793 lot 30 valuation)."""
    if record["decision"] not in ("split", "single"):
        return [], f"decision is {record['decision']}: {'; '.join(record['reasons'])}"
    text, vision = record["text"], record.get("vision")
    kind = text["lot_kind"]
    works = text["works"]
    sale, lot = record["sale"], record["lot"]
    lot_id = f"roseberys-{sale.lower()}-lot{lot}"

    photo_for = {}
    if vision:
        photo_for = {a["work_position"]: a["photo_index"] for a in vision["assignments"]}
    urls = record.get("photo_urls") or []

    # A single lot is one record at the whole price. `n = 1` makes every share below a no-op,
    # so the money fields stay exactly as the house published them.
    if record["decision"] == "single":
        n = 1
        expanded = [(works[0], 1)] if works else []
        if not expanded:
            return [], f"decision single but no work extracted ({kind})"
    # identical_copies: one work, N impressions of it, each carrying 1/N of the money.
    elif kind == "identical_copies":
        n = works[0]["copies"]
        expanded = [(works[0], i + 1) for i in range(n)]
    else:
        n = len(works)
        expanded = [(w, w["position"]) for w in works]

    evidences = [w["evidence"] for w in works]
    per_work_evidence = len(set(evidences)) == len(evidences) and kind != "identical_copies"

    money = record.get("money") or {}
    sale_date = record.get("saleDate") or sale_date_for(sale)
    rows = []
    for work, part in expanded:
        artist = strip_honorifics(work["artist"] or record.get("artist") or "")
        title = (work["title"] or "").strip() or f"Untitled ({sale} lot {lot} part {part})"
        refs = genuine_refs(parse_catalogue_refs(work.get("catalogue_refs")))
        object_id = lot_id if record["decision"] == "single" else f"{lot_id}-w{part}"
        dims = (f"{work['width_cm']}x{work['height_cm']}cm"
                if work.get("width_cm") and work.get("height_cm") else None)
        dim_kind = (work.get("dim_kind") or "").strip().lower()
        # A split work gets the photo the vision pass matched to it. A single lot has no vision
        # pass, so it takes the lot's primary image — which for a portfolio is the right picture
        # anyway: the group shot IS the object being sold.
        photo_idx = (0 if record["decision"] == "single"
                     else photo_for.get(work["position"] if kind != "identical_copies" else 1))
        medium = work.get("medium") or ""
        rows.append({
            "objectId": object_id,
            "conceptualWorkId": build_conceptual_work_id(
                source_prefix="roseberys", artist_name=artist, title=title,
                catalogue_refs=refs, fallback_id=object_id),
            "saleId": sale,
            "lotNumber": lot,
            "artistName": artist,
            "title": title,
            "dateYear": work.get("year"),
            "rawMedium": medium or None,
            "techniques": extract_techniques(medium),
            "papers": extract_papers(f"{medium} {work.get('support') or ''}"),
            "sheetDimensions": dims if dim_kind in ("sheet", "each sheet", "overall", "") else None,
            "imageDimensions": dims if dim_kind == "image" else None,
            "plateDimensions": dims if dim_kind == "plate" else None,
            "editionSize": work.get("edition_size"),
            # see module docstring — a shared evidence quote cannot tell us who signed
            "signed": bool(work["signed"]) if (per_work_evidence and work["signed"] is not None)
                      else None,
            "catalogueRefs": refs,
            "listingUrl": record["url"],
            "imageUrl": urls[photo_idx] if photo_idx is not None and photo_idx < len(urls) else None,
            # money: this work's share, with the lot's own figures kept beside it
            "estimateLow": _share(money.get("estimateLow"), n),
            "estimateHigh": _share(money.get("estimateHigh"), n),
            "reserve": _share(money.get("reserve"), n),
            "hammerPrice": _share(money.get("hammerPrice"), n),
            "priceRealised": _share(money.get("priceRealised"), n),
            "priceCurrency": money.get("priceCurrency", "GBP"),
            "sold": bool(money.get("sold")),
            # What the comps queries actually read. Roseberys is GBP, so rate 1.0 and the GBP
            # fields equal the native ones — written here rather than left to a later backfill.
            "hammerPriceGBP": gbp(_share(money.get("hammerPrice"), n)),
            "priceRealisedGBP": gbp(_share(money.get("priceRealised"), n)),
            "estimateLowGBP": gbp(_share(money.get("estimateLow"), n)),
            "estimateHighGBP": gbp(_share(money.get("estimateHigh"), n)),
            "fxRateToGBP": 1.0,
            "saleDate": sale_date,
            "lotEstimateLow": money.get("estimateLow"),
            "lotEstimateHigh": money.get("estimateHigh"),
            "lotReserve": money.get("reserve"),
            "lotHammerPrice": money.get("hammerPrice"),
            "lotPriceRealised": money.get("priceRealised"),
            "priceAllocation": ("whole_lot_with_ancillary" if kind == "single_work_with_ancillary"
                                else "whole_lot" if record["decision"] == "single"
                                else "equal_split"),
            "allocationShare": round(1.0 / n, 4),
            "lotWorkCount": n,
            "lotPart": part,
            # A complete portfolio is one object made of several plates; the count is a fact
            # about the object, not a number of works, and nothing may divide the price by it.
            "portfolioPlateCount": (text.get("declared_count")
                                    if kind == "complete_portfolio" else None),
            "ancillaryItems": text.get("ancillary_items") or [],
            "lotRecordId": f"{lot_id}-record",
            "lotKind": kind,
            "lotParseMethod": record.get("parser", INGEST_VERSION),
        })
    return rows, None


LOAD_QUERY = """
UNWIND $rows AS row

MERGE (artist:Artist {name: row.artistName})
SET artist.identityConfidence = coalesce(artist.identityConfidence, "unresolved")

""" + resolve_merged_work_cypher('row.conceptualWorkId', ['row', 'artist']) + """
SET cw.name = coalesce(cw.name, row.title),
    cw.dateCreated_year = coalesce(cw.dateCreated_year, row.dateYear),
    cw.dateCreated_precision = coalesce(cw.dateCreated_precision, "exact")
MERGE (artist)-[:CREATED]->(cw)

MERGE (er:EditionRun {id: row.objectId + "-er"})
SET er.dateRange_year = row.dateYear,
    er.dateRange_precision = "exact",
    er.declaredSize = row.editionSize
MERGE (cw)-[:PRINTED_AS]->(er)

MERGE (imp:Impression {id: row.objectId})
SET imp.sheetDimensions = row.sheetDimensions,
    imp.imageDimensions = row.imageDimensions,
    imp.plateDimensions = row.plateDimensions,
    imp.rawMedium = row.rawMedium,
    imp.signed = row.signed
MERGE (er)-[:INCLUDES]->(imp)

MERGE (src:SourceRecord {id: row.objectId + "-record"})
SET src.sourceType = "auction",
    src.institutionName = $house,
    src.saleId = row.saleId,
    src.lotNumber = row.lotNumber,
    src.estimateLow = row.estimateLow,
    src.estimateHigh = row.estimateHigh,
    src.reserve = row.reserve,
    src.hammerPrice = row.hammerPrice,
    src.priceRealised = row.priceRealised,
    src.priceCurrency = row.priceCurrency,
    src.sold = row.sold,
    src.hammerPriceGBP = row.hammerPriceGBP,
    src.priceRealisedGBP = row.priceRealisedGBP,
    src.estimateLowGBP = row.estimateLowGBP,
    src.estimateHighGBP = row.estimateHighGBP,
    src.fxRateToGBP = row.fxRateToGBP,
    src.fxSource = "ingest (GBP source, identity conversion)",
    src.saleDate = row.saleDate,
    src.listingUrl = row.listingUrl,
    src.priceAllocation = row.priceAllocation,
    src.allocationShare = row.allocationShare,
    src.lotWorkCount = row.lotWorkCount,
    src.lotPart = row.lotPart,
    src.lotRecordId = row.lotRecordId,
    src.lotKind = row.lotKind,
    src.lotEstimateLow = row.lotEstimateLow,
    src.lotEstimateHigh = row.lotEstimateHigh,
    src.lotReserve = row.lotReserve,
    src.lotHammerPrice = row.lotHammerPrice,
    src.lotPriceRealised = row.lotPriceRealised,
    src.lotParseMethod = row.lotParseMethod,
    src.portfolioPlateCount = row.portfolioPlateCount,
    src.lotAncillaryItems = CASE WHEN size(row.ancillaryItems) > 0 THEN row.ancillaryItems ELSE null END
MERGE (src)-[:DOCUMENTS]->(imp)
MERGE (src)-[att:ATTRIBUTED_TO]->(artist)
SET att.qualifier = "direct"

FOREACH (_ IN CASE WHEN row.imageUrl IS NOT NULL THEN [1] ELSE [] END |
  MERGE (img:DigitalImage {id: row.objectId + "-image"})
  SET img.sourceUrl = row.imageUrl, img.imageType = "listing_photo"
  MERGE (img)-[:SHOWS]->(imp)
)

WITH row, imp, cw
UNWIND row.techniques AS tech
MERGE (t:Technique {name: tech.name})
FOREACH (_ IN CASE WHEN tech.aatId IS NOT NULL THEN [1] ELSE [] END | SET t.aatId = tech.aatId)
MERGE (imp)-[:USES_TECHNIQUE]->(t)

WITH row, imp, cw
UNWIND (CASE WHEN size(row.papers) = 0 THEN [null] ELSE row.papers END) AS paper
FOREACH (_ IN CASE WHEN paper IS NOT NULL THEN [1] ELSE [] END |
  MERGE (p:Paper {name: paper.name})
  MERGE (imp)-[:PRINTED_ON]->(p)
  SET p.aatId = CASE WHEN paper.aatId IS NOT NULL THEN paper.aatId ELSE p.aatId END
)

WITH row, cw
UNWIND row.catalogueRefs AS ref
MERGE (cr:CatalogueRaisonne {numberingPrefix: ref.catalogueName})
MERGE (ce:CatalogueEntry {id: ref.catalogueName + "-" + ref.entryNumber})
SET ce.number = ref.entryNumber
MERGE (cr)-[:CONTAINS]->(ce)
MERGE (ce)-[:DOCUMENTS]->(cw)
"""

SNAPSHOT_QUERY = """
UNWIND $ids AS id
OPTIONAL MATCH (imp:Impression {id: id})
OPTIONAL MATCH (src:SourceRecord {id: id + "-record"})
OPTIONAL MATCH (img:DigitalImage {id: id + "-image"})
RETURN id, properties(imp) AS impression, properties(src) AS sourceRecord,
       properties(img) AS image
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", required=True, help="roseberys_multi_work_parse.py output")
    ap.add_argument("--execute", action="store_true", help="actually write (default: dry run)")
    ap.add_argument("--sale-date", help="ISO sale date for a sale not yet in "
                                        "roseberys_sale_dates.json (an upcoming catalogue)")
    ap.add_argument("--allow-new-artist", action="store_true",
                    help="create an Artist node even when an existing one has a similar name")
    ap.add_argument("--no-embed", action="store_true",
                    help="skip embedding the images this run writes (they stay out of the "
                         "vector index until roseberys_embed_images.py runs over the sale)")
    args = ap.parse_args()

    records = json.load(open(args.infile))
    rows, skipped = [], []
    for rec in records:
        if args.sale_date:
            rec["saleDate"] = args.sale_date
        r, why = build_rows(rec)
        rows.extend(r)
        if why:
            skipped.append((rec["sale"], rec["lot"], why))

    print(f"{len(records)} parsed lots -> {len(rows)} per-work records; {len(skipped)} lots skipped")
    for sale, lot, why in skipped:
        print(f"  skip {sale} lot {lot}: {why}")

    # Resolve artists BEFORE the dry-run listing, so a near-miss refuses the run while it is
    # still a dry run rather than after a write. This is a read; it needs the graph either way.
    if rows:
        _require_env("NEO4J_PASSWORD")
        lookup = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                      auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
        try:
            with lookup.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
                resolved = resolve_artists(session, [r["artistName"] for r in rows],
                                           allow_new=args.allow_new_artist)
        finally:
            lookup.close()
        for r in rows:
            r["artistName"] = resolved[r["artistName"]]
    for row in rows:
        print(f"  {row['objectId']}: {row['title']!r} | {row['rawMedium']} | "
              f"est {row['estimateLow']}-{row['estimateHigh']} of lot "
              f"{row['lotEstimateLow']}-{row['lotEstimateHigh']} | share {row['allocationShare']} | "
              f"signed={row['signed']} | photo={'yes' if row['imageUrl'] else 'NO'}")
    if not rows:
        return
    if not args.execute:
        print("\nDRY RUN — nothing written. Re-run with --execute.")
        return

    if not args.no_embed:
        # Fail before writing, not after: an ingest that leaves half-indexed images behind is
        # invisible until something trips over it. See embed_written_images().
        check_embedding_service()
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    database = os.environ.get("NEO4J_DATABASE", "neo4j")
    stamp = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    snap_path = f"multi_work_ingest_presnapshot_{stamp}.json"
    with driver.session(database=database) as session:
        before = session.run(SNAPSHOT_QUERY, ids=[r["objectId"] for r in rows]).data()
        json.dump(before, open(snap_path, "w"), indent=1, default=str)
        print(f"pre-snapshot of the {len(before)} target ids written to {snap_path}")
        session.run(LOAD_QUERY, rows=rows, house=HOUSE)
        after = session.run(
            "UNWIND $ids AS id MATCH (s:SourceRecord {id: id + '-record'})-[:DOCUMENTS]->(i:Impression) "
            "OPTIONAL MATCH (img:DigitalImage)-[:SHOWS]->(i) "
            "OPTIONAL MATCH (:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(i) "
            "RETURN id, cw.name AS work, s.estimateLow AS estLow, s.estimateHigh AS estHigh, "
            "s.priceAllocation AS allocation, s.lotPart AS part, s.lotWorkCount AS of, "
            "img.sourceUrl IS NOT NULL AS hasImage",
            ids=[r["objectId"] for r in rows]).data()
        for a in after:
            print("  wrote", a)
    driver.close()
    if args.no_embed:
        print("[EMBED] skipped (--no-embed); these images are NOT in the vector index yet")
    else:
        embed_written_images(rows)


if __name__ == "__main__":
    main()
