// Ported verbatim from the original app.js — the analytics behind the vessel
// detail sheet: classifying task-log rows into plain-language activity
// buckets and aggregating standby time per location across every report.

import type { DailyReport } from '@/api/types'
import type { SimContext } from './engine'
import { codeIsStandby, codeIsTransit } from './engine'

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
  if (/\bfwe\b|f\.w\.e|finish(ed)? ?me\b|finished with engine/.test(tl)) return 'Idle (engines off)'
  if (/give way|waiting|stby at|standby for instruction|standby waiting|cancel ops/.test(tl)) return 'Waiting / giving way'
  if (/pull out|cast off|anchor|heave|aweigh|\bsbe\b|s\.b\.e|dp ?(setup|set up|mode|on|off)|500 ?m|proceed|shift|position|arriv|enter|outside|clear|underway|drop back/.test(tl))
    return 'Maneuvering'
  return 'Other activity'
}

export interface StandbyRow {
  id: string
  minutes: number
  activities: { label: string; minutes: number }[]
  stayMinutes: number
  name: string
  type: string
}

export interface StandbySummary {
  rows: StandbyRow[]
  total: number
  reportCount: number
}

// Aggregate, across ALL of a vessel's daily reports, how long it sat in a
// standby task at each location (rig / berth / port) AND what activities it
// performed there.  Rows whose own location_id is null inherit the last known
// location (location_id is the position at the END of a segment), carried
// forward across reports so an overnight standby is attributed to where the
// vessel actually was.
export function standbyByLocation(ctx: SimContext, reports: DailyReport[]): StandbySummary {
  const totals = new Map<string, number>()   // locId -> standby minutes
  const acts = new Map<string, Map<string, number>>()   // locId -> activity label -> minutes
  let lastLoc: string | null = null
  let total = 0
  for (const rep of reports) {
    const rows = Array.isArray(rep.task_log) ? rep.task_log : []
    for (const r of rows) {
      if (r.location_id) lastLoc = r.location_id
      const mn = r.duration_min || 0
      if (mn <= 0) continue
      const key = lastLoc || '__sea'
      if (codeIsStandby(r.task_code, r.task_label)) {
        totals.set(key, (totals.get(key) || 0) + mn)
        total += mn
      } else {
        const cat = classifyActivity(r.task_code, r.task_label, r.description)
        if (!cat) continue     // skip transit
        if (!acts.has(key)) acts.set(key, new Map())
        const m = acts.get(key)!
        m.set(cat, (m.get(cat) || 0) + mn)
      }
    }
  }
  const keys = new Set([...totals.keys(), ...acts.keys()])
  const out = [...keys].map(id => {
    const loc = ctx.locsById[id]
    const am = acts.get(id) || new Map<string, number>()
    const activities = [...am.entries()]
      .map(([label, minutes]) => ({ label, minutes }))
      .sort((a, b) => b.minutes - a.minutes)
    const standby = totals.get(id) || 0
    return {
      id,
      minutes: standby,
      activities,
      // Rank locations by the full time spent there (standby + activity).
      stayMinutes: standby + activities.reduce((s, x) => s + x.minutes, 0),
      name: loc ? (loc.name || loc.short || id) : (id === '__sea' ? 'At anchor / untagged' : id),
      type: loc ? loc.type : 'sea',
    }
  }).sort((a, b) => b.stayMinutes - a.stayMinutes)
  return { rows: out, total, reportCount: reports.length }
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
