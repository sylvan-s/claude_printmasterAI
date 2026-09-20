"""
PrintMasterAI — Roseberys multi-work lot parser (pilot)
Version: ROSEBERYS-MULTI-0.7

Roseberys lots flagged `multi_work` by the extractor (benchmark/src/roseberys/parse.ts
detectMultiWork) have been held out of the ACKG since 2026-08-24. The flag is a regex and is
only a candidate filter: some flagged lots are one work whose NOTE mentions a set, and some are
one print sold with a book, certificate or box. This module decides, per lot, what it really is
and — when it is several works — splits it into per-work records.

Two LLM passes, then a deterministic gate:
  1. TEXT pass — classify the lot and extract each work's fields from the catalogue prose.
  2. VISION pass — only for split candidates: assign one of the lot's own photos to each work.
     The API returns only the primary image; the lot page lists every photo in the lot's own
     S3 folder (the parent directory of `lot.image`). Photo 0 is usually a group shot.
  3. GATE (validate()) — code, not the model, decides split / single / hold. A lot is held when
     the works found don't match the declared count, a work has no title (unless the lot is
     identical copies), or a work gets no confident photo of its own.

Writes nothing to Neo4j. Output is a JSON file per run for scoring against hand labels.

Usage (source .env first):
    python3 roseberys_multi_work_parse.py --lots pilot_lots.json --out pilot_opus.json
    python3 roseberys_multi_work_parse.py --lots pilot_lots.json --out pilot_haiku.json --model claude-haiku-4-5
    python3 roseberys_multi_work_parse.py --lots pilot_lots.json --out pilot_qwen.json \
        --model qwen-plus --vision-model qwen3-vl-plus
"""

import argparse
import base64
import html
import io
import json
import os
import re
import time

import anthropic
import requests
from PIL import Image

PARSER_VERSION = "ROSEBERYS-MULTI-0.7"
# 2026-09-19 pilot (40 hand-labelled lots): Opus 5 38/40 kinds, 0 harmful decisions, every
# disputed photo match checked by eye was right (it reads pencil titles and edition numbers).
# Haiku 4.5 27/40 with 8 harmful (over-uses identical_copies; "high" photo confidence was
# wrong on 3 of 5 checked lots). Sonnet 5 34/40 with 2 harmful, at ~55% of Opus's cost.
DEFAULT_MODEL = "claude-opus-5"
# $ per million tokens, input/output. Qwen rates are the International (Singapore) list price
# for the shortest context tier — alibabacloud.com/help/en/model-studio/model-pricing, 2026-09-19.
PRICING = {"claude-opus-5": (5.00, 25.00), "claude-sonnet-5": (2.00, 10.00),
           "claude-haiku-4-5": (1.00, 5.00),
           "qwen-plus": (0.40, 1.20), "qwen3-vl-plus": (0.20, 1.60),
           "qwen-vl-plus": (0.21, 0.63)}
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
QWEN_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
# .env's DASHSCOPE_BASE_URL points at dashscope-us, which 401s on this key (2026-09-19);
# the international endpoint above is the one that answers.
ASSET_BASE = "https://am-s3-bucket-assets.s3.eu-west-2.amazonaws.com/roseberys/prod"
MAX_PHOTOS = 16
PHOTO_LONG_EDGE = 900
MAX_DECLARED = 12
REQUEST_DELAY = 0.7   # courtesy throttle, same as the extractor

LOT_KINDS = ["single_work", "single_work_with_ancillary", "multi_work", "identical_copies",
             "complete_portfolio", "under_described"]


def _nullable(t):
    return {"anyOf": [{"type": t}, {"type": "null"}]}


WORK_SCHEMA = {
    "type": "object",
    "properties": {
        "position": {"type": "integer"},
        "artist": _nullable("string"),
        "title": _nullable("string"),
        "year": _nullable("integer"),
        "medium": _nullable("string"),
        "support": _nullable("string"),
        "dim_kind": _nullable("string"),
        "width_cm": _nullable("number"),
        "height_cm": _nullable("number"),
        "edition_size": _nullable("integer"),
        "edition_number": _nullable("string"),
        "signed": _nullable("boolean"),
        "catalogue_refs": _nullable("string"),
        "copies": {"type": "integer"},
        "evidence": {"type": "string"},
    },
    "required": ["position", "artist", "title", "year", "medium", "support", "dim_kind",
                 "width_cm", "height_cm", "edition_size", "edition_number", "signed",
                 "catalogue_refs", "copies", "evidence"],
    "additionalProperties": False,
}

TEXT_SCHEMA = {
    "type": "object",
    "properties": {
        "lot_kind": {"type": "string", "enum": LOT_KINDS},
        "declared_count": _nullable("integer"),
        "works": {"type": "array", "items": WORK_SCHEMA},
        "ancillary_items": {"type": "array", "items": {"type": "string"}},
        "under_described_reason": _nullable("string"),
        "notes": {"type": "string"},
    },
    "required": ["lot_kind", "declared_count", "works", "ancillary_items",
                 "under_described_reason", "notes"],
    "additionalProperties": False,
}

VISION_SCHEMA = {
    "type": "object",
    "properties": {
        "photos": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "index": {"type": "integer"},
                "shows": {"type": "string",
                          "enum": ["single_work", "group", "detail", "ancillary", "other"]},
                "work_position": _nullable("integer"),
            },
            "required": ["index", "shows", "work_position"],
            "additionalProperties": False}},
        "assignments": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "work_position": {"type": "integer"},
                "photo_index": _nullable("integer"),
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "reason": {"type": "string"},
            },
            "required": ["work_position", "photo_index", "confidence", "reason"],
            "additionalProperties": False}},
    },
    "required": ["photos", "assignments"],
    "additionalProperties": False,
}

TEXT_PROMPT = """You parse one auction-house catalogue entry (Roseberys, London, Prints & Multiples).
The lot was flagged as possibly containing more than one work. Decide what it really contains and
extract each work.

lot_kind — pick exactly one:
- single_work: one artwork. A note that merely MENTIONS a set, series or portfolio the work belongs
  to does not make it several works. A single sheet on which several small images are printed or
  mounted together is one work.
- single_work_with_ancillary: one artwork sold with non-artwork extras (a book, exhibition
  catalogue, certificate, box, folder, invitation, letter). List the extras in ancillary_items.
  A poster or print counts as an artwork, not an extra.
- multi_work: two or more DIFFERENT artworks, and the entry identifies each one individually — at
  minimum a distinct title (or an explicit "Untitled" per work) for every work in the declared
  count. Titles may be listed with semicolons, in (i)/(ii) blocks, in brackets, or after "together
  with N other prints".
- identical_copies: two or more impressions of the SAME work — same image, same colourway, same
  edition — e.g. "(2)" after a single poster title with "each offset lithograph". Different
  colourways ("in yellow and red"), different images in one series, or the two halves of a
  diptych are NOT identical copies. Colourways that the entry names individually are multi_work;
  a set whose members are not named individually is under_described.
- complete_portfolio: a portfolio, suite, album or folio ISSUED AND SOLD AS ONE UNIT under one
  title, complete or stated as complete, whose individual plates the entry does not name
  ("Le Balcon engravings, portfolio, 1964; portfolio of ten engravings, signed, dated, numbered
  and editioned 1-10"). The unit of sale is the portfolio, so it is one thing, not n things.
  Give ONE work entry: the portfolio's own title, its edition, and copies = 1; put the number of
  plates in declared_count. The TITLE is the portfolio's name only — drop a trailing format
  descriptor such as "portfolio", "suite", "the complete set", "folio" and any trailing year,
  because that is the format, not the name, and it is already recorded in declared_count. Two
  houses cataloguing one portfolio as "Le Balcon engravings" and "Le Balcon engravings,
  portfolio, 1964" must produce the SAME title, or the graph holds them as two works and
  neither is a comp for the other. An INCOMPLETE set, or an assortment gathered by the auctioneer
  ("four prints including..."), is NOT this — it is under_described.
- under_described: several works, but the entry does not identify every one of them individually —
  e.g. "the complete portfolio of eleven screenprints" with one portfolio title, "eight offset
  lithographs" under a series name, "four prints including..." with fewer titles than works, or a
  count with no titles. Say why in under_described_reason.

declared_count: the number of works the entry says the lot contains — the trailing "(n)", or the
count in the text ("five etchings", "a set of 4", "together with 4 other prints" = 5). Count
artworks only, not extras. null if no count is given.

works — one entry per distinct artwork, in catalogue order, position starting at 1:
- For identical_copies give ONE entry with copies = the number of copies. Otherwise copies = 1.
- For under_described, list only the works that ARE individually identified (may be empty).
- Resolve "respectively": "numbered 62/70 and 51/70 respectively" gives work 1 edition_number
  "62/70" and work 2 "51/70". A shared attribute ("each signed", "all from the edition of 75")
  applies to every work. When the text gives an attribute only for some works ("the first signed",
  "one framed"), set it only where the text says so and leave the rest null.
- A "largest sheet"/"largest image" dimension belongs to no single work: leave width/height null.
  "each sheet: 40 x 59cm" applies to every work. Dimensions are width x height as printed.
- dim_kind: sheet | image | plate | overall | null.
- artist: the work's artist when the lot is by several artists; otherwise the lot's artist.
- year: the work's own year, or null. catalogue_refs: e.g. "Kemp 73", or null.
- evidence: the exact phrase(s) of the entry this work's title and attributes came from.
Do not invent anything the entry does not say. Use null for unknowns.

Catalogue entry:
<entry>
{entry}
</entry>"""

VISION_PROMPT = """These are all the photographs an auction house published for one lot, numbered
from 0 in the order shown on the lot page. The catalogue says the lot contains these works:

{works}

For EACH photo, say what it shows: a single one of the works (single_work, with its work_position),
several works together (group), a close-up of part of a work already shown (detail, with its
work_position if you can tell), an extra that is not one of the works — book, certificate, box,
verso, label (ancillary), or something else (other).

Then for EACH work, pick the one photo that best shows that work on its own (photo_index), or null
if no photo shows it on its own. Match on the title, medium, colour, subject and size described.
confidence: high = the photo clearly matches this work's description and no other; medium = likely
but the descriptions are too thin to be sure; low = a guess (for example you are relying only on
the photo order). Do not give two works the same photo."""


def lot_text(raw):
    t = re.sub(r"<br\s*/?>", "\n", raw["description"])
    t = re.sub(r"</p>\s*<p>", "\n", t)
    t = html.unescape(re.sub(r"<[^>]+>", "", t)).replace("\xa0", " ")
    return "\n".join(line.strip() for line in t.split("\n")).strip()


def lot_money(raw):
    """The lot's own money, in the extractor's semantics (benchmark/src/roseberys/api.ts):
    `rostrum_hammer` is the TRUE hammer and is only populated on recent sales; `hammer_price`
    is the premium-inclusive price realised despite its name, and can be non-null on an unsold
    lot — so `sold` comes from the `sold` flag, never from a price being present."""
    def num(v):
        if v in (None, "", 0, "0"):
            return None
        try:
            return float(str(v).replace(",", ""))
        except ValueError:
            return None
    sold = bool(raw.get("sold")) and not raw.get("passed") and not raw.get("withdrawn")
    return {"estimateLow": num(raw.get("low_estimate")), "estimateHigh": num(raw.get("high_estimate")),
            "reserve": num(raw.get("reserve_price")),
            "hammerPrice": num(raw.get("rostrum_hammer")) if sold else None,
            "priceRealised": num(raw.get("hammer_price")) if sold else None,
            "priceCurrency": "GBP", "sold": sold}


def lot_photo_urls(raw, lot_url, session):
    """Every photo in the lot's own S3 folder, in page order. The folder is the parent directory
    of the API's primary `image`; other folders on the page belong to neighbouring lots."""
    if not raw.get("image"):
        return []
    parts = raw["image"].split("/")
    folder, primary = parts[-2], parts[-1].rsplit(".", 1)[0]
    page = session.get(lot_url, headers={"User-Agent": UA}, timeout=60).text
    time.sleep(REQUEST_DELAY)
    seen = []
    for m in re.finditer(r"lot_images/(?:xlarge|large)/" + re.escape(folder) +
                         r"/([0-9a-f-]+)\.(\w+)", page):
        if m.group(1) not in [s[0] for s in seen]:
            seen.append((m.group(1), m.group(2)))
    if primary not in [s[0] for s in seen]:
        seen.insert(0, (primary, parts[-1].rsplit(".", 1)[1]))
    return [f"{ASSET_BASE}/lot_images/large/{folder}/{g}.{ext}" for g, ext in seen]


def fetch_jpeg_b64(url, session):
    r = session.get(url, headers={"User-Agent": UA}, timeout=60)
    r.raise_for_status()
    im = Image.open(io.BytesIO(r.content)).convert("RGB")
    im.thumbnail((PHOTO_LONG_EDGE, PHOTO_LONG_EDGE))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return base64.standard_b64encode(buf.getvalue()).decode()


class Caller:
    """One JSON-returning call, against Claude or — for a comparison run — Alibaba's Qwen models
    through their OpenAI-compatible endpoint. Same prompts, same schema, same gate; only the
    transport differs. Qwen is split across two models because qwen-plus takes no images."""

    def __init__(self, model, vision_model=None):
        self.model = model
        self.vision_model = vision_model or model
        self.is_qwen = model.startswith("qwen")
        if self.is_qwen:
            import openai
            base = os.environ.get("DASHSCOPE_BASE_URL_INTL", QWEN_BASE)
            self.client = openai.OpenAI(api_key=os.environ["DASHSCOPE_API_KEY"], base_url=base)
        else:
            self.client = anthropic.Anthropic()
        self.tokens = {}   # model -> [input, output]

    def json_call(self, content, schema, max_tokens=8000):
        has_image = any(b["type"] == "image" for b in content)
        model = self.vision_model if has_image else self.model
        for attempt in range(3):
            try:
                if self.is_qwen:
                    text, stop = self._qwen(model, content, schema, max_tokens)
                else:
                    text, stop = self._claude(model, content, schema, max_tokens)
            except Exception as exc:                    # transport, rate limit, 5xx
                if attempt == 2:
                    return None, f"error: {type(exc).__name__}"
                time.sleep(5 * (attempt + 1))
                continue
            if stop == "refusal":
                return None, "refusal"
            try:
                return json.loads(text), None
            except (json.JSONDecodeError, TypeError):
                if stop in ("max_tokens", "length"):
                    max_tokens *= 2
                continue
        return None, "failed"

    def _claude(self, model, content, schema, max_tokens):
        resp = self.client.messages.create(
            model=model, max_tokens=max_tokens,
            messages=[{"role": "user", "content": content}],
            extra_body={"output_config": {"format": {"type": "json_schema", "schema": schema}}})
        self._tally(model, resp.usage.input_tokens, resp.usage.output_tokens)
        if resp.stop_reason == "refusal":
            return None, "refusal"
        return next((b.text for b in resp.content if b.type == "text"), ""), resp.stop_reason

    def _qwen(self, model, content, schema, max_tokens):
        parts = []
        for b in content:
            if b["type"] == "text":
                parts.append({"type": "text", "text": b["text"]})
            else:
                parts.append({"type": "image_url", "image_url": {
                    "url": "data:image/jpeg;base64," + b["source"]["data"]}})
        resp = self.client.chat.completions.create(
            model=model, max_tokens=max_tokens, messages=[{"role": "user", "content": parts}],
            response_format={"type": "json_schema", "json_schema": {
                "name": "result", "strict": True, "schema": schema}})
        self._tally(model, resp.usage.prompt_tokens, resp.usage.completion_tokens)
        choice = resp.choices[0]
        return choice.message.content, choice.finish_reason

    def _tally(self, model, in_tok, out_tok):
        t = self.tokens.setdefault(model, [0, 0])
        t[0] += in_tok
        t[1] += out_tok

    def cost(self):
        """None when any model used has no published rate here, rather than a misleading $0.00."""
        total = 0.0
        for model, (in_tok, out_tok) in self.tokens.items():
            if model not in PRICING:
                return None
            pin, pout = PRICING[model]
            total += (in_tok * pin + out_tok * pout) / 1e6
        return total

    def spend(self):
        c = self.cost()
        return f"${c:.3f}" if c is not None else "cost n/a"


def validate(text, vision, n_photos):
    """The gate. Returns (decision, reasons). decision: single | split | hold."""
    kind = text["lot_kind"]
    works = text["works"]
    if kind in ("single_work", "single_work_with_ancillary"):
        return "single", []
    # A complete portfolio is ONE marketable object: the house sells it whole, prices it whole,
    # and the plates have no separate identity in the entry. Splitting would invent n titles and
    # divide the price on no evidence; holding it loses a real comp — the same Sorel portfolio
    # sold at A0777 lot 52 for £440 and was invisible to the A0793 lot 30 valuation. So it is
    # ingested as one work at the FULL lot price, with the plate count recorded.
    if kind == "complete_portfolio":
        if len(works) != 1:
            return "hold", [f"complete_portfolio with {len(works)} work entries; expected one"]
        if not (works[0]["title"] or "").strip():
            return "hold", ["complete_portfolio with no portfolio title"]
        return "single", []
    if kind == "under_described":
        return "hold", ["under_described: " + (text.get("under_described_reason") or "")]
    reasons = []
    declared = text["declared_count"]
    if kind == "identical_copies":
        if len(works) != 1:
            reasons.append(f"identical_copies with {len(works)} work entries")
        # A title holding a list ("Untitled; Mum") means the model called two DIFFERENT prints
        # copies of one work, which would merge them into a single ConceptualWork. Qwen did this
        # in the 2026-09-19 comparison run; cheap to catch, expensive to miss.
        elif ";" in (works[0]["title"] or ""):
            reasons.append(f"identical_copies but the title lists several works: {works[0]['title']!r}")
        found = works[0]["copies"] if works else 0
    else:
        found = len(works)
        missing_title = [w["position"] for w in works if not (w["title"] or "").strip()]
        if missing_title:
            reasons.append(f"works without a title: {missing_title}")
    if declared is None:
        reasons.append("no declared count")
    elif declared != found:
        reasons.append(f"declared {declared} but found {found}")
    if found < 2:
        reasons.append(f"only {found} work(s) found")
    if found > MAX_DECLARED:
        reasons.append(f"{found} works exceeds cap {MAX_DECLARED}")
    if n_photos == 0:
        reasons.append("no photos")
    elif vision is None:
        reasons.append("vision pass missing")
    elif kind == "multi_work":
        by_pos = {a["work_position"]: a for a in vision["assignments"]}
        # A photo the model itself called a group shot (or an extra) shows more than this work,
        # so it cannot be the work's own image — seen in the 2026-09-19 comparison run.
        not_single = {p["index"] for p in vision["photos"]
                      if p["shows"] in ("group", "ancillary", "other")}
        used = {}
        for w in works:
            a = by_pos.get(w["position"])
            if not a or a["photo_index"] is None:
                reasons.append(f"work {w['position']} has no photo of its own")
            elif a["confidence"] == "low":
                reasons.append(f"work {w['position']} photo match is low confidence")
            elif not (0 <= a["photo_index"] < n_photos):
                reasons.append(f"work {w['position']} photo index out of range")
            elif a["photo_index"] in used:
                reasons.append(f"works {used[a['photo_index']]} and {w['position']} share a photo")
            elif a["photo_index"] in not_single:
                reasons.append(f"work {w['position']} was given a group/extra photo")
            else:
                used[a["photo_index"]] = w["position"]
    elif kind == "identical_copies":
        if not any(p["shows"] in ("single_work", "group") for p in vision["photos"]):
            reasons.append("no photo shows the work")
    return ("hold", reasons) if reasons else ("split", [])


def describe_works(works):
    lines = []
    for w in works:
        bits = [w.get("title") or "(untitled)", w.get("medium"),
                f"{w['width_cm']} x {w['height_cm']}cm" if w.get("width_cm") else None,
                f"{w['copies']} copies" if w.get("copies", 1) > 1 else None]
        lines.append(f"{w['position']}. " + "; ".join(b for b in bits if b))
    return "\n".join(lines)


def parse_lot(lot, caller, session, image_cache):
    raw = lot["raw"]
    entry = lot_text(raw)
    text, err = caller.json_call([{"type": "text", "text": TEXT_PROMPT.format(entry=entry)}],
                                 TEXT_SCHEMA)
    out = {"sale": lot["sale"], "lot": lot["lot"], "url": lot["url"], "hammer": lot["hammer"],
           "heuristic": lot["heuristic"], "entry": entry, "money": lot_money(raw),
           "text": text, "text_error": err}
    if text is None:
        out.update(decision="hold", reasons=[f"text pass {err}"])
        return out
    key = (lot["sale"], lot["lot"])
    if key not in image_cache:
        image_cache[key] = lot_photo_urls(raw, lot["url"], session)
    urls = image_cache[key]
    out["photo_urls"] = urls
    vision = None
    if text["lot_kind"] in ("multi_work", "identical_copies") and urls:
        content = []
        for i, u in enumerate(urls[:MAX_PHOTOS]):
            content.append({"type": "text", "text": f"Photo {i}:"})
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": fetch_jpeg_b64(u, session)}})
        content.append({"type": "text",
                        "text": VISION_PROMPT.format(works=describe_works(text["works"]))})
        vision, verr = caller.json_call(content, VISION_SCHEMA)
        out["vision_error"] = verr
    out["vision"] = vision
    decision, reasons = validate(text, vision, min(len(urls), MAX_PHOTOS))
    out.update(decision=decision, reasons=reasons)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lots", required=True, help="JSON list of {sale, lot, url, hammer, heuristic, raw}")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--vision-model", default=None,
                    help="model for the photo pass when it differs from --model "
                         "(qwen-plus takes no images; pair it with qwen3-vl-plus)")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    key = "DASHSCOPE_API_KEY" if args.model.startswith("qwen") else "ANTHROPIC_API_KEY"
    if not os.environ.get(key):
        raise RuntimeError(f"{key} is not set. Source .env first.")
    lots = json.load(open(args.lots))[: args.limit]
    caller = Caller(args.model, args.vision_model)
    session, image_cache, results = requests.Session(), {}, []
    for n, lot in enumerate(lots, 1):
        r = parse_lot(lot, caller, session, image_cache)
        r["parser"] = f"{PARSER_VERSION}:{args.model}"
        if args.vision_model:
            r["parser"] += f"+{args.vision_model}"
        results.append(r)
        kind = r["text"]["lot_kind"] if r["text"] else "-"
        print(f"[{n}/{len(lots)}] {r['sale']} lot {r['lot']}: {kind} -> {r['decision']} "
              f"{'; '.join(r['reasons'])[:120]}  ({caller.spend()})", flush=True)
        json.dump(results, open(args.out, "w"), indent=1)
    for model, (in_tok, out_tok) in caller.tokens.items():
        print(f"done: {model}: {in_tok} in / {out_tok} out tokens")
    print(f"done: {len(results)} lots, {caller.spend()}")


if __name__ == "__main__":
    main()
