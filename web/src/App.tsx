import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { Toaster } from '@/components/ui/sonner'
import DwosShell from '@/shell/DwosShell'
import TeamOverview from '@/pages/TeamOverview'
import NotBuiltPage from '@/pages/NotBuiltPage'
import MapPage from '@/features/vessel-movement/pages/MapPage'
import ReportsPage from '@/features/vessel-movement/pages/ReportsPage'
import FormsPage from '@/features/vessel-movement/pages/FormsPage'
import PlanPage from '@/features/vessel-movement/pages/PlanPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The snapshot cannot change under us, so a refetch on every window focus
      // is pure work. Point this back at the defaults when the live API lands.
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DwosShell>
          <Routes>
            <Route path="/" element={<TeamOverview />} />

            {/* Unit 4 · Offshore — the Vessel Movement application. */}
            <Route path="/unit-4/vessels/map" element={<MapPage />} />
            <Route path="/unit-4/vessels/reports" element={<ReportsPage />} />
            <Route path="/unit-4/vessels/forms" element={<FormsPage />} />
            <Route path="/unit-4/vessels/plan" element={<PlanPage />} />
            <Route path="/unit-4/vessels" element={<Navigate to="/unit-4/vessels/map" replace />} />

            {/*
              Everything else in the nav is configured but not built. It routes
              to a page that says so and names the table it would read, rather
              than to a blank screen or a 404 — a nav item that goes nowhere is a
              bug report waiting to happen, and one that goes somewhere honest is
              a roadmap.
            */}
            <Route path="*" element={<NotBuiltPage />} />
          </Routes>
        </DwosShell>
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
