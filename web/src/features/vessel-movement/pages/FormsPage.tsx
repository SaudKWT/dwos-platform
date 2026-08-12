import { PageHeader } from '@/components/ui/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Database } from 'lucide-react'

import ReportForm from '../report-form/ReportForm'
import { SNAPSHOT_IS_READ_ONLY } from '../api/client'

/**
 * The captain's Daily Vessel Report — one per vessel per day.
 *
 * The form itself is unchanged from the standalone app: the row model, the
 * span/event distinction, the coverage strip, the tank config and the draft
 * store all live in ../report-form and are driven by a round-trip parity test
 * that proves a form submission reproduces an imported PDF exactly. What the
 * dashboard adds is the page frame and an honest note about where a submission
 * goes while this runs on a snapshot.
 *
 * The PDF bulk-import card from the standalone app is deliberately absent here:
 * parsing a PDF needs the server, and a drop zone that silently fails is worse
 * than no drop zone.
 */
export default function FormsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4">
        <PageHeader
          title="File a daily vessel report"
          description="One per vessel per day. Spans account for the 24 hours; events mark the moment something happened."
          breadcrumbs={[{ label: 'Offshore' }, { label: 'Marine logistics' }, { label: 'File a report' }]}
        />

        {SNAPSHOT_IS_READ_ONLY && (
          <Alert className="mt-4">
            <Database />
            <AlertTitle>Submissions are held for this session only</AlertTitle>
            <AlertDescription>
              This dashboard reads a snapshot of <span className="font-mono text-xs">dbo.VesselDailyReport</span>,
              not the live database. A submitted report appears in the reports list and in the map
              playback immediately, and is gone on reload. The payload is the real one — the same
              JSON the PDF importer writes.
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-4">
          <ReportForm />
        </div>
      </div>
    </div>
  )
}
