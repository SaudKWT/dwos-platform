import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, Ship, Waves } from 'lucide-react'

import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DWOS } from '@/config/dwos'
import { useReportIndex, useVessels } from '@/features/vessel-movement/api/queries'

/**
 * The team landing page — what the whole team can see, across units.
 *
 * The only numbers here are ones this dashboard can actually stand behind: they
 * come from the Vessel Movement snapshot, which is real data. There is no
 * "rigs drilling" or "NPT this month" tile, because nothing behind those exists
 * yet and a dashboard whose headline figures are decorative teaches people not
 * to trust the ones that are not.
 */
export default function TeamOverview() {
  const vessels = useVessels()
  const reports = useReportIndex()

  const stats = useMemo(() => {
    const fleet = vessels.data ?? []
    const index = reports.data ?? []
    const inService = fleet.filter(v => !v.retired_on).length
    const latest = index[0]?.report_date ?? null
    const filedOnLatest = latest ? index.filter(r => r.report_date === latest).length : 0
    return { inService, total: index.length, latest, filedOnLatest }
  }, [vessels.data, reports.data])

  const unitCount = DWOS.units.length

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-4">
        <PageHeader
          title={DWOS.name}
          description={`${DWOS.directorate} Directorate · ${DWOS.group} Group · ${unitCount} units`}
          meta={
            <span className="text-xs text-muted-foreground">
              Vessel figures are live from the snapshot. Every other screen in the nav is
              configured but not built.
            </span>
          }
        />

        <section className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Vessels in service"
            value={stats.inService}
            icon={<Ship className="size-4" />}
          />
          <StatCard
            label="Daily reports on file"
            value={stats.total}
            icon={<ClipboardList className="size-4" />}
          />
          <StatCard
            label="Filed on the latest day"
            value={stats.filedOnLatest}
            unit={stats.latest ? `of ${stats.inService}` : undefined}
            icon={<Waves className="size-4" />}
          />
        </section>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-sm">Units</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {DWOS.units.map(u => {
              const apps = u.groups.reduce((n, g) => n + g.items.length, 0)
              const first = u.groups[0]?.items[0]
              return (
                <Link
                  key={u.id}
                  to={first?.href ?? '/'}
                  className="flex items-baseline justify-between rounded-md border border-border px-3 py-2 text-sm transition-colors duration-fast ease-out hover:bg-accent"
                >
                  <span>
                    <span className="font-medium">{u.name}</span>{' '}
                    <span className="text-xs text-muted-foreground">{u.label}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{apps} screens</span>
                </Link>
              )
            })}
          </CardContent>
        </Card>

        <Alert className="mt-4">
          <Ship />
          <AlertTitle>Vessel Movement lives under Unit 4 · Offshore</AlertTitle>
          <AlertDescription>
            It is scoped to the unit rather than shared team-wide because the fleet serves the
            offshore rigs specifically — Oriental Phoenix and Oriental Dragon-1 are Unit 4's.
            Invoicing and GIS are the genuinely shared ones, and they sit in the team-wide zone
            at the bottom of the sidebar.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  )
}
