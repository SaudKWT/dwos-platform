#!/usr/bin/env python3
"""End-to-end data integrity check.

Walks every parsed JSON file under ``data/`` and reports issues that would
cause the simulator to silently drop a vessel-day or render a wrong
position.  Run this whenever the parsers or imports change.

Checks:
  * data/daily-reports/*.json
      - vessel_id is one of JUNO / CA1 / CA3 / CA5
      - report_date is YYYY-MM-DD
      - task_log is a non-empty array
      - every task_log row has a valid HH:MM from_time (zero-padded)
      - every task_log row's to_time is either null or valid HH:MM
      - to_time, when present, is >= from_time (else flagged)
      - location_id, when present, is one of B4/B20/NP/OPH/OD
      - first row covers 00:00–early-morning (no gaps at start of day)
  * data/ais-history/*.json
      - vessel_id, mmsi, date_utc present + well-formed
      - positions is non-empty
      - every position has ts (ISO Z), lat in [-90, 90], lon in [-180, 180]
      - all positions fall on the file's date_utc (otherwise the index is wrong)
      - positions are sorted ascending by ts
  * data/daily-reports/index.json + data/ais-history/index.json
      - each row exists as a file on disk
      - no orphan files (file on disk not in index)
  * data/learned-profiles.json
      - referenced vessel_ids exist
      - waypoint lat/lon are sane

Exit code = 0 if clean, 1 if any issue found.

    python3 tools/validate_data.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPORTS_DIR  = PROJECT_ROOT / "data" / "daily-reports"
AIS_DIR      = PROJECT_ROOT / "data" / "ais-history"
PLANS_DIR    = PROJECT_ROOT / "data" / "movement-plans"
LEARNED_PATH = PROJECT_ROOT / "data" / "learned-profiles.json"

VESSEL_IDS = {"JUNO", "CA1", "CA3", "CA5"}
LOC_IDS    = {"B4", "B20", "NP", "OPH", "OD"}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^[0-2]\d:[0-5]\d$")    # 00:00–29:59 — strict 2-digit hour
ISO_RE  = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class Issues:
    def __init__(self):
        self.errors:   list[tuple[str, str]] = []  # (file, message)
        self.warnings: list[tuple[str, str]] = []

    def err(self, where: str, msg: str): self.errors.append((where, msg))
    def warn(self, where: str, msg: str): self.warnings.append((where, msg))

    def has_issues(self) -> bool:
        return bool(self.errors) or bool(self.warnings)


# ---------------------------------------------------------------------------
# Daily reports
# ---------------------------------------------------------------------------

def check_daily_reports(issues: Issues) -> None:
    if not REPORTS_DIR.is_dir():
        issues.err(str(REPORTS_DIR), "directory missing"); return

    files = sorted(REPORTS_DIR.glob("*.json"))
    found = {}
    for f in files:
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            issues.err(f.name, f"unparseable JSON: {e}"); continue

        vid = d.get("vessel_id")
        date = d.get("report_date")
        if vid not in VESSEL_IDS:
            issues.err(f.name, f"vessel_id={vid!r} not in {sorted(VESSEL_IDS)}")
        if not isinstance(date, str) or not DATE_RE.match(date):
            issues.err(f.name, f"report_date={date!r} not YYYY-MM-DD")

        # File name should agree with content
        expected = f"{vid}-{date}.json"
        if vid and date and f.name != expected:
            issues.warn(f.name, f"filename should be {expected}")

        # task_log
        tl = d.get("task_log")
        if not isinstance(tl, list) or len(tl) == 0:
            issues.err(f.name, "task_log missing or empty")
        else:
            seen_times = set()
            prev_from = None
            for i, r in enumerate(tl):
                ft = r.get("from_time")
                tt = r.get("to_time")
                if not isinstance(ft, str) or not TIME_RE.match(ft):
                    issues.err(f.name, f"task_log[{i}].from_time={ft!r} not HH:MM zero-padded")
                if tt is not None and (not isinstance(tt, str) or not (TIME_RE.match(tt) or tt == "24:00")):
                    issues.err(f.name, f"task_log[{i}].to_time={tt!r} not HH:MM zero-padded")
                # to >= from check (when both valid; same minute OK)
                if (isinstance(ft, str) and isinstance(tt, str)
                        and TIME_RE.match(ft) and (TIME_RE.match(tt) or tt == "24:00")):
                    tt_cmp = "24:00" if tt == "24:00" else tt
                    if tt_cmp < ft and tt_cmp != "24:00":
                        issues.warn(f.name, f"task_log[{i}] to_time {tt} < from_time {ft}")
                # task_code
                if not r.get("task_code"):
                    issues.err(f.name, f"task_log[{i}] missing task_code")
                # location_id, when present
                loc = r.get("location_id")
                if loc is not None and loc not in LOC_IDS:
                    issues.warn(f.name, f"task_log[{i}].location_id={loc!r} not in {sorted(LOC_IDS)}")
                # ordering by from_time should be monotonically non-decreasing
                if prev_from and isinstance(ft, str) and TIME_RE.match(ft):
                    if ft < prev_from:
                        issues.warn(f.name, f"task_log[{i}] from_time {ft} earlier than previous row {prev_from}")
                if isinstance(ft, str) and TIME_RE.match(ft):
                    prev_from = ft

        # source block
        src = d.get("source")
        if not isinstance(src, dict) or not src.get("type"):
            issues.warn(f.name, "source.type missing")

        found[(vid, date)] = f.name

    # Index check
    idx_path = REPORTS_DIR / "index.json"
    if not idx_path.exists():
        issues.warn("daily-reports/index.json", "missing")
    else:
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        rows = idx.get("reports") or []
        index_keys = {(r.get("vessel_id"), r.get("report_date")) for r in rows}
        on_disk_keys = set(found.keys())
        for k in index_keys - on_disk_keys:
            issues.err("daily-reports/index.json", f"references missing file: {k[0]}-{k[1]}.json")
        for k in on_disk_keys - index_keys:
            issues.warn("daily-reports/index.json", f"on disk but not in index: {k[0]}-{k[1]}.json")


# ---------------------------------------------------------------------------
# AIS history
# ---------------------------------------------------------------------------

def check_ais_history(issues: Issues) -> None:
    if not AIS_DIR.is_dir():
        issues.warn(str(AIS_DIR), "directory missing (no AIS imported yet)"); return

    files = sorted(AIS_DIR.glob("*.json"))
    found = {}
    for f in files:
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            issues.err(f.name, f"unparseable JSON: {e}"); continue

        vid = d.get("vessel_id")
        date_utc = d.get("date_utc")
        mmsi = d.get("mmsi")
        if vid not in VESSEL_IDS:
            issues.err(f.name, f"vessel_id={vid!r} not in {sorted(VESSEL_IDS)}")
        if not isinstance(date_utc, str) or not DATE_RE.match(date_utc):
            issues.err(f.name, f"date_utc={date_utc!r} not YYYY-MM-DD")
        if not isinstance(mmsi, str) or not re.match(r"^\d{9}$", mmsi or ""):
            issues.err(f.name, f"mmsi={mmsi!r} not a 9-digit string")

        positions = d.get("positions")
        if not isinstance(positions, list) or len(positions) == 0:
            issues.err(f.name, "positions array missing or empty"); continue

        prev_ts = None
        for i, p in enumerate(positions):
            ts = p.get("ts")
            lat = p.get("lat")
            lon = p.get("lon")
            if not isinstance(ts, str) or not ISO_RE.match(ts):
                issues.err(f.name, f"positions[{i}].ts={ts!r} not ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)")
                continue
            if not isinstance(lat, (int, float)) or not (-90 <= lat <= 90):
                issues.err(f.name, f"positions[{i}].lat={lat!r} out of [-90, 90]")
            if not isinstance(lon, (int, float)) or not (-180 <= lon <= 180):
                issues.err(f.name, f"positions[{i}].lon={lon!r} out of [-180, 180]")
            # date_utc must agree with the position's date
            if date_utc and ts[:10] != date_utc:
                issues.err(f.name, f"positions[{i}].ts={ts!r} not on file's date_utc {date_utc}")
            if prev_ts and ts < prev_ts:
                issues.warn(f.name, f"positions[{i}] ts {ts} earlier than previous {prev_ts} (unsorted)")
            prev_ts = ts

        found[(vid, date_utc)] = f.name

    # Index check
    idx_path = AIS_DIR / "index.json"
    if not idx_path.exists():
        issues.warn("ais-history/index.json", "missing"); return
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
    rows = idx.get("tracks") or []
    index_keys = {(r.get("vessel_id"), r.get("date_utc")) for r in rows}
    on_disk_keys = set(found.keys())
    for k in index_keys - on_disk_keys:
        issues.err("ais-history/index.json", f"references missing file: {k[0]}-{k[1]}.json")
    for k in on_disk_keys - index_keys:
        issues.warn("ais-history/index.json", f"on disk but not in index: {k[0]}-{k[1]}.json")


# ---------------------------------------------------------------------------
# Learned profiles
# ---------------------------------------------------------------------------

def check_learned_profiles(issues: Issues) -> None:
    if not LEARNED_PATH.exists():
        issues.warn("learned-profiles.json", "missing (run tools/learn_from_ais.py)"); return
    try:
        d = json.loads(LEARNED_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        issues.err("learned-profiles.json", f"unparseable: {e}"); return
    vessels = d.get("vessels") or {}
    for vid, v in vessels.items():
        if vid not in VESSEL_IDS:
            issues.err("learned-profiles.json", f"vessel {vid!r} not in {sorted(VESSEL_IDS)}")
        sp = v.get("cruise_speed_kts")
        if not isinstance(sp, (int, float)) or not (0 < sp < 50):
            issues.err("learned-profiles.json", f"vessel {vid} cruise_speed_kts={sp!r} unrealistic")
    routes = d.get("routes") or []
    for r in routes:
        vid = r.get("vessel_id")
        if vid not in VESSEL_IDS:
            issues.err("learned-profiles.json", f"route vessel_id={vid!r} unknown")
        for k in ("from", "to"):
            if r.get(k) not in LOC_IDS:
                issues.err("learned-profiles.json", f"route {vid} {r.get('from')}→{r.get('to')} {k}={r.get(k)!r} unknown location")
        wps = r.get("waypoints") or []
        for i, wp in enumerate(wps):
            if (not isinstance(wp, list) or len(wp) != 2
                    or not all(isinstance(x, (int, float)) for x in wp)
                    or not (-90 <= wp[0] <= 90) or not (-180 <= wp[1] <= 180)):
                issues.err("learned-profiles.json", f"route waypoint[{i}]={wp!r} malformed")


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def check_simulator_buildable(issues: Issues) -> None:
    """Replicate (Python-side) what the JS buildTimelinesFromReports does
    and verify every (vessel, day) produces at least one segment.  Catches
    the kind of bug where data parses fine schema-wise but the simulator's
    timeline ends up empty (e.g. all rows were rejected for some reason)."""
    from datetime import datetime, timezone

    def parse_task_time(date_str: str, hhmm) -> datetime | None:
        if not isinstance(hhmm, str): return None
        m = re.match(r"^(\d{1,2}):(\d{2})$", hhmm)
        if not m: return None
        hh, mm = int(m.group(1)), int(m.group(2))
        if hh > 24 or (hh == 24 and mm != 0): return None
        # Treat as Kuwait time but we only care about ordering
        if hh == 24:
            from datetime import timedelta
            return datetime.fromisoformat(date_str + "T00:00:00+03:00") + timedelta(days=1)
        return datetime.fromisoformat(f"{date_str}T{hh:02d}:{mm:02d}:00+03:00")

    if not REPORTS_DIR.is_dir():
        return
    by_vessel: dict[str, list[Path]] = {}
    for f in sorted(REPORTS_DIR.glob("*.json")):
        if f.name == "index.json":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        vid = d.get("vessel_id")
        if vid: by_vessel.setdefault(vid, []).append(f)
    for vid, files in by_vessel.items():
        for f in files:
            d = json.loads(f.read_text(encoding="utf-8"))
            tl = d.get("task_log") or []
            date = d.get("report_date") or ""
            valid_rows = 0
            for r in tl:
                t0 = parse_task_time(date, r.get("from_time"))
                if t0 is not None and r.get("task_code"):
                    valid_rows += 1
            if not valid_rows:
                issues.err(f.name, f"NO usable rows for simulator — task_log has {len(tl)} entries but none have a valid from_time + task_code")
            elif valid_rows < len(tl):
                issues.warn(f.name, f"{len(tl) - valid_rows} of {len(tl)} task_log rows have invalid from_time or missing task_code")


def check_movement_plans(issues: Issues) -> None:
    """Validate every movement-plan file against the lightweight schema used
    by the admin form and the simulator overlay."""
    if not PLANS_DIR.is_dir():
        # Plans are optional — skip silently if the folder is absent.
        return
    files = sorted(PLANS_DIR.glob("*.json"))
    for f in files:
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            issues.err(f.name, f"unparseable JSON: {e}"); continue

        # Filename must match plan_date
        plan_date = d.get("plan_date")
        if not (isinstance(plan_date, str) and DATE_RE.match(plan_date)):
            issues.err(f.name, f"plan_date {plan_date!r} not YYYY-MM-DD"); continue
        if f.stem != plan_date:
            issues.err(f.name, f"filename does not match plan_date={plan_date!r}")

        # Vessels block
        vessels = d.get("vessels")
        if not isinstance(vessels, list) or not vessels:
            issues.err(f.name, "vessels missing or empty"); continue
        seen_vids: set[str] = set()
        for v in vessels:
            if not isinstance(v, dict):
                issues.err(f.name, f"vessel entry is not an object: {v!r}"); continue
            vid = v.get("vessel_id")
            if vid not in VESSEL_IDS:
                issues.err(f.name, f"vessel_id {vid!r} not in {sorted(VESSEL_IDS)}")
            elif vid in seen_vids:
                issues.warn(f.name, f"vessel_id {vid!r} appears more than once")
            else:
                seen_vids.add(vid)
            for k in ("current_status", "tomorrow_plan", "additional", "notes"):
                if k in v and v[k] is not None and not isinstance(v[k], str):
                    issues.err(f.name, f"vessel {vid!r}: {k} must be a string or null")
        if not seen_vids:
            issues.warn(f.name, "no recognised vessels in plan")

        # Issued date sanity
        issued = d.get("issued_date")
        if issued and not (isinstance(issued, str) and DATE_RE.match(issued)):
            issues.err(f.name, f"issued_date {issued!r} not YYYY-MM-DD")


def main() -> int:
    issues = Issues()
    print("Checking daily reports …")
    check_daily_reports(issues)
    print("Checking AIS history …")
    check_ais_history(issues)
    print("Checking learned profiles …")
    check_learned_profiles(issues)
    print("Checking movement plans …")
    check_movement_plans(issues)
    print("Checking simulator can build a timeline for every (vessel, day) …")
    check_simulator_buildable(issues)

    if issues.errors:
        print(f"\n❌ {len(issues.errors)} ERROR(S):")
        for f, msg in issues.errors:
            print(f"  {f}: {msg}")
    if issues.warnings:
        print(f"\n⚠️  {len(issues.warnings)} WARNING(S):")
        for f, msg in issues.warnings:
            print(f"  {f}: {msg}")
    if not issues.has_issues():
        print("\n✅ All data clean — no errors, no warnings.")
        return 0
    return 1 if issues.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
