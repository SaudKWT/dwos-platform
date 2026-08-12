import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { Vessel } from '@/features/vessel-movement/api/types'
import type { AisTrackPoint, SimContext, Timelines, VesselPosition } from './engine'
import { rigZoneColor, vesselFallbackFill, vesselFallbackStroke } from './mapTokens'
import {
  applyAntiOverlap, coveredPolyline, isVesselActive, positionAt, transitSpeedKts,
} from './engine'
import {
  berthIconHtml, fastCrewSvg, iconPx, jackupRigSvg, mergedBerthIconHtml,
  portIconHtml, psvSvg,
} from './icons'

// The moving parts of the map, managed imperatively.
//
// React reconciliation is the wrong tool for markers that move every animation
// frame — the original app drives Leaflet directly and so does this port. React
// owns the shell (sidebar, controls); this component owns every layer on the
// map and reads the authoritative clock from `timeRef` each frame, so vessel
// motion stays smooth no matter how often React renders.

export interface SimulatorOptions {
  showRoutes: boolean
  aisOverlay: boolean
}

interface Props {
  ctx: SimContext
  timelines: Timelines
  aisTracksByVid: Record<string, AisTrackPoint[]>
  vessels: Vessel[]
  /** Authoritative simulation clock (ms). Mutated by the playback loop. */
  timeRef: React.MutableRefObject<number>
  options: SimulatorOptions
}

export default function SimulatorLayer({
  ctx, timelines, aisTracksByVid, vessels, timeRef, options,
}: Props) {
  const map = useMap()
  const vesselMarkers = useRef<Record<string, L.Marker>>({})
  const locMarkers = useRef<L.Marker[]>([])
  const rigZones = useRef<L.Circle[]>([])
  const routeLines = useRef<L.Polyline[]>([])
  const aisLayers = useRef<(L.Polyline | L.CircleMarker)[]>([])
  const transitLines = useRef<L.Polyline[]>([])

  // ---- location markers, rebuilt on zoom (B20/B4 merge below zoom 13) ------
  useEffect(() => {
    const rebuild = () => {
      locMarkers.current.forEach(m => map.removeLayer(m))
      locMarkers.current = []
      const zoom = map.getZoom()
      const merge = zoom < 13
      const locs = Object.values(ctx.locsById)

      for (const loc of locs) {
        if (merge && (loc.id === 'B20' || loc.id === 'B4')) continue
        let html: string
        let iconSize: [number, number]
        let iconAnchor: [number, number]
        if (loc.type === 'rig') {
          const px = iconPx(60, 30, zoom)
          html = `<div class="rig-marker" style="width:${px}px;height:${px}px"><div class="rig-body">${jackupRigSvg()}</div><div class="rig-label">${loc.short ?? loc.id}</div><div class="rig-occ" data-occ="${loc.id}" hidden></div></div>`
          iconSize = [px, px]
          iconAnchor = [px / 2, px / 2]
        } else if (loc.type === 'port') {
          html = portIconHtml(loc.short ?? loc.id)
          iconSize = [80, 30]
          iconAnchor = [40, 15]
        } else {
          html = berthIconHtml(loc.short ?? loc.id)
          iconSize = [70, 26]
          iconAnchor = [35, 13]
        }
        const icon = L.divIcon({ className: '', html, iconSize, iconAnchor })
        const m = L.marker([loc.lat, loc.lon], { icon, title: loc.name }).addTo(map)
        m.bindPopup(`<b>${loc.name}</b><br/>${loc.type}${loc.berth_use ? '<br/>' + loc.berth_use : ''}<br/>${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`)
        locMarkers.current.push(m)
      }

      if (merge && ctx.locsById.B20 && ctx.locsById.B4) {
        const b20 = ctx.locsById.B20
        const b4 = ctx.locsById.B4
        const center: [number, number] = [(b20.lat + b4.lat) / 2, (b20.lon + b4.lon) / 2]
        const icon = L.divIcon({
          className: '', html: mergedBerthIconHtml(),
          iconSize: [110, 34], iconAnchor: [55, 17],
        })
        const m = L.marker(center, { icon, title: 'Shuaiba Port (Berths 20 & 4)' }).addTo(map)
        m.bindPopup('<b>Shuaiba Port</b><br/>Berth 20 (PSVs) + Berth 4 (Crew SV)<br/>Zoom in to separate berths.')
        locMarkers.current.push(m)
      }
    }
    rebuild()
    map.on('zoomend', rebuild)
    return () => {
      map.off('zoomend', rebuild)
      locMarkers.current.forEach(m => map.removeLayer(m))
      locMarkers.current = []
    }
  }, [map, ctx])

  // ---- 500 m rig safety zones ----------------------------------------------
  useEffect(() => {
    for (const loc of Object.values(ctx.locsById)) {
      if (loc.type !== 'rig') continue
      const c = L.circle([loc.lat, loc.lon], {
        radius: 500,
        color: rigZoneColor(), weight: 1, opacity: 0.45, dashArray: '4,5',
        fillColor: rigZoneColor(), fillOpacity: 0.05, interactive: false,
      }).addTo(map)
      rigZones.current.push(c)
    }
    return () => {
      rigZones.current.forEach(c => map.removeLayer(c))
      rigZones.current = []
    }
  }, [map, ctx])

  // ---- route polylines (dashed captain's-narrative routes + AIS trail) -----
  useEffect(() => {
    routeLines.current.forEach(p => map.removeLayer(p))
    routeLines.current = []
    aisLayers.current.forEach(l => map.removeLayer(l))
    aisLayers.current = []
    if (!options.showRoutes) return

    // Story routes from the daily reports — thin dashed lines in each vessel's
    // colour. Learned AIS shape when we have one, straight from→to otherwise.
    const seenRoutes = new Set<string>()
    for (const vid in timelines) {
      const v = ctx.vesselsById[vid]
      if (!v) continue
      for (const s of timelines[vid].filter(s => s.type === 'transit')) {
        const routeKey = `${vid}|${s.from}|${s.to}`
        if (seenRoutes.has(routeKey)) continue
        seenRoutes.add(routeKey)
        const from = ctx.locsById[s.from!]
        const to = ctx.locsById[s.to!]
        if (!from || !to) continue
        const path = (Array.isArray(s.polyline) && s.polyline.length >= 2)
          ? s.polyline
          : [[from.lat, from.lon], [to.lat, to.lon]] as [number, number][]
        const p = L.polyline(path, {
          color: v.color ?? vesselFallbackFill(), weight: 1.5, opacity: 0.35, dashArray: '3,5',
        }).addTo(map)
        routeLines.current.push(p)
      }
    }

    // Real AIS trail — different visual language (solid + thicker + a dot at
    // every fix) so the eye can tell captain's log from AIS truth.
    if (options.aisOverlay) {
      for (const vid in aisTracksByVid) {
        const v = ctx.vesselsById[vid]
        if (!v) continue
        const track = aisTracksByVid[vid]
        if (!track || track.length < 1) continue
        if (track.length >= 2) {
          const line = L.polyline(track.map(p => [p.lat, p.lon] as [number, number]), {
            color: v.color ?? vesselFallbackFill(), weight: 3, opacity: 0.85, lineCap: 'round',
          }).addTo(map)
          line.bindTooltip(`${v.name} — real AIS keyframes (${track.length})`, { sticky: true })
          aisLayers.current.push(line)
        }
        for (const p of track) {
          const dot = L.circleMarker([p.lat, p.lon], {
            radius: 3, color: v.stroke ?? vesselFallbackStroke(), weight: 1,
            fillColor: v.color ?? vesselFallbackFill(), fillOpacity: 1,
          }).addTo(map)
          dot.bindTooltip(
            `${v.name} · ${p.ts.toISOString().replace('T', ' ').slice(0, 16)} UTC` +
            (typeof p.sog === 'number' ? ` · ${p.sog.toFixed(1)} kts` : ''),
            { sticky: true },
          )
          aisLayers.current.push(dot)
        }
      }
    }
    return () => {
      routeLines.current.forEach(p => map.removeLayer(p))
      routeLines.current = []
      aisLayers.current.forEach(l => map.removeLayer(l))
      aisLayers.current = []
    }
  }, [map, ctx, timelines, aisTracksByVid, options.showRoutes, options.aisOverlay])

  // ---- vessel markers -------------------------------------------------------
  useEffect(() => {
    const buildMarkers = () => {
      for (const id in vesselMarkers.current) map.removeLayer(vesselMarkers.current[id])
      vesselMarkers.current = {}
      const zoom = map.getZoom()
      for (const v of vessels) {
        // Draw by what the vessel *is*, not by its id: Charlie 3 is a fast crew
        // boat like Juno, and keying off 'JUNO' drew it with the PSV hull.
        const isCrewBoat = /crew\s*boat/i.test(v.type || '')
        const lengthPx = iconPx(v.length_m ?? 60, isCrewBoat ? 22 : 28, zoom)
        const beamPx = iconPx(v.beam_m ?? 14, isCrewBoat ? 8 : 11, zoom)
        const svg = isCrewBoat
          ? fastCrewSvg(v.color ?? vesselFallbackFill(), v.stroke ?? vesselFallbackStroke())
          : psvSvg(v.color ?? vesselFallbackFill(), v.stroke ?? vesselFallbackStroke())
        const html = `<div class="vessel-marker" style="--vc:${v.color};width:${beamPx}px;height:${lengthPx}px">
            <div class="vessel-body">${svg}</div>
            <div class="vessel-label">${v.id}</div>
          </div>`
        const icon = L.divIcon({
          className: '', html,
          iconSize: [beamPx, lengthPx],
          iconAnchor: [beamPx / 2, lengthPx / 2],
        })
        const m = L.marker([0, 0], { icon, zIndexOffset: 1000 })
        m.bindPopup(`<b>${v.name}</b><br/>${v.type ?? ''}<br/>${v.length_m} × ${v.beam_m} m · ${v.speed_kts} kts`)
        vesselMarkers.current[v.id] = m
      }
    }
    buildMarkers()
    // Icon size tracks zoom (real metres per pixel), like the original.
    map.on('zoomend', buildMarkers)
    return () => {
      map.off('zoomend', buildMarkers)
      for (const id in vesselMarkers.current) map.removeLayer(vesselMarkers.current[id])
      vesselMarkers.current = {}
    }
  }, [map, vessels])

  // ---- the render loop ------------------------------------------------------
  useEffect(() => {
    let raf = 0
    const frame = () => {
      const t = new Date(timeRef.current)

      // Only vessels in service at this moment. Charlie 3 replaced Allianz
      // Juno — outside its window a vessel must leave the map entirely.
      const positions: Record<string, VesselPosition | null> = {}
      for (const v of vessels) {
        const marker = vesselMarkers.current[v.id]
        if (!marker) continue
        const onDuty = isVesselActive(v, t)
        const shown = map.hasLayer(marker)
        if (onDuty && !shown) marker.addTo(map)
        else if (!onDuty && shown) map.removeLayer(marker)
        if (onDuty) {
          positions[v.id] = positionAt(ctx, timelines, aisTracksByVid, options.aisOverlay, v.id, t)
        }
      }
      applyAntiOverlap(ctx, positions, map.getZoom())

      for (const v of vessels) {
        const pos = positions[v.id]
        const marker = vesselMarkers.current[v.id]
        if (!pos || !marker || !map.hasLayer(marker)) continue
        marker.setLatLng([pos.lat, pos.lon])
        const el = marker.getElement()
        if (el) {
          const vm = el.querySelector('.vessel-marker') as HTMLElement | null ?? el
          vm.classList.toggle('is-ais-source', !!pos.ais)
          const underway = !!(pos.segment && pos.segment.type === 'transit')
          vm.classList.toggle('is-underway', underway)
          const body = el.querySelector('.vessel-body') as HTMLElement | null
          if (body) body.style.transform = `rotate(${pos.heading || 0}deg)`
          // Map label shows the current speed while the vessel is underway.
          const label = el.querySelector('.vessel-label') as HTMLElement | null
          if (label) {
            const kts = underway ? transitSpeedKts(pos.segment) : null
            const txt = kts ? `${v.id} · ${kts.toFixed(1)} kt` : v.id
            if (label.textContent !== txt) label.textContent = txt
          }
        }
      }

      // Solid "path covered so far" line behind each vessel in transit.
      transitLines.current.forEach(l => map.removeLayer(l))
      transitLines.current = []
      for (const v of vessels) {
        const p = positions[v.id]
        if (!p || !p.segment || p.segment.type !== 'transit' || p.ais) continue
        const seg = p.segment
        const from = ctx.locsById[seg.from!]
        const to = ctx.locsById[seg.to!]
        const path = (Array.isArray(seg.polyline) && seg.polyline.length >= 2)
          ? seg.polyline
          : (from && to ? [[from.lat, from.lon], [to.lat, to.lon]] as [number, number][] : null)
        if (!path) continue
        const frac = Math.min(1, Math.max(0,
          (timeRef.current - seg.t0.getTime()) / (seg.t1.getTime() - seg.t0.getTime())))
        const covered = coveredPolyline(path, frac)
        covered.push([p.lat, p.lon])
        const line = L.polyline(covered, {
          color: v.color ?? vesselFallbackFill(), weight: 3, opacity: 0.85,
          lineCap: 'round', interactive: false,
        }).addTo(map)
        transitLines.current.push(line)
      }

      // Rig occupancy badge: "⚓n" on each rig with vessels alongside.
      const occ: Record<string, number> = {}
      for (const vid in positions) {
        const p = positions[vid]
        if (p?.segment?.type === 'moored') {
          const loc = ctx.locsById[p.segment.loc!]
          if (loc?.type === 'rig') occ[loc.id] = (occ[loc.id] || 0) + 1
        }
      }
      document.querySelectorAll<HTMLElement>('.rig-occ[data-occ]').forEach(el => {
        const rigId = el.dataset.occ!
        const n = occ[rigId] || 0
        el.hidden = n === 0
        el.textContent = `⚓${n}`
      })

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      transitLines.current.forEach(l => map.removeLayer(l))
      transitLines.current = []
    }
  }, [map, ctx, timelines, aisTracksByVid, vessels, options.aisOverlay, timeRef])

  return null
}
