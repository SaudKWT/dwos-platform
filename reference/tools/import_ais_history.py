#!/usr/bin/env python3
"""Import historical AIS positions for one or more vessels and write them
into ``data/ais-history/{VESSEL_ID}-{YYYY-MM-DD}.json`` using the schema
defined in ``data/ais-history.schema.json``.

The script is **provider-agnostic** — each supported AIS API is a small
class that knows how to query its vendor and emit position records in
the canonical shape.  The CLI picks the provider, and the calling
contract is the same for everyone:

    python3 tools/import_ais_history.py \\
        --provider datalastic \\
        --api-key  YOUR_KEY \\
        --vessel JUNO CA1 CA3 CA5 \\
        --days 7

Reads vessel→MMSI mapping from ``.env`` (the same one ``config.local.js``
already mirrors).  Never prints the key.  Writes one JSON per vessel per
UTC day, plus an updated ``data/ais-history/index.json``.

Implemented providers:
  - ``datalastic``  — REST `/api/v0/vessel_history` endpoint, by MMSI
  - ``vtexplorer``  — STUB (subscription history isn't a public API)

Add a new provider by subclassing ``AISProvider`` and registering it in
``PROVIDERS``.  No other file needs to change.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "data" / "ais-history"
ENV_PATH = PROJECT_ROOT / ".env"

VESSEL_IDS = ["JUNO", "CH3", "CA1", "CA3", "CA5"]


# ---------------------------------------------------------------------------
# Tiny .env reader (no python-dotenv dependency)
# ---------------------------------------------------------------------------

def load_env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    env: dict[str, str] = {}
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def mmsi_for(env: dict[str, str], vessel_id: str) -> str | None:
    """Resolve vessel_id (JUNO/CH3/CA1/CA3/CA5) -> MMSI from .env."""
    return env.get(f"AIS_MMSI_{vessel_id}")


# ---------------------------------------------------------------------------
# Provider plumbing
# ---------------------------------------------------------------------------

class AISProvider:
    """Base class.  Subclasses implement ``fetch_history``."""

    name = "abstract"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def fetch_history(self, mmsi: str, since: datetime, until: datetime) -> list[dict]:
        """Return a list of canonical position dicts (see schema).

        Each dict has keys: ``ts`` (ISO-8601 UTC), ``lat``, ``lon``, and
        optionally ``sog``, ``cog``, ``heading``, ``nav_status``.
        The implementation is responsible for any vendor pagination.
        """
        raise NotImplementedError

    # Common HTTP helper — providers can override if they need POST or auth headers.
    def _get_json(self, url: str, params: dict[str, str], *, timeout: int = 30) -> dict:
        q = urllib.parse.urlencode(params)
        full = f"{url}?{q}"
        with urllib.request.urlopen(full, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Datalastic
# ---------------------------------------------------------------------------

class Datalastic(AISProvider):
    """Datalastic historical AIS provider.

    Endpoint: ``GET https://api.datalastic.com/api/v0/vessel_history``
    Parameters: ``api-key``, ``mmsi``, ``days`` (look-back window in days).
    Credit cost: 1 credit per vessel-day returned.
    """

    name = "datalastic"
    BASE_URL = "https://api.datalastic.com/api/v0/vessel_history"

    def fetch_history(self, mmsi: str, since: datetime, until: datetime) -> list[dict]:
        days = max(1, (until - since).days + 1)
        try:
            payload = self._get_json(self.BASE_URL, {
                "api-key": self.api_key,
                "mmsi": mmsi,
                "days": str(days),
            })
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Datalastic HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e

        # Documented response wraps positions under 'data.positions' (Datalastic
        # convention).  Be lenient: accept either {'data': {'positions': []}},
        # {'positions': []}, or just a top-level list.
        if isinstance(payload, list):
            raw = payload
        elif isinstance(payload, dict):
            raw = (payload.get("data") or {}).get("positions") \
                  or payload.get("positions") \
                  or payload.get("data") \
                  or []
            if not isinstance(raw, list):
                raw = []
        else:
            raw = []

        out: list[dict] = []
        for p in raw:
            try:
                out.append(self._normalise_position(p))
            except Exception:
                continue
        return out

    @staticmethod
    def _normalise_position(p: dict) -> dict:
        # Datalastic fields seen across docs: lat, lon, last_position_epoch / timestamp,
        # speed, course, heading, navigation_status.  Be flexible.
        lat = p.get("lat") if "lat" in p else p.get("latitude")
        lon = p.get("lon") if "lon" in p else p.get("longitude")
        ts = (p.get("last_position_epoch") or p.get("timestamp")
              or p.get("ts") or p.get("time"))
        if isinstance(ts, (int, float)):
            ts_iso = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
        elif isinstance(ts, str):
            # Already ISO; trust but normalise trailing tz
            ts_iso = ts.replace("+00:00", "Z")
            if not ts_iso.endswith("Z") and "T" in ts_iso and "+" not in ts_iso:
                ts_iso += "Z"
        else:
            raise ValueError("no timestamp")
        return {
            "ts": ts_iso,
            "lat": float(lat),
            "lon": float(lon),
            "sog": _num(p.get("speed") if "speed" in p else p.get("sog")),
            "cog": _num(p.get("course") if "course" in p else p.get("cog")),
            "heading": _num(p.get("heading")),
            "nav_status": p.get("navigation_status") or p.get("nav_status"),
        }


# ---------------------------------------------------------------------------
# VT Explorer (stub — no public historical API, leaving the slot ready)
# ---------------------------------------------------------------------------

class VTExplorer(AISProvider):
    name = "vtexplorer"

    def fetch_history(self, mmsi: str, since: datetime, until: datetime) -> list[dict]:
        raise NotImplementedError(
            "VT Explorer does not expose a public history-by-MMSI API at the time "
            "of writing — their subscription includes a 2-month UI playback and "
            "older data is delivered by manual quote.  If you have CSV exports "
            "from their dashboard, use --provider manual instead."
        )


# ---------------------------------------------------------------------------
# Manual (drop a CSV/JSON in for us, we just normalise)
# ---------------------------------------------------------------------------

class Manual(AISProvider):
    """Read positions from a local file you've already prepared.

    Use with ``--input PATH``.  Accepts:
      * CSV with columns: ts, lat, lon[, sog, cog, heading, nav_status]
      * JSON list of position objects in the canonical shape

    Lets you wire in any vendor that doesn't expose an API."""

    name = "manual"

    def __init__(self, *, input_path: str):
        self.input_path = Path(input_path)
        if not self.input_path.exists():
            raise FileNotFoundError(self.input_path)

    def fetch_history(self, mmsi: str, since: datetime, until: datetime) -> list[dict]:
        text = self.input_path.read_text(encoding="utf-8")
        if self.input_path.suffix.lower() == ".json":
            data = json.loads(text)
            return data if isinstance(data, list) else (data.get("positions") or [])
        # CSV
        import csv, io
        out: list[dict] = []
        for row in csv.DictReader(io.StringIO(text)):
            out.append({
                "ts": row["ts"],
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
                "sog": _num(row.get("sog")),
                "cog": _num(row.get("cog")),
                "heading": _num(row.get("heading")),
                "nav_status": row.get("nav_status") or None,
            })
        return out


PROVIDERS: dict[str, type[AISProvider]] = {
    "datalastic": Datalastic,
    "vtexplorer": VTExplorer,
    "manual": Manual,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _num(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def split_by_utc_day(positions: list[dict]) -> dict[str, list[dict]]:
    """Bucket positions by their UTC date (YYYY-MM-DD)."""
    out: dict[str, list[dict]] = {}
    for p in positions:
        d = p["ts"][:10]
        out.setdefault(d, []).append(p)
    for d in out:
        out[d].sort(key=lambda p: p["ts"])
    return out


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


def write_track(vessel_id: str, mmsi: str, date_utc: str,
                positions: list[dict], provider: str, raw_query: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{vessel_id}-{date_utc}.json"
    record = {
        "vessel_id": vessel_id,
        "mmsi": mmsi,
        "date_utc": date_utc,
        "positions": positions,
        "stats": stats_for(positions),
        "source": {
            "provider": provider,
            "imported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "raw_query": raw_query,
        },
    }
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return path


def rebuild_index() -> int:
    if not OUT_DIR.is_dir():
        return 0
    rows = []
    for f in sorted(OUT_DIR.glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
            rows.append({
                "vessel_id": rec["vessel_id"],
                "date_utc":  rec["date_utc"],
                "file":      f"ais-history/{f.name}",
                "positions": len(rec.get("positions") or []),
                "provider":  (rec.get("source") or {}).get("provider"),
            })
        except Exception:
            continue
    rows.sort(key=lambda r: (r["date_utc"], r["vessel_id"]))
    (OUT_DIR / "index.json").write_text(
        json.dumps({"tracks": rows}, indent=2), encoding="utf-8")
    return len(rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Import historical AIS positions.")
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS.keys()))
    ap.add_argument("--api-key", default=None,
                    help="API key for the provider. Defaults to env var (e.g. DATALASTIC_API_KEY).")
    ap.add_argument("--vessel", nargs="+", default=VESSEL_IDS,
                    help="Vessel IDs to fetch. Default: all four.")
    ap.add_argument("--days", type=int, default=7,
                    help="Look-back window in days (1–30). Default: 7.")
    ap.add_argument("--input", default=None,
                    help="For --provider=manual: path to a CSV or JSON file of positions.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Hit the API and report counts, but do not write files.")
    args = ap.parse_args()

    env = load_env()

    # Resolve API key
    api_key = args.api_key
    if not api_key and args.provider != "manual":
        env_var = {
            "datalastic": "DATALASTIC_API_KEY",
            "vtexplorer": "VTEXPLORER_API_KEY",
        }.get(args.provider)
        api_key = env.get(env_var) if env_var else None
    if not api_key and args.provider != "manual":
        print(f"error: no API key. Pass --api-key or set the env var in .env.", file=sys.stderr)
        return 2

    # Instantiate provider
    cls = PROVIDERS[args.provider]
    if args.provider == "manual":
        if not args.input:
            print("error: --input PATH is required for --provider=manual", file=sys.stderr)
            return 2
        provider = cls(input_path=args.input)  # type: ignore[call-arg]
    else:
        provider = cls(api_key=api_key)  # type: ignore[call-arg]

    until = datetime.now(timezone.utc)
    since = until - timedelta(days=args.days)

    total = 0
    written: list[str] = []
    errors: list[tuple[str, str]] = []
    for vid in args.vessel:
        mmsi = mmsi_for(env, vid)
        if not mmsi:
            errors.append((vid, "no MMSI in .env"))
            continue
        try:
            positions = provider.fetch_history(mmsi, since, until)
        except Exception as e:
            errors.append((vid, str(e)[:200]))
            continue

        by_day = split_by_utc_day(positions)
        for date, day_pos in sorted(by_day.items()):
            total += len(day_pos)
            if args.dry_run:
                print(f"  {vid} {date}: {len(day_pos)} positions (dry-run)")
            else:
                raw_q = f"{args.provider}: mmsi={mmsi} days={args.days}"
                path = write_track(vid, mmsi, date, day_pos, args.provider, raw_q)
                print(f"  wrote {path.relative_to(PROJECT_ROOT)} ({len(day_pos)} positions)")
                written.append(str(path.relative_to(PROJECT_ROOT)))

    if not args.dry_run:
        n = rebuild_index()
        print(f"index now has {n} tracks")

    print(f"\nSummary: {total} positions across {len(args.vessel) - len(errors)} vessel(s)")
    if errors:
        print(f"Errors:")
        for vid, msg in errors:
            print(f"  {vid}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
