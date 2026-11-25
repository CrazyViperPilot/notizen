// Geodreieck: reine Geometrie ohne DOM (testbar in Node). Koordinaten sind CSS-px relativ zum Surface-Container (.ed-surface).
// state = {x, y, angle}: (x, y) = Nullpunkt = Mitte der Hypotenuse, angle in Grad, positiv im Uhrzeigersinn (wie CSS rotate).
// Gedreht wird immer um den Nullpunkt. pxPerMm = 10 · surface.viewScale(); alle Maße sind echte mm.
// Lokale Achsen wie im Lineal: u entlang der Hypotenuse (bei 0° nach rechts), n senkrecht dazu (bei 0° nach unten).
// Dreieck: Hypotenuse n = 0 für u ∈ [−80, 80] mm; Spitze (rechter Winkel) bei (u = 0, n = −80 mm), bei 0° zeigt sie nach oben.
// Intern wird in lokalen px gerechnet (u, n jeweils in CSS-px relativ zum Nullpunkt).

import { twist, snapAngle, normDeg } from './ruler-geom.js';

export { twist, snapAngle, normDeg };

export const GEO_HYP_MM = 160;       // Hypotenuse (lange Kante) = Breite der Bounding-Box
export const GEO_H_MM = 80;          // Höhe Hypotenuse → Spitze (gleichschenklig rechtwinklig: gleich der halben Hypotenuse)
export const ARC_R_MM = 52;          // Radius des Winkelmessers
export const GEO_SCALE_MM = 70;      // Skala auf der Hypotenuse: −70 … +70 mm
export const GEO_GRIP_R = 22;        // Trefferradius des Dreh-Griffs (px)
export const GEO_GRIP_MM = 62;       // Griff-Mittelpunkt 62 mm vom Nullpunkt (18 mm unter der Spitze), mindestens GRIP_MIN_PX
export const GEO_EDGE_GAP = 1.5;     // Projektionskante liegt eine halbe Stiftbreite außerhalb der Kante (px)

const GEO_PAD = 4;                   // Rand der Canvas-Box (px)
const GRIP_MIN_PX = 30;
const EDGE_TOL = 1;                  // bis 1 px innerhalb einer Kante gilt noch als „auf der Kante“
const HIT_TOL = 0.5;                 // Trefferprüfung: Randpunkte zählen als innen (Rundungsfehler)
const SQ = Math.SQRT1_2;

/** Halbe Hypotenuse bzw. Höhe in px (identisch, da gleichschenklig rechtwinklig). */
function half(pxPerMm) {
  return (GEO_HYP_MM / 2) * pxPerMm;
}

function frame(angle) {
  const a = ((angle || 0) * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  return { ux, uy, nx: -uy, ny: ux };
}

/** Punkt → lokale Koordinaten (px) relativ zum Nullpunkt. */
function local(state, pt) {
  const f = frame(state.angle);
  const dx = pt.x - state.x, dy = pt.y - state.y;
  return { u: dx * f.ux + dy * f.uy, n: dx * f.nx + dy * f.ny };
}

/** Lokale Koordinaten (px) → Container-px. */
function world(state, u, n) {
  const f = frame(state.angle);
  return { x: state.x + f.ux * u + f.nx * n, y: state.y + f.uy * u + f.ny * n };
}

/**
 * Signierte Abstände in px (positiv = innen) zu den drei Kanten: [Hypotenuse, linke Kathete, rechte Kathete].
 * Innen ist, wo alle drei Werte ≥ 0 sind.
 */
function depths(p, K) {
  return [-p.n, (p.u + p.n + K) * SQ, (-p.u + p.n + K) * SQ];
}

/** Segmente der drei Kanten in lokalen px: [Hypotenuse, linke Kathete, rechte Kathete]. */
function segments(K) {
  const apex = { u: 0, n: -K };
  return [
    [{ u: -K, n: 0 }, { u: K, n: 0 }],
    [{ u: -K, n: 0 }, apex],
    [{ u: K, n: 0 }, apex],
  ];
}

/** Abstand eines Punktes zu einem Strecken-Segment (lokale px). */
function segDist(p, a, b) {
  const dx = b.u - a.u, dn = b.n - a.n;
  const len2 = dx * dx + dn * dn;
  let t = len2 > 0 ? ((p.u - a.u) * dx + (p.n - a.n) * dn) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.u - (a.u + t * dx), p.n - (a.n + t * dn));
}

/** Die drei Ecken in Container-px: [links (u = −80 mm), rechts (u = +80 mm), Spitze]. */
export function geoCorners(state, pxPerMm) {
  const K = half(pxPerMm);
  return [world(state, -K, 0), world(state, K, 0), world(state, 0, -K)];
}

/** true, wenn pt innerhalb des Geodreiecks liegt (Rand zählt). */
export function hitGeo(state, pxPerMm, pt) {
  return Math.min(...depths(local(state, pt), half(pxPerMm))) >= -HIT_TOL;
}

/**
 * Kante, an der ein Stift-Strich ansetzt: 0 = Hypotenuse, 1 = linke Kathete, 2 = rechte Kathete, null = keine.
 * Der Punkt muss außerhalb der Kante liegen (oder höchstens 1 px innen) und höchstens maxDist px vom Kanten-SEGMENT
 * entfernt sein. Bei mehreren Kandidaten gewinnt die nächste Kante.
 */
export function geoEdgeAt(state, pxPerMm, pt, maxDist = 24) {
  const K = half(pxPerMm);
  const p = local(state, pt);
  const d = depths(p, K);
  const segs = segments(K);
  let best = null, bestDist = Infinity;
  for (let e = 0; e < 3; e++) {
    if (d[e] > EDGE_TOL) continue;                     // innen, mehr als 1 px von dieser Kante entfernt
    const dist = segDist(p, segs[e][0], segs[e][1]);
    if (dist <= maxDist && dist < bestDist) { best = e; bestDist = dist; }
  }
  return best;
}

/**
 * Senkrechte Projektion von pt auf die Gerade der Kante (edge 0, 1 oder 2), um GEO_EDGE_GAP nach außen versetzt.
 * Entlang der Geraden unbegrenzt. Ungültige Kante → pt unverändert.
 */
export function geoProject(state, pxPerMm, pt, edge) {
  if (edge !== 0 && edge !== 1 && edge !== 2) return { x: pt.x, y: pt.y };
  const K = half(pxPerMm);
  const p = local(state, pt);
  // Einheitsnormale nach innen (a, b) je Kante; Ergebnis = pt − (Abstand innen + Versatz) · (a, b)
  const ab = edge === 0 ? [0, -1] : edge === 1 ? [SQ, SQ] : [-SQ, SQ];
  const k = depths(p, K)[edge] + GEO_EDGE_GAP;
  return world(state, p.u - k * ab[0], p.n - k * ab[1]);
}

/** Abstand des Dreh-Griffs vom Nullpunkt in px (entlang der Spitze). */
export function geoGripDist(pxPerMm) {
  return Math.max(GEO_GRIP_MM * pxPerMm, GRIP_MIN_PX);
}

/** true, wenn pt im Dreh-Griff an der Spitze liegt (Radius GEO_GRIP_R). */
export function hitGeoGrip(state, pxPerMm, pt) {
  const g = world(state, 0, -geoGripDist(pxPerMm));
  return Math.hypot(pt.x - g.x, pt.y - g.y) <= GEO_GRIP_R;
}

/**
 * Canvas-Box des Geodreiecks in CSS-px: Breite/Höhe, Ursprung (Nullpunkt) im Canvas bei (ox, oy).
 * Der Ursprung ist unten Mitte, die Box hat einen Rand von GEO_PAD px.
 */
export function geoBox(pxPerMm) {
  const w = GEO_HYP_MM * pxPerMm + 2 * GEO_PAD;
  const h = GEO_H_MM * pxPerMm + 2 * GEO_PAD;
  return { w, h, ox: w / 2, oy: h - GEO_PAD, pad: GEO_PAD };
}

/**
 * Gradstriche des Winkelmessers für 0…180°. 0° liegt rechts (u > 0), 180° links.
 * len: 'ten' (10°, lang), 'five' (5°, mittel), 'one' (1°, kurz). Bei pxPerMm < 2 nur 5er und 10er.
 * outer = Zahl der äußeren Reihe (deg), inner = Zahl der inneren Reihe (180 − deg), nur bei 10er-Strichen.
 */
export function degreeTicks(pxPerMm) {
  const out = [];
  for (let deg = 0; deg <= 180; deg++) {
    const ten = deg % 10 === 0;
    if (!ten && deg % 5 !== 0 && pxPerMm < 2) continue;
    const t = { deg, len: ten ? 'ten' : deg % 5 === 0 ? 'five' : 'one' };
    if (ten) { t.outer = String(deg); t.inner = String(180 - deg); }
    out.push(t);
  }
  return out;
}

/**
 * Skala auf der Hypotenuse, −70 … +70 mm: cm-Striche mit Beschriftung |cm| ('cm'), 5-mm-Striche ('half'),
 * 1-mm-Striche ('mm'). Bei pxPerMm < 2 entfallen die 1-mm-Striche.
 */
export function hypTicks(pxPerMm) {
  const out = [];
  for (let mm = -GEO_SCALE_MM; mm <= GEO_SCALE_MM; mm++) {
    if (mm % 10 === 0) out.push({ mm, len: 'cm', label: String(Math.abs(mm) / 10) });
    else if (mm % 5 === 0) out.push({ mm, len: 'half' });
    else if (pxPerMm >= 2) out.push({ mm, len: 'mm' });
  }
  return out;
}
