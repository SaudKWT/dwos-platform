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

  // Apply snapshot anchors (ETA overrides + repositioning when reality diverges from plan)
  applySnapshotOverrides(tl, sortedPlans);

  // Finalize each vessel's timeline
  for (const vid in tl) {
    tl[vid] = finalize(tl[vid]);
  }
  state.timelines = tl;

  // Compute global time bounds — base timelineEnd on the last *transit*, not on
  // the synthetic trailing-moored segment that may extend well past it.
  let minT = Infinity, maxT = -Infinity;
  for (const vid in tl) {
    for (const s of tl[vid]) {
      if (s.t0 && s.t0.getTime() < minT) minT = s.t0.getTime();
      if (s.t1 && s.type === 'transit' && s.t1.getTime() > maxT) maxT = s.t1.getTime();
    }
  }
  // Pad 12 h beyond the last transit so users can scrub past it
  state.timelineStart = new Date(minT);
  state.timelineEnd = new Date(maxT + 12 * 3600 * 1000);
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

function applySnapshotOverrides(tl, sortedPlans) {
  for (const plan of sortedPlans) {
    const T = parseLocalTime(plan.snapshot_at);
    for (const vid in plan.snapshots) {
      const s = plan.snapshots[vid];
      const segs = tl[vid];
      if (!segs || !s) continue;

      // Case A: snapshot says vessel enroute to X with ETA E — anchor matching transit's t1
      if (s.eta && typeof s.loc === 'string' && s.loc.startsWith('enroute_to_')) {
        const targetId = s.loc.replace('enroute_to_', '');
        const eta = parseLocalTime(s.eta);
        const candidate = [...segs]
          .filter(x => x.type === 'transit' && x.to === targetId && x.t0 <= T)
          .sort((a, b) => b.t0 - a.t0)[0];
        if (candidate) {
          candidate.t1 = eta;
          candidate.eta_anchored = true;
        }
        continue;
      }

      // Case B: snapshot says vessel at concrete loc — insert repositioning if computed position differs
      if (typeof s.loc === 'string' && !s.loc.startsWith('enroute_')) {
        segs.sort((a, b) => a.t0 - b.t0);
        const containing = segs.find(x => x.t0 <= T && (x.t1 === null || T <= x.t1));
        const lastBefore = [...segs].filter(x => x.t1 !== null && x.t1 <= T).sort((a, b) => b.t1 - a.t1)[0];
        let expectedLoc = null;
        if (containing) {
          expectedLoc = containing.type === 'moored' ? containing.loc : containing.to;
        } else if (lastBefore) {
          expectedLoc = lastBefore.type === 'moored' ? lastBefore.loc : lastBefore.to;
        }
        if (expectedLoc && expectedLoc !== s.loc) {
          const v = state.vesselsById[vid];
          const from = state.locsById[expectedLoc];
          const to = state.locsById[s.loc];
          if (from && to && v) {
            const d = distNm(from, to);
            const durMs = (d / v.speed_kts) * 3600 * 1000;
            segs.push({
              type: 'transit',
              t0: new Date(T.getTime() - durMs),
              t1: T,
              from: expectedLoc,
              to: s.loc,
              purpose: 'Repositioning (inferred from next-day snapshot)',
              raw: `Inferred: ${v.name} observed at ${to.short} at ${plan.snapshot_at} — auto repositioning leg added.`,
              repositioning: true,
              distance_nm: d,
            });
          }
        }
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
          raw: null,
          filler: true,
        });
      } else if (prev.t1 > s.t0) {
        prev.t1 = s.t0; // truncate overlap
      }
    }
    out.push(s);
  }
  // Ensure the timeline ends with a moored segment so post-transit shows "Moored" not "Transit 100%"
  if (out.length) {
    const last = out[out.length - 1];
    if (last.t1 === null) last.t1 = new Date(last.t0.getTime() + 24 * 3600 * 1000);
    if (last.type === 'transit') {
      out.push({
        type: 'moored',
        t0: last.t1,
        t1: new Date(last.t1.getTime() + 7 * 24 * 3600 * 1000),
        loc: last.to,
        purpose: 'STBY',
        raw: null,
        filler: true,
      });
    }
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
      maxZoom: 19,
    }).addTo(state.map);
  }
}

function metersPerPixel() {
  const lat = 29;
  return 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, state.map.getZoom());
}

function iconPx(realM, minPx) {
  return Math.max(minPx || 14, Math.round(realM / metersPerPixel()));
}

function psvSvg(color, stroke) {
  return `<svg viewBox="0 0 24 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M 1 95 L 1 14 Q 1 2 12 2 Q 23 2 23 14 L 23 95 Q 23 98.5 18 98.5 L 6 98.5 Q 1 98.5 1 95 Z"
          fill="${color}" stroke="${stroke}" stroke-width="0.7"/>
    <rect x="4" y="13" width="16" height="22" fill="white" stroke="${stroke}" stroke-width="0.4"/>
    <rect x="5" y="15" width="14" height="4" fill="#88c5ff" stroke="${stroke}" stroke-width="0.25"/>
    <rect x="7" y="21" width="3" height="3" fill="${stroke}" opacity="0.6"/>
    <rect x="14" y="21" width="3" height="3" fill="${stroke}" opacity="0.6"/>
    <rect x="3" y="38" width="18" height="55" fill="rgba(0,0,0,0.18)"/>
    <rect x="5" y="44" width="6" height="9" fill="rgba(255,255,255,0.55)" stroke="${stroke}" stroke-width="0.25"/>
    <rect x="13" y="44" width="6" height="9" fill="rgba(255,255,255,0.55)" stroke="${stroke}" stroke-width="0.25"/>
    <rect x="5" y="55" width="6" height="9" fill="rgba(255,255,255,0.55)" stroke="${stroke}" stroke-width="0.25"/>
    <rect x="13" y="55" width="6" height="9" fill="rgba(255,255,255,0.55)" stroke="${stroke}" stroke-width="0.25"/>
    <circle cx="20.5" cy="72" r="1.8" fill="#fcc500" stroke="black" stroke-width="0.25"/>
    <circle cx="3.5" cy="80" r="1.8" fill="#fcc500" stroke="black" stroke-width="0.25"/>
    <line x1="12" y1="34" x2="12" y2="42" stroke="black" stroke-width="0.7"/>
    <circle cx="12" cy="42" r="0.8" fill="black"/>
  </svg>`;
}

function fastCrewSvg(color, stroke) {
  return `<svg viewBox="0 0 22 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M 2 88 L 2 26 Q 2 2 11 2 Q 20 2 20 26 L 20 88 Q 20 96 15 98 L 7 98 Q 2 96 2 88 Z"
          fill="${color}" stroke="${stroke}" stroke-width="0.7"/>
    <path d="M 4 28 L 18 28 L 18 82 Q 18 86 14 87 L 8 87 Q 4 86 4 82 Z" fill="white" stroke="${stroke}" stroke-width="0.4"/>
    <path d="M 5 28 L 11 12 L 17 28 Z" fill="#88c5ff" stroke="${stroke}" stroke-width="0.4"/>
    <line x1="5" y1="42" x2="17" y2="42" stroke="${stroke}" stroke-width="0.3"/>
    <line x1="5" y1="55" x2="17" y2="55" stroke="${stroke}" stroke-width="0.3"/>
    <line x1="5" y1="68" x2="17" y2="68" stroke="${stroke}" stroke-width="0.3"/>
    <line x1="11" y1="55" x2="11" y2="65" stroke="black" stroke-width="0.5"/>
    <circle cx="11" cy="55" r="1.2" fill="#fcc500"/>
  </svg>`;
}

function jackupRigSvg() {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect x="12" y="12" width="76" height="76" rx="3" fill="#e8a06b" stroke="#7a3a14" stroke-width="2"/>
    <circle cx="20" cy="20" r="7" fill="#3a3a3a" stroke="#111" stroke-width="0.8"/>
    <circle cx="80" cy="20" r="7" fill="#3a3a3a" stroke="#111" stroke-width="0.8"/>
    <circle cx="50" cy="83" r="7" fill="#3a3a3a" stroke="#111" stroke-width="0.8"/>
    <rect x="22" y="55" width="34" height="22" fill="white" stroke="#7a3a14" stroke-width="1"/>
    <line x1="22" y1="60" x2="56" y2="60" stroke="#7a3a14" stroke-width="0.6"/>
    <line x1="22" y1="65" x2="56" y2="65" stroke="#7a3a14" stroke-width="0.6"/>
    <line x1="22" y1="71" x2="56" y2="71" stroke="#7a3a14" stroke-width="0.6"/>
    <circle cx="74" cy="68" r="13" fill="#fcd750" stroke="#7a3a14" stroke-width="1.2"/>
    <text x="74" y="73.5" font-size="16" font-weight="900" text-anchor="middle" fill="#7a3a14">H</text>
    <rect x="55" y="22" width="22" height="22" fill="#b02020" stroke="#5a0d0d" stroke-width="0.8"/>
    <line x1="55" y1="22" x2="77" y2="44" stroke="#5a0d0d" stroke-width="0.9"/>
    <line x1="77" y1="22" x2="55" y2="44" stroke="#5a0d0d" stroke-width="0.9"/>
    <line x1="55" y1="33" x2="77" y2="33" stroke="#5a0d0d" stroke-width="0.6"/>
    <line x1="66" y1="22" x2="66" y2="44" stroke="#5a0d0d" stroke-width="0.6"/>
    <rect x="58" y="17" width="16" height="5" fill="#5a0d0d"/>
    <circle cx="66" cy="50" r="2" fill="#2a2a2a"/>
  </svg>`;
}

function berthIconHtml(label) {
  return `<div class="berth-icon"><div class="berth-pin"></div><div class="berth-label">${label}</div></div>`;
}

function portIconHtml(label) {
  return `<div class="port-icon"><div class="port-pin"></div><div class="port-label">${label}</div></div>`;
}

function rebuildLocationMarkers() {
  state.locMarkers.forEach(m => state.map.removeLayer(m));
  state.locMarkers = [];

  const zoom = state.map.getZoom();
  const merge = zoom < 13;

  for (const loc of state.locs) {
    if (merge && (loc.id === 'B20' || loc.id === 'B4')) continue;

    let html, iconSize, iconAnchor;
    if (loc.type === 'rig') {
      const px = iconPx(60, 30);
      html = `<div class="rig-marker" style="width:${px}px;height:${px}px"><div class="rig-body">${jackupRigSvg()}</div><div class="rig-label">${loc.short}</div></div>`;
      iconSize = [px, px];
      iconAnchor = [px / 2, px / 2];
    } else if (loc.type === 'port') {
      html = portIconHtml(loc.short);
      iconSize = [80, 30];
      iconAnchor = [40, 15];
    } else {
      html = berthIconHtml(loc.short);
      iconSize = [70, 26];
      iconAnchor = [35, 13];
    }
    const icon = L.divIcon({ className: '', html, iconSize, iconAnchor });
    const m = L.marker([loc.lat, loc.lon], { icon, title: loc.name }).addTo(state.map);
    m.bindPopup(`<b>${loc.name}</b><br/>${loc.type}${loc.berth_use ? '<br/>'+loc.berth_use : ''}<br/>${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`);
    state.locMarkers.push(m);
  }

  if (merge) {
    const b20 = state.locsById.B20, b4 = state.locsById.B4;
    const center = [(b20.lat + b4.lat) / 2, (b20.lon + b4.lon) / 2];
    const html = `<div class="berth-icon merged"><div class="berth-pin"></div><div class="berth-label">Shuaiba Port</div><div class="berth-sub">B20 · B4</div></div>`;
    const icon = L.divIcon({ className: '', html, iconSize: [110, 34], iconAnchor: [55, 17] });
    const m = L.marker(center, { icon, title: 'Shuaiba Port (Berths 20 & 4)' }).addTo(state.map);
    m.bindPopup('<b>Shuaiba Port</b><br/>Berth 20 (PSVs) + Berth 4 (Crew SV)<br/>Zoom in to separate berths.');
    state.locMarkers.push(m);
  }
}

function rebuildVesselMarkers() {
  for (const v of state.vessels) {
    if (state.vesselMarkers[v.id]) {
      state.map.removeLayer(state.vesselMarkers[v.id]);
    }
    const isJuno = v.id === 'JUNO';
    const lengthPx = iconPx(v.length_m, isJuno ? 22 : 28);
    const beamPx = iconPx(v.beam_m, isJuno ? 8 : 11);
    const svg = isJuno ? fastCrewSvg(v.color, v.stroke) : psvSvg(v.color, v.stroke);
    const html = `<div class="vessel-marker" style="--vc:${v.color};width:${beamPx}px;height:${lengthPx}px">
        <div class="vessel-body">${svg}</div>
        <div class="vessel-label">${v.id}</div>
      </div>`;
    const icon = L.divIcon({
      className: '',
      html,
      iconSize: [beamPx, lengthPx],
      iconAnchor: [beamPx / 2, lengthPx / 2],
    });
    const m = L.marker([0, 0], { icon, zIndexOffset: 1000 }).addTo(state.map);
    m.bindPopup(`<b>${v.name}</b><br/>${v.type}<br/>${v.length_m} × ${v.beam_m} m · ${v.speed_kts} kts`);
    state.vesselMarkers[v.id] = m;
  }
}

function initMap() {
  state.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([29.08, 48.28], 10);
  applyTheme(state.theme);

  rebuildLocationMarkers();
  rebuildVesselMarkers();
  drawRoutes();

  state.map.on('zoomend', () => {
    rebuildLocationMarkers();
    rebuildVesselMarkers();
    render();
  });
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

function applyAntiOverlap(positions) {
  // Reposition moored vessels so they don't stack on top of their berth/rig icon.
  //   - At a RIG: vessels park alongside (east face), spaced lengthwise, bow oriented
  //     parallel to the rig — that's how supply boats actually moor offshore.
  //   - At a Shuaiba berth when zoom < 13 the B20/B4 pins are visually merged, so we
  //     group B20+B4 together and spread the vessels in a small ring around the merged
  //     pin so Juno (B4) and CA5 (B20) don't stack on each other.
  //   - At other ports/berths with multiple vessels, fall back to a ring spread.
  const zoom = state.map ? state.map.getZoom() : 99;
  const berthsMerged = zoom < 13;
  const groupKey = (locId) => (berthsMerged && (locId === 'B20' || locId === 'B4')) ? 'SHUAIBA' : locId;

  const groups = {};
  for (const [vid, p] of Object.entries(positions)) {
    if (!p || !p.segment) continue;
    if (p.segment.type === 'moored') {
      const key = groupKey(p.segment.loc);
      groups[key] = groups[key] || [];
      groups[key].push(vid);
    }
  }

  const cosLat = Math.cos(29 * Math.PI / 180);
  const mToDegLat = 1 / 111000;
  const mToDegLon = 1 / (111000 * cosLat);

  for (const key in groups) {
    const vids = groups[key].sort();
    const n = vids.length;
    if (n === 0) continue;

    const loc = state.locsById[key] || (key === 'SHUAIBA' ? state.locsById.B20 : null);
    const isRig = loc && loc.type === 'rig';

    if (isRig) {
      // Park alongside the rig on its east face. Even a lone vessel gets offset so it
      // never sits on top of the platform.
      const sideOffsetM = 90;  // rig is ~60 m square + vessel half-beam ~10 m + gap
      const spacingM = 35;     // lengthwise spacing between adjacent vessels
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) / 2) * spacingM;
        positions[vids[i]].lon += sideOffsetM * mToDegLon;
        positions[vids[i]].lat += along * mToDegLat;
        positions[vids[i]].heading = 0; // bow north, parallel to the rig east face
      }
      continue;
    }

    if (n > 1) {
      const r = 0.0009; // ~100 m ring for ports with multiple vessels
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        positions[vids[i]].lat += Math.cos(angle) * r;
        positions[vids[i]].lon += Math.sin(angle) * r / cosLat;
      }
    }
  }
}

function nextTransit(vid, t) {
  const segs = state.timelines[vid];
  if (!segs) return null;
  return segs.find(s => s.type === 'transit' && s.t0 > t && !s.repositioning);
}

function render() {
  const t = state.currentTime;
  document.getElementById('clock').textContent = toKuwaitStr(t);
  const range = state.timelineEnd - state.timelineStart;
  const frac = (t - state.timelineStart) / range;
  document.getElementById('slider').value = Math.round(frac * 1000);

  // Compute all positions
  const positions = {};
  for (const v of state.vessels) {
    positions[v.id] = positionAt(v.id, t);
  }
  applyAntiOverlap(positions);

  const cards = [];
  for (const v of state.vessels) {
    const pos = positions[v.id];
    const marker = state.vesselMarkers[v.id];
    if (pos) {
      marker.setLatLng([pos.lat, pos.lon]);
      const el = marker.getElement();
      if (el) {
        const body = el.querySelector('.vessel-body');
        if (body) body.style.transform = `rotate(${pos.heading || 0}deg)`;
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
    statusHtml = `<span class="tag unknown">${pos.status || 'unknown'}</span>`;
    metaHtml = '';
  } else if (s.type === 'moored') {
    const loc = state.locsById[s.loc];
    statusHtml = `<span class="tag moored">Moored</span> ${loc ? loc.short : s.loc}`;
    metaHtml = `${s.purpose || 'STBY'}`;
  } else {
    const from = state.locsById[s.from];
    const to = state.locsById[s.to];
    const frac = Math.min(1, Math.max(0, (state.currentTime - s.t0) / (s.t1 - s.t0)));
    const tag = s.repositioning ? '<span class="tag transit">Repositioning</span>' : '<span class="tag transit">Transit</span>';
    statusHtml = `${tag} ${from.short} → ${to.short} (${Math.round(frac*100)}%)`;
    const durHr = (s.t1 - s.t0) / 3600000;
    metaHtml = `${s.purpose || ''} · ${s.distance_nm ? s.distance_nm.toFixed(1) + ' nm' : ''} · ${durHr.toFixed(1)} h @ ${v.speed_kts} kts${s.eta_anchored ? ' · ETA anchored' : ''}`;
  }
  const next = nextTransit(v.id, state.currentTime);
  const nextHtml = next
    ? `<div class="next">Next: ${state.locsById[next.from].short} → ${state.locsById[next.to].short} @ ${toKuwaitStr(next.t0)}</div>`
    : '<div class="next">No further planned movements.</div>';
  return `<div class="vessel-card" style="--vc:${v.color}">
    <div class="name">${v.name} <span class="sub">${v.length_m}×${v.beam_m} m · ${v.speed_kts} kts</span></div>
    <div class="status">${statusHtml}</div>
    <div class="meta">${metaHtml}</div>
    ${nextHtml}
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
    // Fit map to all locations (cap zoom so it doesn't collapse on narrow viewports)
    const bounds = L.latLngBounds(state.locs.map(l => [l.lat, l.lon]));
    state.map.fitBounds(bounds.pad(0.08), { maxZoom: 11 });
    if (state.map.getZoom() < 9) state.map.setZoom(10);
    render();
    requestAnimationFrame(animationLoop);
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b">${err.stack || err.message || err}</pre>`;
  }
}

document.addEventListener('DOMContentLoaded', main);
