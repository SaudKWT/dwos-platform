/**
 * The vessel data, read from a bundled snapshot of the DWOS database.
 *
 * WHY A SNAPSHOT
 * --------------
 * The live data lives in SQL Server (`dbo.Vessel`, `dbo.VesselDailyReport`,
 * `dbo.MovementPlan`, `dbo.AisPosition` — schema0726 plus the marine tables).
 * This dashboard has no database connection, so it ships a point-in-time export:
 * 5 vessels, 256 daily reports, 9 movement plans, 20 AIS day-tracks.
 *
 * The interface below is deliberately the one the real API already serves —
 * same paths, same shapes, same snake_case field names, all of which come from
 * the source PDFs and are preserved end to end. Swapping the snapshot for the
 * live API is replacing the bodies of these functions with `fetch`, and nothing
 * that calls them changes.
 *
 * The daily reports are 2.4 MB across 256 files, so they are lazy `import()`s
 * rather than a single eager bundle: the index is cheap and a report is fetched
 * when someone opens it.
 */

import type {
  AisPosition, AisTrackRow, DailyReport, LocationsResponse,
  PlanIndexRow, ReportIndexRow, Vessel,
} from './types'

import vesselsJson from '../data/vessels.json'
import locationsJson from '../data/locations.json'

const reportModules = import.meta.glob('../data/daily-reports/*.json') as Record<
  string, () => Promise<{ default: DailyReport }>
>
const planModules = import.meta.glob('../data/movement-plans/*.json') as Record<
  string, () => Promise<{ default: Record<string, unknown> }>
>
const aisModules = import.meta.glob('../data/ais-history/*.json') as Record<
  string, () => Promise<{ default: { vessel_id: string; positions: AisPosition[] } }>
>

/** `../data/daily-reports/CA3-2026-05-06.json` -> `CA3-2026-05-06`. */
const stem = (path: string): string => path.split('/').pop()!.replace(/\.json$/, '')

/** The index files are shipped alongside the records; they are not records. */
const isIndex = (path: string): boolean => stem(path) === 'index'

async function load<T>(
  modules: Record<string, () => Promise<{ default: T }>>,
  path: string,
  what: string,
): Promise<T> {
  const loader = modules[path]
  if (!loader) throw new Error(`${what} is not in the bundled snapshot`)
  return (await loader()).default
}

// ---------------------------------------------------------------------------
// Indexes
//
// The real API builds these server-side. Here they are derived from the
// filenames plus a cheap read of each record, memoised so the cost is paid once
// per session rather than per screen.
// ---------------------------------------------------------------------------

let reportIndexCache: Promise<ReportIndexRow[]> | null = null

function buildReportIndex(): Promise<ReportIndexRow[]> {
  reportIndexCache ??= Promise.all(
    Object.entries(reportModules)
      .filter(([p]) => !isIndex(p))
      .map(async ([path, loader]) => {
        const r = (await loader()).default
        return {
          vessel_id: r.vessel_id,
          report_date: r.report_date,
          file: `daily-reports/${stem(path)}.json`,
          task_log_rows: Array.isArray(r.task_log) ? r.task_log.length : 0,
          source_type: (r.source as { type?: string } | undefined)?.type ?? null,
        }
      }),
  ).then(rows => rows.sort((a, b) =>
    b.report_date.localeCompare(a.report_date) || a.vessel_id.localeCompare(b.vessel_id),
  ))
  return reportIndexCache
}

let planIndexCache: Promise<PlanIndexRow[]> | null = null

function buildPlanIndex(): Promise<PlanIndexRow[]> {
  planIndexCache ??= Promise.all(
    Object.entries(planModules)
      .filter(([p]) => !isIndex(p))
      .map(async ([path, loader]) => {
        const p = (await loader()).default as Record<string, unknown>
        const vessels = (p.vessels as { vessel_id: string }[] | undefined) ?? []
        return {
          plan_date: String(p.plan_date ?? stem(path)),
          issued_date: (p.issued_date as string) ?? null,
          issued_by: (p.issued_by as string) ?? null,
          subject: (p.subject as string) ?? null,
          vessels: vessels.map(v => v.vessel_id),
          source_type: (p.source as { type?: string } | undefined)?.type ?? null,
          file: `movement-plans/${stem(path)}.json`,
        }
      }),
  ).then(rows => rows.sort((a, b) => b.plan_date.localeCompare(a.plan_date)))
  return planIndexCache
}

// ---------------------------------------------------------------------------
// Writes
//
// The snapshot is read-only. Submissions are held in memory for the session so
// the form can be exercised end to end — a saved report reappears in the index
// and in the list, and is gone on reload. `saveReport` returning success while
// nothing persists would be the wrong lie to tell, so the UI is told plainly
// (see `SNAPSHOT_IS_READ_ONLY`) rather than left to discover it.
// ---------------------------------------------------------------------------

export const SNAPSHOT_IS_READ_ONLY = true

const sessionReports = new Map<string, DailyReport>()
const sessionPlans = new Map<string, Record<string, unknown>>()

const reportKey = (vesselId: string, date: string) => `${vesselId}-${date}`

export const api = {
  // vessels.json is hand-maintained: it carries $comment notes and a `defaults`
  // block alongside the fleet, so its inferred literal type will never line up
  // with Vessel. The cast is the boundary between a checked-in file and the
  // typed API, and it is the only one.
  vessels: async (): Promise<Vessel[]> => (vesselsJson as unknown as { vessels: Vessel[] }).vessels,

  locations: async (): Promise<LocationsResponse> => locationsJson as unknown as LocationsResponse,

  reportIndex: async (): Promise<ReportIndexRow[]> => {
    const stored = await buildReportIndex()
    if (!sessionReports.size) return stored
    const overlaid = new Map(stored.map(r => [reportKey(r.vessel_id, r.report_date), r]))
    for (const [key, r] of sessionReports) {
      overlaid.set(key, {
        vessel_id: r.vessel_id,
        report_date: r.report_date,
        file: `session/${key}.json`,
        task_log_rows: r.task_log.length,
        source_type: (r.source as { type?: string } | undefined)?.type ?? 'dashboard_submission',
      })
    }
    return [...overlaid.values()].sort((a, b) =>
      b.report_date.localeCompare(a.report_date) || a.vessel_id.localeCompare(b.vessel_id),
    )
  },

  report: async (vesselId: string, date: string): Promise<DailyReport> => {
    const held = sessionReports.get(reportKey(vesselId, date))
    if (held) return held
    return load(reportModules, `../data/daily-reports/${vesselId}-${date}.json`, `${vesselId} ${date}`)
  },

  saveReport: async (report: DailyReport) => {
    sessionReports.set(reportKey(report.vessel_id, report.report_date), report)
    return { ok: true, vessel_id: report.vessel_id, report_date: report.report_date }
  },

  planIndex: async (): Promise<PlanIndexRow[]> => buildPlanIndex(),

  plan: async (date: string): Promise<Record<string, unknown>> => {
    const held = sessionPlans.get(date)
    if (held) return held
    return load(planModules, `../data/movement-plans/${date}.json`, `plan ${date}`)
  },

  savePlan: async (plan: Record<string, unknown>) => {
    const date = String(plan.plan_date)
    sessionPlans.set(date, plan)
    return { ok: true, plan_date: date }
  },

  aisIndex: async (): Promise<AisTrackRow[]> =>
    Object.keys(aisModules)
      .filter(p => !isIndex(p))
      .map(path => {
        const [vessel_id, ...rest] = stem(path).split('-')
        return {
          vessel_id,
          date_utc: rest.join('-'),
          file: `ais-history/${stem(path)}.json`,
          positions: 0,
          provider: 'snapshot',
        }
      })
      .sort((a, b) => b.date_utc.localeCompare(a.date_utc)),

  aisDay: async (vesselId: string, dateUtc: string) =>
    load(aisModules, `../data/ais-history/${vesselId}-${dateUtc}.json`, `AIS ${vesselId} ${dateUtc}`),
}

export type { ImportResult } from './types'
