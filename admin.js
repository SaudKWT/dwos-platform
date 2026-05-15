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
