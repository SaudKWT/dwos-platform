// Vercel serverless handler — all /api/* routes except /api/auth.
// Adapted from server.mjs: same logic, no http.createServer / server.listen.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');   // api/ -> project root
const REPORTS_DIR  = path.join(PROJECT_ROOT, 'data', 'daily-reports');
const AIS_DIR      = path.join(PROJECT_ROOT, 'data', 'ais-history');
const PLANS_DIR    = path.join(PROJECT_ROOT, 'data', 'movement-plans');

const VESSEL_IDS = new Set(['JUNO', 'CA1', 'CA3', 'CA5']);
const DATE_RE    = /^\d{4}-\d{2}-\d{2}$/;

// SSE bus — shared within a single cold-start invocation only.
const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------------------
// Live AIS polling (best-effort; state resets between cold starts on Vercel)
// ---------------------------------------------------------------------------

const LIVE_DEFAULT_INTERVAL_MS = 120_000;
const live = {
  running: false,
  intervalMs: LIVE_DEFAULT_INTERVAL_MS,
  timer: null,
  lastPollAt: null,
  lastError: null,
  pollsThisSession: 0,
  newPositionsThisSession: 0,
  lastPositions: {},
};

function loadEnvSync() {
  // On Vercel, env vars are injected directly; no .env file needed.
  return process.env;
}

async function fetchVesselPro(apiKey, mmsi) {
  const url = `https://api.datalastic.com/api/v0/vessel_pro?api-key=${encodeURIComponent(apiKey)}&mmsi=${encodeURIComponent(mmsi)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${body.slice(0, 160)}`);
    }
    const j = await r.json();
    const d = (j && j.data) || {};
    if (typeof d.lat !== 'number' || typeof d.lon !== 'number') return null;
    return {
      ts: d.last_position_UTC || d.timestamp,
      lat: d.lat, lon: d.lon,
      sog: typeof d.speed === 'number' ? d.speed : null,
      cog: typeof d.course === 'number' ? d.course : null,
      heading: typeof d.heading === 'number' ? d.heading : null,
      nav_status: d.navigation_status || null,
    };
  } finally { clearTimeout(to); }
}

async function appendAisPosition(vid, mmsi, pos) {
  if (!pos || !pos.ts) return false;
  const date = pos.ts.slice(0, 10);
  const file = path.join(AIS_DIR, `${vid}-${date}.json`);
  let rec;
  try { rec = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch {
    rec = {
      vessel_id: vid, mmsi, date_utc: date, positions: [],
      source: { provider: 'datalastic', imported_at: new Date().toISOString(),
                raw_query: 'datalastic /vessel_pro live' },
    };
  }
  if (rec.positions.some(p => p.ts === pos.ts)) return false;
  rec.positions.push(pos);
  rec.positions.sort((a, b) => a.ts.localeCompare(b.ts));
  const lats = rec.positions.map(p => p.lat);
  const lons = rec.positions.map(p => p.lon);
  rec.stats = {
    count: rec.positions.length,
    first_ts: rec.positions[0].ts,
    last_ts:  rec.positions[rec.positions.length - 1].ts,
    bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)],
  };
  rec.source.imported_at = new Date().toISOString();
  await fs.mkdir(AIS_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

async function rebuildAisIndex() {
  const files = (await fs.readdir(AIS_DIR).catch(() => []))
    .filter(f => f.endsWith('.json') && f !== 'index.json');
  const rows = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(AIS_DIR, f), 'utf8'));
      rows.push({ vessel_id: rec.vessel_id, date_utc: rec.date_utc,
                  file: `ais-history/${f}`,
                  positions: (rec.positions || []).length,
                  provider: (rec.source || {}).provider || null });
    } catch {}
  }
  rows.sort((a, b) => a.date_utc.localeCompare(b.date_utc) || a.vessel_id.localeCompare(b.vessel_id));
  await fs.writeFile(path.join(AIS_DIR, 'index.json'), JSON.stringify({ tracks: rows }, null, 2), 'utf8');
}

async function pollOnce() {
  live.pollsThisSession++;
  live.lastPollAt = new Date().toISOString();
  live.lastError = null;
  const env = loadEnvSync();
  const apiKey = env.DATALASTIC_API_KEY;
  if (!apiKey) { live.lastError = 'DATALASTIC_API_KEY not set'; bus.emit('live_status', liveSnapshot()); return; }
  let anyNew = false;
  for (const vid of VESSEL_IDS) {
    const mmsi = env[`AIS_MMSI_${vid}`];
    if (!mmsi) continue;
    let pos;
    try { pos = await fetchVesselPro(apiKey, mmsi); }
    catch (e) { live.lastError = `${vid}: ${String(e.message).slice(0, 160)}`; continue; }
    if (!pos) continue;
    const prev = live.lastPositions[vid];
    const isNewTs = !prev || prev.ts !== pos.ts;
    live.lastPositions[vid] = pos;
    if (isNewTs) {
      await appendAisPosition(vid, mmsi, pos);
      live.newPositionsThisSession++;
      bus.emit('live_position', { vessel_id: vid, mmsi, position: pos });
      anyNew = true;
    }
  }
  if (anyNew) { try { await rebuildAisIndex(); } catch {} }
  bus.emit('live_status', liveSnapshot());
}

function startLive(intervalMs) {
  if (live.running) return;
  live.running = true;
  live.intervalMs = Math.max(60_000, intervalMs || LIVE_DEFAULT_INTERVAL_MS);
  live.pollsThisSession = 0;
  live.newPositionsThisSession = 0;
  live.timer = setInterval(() => pollOnce().catch(console.error), live.intervalMs);
  pollOnce().catch(console.error);
  bus.emit('live_status', liveSnapshot());
}

function stopLive() {
  if (live.timer) clearInterval(live.timer);
  live.timer = null;
  live.running = false;
  bus.emit('live_status', liveSnapshot());
}

function liveSnapshot() {
  return {
    running: live.running,
    interval_ms: live.intervalMs,
    last_poll_at: live.lastPollAt,
    last_error: live.lastError,
    polls_this_session: live.pollsThisSession,
    new_positions_this_session: live.newPositionsThisSession,
    vessels: Object.keys(live.lastPositions),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

async function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0, chunks = [];
    req.on('data', c => {
      total += c.length;
      if (total > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Index rebuilders
// ---------------------------------------------------------------------------

async function rebuildIndex() {
  const files = (await fs.readdir(REPORTS_DIR))
    .filter(f => f.endsWith('.json') && f !== 'index.json');
  const rows = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(REPORTS_DIR, f), 'utf8'));
      if (!rec.vessel_id || !rec.report_date) continue;
      rows.push({ vessel_id: rec.vessel_id, report_date: rec.report_date,
                  file: `daily-reports/${f}`, task_log_rows: (rec.task_log || []).length,
                  source_type: rec.source?.type || null });
    } catch {}
  }
  rows.sort((a, b) => a.report_date.localeCompare(b.report_date) || a.vessel_id.localeCompare(b.vessel_id));
  await fs.writeFile(path.join(REPORTS_DIR, 'index.json'), JSON.stringify({ reports: rows }, null, 2), 'utf8');
  return rows;
}

async function rebuildPlansIndex() {
  const files = (await fs.readdir(PLANS_DIR).catch(() => []))
    .filter(f => f.endsWith('.json') && f !== 'index.json');
  const rows = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(PLANS_DIR, f), 'utf8'));
      if (!rec.plan_date) continue;
      rows.push({ plan_date: rec.plan_date, issued_date: rec.issued_date || null,
                  issued_by: rec.issued_by || null, subject: rec.subject || null,
                  vessels: (rec.vessels || []).map(v => v.vessel_id),
                  source_type: (rec.source || {}).type || null,
                  file: `movement-plans/${f}` });
    } catch {}
  }
  rows.sort((a, b) => a.plan_date.localeCompare(b.plan_date));
  const idxPath = path.join(PLANS_DIR, 'index.json');
  await fs.mkdir(PLANS_DIR, { recursive: true });
  await fs.writeFile(idxPath, JSON.stringify({ plans: rows }, null, 2), 'utf8');
  return rows;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validatePlan(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!DATE_RE.test(body.plan_date || '')) return 'plan_date must be YYYY-MM-DD';
  if (!Array.isArray(body.vessels)) return 'vessels must be an array';
  if (body.vessels.length === 0) return 'vessels must contain at least one entry';
  for (const v of body.vessels) {
    if (!v || typeof v !== 'object') return 'every vessel entry must be an object';
    if (!VESSEL_IDS.has(v.vessel_id)) return `vessel_id "${v.vessel_id}" must be one of JUNO, CA1, CA3, CA5`;
  }
  return null;
}

function validateReport(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!VESSEL_IDS.has(body.vessel_id)) return 'vessel_id must be one of JUNO, CA1, CA3, CA5';
  if (!DATE_RE.test(body.report_date || '')) return 'report_date must be YYYY-MM-DD';
  if (!Array.isArray(body.task_log)) return 'task_log must be an array';
  for (const r of body.task_log) {
    if (!r || typeof r.from_time !== 'string' || !/^[0-2]?\d:[0-5]\d$/.test(r.from_time))
      return 'every task_log row needs a from_time HH:MM';
    if (!r.task_code) return 'every task_log row needs a task_code';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler (exported for Vercel)
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);

  try {
    // GET /api/reports
    if (req.method === 'GET' && url.pathname === '/api/reports') {
      const idxPath = path.join(REPORTS_DIR, 'index.json');
      try { return send(res, 200, await fs.readFile(idxPath, 'utf8')); }
      catch { return send(res, 200, { reports: await rebuildIndex() }); }
    }

    // GET /api/reports/:vessel/:date
    const m = url.pathname.match(/^\/api\/reports\/([A-Z0-9]+)\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === 'GET' && m) {
      const [, vid, date] = m;
      if (!VESSEL_IDS.has(vid)) return send(res, 400, { error: 'unknown vessel_id' });
      try { return send(res, 200, await fs.readFile(path.join(REPORTS_DIR, `${vid}-${date}.json`), 'utf8')); }
      catch { return send(res, 404, { error: 'not found' }); }
    }

    // POST /api/reports
    if (req.method === 'POST' && url.pathname === '/api/reports') {
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { return send(res, 400, { error: 'invalid JSON: ' + e.message }); }
      const err = validateReport(body);
      if (err) return send(res, 400, { error: err });
      body.source = { ...(body.source || {}), type: 'dashboard_submission',
                      submitted_via: 'admin.html', submitted_at: new Date().toISOString() };
      const out = path.join(REPORTS_DIR, `${body.vessel_id}-${body.report_date}.json`);
      await fs.writeFile(out, JSON.stringify(body, null, 2), 'utf8');
      await rebuildIndex();
      bus.emit('report_saved', { vessel_id: body.vessel_id, report_date: body.report_date });
      return send(res, 200, { ok: true, vessel_id: body.vessel_id, report_date: body.report_date });
    }

    // GET /api/movement-plans
    if (req.method === 'GET' && url.pathname === '/api/movement-plans') {
      const idxPath = path.join(PLANS_DIR, 'index.json');
      try { return send(res, 200, await fs.readFile(idxPath, 'utf8')); }
      catch { return send(res, 200, { plans: await rebuildPlansIndex() }); }
    }

    // GET /api/movement-plans/:date
    const mPlan = url.pathname.match(/^\/api\/movement-plans\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === 'GET' && mPlan) {
      try { return send(res, 200, await fs.readFile(path.join(PLANS_DIR, `${mPlan[1]}.json`), 'utf8')); }
      catch { return send(res, 404, { error: 'no plan for that date' }); }
    }

    // POST /api/movement-plans
    if (req.method === 'POST' && url.pathname === '/api/movement-plans') {
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { return send(res, 400, { error: 'invalid JSON: ' + e.message }); }
      const err = validatePlan(body);
      if (err) return send(res, 400, { error: err });
      body.source = { ...(body.source || {}), type: 'dashboard_submission',
                      submitted_via: 'admin.html', submitted_at: new Date().toISOString() };
      await fs.mkdir(PLANS_DIR, { recursive: true });
      const out = path.join(PLANS_DIR, `${body.plan_date}.json`);
      await fs.writeFile(out, JSON.stringify(body, null, 2), 'utf8');
      await rebuildPlansIndex();
      bus.emit('plan_saved', { plan_date: body.plan_date });
      return send(res, 200, { ok: true, plan_date: body.plan_date });
    }

    // GET /api/ais-history
    if (req.method === 'GET' && url.pathname === '/api/ais-history') {
      try { return send(res, 200, await fs.readFile(path.join(AIS_DIR, 'index.json'), 'utf8')); }
      catch { return send(res, 200, { tracks: [] }); }
    }

    // GET /api/ais-history/:vessel/:date
    const mAis = url.pathname.match(/^\/api\/ais-history\/([A-Z0-9]+)\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === 'GET' && mAis) {
      const [, vid, date] = mAis;
      if (!VESSEL_IDS.has(vid)) return send(res, 400, { error: 'unknown vessel_id' });
      try { return send(res, 200, await fs.readFile(path.join(AIS_DIR, `${vid}-${date}.json`), 'utf8')); }
      catch { return send(res, 404, { error: 'no AIS track for that vessel/date' }); }
    }

    // GET /api/stream (SSE)
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      const onSaved    = p => res.write(`event: report_saved\ndata: ${JSON.stringify(p)}\n\n`);
      const onPlan     = p => res.write(`event: plan_saved\ndata: ${JSON.stringify(p)}\n\n`);
      const onPosition = p => res.write(`event: live_position\ndata: ${JSON.stringify(p)}\n\n`);
      const onStatus   = p => res.write(`event: live_status\ndata: ${JSON.stringify(p)}\n\n`);
      bus.on('report_saved',  onSaved);
      bus.on('plan_saved',    onPlan);
      bus.on('live_position', onPosition);
      bus.on('live_status',   onStatus);
      onStatus(liveSnapshot());
      const keepalive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
      req.on('close', () => {
        clearInterval(keepalive);
        bus.off('report_saved',  onSaved);
        bus.off('plan_saved',    onPlan);
        bus.off('live_position', onPosition);
        bus.off('live_status',   onStatus);
      });
      return;
    }

    // GET /api/live
    if (req.method === 'GET' && url.pathname === '/api/live') {
      return send(res, 200, liveSnapshot());
    }

    // POST /api/live/start
    if (req.method === 'POST' && url.pathname === '/api/live/start') {
      let body = {};
      try { body = await readJsonBody(req); } catch {}
      startLive(Number(body.interval_ms) || LIVE_DEFAULT_INTERVAL_MS);
      return send(res, 200, liveSnapshot());
    }

    // POST /api/live/stop
    if (req.method === 'POST' && url.pathname === '/api/live/stop') {
      stopLive();
      return send(res, 200, liveSnapshot());
    }

    // POST /api/import — not available on the deployed site (Phase 1 is local only).
    // The live host can't run the PDF reader or permanently save uploads.
    if (req.method === 'POST' && url.pathname === '/api/import') {
      return send(res, 501, {
        error: 'PDF import runs on your local Mac only for now. Run "node server.mjs" '
             + 'on your computer, import there, then push to update this site.',
      });
    }

    send(res, 404, { error: 'api route not found' });
  } catch (e) {
    console.error('[api] error:', e);
    send(res, 500, { error: 'internal error' });
  }
}
