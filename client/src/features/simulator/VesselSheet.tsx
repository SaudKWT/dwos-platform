// Vessel detail sheet — full-page big-font view of one vessel's day, ported
// from the original app.js openVesselSheet(). Opens when the user clicks any
// side-panel vessel card (playback pauses first); closes on ✕, on
// click-outside-content, or on Escape.

import { useEffect, useMemo, useRef } from 'react'
import type { DailyReport, Vessel } from '@/api/types'
import type { SimContext } from './engine'
import { monotonicizeRows } from './engine'
import { STANDBY_LABEL, timeByLocation, tidyText } from './activity'
import { fmtDur } from './geo'
import { cn } from '@/lib/utils'

const TZ_OFFSET_MIN = 180 // Kuwait, UTC+3

// Pick the captain's report that brackets the simulator's current time.
// Falls back to the most recent report we have for that vessel.
function reportForTime(reports: DailyReport[], cur: Date): DailyReport | null {
  if (!reports.length) return null
  const isoDay = new Date(cur.getTime() + TZ_OFFSET_MIN * 60 * 1000).toISOString().slice(0, 10)
  const hit = reports.find(r => r.report_date === isoDay)
  if (hit) return hit
  // closest by date
  let best = reports[0]
  let bestDiff = Math.abs(Date.parse(best.report_date + 'T00:00:00Z') - cur.getTime())
  for (const r of reports) {
    const diff = Math.abs(Date.parse(r.report_date + 'T00:00:00Z') - cur.getTime())
    if (diff < bestDiff) { best = r; bestDiff = diff }
  }
  return best
}

export default function VesselSheet({ vessel: v, ctx, reports, t, onClose }: {
  vessel: Vessel
  ctx: SimContext
  reports: DailyReport[]
  t: Date
  onClose: () => void
}) {
  const rep = useMemo(() => reportForTime(reports, t), [reports, t])
  const learnedV = ctx.learnedVessels[v.id]
  const sb = useMemo(() => timeByLocation(ctx, reports), [ctx, reports])

  // cruise_speed_kts is only present once we've learned a speed from the
  // reports; with no learned speed the engine falls back to v.speed_kts, which
  // the "kt spec" figure beside this already shows — so drop the badge instead.
  const learnedCruise = typeof learnedV?.cruise_speed_kts === 'number' ? learnedV.cruise_speed_kts : null

  const cons = (rep?.consumables ?? {}) as Record<string, Record<string, unknown>>
  const fuel = cons.fuel_oil ?? {}
  const water = cons.fresh_water ?? {}
  const compiled = rep?.compiled_by ?? {}

  // Figure out which task-log row is "happening right now" relative to the
  // simulator's clock.  Rule: the row with the LATEST from_time on this
  // report_date that's still <= the current sim time.  Only highlight if the
  // sim clock actually falls on this report's day (otherwise the user is
  // looking at a different day's report and nothing should glow).  Use the
  // SAME monotonic-clamped from_time view that rowsToSegments does, so the
  // highlighted "NOW" row matches the actual rendered motion even when the
  // captain typo'd a from_time (see monotonicizeRows).
  const taskLogRaw = Array.isArray(rep?.task_log) ? rep!.task_log : []
  const taskLogView = useMemo(() => monotonicizeRows(taskLogRaw), [taskLogRaw])
  let activeIdx = -1
  if (taskLogView.length && rep) {
    const cur = new Date(t.getTime() + TZ_OFFSET_MIN * 60 * 1000)
    const curIsoDay = cur.toISOString().slice(0, 10)
    if (curIsoDay === rep.report_date) {
      const curMin = cur.getUTCHours() * 60 + cur.getUTCMinutes()
      let bestMin = -1
      taskLogView.forEach((r, i) => {
        const m = /^(\d{2}):(\d{2})$/.exec(r.from_time || '')
        if (!m) return
        const rowMin = +m[1] * 60 + +m[2]
        if (rowMin <= curMin && rowMin >= bestMin) {
          bestMin = rowMin
          activeIdx = i
        }
      })
    }
  }

  // Close on Escape; focus the close button for keyboard users; scroll the
  // "NOW" row into view — saves a click for the common case where the user
  // wants to see what's happening right now in a long task log.
  const closeRef = useRef<HTMLButtonElement>(null)
  const activeRowRef = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    activeRowRef.current?.scrollIntoView({ block: 'center' })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const str = (x: unknown) => (x === null || x === undefined || x === '' ? '—' : String(x))

  return (
    <div className="fixed inset-0 z-[1200]" role="dialog" aria-modal="true" aria-label={`${v.name} daily activities`}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className="absolute inset-x-0 top-4 bottom-0 mx-auto flex max-w-4xl flex-col overflow-hidden rounded-t-xl border bg-background shadow-2xl"
        style={{ borderTopColor: v.color ?? undefined, borderTopWidth: 3 }}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">{v.name}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {v.type} · {v.length_m}×{v.beam_m} m · {v.speed_kts} kt spec
              {learnedCruise !== null && <> · <b className="text-foreground">{learnedCruise.toFixed(1)} kt real</b></>}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {rep
                ? <>Report for <b className="text-foreground">{rep.report_date}</b>{rep.voyage_no ? <> · Voyage {rep.voyage_no}</> : null}</>
                : 'No daily report available for this vessel yet.'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md border px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {!rep && (
            <p className="text-sm text-muted-foreground">
              No captain's daily report on file for this vessel near the simulator's
              current time. Submit one via the <a href="/forms" className="underline">Forms tab</a>.
            </p>
          )}

          {rep && (
            <>
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Fuel ROB" value={str(fuel.rob)} />
                <Stat label="Fuel consumed (24h)" value={str(fuel.consumed)} />
                <Stat label="Water ROB" value={str(water.rob)} />
                <Stat label="Water consumed (24h)" value={str(water.consumed)} />
              </section>

              {sb.rows.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold">
                    Time spent by location{' '}
                    <span className="font-normal text-muted-foreground">
                      all {sb.reportCount} report{sb.reportCount === 1 ? '' : 's'} · total {fmtDur(sb.total)}
                    </span>
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The big number is the <b>real time at that location</b>. The lines under it
                    show what the vessel was doing — <i>idle</i> counts only the hours with no
                    work logged. Some jobs run at the same time (a hose connected while cargo
                    is worked), so the lines can add up to more than the stay.
                  </p>
                  <div className="mt-2 overflow-hidden rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="bg-secondary/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Location</th>
                          <th className="px-3 py-2 text-left font-medium">Type</th>
                          <th className="px-3 py-2 text-right font-medium">Time</th>
                          <th className="w-2/5 px-3 py-2 text-left font-medium">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sb.rows.map(r => {
                          const pct = sb.total ? Math.round(r.stayMinutes / sb.total * 100) : 0
                          // Sub-item bars are sized against the real stay, so a line that
                          // fills the block means the vessel was doing that job for most of
                          // its time here — and parallel jobs can each fill a lot of it.
                          const denom = r.stayMinutes || 1
                          return [
                            <tr key={r.id} className="border-t">
                              <td className="px-3 py-2 font-medium">{r.name}</td>
                              <td className="px-3 py-2">
                                <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] uppercase text-muted-foreground">{r.type}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-right">
                                <b>{r.stayMinutes ? fmtDur(r.stayMinutes) : '—'}</b>
                                <span className="ml-1 text-[10px] text-muted-foreground">total</span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <div className="h-2 flex-1 overflow-hidden rounded bg-secondary">
                                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span className="w-8 text-right text-xs text-muted-foreground">{pct}%</span>
                                </div>
                              </td>
                            </tr>,
                            ...r.activities.map(a => {
                              const w = Math.min(100, Math.round(a.minutes / denom * 100))
                              const idle = a.label === STANDBY_LABEL
                              return (
                                <tr key={`${r.id}-${a.label}`} className="text-xs text-muted-foreground">
                                  <td className={cn('py-1 pl-7 pr-3', idle && 'italic')}>{a.label}</td>
                                  <td />
                                  <td className="whitespace-nowrap px-3 py-1 text-right">{fmtDur(a.minutes)}</td>
                                  <td className="px-3 py-1">
                                    <div className="mr-10 h-1.5 overflow-hidden rounded bg-secondary">
                                      <div
                                        className={cn('h-full', idle ? 'bg-muted-foreground/40' : 'bg-primary/50')}
                                        style={{ width: `${w}%` }}
                                      />
                                    </div>
                                  </td>
                                </tr>
                              )
                            }),
                            ...(r.hasOverlap
                              ? [
                                  <tr key={`${r.id}-note`} className="text-[10px] text-muted-foreground/70">
                                    <td className="pb-1.5 pl-7 pr-3 italic" colSpan={4}>
                                      Some of these jobs ran at the same time, so they add up to
                                      more than {fmtDur(r.stayMinutes)}.
                                    </td>
                                  </tr>,
                                ]
                              : []),
                          ]
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section>
                <h2 className="text-sm font-semibold">
                  Operational task log{' '}
                  <span className="font-normal text-muted-foreground">({taskLogRaw.length} entries)</span>
                </h2>
                <div className="mt-2 overflow-hidden rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">From</th>
                        <th className="px-3 py-2 text-left font-medium">To</th>
                        <th className="px-3 py-2 text-left font-medium">Code</th>
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-left font-medium">Where</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskLogView.length === 0 && (
                        <tr><td colSpan={5} className="px-3 py-3 text-center text-muted-foreground">No task-log entries.</td></tr>
                      )}
                      {taskLogView.map((r, i) => {
                        // Display the original from_time alongside as a hint when the
                        // value was corrected, so the user can spot the captain's typo.
                        const orig = taskLogRaw[i]?.from_time
                        const fixed = !!orig && orig !== r.from_time
                        const active = i === activeIdx
                        return (
                          <tr
                            key={i}
                            ref={active ? activeRowRef : undefined}
                            className={cn('border-t align-top', active && 'bg-primary/10')}
                          >
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                              {r.from_time}
                              {fixed && (
                                <span
                                  className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] text-amber-500"
                                  title={`captain wrote ${orig} — adjusted to keep the timeline monotonic`}
                                >
                                  ~{orig}
                                </span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.to_time || '—'}</td>
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.task_code || ''}</td>
                            <td className="px-3 py-2">
                              {r.description || ''}
                              {active && (
                                <span className="ml-1.5 rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary-foreground">
                                  Now
                                </span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{r.location_id || ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {typeof rep.requirements_next_port_call === 'string' && rep.requirements_next_port_call && (
                <section>
                  <h2 className="text-sm font-semibold">Requirements next port call</h2>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                    {tidyText(rep.requirements_next_port_call)}
                  </p>
                </section>
              )}

              {compiled.name && (
                <footer className="border-t pt-3 text-xs text-muted-foreground">
                  Compiled by {compiled.name} · {compiled.role || 'Master'}
                </footer>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold" title={value}>{value}</div>
    </div>
  )
}
