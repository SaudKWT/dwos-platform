import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Upload } from 'lucide-react'
import { api, type ImportResult } from '@/api/client'
import { usePlanIndex, useVessels } from '@/api/queries'
import type { DailyReport } from '@/api/types'
import { cn } from '@/lib/utils'

// The data-entry side of the app, ported from admin.html/admin.js:
//   - captain's Daily Vessel Report (one per vessel per day) + PDF bulk import
//   - supervisor's 48-hr Movement Plan
// Payload shapes match the original builders exactly, so the API (and the
// simulator downstream) sees the same documents it always has.

const TASK_CODES: [string, string][] = [
  ['S01', 'S01 — Standby on location'],
  ['S02', 'S02 — Standby alongside rig (DP)'],
  ['S03', 'S03 — Standby (semi DP / base)'],
  ['S04', 'S04 — Standby Shuaiba port'],
  ['S05', 'S05 — Standby awaiting instructions'],
  ['DP1', 'DP1 — DP cargo operations'],
  ['L1F', 'L1F — Cargo ops Freeport'],
  ['L2E', 'L2E — Cargo ops'],
  ['B1', 'B1 — Back-load at rig'],
  ['O1', 'O1 — Other'],
  ['I01', 'I01 — In transit'],
  ['I02', 'I02 — In transit (channel)'],
  ['D1', 'D1 — Downtime'],
  ['WOW', 'WOW — Waiting on weather'],
  ['A01', 'A01 — Standby at anchor'],
]

interface TaskRow {
  from_time: string
  to_time: string
  task_code: string
  description: string
}

export default function FormsPage() {
  const [tab, setTab] = useState<'report' | 'plan'>('report')
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4">
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

function ReportForm() {
  const vessels = useVessels()
  const queryClient = useQueryClient()

  const [vesselId, setVesselId] = useState('')
  const [reportDate, setReportDate] = useState('')
  const [voyageNo, setVoyageNo] = useState('')
  const [securityLevel, setSecurityLevel] = useState('')
  const [daysSincePortCall, setDaysSincePortCall] = useState('')
  const [nextCrewChange, setNextCrewChange] = useState('')
  const [periodEnd, setPeriodEnd] = useState('24:00')
  const [safety, setSafety] = useState({ accidents: 'Nil', incidents: 'Nil', near_miss: 'Nil' })
  const [fuel, setFuel] = useState({ rob: '', consumed: '', max: '' })
  const [water, setWater] = useState({ rob: '', consumed: '', max: '' })
  const [compiledName, setCompiledName] = useState('')
  const [compiledRole, setCompiledRole] = useState('Master')
  const [issuesComments, setIssuesComments] = useState('')
  const [lifts, setLifts] = useState({ on_deck: '', loaded: '', discharged: '', utilization: '' })
  const [provisions, setProvisions] = useState({ dry: '', fresh: '', water: '', unpumpable: '' })
  const [delays, setDelays] = useState({ arrival: 'NA', departure: 'NA' })
  const [requirements, setRequirements] = useState('')
  const [accidentSummary, setAccidentSummary] = useState('')
  const [tasks, setTasks] = useState<TaskRow[]>([
    { from_time: '00:00', to_time: '', task_code: 'S01', description: '' },
  ])
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'err' | '' }>({ text: '', tone: '' })
  const [busy, setBusy] = useState(false)

  const num = (s: string) => {
    if (s.trim() === '') return null
    const x = Number(s)
    return Number.isFinite(x) ? x : null
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const task_log = tasks
      .map(t => ({
        from_time: t.from_time,
        to_time: t.to_time || null,
        task_code: t.task_code,
        description: t.description.trim(),
      }))
      .filter(t => t.from_time && t.task_code)

    if (!vesselId || !reportDate) { setStatus({ text: 'Vessel and date are required.', tone: 'err' }); return }
    if (!task_log.length) { setStatus({ text: 'At least one task row is required.', tone: 'err' }); return }

    // Same shape admin.js built — the simulator reads these fields.
    const payload: DailyReport = {
      vessel_id: vesselId,
      report_date: reportDate,
      period_end: periodEnd || '24:00',
      voyage_no: voyageNo || null,
      security_level: num(securityLevel),
      days_since_port_call: num(daysSincePortCall),
      next_crew_change: nextCrewChange || null,
      safety: {
        accidents: safety.accidents || 'Nil',
        incidents: safety.incidents || 'Nil',
        near_miss: safety.near_miss || 'Nil',
      },
      consumables: {
        fuel_oil: { rob: fuel.rob || null, consumed: fuel.consumed || null, max_capacity: fuel.max || null },
        fresh_water: { rob: water.rob || null, consumed: water.consumed || null, max_capacity: water.max || null },
      },
      lifts: {
        on_deck: lifts.on_deck,
        loaded: lifts.loaded,
        discharged: lifts.discharged,
        utilization_pct: num(lifts.utilization),
      },
      provisions: {
        dry_store_days: num(provisions.dry),
        fresh_frozen_days: num(provisions.fresh),
        drinking_water_days: num(provisions.water),
        fuel_oil_unpumpable: provisions.unpumpable || null,
      },
      delays: {
        arrival_time: delays.arrival || 'NA',
        departure_time: delays.departure || 'NA',
      },
      requirements_next_port_call: requirements,
      issues_comments: issuesComments,
      accident_summary: accidentSummary,
      compiled_by: { name: compiledName, role: compiledRole || 'Master' },
      task_log,
      source: { type: 'dashboard_submission' },
    }

    setBusy(true)
    setStatus({ text: 'Saving…', tone: '' })
    try {
      const r = await api.saveReport(payload)
      setStatus({ text: `Saved ${r.vessel_id} · ${r.report_date}. The simulator will pick it up.`, tone: 'ok' })
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      queryClient.invalidateQueries({ queryKey: ['all-reports'] })
    } catch (err) {
      setStatus({ text: `Save failed: ${err instanceof Error ? err.message : err}`, tone: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PdfImportCard />

      <form onSubmit={submit} className="space-y-4">
        <Card title="Report header">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Vessel *">
              <select required value={vesselId} onChange={e => setVesselId(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {(vessels.data ?? []).filter(v => !v.retired_on).map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Report date *">
              <input required type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Voyage No">
              <input value={voyageNo} onChange={e => setVoyageNo(e.target.value)} placeholder="e.g. 041/2026" className={inputCls} />
            </Field>
            <Field label="Security level">
              <input type="number" min={1} max={3} value={securityLevel} onChange={e => setSecurityLevel(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Days since port call">
              <input type="number" min={0} value={daysSincePortCall} onChange={e => setDaysSincePortCall(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Next crew change">
              <input type="date" value={nextCrewChange} onChange={e => setNextCrewChange(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Period end">
              <input value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className={inputCls} />
            </Field>
          </div>
        </Card>

        <Card title="Safety (24 hrs)">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Accidents"><input value={safety.accidents} onChange={e => setSafety({ ...safety, accidents: e.target.value })} className={inputCls} /></Field>
            <Field label="Incidents"><input value={safety.incidents} onChange={e => setSafety({ ...safety, incidents: e.target.value })} className={inputCls} /></Field>
            <Field label="Near miss"><input value={safety.near_miss} onChange={e => setSafety({ ...safety, near_miss: e.target.value })} className={inputCls} /></Field>
          </div>
        </Card>

        <Card title="Operational task log *" subtitle="Hour-by-hour — this is what moves the vessel on the map">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-1 pr-2 text-left font-medium">From</th>
                  <th className="pb-1 pr-2 text-left font-medium">To</th>
                  <th className="pb-1 pr-2 text-left font-medium">Code</th>
                  <th className="pb-1 pr-2 text-left font-medium">Description (mention locations — OD-1, OPH, NSBP, Shuaiba…)</th>
                  <th className="pb-1" />
                </tr>
              </thead>
              <tbody>
                {tasks.map((row, i) => (
                  <tr key={i}>
                    <td className="pr-2 pt-1"><input type="time" value={row.from_time} onChange={e => setTasks(ts => ts.map((t, j) => j === i ? { ...t, from_time: e.target.value } : t))} className={cn(inputCls, 'w-24')} /></td>
                    <td className="pr-2 pt-1"><input type="time" value={row.to_time} onChange={e => setTasks(ts => ts.map((t, j) => j === i ? { ...t, to_time: e.target.value } : t))} className={cn(inputCls, 'w-24')} /></td>
                    <td className="pr-2 pt-1">
                      <select value={row.task_code} onChange={e => setTasks(ts => ts.map((t, j) => j === i ? { ...t, task_code: e.target.value } : t))} className={cn(inputCls, 'w-40')}>
                        {TASK_CODES.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
                      </select>
                    </td>
                    <td className="pr-2 pt-1"><input value={row.description} onChange={e => setTasks(ts => ts.map((t, j) => j === i ? { ...t, description: e.target.value } : t))} className={inputCls} /></td>
                    <td className="pt-1">
                      <button type="button" title="Remove row" onClick={() => setTasks(ts => ts.filter((_, j) => j !== i))} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => setTasks(ts => [...ts, { from_time: ts[ts.length - 1]?.to_time || '', to_time: '', task_code: 'S01', description: '' }])}
            className="mt-2 flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" /> Add row
          </button>
        </Card>

        <Card title="Consumables">
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs text-muted-foreground">Fuel oil</legend>
              <div className="grid grid-cols-3 gap-2">
                <Field label="ROB"><input value={fuel.rob} onChange={e => setFuel({ ...fuel, rob: e.target.value })} placeholder="417.42 M3" className={inputCls} /></Field>
                <Field label="Consumed"><input value={fuel.consumed} onChange={e => setFuel({ ...fuel, consumed: e.target.value })} placeholder="1.44 M3" className={inputCls} /></Field>
                <Field label="Max"><input value={fuel.max} onChange={e => setFuel({ ...fuel, max: e.target.value })} placeholder="950 M3 (80%)" className={inputCls} /></Field>
              </div>
            </fieldset>
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs text-muted-foreground">Fresh water</legend>
              <div className="grid grid-cols-3 gap-2">
                <Field label="ROB"><input value={water.rob} onChange={e => setWater({ ...water, rob: e.target.value })} placeholder="294 M3" className={inputCls} /></Field>
                <Field label="Consumed"><input value={water.consumed} onChange={e => setWater({ ...water, consumed: e.target.value })} placeholder="3 M3" className={inputCls} /></Field>
                <Field label="Max"><input value={water.max} onChange={e => setWater({ ...water, max: e.target.value })} placeholder="673 M3 (100%)" className={inputCls} /></Field>
              </div>
            </fieldset>
          </div>
        </Card>

        <Card title="Deck cargo / lifts">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="On deck"><input value={lifts.on_deck} onChange={e => setLifts({ ...lifts, on_deck: e.target.value })} placeholder="1 trash skip, 3 Lamor…" className={inputCls} /></Field>
            <Field label="Loaded"><input value={lifts.loaded} onChange={e => setLifts({ ...lifts, loaded: e.target.value })} placeholder="10 Lift" className={inputCls} /></Field>
            <Field label="Discharged"><input value={lifts.discharged} onChange={e => setLifts({ ...lifts, discharged: e.target.value })} placeholder="1 Lift" className={inputCls} /></Field>
            <Field label="Deck utilization %"><input type="number" min={0} max={100} value={lifts.utilization} onChange={e => setLifts({ ...lifts, utilization: e.target.value })} className={inputCls} /></Field>
          </div>
        </Card>

        <Card title="Provisions & delays">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Dry store (days)"><input type="number" min={0} value={provisions.dry} onChange={e => setProvisions({ ...provisions, dry: e.target.value })} className={inputCls} /></Field>
            <Field label="Fresh & frozen (days)"><input type="number" min={0} value={provisions.fresh} onChange={e => setProvisions({ ...provisions, fresh: e.target.value })} className={inputCls} /></Field>
            <Field label="Drinking water (days)"><input type="number" min={0} value={provisions.water} onChange={e => setProvisions({ ...provisions, water: e.target.value })} className={inputCls} /></Field>
            <Field label="Fuel oil unpumpable"><input value={provisions.unpumpable} onChange={e => setProvisions({ ...provisions, unpumpable: e.target.value })} placeholder="20 M3" className={inputCls} /></Field>
            <Field label="Delay — arrival"><input value={delays.arrival} onChange={e => setDelays({ ...delays, arrival: e.target.value })} className={inputCls} /></Field>
            <Field label="Delay — departure"><input value={delays.departure} onChange={e => setDelays({ ...delays, departure: e.target.value })} className={inputCls} /></Field>
          </div>
        </Card>

        <Card title="Comments & sign-off">
          <Field label="Requirements next port call">
            <textarea rows={2} value={requirements} onChange={e => setRequirements(e.target.value)} className={inputCls} />
          </Field>
          <div className="mt-3" />
          <Field label="Issues / comments">
            <textarea rows={3} value={issuesComments} onChange={e => setIssuesComments(e.target.value)} className={inputCls} />
          </Field>
          <div className="mt-3" />
          <Field label="Accident / incident summary">
            <textarea rows={2} value={accidentSummary} onChange={e => setAccidentSummary(e.target.value)} className={inputCls} />
          </Field>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Master's name">
              <input value={compiledName} onChange={e => setCompiledName(e.target.value)} placeholder="Capt. …" className={inputCls} />
            </Field>
            <Field label="Role">
              <input value={compiledRole} onChange={e => setCompiledRole(e.target.value)} className={inputCls} />
            </Field>
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            Submit report
          </button>
          <StatusText status={status} />
        </div>
      </form>
    </div>
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
    <Card title="Import daily-report PDFs" subtitle="Drop the captains' PDF reports — parsed and saved automatically">
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
                  r.status === 'saved' || r.status === 'overwrote' ? 'text-emerald-400'
                  : r.status === 'skipped' ? 'text-amber-400' : 'text-destructive')}>
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
      <Card title="Plan header">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Plan date *">
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
        <Card key={v.id} title={v.name}>
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

const inputCls = 'w-full rounded-md border bg-card px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring'

function Card({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border p-4">
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      {subtitle && <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </section>
  )
}

function Field({ label, children, className }: {
  label: string; children: React.ReactNode; className?: string
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function StatusText({ status }: { status: { text: string; tone: 'ok' | 'err' | '' } }) {
  if (!status.text) return null
  return (
    <span className={cn(
      'text-sm',
      status.tone === 'ok' && 'text-emerald-400',
      status.tone === 'err' && 'text-destructive',
      status.tone === '' && 'text-muted-foreground',
    )}>
      {status.text}
    </span>
  )
}
