# Plan: From poll-and-snap to subscribe-and-flow

> **Status:** Drafted but **NOT yet implemented**. Saved here so we can pick it up later.
> Decisions captured at the bottom of the doc.

---

## The problem (be honest)

The current "cyan halo when AIS is fresh, plain icon otherwise" experience is a
symptom of three deeper architectural choices:

1. **Position is a binary decision.** At each render tick the simulator picks
   ONE source: either the nearest AIS keyframe (within ±30 min) OR a straight
   line interpolation from the captain's report. Switching between them feels
   like a "hijack" because the vessel teleports.
2. **AIS data is stored as discrete snapshots, not a continuous stream.** With
   30-min gaps you can't draw smooth motion — you can only point at one
   snapshot at a time.
3. **The two sources fight for the same icon.** When AIS disagrees with the
   captain's report, only one wins; the user can't see the disagreement.

A better provider with continuous data is **necessary but not sufficient** — we
also need to change how the simulator represents truth.

---

## Provider research

| Provider | Delivery | Update freq | Persian Gulf | Trial / pricing |
|---|---|---|---|---|
| **Kpler (parent of Spire + MarineTraffic) — NMEA TCP stream** ⭐ | **TCP feed, push** | ~25 s/vessel avg, ~5 s latency | 13,000+ receivers globally, Gulf covered | Enterprise only — request demo. Likely ~$500–2 000/mo for 4 MMSIs with NMEA stream access |
| Kpler API (REST) | Polling | Same dataset, same coverage | Same | Enterprise |
| **Datalastic /vessel_pro (today)** | Polling | ~30 min per vessel | Gulf yes | €199/mo, 14-day trial |
| AISStream.io | WebSocket | Real-time when in range | ❌ no Gulf | Free |

**Realistic upgrade path is Kpler/Spire** — only commercial provider that has
both Persian Gulf coverage *and* a true streaming feed. Pricing not public;
worth a demo call before committing.

**Alternative DIY route:** install one cheap AIS receiver in Kuwait
(~$150–300 RTL-SDR + dAISy + RPi). Owning the raw NMEA stream costs nothing
per month. Range is line-of-sight (~40 nm) but Shuaiba + OPH + OD-1 are all
within range of one well-placed antenna.

---

## The architectural shift — three changes

### 1. From "snap-to-keyframe" to dead-reckoning

Today: marker jumps to the nearest AIS fix or to the interpolated
daily-report position. Choose-one.

Better: the marker **always moves smoothly**, using **dead-reckoning** physics
between fixes:

```
   AIS fix at t=0:  position (29.04, 48.16), SOG 8 kt, COG 045°
   AIS fix at t=30s: not yet arrived
   ──────────────────────────────────────────────────────
   At t=15s, the marker doesn't snap — it advances from (29.04, 48.16)
   along COG 045° at 8 kt for 15 seconds = ~33 meters NE.
   When the t=30s fix arrives, smoothly correct (Kalman-style)
   rather than teleport.
```

The vessel **never jumps**. It moves continuously, with confidence that
decays as time-since-last-fix grows.

### 2. From "AIS or report" to "both always visible"

Drop the "two-source binary." Always draw **two parallel objects**:

```
   The vessel icon                    What it represents
   ─────────────────                  ────────────────────────────
   🚢 (solid, bright)                 Real AIS truth (dead-reckoned)
                                       — primary signal of "where it
                                       actually is"

   🛳️ (ghosted, dashed outline)        Captain's planned position
                                       at this time — only drawn when
                                       it DIFFERS from AIS by > 200 m

   ─ ─ ─ ─ ─ ─ ─                       Planned route (dashed thin)
   ━━━━━━━━━━━━━                       Actual track (solid bright)
```

The cyan halo goes away. Instead, the user sees both ghosts when reality
disagrees with the plan — that's the *audit story made visual*.

### 3. From "single moment" to "continuous trail"

Show **last N minutes of vessel history as a fading trail** behind the
marker, like every modern maritime tool does:

```
     · · • • ━━━━━━●  ← vessel now
     │       │      │
     30 min  10 min  current
     ago     ago     fix
```

When live mode is on, the trail grows in real time. When the time slider
moves, the trail rewinds. This is how MarineTraffic, VesselFinder, and
FleetMon all do it.

---

## UX patterns to adopt (instead of cyan pulse)

| Pattern | Replaces today's… | What it tells you |
|---|---|---|
| **Velocity vector** — small arrow projecting from vessel showing COG and SOG | (none) | At a glance: which way + how fast |
| **Stale-data desaturation** — vessel icon goes grey + slightly transparent when AIS hasn't updated in N min | Cyan halo (which is positive feedback for fresh data) | Negative cue for stale data; fresh data is the implicit default |
| **Trail with timestamps** — hover any dot on the trail → tooltip with UTC, SOG, COG | Static AIS keyframe dots | Lets you audit a specific moment |
| **Predicted-track cone** — dashed cone projecting forward based on current SOG/COG (widens with time-uncertainty) | (none) | "Vessel will be roughly here in 20 min" |
| **Discrepancy banner** at top of vessel card — "AIS shows vessel at OPH; report said Shuaiba (off by 2.3 nm)" | (you have to compare manually) | Auto-detects when reality and report disagree |
| **AIS-coverage gauge** below the vessel card — sparkline of fix density over last 24h | (no signal) | Tells you "we're getting good data" or "vessel went dark 4h ago" |
| **Replay scrubber with density overlay** on the time slider | Flat slider | Shows you visually WHERE in time AIS data is dense vs sparse |

---

## Phased implementation (when we resume)

| Phase | Effort | What it gives you |
|---|---|---|
| **1 — Backend swap** (only if/when Kpler/Spire arrives) | Half-day | Replace `tools/poll_ais.py` + `/api/live/start` with a Node TCP client that subscribes to a NMEA stream. Same `data/ais-history/` JSON shape, just continuously fed. `app.js` doesn't change yet. |
| **2 — Dead-reckoning render** | Half-day | Replace `positionAt()` "snap to nearest" with "linear interpolate between bracketing fixes + extrapolate when extending beyond last fix." Vessel motion becomes smooth. Drop the cyan halo. |
| **3 — Trail and velocity vector** | Half-day | Render `state.aisTracksByVid[vid]` as a fading polyline behind each vessel; small arrow showing COG. |
| **4 — Two-object overlay** | 1 day | When `state.showPlanned` is on, render a ghosted secondary icon at the daily-report's interpolated position. Only visible when it differs from AIS by > 200 m. |
| **5 — Discrepancy detection + banner** | 1 day | New module `discrepancies.js`: walks AIS track + daily report task log, flags divergences (location, time, sequence), surfaces in vessel cards + a dedicated "Audit" panel. |
| **6 — Predicted-track cone + AIS-coverage gauge** | Half-day each | Pure visualization on top of existing data. Polish. |
| **7 — Time-slider density overlay** | Half-day | Compute fix density per hour bucket, render as a small bar chart underneath the slider track. |

Total: roughly **4–5 days of engineering** to go from "poll-and-snap" to
"subscribe-and-flow."

---

## Decisions taken so far

When this plan was reviewed, two questions were answered:

1. **Provider strategy** — *"Skip the provider question — just do the UX /
   architecture changes now on top of Datalastic."*
   Rationale: even with 30-min polling cadence, the architectural moves
   (dead-reckoning, trail, two-object overlay, discrepancy detection) would
   make the current data feel much better. The provider upgrade becomes a
   drop-in later when we go to a Kpler/Spire demo.

2. **Priority order** — *"Do motion+trail first, then discrepancy."*
   Two days of work back-to-back. The smooth motion change makes the
   discrepancy work cleaner because the user can see two vessels diverge
   in real time.

So when we resume, the order is:

1. **Phase 2 — Dead-reckoning render** (kill the snap)
2. **Phase 3 — Trail + velocity vector** (continuous history visible)
3. **Phase 5 — Discrepancy detection + banner** (audit feature)
4. (later) Phases 1, 4, 6, 7 as time / budget / provider permit.

---

## Open questions to revisit when we start

* Do we keep the AIS overlay checkbox in this future? With dead-reckoning the
  marker is *always* AIS-driven when AIS exists — the checkbox might become
  redundant.
* What's the right N for "trail last N minutes"? Default 60 min, user-tunable?
* Discrepancy threshold — 200 m for location, 15 min for time? Both need
  per-vessel-type tuning (Juno moves much faster than Crest PSVs).
* Should the discrepancies be written to a new `data/audit/{date}.json` so
  there's an auditable record over time?

---

*Last touched: 2026-05-16 — paused before implementation; resume by reading
this doc, picking Phase 2, and editing `app.js positionAt()` first.*
