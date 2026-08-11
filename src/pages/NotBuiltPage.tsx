import { useLocation } from 'react-router-dom'
import { Construction } from 'lucide-react'

import { PageHeader } from '@/components/ui/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DWOS } from '@/config/dwos'
import { UNIT_BINDINGS, unitScopeReady } from '@/config/schema-binding'
import { teamItems } from '@/lib/org'

/**
 * The honest landing for a nav item that is configured but not implemented.
 *
 * Every entry in the DWOS config except the Vessel Movement screens is a
 * placeholder. Routing them to a blank page or a 404 makes the nav look broken;
 * routing them here says what is missing and what it will read, which is the
 * difference between an unfinished product and a plan.
 */

/** Which schema0726 table each placeholder screen will be built on. */
const BACKING_TABLE: Record<string, string> = {
  ddr: 'dbo.Drilling, joined to dbo.Well and dbo.RigInfo',
  rigs: 'dbo.RigInfo, joined to dbo.Rig and dbo.Activity',
  npt: 'dbo.Drilling.NPTOngoing, with dbo.Activity for the reason',
  programmes: 'dbo.WellProfile and dbo.WellInfo',
  materials: 'not yet modelled in schema0726',
  kpi: 'dbo.Drilling and dbo.Workover, aggregated by TeamID',
  availability: 'dbo.RigInfo, joined to dbo.Contract',
  register: 'dbo.Well filtered to the water-well type',
  maintenance: 'not yet modelled in schema0726',
  jobs: 'dbo.Workover, joined to dbo.Well',
  slickline: 'dbo.Workover, filtered by dbo.Activity',
  reports: 'dbo.Drilling and dbo.Workover',
  logistics: 'not yet modelled in schema0726',
  crew: 'not yet modelled in schema0726',
  invoicing: 'dbo.AFE, dbo.AFEInfo and dbo.Contract',
  gis: 'dbo.Well.Latitude / .Longitude and dbo.MarineLocation',
}

export default function NotBuiltPage() {
  const { pathname } = useLocation()

  const item = teamItems(DWOS).find(
    i => pathname === i.href || pathname.startsWith(i.href + '/'),
  )
  const unitId = /^\/(unit-\d+)\b/.exec(pathname)?.[1]
  const unit = DWOS.units.find(u => u.id === unitId)
  const leaf = pathname.split('/').filter(Boolean).pop() ?? ''
  const backing = BACKING_TABLE[leaf]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4">
        <PageHeader
          title={item?.label ?? 'Not found'}
          description={
            item
              ? 'Configured in the team config, not implemented yet.'
              : 'No screen is configured at this address.'
          }
          breadcrumbs={
            unit
              ? [{ label: unit.name ?? unit.label }, { label: item?.label ?? leaf }]
              : item
                ? [{ label: 'Team-wide' }, { label: item.label }]
                : undefined
          }
        />

        <Alert className="mt-4">
          <Construction />
          <AlertTitle>This screen has not been built</AlertTitle>
          <AlertDescription>
            <p>
              It exists in <code className="font-mono text-xs">src/config/dwos.ts</code> so the
              shape of the dashboard is reviewable before the screens are written. The Vessel
              Movement app under Unit 4 · Offshore is the one that is real.
            </p>
            {backing && (
              <p className="mt-2">
                It will read <span className="font-mono text-xs">{backing}</span>.
              </p>
            )}
            {unit && !unitScopeReady(unit.id) && (
              <p className="mt-2">
                {unit.label} has no <span className="font-mono text-xs">TeamID</span> binding yet
                either — see <code className="font-mono text-xs">src/config/schema-binding.ts</code>.
                Without it a unit screen cannot filter{' '}
                <span className="font-mono text-xs">dbo.RigInfo</span> to this unit, and an
                unscoped query looks entirely normal while showing the whole directorate.
              </p>
            )}
          </AlertDescription>
        </Alert>

        <p className="mt-4 text-xs text-muted-foreground">
          {Object.keys(UNIT_BINDINGS).length} units configured · 1 application implemented
        </p>
      </div>
    </div>
  )
}
