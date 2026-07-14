#!/usr/bin/env node
// Minimal Node backend for the KOC vessel-movement simulator.
//
// Serves the static site (index.html, app.js, admin.html, data/...) and
// exposes a tiny JSON API for the captain dashboard:
//
//   GET  /api/reports                       -> index of all daily reports
//   GET  /api/reports/:vessel/:date         -> one daily report by id
//   POST /api/reports                       -> save / overwrite a report
//                                             (body = daily-report.schema.json)
//   GET  /api/stream                        -> Server-Sent Events;
//                                             emits {event:'report_saved'} when
//                                             a new submission lands.
//
// Zero npm deps. Run from project root:
//
//   node server.mjs
//
// Then open http://localhost:5173/ (simulator) or /admin.html (captain form).

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const REPORTS_DIR  = path.join(PROJECT_ROOT, 'data', 'daily-reports');
const AIS_DIR      = path.join(PROJECT_ROOT, 'data', 'ais-history');
const PLANS_DIR    = path.join(PROJECT_ROOT, 'data', 'movement-plans');
const PORT         = Number(process.env.PORT || 5173);
const HOST         = process.env.HOST || '127.0.0.1';

const VESSEL_IDS  = new Set(['JUNO', 'CA1', 'CA3', 'CA5']);
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;

const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------------------
// Live polling against Datalastic /vessel_pro
// ---------------------------------------------------------------------------

const LIVE_DEFAULT_INTERVAL_MS = 120_000;  // 2 minutes
const live = {
  running: false,
  intervalMs: LIVE_DEFAULT_INTERVAL_MS,
  timer: null,
  lastPollAt: null,        // ISO string
  lastError: null,
  pollsThisSession: 0,
  newPositionsThisSession: 0,
  lastPositions: {},       // vid -> { ts, lat, lon, sog, cog, heading, nav_status }
};

function loadEnvSync() {
  try {
    const buf = fsSync.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
    const env = {};
    for (const raw of buf.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
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
      lat: d.lat,
      lon: d.lon,
      sog: typeof d.speed === 'number' ? d.speed : null,
      cog: typeof d.course === 'number' ? d.course : null,
      heading: typeof d.heading === 'number' ? d.heading : null,
      nav_status: d.navigation_status || null,
    };
  } finally {
    clearTimeout(to);
  }
}

async function appendAisPosition(vid, mmsi, pos) {
  if (!pos || !pos.ts) return false;
  const date = pos.ts.slice(0, 10);
  const file = path.join(AIS_DIR, `${vid}-${date}.json`);
  let rec;
  try {
    rec = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
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

async function pollOnce() {
  live.pollsThisSession += 1;
  live.lastPollAt = new Date().toISOString();
  live.lastError = null;
  const env = loadEnvSync();
  const apiKey = env.DATALASTIC_API_KEY;
  if (!apiKey) {
    live.lastError = 'DATALASTIC_API_KEY missing in .env';
    bus.emit('live_status', liveSnapshot());
    return;
  }
  let anyNew = false;
  for (const vid of VESSEL_IDS) {
    const mmsi = env[`AIS_MMSI_${vid}`];
    if (!mmsi) continue;
    let pos;
    try { pos = await fetchVesselPro(apiKey, mmsi); }
    catch (e) {
      live.lastError = `${vid}: ${String(e.message).slice(0, 160)}`;
      continue;
    }
    if (!pos) continue;
    const prev = live.lastPositions[vid];
    const isNewTs = !prev || prev.ts !== pos.ts;
    live.lastPositions[vid] = pos;
    if (isNewTs) {
      await appendAisPosition(vid, mmsi, pos);
      live.newPositionsThisSession += 1;
      bus.emit('live_position', { vessel_id: vid, mmsi, position: pos });
      anyNew = true;
    }
  }
  if (anyNew) {
    try { await rebuildAisIndex(); } catch {}
  }
  bus.emit('live_status', liveSnapshot());
}

async function rebuildAisIndex() {
  const files = (await fs.readdir(AIS_DIR).catch(() => []))
    .filter(f => f.endsWith('.json') && f !== 'index.json');
  const rows = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(AIS_DIR, f), 'utf8'));
      rows.push({
        vessel_id: rec.vessel_id, date_utc: rec.date_utc,
        file: `ais-history/${f}`,
        positions: (rec.positions || []).length,
        provider: (rec.source || {}).provider || null,
      });
    } catch {}
  }
  rows.sort((a, b) => a.date_utc.localeCompare(b.date_utc) || a.vessel_id.localeCompare(b.vessel_id));
  await fs.writeFile(path.join(AIS_DIR, 'index.json'), JSON.stringify({ tracks: rows }, null, 2), 'utf8');
}

function startLive(intervalMs) {
  if (live.running) return;
  live.running = true;
  live.intervalMs = Math.max(60_000, intervalMs || LIVE_DEFAULT_INTERVAL_MS);
  live.pollsThisSession = 0;
  live.newPositionsThisSession = 0;
  live.timer = setInterval(() => { pollOnce().catch(e => console.error('[live] poll failed:', e)); },
                           live.intervalMs);
  // Fire one immediately so the user sees a response right after clicking.
  pollOnce().catch(e => console.error('[live] poll failed:', e));
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
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
  '.eml':  'message/rfc822',
};

// Block access to anything starting with these prefixes, to avoid serving
// secrets or the captain's mailbox archive.
const BLOCKED_PREFIXES = ['.env', '.git', 'config.local.js', 'Vessels daily report'];

function safeResolve(urlPath) {
  // Drop query string, normalise.
  let p = urlPath.split('?')[0];
  if (p === '/' || p === '') p = '/index.html';
  // Reject any path that escapes the project root.
  const decoded = decodeURIComponent(p);
  if (decoded.includes('\0')) return null;
  const abs = path.normalize(path.join(PROJECT_ROOT, decoded));
  if (!abs.startsWith(PROJECT_ROOT)) return null;
  const rel = path.relative(PROJECT_ROOT, abs);
  if (BLOCKED_PREFIXES.some(b => rel === b || rel.startsWith(b + path.sep) || rel.startsWith(b + '/'))) {
    return null;
  }
  return abs;
}

async function serveStatic(req, res) {
  const abs = safeResolve(req.url);
  if (!abs) return send(res, 403, 'Forbidden');
  let stat;
  try { stat = await fs.stat(abs); }
  catch { return send(res, 404, 'Not found'); }
  if (stat.isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(abs).pipe(res);
}

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
    let total = 0;
    const chunks = [];
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
// API
// ---------------------------------------------------------------------------

// Run the Python parser on ONE loose PDF and resolve its JSON envelope.
// Reuses tools/parse_daily_reports.py so the import screen and the historical
// importer share exactly the same PDF-reading logic.
function parsePdfFile(pdfPath, name) {
  return new Promise((resolve) => {
    execFile(
      'python3',
      [path.join(PROJECT_ROOT, 'tools', 'parse_daily_reports.py'),
       '--pdf', pdfPath, '--name', name || ''],
      { cwd: PROJECT_ROOT, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!stdout) {
          resolve({ ok: false, error: (stderr || err?.message || 'parser failed').trim() });
          return;
        }
        try {
          // The envelope is the last non-empty line of stdout.
          const line = stdout.trim().split('\n').filter(Boolean).pop();
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: 'could not read the parser output' });
        }
      },
    );
  });
}

async function rebuildIndex() {
  const files = (await fs.readdir(REPORTS_DIR))
    .filter(f => f.endsWith('.json') && f !== 'index.json');
  const rows = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(REPORTS_DIR, f), 'utf8'));
      if (!rec.vessel_id || !rec.report_date) continue;
      rows.push({
        vessel_id: rec.vessel_id,
        report_date: rec.report_date,
        file: `daily-reports/${f}`,
        task_log_rows: (rec.task_log || []).length,
        source_type: rec.source?.type || null,
      });
    } catch { /* skip malformed */ }
  }
  rows.sort((a, b) =>
    a.report_date.localeCompare(b.report_date) || a.vessel_id.localeCompare(b.vessel_id));
  const idxPath = path.join(REPORTS_DIR, 'index.json');
  await fs.writeFile(idxPath, JSON.stringify({ reports: rows }, null, 2), 'utf8');
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
      rows.push({
        plan_date:   rec.plan_date,
        issued_date: rec.issued_date || null,
        issued_by:   rec.issued_by || null,
        subject:     rec.subject || null,
        vessels:     (rec.vessels || []).map(v => v.vessel_id),
        source_type: (rec.source || {}).type || null,
        file:        `movement-plans/${f}`,
      });
    } catch { /* skip malformed */ }
  }
  rows.sort((a, b) => a.plan_date.localeCompare(b.plan_date));
  const idxPath = path.join(PLANS_DIR, 'index.json');
  await fs.mkdir(PLANS_DIR, { recursive: true });
  await fs.writeFile(idxPath, JSON.stringify({ plans: rows }, null, 2), 'utf8');
  return rows;
}

function validatePlan(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!DATE_RE.test(body.plan_date || '')) return 'plan_date must be YYYY-MM-DD';
  if (!Array.isArray(body.vessels)) return 'vessels must be an array';
  if (body.vessels.length === 0) return 'vessels must contain at least one entry';
  for (const v of body.vessels) {
    if (!v || typeof v !== 'object') return 'every vessel entry must be an object';
    if (!VESSEL_IDS.has(v.vessel_id)) {
      return `vessel_id "${v.vessel_id}" must be one of JUNO, CA1, CA3, CA5`;
    }
  }
  return null;
}

function validateReport(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!VESSEL_IDS.has(body.vessel_id)) return 'vessel_id must be one of JUNO, CA1, CA3, CA5';
  if (!DATE_RE.test(body.report_date || '')) return 'report_date must be YYYY-MM-DD';
  if (!Array.isArray(body.task_log)) return 'task_log must be an array';
  for (const r of body.task_log) {
    if (!r || typeof r.from_time !== 'string' || !/^[0-2]?\d:[0-5]\d$/.test(r.from_time)) {
      return 'every task_log row needs a from_time HH:MM';
    }
    if (!r.task_code) return 'every task_log row needs a task_code';
  }
  return null;
}

async function handleApi(req, res, url) {
  // GET /api/reports
  if (req.method === 'GET' && url.pathname === '/api/reports') {
    const idxPath = path.join(REPORTS_DIR, 'index.json');
    try {
      const buf = await fs.readFile(idxPath);
      return send(res, 200, buf.toString('utf8'));
    } catch {
      const rows = await rebuildIndex();
      return send(res, 200, { reports: rows });
    }
  }

  // GET /api/reports/:vessel/:date
  const m = url.pathname.match(/^\/api\/reports\/([A-Z0-9]+)\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === 'GET' && m) {
    const [_, vid, date] = m;
    if (!VESSEL_IDS.has(vid)) return send(res, 400, { error: 'unknown vessel_id' });
    const p = path.join(REPORTS_DIR, `${vid}-${date}.json`);
    try {
      const buf = await fs.readFile(p);
      return send(res, 200, buf.toString('utf8'));
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }

  // POST /api/reports
  if (req.method === 'POST' && url.pathname === '/api/reports') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return send(res, 400, { error: 'invalid JSON: ' + e.message }); }

    const err = validateReport(body);
    if (err) return send(res, 400, { error: err });

    // Always overwrite by (vessel, date).  Tag the source.
    body.source = {
      ...(body.source || {}),
      type: 'dashboard_submission',
      submitted_via: 'admin.html',
      submitted_at: new Date().toISOString(),
    };

    const out = path.join(REPORTS_DIR, `${body.vessel_id}-${body.report_date}.json`);
    await fs.writeFile(out, JSON.stringify(body, null, 2), 'utf8');
    await rebuildIndex();
    bus.emit('report_saved', { vessel_id: body.vessel_id, report_date: body.report_date });
    return send(res, 200, { ok: true, vessel_id: body.vessel_id, report_date: body.report_date });
  }

  // POST /api/import — bulk-import loose DDR PDFs.
  // Body: { files: [ { name, data_base64 } ] }.  Each PDF is parsed, validated,
  // and (auto-)saved as a daily report.  Returns a per-file result summary.
  if (req.method === 'POST' && url.pathname === '/api/import') {
    let body;
    try { body = await readJsonBody(req, 32 * 1024 * 1024); }
    catch (e) { return send(res, 400, { error: 'invalid upload: ' + e.message }); }

    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return send(res, 400, { error: 'no files provided' });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koc-import-'));
    const results = [];
    const seenInBatch = new Map();   // "vid|date" -> first filename that won it
    const savedKeys = [];

    try {
      for (const f of files) {
        const name = String(f?.name || 'upload.pdf');
        if (!/\.pdf$/i.test(name)) {
          results.push({ name, status: 'skipped', reason: 'not a PDF' });
          continue;
        }
        let buf;
        try { buf = Buffer.from(String(f.data_base64 || ''), 'base64'); }
        catch { results.push({ name, status: 'error', reason: 'could not decode file' }); continue; }
        if (!buf.length) { results.push({ name, status: 'error', reason: 'empty file' }); continue; }

        const tmpPath = path.join(tmpDir, `${randomUUID()}.pdf`);
        await fs.writeFile(tmpPath, buf);

        const parsed = await parsePdfFile(tmpPath, name);
        if (!parsed.ok) {
          results.push({ name, status: 'error', reason: parsed.error || 'parse failed' });
          continue;
        }
        const rec = parsed.record;
        const verr = validateReport(rec);
        if (verr) { results.push({ name, status: 'error', reason: verr }); continue; }

        const key = `${rec.vessel_id}|${rec.report_date}`;
        const rows = (rec.task_log || []).length;
        if (seenInBatch.has(key)) {
          results.push({ name, vessel_id: rec.vessel_id, report_date: rec.report_date, rows,
                         status: 'skipped', reason: `same vessel/date as ${seenInBatch.get(key)}` });
          continue;
        }
        seenInBatch.set(key, name);

        const out = path.join(REPORTS_DIR, `${rec.vessel_id}-${rec.report_date}.json`);
        let existed = true;
        try { await fs.access(out); } catch { existed = false; }
        await fs.writeFile(out, JSON.stringify(rec, null, 2), 'utf8');
        savedKeys.push({ vessel_id: rec.vessel_id, report_date: rec.report_date });
        results.push({ name, vessel_id: rec.vessel_id, report_date: rec.report_date, rows,
                       status: existed ? 'overwrote' : 'saved' });
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    if (savedKeys.length) {
      await rebuildIndex();
      for (const k of savedKeys) bus.emit('report_saved', k);
    }
    return send(res, 200, { results, saved: savedKeys.length });
  }

  // -------------------- Movement plans --------------------
  // GET /api/movement-plans               -> index of all plans
  if (req.method === 'GET' && url.pathname === '/api/movement-plans') {
    const idxPath = path.join(PLANS_DIR, 'index.json');
    try {
      const buf = await fs.readFile(idxPath);
      return send(res, 200, buf.toString('utf8'));
    } catch {
      const rows = await rebuildPlansIndex();
      return send(res, 200, { plans: rows });
    }
  }
  // GET /api/movement-plans/:date         -> one plan by plan_date
  const mPlan = url.pathname.match(/^\/api\/movement-plans\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === 'GET' && mPlan) {
    const date = mPlan[1];
    const p = path.join(PLANS_DIR, `${date}.json`);
    try {
      const buf = await fs.readFile(p);
      return send(res, 200, buf.toString('utf8'));
    } catch {
      return send(res, 404, { error: 'no plan for that date' });
    }
  }
  // POST /api/movement-plans              -> save / overwrite plan
  if (req.method === 'POST' && url.pathname === '/api/movement-plans') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return send(res, 400, { error: 'invalid JSON: ' + e.message }); }
    const err = validatePlan(body);
    if (err) return send(res, 400, { error: err });
    body.source = {
      ...(body.source || {}),
      type: 'dashboard_submission',
      submitted_via: 'admin.html',
      submitted_at: new Date().toISOString(),
    };
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const out = path.join(PLANS_DIR, `${body.plan_date}.json`);
    await fs.writeFile(out, JSON.stringify(body, null, 2), 'utf8');
    await rebuildPlansIndex();
    bus.emit('plan_saved', { plan_date: body.plan_date });
    return send(res, 200, { ok: true, plan_date: body.plan_date });
  }

  // GET /api/ais-history                 -> index of all imported AIS tracks
  if (req.method === 'GET' && url.pathname === '/api/ais-history') {
    try {
      const buf = await fs.readFile(path.join(AIS_DIR, 'index.json'));
      return send(res, 200, buf.toString('utf8'));
    } catch {
      return send(res, 200, { tracks: [] });
    }
  }

  // GET /api/ais-history/:vessel/:date    -> one day's positions
  const mAis = url.pathname.match(/^\/api\/ais-history\/([A-Z0-9]+)\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === 'GET' && mAis) {
    const [_, vid, date] = mAis;
    if (!VESSEL_IDS.has(vid)) return send(res, 400, { error: 'unknown vessel_id' });
    const p = path.join(AIS_DIR, `${vid}-${date}.json`);
    try {
      const buf = await fs.readFile(p);
      return send(res, 200, buf.toString('utf8'));
    } catch {
      return send(res, 404, { error: 'no AIS track for that vessel/date' });
    }
  }

  // GET /api/stream (SSE) — emits report_saved + live_position + live_status
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const onSaved    = (p) => res.write(`event: report_saved\ndata: ${JSON.stringify(p)}\n\n`);
    const onPlan     = (p) => res.write(`event: plan_saved\ndata: ${JSON.stringify(p)}\n\n`);
    const onPosition = (p) => res.write(`event: live_position\ndata: ${JSON.stringify(p)}\n\n`);
    const onStatus   = (p) => res.write(`event: live_status\ndata: ${JSON.stringify(p)}\n\n`);
    bus.on('report_saved',  onSaved);
    bus.on('plan_saved',    onPlan);
    bus.on('live_position', onPosition);
    bus.on('live_status',   onStatus);
    // Send current live snapshot on connect so the UI can sync.
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

  // GET /api/live              -> current live polling status
  if (req.method === 'GET' && url.pathname === '/api/live') {
    return send(res, 200, liveSnapshot());
  }
  // POST /api/live/start       -> start polling.  body: { interval_ms? }
  if (req.method === 'POST' && url.pathname === '/api/live/start') {
    let body = {};
    try { body = await readJsonBody(req); } catch {}
    startLive(Number(body.interval_ms) || LIVE_DEFAULT_INTERVAL_MS);
    return send(res, 200, liveSnapshot());
  }
  // POST /api/live/stop        -> stop polling
  if (req.method === 'POST' && url.pathname === '/api/live/stop') {
    stopLive();
    return send(res, 200, liveSnapshot());
  }

  send(res, 404, { error: 'api route not found' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res);
  } catch (e) {
    console.error('[server] error:', e);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, async () => {
  try { await rebuildIndex(); } catch (e) { console.warn('[server] could not build index:', e.message); }
  try { await rebuildPlansIndex(); } catch (e) { console.warn('[server] could not build plans index:', e.message); }
  console.log(`KOC vessel-movement server`);
  console.log(`  Simulator : http://${HOST}:${PORT}/`);
  console.log(`  Dashboard : http://${HOST}:${PORT}/admin.html`);
  console.log(`  API index : http://${HOST}:${PORT}/api/reports`);
});
