#!/usr/bin/env node
// Standalone AISStream.io connectivity test — NO BROWSER, NO APP CODE.
//
// Usage:  node tools/test-aisstream.mjs
//
// Reads AISSTREAM_API_KEY from .env in the project root.
// Connects to wss://stream.aisstream.io/v0/stream and subscribes to a
// WORLD-WIDE bounding box. If AISStream's network is alive and our key
// works, we should see many messages per second from anywhere on Earth.
// Per message, we also report whether the lat/lon falls inside the
// Persian Gulf area (24°–30°N × 47°–56°E).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const txt = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const KEY = env.AISSTREAM_API_KEY;
if (!KEY || KEY.startsWith('your_')) {
  console.error('No AISSTREAM_API_KEY in .env — abort.');
  process.exit(1);
}
console.log(`Key loaded (length=${KEY.length}, prefix=${KEY.slice(0, 4)}…)`);

const OUR_MMSIS = new Set(['636025030', '538010097', '538010098', '538010099']);
const GULF = { latMin: 24, lonMin: 47, latMax: 30, lonMax: 56 };
const inGulf = (lat, lon) =>
  lat >= GULF.latMin && lat <= GULF.latMax &&
  lon >= GULF.lonMin && lon <= GULF.lonMax;

const RUN_SECONDS = 25;
let total = 0;
let inGulfCount = 0;
let ours = new Set();
const uniqueMmsis = new Set();
const gulfMmsis = new Set();
let firstAt = null, lastAt = null;
let serverError = null;

console.log(`\nConnecting to wss://stream.aisstream.io/v0/stream — running for ${RUN_SECONDS}s …\n`);

const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

ws.addEventListener('open', () => {
  console.log('[open] WebSocket open. Sending Singapore Strait subscription');
  console.log('       (busiest AIS area on Earth — guaranteed traffic if our key works).');
  const sub = {
    APIKey: KEY,
    // Singapore Strait: 1.0–1.5°N × 103.5°–104.5°E. Hundreds of ships
    // continuously — if our key is valid we'll see data within seconds.
    BoundingBoxes: [[[1.0, 103.5], [1.5, 104.5]]],
  };
  console.log('[sub]', JSON.stringify(sub).slice(0, 120) + '…');
  ws.send(JSON.stringify(sub));
});

ws.addEventListener('message', (evt) => {
  let msg;
  try { msg = JSON.parse(evt.data); } catch (e) { return; }
  if (msg.error) {
    serverError = msg.error;
    console.error('[server error]', msg.error);
    return;
  }
  total++;
  if (!firstAt) firstAt = Date.now();
  lastAt = Date.now();
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || meta.MMSI_String || '');
  if (mmsi) uniqueMmsis.add(mmsi);
  const inner =
    (msg.Message && (msg.Message.PositionReport || msg.Message.StandardClassBPositionReport)) || null;
  if (inner && typeof inner.Latitude === 'number' && typeof inner.Longitude === 'number') {
    if (inGulf(inner.Latitude, inner.Longitude)) {
      inGulfCount++;
      gulfMmsis.add(mmsi);
      console.log(`[GULF HIT] MMSI ${mmsi} @ ${inner.Latitude.toFixed(3)},${inner.Longitude.toFixed(3)}`);
    }
    if (OUR_MMSIS.has(mmsi)) ours.add(mmsi);
  }
  if (total <= 3) console.log('[sample msg]', JSON.stringify(msg).slice(0, 200) + '…');
});

ws.addEventListener('error', (e) => {
  console.error('[ws error]', e.message || e);
});

ws.addEventListener('close', (e) => {
  console.log(`\n[close] code=${e.code} reason="${e.reason || ''}"`);
  printSummary();
  process.exit(0);
});

setTimeout(() => {
  console.log(`\n--- Time's up (${RUN_SECONDS}s). Closing. ---`);
  try { ws.close(1000, 'test done'); } catch (e) {}
  setTimeout(() => { printSummary(); process.exit(0); }, 500);
}, RUN_SECONDS * 1000);

function printSummary() {
  const dur = firstAt && lastAt ? ((lastAt - firstAt) / 1000).toFixed(1) : '0';
  console.log('\n================ SUMMARY ================');
  console.log(`Total messages received        : ${total}`);
  console.log(`Unique MMSIs seen              : ${uniqueMmsis.size}`);
  console.log(`Messages inside Persian Gulf   : ${inGulfCount}`);
  console.log(`Unique MMSIs in Gulf bbox      : ${gulfMmsis.size}`);
  console.log(`Our 4 vessels seen             : ${[...ours].join(', ') || '(none)'}`);
  console.log(`First→last message timespan    : ${dur}s`);
  if (serverError) console.log(`Server error encountered       : ${serverError}`);
  console.log('=========================================\n');
  if (total === 0 && !serverError) {
    console.log('VERDICT: Zero global messages. Either the key is invalid, or');
    console.log('AISStream is currently down. (Coverage isn\'t the issue if even');
    console.log('WORLDWIDE returns nothing.)');
  } else if (total > 0 && inGulfCount === 0) {
    console.log(`VERDICT: AISStream is alive (${total} global msgs / ${uniqueMmsis.size} ships`);
    console.log('worldwide) but ZERO messages came from the Persian Gulf bbox.');
    console.log('This confirms AISStream has no terrestrial-AIS receiver coverage');
    console.log('in your region. Use a different provider.');
  } else if (inGulfCount > 0) {
    console.log(`VERDICT: AISStream HAS Gulf coverage (${inGulfCount} msgs, ${gulfMmsis.size} ships)`);
    console.log('Your tight Kuwait bbox may have been too small to catch them in time.');
    console.log('We can tune the bbox and try again.');
  }
}
