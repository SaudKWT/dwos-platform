// Vessel / location marker artwork, ported verbatim from app.js.
// These are the real silhouettes — a PSV hull with deck cargo bays, a fast crew
// boat with a raked bow, a jack-up rig with legs and helideck. Do not replace
// them with dots; the shapes are how operators tell boats apart at a glance.

export function psvSvg(color: string, stroke: string): string {
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
  </svg>`
}

export function fastCrewSvg(color: string, stroke: string): string {
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
  </svg>`
}

export function jackupRigSvg(): string {
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
  </svg>`
}

export function berthIconHtml(label: string): string {
  return `<div class="berth-icon"><div class="berth-pin"></div><div class="berth-label">${label}</div></div>`
}

export function mergedBerthIconHtml(): string {
  return `<div class="berth-icon merged"><div class="berth-pin"></div><div class="berth-label">Shuaiba Port</div><div class="berth-sub">B20 · B4</div></div>`
}

export function portIconHtml(label: string): string {
  return `<div class="port-icon"><div class="port-pin"></div><div class="port-label">${label}</div></div>`
}

/** Metres represented by one screen pixel at Kuwait's latitude for a zoom level. */
export function metersPerPixel(zoom: number): number {
  const lat = 29
  return 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom)
}

/** Pixel size for a real-world length, floored so icons stay tappable when zoomed out. */
export function iconPx(realM: number, minPx: number, zoom: number): number {
  return Math.max(minPx || 14, Math.round(realM / metersPerPixel(zoom)))
}
