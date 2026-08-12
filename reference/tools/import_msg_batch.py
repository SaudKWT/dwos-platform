#!/usr/bin/env python3
"""Import daily reports from a folder of Outlook ``.msg`` emails.

The captains' mailbox exports as ``.msg`` (Outlook) rather than the ``.eml``
that tools/parse_daily_reports.py reads, and each message carries exactly one
report PDF plus signature images.  This walks a folder tree of ``.msg`` files,
pulls out the PDF, parses it with the shared reader, and writes
``data/daily-reports/{VESSEL}-{YYYY-MM-DD}.json``.

Why not the admin drag-and-drop screen: a loose PDF has no email date, so the
duplicate rule below cannot be applied, and the report loses its provenance
(who sent it, when).  Importing from the messages keeps both.

Duplicate rule — a captain who re-sends a day's report is correcting it, so the
LATEST message for a (vessel, date) wins.  The opposite rule (keep the earliest,
as the .eml importer does) would, on this batch, keep Crest Argus 3's 1 June
report that parses to zero task rows and throw away the revision sent 27 minutes
later carrying all 15.  Where two messages tie, the one with more task rows wins.

Nothing here overwrites a report that a *different* source already wrote unless
--overwrite is passed; the run prints what it would replace and stops.

Run:
    .venv/bin/python tools/import_msg_batch.py --src "/path/to/mail folder"
    .venv/bin/python tools/import_msg_batch.py --src ... --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.parse_daily_reports import parse_single_pdf  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "data" / "daily-reports"

# A re-send: "RE_ CHARLIE 3 - ...", "REV_ CREST ARGUS 3 - ...", "... Revised",
# "... Revise", "... (1)".  Note we do NOT skip these — for Charlie 3's 2 July
# report the "RE_" message is the only copy in the mailbox, so dropping re-sends
# (as the .eml importer does) would silently lose that day entirely.
REVISION_RE = re.compile(r"^\s*(?:re|rev)[\s_\-:]|revis(?:ed|e|ion)|\(\d+\)", re.I)


def read_msg(path: Path):
    import extract_msg
    return extract_msg.Message(str(path))


def pdf_of(msg) -> tuple[bytes, str] | None:
    for a in msg.attachments:
        fn = a.longFilename or a.shortFilename or ""
        if fn.lower().endswith(".pdf"):
            return a.data, fn
    return None


def collect(src: Path, tmp: Path) -> list[dict]:
    """Parse every .msg under *src* into candidate records."""
    out: list[dict] = []
    for msg_path in sorted(src.rglob("*.msg")):
        rel = msg_path.relative_to(src)
        try:
            msg = read_msg(msg_path)
        except Exception as ex:
            out.append({"ok": False, "file": str(rel), "error": f"unreadable message: {ex}"})
            continue
        try:
            got = pdf_of(msg)
            if got is None:
                out.append({"ok": False, "file": str(rel), "error": "no PDF attached"})
                continue
            data, att_name = got
            dest = tmp / f"{abs(hash(str(rel)))}.pdf"
            dest.write_bytes(data)

            # Name the PDF after its message, not its attachment: the message
            # filename carries a date on every one of these, the attachment's
            # does not — and that name is one of the three votes on which day
            # the report is for.
            env = parse_single_pdf(dest, msg_path.stem, None)
            if not env.get("ok"):
                out.append({"ok": False, "file": str(rel), "subject": msg.subject or "",
                            "error": env.get("error")})
                continue

            rec = env["record"]
            rec["source"] = {
                "type": "imported_email",
                "email_subject": msg.subject or "",
                "email_from": str(msg.sender or "").strip(),
                "email_date": str(msg.date) if msg.date else None,
                "attachment_name": att_name,
                "submitted_via": "msg_batch_import",
            }
            if env.get("date_conflict"):
                rec["source"]["date_conflict"] = env["date_conflict"]
            out.append({
                "ok": True, "file": str(rel), "subject": msg.subject or "",
                "vessel_id": env["vessel_id"], "report_date": env["report_date"],
                "rows": env["task_log_rows"], "record": rec,
                "date_conflict": env.get("date_conflict"),
                "email_date": str(msg.date) if msg.date else "",
                "is_revision": bool(REVISION_RE.search(msg_path.stem)),
            })
        finally:
            try:
                msg.close()
            except Exception:
                pass
    return out


def pick_winners(cands: list[dict]) -> tuple[dict, list[dict]]:
    """One record per (vessel, date): latest message wins, then most rows."""
    best: dict[tuple[str, str], dict] = {}
    dropped: list[dict] = []
    for c in sorted(cands, key=lambda c: (c["email_date"], c["rows"])):
        key = (c["vessel_id"], c["report_date"])
        if key in best:
            dropped.append({**best[key], "superseded_by": c["file"]})
        best[key] = c
    return best, dropped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder of .msg emails (searched recursively)")
    ap.add_argument("--dry-run", action="store_true", help="report what would be written, write nothing")
    ap.add_argument("--overwrite", action="store_true", help="replace reports that already exist on disk")
    ap.add_argument("--report", help="write a JSON summary of the run here")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    if not src.is_dir():
        print(f"not a folder: {src}", file=sys.stderr)
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="koc-msg-import-"))
    cands = collect(src, tmp)
    good = [c for c in cands if c.get("ok")]
    bad = [c for c in cands if not c.get("ok")]
    best, dropped = pick_winners(good)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    existing = {p.stem for p in OUT_DIR.glob("*.json") if p.stem != "index"}
    clashes = [k for k in best if f"{k[0]}-{k[1]}" in existing]

    print(f"messages scanned : {len(cands)}")
    print(f"  parsed         : {len(good)}")
    print(f"  unreadable     : {len(bad)}")
    for b in bad[:12]:
        print(f"      - {b['file']}: {b['error']}")
    print(f"  unique reports : {len(best)}")
    print(f"  superseded     : {len(dropped)}")
    for d in dropped:
        print(f"      - {d['file']} ({d['rows']} rows) <- superseded by {d['superseded_by']}")

    conflicts = [c for c in best.values() if c.get("date_conflict")]
    if conflicts:
        print(f"  date disagreements (header vs sign-off vs filename): {len(conflicts)}")
        for c in conflicts:
            d = c["date_conflict"]
            print(f"      - {c['vessel_id']} filed as {d['chosen']}: header={d['header']} "
                  f"sign-off={d['signoff']} filename={d['filename']}  [{c['file']}]")
    if clashes:
        print(f"  already on disk: {len(clashes)}")
        for k in sorted(clashes)[:12]:
            print(f"      - {k[0]}-{k[1]}.json")
        if not args.overwrite:
            print("\nRefusing to replace reports that already exist. Re-run with --overwrite "
                  "if that is what you want.")
            if not args.dry_run:
                return 2

    written = 0
    if not args.dry_run:
        for (vid, date), c in sorted(best.items()):
            path = OUT_DIR / f"{vid}-{date}.json"
            if path.exists() and not args.overwrite:
                continue
            path.write_text(json.dumps(c["record"], indent=2, ensure_ascii=False), encoding="utf-8")
            written += 1
        rebuild_index()
        print(f"\nwrote {written} report(s) and rebuilt the index")
    else:
        print("\n(dry run — nothing written)")

    if args.report:
        Path(args.report).write_text(json.dumps({
            "scanned": len(cands), "parsed": len(good), "failed": bad,
            "written": written,
            "reports": [{"vessel_id": k[0], "report_date": k[1], "rows": c["rows"],
                         "file": c["file"], "subject": c["subject"],
                         "email_date": c["email_date"], "is_revision": c["is_revision"]}
                        for k, c in sorted(best.items())],
            "superseded": [{"file": d["file"], "rows": d["rows"],
                            "vessel_id": d["vessel_id"], "report_date": d["report_date"],
                            "superseded_by": d["superseded_by"]} for d in dropped],
        }, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


def rebuild_index() -> None:
    rows = []
    for f in sorted(OUT_DIR.glob("*.json")):
        if f.stem == "index":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        rows.append({"vessel_id": d["vessel_id"], "report_date": d["report_date"],
                     "file": f"daily-reports/{f.name}",
                     "task_log_rows": len(d.get("task_log") or [])})
    rows.sort(key=lambda r: (r["report_date"], r["vessel_id"]))
    (OUT_DIR / "index.json").write_text(
        json.dumps({"reports": rows}, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
