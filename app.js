'use strict';

const TZ_OFFSET_MIN = 3 * 60;
const VIA_STBY_MIN = 30;

const TILE_URLS = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

const state = {
  theme: 'dark',
  tileLayer: null,
  locsById: {},
  locs: [],
  vesselsById: {},
  vessels: [],
  plans: [],
  timelines: {},
  timelineStart: null,
  timelineEnd: null,
  currentTime: null,
  playing: false,
  speed: 1800,
  showRoutes: true,
  map: null,
  locMarkers: [],
  vesselMarkers: {},
  routePolylines: [],
  lastTickMs: null,
};

function parseLocalTime(iso) {
  if (!iso) return null;
  return new Date(iso + ':00+03:00');
}

function toKuwaitStr(d) {
  if (!d) return '—';
  const utc = d.getTime();
  const k = new Date(utc + TZ_OFFSET_MIN * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth()+1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`;
}

function distNm(a, b) {
  const cosLat = Math.cos(29 * Math.PI / 180);
  const dLatNm = (b.lat - a.lat) * 60;
  const dLonNm = (b.lon - a.lon) * 60 * cosLat;
  return Math.sqrt(dLatNm * dLatNm + dLonNm * dLonNm);
}

function bearingDeg(a, b) {
  const phi1 = a.lat * Math.PI / 180;
  const phi2 = b.lat * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

async function loadData() {
  const [loc, ves, plans] = await Promise.all([
    fetch('data/locations.json').then(r => r.json()),
    fetch('data/vessels.json').then(r => r.json()),
    fetch('data/plans.json').then(r => r.json()),
  ]);
  state.locs = loc.locations;
  state.locsById = Object.fromEntries(state.locs.map(l => [l.id, l]));
  state.vessels = ves.vessels;
  state.vesselsById = Object.fromEntries(state.vessels.map(v => [v.id, v]));
  state.defaults = ves.defaults;
  state.plans = plans.plans;
}

function buildTimelines() {
  const rigStby = state.defaults.rig_turnaround_min || 60;
  const tl = {};
  state.vessels.forEach(v => { tl[v.id] = []; });

  const sortedPlans = [...state.plans].sort(
    (a, b) => parseLocalTime(a.snapshot_at) - parseLocalTime(b.snapshot_at)
  );

  // Initial moored segments from earliest plan snapshots
  const first = sortedPlans[0];
  for (const vid in first.snapshots) {
    const s = first.snapshots[vid];
    if (typeof s.loc === 'string' && !s.loc.startsWith('enroute_')) {
      tl[vid].push({
        type: 'moored',
        t0: parseLocalTime(first.snapshot_at),
        t1: null,
        loc: s.loc,
        purpose: 'STBY (initial)',
        raw: s.raw,
      });
    }
  }

  // Process movements from all plans
  for (const plan of sortedPlans) {
    for (const m of (plan.movements || [])) {
      const vessel = state.vesselsById[m.vessel];
      if (!vessel) continue;
      addMovementSegments(tl[m.vessel], m, vessel, rigStby);
    }
  }

  // Finalize each vessel's timeline
  for (const vid in tl) {
    tl[vid] = finalize(tl[vid]);
  }
  state.timelines = tl;

  // Compute global time bounds
  let minT = Infinity, maxT = -Infinity;
  for (const vid in tl) {
    for (const s of tl[vid]) {
      if (s.t0 && s.t0.getTime() < minT) minT = s.t0.getTime();
      if (s.t1 && s.t1.getTime() > maxT) maxT = s.t1.getTime();
    }
  }
  state.timelineStart = new Date(minT);
  state.timelineEnd = new Date(maxT);
}

function addMovementSegments(segs, m, vessel, rigStby) {
  const speed = vessel.speed_kts;
  const etd = parseLocalTime(m.etd);
  const path = [m.from, ...(m.via || []), m.to];
  let cursor = etd;

  for (let i = 0; i < path.length - 1; i++) {
    const fromLoc = state.locsById[path[i]];
    const toLoc = state.locsById[path[i + 1]];
    if (!fromLoc || !toLoc) continue;
    const d = distNm(fromLoc, toLoc);
    const durMs = (d / speed) * 3600 * 1000;
    const arrive = new Date(cursor.getTime() + durMs);
    segs.push({
      type: 'transit',
      t0: cursor, t1: arrive,
      from: path[i], to: path[i + 1],
      purpose: m.purpose,
      raw: m.raw,
      distance_nm: d,
    });
    cursor = arrive;
    if (i < path.length - 2) {
      const tEnd = new Date(cursor.getTime() + VIA_STBY_MIN * 60 * 1000);
      segs.push({
        type: 'moored',
        t0: cursor, t1: tEnd,
        loc: path[i + 1],
        purpose: 'Via stop',
        raw: m.raw,
      });
      cursor = tEnd;
    }
  }

  if (m.return) {
    const stbyEnd = new Date(cursor.getTime() + rigStby * 60 * 1000);
    segs.push({
      type: 'moored',
      t0: cursor, t1: stbyEnd,
      loc: m.to,
      purpose: (m.purpose || '') + ' — at destination',
      raw: m.raw,
    });
    cursor = stbyEnd;

    const retPath = [m.to, ...(m.return.via || []), m.return.to];
    for (let i = 0; i < retPath.length - 1; i++) {
      const fromLoc = state.locsById[retPath[i]];
      const toLoc = state.locsById[retPath[i + 1]];
      if (!fromLoc || !toLoc) continue;
      const d = distNm(fromLoc, toLoc);
      const durMs = (d / speed) * 3600 * 1000;
      const arrive = new Date(cursor.getTime() + durMs);
      segs.push({
        type: 'transit',
        t0: cursor, t1: arrive,
        from: retPath[i], to: retPath[i + 1],
        purpose: 'Returning to port',
        raw: m.raw,
        distance_nm: d,
      });
      cursor = arrive;
      if (i < retPath.length - 2) {
        const tEnd = new Date(cursor.getTime() + VIA_STBY_MIN * 60 * 1000);
        segs.push({
          type: 'moored',
          t0: cursor, t1: tEnd,
          loc: retPath[i + 1],
          purpose: 'Return via stop',
          raw: m.raw,
        });
        cursor = tEnd;
      }
    }
  }
}

function finalize(segs) {
  segs.sort((a, b) => a.t0 - b.t0);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.t1 === null) prev.t1 = s.t0;
      if (prev.t1 < s.t0) {
        const endLoc = prev.type === 'transit' ? prev.to : prev.loc;
        out.push({
          type: 'moored',
          t0: prev.t1, t1: s.t0,
          loc: endLoc,
          purpose: 'STBY',
          raw: 'Continuation between events',
        });
      } else if (prev.t1 > s.t0) {
        prev.t1 = s.t0; // truncate overlap
      }
    }
    out.push(s);
  }
  if (out.length && out[out.length - 1].t1 === null) {
    out[out.length - 1].t1 = new Date(out[out.length - 1].t0.getTime() + 24 * 3600 * 1000);
  }
  return out;
}

function positionAt(vid, t) {
  const segs = state.timelines[vid];
  if (!segs || segs.length === 0) return null;
  if (t < segs[0].t0) {
    const s = segs[0];
    const loc = state.locsById[s.type === 'moored' ? s.loc : s.from];
    return { lat: loc.lat, lon: loc.lon, segment: null, heading: 0, status: 'pre-timeline' };
  }
  if (t > segs[segs.length - 1].t1) {
    const s = segs[segs.length - 1];
    const loc = state.locsById[s.type === 'moored' ? s.loc : s.to];
    return { lat: loc.lat, lon: loc.lon, segment: s, heading: 0, status: 'post-timeline' };
  }
  const seg = segs.find(s => s.t0 <= t && t <= s.t1);
  if (!seg) return null;
  if (seg.type === 'moored') {
    const loc = state.locsById[seg.loc];
    return { lat: loc.lat, lon: loc.lon, segment: seg, heading: 0 };
  }
  const from = state.locsById[seg.from];
  const to = state.locsById[seg.to];
  const frac = Math.min(1, Math.max(0, (t - seg.t0) / (seg.t1 - seg.t0)));
  return {
    lat: from.lat + (to.lat - from.lat) * frac,
    lon: from.lon + (to.lon - from.lon) * frac,
    segment: seg,
    heading: bearingDeg(from, to),
  };
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('vesselSimTheme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
  if (state.map) {
    if (state.tileLayer) state.map.removeLayer(state.tileLayer);
    state.tileLayer = L.tileLayer(TILE_URLS[theme], {
      attribution: '© OpenStreetMap, © CARTO',
      maxZoom: 18,
    }).addTo(state.map);
  }
}

function initMap() {
  state.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([29.08, 48.28], 10);
  applyTheme(state.theme);

  // Location markers
  for (const loc of state.locs) {
    const cls = `loc-marker ${loc.type}`;
    const icon = L.divIcon({
      className: '',
      html: `<div class="${cls}">${loc.short}</div>`,
      iconAnchor: [30, 8],
      iconSize: [60, 16],
    });
    const m = L.marker([loc.lat, loc.lon], { icon, title: loc.name }).addTo(state.map);
    m.bindPopup(`<b>${loc.name}</b><br/>${loc.type}${loc.berth_use ? '<br/>'+loc.berth_use : ''}<br/>${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`);
    state.locMarkers.push(m);
  }

  // Vessel markers
  for (const v of state.vessels) {
    const size = v.id === 'JUNO' ? 'small' : '';
    const html = `<div class="vessel-marker ${size}" style="--vc:${v.color};--vs:${v.stroke}">
      <div class="hull"></div>
      <div class="label">${v.id}</div>
    </div>`;
    const icon = L.divIcon({ className: '', html, iconAnchor: [14, 5], iconSize: [28, 10] });
    const m = L.marker([0, 0], { icon, zIndexOffset: 1000 }).addTo(state.map);
    m.bindPopup(`<b>${v.name}</b>`);
    state.vesselMarkers[v.id] = m;
  }

  // Draw planned route polylines (all transits in timeline)
  drawRoutes();
}

function drawRoutes() {
  // Clear existing
  state.routePolylines.forEach(p => state.map.removeLayer(p));
  state.routePolylines = [];
  if (!state.showRoutes) return;
  for (const vid in state.timelines) {
    const v = state.vesselsById[vid];
    const segs = state.timelines[vid].filter(s => s.type === 'transit');
    for (const s of segs) {
      const from = state.locsById[s.from];
      const to = state.locsById[s.to];
      const p = L.polyline([[from.lat, from.lon], [to.lat, to.lon]], {
        color: v.color,
        weight: 1.5,
        opacity: 0.35,
        dashArray: '3,5',
      }).addTo(state.map);
      state.routePolylines.push(p);
    }
  }
}

function render() {
  const t = state.currentTime;
  document.getElementById('clock').textContent = toKuwaitStr(t);
  // slider position
  const range = state.timelineEnd - state.timelineStart;
  const frac = (t - state.timelineStart) / range;
  document.getElementById('slider').value = Math.round(frac * 1000);

  // vessels
  const cards = [];
  for (const v of state.vessels) {
    const pos = positionAt(v.id, t);
    const marker = state.vesselMarkers[v.id];
    if (pos) {
      marker.setLatLng([pos.lat, pos.lon]);
      const el = marker.getElement();
      if (el) {
        const hull = el.querySelector('.hull');
        if (hull) hull.style.transform = `rotate(${pos.heading - 90}deg)`;
      }
    }
    cards.push(vesselCardHtml(v, pos));
  }
  document.getElementById('vesselCards').innerHTML = cards.join('');
}

function vesselCardHtml(v, pos) {
  if (!pos) {
    return `<div class="vessel-card" style="--vc:${v.color}">
      <div class="name">${v.name}</div>
      <div class="status"><span class="tag unknown">No data</span></div>
    </div>`;
  }
  const s = pos.segment;
  let statusHtml, metaHtml;
  if (!s) {
    statusHtml = `<span class="tag unknown">${pos.status}</span>`;
    metaHtml = '';
  } else if (s.type === 'moored') {
    const loc = state.locsById[s.loc];
    statusHtml = `<span class="tag moored">Moored</span> ${loc ? loc.short : s.loc}`;
    metaHtml = `${s.purpose || ''}`;
  } else {
    const from = state.locsById[s.from];
    const to = state.locsById[s.to];
    const frac = Math.min(1, Math.max(0, (state.currentTime - s.t0) / (s.t1 - s.t0)));
    statusHtml = `<span class="tag transit">Transit</span> ${from.short} → ${to.short} (${Math.round(frac*100)}%)`;
    metaHtml = `${s.purpose || ''} · ${s.distance_nm ? s.distance_nm.toFixed(1) + ' nm' : ''} @ ${v.speed_kts} kts`;
  }
  return `<div class="vessel-card" style="--vc:${v.color}">
    <div class="name">${v.name} <span style="color:#7a8a9b;font-weight:400;font-size:11px">${v.length_m}×${v.beam_m} m · ${v.speed_kts} kts</span></div>
    <div class="status">${statusHtml}</div>
    <div class="meta">${metaHtml}</div>
    ${s && s.raw ? `<div class="raw">${s.raw}</div>` : ''}
  </div>`;
}

function renderLegend() {
  const items = state.vessels.map(v =>
    `<div><span class="sw" style="background:${v.color}"></span>${v.name} · ${v.type}</div>`
  );
  items.push('<div style="margin-top:6px"><span style="color:#ff7849">▲</span> Rig &nbsp; <span style="color:#6e84ff">■</span> Port/Berth</div>');
  document.getElementById('legend').innerHTML = items.join('');

  const notes = [
    '<b>Notes from source PDFs:</b>',
    '• 06-May: Crest Argus 5 row truncated (ETD unknown — placeholder 11:00).',
    '• 07-May: Juno 2nd run ETD 01.30hrs treated as 13:30 (suspected typo).',
    '• 08-May: Crest Argus 3 ETD TBC — placeholder 15:00.',
    '• 10-May plan was skipped on the Sunday — May 11 inferred from snapshot.',
    '• Transit times computed from coords ÷ speed. Default 60 min STBY at rig, 30 min at via stops.',
  ];
  document.getElementById('notes').innerHTML = notes.join('<br/>');
}

function setupControls() {
  const slider = document.getElementById('slider');
  slider.addEventListener('input', () => {
    const frac = slider.value / 1000;
    state.currentTime = new Date(state.timelineStart.getTime() + frac * (state.timelineEnd - state.timelineStart));
    render();
  });

  document.getElementById('btnPlay').addEventListener('click', e => {
    state.playing = !state.playing;
    e.target.textContent = state.playing ? '⏸ Pause' : '▶ Play';
    state.lastTickMs = performance.now();
  });

  document.getElementById('btnPrevHour').addEventListener('click', () => stepTime(-3600));
  document.getElementById('btnNextHour').addEventListener('click', () => stepTime(3600));
  document.getElementById('btnPrevDay').addEventListener('click', () => stepTime(-86400));
  document.getElementById('btnNextDay').addEventListener('click', () => stepTime(86400));

  document.getElementById('speed').addEventListener('change', e => {
    state.speed = Number(e.target.value);
  });
  state.speed = Number(document.getElementById('speed').value);

  document.getElementById('cbRoutes').addEventListener('change', e => {
    state.showRoutes = e.target.checked;
    drawRoutes();
  });

  document.getElementById('themeBtn').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });
}

function stepTime(seconds) {
  const next = new Date(state.currentTime.getTime() + seconds * 1000);
  state.currentTime = clampTime(next);
  render();
}

function clampTime(t) {
  if (t < state.timelineStart) return state.timelineStart;
  if (t > state.timelineEnd) return state.timelineEnd;
  return t;
}

function animationLoop(nowMs) {
  if (state.playing && state.lastTickMs != null) {
    const dt = (nowMs - state.lastTickMs) / 1000;
    const dSim = dt * state.speed * 1000;
    let next = new Date(state.currentTime.getTime() + dSim);
    if (next > state.timelineEnd) {
      next = state.timelineEnd;
      state.playing = false;
      document.getElementById('btnPlay').textContent = '▶ Play';
    }
    state.currentTime = next;
    render();
  }
  state.lastTickMs = nowMs;
  requestAnimationFrame(animationLoop);
}

async function main() {
  try {
    state.theme = localStorage.getItem('vesselSimTheme') || 'dark';
    document.documentElement.dataset.theme = state.theme;
    await loadData();
    buildTimelines();
    state.currentTime = state.timelineStart;
    initMap();
    renderLegend();
    setupControls();
    document.getElementById('dataRange').textContent =
      `${toKuwaitStr(state.timelineStart)} → ${toKuwaitStr(state.timelineEnd)}`;
    // Fit map to all locations
    const bounds = L.latLngBounds(state.locs.map(l => [l.lat, l.lon]));
    state.map.fitBounds(bounds.pad(0.2));
    render();
    requestAnimationFrame(animationLoop);
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b">${err.stack || err.message || err}</pre>`;
  }
}

document.addEventListener('DOMContentLoaded', main);
