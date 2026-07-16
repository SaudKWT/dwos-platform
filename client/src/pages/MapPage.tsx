import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { FastForward, Pause, Play, Rewind, SkipBack, SkipForward } from 'lucide-react'
import { api } from '@/api/client'
import { useLocations, useVessels } from '@/api/queries'
import type { DailyReport, Vessel } from '@/api/types'
import type { AisTrackPoint, LearnedRoute, LearnedVessel, SimContext, Segment } from '@/features/simulator/engine'
import {
  activeSubEvent, buildTimelinesFromReports, isVesselActive, nearestAisPoint,
  nextSubEvent, nextTransit, positionAt, transitSpeedKts,
} from '@/features/simulator/engine'
import { fmtDur, toKuwaitStr } from '@/features/simulator/geo'
import SimulatorLayer from '@/features/simulator/SimulatorLayer'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
}
const ATTRIBUTION = '&copy; OpenStreetMap &copy; CARTO'
const KUWAIT_CENTER: [number, number] = [29.09, 48.3]

const SPEED_OPTIONS = [
  { value: 60, label: '1× (1 min/sec)' },
  { value: 300, label: '5×' },
  { value: 1800, label: '30× (30 min/sec)' },
  { value: 3600, label: '60× (1 hr/sec)' },
  { value: 14400, label: '240×' },
]

/** Leaflet measures its container once at mount; re-measure after flex layout. */
function ResizeHandler() {
  const map = useMap()
  useEffect(() => {
    const invalidate = () => map.invalidateSize()
    invalidate()
    const observer = new ResizeObserver(invalidate)
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map])
  return null
}

/** Every daily report, fetched the way the original app did: index, then each record. */
function useAllReports() {
  return useQuery({
    queryKey: ['all-reports'],
    staleTime: Infinity,
    queryFn: async () => {
      const index = await api.reportIndex()
      const records = await Promise.all(
        index.map(r => api.report(r.vessel_id, r.report_date).catch(() => null)),
      )
      const byVid: Record<string, DailyReport[]> = {}
      for (const rec of records) {
        if (!rec) continue
        ;(byVid[rec.vessel_id] ??= []).push(rec)
      }
      for (const vid in byVid) {
        byVid[vid].sort((a, b) => a.report_date.localeCompare(b.report_date))
      }
      return byVid
    },
  })
}

/** All imported AIS tracks, keyed by vessel, sorted by time. */
function useAisTracks() {
  return useQuery({
    queryKey: ['all-ais'],
    staleTime: Infinity,
    queryFn: async () => {
      const index = await api.aisIndex()
      const days = await Promise.all(
        index.map(t => api.aisDay(t.vessel_id, t.date_utc).catch(() => null)),
      )
      const byVid: Record<string, AisTrackPoint[]> = {}
      for (const day of days) {
        if (!day) continue
        const bucket = (byVid[day.vessel_id] ??= [])
        for (const p of day.positions) {
          const ts = new Date(p.ts)
          if (!isNaN(ts.getTime())) bucket.push({ ts, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog })
        }
      }
      for (const vid in byVid) byVid[vid].sort((a, b) => a.ts.getTime() - b.ts.getTime())
      return byVid
    },
  })
}

/** Cruise speeds + route shapes learned from AIS (static artifact, like the original). */
function useLearnedProfiles() {
  return useQuery({
    queryKey: ['learned-profiles'],
    staleTime: Infinity,
    queryFn: async () => {
      try {
        const res = await fetch('/learned-profiles.json')
        if (!res.ok) return { vessels: {}, routes: {} }
        const lp = await res.json()
        const routes: Record<string, LearnedRoute> = {}
        for (const r of lp.routes ?? []) routes[`${r.vessel_id}|${r.from}|${r.to}`] = r
        return { vessels: (lp.vessels ?? {}) as Record<string, LearnedVessel>, routes }
      } catch {
        return { vessels: {} as Record<string, LearnedVessel>, routes: {} as Record<string, LearnedRoute> }
      }
    },
  })
}

export default function MapPage() {
  const theme = useTheme()
  const vessels = useVessels()
  const locations = useLocations()
  const reports = useAllReports()
  const aisTracks = useAisTracks()
  const learned = useLearnedProfiles()

  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1800)
  const [showRoutes, setShowRoutes] = useState(true)
  const [aisOverlay, setAisOverlay] = useState(false)
  // Display copy of the clock; the authoritative value lives in timeRef so the
  // animation can run every frame without a React render per frame.
  const [displayTime, setDisplayTime] = useState(0)
  const timeRef = useRef(0)

  const ctx: SimContext | null = useMemo(() => {
    if (!vessels.data || !locations.data || !learned.data) return null
    return {
      locsById: Object.fromEntries(locations.data.locations.map(l => [l.id, l])),
      vesselsById: Object.fromEntries(vessels.data.map(v => [v.id, v])),
      learnedVessels: learned.data.vessels,
      learnedRoutes: learned.data.routes,
    }
  }, [vessels.data, locations.data, learned.data])

  const built = useMemo(() => {
    if (!ctx || !reports.data || !aisTracks.data) return null
    return buildTimelinesFromReports(ctx, reports.data, aisTracks.data)
  }, [ctx, reports.data, aisTracks.data])

  // Start the clock once everything is loaded. Deep-linkable: /map?t=2026-05-06T13:30
  // jumps straight to that Kuwait-local moment, &play=1 starts playback — so a
  // specific situation can be shared as a URL.
  useEffect(() => {
    if (!built || timeRef.current !== 0) return
    const params = new URLSearchParams(window.location.search)
    const tParam = params.get('t')
    const parsed = tParam ? Date.parse(`${tParam}:00+03:00`) : NaN
    timeRef.current = Number.isFinite(parsed)
      ? Math.min(built.timelineEnd.getTime(), Math.max(built.timelineStart.getTime(), parsed))
      : built.timelineStart.getTime()
    setDisplayTime(timeRef.current)
    if (params.get('play') === '1') setPlaying(true)
  }, [built])

  // Playback: advance sim time by wall-time × speed. The marker layer reads
  // timeRef every frame; React redraws (clock, cards, slider) are throttled.
  useEffect(() => {
    if (!playing || !built) return
    let raf = 0
    let last = performance.now()
    let lastReact = 0
    const tick = (now: number) => {
      const dt = now - last
      last = now
      timeRef.current += dt * speed
      if (timeRef.current >= built.timelineEnd.getTime()) {
        timeRef.current = built.timelineEnd.getTime()
        setPlaying(false)
      }
      if (now - lastReact > 200) {
        lastReact = now
        setDisplayTime(timeRef.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, built])

  const setTime = useCallback((ms: number) => {
    if (!built) return
    const clamped = Math.min(built.timelineEnd.getTime(), Math.max(built.timelineStart.getTime(), ms))
    timeRef.current = clamped
    setDisplayTime(clamped)
  }, [built])

  const stepTime = (seconds: number) => setTime(timeRef.current + seconds * 1000)

  const loading = vessels.isLoading || locations.isLoading || reports.isLoading
    || aisTracks.isLoading || learned.isLoading
  const error = vessels.error ?? locations.error ?? reports.error ?? aisTracks.error

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive">Could not load the fleet.</p>
          <p className="mt-1 text-muted-foreground">{String(error)}</p>
        </div>
      </div>
    )
  }

  const t = new Date(displayTime)
  const range = built ? built.timelineEnd.getTime() - built.timelineStart.getTime() : 1
  const sliderValue = built ? Math.round(((displayTime - built.timelineStart.getTime()) / range) * 1000) : 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto border-r p-3">
          {loading && <p className="p-1 text-xs text-muted-foreground">Loading fleet, reports and AIS…</p>}
          {built && ctx && vessels.data?.filter(v => isVesselActive(v, t)).map(v => (
            <VesselCard
              key={v.id}
              vessel={v}
              ctx={ctx}
              t={t}
              segments={built.timelines[v.id] ?? []}
              aisTracks={aisTracks.data ?? {}}
              aisOverlay={aisOverlay}
            />
          ))}
          {built && vessels.data?.filter(v => !isVesselActive(v, t)).map(v => (
            <div key={v.id} className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <span className="line-through">{v.name}</span>
              {' — '}
              {v.retired_on && t.getTime() >= Date.parse(`${v.retired_on}T00:00:00+03:00`)
                ? `retired ${v.retired_on}`
                : `enters service ${v.active_from}`}
            </div>
          ))}
        </aside>

        <div className="relative min-w-0 flex-1">
          <MapContainer center={KUWAIT_CENTER} zoom={10} className="h-full w-full">
            <ResizeHandler />
            {/* key remounts the layer on theme change — Leaflet caches the URL */}
            <TileLayer key={theme} url={TILES[theme]} attribution={ATTRIBUTION} subdomains="abcd" />
            {ctx && built && vessels.data && aisTracks.data && (
              <SimulatorLayer
                ctx={ctx}
                timelines={built.timelines}
                aisTracksByVid={aisTracks.data}
                vessels={vessels.data}
                timeRef={timeRef}
                options={{ showRoutes, aisOverlay }}
              />
            )}
          </MapContainer>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2">
        <div className="flex items-center gap-1">
          <ControlButton title="Back one day" onClick={() => stepTime(-86400)}><SkipBack className="h-4 w-4" /></ControlButton>
          <ControlButton title="Back one hour" onClick={() => stepTime(-3600)}><Rewind className="h-4 w-4" /></ControlButton>
          <ControlButton
            title={playing ? 'Pause' : 'Play'}
            primary
            onClick={() => setPlaying(p => !p)}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </ControlButton>
          <ControlButton title="Forward one hour" onClick={() => stepTime(3600)}><FastForward className="h-4 w-4" /></ControlButton>
          <ControlButton title="Forward one day" onClick={() => stepTime(86400)}><SkipForward className="h-4 w-4" /></ControlButton>
        </div>

        <select
          className="rounded-md border bg-card px-2 py-1 text-xs"
          value={speed}
          onChange={e => setSpeed(Number(e.target.value))}
          title="Playback speed"
        >
          {SPEED_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <input
          type="range" min={0} max={1000}
          value={sliderValue}
          onChange={e => built && setTime(built.timelineStart.getTime() + (Number(e.target.value) / 1000) * range)}
          className="min-w-32 flex-1 accent-primary"
        />

        <span className="font-mono text-sm tabular-nums">{toKuwaitStr(t)}</span>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showRoutes} onChange={e => setShowRoutes(e.target.checked)} className="accent-primary" />
          Routes
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Prefer real AIS positions when a fix exists within ±30 min">
          <input type="checkbox" checked={aisOverlay} onChange={e => setAisOverlay(e.target.checked)} className="accent-primary" />
          AIS overlay
        </label>
      </footer>
    </div>
  )
}

function ControlButton({ children, onClick, title, primary }: {
  children: React.ReactNode
  onClick: () => void
  title: string
  primary?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
        primary ? 'bg-primary text-primary-foreground hover:opacity-90' : 'bg-card hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}

/** Sidebar card — a port of the original vesselCardHtml. */
function VesselCard({ vessel: v, ctx, t, segments, aisTracks, aisOverlay }: {
  vessel: Vessel
  ctx: SimContext
  t: Date
  segments: Segment[]
  aisTracks: Record<string, AisTrackPoint[]>
  aisOverlay: boolean
}) {
  const timelines = useMemo(() => ({ [v.id]: segments }), [v.id, segments])
  const pos = positionAt(ctx, timelines, aisTracks, aisOverlay, v.id, t)

  let status: React.ReactNode
  let meta = ''
  const s = pos?.segment ?? null

  if (!pos) {
    status = <Tag tone="muted">No data</Tag>
  } else if (!s) {
    status = <Tag tone="muted">{pos.status === 'pre-timeline' ? 'No report yet at this time' : 'After last report'}</Tag>
  } else if (s.type === 'moored') {
    const loc = ctx.locsById[s.loc!]
    status = <><Tag tone="moored">Moored</Tag> {loc?.short ?? s.loc}</>
    // Show ONLY the activity current at the simulation clock — the full chain
    // lives in the Daily Reports tab.
    const active = activeSubEvent(s, t)
    meta = (active?.purpose) || s.purpose || 'STBY'
  } else {
    const from = ctx.locsById[s.from!]
    const to = ctx.locsById[s.to!]
    const frac = Math.min(1, Math.max(0, (t.getTime() - s.t0.getTime()) / (s.t1.getTime() - s.t0.getTime())))
    const kts = transitSpeedKts(s)
    const remainMin = Math.max(0, (s.t1.getTime() - t.getTime()) / 60000)
    status = (
      <>
        <Tag tone="transit">Underway</Tag> {from?.short} → {to?.short}
        {s.turned_back && <span className="text-muted-foreground"> (turned back)</span>}
        <div className="mt-1 h-1 overflow-hidden rounded bg-secondary">
          <div className="h-full bg-primary" style={{ width: `${Math.round(frac * 100)}%` }} />
        </div>
      </>
    )
    meta = [
      s.purpose || '',
      s.distance_nm ? `${s.distance_nm.toFixed(1)} nm` : '',
      kts ? `${kts.toFixed(1)} kt` : '',
      `ETA ${toKuwaitStr(s.t1).slice(11)}${s.eta_estimated ? ' (est.)' : ''} · in ${fmtDur(remainMin)}`,
    ].filter(Boolean).join(' · ')
  }

  // "Next" line: prefer the next sub-event inside the current moored block,
  // fall back to the next planned transit.
  const nextSub = s?.type === 'moored' ? nextSubEvent(s, t) : null
  const nextTr = nextTransit(timelines, v.id, t)
  const next = nextSub?.purpose
    ? `Next: ${nextSub.purpose.replace(' (gap fill)', '')}`
    : nextTr
      ? `Next: ${ctx.locsById[nextTr.from!]?.short} → ${ctx.locsById[nextTr.to!]?.short}`
      : 'No further planned movements.'

  // Position source badge — AIS truth vs interpolated from the daily report.
  let source: React.ReactNode = null
  if (aisOverlay && pos) {
    if (pos.ais) {
      const nearest = nearestAisPoint(aisTracks, v.id, t)
      const ago = nearest ? Math.round(Math.abs(t.getTime() - nearest.ts.getTime()) / 60000) : null
      source = (
        <div className="text-[11px] text-cyan-400">
          📡 Position: <b>real AIS</b>
          {ago !== null && ` · nearest fix ${ago} min ${nearest!.ts < t ? 'before' : 'after'} now`}
        </div>
      )
    } else {
      source = <div className="text-[11px] text-muted-foreground">📝 Position: <b>interpolated from daily report</b> · no AIS within ±30 min</div>
    }
  }

  return (
    <div className="rounded-lg border p-3 text-sm" style={{ borderLeftColor: v.color ?? undefined, borderLeftWidth: 3 }}>
      <div className="font-medium">
        {v.name}{' '}
        <span className="text-xs font-normal text-muted-foreground">
          {v.length_m}×{v.beam_m} m · {v.speed_kts} kts
        </span>
      </div>
      <div className="mt-1">{status}</div>
      {source}
      {meta && <div className="mt-1 text-xs text-muted-foreground">{meta}</div>}
      <div className="mt-1 text-xs text-muted-foreground/80">{next}</div>
    </div>
  )
}

function Tag({ tone, children }: { tone: 'moored' | 'transit' | 'muted'; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
      tone === 'moored' && 'bg-emerald-500/15 text-emerald-400',
      tone === 'transit' && 'bg-sky-500/15 text-sky-400',
      tone === 'muted' && 'bg-secondary text-muted-foreground',
    )}>
      {children}
    </span>
  )
}
