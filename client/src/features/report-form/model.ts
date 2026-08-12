// Pure data model behind the Daily Vessel Report form: the form state shape,
// empty/prefill constructors, and the state -> API payload builder.
//
// Kept free of React so the round-trip parity test can drive it headlessly:
// reportToFormState(imported) |> formStateToPayload must reproduce every field
// the importer wrote — that is the guarantee that a captain filling this form
// gets the same analytics as a captain emailing a PDF.

import type { DailyReport, ReportTask } from '@/api/types'

// Official KOC task codes with the importer's exact label vocabulary — payload
// task_label must match what PDF imports carry so downstream displays and the
// standby classifier (which falls back to the label) behave identically.
export const CODE_LABELS: Record<string, string> = {
  S01: 'Standby on location',
  S02: 'Standby alongside rig in DP',
  S03: 'Standby (semi DP / base)',
  S04: 'Standby Shuaiba port',
  S05: 'Standby awaiting instructions',
  DP1: 'DP cargo operations',
  L1F: 'Cargo ops Freeport',
  L2E: 'Cargo ops',
  B1: 'Back-load at rig',
  O1: 'Other',
  I01: 'In transit',
  I02: 'In transit (channel)',
  D1: 'Downtime',
  WOW: 'Waiting on weather',
  A01: 'Standby at anchor',
}

export const TASK_CODE_OPTIONS = Object.entries(CODE_LABELS)

/** The same codes grouped for the picker, so 15 options read as four choices. */
export const TASK_CODE_GROUPS: { family: string; codes: string[] }[] = [
  { family: 'Standby / waiting', codes: ['S01', 'S02', 'S03', 'S04', 'S05', 'A01', 'WOW', 'D1'] },
  { family: 'Transit', codes: ['I01', 'I02'] },
  { family: 'Cargo', codes: ['DP1', 'L1F', 'L2E', 'B1'] },
  { family: 'Other', codes: ['O1'] },
]

/**
 * What kind of job the row was — the question the paper form never asked.
 * 1,268 of 4,835 imported rows are coded O1 "Other" and bunkering has no code
 * at all, so the analytics have to guess the answer from the description. The
 * official code stays untouched for compliance; this rides alongside it.
 *
 * The vocabulary is the classifier's own output (features/simulator/activity.ts)
 * so an explicit answer and a guessed one are the same string downstream.
 */
export const ACTIVITY_OPTIONS: string[] = [
  'Cargo loading / unloading',
  'Water bunkering',
  'Diesel bunkering',
  'Base oil bunkering',
  'Crew / passenger transfer',
  'Provisions',
  'Slop / mud transfer',
  'Tank cleaning',
  'Inspection',
  'Maneuvering',
  'Waiting / giving way',
  'Idle (no work logged)',
  'Other activity',
]

/**
 * The fleet's own phrasing, most-used first, offered as autocomplete on the
 * description box. The same handful of entries is retyped constantly across the
 * imported reports — "deck cargo ops" 117 times, "SBE" 104, "exit 500 mtr" 96 —
 * so suggesting them saves more keystrokes than any other change, and it nudges
 * the wording the location and activity classifiers already read well.
 */
export const COMMON_DESCRIPTIONS: string[] = [
  'Deck cargo ops',
  'SBE',
  'FWE',
  'Exit 500 mtr',
  'Enter 500 mtr',
  'Pull out & c/o',
  'Heave up anchor',
  'Carried out fire & safety round',
  'Stop M/E',
  'DP setup carried out',
  'Vessel cast off',
  'FW hose connected',
  'FW hose disconnected',
  'FO received via road tanker',
  'Slop hose connected',
  'Slop hose disconnected',
  'Anchor aweigh, proceeding to OPH',
  'Standby awaiting instructions',
]

/**
 * Values that mean "nothing to report" in the safety and delay boxes. All 719
 * safety values across 256 reports are the literal string "Nil" and all 379
 * delay values are "NA" — the boxes have never once carried real content, which
 * is what a free-text field defaulted to "Nil" gets you. The form asks the
 * yes/no question instead and only opens a box when the answer is yes.
 */
const NIL_RE = /^(nil|none|na|n\.?\/?a\.?|-|nil delay|na delay)\.?$/i

export const isNilAnswer = (v: string): boolean => v.trim() === '' || NIL_RE.test(v.trim())

export interface LiquidState {
  rob: string
  consumed: string
  max: string
  loaded: string
  discharged: string
  remaining: string
  remarks: string
}

export type LiquidKey = 'fuel_oil' | 'fresh_water' | 'drill_water' | 'base_oil'
export const LIQUID_KEYS: LiquidKey[] = ['fuel_oil', 'fresh_water', 'drill_water', 'base_oil']
export const LIQUID_TITLES: Record<LiquidKey, string> = {
  fuel_oil: 'Fuel oil',
  fresh_water: 'Fresh water',
  drill_water: 'Drill water',
  base_oil: 'Base oil',
}

/**
 * How a row accounts for time. The fleet logs two different ways and the form
 * used to understand only one of them: the PSVs log spans that tile the day
 * ("00:00–06:00 standby"), while the crew boats log the moments things happened
 * ("14:20 FW hose connected"). 1,535 of 4,835 imported rows have no end time
 * and never will — treating those as unfinished spans made the coverage bar sit
 * empty and put up to 38 "no valid end time" warnings on a correctly filled
 * report. An event row is complete with one timestamp.
 */
export type RowKind = 'span' | 'event'

export interface TaskRowState {
  kind: RowKind
  from_time: string
  to_time: string
  task_code: string
  /** Optional explicit job type; '' means "let the classifier guess". */
  activity: string
  description: string
  /** Explicit at-location for non-transit rows ('' = infer from text). */
  location_id: string
  /** Explicit leg endpoints for transit rows. */
  from_location_id: string
  to_location_id: string
  /** Label carried through prefill for codes outside the official list. */
  raw_label?: string
  /**
   * Importer's duration carried through prefill — used only when the clock
   * times can't produce one (e.g. reversed-times typo rows, where the PDF's
   * own HRS/MIN column is the only usable number).
   */
  raw_duration_min?: number
}

export interface CrewRowState {
  first: string
  last: string
  position: string
  days_onboard: string
  sign_on_date: string
  planned_crew_change: string
}

export interface ReportFormState {
  vesselId: string
  reportDate: string
  voyageNo: string
  securityLevel: string
  daysSincePortCall: string
  nextCrewChange: string
  periodEnd: string
  safety: { accidents: string; incidents: string; near_miss: string }
  liquids: Record<LiquidKey, LiquidState>
  lifts: { on_deck: string; loaded: string; discharged: string; utilization: string }
  provisions: { dry: string; fresh: string; water: string; unpumpable: string }
  delays: { arrival: string; departure: string }
  requirements: string
  issuesComments: string
  accidentSummary: string
  compiledName: string
  compiledRole: string
  crew: CrewRowState[]
  tasks: TaskRowState[]
}

export const emptyLiquid = (): LiquidState =>
  ({ rob: '', consumed: '', max: '', loaded: '', discharged: '', remaining: '', remarks: '' })

export function emptyFormState(): ReportFormState {
  return {
    vesselId: '',
    reportDate: '',
    voyageNo: '',
    securityLevel: '',
    daysSincePortCall: '',
    nextCrewChange: '',
    periodEnd: '24:00',
    safety: { accidents: 'Nil', incidents: 'Nil', near_miss: 'Nil' },
    liquids: {
      fuel_oil: emptyLiquid(), fresh_water: emptyLiquid(),
      drill_water: emptyLiquid(), base_oil: emptyLiquid(),
    },
    lifts: { on_deck: '', loaded: '', discharged: '', utilization: '' },
    provisions: { dry: '', fresh: '', water: '', unpumpable: '' },
    delays: { arrival: 'NA', departure: 'NA' },
    requirements: '',
    issuesComments: '',
    accidentSummary: '',
    compiledName: '',
    compiledRole: 'Master',
    crew: [],
    tasks: [emptyTaskRow('00:00')],
  }
}

export function emptyTaskRow(from = '', carry: Partial<TaskRowState> = {}): TaskRowState {
  return {
    kind: 'span', from_time: from, to_time: '', task_code: 'S01', activity: '',
    description: '', location_id: '', from_location_id: '', to_location_id: '',
    ...carry,
  }
}

const s = (v: unknown): string => (v == null ? '' : String(v))

/**
 * Fill in anything a stored draft predates. Drafts are JSON written by whatever
 * version of the form was open at the time, so a restored one can be missing
 * fields the inputs now bind to — and an input bound to undefined is an
 * uncontrolled input that React refuses to take over later.
 */
export function hydrateFormState(raw: Partial<ReportFormState> | null | undefined): ReportFormState {
  const base = emptyFormState()
  if (!raw || !Array.isArray(raw.tasks)) return base
  const liquids = { ...base.liquids }
  for (const k of LIQUID_KEYS) liquids[k] = { ...base.liquids[k], ...(raw.liquids?.[k] ?? {}) }
  return {
    ...base,
    ...raw,
    safety: { ...base.safety, ...(raw.safety ?? {}) },
    liquids,
    lifts: { ...base.lifts, ...(raw.lifts ?? {}) },
    provisions: { ...base.provisions, ...(raw.provisions ?? {}) },
    delays: { ...base.delays, ...(raw.delays ?? {}) },
    crew: ((raw.crew ?? []) as Partial<CrewRowState>[]).map(c => ({
      first: '', last: '', position: '', days_onboard: '',
      sign_on_date: '', planned_crew_change: '', ...c,
    })),
    // A draft written before row kinds existed carries none: read it the way
    // the importer reads a report — no end time means an event.
    tasks: raw.tasks.map(t => ({
      ...emptyTaskRow(), ...t,
      kind: (t.kind ?? (t.to_time ? 'span' : 'event')) as RowKind,
    })),
  }
}

/** 'HH:MM' -> minutes past midnight; '24:00' (1440) is a valid end-of-day. */
export function parseClock(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim())
  if (!m) return null
  const min = Number(m[1]) * 60 + Number(m[2])
  return min >= 0 && min <= 1440 ? min : null
}

/** Zero-pad a loosely typed clock value: '7:0' -> '07:00'. '' stays ''. */
export function normalizeClock(t: string): string {
  const m = /^(\d{1,2})[:.]?(\d{0,2})$/.exec(t.trim())
  if (!m) return t.trim()
  const h = m[1].padStart(2, '0')
  const mm = (m[2] || '0').padStart(2, '0')
  const parsed = parseClock(`${h}:${mm}`)
  return parsed === null ? t.trim() : `${h}:${mm}`
}

/**
 * Row duration from the clock times; null when unusable. Reversed times
 * (15:40 -> 15:30, a typo seen in real reports) are NOT wrapped across
 * midnight — reports cover a single 00:00-24:00 day, so a wrap would turn a
 * 10-minute typo into 23h50m of counted work.
 */
export function rowDurationMin(from: string, to: string): number | null {
  const a = parseClock(from)
  const b = parseClock(to)
  if (a === null || b === null || b <= a) return null
  return b - a
}

function liquidToState(v: unknown): LiquidState {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    rob: s(o.rob), consumed: s(o.consumed), max: s(o.max_capacity),
    loaded: s(o.loaded), discharged: s(o.discharged),
    remaining: s(o.remaining_to_load), remarks: s(o.remarks),
  }
}

const liquidHasData = (l: LiquidState): boolean =>
  Boolean(l.rob || l.consumed || l.max || l.loaded || l.discharged || l.remaining || l.remarks)

function liquidToPayload(l: LiquidState): Record<string, string | null> {
  return {
    loaded: l.loaded || null,
    discharged: l.discharged || null,
    consumed: l.consumed || null,
    rob: l.rob || null,
    max_capacity: l.max || null,
    remaining_to_load: l.remaining || null,
    remarks: l.remarks,
  }
}

/** Prefill the form from an existing report (draft templates, round-trip test). */
export function reportToFormState(r: DailyReport): ReportFormState {
  const f = emptyFormState()
  f.vesselId = s(r.vessel_id)
  f.reportDate = s(r.report_date)
  f.voyageNo = s(r.voyage_no)
  f.securityLevel = s(r.security_level)
  f.daysSincePortCall = s(r.days_since_port_call)
  f.nextCrewChange = s(r.next_crew_change)
  f.periodEnd = s(r.period_end) || '24:00'
  const sa = (r.safety ?? {}) as Record<string, unknown>
  f.safety = { accidents: s(sa.accidents), incidents: s(sa.incidents), near_miss: s(sa.near_miss) }
  const cons = (r.consumables ?? {}) as Record<string, unknown>
  for (const k of LIQUID_KEYS) f.liquids[k] = liquidToState(cons[k])
  const li = (r.lifts ?? {}) as Record<string, unknown>
  f.lifts = { on_deck: s(li.on_deck), loaded: s(li.loaded), discharged: s(li.discharged), utilization: s(li.utilization_pct) }
  const pr = (r.provisions ?? {}) as Record<string, unknown>
  f.provisions = {
    dry: s(pr.dry_store_days), fresh: s(pr.fresh_frozen_days),
    water: s(pr.drinking_water_days), unpumpable: s(pr.fuel_oil_unpumpable),
  }
  const de = (r.delays ?? {}) as Record<string, unknown>
  f.delays = { arrival: s(de.arrival_time), departure: s(de.departure_time) }
  f.requirements = s(r.requirements_next_port_call)
  f.issuesComments = s(r.issues_comments)
  f.accidentSummary = s(r.accident_summary)
  f.compiledName = s(r.compiled_by?.name)
  f.compiledRole = s(r.compiled_by?.role)
  f.crew = (Array.isArray(r.crew) ? r.crew as Record<string, unknown>[] : []).map(c => ({
    first: s(c.first), last: s(c.last), position: s(c.position),
    days_onboard: s(c.days_onboard), sign_on_date: s(c.sign_on_date),
    planned_crew_change: s(c.planned_crew_change),
  }))
  f.tasks = (r.task_log ?? []).map(t => ({
    // No end time in the source means the captain logged an event, not a span.
    kind: (t.to_time ? 'span' : 'event') as RowKind,
    from_time: s(t.from_time),
    to_time: s(t.to_time),
    task_code: s(t.task_code),
    activity: s(t.activity),
    description: s(t.description),
    location_id: s(t.location_id),
    from_location_id: s(t.from_location_id),
    to_location_id: s(t.to_location_id),
    raw_label: t.task_label && !CODE_LABELS[s(t.task_code).toUpperCase()] ? s(t.task_label) : undefined,
    raw_duration_min: typeof t.duration_min === 'number' ? t.duration_min : undefined,
  }))
  if (!f.tasks.length) f.tasks = emptyFormState().tasks
  return f
}

const num = (v: string): number | null => {
  if (v.trim() === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

const hasAny = (o: Record<string, string>): boolean => Object.values(o).some(v => v !== '')

/** Build the API payload — the exact JSON shape the PDF importer writes. */
export function formStateToPayload(f: ReportFormState): DailyReport {
  const task_log: ReportTask[] = f.tasks
    .filter(t => t.from_time && t.task_code)
    .map(t => {
      const code = t.task_code.trim()
      // An event row has no span to emit: exactly the shape the importer writes
      // for the crew boats' single-timestamp events.
      const isEvent = t.kind === 'event'
      const row: ReportTask = {
        from_time: t.from_time,
        to_time: isEvent ? null : (t.to_time || null),
        duration_min: (isEvent ? null : rowDurationMin(t.from_time, t.to_time)) ?? t.raw_duration_min ?? null,
        task_code: code,
        task_label: CODE_LABELS[code.toUpperCase()] ?? t.raw_label ?? code,
        description: t.description.trim(),
      }
      if (t.activity) row.activity = t.activity
      if (t.location_id) row.location_id = t.location_id
      if (t.from_location_id) row.from_location_id = t.from_location_id
      if (t.to_location_id) row.to_location_id = t.to_location_id
      return row
    })

  const payload: DailyReport = {
    vessel_id: f.vesselId,
    report_date: f.reportDate,
    period_end: f.periodEnd || '24:00',
    voyage_no: f.voyageNo || null,
    security_level: num(f.securityLevel),
    days_since_port_call: num(f.daysSincePortCall),
    next_crew_change: f.nextCrewChange || null,
    task_log,
    source: { type: 'dashboard_submission' },
  }

  // Values pass through as typed — the 'Nil'/'NA' conventions live in
  // emptyFormState() defaults, never injected here, so a prefilled report
  // round-trips without invented values.
  if (hasAny(f.safety)) {
    const sa: Record<string, string> = {}
    if (f.safety.accidents) sa.accidents = f.safety.accidents
    if (f.safety.incidents) sa.incidents = f.safety.incidents
    if (f.safety.near_miss) sa.near_miss = f.safety.near_miss
    payload.safety = sa
  }

  const consumables: Record<string, unknown> = {}
  for (const k of LIQUID_KEYS) {
    if (liquidHasData(f.liquids[k])) consumables[k] = liquidToPayload(f.liquids[k])
  }
  if (Object.keys(consumables).length) payload.consumables = consumables

  if (hasAny(f.lifts)) {
    payload.lifts = {
      on_deck: f.lifts.on_deck,
      loaded: f.lifts.loaded,
      discharged: f.lifts.discharged,
      utilization_pct: num(f.lifts.utilization),
    }
  }
  if (hasAny(f.provisions)) {
    payload.provisions = {
      dry_store_days: num(f.provisions.dry),
      fresh_frozen_days: num(f.provisions.fresh),
      drinking_water_days: num(f.provisions.water),
      fuel_oil_unpumpable: f.provisions.unpumpable || null,
    }
  }
  if (hasAny(f.delays)) {
    const de: Record<string, string> = {}
    if (f.delays.arrival) de.arrival_time = f.delays.arrival
    if (f.delays.departure) de.departure_time = f.delays.departure
    payload.delays = de
  }
  if (f.requirements) payload.requirements_next_port_call = f.requirements
  if (f.issuesComments) payload.issues_comments = f.issuesComments
  if (f.accidentSummary) payload.accident_summary = f.accidentSummary
  if (f.compiledName || f.compiledRole) {
    payload.compiled_by = { name: f.compiledName, role: f.compiledRole }
  }
  if (f.crew.length) {
    payload.crew = f.crew
      .filter(c => hasAny(c as unknown as Record<string, string>))
      .map(c => ({
        first: c.first, last: c.last, position: c.position,
        days_onboard: num(c.days_onboard),
        sign_on_date: c.sign_on_date, planned_crew_change: c.planned_crew_change,
      }))
  }
  return payload
}

// ---------------------------------------------------------------------------
// Day-coverage validation: which parts of 00:00–24:00 the task rows account
// for. Overlapping rows are FINE (captains log parallel work); gaps are the
// thing a captain should fix before submitting, so they come back as warnings.
//
// Only SPAN rows can cover time. Event rows are marks on the same 24-hour
// strip: they don't fill a gap but they do explain one, so a stretch of clock
// with events logged in it is not reported as unaccounted for. Without that,
// 165 of 256 real reports would raise a gap warning — a warning two thirds of
// correct reports trigger has stopped meaning anything.
// ---------------------------------------------------------------------------

export interface CoverageSegment {
  start: number      // minutes past midnight
  end: number
  kind: 'standby' | 'transit' | 'cargo' | 'other' | 'gap'
  /** Gap segments only: event rows logged inside it. 0 = truly unaccounted. */
  events?: number
}

export interface CoverageGap {
  start: number
  end: number
  /** Event rows logged inside this stretch. >0 means it is accounted for. */
  events: number
}

export interface DayCoverage {
  segments: CoverageSegment[]      // contiguous, 00:00 -> 24:00
  coveredMin: number
  gaps: CoverageGap[]
  /** Gaps with no events in them — the only ones worth warning about. */
  silentGaps: CoverageGap[]
  /** Times of event rows, minutes past midnight, for the strip's tick marks. */
  eventTimes: number[]
  /** Span rows with a start but no usable end — genuinely unfinished. */
  rowsMissingTo: number[]
  spanRows: number
  eventRows: number
}

export function codeFamily(code: string): 'standby' | 'transit' | 'cargo' | 'other' {
  const c = code.toUpperCase()
  if (/^(S0\d|A01|WOW|D1)/.test(c)) return 'standby'
  if (/^I0\d/.test(c)) return 'transit'
  if (/^(DP1|L\d|L1F|L2E|B1)/.test(c)) return 'cargo'
  return 'other'
}

export function computeCoverage(tasks: TaskRowState[]): DayCoverage {
  interface Iv { start: number; end: number; kind: CoverageSegment['kind'] }
  const ivs: Iv[] = []
  const rowsMissingTo: number[] = []
  const eventTimes: number[] = []
  let spanRows = 0
  let eventRows = 0

  tasks.forEach((t, i) => {
    const a = parseClock(t.from_time)
    if (a === null) return
    if (t.kind === 'event') {
      eventRows++
      eventTimes.push(a)
      return
    }
    spanRows++
    const b = parseClock(t.to_time)
    if (b === null || b <= a) {
      if (t.from_time) rowsMissingTo.push(i)
      return
    }
    ivs.push({ start: a, end: b, kind: codeFamily(t.task_code) })
  })
  ivs.sort((x, y) => x.start - y.start)

  const segments: CoverageSegment[] = []
  const gaps: CoverageGap[] = []
  const addGap = (start: number, end: number) => {
    // Strictly inside: an event sitting exactly on a span's edge is that span's
    // bookend ("16:00 cast off"), not an account of the fourteen hours after it.
    const events = eventTimes.filter(m => m > start && m < end).length
    segments.push({ start, end, kind: 'gap', events })
    gaps.push({ start, end, events })
  }

  let cursor = 0
  for (const iv of ivs) {
    if (iv.start > cursor) addGap(cursor, iv.start)
    if (iv.end > cursor) {
      segments.push({ start: Math.max(iv.start, cursor), end: iv.end, kind: iv.kind })
      cursor = iv.end
    }
  }
  if (cursor < 1440) addGap(cursor, 1440)

  const coveredMin = segments.filter(sg => sg.kind !== 'gap').reduce((acc, sg) => acc + (sg.end - sg.start), 0)
  return {
    segments, coveredMin, gaps,
    silentGaps: gaps.filter(g => g.events === 0),
    eventTimes: eventTimes.sort((a, b) => a - b),
    rowsMissingTo, spanRows, eventRows,
  }
}

export const fmtMin = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** Leading number out of strings like '417.42 M3' / '92 MT (85%)'. */
export function leadingNumber(v: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(v)
  return m ? Number(m[0]) : null
}
