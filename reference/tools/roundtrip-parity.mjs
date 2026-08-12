// Round-trip parity test for the Daily Vessel Report form model.
//
// Guarantee under test: prefill the form from an imported PDF report, submit
// without touching anything, and the payload must carry every field the
// importer wrote — a captain filling the form gets identical analytics to a
// captain emailing a PDF.
//
// Run:  node --experimental-strip-types reference/tools/roundtrip-parity.mjs
// (model.ts is erasable TypeScript; its only TS import is `import type`)

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// reference/tools/ -> repo root is two levels up, not one.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { reportToFormState, formStateToPayload } =
  await import(pathToFileURL(join(root, 'web/src/features/vessel-movement/report-form/model.ts')).href)

// null / undefined / '' are the same "empty" for comparison; numbers compare
// loosely against their string forms (the form keeps strings).
const empty = v => v == null || v === ''
const eq = (a, b) => {
  if (empty(a) && empty(b)) return true
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim()
  return String(a ?? '').trim() === String(b ?? '').trim()
}

const LIQUIDS = ['fuel_oil', 'fresh_water', 'drill_water', 'base_oil']
const LIQ_FIELDS = ['loaded', 'discharged', 'consumed', 'rob', 'max_capacity', 'remaining_to_load', 'remarks']

const dir = join(root, 'reference/data/daily-reports')
const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').sort()

let reports = 0
let fieldMismatches = 0
let durationDiffs = 0
const problems = new Map()   // message -> count (first file kept)

function flag(msg, file) {
  fieldMismatches++
  const k = msg
  if (!problems.has(k)) problems.set(k, { count: 0, file })
  problems.get(k).count++
}

for (const file of files) {
  const orig = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  reports++
  const out = formStateToPayload(reportToFormState(orig))

  for (const k of ['vessel_id', 'report_date', 'period_end', 'voyage_no', 'security_level',
                   'days_since_port_call', 'next_crew_change', 'requirements_next_port_call',
                   'issues_comments', 'accident_summary']) {
    if (!eq(orig[k], out[k])) flag(`top-level ${k}`, file)
  }
  for (const k of ['accidents', 'incidents', 'near_miss']) {
    if (!eq(orig.safety?.[k], out.safety?.[k])) flag(`safety.${k}`, file)
  }
  for (const liq of LIQUIDS) {
    for (const k of LIQ_FIELDS) {
      if (!eq(orig.consumables?.[liq]?.[k], out.consumables?.[liq]?.[k])) flag(`consumables.${liq}.${k}`, file)
    }
  }
  for (const k of ['on_deck', 'loaded', 'discharged', 'utilization_pct']) {
    if (!eq(orig.lifts?.[k], out.lifts?.[k])) flag(`lifts.${k}`, file)
  }
  for (const k of ['dry_store_days', 'fresh_frozen_days', 'drinking_water_days', 'fuel_oil_unpumpable']) {
    if (!eq(orig.provisions?.[k], out.provisions?.[k])) flag(`provisions.${k}`, file)
  }
  for (const k of ['arrival_time', 'departure_time']) {
    if (!eq(orig.delays?.[k], out.delays?.[k])) flag(`delays.${k}`, file)
  }
  if (!eq(orig.compiled_by?.name, out.compiled_by?.name)) flag('compiled_by.name', file)
  if (!eq(orig.compiled_by?.role, out.compiled_by?.role)) flag('compiled_by.role', file)

  const oCrew = Array.isArray(orig.crew) ? orig.crew : []
  const nCrew = Array.isArray(out.crew) ? out.crew : []
  if (oCrew.length !== nCrew.length) flag('crew.length', file)
  else oCrew.forEach((c, i) => {
    for (const k of ['first', 'last', 'position', 'days_onboard', 'sign_on_date', 'planned_crew_change']) {
      if (!eq(c[k], nCrew[i]?.[k])) flag(`crew.${k}`, file)
    }
  })

  const oT = orig.task_log ?? []
  const nT = out.task_log ?? []
  if (oT.length !== nT.length) { flag(`task_log.length (${oT.length} -> ${nT.length})`, file); continue }
  oT.forEach((t, i) => {
    const n = nT[i]
    // `activity` is form-only and absent from every import: it must round-trip
    // as absent, never as a value the form invented from its own guess.
    for (const k of ['from_time', 'to_time', 'task_code', 'description', 'activity',
                     'location_id', 'from_location_id', 'to_location_id']) {
      if (!eq(t[k], n[k])) flag(`task_log.${k}`, file)
    }
    // A junk imported label that just echoes the code ("L1f", "Dp1") is
    // deliberately upgraded to the official vocabulary — not a mismatch.
    const junkLabel = String(t.task_label ?? '').toLowerCase() === String(t.task_code ?? '').toLowerCase()
    if (!junkLabel && !eq(t.task_label, n.task_label)) flag(`task_log.task_label ("${t.task_label}" -> "${n.task_label}")`, file)
    // duration_min informational: the form recomputes it from the clock times.
    if (t.duration_min != null && n.duration_min != null && t.duration_min !== n.duration_min) durationDiffs++
  })
}

console.log(`\n${reports} reports round-tripped`)
console.log(`${fieldMismatches} field mismatches, ${durationDiffs} recomputed-duration differences`)
if (problems.size) {
  console.log('\nMismatch breakdown:')
  for (const [msg, { count, file }] of [...problems.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(count).padStart(4)}x  ${msg}   (first: ${file})`)
  }
  process.exit(1)
}
console.log('PARITY OK — the form reproduces every imported report exactly.')
