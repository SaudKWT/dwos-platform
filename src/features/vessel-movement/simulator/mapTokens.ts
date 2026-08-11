/**
 * Design tokens for the Leaflet layer.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The rule is that no colour is ever hand-written outside the token source. The
 * map makes that awkward: Leaflet paints paths by setting SVG presentation
 * attributes from JavaScript, so `className="text-warning"` does nothing and
 * `var(--warning)` is not a valid value for a `stroke` attribute. The previous
 * code took the obvious way out and wrote `'#ff7849'` inline.
 *
 * So the token is read at paint time from the computed style of the document
 * root, where the KOC theme defines it. One indirection instead of a literal:
 * the safety zone follows the theme, changes with light/dark, and still comes
 * from `--warning` rather than from a designer's memory of what orange looked
 * right.
 *
 * WHAT IS DELIBERATELY NOT TOKENISED
 * ----------------------------------
 * `Vessel.MapColor` / `.MapStroke` — the per-vessel colours in the sidebar
 * cards, the trails and the icons. Those are columns in `dbo.Vessel`, not theme:
 * they identify a hull, they are the same colour on every screen and in every
 * theme, and the operations team picks them. Data that happens to be a colour
 * is not a design token, and routing it through the theme would make Crest
 * Argus 1 change identity in dark mode.
 */

/** Fallbacks used only before the stylesheet has applied (first paint, tests). */
const FALLBACK: Record<string, string> = {
  '--warning': 'oklch(0.4826 0.1044 70.21)',
  '--muted-foreground': 'oklch(0.4836 0.0224 248.29)',
  '--foreground': 'oklch(0.2061 0.0086 240.33)',
}

/** Read a KOC token off the root element. */
export function token(name: string): string {
  if (typeof document === 'undefined') return FALLBACK[name] ?? 'currentColor'
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || FALLBACK[name] || 'currentColor'
}

/** The 500 m rig exclusion zone — a caution boundary, so `--warning`. */
export const rigZoneColor = () => token('--warning')

/**
 * Stand-in for a vessel with no MapColor set. Muted rather than a colour,
 * because an unconfigured vessel should look unconfigured and not quietly
 * borrow another hull's identity.
 */
export const vesselFallbackFill = () => token('--muted-foreground')
export const vesselFallbackStroke = () => token('--foreground')
