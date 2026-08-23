#!/usr/bin/env python3
"""
Build the Roseberys Prints & Multiples workbook from catalogue.csv.

Sheets
  Search         input cells + live filtered results (INDEX/MATCH, no dynamic arrays)
  Data           full extract as an Excel Table named "Lots" — pivot-ready
  Artist Summary per-artist aggregates (precomputed)
  Sale Summary   per-sale aggregates (precomputed)
  Read me        column glossary and caveats

Design notes
  - No FILTER/SORT/UNIQUE/XLOOKUP. openpyxl writes no spill metadata, so dynamic
    array formulas silently truncate to their top-left cell. Everything here is
    Excel-2007-era and works in any version.
  - The match helper uses a running TOTAL rather than a running COUNT, so each row
    is O(1). MATCH(n, running_total, 0) lands on the nth matching row, because the
    total only increments on a match.
  - Each result row resolves its source row ONCE into a hidden column, so the sheet
    does 250 MATCHes over the data rather than 250 x 12.

Usage: python3 build_workbook.py <catalogue.csv> <output.xlsx>
"""

import sys
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

FONT = "Arial"
RESULT_ROWS = 250          # rows of live results on the Search sheet
GOLD = "C0AA84"
CLARET = "4C0B2A"
CREAM = "FDFBF8"

# Data sheet column order — display-relevant fields first.
COLUMNS = [
    "sale_code", "auction_id", "lot_number", "artist", "title", "year",
    "medium", "support", "width_cm", "height_cm", "edition_size",
    "signed", "framed", "low_estimate", "high_estimate", "hammer",
    "price_realised_inc_premium", "sold", "ratio_to_high_est", "ratio_to_low_est",
    "artist_qualifier", "other_artists", "nationality", "life_dates",
    "dim_kind", "edition_note", "printer", "publisher", "catalogue_refs",
    "multi_work", "arr", "reserve", "hammer_basis", "premium_ratio_used",
    "provenance", "lot_url", "image_url",
]

# Columns shown in the Search results grid, in order.
RESULT_COLS = [
    "sale_code", "lot_number", "artist", "title", "year", "medium",
    "low_estimate", "high_estimate", "hammer", "price_realised_inc_premium",
    "sold", "ratio_to_high_est", "lot_url",
]

MONEY = {"low_estimate", "high_estimate", "hammer",
         "price_realised_inc_premium", "reserve"}
RATIO = {"ratio_to_high_est", "ratio_to_low_est", "premium_ratio_used"}

GLOSSARY = [
    ("sale_code",       "Roseberys sale reference, e.g. A0785."),
    ("lot_number",      "Lot number within that sale."),
    ("artist",          "Primary artist, parsed from the first line of the catalogue entry."),
    ("other_artists",   "Further names on the same line (e.g. a folio illustrated by a second artist)."),
    ("artist_qualifier","certain / attributed / circle / studio / follower / after, from catalogue wording."),
    ("title",           "Work title, with the trailing year stripped into 'year'."),
    ("medium",          "Printmaking technique, e.g. 'etching and aquatint in colours'."),
    ("support",         "Paper or substrate, taken from the text after ' on '."),
    ("width_cm / height_cm", "First stated dimension, normalised to centimetres."),
    ("dim_kind",        "Which measurement it is: image, sheet, plate, overall."),
    ("edition_size",    "Edition size where stated."),
    ("low/high_estimate", "Pre-sale estimate, hammer basis, GBP."),
    ("reserve",         "Reserve where published."),
    ("hammer",          "Hammer price, GBP. See hammer_basis — some are reconstructed."),
    ("price_realised_inc_premium", "Hammer plus buyer's premium — the figure shown on the website."),
    ("hammer_basis",    "'reported' = taken directly from the record. "
                        "'derived' = reconstructed by removing buyer's premium (older sales "
                        "publish only the premium-inclusive figure)."),
    ("premium_ratio_used", "Premium divisor used for a derived hammer (1.30 or 1.312)."),
    ("sold",            "sold / unsold. A blank hammer means the lot did not sell."),
    ("ratio_to_high_est", "hammer / high estimate. Above 1.0 beat the top estimate."),
    ("arr",             "Artist's Resale Right applied — indicates the artist's copyright is likely live."),
    ("multi_work",      "Non-blank where the lot contains more than one work."),
]

CAVEATS = [
    "Reconstructed hammer prices",
    "  Roseberys' records only carry a separate hammer field on recent sales. For older sales the",
    "  published figure includes buyer's premium, so hammer has been reconstructed by removing it",
    "  (25%+VAT = 1.30 historically, 26%+VAT = 1.312 from sale A0612 onward) and snapping the result",
    "  to the nearest bid increment. The 1.30 rate was inferred for older sales and then confirmed:",
    "  sale A0592 reports it directly. Check hammer_basis to see which figures are reconstructed;",
    "  roughly 58% of them are. Treat those as close estimates, not as records.",
    "",
    "Parsing coverage",
    "  Fields are parsed from free-text catalogue entries. Artist, title and medium resolve for",
    "  essentially every lot; dimensions for about 87%; edition size for about 57%. Blank means the",
    "  value could not be read from the text — nothing here is guessed or filled in.",
    "",
    "Scope",
    "  43 Prints & Multiples sales, 2016 to July 2026, drawn from the public catalogue on",
    "  roseberys.co.uk. Withdrawn and unpublished lots are excluded.",
]


def money_fmt():
    return '£#,##0;(£#,##0);-'


def build(csv_path: Path, out_path: Path) -> None:
    print(f"Reading {csv_path} ...")
    df = pd.read_csv(csv_path, encoding="utf-8-sig", low_memory=False)
    df = df.reindex(columns=[c for c in COLUMNS if c in df.columns])

    for c in MONEY | RATIO | {"width_cm", "height_cm", "edition_size", "lot_number", "year"}:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    n = len(df)
    print(f"  {n:,} rows x {len(df.columns)} columns")

    # ---------------------------------------------------------- summaries
    sold = df[df["sold"] == "sold"]

    artist = (
        df.groupby("artist")
          .agg(lots_offered=("lot_number", "size"),
               lots_sold=("sold", lambda s: (s == "sold").sum()))
          .join(sold.groupby("artist").agg(
               median_hammer=("hammer", "median"),
               lowest_hammer=("hammer", "min"),
               highest_hammer=("hammer", "max"),
               median_ratio_to_high_est=("ratio_to_high_est", "median")))
          .reset_index()
    )
    artist["sell_through_pct"] = (artist.lots_sold / artist.lots_offered * 100).round(1)
    artist = artist[["artist", "lots_offered", "lots_sold", "sell_through_pct",
                     "median_hammer", "lowest_hammer", "highest_hammer",
                     "median_ratio_to_high_est"]]
    artist = artist.sort_values(["lots_offered", "artist"], ascending=[False, True])

    sale = (
        df.groupby("sale_code")
          .agg(lots=("lot_number", "size"),
               sold_lots=("sold", lambda s: (s == "sold").sum()),
               distinct_artists=("artist", "nunique"))
          .join(sold.groupby("sale_code").agg(
               total_hammer=("hammer", "sum"),
               median_hammer=("hammer", "median"),
               top_hammer=("hammer", "max")))
          .reset_index()
    )
    sale["sell_through_pct"] = (sale.sold_lots / sale.lots * 100).round(1)
    sale = sale.sort_values("sale_code")

    # ------------------------------------------------------------- write
    print("Writing sheets ...")
    with pd.ExcelWriter(out_path, engine="openpyxl") as xl:
        df.to_excel(xl, sheet_name="Data", index=False)
        artist.to_excel(xl, sheet_name="Artist Summary", index=False)
        sale.to_excel(xl, sheet_name="Sale Summary", index=False)

    wb = load_workbook(out_path)
    data = wb["Data"]
    last_row = n + 1
    ncols = len(df.columns)
    col_of = {name: i + 1 for i, name in enumerate(df.columns)}

    # Helper columns sit OUTSIDE the table so pivots stay clean.
    m_col = ncols + 2                      # match flag 1/0
    c_col = ncols + 3                      # running total of matches
    m_L, c_L = get_column_letter(m_col), get_column_letter(c_col)
    data.cell(1, m_col, "match").font = Font(name=FONT, bold=True, size=9)
    data.cell(1, c_col, "cum").font = Font(name=FONT, bold=True, size=9)

    L = {name: get_column_letter(col_of[name]) for name in df.columns}

    print("  helper formulas ...")
    for r in range(2, last_row + 1):
        data.cell(r, m_col).value = (
            "=IF(AND("
            f'ISNUMBER(SEARCH(Search!$B$5&"",{L["artist"]}{r}&"")),'
            f'ISNUMBER(SEARCH(Search!$B$6&"",{L["title"]}{r}&"")),'
            f'ISNUMBER(SEARCH(Search!$B$7&"",{L["medium"]}{r}&"")),'
            f'OR(Search!$B$8="",{L["sale_code"]}{r}=Search!$B$8),'
            f'OR(Search!$B$9="All",{L["sold"]}{r}=Search!$B$9),'
            f'OR(Search!$B$10="",N({L["hammer"]}{r})>=N(Search!$B$10)),'
            f'OR(Search!$B$11="",N({L["hammer"]}{r})<=N(Search!$B$11)),'
            f'OR(Search!$B$12="",N({L["year"]}{r})>=N(Search!$B$12)),'
            f'OR(Search!$B$13="",N({L["year"]}{r})<=N(Search!$B$13))'
            "),1,0)"
        )
        # Running TOTAL, not running count: O(1) per row.
        data.cell(r, c_col).value = f"=N({c_L}{r-1})+{m_L}{r}"

    data.column_dimensions[m_L].hidden = True
    data.column_dimensions[c_L].hidden = True

    # Excel Table over the data block only — makes Insert > PivotTable two clicks.
    ref = f"A1:{get_column_letter(ncols)}{last_row}"
    tbl = Table(displayName="Lots", ref=ref)
    tbl.tableStyleInfo = TableStyleInfo(
        name="TableStyleMedium2", showRowStripes=True, showColumnStripes=False)
    data.add_table(tbl)
    data.freeze_panes = "D2"

    for name in df.columns:
        c = data.cell(1, col_of[name])
        c.font = Font(name=FONT, bold=True, size=10)
        c.alignment = Alignment(vertical="center", wrap_text=True)
        letter = L[name]
        width = 40 if name in ("title", "provenance", "lot_url", "image_url") else \
                26 if name in ("artist", "medium", "support", "printer", "publisher") else 13
        data.column_dimensions[letter].width = width
        fmt = money_fmt() if name in MONEY else ("0.00" if name in RATIO else None)
        if fmt:
            for r in range(2, last_row + 1):
                data.cell(r, col_of[name]).number_format = fmt

    # ------------------------------------------------------- Search sheet
    print("  search sheet ...")
    s = wb.create_sheet("Search", 0)
    s.sheet_properties.tabColor = CLARET

    s["A1"] = "Roseberys Prints & Multiples — Lot Search"
    s["A1"].font = Font(name=FONT, bold=True, size=16, color=CLARET)
    s["A2"] = (f"{n:,} lots across {df.sale_code.nunique()} sales, 2016–2026. "
               "Type in the yellow cells; results update automatically.")
    s["A2"].font = Font(name=FONT, size=10, italic=True, color="7A6C71")

    s["A4"] = "SEARCH CRITERIA"
    s["A4"].font = Font(name=FONT, bold=True, size=11, color=CLARET)

    inputs = [
        ("Artist contains",      "", "Part of a name is enough — 'trevelyan' finds Julian Trevelyan RA."),
        ("Title contains",       "", "Leave blank to ignore."),
        ("Medium contains",      "", "e.g. etching, lithograph, screenprint."),
        ("Sale code",            "", "e.g. A0785. Blank = every sale."),
        ("Status",            "All", "All, sold, or unsold."),
        ("Min hammer (£)",       "", "Blank = no minimum."),
        ("Max hammer (£)",       "", "Blank = no maximum."),
        ("Year from",            "", "Year the work was made, not the sale year."),
        ("Year to",              "", "Blank = no upper bound."),
    ]
    yellow = PatternFill("solid", fgColor="FFFF99")
    thin = Side(style="thin", color="BFBFBF")
    for i, (label, default, hint) in enumerate(inputs):
        r = 5 + i
        s.cell(r, 1, label).font = Font(name=FONT, bold=True, size=10)
        cell = s.cell(r, 2, default)
        cell.fill = yellow
        cell.font = Font(name=FONT, size=10)
        cell.border = Border(thin, thin, thin, thin)
        s.cell(r, 3, hint).font = Font(name=FONT, size=9, italic=True, color="808080")

    dv = DataValidation(type="list", formula1='"All,sold,unsold"', allow_blank=True)
    s.add_data_validation(dv)
    dv.add(s["B9"])

    s["A15"] = "Matches found"
    s["A15"].font = Font(name=FONT, bold=True, size=11, color=CLARET)
    s["B15"] = f"=COUNTIF(Data!${m_L}$2:${m_L}${last_row},1)"
    s["B15"].font = Font(name=FONT, bold=True, size=14, color=CLARET)
    s["C15"] = (f'=IF(B15>{RESULT_ROWS},"showing first {RESULT_ROWS} — narrow your search",'
                f'IF(B15=0,"no matches — try fewer criteria",""))')
    s["C15"].font = Font(name=FONT, size=10, italic=True, color="C00000")

    stats = [
        ("Sold", f'=COUNTIFS(Data!${m_L}$2:${m_L}${last_row},1,'
                 f'Data!${L["sold"]}$2:${L["sold"]}${last_row},"sold")', "0"),
        ("Average hammer", f'=IFERROR(AVERAGEIFS(Data!${L["hammer"]}$2:${L["hammer"]}${last_row},'
                           f'Data!${m_L}$2:${m_L}${last_row},1,'
                           f'Data!${L["hammer"]}$2:${L["hammer"]}${last_row},">0"),"")', money_fmt()),
        ("Lowest hammer", f'=IFERROR(_xlfn.MINIFS(Data!${L["hammer"]}$2:${L["hammer"]}${last_row},'
                          f'Data!${m_L}$2:${m_L}${last_row},1,'
                          f'Data!${L["hammer"]}$2:${L["hammer"]}${last_row},">0"),"")', money_fmt()),
        ("Highest hammer", f'=IFERROR(_xlfn.MAXIFS(Data!${L["hammer"]}$2:${L["hammer"]}${last_row},'
                           f'Data!${m_L}$2:${m_L}${last_row},1),"")', money_fmt()),
    ]
    for i, (label, formula, fmt) in enumerate(stats):
        c = 5 + i * 2
        s.cell(15, c, label).font = Font(name=FONT, bold=True, size=9, color="7A6C71")
        cell = s.cell(15, c + 1, formula)
        cell.font = Font(name=FONT, bold=True, size=11)
        if fmt != "0":
            cell.number_format = fmt

    # Results grid
    hdr_row = 17
    s.cell(hdr_row, 1, "#").font = Font(name=FONT, bold=True, size=9, color="FFFFFF")
    s.cell(hdr_row, 1).fill = PatternFill("solid", fgColor=CLARET)
    for i, name in enumerate(RESULT_COLS):
        c = s.cell(hdr_row, i + 2, name)
        c.font = Font(name=FONT, bold=True, size=9, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=CLARET)
        c.alignment = Alignment(vertical="center", wrap_text=True)

    row_col = len(RESULT_COLS) + 3          # hidden: resolved source row
    row_L = get_column_letter(row_col)
    s.cell(hdr_row, row_col, "src_row").font = Font(name=FONT, size=8)
    s.column_dimensions[row_L].hidden = True

    for k in range(1, RESULT_ROWS + 1):
        r = hdr_row + k
        s.cell(r, 1, k).font = Font(name=FONT, size=9, color="A0A0A0")
        # Resolve the source row once per result row, then INDEX off it.
        s.cell(r, row_col).value = (
            f'=IFERROR(MATCH($A{r},Data!${c_L}$2:${c_L}${last_row},0),"")'
        )
        for i, name in enumerate(RESULT_COLS):
            src = L[name]
            cell = s.cell(r, i + 2)
            cell.value = (
                f'=IF(${row_L}{r}="","",'
                f'IF(INDEX(Data!${src}$2:${src}${last_row},${row_L}{r})="","",'
                f'INDEX(Data!${src}$2:${src}${last_row},${row_L}{r})))'
            )
            cell.font = Font(name=FONT, size=9)
            if name in MONEY:
                cell.number_format = money_fmt()
            elif name in RATIO:
                cell.number_format = "0.00"

    widths = {"sale_code": 10, "lot_number": 8, "artist": 28, "title": 42, "year": 7,
              "medium": 26, "low_estimate": 12, "high_estimate": 12, "hammer": 12,
              "price_realised_inc_premium": 15, "sold": 9, "ratio_to_high_est": 10,
              "lot_url": 46}
    s.column_dimensions["A"].width = 22
    s.column_dimensions["B"].width = 24
    s.column_dimensions["C"].width = 34
    for i, name in enumerate(RESULT_COLS):
        s.column_dimensions[get_column_letter(i + 2)].width = widths.get(name, 14)
    s.freeze_panes = f"A{hdr_row + 1}"

    s["B5"].comment = Comment(
        "Matching is 'contains', not exact — partial names work.\n"
        "Leave any box blank to ignore that criterion.", "Extract")

    # ------------------------------------------------------ summary sheets
    for sheet_name, widths_map in (
        ("Artist Summary", {"A": 34}),
        ("Sale Summary", {"A": 12}),
    ):
        ws = wb[sheet_name]
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        for cell in ws[1]:
            cell.font = Font(name=FONT, bold=True, size=10, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor=CLARET)
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        for col_letter, w in widths_map.items():
            ws.column_dimensions[col_letter].width = w
        for col in ws.iter_cols(min_row=2):
            head = ws.cell(1, col[0].column).value or ""
            if "hammer" in head and "ratio" not in head:
                for cell in col:
                    cell.number_format = money_fmt()
            elif "ratio" in head or "pct" in head:
                for cell in col:
                    cell.number_format = "0.0"
            if ws.column_dimensions[get_column_letter(col[0].column)].width in (None, 13):
                ws.column_dimensions[get_column_letter(col[0].column)].width = 15

    # ------------------------------------------------------------ Read me
    rm = wb.create_sheet("Read me")
    rm.sheet_properties.tabColor = GOLD
    rm["A1"] = "Roseberys Prints & Multiples — catalogue extract"
    rm["A1"].font = Font(name=FONT, bold=True, size=16, color=CLARET)
    r = 3
    rm.cell(r, 1, "How to use this workbook").font = Font(name=FONT, bold=True, size=12, color=CLARET)
    r += 1
    for line in [
        "Search — type into the yellow cells. Results update as you type; no filtering needed.",
        "Data — every lot, as an Excel Table called 'Lots'. Use the filter arrows, or select any",
        "       cell and choose Insert > PivotTable to build your own analysis.",
        "Artist Summary — one row per artist: lots offered, sell-through, median and range of hammer.",
        "Sale Summary — one row per sale: size, sell-through, total and top hammer.",
    ]:
        rm.cell(r, 1, line).font = Font(name=FONT, size=10)
        r += 1

    r += 1
    rm.cell(r, 1, "Please read before relying on the figures").font = Font(
        name=FONT, bold=True, size=12, color="C00000")
    r += 1
    for line in CAVEATS:
        c = rm.cell(r, 1, line)
        c.font = Font(name=FONT, bold=line and not line.startswith(" "), size=10)
        r += 1

    r += 1
    rm.cell(r, 1, "Column glossary").font = Font(name=FONT, bold=True, size=12, color=CLARET)
    r += 1
    for name, desc in GLOSSARY:
        rm.cell(r, 1, name).font = Font(name=FONT, bold=True, size=9)
        rm.cell(r, 2, desc).font = Font(name=FONT, size=9)
        r += 1
    rm.column_dimensions["A"].width = 30
    rm.column_dimensions["B"].width = 100

    wb.calculation.fullCalcOnLoad = True
    wb.active = 0
    print(f"Saving {out_path} ...")
    wb.save(out_path)
    print(f"  done — {out_path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build(Path(sys.argv[1]), Path(sys.argv[2]))
