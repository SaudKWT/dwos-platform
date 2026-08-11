// Geometry + time helpers, ported from app.js. All times are Kuwait local
// (UTC+3) unless a name says otherwise.

export const TZ_OFFSET_MIN = 3 * 60

export function parseLocalTime(iso: string | null | undefined): Date | null {
  if (!iso) return null
  return new Date(iso + ':00+03:00')
}

export function toKuwaitStr(d: Date | null | undefined): string {
  if (!d) return '—'
  const k = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ` +
         `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`
}

/** Fast flat-earth distance in nautical miles — fine at this scale (Kuwait coast). */
export function distNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const cosLat = Math.cos(29 * Math.PI / 180)
  const dLatNm = (b.lat - a.lat) * 60
  const dLonNm = (b.lon - a.lon) * 60 * cosLat
  return Math.sqrt(dLatNm * dLatNm + dLonNm * dLonNm)
}

export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const phi1 = a.lat * Math.PI / 180
  const phi2 = b.lat * Math.PI / 180
  const dl = (b.lon - a.lon) * Math.PI / 180
  const y = Math.sin(dl) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

/**
 * Parses a task-log clock into an absolute Date on the report's day.
 *
 * Defensive: source-PDF task logs sometimes have unpadded hours ("7:00"
 * instead of "07:00"). A strict ISO parser rejects them and silently breaks
 * the vessel's whole timeline (CA5 12-May had 20 such fields). '24:00' is
 * midnight at the END of the day.
 */
export function parseTaskTime(reportDate: string, hhmm: string | null | undefined): Date | null {
  if (!hhmm) return null
  const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(hhmm)
  if (!m) return null
  const hh = parseInt(m[1], 10)
  const mm = m[2]
  if (hh === 24 && mm === '00') {
    const d = new Date(reportDate + 'T00:00:00+03:00')
    d.setUTCDate(d.getUTCDate() + 1)
    return d
  }
  if (hh > 23) return null
  return parseLocalTime(`${reportDate}T${String(hh).padStart(2, '0')}:${mm}`)
}

/** "131h 24m" / "5h" / "42m" */
export function fmtDur(min: number): string {
  min = Math.round(min || 0)
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}
