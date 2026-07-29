import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileDown, Plus, Trash2, Upload } from 'lucide-react'
import { api, type ImportResult } from '@/api/client'
import { useLocations, usePlanIndex, useReportIndex, useVessels } from '@/api/queries'
import { classifyActivity, STANDBY_LABEL } from '@/features/simulator/activity'
import { codeIsStandby, codeIsTransit } from '@/features/simulator/engine'
import {
  CODE_LABELS, LIQUID_KEYS, LIQUID_TITLES, TASK_CODE_OPTIONS,
  computeCoverage, emptyFormState, fmtMin, formStateToPayload, leadingNumber,
  normalizeClock, reportToFormState, rowDurationMin,
  type LiquidKey, type ReportFormState, type TaskRowState,
} from '@/features/report-form/model'
import { openReportPdf } from '@/features/report-form/buildReportHtml'
import type { DailyReport } from '@/api/types'
import { cn } from '@/lib/utils'

// The data-entry side of the app:
//   - captain's Daily Vessel Report (one per vessel per day) + PDF bulk import
//     + print-ready PDF export (the official Halliburton-style template)
//   - supervisor's 48-hr Movement Plan
// Form state <-> payload conversion lives in features/report-form/model.ts so
// the round-trip parity test can drive it without a browser. Payload shapes
// match the PDF importer exactly — the simulator can't tell them apart.

const DRAFT_KEY = 'vm.dvr.draft.v1'

export default function FormsPage() {
  const [tab, setTab] = useState<'report' | 'plan'>('report')
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4">
        <div className="mb-4 flex gap-1 rounded-lg bg-secondary p-1">
          <TabButton active={tab === 'report'} onClick={() => setTab('report')}>
            📋 Daily Vessel Report <span className="font-normal opacity-60">(captain · one per vessel/day)</span>
          </TabButton>
          <TabButton active={tab === 'plan'} onClick={() => setTab('plan')}>
            🗺 Movement Plan <span className="font-normal opacity-60">(supervisor · next 48 hrs)</span>
          </TabButton>
        </div>
        {tab === 'report' ? <ReportForm /> : <PlanForm />}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-card shadow' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Daily Vessel Report
// ---------------------------------------------------------------------------

const FAMILY_TINT: Record<string, string> = {
  standby: 'bg-amber-500/[0.06] border-l-amber-400',
  transit: 'bg-sky-500/[0.06] border-l-sky-400',
  cargo: 'bg-emerald-500/[0.06] border-l-emerald-400',
  other: 'bg-muted/40 border-l-slate-400',
}

const FAMILY_BAR: Record<string, string> = {
  standby: 'bg-amber-400',
  transit: 'bg-sky-500',
  cargo: 'bg-emerald-500',
  other: 'bg-slate-400',
  gap: 'bg-destructive/60',
}

function rowFamily(code: string): string {
  const c = code.toUpperCase()
  if (/^I0\d|^IO\d/.test(c)) return 'transit'
  if (/^(S0\d|SO\d|A01|WOW|D1)/.test(c)) return 'standby'
  if (/^(DP1|L\d|B1)/.test(c)) return 'cargo'
  return 'other'
}

/** Plain-language chip for what the analytics will make of this row. */
function activityChip(t: TaskRowState): string {
  if (codeIsTransit(t.task_code)) return 'Transit'
  if (codeIsStandby(t.task_code, CODE_LABELS[t.task_code] ?? t.raw_label)) return 'Idle / standby'
  const a = classifyActivity(t.task_code, CODE_LABELS[t.task_code] ?? t.raw_label, t.description)
  if (a === STANDBY_LABEL) return 'Idle / standby'
  return a ?? 'Transit'
}

function loadDraft(): ReportFormState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ReportFormState
    return parsed && Array.isArray(parsed.tasks) ? parsed : null
  } catch { return null }
}

function nextDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function ReportForm() {
  const vessels = useVessels()
  const locations = useLocations()
  const reportIndex = useReportIndex()
  const queryClient = useQueryClient()

  const [restored] = useState(() => loadDraft())
  const [f, setF] = useState<ReportFormState>(() => restored ?? emptyFormState())
  const [draftNote, setDraftNote] = useState(Boolean(restored))
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'err' | '' }>({ text: '', tone: '' })
  const [busy, setBusy] = useState(false)

  // Auto-saved draft: a captain filling 25 rows on a moving vessel must never
  // lose work to a closed tab. Cleared on successful submit.
  useEffect(() => {
    const id = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(f)) } catch { /* storage full/blocked — draft is best-effort */ }
    }, 400)
    return () => clearTimeout(id)
  }, [f])

  const patch = (p: Partial<ReportFormState>) => setF(prev => ({ ...prev, ...p }))

  const editTask = (i: number, p: Partial<TaskRowState>) => setF(prev => {
    const tasks = prev.tasks.map((t, j) => (j === i ? { ...t, ...p } : t))
    // Chain: when a row's end time changes, pull the next row's start along if
    // it was empty or still matched the old value.
    if (p.to_time !== undefined && tasks[i + 1]) {
      const old = prev.tasks[i].to_time
      const nxt = tasks[i + 1]
      if (!nxt.from_time || nxt.from_time === old) tasks[i + 1] = { ...nxt, from_time: p.to_time }
    }
    return { ...prev, tasks }
  })

  const locOptions = locations.data?.locations ?? []
  const coverage = useMemo(() => computeCoverage(f.tasks), [f.tasks])

  const warnings = useMemo(() => {
    const out: string[] = []
    if (coverage.gaps.length) {
      const list = coverage.gaps.slice(0, 4).map(g => `${fmtMin(g.start)}–${fmtMin(g.end)}`).join(', ')
      out.push(`The day has unaccounted time: ${list}${coverage.gaps.length > 4 ? '…' : ''}. Captains should log the full 00:00–24:00.`)
    }
    if (coverage.rowsMissingTo.length) {
      out.push(`Row${coverage.rowsMissingTo.length > 1 ? 's' : ''} ${coverage.rowsMissingTo.map(i => i + 1).join(', ')} ha${coverage.rowsMissingTo.length > 1 ? 've' : 's'} no valid end time.`)
    }
    for (const k of LIQUID_KEYS) {
      const l = f.liquids[k]
      const rob = leadingNumber(l.rob)
      const max = leadingNumber(l.max)
      if (rob !== null && max !== null && rob > max) out.push(`${LIQUID_TITLES[k]}: ROB (${l.rob}) is above max capacity (${l.max}).`)
    }
    if (f.reportDate && f.reportDate > new Date().toISOString().slice(0, 10)) {
      out.push('Report date is in the future.')
    }
    return out
  }, [coverage, f.liquids, f.reportDate])

  const vesselName = (id: string) => vessels.data?.find(v => v.id === id)?.name ?? id

  const buildPayload = (): DailyReport | null => {
    if (!f.vesselId || !f.reportDate) { setStatus({ text: 'Vessel and date are required.', tone: 'err' }); return null }
    const payload = formStateToPayload(f)
    if (!payload.task_log.length) { setStatus({ text: 'At least one task row is required.', tone: 'err' }); return null }
    return payload
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload = buildPayload()
    if (!payload) return
    setBusy(true)
    setStatus({ text: 'Saving…', tone: '' })
    try {
      const r = await api.saveReport(payload)
      setStatus({ text: `Saved ${r.vessel_id} · ${r.report_date}. The simulator will pick it up.`, tone: 'ok' })
      localStorage.removeItem(DRAFT_KEY)
      setDraftNote(false)
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      queryClient.invalidateQueries({ queryKey: ['all-reports'] })
    } catch (err) {
      setStatus({ text: `Save failed: ${err instanceof Error ? err.message : err}`, tone: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const printPdf = () => {
    const payload = buildPayload()
    if (!payload) return
    if (!openReportPdf(payload, vesselName(f.vesselId))) {
      setStatus({ text: 'Pop-up blocked — allow pop-ups for this site.', tone: 'err' })
    }
  }

  const discardDraft = () => {
    localStorage.removeItem(DRAFT_KEY)
    setF(emptyFormState())
    setDraftNote(false)
    setStatus({ text: 'Draft discarded.', tone: '' })
  }

  // "Start from the vessel's last report": copy it wholesale, dated the next
  // day — a typical day is edit-three-rows, not type-twenty-five.
  const prefillFromLast = async () => {
    if (!f.vesselId) { setStatus({ text: 'Pick a vessel first.', tone: 'err' }); return }
    const latest = (reportIndex.data ?? [])
      .filter(r => r.vessel_id === f.vesselId)
      .sort((a, b) => b.report_date.localeCompare(a.report_date))[0]
    if (!latest) { setStatus({ text: `No stored reports for ${vesselName(f.vesselId)}.`, tone: 'err' }); return }
    try {
      const rep = await api.report(latest.vessel_id, latest.report_date)
      const state = reportToFormState(rep)
      state.reportDate = nextDay(latest.report_date)
      setF(state)
      setStatus({ text: `Prefilled from ${latest.report_date} — dated ${state.reportDate}. Edit and submit.`, tone: 'ok' })
    } catch (err) {
      setStatus({ text: `Could not load ${latest.report_date}: ${err instanceof Error ? err.message : err}`, tone: 'err' })
    }
  }

  return (
    <div className="space-y-4">
      <PdfImportCard />

      {draftNote && (
        <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span>Unsubmitted draft restored — keep editing or discard it.</span>
          <button type="button" onClick={discardDraft} className="rounded border border-warning/40 px-2 py-0.5 text-xs hover:bg-amber-500/20">
            Discard draft
          </button>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        <Card title="Report header" accent="blue">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Vessel" required>
              <select required value={f.vesselId} onChange={e => patch({ vesselId: e.target.value })} className={inputCls}>
                <option value="">Select…</option>
                {(vessels.data ?? []).filter(v => !v.retired_on).map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Report date" required>
              <input required type="date" value={f.reportDate} onChange={e => patch({ reportDate: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Voyage No">
              <input value={f.voyageNo} onChange={e => patch({ voyageNo: e.target.value })} placeholder="e.g. 041/2026" className={inputCls} />
            </Field>
            <Field label="Security level">
              <input type="number" min={1} max={3} value={f.securityLevel} onChange={e => patch({ securityLevel: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Days since port call">
              <input type="number" min={0} value={f.daysSincePortCall} onChange={e => patch({ daysSincePortCall: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Next crew change">
              <input type="date" value={f.nextCrewChange} onChange={e => patch({ nextCrewChange: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Period end">
              <input value={f.periodEnd} onChange={e => patch({ periodEnd: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <button
            type="button"
            onClick={prefillFromLast}
            className="mt-3 rounded-md border border-primary/40 px-2.5 py-1 text-xs text-primary hover:bg-primary/10"
          >
            ⚡ Start from this vessel's last report
          </button>
        </Card>

        <Card title="Safety (24 hrs)" accent="red">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Accidents"><input value={f.safety.accidents} onChange={e => patch({ safety: { ...f.safety, accidents: e.target.value } })} className={inputCls} /></Field>
            <Field label="Incidents"><input value={f.safety.incidents} onChange={e => patch({ safety: { ...f.safety, incidents: e.target.value } })} className={inputCls} /></Field>
            <Field label="Near miss"><input value={f.safety.near_miss} onChange={e => patch({ safety: { ...f.safety, near_miss: e.target.value } })} className={inputCls} /></Field>
          </div>
        </Card>

        <Card title="Operational task log" required accent="violet"
          subtitle="Hour-by-hour — this is what moves the vessel on the map. Cover the whole day, 00:00 to 24:00.">

          <CoverageBar tasks={f.tasks} />

          <div className="mt-3 space-y-2">
            {f.tasks.map((row, i) => {
              const fam = rowFamily(row.task_code)
              const dur = rowDurationMin(row.from_time, row.to_time)
              const transit = codeIsTransit(row.task_code)
              const codeKnown = Boolean(CODE_LABELS[row.task_code])
              return (
                <div key={i} className={cn('rounded-md border border-l-4 p-2', FAMILY_TINT[fam])}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-5 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                    <input
                      value={row.from_time}
                      onChange={e => editTask(i, { from_time: e.target.value })}
                      onBlur={e => editTask(i, { from_time: normalizeClock(e.target.value) })}
                      placeholder="00:00" inputMode="numeric"
                      className={cn(inputCls, 'w-[4.5rem] text-center font-mono')}
                    />
                    <span className="text-xs text-muted-foreground">→</span>
                    <input
                      value={row.to_time}
                      onChange={e => editTask(i, { to_time: e.target.value })}
                      onBlur={e => editTask(i, { to_time: normalizeClock(e.target.value) })}
                      placeholder="24:00" inputMode="numeric"
                      className={cn(inputCls, 'w-[4.5rem] text-center font-mono')}
                    />
                    <span className="w-12 font-mono text-[11px] text-muted-foreground">
                      {dur !== null ? `${Math.floor(dur / 60)}h${dur % 60 ? String(dur % 60).padStart(2, '0') : ''}` : '—'}
                    </span>
                    <select
                      value={row.task_code}
                      onChange={e => editTask(i, { task_code: e.target.value })}
                      className={cn(inputCls, 'w-56 flex-none')}
                    >
                      {!codeKnown && row.task_code && <option value={row.task_code}>{row.task_code} — (as imported)</option>}
                      {TASK_CODE_OPTIONS.map(([c, label]) => <option key={c} value={c}>{c} — {label}</option>)}
                    </select>
                    {transit ? (
                      <span className="flex items-center gap-1">
                        <select value={row.from_location_id} onChange={e => editTask(i, { from_location_id: e.target.value })} className={cn(inputCls, 'w-32')}>
                          <option value="">From…</option>
                          {locOptions.map(l => <option key={l.id} value={l.id}>{l.short ?? l.name}</option>)}
                        </select>
                        <span className="text-xs text-muted-foreground">→</span>
                        <select value={row.to_location_id} onChange={e => editTask(i, { to_location_id: e.target.value })} className={cn(inputCls, 'w-32')}>
                          <option value="">To…</option>
                          {locOptions.map(l => <option key={l.id} value={l.id}>{l.short ?? l.name}</option>)}
                        </select>
                      </span>
                    ) : (
                      <select value={row.location_id} onChange={e => editTask(i, { location_id: e.target.value })} className={cn(inputCls, 'w-36')}>
                        <option value="">Where? (auto)</option>
                        {locOptions.map(l => <option key={l.id} value={l.id}>{l.short ?? l.name}</option>)}
                      </select>
                    )}
                    <button type="button" title="Remove row" onClick={() => setF(prev => ({ ...prev, tasks: prev.tasks.filter((_, j) => j !== i) }))} className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 pl-7">
                    <input
                      value={row.description}
                      onChange={e => editTask(i, { description: e.target.value })}
                      placeholder="What happened — mention locations (OD-1, OPH, NSBP, Shuaiba…)"
                      className={cn(inputCls, 'flex-1')}
                    />
                    <span className="whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground" title="How the analytics will classify this row">
                      {activityChip(row)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => setF(prev => ({
              ...prev,
              tasks: [...prev.tasks, {
                from_time: prev.tasks[prev.tasks.length - 1]?.to_time || '',
                to_time: '', task_code: 'S01', description: '',
                location_id: prev.tasks[prev.tasks.length - 1]?.location_id || '',
                from_location_id: '', to_location_id: '',
              }],
            }))}
            className="mt-2 flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" /> Add row
          </button>
        </Card>

        <Card title="Consumables" accent="teal" subtitle="Loaded / Discharged are what prove a delivery to the rig happened — fill them whenever a hose was connected.">
          <div className="grid gap-3 sm:grid-cols-2">
            {LIQUID_KEYS.map(k => <LiquidFieldset key={k} k={k} f={f} patch={patch} />)}
          </div>
        </Card>

        <Card title="Deck cargo / lifts" accent="amber">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="On deck"><input value={f.lifts.on_deck} onChange={e => patch({ lifts: { ...f.lifts, on_deck: e.target.value } })} placeholder="1 trash skip, 3 Lamor…" className={inputCls} /></Field>
            <Field label="Loaded"><input value={f.lifts.loaded} onChange={e => patch({ lifts: { ...f.lifts, loaded: e.target.value } })} placeholder="10 Lift" className={inputCls} /></Field>
            <Field label="Discharged"><input value={f.lifts.discharged} onChange={e => patch({ lifts: { ...f.lifts, discharged: e.target.value } })} placeholder="1 Lift" className={inputCls} /></Field>
            <Field label="Deck utilization %"><input type="number" min={0} max={100} value={f.lifts.utilization} onChange={e => patch({ lifts: { ...f.lifts, utilization: e.target.value } })} className={inputCls} /></Field>
          </div>
        </Card>

        <Card title="Provisions & delays" accent="green">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Dry store (days)"><input type="number" min={0} value={f.provisions.dry} onChange={e => patch({ provisions: { ...f.provisions, dry: e.target.value } })} className={inputCls} /></Field>
            <Field label="Fresh & frozen (days)"><input type="number" min={0} value={f.provisions.fresh} onChange={e => patch({ provisions: { ...f.provisions, fresh: e.target.value } })} className={inputCls} /></Field>
            <Field label="Drinking water (days)"><input type="number" min={0} value={f.provisions.water} onChange={e => patch({ provisions: { ...f.provisions, water: e.target.value } })} className={inputCls} /></Field>
            <Field label="Fuel oil unpumpable"><input value={f.provisions.unpumpable} onChange={e => patch({ provisions: { ...f.provisions, unpumpable: e.target.value } })} placeholder="20 M3" className={inputCls} /></Field>
            <Field label="Delay — arrival"><input value={f.delays.arrival} onChange={e => patch({ delays: { ...f.delays, arrival: e.target.value } })} className={inputCls} /></Field>
            <Field label="Delay — departure"><input value={f.delays.departure} onChange={e => patch({ delays: { ...f.delays, departure: e.target.value } })} className={inputCls} /></Field>
          </div>
        </Card>

        <Card title="Crew list" accent="cyan" subtitle="Optional — fills the crew table on page 3 of the printed report.">
          {f.crew.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {f.crew.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <input value={c.first} onChange={e => setF(p => ({ ...p, crew: p.crew.map((x, j) => j === i ? { ...x, first: e.target.value } : x) }))} placeholder="First name" className={cn(inputCls, 'w-28 flex-1')} />
                  <input value={c.last} onChange={e => setF(p => ({ ...p, crew: p.crew.map((x, j) => j === i ? { ...x, last: e.target.value } : x) }))} placeholder="Last name" className={cn(inputCls, 'w-28 flex-1')} />
                  <input value={c.position} onChange={e => setF(p => ({ ...p, crew: p.crew.map((x, j) => j === i ? { ...x, position: e.target.value } : x) }))} placeholder="Position" className={cn(inputCls, 'w-24 flex-1')} />
                  <input value={c.days_onboard} onChange={e => setF(p => ({ ...p, crew: p.crew.map((x, j) => j === i ? { ...x, days_onboard: e.target.value } : x) }))} placeholder="Days" type="number" min={0} className={cn(inputCls, 'w-16')} />
                  <input value={c.sign_on_date} onChange={e => setF(p => ({ ...p, crew: p.crew.map((x, j) => j === i ? { ...x, sign_on_date: e.target.value } : x) }))} placeholder="Sign-on" className={cn(inputCls, 'w-24')} />
                  <input value={c.planned_crew_change} onChange={e => setF(p => ({ ...p, crew: p.crew.map((x, j) => j === i ? { ...x, planned_crew_change: e.target.value } : x) }))} placeholder="Change due" className={cn(inputCls, 'w-24')} />
                  <button type="button" title="Remove crew member" onClick={() => setF(p => ({ ...p, crew: p.crew.filter((_, j) => j !== i) }))} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setF(p => ({ ...p, crew: [...p.crew, { first: '', last: '', position: '', days_onboard: '', sign_on_date: '', planned_crew_change: '' }] }))}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" /> Add crew member
          </button>
        </Card>

        <Card title="Comments & sign-off" accent="slate">
          <Field label="Requirements next port call">
            <textarea rows={2} value={f.requirements} onChange={e => patch({ requirements: e.target.value })} className={inputCls} />
          </Field>
          <div className="mt-3" />
          <Field label="Issues / comments">
            <textarea rows={3} value={f.issuesComments} onChange={e => patch({ issuesComments: e.target.value })} className={inputCls} />
          </Field>
          <div className="mt-3" />
          <Field label="Accident / incident summary">
            <textarea rows={2} value={f.accidentSummary} onChange={e => patch({ accidentSummary: e.target.value })} className={inputCls} />
          </Field>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Master's name">
              <input value={f.compiledName} onChange={e => patch({ compiledName: e.target.value })} placeholder="Capt. …" className={inputCls} />
            </Field>
            <Field label="Role">
              <input value={f.compiledRole} onChange={e => patch({ compiledRole: e.target.value })} className={inputCls} />
            </Field>
          </div>
        </Card>

        {warnings.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            <p className="mb-1 font-medium">Worth checking before you submit — you can still submit as-is:</p>
            <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            Submit report
          </button>
          <button type="button" onClick={printPdf} className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">
            <FileDown className="h-4 w-4" /> Print / PDF
          </button>
          <StatusText status={status} />
        </div>
      </form>
    </div>
  )
}

/** 24-hour strip showing what the task rows account for; gaps glow red. */
function CoverageBar({ tasks }: { tasks: TaskRowState[] }) {
  const cov = useMemo(() => computeCoverage(tasks), [tasks])
  const fullyCovered = cov.coveredMin >= 1440
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border bg-muted/50">
        {cov.segments.map((sg, i) => (
          <div
            key={i}
            title={`${fmtMin(sg.start)}–${fmtMin(sg.end)} ${sg.kind === 'gap' ? '— not accounted for' : ''}`}
            className={cn('h-full', FAMILY_BAR[sg.kind])}
            style={{ width: `${((sg.end - sg.start) / 1440) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex items-center gap-3">
          <LegendDot cls="bg-amber-400" label="Standby" />
          <LegendDot cls="bg-sky-500" label="Transit" />
          <LegendDot cls="bg-emerald-500" label="Cargo" />
          <LegendDot cls="bg-slate-400" label="Other" />
          <LegendDot cls="bg-destructive/60" label="Gap" />
        </span>
        <span className={cn('font-mono', fullyCovered ? 'text-success' : '')}>
          {fullyCovered ? '✓ full day accounted' : `${fmtMin(cov.coveredMin)} / 24:00 accounted`}
        </span>
      </div>
    </div>
  )
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('inline-block h-2 w-2 rounded-full', cls)} />
      {label}
    </span>
  )
}

function LiquidFieldset({ k, f, patch }: {
  k: LiquidKey
  f: ReportFormState
  patch: (p: Partial<ReportFormState>) => void
}) {
  const l = f.liquids[k]
  const set = (p: Partial<typeof l>) => patch({ liquids: { ...f.liquids, [k]: { ...l, ...p } } })
  return (
    <fieldset className="rounded-md border bg-background/40 p-3">
      <legend className="px-1 text-xs font-semibold">{LIQUID_TITLES[k]}</legend>
      <div className="grid grid-cols-3 gap-2">
        <Field label="ROB"><input value={l.rob} onChange={e => set({ rob: e.target.value })} placeholder="417.42 M3" className={inputCls} /></Field>
        <Field label="Consumed"><input value={l.consumed} onChange={e => set({ consumed: e.target.value })} placeholder="1.44 M3" className={inputCls} /></Field>
        <Field label="Max"><input value={l.max} onChange={e => set({ max: e.target.value })} placeholder="950 M3 (80%)" className={inputCls} /></Field>
        <Field label="Loaded"><input value={l.loaded} onChange={e => set({ loaded: e.target.value })} className={inputCls} /></Field>
        <Field label="Discharged"><input value={l.discharged} onChange={e => set({ discharged: e.target.value })} className={inputCls} /></Field>
        <Field label="Rem. to load"><input value={l.remaining} onChange={e => set({ remaining: e.target.value })} className={inputCls} /></Field>
      </div>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// PDF bulk import
// ---------------------------------------------------------------------------

function PdfImportCard() {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ImportResult[]>([])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const handleFiles = useCallback(async (list: FileList | File[]) => {
    const pdfs = [...list].filter(f => /\.pdf$/i.test(f.name))
    if (!pdfs.length) { setError('Drop PDF files only.'); return }
    setBusy(true)
    setError('')
    setResults([])
    try {
      const files = await Promise.all(pdfs.map(async f => ({
        name: f.name,
        data_base64: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))),
      })))
      const r = await api.importPdfs(files)
      setResults(r.results)
      if (r.saved > 0) {
        queryClient.invalidateQueries({ queryKey: ['reports'] })
        queryClient.invalidateQueries({ queryKey: ['all-reports'] })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [queryClient])

  return (
    <Card title="Import daily-report PDFs" subtitle="Drop the captains' PDF reports — parsed and saved automatically" accent="slate">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors',
          dragging ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:border-primary/50',
        )}
      >
        <Upload className="h-5 w-5" />
        {busy ? 'Parsing…' : 'Drop PDFs here, or click to choose'}
        <input
          ref={inputRef} type="file" accept=".pdf" multiple hidden
          onChange={e => e.target.files && handleFiles(e.target.files)}
        />
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {results.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <tbody>
            {results.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="max-w-48 truncate py-1 pr-2">{r.name}</td>
                <td className="py-1 pr-2 font-mono">{r.vessel_id && `${r.vessel_id} · ${r.report_date}`}</td>
                <td className={cn('py-1 pr-2 font-medium',
                  r.status === 'saved' || r.status === 'overwrote' ? 'text-success'
                  : r.status === 'skipped' ? 'text-warning' : 'text-destructive')}>
                  {r.status}{r.rows != null && ` · ${r.rows} rows`}
                </td>
                <td className="py-1 text-muted-foreground">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Movement Plan
// ---------------------------------------------------------------------------

interface PlanVesselEntry {
  vessel_id: string
  current_status: string
  tomorrow_plan: string
  additional: string
}

function PlanForm() {
  const vessels = useVessels()
  const plans = usePlanIndex()
  const queryClient = useQueryClient()

  const [planDate, setPlanDate] = useState('')
  const [issuedBy, setIssuedBy] = useState('')
  const [issuedRole, setIssuedRole] = useState('IODS Operations Supervisor (Offshore Project), HPM')
  const [entries, setEntries] = useState<PlanVesselEntry[] | null>(null)
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'err' | '' }>({ text: '', tone: '' })
  const [busy, setBusy] = useState(false)

  // One card per in-service vessel, like the original supervisor form.
  const activeVessels = (vessels.data ?? []).filter(v => !v.retired_on)
  const current = entries ?? activeVessels.map(v => ({
    vessel_id: v.id, current_status: '', tomorrow_plan: '', additional: '',
  }))

  const loadExisting = async (date: string) => {
    if (!date) return
    try {
      const p = await api.plan(date)
      setPlanDate(String(p.plan_date ?? date))
      setIssuedBy(String(p.issued_by ?? ''))
      setIssuedRole(String(p.issued_role ?? issuedRole))
      const vs = (p.vessels as PlanVesselEntry[] | undefined) ?? []
      setEntries(activeVessels.map(v => {
        const existing = vs.find(x => x.vessel_id === v.id)
        return {
          vessel_id: v.id,
          current_status: existing?.current_status ?? '',
          tomorrow_plan: existing?.tomorrow_plan ?? '',
          additional: existing?.additional ?? '',
        }
      }))
      setStatus({ text: `Loaded plan ${date} for editing.`, tone: 'ok' })
    } catch {
      setStatus({ text: `No plan stored for ${date}.`, tone: 'err' })
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!planDate) { setStatus({ text: 'Plan date is required.', tone: 'err' }); return }
    const filled = current.filter(x => x.current_status || x.tomorrow_plan || x.additional)
    if (!filled.length) { setStatus({ text: 'Fill in at least one vessel.', tone: 'err' }); return }

    const payload = {
      plan_date: planDate,
      issued_date: planDate,
      issued_by: issuedBy,
      issued_role: issuedRole,
      subject: `Vessel Movement Plan for the next 48 Hrs. ${planDate}`,
      vessels: filled,
      source: { type: 'dashboard_submission' },
    }

    setBusy(true)
    setStatus({ text: 'Saving…', tone: '' })
    try {
      const r = await api.savePlan(payload)
      setStatus({ text: `Saved plan for ${r.plan_date}.`, tone: 'ok' })
      queryClient.invalidateQueries({ queryKey: ['plans'] })
    } catch (err) {
      setStatus({ text: `Save failed: ${err instanceof Error ? err.message : err}`, tone: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card title="Plan header" accent="blue">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Plan date" required>
            <input required type="date" value={planDate} onChange={e => setPlanDate(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Issued by">
            <input value={issuedBy} onChange={e => setIssuedBy(e.target.value)} placeholder="Supervisor's name" className={inputCls} />
          </Field>
          <Field label="Load existing">
            <select className={inputCls} defaultValue="" onChange={e => loadExisting(e.target.value)}>
              <option value="">(recent plans…)</option>
              {[...(plans.data ?? [])].sort((a, b) => b.plan_date.localeCompare(a.plan_date)).map(p => (
                <option key={p.plan_date} value={p.plan_date}>{p.plan_date} — {p.issued_by ?? ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Role" className="col-span-2 sm:col-span-3">
            <input value={issuedRole} onChange={e => setIssuedRole(e.target.value)} className={inputCls} />
          </Field>
        </div>
      </Card>

      {activeVessels.map((v, idx) => (
        <Card key={v.id} title={v.name} accent="teal">
          <div className="space-y-3">
            <Field label="Current status (today)">
              <textarea
                rows={2}
                placeholder="Vessel Currently STBY at Shuaiba Port…"
                value={current[idx]?.current_status ?? ''}
                onChange={e => setEntries(cs => (cs ?? current).map((c, j) => j === idx ? { ...c, current_status: e.target.value } : c))}
                className={inputCls}
              />
            </Field>
            <Field label="Tomorrow's plan">
              <textarea
                rows={2}
                placeholder="Tomorrow …, Vessel will sail to …, ETD at …"
                value={current[idx]?.tomorrow_plan ?? ''}
                onChange={e => setEntries(cs => (cs ?? current).map((c, j) => j === idx ? { ...c, tomorrow_plan: e.target.value } : c))}
                className={inputCls}
              />
            </Field>
            <Field label="Additional (return legs, conditional plans)">
              <textarea
                rows={2}
                value={current[idx]?.additional ?? ''}
                onChange={e => setEntries(cs => (cs ?? current).map((c, j) => j === idx ? { ...c, additional: e.target.value } : c))}
                className={inputCls}
              />
            </Field>
          </div>
        </Card>
      ))}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          Submit plan
        </button>
        <StatusText status={status} />
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------

const inputCls = 'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm outline-none transition-shadow placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/30'

type Accent = 'blue' | 'red' | 'violet' | 'teal' | 'amber' | 'green' | 'cyan' | 'slate'

const ACCENTS: Record<Accent, { bar: string; dot: string }> = {
  blue:   { bar: 'border-l-blue-500',    dot: 'bg-blue-500' },
  red:    { bar: 'border-l-red-500',     dot: 'bg-red-500' },
  violet: { bar: 'border-l-violet-500',  dot: 'bg-violet-500' },
  teal:   { bar: 'border-l-teal-500',    dot: 'bg-teal-500' },
  amber:  { bar: 'border-l-amber-500',   dot: 'bg-amber-500' },
  green:  { bar: 'border-l-green-500',   dot: 'bg-green-500' },
  cyan:   { bar: 'border-l-cyan-500',    dot: 'bg-cyan-500' },
  slate:  { bar: 'border-l-slate-400',   dot: 'bg-slate-400' },
}

function Card({ title, subtitle, accent = 'slate', required, children }: {
  title: string; subtitle?: string; accent?: Accent; required?: boolean; children: React.ReactNode
}) {
  const a = ACCENTS[accent]
  return (
    <section className={cn('rounded-lg border border-l-4 bg-card p-4', a.bar)}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <span className={cn('inline-block h-2.5 w-2.5 rounded-full', a.dot)} />
        {title}
        {required && <span className="text-destructive" title="Required">*</span>}
      </h2>
      {subtitle && <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </section>
  )
}

function Field({ label, children, className, required }: {
  label: string; children: React.ReactNode; className?: string; required?: boolean
}) {
  return (
    <label className={cn('block', className)}>
      <span className={cn(
        'mb-1 block text-xs',
        required ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
      )}>
        {label}{required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
    </label>
  )
}

function StatusText({ status }: { status: { text: string; tone: 'ok' | 'err' | '' } }) {
  if (!status.text) return null
  return (
    <span className={cn(
      'text-sm',
      status.tone === 'ok' && 'text-success',
      status.tone === 'err' && 'text-destructive',
      status.tone === '' && 'text-muted-foreground',
    )}>
      {status.text}
    </span>
  )
}
