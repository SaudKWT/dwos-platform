// Local drafts for the Daily Vessel Report, keyed by vessel and date.
//
// The form used to autosave into one key, `vm.dvr.draft.v1`: start a second
// vessel's report and the first one was gone, with the restore banner offering
// the survivor as though nothing had happened. A captain filling 25 rows on a
// moving vessel must never lose work, so each vessel/date gets its own slot and
// the form lists whatever is waiting.

import { hydrateFormState, type ReportFormState } from './model'

const KEY = 'vm.dvr.drafts.v2'
const LEGACY_KEY = 'vm.dvr.draft.v1'
const MAX_DRAFTS = 12

export interface DraftEntry {
  key: string
  vesselId: string
  reportDate: string
  savedAt: number
  state: ReportFormState
}

type Store = Record<string, Omit<DraftEntry, 'key'>>

export const draftKey = (vesselId: string, reportDate: string): string =>
  `${vesselId || '—'}|${reportDate || '—'}`

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) as Store : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function write(store: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)) }
  catch { /* storage full or blocked — drafts are best-effort, never load-bearing */ }
}

/** Everything waiting, newest first. */
export function listDrafts(): DraftEntry[] {
  return Object.entries(read())
    .filter(([, d]) => d && Array.isArray(d.state?.tasks))
    .map(([key, d]) => ({ key, ...d, state: hydrateFormState(d.state) }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

export function saveDraft(state: ReportFormState): void {
  const store = read()
  const key = draftKey(state.vesselId, state.reportDate)
  store[key] = {
    vesselId: state.vesselId, reportDate: state.reportDate, savedAt: Date.now(), state,
  }
  // Typing starts before the header is complete, so the first keystrokes land
  // under a partial key ('CH3|—'). Once the vessel and date are both set, that
  // half-identified draft is this one — drop it rather than offer it back.
  if (state.vesselId && state.reportDate) {
    delete store[draftKey(state.vesselId, '')]
    delete store[draftKey('', '')]
  }
  // Oldest out first, so a long shift's worth of real drafts survives.
  const keys = Object.keys(store).sort((a, b) => store[b].savedAt - store[a].savedAt)
  for (const k of keys.slice(MAX_DRAFTS)) delete store[k]
  write(store)
}

export function removeDraft(key: string): void {
  const store = read()
  delete store[key]
  write(store)
}

/**
 * A form worth remembering: anything beyond the untouched starting state. Stops
 * an empty tab from filling a slot and putting a restore banner in front of the
 * next person to open the page.
 */
export function isWorthSaving(f: ReportFormState): boolean {
  if (f.vesselId || f.reportDate || f.voyageNo || f.compiledName) return true
  if (f.crew.length) return true
  if (f.requirements || f.issuesComments || f.accidentSummary) return true
  return f.tasks.some(t => t.description.trim() || t.to_time || t.location_id ||
    t.activity || (t.from_time && t.from_time !== '00:00'))
}

/** One-time move of the old single-slot draft into the keyed store. */
export function migrateLegacyDraft(): void {
  let raw: string | null = null
  try { raw = localStorage.getItem(LEGACY_KEY) } catch { return }
  if (!raw) return
  try {
    const state = JSON.parse(raw) as ReportFormState
    if (state && Array.isArray(state.tasks) && isWorthSaving(state)) saveDraft(state)
  } catch { /* unreadable legacy draft — nothing to rescue */ }
  try { localStorage.removeItem(LEGACY_KEY) } catch { /* ignore */ }
}
