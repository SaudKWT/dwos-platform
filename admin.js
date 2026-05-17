// Captain Dashboard — daily vessel report form.
//
// Loads, edits, and submits records that conform to data/daily-report.schema.json.
// Submissions POST to /api/reports on the local Node backend (see server.mjs).

const TASK_CODES = [
  ['S01', 'S01 — Standby on location'],
  ['S02', 'S02 — Standby alongside rig (DP)'],
  ['S03', 'S03 — Standby (semi DP / base)'],
  ['S04', 'S04 — Standby Shuaiba port'],
  ['S05', 'S05 — Standby awaiting instructions'],
  ['DP1', 'DP1 — DP cargo operations'],
  ['L1F', 'L1F — Cargo ops Freeport'],
  ['L2E', 'L2E — Cargo ops'],
  ['B1',  'B1 — Back-load at rig'],
  ['O1',  'O1 — Other'],
  ['I01', 'I01 — In transit'],
  ['I02', 'I02 — In transit (channel)'],
  ['D1',  'D1 — Downtime'],
  ['WOW', 'WOW — Waiting on weather'],
  ['A01', 'A01 — Standby at anchor'],
];

const form        = document.getElementById('reportForm');
const taskBody    = document.querySelector('#taskLog tbody');
const addRowBtn   = document.getElementById('addRowBtn');
const submitStat  = document.getElementById('submitStatus');
const loadStat    = document.getElementById('loadStatus');
const loadBtn     = document.getElementById('loadBtn');
const newBtn      = document.getElementById('newBtn');
const loadVessel  = document.getElementById('loadVessel');
const loadDate    = document.getElementById('loadDate');

// ---------------------------------------------------------------------------
// Task-log rows
// ---------------------------------------------------------------------------

function addRow(values = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="time" name="from_time" value="${values.from_time || ''}" required step="60" /></td>
    <td><input type="time" name="to_time"   value="${values.to_time   || ''}" step="60" /></td>
    <td><select name="task_code" required>
      ${TASK_CODES.map(([c, label]) => `<option value="${c}" ${values.task_code === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select></td>
    <td><input type="text" name="description" placeholder="A/S AT PORT SIDE OPH" value="${escapeHtml(values.description || '')}" /></td>
    <td><button type="button" class="btn-row-remove" aria-label="Remove row" title="Remove row">×</button></td>
  `;
  tr.querySelector('.btn-row-remove').addEventListener('click', () => tr.remove());
  taskBody.appendChild(tr);
  return tr;
}

addRowBtn.addEventListener('click', () => addRow());

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Seed one empty row so the form isn't empty on first paint.
addRow();

// ---------------------------------------------------------------------------
// Load existing
// ---------------------------------------------------------------------------

loadBtn.addEventListener('click', async () => {
  const vid = loadVessel.value;
  const date = loadDate.value;
  if (!vid || !date) {
    setStatus(loadStat, 'Pick a vessel and a date.', 'err');
    return;
  }
  setStatus(loadStat, 'Loading…');
  try {
    const r = await fetch(`/api/reports/${vid}/${date}`);
    if (!r.ok) {
      setStatus(loadStat, r.status === 404 ? 'No report for that vessel/date.' : 'Error loading.', 'err');
      return;
    }
    const data = await r.json();
    populateForm(data);
    setStatus(loadStat, `Loaded ${vid} ${date}. Edit and submit to overwrite.`, 'ok');
  } catch (e) {
    setStatus(loadStat, 'Network error: ' + e.message, 'err');
  }
});

newBtn.addEventListener('click', () => {
  form.reset();
  taskBody.innerHTML = '';
  addRow();
  setStatus(loadStat, 'Blank form.', 'ok');
});

function populateForm(d) {
  form.elements['vessel_id'].value          = d.vessel_id || '';
  form.elements['report_date'].value        = d.report_date || '';
  form.elements['voyage_no'].value          = d.voyage_no || '';
  form.elements['security_level'].value     = d.security_level ?? '';
  form.elements['days_since_port_call'].value = d.days_since_port_call ?? '';
  form.elements['next_crew_change'].value   = isIsoDate(d.next_crew_change) ? d.next_crew_change : '';
  form.elements['period_end'].value         = d.period_end || '24:00';

  const s = d.safety || {};
  form.elements['safety_accidents'].value = s.accidents || 'Nil';
  form.elements['safety_incidents'].value = s.incidents || 'Nil';
  form.elements['safety_near_miss'].value = s.near_miss || 'Nil';

  // Consumables (flatten the two main rows we expose)
  const fo = (d.consumables || {}).fuel_oil || {};
  form.elements['fuel_rob'].value      = fo.rob || '';
  form.elements['fuel_consumed'].value = fo.consumed || '';
  form.elements['fuel_max'].value      = fo.max_capacity || '';
  const fw = (d.consumables || {}).fresh_water || {};
  form.elements['water_rob'].value      = fw.rob || '';
  form.elements['water_consumed'].value = fw.consumed || '';
  form.elements['water_max'].value      = fw.max_capacity || '';

  const li = d.lifts || {};
  form.elements['lifts_on_deck'].value    = li.on_deck || '';
  form.elements['lifts_loaded'].value     = li.loaded ?? '';
  form.elements['lifts_discharged'].value = li.discharged ?? '';
  form.elements['deck_utilization_pct'].value = li.utilization_pct ?? '';

  const p = d.provisions || {};
  form.elements['dry_store_days'].value      = p.dry_store_days ?? '';
  form.elements['fresh_frozen_days'].value   = p.fresh_frozen_days ?? '';
  form.elements['drinking_water_days'].value = p.drinking_water_days ?? '';
  form.elements['fuel_oil_unpumpable'].value = p.fuel_oil_unpumpable || '';

  const dl = d.delays || {};
  form.elements['delay_arrival'].value   = dl.arrival_time || 'NA';
  form.elements['delay_departure'].value = dl.departure_time || 'NA';

  form.elements['requirements_next_port_call'].value = d.requirements_next_port_call || '';
  form.elements['issues_comments'].value             = d.issues_comments || '';
  form.elements['accident_summary'].value            = d.accident_summary || '';

  const cb = d.compiled_by || {};
  form.elements['compiled_name'].value = cb.name || '';
  form.elements['compiled_role'].value = cb.role || 'Master';

  // Task log
  taskBody.innerHTML = '';
  (d.task_log || []).forEach(row => addRow({
    from_time:   normaliseTime(row.from_time),
    to_time:     normaliseTime(row.to_time),
    task_code:   pickTaskCode(row.task_code),
    description: row.description || '',
  }));
  if (!taskBody.children.length) addRow();
}

function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function normaliseTime(s) {
  if (!s) return '';
  // Already HH:MM
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return '';
}

function pickTaskCode(c) {
  if (!c) return TASK_CODES[0][0];
  // Slash-combined codes (e.g. "S01/A01") — keep first half.
  const head = c.split(/[/+]/)[0].trim();
  return TASK_CODES.some(([code]) => code === head) ? head : 'O1';
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus(submitStat, 'Saving…');
  const payload = buildPayload();
  try {
    const r = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(submitStat, 'Save failed: ' + (j.error || r.statusText), 'err');
      return;
    }
    setStatus(submitStat, `Saved ${j.vessel_id} ${j.report_date}. Simulator will refresh.`, 'ok');
  } catch (err) {
    setStatus(submitStat, 'Network error: ' + err.message, 'err');
  }
});

function buildPayload() {
  const f = form.elements;
  const v = name => (f[name]?.value || '').trim();
  const n = name => {
    const s = v(name);
    if (s === '') return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  };

  const task_log = Array.from(taskBody.querySelectorAll('tr')).map(tr => {
    const inputs = tr.querySelectorAll('input,select');
    return {
      from_time:   inputs[0].value,
      to_time:     inputs[1].value || null,
      task_code:   inputs[2].value,
      description: inputs[3].value.trim(),
    };
  }).filter(r => r.from_time && r.task_code);

  return {
    vessel_id:           v('vessel_id'),
    report_date:         v('report_date'),
    period_end:          v('period_end') || '24:00',
    voyage_no:           v('voyage_no') || null,
    security_level:      n('security_level'),
    days_since_port_call: n('days_since_port_call'),
    next_crew_change:    v('next_crew_change') || null,

    safety: {
      accidents: v('safety_accidents') || 'Nil',
      incidents: v('safety_incidents') || 'Nil',
      near_miss: v('safety_near_miss') || 'Nil',
    },

    consumables: {
      fuel_oil: {
        rob: v('fuel_rob') || null,
        consumed: v('fuel_consumed') || null,
        max_capacity: v('fuel_max') || null,
      },
      fresh_water: {
        rob: v('water_rob') || null,
        consumed: v('water_consumed') || null,
        max_capacity: v('water_max') || null,
      },
    },

    lifts: {
      on_deck:         v('lifts_on_deck'),
      loaded:          v('lifts_loaded'),
      discharged:      v('lifts_discharged'),
      utilization_pct: n('deck_utilization_pct'),
    },

    provisions: {
      dry_store_days:      n('dry_store_days'),
      fresh_frozen_days:   n('fresh_frozen_days'),
      drinking_water_days: n('drinking_water_days'),
      fuel_oil_unpumpable: v('fuel_oil_unpumpable') || null,
    },

    delays: {
      arrival_time:   v('delay_arrival') || 'NA',
      departure_time: v('delay_departure') || 'NA',
    },

    requirements_next_port_call: v('requirements_next_port_call'),
    issues_comments:             v('issues_comments'),
    accident_summary:            v('accident_summary'),

    compiled_by: {
      name: v('compiled_name'),
      role: v('compiled_role') || 'Master',
    },

    task_log,

    source: { type: 'dashboard_submission' },
  };
}

function setStatus(el, msg, cls = '') {
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

// ---------------------------------------------------------------------------
// PDF generation — opens a print-friendly window styled like the official
// Daily Vessel Report (Halliburton template). Captain prints → Save as PDF.
// ---------------------------------------------------------------------------

const VESSEL_NAMES = {
  JUNO: 'Allianz Juno',
  CA1:  'Crest Argus 1',
  CA3:  'Crest Argus 3',
  CA5:  'Crest Argus 5',
};

const TANK_TEMPLATE = [
  { name: 'Drill Water',      max: '1476 M³ (100%)' },
  { name: 'Baroid Tank 1',    max: '92 MT (85%)',   sub: 'Product type: BARITE' },
  { name: 'Cement Tank 2',    max: '65 MT (85%)',   sub: 'HEAVY BLENDED' },
  { name: 'Baroid Tank 3',    max: '41 MT (85%)',   sub: 'Product type: BENTONITE' },
  { name: 'Cement Tank 4',    max: '65 MT (85%)',   sub: 'LIGHT CEMENT' },
  { name: 'Baroid Tank 5',    max: '92 MT (85%)',   sub: 'Product type: BARITE' },
  { name: 'Baroid Tank 6',    max: '92 MT (85%)',   sub: 'Product type: BARITE' },
  { name: 'BASE OIL / SARALINE', max: '1094 Bbls (80%)' },
  { name: 'Mud Tk #1',        max: '1062 Bbls (80%)', sub: 'SOBM 19.5 PPG' },
  { name: 'Mud Tk #2',        max: '1062 Bbls (80%)', sub: 'SOBM 19.5 PPG' },
  { name: 'Mud Tk #3',        max: '1062 Bbls (80%)', sub: 'SOBM 22 PPG' },
  { name: 'Mud Tk #4',        max: '1000 Bbls (80%)', sub: 'SOBM 19.5 PPG' },
  { name: 'Brine',            max: '' },
];

function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function durationHM(from, to) {
  if (!from || !to) return '';
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  let mins = (th * 60 + tm) - (fh * 60 + fm);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function dash(v) { return v && String(v).trim() ? escapeHtml(v) : '-'; }

function buildReportHTML(p) {
  const vesselName = VESSEL_NAMES[p.vessel_id] || p.vessel_id || '';
  const fo = p.consumables?.fuel_oil || {};
  const fw = p.consumables?.fresh_water || {};

  const tanksRows = TANK_TEMPLATE.map(t => `
    <tr>
      <td class="tank-name">${escapeHtml(t.name)}${t.sub ? `<div class="sub">${escapeHtml(t.sub)}</div>` : ''}</td>
      <td>${escapeHtml(t.max)}</td>
      <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td></td>
    </tr>`).join('');

  const taskRows = (p.task_log || []).map(r => `
    <tr>
      <td>${escapeHtml(r.from_time || '')}</td>
      <td>${escapeHtml(r.to_time || '')}</td>
      <td>${escapeHtml(durationHM(r.from_time, r.to_time))}</td>
      <td class="bold">${escapeHtml(r.task_code || '')}</td>
      <td class="task-desc">${escapeHtml(r.description || '')}</td>
    </tr>`).join('');

  // Pad with empty rows so the layout looks like the official form.
  const pad = Math.max(0, 18 - (p.task_log?.length || 0));
  const padRows = '<tr><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(pad);

  const css = `
    @page { size: A4; margin: 12mm 10mm; }
    * { box-sizing: border-box; }
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
    .row-flex { display: flex; gap: 8px; }
    .actions { position: fixed; top: 8px; left: 8px; z-index: 9999; }
    .actions button { padding: 8px 14px; font-size: 13px; cursor: pointer; }
    @media print { .actions { display: none; } }
  `;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escapeHtml(vesselName)} — Daily Vessel Report ${escapeHtml(fmtDate(p.report_date))}</title>
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
      <td class="label">Accidents:</td><td>${dash(p.safety?.accidents)}</td>
      <td class="label">Incidents:</td><td>${dash(p.safety?.incidents)}</td>
      <td class="label">Near Miss:</td><td colspan="2">${dash(p.safety?.near_miss)}</td>
    </tr>
    <tr>
      <td class="label">Days Since Last Port Call</td><td>${dash(p.days_since_port_call)}</td>
      <td class="label">Next Crew Change</td><td colspan="2">${dash(fmtDate(p.next_crew_change) || 'T.B.A')}</td>
      <td class="label">Security Level</td><td colspan="2" class="bold" style="text-align:center;font-size:14px">${dash(p.security_level)}</td>
    </tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td colspan="8">24-hour Consumable Summary</td></tr>
    <tr class="pink">
      <td>Product</td><td>Max. Cap.</td><td>Consumed</td><td>Discharged</td>
      <td>ROB</td><td>Rem. To load</td><td>Loaded</td><td>Remarks</td>
    </tr>
    <tr>
      <td class="tank-name">Fuel oil</td>
      <td>${dash(fo.max_capacity)}</td>
      <td>${dash(fo.consumed)}</td>
      <td>-</td>
      <td>${dash(fo.rob)}</td>
      <td>-</td><td>-</td><td></td>
    </tr>
    <tr>
      <td class="tank-name">Fresh water</td>
      <td>${dash(fw.max_capacity)}</td>
      <td>${dash(fw.consumed)}</td>
      <td>-</td>
      <td>${dash(fw.rob)}</td>
      <td>-</td><td>-</td><td></td>
    </tr>
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
      <td rowspan="2" style="width:18%">${escapeHtml(p.lifts?.on_deck || '').replace(/\n/g, '<br>')}</td>
      <td class="head" style="width:11%">Lifts Loaded</td>
      <td style="width:14%">${dash(p.lifts?.loaded)}</td>
      <td class="head" style="width:14%">Lifts Discharged</td>
      <td style="width:14%">${dash(p.lifts?.discharged)}</td>
      <td class="head" style="width:14%">Deck Utilization</td>
      <td>${p.lifts?.utilization_pct != null && p.lifts?.utilization_pct !== '' ? escapeHtml(p.lifts.utilization_pct) + ' %' : '-'}</td>
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
    ${'<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(15)}
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td colspan="3">Passengers Onboard (Name &amp; Employer)</td></tr>
    <tr class="pink"><td>ON SIGNER</td><td>OFF SIGNER</td><td>COMPANY NAME</td></tr>
    <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>Requirements Next Port Call</td></tr>
    <tr><td>${escapeHtml(p.requirements_next_port_call || 'NIL')}</td></tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>Issues, Concerns &amp; Comments</td></tr>
    <tr><td style="white-space:pre-wrap; min-height:80px">${escapeHtml(p.issues_comments || '')}

Remaining provision store On-board:
Dry Store          : ${dash(p.provisions?.dry_store_days)} Days
Fresh &amp; Frozen Store: ${dash(p.provisions?.fresh_frozen_days)} Days
Drinking Water     : ${dash(p.provisions?.drinking_water_days)} Days

FO Unpumpable      : ${dash(p.provisions?.fuel_oil_unpumpable)}
Delay Arrival Time : ${dash(p.delays?.arrival_time)}
Delay Departure Time: ${dash(p.delays?.departure_time)}</td></tr>
  </table>

  <table style="margin-top:6px">
    <tr class="pink"><td>Accident, Incident or Near Miss Summary Report</td></tr>
    <tr><td>${escapeHtml(p.accident_summary || 'NIL')}</td></tr>
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

</body></html>`;
}

function generatePdf() {
  const payload = buildPayload();
  if (!payload.vessel_id || !payload.report_date) {
    setStatus(submitStat, 'Pick a vessel and report date first.', 'err');
    return;
  }
  const html = buildReportHTML(payload);
  const win = window.open('', '_blank');
  if (!win) {
    setStatus(submitStat, 'Pop-up blocked — allow pop-ups for this site.', 'err');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

document.getElementById('generatePdfBtn').addEventListener('click', generatePdf);
document.getElementById('generatePdfTopBtn')?.addEventListener('click', generatePdf);
