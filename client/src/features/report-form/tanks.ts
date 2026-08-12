// Which tanks each vessel actually has, and how big they are.
//
// Every one of these numbers was retyped by hand into every daily report. Across
// all 256 imported reports each vessel's max capacity is a single constant —
// CA1's fuel is "950 M3 (80%)" all 64 times, Charlie 3's is "55 m3 (60%)" all
// 54 — so the form prints it instead of asking for it, and shows a vessel only
// the tanks it has (CA1 has never once reported base oil; the two crew boats
// carry fuel and fresh water only).
//
// Written as the exact strings the reports carry, including the unit's own
// spelling per vessel (M3 for the PSVs, m3 for the crew boats): a prefilled
// report has to round-trip byte-identically, so the unit the form re-appends to
// a typed number must be the one that vessel's reports already use.
//
// This belongs in vessel configuration in the database next to length and beam.
// It lives here because the fleet API has no tank columns yet; when it grows
// them, delete this file and read `tanks` off the vessel.

import type { LiquidKey } from './model'

export interface TankSpec {
  key: LiquidKey
  /** Capacity exactly as the reports write it, e.g. '950 M3 (80%)'. */
  maxCapacity: string
  /** Unit suffix re-appended when the captain types a bare number. */
  unit: string
}

const PSV_COMMON: TankSpec[] = [
  { key: 'fuel_oil', maxCapacity: '950 M3 (80%)', unit: 'M3' },
  { key: 'fresh_water', maxCapacity: '673 M3 (100%)', unit: 'M3' },
]

export const VESSEL_TANKS: Record<string, TankSpec[]> = {
  CA1: [
    ...PSV_COMMON,
    { key: 'drill_water', maxCapacity: '1476 M3 (100%)', unit: 'M3' },
  ],
  CA3: [
    ...PSV_COMMON,
    { key: 'drill_water', maxCapacity: '1476 M3 (100%)', unit: 'M3' },
    { key: 'base_oil', maxCapacity: '1094 Bbls (80%)', unit: 'Bbls' },
  ],
  CA5: [
    { key: 'fuel_oil', maxCapacity: '950 M3 (85%)', unit: 'M3' },
    { key: 'fresh_water', maxCapacity: '673 M3 (100%)', unit: 'M3' },
    { key: 'drill_water', maxCapacity: '1180 M3 (80%)', unit: 'M3' },
    { key: 'base_oil', maxCapacity: '1000 Bbls (80%)', unit: 'Bbls' },
  ],
  CH3: [
    { key: 'fuel_oil', maxCapacity: '55 m3 (60%)', unit: 'm3' },
    { key: 'fresh_water', maxCapacity: '20 m3', unit: 'm3' },
  ],
  JUNO: [
    { key: 'fuel_oil', maxCapacity: '147 m3 (85%)', unit: 'm3' },
    { key: 'fresh_water', maxCapacity: '139 m3 (85%)', unit: 'm3' },
  ],
}

/** Fallback for a vessel with no tank config: all four, unitless. */
const UNKNOWN_VESSEL: TankSpec[] = (['fuel_oil', 'fresh_water', 'drill_water', 'base_oil'] as LiquidKey[])
  .map(key => ({ key, maxCapacity: '', unit: '' }))

export function tanksFor(vesselId: string): TankSpec[] {
  return VESSEL_TANKS[vesselId.toUpperCase()] ?? UNKNOWN_VESSEL
}

/**
 * Strip the configured unit for display: '417.42 M3' -> '417.42'. Anything that
 * doesn't end in exactly that unit is shown untouched, so an odd imported value
 * ('CORRECTION 0.001 M3', '-') is never quietly rewritten.
 */
export function stripUnit(value: string, unit: string): string {
  if (!unit) return value
  const v = value.trim()
  const tail = v.slice(-unit.length)
  if (tail.toLowerCase() !== unit.toLowerCase()) return value
  return v.slice(0, -unit.length).trim()
}

/** Re-attach the unit to a bare number typed by the captain; leave the rest alone. */
export function withUnit(typed: string, unit: string): string {
  const v = typed.trim()
  if (!v || !unit) return v
  return /^-?\d+(\.\d+)?$/.test(v) ? `${v} ${unit}` : v
}
