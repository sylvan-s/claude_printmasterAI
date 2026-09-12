"""
PrintMasterAI — visual adjudication of Splink merge candidates.
Version: VISUAL-ADJUDICATOR-1.0

Reads `generate_splink_merge_candidates.py`'s CSV, fetches both sides' images, and asks a vision
model for an explicit SAME_WORK / DIFFERENT_WORK / UNCERTAIN verdict per pair. Writes a review
CSV. It never touches the graph and never merges — same never-auto-merge posture as
`verify_ambiguous_artists.py` and ADR-0008.

WHY A VISION PASS AT ALL. Splink turns 686,206 record pairs into ~100 candidates with an image on
both sides, but its own evaluation cannot say how many are right: the pairs it CAN be scored
against are prior merges, and those are dropped from the candidate list. Each remaining row is
either two different works or a duplicate the graph has not folded, and nothing in the metadata
separates those readings. The pictures can, for most of them.

THE QUESTION IS NOT "ARE THESE THE SAME IMAGE", and the prompt is built around that.

A print corpus has four ways for two images to look alike while being different works, all of
them recorded in this project from real incidents rather than imagined:

  - STATES. Successive reworkings of one plate. Hamilton's "In Horne's house - state I..V" is five
    objects and they differ by added shading or a reworked passage, not by composition.
  - PLATE DESIGNATIONS. "La Femme qui pleure. III" and ". IV" are one subject worked on separate
    plates. ADR-0017 Amendment 2 measured these axes as ORTHOGONAL: 14 of 31 works carrying both
    hold two to five states behind a single numeral.
  - COLOURWAYS. One matrix, different inks. Merging five Stik colourways is corruption incident
    2 in catalogue_matching.py's docstring.
  - MATRIX vs IMPRESSION. A plate is the MIRROR of its print and tonally inverted. Measured over
    104 same-name pairs: mean image similarity 0.540, 80 of 104 below 0.70. Here a LOW score is
    what a correct pair looks like.

The first three are the failure mode of this whole approach: a model shown two states of one
plate will call them the same image, be right about the image, and wrong about the work. So when
the generator's `designationDiffers` flag is set, the pair is escalated — the prompt names the
designation, says plainly that the works are presumed DIFFERENT, and asks for the specific
physical evidence that would overturn that, not a general impression.

WHAT THE MODEL IS AND IS NOT TOLD. It gets both titles, years, institutions, catalogue
references, and the flags — withholding them would force it to re-derive from pixels what the
graph already knows. It is NOT told Splink's match weight: that is the model's own prior, and
feeding it back produces agreement rather than evidence.

Usage:
    python3 adjudicate_merge_candidates.py --in candidates.csv --out verdicts.csv --limit 20
    python3 adjudicate_merge_candidates.py --in candidates.csv --model claude-haiku-4-5
"""

import argparse
import base64
import csv
import json
import os
import re
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone

import anthropic

DEFAULT_MODEL = "claude-opus-5"
MAX_IMAGE_BYTES = 4_000_000
# The state descriptions that make this useful run long — #14's ran to ~600
# characters. At 1200 the JSON truncated mid-object and two pairs came back as
# UNCERTAIN with an empty reasoning field, which reads like model doubt and was not.
MAX_TOKENS = 3000

# Published rates for the default model, $ per million tokens. Used only to print a running
# estimate — the token counts themselves are measured from response.usage, never guessed.
PRICING = {"claude-opus-5": (5.00, 25.00), "claude-opus-4-8": (5.00, 25.00),
           "claude-sonnet-5": (2.00, 10.00), "claude-haiku-4-5": (1.00, 5.00)}
FETCH_TIMEOUT = 30

SYSTEM_PROMPT = """You adjudicate whether two records in a print catalogue describe the SAME
CONCEPTUAL WORK. You are shown one image from each side plus the metadata each source recorded.

A CONCEPTUAL WORK is the artist's design as realised through ONE MATRIX. A state is a stage in
the working of that matrix, not a separate work — successive states belong to one conceptual
work and are recorded beneath it. It is NOT "an image that looks the same".

These are DIFFERENT works even when the pictures look nearly identical:
  - different PLATES of one subject — a second, separately cut matrix of the same scene. The
    catalogue gives each plate its own number
  - different COLOURWAYS printed from one matrix
  - a different EDITION only if the catalogue treats it as a separate work; a later printing of
    the same plate is the SAME work

These are the SAME work even when the pictures look different:
  - different STATES of one plate — successive reworkings, with added shading, strengthened or
    burnished lines, added or removed elements. One plate worked through several states is ONE
    conceptual work. When you see a state difference, return SAME_WORK and describe the change
    in stateEvidence so the state can be recorded against the work
  - a MATRIX (copper, zinc, linoleum block) and an impression pulled from it — the plate is the
    MIRROR IMAGE of the print and tonally inverted
  - different photography: colour cast, crop, framing, margins, sheet trimmed differently
  - one side showing the full sheet and the other only the platemark
  - different INKING: a weakly inked or heavily wiped impression against a richly inked one,
    more or less plate tone, more or less drypoint burr showing. Impression strength is a
    printing variable, not a change to the plate

THE HARDEST DISTINCTION, and the one to get right: a lightly inked impression and an earlier
state look alike in a photograph. They are told apart by WHAT IS ON THE PLATE, not by how dark
the print is. A state change ADDS OR REMOVES MARKS — a passage of hatching absent in one and
present in the other, a line burnished away, a contour redrawn, an added remarque. An inking
difference shows THE SAME MARKS at a different strength.

So before calling a state change, name a mark that is present in one image and absent from the
other, and put it in stateEvidence. If all you can say is that one is darker, denser, more
heavily worked or more finished LOOKING, that is inking, and the answer is SAME_WORK.

Compare the printed image itself, never the paper, mount, frame or margins.

Return ONLY a JSON object, no prose around it:
{
  "verdict": "SAME_WORK" | "DIFFERENT_WORK" | "UNCERTAIN",
  "confidence": 0.0-1.0,
  "whatMatches": "specific shared features, or empty",
  "whatDiffers": "specific differences in the PRINTED IMAGE, or empty",
  "stateEvidence": "for a suspected state or plate difference, the exact passage that differs, or empty",
  "reasoning": "one or two sentences"
}

Use UNCERTAIN rather than guessing when an image is too small, too dark, cropped past the
composition, or when the only differences you can see could be photographic."""

ESCALATION = """
THIS PAIR IS FLAGGED: the two titles are identical except for a trailing designation
({designation}), and the catalogue citations could not settle what that designation means. It is
either a STATE (one matrix worked in stages -> SAME work) or a separate PLATE (a second matrix of
the same subject -> DIFFERENT works). Deciding which is the question.

A STATE difference shows the same composition with marks added to or removed from it: a passage
newly hatched, a line burnished away, a contour strengthened, a remarque added. The drawing sits
in the same place on the sheet.

A separate PLATE is redrawn. The figures shift, proportions change, the composition is laid out
again — recognisably the same subject, not the same drawing.

Return SAME_WORK for a state difference and put the changed passage in stateEvidence. Return
DIFFERENT_WORK for a separate plate and say what is redrawn. Return UNCERTAIN if the images are
too small or too alike to tell which of the two you are looking at."""


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Source .env first.")
    return value


def fetch_image(url, cache):
    """Returns (media_type, base64) or (None, None). Failures are recorded, never fatal — a pair
    with one unreachable image becomes UNCERTAIN rather than disappearing from the review."""
    if url in cache:
        return cache[url]
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "PrintMasterAI/research"})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT, context=ctx) as r:
            body = r.read(MAX_IMAGE_BYTES + 1)
            media = r.headers.get_content_type()
    except Exception:
        cache[url] = (None, None)
        return cache[url]
    if len(body) > MAX_IMAGE_BYTES or len(body) < 1000:
        cache[url] = (None, None)
        return cache[url]
    # SNIFF, DO NOT TRUST THE HEADER. Forum's S3 bucket serves .webp under a generic type, and
    # defaulting those to image/jpeg made the API reject the request — 1 of the first 14 pairs
    # was lost to it, reported as UNCERTAIN with an API error in the reasoning field.
    sniffed = _sniff_media_type(body)
    media = sniffed or (media if media in
                        ("image/jpeg", "image/png", "image/gif", "image/webp") else "image/jpeg")
    cache[url] = (media, base64.standard_b64encode(body).decode())
    return cache[url]


def _sniff_media_type(body):
    if body[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if body[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if body[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    return None


def side_summary(row, side):
    return (f"  title:        {row['title'+side]!r}\n"
            f"  year:         {row['year'+side] or 'not recorded'}\n"
            f"  institutions: {row['institutions'+side] or 'not recorded'}\n"
            f"  catalogue:    {row['catalogue'+side] or 'none cited'}\n"
            f"  technique:    {row['techFamily'+side] or 'not resolved'}\n"
            f"  impressions:  {row['impressions'+side]}")


def build_message(row, image_a, image_b):
    flags = row.get("flags", "")
    parts = [{"type": "text", "text":
              f"RECORD A\n{side_summary(row, 'A')}\n\nRECORD B\n{side_summary(row, 'B')}\n\n"
              f"catalogue verdict: {row['catalogueVerdict']}   flags: {flags or 'none'}"}]
    parts.append({"type": "text", "text": "Image of RECORD A:"})
    parts.append({"type": "image", "source": {"type": "base64",
                                              "media_type": image_a[0], "data": image_a[1]}})
    parts.append({"type": "text", "text": "Image of RECORD B:"})
    parts.append({"type": "image", "source": {"type": "base64",
                                              "media_type": image_b[0], "data": image_b[1]}})
    if row.get("designationDiffers") == "1":
        designation = _designation_hint(row["titleA"], row["titleB"])
        parts.append({"type": "text", "text": ESCALATION.format(designation=designation)})
    return parts


def _designation_hint(title_a, title_b):
    rx = re.compile(r"[\s,.\-–(\[]+((?:no|pl|planche|plate|state|etat|état)?\.?\s*"
                    r"(?:[IVXLC]{1,6}|\d{1,3}))\s*[)\]]?\s*$", re.I)
    a = rx.search(title_a or "")
    b = rx.search(title_b or "")
    return f"{a.group(1).strip() if a else '?'} vs {b.group(1).strip() if b else '?'}"


VERDICT_COLUMNS = ["rank", "matchWeight", "verdict", "confidence", "artist",
                   "titleA", "titleB", "flags", "whatMatches", "whatDiffers",
                   "stateEvidence", "reasoning", "inputTokens", "outputTokens",
                   "workA", "workB", "adjudicatedAt"]


def adjudicate(client, model, row, cache):
    image_a = fetch_image((row["imagesA"] or "").split(" | ")[0], cache)
    image_b = fetch_image((row["imagesB"] or "").split(" | ")[0], cache)
    if not image_a[1] or not image_b[1]:
        return {"verdict": "UNCERTAIN", "confidence": 0.0, "whatMatches": "",
                "whatDiffers": "", "stateEvidence": "",
                "reasoning": "image could not be fetched on one or both sides"}
    response = client.messages.create(
        model=model, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_message(row, image_a, image_b)}])
    usage = {"inputTokens": response.usage.input_tokens,
             "outputTokens": response.usage.output_tokens}
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        # Say WHY. An empty reasoning field reads like model doubt; a truncation is a bug.
        return {**usage, "verdict": "UNCERTAIN", "confidence": 0.0, "whatMatches": "",
                "whatDiffers": "", "stateEvidence": "",
                "reasoning": f"no JSON in response (stop_reason={response.stop_reason}, "
                             f"{len(text)} chars): {text[:160]}"}
    try:
        return {**usage, **json.loads(m.group(0))}
    except json.JSONDecodeError:
        return {**usage, "verdict": "UNCERTAIN", "confidence": 0.0, "whatMatches": "",
                "whatDiffers": "", "stateEvidence": "",
                "reasoning": f"invalid JSON: {m.group(0)[:160]}"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--out", default="merge_candidate_verdicts.csv")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--min-weight", type=float, default=None)
    ap.add_argument("--route", default="needsVision",
                    help="which generator route to adjudicate; 'all' to ignore routing. "
                         "stateFamily and plateConflict are decided on the catalogue citation "
                         "and cost nothing — see generate_splink_merge_candidates.route()")
    args = ap.parse_args()

    _require_env("ANTHROPIC_API_KEY")
    rows = list(csv.DictReader(open(args.infile, encoding="utf-8")))
    if args.route != "all" and rows and "route" in rows[0]:
        before = len(rows)
        rows = [r for r in rows if r["route"] == args.route]
        print(f"routing: {len(rows)}/{before} rows are {args.route}; "
              f"the rest were decided on metadata", flush=True)
    if args.min_weight is not None:
        rows = [r for r in rows if float(r["matchWeight"]) >= args.min_weight]
    if args.limit:
        rows = rows[:args.limit]
    print(f"{len(rows)} candidates to adjudicate with {args.model}", flush=True)

    client = anthropic.Anthropic()
    cache, out_rows, tally = {}, [], {}
    for n, row in enumerate(rows, 1):
        try:
            result = adjudicate(client, args.model, row, cache)
        except Exception as exc:
            result = {"verdict": "UNCERTAIN", "confidence": 0.0, "whatMatches": "",
                      "whatDiffers": "", "stateEvidence": "",
                      "reasoning": f"{type(exc).__name__}: {exc}"}
            time.sleep(2)
        verdict = result.get("verdict", "UNCERTAIN")
        tally[verdict] = tally.get(verdict, 0) + 1
        out_rows.append({
            "rank": row["rank"], "matchWeight": row["matchWeight"], "verdict": verdict,
            "confidence": result.get("confidence", ""), "artist": row["artist"],
            "titleA": row["titleA"], "titleB": row["titleB"], "flags": row.get("flags", ""),
            "whatMatches": result.get("whatMatches", ""),
            "whatDiffers": result.get("whatDiffers", ""),
            "stateEvidence": result.get("stateEvidence", ""),
            "reasoning": result.get("reasoning", ""),
            "inputTokens": result.get("inputTokens", ""),
            "outputTokens": result.get("outputTokens", ""),
            "workA": row["workA"], "workB": row["workB"],
            "adjudicatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        print(f"  [{n}/{len(rows)}] {verdict:14s} {row['titleA'][:34]!r} | "
              f"{row['titleB'][:34]!r}", flush=True)

    # Spend is REPORTED, not estimated after the fact. The first two trial runs of this script
    # discarded response.usage entirely, so what they cost is unrecoverable.
    in_tok = sum(r["inputTokens"] for r in out_rows if r["inputTokens"] != "")
    out_tok = sum(r["outputTokens"] for r in out_rows if r["outputTokens"] != "")
    rate = PRICING.get(args.model)
    if rate and (in_tok or out_tok):
        cost = in_tok / 1e6 * rate[0] + out_tok / 1e6 * rate[1]
        print(f"\nusage: {in_tok:,} input + {out_tok:,} output tokens over {len(out_rows)} pairs"
              f"  =  ${cost:.3f} at {args.model} rates "
              f"(${cost/max(len(out_rows),1):.4f}/pair)")

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=VERDICT_COLUMNS)
        writer.writeheader()
        writer.writerows(out_rows)
    print(f"\nwrote {len(out_rows)} verdicts -> {args.out}")
    for verdict, n in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {verdict:14s} {n:4d}")
    flagged = [r for r in out_rows if "designationDiffers" in r["flags"]]
    if flagged:
        same = sum(1 for r in flagged if r["verdict"] == "SAME_WORK")
        print(f"\n  of {len(flagged)} designationDiffers pairs, {same} returned SAME_WORK — "
              f"read those rows before trusting any of them")
    print("\nNothing has been merged. This is a review file.")


if __name__ == "__main__":
    main()
