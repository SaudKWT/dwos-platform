import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Table2 } from 'lucide-react'

import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

import DayBrowser, { type DayBrowserFocus } from './DayBrowser'
import { useReportIndex, useVessels } from '../api/queries'
import type { ReportIndexRow } from '../api/types'

/**
 * Daily vessel reports — 256 of them, in the two shapes people actually want.
 *
 * "Browse by day" is the reader: pick a day, read a report, arrow-key through
 * the calendar. It is the right shape for the daily question ("what did the
 * fleet do yesterday?") and it is the app's original screen, kept because a
 * table would be a downgrade for that job.
 *
 * "All reports" is the list view: sortable, filterable, paginated. It is the
 * right shape for the other question ("when did CA5 last file?", "which days
 * are missing a report?"), which the day browser makes you scroll for.
 *
 * Two tabs rather than two nav items: it is one dataset and one destination,
 * and a nav that lists the same thing twice makes people choose before they
 * know which one they need.
 */
export default function ReportsPage() {
  const index = useReportIndex()
  const vessels = useVessels()
  const navigate = useNavigate()
  const [tab, setTab] = useState('day')
  const [focus, setFocus] = useState<DayBrowserFocus>()

  const vesselName = (id: string) =>
    (vessels.data ?? []).find(v => v.id === id)?.name ?? id

  const rows = useMemo(
    () => (index.data ?? []).map(r => ({ ...r, vessel_name: vesselName(r.vessel_id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index.data, vessels.data],
  )

  const columns = useMemo(
    () => [
      {
        accessorKey: 'report_date',
        header: 'Date',
        cell: ({ row }: { row: { original: ReportIndexRow } }) => (
          <span className="font-mono text-xs">{row.original.report_date}</span>
        ),
      },
      { accessorKey: 'vessel_name', header: 'Vessel' },
      {
        accessorKey: 'task_log_rows',
        header: 'Log rows',
        // Numeric alignment is declared, not styled: `meta.numeric` right-aligns
        // the header and the cells together so they cannot drift apart.
        meta: { numeric: true },
      },
      {
        accessorKey: 'source_type',
        header: 'Source',
        cell: ({ row }: { row: { original: ReportIndexRow } }) => {
          const src = row.original.source_type ?? 'unknown'
          return (
            <Badge variant={src === 'dashboard_submission' ? 'default' : 'secondary'}>
              {src.replace(/_/g, ' ')}
            </Badge>
          )
        },
      },
      {
        id: 'open',
        header: '',
        cell: ({ row }: { row: { original: ReportIndexRow } }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Hand the row to the reader and switch to it. The nonce makes
              // re-opening the same report re-focus rather than no-op.
              setFocus(f => ({
                date: row.original.report_date,
                vesselId: row.original.vessel_id,
                nonce: (f?.nonce ?? 0) + 1,
              }))
              setTab('day')
            }}
          >
            Open
          </Button>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-2">
        <PageHeader
          title="Daily vessel reports"
          description="One per vessel per day, from the captains' PDFs and from this dashboard's own form."
          breadcrumbs={[{ label: 'Offshore' }, { label: 'Marine logistics' }, { label: 'Daily reports' }]}
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate('/unit-4/vessels/forms')}>
              File a report
            </Button>
          }
        />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 w-fit">
          <TabsTrigger value="day" className="gap-1.5">
            <CalendarDays className="size-3.5" /> Browse by day
          </TabsTrigger>
          <TabsTrigger value="all" className="gap-1.5">
            <Table2 className="size-3.5" /> All reports
          </TabsTrigger>
        </TabsList>

        <TabsContent value="day" className="min-h-0 flex-1">
          <DayBrowser focus={focus} />
        </TabsContent>

        <TabsContent value="all" className="min-h-0 flex-1 overflow-y-auto p-4">
          <DataTable
            caption="Every daily vessel report on file, newest first"
            columns={columns}
            data={rows}
            loading={index.isLoading}
            filterColumn="vessel_name"
            filterPlaceholder="Filter by vessel…"
            pageSize={15}
            empty={{
              title: 'No reports on file',
              description: 'Reports arrive from the captains’ PDFs, or from the form on this dashboard.',
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
