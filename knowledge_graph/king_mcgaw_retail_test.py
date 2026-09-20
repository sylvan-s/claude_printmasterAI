"""
Offline tests (no network, no Neo4j) for the King & McGaw retail-field honesty fix:
KING-MCGAW-FETCH-3.1, KING-MCGAW-INGEST-1.2 and KM-RETAIL-FIELDS-REPAIR-1.0.

    python3 -m pytest knowledge_graph/king_mcgaw_retail_test.py

The HTML fixtures reproduce the shapes seen on live pages on 2026-09-19: a multi-variant print page
(`appOptions.artwork.products[].price` in pence, `is_pod`, optional `partnership`), a single-price rare
poster, and an ARTBLOCK page that has no `appOptions` at all.
"""
import json
import os
import sys
import urllib.request

import pytest
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import king_mcgaw_fetch as fetch
import king_mcgaw_ingest as ingest
import repair_km_retail_fields as repair


def page(og_price="185.0", prices=(), is_pod=False, partnership=None, description="An original poster.", blob=True):
    meta = f'<meta property="product:price:amount" content="{og_price}">' if og_price is not None else ""
    artwork = {
        "id": 1, "title": "T", "is_pod": is_pod, "description": description,
        "partnership": ({"text": partnership} if partnership else {}),
        "products": [{"price": p, "type": "CustomPrintProduct"} for p in prices],
    }
    script = "<script>var appOptions = {\n  artwork: " + json.dumps(artwork) + ",\n  podMedia: []\n};</script>" if blob else \
             '<script type="application/ld+json">{"@type":"Product","offers":{"price":"35.0"}}</script>'
    html = f'<html><head><meta property="og:title" content="A by B - art print from King &amp; McGaw">' \
           f'<meta property="og:image" content="https://img/x.jpg">{meta}</head><body>{script}</body></html>'
    return BeautifulSoup(html, "html.parser")


# ── extract_retail_facts ─────────────────────────────────────────────────────

def test_multi_variant_page_states_its_listing_price_and_no_max():
    facts = fetch.extract_retail_facts(page(og_price="160.0", prices=[3500, 16000, 31000, 16000]))
    assert facts == {"listing_price_gbp": 160.0, "is_pod": False, "partner": None}   # no max: 160 * 2.5 was invented


def test_page_without_blob_states_only_the_listing_price():
    facts = fetch.extract_retail_facts(page(og_price="35.0", blob=False))
    assert facts == {"listing_price_gbp": 35.0, "is_pod": None, "partner": None}


@pytest.mark.parametrize("og", [None, "0.0", "-1", "abc"])
def test_no_usable_price_is_none_not_the_35_default(og):
    assert fetch.extract_retail_facts(page(og_price=og, prices=[]))["listing_price_gbp"] is None


def test_malformed_blob_does_not_raise_and_states_nothing():
    html = '<meta property="product:price:amount" content="50.0"><script>var appOptions = { artwork: {"is_pod": tru</script>'
    facts = fetch.extract_retail_facts(BeautifulSoup(html, "html.parser"))
    assert facts == {"listing_price_gbp": 50.0, "is_pod": None, "partner": None}


def test_braces_and_quotes_inside_description_do_not_break_parsing():
    facts = fetch.extract_retail_facts(page(og_price="20.0", is_pod=True, description='A "quoted" } stray { brace'))
    assert facts["is_pod"] is True and facts["listing_price_gbp"] == 20.0


def test_partner_prefix_is_stripped_and_is_pod_read_as_bool():
    facts = fetch.extract_retail_facts(page(is_pod=True, partnership="In partnership with National Gallery", prices=[3500, 16000]))
    assert facts["partner"] == "National Gallery" and facts["is_pod"] is True


# ── derive_institutional_pod ─────────────────────────────────────────────────

@pytest.mark.parametrize("is_pod,partner,expected", [
    (True, "National Gallery", True),
    (True, "Tate", True),
    (False, "National Gallery", None),          # not print-on-demand: unasserted, never False
    (None, "National Gallery", None),           # no blob
    (True, None, None),                         # no partner named: silent, not a negative
    (True, "Mirrorpix", None),                  # commercial agency, deliberately not institutional
    (True, "Royal Horticultural Society", None),
])
def test_institutional_pod_is_true_or_none_never_false(is_pod, partner, expected):
    assert fetch.derive_institutional_pod(is_pod, partner) is expected


def test_url_substring_no_longer_decides_institution(monkeypatch):
    html = str(page(og_price="160.0", prices=[16000, 31000], is_pod=True)).encode()

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return html

    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Resp())
    rec = fetch.parse_live_product_page("https://www.kingandmcgaw.com/prints/tate-modern/some-print-123", rare_limited_ids=set())
    assert rec["in_institutional_pod_archive"] is None      # "tate" in the URL and price >= 40 used to make this True
    assert "retail_price_max_gbp" not in rec                # the field no longer exists
    assert rec["print_on_demand"] is True and rec["partner_name"] is None


def test_parse_live_product_page_without_price_has_no_defaults(monkeypatch):
    html = str(page(og_price=None, blob=False)).encode()

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return html

    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Resp())
    rec = fetch.parse_live_product_page("https://www.kingandmcgaw.com/prints/x/y-9", rare_limited_ids=set())
    assert rec["retail_price_min_gbp"] is None
    assert rec["in_institutional_pod_archive"] is None


# ── ingest ───────────────────────────────────────────────────────────────────

def test_ingest_helpers_keep_none_and_zero_distinct():
    assert ingest._optional_float(None) is None and ingest._optional_float(0) == 0.0
    assert ingest._optional_bool(None) is None and ingest._optional_bool(False) is False


def test_ingest_writes_null_for_absent_values(monkeypatch):
    monkeypatch.setattr(ingest, "resolve_artist", lambda name: {"strippedName": name})
    rec = ingest.prepare_item_record({"km_product_id": "KM-1", "artist_name": "A B", "artwork_title": "T"})["source_record"]
    assert rec["retailPriceMinGBP"] is None
    assert rec["inInstitutionalPODArchive"] is None


def test_ingest_keeps_real_values(monkeypatch):
    monkeypatch.setattr(ingest, "resolve_artist", lambda name: {"strippedName": name})
    rec = ingest.prepare_item_record({"km_product_id": "KM-1", "artist_name": "A B", "artwork_title": "T",
                                      "retail_price_min_gbp": 160.0,
                                      "in_institutional_pod_archive": True})["source_record"]
    assert (rec["retailPriceMinGBP"], rec["inInstitutionalPODArchive"]) == (160.0, True)
    assert "retailPriceMaxGBP" not in rec                    # never written, so the Cypher cannot create it


def test_seed_data_and_seed_flag_are_gone():
    assert not hasattr(ingest, "SAMPLE_SEED_ITEMS")
    assert "--seed" not in open(ingest.__file__).read().split("def main")[1]


def _run_main(monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["king_mcgaw_ingest.py"] + argv)
    with pytest.raises(SystemExit) as exc:
        ingest.main()
    return exc.value.code


def test_ingest_requires_a_file_and_never_falls_back_to_anything(monkeypatch):
    assert _run_main(monkeypatch, []) == 2


def test_ingest_rejects_a_stale_catalog(monkeypatch, tmp_path):
    stale = tmp_path / "catalog.json"
    stale.write_text(json.dumps([{"km_product_id": "KM-1", "retail_price_max_gbp": 462.5, "in_institutional_pod_archive": True}]))
    monkeypatch.setattr(ingest, "run_ingestion", lambda *a, **k: pytest.fail("a stale catalog must not reach the graph"))
    assert _run_main(monkeypatch, ["--file", str(stale)]) == 2


# ── repair decision table ────────────────────────────────────────────────────

FACTS_RANGE = {"listing_price_gbp": 160.0, "is_pod": True, "partner": "National Gallery"}
FACTS_PLAIN = {"listing_price_gbp": 160.0, "is_pod": True, "partner": None}
# retailPriceMaxGBP is a stray value from the retired scraper: nothing supports it any more.
STORED = {"retailPriceMinGBP": 160.0, "retailPriceMaxGBP": 400.0, "inInstitutionalPODArchive": True}


def test_repair_nulls_unsupported_values_and_keeps_supported_ones():
    plan = repair.plan_record(STORED, "ok", FACTS_RANGE, fill=False)
    assert plan["actions"] == {"retailPriceMinGBP": "keep", "retailPriceMaxGBP": "null", "inInstitutionalPODArchive": "keep"}
    assert plan["after"] == {"retailPriceMinGBP": 160.0, "retailPriceMaxGBP": None, "inInstitutionalPODArchive": True}
    assert plan["pageOffers"] == {}


def test_repair_fill_writes_the_real_listing_price_but_never_a_max():
    plan = repair.plan_record({**STORED, "retailPriceMinGBP": 35.0}, "ok", FACTS_RANGE, fill=True)
    assert plan["actions"]["retailPriceMinGBP"] == "fill" and plan["after"]["retailPriceMinGBP"] == 160.0
    assert plan["actions"]["retailPriceMaxGBP"] == "null" and plan["after"]["retailPriceMaxGBP"] is None


def test_repair_nulls_an_institutional_flag_the_page_does_not_support():
    plan = repair.plan_record(STORED, "ok", FACTS_PLAIN, fill=False)
    assert plan["after"]["inInstitutionalPODArchive"] is None


def test_repair_nulls_a_stored_false_because_absence_is_never_asserted():
    plan = repair.plan_record({**STORED, "inInstitutionalPODArchive": False}, "ok", FACTS_PLAIN, fill=False)
    assert plan["actions"]["inInstitutionalPODArchive"] == "null"


def test_repair_nulls_the_35_default_min_when_the_page_says_otherwise():
    plan = repair.plan_record({**STORED, "retailPriceMinGBP": 35.0}, "ok", FACTS_RANGE, fill=False)
    assert plan["after"]["retailPriceMinGBP"] is None
    # ...but a real 35.0 listing price is supported and stays
    plan = repair.plan_record({**STORED, "retailPriceMinGBP": 35.0}, "ok", {**FACTS_RANGE, "listing_price_gbp": 35.0}, fill=False)
    assert plan["actions"]["retailPriceMinGBP"] == "keep"


def test_repair_leaves_absent_values_absent_without_fill():
    empty = {f: None for f in repair.FIELDS}
    plan = repair.plan_record(empty, "ok", FACTS_RANGE, fill=False)
    assert set(plan["actions"].values()) == {"keep"} and plan["after"] == empty


def test_repair_gone_page_supports_nothing():
    plan = repair.plan_record(STORED, "gone", None, fill=True)
    assert set(plan["actions"].values()) == {"null"} and set(plan["after"].values()) == {None}


def test_repair_unverified_record_is_left_untouched():
    assert repair.plan_record(STORED, "error", None, fill=False) is None


def test_repair_is_idempotent():
    first = repair.plan_record(STORED, "ok", FACTS_RANGE, fill=False)["after"]
    second = repair.plan_record(first, "ok", FACTS_RANGE, fill=False)
    assert set(second["actions"].values()) == {"keep"}


def test_scrape_treats_429_as_unverified_never_gone(monkeypatch):
    import urllib.error

    def boom(*a, **k):
        raise urllib.error.HTTPError("u", 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    monkeypatch.setattr(repair.time, "sleep", lambda s: None)
    assert repair.scrape_listing("https://x/y-1", retries=2)[0] == "error"


def test_scrape_treats_404_and_missing_url_as_gone(monkeypatch):
    import urllib.error

    def nf(*a, **k):
        raise urllib.error.HTTPError("u", 404, "Not Found", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", nf)
    assert repair.scrape_listing("https://x/y-1")[0] == "gone"
    assert repair.scrape_listing(None)[0] == "gone"


def test_cypher_guards_cover_every_field_and_are_null_safe():
    for query, guarded, assigned in ((repair.APPLY_QUERY, "before", "after"), (repair.ROLLBACK_QUERY, "after", "before")):
        for f in repair.FIELDS:
            assert f"sr.{f} IS NULL AND row.{guarded}.{f} IS NULL" in query
            assert f"sr.{f} = row.{assigned}.{f}" in query
        assert "MATCH (sr:SourceRecord {id: row.id})" in query      # label-scoped, id index usable


def test_scrape_treats_a_degraded_200_as_unverified_not_as_an_empty_page(monkeypatch):
    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"<html><head><title>Please wait</title></head><body></body></html>"

    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Resp())
    monkeypatch.setattr(repair.time, "sleep", lambda s: None)
    status, facts, detail = repair.scrape_listing("https://x/y-1", retries=2)
    assert status == "error" and facts is None and "degraded" in detail


def test_scrape_accepts_a_page_whose_only_data_is_the_listing_price(monkeypatch):
    html = str(page(og_price="35.0", blob=False)).encode()

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return html

    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Resp())
    monkeypatch.setattr(repair.time, "sleep", lambda s: None)
    status, facts, _ = repair.scrape_listing("https://x/y-1")
    assert status == "ok" and facts["listing_price_gbp"] == 35.0


def test_cached_lookup_reads_saved_facts_and_leaves_unknown_records_unverified():
    look = repair.cached_lookup({"KM-473809": FACTS_PLAIN})
    assert look({"id": "km-sr-km-473809"}) == ("ok", FACTS_PLAIN, "")
    status, facts, _ = look({"id": "km-sr-km-1"})
    assert status == "error" and facts is None


def test_build_plan_from_saved_facts_makes_no_requests(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: pytest.fail("saved facts must not hit the network"))
    recs = [{"id": "km-sr-km-473809", "url": "https://x/y-473809", **STORED}, {"id": "km-sr-km-9", "url": "https://x/y-9", **STORED}]
    plan = repair.build_plan(recs, fill=False, workers=1, delay=0, fetch=repair.cached_lookup({"KM-473809": FACTS_RANGE}))
    assert [r["id"] for r in plan["rows"]] == ["km-sr-km-473809"]
    assert [u["id"] for u in plan["unverified"]] == ["km-sr-km-9"]
