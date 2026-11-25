// Lineal: reine Geometrie ohne DOM (testbar in Node). Koordinaten sind CSS-px relativ zum Surface-Container (.ed-surface).
// state = {x, y, angle}: (x, y) = Mittelpunkt, angle in Grad, positiv im Uhrzeigersinn (wie CSS rotate).
// pxPerMm = 10 · surface.viewScale(). Die Länge folgt dem Seitenmaßstab, die Höhe bleibt in CSS-px.
// Lokale Achsen: u entlang des Lineals (bei 0° nach rechts), n senkrecht dazu (bei 0° nach unten).
// Kante 0 = obere Längskante (n < 0), Kante 1 = untere Längskante (n > 0).

export const RULER_MM = 300;     // Länge: 30 cm
export const RULER_H = 70;       // Höhe in CSS-px (zoomunabhängig)
export const EDGE_GAP = 1.5;     // Projektionskante liegt eine halbe Stiftbreite außerhalb des Lineals (CSS-px)
export const GRIP_R = 22;        // Radius des Dreh-Griffs (Trefferfläche 44 px)
export const GRIP_INSET = 36;    // Abstand des Griff-Mittelpunkts vom rechten Ende (CSS-px)

const EDGE_TOL = 1;              // bis 1 px innerhalb der Kante gilt noch als „auf der Kante“

/** Winkel in Grad, normalisiert auf (-180, 180]. */
export function normDeg(d) {
  let r = ((d % 360) + 360) % 360;   // [0, 360)
  if (r > 180) r -= 360;
  return r;
}

/** Länge des Lineals in CSS-px. */
export function rulerLength(pxPerMm) {
  return RULER_MM * pxPerMm;
}

function frame(angle) {
  const a = ((angle || 0) * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  return { ux, uy, nx: -uy, ny: ux };
}

/** Punkt → lokale Koordinaten (u entlang, n quer) relativ zum Mittelpunkt. */
function local(state, pt) {
  const f = frame(state.angle);
  const dx = pt.x - state.x, dy = pt.y - state.y;
  return { u: dx * f.ux + dy * f.uy, n: dx * f.nx + dy * f.ny };
}

/** Lokale Koordinaten → Container-px. */
function world(state, u, n) {
  const f = frame(state.angle);
  return { x: state.x + f.ux * u + f.nx * n, y: state.y + f.uy * u + f.ny * n };
}

/** Die 4 Eckpunkte [{x,y}] in Container-px: oben links, oben rechts, unten rechts, unten links (bei 0°). */
export function rulerCorners(state, pxPerMm) {
  const L = rulerLength(pxPerMm) / 2, H = RULER_H / 2;
  return [[-L, -H], [L, -H], [L, H], [-L, H]].map(([u, n]) => world(state, u, n));
}

/** true, wenn pt innerhalb des Lineals liegt. */
export function hitRuler(state, pxPerMm, pt) {
  const p = local(state, pt);
  return Math.abs(p.u) <= rulerLength(pxPerMm) / 2 && Math.abs(p.n) <= RULER_H / 2;
}

/** Mittelpunkt des Dreh-Griffs (am rechten Ende, innerhalb des Lineals), Container-px. */
export function gripCenter(state, pxPerMm) {
  return world(state, rulerLength(pxPerMm) / 2 - GRIP_INSET, 0);
}

/** true, wenn pt im Dreh-Griff liegt (Radius GRIP_R). */
export function hitGrip(state, pxPerMm, pt) {
  const g = gripCenter(state, pxPerMm);
  return Math.hypot(pt.x - g.x, pt.y - g.y) <= GRIP_R;
}

/**
 * Kante, an der ein Stift-Strich ansetzt: 0 = obere, 1 = untere Längskante, null = keine.
 * Der Punkt muss außerhalb des Lineals (oder auf der Kante) liegen und höchstens maxDist px vom Kantensegment entfernt sein.
 */
export function edgeAt(state, pxPerMm, pt, maxDist = 24) {
  const p = local(state, pt);
  const L = rulerLength(pxPerMm) / 2, H = RULER_H / 2;
  const du = Math.max(Math.abs(p.u) - L, 0);           // Abstand entlang der Längsachse über das Ende hinaus
  for (const edge of [0, 1]) {
    // Abstand nach außen von dieser Kante (positiv = außerhalb des Lineals)
    const out = edge === 0 ? -H - p.n : p.n - H;
    if (out < -EDGE_TOL) continue;                     // innen
    if (Math.hypot(du, Math.max(out, 0)) <= maxDist) return edge;
  }
  return null;
}

/** Senkrechte Projektion von pt auf die Kantengerade (um EDGE_GAP nach außen versetzt). Entlang der Geraden unbegrenzt. */
export function projectToEdge(state, pt, edge) {
  const p = local(state, pt);
  const off = (edge === 0 ? -1 : 1) * (RULER_H / 2 + EDGE_GAP);
  return world(state, p.u, off);
}

/**
 * Zwei-Finger-Geste: Verschiebung des Fingermittelpunkts und Winkeländerung (Grad) zwischen zwei Fingerpaaren.
 * a0/b0 = vorher, a1/b1 = nachher, je {x, y}.
 */
export function twist(a0, b0, a1, b1) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const m0 = mid(a0, b0), m1 = mid(a1, b1);
  const angle = (a, b) => (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 ? null : (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
  const g0 = angle(a0, b0), g1 = angle(a1, b1);
  const dAngle = g0 === null || g1 === null ? 0 : normDeg(g1 - g0);
  return { dx: m1.x - m0.x, dy: m1.y - m0.y, dAngle };
}

/** Rastet auf Vielfache von 45° ein, wenn höchstens 2° entfernt. Ergebnis in (-180, 180]. */
export function snapAngle(deg) {
  const n = normDeg(deg);
  const m = Math.round(n / 45) * 45;
  return Math.abs(n - m) <= 2 ? normDeg(m) : n;
}

/**
 * Striche für die Skala über lengthMm: cm-Striche mit Beschriftung ('cm', label „0“…„30“), 5-mm-Striche ('half'),
 * 1-mm-Striche ('mm'). Bei pxPerMm < 2 entfallen die 1-mm-Striche.
 */
export function ticks(pxPerMm, lengthMm) {
  const out = [];
  const n = Math.floor(lengthMm);
  for (let mm = 0; mm <= n; mm++) {
    if (mm % 10 === 0) out.push({ mm, len: 'cm', label: String(mm / 10) });
    else if (mm % 5 === 0) out.push({ mm, len: 'half' });
    else if (pxPerMm >= 2) out.push({ mm, len: 'mm' });
  }
  return out;
}
