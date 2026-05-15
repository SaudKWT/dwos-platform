"""Shared normalizers for the daily-report importer and the dashboard.

Locations and task codes appear in the source emails/PDFs in many spellings
("OD-1", "OD.1", "Oriental Dragon 1", "Rig OD-1" …).  Every consumer of the
parsed data should go through these functions so the simulation only ever
deals with canonical IDs (B4, B20, NP, OPH, OD).
"""

import re

# Canonical location IDs come from data/locations.json.
# (Kept here in code form so the importer doesn't have a runtime dependency
# on the JSON; if you add a location, update both files.)
CANONICAL_LOCATIONS = {"B4", "B20", "NP", "OPH", "OD"}

# Patterns are matched in order; first match wins. Use \b boundaries to avoid
# false hits ("OPHRA" must not match OPH; we keep patterns specific enough).
_LOCATION_PATTERNS = [
    # Rigs
    (re.compile(r"\boriental\s*dragon[-\s.]*1?\b", re.I), "OD"),
    (re.compile(r"\bod[-\s.]*1\b", re.I),                 "OD"),
    (re.compile(r"\boriental\s*phoenix\b", re.I),         "OPH"),
    (re.compile(r"\boph\b", re.I),                        "OPH"),

    # Ports & berths.  Order matters: most specific first.
    (re.compile(r"\bberth\s*(?:no\.?\s*)?(?:#\s*)?20\b", re.I), "B20"),
    (re.compile(r"\bberth\s*(?:no\.?\s*)?(?:#\s*)?4\b",  re.I), "B4"),
    (re.compile(r"\bnorth\s*port\b",   re.I), "NP"),
    (re.compile(r"\bnsbp\b",           re.I), "NP"),

    # Generic "Shuaiba" without a berth number → fall back to vessel's home berth
    # (handled in resolve_location, not here).
    (re.compile(r"\bshuaiba\b",        re.I), "SHUAIBA_GENERIC"),
]

# A vessel's "default" berth at Shuaiba when no berth number is given.
HOME_BERTH = {
    "JUNO": "B4",
    "CA1":  "B20",
    "CA3":  "B20",
    "CA5":  "B20",
}


def find_locations(text: str, vessel_id: str | None = None) -> list[str]:
    """Return the canonical location IDs mentioned in *text*, in order of
    first appearance, deduplicated.  Generic 'Shuaiba' resolves to the
    vessel's home berth when *vessel_id* is provided."""
    if not text:
        return []
    found: list[tuple[int, str]] = []
    for pat, loc in _LOCATION_PATTERNS:
        for m in pat.finditer(text):
            if loc == "SHUAIBA_GENERIC":
                resolved = HOME_BERTH.get(vessel_id or "", None)
                if resolved is None:
                    continue
                found.append((m.start(), resolved))
            else:
                found.append((m.start(), loc))
    found.sort()
    seen: set[str] = set()
    ordered: list[str] = []
    for _, loc in found:
        if loc not in seen:
            seen.add(loc)
            ordered.append(loc)
    return ordered


def resolve_location(text: str, vessel_id: str | None = None) -> str | None:
    """Return a single best-guess canonical location for *text*, or None."""
    locs = find_locations(text, vessel_id)
    return locs[0] if locs else None


# Operational task code → human label.
# Codes seen in Halliburton + Allianz Marine templates.
TASK_CODES = {
    "S01": "Standby on location",
    "S02": "Standby alongside rig in DP",
    "S03": "Standby (semi DP / base)",
    "S04": "Standby Shuaiba port",
    "S05": "Standby awaiting instructions",
    "DP1": "DP cargo operations",
    "L1F": "Cargo ops Freeport",
    "L2E": "Cargo ops",
    "B1":  "Back-load at rig",
    "O1":  "Other",
    "I01": "In transit",
    "I02": "In transit (channel)",
    "D1":  "Downtime",
    "WOW": "Waiting on weather",
    "A01": "Standby at anchor",
}


def label_task(code: str) -> str:
    """Return a human-readable label for a (possibly slash-combined) task code."""
    if not code:
        return ""
    parts = [p.strip() for p in re.split(r"[/+]", code) if p.strip()]
    labels = [TASK_CODES.get(p, p) for p in parts]
    return " / ".join(labels)


# Vessel-name → vessel_id (used when parsing email subjects / arrival reports).
VESSEL_ALIASES = {
    "allianz juno":     "JUNO",
    "juno":             "JUNO",
    "crest argus 1":    "CA1",
    "crest argus1":     "CA1",
    "crestargus1":      "CA1",
    "ca1":              "CA1",
    "ca-1":             "CA1",
    "crest argus 3":    "CA3",
    "crest argus3":     "CA3",
    "crestargus3":      "CA3",
    "ca3":              "CA3",
    "ca-3":             "CA3",
    "crest argus 5":    "CA5",
    "crest argus5":     "CA5",
    "crestargus5":      "CA5",
    "ca5":              "CA5",
    "ca-5":             "CA5",
}


def resolve_vessel(text: str) -> str | None:
    """Return canonical vessel_id from a free-text mention, or None."""
    if not text:
        return None
    low = text.lower()
    # try most specific first (avoid 'ca1' matching 'allianz juno')
    for key in sorted(VESSEL_ALIASES, key=len, reverse=True):
        if key in low:
            return VESSEL_ALIASES[key]
    return None


def parse_duration_to_min(s: str | None) -> int | None:
    """Parse 'H:MM' or 'HH:MM' duration to total minutes."""
    if not s:
        return None
    m = re.match(r"\s*(\d+)\s*:\s*(\d+)\s*$", s)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def parse_date_dmy(s: str) -> str | None:
    """Parse 'DD/MM/YYYY' or 'DD-MMM-YYYY' or 'DD.MM.YYYY' → 'YYYY-MM-DD'."""
    if not s:
        return None
    s = s.strip()
    # DD/MM/YYYY  or  DD.MM.YYYY
    m = re.match(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$", s)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    # DD-MMM-YYYY  (e.g. 07-May-2026)
    m = re.match(r"^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$", s)
    if m:
        d, mon, y = m.groups()
        months = {n.lower(): i for i, n in enumerate(
            ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], 1)}
        # accept full names too
        long_months = {"january":1,"february":2,"march":3,"april":4,"may":5,"june":6,
                       "july":7,"august":8,"september":9,"october":10,"november":11,"december":12}
        mi = months.get(mon[:3].lower()) or long_months.get(mon.lower())
        if mi:
            return f"{y}-{mi:02d}-{int(d):02d}"
    return None
