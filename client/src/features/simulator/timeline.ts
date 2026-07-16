import type { DailyReport, MarineLocation, Vessel } from '@/api/types'

// Pure timeline logic: no React, no Leaflet, no DOM.
//
// This is the part of the old app.js worth porting carefully — it decides where
// a vessel actually was at a given minute. Keeping it free of rendering concerns
// means it can be tested directly and reasoned about without a map on screen.
//
// All times here are Kuwait local (UTC+3), matching the reports.

export const KUWAIT_UTC_OFFSET_MIN = 3 * 60

/** A vessel occupying one place over a time span. */
export interface Segment {
  vesselId: string
  locationId: string
  startMin: number     // minutes from midnight, Kuwait local
  endMin: number
  label: string | null
  description: string | null
}

/** Where a vessel is at one instant. */
export interface Fix {
  vesselId: string
  lat: number
  lon: number
  locationId: string | null
  moving: boolean
  label: string | null
}

/**
 * Parses the 'HH:MM' clock used in the reports into minutes from midnight.
 * '24:00' is a real value in this data (it closes the last row of the day), so
 * this deliberately allows 1440 rather than rejecting it as out of range.
 */
export function parseClock(text: string | null | undefined): number | null {
  if (!text) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

/**
 * Turns a report's task log into the spans of time the vessel spent at a place.
 *
 * Two things about this data drive the shape of this function, and both are easy
 * to get wrong by reading the schema alone:
 *
 * 1. `to_time` is usually absent. A log row records what STARTED at a moment,
 *    not a closed interval, so a row runs until the next row starts (or to the
 *    end of the day). Requiring an explicit to_time drops most of the log —
 *    Allianz Juno's 06-May report has 31 rows and only a handful close
 *    themselves.
 *
 * 2. `location_id` is only on about a third of rows (1,700 of 4,835). A captain
 *    writes the place when it CHANGES; "Cargo ops" at 06:22 happens wherever the
 *    vessel already was. So the last known location carries forward. Skipping
 *    unlocated rows would blink the vessel off the map between entries.
 *
 * Rows before the first located row have nowhere to inherit from and are
 * dropped: there is genuinely no evidence of where the vessel was.
 *
 * NOT YET PORTED from the legacy engine: transit interpolation (drawing a vessel
 * partway along a passage) and its rule for inferring when a passage really
 * ended. Until that lands, a vessel under way is shown at its last confirmed
 * place rather than somewhere invented mid-route.
 */
export function segmentsFromReport(report: DailyReport): Segment[] {
  const rows = (report.task_log ?? [])
    .map(task => ({ task, startMin: parseClock(task.from_time) }))
    .filter((r): r is { task: typeof r.task; startMin: number } => r.startMin !== null)
    .sort((a, b) => a.startMin - b.startMin)

  const out: Segment[] = []
  let lastKnownLocation: string | null = null

  for (let i = 0; i < rows.length; i++) {
    const { task, startMin } = rows[i]

    // An explicit to_time wins; otherwise the row runs until the next one starts.
    const explicitEnd = parseClock(task.to_time)
    const nextStart = i + 1 < rows.length ? rows[i + 1].startMin : 24 * 60
    const endMin = explicitEnd !== null && explicitEnd > startMin ? explicitEnd : nextStart

    if (endMin <= startMin) continue

    const locationId = task.location_id ?? task.to_location_id ?? lastKnownLocation
    if (!locationId) continue
    lastKnownLocation = locationId

    out.push({
      vesselId: report.vessel_id,
      locationId,
      startMin,
      endMin,
      label: task.task_label ?? null,
      description: task.description ?? null,
    })
  }

  return mergeAdjacent(out)
}

/**
 * Collapses consecutive spans at the same place into one.
 * A day at a single berth is 20 log rows and one fact.
 */
function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (prev && prev.locationId === seg.locationId && prev.endMin >= seg.startMin) {
      prev.endMin = Math.max(prev.endMin, seg.endMin)
      continue
    }
    out.push({ ...seg })
  }
  return out
}

/** True when the vessel was in service on the given day. */
export function isVesselActiveOn(vessel: Vessel, date: string): boolean {
  // Charlie 3 replaced Allianz Juno on 2026-05-20. Without this check the map
  // carries Juno's last position forward for ever and draws both boats at berth
  // 4 at once — two vessels where there is one.
  if (vessel.active_from && date < vessel.active_from) return false
  if (vessel.retired_on && date >= vessel.retired_on) return false
  return true
}

/**
 * Resolves a task's location to coordinates.
 *
 * `aliases` may map text to `__vessel_home_berth__`, meaning the source named a
 * place that is only unambiguous per vessel ("Shuaiba Port" is berth 4 for the
 * crew boats, berth 20 for the PSVs). The vessel's own home berth settles it.
 */
export function resolveLocation(
  locationId: string,
  vessel: Vessel | undefined,
  locations: Map<string, MarineLocation>,
  aliases: Record<string, string> = {},
): MarineLocation | null {
  const direct = locations.get(locationId)
  if (direct) return direct

  const aliased = aliases[locationId]
  if (aliased === '__vessel_home_berth__') {
    return vessel?.home_berth ? locations.get(vessel.home_berth) ?? null : null
  }
  return aliased ? locations.get(aliased) ?? null : null
}

/**
 * Where each vessel was at `minuteOfDay`, from that day's reports.
 *
 * A vessel with no covering segment is left out entirely rather than shown at a
 * stale position — an absent boat is honest, a wrong one is not.
 */
export function fixesAt(
  minuteOfDay: number,
  reports: DailyReport[],
  vessels: Map<string, Vessel>,
  locations: Map<string, MarineLocation>,
  aliases: Record<string, string> = {},
): Fix[] {
  const out: Fix[] = []

  for (const report of reports) {
    const vessel = vessels.get(report.vessel_id)
    if (vessel && !isVesselActiveOn(vessel, report.report_date)) continue

    const segments = segmentsFromReport(report)
    const seg = segments.find(s => minuteOfDay >= s.startMin && minuteOfDay < s.endMin)
    if (!seg) continue

    const loc = resolveLocation(seg.locationId, vessel, locations, aliases)
    if (!loc) continue

    out.push({
      vesselId: report.vessel_id,
      lat: loc.lat,
      lon: loc.lon,
      locationId: loc.id,
      moving: false,
      label: seg.label,
    })
  }
  return out
}

/** Minutes-from-midnight formatted back to the clock the reports use. */
export function formatClock(minuteOfDay: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minuteOfDay)))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
