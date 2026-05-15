#!/usr/bin/env python3
"""Run a provider against the 4 KOC MMSIs and print a coverage report.

Use this BEFORE paying for a provider.  Drop in your trial API key, run
the script, and it tells you:

  * Did the provider return any data at all for each vessel?
  * Are the positions actually in the Persian Gulf, or are they ghosts?
  * What's the time resolution (positions per hour)?
  * Are there long gaps?

Example:
    python3 tools/validate_ais_provider.py \\
        --provider datalastic \\
        --api-key  $DATALASTIC_TRIAL_KEY \\
        --days 7

It does NOT write anything to data/ais-history/ — pure read-only probe.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.import_ais_history import (  # noqa: E402
    PROVIDERS, VESSEL_IDS, load_env, mmsi_for, stats_for, split_by_utc_day,
)

# Persian Gulf rough bounding box (Kuwait + Hormuz approaches).
GULF_BBOX = (24.0, 47.0, 30.5, 57.0)  # lat_min, lon_min, lat_max, lon_max


def in_gulf(p: dict) -> bool:
    return (GULF_BBOX[0] <= p["lat"] <= GULF_BBOX[2]
            and GULF_BBOX[1] <= p["lon"] <= GULF_BBOX[3])


def analyse(positions: list[dict]) -> dict:
    if not positions:
        return {"count": 0}
    in_gulf_count = sum(1 for p in positions if in_gulf(p))
    s = stats_for(positions)
    # Gaps: longest stretch of consecutive points without a new sample
    times = []
    for p in positions:
        try:
            t = datetime.fromisoformat(p["ts"].replace("Z", "+00:00"))
            times.append(t)
        except Exception:
            pass
    times.sort()
    gaps_min = []
    for a, b in zip(times, times[1:]):
        gaps_min.append((b - a).total_seconds() / 60)
    return {
        **s,
        "in_gulf": in_gulf_count,
        "out_of_gulf": s["count"] - in_gulf_count,
        "gulf_pct": round(100 * in_gulf_count / s["count"], 1) if s["count"] else 0,
        "max_gap_min": round(max(gaps_min)) if gaps_min else None,
        "median_gap_min": round(sorted(gaps_min)[len(gaps_min) // 2]) if gaps_min else None,
        "positions_per_hour": round(s["count"] / max(1, (times[-1] - times[0]).total_seconds() / 3600), 1)
            if len(times) >= 2 else 0,
    }


def verdict(stats: dict) -> str:
    if stats["count"] == 0:
        return "❌ NO DATA — provider does not cover this vessel/region"
    if stats.get("gulf_pct", 0) < 50:
        return f"⚠️  ONLY {stats['gulf_pct']}% OF POSITIONS IN THE GULF — coverage likely indirect"
    if stats.get("median_gap_min", 999) > 60:
        return f"⚠️  SPARSE (median {stats['median_gap_min']} min between fixes) — possibly satellite-only"
    if stats.get("positions_per_hour", 0) < 1:
        return "⚠️  LOW FREQUENCY — confirm before committing"
    return "✅ GOOD coverage"


def main() -> int:
    ap = argparse.ArgumentParser(description="Probe an AIS provider's Persian Gulf coverage.")
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS.keys()))
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--vessel", nargs="+", default=VESSEL_IDS)
    ap.add_argument("--days", type=int, default=3,
                    help="Look-back window in days. Smaller = cheaper in credits. Default 3.")
    args = ap.parse_args()

    env = load_env()
    api_key = args.api_key
    if not api_key:
        envvar = {
            "datalastic": "DATALASTIC_API_KEY",
            "vtexplorer": "VTEXPLORER_API_KEY",
        }.get(args.provider)
        api_key = env.get(envvar) if envvar else None
    if not api_key and args.provider != "manual":
        print("error: no --api-key and none in .env", file=sys.stderr)
        return 2

    cls = PROVIDERS[args.provider]
    provider = cls(api_key=api_key)  # type: ignore[call-arg]

    until = datetime.now(timezone.utc)
    since = until - timedelta(days=args.days)

    print(f"=" * 64)
    print(f"  AIS Provider Coverage Probe — {args.provider}")
    print(f"  Window:    last {args.days} day(s) (since {since.strftime('%Y-%m-%d')})")
    print(f"  Vessels:   {', '.join(args.vessel)}")
    print(f"  Gulf bbox: lat {GULF_BBOX[0]}–{GULF_BBOX[2]}, lon {GULF_BBOX[1]}–{GULF_BBOX[3]}")
    print(f"=" * 64)

    overall_count = 0
    overall_in_gulf = 0
    overall_failures = 0
    for vid in args.vessel:
        mmsi = mmsi_for(env, vid)
        if not mmsi:
            print(f"\n  {vid} (MMSI ?)")
            print(f"    skip: MMSI not in .env (AIS_MMSI_{vid})")
            continue
        try:
            positions = provider.fetch_history(mmsi, since, until)
        except Exception as e:
            overall_failures += 1
            print(f"\n  {vid} (MMSI {mmsi})")
            print(f"    ERROR: {str(e)[:160]}")
            continue

        s = analyse(positions)
        overall_count += s.get("count", 0)
        overall_in_gulf += s.get("in_gulf", 0)
        print(f"\n  {vid} (MMSI {mmsi})")
        if s["count"] == 0:
            print(f"    no positions returned")
        else:
            print(f"    positions returned : {s['count']}")
            print(f"    in Persian Gulf    : {s['in_gulf']} ({s['gulf_pct']}%)")
            print(f"    bbox observed      : lat {s['bbox'][0]:.3f}–{s['bbox'][2]:.3f}, lon {s['bbox'][1]:.3f}–{s['bbox'][3]:.3f}")
            print(f"    time coverage      : {s['first_ts']} → {s['last_ts']}")
            print(f"    median gap         : {s.get('median_gap_min')} min   max gap: {s.get('max_gap_min')} min")
            print(f"    positions/hour     : {s.get('positions_per_hour')}")
        # Per-day breakdown for transparency
        by_day = split_by_utc_day(positions)
        if by_day:
            print(f"    per-day            : " +
                  ", ".join(f"{d}={len(p)}" for d, p in sorted(by_day.items())))
        print(f"    verdict            : {verdict(s)}")

    print()
    print(f"=" * 64)
    if overall_count == 0:
        print(f"  OVERALL: ❌ no data returned from {args.provider} for any vessel.")
        print(f"  Recommendation: try a different provider.")
    else:
        pct = 100 * overall_in_gulf / overall_count if overall_count else 0
        print(f"  OVERALL: {overall_count} positions, {overall_in_gulf} in Gulf ({pct:.1f}%)")
        if pct >= 50 and overall_failures == 0:
            print(f"  Recommendation: ✅ {args.provider} looks viable. Run full import.")
        elif pct >= 50:
            print(f"  Recommendation: ⚠️  partial — got data for some vessels, failed on others.")
        else:
            print(f"  Recommendation: ⚠️  data exists but mostly outside the Gulf — verify with support.")
    print(f"=" * 64)
    return 0 if overall_count > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
