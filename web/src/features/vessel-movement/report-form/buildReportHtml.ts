// Print-ready Daily Vessel Report — ported from the legacy admin.js
// generatePdf() and kept visually faithful to the official Halliburton
// template (pink headers, tank table, codes legend, sign-off page).
// The captain opens it in a new window and uses Print -> Save as PDF, so the
// output can be emailed exactly like the reports that used to come back as
// PDF attachments. Extended over the legacy version:
//   - all four tracked liquids (fuel, fresh water, drill water, base oil)
//     print their real values, including Loaded / Discharged / Rem. to load
//   - the crew list from the form fills page 3 instead of blank rows
//   - vessel names come from the fleet API instead of a hardcoded map

import type { DailyReport } from '@/features/vessel-movement/api/types'

// Fixed tank rows of the official template that the app does not track —
// printed as blanks for the captain to fill by hand if used.
const TANK_TEMPLATE: { name: string; max: string; sub?: string }[] = [
  { name: 'Baroid Tank 1', max: '92 MT (85%)', sub: 'Product type: BARITE' },
  { name: 'Cement Tank 2', max: '65 MT (85%)', sub: 'HEAVY BLENDED' },
  { name: 'Baroid Tank 3', max: '41 MT (85%)', sub: 'Product type: BENTONITE' },
  { name: 'Cement Tank 4', max: '65 MT (85%)', sub: 'LIGHT CEMENT' },
  { name: 'Baroid Tank 5', max: '92 MT (85%)', sub: 'Product type: BARITE' },
  { name: 'Baroid Tank 6', max: '92 MT (85%)', sub: 'Product type: BARITE' },
  { name: 'Mud Tk #1', max: '1062 Bbls (80%)', sub: 'SOBM 19.5 PPG' },
  { name: 'Mud Tk #2', max: '1062 Bbls (80%)', sub: 'SOBM 19.5 PPG' },
  { name: 'Mud Tk #3', max: '1062 Bbls (80%)', sub: 'SOBM 22 PPG' },
  { name: 'Mud Tk #4', max: '1000 Bbls (80%)', sub: 'SOBM 19.5 PPG' },
  { name: 'Brine', max: '' },
]

function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ''
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

function durationHM(from?: string | null, to?: string | null): string {
  if (!from || !to) return ''
  const p = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const a = p(from)
  const b = p(to)
  if (a === null || b === null) return ''
  let mins = b - a
  if (mins < 0) mins += 24 * 60
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

const dash = (v: unknown): string => (v != null && String(v).trim() ? escapeHtml(v) : '-')

type Liquid = { loaded?: unknown; discharged?: unknown; consumed?: unknown; rob?: unknown; max_capacity?: unknown; remaining_to_load?: unknown; remarks?: unknown }

function liquidRow(name: string, l: Liquid | undefined, fallbackMax = ''): string {
  const o = l ?? {}
  return `
    <tr>
      <td class="tank-name">${escapeHtml(name)}</td>
      <td>${dash(o.max_capacity ?? fallbackMax)}</td>
      <td>${dash(o.consumed)}</td>
      <td>${dash(o.discharged)}</td>
      <td>${dash(o.rob)}</td>
      <td>${dash(o.remaining_to_load)}</td>
      <td>${dash(o.loaded)}</td>
      <td>${escapeHtml(o.remarks ?? '')}</td>
    </tr>`
}

export function buildReportHTML(p: DailyReport, vesselName: string): string {
  const cons = (p.consumables ?? {}) as Record<string, Liquid>

  const tanksRows = TANK_TEMPLATE.map(t => `
    <tr>
      <td class="tank-name">${escapeHtml(t.name)}${t.sub ? `<div class="sub">${escapeHtml(t.sub)}</div>` : ''}</td>
      <td>${escapeHtml(t.max)}</td>
      <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td></td>
    </tr>`).join('')

  const taskRows = (p.task_log || []).map(r => `
    <tr>
      <td>${escapeHtml(r.from_time || '')}</td>
      <td>${escapeHtml(r.to_time || '')}</td>
      <td>${escapeHtml(durationHM(r.from_time, r.to_time))}</td>
      <td class="bold">${escapeHtml(r.task_code || '')}</td>
      <td class="task-desc">${escapeHtml(r.description || '')}</td>
    </tr>`).join('')

  const pad = Math.max(0, 18 - (p.task_log?.length || 0))
  const padRows = '<tr><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(pad)

  const crew = (Array.isArray(p.crew) ? p.crew as Record<string, unknown>[] : [])
  const crewRows = crew.map(c => `
    <tr>
      <td>${escapeHtml(c.first ?? '')}</td><td>${escapeHtml(c.last ?? '')}</td>
      <td>${escapeHtml(c.position ?? '')}</td><td>${dash(c.days_onboard)}</td>
      <td>${escapeHtml(c.sign_on_date ?? '')}</td><td>${escapeHtml(c.planned_crew_change ?? '')}</td>
    </tr>`).join('')
  const crewPad = '<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>'
    .repeat(Math.max(0, 15 - crew.length))

  const lifts = (p.lifts ?? {}) as Record<string, unknown>
  const provisions = (p.provisions ?? {}) as Record<string, unknown>
  const delays = (p.delays ?? {}) as Record<string, unknown>
  const safety = (p.safety ?? {}) as Record<string, unknown>

  const css = `
    @page { size: A4; margin: 12mm 10mm; }
    * { box-sizing: border-box; }
  /* The hexes in this stylesheet are a FACSIMILE of KOC's official paper Daily
     Vessel Report — the pink header bands, the black rules, the red code
     legend. They are not app chrome and must not follow the app theme: this
     document is opened in a print window, goes onto white paper or into a PDF
     attached to an email, and has to match the form the office already files.
     Restyling it with KOC tokens would produce a document that is on-brand and
     wrong. */
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #000; background: #fff; margin: 0; padding: 50px 12mm 12mm; }
    .page { page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    h1.title { text-align: center; font-size: 16px; margin: 4px 0 8px; }
    table { border-collapse: collapse; width: 100%; }
    table, th, td { border: 1px solid #000; }
    th, td { padding: 3px 5px; vertical-align: middle; }
    .pink th, .pink td.head, tr.pink td { background: #f4b5b5; font-weight: bold; text-align: center; }
    .label { font-weight: bold; }
    .bold { font-weight: bold; }
    td.head { background: #f4b5b5; font-weight: bold; text-align: center; }
    .sub { font-size: 9px; font-weight: normal; color: #333; }
    .tank-name { font-weight: bold; }
    .task-desc { text-align: left; }
    .codes td { padding: 4px; font-size: 9px; background: #f9c8c8; }
    .codes td b { color: #b00020; }
    .lifts td { padding: 6px; }
    .footer-note { border: 1px solid #000; padding: 8px; font-size: 10px; margin-top: 6px; }
    .footer-note .em { font-weight: bold; font-style: italic; text-decoration: underline; display:block; margin-top: 6px;}
    .actions { position: fixed; top: 8px; left: 8px; z-index: 9999; }
    .actions button { padding: 8px 14px; font-size: 13px; cursor: pointer; }
    @media print { .actions { display: none; } }
  `

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escapeHtml(p.vessel_id)} Daily Report ${escapeHtml(fmtDate(p.report_date))}</title>
<style>${css}</style>
</head><body>

<div class="actions">
  <button onclick="window.print()">🖨 Print / Save as PDF</button>
  <button onclick="window.close()">Close</button>
</div>

<!-- PAGE 1 -->
<section class="page">
  <h1 class="title">${escapeHtml(vesselName)}<br/>Daily Vessel Report</h1>

  <table>
    <tr class="pink"><td colspan="2">5.0379 1.5</td><td colspan="6" class="head">Vessel Name</td></tr>
    <tr>
      <td class="label">Period ending ${escapeHtml(p.period_end || '24:00')}HRS</td>
      <td class="label">Date:</td><td>${escapeHtml(fmtDate(p.report_date))}</td>
      <td class="label">Voyage No.</td><td colspan="3">${dash(p.voyage_no)}</td>
    </tr>
    <tr>
      <td class="label">Vessel Safety Performance:</td>
      <td class="label">Accidents:</td><td>${dash(safety.accidents)}</td>
      <td class="label">Incidents:</td><td>${dash(safety.incidents)}</td>
      <td class="label">Near Miss:</td><td colspan="2">${dash(safety.near_miss)}</td>
    </tr>
    <tr>
      <td class="label">Days Since Last Port Call</td><td>${dash(p.days_since_port_call)}</td>
      <td class="label">Next Crew Change</td><td colspan="2">${dash(fmtDate(String(p.next_crew_change ?? '')) || 'T.B.A')}</td>
      <td class="label">Security Level</td><td colspan="2" class="bold" style="text-align:center;font-size:14px">${dash(p.security_level)}</td>
    </tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td colspan="8">24-hour Consumable Summary</td></tr>
    <tr class="pink">
      <td>Product</td><td>Max. Cap.</td><td>Consumed</td><td>Discharged</td>
      <td>ROB</td><td>Rem. To load</td><td>Loaded</td><td>Remarks</td>
    </tr>
    ${liquidRow('Fuel oil', cons.fuel_oil)}
    ${liquidRow('Fresh water', cons.fresh_water)}
    ${liquidRow('Drill Water', cons.drill_water, '1476 M³ (100%)')}
    ${liquidRow('BASE OIL / SARALINE', cons.base_oil, '1094 Bbls (80%)')}
    ${tanksRows}
  </table>
</section>

<!-- PAGE 2 -->
<section class="page">
  <h1 class="title">${escapeHtml(vesselName)}<br/>Daily Vessel Report</h1>

  <table class="codes">
    <tr><td colspan="5" style="text-align:center;font-weight:bold;background:#fff">Operational Task Codes</td></tr>
    <tr>
      <td><b>S01</b> – Standby On Location</td>
      <td><b>S02</b> – Standby alongside rig in DP</td>
      <td><b>S03</b> – Standby on semi DP</td>
      <td><b>S04</b> – STBY Shuaiba Port</td>
      <td><b>S05</b> – Standby awaiting instructions</td>
    </tr>
    <tr>
      <td><b>DP1</b> – DP cargo operations</td>
      <td><b>L1F</b> – Cargo ops Freeport</td>
      <td><b>L2E</b> – Cargo ops</td>
      <td><b>B1</b> – Back-load at rig</td>
      <td><b>O1</b> – Other (please describe)</td>
    </tr>
    <tr>
      <td><b>I01</b> – In Transit</td>
      <td><b>I02</b> – In transit Channel</td>
      <td><b>D1</b> – Downtime</td>
      <td><b>WOW</b> – Waiting on weather</td>
      <td><b>A01</b> – Standby at anchor</td>
    </tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>From</td><td>To</td><td>HRS/MIN</td><td>Task code</td><td>Description Log</td></tr>
    ${taskRows}
    ${padRows}
  </table>

  <table class="lifts" style="margin-top:6px">
    <tr>
      <td class="head" rowspan="2" style="width:14%">Lifts On Deck</td>
      <td rowspan="2" style="width:18%">${escapeHtml(String(lifts.on_deck ?? '')).replace(/\n/g, '<br>')}</td>
      <td class="head" style="width:11%">Lifts Loaded</td>
      <td style="width:14%">${dash(lifts.loaded)}</td>
      <td class="head" style="width:14%">Lifts Discharged</td>
      <td style="width:14%">${dash(lifts.discharged)}</td>
      <td class="head" style="width:14%">Deck Utilization</td>
      <td>${lifts.utilization_pct != null && lifts.utilization_pct !== '' ? escapeHtml(lifts.utilization_pct) + ' %' : '-'}</td>
    </tr>
    <tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  </table>
</section>

<!-- PAGE 3 -->
<section class="page">
  <h1 class="title">${escapeHtml(vesselName)}<br/>Daily Vessel Report</h1>

  <table>
    <tr class="pink"><td colspan="6">Crew List</td></tr>
    <tr class="pink">
      <td>Name (First)</td><td>Name (Last)</td><td>Position</td>
      <td>Days Onboard</td><td>Sign On Date</td><td>Planned Crew change Date</td>
    </tr>
    ${crewRows}
    ${crewPad}
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td colspan="3">Passengers Onboard (Name &amp; Employer)</td></tr>
    <tr class="pink"><td>ON SIGNER</td><td>OFF SIGNER</td><td>COMPANY NAME</td></tr>
    <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>Requirements Next Port Call</td></tr>
    <tr><td>${escapeHtml(String(p.requirements_next_port_call ?? '') || 'NIL')}</td></tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>Issues, Concerns &amp; Comments</td></tr>
    <tr><td style="white-space:pre-wrap; min-height:80px">${escapeHtml(String(p.issues_comments ?? ''))}

Remaining provision store On-board:
Dry Store          : ${dash(provisions.dry_store_days)} Days
Fresh &amp; Frozen Store: ${dash(provisions.fresh_frozen_days)} Days
Drinking Water     : ${dash(provisions.drinking_water_days)} Days

FO Unpumpable      : ${dash(provisions.fuel_oil_unpumpable)}
Delay Arrival Time : ${dash(delays.arrival_time)}
Delay Departure Time: ${dash(delays.departure_time)}</td></tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>Accident, Incident or Near Miss Summary Report</td></tr>
    <tr><td>${escapeHtml(String(p.accident_summary ?? '') || 'NIL')}</td></tr>
  </table>
</section>

<!-- PAGE 4 -->
<section class="page">
  <h1 class="title">${escapeHtml(vesselName)}<br/>Daily Vessel Report</h1>

  <table>
    <tr>
      <td class="head" style="width:22%">Report Compiled By:</td>
      <td>${escapeHtml(p.compiled_by?.role || 'Master')} : ${escapeHtml(p.compiled_by?.name || '')}</td>
      <td class="label" style="width:18%">Date: ${escapeHtml(fmtDate(p.report_date))}</td>
      <td class="label" style="width:14%">Time: ${escapeHtml(p.period_end || '24:00')}</td>
    </tr>
  </table>

  <div class="footer-note">
    The Daily Report shall be communicated by 06:00 each day regardless of the Vessel's location or employment.
    A distribution list shall be provided. Any occurrence which impacts the safety or operational capabilities
    of the Vessel shall be reported immediately and noted in the applicable section above. The e-mail title
    and document file name shall state "Daily Report" and include the name and date of the vessel.
    <span class="em">The report shall be completed in sufficient detail so as to provide a clear and concise illustration of all operational activities and events for the period.</span>
  </div>
</section>

</body></html>`
}

/** Open the print-ready report in a new window. Returns false if pop-ups are blocked. */
export function openReportPdf(p: DailyReport, vesselName: string): boolean {
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.open()
  win.document.write(buildReportHTML(p, vesselName))
  win.document.close()
  return true
}
