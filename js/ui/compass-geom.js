// Zirkel: reine Geometrie ohne DOM (testbar in Node). Koordinaten sind CSS-px relativ zum Surface-Container (.ed-surface).
// state = {cx, cy, r, a, visible}: (cx, cy) = Einstichpunkt (Mittelpunkt) in CSS-px, r = Radius in mm (1 … 150),
// a = Winkel der Bleistiftspitze in Grad (Bildschirmwinkel: 0° rechts, positiv im Uhrzeigersinn wie atan2 mit y nach unten).
// pxPerMm = 10 · surface.viewScale(); alle Maße sind echte mm. Der Kreisradius in px ist r · pxPerMm.

import { normDeg } from './ruler-geom.js';

export { normDeg };

export const ZIRKEL_MIN_MM = 1;        // kleinster Radius (mm)
export const ZIRKEL_MAX_MM = 150;      // größter Radius (mm)
export const ZIRKEL_DEFAULT_MM = 30;   // Radius beim ersten Einblenden (mm)
export const TIP_R = 22;               // Trefferradius der Bleistiftspitze (Trefferfläche 44 px)
export const CENTER_R = 22;            // Trefferradius des Einstichpunkts (Trefferfläche 44 px)
export const LEG_HALF = 15;            // halbe Breite der Schenkel-Trefferfläche (ganze Breite 30 px)
export const HINGE_PX = 40;            // Abstand des Gelenks von der Mitte zwischen Einstich und Spitze (px)
export const COMPASS_PAD = 70;         // Rand der Canvas-Box um den Kreis (px): Gelenk, Griff, Luft
export const MAX_CANVAS_PX = 4096;     // größte Kante eines Canvas (Safari-Grenze)

const MAX_HALF = MAX_CANVAS_PX / 2 - 1;

/** Begrenzt einen Radius (mm) auf 1 … 150, ohne zu runden (für die Live-Anzeige). */
export function clampRadius(mm) {
  const v = Number(mm);
  if (!Number.isFinite(v)) return ZIRKEL_DEFAULT_MM;
  return Math.min(ZIRKEL_MAX_MM, Math.max(ZIRKEL_MIN_MM, v));
}

/** Radius beim Loslassen: auf ganze mm runden, im Bereich 1 … 150. */
export function snapRadius(mm) {
  return Math.round(clampRadius(mm));
}

/** Position der Bleistiftspitze (Container-px): Mittelpunkt + r·(cos a, sin a). */
export function tipPoint(state, pxPerMm) {
  const R = state.r * pxPerMm;
  const a = (state.a * Math.PI) / 180;
  return { x: state.cx + R * Math.cos(a), y: state.cy + R * Math.sin(a) };
}

/**
 * Gelenk (Container-px): liegt HINGE_PX senkrecht zur Verbindung Einstich–Spitze, auf der Seite nach oben
 * (kleineres y). Bei senkrechter Verbindung liegt es links. So bilden die Schenkel ein V, auch bei jedem Winkel.
 */
export function hingePoint(state, pxPerMm) {
  const t = tipPoint(state, pxPerMm);
  const dx = t.x - state.cx, dy = t.y - state.cy;
  const len = Math.hypot(dx, dy);
  let nx = len > 1e-9 ? -dy / len : 0;
  let ny = len > 1e-9 ? dx / len : -1;
  if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx > 0)) { nx = -nx; ny = -ny; }
  const mx = (state.cx + t.x) / 2, my = (state.cy + t.y) / 2;
  return { x: mx + nx * HINGE_PX, y: my + ny * HINGE_PX };
}

/**
 * Canvas-Box des Zirkels in CSS-px. Der Einstichpunkt liegt in der Box bei (ox, oy) = Mitte.
 * Größe = Kreis + COMPASS_PAD auf jeder Seite, höchstens MAX_CANVAS_PX Kante (größere Kreise werden abgeschnitten).
 */
export function compassBox(state, pxPerMm) {
  const R = Math.max(0, state.r * pxPerMm);
  const half = Math.min(R + COMPASS_PAD, MAX_HALF);
  return { w: 2 * half, h: 2 * half, ox: half, oy: half, pad: COMPASS_PAD };
}

/** Abstand eines Punktes zu einem Strecken-Segment (px). */
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Kreislinie, an der ein Stift-Strich ansetzt: 0, wenn der Punkt höchstens maxDist px vom Kreis entfernt liegt
 * (|Abstand zum Mittelpunkt − r·pxPerMm| ≤ maxDist), sonst null. Ein unsichtbarer Zirkel (visible === false) liefert null.
 */
export function circleEdgeAt(state, pxPerMm, pt, maxDist = 24) {
  if (state.visible === false) return null;
  const d = Math.hypot(pt.x - state.cx, pt.y - state.cy);
  return Math.abs(d - state.r * pxPerMm) <= maxDist ? 0 : null;
}

/** Punkt auf dem Kreis in Richtung pt (Container-px). Bei Abstand 0 zum Mittelpunkt: die Spitze. */
export function projectToCircle(state, pxPerMm, pt) {
  const dx = pt.x - state.cx, dy = pt.y - state.cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return tipPoint(state, pxPerMm);
  const R = state.r * pxPerMm;
  return { x: state.cx + (dx / d) * R, y: state.cy + (dy / d) * R };
}

/**
 * Überstrichener Winkel von p0 nach p1 um den Mittelpunkt, ganzzahlig in Grad. Nur die beiden Punkte sind bekannt,
 * deshalb der einfache Winkel zwischen ihnen (Betrag, 0 … 180; über die 0°/360°-Grenze hinweg korrekt).
 */
export function sweepDeg(state, p0, p1) {
  const a0 = Math.atan2(p0.y - state.cy, p0.x - state.cx);
  const a1 = Math.atan2(p1.y - state.cy, p1.x - state.cx);
  const delta = normDeg(((a1 - a0) * 180) / Math.PI);
  return Math.round(Math.abs(delta));
}

/** Bildschirmwinkel (Grad, normalisiert) vom Mittelpunkt zu pt. */
export function angleAt(state, pt) {
  return normDeg((Math.atan2(pt.y - state.cy, pt.x - state.cx) * 180) / Math.PI);
}

/** Radius (mm, ungerundet, 1 … 150) als Abstand des Punktes vom Mittelpunkt. */
export function radiusAtPoint(state, pxPerMm, pt) {
  if (!(pxPerMm > 0)) return clampRadius(state.r);
  return clampRadius(Math.hypot(pt.x - state.cx, pt.y - state.cy) / pxPerMm);
}

/** Formatierung für die Anzeige: immer in cm mit einer Nachkommastelle, deutsches Komma („r = 3,5 cm“). */
export function formatRadius(mm) {
  const v = Number.isFinite(Number(mm)) ? Number(mm) : ZIRKEL_DEFAULT_MM;
  return 'r = ' + (v / 10).toFixed(1).replace('.', ',') + ' cm';
}

/** Live-Text beim Zeichnen: „r = 3,5 cm · 72°“. */
export function formatMeasure(mm, deg) {
  return formatRadius(mm) + ' · ' + Math.round(deg) + '°';
}

/** true, wenn pt im Einstichpunkt liegt (Radius CENTER_R). */
export function hitCenter(state, pxPerMm, pt) {
  return Math.hypot(pt.x - state.cx, pt.y - state.cy) <= CENTER_R;
}

/** true, wenn pt in der Bleistiftspitze liegt (Radius TIP_R). */
export function hitTip(state, pxPerMm, pt) {
  const t = tipPoint(state, pxPerMm);
  return Math.hypot(pt.x - t.x, pt.y - t.y) <= TIP_R;
}

/** true, wenn pt höchstens LEG_HALF px neben einem der Schenkel liegt (Mitte → Gelenk → Spitze). */
export function hitLegs(state, pxPerMm, pt) {
  const c = { x: state.cx, y: state.cy };
  const g = hingePoint(state, pxPerMm);
  const t = tipPoint(state, pxPerMm);
  return Math.min(segDist(pt, c, g), segDist(pt, g, t)) <= LEG_HALF;
}
