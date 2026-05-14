#!/usr/bin/env node
// Persian Gulf coverage test with proper Blob handling.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function loadKey() {
  const txt = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^AISSTREAM_API_KEY=(.*)$/);
    if (m) return m[1].trim();
  }
  throw new Error('No key');
}

const KEY = loadKey();
const OUR = new Set(['636025030', '538010097', '538010098', '538010099']);
const NAMES = { '636025030': 'JUNO', '538010097': 'CA1', '538010098': 'CA3', '538010099': 'CA5' };
const RUN_SEC = 30;

let total = 0;
const seenMmsis = new Set();
const ours = new Map();    // mmsi -> { lat, lon, ts }
const otherSample = new Map(); // mmsi -> { lat, lon }

console.log(`Persian Gulf test — ${RUN_SEC}s. Key prefix ${KEY.slice(0, 4)}…\n`);

const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

ws.addEventListener('open', () => {
  const sub = {
    APIKey: KEY,
    // Strait of Hormuz: 25–27°N × 55.5–58°E. Heavy oil-tanker traffic.
    BoundingBoxes: [[[25.0, 55.5], [27.0, 58.0]]],
  };
  ws.send(JSON.stringify(sub));
  console.log('Subscribed. Listening…\n');
});

async function readData(data) {
  // Handle string, Blob, or ArrayBuffer
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

ws.addEventListener('message', async (evt) => {
  const text = await readData(evt.data);
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (msg.error) { console.error('SERVER ERROR:', msg.error); return; }
  total++;
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || meta.MMSI_String || '');
  if (mmsi) seenMmsis.add(mmsi);
  const inner = (msg.Message && (msg.Message.PositionReport || msg.Message.StandardClassBPositionReport ||
    msg.Message.ExtendedClassBPositionReport)) || null;
  if (inner && typeof inner.Latitude === 'number') {
    if (OUR.has(mmsi)) {
      ours.set(mmsi, { lat: inner.Latitude, lon: inner.Longitude, ts: new Date() });
      console.log(`🎯 ${NAMES[mmsi]} (${mmsi}) @ ${inner.Latitude.toFixed(4)}, ${inner.Longitude.toFixed(4)}  SOG=${inner.Sog ?? '–'} COG=${inner.Cog ?? '–'}`);
    } else if (otherSample.size < 5) {
      otherSample.set(mmsi, { lat: inner.Latitude, lon: inner.Longitude });
    }
  }
  if (total % 50 === 0) console.log(`  … ${total} msgs total, ${seenMmsis.size} unique MMSIs, ${ours.size}/4 of ours`);
});

ws.addEventListener('close', () => done());
setTimeout(() => { try { ws.close(1000, 'done'); } catch (e) {} done(); }, RUN_SEC * 1000);

function done() {
  console.log('\n=========== RESULT ===========');
  console.log(`Total messages: ${total}`);
  console.log(`Unique MMSIs in Gulf: ${seenMmsis.size}`);
  console.log(`Our 4 vessels seen: ${ours.size}/4`);
  for (const [mmsi, p] of ours) console.log(`  ${NAMES[mmsi]} @ ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} (last: ${p.ts.toISOString()})`);
  console.log(`Sample other Gulf vessels:`);
  for (const [mmsi, p] of otherSample) console.log(`  ${mmsi} @ ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`);
  console.log('==============================');
  process.exit(0);
}
