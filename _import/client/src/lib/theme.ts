import { useSyncExternalStore } from 'react'

// Dark is the default — the crews read this on a bridge at night. The light
// theme swaps both the CSS variables (via the .light class) and the map tiles
// (the map subscribes through useTheme and picks its tile URL).

export type Theme = 'dark' | 'light'

let theme: Theme = (localStorage.getItem('vm-theme') as Theme) || 'dark'
const listeners = new Set<() => void>()

applyClass(theme)

function applyClass(t: Theme) {
  document.documentElement.classList.toggle('light', t === 'light')
}

export function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('vm-theme', theme)
  applyClass(theme)
  listeners.forEach(l => l())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb) },
    () => theme,
  )
}
