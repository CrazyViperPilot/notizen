// Stroke geometry shared by canvas rendering, PDF export and the eraser. All coordinates in page units (0.1 mm).
//
// Pen strokes are drawn as the union of round "stamps" and quads between consecutive points (variable width from
// pressure). That is robust at sharp turns (no gaps or notches) and fills with one nonzero fill per stroke.

import { PEN_WIDTHS, HL_WIDTH } from '../config.js';
import { strokeId } from './codec.js';

const MIN_DIST = 3;        // drop input points closer than 0.3 mm to the previous one
const SMOOTH = 0.55;       // low-pass factor for position (1 = no smoothing)
const SMOOTH_P = 0.3;      // low-pass factor for pressure
const JOIN_COS = 0.985;    // skip joint circles where the path is almost straight (~10°)

/** Pressure 0–1 from a pointer event value; no pressure info → 0.5. */
export function normPressure(p, pointerType) {
  if (pointerType !== 'pen' || !(p > 0)) return 0.5;
  return Math.min(1, p);
}

/** Streaming input filter. Used live while drawing and for finished strokes, so both look identical. */
/** Smoothing levels (setting „Glättung“): low-pass factor for positions, 1 = raw input. */
export const SMOOTHING = { direct: 0.85, normal: SMOOTH, strong: 0.3 };

export class Smoother {
  constructor(k = SMOOTH) {
    this.k = k;
    this.out = [];       // x, y, p (ints)
    this.sx = 0; this.sy = 0; this.sp = 0;
    this.n = 0;
  }

  /** Adds a raw sample (x, y in page units, p 0–1). Returns true if a point was emitted. */
  push(x, y, p) {
    const pi = p * 255;
    if (this.n === 0) {
      this.sx = x; this.sy = y; this.sp = pi;
    } else {
      this.sx += (x - this.sx) * this.k;
      this.sy += (y - this.sy) * this.k;
      this.sp += (pi - this.sp) * SMOOTH_P;
    }
    this.n++;
    return this._emit(this.sx, this.sy, this.sp, false);
  }

  /** Pen lifted: make the stroke end where the pen was. */
  finish(x, y, p) {
    if (this.n === 0) return false;
    return this._emit(x, y, this.sp, true) || false;
  }

  _emit(x, y, p, force) {
    const o = this.out;
    const xi = Math.round(x), yi = Math.round(y), pi = Math.max(1, Math.min(255, Math.round(p)));
    const L = o.length;
    if (L >= 3) {
      const dx = xi - o[L - 3], dy = yi - o[L - 2];
      if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) {
        if (force && (dx || dy)) { o[L - 3] = xi; o[L - 2] = yi; return true; }
        return false;
      }
    }
    o.push(xi, yi, pi);
    return true;
  }

  points() {
    return Int32Array.from(this.out);
  }
}

/** Raw samples [{x, y, p}] (p 0–1) → smoothed Int32Array x,y,p. */
export function smoothPoints(raw) {
  const s = new Smoother();
  for (const r of raw) s.push(r.x, r.y, r.p);
  if (raw.length) { const l = raw[raw.length - 1]; s.finish(l.x, l.y, l.p); }
  return s.points();
}

/**
 * Bleistift (type 'b'): der Punktwert p speichert direkt den Radius (p / 4 Einheiten, max. ~6,4 mm), berechnet beim
 * Zeichnen aus Druck und Neigung. Senkrecht gehalten = fein wie der Stift, flach gehalten = breit zum Schraffieren.
 * altitude in Radiant (π/2 = senkrecht). Rückgabe 0–1 (wie ein Druckwert für den Smoother).
 */
export const PENCIL_P_SCALE = 4;
export function pencilP(width, pressure, altitude) {
  const base = (PEN_WIDTHS[width] ?? PEN_WIDTHS[1]) / 2;
  const deg = (Number.isFinite(altitude) ? altitude : Math.PI / 2) * 180 / Math.PI;
  const t = Math.max(0, Math.min(1, (50 - deg) / 35));          // 50° und steiler: 0, 15° und flacher: 1
  const r = base * (0.6 + 0.8 * pressure) * (1 + 11 * t * t);
  return Math.max(1, Math.min(255, r * PENCIL_P_SCALE)) / 255;
}

/** Neigung eines Pointer-Events als Höhenwinkel (Radiant, π/2 = senkrecht); ohne Angabe senkrecht. */
export function altitudeOf(e) {
  if (e.pointerType !== 'pen') return Math.PI / 2;
  if (Number.isFinite(e.altitudeAngle)) return e.altitudeAngle;
  const tx = Math.tan(((e.tiltX || 0) * Math.PI) / 180), ty = Math.tan(((e.tiltY || 0) * Math.PI) / 180);
  const l = Math.hypot(tx, ty);
  return l ? Math.atan(1 / l) : Math.PI / 2;
}

/** Radius at a point of a stroke (pen or pencil). */
export function radiusAt(stroke, p255) {
  return stroke.type === 'b' ? p255 / PENCIL_P_SCALE : penRadius(stroke.width, p255);
}

/** Radius at a point of a pen stroke. */
export function penRadius(width, p255) {
  const base = PEN_WIDTHS[width] ?? PEN_WIDTHS[1];
  const f = Math.max(0.45, Math.min(1.6, 0.45 + 1.15 * (p255 / 255)));
  return (base * f) / 2;
}

/**
 * Shapes of a pen stroke from point index `from` on (for incremental drawing pass the index of the first new point;
 * the segment leading to it is included). Returns {circles: [x,y,r,…], quads: [x1,y1,…,x4,y4,…]}.
 */
export function penShapes(stroke, from = 0) {
  const pts = stroke.pts;
  const n = pts.length / 3;
  const circles = [];
  const quads = [];
  const start = Math.max(0, from);
  for (let i = start; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], r = radiusAt(stroke, pts[i * 3 + 2]);
    // Joint/end circle: at both ends and wherever the direction changes noticeably.
    let needCircle = i === 0 || i === n - 1;
    if (!needCircle && i > 0) {
      const ax = x - pts[i * 3 - 3], ay = y - pts[i * 3 - 2];
      const bx = pts[i * 3 + 3] - x, by = pts[i * 3 + 4] - y;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      needCircle = la === 0 || lb === 0 || (ax * bx + ay * by) / (la * lb) < JOIN_COS;
    }
    // During live drawing the last point is temporarily an end point; its circle is redrawn later as needed.
    if (needCircle) circles.push(x, y, r);
    if (i > 0) {
      const x0 = pts[i * 3 - 3], y0 = pts[i * 3 - 2], r0 = radiusAt(stroke, pts[i * 3 - 1]);
      const dx = x - x0, dy = y - y0;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const nx = -dy / len, ny = dx / len;
        quads.push(x0 + nx * r0, y0 + ny * r0, x + nx * r, y + ny * r, x - nx * r, y - ny * r, x0 - nx * r0, y0 - ny * r0);
      }
    }
  }
  return { circles, quads };
}

/** Half width of a stroke for hit testing / bounding boxes. */
export function maxRadius(stroke) {
  if (stroke.type === 'h') return HL_WIDTH / 2;
  let m = 0;
  for (let i = 2; i < stroke.pts.length; i += 3) m = Math.max(m, stroke.pts[i]);
  return radiusAt(stroke, m);
}

/** [minX, minY, maxX, maxY] including stroke width. Cached on the stroke object. */
export function bbox(stroke) {
  if (stroke._bb) return stroke._bb;
  const p = stroke.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const r = maxRadius(stroke);
  return (stroke._bb = [x0 - r, y0 - r, x1 + r, y1 + r]);
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Does a circle (x, y, r) touch the stroke? */
export function hitTest(stroke, x, y, r) {
  const bb = bbox(stroke);
  if (x + r < bb[0] || x - r > bb[2] || y + r < bb[1] || y - r > bb[3]) return false;
  const p = stroke.pts;
  const lim = r + maxRadius(stroke);
  const lim2 = lim * lim;
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= lim2;
  for (let i = 3; i < p.length; i += 3) {
    if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= lim2) return true;
  }
  return false;
}

/** Does the segment (ax,ay)-(bx,by) with radius r touch the stroke? (eraser moved fast between two samples) */
export function hitTestSegment(stroke, ax, ay, bx, by, r) {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / Math.max(1, r)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (hitTest(stroke, ax + (bx - ax) * t, ay + (by - ay) * t, r)) return true;
  }
  return false;
}

/**
 * Teil-Radierer (ARCHITEKTUR 10.3). Eraser = Kapsel um (ax,ay)-(bx,by) mit Radius r.
 * Returns null if no point of the stroke is touched. Otherwise the remaining runs of untouched points as new strokes
 * (new ids, same type/color/width; runs with fewer than 2 points are dropped). Empty array if everything was erased.
 * The stroke is densified first (interpolated points, spacing <= r/2, but at least 1 unit) so that thinly sampled
 * strokes split cleanly. Points are only tested against r, not against the pen width.
 */
export function eraseSplit(stroke, ax, ay, bx, by, r) {
  const pts = stroke.pts;
  if (!pts || pts.length < 3) return null;
  const R = r > 0 ? r : 0;

  // 1. Quick reject: stroke bbox (includes its width) against the capsule bbox.
  const bb = bbox(stroke);
  if (Math.min(ax, bx) - R > bb[2] || Math.max(ax, bx) + R < bb[0] ||
      Math.min(ay, by) - R > bb[3] || Math.max(ay, by) + R < bb[1]) return null;

  // 2. Densify: each segment is split into k = ceil(len / step) pieces, endpoints are kept exactly.
  const step = Math.max(R / 2, 1);
  const n = pts.length / 3;
  let total = 1;
  for (let i = 1; i < n; i++) {
    const len = Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2]);
    total += Math.max(1, Math.ceil(len / step));
  }
  const dense = new Int32Array(total * 3);
  dense[0] = pts[0]; dense[1] = pts[1]; dense[2] = pts[2];
  let m = 1;
  for (let i = 1; i < n; i++) {
    const x0 = pts[i * 3 - 3], y0 = pts[i * 3 - 2], p0 = pts[i * 3 - 1];
    const dx = pts[i * 3] - x0, dy = pts[i * 3 + 1] - y0, dp = pts[i * 3 + 2] - p0;
    const k = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    for (let s = 1; s <= k; s++) {
      const t = s / k;
      dense[m * 3] = Math.round(x0 + dx * t);
      dense[m * 3 + 1] = Math.round(y0 + dy * t);
      dense[m * 3 + 2] = Math.round(p0 + dp * t);
      m++;
    }
  }

  // 3. Mark touched points (distance to segment AB <= r).
  const hit = new Uint8Array(total);
  const r2 = R * R;
  let any = false;
  for (let i = 0; i < total; i++) {
    if (segDist2(dense[i * 3], dense[i * 3 + 1], ax, ay, bx, by) <= r2) { hit[i] = 1; any = true; }
  }
  if (!any) return null;

  // 4. Collect runs of untouched points as new strokes.
  const out = [];
  const used = [stroke.id];
  let i = 0;
  while (i < total) {
    if (hit[i]) { i++; continue; }
    let j = i;
    while (j < total && !hit[j]) j++;
    if (j - i >= 2) {
      let id = strokeId();
      while (used.indexOf(id) !== -1) id = strokeId();
      used.push(id);
      out.push({
        id,
        type: stroke.type,
        color: stroke.color,
        width: stroke.width,
        pts: dense.slice(i * 3, j * 3),
      });
    }
    i = j;
  }
  return out;
}
