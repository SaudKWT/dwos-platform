import { useSyncExternalStore } from 'react'

/**
 * Theme state, as a class on the root element.
 *
 * The KOC token layer keys dark mode off `.dark` (see the `@custom-variant` in
 * styles.css), and the vessel map needs to know the same thing to pick its tile
 * layer — a light basemap under a dark shell is unreadable. One source of truth
 * for both, subscribed to rather than read once, so the map re-tiles on toggle.
 *
 * Light is the default here, unlike the standalone vessel app where dark was:
 * this is an office dashboard first and a bridge display second. The preference
 * is remembered either way.
 */

export type Theme = 'dark' | 'light'

const KEY = 'dwos-theme'

let theme: Theme = readStored()
const listeners = new Set<() => void>()

function readStored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyClass(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
}

applyClass(theme)

export function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark'
  try { localStorage.setItem(KEY, theme) } catch { /* private mode — the class still applies */ }
  applyClass(theme)
  listeners.forEach(l => l())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb) },
    () => theme,
  )
}
