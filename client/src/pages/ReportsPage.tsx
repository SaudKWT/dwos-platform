import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, MapPin } from 'lucide-react'
import { useReport, useReportIndex, useVessels } from '@/api/queries'
import type { ReportIndexRow } from '@/api/types'
import { cn } from '@/lib/utils'

// Day-first navigation: with a year of data the flat report list becomes
// thousands of rows, so the sidebar lists DAYS (newest first) and selecting a
// day immediately opens a report — no extra click. Within a day the vessels
// are one-click chips; prev/next arrows and ←/→ keys walk day by day, and the
// date picker jumps anywhere (snapping to the nearest day that has reports).

interface DayGroup {
  date: string
  rows: ReportIndexRow[]
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function weekday(date: string): string {
  return WEEKDAY[new Date(date + 'T00:00:00Z').getUTCDay()]
}

export default function ReportsPage() {
  const index = useReportIndex()
  const vessels = useVessels()

  const days: DayGroup[] = useMemo(() => {
    const byDate = new Map<string, ReportIndexRow[]>()
    for (const r of index.data ?? []) {
      if (!byDate.has(r.report_date)) byDate.set(r.report_date, [])
      byDate.get(r.report_date)!.push(r)
    }
    return [...byDate.entries()]
      .map(([date, rows]) => ({ date, rows: rows.sort((a, b) => a.vessel_id.localeCompare(b.vessel_id)) }))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [index.data])

  const [selectedDate, setSelectedDate] = useState<string>()
  const [selectedVessel, setSelectedVessel] = useState<string>()

  const day = days.find(d => d.date === selectedDate)
  const dayIdx = days.findIndex(d => d.date === selectedDate)

  // Selecting a day opens a report immediately. Keep the same vessel when it
  // reported that day too (so ←/→ pages one vessel through the calendar);
  // otherwise fall back to the day's first report.
  const openDay = (date: string, preferVessel?: string) => {
    const target = days.find(d => d.date === date)
    if (!target) return
    setSelectedDate(date)
    const keep = preferVessel ?? selectedVessel
    setSelectedVessel(target.rows.some(r => r.vessel_id === keep) ? keep : target.rows[0]?.vessel_id)
  }

  // Newest day auto-opens on first load.
  useEffect(() => {
    if (!selectedDate && days.length) openDay(days[0].date)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length])

  // days[] is sorted newest-first, so "previous day" (older) is index + 1.
  const stepDay = (dir: 1 | -1) => {
    const next = days[dayIdx - dir]
    if (next) openDay(next.date)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      if (e.key === 'ArrowLeft') stepDay(-1)
      if (e.key === 'ArrowRight') stepDay(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Date-picker jump: snap to the nearest day that actually has reports.
  const jumpToDate = (date: string) => {
    if (!date || !days.length) return
    let best = days[0].date
    let bestDiff = Infinity
    for (const d of days) {
      const diff = Math.abs(Date.parse(d.date) - Date.parse(date))
      if (diff < bestDiff) { best = d.date; bestDiff = diff }
    }
    openDay(best)
  }

  const report = useReport(selectedVessel, selectedDate)
  const vesselName = (id: string) => (vessels.data ?? []).find(v => v.id === id)?.name ?? id
  const vesselColor = (id: string) => (vessels.data ?? []).find(v => v.id === id)?.color ?? undefined

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <button
            type="button"
            title="Older day (←)"
            onClick={() => stepDay(-1)}
            disabled={dayIdx < 0 || dayIdx >= days.length - 1}
            className="rounded-md border p-1 hover:bg-accent disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="date"
            value={selectedDate ?? ''}
            min={days.length ? days[days.length - 1].date : undefined}
            max={days.length ? days[0].date : undefined}
            onChange={e => jumpToDate(e.target.value)}
            className="min-w-0 flex-1 rounded-md border bg-card px-2 py-1 text-xs"
            title="Jump to a date (snaps to the nearest day with reports)"
          />
          <button
            type="button"
            title="Newer day (→)"
            onClick={() => stepDay(1)}
            disabled={dayIdx <= 0}
            className="rounded-md border p-1 hover:bg-accent disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          {days.length} days · {(index.data ?? []).length} reports
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {days.map(d => {
            const active = d.date === selectedDate
            return (
              <li key={d.date}>
                <button
                  onClick={() => openDay(d.date)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-sm transition-colors',
                    active ? 'bg-secondary' : 'hover:bg-accent',
                  )}
                >
                  <span>
                    <span className="font-mono text-xs">{d.date}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{weekday(d.date)}</span>
                  </span>
                  <span className="flex gap-1">
                    {d.rows.map(r => (
                      <span
                        key={r.vessel_id}
                        className="h-2 w-2 rounded-full"
                        title={vesselName(r.vessel_id)}
                        style={{ background: vesselColor(r.vessel_id) ?? 'var(--muted-foreground)' }}
                      />
                    ))}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {day && (
          <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2.5">
            <span className="text-sm font-medium">
              {day.date} <span className="text-xs font-normal text-muted-foreground">{weekday(day.date)}</span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {day.rows.map(r => {
                const active = r.vessel_id === selectedVessel
                return (
                  <button
                    key={r.vessel_id}
                    onClick={() => setSelectedVessel(r.vessel_id)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      active ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-accent',
                    )}
                    style={active ? { borderColor: vesselColor(r.vessel_id) } : undefined}
                  >
                    {vesselName(r.vessel_id)}
                  </button>
                )
              })}
            </div>
            <Link
              to={`/map?t=${day.date}T12:00`}
              className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Open the simulator at noon on this day"
            >
              <MapPin className="h-3.5 w-3.5" /> View day on map
            </Link>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {!selectedDate && !index.isLoading && (
            <p className="text-sm text-muted-foreground">No reports yet.</p>
          )}

          {selectedDate && report.isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}

          {selectedDate && report.error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
              <p className="font-medium text-destructive">Could not load that report.</p>
              <p className="mt-1 text-muted-foreground">{String(report.error)}</p>
            </div>
          )}

          {report.data && (
            <div className="space-y-5">
              <header>
                <h1 className="text-lg font-semibold">
                  {vesselName(report.data.vessel_id)}
                  <span className="ml-2 font-mono text-sm font-normal text-muted-foreground">
                    {report.data.report_date}
                  </span>
                </h1>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {report.data.voyage_no && <>Voyage {report.data.voyage_no} · </>}
                  {report.data.compiled_by?.name ?? 'unknown master'}
                </p>
              </header>

              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">From</th>
                      <th className="px-3 py-2 text-left font-medium">To</th>
                      <th className="px-3 py-2 text-left font-medium">Activity</th>
                      <th className="px-3 py-2 text-left font-medium">Where</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.data.task_log ?? []).map((t, i) => (
                      <tr key={i} className="border-t align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{t.from_time}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{t.to_time}</td>
                        <td className="px-3 py-2">
                          <div>{t.task_label ?? t.task_code ?? '—'}</div>
                          {t.description && (
                            <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                          {t.location_id ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
