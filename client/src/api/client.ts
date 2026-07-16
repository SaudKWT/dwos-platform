import type {
  AisPosition, AisTrackRow, DailyReport, LocationsResponse,
  PlanIndexRow, ReportIndexRow, Vessel,
} from './types'

// Relative URLs throughout: Vite proxies /api to the backend in dev, and in
// production the API serves this app itself. Nothing needs a base URL or an
// environment switch.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    // Surface the API's own message ({ error: "..." }) when it sent one.
    const body = await res.text()
    let message = `${res.status} ${res.statusText}`
    try {
      const parsed = JSON.parse(body)
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
      const parsed = JSON.parse(text)
      if (parsed?.error) message = parsed.error
    } catch { /* keep status line */ }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => get<{ ok: boolean; database: boolean; vessels: number; reports: number }>('/api/health'),

  vessels: () => get<{ vessels: Vessel[] }>('/api/vessels').then(r => r.vessels),
  locations: () => get<LocationsResponse>('/api/locations'),

  reportIndex: () => get<{ reports: ReportIndexRow[] }>('/api/reports').then(r => r.reports),
  report: (vesselId: string, date: string) => get<DailyReport>(`/api/reports/${vesselId}/${date}`),
  saveReport: (report: DailyReport) =>
    post<{ ok: boolean; vessel_id: string; report_date: string }>('/api/reports', report),

  planIndex: () => get<{ plans: PlanIndexRow[] }>('/api/movement-plans').then(r => r.plans),
  plan: (date: string) => get<Record<string, unknown>>(`/api/movement-plans/${date}`),

  aisIndex: () => get<{ tracks: AisTrackRow[] }>('/api/ais-history').then(r => r.tracks),
  aisDay: (vesselId: string, dateUtc: string) =>
    get<{ vessel_id: string; positions: AisPosition[] }>(`/api/ais-history/${vesselId}/${dateUtc}`),
}
