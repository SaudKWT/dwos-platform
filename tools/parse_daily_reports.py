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
_ROW_FULL_RE = re.compile(
    r"^\s*(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+"
    r"([A-Z]\w{0,3}(?:/[A-Z]\w{0,3})?)\s+(.+?)\s*$"
)
# CA5's two-line layout:
#   Line A (hrs + code, optionally followed by description text):
#     "<spaces> H:MM  <spaces> CODE [<spaces> <desc>]"
_ROW_PARTIAL_HRS_CODE_RE = re.compile(
    r"^\s*(\d{1,2}:\d{2})\s+([A-Z]\w{0,3}(?:/[A-Z]\w{0,3})?)(?:\s+(\S.*?))?\s*$"
)
#   Line B (from + to, optionally followed by description text):
#     "<spaces> H:MM <spaces> H:MM [<spaces> <desc>]"
# (Some CA5 reports drop the colon: "0712"; treat as typo, accept it.)
_ROW_PARTIAL_FROM_TO_DESC_RE = re.compile(
    r"^\s*(\d{1,2}:?\d{2})\s+(\d{1,2}:?\d{2})(?:\s+(\S.*?))?\s*$"
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
    for raw_line in block.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            pending = (None, None, None)
            continue
        # 1) Full single-line row (CA1/CA3)
        m = _ROW_FULL_RE.match(line)
        if m:
            from_t, to_t, hrs, code, desc = m.groups()
            _append_row(rows, vessel_id, from_t, to_t, hrs, code, desc)
            pending = (None, None, None)
            continue
        # 2) CA5 partial: hrs + code (optionally with description on the same line)
        m = _ROW_PARTIAL_HRS_CODE_RE.match(line)
        if m:
            pending = (m.group(1), m.group(2), m.group(3))
            continue
        # 3) CA5 partial: from + to (optionally with description); pair with pending hrs+code
        m = _ROW_PARTIAL_FROM_TO_DESC_RE.match(line)
        if m and pending[0] is not None:
            from_t_raw, to_t_raw, desc_b = m.groups()
            from_t = _fix_time(from_t_raw)
            to_t = _fix_time(to_t_raw)
            if from_t and to_t:
                # Prefer line-B description; fall back to whatever was on line A.
                # If both are present, concatenate (line B usually has the
                # detail; line A may carry the first part of a wrapped desc).
                desc_a = pending[2]
                if desc_a and desc_b:
                    desc = f"{desc_a} {desc_b}".strip()
                else:
                    desc = desc_b or desc_a or ""
                _append_row(rows, vessel_id, from_t, to_t, pending[0], pending[1], desc)
                pending = (None, None, None)
                continue
        # otherwise ignore (header continuation, footers, etc.)
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

    # Safety
    sm = re.search(r"Accidents:\s*([A-Za-z0-9]+).*?Incidents\s*[:]\s*([A-Za-z0-9]+).*?Near Miss:\s*([A-Za-z0-9]+)",
                   text, re.S)
    if sm:
        out["safety"] = {"accidents": sm.group(1), "incidents": sm.group(2), "near_miss": sm.group(3)}

    # 24-hr consumables — single-row scalars.
    # Fuel oil row. The PDF table has 7 columns: Product | Max Cap | Consumed |
    # Discharged | ROB | Rem. To Load | Loaded. Each value cell is either
    # "<num> M3" / "<num> MT", a bare number, or a "-" / "Nil" placeholder.
    # Max Cap has a parenthesised safe-fill percentage ("950 M3 (80%)").
    # Some PDFs render M3 as M + superscript 3, which pdftotext -layout drops
    # the 3 from this line — we accept "M" as a unit and re-normalise below.
    cell = r"(?:[\d,.]+\s*(?:M3|MT|m3|M)|[\d,.]+|-|Nil|nil|N/A)"
    m = re.search(
        rf"Fuel oil\s+([\d,.]+\s*(?:M3|M)\s*\(\s*\d+\s*%\s*\))\s+"
        rf"({cell})\s+({cell})\s+({cell})\s+({cell})(?:\s+({cell}))?",
        text,
    )
    if m:
        def _norm_unit(v: str | None) -> str | None:
            if not v:
                return v
            v = re.sub(r"\s+", " ", v).strip()
            # Re-attach the dropped superscript "3": "950 M (80%)" -> "950 M3 (80%)",
            # "564.646 M" -> "564.646 M3". Skip if already "M3"/"MT"/no unit.
            return re.sub(r"(?<=\d)\s*M(?!3|T|t)\b", " M3", v)
        out["consumables"]["fuel_oil"] = {
            "max_capacity": _norm_unit(m.group(1)),
            "consumed": _norm_unit(m.group(2)),
            "discharged": _norm_unit(m.group(3)),
            "rob": _norm_unit(m.group(4)),
            "remaining_to_load": _norm_unit(m.group(5)),
            "loaded": _norm_unit(m.group(6)) if m.group(6) else None,
            "remarks": "",
        }
    # Fresh water (label varies: "Fresh Water" / "Fresh water")
    m = re.search(r"Fresh [Ww]ater[^\n]*\n.*?([0-9.,]+\s*M3[^ ]*)\s+([0-9.,]+\s*M3?|Nil|-|\S+)", text, re.S)
    # (Best-effort; will improve below using line-by-line column split.)

    # Task log (handles both Crest layouts).
    out["task_log"] = extract_task_log_block(text, vessel_id)

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
                "error": "could not identify the vessel (expected Crest Argus 1 / 3 / 5)"}

    try:
        rec = parse_crest_pdf(pdf_path, vid)
    except Exception as ex:
        return {"ok": False, "error": f"parse failed: {ex}"}

    rec["vessel_id"] = vid
    rec.setdefault("period_end", "24:00")

    # Date fallback from the filename if the PDF body didn't yield one.
    if not rec.get("report_date") and name_hint:
        fm = re.search(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})", name_hint)
        if fm:
            rec["report_date"] = f"{fm.group(3)}-{int(fm.group(2)):02d}-{int(fm.group(1)):02d}"
        else:
            fm = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", name_hint)
            if fm:
                rec["report_date"] = parse_date_dmy(f"{fm.group(1)}-{fm.group(2)}-{fm.group(3)}")
    if not rec.get("report_date"):
        return {"ok": False,
                "error": "could not determine the report date from the PDF or filename"}

    rec["source"] = {
        "type": "imported_pdf",
        "attachment_name": name_hint or pdf_path.name,
        "submitted_via": "admin_import",
    }
    return {"ok": True, "vessel_id": vid, "report_date": rec["report_date"],
            "task_log_rows": len(rec.get("task_log") or []), "record": rec}


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
