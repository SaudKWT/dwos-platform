import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { HubConnectionBuilder } from '@microsoft/signalr'
import { useQueryClient } from '@tanstack/react-query'
import { Moon, Ship, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toggleTheme, useTheme } from '@/lib/theme'
import { useHealth } from '@/api/queries'
import FormsPage from '@/pages/FormsPage'
import MapPage from '@/pages/MapPage'
import ReportsPage from '@/pages/ReportsPage'

function StatusPill() {
  const { data, isError, isLoading } = useHealth()

  const [tone, text] = isLoading
    ? ['bg-muted-foreground', 'connecting…']
    : isError || !data?.database
      ? ['bg-destructive', 'API unreachable']
      : ['bg-emerald-500', `${data.vessels} vessels · ${data.reports} reports`]

  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn('h-2 w-2 rounded-full', tone)} />
      {text}
    </span>
  )
}

/**
 * Live updates over SignalR — replaces the old SSE stream. When a captain
 * submits a report (or a plan lands) in another session, every open dashboard
 * refetches and the simulator picks it up without a reload.
 */
function useLiveUpdates() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const conn = new HubConnectionBuilder()
      .withUrl('/hubs/live')
      .withAutomaticReconnect()
      .build()

    conn.on('report_saved', () => {
      queryClient.invalidateQueries({ queryKey: ['reports'] })
      queryClient.invalidateQueries({ queryKey: ['all-reports'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    })
    conn.on('plan_saved', () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] })
    })

    conn.start().catch(() => { /* API down — queries still work on refetch */ })
    return () => { conn.stop() }
  }, [queryClient])
}

function ThemeButton() {
  const theme = useTheme()
  return (
    <button
      type="button"
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
      className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}

export default function App() {
  useLiveUpdates()
  const tab = ({ isActive }: { isActive: boolean }) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm transition-colors',
      isActive
        ? 'bg-secondary text-secondary-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
    )

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b px-4 py-2.5">
        <div className="flex items-center gap-2 font-semibold">
          <Ship className="h-5 w-5 text-primary" />
          <span>Vessel Movement</span>
        </div>
        <nav className="flex gap-1">
          <NavLink to="/map" className={tab}>Map</NavLink>
          <NavLink to="/reports" className={tab}>Daily Reports</NavLink>
          <NavLink to="/forms" className={tab}>Forms</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <StatusPill />
          <ThemeButton />
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/map" replace />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/forms" element={<FormsPage />} />
        </Routes>
      </main>
    </div>
  )
}
