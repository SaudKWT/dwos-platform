import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Ship } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHealth } from '@/api/queries'
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

export default function App() {
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
        </nav>
        <div className="ml-auto">
          <StatusPill />
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/map" replace />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/reports" element={<ReportsPage />} />
        </Routes>
      </main>
    </div>
  )
}
