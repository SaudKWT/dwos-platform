#!/usr/bin/env python3
"""Poll Datalastic's /vessel_pro (current position) endpoint for each MMSI
and append the result into ``data/ais-history/{VESSEL}-{YYYY-MM-DD}.json``.

Why this exists: Datalastic's ``/vessel_history`` retroactively returns
sampled keyframes (median ~30 min apart).  ``/vessel_pro`` returns the
*current* position, fresh.  By polling it on a schedule and appending,
the per-day JSON accumulates dense recent track that exceeds what
``/vessel_history`` will give for the same window.

Idempotent: dedupes by exact ``last_position_UTC`` timestamp, so running
the script twice in a row (e.g. when the vessel hasn't moved) does not
bloat the file.

Examples:
    # One-shot — pull current position for all 4 vessels, append, exit.
    python3 tools/poll_ais.py

    # Loop in foreground every 10 minutes (Ctrl-C to stop).
    python3 tools/poll_ais.py --interval 600

    # Single MMSI, single shot.
    python3 tools/poll_ais.py --vessel JUNO

Credit cost: 1 Datalastic credit per /vessel_pro call.  At 4 vessels
every 10 minutes that's ~575 credits/day.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
AIS_DIR = PROJECT_ROOT / "data" / "ais-history"

sys.path.insert(0, str(PROJECT_ROOT))
from tools.import_ais_history import load_env, mmsi_for, rebuild_index  # noqa: E402

VESSEL_IDS = ["JUNO", "CA1", "CA3", "CA5"]
BASE_URL = "https://api.datalastic.com/api/v0/vessel_pro"


def fetch_current(api_key: str, mmsi: str, *, timeout: int = 20) -> dict | None:
    """Return the canonical position dict from /vessel_pro, or None on failure."""
    url = f"{BASE_URL}?{urllib.parse.urlencode({'api-key': api_key, 'mmsi': mmsi})}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"HTTP {e.code}: {body}") from e
    except Exception as e:
        raise RuntimeError(str(e)) from e

    d = (payload or {}).get("data") or {}
    if not d.get("lat") or not d.get("lon"):
        return None
    return {
        "ts": d.get("last_position_UTC") or d.get("timestamp"),
        "lat": float(d["lat"]),
        "lon": float(d["lon"]),
        "sog": _num(d.get("speed")),
        "cog": _num(d.get("course")),
        "heading": _num(d.get("heading")),
        "nav_status": d.get("navigation_status"),
    }


def _num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def append_position(vessel_id: str, mmsi: str, pos: dict) -> tuple[Path, bool]:
    """Append *pos* into the per-UTC-day JSON for this vessel.

    Returns (path, appended) — appended=False means the timestamp was
    already present (dedup hit) and the file was not modified.
    """
    if not pos.get("ts"):
        raise ValueError("position has no timestamp")
    date = pos["ts"][:10]
    path = AIS_DIR / f"{vessel_id}-{date}.json"

    if path.exists():
        rec = json.loads(path.read_text(encoding="utf-8"))
    else:
        rec = {
            "vessel_id": vessel_id,
            "mmsi": mmsi,
            "date_utc": date,
            "positions": [],
            "source": {
                "provider": "datalastic",
                "imported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "raw_query": f"datalastic /vessel_pro polled",
            },
        }

    if any(p.get("ts") == pos["ts"] for p in rec["positions"]):
        return path, False

    rec["positions"].append(pos)
    rec["positions"].sort(key=lambda p: p["ts"])
    rec["stats"] = stats_for(rec["positions"])
    rec["source"]["imported_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    AIS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, indent=2), encoding="utf-8")
    return path, True


def stats_for(positions: list[dict]) -> dict:
    if not positions:
        return {"count": 0}
    sorted_ts = sorted(p["ts"] for p in positions)
    lats = [p["lat"] for p in positions]
    lons = [p["lon"] for p in positions]
    sogs = [p.get("sog") for p in positions if isinstance(p.get("sog"), (int, float))]
    return {
        "count": len(positions),
        "first_ts": sorted_ts[0],
        "last_ts":  sorted_ts[-1],
        "bbox":    [min(lats), min(lons), max(lats), max(lons)],
        "max_sog": max(sogs) if sogs else None,
    }


def run_once(api_key: str, vessels: list[str], env: dict) -> None:
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] polling {len(vessels)} vessel(s)…")
    new_count = 0
    for vid in vessels:
        mmsi = mmsi_for(env, vid)
        if not mmsi:
            print(f"  {vid:5s} skip: no MMSI in .env")
            continue
        try:
            pos = fetch_current(api_key, mmsi)
        except Exception as e:
            print(f"  {vid:5s} ERROR: {str(e)[:140]}")
            continue
        if pos is None:
            print(f"  {vid:5s} no position returned")
            continue
        path, appended = append_position(vid, mmsi, pos)
        tag = "NEW " if appended else "dup "
        if appended:
            new_count += 1
        sog = f"{pos['sog']:.1f}kt" if pos.get("sog") is not None else "    -"
        print(f"  {vid:5s} {tag} {pos['ts']}  {pos['lat']:8.4f},{pos['lon']:8.4f}  {sog}  → {path.name}")
    rebuild_index()
    print(f"[{now}] done. {new_count} new position(s) appended.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Poll Datalastic /vessel_pro and append to ais-history.")
    ap.add_argument("--api-key", default=None,
                    help="Datalastic API key. Defaults to DATALASTIC_API_KEY in .env.")
    ap.add_argument("--vessel", nargs="+", default=VESSEL_IDS,
                    help="Which vessels to poll. Default: all four.")
    ap.add_argument("--interval", type=int, default=0,
                    help="Seconds between polls. 0 (default) = one-shot then exit.")
    args = ap.parse_args()

    env = load_env()
    api_key = args.api_key or env.get("DATALASTIC_API_KEY")
    if not api_key:
        print("error: no Datalastic API key (pass --api-key or set DATALASTIC_API_KEY in .env)", file=sys.stderr)
        return 2

    if args.interval <= 0:
        run_once(api_key, args.vessel, env)
        return 0

    print(f"Polling every {args.interval}s — Ctrl-C to stop.")
    try:
        while True:
            run_once(api_key, args.vessel, env)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nstopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
