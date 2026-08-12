import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownWideNarrow, Copy, FileDown, Plus, Trash2 } from 'lucide-react'
import { api } from '@/features/vessel-movement/api/client'
import { useLocations, useReportIndex, useVessels } from '@/features/vessel-movement/api/queries'
import { classifyActivity, STANDBY_LABEL } from '@/features/vessel-movement/simulator/activity'
import { codeIsStandby, codeIsTransit } from '@/features/vessel-movement/simulator/engine'
import {
  ACTIVITY_OPTIONS, CODE_LABELS, COMMON_DESCRIPTIONS, LIQUID_TITLES, TASK_CODE_GROUPS,
  computeCoverage, emptyFormState, emptyTaskRow, fmtMin, formStateToPayload, hydrateFormState,
  isNilAnswer, leadingNumber, normalizeClock, parseClock, reportToFormState, rowDurationMin,
  type LiquidKey, type LiquidState, type ReportFormState, type TaskRowState,
} from './model'
import { stripUnit, tanksFor, withUnit, type TankSpec } from './tanks'
import {
  isWorthSaving, listDrafts, migrateLegacyDraft, removeDraft, saveDraft, draftKey,
  type DraftEntry,
} from './drafts'
import { openReportPdf } from './buildReportHtml'
import { Card, CollapsibleCard, Field, NilToggle, StatusText, inputCls } from './ui'
import type { DailyReport } from '@/features/vessel-movement/api/types'
import { cn } from '@/lib/utils'

// The captain's Daily Vessel Report — one per vessel per day.
//
// Form state <-> payload conversion lives in ./model.ts so the round-trip
// parity test can drive it without a browser. The payload shape matches the PDF
// importer exactly: downstream, a form submission and a parsed PDF are
// indistinguishable.

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

/** What the analytics will make of this row if the captain doesn't say. */
function activityGuess(t: TaskRowState): string {
  if (codeIsTransit(t.task_code)) return 'Transit'
  if (codeIsStandby(t.task_code, CODE_LABELS[t.task_code] ?? t.raw_label)) return STANDBY_LABEL
  return classifyActivity(t.task_code, CODE_LABELS[t.task_code] ?? t.raw_label, t.description) ?? 'Transit'
}

function nextDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

interface Warning { id: string; text: string }

export default function ReportForm() {
  const vessels = useVessels()
  const locations = useLocations()
  const reportIndex = useReportIndex()
  const queryClient = useQueryClient()

  const [f, setF] = useState<ReportFormState>(emptyFormState)
  const [drafts, setDrafts] = useState<DraftEntry[]>([])
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'err' | '' }>({ text: '', tone: '' })
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [open, setOpen] = useState({ provisions: false, cargo: false, crew: false })

  // Remaining-to-load is recomputed when ROB changes, unless the captain has
  // typed into it themselves — then their number stands.
  const remainingTyped = useRef<Set<string>>(new Set())

  useEffect(() => {
    migrateLegacyDraft()
    setDrafts(listDrafts())
  }, [])

  // Autosaved draft, one slot per vessel and date: a captain filling 25 rows on
  // a moving vessel must never lose work to a closed tab.
  useEffect(() => {
    if (!isWorthSaving(f)) return
    const id = setTimeout(() => {
      saveDraft(f)
      setSavedAt(Date.now())
      setDrafts(listDrafts())
    }, 500)
    return () => clearTimeout(id)
  }, [f])

  const patch = (p: Partial<ReportFormState>) => setF(prev => ({ ...prev, ...p }))

  const replaceState = (next: ReportFormState) => {
    remainingTyped.current = new Set()
    setF(next)
    setOpen({
      provisions: Boolean(next.provisions.dry || next.provisions.fresh || next.provisions.water || next.provisions.unpumpable),
      cargo: Boolean(next.lifts.on_deck || next.lifts.loaded || next.lifts.discharged || next.lifts.utilization),
      crew: next.crew.length > 0,
    })
  }

  const editTask = (i: number, p: Partial<TaskRowState>) => setF(prev => {
    const tasks = prev.tasks.map((t, j) => (j === i ? { ...t, ...p } : t))
    const next = tasks[i + 1]
    // Chain forward: when a row's end time or location changes, pull the next
    // row along if it was empty or still matched the old value. Clearing an end
    // time is excluded — switching a row to an event drops its end time, and
    // that must not take the following row's start with it.
    if (p.to_time && next) {
      const old = prev.tasks[i].to_time
      if (!next.from_time || next.from_time === old) tasks[i + 1] = { ...next, from_time: p.to_time }
    }
    if (p.location_id !== undefined && tasks[i + 1]) {
      const old = prev.tasks[i].location_id
      const n = tasks[i + 1]
      if (!n.location_id || n.location_id === old) tasks[i + 1] = { ...n, location_id: p.location_id }
    }
    return { ...prev, tasks }
  })

  const addRow = (kind: TaskRowState['kind']) => setF(prev => {
    const last = prev.tasks[prev.tasks.length - 1]
    return {
      ...prev,
      tasks: [...prev.tasks, emptyTaskRow(last?.kind === 'span' ? last.to_time : '', {
        kind,
        location_id: last?.location_id ?? '',
        task_code: kind === 'event' ? 'O1' : 'S01',
      })],
    }
  })

  const duplicateRow = (i: number) => setF(prev => ({
    ...prev,
    tasks: [...prev.tasks.slice(0, i + 1), { ...prev.tasks[i] }, ...prev.tasks.slice(i + 1)],
  }))

  const removeRow = (i: number) => setF(prev => ({ ...prev, tasks: prev.tasks.filter((_, j) => j !== i) }))

  /** 40 rows typed out of order sort themselves; rows with no time stay put. */
  const sortRows = () => setF(prev => ({
    ...prev,
    tasks: [...prev.tasks]
      .map((t, i) => ({ t, i, m: parseClock(t.from_time) }))
      .sort((a, b) => (a.m === null || b.m === null ? a.i - b.i : a.m - b.m || a.i - b.i))
      .map(x => x.t),
  }))

  const locOptions = locations.data?.locations ?? []
  const tanks = useMemo(() => {
    const spec = tanksFor(f.vesselId)
    // Never hide a tank that already holds data — a report imported for a
    // vessel whose config has drifted must still show everything it carries.
    const extra = (Object.keys(f.liquids) as LiquidKey[])
      .filter(k => !spec.some(t => t.key === k) && liquidHasData(f.liquids[k]))
      .map(k => ({ key: k, maxCapacity: f.liquids[k].max, unit: '' }) as TankSpec)
    return [...spec, ...extra]
  }, [f.vesselId, f.liquids])

  const coverage = useMemo(() => computeCoverage(f.tasks), [f.tasks])

  const existing = useMemo(
    () => (reportIndex.data ?? []).find(r => r.vessel_id === f.vesselId && r.report_date === f.reportDate),
    [reportIndex.data, f.vesselId, f.reportDate],
  )

  const warnings = useMemo<Warning[]>(() => {
    const out: Warning[] = []
    // An untouched form has nothing to check: opening the page to "2 things
    // worth checking" teaches people to ignore the count.
    if (!isWorthSaving(f)) return out
    if (coverage.silentGaps.length) {
      const list = coverage.silentGaps.slice(0, 4).map(g => `${fmtMin(g.start)}–${fmtMin(g.end)}`).join(', ')
      out.push({
        id: 'dvr-task-log',
        text: `Nothing logged for ${list}${coverage.silentGaps.length > 4 ? '…' : ''}. Add a span or an event so the day is accounted for.`,
      })
    }
    for (const i of coverage.rowsMissingTo) {
      out.push({ id: `dvr-row-${i}-to`, text: `Row ${i + 1} is a span with no end time — set one, or switch it to an event.` })
    }
    for (const t of tanks) {
      const l = f.liquids[t.key]
      const rob = leadingNumber(l.rob)
      const max = leadingNumber(t.maxCapacity || l.max)
      if (rob !== null && max !== null && rob > max) {
        out.push({ id: `dvr-tank-${t.key}-rob`, text: `${LIQUID_TITLES[t.key]}: ROB (${l.rob}) is above the tank's ${t.maxCapacity || l.max}.` })
      }
    }
    if (f.reportDate && f.reportDate > new Date().toISOString().slice(0, 10)) {
      out.push({ id: 'dvr-report-date', text: 'Report date is in the future.' })
    }
    return out
  }, [coverage, f, tanks])

  const vesselName = (id: string) => vessels.data?.find(v => v.id === id)?.name ?? id

  const buildPayload = (): DailyReport | null => {
    if (!f.vesselId || !f.reportDate) {
      setStatus({ text: 'Vessel and date are required.', tone: 'err' })
      focusField(f.vesselId ? 'dvr-report-date' : 'dvr-vessel')
      return null
    }
    const payload = formStateToPayload(f)
    if (!payload.task_log.length) {
      setStatus({ text: 'At least one task row is required.', tone: 'err' })
      focusField('dvr-task-log')
      return null
    }
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
      removeDraft(draftKey(f.vesselId, f.reportDate))
      setDrafts(listDrafts())
      setSavedAt(null)
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

  const loadReport = useCallback(async (vesselId: string, date: string, asNextDay: boolean) => {
    try {
      const rep = await api.report(vesselId, date)
      const state = reportToFormState(rep)
      if (asNextDay) state.reportDate = nextDay(date)
      replaceState(state)
      setStatus({
        text: asNextDay
          ? `Prefilled from ${date} — dated ${state.reportDate}. Edit and submit.`
          : `Loaded ${vesselId} · ${date}. Submitting will replace it.`,
        tone: 'ok',
      })
    } catch (err) {
      setStatus({ text: `Could not load ${date}: ${err instanceof Error ? err.message : err}`, tone: 'err' })
    }
  }, [])

  // "Start from the vessel's last report": a typical day is edit-three-rows,
  // not type-twenty-five.
  const prefillFromLast = () => {
    if (!f.vesselId) { setStatus({ text: 'Pick a vessel first.', tone: 'err' }); return }
    const latest = (reportIndex.data ?? [])
      .filter(r => r.vessel_id === f.vesselId)
      .sort((a, b) => b.report_date.localeCompare(a.report_date))[0]
    if (!latest) { setStatus({ text: `No stored reports for ${vesselName(f.vesselId)}.`, tone: 'err' }); return }
    loadReport(latest.vessel_id, latest.report_date, true)
  }

  const otherDrafts = drafts.filter(d => d.key !== draftKey(f.vesselId, f.reportDate))

  return (
    <div className="space-y-4">
      {otherDrafts.length > 0 && (
        <DraftBanner
          drafts={otherDrafts}
          vesselName={vesselName}
          onOpen={d => { replaceState(hydrateFormState(d.state)); setStatus({ text: 'Draft restored.', tone: 'ok' }) }}
          onDiscard={key => { removeDraft(key); setDrafts(listDrafts()) }}
        />
      )}

      <form onSubmit={submit} className="space-y-4 pb-2">
        <Card title="Report header" accent="blue">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Vessel" required>
              <select id="dvr-vessel" required value={f.vesselId} onChange={e => patch({ vesselId: e.target.value })} className={inputCls}>
                <option value="">Select…</option>
                {(vessels.data ?? []).filter(v => !v.retired_on).map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Report date" required>
              <input id="dvr-report-date" required type="date" value={f.reportDate} onChange={e => patch({ reportDate: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Voyage No">
              <input value={f.voyageNo} onChange={e => patch({ voyageNo: e.target.value })} placeholder="e.g. 041/2026" className={inputCls} />
            </Field>
            <Field label="Security level">
              <select value={f.securityLevel} onChange={e => patch({ securityLevel: e.target.value })} className={inputCls}>
                <option value="">—</option>
                <option value="1">1 — normal</option>
                <option value="2">2 — heightened</option>
                <option value="3">3 — exceptional</option>
              </select>
            </Field>
            <Field label="Days since port call">
              <input type="number" min={0} value={f.daysSincePortCall} onChange={e => patch({ daysSincePortCall: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Next crew change">
              <input type="date" value={f.nextCrewChange} onChange={e => patch({ nextCrewChange: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Period end" hint="End of the 24 hours this report covers. 24:00 unless the log stops early.">
              <input value={f.periodEnd} onChange={e => patch({ periodEnd: e.target.value })} onBlur={e => patch({ periodEnd: normalizeClock(e.target.value) })} className={inputCls} />
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={prefillFromLast}
              className="rounded-md border border-primary/40 px-2.5 py-1 text-xs text-primary hover:bg-primary/10"
            >
              ⚡ Start from this vessel's last report
            </button>
          </div>

          {existing && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <span>
                <strong>{vesselName(f.vesselId)} · {f.reportDate}</strong> is already filed
                {' '}({existing.task_log_rows} rows{existing.source_type ? `, ${existing.source_type.replace(/_/g, ' ')}` : ''}).
                Submitting replaces it.
              </span>
              <button
                type="button"
                onClick={() => loadReport(f.vesselId, f.reportDate, false)}
                className="rounded border border-warning/40 px-2 py-0.5 font-medium hover:bg-amber-500/20"
              >
                Load it in
              </button>
            </div>
          )}
        </Card>

        <Card title="Safety (24 hrs)" accent="red" subtitle="Answer the question — the box only opens if there is something to report.">
          <div className="grid gap-3 sm:grid-cols-3">
            <NilToggle
              label="Accidents" value={f.safety.accidents} isNil={isNilAnswer(f.safety.accidents)}
              nilWord="None" yesWord="Reportable" placeholder="What happened"
              onChange={v => patch({ safety: { ...f.safety, accidents: v } })}
            />
            <NilToggle
              label="Incidents" value={f.safety.incidents} isNil={isNilAnswer(f.safety.incidents)}
              nilWord="None" yesWord="Reportable" placeholder="What happened"
              onChange={v => patch({ safety: { ...f.safety, incidents: v } })}
            />
            <NilToggle
              label="Near miss" value={f.safety.near_miss} isNil={isNilAnswer(f.safety.near_miss)}
              nilWord="None" yesWord="Reportable" placeholder="What happened"
              onChange={v => patch({ safety: { ...f.safety, near_miss: v } })}
            />
          </div>
        </Card>

        <Card
          title="Operational task log" required accent="violet" id="dvr-task-log"
          subtitle="Spans account for the day; events mark the moment something happened. Both drive the map."
        >
          <div className="sticky top-0 z-10 -mx-4 mb-3 border-b bg-card px-4 pb-2 pt-1">
            <CoverageStrip coverage={coverage} />
          </div>

          <div className="space-y-2">
            {f.tasks.map((row, i) => (
              <TaskRow
                key={i}
                i={i}
                row={row}
                locOptions={locOptions}
                onEdit={p => editTask(i, p)}
                onDuplicate={() => duplicateRow(i)}
                onRemove={() => removeRow(i)}
              />
            ))}
          </div>

          <datalist id="dvr-descriptions">
            {[...new Set([...f.tasks.map(t => t.description).filter(Boolean), ...COMMON_DESCRIPTIONS])]
              .map(d => <option key={d} value={d} />)}
          </datalist>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => addRow('span')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent">
              <Plus className="h-3.5 w-3.5" /> Add span
            </button>
            <button type="button" onClick={() => addRow('event')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent">
              <Plus className="h-3.5 w-3.5" /> Add event
            </button>
            <button type="button" onClick={sortRows} className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
              <ArrowDownWideNarrow className="h-3.5 w-3.5" /> Sort by time
            </button>
          </div>
        </Card>

        <Card
          title="Consumables" accent="teal"
          subtitle={f.vesselId
            ? "Loaded / Discharged are what prove a delivery happened — fill them whenever a hose was connected."
            : "Pick a vessel to see its tanks."}
        >
          {f.vesselId ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {tanks.map(t => (
                <TankFieldset
                  key={t.key}
                  spec={t}
                  value={f.liquids[t.key]}
                  onChange={(p, robChanged) => setF(prev => {
                    const cur = prev.liquids[t.key]
                    const merged = { ...cur, ...p }
                    // ROB moved: the old remaining-to-load is stale arithmetic.
                    // 646 of 701 imported values are exactly max - ROB, and most
                    // of the rest are the captain's subtraction slipping.
                    if (robChanged && !remainingTyped.current.has(t.key)) {
                      const max = leadingNumber(t.maxCapacity || merged.max)
                      const rob = leadingNumber(merged.rob)
                      merged.remaining = max !== null && rob !== null && merged.rob.trim() !== ''
                        ? withUnit(String(Math.round((max - rob) * 1000) / 1000), t.unit)
                        : ''
                    }
                    if (p.remaining !== undefined) remainingTyped.current.add(t.key)
                    return { ...prev, liquids: { ...prev.liquids, [t.key]: merged } }
                  })}
                />
              ))}
            </div>
          ) : null}
        </Card>

        <CollapsibleCard
          title="Provisions & delays" accent="green"
          open={open.provisions} onOpenChange={v => setOpen(o => ({ ...o, provisions: v }))}
          summary={provisionsSummary(f)}
          action="Add"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Dry store (days)"><input type="number" min={0} value={f.provisions.dry} onChange={e => patch({ provisions: { ...f.provisions, dry: e.target.value } })} className={inputCls} /></Field>
            <Field label="Fresh & frozen (days)"><input type="number" min={0} value={f.provisions.fresh} onChange={e => patch({ provisions: { ...f.provisions, fresh: e.target.value } })} className={inputCls} /></Field>
            <Field label="Drinking water (days)"><input type="number" min={0} value={f.provisions.water} onChange={e => patch({ provisions: { ...f.provisions, water: e.target.value } })} className={inputCls} /></Field>
            <Field label="Fuel oil unpumpable"><input value={f.provisions.unpumpable} onChange={e => patch({ provisions: { ...f.provisions, unpumpable: e.target.value } })} placeholder="20 M3" className={inputCls} /></Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <NilToggle
              label="Delay on arrival" value={f.delays.arrival} isNil={isNilAnswer(f.delays.arrival)}
              nilWord="On time" yesWord="Delayed" placeholder="How long, and why"
              onChange={v => patch({ delays: { ...f.delays, arrival: v } })}
            />
            <NilToggle
              label="Delay on departure" value={f.delays.departure} isNil={isNilAnswer(f.delays.departure)}
              nilWord="On time" yesWord="Delayed" placeholder="How long, and why"
              onChange={v => patch({ delays: { ...f.delays, departure: v } })}
            />
          </div>
        </CollapsibleCard>

        <CollapsibleCard
          title="Deck cargo / lifts" accent="amber"
          open={open.cargo} onOpenChange={v => setOpen(o => ({ ...o, cargo: v }))}
          summary={f.lifts.on_deck || f.lifts.loaded || f.lifts.discharged ? 'has entries' : undefined}
          action="Add"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="On deck"><input value={f.lifts.on_deck} onChange={e => patch({ lifts: { ...f.lifts, on_deck: e.target.value } })} placeholder="1 trash skip, 3 Lamor…" className={inputCls} /></Field>
            <Field label="Loaded"><input value={f.lifts.loaded} onChange={e => patch({ lifts: { ...f.lifts, loaded: e.target.value } })} placeholder="10 Lift" className={inputCls} /></Field>
            <Field label="Discharged"><input value={f.lifts.discharged} onChange={e => patch({ lifts: { ...f.lifts, discharged: e.target.value } })} placeholder="1 Lift" className={inputCls} /></Field>
            <Field label="Deck utilization %"><input type="number" min={0} max={100} value={f.lifts.utilization} onChange={e => patch({ lifts: { ...f.lifts, utilization: e.target.value } })} className={inputCls} /></Field>
          </div>
        </CollapsibleCard>

        <CollapsibleCard
          title="Crew list" accent="cyan"
          subtitle="Fills the crew table on page 3 of the printed report."
          open={open.crew} onOpenChange={v => setOpen(o => ({ ...o, crew: v }))}
          summary={f.crew.length ? `${f.crew.length} aboard` : undefined}
          action="Add"
        >
          <CrewTable
            crew={f.crew}
            onChange={crew => patch({ crew })}
          />
        </CollapsibleCard>

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

        <ActionBar
          busy={busy}
          warnings={warnings}
          status={status}
          savedAt={savedAt}
          onPrint={printPdf}
        />
      </form>
    </div>
  )
}

const liquidHasData = (l: LiquidState): boolean =>
  Boolean(l.rob || l.consumed || l.max || l.loaded || l.discharged || l.remaining || l.remarks)

function provisionsSummary(f: ReportFormState): string | undefined {
  const filled = [f.provisions.dry, f.provisions.fresh, f.provisions.water, f.provisions.unpumpable].filter(Boolean).length
  const delayed = !isNilAnswer(f.delays.arrival) || !isNilAnswer(f.delays.departure)
  if (delayed) return 'delay reported'
  return filled ? `${filled} filled` : undefined
}

function focusField(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.focus()
}

// ---------------------------------------------------------------------------
// Task log
// ---------------------------------------------------------------------------

function TaskRow({ i, row, locOptions, onEdit, onDuplicate, onRemove }: {
  i: number
  row: TaskRowState
  locOptions: { id: string; name: string; short: string | null }[]
  onEdit: (p: Partial<TaskRowState>) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const fam = rowFamily(row.task_code)
  const dur = rowDurationMin(row.from_time, row.to_time)
  const transit = codeIsTransit(row.task_code)
  const codeKnown = Boolean(CODE_LABELS[row.task_code])
  const isEvent = row.kind === 'event'

  return (
    <div className={cn('rounded-md border border-l-4 p-2', FAMILY_TINT[fam])}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>

        {/*
          Changing the kind drops the importer's carried duration: it described
          the row as it arrived, and a row deliberately turned into an event no
          longer claims those hours — the analytics add duration_min up.
        */}
        <KindToggle
          kind={row.kind}
          onChange={kind => onEdit({ kind, raw_duration_min: undefined, ...(kind === 'event' ? { to_time: '' } : {}) })}
        />

        <input
          id={`dvr-row-${i}-from`}
          value={row.from_time}
          onChange={e => onEdit({ from_time: e.target.value })}
          onBlur={e => onEdit({ from_time: normalizeClock(e.target.value) })}
          placeholder="00:00" inputMode="numeric"
          aria-label={isEvent ? `Row ${i + 1} time` : `Row ${i + 1} start time`}
          className={cn(inputCls, 'w-[4.5rem] text-center font-mono')}
        />

        {isEvent ? (
          <span className="w-[7.75rem] text-[11px] text-muted-foreground">a moment in time</span>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">→</span>
            <input
              id={`dvr-row-${i}-to`}
              value={row.to_time}
              onChange={e => onEdit({ to_time: e.target.value })}
              onBlur={e => onEdit({ to_time: normalizeClock(e.target.value) })}
              placeholder="24:00" inputMode="numeric"
              aria-label={`Row ${i + 1} end time`}
              className={cn(inputCls, 'w-[4.5rem] text-center font-mono')}
            />
            <span className="w-12 font-mono text-[11px] text-muted-foreground">
              {dur !== null ? `${Math.floor(dur / 60)}h${dur % 60 ? String(dur % 60).padStart(2, '0') : ''}` : '—'}
            </span>
          </>
        )}

        <select
          value={row.task_code}
          onChange={e => onEdit({ task_code: e.target.value })}
          aria-label={`Row ${i + 1} task code`}
          className={cn(inputCls, 'w-56 flex-none')}
        >
          {!codeKnown && row.task_code && <option value={row.task_code}>{row.task_code} — (as imported)</option>}
          {TASK_CODE_GROUPS.map(g => (
            <optgroup key={g.family} label={g.family}>
              {g.codes.map(c => <option key={c} value={c}>{c} — {CODE_LABELS[c]}</option>)}
            </optgroup>
          ))}
        </select>

        {transit ? (
          <span className="flex items-center gap-1">
            <select value={row.from_location_id} onChange={e => onEdit({ from_location_id: e.target.value })} aria-label={`Row ${i + 1} from`} className={cn(inputCls, 'w-32')}>
              <option value="">From…</option>
              {locOptions.map(l => <option key={l.id} value={l.id}>{l.short ?? l.name}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">→</span>
            <select value={row.to_location_id} onChange={e => onEdit({ to_location_id: e.target.value })} aria-label={`Row ${i + 1} to`} className={cn(inputCls, 'w-32')}>
              <option value="">To…</option>
              {locOptions.map(l => <option key={l.id} value={l.id}>{l.short ?? l.name}</option>)}
            </select>
          </span>
        ) : (
          <select value={row.location_id} onChange={e => onEdit({ location_id: e.target.value })} aria-label={`Row ${i + 1} location`} className={cn(inputCls, 'w-36')}>
            <option value="">Where?</option>
            {locOptions.map(l => <option key={l.id} value={l.id}>{l.short ?? l.name}</option>)}
          </select>
        )}

        <span className="ml-auto flex items-center">
          <button type="button" title="Duplicate row" onClick={onDuplicate} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Copy className="h-4 w-4" />
          </button>
          <button type="button" title="Remove row" onClick={onRemove} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive">
            <Trash2 className="h-4 w-4" />
          </button>
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 pl-7">
        <input
          value={row.description}
          onChange={e => onEdit({ description: e.target.value })}
          list="dvr-descriptions"
          placeholder="What happened — mention locations (OD-1, OPH, NSBP, Shuaiba…)"
          aria-label={`Row ${i + 1} description`}
          className={cn(inputCls, 'flex-1')}
        />
        <select
          value={row.activity}
          onChange={e => onEdit({ activity: e.target.value })}
          aria-label={`Row ${i + 1} job type`}
          title="What kind of job this was — the analytics use it instead of guessing"
          className={cn(
            'max-w-[13rem] shrink-0 truncate rounded-full border px-2 py-0.5 text-[11px] outline-none focus:ring-2 focus:ring-ring/30',
            row.activity ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-transparent bg-secondary text-muted-foreground',
          )}
        >
          <option value="">Auto: {activityGuess(row)}</option>
          {ACTIVITY_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
    </div>
  )
}

function KindToggle({ kind, onChange }: { kind: TaskRowState['kind']; onChange: (k: TaskRowState['kind']) => void }) {
  return (
    <span className="flex overflow-hidden rounded border border-input text-[10px] font-medium" role="group" aria-label="Row type">
      {(['span', 'event'] as const).map(k => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          aria-pressed={kind === k}
          title={k === 'span' ? 'Covers a stretch of the day' : 'Marks the moment something happened'}
          className={cn('px-1.5 py-1 capitalize transition-colors duration-fast ease-out',
            k === 'event' && 'border-l border-input',
            kind === k ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent')}
        >
          {k}
        </button>
      ))}
    </span>
  )
}

/** 24-hour strip: spans fill it, events tick it, silent gaps glow red. */
function CoverageStrip({ coverage }: { coverage: ReturnType<typeof computeCoverage> }) {
  const full = coverage.coveredMin >= 1440
  return (
    <div>
      <div className="relative flex h-3 w-full overflow-hidden rounded-full border bg-muted/50">
        {coverage.segments.map((sg, i) => {
          // A stretch with events logged in it is accounted for, just not by a
          // span — colouring it the same red as a silent gap would put the bar
          // at odds with the warnings, which ignore it.
          const explained = sg.kind === 'gap' && (sg.events ?? 0) > 0
          return (
            <div
              key={i}
              title={`${fmtMin(sg.start)}–${fmtMin(sg.end)}${
                sg.kind !== 'gap' ? '' : explained ? ` — ${sg.events} event${sg.events === 1 ? '' : 's'}, no span` : ' — nothing logged'}`}
              className={cn('h-full', explained ? 'bg-muted-foreground/25' : FAMILY_BAR[sg.kind])}
              style={{ width: `${((sg.end - sg.start) / 1440) * 100}%` }}
            />
          )
        })}
        {coverage.eventTimes.map((m, i) => (
          <span
            key={i}
            title={`Event at ${fmtMin(m)}`}
            className="absolute top-0 h-full w-px bg-foreground/70"
            style={{ left: `${(m / 1440) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-muted-foreground">
        <span className="flex flex-wrap items-center gap-3">
          <LegendDot cls="bg-amber-400" label="Standby" />
          <LegendDot cls="bg-sky-500" label="Transit" />
          <LegendDot cls="bg-emerald-500" label="Cargo" />
          <LegendDot cls="bg-slate-400" label="Other" />
          <LegendDot cls="bg-destructive/60" label="Nothing logged" />
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-px bg-foreground/70" />Event</span>
          <LegendDot cls="bg-muted-foreground/25" label="Events only" />
        </span>
        <span className={cn('font-mono', full && 'text-success')}>
          {coverage.spanRows === 0 && coverage.eventRows > 0
            ? `${coverage.eventRows} event${coverage.eventRows === 1 ? '' : 's'} logged`
            : `${full ? '✓ full day' : `${fmtMin(coverage.coveredMin)} / 24:00`} accounted${
                coverage.eventRows ? ` · ${coverage.eventRows} event${coverage.eventRows === 1 ? '' : 's'}` : ''}`}
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

// ---------------------------------------------------------------------------
// Consumables
// ---------------------------------------------------------------------------

function TankFieldset({ spec, value, onChange }: {
  spec: TankSpec
  value: LiquidState
  onChange: (p: Partial<LiquidState>, robChanged?: boolean) => void
}) {
  const over = (() => {
    const rob = leadingNumber(value.rob)
    const max = leadingNumber(spec.maxCapacity || value.max)
    return rob !== null && max !== null && rob > max
  })()

  return (
    <fieldset className="rounded-md border bg-background/40 p-3">
      <legend className="flex items-center gap-2 px-1 text-xs font-semibold">
        {LIQUID_TITLES[spec.key]}
        {spec.maxCapacity && (
          <span className="font-normal text-muted-foreground" title="From the vessel's tank configuration">
            max {spec.maxCapacity}
          </span>
        )}
      </legend>
      <div className="grid grid-cols-3 gap-2">
        <QtyField
          id={`dvr-tank-${spec.key}-rob`} label="ROB" unit={spec.unit} value={value.rob}
          invalid={over} onChange={v => onChange({ rob: v }, true)}
        />
        <QtyField label="Consumed" unit={spec.unit} value={value.consumed} onChange={v => onChange({ consumed: v })} />
        <QtyField label="Loaded" unit={spec.unit} value={value.loaded} onChange={v => onChange({ loaded: v })} />
        <QtyField label="Discharged" unit={spec.unit} value={value.discharged} onChange={v => onChange({ discharged: v })} />
        <QtyField
          label="Rem. to load" unit={spec.unit} value={value.remaining}
          hint="max − ROB" onChange={v => onChange({ remaining: v })}
        />
        <Field label="Remarks">
          <input value={value.remarks} onChange={e => onChange({ remarks: e.target.value })} className={inputCls} />
        </Field>
      </div>
      {over && (
        <p className="mt-1.5 text-[11px] text-destructive">ROB is above the tank's stated capacity.</p>
      )}
    </fieldset>
  )
}

/**
 * A number with the vessel's unit shown at the edge of the field instead of
 * typed into it. The stored value keeps the unit ('417.42 M3') because that is
 * what every imported report carries and what has to round-trip; anything that
 * isn't a bare number is left exactly as it was found.
 */
function QtyField({ id, label, unit, value, hint, invalid, onChange }: {
  id?: string; label: string; unit: string; value: string
  hint?: string; invalid?: boolean; onChange: (v: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? stripUnit(value, unit)
  return (
    <Field label={label} hint={hint}>
      <span className="relative block">
        <input
          id={id}
          value={shown}
          onChange={e => { setDraft(e.target.value); onChange(withUnit(e.target.value, unit)) }}
          onBlur={() => setDraft(null)}
          inputMode="decimal"
          aria-invalid={invalid || undefined}
          className={cn(inputCls, unit && 'pr-9', invalid && 'border-destructive')}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] text-muted-foreground">
            {unit}
          </span>
        )}
      </span>
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

const CREW_COLS: { key: keyof import('./model').CrewRowState; label: string; cls: string; type?: string }[] = [
  { key: 'first', label: 'First name', cls: 'w-28 flex-1' },
  { key: 'last', label: 'Last name', cls: 'w-28 flex-1' },
  { key: 'position', label: 'Position', cls: 'w-24 flex-1' },
  { key: 'days_onboard', label: 'Days', cls: 'w-16', type: 'number' },
  { key: 'sign_on_date', label: 'Sign-on', cls: 'w-24' },
  { key: 'planned_crew_change', label: 'Change due', cls: 'w-24' },
]

function CrewTable({ crew, onChange }: {
  crew: ReportFormState['crew']
  onChange: (c: ReportFormState['crew']) => void
}) {
  return (
    <>
      {crew.length > 0 && (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 pr-9 text-[11px] font-medium text-muted-foreground">
            {CREW_COLS.map(c => <span key={c.key} className={c.cls}>{c.label}</span>)}
          </div>
          <div className="mb-2 space-y-1.5">
            {crew.map((row, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                {CREW_COLS.map(c => (
                  <input
                    key={c.key}
                    value={row[c.key]}
                    type={c.type}
                    min={c.type === 'number' ? 0 : undefined}
                    aria-label={`Crew ${i + 1} ${c.label}`}
                    onChange={e => onChange(crew.map((x, j) => j === i ? { ...x, [c.key]: e.target.value } : x))}
                    className={cn(inputCls, c.cls)}
                  />
                ))}
                <button
                  type="button" title={`Remove crew member ${i + 1}`}
                  onClick={() => onChange(crew.filter((_, j) => j !== i))}
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => onChange([...crew, { first: '', last: '', position: '', days_onboard: '', sign_on_date: '', planned_crew_change: '' }])}
        className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
      >
        <Plus className="h-3.5 w-3.5" /> Add crew member
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// Drafts and the action bar
// ---------------------------------------------------------------------------

function DraftBanner({ drafts, vesselName, onOpen, onDiscard }: {
  drafts: DraftEntry[]
  vesselName: (id: string) => string
  onOpen: (d: DraftEntry) => void
  onDiscard: (key: string) => void
}) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <p className="mb-1.5 font-medium">
        {drafts.length === 1 ? 'An unsubmitted draft is waiting' : `${drafts.length} unsubmitted drafts are waiting`}
      </p>
      <ul className="space-y-1">
        {drafts.map(d => (
          <li key={d.key} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-mono">
              {d.vesselId ? vesselName(d.vesselId) : 'No vessel'} · {d.reportDate || 'no date'}
            </span>
            <span className="text-muted-foreground">
              {d.state.tasks.length} row{d.state.tasks.length === 1 ? '' : 's'}
            </span>
            <button type="button" onClick={() => onOpen(d)} className="rounded border border-warning/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20">
              Open
            </button>
            <button type="button" onClick={() => onDiscard(d.key)} className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive">
              Discard
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Submit, print and every warning in one place at the bottom of the viewport.
 * The warnings used to sit above the buttons, nine cards down: by the time you
 * could read one you had scrolled past the field it was about, so each one is
 * now a link that puts the cursor in it.
 */
function ActionBar({ busy, warnings, status, savedAt, onPrint }: {
  busy: boolean
  warnings: Warning[]
  status: { text: string; tone: 'ok' | 'err' | '' }
  savedAt: number | null
  onPrint: () => void
}) {
  const [showWarnings, setShowWarnings] = useState(false)
  return (
    <div className="sticky bottom-0 -mx-4 border-t bg-card/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      {showWarnings && warnings.length > 0 && (
        <ul className="mb-2 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
          {warnings.map((w, i) => (
            <li key={i}>
              <button type="button" onClick={() => focusField(w.id)} className="text-left underline-offset-2 hover:underline">
                {w.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          Submit report
        </button>
        <button type="button" onClick={onPrint} className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">
          <FileDown className="h-4 w-4" /> Print / PDF
        </button>
        {warnings.length > 0 && (
          <button
            type="button"
            onClick={() => setShowWarnings(v => !v)}
            aria-expanded={showWarnings}
            className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-xs font-medium hover:bg-warning/20"
          >
            {warnings.length} thing{warnings.length === 1 ? '' : 's'} worth checking
          </button>
        )}
        <span className="ml-auto flex items-center gap-3">
          <StatusText status={status} />
          {savedAt && !status.text && <span className="text-xs text-muted-foreground">Draft saved</span>}
        </span>
      </div>
    </div>
  )
}
