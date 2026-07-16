import { useMemo, useState } from 'react'
import { useReport, useReportIndex, useVessels } from '@/api/queries'
import { cn } from '@/lib/utils'

export default function ReportsPage() {
  const index = useReportIndex()
  const vessels = useVessels()
  const [selected, setSelected] = useState<{ vessel: string; date: string }>()

  const report = useReport(selected?.vessel, selected?.date)

  const rows = useMemo(
    () => [...(index.data ?? [])].sort((a, b) =>
      b.report_date.localeCompare(a.report_date) || a.vessel_id.localeCompare(b.vessel_id)),
    [index.data],
  )

  const vesselName = (id: string) =>
    (vessels.data ?? []).find(v => v.id === id)?.name ?? id

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r">
        <div className="border-b px-4 py-2.5 text-xs text-muted-foreground">
          {rows.length} reports
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {rows.map(r => {
            const active = selected?.vessel === r.vessel_id && selected?.date === r.report_date
            return (
              <li key={`${r.vessel_id}-${r.report_date}`}>
                <button
                  onClick={() => setSelected({ vessel: r.vessel_id, date: r.report_date })}
                  className={cn(
                    'w-full border-b px-4 py-2 text-left text-sm transition-colors',
                    active ? 'bg-secondary' : 'hover:bg-accent',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{vesselName(r.vessel_id)}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {r.report_date}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {r.task_log_rows} task rows · {r.source_type ?? 'unknown source'}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto p-6">
        {!selected && (
          <p className="text-sm text-muted-foreground">Select a report to view its task log.</p>
        )}

        {selected && report.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {selected && report.error && (
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
      </section>
    </div>
  )
}
