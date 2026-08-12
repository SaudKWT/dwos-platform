/**
 * The vessel data, read from the DWOS API.
 *
 * This file used to serve a bundled JSON snapshot, and its header promised that
 * swapping it for the live API would be "replacing the bodies of these functions
 * with fetch, and nothing that calls them changes". That turned out to be true —
 * every call site is untouched, because the snapshot was deliberately built to
 * the shapes the API already served.
 *
 * WHERE THE DATA COMES FROM NOW
 * -----------------------------
 * `server/` (ASP.NET Core) over SQL Server: dbo.Vessel, dbo.VesselDailyReport,
 * dbo.MovementPlan, dbo.AisPosition — 001-schema0726 plus the marine tables.
 * Relative URLs throughout: Vite proxies /api to the API in development, and in
 * production the API serves this app itself, so nothing needs a base URL or an
 * environment switch.
 *
 * NO FALLBACK TO THE OLD SNAPSHOT, DELIBERATELY
 * ---------------------------------------------
 * It would be easy to catch a failed fetch and serve the bundled files instead,
 * and it would be the wrong thing. A dashboard that silently shows three-month-
 * old figures when the database is unreachable is worse than one that says the
 * database is unreachable — an operations screen is trusted precisely because it
 * fails visibly. Errors propagate; React Query surfaces them.
 *
 * snake_case field names are preserved end to end. They come from the source
 * PDFs, the importer writes them, the API serves them and the UI reads them;
 * renaming at any one boundary would mean keeping two vocabularies in sync by
 * hand for no gain.
 */

import type {
  AisPosition, AisTrackRow, DailyReport, LocationsResponse,
  PlanIndexRow, ReportIndexRow, Vessel,
} from './types'

/**
 * Writes reach a real database now. The form no longer has to explain that a
 * submission evaporates on reload — kept as an export because the UI reads it,
 * and because a future read-only deployment (a published viewer, say) can flip
 * it back without touching the components.
 */
export const SNAPSHOT_IS_READ_ONLY = false

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    // Surface the API's own message ({ "error": "..." }) when it sent one; a
    // bare "500 Internal Server Error" tells the person on the bridge nothing.
    const body = await res.text()
    let message = `${res.status} ${res.statusText}`
    try {
      const parsed = JSON.parse(body) as { error?: string }
      if (parsed?.error) message = parsed.error
    } catch { /* not JSON — keep the status line */ }
    throw new Error(`${path}: ${message}`)
  }
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    let message = `${res.status} ${res.statusText}`
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed?.error) message = parsed.error
    } catch { /* keep the status line */ }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () =>
    get<{ ok: boolean; database: boolean; vessels: number; reports: number }>('/api/health'),

  vessels: () => get<{ vessels: Vessel[] }>('/api/vessels').then(r => r.vessels),

  locations: () => get<LocationsResponse>('/api/locations'),

  // The indexes are built server-side now. The snapshot had to derive them by
  // reading every record, memoised to pay the cost once a session; the API
  // projects them out of relational columns instead, so the memoisation is gone
  // rather than moved — React Query already caches at the call site.
  reportIndex: () => get<{ reports: ReportIndexRow[] }>('/api/reports').then(r => r.reports),

  report: (vesselId: string, date: string) =>
    get<DailyReport>(`/api/reports/${vesselId}/${date}`),

  saveReport: (report: DailyReport) =>
    post<{ ok: boolean; vessel_id: string; report_date: string }>('/api/reports', report),

  planIndex: () => get<{ plans: PlanIndexRow[] }>('/api/movement-plans').then(r => r.plans),

  plan: (date: string) => get<Record<string, unknown>>(`/api/movement-plans/${date}`),

  savePlan: (plan: Record<string, unknown>) =>
    post<{ ok: boolean; plan_date: string }>('/api/movement-plans', plan),

  aisIndex: () => get<{ tracks: AisTrackRow[] }>('/api/ais-history').then(r => r.tracks),

  aisDay: (vesselId: string, dateUtc: string) =>
    get<{ vessel_id: string; positions: AisPosition[] }>(`/api/ais-history/${vesselId}/${dateUtc}`),
}

export type { ImportResult } from './types'
