#!/usr/bin/env python3
"""Independently re-count what the importer claims, straight from the PDFs.

This deliberately does NOT reuse the importer's readers.  It looks at the plain
text layout and counts the things a human would count when checking by eye:

  * how many task codes appear in the log block  — one per row, so this is the
    row count the report should have;
  * whether every from/to time in the stored JSON appears in the source text;
  * whether the stored fuel/water figures appear in the source text;
  * whether ROB + Rem-to-load == Max. Cap. (arithmetic the master's own numbers
    must satisfy, and which only holds if the columns were mapped correctly).

A disagreement here is a lead to investigate, not proof of a bug — the source
itself contains typos.  Run it after any import:

    .venv/bin/python tools/crosscheck_reports.py --pdfs <dir> --out report.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPORTS_DIR = PROJECT_ROOT / "data" / "daily-reports"

# Every task code the two templates use.  One appears per log row.
# The trailing guard rejects a following lower-case letter or digit but allows a
# capital, because the layout often runs the code straight into its description
# with no space: "O1SBE", "O1Ancho heaved up".  The leading guard keeps "D1" out
# of "OD1" and "O1" out of a longer token.
CODE = r"(?:S0[1-8]|DP1|L1F|L2E|B1|O1|I0[12]|D1|WOW|A01)"
CODE_RE = re.compile(rf"(?<![A-Za-z0-9/#])(?:{CODE})(?:/{CODE})?(?![a-z0-9])")


def layout_text(pdf: Path) -> str:
    return subprocess.run(["pdftotext", "-layout", "-nopgbrk", str(pdf), "-"],
                          check=True, capture_output=True, text=True).stdout


def log_block(text: str) -> str:
    """The text between the log's column header and whatever section follows."""
    m = re.search(r"Description\s+Log", text)
    if not m:
        return ""
    rest = text[m.end():]
    e = re.search(r"(?:Crew List|Lifts On Deck|Report Compiled By)", rest)
    return rest[: e.start() if e else None]


def num(s: str | None) -> float | None:
    """First number in a cell.  These masters use both 506.554 and 506,554."""
    if not s:
        return None
    m = re.search(r"\d+(?:[.,]\d+)?", s)
    return float(m.group(0).replace(",", ".")) if m else None


def check(pdf: Path, rec: dict) -> list[str]:
    issues: list[str] = []
    text = layout_text(pdf)
    block = log_block(text)

    codes = CODE_RE.findall(block)
    rows = rec.get("task_log") or []
    if len(codes) != len(rows):
        issues.append(f"row count: source shows {len(codes)} task codes, stored has {len(rows)}")

    # Every stored time must be somewhere in the source.  Times are printed
    # unpadded ("7:25") as often as not, so accept either spelling.
    flat = re.sub(r"\s+", " ", block)
    for i, r in enumerate(rows):
        for field in ("from_time", "to_time"):
            v = r.get(field)
            if not v:
                continue
            unpadded = v.lstrip("0") if v[0] == "0" else v
            if v not in flat and unpadded not in flat:
                issues.append(f"task_log[{i}].{field}={v} not found in the source text")

    for key, row in (rec.get("consumables") or {}).items():
        for field in ("rob", "consumed", "max_capacity", "remaining_to_load"):
            v = row.get(field)
            if not v:
                continue
            head = re.match(r"[\d.,]+", str(v).strip())
            if head and head.group(0) not in re.sub(r"\s+", " ", text):
                issues.append(f"consumables.{key}.{field}={v!r} not found in the source text")
        rob, rem, mx = num(row.get("rob")), num(row.get("remaining_to_load")), num(row.get("max_capacity"))
        if None not in (rob, rem, mx) and mx > 0 and abs(rob + rem - mx) > 0.05 * mx:
            issues.append(f"consumables.{key}: ROB {rob} + Rem {rem} != Max {mx}")
    return issues


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="folder of .msg emails the reports came from")
    ap.add_argument("--report", required=True, help="the importer's --report JSON (maps report -> message)")
    ap.add_argument("--out", help="write findings here")
    args = ap.parse_args()

    import extract_msg
    import tempfile

    run = json.loads(Path(args.report).read_text(encoding="utf-8"))
    src_root = Path(args.src)
    tmp = Path(tempfile.mkdtemp(prefix="koc-xcheck-"))
    findings: dict[str, list[str]] = {}
    checked = 0

    for row in run["reports"]:
        key = f"{row['vessel_id']}-{row['report_date']}"
        f = REPORTS_DIR / f"{key}.json"
        if not f.exists():
            findings[key] = ["report is in the import log but not on disk"]
            continue
        rec = json.loads(f.read_text(encoding="utf-8"))
        msg_path = src_root / row["file"]
        if not msg_path.exists():
            findings[key] = [f"source message missing: {row['file']}"]
            continue
        m = extract_msg.Message(str(msg_path))
        pdf = None
        for a in m.attachments:
            fn = a.longFilename or a.shortFilename or ""
            if fn.lower().endswith(".pdf"):
                pdf = tmp / f"{key}.pdf"
                pdf.write_bytes(a.data)
                break
        m.close()
        if pdf is None:
            findings[key] = ["no PDF in the source message"]
            continue
        checked += 1
        got = check(pdf, rec)
        if got:
            findings[key] = got

    print(f"cross-checked {checked} reports against their PDFs")
    print(f"reports with something to look at: {len(findings)}")
    for k in sorted(findings)[:40]:
        print(f"\n  {k}")
        for i in findings[k][:6]:
            print(f"      - {i}")
    if args.out:
        Path(args.out).write_text(json.dumps(findings, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
