#!/usr/bin/env python3
"""Import historical vessel daily-reports from the .eml mailbox into
``data/daily-reports/{VESSEL}-{YYYYMMDD}.json``.

Each captain emails one daily report per midnight:
- Allianz Juno → `.docx` attachment (Allianz Marine template)
- Crest Argus 1 / 3 / 5 → `.pdf` attachment (Halliburton / OFCO template)

The two templates differ in column count and layout, but share the same
key blocks: header, 24-hour consumables, operational task log, crew list,
lifts, provisions, compiled-by.  The parser below extracts the fields that
the simulation needs (date, voyage, task log → vessel position timeline,
key consumables, safety counts, lifts, delays, issues) and stores them in
the canonical schema defined in `data/daily-report.schema.json`.

Dedup rule: same `(vessel_id, report_date)` keeps the **earliest** email
date and ignores `Re-`, `RE-`, `Recall-`, `[1]`, `[2]` duplicates.

Run:
    python3 tools/parse_daily_reports.py
"""

from __future__ import annotations

import email
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from email import policy
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET

# Make `tools.normalize` importable when run from project root or tools/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.normalize import (  # noqa: E402
    HOME_BERTH,
    find_locations,
    label_task,
    parse_date_dmy,
    parse_duration_to_min,
    resolve_location,
    resolve_vessel,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INBOX_DIR = PROJECT_ROOT / "Vessels daily report"
OUT_DIR = PROJECT_ROOT / "data" / "daily-reports"

# ---------------------------------------------------------------------------
# .eml helpers
# ---------------------------------------------------------------------------

def parse_eml(path: Path) -> email.message.EmailMessage:
    with open(path, "rb") as f:
        return email.message_from_binary_file(f, policy=policy.default)


def extract_attachment(msg: email.message.EmailMessage, out_dir: Path) -> Path | None:
    for part in msg.walk():
        cd = (part.get("Content-Disposition") or "").lower()
        if "attachment" in cd:
            fn = part.get_filename() or "attachment.bin"
            out = out_dir / fn
            with open(out, "wb") as o:
                o.write(part.get_payload(decode=True))
            return out
    return None


# ---------------------------------------------------------------------------
# DOCX extraction (Allianz Juno)
# ---------------------------------------------------------------------------

WORD_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def docx_rows(docx_path: Path) -> list[list[list[str]]]:
    """Return [[row-cells]] tables from a docx.  Each cell is a list of
    paragraph strings so we can spot multi-line cells."""
    with zipfile.ZipFile(docx_path) as z, z.open("word/document.xml") as f:
        tree = ET.parse(f)
    tables: list[list[list[list[str]]]] = []
    for tbl in tree.getroot().iter(f"{{{WORD_NS['w']}}}tbl"):
        rows: list[list[list[str]]] = []
        for row in tbl.findall(".//w:tr", WORD_NS):
            cells: list[list[str]] = []
            for cell in row.findall("w:tc", WORD_NS):
                paras: list[str] = []
                for p in cell.findall(".//w:p", WORD_NS):
                    txt = "".join(t.text or "" for t in p.findall(".//w:t", WORD_NS))
                    if txt.strip():
                        paras.append(txt.strip())
                cells.append(paras)
            rows.append(cells)
        tables.append(rows)
    return tables


def parse_juno_docx(docx_path: Path) -> dict:
    """Parse the Allianz Juno daily report .docx.

    The Juno template has *one* big table with logical sections separated
    by header rows.  We iterate cells, detect section headers, and fan out
    into the canonical schema.
    """
    out: dict = {
        "consumables": {},
        "task_log": [],
        "crew": [],
        "passengers": [],
        "safety": {},
        "provisions": {},
        "delays": {},
        "lifts": {},
    }

    tables = docx_rows(docx_path)
    if not tables:
        return out
    main = tables[0]

    # Flatten table rows into a stream of (cells, joined) for header detection.
    def cell_text(c: list[str]) -> str:
        return " ".join(c).strip()

    section = None
    for row in main:
        joined = " | ".join(cell_text(c) for c in row).strip()
        joined_low = joined.lower()

        # Header detection
        if "period ending" in joined_low and "voyage" in joined_low:
            # row: 'Vessel Name | Period ending 24:00hrs | 06 MAY 2026 | Voyage No: 0 |'
            for c in row:
                t = cell_text(c)
                m = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b", t)
                if m:
                    out["report_date"] = parse_date_dmy(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
                m = re.search(r"voyage\s*no[:\s.]*([\w/\-]+)", t, re.I)
                if m:
                    out["voyage_no"] = m.group(1)
            continue

        if "safety performance" in joined_low:
            # 'Accidents: - | Incidents: - | Near Miss: -'
            for c in row:
                t = cell_text(c)
                for key, label in (("accidents", "Accidents"),
                                   ("incidents", "Incidents"),
                                   ("near_miss", "Near Miss")):
                    m = re.search(rf"{label}\s*[:\-]?\s*([^|]*)", t, re.I)
                    if m and m.group(1).strip():
                        out["safety"][key] = m.group(1).strip().strip("-").strip() or "Nil"
            continue

        if "days since last port" in joined_low or "security level" in joined_low:
            # Header row, captures next-crew-change + security level
            for c in row:
                t = cell_text(c)
                m = re.search(r"security level\s*[:\-]?\s*(\d+)", t, re.I)
                if m:
                    try:
                        out["security_level"] = int(m.group(1))
                    except ValueError:
                        pass
            continue

        if "24 hr" in joined_low and "consumable" in joined_low:
            section = "consumables"
            continue

        if section == "consumables":
            # Either header row "Product | Loaded | ..." or a data row.
            cells = [cell_text(c) for c in row]
            if cells and cells[0].lower() in {"product"}:
                continue
            if cells and cells[0]:
                key = cells[0].lower().strip()
                if key in {"fuel", "water"}:
                    out["consumables"][f"{'fuel_oil' if key == 'fuel' else 'fresh_water'}"] = {
                        "loaded": cells[1] if len(cells) > 1 else None,
                        "discharged": cells[2] if len(cells) > 2 else None,
                        "consumed": cells[3] if len(cells) > 3 else None,
                        "rob": cells[4] if len(cells) > 4 else None,
                        "max_capacity": cells[5] if len(cells) > 5 else None,
                        "remaining_to_load": cells[6] if len(cells) > 6 else None,
                        "remarks": "",
                    }

        if "operational task codes" in joined_low:
            section = "task_log"
            continue

        if section == "task_log":
            cells = [cell_text(c) for c in row]
            # Skip the header row "From | To | Hours: min | Task code | Description Log"
            if cells and cells[0].lower() == "from":
                continue
            # Skip empty rows
            if not any(cells):
                continue
            # Stop conditions
            if any("lifts on deck" in c.lower() for c in cells):
                section = None
                continue
            # Heuristic: a task-log row starts with a time HH:MM or HH:MM-
            if len(cells) >= 5 and re.match(r"^\d{1,2}:\d{2}-?$", cells[0]):
                from_t = _norm_time(cells[0].rstrip("-"))
                to_t = _norm_time(cells[1]) if cells[1] and re.match(r"^\d{1,2}:\d{2}$", cells[1]) else None
                hrs = cells[2] if cells[2] else None
                code = cells[3]
                desc = cells[4]
                locs = find_locations(desc, "JUNO")
                entry = {
                    "from_time": from_t,
                    "to_time": to_t,
                    "duration_min": parse_duration_to_min(hrs),
                    "task_code": code,
                    "task_label": label_task(code),
                    "description": desc,
                    "location_id": locs[-1] if locs else None,
                    "from_location_id": locs[0] if len(locs) >= 2 else None,
                    "to_location_id": locs[-1] if len(locs) >= 2 else None,
                }
                out["task_log"].append(entry)

        if joined_low.startswith("crew list"):
            section = "crew"
            continue

        if section == "crew":
            cells = [cell_text(c) for c in row]
            if not any(cells):
                continue
            if cells and cells[0].lower() in {"first name", "name (first)"}:
                continue
            if cells and "passenger" in cells[0].lower():
                section = None
                continue
            if len(cells) >= 4 and cells[0] and cells[2]:
                days = re.search(r"(\d+)", cells[3] or "")
                out["crew"].append({
                    "first": cells[0],
                    "last": cells[1] if len(cells) > 1 else "",
                    "position": cells[2],
                    "days_onboard": int(days.group(1)) if days else None,
                    "sign_on_date": cells[4] if len(cells) > 4 else None,
                    "planned_crew_change": cells[5] if len(cells) > 5 else None,
                })

    # The Lifts cells often live in a row we already passed; re-scan once.
    for row in main:
        cells = [cell_text(c) for c in row]
        joined_low = " | ".join(cells).lower()
        if "lifts on deck" in joined_low:
            try:
                ix = next(i for i, c in enumerate(cells) if "lifts on deck" in c.lower())
                on_deck = cells[ix + 1] if ix + 1 < len(cells) else ""
                # Next "Lifts Loaded" ...
                jx = next((i for i, c in enumerate(cells) if "lifts loaded" in c.lower()), -1)
                loaded = cells[jx + 1] if jx >= 0 and jx + 1 < len(cells) else ""
                kx = next((i for i, c in enumerate(cells) if "deck utilization" in c.lower()), -1)
                util = cells[kx + 1] if kx >= 0 and kx + 1 < len(cells) else ""
                out["lifts"] = {
                    "on_deck": on_deck,
                    "loaded": loaded,
                    "discharged": "",
                    "utilization_pct": _to_num(util),
                }
            except Exception:
                pass
            break

    return out


# ---------------------------------------------------------------------------
# PDF extraction (Crest Argus 1 / 3 / 5)
# ---------------------------------------------------------------------------

def pdf_to_layout_text(pdf_path: Path) -> str:
    res = subprocess.run(
        ["pdftotext", "-layout", "-nopgbrk", str(pdf_path), "-"],
        check=True, capture_output=True, text=True,
    )
    return res.stdout


# Single-line layout (CA1, CA3):  from  to  hrs  code  desc
# The description is optional: when a row's only description is long enough to
# wrap, the template centres the times vertically against it, leaving the
# times-and-code line bare and the text on the lines around it.  Requiring a
# description here silently dropped those rows — a whole day's log, on reports
# where the vessel sat at anchor and the master wrote one long line.
_ROW_FULL_RE = re.compile(
    r"^\s*(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+"
    r"([A-Z]\w{0,3}(?:/[A-Z]\w{0,3})?)(?:\s+(.+?))?\s*$"
)
# CA5's two-line layout:
#   Line A (hrs + code, optionally followed by description text):
#     "<spaces> H:MM  <spaces> CODE [<spaces> <desc>]"
_ROW_PARTIAL_HRS_CODE_RE = re.compile(
    r"^\s*(\d{1,2}:\d{2})\s+([A-Z]\w{0,3}(?:/[A-Z]\w{0,3})?)(?:\s+(\S.*?))?\s*$"
)
#   Line B (from + to, optionally followed by description text):
#     "<spaces> H:MM <spaces> H:MM [<spaces> <desc>]"
# (Some CA5 reports drop the colon: "0712"; treat as typo, accept it.  Others
# lose a digit — "24:0" — so the second time is matched loosely and normalised
# below; a to-time we cannot read must not cost us the whole row.)
_ROW_PARTIAL_FROM_TO_DESC_RE = re.compile(
    r"^\s*(\d{1,2}:?\d{2})\s+(\d{1,2}:?\d{1,2})(?:\s+(\S.*?))?\s*$"
)


# The column headers wrap ("Task code" leaves a bare "code" on the next line),
# and the block we slice starts mid-header — so these fragments would otherwise
# be adopted as the first words of a description.
_HEADER_FRAGMENT_RE = re.compile(
    r"^(?:(?:task\s*)?code|log|min|hrs\s*/?\s*min|from|to|description(?:\s+log)?)$",
    re.I,
)


def _fix_time(s: str) -> str | None:
    """Accept '07:25', '7:25', or typo '0725' -> 'HH:MM'."""
    if not s:
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if m:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    m = re.match(r"^(\d{2})(\d{2})$", s)
    if m:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    return None

# Same normalizer used by the docx (Allianz Juno) path so all emitted
# from_time / to_time values are guaranteed HH:MM zero-padded.
_norm_time = _fix_time


def extract_task_log_block(text: str, vessel_id: str) -> list[dict]:
    """Parse the operational task log block from the Crest PDF layout text.

    Handles two known layouts:
      * CA1 / CA3: one line per row (from, to, hrs, code, desc).
      * CA5:       two lines per row — (hrs, code) on one line, then
                   (from, to, desc) on the next.
    """
    block = _slice_between(text, r"Description\s+Log",
                           r"(?:Crew List|Lifts On Deck|Operational Task Codes)\b")
    if not block:
        return []
    rows: list[dict] = []
    # (hrs, code, desc-from-line-A) — desc may be None
    pending: tuple[str | None, str | None, str | None] = (None, None, None)
    # Description text for a row whose own line carried none: the lines just
    # before it, then any lines just after it, up to the next row or blank line.
    orphans: list[str] = []
    awaiting: int | None = None

    def _adopt(idx: int, extra: str) -> None:
        rows[idx]["description"] = _clean(f"{rows[idx]['description']} {extra}")
        locs = find_locations(rows[idx]["description"], vessel_id)
        rows[idx]["location_id"]      = locs[-1] if locs else None
        rows[idx]["from_location_id"] = locs[0]  if len(locs) >= 2 else None
        rows[idx]["to_location_id"]   = locs[-1] if len(locs) >= 2 else None

    for raw_line in block.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            pending = (None, None, None)
            orphans = []
            awaiting = None
            continue
        # 1) Full single-line row (CA1/CA3)
        m = _ROW_FULL_RE.match(line)
        if m:
            from_t, to_t, hrs, code, desc = m.groups()
            desc = (desc or "").strip()
            if not desc and orphans:
                desc = " ".join(orphans)
            _append_row(rows, vessel_id, from_t, to_t, hrs, code, desc)
            # Only a row still short of a description may adopt the lines that
            # follow; rows that named their own must not swallow stray text.
            awaiting = len(rows) - 1 if (rows and not m.group(5)) else None
            orphans = []
            pending = (None, None, None)
            continue
        # 2) CA5 partial: hrs + code (optionally with description on the same line)
        m = _ROW_PARTIAL_HRS_CODE_RE.match(line)
        if m:
            pending = (m.group(1), m.group(2), m.group(3))
            awaiting = None
            continue
        # 3) CA5 partial: from + to (optionally with description); pair with pending hrs+code
        m = _ROW_PARTIAL_FROM_TO_DESC_RE.match(line)
        if m and pending[0] is not None:
            from_t_raw, to_t_raw, desc_b = m.groups()
            from_t = _fix_time(from_t_raw)
            to_t = _fix_time(to_t_raw)
            if from_t:
                # Prefer line-B description; fall back to whatever was on line A.
                # If both are present, concatenate (line B usually has the
                # detail; line A may carry the first part of a wrapped desc).
                desc_a = pending[2]
                if desc_a and desc_b:
                    desc = f"{desc_a} {desc_b}".strip()
                else:
                    desc = desc_b or desc_a or ""
                _append_row(rows, vessel_id, from_t, to_t, pending[0], pending[1], desc)
                awaiting = len(rows) - 1 if (rows and not desc) else None
                pending = (None, None, None)
                orphans = []
                continue
        # 4) Free text — either the tail of the row above, or the description of
        #    a row whose times sit on the line below it.
        if _HEADER_FRAGMENT_RE.match(line.strip()):
            continue
        if awaiting is not None:
            _adopt(awaiting, line.strip())
        else:
            orphans.append(line.strip())
    return rows


def _append_row(rows: list[dict], vessel_id: str,
                from_t: str | None, to_t: str | None,
                hrs: str | None, code: str | None, desc: str) -> None:
    if not (from_t and code):
        return
    # Zero-pad times.  Both Crest PDF layouts can yield "7:00" instead
    # of "07:00" which the simulator's ISO parser later rejects.
    from_t = _fix_time(from_t) or from_t
    to_t   = _fix_time(to_t)   if to_t else None
    locs = find_locations(desc, vessel_id)
    rows.append({
        "from_time": from_t,
        "to_time": to_t if to_t and to_t != from_t else None,
        "duration_min": parse_duration_to_min(hrs),
        "task_code": code,
        "task_label": label_task(code),
        "description": _clean(desc),
        "location_id": locs[-1] if locs else None,
        "from_location_id": locs[0] if len(locs) >= 2 else None,
        "to_location_id": locs[-1] if len(locs) >= 2 else None,
    })


def parse_crest_pdf(pdf_path: Path, vessel_id: str) -> dict:
    """Parse a Halliburton/OFCO daily vessel report PDF."""
    text = pdf_to_layout_text(pdf_path)
    out: dict = {
        "consumables": {},
        "task_log": [],
        "crew": [],
        "passengers": [],
        "safety": {},
        "provisions": {},
        "delays": {},
        "lifts": {},
    }

    # Header
    m = re.search(r"Date[:\s]+(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})", text)
    if m:
        out["report_date"] = parse_date_dmy(m.group(1))
    m = re.search(r"Voyage\s*No[.:\s]*([\w/\-]+)", text, re.I)
    if m:
        out["voyage_no"] = m.group(1)
    m = re.search(r"Security\s*Level\s*[:\s]*(\d+)", text, re.I)
    if m:
        out["security_level"] = int(m.group(1))
    m = re.search(r"Days Since Last Port Call\s+(\d+)", text)
    if m:
        out["days_since_port_call"] = int(m.group(1))
    m = re.search(r"Next Crew\s*Change\s+([0-9A-Za-z\-/\. ]{6,15})", text)
    if m:
        nd = parse_date_dmy(m.group(1).strip())
        out["next_crew_change"] = nd or m.group(1).strip()

    # Safety is read from the cells further down (see _table_safety): matched as
    # text, a Near Miss cell narrow enough to stack "Nil" vertically yields the
    # single letter "i".

    # 24-hr consumables.  These were previously matched as one long line of the
    # form "Fuel oil  950 M3 (80%)  4.159 M3  -  467.234 M3 ...", which only
    # holds on some Crest reports: CA5's template puts the safe-fill "(85%)" and
    # even "950 M3" on their own lines, so the pattern silently found nothing and
    # the whole consumables block came back empty (0 of 9 CA5 reports had it).
    # Reading the ruled cells by column handles both spellings.
    tables: list = []
    try:
        pdfplumber = _require_pdfplumber()
        with pdfplumber.open(str(pdf_path)) as pdf:
            for pg in pdf.pages:
                tables.extend(_ruled_rows(pg))
        out["consumables"] = _table_consumables(tables)
        out["safety"] = _table_safety(tables)
        out.update(_table_scalars(tables))
    except Exception:
        # Never lose the task log (what the simulation runs on) over consumables.
        out["consumables"] = {}

    # Task log.  Read the ruled cells when the template draws them (CA1, CA5):
    # a row's own cell keeps its whole description, however the text wraps.  The
    # text reader below cannot tell which row a line between two rows belongs to,
    # and mis-splits wrapped descriptions — "Vessel was standing by 200 mtrs away
    # from Oriental Phoenix due" ends up on the row above "to weather condition".
    # Some Crest Argus 3 reports draw no borders at all, and only text remains.
    out["task_log"] = _ruled_task_log(tables, vessel_id, text) or extract_task_log_block(text, vessel_id)

    # Lifts
    m = re.search(r"Lifts On Deck\s+(.*?)\s+Lifts\s+Loaded\s+(.+?)\s+Lifts Discharged\s+(.+?)\s+Deck Utilization\s+([0-9.]+)\s*%", text, re.S)
    if m:
        out["lifts"] = {
            "on_deck": _clean(m.group(1)),
            "loaded": _clean(m.group(2)),
            "discharged": _clean(m.group(3)),
            "utilization_pct": float(m.group(4)),
        }

    # Provisions block
    for key, label in (
        ("dry_store_days", r"Dry Store"),
        ("fresh_frozen_days", r"Fresh\s*&?\s*Frozen Store"),
        ("drinking_water_days", r"Drinking Water"),
    ):
        m = re.search(rf"{label}\s*:\s*(\d+)\s*Days?", text, re.I)
        if m:
            out["provisions"][key] = int(m.group(1))
    m = re.search(r"(?:Fuel Oil unpumpable|FO Unpumpable)\s*:\s*([^\n]+)", text, re.I)
    if m:
        out["provisions"]["fuel_oil_unpumpable"] = _clean(m.group(1))
    m = re.search(r"Delay\s*Arrival Time\s*[:\-]?\s*([^\n]+)", text, re.I)
    if m:
        out["delays"]["arrival_time"] = _clean(m.group(1))
    m = re.search(r"Delay\s*Departure Time\s*[:\-]?\s*([^\n]+)", text, re.I)
    if m:
        out["delays"]["departure_time"] = _clean(m.group(1))

    # Issues / accident summary
    m = re.search(r"Issues, Concerns & Comments\s*(.+?)(?:Accident, Incident|Report Compiled By|$)", text, re.S)
    if m:
        out["issues_comments"] = _clean_block(m.group(1))
    m = re.search(r"Accident, Incident or Near Miss Summary Report\s*(.+?)(?:Report Compiled By|$)", text, re.S)
    if m:
        out["accident_summary"] = _clean_block(m.group(1))

    # Compiled by
    m = re.search(r"Report Compiled By:\s*(?:Master\s*:\s*)?([^\n|]+?)(?:Date|\|)\s*[:\s]*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\s*(?:Time)?[:\s]*([0-9:]+)?", text, re.I)
    if m:
        out["compiled_by"] = {
            "name": _clean(m.group(1)),
            "role": "Master",
        }

    return out


# ---------------------------------------------------------------------------
# PDF extraction (Charlie 3)
# ---------------------------------------------------------------------------
#
# Charlie 3 took over Allianz Juno's role on 20 May 2026 and its master kept
# Juno's Word template, so these PDFs are NOT the Halliburton/OFCO layout that
# parse_crest_pdf() above reads.  Two differences make the Crest patterns
# actively wrong here rather than merely unlucky:
#
#   * the consumable columns run  Loaded | Discharged | Consumption | ROB |
#     Max. Cap. | Rem to load.  The Crest template leads with Max. Cap., so
#     reading this table with the Crest regexes mis-assigns every figure.
#   * a task-log row is a ruled table cell.  When a description wraps onto a
#     second line the master's template centres the time vertically, putting it
#     on a *different* text line from its own task code — so line-oriented
#     regexes pair times with the wrong row.
#
# We therefore read the ruled cells with pdfplumber and decide each cell's
# meaning from where the column header sits, rather than from text shape.

def _require_pdfplumber():
    try:
        import pdfplumber  # noqa: F401
        return pdfplumber
    except ImportError:
        raise RuntimeError(
            "pdfplumber is needed to read Charlie 3 reports but is not installed. "
            "Run:  .venv/bin/pip install -r tools/requirements.txt"
        )


def _ruled_rows(page) -> list[list[tuple[float, float, str]]]:
    """Every ruled table on the page as rows of (x0, x1, text) cells.

    We keep each cell's x-position rather than its index in the extracted grid:
    this template merges cells heavily, so a column's grid index drifts between
    the header row and its own data (the "Max. Cap." header lands one index to
    the right of the figure beneath it).  Positions don't drift.
    """
    tables: list[list[list[tuple[float, float, str]]]] = []
    for tbl in page.find_tables():
        grid = tbl.extract()
        rows: list[list[tuple[float, float, str]]] = []
        for ri, row in enumerate(tbl.rows):
            cells: list[tuple[float, float, str]] = []
            for j, bbox in enumerate(row.cells):
                if bbox is None or ri >= len(grid) or j >= len(grid[ri]):
                    continue
                txt = grid[ri][j]
                if txt and txt.strip():
                    cells.append((bbox[0], bbox[2], txt.strip()))
            # CA5 draws the log with doubled borders (a box inside a box), and
            # pdfplumber then emits some rows with every cell twice, a few
            # points apart: "15:45 | 15:45 | 16:25 | 16:25 | …".  Columnised
            # that reads "15:45 15:45", which parses as no time at all, and the
            # whole row folds into the one above it.  Two same-text cells can
            # only both be real when they sit in different columns, so keep one
            # of any pair that overlaps horizontally.
            deduped: list[tuple[float, float, str]] = []
            for x0, x1, txt in cells:
                if any(t == txt and x0 < px1 and px0 < x1 for px0, px1, t in deduped):
                    continue
                deduped.append((x0, x1, txt))
            rows.append(deduped)
        tables.append(rows)
    return tables


def _columnise(cells: list[tuple[float, float, str]],
               bounds: list[tuple[str, float]]) -> dict[str, str]:
    """Assign each cell to the column its centre falls in.

    *bounds* is [(name, header_x0), ...] sorted left-to-right.  A cell belongs to
    the rightmost column starting at or before the cell's centre.
    """
    out: dict[str, list[str]] = {name: [] for name, _ in bounds}
    for x0, x1, txt in cells:
        cx = (x0 + x1) / 2
        name = bounds[0][0]
        for n, bx in bounds:
            if bx <= cx:
                name = n
            else:
                break
        out[name].append(txt.replace("\n", " ").strip())
    return {k: _clean(" ".join(v)) for k, v in out.items()}


def _unstack(s: str) -> str:
    """Re-join a value the template printed one letter per line.

    Some reports leave the Near Miss cell about five points wide, so "Nil" is
    laid out vertically as N / i / l.  Read as text that yields the single
    letter "i"; read as a cell it is three one-character lines, which can only
    be a wrapped word.
    """
    lines = [ln.strip() for ln in s.split("\n") if ln.strip()]
    if len(lines) > 1 and all(len(ln) == 1 for ln in lines):
        return "".join(lines)
    return _clean(" ".join(lines))


_SAFETY_LABELS = {"accidents": "accidents", "incidents": "incidents", "near miss": "near_miss"}

# Cells that are labels, never a neighbouring label's value.
_LABELISH = ("security", "level", "change", "next crew", "days since", "accidents",
             "incidents", "near miss", "vessel safety")


def _table_scalars(tables: list) -> dict:
    """Read Days Since Last Port Call / Next Crew Change / Security Level.

    These three share one table row, and the headings wrap: "Security" and
    "Level" land on separate text lines from each other and from the figure.
    Matched as text, the security level goes missing on every Crest report and
    can even be read as the days-since count — so pair each label cell with the
    cell to its right instead.
    """
    out: dict = {}
    for t in tables:
        for cells in t:
            joined = " ".join(c[2] for c in cells)
            if "Security" not in joined and "Days Since" not in joined:
                continue
            for i, (_x0, _x1, txt) in enumerate(cells):
                low = txt.replace("\n", " ").strip().lower()
                nxt = cells[i + 1][2].replace("\n", " ").strip() if i + 1 < len(cells) else ""
                if nxt.lower().startswith(_LABELISH):
                    nxt = ""
                if low.startswith("security"):
                    m = re.search(r"\b(\d+)\b", f"{txt} {nxt}")
                    if m:
                        out["security_level"] = int(m.group(1))
                elif low.startswith("days since last port call"):
                    m = re.search(r"\b(\d+)\b", nxt)
                    if m:
                        out["days_since_port_call"] = int(m.group(1))
                elif low.startswith("next crew"):
                    if nxt and nxt not in {"-", "--"}:
                        out["next_crew_change"] = parse_date_dmy(nxt) or nxt
            if out:
                return out
    return out


def _table_safety(tables: list) -> dict:
    """Read Accidents / Incidents / Near Miss from the ruled cells."""
    for t in tables:
        for ri, cells in enumerate(t):
            if not any("Safety Performance" in c[2] for c in cells):
                continue
            out: dict = {}
            for i, (_x0, _x1, txt) in enumerate(cells):
                m = re.match(r"(?i)\s*(accidents|incidents|near\s*miss)\s*:\s*(.*)$",
                             txt.replace("\n", " "))
                if not m:
                    continue
                key = _SAFETY_LABELS[re.sub(r"\s+", " ", m.group(1).lower())]
                # Charlie 3 keeps the value in the label's own cell ("Near Miss: -");
                # Crest puts it in the next cell along.
                val = m.group(2).strip()
                if not val and i + 1 < len(cells):
                    vx0, vx1, vtxt = cells[i + 1]
                    val = _unstack(vtxt)
                    # The Near Miss cell can be ~5pt wide, so "Nil" not only stacks
                    # inside one cell (N/i/l) but can spill into the rows around it
                    # in the same column — "N" on the safety row and "il" below, or
                    # "Ni" above and "l" on the row itself.  Gather the pieces back
                    # in reading order.
                    def _frags(rows_slice, xlo=vx0, xhi=vx1):
                        got = ""
                        for row in rows_slice:
                            for cx0, cx1, ctxt in row:
                                frag = _unstack(ctxt)
                                if (cx0 < xhi and cx1 > xlo and frag.isalpha()
                                        and len(frag) <= 3):
                                    got += frag
                        return got
                    # Only reassemble when what we have is too short to be a word
                    # on its own: a complete "Nil" must not go hoovering up its
                    # neighbours (it would swallow the Next Crew Change "TBA" two
                    # cells over and store "NilTBA").
                    if len(val) < 3:
                        val += _frags([cells[i + 2:]], vx1, vx1 + 20)
                        val = _frags(t[max(0, ri - 2):ri]) + val + _frags(t[ri + 1:ri + 3])
                        # Some reports rotate this cell, scattering "Nil" over two
                        # cells out of reading order ("i\nl" at x580, "N" at x588),
                        # so position cannot tell us the order.  The letters still
                        # can: only reorder when they spell exactly one word, and
                        # never invent a letter that isn't on the page.
                        if len(val) == 3 and sorted(val.lower()) == sorted("nil"):
                            val = "Nil"
                out[key] = "Nil" if val in {"-", "--", ""} else val
            if out:
                return out
    return {}


def _find_header(rows: list[list[tuple[float, float, str]]],
                 labels: dict[str, str],
                 optional: dict[str, str] | None = None,
                 ) -> tuple[int, dict[str, tuple[float, float]]] | None:
    """Locate the row carrying every required label.

    Returns its index and each column's (x0, x1).  Optional labels are picked up
    when the template has them.
    """
    wanted = {**labels, **(optional or {})}
    for i, cells in enumerate(rows):
        found: dict[str, tuple[float, float]] = {}
        for x0, x1, txt in cells:
            low = txt.replace("\n", " ").strip().lower()
            for key, prefix in wanted.items():
                prefixes = (prefix,) if isinstance(prefix, str) else prefix
                if key not in found and low.startswith(prefixes):
                    found[key] = (x0, x1)
        if all(k in found for k in labels):
            return i, found
    return None


def _bounds(found: dict[str, tuple[float, float]],
            spill: str | None = None) -> list[tuple[str, float]]:
    """Column boundaries, left to right.

    *spill* names a catch-all column starting at the right edge of the last
    labelled one.  CA5's consumable table carries a remarks column that has no
    header, so without this its dated bunkering notes land in "Loaded".
    """
    b = sorted(((k, v[0]) for k, v in found.items()), key=lambda kv: kv[1])
    if spill:
        b.append((spill, max(v[1] for v in found.values())))
    return b


# Charlie/Juno head this column "Hours: min", Crest heads it "HRS/MIN".
# Match the code column on "task" alone: Crest Argus 3 wraps the heading so the
# header cell holds only "Task" and drops "code" into the row beneath it.  With
# "task code" required, CA3 never matched, fell back to the text reader, and that
# reader cannot tell which row a line between two rows belongs to — it dropped
# whole entries (CA3's 24 May "give way to Charlie-3, MOB drill" row, 95 minutes).
TASK_LOG_LABELS = {"from": "from", "to": "to", "hours": ("hours", "hrs"),
                   "code": "task", "desc": "description"}


def _times_from_text(text: str, code: str, desc: str, hrs: str) -> tuple[str, str] | None:
    """Find a row's From/To in the text layout when its cells didn't survive.

    Where a log row straddles a page break the borders can go missing on one
    side of it, and the ruled reader sees only "01:10 | L2E | Deck cargo ops"
    with no times — the row is real, so recover its times from the same line of
    the text layout rather than drop it.
    """
    if not (code and hrs):
        return None
    head = re.escape(_clean(desc)[:20]) if desc else ""
    pat = (rf"(\d{{1,2}}:\d{{2}})\s+(\d{{1,2}}:\d{{2}})\s+{re.escape(hrs)}\s+"
           rf"{re.escape(code)}\s+{head}")
    m = re.search(pat, text)
    return (_fix_time(m.group(1)), _fix_time(m.group(2))) if m else None


def _ruled_task_log(tables: list, vessel_id: str, text: str = "") -> list[dict]:
    """Read the 24-hour task log out of the ruled table.

    Works for every template that draws the log as a real table — which is all
    of them except some Crest Argus 3 reports, where the log has no cell borders
    and extract_task_log_block() reads the text layout instead.
    """
    start_at = None
    for ti, t in enumerate(tables):
        hdr = _find_header(t, TASK_LOG_LABELS)
        if hdr is not None:
            start_at = (ti, hdr[0], _bounds(hdr[1]))
            break
    if start_at is None:
        return []
    ti0, hdr_i, bounds = start_at

    rows: list[dict] = []
    cur: dict | None = None
    carry: tuple[str | None, str | None] | None = None
    done = False
    # A long log runs past the end of its page and resumes in a *headerless*
    # table further on — Crest Argus 1's last two rows of 22 May sit alone on
    # page 3.  Stopping at the header table's end loses them, so carry on
    # through the later tables with the same columns until the next section.
    for ti in range(ti0, len(tables)):
        if done:
            break
        t = tables[ti]
        for cells in (t[hdr_i + 1:] if ti == ti0 else t):
            if not cells:
                continue
            joined = " ".join(c[2] for c in cells).lower()
            if any(k in joined for k in ("lifts on deck", "crew list",
                                         "passengers onboard", "report compiled by")):
                done = True
                break

            col  = _columnise(cells, bounds)
            f_t  = _fix_time(col["from"])
            t_t  = _fix_time(col["to"])
            hrs  = col["hours"]
            code = col["code"]
            desc = col["desc"]

            # Past the log's own table, only take rows that are unmistakably log
            # rows.  Crew and passenger tables sit in this column range too, and
            # adopting their cells as description would quietly corrupt the log.
            # Past the log's own table, a row must still look like a log row: a
            # code plus either its times or its hours (the hours let us recognise
            # a row whose times lost their cell borders at the page break — see
            # _times_from_text).  Crew and passenger tables share this column
            # range, so anything vaguer is left alone.
            if ti != ti0 and not (code and (f_t or t_t or carry or hrs)):
                continue

            if not code:
                # A wrapped description (or a stray time) belonging to the row above.
                if cur is not None:
                    if desc:
                        cur["description"] = _clean(f"{cur['description']} {desc}")
                    if f_t and not cur["from_time"]:
                        cur["from_time"] = f_t
                    elif t_t and not cur["to_time"]:
                        cur["to_time"] = t_t
                # A row can straddle a page break: its From/To print at the foot of
                # one page and its hours/code/description at the head of the next.
                # Hold the orphaned times for the code that follows — CA3's 24 June
                # "22:50–24:00 L2E Deck cargo ops" was lost between the two halves.
                if (f_t or t_t) and not hrs and not desc:
                    carry = (f_t, t_t)
                continue

            # This master writes an event's time in whichever of From/To he
            # reaches for, so a row carrying only a To time is still a single
            # timestamped event — not a segment ending then.  Anchor the row on
            # whichever time is present, and only treat it as a span when both are.
            if not (f_t or t_t) and carry:
                f_t, t_t = carry
            carry = None
            if not (f_t or t_t) and text:
                got = _times_from_text(text, code, desc, hrs)
                if got:
                    f_t, t_t = got
            start = f_t or t_t
            end   = t_t if (f_t and t_t and t_t != f_t) else None
            if not start:
                # Only fold stray text into the row above inside the log's own
                # table.  Beyond it we are walking other sections, and a cell we
                # failed to read is not licence to append it to the last log row.
                if ti == ti0 and cur is not None and desc:
                    cur["description"] = _clean(f"{cur['description']} {desc}")
                continue

            cur = {
                "from_time": start,
                "to_time": end,
                "duration_min": parse_duration_to_min(hrs),
                "task_code": code,
                "task_label": label_task(code),
                "description": _clean(desc),
                "location_id": None,
                "from_location_id": None,
                "to_location_id": None,
            }
            rows.append(cur)

    # Locations depend on the *finished* description, so resolve them only once
    # every continuation line has been folded in.
    for e in rows:
        locs = find_locations(e["description"], vessel_id)
        e["location_id"]      = locs[-1] if locs else None
        e["from_location_id"] = locs[0]  if len(locs) >= 2 else None
        e["to_location_id"]   = locs[-1] if len(locs) >= 2 else None
    return rows


CONSUMABLE_LABELS = {"product": "product", "loaded": "loaded", "discharged": "discharged",
                     "consumed": "consum", "rob": "rob", "max_capacity": "max",
                     "remaining_to_load": "rem"}
CONSUMABLE_OPTIONAL = {"remarks": "remarks"}

FIELD_ORDER = ["loaded", "discharged", "consumed", "rob", "max_capacity", "remaining_to_load"]

# A cell holding only a safe-fill percentage, e.g. "(85%)" wrapped under "950 M3".
_PCT_ONLY = re.compile(r"^\(\s*\d+(?:\.\d+)?\s*%\s*\)$")

# Longest/most specific first: "Drill Water" must not be taken for "Water".
PRODUCT_KEYS = [
    ("fresh water", "fresh_water"),
    ("drill water", "drill_water"),
    ("base oil",    "base_oil"),
    ("fuel",        "fuel_oil"),     # "Fuel" (Charlie) and "Fuel oil" (Crest)
    ("water",       "fresh_water"),  # Charlie labels its fresh-water row just "Water"
]


def _table_consumables(tables: list) -> dict:
    """Read the 24-hour consumable summary from whichever template this is.

    The two templates order these columns differently — Charlie/Juno run
    Loaded-first, Crest runs Max. Cap.-first — but they use the same column
    *names*.  Because each figure is matched to the header it sits under, one
    reader handles both, and neither can silently mis-assign the other's values.
    """
    out: dict = {}
    for t in tables:
        hdr = _find_header(t, CONSUMABLE_LABELS, CONSUMABLE_OPTIONAL)
        if hdr is None:
            continue
        # Anything right of the last labelled column is a remarks column the
        # template forgot to label (CA5).  We only need it to exist so its dated
        # notes stop landing in "Loaded" — its text is split across sliver cells
        # and cannot be reassembled in reading order, so we drop it.  The
        # reports that *do* label Remarks are read from that column instead.
        hdr_i, bounds = hdr[0], _bounds(hdr[1], spill="_spill")

        cur_key: str | None = None
        for cells in t[hdr_i + 1:]:
            if not cells:
                continue
            if any("operational task codes" in c[2].lower() for c in cells):
                break
            col = _columnise(cells, bounds)
            product = col["product"].lower().strip()
            key = next((v for k, v in PRODUCT_KEYS if product.startswith(k)), None)
            if not key and product:
                # A row for a product we don't store (Baroid Tank 1, Cement Tank 2,
                # Mud Tk #3 …).  Close the previous product off here: without this,
                # that tank's own wrapped "(95%)" is read as a continuation of the
                # last product we DID store, and drill water ends up claiming a
                # capacity of "1180 M3 (80%) (95%) (95%)" — figures belonging to
                # two other tanks entirely.  Inventing a value is worse than
                # missing one.
                cur_key = None
                continue
            if key:
                cur_key = key
                out[key] = {f: col[f] for f in FIELD_ORDER}
                # The Remarks column holds a stack of dated bunkering notes, and
                # the templates split it across narrow sliver cells that cannot be
                # put back in reading order — the text comes out scrambled ("T 1 T
                # 1 R 1 R 1 T 2 R 2 X TO OPH 150 M3") or cut short ("Rx from
                # Halliburton", losing its quantity and date).  A truncated note
                # reads as fact, so store nothing rather than something wrong.
                # Nothing in the app displays this field.
                out[key]["remarks"] = ""
            elif cur_key and not product:
                # The only value these templates legitimately wrap onto a line of
                # its own is the safe-fill percentage ("(85%)" under "950 M3").
                # Other headerless rows are a second sub-row in the source (drill
                # water repeated in Bbls); appending those would fuse two separate
                # readings into one field — "Nil Nil", "1476 M3 (100%) 1094 Bbls".
                for f in FIELD_ORDER:
                    v = (col.get(f) or "").strip()
                    if v and _PCT_ONLY.match(v):
                        out[cur_key][f] = _clean(f"{out[cur_key].get(f) or ''} {v}")
        if out:
            break

    # Blank cells arrive as "" and unit-only leftovers as "m3"; neither is a value.
    for row in out.values():
        for f, v in list(row.items()):
            if f == "remarks":
                continue
            row[f] = None if (not v or re.fullmatch(r"(?i)m3|mt|m|-|_|nil|n/a", v.strip())) else _clean(v)
    return out


def parse_charlie_pdf(pdf_path: Path, vessel_id: str = "CH3") -> dict:
    pdfplumber = _require_pdfplumber()
    out: dict = {
        "consumables": {}, "task_log": [], "crew": [], "passengers": [],
        "safety": {}, "provisions": {}, "delays": {}, "lifts": {},
    }
    tables: list = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for pg in pdf.pages:
            tables.extend(_ruled_rows(pg))

    text = pdf_to_layout_text(pdf_path)

    # Header — "Period ending 24:00hrs | 01st JUNE 2026 | Voyage No: 0".
    # The ordinal suffix is a superscript, so it may or may not survive extraction.
    for t in tables:
        for cells in t:
            texts = [c[2] for c in cells]
            if not any("Period ending" in c for c in texts):
                continue
            for c in texts:
                m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(\d{4})\b", c)
                if m and not out.get("report_date"):
                    out["report_date"] = parse_date_dmy(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
                m = re.search(r"voyage\s*no[:\s.]*([\w/\-]+)", c, re.I)
                if m:
                    out["voyage_no"] = m.group(1)
    if not out.get("report_date"):
        m = re.search(r"Period ending[^\n]*?\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(\d{4})\b", text)
        if m:
            out["report_date"] = parse_date_dmy(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
    if not out.get("report_date"):
        # Last resort inside the document: the sign-off block on the final page.
        m = re.search(r"Report Compiled By.*?Date\s*[:\s]*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})", text, re.S | re.I)
        if m:
            out["report_date"] = parse_date_dmy(m.group(1))

    out["safety"] = _table_safety(tables)
    out.update(_table_scalars(tables))

    m = re.search(r"Report Compiled By[:\s]*([^\n|]*?)\s*(?:Date|\|)", text, re.I)
    if m and m.group(1).strip():
        out["compiled_by"] = {"name": _clean(m.group(1)), "role": "Master"}

    out["consumables"] = _table_consumables(tables)
    out["task_log"] = _ruled_task_log(tables, vessel_id, text)
    return out


# ---------------------------------------------------------------------------
# Which day is this report actually for?
# ---------------------------------------------------------------------------
#
# Three independent places name the date: the header ("Period ending … 16 JUNE
# 2026" / "Date: 01/07/2026"), the master's sign-off on the last page, and the
# filename the mail arrived under.  Usually all three agree.
#
# When they don't, taking the header on faith corrupts data silently: Charlie 3's
# 17 June report carries a header still reading "16 JUNE 2026" — the master built
# it from the previous day's file and missed that line — while its sign-off and
# filename both say the 17th.  Trusting the header there would file the 17th's
# log on top of the 16th's and lose both days' truth in one move.  So take the
# majority and record any disagreement for a human to look at.

def _signoff_date(text: str) -> str | None:
    m = re.search(r"Report Compiled By.*?Date\s*[:\s]*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})",
                  text, re.S | re.I)
    return parse_date_dmy(m.group(1)) if m else None


def _name_date(name: str | None) -> str | None:
    if not name:
        return None
    m = re.search(r"(\d{1,2})[._\-/](\d{1,2})[._\-/](\d{4})", name)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", name)
    if m:
        return parse_date_dmy(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
    return None


def _reconcile_date(header: str | None, signoff: str | None,
                    filename: str | None) -> tuple[str | None, dict | None]:
    """Return (chosen date, conflict) from the three sources."""
    from collections import Counter
    votes = [d for d in (header, signoff, filename) if d]
    if not votes:
        return None, None
    counts = Counter(votes)
    top, n = counts.most_common(1)[0]
    detail = {"chosen": top, "header": header, "signoff": signoff, "filename": filename}
    if len(counts) == 1:
        return top, None                      # all sources that spoke agree
    if n >= 2:
        return top, detail                    # outvoted the odd one out
    # Three different answers: the sign-off is the master's own dating of the
    # document, so prefer it, but this needs eyes on it.
    chosen = signoff or header or filename
    return chosen, {**detail, "chosen": chosen, "all_disagree": True}


def _slice_between(text: str, start_pat: str, end_pat: str) -> str | None:
    m = re.search(start_pat, text)
    if not m:
        return None
    rest = text[m.end():]
    e = re.search(end_pat, rest)
    return rest[: e.start() if e else None]


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _clean_block(s: str) -> str:
    return "\n".join(line.rstrip() for line in s.strip().splitlines() if line.strip())[:2000]


def _to_num(s: str) -> float | None:
    if not s:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

DAILY_SUBJECT_RE = re.compile(
    r"^(?P<vessel>ALLIANZ JUNO|CREST ARGUS [135])\s*-\s*(Daily Midnight Report|DAILY VESSEL REPORT(?:\s+OF)?)\s*[-of]*\s*(?P<rest>.+)$",
    re.I,
)


def classify(subject: str, filename: str) -> tuple[str | None, str | None]:
    """Return (vessel_id, kind) where kind is 'daily' | None."""
    s = subject or ""
    # Skip recalled / re-sent forwards (they re-attach the same report).
    if re.match(r"^\s*(Re-|RE-|Recall-)", s, re.I):
        return None, None
    # Skip forwards of someone else's mail (rare).
    if "fwd:" in s.lower():
        return None, None
    m = DAILY_SUBJECT_RE.match(s)
    if not m:
        return None, None
    vid = resolve_vessel(m.group("vessel"))
    return vid, "daily"


def main() -> int:
    if not INBOX_DIR.is_dir():
        print(f"Inbox not found: {INBOX_DIR}", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    tmp = Path(tempfile.mkdtemp(prefix="koc-parse-"))
    seen: dict[tuple[str, str], dict] = {}  # (vessel, date) -> record

    n_seen = 0
    n_kept = 0
    n_skipped = 0
    n_errors: list[tuple[str, str]] = []

    for eml in sorted(INBOX_DIR.glob("*.eml")):
        n_seen += 1
        try:
            msg = parse_eml(eml)
            vid, kind = classify(msg["Subject"] or "", eml.name)
            if kind != "daily" or vid is None:
                n_skipped += 1
                continue

            # Email date (used for dedup + audit trail)
            edate = msg.get("Date")
            edt = parsedate_to_datetime(edate).isoformat() if edate else None

            # Extract attachment to a temp dir
            sub = tmp / eml.stem
            sub.mkdir(parents=True, exist_ok=True)
            att = extract_attachment(msg, sub)
            if att is None:
                n_skipped += 1
                continue

            if att.suffix.lower() == ".docx":
                rec = parse_juno_docx(att)
            elif att.suffix.lower() == ".pdf":
                rec = parse_crest_pdf(att, vid)
            else:
                n_skipped += 1
                continue

            rec.setdefault("vessel_id", vid)
            rec.setdefault("period_end", "24:00")
            rec["vessel_id"] = vid

            # If parser didn't get a date from the body, fall back to filename / subject.
            if not rec.get("report_date"):
                fm = re.search(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})", eml.name)
                if fm:
                    rec["report_date"] = f"{fm.group(3)}-{int(fm.group(2)):02d}-{int(fm.group(1)):02d}"
                else:
                    fm = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", eml.name)
                    if fm:
                        rec["report_date"] = parse_date_dmy(f"{fm.group(1)}-{fm.group(2)}-{fm.group(3)}")
            if not rec.get("report_date"):
                n_errors.append((eml.name, "no report_date"))
                continue

            rec["source"] = {
                "type": "imported_email",
                "email_subject": msg["Subject"] or "",
                "email_from": (msg["From"] or "").strip(),
                "email_date": edt,
                "attachment_name": att.name,
                "submitted_via": "historical_import",
            }

            key = (vid, rec["report_date"])
            existing = seen.get(key)
            if existing is None:
                seen[key] = rec
                n_kept += 1
            else:
                # keep earliest email date
                old_d = existing["source"].get("email_date") or ""
                if edt and (not old_d or edt < old_d):
                    seen[key] = rec
        except Exception as ex:
            n_errors.append((eml.name, str(ex)))

    # Write outputs
    for (vid, date), rec in seen.items():
        out_path = OUT_DIR / f"{vid}-{date}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2, ensure_ascii=False)

    # Index file makes the simulator's job trivial (no directory scanning needed).
    index = sorted(
        [{"vessel_id": v, "report_date": d, "file": f"daily-reports/{v}-{d}.json",
          "task_log_rows": len(rec.get("task_log") or [])} for (v, d), rec in seen.items()],
        key=lambda x: (x["report_date"], x["vessel_id"]),
    )
    with open(OUT_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump({"reports": index}, f, indent=2, ensure_ascii=False)

    # Cleanup
    shutil.rmtree(tmp, ignore_errors=True)

    print(f"Scanned {n_seen} .eml files")
    print(f"  Kept   : {n_kept} unique daily reports")
    print(f"  Skipped: {n_skipped} (non-daily, RE-/Recall-, missing attachment)")
    if n_errors:
        print(f"  Errors : {len(n_errors)}")
        for nm, msg in n_errors[:10]:
            print(f"    - {nm}: {msg}")

    return 0


# ---------------------------------------------------------------------------
# Single-PDF mode (used by the admin dashboard "Import" screen via server.mjs)
# ---------------------------------------------------------------------------

def parse_single_pdf(pdf_path: Path, name_hint: str | None,
                     vessel_hint: str | None) -> dict:
    """Parse ONE loose DDR PDF and return a JSON-serialisable envelope:
        {ok: True,  vessel_id, report_date, task_log_rows, record}
        {ok: False, error}
    The vessel is taken from the PDF's own header text (or the filename),
    since a loose PDF has no email subject to classify it by.
    """
    try:
        text = pdf_to_layout_text(pdf_path)
    except FileNotFoundError:
        return {"ok": False, "error": "PDF reader (pdftotext) is not installed on this machine"}
    except Exception:  # corrupt / encrypted / not-a-PDF
        return {"ok": False, "error": "could not read the PDF — it may be corrupted or not a real PDF"}

    vid = vessel_hint or resolve_vessel(text[:3000]) or resolve_vessel(name_hint or "")
    if not vid:
        return {"ok": False,
                "error": "could not identify the vessel "
                         "(expected Crest Argus 1 / 3 / 5, Charlie 3 or Allianz Juno)"}

    try:
        # Charlie 3 kept Allianz Juno's template, which is a different table
        # layout from the Crest (Halliburton/OFCO) one — see parse_charlie_pdf.
        if vid in {"CH3", "JUNO"}:
            rec = parse_charlie_pdf(pdf_path, vid)
        else:
            rec = parse_crest_pdf(pdf_path, vid)
    except Exception as ex:
        return {"ok": False, "error": f"parse failed: {ex}"}

    rec["vessel_id"] = vid
    rec.setdefault("period_end", "24:00")

    # Settle the date across all three sources rather than trusting the header —
    # see _reconcile_date.  Filenames arrive as 08.05.2026, 08-05-2026, 01_07_2026
    # and "01 June 2026".
    header_date = rec.get("report_date")
    date, conflict = _reconcile_date(header_date, _signoff_date(text), _name_date(name_hint))
    if not date:
        return {"ok": False,
                "error": "could not determine the report date from the PDF or filename"}
    rec["report_date"] = date

    rec["source"] = {
        "type": "imported_pdf",
        "attachment_name": name_hint or pdf_path.name,
        "submitted_via": "admin_import",
    }
    if conflict:
        rec["source"]["date_conflict"] = conflict
    return {"ok": True, "vessel_id": vid, "report_date": rec["report_date"],
            "task_log_rows": len(rec.get("task_log") or []), "record": rec,
            "date_conflict": conflict}


def cli() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Import vessel daily reports.")
    ap.add_argument("--pdf", help="parse a single PDF and print a JSON envelope to stdout")
    ap.add_argument("--name", help="original filename (for date fallback + audit trail)")
    ap.add_argument("--vessel", help="force vessel id (JUNO/CA1/CA3/CA5)")
    args = ap.parse_args()
    if args.pdf:
        res = parse_single_pdf(Path(args.pdf), args.name, args.vessel)
        print(json.dumps(res, ensure_ascii=False))
        return 0  # caller reads the envelope's "ok" flag, not the exit code
    return main()


if __name__ == "__main__":
    raise SystemExit(cli())
