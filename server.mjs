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
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const REPORTS_DIR  = path.join(PROJECT_ROOT, 'data', 'daily-reports');
const AIS_DIR      = path.join(PROJECT_ROOT, 'data', 'ais-history');
const PORT         = Number(process.env.PORT || 5173);
const HOST         = process.env.HOST || '127.0.0.1';

const VESSEL_IDS  = new Set(['JUNO', 'CA1', 'CA3', 'CA5']);
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;

const bus = new EventEmitter();
bus.setMaxListeners(0);

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

  // GET /api/stream (SSE)
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const onSaved = (payload) => {
      res.write(`event: report_saved\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    bus.on('report_saved', onSaved);
    const keepalive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      bus.off('report_saved', onSaved);
    });
    return;
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
  console.log(`KOC vessel-movement server`);
  console.log(`  Simulator : http://${HOST}:${PORT}/`);
  console.log(`  Dashboard : http://${HOST}:${PORT}/admin.html`);
  console.log(`  API index : http://${HOST}:${PORT}/api/reports`);
});
