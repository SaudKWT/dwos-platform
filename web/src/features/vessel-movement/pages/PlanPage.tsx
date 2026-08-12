import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { api } from '../api/client'
import { usePlanIndex, useVessels } from '../api/queries'
import { Card, Field, StatusText, inputCls } from '../report-form/ui'

/**
 * The supervisor's 48-hour Vessel Movement Plan.
 *
 * One card per in-service vessel, matching the shape of the plan the IODS
 * Operations Supervisor already emails: where each vessel is now, what it will
 * do tomorrow, and the conditional legs. It writes `dbo.MovementPlan` and
 * `dbo.MovementPlanVessel`.
 *
 * Free text on purpose. Unlike the captain's daily report — where the whole
 * point was to stop the analytics guessing — a movement plan is a forecast a
 * human writes for other humans, and structuring "ETD 0600 subject to weather"
 * into fields would lose the hedging that makes it useful.
 */

interface PlanVesselEntry {
  vessel_id: string
  current_status: string
  tomorrow_plan: string
  additional: string
}

export default function PlanPage() {
  const vessels = useVessels()
  const plans = usePlanIndex()
  const queryClient = useQueryClient()

  const [planDate, setPlanDate] = useState('')
  const [issuedBy, setIssuedBy] = useState('')
  const [issuedRole, setIssuedRole] = useState('IODS Operations Supervisor (Offshore Project), HPM')
  const [entries, setEntries] = useState<PlanVesselEntry[] | null>(null)
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'err' | '' }>({ text: '', tone: '' })
  const [busy, setBusy] = useState(false)

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

    setBusy(true)
    setStatus({ text: 'Saving…', tone: '' })
    try {
      const r = await api.savePlan({
        plan_date: planDate,
        issued_date: planDate,
        issued_by: issuedBy,
        issued_role: issuedRole,
        subject: `Vessel Movement Plan for the next 48 Hrs. ${planDate}`,
        vessels: filled,
        source: { type: 'dashboard_submission' },
      })
      setStatus({ text: `Saved plan for ${r.plan_date}.`, tone: 'ok' })
      queryClient.invalidateQueries({ queryKey: ['plans'] })
    } catch (err) {
      setStatus({ text: `Save failed: ${err instanceof Error ? err.message : err}`, tone: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4">
        <PageHeader
          title="48-hour movement plan"
          description="Where each vessel is now and what it will do over the next two days."
          breadcrumbs={[{ label: 'Offshore' }, { label: 'Marine logistics' }, { label: 'Movement plan' }]}
        />

        <form onSubmit={submit} className="mt-4 space-y-4">
          <Card title="Plan header">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Plan date" required>
                <input
                  id="plan-date" required type="date" value={planDate}
                  onChange={e => setPlanDate(e.target.value)} className={inputCls}
                />
              </Field>
              <Field label="Issued by">
                <input
                  id="plan-issued-by" value={issuedBy} onChange={e => setIssuedBy(e.target.value)}
                  placeholder="Supervisor's name" className={inputCls}
                />
              </Field>
              <Field label="Load existing">
                <select
                  id="plan-load" className={inputCls} defaultValue=""
                  onChange={e => loadExisting(e.target.value)}
                >
                  <option value="">(recent plans…)</option>
                  {[...(plans.data ?? [])]
                    .sort((a, b) => b.plan_date.localeCompare(a.plan_date))
                    .map(p => (
                      <option key={p.plan_date} value={p.plan_date}>
                        {p.plan_date} — {p.issued_by ?? ''}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Role" className="col-span-2 sm:col-span-3">
                <input
                  id="plan-role" value={issuedRole} onChange={e => setIssuedRole(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
          </Card>

          {activeVessels.map((v, idx) => (
            <Card key={v.id} title={v.name}>
              <div className="space-y-3">
                <Field label="Current status (today)">
                  <textarea
                    rows={2}
                    placeholder="Vessel currently STBY at Shuaiba Port…"
                    value={current[idx]?.current_status ?? ''}
                    onChange={e => setEntries(cs => (cs ?? current).map((c, j) => j === idx ? { ...c, current_status: e.target.value } : c))}
                    className={cn(inputCls, 'resize-y')}
                  />
                </Field>
                <Field label="Tomorrow's plan">
                  <textarea
                    rows={2}
                    placeholder="Tomorrow …, vessel will sail to …, ETD at …"
                    value={current[idx]?.tomorrow_plan ?? ''}
                    onChange={e => setEntries(cs => (cs ?? current).map((c, j) => j === idx ? { ...c, tomorrow_plan: e.target.value } : c))}
                    className={cn(inputCls, 'resize-y')}
                  />
                </Field>
                <Field label="Additional (return legs, conditional plans)">
                  <textarea
                    rows={2}
                    value={current[idx]?.additional ?? ''}
                    onChange={e => setEntries(cs => (cs ?? current).map((c, j) => j === idx ? { ...c, additional: e.target.value } : c))}
                    className={cn(inputCls, 'resize-y')}
                  />
                </Field>
              </div>
            </Card>
          ))}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>Submit plan</Button>
            <StatusText status={status} />
          </div>
        </form>
      </div>
    </div>
  )
}
