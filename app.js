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
  // --- Live AIS state ---
  liveMode: false,
  liveWs: null,
  liveReconnectTimer: null,
  liveReconnectAttempts: 0,
  livePositions: {}, // vid -> { lat, lon, heading, sog, cog, ts (Date), mmsi }
  liveMmsiByVid: {},
  liveVidByMmsi: {},
  // --- Imported AIS history overlay ---
  aisTracksByVid: {},     // vid -> sorted array of { ts (Date), lat, lon, sog, cog }
  aisOverlayEnabled: false,
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
  const [loc, ves] = await Promise.all([
    fetch('data/locations.json').then(r => r.json()),
    fetch('data/vessels.json').then(r => r.json()),
  ]);
  state.locs = loc.locations;
  state.locsById = Object.fromEntries(state.locs.map(l => [l.id, l]));
  state.vessels = ves.vessels;
  state.vesselsById = Object.fromEntries(state.vessels.map(v => [v.id, v]));
  state.defaults = ves.defaults;

  // New source of truth: parsed captains' daily reports.  The API serves an
  // index + one JSON per (vessel, date).  Fallback to the old plans.json
  // only if the daily-reports tree is empty.
  state.reports = [];
  state.reportsByVid = {};
  try {
    const idx = await fetch('/api/reports').then(r => r.ok ? r.json() : null);
    if (idx && Array.isArray(idx.reports) && idx.reports.length) {
      const records = await Promise.all(
        idx.reports.map(r => fetch(`/api/reports/${r.vessel_id}/${r.report_date}`)
          .then(rr => rr.ok ? rr.json() : null))
      );
      state.reports = records.filter(Boolean);
      for (const r of state.reports) {
        (state.reportsByVid[r.vessel_id] ||= []).push(r);
      }
      for (const vid in state.reportsByVid) {
        state.reportsByVid[vid].sort((a, b) => a.report_date.localeCompare(b.report_date));
      }
    }
  } catch (e) {
    console.warn('[reports] could not load from /api/reports — falling back to plans.json:', e);
  }

  if (!state.reports.length) {
    // Legacy fallback: original PDF-derived movement plans.
    try {
      const plans = await fetch('data/plans.json').then(r => r.json());
      state.plans = plans.plans;
      state.legacy = true;
    } catch (e) {
      state.plans = [];
    }
  }

  // Best-effort load of any imported AIS history tracks.  Silent if none
  // are present yet — the simulator falls back to daily-report interpolation.
  try {
    const idx = await fetch('/api/ais-history').then(r => r.ok ? r.json() : null);
    const tracks = idx?.tracks || [];
    if (tracks.length) {
      const records = await Promise.all(
        tracks.map(t => fetch(`/api/ais-history/${t.vessel_id}/${t.date_utc}`)
          .then(r => r.ok ? r.json() : null))
      );
      for (const rec of records) {
        if (!rec || !rec.positions) continue;
        const bucket = (state.aisTracksByVid[rec.vessel_id] ||= []);
        for (const p of rec.positions) {
          const ts = new Date(p.ts);
          if (!isNaN(ts)) bucket.push({ ts, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog });
        }
      }
      for (const vid in state.aisTracksByVid) {
        state.aisTracksByVid[vid].sort((a, b) => a.ts - b.ts);
      }
    }
  } catch (e) {
    console.warn('[ais-history] could not load:', e);
  }
}

// ----------------------------------------------------------------------------
// Timeline builder: captains' daily reports → per-vessel transit/moored segments.
// Each report's `task_log` row becomes a segment; consecutive moored segments
// at the same location are merged so the timeline stays readable.
// ----------------------------------------------------------------------------

const TRANSIT_CODES = new Set(['I01', 'I02']);

function parseTaskTime(reportDate, hhmm) {
  if (!hhmm) return null;
  if (hhmm === '24:00') {
    const d = new Date(reportDate + 'T00:00:00+03:00');
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  return parseLocalTime(`${reportDate}T${hhmm}`);
}

function codeIsTransit(code) {
  if (!code) return false;
  return code.split(/[/+]/).some(c => TRANSIT_CODES.has(c.trim()));
}

function rowsToSegments(reportDate, rows) {
  // Sort by from_time (string compare is fine for HH:MM).
  const sorted = [...rows].filter(r => r && r.from_time)
    .sort((a, b) => a.from_time.localeCompare(b.from_time));
  const out = [];
  let prevKnownLoc = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const t0 = parseTaskTime(reportDate, r.from_time);
    let t1 = parseTaskTime(reportDate, r.to_time);
    if (!t1) {
      // Use the next row's from_time, or end-of-day, as the implicit end.
      const next = sorted[i + 1];
      t1 = next ? parseTaskTime(reportDate, next.from_time)
                : parseTaskTime(reportDate, '24:00');
    }
    if (!t0 || !t1 || t1 <= t0) continue;

    const transit = codeIsTransit(r.task_code);
    const ll = r.location_id || null;
    const from = r.from_location_id || prevKnownLoc || null;
    const to   = r.to_location_id   || ll || null;

    if (transit && from && to && from !== to) {
      const fromLoc = state.locsById[from];
      const toLoc   = state.locsById[to];
      out.push({
        type: 'transit',
        t0, t1, from, to,
        purpose: r.description || r.task_label || '',
        raw: r.description || '',
        task_code: r.task_code,
        distance_nm: (fromLoc && toLoc) ? distNm(fromLoc, toLoc) : null,
      });
      prevKnownLoc = to;
    } else if (transit && (from === to || !to)) {
      // Transit row but we don't know where it's going. Hold position.
      const loc = to || from || prevKnownLoc;
      if (loc) {
        out.push({
          type: 'moored', t0, t1, loc,
          purpose: r.description || r.task_label || '',
          raw: r.description || '',
          task_code: r.task_code,
        });
        prevKnownLoc = loc;
      }
    } else {
      const loc = ll || prevKnownLoc;
      if (loc) {
        out.push({
          type: 'moored', t0, t1, loc,
          purpose: r.description || r.task_label || '',
          raw: r.description || '',
          task_code: r.task_code,
        });
        prevKnownLoc = loc;
      }
    }
  }
  return out;
}

function fillGapsWithMoored(segs) {
  // Whenever there's a gap between consecutive segments (e.g. the captain
  // explicitly logged a row ending at 06:42 but the next row starts at 07:10),
  // bridge it with a "moored at the last-known location" segment so the map
  // doesn't lose the vessel in between.
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const prev = out[out.length - 1];
    if (prev && prev.t1.getTime() < s.t0.getTime()) {
      const endLoc = prev.type === 'transit' ? prev.to : prev.loc;
      if (endLoc) {
        out.push({
          type: 'moored',
          t0: prev.t1,
          t1: s.t0,
          loc: endLoc,
          purpose: 'STBY (gap fill)',
          raw: null,
          filler: true,
        });
      }
    }
    out.push(s);
  }
  return out;
}

function mergeRunsOfSameLoc(segs) {
  // Merge consecutive moored segments that are at the same location.
  // Keeps the human-readable "purpose" of the first segment in the run, but
  // tags the merged block with how many sub-events it covered so the popup
  // can hint at it.
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'moored' && s.type === 'moored' && prev.loc === s.loc
        && prev.t1.getTime() === s.t0.getTime()) {
      prev.t1 = s.t1;
      prev.merged_count = (prev.merged_count || 1) + 1;
      // Keep a comma-separated trail of sub-purposes (truncate to keep ui sane)
      if (s.purpose && prev.purpose && !prev.purpose.includes(s.purpose)) {
        if ((prev.purpose + '; ' + s.purpose).length < 240) {
          prev.purpose = `${prev.purpose}; ${s.purpose}`;
        }
      }
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

function buildTimelinesFromReports() {
  const tl = {};
  state.vessels.forEach(v => { tl[v.id] = []; });

  for (const vid in state.reportsByVid) {
    const reports = state.reportsByVid[vid];
    const segs = [];
    for (const rep of reports) {
      const rowsSegs = rowsToSegments(rep.report_date, rep.task_log || []);
      segs.push(...rowsSegs);
    }
    segs.sort((a, b) => a.t0 - b.t0);
    tl[vid] = mergeRunsOfSameLoc(fillGapsWithMoored(segs));
  }
  state.timelines = tl;

  let minT = Infinity, maxT = -Infinity;
  for (const vid in tl) {
    for (const s of tl[vid]) {
      if (s.t0 && s.t0.getTime() < minT) minT = s.t0.getTime();
      if (s.t1 && s.t1.getTime() > maxT) maxT = s.t1.getTime();
    }
  }
  // Also include AIS keyframes — newly-polled positions may extend past the
  // daily-report timeline (e.g. JUNO at 2026-05-15 when the last report is
  // 2026-05-12).  Without this the slider can't reach the polled data and
  // the halo can never appear at those times.
  for (const vid in state.aisTracksByVid) {
    for (const p of state.aisTracksByVid[vid]) {
      const t = p.ts.getTime();
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
  }
  if (!isFinite(minT) || !isFinite(maxT)) {
    // No reports loaded. Pick today as a placeholder so the controls render.
    const now = Date.now();
    state.timelineStart = new Date(now - 24 * 3600 * 1000);
    state.timelineEnd   = new Date(now + 24 * 3600 * 1000);
  } else {
    state.timelineStart = new Date(minT);
    state.timelineEnd   = new Date(maxT + 6 * 3600 * 1000); // 6 h trailing pad
  }
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

// Binary-search nearest AIS sample for vessel vid at time t.  Returns null
// if no AIS data is loaded for this vessel, or the closest sample exceeds
// AIS_MAX_GAP_MS so we don't accept a half-day-old point as "current."
const AIS_MAX_GAP_MS = 30 * 60 * 1000;  // 30 minutes
function nearestAisPoint(vid, t) {
  const track = state.aisTracksByVid[vid];
  if (!track || track.length === 0) return null;
  // Binary search for the insertion point of t.
  let lo = 0, hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].ts < t) lo = mid + 1; else hi = mid;
  }
  const before = lo > 0 ? track[lo - 1] : null;
  const after  = lo < track.length ? track[lo] : null;
  let candidate = null;
  if (before && after) {
    candidate = (t - before.ts) <= (after.ts - t) ? before : after;
  } else {
    candidate = before || after;
  }
  if (!candidate) return null;
  return Math.abs(candidate.ts - t) <= AIS_MAX_GAP_MS ? candidate : null;
}

function positionAt(vid, t) {
  // When the AIS overlay is on and we have a real sample close to t, use it
  // verbatim and skip the segment interpolation. The "segment" return is the
  // operational state from the daily report — we still show it in the popup,
  // so the user sees both layers (position from AIS, context from captain).
  if (state.aisOverlayEnabled) {
    const ais = nearestAisPoint(vid, t);
    if (ais) {
      const segs = state.timelines[vid] || [];
      const seg = segs.find(s => s.t0 <= t && t <= s.t1) || null;
      return {
        lat: ais.lat,
        lon: ais.lon,
        segment: seg,
        heading: Number.isFinite(ais.cog) ? ais.cog : 0,
        ais: true,
      };
    }
  }
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
  // Clear BOTH layers first — the "Show routes" toggle hides both the
  // planned/interpolated dashed lines AND the real-AIS trail.  The early
  // return below previously skipped the AIS clear, which left cyan lines
  // stranded on the map when the user unticked Show routes.
  state.routePolylines.forEach(p => state.map.removeLayer(p));
  state.routePolylines = [];
  if (state.aisLayers) {
    state.aisLayers.forEach(l => state.map.removeLayer(l));
  }
  state.aisLayers = [];

  if (!state.showRoutes) return;  // both layers hidden

  // Layer 1: planned/interpolated routes from daily reports (thin dashed)
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
  // Layer 2: real AIS trail (only if its toggle is also on)
  drawAisTracks();
}

// AIS-history overlay: when the user has imported real positions and toggled
// the overlay on, draw the keyframe trail.  Different visual language from the
// planned routes (solid + thicker + dot at every fix) so the eye can tell at a
// glance which path is from the captain's log and which is real AIS truth.
//
// Note: clearing the previous AIS polylines is done by drawRoutes() — call
// that, not this function directly, when toggling state.  This function only
// DRAWS; it expects state.aisLayers to be empty when entered.
function drawAisTracks() {
  if (!state.aisOverlayEnabled || !state.showRoutes) return;
  state.aisLayers = state.aisLayers || [];
  for (const vid in state.aisTracksByVid) {
    const v = state.vesselsById[vid];
    if (!v) continue;
    const track = state.aisTracksByVid[vid];
    if (!track || track.length < 1) continue;
    // Polyline through the keyframes
    if (track.length >= 2) {
      const line = L.polyline(track.map(p => [p.lat, p.lon]), {
        color: v.color,
        weight: 3,
        opacity: 0.85,
        lineCap: 'round',
        className: 'ais-track-line',
      }).addTo(state.map);
      line.bindTooltip(`${v.name} — real AIS keyframes (${track.length})`, { sticky: true });
      state.aisLayers.push(line);
    }
    // Small dot at every keyframe so the granularity is visible
    for (const p of track) {
      const dot = L.circleMarker([p.lat, p.lon], {
        radius: 3,
        color: v.stroke || '#222',
        weight: 1,
        fillColor: v.color,
        fillOpacity: 1,
        className: 'ais-keyframe-dot',
      }).addTo(state.map);
      dot.bindTooltip(
        `${v.name} · ${new Date(p.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC` +
        (typeof p.sog === 'number' ? ` · ${p.sog.toFixed(1)} kts` : ''),
        { sticky: true }
      );
      state.aisLayers.push(dot);
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
    const isBerth = loc && (loc.type === 'berth' || loc.type === 'port' || key === 'SHUAIBA');

    if (isRig) {
      // Alongside the east face of the rig, bow-north so the hull is vertical and
      // parallel to the rig's east side.
      const sideOffsetM = 90;
      const spacingM = 35;
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) / 2) * spacingM;
        positions[vids[i]].lon += sideOffsetM * mToDegLon;
        positions[vids[i]].lat += along * mToDegLat;
        positions[vids[i]].heading = 0;
      }
      continue;
    }

    if (isBerth) {
      // Shuaiba berths sit along the quay; vessels lie horizontally (east-west) just
      // off the berth pin so the label is readable. Multiple vessels at the merged
      // Shuaiba pin stack north-south, each parallel to its own berth.
      const sideOffsetM = 55;  // east of the berth pin, into the water
      const spacingM = 45;     // lateral spacing between vessels (B20 north of B4)
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) / 2) * spacingM;
        positions[vids[i]].lon += sideOffsetM * mToDegLon;
        positions[vids[i]].lat += along * mToDegLat;
        positions[vids[i]].heading = 90; // bow east → horizontal silhouette
      }
      continue;
    }

    if (n > 1) {
      const r = 0.0009; // fallback ring spread for any other co-located group
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

// =================== LIVE AIS (AISStream.io) ===================

function aisConfig() {
  return (typeof window !== 'undefined' && window.AIS_CONFIG) || null;
}

function buildMmsiMaps() {
  const cfg = aisConfig();
  if (!cfg) return;
  state.liveMmsiByVid = { ...cfg.MMSI_BY_VESSEL };
  state.liveVidByMmsi = Object.fromEntries(
    Object.entries(cfg.MMSI_BY_VESSEL).map(([vid, mmsi]) => [String(mmsi), vid])
  );
}

function startLiveTracking() {
  const cfg = aisConfig();
  if (!cfg || !cfg.AISSTREAM_API_KEY || cfg.AISSTREAM_API_KEY === 'your_aisstream_api_key_here') {
    alert('Live tracking requires an AISStream.io API key.\nGet one free at https://aisstream.io and put it in config.local.js.');
    return false;
  }
  buildMmsiMaps();
  state.liveMode = true;
  state.playing = false;
  state.liveReconnectAttempts = 0;
  updateLiveUi();
  openLiveWs();
  return true;
}

function stopLiveTracking() {
  state.liveMode = false;
  if (state.liveReconnectTimer) {
    clearTimeout(state.liveReconnectTimer);
    state.liveReconnectTimer = null;
  }
  if (state.liveWs) {
    try { state.liveWs.close(1000, 'user stopped'); } catch (e) {}
    state.liveWs = null;
  }
  state.livePositions = {};
  updateLiveUi();
  render();
}

function openLiveWs() {
  const cfg = aisConfig();
  if (!cfg) return;
  state.liveMsgCount = 0;
  state.liveOtherMmsis = new Set();
  state.liveLastMessageAt = null;
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  state.liveWs = ws;

  ws.onopen = () => {
    state.liveReconnectAttempts = 0;
    // DIAGNOSTIC subscription: bounding box ONLY, no server-side MMSI filter.
    // This lets us see whether AISStream has any receiver coverage in the
    // Gulf at all. We filter to our 4 MMSIs client-side in handleAisMessage.
    const sub = {
      APIKey: cfg.AISSTREAM_API_KEY,
      BoundingBoxes: [[
        [cfg.BBOX.latMin, cfg.BBOX.lonMin],
        [cfg.BBOX.latMax, cfg.BBOX.lonMax],
      ]],
      // Subscribe to all position-bearing message types so we don't miss
      // anything (Class A, Class B, long-range satellite).
      FilterMessageTypes: [
        'PositionReport',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
        'LongRangeAisBroadcastMessage',
      ],
    };
    console.log('[AIS] Subscribing:', sub);
    ws.send(JSON.stringify(sub));
    updateLiveUi('Subscribed — bbox-only, listening…');
  };

  ws.onmessage = async (evt) => {
    state.liveMsgCount = (state.liveMsgCount || 0) + 1;
    state.liveLastMessageAt = new Date();
    // AISStream may deliver each AIS message as a Blob or ArrayBuffer rather
    // than a string depending on the WebSocket runtime. Normalise to text
    // before JSON.parse — otherwise we silently drop every single message.
    let text;
    try {
      if (typeof evt.data === 'string') text = evt.data;
      else if (evt.data instanceof Blob) text = await evt.data.text();
      else if (evt.data instanceof ArrayBuffer) text = new TextDecoder().decode(evt.data);
      else text = String(evt.data);
    } catch (e) {
      console.warn('[AIS] could not read message body:', e);
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch (e) {
      console.warn('[AIS] non-JSON message:', text);
      return;
    }
    // Surface server errors instead of swallowing them.
    if (msg.error) {
      console.error('[AIS] server error:', msg.error);
      updateLiveUi(`Server error: ${msg.error}`);
      return;
    }
    if (state.liveMsgCount <= 3) console.log('[AIS] msg:', msg);
    handleAisMessage(msg);
    // Update status with a running tally so the user has feedback even when
    // none of the messages are for our 4 MMSIs.
    const ours = Object.keys(state.livePositions).length;
    const others = state.liveOtherMmsis.size;
    updateLiveUi(`${state.liveMsgCount} msgs received · ${ours}/4 of our vessels · ${others} other MMSIs in bbox`);
  };

  ws.onerror = (e) => {
    console.error('[AIS] WS error', e);
    updateLiveUi('WebSocket error — see console');
  };

  ws.onclose = (e) => {
    console.warn('[AIS] WS closed:', e.code, e.reason);
    state.liveWs = null;
    if (!state.liveMode) return;
    state.liveReconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * Math.pow(2, state.liveReconnectAttempts));
    updateLiveUi(`Disconnected (code ${e.code}${e.reason ? ': '+e.reason : ''}) — retrying in ${Math.round(delay/1000)}s`);
    state.liveReconnectTimer = setTimeout(() => {
      if (state.liveMode) openLiveWs();
    }, delay);
  };
}

function handleAisMessage(msg) {
  if (!msg || !msg.MessageType) return;
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || meta.MMSI_String || '');
  if (!mmsi) return;
  const vid = state.liveVidByMmsi[mmsi];
  if (!vid) {
    // Not one of our 4 — but record so we can tell user that coverage exists.
    if (state.liveOtherMmsis) state.liveOtherMmsis.add(mmsi);
    return;
  }

  // Extract lat/lon/cog/sog from whichever message body exists
  const body = msg.Message || {};
  const inner = body.PositionReport || body.StandardClassBPositionReport ||
                body.ExtendedClassBPositionReport || body.LongRangeAisBroadcastMessage || null;
  if (!inner) return;

  const lat = inner.Latitude;
  const lon = inner.Longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return;

  const sog = inner.Sog;
  const cog = inner.Cog;
  const trueHeading = inner.TrueHeading;
  // Heading: prefer TrueHeading if valid (0–359), else fall back to COG.
  let heading = 0;
  if (typeof trueHeading === 'number' && trueHeading >= 0 && trueHeading < 360) heading = trueHeading;
  else if (typeof cog === 'number') heading = cog;

  state.livePositions[vid] = {
    lat, lon, heading,
    sog: typeof sog === 'number' ? sog : null,
    cog: typeof cog === 'number' ? cog : null,
    ts: new Date(meta.time_utc || Date.now()),
    mmsi,
  };

  if (state.liveMode) render();
}

function updateLiveUi(statusText) {
  const btn = document.getElementById('btnLive');
  const ind = document.getElementById('liveIndicator');
  const st = document.getElementById('liveStatus');
  if (btn) {
    btn.classList.toggle('active', state.liveMode);
    btn.textContent = state.liveMode ? '■ Live (on)' : '● Live';
  }
  if (ind) ind.hidden = !state.liveMode;
  if (st) {
    if (!state.liveMode) st.textContent = 'Off';
    else if (statusText) st.textContent = statusText;
    else st.textContent = 'Connecting…';
  }
}

function relativeAgo(ts) {
  if (!ts) return '—';
  const ms = Date.now() - ts.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

function render() {
  // Datalastic live: positions land in state.aisTracksByVid and the normal
  // render() path (via positionAt + AIS overlay) handles them — no fork
  // needed.  (The legacy AISStream renderLive() is parked; AISStream has no
  // Persian Gulf coverage.)

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
        // Tag the inner .vessel-marker (NOT the leaflet wrapper) so the
        // ::before halo CSS can find it.  Class went on the wrong element
        // in the first cut — that's why nothing was pulsing.
        const vm = el.querySelector('.vessel-marker') || el;
        vm.classList.toggle('is-ais-source', !!pos.ais);
        const body = el.querySelector('.vessel-body');
        if (body) body.style.transform = `rotate(${pos.heading || 0}deg)`;
      }
    }
    cards.push(vesselCardHtml(v, pos));
  }
  document.getElementById('vesselCards').innerHTML = cards.join('');
}

function renderLive() {
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = toKuwaitStr(new Date());

  const cards = [];
  for (const v of state.vessels) {
    const live = state.livePositions[v.id];
    const marker = state.vesselMarkers[v.id];
    if (live) {
      marker.setLatLng([live.lat, live.lon]);
      const el = marker.getElement();
      if (el) {
        const body = el.querySelector('.vessel-body');
        if (body) body.style.transform = `rotate(${live.heading || 0}deg)`;
      }
    }
    cards.push(vesselCardLiveHtml(v, live));
  }
  document.getElementById('vesselCards').innerHTML = cards.join('');
}

function vesselCardLiveHtml(v, live) {
  const mmsi = state.liveMmsiByVid[v.id] || '—';
  if (!live) {
    return `<div class="vessel-card" style="--vc:${v.color}">
      <div class="name">${v.name} <span class="sub">MMSI ${mmsi}</span></div>
      <div class="status"><span class="tag unknown">Waiting for AIS…</span></div>
      <div class="meta">Subscribed via AISStream.io — vessel hasn't broadcast since connect.</div>
    </div>`;
  }
  const ageMin = (Date.now() - live.ts.getTime()) / 60000;
  const stale = ageMin > 15;
  const moving = (live.sog || 0) > 0.5;
  const statusTag = moving
    ? `<span class="tag transit">Underway</span> ${live.sog.toFixed(1)} kts · COG ${Math.round(live.cog || 0)}°`
    : `<span class="tag moored">Stopped/Moored</span> ${live.sog != null ? live.sog.toFixed(1)+' kts' : ''}`;
  return `<div class="vessel-card" style="--vc:${v.color}">
    <div class="name">${v.name} <span class="sub">MMSI ${mmsi}</span></div>
    <div class="status">${statusTag}</div>
    <div class="meta">${live.lat.toFixed(5)}, ${live.lon.toFixed(5)} · HDG ${Math.round(live.heading || 0)}°</div>
    <div class="live-line${stale ? ' stale' : ''}">${stale ? '⚠ ' : '● '}Last AIS: ${relativeAgo(live.ts)} (${toKuwaitStr(live.ts)})</div>
  </div>`;
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

  // Position source badge — tells the user whether the dot on the map is from
  // real AIS or interpolated from the captain's daily-report timeline.
  let sourceHtml = '';
  if (state.aisOverlayEnabled) {
    if (pos.ais) {
      const nearest = nearestAisPoint(v.id, state.currentTime);
      const ago = nearest ? Math.round(Math.abs(state.currentTime - nearest.ts) / 60000) : null;
      sourceHtml = `<div class="source ais">📡 Position: <b>real AIS</b>` +
        (ago !== null ? ` · nearest fix ${ago} min ${nearest.ts < state.currentTime ? 'before' : 'after'} now` : '') +
        `</div>`;
    } else {
      sourceHtml = `<div class="source report">📝 Position: <b>interpolated from daily report</b> · no AIS within ±30 min</div>`;
    }
  }
  return `<div class="vessel-card" style="--vc:${v.color}">
    <div class="name">${v.name} <span class="sub">${v.length_m}×${v.beam_m} m · ${v.speed_kts} kts</span></div>
    <div class="status">${statusHtml}</div>
    ${sourceHtml}
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
    if (state.liveMode) {
      // Turning play on while in live mode doesn't make sense — leave live mode first.
      stopLiveTracking();
    }
    state.playing = !state.playing;
    e.target.textContent = state.playing ? '⏸ Pause' : '▶ Play';
    state.lastTickMs = performance.now();
  });

  const btnLive = document.getElementById('btnLive');
  if (btnLive) {
    btnLive.addEventListener('click', async () => {
      // Datalastic-driven live (replaces the old AISStream WebSocket path —
      // that's parked because AISStream has no Persian Gulf coverage).
      if (state.liveMode) {
        await stopLiveDatalastic();
      } else {
        if (state.playing) {
          state.playing = false;
          document.getElementById('btnPlay').textContent = '▶ Play';
        }
        await startLiveDatalastic();
      }
    });
  }
  // Refresh the "last poll N seconds ago" line once per second while live.
  setInterval(() => {
    if (state.liveMode && state.liveStatus) updateLiveUi(formatLiveStatus(state.liveStatus));
  }, 1000);

  // Refresh "Last AIS: X ago" once a second while in live mode, even if no new
  // messages have arrived.
  setInterval(() => {
    if (state.liveMode) {
      state.currentTime = new Date();   // keep clock pinned to "now"
      render();
    }
  }, 1000);

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

  const aisCb = document.getElementById('cbAisTrack');
  const aisStatus = document.getElementById('aisStatus');
  if (aisCb) {
    const trackCount = Object.values(state.aisTracksByVid).reduce((n, t) => n + t.length, 0);
    const trackVids  = Object.keys(state.aisTracksByVid).length;
    if (trackCount === 0) {
      aisCb.disabled = true;
      aisStatus.hidden = false;
      aisStatus.textContent = 'no AIS imported yet — run tools/import_ais_history.py';
    } else {
      aisStatus.hidden = false;
      aisStatus.textContent = `${trackCount} positions across ${trackVids} vessel(s) loaded`;
    }
    aisCb.addEventListener('change', e => {
      state.aisOverlayEnabled = e.target.checked;
      drawRoutes();   // redraws the AIS trail polylines/keyframe dots
      render();
    });
  }

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
  if (state.playing && !state.liveMode && state.lastTickMs != null) {
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

function rebuildAndRefresh() {
  if (state.reports && state.reports.length) {
    buildTimelinesFromReports();
  } else {
    buildTimelines();
  }
  const range = document.getElementById('dataRange');
  if (range) range.textContent =
    `${toKuwaitStr(state.timelineStart)} → ${toKuwaitStr(state.timelineEnd)}`;
  render();
}

// Subscribe to server events: dashboard submissions, live polling updates,
// and live status.  Single EventSource for all of them — multiplexed by event
// name on the server side (see server.mjs).
function subscribeToReportStream() {
  let es;
  try { es = new EventSource('/api/stream'); }
  catch (e) { console.warn('[reports] EventSource unavailable:', e); return; }

  // --- Dashboard report saved ---
  es.addEventListener('report_saved', async (evt) => {
    try {
      const { vessel_id, report_date } = JSON.parse(evt.data);
      const rec = await fetch(`/api/reports/${vessel_id}/${report_date}`).then(r => r.ok ? r.json() : null);
      if (!rec) return;
      const existing = (state.reportsByVid[vessel_id] ||= []);
      const ix = existing.findIndex(r => r.report_date === rec.report_date);
      if (ix >= 0) existing[ix] = rec; else existing.push(rec);
      existing.sort((a, b) => a.report_date.localeCompare(b.report_date));
      state.reports = Object.values(state.reportsByVid).flat();
      rebuildAndRefresh();
      const ind = document.getElementById('liveStatus');
      if (ind) ind.textContent = `Updated from dashboard: ${vessel_id} ${report_date}`;
    } catch (e) {
      console.warn('[reports] could not apply update:', e);
    }
  });

  // --- Datalastic live poll: a fresh position arrived ---
  es.addEventListener('live_position', (evt) => {
    try {
      const { vessel_id, position } = JSON.parse(evt.data);
      if (!position || !position.ts) return;
      const ts = new Date(position.ts);
      if (isNaN(ts)) return;
      const bucket = (state.aisTracksByVid[vessel_id] ||= []);
      // Dedup by exact timestamp.
      if (bucket.some(p => p.ts.getTime() === ts.getTime())) return;
      bucket.push({ ts, lat: position.lat, lon: position.lon, sog: position.sog, cog: position.cog });
      bucket.sort((a, b) => a.ts - b.ts);
      // Auto-jump the clock to "now" when live mode is on, so the user sees
      // the vessel snap to its fresh position instead of staring at an old time.
      if (state.liveMode) state.currentTime = new Date();
      rebuildAndRefresh();
    } catch (e) {
      console.warn('[live] could not apply position:', e);
    }
  });

  // --- Datalastic live status updates ---
  es.addEventListener('live_status', (evt) => {
    try {
      const s = JSON.parse(evt.data);
      state.liveStatus = s;
      // Reconcile state.liveMode with the server's running flag — if the
      // server is polling but the UI thinks live is off (or vice versa), the
      // server is authoritative because it's the one burning credits.
      state.liveMode = !!s.running;
      updateLiveUi(formatLiveStatus(s));
    } catch (e) { /* ignore */ }
  });

  es.onerror = () => { /* EventSource auto-reconnects */ };
  state.reportEventSource = es;
}

function formatLiveStatus(s) {
  if (!s) return 'Off';
  if (s.last_error) return `Error: ${s.last_error}`;
  if (!s.running) {
    if (s.polls_this_session) {
      return `Stopped · last session ${s.polls_this_session} polls, ${s.new_positions_this_session} new`;
    }
    return 'Off';
  }
  const ageS = s.last_poll_at
    ? Math.max(0, Math.round((Date.now() - new Date(s.last_poll_at).getTime()) / 1000))
    : null;
  const ageTxt = ageS === null ? 'polling…'
    : ageS < 60 ? `last poll ${ageS}s ago`
    : `last poll ${Math.floor(ageS / 60)}m ${ageS % 60}s ago`;
  const intMin = Math.round(s.interval_ms / 60_000);
  return `Live (Datalastic, ${intMin} min) · ${ageTxt} · ${s.new_positions_this_session} new this session`;
}

// --- New live-mode entry points: drive Datalastic via the server ---
async function startLiveDatalastic() {
  try {
    state.playing = false;
    // Force AIS overlay on so the live position snaps the dot; also tick the
    // checkbox so the user sees the state matches the data they're now seeing.
    state.aisOverlayEnabled = true;
    const cb = document.getElementById('cbAisTrack');
    if (cb) { cb.checked = true; cb.disabled = false; }
    // Pin the clock to "now" — every fresh position should re-pin (handled in
    // the live_position SSE listener).
    state.currentTime = new Date();
    drawRoutes();
    render();

    const r = await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_ms: 120_000 }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert('Could not start live: ' + (j.error || r.statusText));
      return false;
    }
    return true;
  } catch (e) {
    alert('Could not start live: ' + e.message);
    return false;
  }
}

async function stopLiveDatalastic() {
  try { await fetch('/api/live/stop', { method: 'POST' }); } catch {}
}

async function main() {
  try {
    state.theme = localStorage.getItem('vesselSimTheme') || 'dark';
    document.documentElement.dataset.theme = state.theme;
    await loadData();
    if (state.reports && state.reports.length) {
      buildTimelinesFromReports();
    } else {
      buildTimelines();
    }
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
    subscribeToReportStream();
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b">${err.stack || err.message || err}</pre>`;
  }
}

document.addEventListener('DOMContentLoaded', main);
