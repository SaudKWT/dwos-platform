#!/usr/bin/env node
// Test every plausible casing of the API key field, one at a time.
// AISStream docs say "APIKey", but their official JS example uses "APIkey"
// and their browser example uses "Apikey". We'll find out which one the
// server actually honors by trying each in turn.

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
  throw new Error('No AISSTREAM_API_KEY in .env');
}

const KEY = loadKey();
const VARIANTS = ['APIKey', 'APIkey', 'Apikey', 'apiKey', 'apikey', 'api_key'];
const PER_VARIANT_SECONDS = 8;

async function testVariant(fieldName) {
  return new Promise((resolve) => {
    let count = 0;
    let firstMsg = null;
    let serverError = null;
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    let timeout;

    ws.addEventListener('open', () => {
      const sub = {
        [fieldName]: KEY,
        BoundingBoxes: [[[1.0, 103.5], [1.5, 104.5]]], // Singapore Strait
      };
      ws.send(JSON.stringify(sub));
    });

    ws.addEventListener('message', (evt) => {
      count++;
      if (!firstMsg) firstMsg = evt.data.slice(0, 200);
      try {
        const m = JSON.parse(evt.data);
        if (m.error) serverError = m.error;
      } catch (e) {}
    });

    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      resolve({ fieldName, count, firstMsg, serverError });
    });

    timeout = setTimeout(() => {
      try { ws.close(1000, 'test done'); } catch (e) {}
    }, PER_VARIANT_SECONDS * 1000);
  });
}

console.log(`Key: ${KEY.slice(0, 4)}… (${KEY.length} chars)`);
console.log(`Testing ${VARIANTS.length} casings × ${PER_VARIANT_SECONDS}s each. Singapore Strait bbox.\n`);

for (const v of VARIANTS) {
  process.stdout.write(`Trying "${v}"… `);
  const r = await testVariant(v);
  if (r.serverError) {
    console.log(`SERVER ERROR: ${r.serverError}`);
  } else if (r.count > 0) {
    console.log(`✅ ${r.count} msgs received! First: ${r.firstMsg.slice(0, 120)}…`);
  } else {
    console.log(`silence (${r.count} msgs)`);
  }
}

console.log('\nDone.');
