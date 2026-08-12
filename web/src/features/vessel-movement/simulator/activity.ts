// Ported verbatim from the original app.js — the analytics behind the vessel
// detail sheet: classifying task-log rows into plain-language activity
// buckets and aggregating standby time per location across every report.

import type { DailyReport } from '@/features/vessel-movement/api/types'
import type { SimContext } from './engine'
import { codeIsStandby, codeIsTransit } from './engine'

// The vessel is at the location and NOT working — no cargo, no hose, no crew
// transfer, nothing.  Standby-coded rows (S01-S05, A01) and "FWE" /
// finished-with-engine rows both land here: FWE is not a job, it is the captain
// noting the engines were shut down while the vessel sat, and it is logged as a
// row running ALONGSIDE the standby row for the same hours.
//
// IMPORTANT: what a "standby" row covers differs by place.  At the rigs the
// captains END the standby row the moment work starts (a DP1/L* row takes
// over), so standby-coded time really is idle time.  At Shuaiba port they do
// the opposite — one S04 row covers the ENTIRE alongside stay ("vessel a/side
// jetty #20, 00:00-10:14") and the fuel/cargo/crew rows are logged INSIDE that
// window.  Taken at face value that made "standby" at the berth mean "tied up
// alongside", which is not idleness at all.  So the aggregation below subtracts
// every worked interval from the standby window first: this line always means
// "no work was logged during these hours", at every location.
export const STANDBY_LABEL = 'Idle (no work logged)'

// Classify a NON-standby task-log row into a plain-language activity bucket so
// the standby table can show WHAT the vessel actually did during its stay at a
// location — cargo loading/unloading, water or fuel bunkering, crew transfer,
// provisions, etc.  Returns null for rows that should not be counted against a
// location's stay (transit between locations).
export function classifyActivity(
  code: string | null | undefined,
  label: string | null | undefined,
  desc: string | null | undefined,
): string | null {
  const c = (code || '').toUpperCase()
  const tl = `${label || ''} ${desc || ''}`.toLowerCase()
  if (codeIsTransit(c)) return null                   // movement, not at-location
  // Bunkering is detected from the DESCRIPTION first, because the captains
  // sometimes code a fuel/water hose transfer as "Cargo ops" (e.g. L1F).
  // Fresh / potable water transfer.  "\bfw\b" safely skips "FWE"/"F.W.E"
  // (= Finished With Engine) since those have no word boundary after "fw".
  if (/\bfw\b|\bdw\b|fresh water|potable|drinking water/.test(tl) && !/f\.?w\.?e/.test(tl))
    return 'Water bunkering'
  // Diesel / fuel-oil bunkering ("FO hose", "Rx FO", diesel, MGO, bunker).
  // Exclude consumable stat lines and slop-to-mud-tank transfers.
  if (/\bfo\b|fuel oil hose|diesel|\bmgo\b|\bd\.?o\.?\b|bunker/.test(tl) &&
      !/unpumpable|mud tank|slop/.test(tl))
    return 'Diesel bunkering'
  // Cargo: loading / unloading / back-load / lift handling (by code or words).
  if (/\bL\d|\bDP1\b|\bB1\b/.test(c) ||
      /cargo|lift|loading|unload|off ?load|back ?load|discharg|hand carry|\bh\.?c\b|basket/.test(tl))
    return 'Cargo loading / unloading'
  if (/provision|food|stores/.test(tl))             return 'Provisions'
  if (/\bpax\b|passenger|on.?signer|off.?signer|crew change/.test(tl)) return 'Crew / passenger transfer'
  if (/slop|mud tank/.test(tl))                      return 'Slop / mud transfer'
  // Base oil / brine transfer (captains write "base oil hose", "Rx base oil").
  if (/base ?oil|brine/.test(tl))                    return 'Base oil bunkering'
  // Break the old catch-all "Other" into the real jobs hiding inside code O1.
  if (/tank clean|mud tk|agitator|hetco/.test(tl))   return 'Tank cleaning'
  if (/inspection|coast guard|\bmoi\b|officer|\bhall\b/.test(tl)) return 'Inspection'
  if (/\bfwe\b|f\.w\.e|finish(ed)? ?me\b|finished with engine/.test(tl)) return STANDBY_LABEL
  if (/give way|waiting|stby at|standby for instruction|standby waiting|cancel ops/.test(tl)) return 'Waiting / giving way'
  if (/pull out|cast off|anchor|heave|aweigh|\bsbe\b|s\.b\.e|dp ?(setup|set up|mode|on|off)|500 ?m|proceed|shift|position|arriv|enter|outside|clear|underway|drop back/.test(tl))
    return 'Maneuvering'
  return 'Other activity'
}

export interface LocationRow {
  id: string
  /** Wall-clock time the vessel was at this location, overlaps removed. */
  stayMinutes: number
  /** Time broken down by what the vessel was doing; lines may overlap each other. */
  activities: { label: string; minutes: number }[]
  /** True when any two lines under this location ran at the same time. */
  hasOverlap: boolean
  name: string
  type: string
}

export interface LocationSummary {
  rows: LocationRow[]
  /** Wall-clock time across every location, overlaps removed. */
  total: number
  reportCount: number
}

// 'HH:MM' -> minutes past midnight. '24:00' (1440) is valid in these reports.
// Returns null for missing or unparseable values.
function parseClock(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim())
  if (!m) return null
  const min = Number(m[1]) * 60 + Number(m[2])
  return min >= 0 && min <= 1440 ? min : null
}

// Sort intervals and merge the ones that touch or overlap.
function mergeSpans(iv: [number, number][]): [number, number][] {
  const sorted = [...iv].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) { if (b > last[1]) last[1] = b }
    else out.push([a, b])
  }
  return out
}

// Total length of a set of intervals with overlaps counted once.
function unionMinutes(iv: [number, number][]): number {
  return mergeSpans(iv).reduce((s, [a, b]) => s + (b - a), 0)
}

// Minutes of `a` NOT covered by any interval in `b` — used to trim the worked
// hours out of a standby window so "idle" means genuinely idle.  Row counts
// per report are tiny, so the simple nested sweep is plenty.
function minutesOutside(a: [number, number][], b: [number, number][]): number {
  const cover = mergeSpans(b)
  let total = 0
  for (const [s, e] of mergeSpans(a)) {
    let cur = s
    for (const [cs, ce] of cover) {
      if (ce <= cur || cs >= e) continue
      if (cs > cur) total += cs - cur
      cur = ce
      if (cur >= e) break
    }
    if (cur < e) total += e - cur
  }
  return total
}

// Running total plus the current report's intervals. Times are times-of-day, so
// they only make sense within one report and are unioned as each report closes.
// `loose` catches rows with no usable timestamps, where duration_min is all we
// have — those can't be checked for overlap, so they are simply added.
interface Span {
  minutes: number
  spans: [number, number][]
  loose: number
}

function newSpan(): Span {
  return { minutes: 0, spans: [], loose: 0 }
}

function addRow(s: Span, from: number | null, to: number | null, mn: number) {
  if (from !== null && to !== null && to > from) s.spans.push([from, to])
  else s.loose += mn
}

// Fold one report's intervals into the running total, overlaps counted once.
function flushSpan(s: Span) {
  s.minutes += unionMinutes(s.spans) + s.loose
  s.spans = []
  s.loose = 0
}

// Per-location accumulator: the stay overall, plus one Span per activity label.
interface Acc {
  stay: Span
  byLabel: Map<string, Span>
}

function newAcc(): Acc {
  return { stay: newSpan(), byLabel: new Map() }
}

// Aggregate, across ALL of a vessel's daily reports, how long the vessel was at
// each location (rig / berth / port) and what it was doing there.  Rows whose
// own location_id is null inherit the last known location (location_id is the
// position at the END of a segment), carried forward across reports so an
// overnight stay is attributed to where the vessel actually was.
//
// Two things the captains' logs make tricky, and how they are handled here:
//
//  - "Standby" rows don't mean the same thing everywhere.  At the rigs they
//    end when work starts, but at the berth ONE standby row blankets the whole
//    alongside stay with the jobs logged inside it (see STANDBY_LABEL above).
//    So the worked intervals are subtracted from the standby window before it
//    is counted: the idle line is only the hours with no job logged, and it is
//    just one more line in the breakdown, never the headline.
//  - Rows DO overlap each other, and often describe ONE event twice: the same
//    cargo job is logged as "positioned a/side the P/S crane" (DP1, 06:40-08:10)
//    AND "deck cargo operation" (L2E, 06:55-08:05), and both classify as cargo.
//    So every line is the union of its own rows, not their sum — summing
//    inflated cargo at Oriental Phoenix by 45% (97h of rows over 67h of clock).
//
// Lines can still overlap EACH OTHER (a hose connected while cargo is worked),
// which is real parallel work rather than a duplicate description, so they stay
// separate; `hasOverlap` flags where they therefore exceed the stay.
export function timeByLocation(ctx: SimContext, reports: DailyReport[]): LocationSummary {
  const byLoc = new Map<string, Acc>()
  const touchedToday = new Set<Acc>()
  let lastLoc: string | null = null

  for (const rep of reports) {
    const rows = Array.isArray(rep.task_log) ? rep.task_log : []
    touchedToday.clear()
    for (const r of rows) {
      if (r.location_id) lastLoc = r.location_id
      const mn = r.duration_min || 0
      if (mn <= 0) continue
      // An explicit answer from the form beats the classifier's guess — that is
      // the whole point of asking. Transit still drops out: it is time between
      // locations, not time at one.
      const label = r.activity && !codeIsTransit(r.task_code)
        ? r.activity
        : codeIsStandby(r.task_code, r.task_label)
          ? STANDBY_LABEL
          : classifyActivity(r.task_code, r.task_label, r.description)
      if (!label) continue     // skip transit — time between locations, not at one

      const key = lastLoc || '__sea'
      let acc = byLoc.get(key)
      if (!acc) { acc = newAcc(); byLoc.set(key, acc) }
      touchedToday.add(acc)

      let lab = acc.byLabel.get(label)
      if (!lab) { lab = newSpan(); acc.byLabel.set(label, lab) }

      const from = parseClock(r.from_time)
      const to = parseClock(r.to_time)
      addRow(acc.stay, from, to, mn)
      addRow(lab, from, to, mn)
    }
    for (const acc of touchedToday) {
      flushSpan(acc.stay)
      // Idle first: trim every worked interval logged today at this location
      // out of the standby window, so overlap counts as the job, not as idle.
      const idle = acc.byLabel.get(STANDBY_LABEL)
      if (idle) {
        const worked: [number, number][] = []
        for (const [label, s] of acc.byLabel) {
          if (label !== STANDBY_LABEL) worked.push(...s.spans)
        }
        idle.minutes += minutesOutside(idle.spans, worked) + idle.loose
        idle.spans = []
        idle.loose = 0
      }
      for (const [label, lab] of acc.byLabel) {
        if (label !== STANDBY_LABEL) flushSpan(lab)
      }
    }
  }

  const out = [...byLoc.entries()].map(([id, acc]) => {
    const loc = ctx.locsById[id]
    const activities = [...acc.byLabel.entries()]
      .map(([label, s]) => ({ label, minutes: s.minutes }))
      .filter(a => a.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
    const stayMinutes = acc.stay.minutes
    return {
      id,
      stayMinutes,
      activities,
      hasOverlap: activities.reduce((s, a) => s + a.minutes, 0) > stayMinutes,
      name: loc ? (loc.name || loc.short || id) : (id === '__sea' ? 'At anchor / untagged' : id),
      type: loc ? loc.type : 'sea',
    }
  }).sort((a, b) => b.stayMinutes - a.stayMinutes)

  return {
    rows: out,
    total: out.reduce((s, r) => s + r.stayMinutes, 0),
    reportCount: reports.length,
  }
}

// Clean up multi-line free text from the PDFs: collapse whitespace, drop
// standalone page/section numbers, and re-join mid-sentence line wraps.
export function tidyText(s: unknown): string {
  const lines = String(s ?? '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => !/^\d{1,3}$/.test(l)) // remove standalone page/section numbers

  const out: string[] = []
  for (const line of lines) {
    if (!line) { if (out.length && out[out.length - 1] !== '') out.push(''); continue }
    const prev = out.length ? out[out.length - 1] : ''
    // Join onto previous line when this line is a mid-sentence continuation:
    // previous didn't end a sentence and this line starts lowercase / punctuation.
    if (prev && !/[.:!?]$/.test(prev) && /^[a-z,)"'–—-]/.test(line)) {
      out[out.length - 1] = prev + ' ' + line
    } else {
      out.push(line)
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
