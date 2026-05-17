#!/usr/bin/env python3
"""Import Vessel Movement Plan emails / PDFs into structured JSON.

Sources scanned:
  1. ``Vessels daily report/*.eml`` — emails whose subject begins
     "Vessel Movement Plan for the next 48 Hrs.".  Body is plain text
     with the supervisor's narrative.
  2. ``data/vessels-movement-plans/*.pdf`` — PDFs the user dropped into
     the project folder directly.

Output: ``data/movement-plans/{YYYY-MM-DD}.json`` keyed by ``plan_date``
(the date in the subject = the "today" of the 48-hour plan).

Dedup rule: same ``plan_date`` keeps the earliest non-Re-/Recall- email;
PDFs in the folder win over emails (the user is treating that folder as
their canonical input).

Run from project root:

    python3 tools/parse_movement_plans.py
"""

from __future__ import annotations

import email
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from email import policy
from email.utils import parsedate_to_datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INBOX_DIR    = PROJECT_ROOT / "Vessels daily report"
PDF_DIR      = PROJECT_ROOT / "data" / "vessels-movement-plans"
OUT_DIR      = PROJECT_ROOT / "data" / "movement-plans"

# ---------------------------------------------------------------------------
# Vessel name mapping
# ---------------------------------------------------------------------------

VESSEL_HEADERS = [
    # (regex matched against a header line, vessel_id)
    (re.compile(r"^\s*allianz\s*juno\b", re.I),     "JUNO"),
    (re.compile(r"^\s*crest\s*argus\s*-?\s*1\b", re.I), "CA1"),
    (re.compile(r"^\s*crest\s*argus\s*-?\s*3\b", re.I), "CA3"),
    (re.compile(r"^\s*crest\s*argus\s*-?\s*5\b", re.I), "CA5"),
]

SUBJECT_DATE_RE = re.compile(
    r"Vessel\s+Movement\s+Plan\s+for\s+the\s+next\s+48\s*Hrs?\.\s*(\d{1,2})[\-\s]([A-Za-z]+)[\-\s](\d{4})",
    re.I,
)

# Match the typical bullet markers used in the plain-text body (Outlook list).
BULLET_RE = re.compile(r"^\s*(?:[\*•\-]|\d+\.)\s+(.+?)\s*$")

# Anything after one of these markers belongs to the signature / closing
# block, not a vessel section.  Used to stop collecting bullets for the
# current vessel without depending on the bullet marker style.
STOP_RE = re.compile(
    r"^\s*("
    r"crew\s+change\s+details\b"
    r"|gary\b"
    r"|kindly\s+approve\b"
    r"|regards\b"
    r"|thanks\s*(?:&|and)?\s*regards\b"
    r"|best\s+regards\b"
    r"|sincerely\b"
    r"|nirmal\s+mishra\b"
    r"|iods\s+operations\b"
    r"|kgl\s+logistics\b"
    r"|page\s+\d+\s+of\s+\d+\b"
    r"|this\s+e-?mail\b"
    r"|caution:\b"
    r"|attachments?:\b"
    r")",
    re.I,
)

# A line is "indented body text" (used to attach to a paragraph-style bullet
# in the PDF layout) when it starts with whitespace and isn't blank.  An
# unindented line in a PDF is typically a header/footer ("1 of 2") or a
# stop marker.
INDENT_RE = re.compile(r"^\s{2,}\S")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June",
     "July", "August", "September", "October", "November", "December"], start=1)}
# Short forms
_MONTHS.update({m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)})


def parse_subject_date(subject: str) -> str | None:
    """Return YYYY-MM-DD for the date in a movement-plan subject, or None."""
    if not subject:
        return None
    m = SUBJECT_DATE_RE.search(subject)
    if not m:
        return None
    day = int(m.group(1))
    mon = _MONTHS.get(m.group(2).lower())
    yr  = int(m.group(3))
    if not mon:
        return None
    try:
        return datetime(yr, mon, day).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _strip_url_decorations(line: str) -> str:
    """Drop trailing tracking URLs in angle-brackets that Halliburton appends.
    e.g. 'Halliburton<https://...>' -> 'Halliburton'."""
    return re.sub(r"<https?://[^>]*>", "", line)


def _normalise_body(text: str) -> list[str]:
    """Return body broken into clean lines: URL-stripped, NBSP→space, rstripped."""
    out: list[str] = []
    for ln in text.splitlines():
        ln = ln.replace(" ", " ")
        ln = _strip_url_decorations(ln)
        out.append(ln.rstrip())
    return out


def _match_vessel_header(line: str) -> str | None:
    """Detect a vessel-section header line.  Tolerant of the ellipsis variants
    ('Allianz Juno…', 'Crest Argus 1...', 'Crest Argus 5….') and case."""
    # Headers are typically short — bail out on long bullet-like lines.
    if len(line.strip()) > 60:
        return None
    for rx, vid in VESSEL_HEADERS:
        if rx.match(line):
            # Ensure the rest of the line is just punctuation / dots / spaces —
            # not the start of a long bullet about another topic.
            tail = rx.sub("", line, count=1).strip()
            tail = tail.strip(" .…")
            if tail == "":
                return vid
    return None


def parse_plan_body(text: str) -> list[dict]:
    """Walk the email/PDF body once, returning a list of per-vessel records.

    Each record: {vessel_id, current_status, tomorrow_plan, additional}.
    Bullets are collected in order; bullet #1 → current_status, bullet #2 →
    tomorrow_plan, any remaining bullets → additional (joined with " | ").

    The function handles two layouts:

    * Plain-text email body (Outlook): bullets begin with ``*``/``•``/``-``.
      A line of body without a marker is treated as a continuation of the
      previous bullet.
    * Rendered PDF: no bullet markers — bullets are sentences within an
      indented paragraph block.  Sentence boundary = previous line ended
      with ``.``/``!``/``?``.
    """
    lines = _normalise_body(text)

    # Pre-scan: do we see actual bullet markers in this body?
    has_markers = sum(1 for ln in lines if BULLET_RE.match(ln)) >= 2

    sections: dict[str, list[str]] = {}
    current_vid: str | None = None
    current_buf: list[str] = []

    def flush() -> None:
        nonlocal current_buf
        if current_vid is not None and current_buf:
            txt = " ".join(s.strip() for s in current_buf).strip()
            if txt:
                sections.setdefault(current_vid, []).append(txt)
        current_buf = []

    def stop_section() -> None:
        nonlocal current_vid
        flush()
        current_vid = None

    for ln in lines:
        stripped = ln.strip()

        if not stripped:
            flush()
            continue

        if STOP_RE.match(ln):
            stop_section()
            continue

        vid = _match_vessel_header(ln)
        if vid:
            stop_section()
            current_vid = vid
            sections.setdefault(vid, [])
            continue

        if current_vid is None:
            continue

        # Skip PDF page-number footers ("1 of 2").
        if re.match(r"^\s*\d+\s+of\s+\d+\s*$", ln):
            continue

        if has_markers:
            m = BULLET_RE.match(ln)
            if m:
                flush()
                current_buf.append(m.group(1).strip())
                continue
            # Continuation line of the previous bullet (Outlook soft-wrap).
            if current_buf:
                current_buf.append(stripped)
            continue

        # PDF mode: split bullets at sentence boundaries.
        # If the current buffer ends a sentence, start a new bullet for this line.
        if current_buf:
            last_char = current_buf[-1][-1:] if current_buf[-1] else ""
            if last_char in ".!?":
                flush()
        current_buf.append(stripped)

    # End-of-document flush
    flush()

    out: list[dict] = []
    for vid, bullets in sections.items():
        rec = {"vessel_id": vid, "current_status": "", "tomorrow_plan": "", "additional": ""}
        if len(bullets) >= 1:
            rec["current_status"] = bullets[0]
        if len(bullets) >= 2:
            rec["tomorrow_plan"]  = bullets[1]
        if len(bullets) >= 3:
            rec["additional"]     = " | ".join(bullets[2:])
        out.append(rec)
    # Preserve canonical vessel order in the file.
    order = {"JUNO": 0, "CA1": 1, "CA3": 2, "CA5": 3}
    out.sort(key=lambda r: order.get(r["vessel_id"], 99))
    return out


def parse_signature(text: str) -> tuple[str | None, str | None]:
    """Return (issued_by, issued_role) by looking at the Regards/sign-off block."""
    lines = _normalise_body(text)
    # Find 'Regards' anchor; the next 1–3 non-empty lines give the name + role.
    name = None
    role = None
    for i, ln in enumerate(lines):
        if re.search(r"\bRegards\b", ln, re.I) or re.search(r"\bThanks\s*(?:&|and)?\s*Regards\b", ln, re.I):
            tail = [t.strip() for t in lines[i + 1: i + 6] if t.strip()]
            tail = [t for t in tail if not re.match(r"^[\[\<]", t)]
            if tail:
                name = tail[0]
            if len(tail) > 1:
                role = tail[1]
            break
    return name, role


# ---------------------------------------------------------------------------
# .eml ingestion
# ---------------------------------------------------------------------------

def is_plan_email(msg: email.message.EmailMessage) -> bool:
    subject = msg.get("Subject") or ""
    return SUBJECT_DATE_RE.search(subject) is not None


def is_dedup_skip(subject: str) -> bool:
    """Skip re-sends, recalls, and [1]/[2]/... numbered duplicates."""
    s = (subject or "").strip()
    if re.match(r"^\s*(re|recall|fw|fwd)[\-:]?\s+", s, re.I):
        return True
    if re.search(r"\[\d+\]\s*$", s):
        return True
    return False


def extract_plain_body(msg: email.message.EmailMessage) -> str:
    body = msg.get_body(preferencelist=("plain", "html"))
    if body is None:
        return ""
    content = body.get_content()
    if body.get_content_type() == "text/html":
        # Strip tags very crudely — good enough for the supervisor's
        # plain-bullets template.
        content = re.sub(r"<br\s*/?>", "\n", content, flags=re.I)
        content = re.sub(r"<li[^>]*>", "* ", content, flags=re.I)
        content = re.sub(r"</li>", "\n", content, flags=re.I)
        content = re.sub(r"<[^>]+>", "", content)
    return content


def parse_eml(path: Path) -> dict | None:
    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=policy.default)
    if not is_plan_email(msg):
        return None
    subject  = msg.get("Subject") or ""
    plan_dt  = parse_subject_date(subject)
    if not plan_dt:
        return None
    body     = extract_plain_body(msg)
    vessels  = parse_plan_body(body)
    if not vessels:
        return None
    name, role = parse_signature(body)
    try:
        sent_at = parsedate_to_datetime(msg.get("Date") or "").isoformat()
    except Exception:
        sent_at = None
    issued_date = sent_at[:10] if sent_at else plan_dt
    out = {
        "plan_date":    plan_dt,
        "issued_date":  issued_date,
        "issued_by":    name or "",
        "issued_role":  role or "",
        "subject":      subject,
        "narrative":    body.strip(),
        "vessels":      vessels,
        "source": {
            "type":          "imported_email",
            "email_subject": subject,
            "email_from":    msg.get("From") or "",
            "email_date":    sent_at,
            "submitted_via": "historical_import",
        },
    }
    return out


# ---------------------------------------------------------------------------
# PDF ingestion (folder data/vessels-movement-plans/)
# ---------------------------------------------------------------------------

def pdf_to_text(pdf_path: Path) -> str:
    """Render a PDF as text via pdftotext (layout mode preserves bullets)."""
    res = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        check=True, capture_output=True, text=True,
    )
    return res.stdout


def parse_pdf(pdf_path: Path) -> dict | None:
    text = pdf_to_text(pdf_path)
    # Some PDFs come with the email header at the top; pull subject from
    # 'Subject:' or fall back to the filename.
    subject = ""
    m = re.search(r"Subject:\s*(.+)$", text, re.M)
    if m:
        subject = m.group(1).strip()
    if not subject:
        subject = pdf_path.stem
    plan_dt = parse_subject_date(subject) or parse_subject_date(pdf_path.stem)
    if not plan_dt:
        return None
    # If 'From:' header survived, capture it.
    m = re.search(r"^From:\s*(.+)$", text, re.M)
    from_field = m.group(1).strip() if m else ""
    m = re.search(r"^Date:\s*(.+)$", text, re.M)
    date_field = m.group(1).strip() if m else ""
    issued_date = plan_dt
    if date_field:
        try:
            dt = datetime.strptime(date_field.split(",", 1)[-1].strip().split(" at ")[0],
                                   "%B %d, %Y")
            issued_date = dt.strftime("%Y-%m-%d")
        except Exception:
            pass
    vessels = parse_plan_body(text)
    if not vessels:
        return None
    name, role = parse_signature(text)
    return {
        "plan_date":    plan_dt,
        "issued_date":  issued_date,
        "issued_by":    name or "",
        "issued_role":  role or "",
        "subject":      subject,
        "narrative":    text.strip(),
        "vessels":      vessels,
        "source": {
            "type":            "imported_pdf",
            "email_subject":   subject,
            "email_from":      from_field,
            "email_date":      date_field,
            "attachment_name": pdf_path.name,
            "submitted_via":   "historical_import",
        },
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def collect_plan_emails() -> list[Path]:
    """Return .eml paths in INBOX_DIR with subjects matching the plan pattern,
    excluding obvious Re-/Recall-/[N] duplicates."""
    out: list[Path] = []
    if not INBOX_DIR.exists():
        return out
    for p in sorted(INBOX_DIR.iterdir()):
        if p.suffix.lower() != ".eml":
            continue
        # Cheap pre-filter on filename (avoid loading thousands of unrelated mails).
        if "Vessel Movement Plan" not in p.name and "vessel movement plan" not in p.name.lower():
            continue
        if is_dedup_skip(p.name):
            continue
        out.append(p)
    return out


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plans_by_date: dict[str, tuple[int, dict]] = {}  # date -> (priority, record)

    # Priority: PDF in data/vessels-movement-plans wins over imported eml.
    # Within same source-type, keep earliest received.
    def add(rec: dict, prio: int) -> None:
        d = rec["plan_date"]
        keep = plans_by_date.get(d)
        if keep is None:
            plans_by_date[d] = (prio, rec)
            return
        if prio > keep[0]:
            plans_by_date[d] = (prio, rec)
            return
        if prio == keep[0]:
            # Prefer earliest email date
            old = (keep[1].get("source") or {}).get("email_date") or ""
            new = (rec.get("source") or {}).get("email_date") or ""
            if new and (not old or new < old):
                plans_by_date[d] = (prio, rec)

    # 1) .eml sources (priority 1)
    eml_count = 0
    for path in collect_plan_emails():
        try:
            rec = parse_eml(path)
        except Exception as e:
            print(f"  ! {path.name}: {e}", file=sys.stderr)
            continue
        if rec:
            add(rec, prio=1)
            eml_count += 1

    # 2) PDF sources (priority 2)
    pdf_count = 0
    if PDF_DIR.exists():
        for path in sorted(PDF_DIR.glob("*.pdf")):
            try:
                rec = parse_pdf(path)
            except Exception as e:
                print(f"  ! {path.name}: {e}", file=sys.stderr)
                continue
            if rec:
                add(rec, prio=2)
                pdf_count += 1

    # Write out
    written = 0
    for d, (_, rec) in sorted(plans_by_date.items()):
        out = OUT_DIR / f"{d}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2, ensure_ascii=False)
        written += 1

    # Build an index
    idx_rows = []
    for d, (_, rec) in sorted(plans_by_date.items()):
        idx_rows.append({
            "plan_date":   d,
            "issued_date": rec.get("issued_date"),
            "issued_by":   rec.get("issued_by"),
            "subject":     rec.get("subject"),
            "vessels":     [v["vessel_id"] for v in rec.get("vessels", [])],
            "source_type": (rec.get("source") or {}).get("type"),
            "file":        f"movement-plans/{d}.json",
        })
    with open(OUT_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump({"plans": idx_rows}, f, indent=2, ensure_ascii=False)

    print(f"Scanned {eml_count} .eml + {pdf_count} pdf source(s)")
    print(f"  Kept   : {written} unique movement plans")
    return 0


if __name__ == "__main__":
    sys.exit(main())
