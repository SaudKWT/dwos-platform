#!/usr/bin/env python3
"""Learn real vessel behaviour from the AIS history we've collected, then
emit a profile the simulator can use to ground its story-section playback.

What we extract per vessel:
  * Cruise speed in knots (mean SOG when underway, i.e. SOG > 3 kt)
  * Max observed SOG
  * Sample count (how confident we should be in the number)

What we extract per leg (one for each observed from→to pair):
  * Median transit duration (minutes)
  * Mean speed during transit
  * Intermediate waypoints (lat/lon list) describing the real path

Output: ``data/learned-profiles.json``.  The simulator's
``buildTimelinesFromReports()`` reads this and uses:
  * The vessel's learned cruise speed instead of the static vessels.json speed
  * The waypoints to draw a curved route polyline instead of a straight line

Endpoints in the simulator are ALWAYS snapped to the canonical location
coords (B4, B20, NP, OPH, OD) — AIS keyframes near a rig are typically
1-1.5 nm off the rig icon because of anchor swing radius, and the user
wants the vessel to visually dock/arrive at the icon every time.

Run:
    python3 tools/learn_from_ais.py
"""

from __future__ import annotations

import json
import math
import os
import statistics
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
AIS_DIR = PROJECT_ROOT / "data" / "ais-history"
OUT_PATH = PROJECT_ROOT / "data" / "learned-profiles.json"

# Canonical location coordinates (kept in sync with data/locations.json).
LOCS: dict[str, tuple[float, float]] = {
    "B4":  (29.040444, 48.158528),
    "B20": (29.041611, 48.158250),
    "NP":  (29.123345, 48.140358),
    "OPH": (29.239111, 48.342694),
    "OD":  (28.921639, 48.474750),
}

# A vessel within this radius of a canonical location is "at" that location.
# 2.5 nm covers normal anchor swing AND the first AIS sighting just after
# the vessel cleared the 500-m safety zone or breakwater.
LOC_RADIUS_NM = 2.5

# Generous radius for the "leaving / approaching" classification — covers
# the first AIS sighting after departure when the vessel may already be a
# few nm out of the port (Datalastic keyframe density is sparse).
DEPARTURE_RADIUS_NM = 5.5

# A vessel with SOG below this is considered stationary.
STATIONARY_SOG_KT = 0.8

# A vessel with SOG above this is considered actively transiting (cruise).
CRUISE_SOG_KT = 3.0

# Minimum number of positions for a "transit episode" to be usable.
MIN_TRANSIT_POSITIONS = 2

# Gap (min) allowed BETWEEN cruise fixes inside a transit before we split.
MAX_CRUISE_GAP_MIN = 100

# Gap allowed between the last cruise fix and a slow "arrival" fix at a
# known location — vessels decelerate over the last few miles and Datalastic
# may capture only one arrival fix that is more than MAX_CRUISE_GAP_MIN
# after the last cruise fix.  We accept that.
MAX_ARRIVAL_GAP_MIN = 180

# A fix at <= APPROACH_SOG_KT within LOC_RADIUS_NM of a known location is
# treated as the arrival fix (transit ends here, not earlier).  Captures
# the "decelerating into DP / approaching the rig" pattern.
APPROACH_SOG_KT = 5.0


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------

def dist_nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    cos_lat = math.cos(math.radians(29))
    d_lat = (b[0] - a[0]) * 60
    d_lon = (b[1] - a[1]) * 60 * cos_lat
    return math.sqrt(d_lat * d_lat + d_lon * d_lon)


def nearest_loc(p: tuple[float, float]) -> tuple[str | None, float]:
    """Return (location_id, distance_nm) for the canonical location closest
    to *p*.  Never returns None for the id — callers do their own radius
    filtering with the appropriate threshold (some allow 4 nm for
    departure / arrival inference, others want a strict 2 nm)."""
    best_id = None
    best_d = math.inf
    for loc_id, loc in LOCS.items():
        d = dist_nm(p, loc)
        if d < best_d:
            best_d = d
            best_id = loc_id
    return best_id, best_d


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_all_positions() -> dict[str, list[dict]]:
    """Read every ais-history JSON, return {vid: [positions sorted by ts]}."""
    by_vid: dict[str, list[dict]] = {}
    for f in sorted(AIS_DIR.glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        vid = d.get("vessel_id")
        if not vid:
            continue
        by_vid.setdefault(vid, []).extend(d.get("positions") or [])
    # Sort and dedup by ts.
    for vid, ps in by_vid.items():
        seen: set[str] = set()
        out: list[dict] = []
        for p in sorted(ps, key=lambda x: x["ts"]):
            if p["ts"] in seen:
                continue
            seen.add(p["ts"])
            out.append(p)
        by_vid[vid] = out
    return by_vid


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Episode segmentation
# ---------------------------------------------------------------------------

def _infer_loc(p: dict, prefer_within_nm: float = LOC_RADIUS_NM) -> tuple[str | None, float]:
    """Return (loc_id, distance_nm) if p is within prefer_within_nm of a
    canonical location, else (None, math.inf)."""
    loc_id, d = nearest_loc((p["lat"], p["lon"]))
    if loc_id is not None and d <= prefer_within_nm:
        return loc_id, d
    return None, math.inf


def find_transit_episodes(positions: list[dict]) -> list[dict]:
    """Walk the positions list and extract transit episodes.

    A transit episode is a run of consecutive positions where the vessel is
    moving (SOG > CRUISE_SOG_KT), extended INWARDS at each end to include
    the bracketing arrival/departure fix where the vessel decelerates near
    a canonical location.  This lets us infer FROM/TO even when we don't
    have a fully-stationary "at the rig" fix immediately before or after.
    """
    episodes: list[dict] = []
    n = len(positions)
    i = 0
    while i < n:
        sog = positions[i].get("sog") or 0
        if sog <= CRUISE_SOG_KT:
            i += 1
            continue
        start = i
        # Walk forward, deciding for each next fix whether to include.
        # Cruising fixes have a tight gap budget; arrival fixes get a wider
        # budget because the vessel slows down and Datalastic may capture
        # only one arrival keyframe far from the previous cruise one.
        j = i
        while j + 1 < n:
            cur = positions[j]
            nxt = positions[j + 1]
            dt = (parse_ts(nxt["ts"]) - parse_ts(cur["ts"])).total_seconds() / 60
            nxt_sog = nxt.get("sog") or 0
            arrival_loc, _ = _infer_loc(nxt, LOC_RADIUS_NM)
            is_arrival = (arrival_loc is not None
                          and nxt_sog <= APPROACH_SOG_KT)
            if is_arrival and dt <= MAX_ARRIVAL_GAP_MIN:
                j += 1
                break
            if nxt_sog <= CRUISE_SOG_KT:
                # Not an arrival but vessel slowed down — include only if
                # near a port/rig (loose radius) and gap is reasonable.
                near_loc, _ = _infer_loc(nxt, DEPARTURE_RADIUS_NM)
                if near_loc is not None and dt <= MAX_ARRIVAL_GAP_MIN:
                    j += 1
                break
            if dt > MAX_CRUISE_GAP_MIN:
                break
            j += 1
        end = j
        if end - start + 1 < MIN_TRANSIT_POSITIONS:
            i = end + 1
            continue

        # FROM inference, in order of confidence:
        #   1) A STATIONARY fix at a known location within 180 min before.
        #   2) A SLOW fix (<= APPROACH_SOG_KT) at a known location within
        #      180 min before — vessel was decelerating into / sitting at
        #      a port even if AIS captured it just barely moving.
        #   3) The start fix itself is within LOC_RADIUS of a location
        #      (= just-departed within the same minute).
        #   4) Else None.  We refuse to guess from mid-passage proximity.
        from_id = None
        for k in range(start - 1, -1, -1):
            p = positions[k]
            dt_back = (parse_ts(positions[start]["ts"]) - parse_ts(p["ts"])).total_seconds() / 60
            if dt_back > 180:
                break
            sog = p.get("sog") or 0
            if sog <= APPROACH_SOG_KT:
                loc, _ = _infer_loc(p, LOC_RADIUS_NM)
                if loc is not None:
                    from_id = loc
                    break
        if from_id is None:
            loc, _ = _infer_loc(positions[start], LOC_RADIUS_NM)
            if loc is not None:
                from_id = loc

        # TO inference — mirror the FROM rules.  Only trust the end fix as
        # an arrival if it's slow (<= APPROACH_SOG_KT) AND within strict
        # LOC_RADIUS of a known location.  Otherwise look forward for a
        # genuine stationary fix at a port.  A cruising-fast end fix that
        # just happens to be near a port (CA1 at 13:21 still doing 6.5 kt
        # 3.9 nm from B4) is NOT an arrival.
        end_sog = positions[end].get("sog") or 0
        to_id = None
        loc, _ = _infer_loc(positions[end], LOC_RADIUS_NM)
        if loc is not None and end_sog <= APPROACH_SOG_KT:
            to_id = loc
        else:
            for k in range(end + 1, n):
                p = positions[k]
                dt_fwd = (parse_ts(p["ts"]) - parse_ts(positions[end]["ts"])).total_seconds() / 60
                if dt_fwd > 180:
                    break
                if (p.get("sog") or 0) <= STATIONARY_SOG_KT:
                    loc, _ = _infer_loc(p, LOC_RADIUS_NM)
                    if loc is not None:
                        to_id = loc
                        break

        t0 = parse_ts(positions[start]["ts"])
        t1 = parse_ts(positions[end]["ts"])
        dur_min = (t1 - t0).total_seconds() / 60
        speeds = [p.get("sog") for p in positions[start:end + 1] if p.get("sog") is not None]
        mean_sog = statistics.mean(speeds) if speeds else 0
        episodes.append({
            "from_loc": from_id, "to_loc": to_id,
            "t0": positions[start]["ts"], "t1": positions[end]["ts"],
            "duration_min": dur_min, "mean_sog_kt": mean_sog,
            "n_fixes": end - start + 1,
            "waypoints": [[p["lat"], p["lon"]] for p in positions[start:end + 1]],
        })
        i = end + 1
    return episodes


# ---------------------------------------------------------------------------
# Per-vessel & per-route aggregation
# ---------------------------------------------------------------------------

def aggregate(by_vid: dict[str, list[dict]]) -> dict:
    vessels: dict[str, dict] = {}
    leg_buckets: dict[tuple[str, str, str], list[dict]] = {}

    for vid, positions in by_vid.items():
        # Per-vessel cruise stats (any moving position)
        speeds = [p["sog"] for p in positions if (p.get("sog") or 0) > CRUISE_SOG_KT]
        if speeds:
            vessels[vid] = {
                "cruise_speed_kts": round(statistics.mean(speeds), 1),
                "median_speed_kts": round(statistics.median(speeds), 1),
                "max_speed_kts": round(max(speeds), 1),
                "sample_count": len(speeds),
            }

        # Per-leg
        episodes = find_transit_episodes(positions)
        for e in episodes:
            if not e["from_loc"] or not e["to_loc"] or e["from_loc"] == e["to_loc"]:
                continue
            key = (vid, e["from_loc"], e["to_loc"])
            leg_buckets.setdefault(key, []).append(e)

    routes = []
    for (vid, frm, to), eps in leg_buckets.items():
        durations = [e["duration_min"] for e in eps]
        speeds_leg = [e["mean_sog_kt"] for e in eps]
        # Use the episode with the most fixes as the "best" waypoint sample.
        best = max(eps, key=lambda e: e["n_fixes"])
        routes.append({
            "vessel_id": vid,
            "from": frm,
            "to": to,
            "sample_count": len(eps),
            "avg_duration_min": round(statistics.mean(durations), 1),
            "median_duration_min": round(statistics.median(durations), 1),
            "avg_speed_kts": round(statistics.mean(speeds_leg), 1),
            "waypoints": best["waypoints"],
            "best_episode": {
                "t0": best["t0"], "t1": best["t1"],
                "duration_min": round(best["duration_min"], 1),
                "n_fixes": best["n_fixes"],
            },
        })

    routes.sort(key=lambda r: (r["vessel_id"], r["from"], r["to"]))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "n_positions_total": sum(len(p) for p in by_vid.values()),
        "vessels": vessels,
        "routes": routes,
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def main() -> int:
    by_vid = load_all_positions()
    if not by_vid:
        print(f"No AIS data in {AIS_DIR}")
        return 1
    profile = aggregate(by_vid)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(profile, indent=2), encoding="utf-8")

    # Friendly summary on stdout
    print(f"Learned from {profile['n_positions_total']} AIS positions.")
    print(f"\nPer-vessel cruise speeds:")
    for vid, v in profile["vessels"].items():
        print(f"  {vid:5s}  cruise {v['cruise_speed_kts']:.1f} kt  "
              f"median {v['median_speed_kts']:.1f}  max {v['max_speed_kts']:.1f}  "
              f"({v['sample_count']} samples)")

    print(f"\nLearned routes ({len(profile['routes'])} total):")
    for r in profile["routes"]:
        print(f"  {r['vessel_id']:5s}  {r['from']:>3s} → {r['to']:<3s}  "
              f"duration {r['median_duration_min']:6.1f} min  "
              f"speed {r['avg_speed_kts']:4.1f} kt  "
              f"waypoints={len(r['waypoints'])}  "
              f"samples={r['sample_count']}")
    print(f"\nWrote {OUT_PATH.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
