import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { api, type ImportResult } from '@/api/client'
import { usePlanIndex, useVessels } from '@/api/queries'
import ReportForm from '@/features/report-form/ReportForm'
import { Card, Field, StatusText, inputCls } from '@/features/report-form/ui'
import { cn } from '@/lib/utils'

// The data-entry side of the app:
//   - captain's Daily Vessel Report (one per vessel per day) + PDF bulk import
//     + print-ready PDF export (the official Halliburton-style template)
//   - supervisor's 48-hr Movement Plan
// The report form is big enough to live on its own: features/report-form/.

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
        {tab === 'report' ? (
          <div className="space-y-4">
            <PdfImportCard />
            <ReportForm />
          </div>
        ) : <PlanForm />}
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
