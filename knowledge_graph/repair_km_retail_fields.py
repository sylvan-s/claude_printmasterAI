"""
PrintMasterAI — repair King & McGaw retail fields that the scraper synthesised rather than scraped.
Version: KM-RETAIL-FIELDS-REPAIR-1.0

`king_mcgaw_fetch.py` (through KING-MCGAW-FETCH-3.0) wrote three SourceRecord values the product page
does not contain:

    retailPriceMaxGBP          `price_min * 2.5` (or 135.0)  — measured 2026-09-19: equal to the
                               page's real highest variant price in 0 of 573 records
    retailPriceMinGBP          fell back to 35.0 when the price meta tag would not parse
                               (5 of 573 records carry that default)
    inInstitutionalPODArchive  a URL-substring / `price >= 40` guess — True on 565 of 573 records,
                               136 of them on pages whose own `is_pod` flag is False

`retailPriceMaxGBP` has since been dropped from the scraper and ingest altogether, so the repair
treats it as never supported: any stored value is nulled (a null property is an absent property in
Neo4j) and `--fill` never writes it.

Nothing under src/ reads any of them (guarded by check_poster_evidence_isolation.py), so this is data
honesty, not a live valuation fix.

For each King & McGaw SourceRecord (`km-sr-km-*`) the listing is fetched again and the stored value is
compared with what the page states today (`king_mcgaw_fetch.extract_retail_facts`, the same code the
scraper now uses):

    supported    stored value == what the page states      -> kept
    unsupported  anything else, incl. a stored False       -> set to null
    page gone    404/410 or no listingUrl                  -> all three set to null (nothing can support them)
    unverified   429/5xx/timeouts after retries            -> record left UNTOUCHED and reported; re-run

`inInstitutionalPODArchive` is only ever True or null: a page that names no partner is silent, not
evidence that the item is absent from an archive.

`--facts FILE` replaces the live re-scrape with a saved one (JSON: `KM-<id>` -> the dict
`extract_retail_facts` returns). Use it to repair from a re-scrape already taken, without sending
another 573 requests to King & McGaw. A graph record with no entry in the file is UNVERIFIED and left
untouched; the file's path and mtime are recorded in the snapshot.

By default the repair only nulls. `--fill` additionally writes the page's real value where it differs
from the stored one (e.g. the real listing price into retailPriceMinGBP); without it, real
values the page offers are reported but not written.

Every graph write is guarded on the value the plan was computed from, so a row edited since the plan
is skipped, not overwritten; and the snapshot is written before any write.

    python3 knowledge_graph/repair_km_retail_fields.py                       # DRY RUN (default): read graph, re-scrape, snapshot plan, no writes
    python3 knowledge_graph/repair_km_retail_fields.py --apply               # snapshot, then write
    python3 knowledge_graph/repair_km_retail_fields.py --apply --fill        # ... and write real page values too
    python3 knowledge_graph/repair_km_retail_fields.py --verify              # audit only, exits 1 on residue/unverified
    python3 knowledge_graph/repair_km_retail_fields.py --rollback <snapshot.json>

Snapshots (`km_retail_fields_repair_presnapshot_*.json`) are git-ignored; do not commit them.
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from king_mcgaw_fetch import HTTP_HEADERS, derive_institutional_pod, extract_retail_facts  # noqa: E402

VERSION = "KM-RETAIL-FIELDS-REPAIR-1.0"
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")

FIELDS = ("retailPriceMinGBP", "retailPriceMaxGBP", "inInstitutionalPODArchive")


def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""


def _same_sql(prop: str, param: str) -> str:
    """Null-safe equality: `sr.p = $x` alone is null (falsy) when both sides are null."""
    return f"((sr.{prop} IS NULL AND {param} IS NULL) OR sr.{prop} = {param})"


def _guard(side: str) -> str:
    return " AND ".join(_same_sql(f, f"row.{side}.{f}") for f in FIELDS)


def _assign(side: str) -> str:
    return ",\n    ".join(f"sr.{f} = row.{side}.{f}" for f in FIELDS)


# Label-scoped on purpose: an unlabelled MATCH would silently skip the id index.
TARGET_QUERY = """
MATCH (sr:SourceRecord)
WHERE sr.id STARTS WITH 'km-sr-km-'
RETURN sr.id AS id, sr.listingUrl AS url,
       sr.retailPriceMinGBP AS retailPriceMinGBP,
       sr.retailPriceMaxGBP AS retailPriceMaxGBP,
       sr.inInstitutionalPODArchive AS inInstitutionalPODArchive
ORDER BY id
"""

COUNTS_QUERY = """
MATCH (sr:SourceRecord)
WHERE sr.id STARTS WITH 'km-sr-km-'
RETURN count(sr) AS total,
       sum(CASE WHEN sr.retailPriceMinGBP IS NOT NULL THEN 1 ELSE 0 END) AS withMin,
       sum(CASE WHEN sr.retailPriceMaxGBP IS NOT NULL THEN 1 ELSE 0 END) AS withMax,
       sum(CASE WHEN sr.inInstitutionalPODArchive IS NOT NULL THEN 1 ELSE 0 END) AS withPod,
       sum(CASE WHEN sr.inInstitutionalPODArchive = true THEN 1 ELSE 0 END) AS podTrue
"""

# Applies `after` only where the row still holds `before` (null-safe): a row changed since the plan is skipped.
APPLY_QUERY = f"""
UNWIND $rows AS row
MATCH (sr:SourceRecord {{id: row.id}})
WHERE {_guard('before')}
SET {_assign('after')}
RETURN count(sr) AS n
"""

# Restores `before` only where the row still holds `after`, so later edits are not clobbered.
ROLLBACK_QUERY = f"""
UNWIND $rows AS row
MATCH (sr:SourceRecord {{id: row.id}})
WHERE {_guard('after')}
SET {_assign('before')}
RETURN count(sr) AS n
"""


# ── re-scrape ────────────────────────────────────────────────────────────────

def scrape_listing(url: Optional[str], retries: int = 5, delay: float = 0.5) -> Tuple[str, Optional[Dict[str, Any]], str]:
    """(status, facts, detail). status: ok | gone | error.

    404/410 (or no URL) is `gone`: the page is not there to support anything. Everything else that
    fails — 429 above all, which a burst of workers provokes, and a 200 that carries neither a price
    nor product data — is `error`, never `gone` or an empty `ok`: a rate limit or a degraded response
    must not be able to decide that a listing states nothing."""
    if not url:
        return "gone", None, "no listingUrl"
    detail = ""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                html = resp.read()
            time.sleep(delay)
            facts = extract_retail_facts(BeautifulSoup(html, "html.parser"))
            if facts["listing_price_gbp"] is None and facts["is_pod"] is None:
                # Every real product page carries a price meta tag or the product blob. A 200 with
                # neither is a degraded response (seen 2026-09-19 under load: two pages that
                # normally carry both), and must not read as "the page states nothing".
                detail = "HTTP 200 without a price or product data (degraded or non-product page)"
                time.sleep(1.0 * (attempt + 1))
                continue
            return "ok", facts, ""
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return "gone", None, f"HTTP {e.code}"
            detail = f"HTTP {e.code}"
            retry_after = e.headers.get("Retry-After", "") if e.headers else ""
            wait = float(retry_after) if retry_after.isdigit() else 2.0 * (attempt + 1) * (3 if e.code == 429 else 1)
            time.sleep(min(wait, 30.0))
        except Exception as e:  # noqa: BLE001 - network layer raises many types; all are "unverified"
            detail = f"{type(e).__name__}: {e}"
            time.sleep(1.0 * (attempt + 1))
    return "error", None, detail


def targets_from_facts(facts: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """What the page supports for each field; a gone page supports nothing."""
    if facts is None:
        return {f: None for f in FIELDS}
    return {
        "retailPriceMinGBP": facts["listing_price_gbp"],
        "retailPriceMaxGBP": None,  # no longer a field the scraper writes: nothing can support a stored value
        "inInstitutionalPODArchive": derive_institutional_pod(facts["is_pod"], facts["partner"]),
    }


# ── decision ─────────────────────────────────────────────────────────────────

def same_value(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    return abs(float(a) - float(b)) < 0.005


def plan_field(stored: Any, target: Any, fill: bool) -> Tuple[str, Any]:
    """(action, value to store). keep | null | fill."""
    if same_value(stored, target):
        return "keep", stored
    if target is not None and fill:
        return "fill", target
    if stored is None:
        return "keep", None  # nothing stored, and we are not filling
    return "null", None


def plan_record(stored: Dict[str, Any], status: str, facts: Optional[Dict[str, Any]], fill: bool) -> Optional[Dict[str, Any]]:
    """None when the record is unverified (left alone); otherwise the per-field plan."""
    if status == "error":
        return None
    targets = targets_from_facts(facts)
    actions, after = {}, {}
    for f in FIELDS:
        actions[f], after[f] = plan_field(stored.get(f), targets[f], fill)
    offered = {f: targets[f] for f in FIELDS
               if targets[f] is not None and not same_value(stored.get(f), targets[f])}
    return {"actions": actions, "after": after, "pageOffers": offered}


def cached_lookup(facts_by_id: Dict[str, Dict[str, Any]]):
    """A `fetch` for build_plan that reads a saved re-scrape instead of the site."""
    def look(rec: Dict[str, Any]) -> Tuple[str, Optional[Dict[str, Any]], str]:
        facts = facts_by_id.get("KM-" + rec["id"][len("km-sr-km-"):].upper())
        if facts is None or "error" in facts:
            return "error", None, "no usable entry in --facts file"
        return "ok", facts, ""
    return look


def build_plan(records: List[Dict[str, Any]], fill: bool, workers: int, delay: float, fetch=None) -> Dict[str, Any]:
    fetch = fetch or (lambda rec: scrape_listing(rec.get("url"), delay=delay))

    def one(rec):
        return rec, fetch(rec)

    scraped = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for i, (rec, res) in enumerate(ex.map(one, records), 1):
            scraped.append((rec, res))
            if i % 100 == 0 or i == len(records):
                print(f"  re-scraped {i}/{len(records)}", flush=True)

    rows, gone, unverified = [], [], []
    stats = Counter()
    for rec, (status, facts, detail) in scraped:
        stats[status] += 1
        plan = plan_record(rec, status, facts, fill)
        if plan is None:
            unverified.append({"id": rec["id"], "url": rec.get("url"), "detail": detail})
            continue
        if status == "gone":
            gone.append({"id": rec["id"], "url": rec.get("url"), "detail": detail})
        for f in FIELDS:
            stats[f"{f}:{plan['actions'][f]}"] += 1
        stats["pageOffers"] += bool(plan["pageOffers"])
        if any(a != "keep" for a in plan["actions"].values()):
            rows.append({
                "id": rec["id"], "url": rec.get("url"), "status": status,
                "before": {f: rec.get(f) for f in FIELDS},
                "after": plan["after"], "actions": plan["actions"],
            })
    return {"rows": rows, "gone": gone, "unverified": unverified, "stats": dict(stats)}


def report(plan: Dict[str, Any], n: int, fill: bool) -> None:
    s = plan["stats"]
    print(f"\n{n} King & McGaw SourceRecords | re-scrape: ok={s.get('ok', 0)} gone={s.get('gone', 0)} unverified={s.get('error', 0)}")
    for f in FIELDS:
        print(f"  {f:27s} keep={s.get(f + ':keep', 0):4d}  null={s.get(f + ':null', 0):4d}  fill={s.get(f + ':fill', 0):4d}")
    if not fill:
        print(f"  (page states a different value for {s.get('pageOffers', 0)} records; not written without --fill)")
    print(f"  {len(plan['rows'])} records change")
    for r in plan["rows"][:5]:
        print("   e.g.", r["id"], {f: (r["before"][f], "->", r["after"][f]) for f in FIELDS if r["actions"][f] != "keep"})
    if plan["gone"]:
        print(f"\n  {len(plan['gone'])} listings are GONE (404/410/no URL) — review these ids; invented or delisted records show up here:")
        for g in plan["gone"][:25]:
            print("   ", g["id"], "|", g["url"], "|", g["detail"])
    if plan["unverified"]:
        print(f"\n  {len(plan['unverified'])} records UNVERIFIED (rate limit / network), left untouched — re-run:")
        for u in plan["unverified"][:10]:
            print("   ", u["id"], "|", u["detail"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write the plan (default is a dry run)")
    mode.add_argument("--verify", action="store_true", help="audit only, no writes; exits 1 on residue or unverified records")
    mode.add_argument("--rollback", metavar="SNAPSHOT", help="restore before-values from a snapshot, no re-scrape")
    ap.add_argument("--fill", action="store_true", help="also write the page's real value where it differs from the stored one")
    ap.add_argument("--backup", help="snapshot path (default: knowledge_graph/km_retail_fields_repair_presnapshot_<ts>.json)")
    ap.add_argument("--facts", metavar="FILE", help="read page facts from a saved re-scrape instead of fetching the site")
    ap.add_argument("--workers", type=int, default=2, help="parallel fetches (default 2; 8 provoked HTTP 429 on 2026-09-19)")
    ap.add_argument("--delay", type=float, default=0.5, help="seconds after each fetch (default 0.5)")
    args = ap.parse_args()

    from neo4j import GraphDatabase
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, get_neo4j_password()))
    with driver.session(database="neo4j") as s:
        before = s.run(COUNTS_QUERY).single().data()
        print("graph before:", before)

        if args.rollback:
            rows = json.load(open(args.rollback))["rows"]
            n = s.run(ROLLBACK_QUERY, rows=rows).single()["n"]
            print(f"rolled back {n} of {len(rows)} rows ({len(rows) - n} skipped: changed since the repair)")
            print("graph after:", s.run(COUNTS_QUERY).single().data())
            return

        records = s.run(TARGET_QUERY).data()
        fetch = facts_source = None
        if args.facts:
            facts_by_id = json.load(open(args.facts))
            fetch = cached_lookup(facts_by_id)
            facts_source = {"path": os.path.abspath(args.facts), "entries": len(facts_by_id),
                            "mtime": datetime.fromtimestamp(os.path.getmtime(args.facts), timezone.utc).isoformat()}
            print(f"using saved re-scrape {facts_source['path']} ({facts_source['entries']} entries, {facts_source['mtime']}); no requests to the site")
        else:
            print(f"re-scraping {len(records)} listings ({args.workers} workers)...")
        plan = build_plan(records, args.fill, args.workers, args.delay, fetch=fetch)
        report(plan, len(records), args.fill)

        if args.verify:
            bad = len(plan["rows"]) + len(plan["unverified"])
            print("\nRESIDUE" if bad else "\nOK: every stored value is supported by its listing.",
                  f"({len(plan['rows'])} unsupported, {len(plan['unverified'])} unverified)" if bad else "")
            sys.exit(1 if bad else 0)

        if not plan["rows"]:
            print("\nnothing to do.")
            sys.exit(1 if plan["unverified"] else 0)

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        path = args.backup or os.path.join(HERE, f"km_retail_fields_repair_presnapshot_{ts}.json")
        with open(path, "w") as f:
            json.dump({"version": VERSION, "takenAt": ts, "fill": args.fill, "factsFile": facts_source, "before": before,
                       "stats": plan["stats"], "gone": plan["gone"], "unverified": plan["unverified"],
                       "rows": plan["rows"]}, f, indent=1)
        print("\nsnapshot ->", path)

        if not args.apply:
            print("\ndry run: no writes made. Re-run with --apply to write.")
            return

        n = s.run(APPLY_QUERY, rows=plan["rows"]).single()["n"]
        after = s.run(COUNTS_QUERY).single().data()
        print(f"updated {n} of {len(plan['rows'])} records ({len(plan['rows']) - n} skipped: changed since the plan)")
        print("graph after:", after)
        if n != len(plan["rows"]) or plan["unverified"]:
            print("INCOMPLETE: skipped or unverified records remain; re-run, then --verify.")
            sys.exit(1)


if __name__ == "__main__":
    main()
