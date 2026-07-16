import { useEffect, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { api } from '@/api/client'
import { useLocations, useReportIndex, useVessels } from '@/api/queries'
import type { DailyReport, Vessel } from '@/api/types'
import { type Fix, fixesAt, formatClock, isVesselActiveOn } from '@/features/simulator/timeline'

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
}
const ATTRIBUTION = '&copy; OpenStreetMap &copy; CARTO'
const KUWAIT_CENTER: [number, number] = [29.09, 48.3]

/**
 * Leaflet measures its container once, at mount. Inside a flex layout that
 * happens before the pane has been given its real width, so the map believes it
 * is a few hundred pixels wide and requests only the handful of tiles that would
 * cover that — leaving most of the pane blank. Re-measuring after layout, and on
 * every resize, is what makes the map fill its space.
 */
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

/**
 * Draws one group of vessels that share a position, fanned around it.
 *
 * The fan is measured in screen pixels, not degrees. A fixed degree offset is
 * wrong at every zoom but one: 0.004° is invisible when the whole Gulf is on
 * screen, and half a kilometre of fiction when zoomed to a berth. Converting
 * through the map's own projection keeps the fan the same size on screen and
 * keeps the markers honest — they stay visually attached to the real point.
 */
function VesselGroup({ group, vessels, minute }: {
  group: Fix[]
  vessels: Map<string, Vessel>
  minute: number
}) {
  const map = useMap()
  const [, setZoom] = useState(map.getZoom())

  // The projection changes with zoom, so the fan must be recomputed on zoom.
  useEffect(() => {
    const onZoom = () => setZoom(map.getZoom())
    map.on('zoomend', onZoom)
    return () => { map.off('zoomend', onZoom) }
  }, [map])

  const FAN_RADIUS_PX = 11

  return (
    <>
      {group.map((fix, i) => {
        let center: [number, number] = [fix.lat, fix.lon]

        if (group.length > 1) {
          const angle = (2 * Math.PI * i) / group.length - Math.PI / 2
          const point = map.latLngToLayerPoint([fix.lat, fix.lon])
          const fanned = map.layerPointToLatLng([
            point.x + FAN_RADIUS_PX * Math.cos(angle),
            point.y + FAN_RADIUS_PX * Math.sin(angle),
          ])
          center = [fanned.lat, fanned.lng]
        }

        const v = vessels.get(fix.vesselId)
        return (
          <CircleMarker
            key={fix.vesselId}
            center={center}
            radius={8}
            pathOptions={{
              color: v?.stroke ?? '#000',
              fillColor: v?.color ?? '#888',
              fillOpacity: 1,
              weight: 2,
            }}
          >
            <Tooltip direction="top" offset={[0, -8]}>{v?.name ?? fix.vesselId}</Tooltip>
            <Popup>
              <div className="text-sm">
                <div className="font-medium">{v?.name ?? fix.vesselId}</div>
                <div className="text-xs opacity-70">{formatClock(minute)} · {fix.locationId}</div>
                {fix.label && <div className="mt-1 text-xs">{fix.label}</div>}
              </div>
            </Popup>
          </CircleMarker>
        )
      })}
    </>
  )
}

export default function MapPage() {
  const vessels = useVessels()
  const locations = useLocations()
  const reportIndex = useReportIndex()

  const [minute, setMinute] = useState(12 * 60)
  const [date, setDate] = useState<string>()

  // Dates that actually have reports — the scrubber should only offer days the
  // data can answer for.
  const dates = useMemo(() => {
    const set = new Set((reportIndex.data ?? []).map(r => r.report_date))
    return [...set].sort()
  }, [reportIndex.data])

  const activeDate = date ?? dates[0]

  const vesselsForDate = useMemo(
    () => (reportIndex.data ?? []).filter(r => r.report_date === activeDate),
    [reportIndex.data, activeDate],
  )

  // One fetch per (vessel, day) report, mirroring how the API stores them.
  const reportQueries = useQueries({
    queries: vesselsForDate.map(row => ({
      queryKey: ['report', row.vessel_id, row.report_date],
      queryFn: () => api.report(row.vessel_id, row.report_date),
      enabled: Boolean(activeDate),
      staleTime: Infinity,
    })),
  })

  const reports = reportQueries
    .map(q => q.data)
    .filter((r): r is DailyReport => Boolean(r))

  const vesselMap = useMemo(
    () => new Map((vessels.data ?? []).map(v => [v.id, v])),
    [vessels.data],
  )
  const locationMap = useMemo(
    () => new Map((locations.data?.locations ?? []).map(l => [l.id, l])),
    [locations.data],
  )

  const fixes = useMemo(
    () => fixesAt(minute, reports, vesselMap, locationMap, locations.data?.aliases ?? {}),
    [minute, reports, vesselMap, locationMap, locations.data],
  )

  // Several vessels routinely sit at the same berth or rig. Stacked exactly on
  // top of each other they read as one boat, so co-located markers are fanned
  // out around the shared point.
  const groups = useMemo(() => {
    const byPoint = new Map<string, typeof fixes>()
    for (const f of fixes) {
      const key = `${f.lat},${f.lon}`
      byPoint.set(key, [...(byPoint.get(key) ?? []), f])
    }
    return [...byPoint.values()]
  }, [fixes])

  const loading = vessels.isLoading || locations.isLoading || reportIndex.isLoading
  const error = vessels.error ?? locations.error ?? reportIndex.error

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

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r p-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Date</label>
          <select
            className="w-full rounded-md border bg-card px-2 py-1.5 text-sm"
            value={activeDate ?? ''}
            onChange={e => setDate(e.target.value)}
            disabled={!dates.length}
          >
            {dates.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label className="text-xs font-medium text-muted-foreground">Time (Kuwait)</label>
            <span className="font-mono text-sm tabular-nums">{formatClock(minute)}</span>
          </div>
          <input
            type="range" min={0} max={1439} step={5}
            value={minute}
            onChange={e => setMinute(Number(e.target.value))}
            className="w-full accent-primary"
          />
        </div>

        <div className="border-t pt-3">
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">
            Fleet {activeDate && <span className="opacity-60">· {activeDate}</span>}
          </h2>
          <ul className="space-y-1.5">
            {(vessels.data ?? []).map(v => {
              const fix = fixes.find(f => f.vesselId === v.id)
              const inService = activeDate ? isVesselActiveOn(v, activeDate) : true
              const loc = fix ? locationMap.get(fix.locationId ?? '') : undefined
              return (
                <li key={v.id} className="flex items-start gap-2 text-sm">
                  <span
                    className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border"
                    style={{
                      background: inService ? v.color ?? '#888' : 'transparent',
                      borderColor: v.stroke ?? '#555',
                    }}
                  />
                  <span className="min-w-0">
                    <span className={inService ? '' : 'text-muted-foreground line-through'}>
                      {v.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {!inService
                        ? v.retired_on && activeDate && activeDate >= v.retired_on
                          ? `retired ${v.retired_on}`
                          : `enters service ${v.active_from}`
                        : loc
                          ? loc.short ?? loc.name
                          : 'no report for this time'}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
      </aside>

      <div className="min-w-0 flex-1">
        <MapContainer center={KUWAIT_CENTER} zoom={10} className="h-full w-full">
          <ResizeHandler />
          <TileLayer url={TILES.dark} attribution={ATTRIBUTION} subdomains="abcd" />

          {(locations.data?.locations ?? []).map(l => (
            <CircleMarker
              key={l.id}
              center={[l.lat, l.lon]}
              radius={5}
              pathOptions={{ color: '#64748b', fillColor: '#334155', fillOpacity: 0.9, weight: 1.5 }}
            >
              <Tooltip>{l.short ?? l.name}</Tooltip>
              <Popup>
                <div className="text-sm">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs opacity-70">{l.type}{l.berth_use ? ` · ${l.berth_use}` : ''}</div>
                  <div className="mt-1 font-mono text-xs">{l.lat.toFixed(6)}, {l.lon.toFixed(6)}</div>
                </div>
              </Popup>
            </CircleMarker>
          ))}

          {groups.map(group => (
            <VesselGroup
              key={group.map(f => f.vesselId).join('-')}
              group={group}
              vessels={vesselMap}
              minute={minute}
            />
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
