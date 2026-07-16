// Shapes returned by the ASP.NET Core API.
//
// These mirror the JSON the file-backed Node server served, because the API
// deliberately kept those shapes: snake_case field names come from the source
// PDFs and emails, and are preserved end-to-end rather than renamed at a
// boundary where the two vocabularies would have to be kept in sync by hand.

export interface Vessel {
  id: string                     // JUNO, CH3, CA1, CA3, CA5
  name: string
  type: string | null
  length_m: number | null
  beam_m: number | null
  speed_kts: number | null
  home_berth: string | null
  mmsi: string | null
  color: string | null
  stroke: string | null
  active_from: string | null     // first day on the map
  retired_on: string | null      // null = still in service
  replaced_vessel: string | null
  specs_provisional: boolean
}

export interface MarineLocation {
  id: string                     // B4, B20, NP, OPH, OD
  name: string
  short: string | null
  lat: number
  lon: number
  type: 'berth' | 'port' | 'rig' | 'anchorage' | 'waypoint'
  berth_use: string | null
}

export interface LocationsResponse {
  locations: MarineLocation[]
  /**
   * Alias text -> location id. A value of `__vessel_home_berth__` means the
   * alias is ambiguous ("Shuaiba Port" is berth 4 for the crew boats and berth
   * 20 for the PSVs) and must be resolved against the vessel.
   */
  aliases: Record<string, string>
}

export interface ReportIndexRow {
  vessel_id: string
  report_date: string            // YYYY-MM-DD, Kuwait local
  file: string
  task_log_rows: number
  source_type: string | null
}

// All members optional: imported reports carry every field, but a form
// submission only writes the ones the captain filled in — exactly like the
// original admin.js payloads.
export interface ReportTask {
  from_time?: string | null      // '00:00'
  to_time?: string | null        // '24:00' is valid, so these stay strings
  duration_min?: number | null
  task_code?: string | null
  task_label?: string | null
  description?: string | null
  location_id?: string | null
  from_location_id?: string | null
  to_location_id?: string | null
}

export interface DailyReport {
  vessel_id: string
  report_date: string
  period_end?: string
  voyage_no?: string | null
  task_log: ReportTask[]
  compiled_by?: { name?: string; role?: string; submitted_at?: string }
  safety?: { accidents?: string; incidents?: string; near_miss?: string }
  source?: Record<string, unknown>
  [key: string]: unknown         // vessel-specific extras are carried through
}

export interface PlanIndexRow {
  plan_date: string
  issued_date: string | null
  issued_by: string | null
  subject: string | null
  vessels: string[]
  source_type: string | null
  file: string
}

export interface AisTrackRow {
  vessel_id: string
  date_utc: string               // UTC, unlike report dates
  file: string
  positions: number
  provider: string
}

export interface AisPosition {
  ts: string                     // UTC ISO
  lat: number
  lon: number
  sog: number | null
  cog: number | null
  heading: number | null
  nav_status: string | null
}
