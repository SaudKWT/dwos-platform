import type { DailyReport, MarineLocation, ReportTask, Vessel } from '@/api/types'
import { bearingDeg, distNm, parseTaskTime } from './geo'

// =============================================================================
// Simulation engine — a faithful port of the vanilla app.js engine.
//
// This code encodes months of hard-won rules about how captains actually write
// task logs (implicit end times, en-route rows, typos, aborted trips). The
// original comments are kept: they are the specification. If a behaviour here
// looks odd, check app.js history before "fixing" it.
//
// Everything is pure: state comes in through SimContext / timelines, nothing
// touches the DOM or Leaflet.
// =============================================================================

export interface LearnedRoute {
  vessel_id: string
  from: string
  to: string
  waypoints: [number, number][]
  sample_count?: number
  avg_speed_kts?: number
}

export interface LearnedVessel {
  cruise_speed_kts?: number
}

export interface SimContext {
  locsById: Record<string, MarineLocation>
  vesselsById: Record<string, Vessel>
  learnedVessels: Record<string, LearnedVessel>
  /** key: `${vid}|${from}|${to}` */
  learnedRoutes: Record<string, LearnedRoute>
}

export interface SubEvent {
  t0: Date
  t1: Date
  purpose: string | null
  raw: string | null
  filler?: boolean
}

export interface Segment {
  type: 'moored' | 'transit'
  t0: Date
  t1: Date
  // moored
  loc?: string
  sub_events?: SubEvent[]
  merged_count?: number
  // transit
  from?: string
  to?: string
  distance_nm?: number | null
  polyline?: [number, number][] | null
  learned_speed_kts?: number | null
  eta_estimated?: boolean
  turned_back?: boolean
  // common
  purpose?: string | null
  raw?: string | null
  task_code?: string | null
  filler?: boolean
}

export interface AisTrackPoint {
  ts: Date
  lat: number
  lon: number
  sog?: number | null
  cog?: number | null
}

export interface VesselPosition {
  lat: number
  lon: number
  segment: Segment | null
  heading: number
  ais?: boolean
  status?: 'pre-timeline' | 'post-timeline'
}

export type Timelines = Record<string, Segment[]>

const TRANSIT_CODES = new Set(['I01', 'I02'])

export function codeIsTransit(code: string | null | undefined): boolean {
  if (!code) return false
  return code.split(/[/+]/).some(c => TRANSIT_CODES.has(c.trim()))
}

// Standby task codes from the captains' reports: S01 (on location), S02
// (alongside rig in DP), S03 (semi DP / base), S04 (Shuaiba port), S05
// (awaiting instructions) and A01 (at anchor). Some rows carry a slash
// combination like "S01/A01".
const STANDBY_CODES = new Set(['S01', 'S02', 'S03', 'S04', 'S05', 'A01'])

export function codeIsStandby(code: string | null | undefined, label?: string | null): boolean {
  if (code && code.split(/[/+]/).some(c => STANDBY_CODES.has(c.trim().toUpperCase()))) return true
  return /standby/i.test(label || '')
}

/**
 * Real route learned from AIS history (if any) — polyline runs
 * canonical_from → AIS midpoints → canonical_to so the vessel still docks at
 * the icon even when AIS keyframes are offshore.
 */
export function learnedPathFor(ctx: SimContext, vid: string, fromId: string, toId: string) {
  const route = ctx.learnedRoutes[`${vid}|${fromId}|${toId}`]
  if (!route || !Array.isArray(route.waypoints) || route.waypoints.length === 0) return null
  const from = ctx.locsById[fromId]
  const to = ctx.locsById[toId]
  if (!from || !to) return null
  const mid = route.waypoints.map(w => [w[0], w[1]] as [number, number])
  // Sanity-trim points that are inside 1 nm of either endpoint to avoid
  // doubling-back when the AIS arrival fix is essentially at the port.
  const trimmed = mid.filter(([la, lo]) =>
    distNm({ lat: la, lon: lo }, from) > 1.0 &&
    distNm({ lat: la, lon: lo }, to) > 1.0)
  return {
    polyline: [[from.lat, from.lon], ...trimmed, [to.lat, to.lon]] as [number, number][],
    sample_count: route.sample_count,
    avg_speed_kts: route.avg_speed_kts,
  }
}

/**
 * Walk task rows in document order and enforce monotonic from_time.
 * If a row's HH:MM falls *strictly before* the previous accepted row's,
 * it's almost certainly a captain typo (e.g. JUNO 15-May row 23 reads
 * "13:45" between 15:43 and 16:20 — the source docx confirms it should
 * be 15:45). In that case shift the row to prev + 1 min so a later
 * stable sort can't sandwich it between earlier entries and compress a
 * multi-hour transit into a few minutes. HH:MM string compare is safe.
 */
export function monotonicizeRows(rows: ReportTask[]): ReportTask[] {
  let prev: string | null = null
  return rows.map(r => {
    if (!r || !r.from_time) return r
    let from = r.from_time
    if (prev && from.localeCompare(prev) < 0) {
      const [ph, pm] = prev.split(':').map(Number)
      let mins = ph * 60 + pm + 1
      if (mins > 24 * 60 - 1) mins = 24 * 60 - 1
      from = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
    }
    prev = from
    return from === r.from_time ? r : { ...r, from_time: from }
  })
}

export function rowsToSegments(
  ctx: SimContext, reportDate: string, rows: ReportTask[], vid: string,
): Segment[] {
  const cleaned = monotonicizeRows(rows).filter(r => r && r.from_time)
  // Sort by from_time (string compare is fine for HH:MM). After the
  // monotonic clamp this is a no-op for well-formed reports.
  const sorted = cleaned.sort((a, b) => a.from_time!.localeCompare(b.from_time!))
  const out: Segment[] = []
  let prevKnownLoc: string | null = null
  // Rows consumed as "en-route" evidence by an earlier transit leg —
  // they must not spawn their own hold-position segments.
  const absorbed = new Set<number>()

  for (let i = 0; i < sorted.length; i++) {
    if (absorbed.has(i)) continue
    const r = sorted[i]
    const t0 = parseTaskTime(reportDate, r.from_time)
    let t1 = parseTaskTime(reportDate, r.to_time)
    let endKind: 'explicit' | 'nextRow' | 'eod' | 'arrival' | 'boundary' | null = t1 ? 'explicit' : null
    if (!t1) {
      // Use the next row's from_time, or end-of-day, as the implicit end.
      const next = sorted[i + 1]
      t1 = next ? parseTaskTime(reportDate, next.from_time)
                : parseTaskTime(reportDate, '24:00')
      endKind = next ? 'nextRow' : 'eod'
    }
    if (!t0 || !t1 || t1 <= t0) continue

    const transit = codeIsTransit(r.task_code)
    const ll = r.location_id || null
    const from: string | null = r.from_location_id || prevKnownLoc || null
    const to: string | null = r.to_location_id || ll || null

    if (transit && from && to && from !== to) {
      const fromLoc = ctx.locsById[from]
      const toLoc = ctx.locsById[to]
      const learned = learnedPathFor(ctx, vid, from, to)

      // ------------------------------------------------------------------
      // Real end-of-transit inference. Captains log a departure row and
      // then keep logging en-route events as separate rows ("CLEAR
      // BREAKWATER" 5 min after "C/OFF ... PROCEED TO OD.1"). Naively
      // ending the leg at the next row's from_time compressed an 18 nm
      // trip into 5 minutes — the vessel teleported at 200+ kts, then sat
      // "moored" at the rig while it was actually still sailing.
      // Rule: while the following rows are transit-coded and carry no
      // location, the vessel is still underway — absorb them. The leg
      // ends at the first row that either confirms presence at the
      // destination (location_id === to, e.g. "ENTER 500 M ZONE AT OD.1")
      // or is a stationary activity (non-transit code).
      // ------------------------------------------------------------------
      if (endKind === 'nextRow' || endKind === 'eod') {
        let found: { t: Date; kind: 'arrival' | 'boundary' } | null = null
        for (let j = i + 1; j < sorted.length; j++) {
          const r2 = sorted[j]
          const t2 = parseTaskTime(reportDate, r2.from_time)
          if (!t2 || t2 <= t0) continue
          const r2loc = r2.location_id || r2.to_location_id || null
          if (codeIsTransit(r2.task_code) && !r2loc) { absorbed.add(j); continue }
          found = { t: t2, kind: r2loc === to ? 'arrival' : 'boundary' }
          break
        }
        if (found) { t1 = found.t; endKind = found.kind }
        else { t1 = parseTaskTime(reportDate, '24:00')!; endKind = 'eod' }
      }

      // Speed sanity net: when the end is still only inferred (no explicit
      // to_time and no arrival confirmation), a missing arrival row can
      // leave the leg absurdly slow (a 30-min hop stretched over hours).
      // Clamp to the vessel's real cruise speed learned from AIS (fallback:
      // spec speed); the gap-filler then moors it at the destination.
      let estimated = false
      if (fromLoc && toLoc && (endKind === 'boundary' || endKind === 'eod')) {
        const dNm = distNm(fromLoc, toLoc)
        const lv = ctx.learnedVessels[vid]
        const vv = ctx.vesselsById[vid]
        const cruise = (lv && lv.cruise_speed_kts) || (vv && vv.speed_kts) || 10
        const durH = (t1.getTime() - t0.getTime()) / 3600000
        if (durH > 0 && dNm / durH < cruise * 0.4) {
          t1 = new Date(t0.getTime() + (dNm / cruise) * 3600000)
          estimated = true
        }
      }

      out.push({
        type: 'transit',
        t0, t1, from, to,
        eta_estimated: estimated,
        purpose: r.description || r.task_label || '',
        raw: r.description || '',
        task_code: r.task_code,
        distance_nm: (fromLoc && toLoc) ? distNm(fromLoc, toLoc) : null,
        polyline: learned ? learned.polyline : null,
        learned_speed_kts: learned ? learned.avg_speed_kts ?? null : null,
      })
      prevKnownLoc = to

      // Aborted-trip repair: a transit A→B immediately followed by B→A where
      // BOTH legs are physically impossible (CA5 11-May: "departure to
      // Shuaiba" 14:25, "return back for cargo" 14:50 — it never reached
      // Shuaiba, it turned around a few miles out). Reinterpret as an
      // out-and-back to the point the vessel could actually reach at its
      // real cruise speed.
      const cur = out[out.length - 1]
      const prev = out[out.length - 2]
      if (prev && prev.type === 'transit' && cur.type === 'transit'
          && prev.to === cur.from && prev.from === cur.to
          && prev.distance_nm && cur.t0.getTime() === prev.t1.getTime()) {
        const lv = ctx.learnedVessels[vid]
        const vv = ctx.vesselsById[vid]
        const cruise = (lv && lv.cruise_speed_kts) || (vv && vv.speed_kts) || 10
        const d1h = (prev.t1.getTime() - prev.t0.getTime()) / 3600000
        const d2h = (cur.t1.getTime() - cur.t0.getTime()) / 3600000
        const tooFast = (h: number) => h > 0 && prev.distance_nm! / h > cruise * 1.6
        if (tooFast(d1h) && tooFast(d2h)) {
          const A = ctx.locsById[prev.from!]
          const B = ctx.locsById[prev.to!]
          if (A && B) {
            const f = Math.min(0.9, (cruise * d1h) / prev.distance_nm!)
            const turn: [number, number] = [A.lat + (B.lat - A.lat) * f, A.lon + (B.lon - A.lon) * f]
            prev.polyline = [[A.lat, A.lon], turn]
            prev.distance_nm! *= f
            prev.turned_back = true
            cur.polyline = [turn, [A.lat, A.lon]]
            cur.distance_nm = prev.distance_nm
            cur.turned_back = true
          }
        }
      }
    } else if (transit && (from === to || !to)) {
      // Transit row but we don't know where it's going. Hold position.
      const loc: string | null = to || from || prevKnownLoc
      if (loc) {
        out.push({
          type: 'moored', t0, t1, loc,
          purpose: r.description || r.task_label || '',
          raw: r.description || '',
          task_code: r.task_code,
        })
        prevKnownLoc = loc
      }
    } else {
      const loc: string | null = ll || prevKnownLoc
      if (loc) {
        out.push({
          type: 'moored', t0, t1, loc,
          purpose: r.description || r.task_label || '',
          raw: r.description || '',
          task_code: r.task_code,
        })
        prevKnownLoc = loc
      }
    }
  }
  return out
}

export function fillGapsWithMoored(segs: Segment[]): Segment[] {
  // Whenever there's a gap between consecutive segments (e.g. the captain
  // explicitly logged a row ending at 06:42 but the next row starts at 07:10),
  // bridge it with a "moored at the last-known location" segment so the map
  // doesn't lose the vessel in between.
  const out: Segment[] = []
  for (const s of segs) {
    const prev = out[out.length - 1]
    if (prev && prev.t1.getTime() < s.t0.getTime()) {
      const endLoc = prev.type === 'transit' ? prev.to : prev.loc
      if (endLoc) {
        out.push({
          type: 'moored',
          t0: prev.t1,
          t1: s.t0,
          loc: endLoc,
          purpose: 'STBY (gap fill)',
          raw: null,
          filler: true,
        })
      }
    }
    out.push(s)
  }
  return out
}

export function mergeRunsOfSameLoc(segs: Segment[]): Segment[] {
  // Merge consecutive moored segments that are at the same location.
  // We retain every underlying sub-event in `sub_events` so the side-panel
  // card can show *only* the activity matching the current sim time.
  // `purpose` is kept as a concatenated fallback for code paths that don't
  // know about sub_events (popups, etc.).
  const out: Segment[] = []
  for (const s of segs) {
    const prev = out[out.length - 1]
    if (prev && prev.type === 'moored' && s.type === 'moored' && prev.loc === s.loc
        && prev.t1.getTime() === s.t0.getTime()) {
      if (!prev.sub_events) {
        prev.sub_events = [{
          t0: prev.t0, t1: prev.t1,
          purpose: prev.purpose ?? null, raw: prev.raw ?? null, filler: prev.filler,
        }]
      }
      prev.sub_events.push({
        t0: s.t0, t1: s.t1,
        purpose: s.purpose ?? null, raw: s.raw ?? null, filler: s.filler,
      })
      prev.t1 = s.t1
      prev.merged_count = (prev.merged_count || 1) + 1
      if (s.purpose && prev.purpose && !prev.purpose.includes(s.purpose)) {
        if ((prev.purpose + '; ' + s.purpose).length < 240) {
          prev.purpose = `${prev.purpose}; ${s.purpose}`
        }
      }
      continue
    }
    out.push({ ...s })
  }
  return out
}

/** Sub-event of a merged moored block active at time `t`. */
export function activeSubEvent(segment: Segment | null, t: Date | number): SubEvent | null {
  if (!segment || segment.type !== 'moored') return null
  const subs = segment.sub_events
  if (!subs || !subs.length) return null
  const tn = t instanceof Date ? t.getTime() : +t
  for (const sub of subs) {
    if (tn >= sub.t0.getTime() && tn < sub.t1.getTime()) return sub
  }
  if (tn < subs[0].t0.getTime()) return subs[0]
  return subs[subs.length - 1]
}

/** Next sub-event strictly after `t` within the same merged block. */
export function nextSubEvent(segment: Segment | null, t: Date | number): SubEvent | null {
  if (!segment || segment.type !== 'moored') return null
  const subs = segment.sub_events
  if (!subs || !subs.length) return null
  const tn = t instanceof Date ? t.getTime() : +t
  for (const sub of subs) {
    if (sub.t0.getTime() > tn) return sub
  }
  return null
}

export interface BuiltTimelines {
  timelines: Timelines
  timelineStart: Date
  timelineEnd: Date
}

export function buildTimelinesFromReports(
  ctx: SimContext,
  reportsByVid: Record<string, DailyReport[]>,
  aisTracksByVid: Record<string, AisTrackPoint[]>,
): BuiltTimelines {
  const tl: Timelines = {}
  for (const vid of Object.keys(ctx.vesselsById)) tl[vid] = []

  for (const vid in reportsByVid) {
    const reports = reportsByVid[vid]
    const segs: Segment[] = []
    for (const rep of reports) {
      segs.push(...rowsToSegments(ctx, rep.report_date, rep.task_log || [], vid))
    }
    segs.sort((a, b) => a.t0.getTime() - b.t0.getTime())
    // Resolve overlaps (duplicate rows, transits crossing midnight logged in
    // both days' reports): the later segment's start wins, earlier one is
    // truncated. Without this positionAt() finds whichever segment sorts
    // first and the vessel can jump back and forth between two positions.
    const clean: Segment[] = []
    for (const s of segs) {
      const prev = clean[clean.length - 1]
      if (prev && prev.t1.getTime() > s.t0.getTime()) {
        if (s.type === 'moored' && prev.type === 'moored' && prev.loc === s.loc
            && s.t1.getTime() <= prev.t1.getTime()) {
          continue // duplicate stay fully inside the previous one
        }
        prev.t1 = s.t0
        if (prev.t1.getTime() <= prev.t0.getTime()) clean.pop()
      }
      clean.push(s)
    }
    tl[vid] = mergeRunsOfSameLoc(fillGapsWithMoored(clean))
  }

  let minT = Infinity
  let maxT = -Infinity
  for (const vid in tl) {
    for (const s of tl[vid]) {
      if (s.t0 && s.t0.getTime() < minT) minT = s.t0.getTime()
      if (s.t1 && s.t1.getTime() > maxT) maxT = s.t1.getTime()
    }
  }
  // Also include AIS keyframes — newly-polled positions may extend past the
  // daily-report timeline. Without this the slider can't reach the polled data.
  for (const vid in aisTracksByVid) {
    for (const p of aisTracksByVid[vid]) {
      const t = p.ts.getTime()
      if (t < minT) minT = t
      if (t > maxT) maxT = t
    }
  }

  let timelineStart: Date
  let timelineEnd: Date
  if (!isFinite(minT) || !isFinite(maxT)) {
    const now = Date.now()
    timelineStart = new Date(now - 24 * 3600 * 1000)
    timelineEnd = new Date(now + 24 * 3600 * 1000)
  } else {
    timelineStart = new Date(minT)
    timelineEnd = new Date(maxT + 6 * 3600 * 1000) // 6 h trailing pad
  }
  return { timelines: tl, timelineStart, timelineEnd }
}

// Binary-search nearest AIS sample for vessel vid at time t. Returns null
// if no AIS data is loaded for this vessel, or the closest sample exceeds
// AIS_MAX_GAP_MS so we don't accept a half-day-old point as "current."
const AIS_MAX_GAP_MS = 30 * 60 * 1000 // 30 minutes

export function nearestAisPoint(
  aisTracksByVid: Record<string, AisTrackPoint[]>, vid: string, t: Date,
): AisTrackPoint | null {
  const track = aisTracksByVid[vid]
  if (!track || track.length === 0) return null
  let lo = 0
  let hi = track.length
  const tn = t.getTime()
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (track[mid].ts.getTime() < tn) lo = mid + 1
    else hi = mid
  }
  const before = lo > 0 ? track[lo - 1] : null
  const after = lo < track.length ? track[lo] : null
  let candidate: AisTrackPoint | null
  if (before && after) {
    candidate = (tn - before.ts.getTime()) <= (after.ts.getTime() - tn) ? before : after
  } else {
    candidate = before || after
  }
  if (!candidate) return null
  return Math.abs(candidate.ts.getTime() - tn) <= AIS_MAX_GAP_MS ? candidate : null
}

export function positionAt(
  ctx: SimContext,
  timelines: Timelines,
  aisTracksByVid: Record<string, AisTrackPoint[]>,
  aisOverlayEnabled: boolean,
  vid: string,
  t: Date,
): VesselPosition | null {
  // When the AIS overlay is on and we have a real sample close to t, use it
  // verbatim and skip the segment interpolation. The "segment" return is the
  // operational state from the daily report — we still show it in the popup,
  // so the user sees both layers (position from AIS, context from captain).
  if (aisOverlayEnabled) {
    const ais = nearestAisPoint(aisTracksByVid, vid, t)
    if (ais) {
      const segs = timelines[vid] || []
      const seg = segs.find(s => s.t0 <= t && t <= s.t1) || null
      return {
        lat: ais.lat,
        lon: ais.lon,
        segment: seg,
        heading: Number.isFinite(ais.cog as number) ? (ais.cog as number) : 0,
        ais: true,
      }
    }
  }
  const segs = timelines[vid]
  if (!segs || segs.length === 0) return null
  if (t < segs[0].t0) {
    const s = segs[0]
    const loc = ctx.locsById[(s.type === 'moored' ? s.loc : s.from)!]
    if (!loc) return null
    return { lat: loc.lat, lon: loc.lon, segment: null, heading: 0, status: 'pre-timeline' }
  }
  if (t > segs[segs.length - 1].t1) {
    const s = segs[segs.length - 1]
    const loc = ctx.locsById[(s.type === 'moored' ? s.loc : s.to)!]
    if (!loc) return null
    return { lat: loc.lat, lon: loc.lon, segment: s, heading: 0, status: 'post-timeline' }
  }
  const seg = segs.find(s => s.t0 <= t && t <= s.t1)
  if (!seg) return null
  if (seg.type === 'moored') {
    const loc = ctx.locsById[seg.loc!]
    if (!loc) return null
    return { lat: loc.lat, lon: loc.lon, segment: seg, heading: 0 }
  }
  const frac = Math.min(1, Math.max(0, (t.getTime() - seg.t0.getTime()) / (seg.t1.getTime() - seg.t0.getTime())))
  // Real-AIS-learned route: walk the polyline (canonical_from →
  // AIS waypoints → canonical_to) at uniform pace through the captain's
  // reported transit time. Endpoints are always the location icon.
  if (Array.isArray(seg.polyline) && seg.polyline.length >= 2) {
    return interpolateAlongPolyline(seg.polyline, frac, seg)
  }
  // Fallback: straight-line from→to.
  const from = ctx.locsById[seg.from!]
  const to = ctx.locsById[seg.to!]
  if (!from || !to) return null
  return {
    lat: from.lat + (to.lat - from.lat) * frac,
    lon: from.lon + (to.lon - from.lon) * frac,
    segment: seg,
    heading: bearingDeg(from, to),
  }
}

// Walk a [[lat,lon], ...] polyline at fraction `frac` of the total path
// length and return the interpolated point + the local heading.
export function interpolateAlongPolyline(
  poly: [number, number][], frac: number, seg: Segment,
): VesselPosition {
  let total = 0
  const segLens: number[] = []
  for (let i = 0; i < poly.length - 1; i++) {
    const a = { lat: poly[i][0], lon: poly[i][1] }
    const b = { lat: poly[i + 1][0], lon: poly[i + 1][1] }
    const d = distNm(a, b)
    segLens.push(d)
    total += d
  }
  if (total === 0) {
    return { lat: poly[0][0], lon: poly[0][1], segment: seg, heading: 0 }
  }
  let target = frac * total
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i] || i === segLens.length - 1) {
      const a = { lat: poly[i][0], lon: poly[i][1] }
      const b = { lat: poly[i + 1][0], lon: poly[i + 1][1] }
      const segFrac = segLens[i] > 0 ? Math.min(1, Math.max(0, target / segLens[i])) : 0
      return {
        lat: a.lat + (b.lat - a.lat) * segFrac,
        lon: a.lon + (b.lon - a.lon) * segFrac,
        segment: seg,
        heading: bearingDeg(a, b),
      }
    }
    target -= segLens[i]
  }
  const last = poly[poly.length - 1]
  return { lat: last[0], lon: last[1], segment: seg, heading: 0 }
}

// Average speed of a transit segment along its actual path (learned polyline
// when we have one, straight-line otherwise).
export function transitSpeedKts(seg: Segment | null): number | null {
  if (!seg || seg.type !== 'transit') return null
  const durH = (seg.t1.getTime() - seg.t0.getTime()) / 3600000
  if (!(durH > 0)) return null
  let dNm = seg.distance_nm ?? null
  if (Array.isArray(seg.polyline) && seg.polyline.length >= 2) {
    dNm = 0
    for (let i = 0; i < seg.polyline.length - 1; i++) {
      dNm += distNm(
        { lat: seg.polyline[i][0], lon: seg.polyline[i][1] },
        { lat: seg.polyline[i + 1][0], lon: seg.polyline[i + 1][1] },
      )
    }
  }
  return dNm ? dNm / durH : null
}

// Points of `poly` from its start up to fraction `frac` of its total length.
export function coveredPolyline(poly: [number, number][], frac: number): [number, number][] {
  let total = 0
  const lens: number[] = []
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distNm(
      { lat: poly[i][0], lon: poly[i][1] },
      { lat: poly[i + 1][0], lon: poly[i + 1][1] },
    )
    lens.push(d)
    total += d
  }
  if (total === 0) return [poly[0]]
  let target = frac * total
  const out: [number, number][] = [poly[0]]
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]) break
    target -= lens[i]
    out.push(poly[i + 1])
  }
  return out
}

function serviceBound(dateStr: string | null | undefined): number | null {
  return dateStr ? Date.parse(`${dateStr}T00:00:00+03:00`) : null
}

export function isVesselActive(v: Vessel, t: Date | number): boolean {
  const ms = t instanceof Date ? t.getTime() : t
  const from = serviceBound(v.active_from)
  const until = serviceBound(v.retired_on)
  if (from != null && ms < from) return false
  if (until != null && ms >= until) return false
  return true
}

/** Next transit segment for a vessel strictly after `t`. */
export function nextTransit(timelines: Timelines, vid: string, t: Date): Segment | null {
  const segs = timelines[vid] || []
  for (const s of segs) {
    if (s.type === 'transit' && s.t0.getTime() > t.getTime()) return s
  }
  return null
}

/**
 * Reposition moored vessels so they don't stack on top of their berth/rig icon.
 *   - At a RIG: vessels park alongside (east face), spaced lengthwise, bow
 *     oriented parallel to the rig — that's how supply boats actually moor.
 *   - At a Shuaiba berth when zoom < 13 the B20/B4 pins are visually merged, so
 *     we group B20+B4 and spread the vessels in a small ring around the merged
 *     pin so Juno (B4) and CA5 (B20) don't stack on each other.
 *   - At other ports/berths with multiple vessels, fall back to a ring spread.
 */
export function applyAntiOverlap(
  ctx: SimContext, positions: Record<string, VesselPosition | null>, zoom: number,
): void {
  const berthsMerged = zoom < 13
  const groupKey = (locId: string) =>
    (berthsMerged && (locId === 'B20' || locId === 'B4')) ? 'SHUAIBA' : locId

  const groups: Record<string, string[]> = {}
  for (const [vid, p] of Object.entries(positions)) {
    if (!p || !p.segment) continue
    if (p.segment.type === 'moored') {
      const key = groupKey(p.segment.loc!)
      groups[key] = groups[key] || []
      groups[key].push(vid)
    }
  }

  const cosLat = Math.cos(29 * Math.PI / 180)
  const mToDegLat = 1 / 111000
  const mToDegLon = 1 / (111000 * cosLat)

  for (const key in groups) {
    const vids = groups[key].sort()
    const n = vids.length
    if (n === 0) continue

    const loc = ctx.locsById[key] || (key === 'SHUAIBA' ? ctx.locsById.B20 : null)
    const isRig = loc && loc.type === 'rig'
    const isBerth = loc && (loc.type === 'berth' || loc.type === 'port' || key === 'SHUAIBA')

    if (isRig) {
      const sideOffsetM = 90
      const spacingM = 35
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) / 2) * spacingM
        positions[vids[i]]!.lon += sideOffsetM * mToDegLon
        positions[vids[i]]!.lat += along * mToDegLat
        positions[vids[i]]!.heading = 0
      }
      continue
    }

    if (isBerth) {
      const sideOffsetM = 55 // east of the berth pin, into the water
      const spacingM = 45    // lateral spacing between vessels (B20 north of B4)
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) / 2) * spacingM
        positions[vids[i]]!.lon += sideOffsetM * mToDegLon
        positions[vids[i]]!.lat += along * mToDegLat
        positions[vids[i]]!.heading = 90 // bow east → horizontal silhouette
      }
      continue
    }

    if (n > 1) {
      const r = 0.0009 // fallback ring spread for any other co-located group
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2
        positions[vids[i]]!.lat += Math.cos(angle) * r
        positions[vids[i]]!.lon += Math.sin(angle) * r / cosLat
      }
    }
  }
}
