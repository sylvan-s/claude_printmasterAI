"""
PrintMasterAI — Live King & McGaw Full Web Scraper & Catalog Extractor
Version: KING-MCGAW-FETCH-3.1

3.1: stops synthesising values the page does not contain. `retail_price_max_gbp` was
    `price_min * 2.5` (or 135.0), `retail_price_min_gbp` fell back to 35.0, and
    `in_institutional_pod_archive` was a URL-substring / `price >= 40` guess. The max field is
    removed outright (a real range exists on the page, but nothing uses it and `min` is the default
    variant's price, not the cheapest); the other two are now read from the product page's own data
    (`extract_retail_facts`) and are None when the page does not state them. The repair for records already in the graph is `repair_km_retail_fields.py`.

Scrapes authentic live product catalog metadata directly from King & McGaw (kingandmcgaw.com),
extracting real artist names, real artwork titles, real high-resolution image URLs, and real retail prices
across all ~2,950 live product pages.

Outputs structured catalog JSON to:
    benchmark/data/king_mcgaw/catalog.json

Usage:
    python knowledge_graph/king_mcgaw_fetch.py --all             # Scrape full live catalog (all ~2,950 products)
    python knowledge_graph/king_mcgaw_fetch.py --limit 500       # Scrape 500 products
"""

import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.request
import concurrent.futures
from typing import Any, Dict, List, Optional, Set
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "benchmark", "data", "king_mcgaw"
)
LIVE_URLS_FILE = os.path.join(CACHE_DIR, "live_urls.json")
RARE_LIMITED_IDS_FILE = os.path.join(CACHE_DIR, "rare_limited_ids.json")
RARE_LIMITED_URL = "https://www.kingandmcgaw.com/prints/rare-limited"

HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
}


def load_live_product_urls() -> List[str]:
    if os.path.exists(LIVE_URLS_FILE):
        with open(LIVE_URLS_FILE) as f:
            urls = json.load(f)
            if urls:
                logging.info(f"Loaded {len(urls)} live product URLs from {LIVE_URLS_FILE}")
                return urls

    # Fallback to direct sitemap discovery if live_urls.json is missing
    import xml.etree.ElementTree as ET
    urls = []
    for i in range(1, 25):
        smap = f"https://sitemaps-kingandmcgaw-com.s3.amazonaws.com/artworks-{i}.xml"
        try:
            req = urllib.request.Request(smap, headers=HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=10) as resp:
                root = ET.fromstring(resp.read())
                urls.extend([e.text.strip() for e in root.findall(".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc") if e.text])
        except Exception:
            pass
    return sorted(list(set(urls)))


def load_rare_limited_ids(refresh: bool = False, max_pages: int = 60) -> Set[str]:
    """Product ids in King & McGaw's Rare & Limited section (904 items across 31 pages on 2026-09-19).

    Section membership is the only real signal for 'limited'. The classifier this replaces was
    `"limited" in url or "rare" in url`, and a product URL never carries its section: it fired only
    where the ARTIST slug happened to contain 'rare' ('rare-theatre-posters', 8 records) and missed
    35 in-section items already in the graph — Picasso x5, Hodgkin x5, Chillida and more — which
    stayed 'open_edition_poster'. Raises if the section cannot be read: guessing would silently
    type every item as an open-edition poster."""
    if not refresh and os.path.exists(RARE_LIMITED_IDS_FILE):
        with open(RARE_LIMITED_IDS_FILE) as f:
            ids = set(json.load(f))
        if ids:
            return ids
    ids: Set[str] = set()
    for page in range(1, max_pages + 1):
        try:
            req = urllib.request.Request(f"{RARE_LIMITED_URL}?page={page}", headers=HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=15) as resp:
                soup = BeautifulSoup(resp.read(), "html.parser")
        except Exception as exc:
            raise RuntimeError(f"cannot read the Rare & Limited section (page {page}): {exc}") from exc
        found = {m.group(1) for a in soup.find_all("a", href=True)
                 for m in [re.search(r"/prints/(?!rare-limited/)[^/]+/[^/?#]+-(\d+)$", a["href"])] if m}
        if not found - ids:
            break
        ids |= found
        time.sleep(0.5)
    if not ids:
        raise RuntimeError("the Rare & Limited section returned no products")
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(RARE_LIMITED_IDS_FILE, "w") as f:
        json.dump(sorted(ids), f)
    logging.info(f"Rare & Limited section: {len(ids)} product ids")
    return ids


PARTNERSHIP_PREFIX = "In partnership with "

# Partners named on the 573 catalogued pages (2026-09-19) that are museums, galleries or public
# archives. Deliberately excludes commercial photo agencies (Mirrorpix), brands and publishers
# (Vogue, Fender, Penguin, Ladybird), the rights society DACS, and bodies that are not collecting
# institutions in the same sense (Royal Horticultural Society, Henry Moore Foundation): each of
# those is a judgement call, so they stay unasserted rather than guessed. Extend by editing here;
# `repair_km_retail_fields.py` picks the change up on its next run.
INSTITUTIONAL_PARTNERS = frozenset({
    "National Gallery", "National Portrait Gallery", "National Galleries of Scotland",
    "The Courtauld Gallery", "Tate", "V&A", "Kettle's Yard", "Hepworth Wakefield",
    "London Transport Museum", "The National Archives", "London Metropolitan Archives",
})

# A King & McGaw product page is server-rendered HTML plus one inline script,
# `var appOptions = { artwork: {...}, ... }`, holding the product record the storefront renders
# from. Templates without it (ARTBLOCK objects, for one) carry only the og:/JSON-LD price.
_ARTWORK_KEY = re.compile(r"\bartwork\s*:\s*(?=\{)")


def extract_artwork_state(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    """The `artwork` object from the page's inline `appOptions` script, or None if absent/unparseable."""
    for script in soup.find_all("script"):
        text = script.string or ""
        if "appOptions" not in text:
            continue
        m = _ARTWORK_KEY.search(text)
        if not m:
            continue
        try:
            artwork, _ = json.JSONDecoder().raw_decode(text[m.end():])
        except ValueError:
            return None
        return artwork if isinstance(artwork, dict) else None
    return None


def extract_retail_facts(soup: BeautifulSoup) -> Dict[str, Any]:
    """Only what the product page states about price and print-on-demand; None where it is silent.

    listing_price_gbp  og `product:price:amount`: the price of the page's DEFAULT configuration
                       (a framed size), not the cheapest variant. This is what `retail_price_min_gbp`
                       has always held.
    is_pod             the page's own `is_pod` flag (print-on-demand), None if the blob is absent.
    partner            "In partnership with X" -> "X", None if the page names no partner.
    """
    listing_price = None
    for tag in soup.find_all("meta"):
        if (tag.get("property") or tag.get("name")) == "product:price:amount":
            try:
                value = float(tag.get("content") or "")
            except ValueError:
                continue
            listing_price = value if value > 0 else None

    is_pod = partner = None
    artwork = extract_artwork_state(soup)
    if artwork:
        if isinstance(artwork.get("is_pod"), bool):
            is_pod = artwork["is_pod"]
        text = ((artwork.get("partnership") or {}).get("text") or "").strip()
        if text:
            partner = text[len(PARTNERSHIP_PREFIX):].strip() if text.startswith(PARTNERSHIP_PREFIX) else text

    return {"listing_price_gbp": listing_price, "is_pod": is_pod, "partner": partner}


def derive_institutional_pod(is_pod: Optional[bool], partner: Optional[str]) -> Optional[bool]:
    """True only when the page says the item is print-on-demand AND names an institutional partner.

    Never False: a page that does not name a partner is silent, not evidence of absence, so the
    graph property is left null instead of asserting a negative."""
    return True if is_pod is True and partner in INSTITUTIONAL_PARTNERS else None


def parse_live_product_page(url: str, retries: int = 2,
                            rare_limited_ids: Optional[Set[str]] = None) -> Optional[Dict[str, Any]]:
    html_content = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=10) as response:
                html_content = response.read()
                break
        except Exception:
            if attempt < retries - 1:
                time.sleep(0.5)

    if not html_content:
        return None

    soup = BeautifulSoup(html_content, "html.parser")

    og_title = ""
    og_image = ""

    for tag in soup.find_all("meta"):
        prop = tag.get("property") or tag.get("name") or ""
        content = tag.get("content") or ""
        if prop == "og:title":
            og_title = content.strip()
        elif prop == "og:image":
            og_image = content.strip()

    title = ""
    artist = ""
    if " by " in og_title:
        clean_og = og_title.split(" - art print")[0].split(" | King")[0]
        parts = clean_og.split(" by ")
        title = parts[0].strip()
        artist = " by ".join(parts[1:]).strip()
    else:
        title = og_title or (soup.find("h1").text.strip() if soup.find("h1") else "Untitled")

    if not artist:
        url_parts = url.split("/prints/")
        if len(url_parts) > 1:
            artist_slug = url_parts[1].split("/")[0]
            artist = artist_slug.replace("-", " ").title()

    url_id_match = re.search(r"-(\d+)$", url)
    km_id = url_id_match.group(1) if url_id_match else "000"

    breadcrumbs = [a.text.strip() for a in soup.select("nav a, ul.breadcrumbs a, div.breadcrumb a")]
    category = "Modern Art"
    if any("Graphic" in b for b in breadcrumbs):
        category = "Graphic Art & Typography"
    elif any("Museums" in b for b in breadcrumbs):
        category = "Museums & Archives"

    if rare_limited_ids is None:
        raise ValueError("rare_limited_ids is required: 'limited' is decided by Rare & Limited section membership")
    is_limited = km_id in rare_limited_ids
    facts = extract_retail_facts(soup)

    return {
        "km_product_id": f"KM-{km_id}",
        "artist_name": artist or "Unknown Artist",
        "artwork_title": title or "Untitled",
        "category": category,
        # The listing states NO medium (a product page is title, artist, size and price), so neither
        # string here is evidence. 'Original Exhibition Lithograph' was asserted for every limited item
        # on the strength of a URL substring; a neutral label says only what the site does.
        "medium_description": "Rare & limited poster (medium not stated)" if is_limited else "Fine Art Print Reproduction",
        "listing_url": url,
        "image_url": og_image,
        # All come from the page (see extract_retail_facts) and are None where it is silent.
        "retail_price_min_gbp": facts["listing_price_gbp"],
        "is_limited_edition": is_limited,
        "print_on_demand": facts["is_pod"],
        "partner_name": facts["partner"],
        "in_institutional_pod_archive": derive_institutional_pod(facts["is_pod"], facts["partner"]),
        "publisher_name": "King & McGaw"
    }


def run_parallel_live_scraper(limit: Optional[int] = None, workers: int = 16) -> List[Dict[str, Any]]:
    urls = load_live_product_urls()
    if limit:
        urls = urls[:limit]

    rare_limited_ids = load_rare_limited_ids()
    total = len(urls)
    logging.info(f"Starting parallel live web scrape of {total} King & McGaw product pages ({workers} workers)...")

    records = []
    start_time = time.time()
    completed = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_url = {executor.submit(parse_live_product_page, url, 2, rare_limited_ids): url for url in urls}
        for future in concurrent.futures.as_completed(future_to_url):
            completed += 1
            rec = future.result()
            if rec and rec.get("artwork_title"):
                records.append(rec)
            if completed % 250 == 0 or completed == total:
                logging.info(f"Scraped [{completed}/{total}] live pages ({len(records)} valid records)...")

    elapsed = time.time() - start_time
    logging.info(f"[COMPLETE] Scraped {len(records)}/{total} authentic live catalog records in {elapsed:.1f}s.")
    return records


def main():
    parser = argparse.ArgumentParser(description="Parallel Live Web Scraper for King & McGaw.")
    parser.add_argument("--all", action="store_true", help="Scrape full live catalog (~2,950 products).")
    parser.add_argument("--limit", type=int, help="Cap the number of live items to scrape.")
    parser.add_argument("--workers", type=int, default=16, help="Parallel worker threads (default: 16).")

    args = parser.parse_args()

    os.makedirs(CACHE_DIR, exist_ok=True)
    out_path = os.path.join(CACHE_DIR, "catalog.json")

    limit = None if args.all else args.limit
    records = run_parallel_live_scraper(limit=limit, workers=args.workers)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)

    logging.info(f"[SUCCESS] Saved {len(records)} authentic live King & McGaw catalog items to {out_path}")


if __name__ == "__main__":
    main()
