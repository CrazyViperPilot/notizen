// Formenerkennung (ARCHITEKTUR 11.4): recognizes a hand-drawn line, ellipse/circle or axis-aligned rectangle and
// returns a clean version of it. Pure and DOM-free. Input and output are Int32Array x,y,p triples (page units, 0.1 mm).

const MIN_POINTS = 6;        // fewer input points → no recognition
const MIN_LENGTH = 80;       // total path length below this → no recognition
const LINE_MIN_CHORD = 80;   // a line must be at least this long (start → end)
const LINE_TOL = 0.06;       // max distance of any point to the chord, relative to the chord length
const SNAP_RAD = 4 * Math.PI / 180;  // nearly horizontal/vertical lines snap to the axis
const CLOSE_TOL = 0.25;      // start ↔ end distance, relative to the larger bbox side
const ELLIPSE_TOL = 0.10;    // mean |r_i - 1| of the normalized radius
const CIRCLE_TOL = 0.12;     // |rx - ry| relative to max(rx, ry) → circle
const RECT_TOL = 0.05;       // distance to the bbox border, relative to the bbox diagonal
const STEP = 18;             // max spacing of output points (ints, so the real spacing stays ≤ 20)

/**
 * Recognizes a shape in a pen stroke.
 * Returns null or {kind: 'line'|'circle'|'ellipse'|'rect', pts: Int32Array} (x,y,p triples, dense, closed shapes end
 * at their start point).
 */
export function recognizeShape(pts) {
  if (!pts || !(pts.length >= 3 * MIN_POINTS)) return null;
  const n = Math.floor(pts.length / 3);

  // One pass: bbox, path length, pressure sum, signed area (sign gives the drawing direction).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let total = 0, psum = 0, area2 = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1];
    psum += pts[3 * i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (i > 0) total += Math.hypot(x - pts[3 * i - 3], y - pts[3 * i - 2]);
    const j = (i + 1) % n;
    area2 += x * pts[3 * j + 1] - pts[3 * j] * y;
  }
  if (total < MIN_LENGTH) return null;

  const press = clamp255(Math.round(psum / n));
  const sx = pts[0], sy = pts[1];
  const ex = pts[3 * (n - 1)], ey = pts[3 * (n - 1) + 1];

  // 1. Line: all points close to the chord start → end.
  const chord = Math.hypot(ex - sx, ey - sy);
  if (chord >= LINE_MIN_CHORD) {
    const lim2 = (LINE_TOL * chord) * (LINE_TOL * chord);
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (segDist2(pts[3 * i], pts[3 * i + 1], sx, sy, ex, ey) > lim2) ok = false;
    }
    if (ok) {
      const seg = snapLine(sx, sy, ex, ey);
      return { kind: 'line', pts: emit(seg, press) };
    }
  }

  // Everything below is a closed shape: the end must come back close to the start.
  const bw = x1 - x0, bh = y1 - y0;
  const span = Math.max(bw, bh);
  if (!(Math.hypot(ex - sx, ey - sy) <= CLOSE_TOL * span)) return null;
  if (!(bw >= 1 && bh >= 1)) return null;
  const clockwise = area2 > 0;   // y axis points down: positive shoelace area = drawn clockwise on screen

  // 2. Ellipse / circle, fitted to the bbox.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = bw / 2, ry = bh / 2;
  let dev = 0;
  for (let i = 0; i < n; i++) {
    const u = (pts[3 * i] - cx) / rx, v = (pts[3 * i + 1] - cy) / ry;
    dev += Math.abs(Math.sqrt(u * u + v * v) - 1);
  }
  if (dev / n <= ELLIPSE_TOL) {
    const isCircle = Math.abs(rx - ry) <= CIRCLE_TOL * Math.max(rx, ry);
    const ax = isCircle ? (rx + ry) / 2 : rx;
    const ay = isCircle ? (rx + ry) / 2 : ry;
    // Start at the angle of the first input point, run in the drawn direction.
    const th0 = Math.atan2((sy - cy) / ay, (sx - cx) / ax);
    const dir = clockwise ? 1 : -1;
    const per = ellipsePerimeter(ax, ay);
    const N = Math.max(8, Math.ceil(per / STEP));
    const verts = [];
    for (let k = 0; k < N; k++) {
      const phi = th0 + (dir * 2 * Math.PI * k) / N;
      verts.push(cx + ax * Math.cos(phi), cy + ay * Math.sin(phi));
    }
    verts.push(verts[0], verts[1]);
    return { kind: isCircle ? 'circle' : 'ellipse', pts: emit(verts, press) };
  }

  // 3. Axis-aligned rectangle: points hug the bbox border and cover all four sides.
  const diag = Math.hypot(bw, bh);
  const tol = RECT_TOL * diag;
  let sumD = 0;
  let topMin = Infinity, topMax = -Infinity, botMin = Infinity, botMax = -Infinity;
  let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1];
    const dl = x - x0, dr = x1 - x, dt = y - y0, db = y1 - y;
    sumD += Math.min(dl, dr, dt, db);
    if (dt <= tol) { if (x < topMin) topMin = x; if (x > topMax) topMax = x; }
    if (db <= tol) { if (x < botMin) botMin = x; if (x > botMax) botMax = x; }
    if (dl <= tol) { if (y < leftMin) leftMin = y; if (y > leftMax) leftMax = y; }
    if (dr <= tol) { if (y < rightMin) rightMin = y; if (y > rightMax) rightMax = y; }
  }
  if (sumD / n > tol) return null;
  const half = 0.5;
  if (!(topMax - topMin >= half * bw && botMax - botMin >= half * bw &&
        leftMax - leftMin >= half * bh && rightMax - rightMin >= half * bh)) return null;

  // Corners in clockwise order from top-left; reversed for counter-clockwise drawing.
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const order = clockwise ? [0, 1, 2, 3] : [0, 3, 2, 1];
  let best = 0, bestD = Infinity;
  for (let m = 0; m < 4; m++) {
    const c = corners[order[m]];
    const d = Math.hypot(c[0] - sx, c[1] - sy);
    if (d < bestD) { bestD = d; best = m; }
  }
  const verts = [];
  for (let j = 0; j < 5; j++) {
    const c = corners[order[(best + j) % 4]];
    verts.push(c[0], c[1]);
  }
  return { kind: 'rect', pts: emit(verts, press) };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// Horizontal/vertical snapping for nearly axis-aligned lines (< 4°); the average coordinate is kept.
function snapLine(ax, ay, bx, by) {
  const ang = Math.abs(Math.atan2(by - ay, bx - ax));   // 0 … π
  if (ang < SNAP_RAD || ang > Math.PI - SNAP_RAD) {
    const y = Math.round((ay + by) / 2);
    return [ax, y, bx, y];
  }
  if (Math.abs(ang - Math.PI / 2) < SNAP_RAD) {
    const x = Math.round((ax + bx) / 2);
    return [x, ay, x, by];
  }
  return [ax, ay, bx, by];
}

// Ramanujan approximation of the ellipse circumference.
function ellipsePerimeter(a, b) {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

// Float polyline (x0,y0,x1,y1,…) → dense Int32Array x,y,p. Each segment is split so that its spacing is ≤ STEP.
// The last vertex is emitted as is, so a closed path ends on exactly the same integer point it starts on.
function emit(verts, press) {
  const out = [];
  const m = verts.length / 2;
  for (let i = 0; i + 1 < m; i++) {
    const ax = verts[2 * i], ay = verts[2 * i + 1];
    const bx = verts[2 * i + 2], by = verts[2 * i + 3];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / STEP));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      out.push(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), press);
    }
  }
  const last = m - 1;
  out.push(Math.round(verts[2 * last]), Math.round(verts[2 * last + 1]), press);
  return Int32Array.from(out);
}
