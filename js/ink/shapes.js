// Formenerkennung (ARCHITEKTUR 11.4, erweitert um Pfeil, Dreieck und Vieleck): erkennt einen Stiftstrich als Linie,
// Pfeil, Kreis, Ellipse, achsparalleles Rechteck, Dreieck oder Vieleck und liefert eine saubere Fassung.
// Pure and DOM-free. Input and output are Int32Array x,y,p triples (page units, 0.1 mm).

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

const ARROW_MIN_CHORD = 120; // arrow shaft: at least 12 mm, so that 3 mm arms stay within 25 % of the shaft
const ARROW_MIN_HOOK = 30;   // arm length from the tip: at least 3 mm
const ARROW_MAX_HOOK = 0.30; // no stroke point may lie further than 30 % of the shaft from the tip (output: 25 %)
const ARROW_MAX_FRAC = 0.25; // output arm length ≤ 25 % of the shaft
const ARROW_TURN_MIN = 12;   // the stroke has turned back once the distance from the start drops this far …
const ARROW_TURN_FRAC = 0.03; // … (or 3 % of the distance, if larger)
const ARROW_ANGLE = Math.PI / 6;      // output arms form 30° with the shaft
const ARROW_ARM_MIN = Math.PI / 12;   // detected arm: 15° … 75° away from the backward direction
const ARROW_ARM_MAX = 5 * Math.PI / 12;

const POLY_EPS = 0.05;       // Douglas-Peucker tolerance, relative to the bbox span (at least POLY_FIT_MIN)
const POLY_FIT = 0.03;       // every input point must lie this close to the polygon, relative to the span …
const POLY_FIT_MIN = 8;      // … and at least 0.8 mm
const CORNER_MAX = 160 * Math.PI / 180;  // a corner needs an interior angle below 160°
const POLY_ROUND = 0.027;    // guard against round shapes: refined sides must fit within 2.7 % of the span …
const POLY_ROUND_MIN = 3;    // … and at least 0.3 mm
const ROUND_TOL = 0.04;      // mean |r_i - 1| up to this: round stroke → circle/ellipse, no polygon check (hexagon ≈ 0.05)
const POLY_MIN = 3, POLY_MAX = 8;
const TRI_SIDE = 0.15;       // triangle: every side ≥ 15 % of the perimeter
const POLY_SIDE = 0.06;      // polygon: every side ≥ 6 % of the perimeter (shorter sides are merged first)
const SQUARE_TOL = Math.PI / 18;  // four corners within 10° of 90° → rectangle
const CORNER_MERGE = 2;      // corners closer than 0.2 mm are the same corner
const PARALLEL_EPS = 0.1;    // sine of the angle below which two side lines do not give a corner

/**
 * Recognizes a shape in a pen stroke.
 * Returns null or {kind: 'line'|'arrow'|'circle'|'ellipse'|'rect'|'triangle'|'polygon', pts: Int32Array}
 * (x,y,p triples, dense). Closed shapes end at their start point. An arrow is one open path:
 * shaft start → tip → arm → tip → arm.
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

  // 2. Arrow: a straight shaft with a V-shaped head at its tip. A closed stroke cannot match (its return passes the start).
  const arrow = arrowVerts(pts, n);
  if (arrow) return { kind: 'arrow', pts: emit(arrow, press) };

  // Everything below is a closed shape: the end must come back close to the start.
  const bw = x1 - x0, bh = y1 - y0;
  const span = Math.max(bw, bh);
  if (!(Math.hypot(ex - sx, ey - sy) <= CLOSE_TOL * span)) return null;
  if (!(bw >= 1 && bh >= 1)) return null;
  const clockwise = area2 > 0;   // y axis points down: positive shoelace area = drawn clockwise on screen

  // 3. Ellipse / circle, fitted to the bbox. Within the tolerance, real corners (hexagon) win over the ellipse,
  //    but only for strokes that are not clearly round.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = bw / 2, ry = bh / 2;
  let dev = 0;
  for (let i = 0; i < n; i++) {
    const u = (pts[3 * i] - cx) / rx, v = (pts[3 * i + 1] - cy) / ry;
    dev += Math.abs(Math.sqrt(u * u + v * v) - 1);
  }
  let poly = null;
  if (dev / n <= ELLIPSE_TOL) {
    poly = dev / n <= ROUND_TOL ? null : polygonOf(pts, n, span, true);
    if (!poly) {
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
  }

  // 4. Axis-aligned rectangle.
  const rect = rectVerts(pts, n, x0, y0, x1, y1, clockwise);
  if (rect) return { kind: 'rect', pts: emit(rect, press) };

  // 5. Triangle or polygon (a rotated rectangle becomes an exact rectangle of kind 'polygon').
  if (!poly) poly = polygonOf(pts, n, span, false);
  if (!poly) return null;
  const verts = [];
  for (const c of poly.corners) verts.push(c[0], c[1]);
  verts.push(poly.corners[0][0], poly.corners[0][1]);
  return { kind: poly.kind, pts: emit(verts, press) };
}

// Arrow: long straight shaft from the start to the tip, then a head behind the tip with two arms (or one arm for a
// one-sided hook). Returns the float polyline start → tip → arm → tip → arm, or null.
function arrowVerts(pts, n) {
  const sx0 = pts[0], sy0 = pts[1];
  // Tip: the farthest point before the stroke turns back (the distance from the start falls again).
  let iT = 0, runMax = -1;
  for (let i = 0; i < n; i++) {
    const dx = pts[3 * i] - sx0, dy = pts[3 * i + 1] - sy0;
    const dd = Math.sqrt(dx * dx + dy * dy);
    if (dd > runMax) { runMax = dd; iT = i; }
    else if (dd < runMax - Math.max(ARROW_TURN_MIN, ARROW_TURN_FRAC * runMax)) break;
  }
  if (iT === 0 || runMax < ARROW_MIN_CHORD) return null;
  const [ax, ay, bx, by] = snapLine(sx0, sy0, pts[3 * iT], pts[3 * iT + 1]);
  const d = Math.hypot(bx - ax, by - ay);
  if (!(d >= ARROW_MIN_CHORD)) return null;

  // Shaft: every point up to the tip lies close to the chord start → tip.
  const lim2 = (LINE_TOL * d) * (LINE_TOL * d);
  for (let i = 0; i <= iT; i++) {
    if (segDist2(pts[3 * i], pts[3 * i + 1], ax, ay, bx, by) > lim2) return null;
  }

  // Head: the rest of the stroke stays behind the tip (not beyond it), within 30 % of the shaft.
  const ux = (bx - ax) / d, uy = (by - ay) / d;
  const maxR2 = (ARROW_MAX_HOOK * d) * (ARROW_MAX_HOOK * d);
  const backTol = LINE_TOL * d;
  let hook2 = -1, far = -1;
  for (let i = iT + 1; i < n; i++) {
    const rx = pts[3 * i] - bx, ry = pts[3 * i + 1] - by;
    if (rx * ux + ry * uy > backTol) return null;
    const r2 = rx * rx + ry * ry;
    if (r2 > maxR2) return null;
    if (r2 > hook2) { hook2 = r2; far = i; }
  }
  if (far < 0) return null;
  const hook = Math.sqrt(hook2);
  if (hook < ARROW_MIN_HOOK) return null;

  // The farthest arm point decides the side and must lie at a sensible angle to the backward direction.
  const fx = pts[3 * far] - bx, fy = pts[3 * far + 1] - by;
  const back = -(fx * ux + fy * uy);      // > 0: behind the tip
  const side = -fx * uy + fy * ux;       // perpendicular component, sign = side of the arm
  const ang = Math.atan2(Math.abs(side), back);
  if (!(ang >= ARROW_ARM_MIN && ang <= ARROW_ARM_MAX)) return null;

  // Symmetric output: both arms at 30°, length = measured hook (clamped to 25 % of the shaft).
  const armLen = Math.min(hook, ARROW_MAX_FRAC * d);
  const sg = side >= 0 ? 1 : -1;
  const bkx = -ux, bky = -uy;
  const c = Math.cos(ARROW_ANGLE), s = Math.sin(ARROW_ANGLE) * sg;
  const a1x = bkx * c - bky * s, a1y = bkx * s + bky * c;   // arm on the side of the far point
  const a2x = bkx * c + bky * s, a2y = -bkx * s + bky * c;  // mirrored arm
  return [
    ax, ay, bx, by,
    bx + armLen * a1x, by + armLen * a1y, bx, by,
    bx + armLen * a2x, by + armLen * a2y,
  ];
}

// Triangle or polygon from a closed stroke: Douglas-Peucker corners, removal of weak corners and short sides,
// corners re-fitted as intersections of the side lines, then the checks. Returns {kind, corners} with the corners in
// drawing order (starting at the corner nearest the stroke start), or null. Circles and wobbly loops do not pass.
function polygonOf(pts, n, span, guard) {
  const sx = pts[0], sy = pts[1];
  let iA = 0, far2 = -1;
  for (let i = 1; i < n; i++) {
    const dx = pts[3 * i] - sx, dy = pts[3 * i + 1] - sy, d2 = dx * dx + dy * dy;
    if (d2 > far2) { far2 = d2; iA = i; }
  }
  if (iA < 2 || iA > n - 3) return null;
  const eps = Math.max(POLY_EPS * span, POLY_FIT_MIN);
  const fit = Math.max(POLY_FIT * span, POLY_FIT_MIN);

  // Douglas-Peucker on both halves (start → far point → end). The last point is the start again, so it is dropped.
  const idx = simplifyRange(pts, 0, iA, eps).concat(simplifyRange(pts, iA, n - 1, eps).slice(1, -1));
  let P = dropNear(idx.map((i) => [pts[3 * i], pts[3 * i + 1]]));
  if (P.length < POLY_MIN) return null;
  const orient = Math.sign(polySigned(P));
  if (orient === 0) return null;

  P = mergeShortSides(removeWeakCorners(P, orient), orient);
  if (P.length < POLY_MIN) return null;
  P = refineCorners(pts, n, P);
  if (!P) return null;
  // Guard for round shapes (ellipse branch only): the refined corners must fit tightly. A circle's side lines still
  // deviate by at least 3.5 % of the span, a real polygon stays below about 1.8 %.
  if (guard && !fitsPolygon(pts, n, P, Math.max(POLY_ROUND * span, POLY_ROUND_MIN))) return null;

  const k = P.length;
  if (k > POLY_MAX) return null;
  let per = 0;
  const lens = [];
  for (let i = 0; i < k; i++) {
    const a = P[i], b = P[(i + 1) % k];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(l);
    per += l;
  }
  const minSide = (k === 3 ? TRI_SIDE : POLY_SIDE) * per;
  for (let i = 0; i < k; i++) {
    if (lens[i] < minSide) return null;
    if (interiorAngle(P[(i + k - 1) % k], P[i], P[(i + 1) % k], orient) >= CORNER_MAX) return null;
  }

  // Fit: every input point lies close to the polygon boundary (no curved or wobbly outline).
  if (!fitsPolygon(pts, n, P, fit)) return null;

  // Start at the corner nearest to the stroke start.
  let start = 0, bestD = Infinity;
  for (let i = 0; i < k; i++) {
    const d = Math.hypot(P[i][0] - sx, P[i][1] - sy);
    if (d < bestD) { bestD = d; start = i; }
  }
  const C = [];
  for (let j = 0; j < k; j++) C.push(P[(start + j) % k]);
  if (k === 3) return { kind: 'triangle', corners: C };
  if (k === 4 && rightAngles(C, orient)) return { kind: 'polygon', corners: squareFromCorners(C) };
  return { kind: 'polygon', corners: C };
}

// Every input point lies within tol of the closed polygon P.
function fitsPolygon(pts, n, P, tol) {
  const k = P.length, tol2 = tol * tol;
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1];
    let best = Infinity;
    for (let j = 0; j < k; j++) {
      const a = P[j], b = P[(j + 1) % k];
      const d2 = segDist2(x, y, a[0], a[1], b[0], b[1]);
      if (d2 < best) best = d2;
    }
    if (best > tol2) return false;
  }
  return true;
}

// Removes vertices that are no corner (interior angle ≥ 160°, or concave), the straightest first.
function removeWeakCorners(P, orient) {
  for (;;) {
    const k = P.length;
    if (k <= POLY_MIN) return P;
    let worst = 0, worstA = -1;
    for (let i = 0; i < k; i++) {
      const a = interiorAngle(P[(i + k - 1) % k], P[i], P[(i + 1) % k], orient);
      if (a > worstA) { worstA = a; worst = i; }
    }
    if (worstA < CORNER_MAX) return P;
    P.splice(worst, 1);
  }
}

// Removes the shorter of the two corners of a side that is shorter than POLY_SIDE of the perimeter (split corners).
function mergeShortSides(P, orient) {
  for (;;) {
    const k = P.length;
    if (k <= POLY_MIN) return P;
    let per = 0, sh = 0, shLen = Infinity;
    for (let i = 0; i < k; i++) {
      const a = P[i], b = P[(i + 1) % k];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      per += l;
      if (l < shLen) { shLen = l; sh = i; }
    }
    if (shLen >= POLY_SIDE * per) return P;
    const i1 = sh, i2 = (sh + 1) % k;
    const a1 = interiorAngle(P[(i1 + k - 1) % k], P[i1], P[i2], orient);
    const a2 = interiorAngle(P[i1], P[i2], P[(i2 + 1) % k], orient);
    P.splice(a1 >= a2 ? i1 : i2, 1);
  }
}

// Each input point belongs to its nearest side. A line is fitted per side (principal axis), and every corner becomes
// the intersection of its two side lines. Returns the corners or null (too few points on a side, parallel sides).
function refineCorners(pts, n, P) {
  const k = P.length;
  const cnt = new Array(k).fill(0), sxs = new Array(k).fill(0), sys = new Array(k).fill(0);
  const sxx = new Array(k).fill(0), syy = new Array(k).fill(0), sxy = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1];
    let best = 0, bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const a = P[j], b = P[(j + 1) % k];
      const d2 = segDist2(x, y, a[0], a[1], b[0], b[1]);
      if (d2 < bestD) { bestD = d2; best = j; }
    }
    cnt[best]++;
    sxs[best] += x; sys[best] += y;
    sxx[best] += x * x; syy[best] += y * y; sxy[best] += x * y;
  }
  const lines = [];
  for (let j = 0; j < k; j++) {
    if (cnt[j] < 2) return null;
    const mx = sxs[j] / cnt[j], my = sys[j] / cnt[j];
    const cxx = sxx[j] - cnt[j] * mx * mx, cyy = syy[j] - cnt[j] * my * my, cxy = sxy[j] - cnt[j] * mx * my;
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    lines.push({ mx, my, dx: Math.cos(th), dy: Math.sin(th) });
  }
  const out = [];
  for (let j = 0; j < k; j++) {
    const L1 = lines[(j + k - 1) % k], L2 = lines[j];
    const den = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(den) < PARALLEL_EPS) return null;
    const t = ((L2.mx - L1.mx) * L2.dy - (L2.my - L1.my) * L2.dx) / den;
    out.push([L1.mx + t * L1.dx, L1.my + t * L1.dy]);
  }
  return out;
}

// Interior angle at b (between a→b and b→c). Convex corners: π − turn; concave (against the orientation): π + turn.
function interiorAngle(a, b, c, orient) {
  const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = c[0] - b[0], d2y = c[1] - b[1];
  const cross = d1x * d2y - d1y * d2x;
  const dot = d1x * d2x + d1y * d2y;
  const turn = Math.atan2(Math.abs(cross), dot);
  return cross * orient >= 0 ? Math.PI - turn : Math.PI + turn;
}

function rightAngles(C, orient) {
  for (let i = 0; i < 4; i++) {
    const a = interiorAngle(C[(i + 3) % 4], C[i], C[(i + 1) % 4], orient);
    if (Math.abs(a - Math.PI / 2) > SQUARE_TOL) return false;
  }
  return true;
}

// Four right-angled corners (drawn order) → exact rectangle: same centre, sides averaged, rotation from the longest side.
function squareFromCorners(C) {
  const len = [], e = [];
  for (let i = 0; i < 4; i++) {
    const a = C[i], b = C[(i + 1) % 4];
    e.push([b[0] - a[0], b[1] - a[1]]);
    len.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  let L = 0;
  for (let i = 1; i < 4; i++) if (len[i] > len[L]) L = i;
  const ux = e[L][0] / len[L], uy = e[L][1] / len[L];
  const vx = -uy, vy = ux;
  const W = (len[L] + len[(L + 2) % 4]) / 2;
  const H = (len[(L + 1) % 4] + len[(L + 3) % 4]) / 2;
  let mx = 0, my = 0;
  for (const c of C) { mx += c[0] / 4; my += c[1] / 4; }
  return C.map((c) => {
    const dx = c[0] - mx, dy = c[1] - my;
    const su = dx * ux + dy * uy >= 0 ? 1 : -1;
    const sv = dx * vx + dy * vy >= 0 ? 1 : -1;
    return [mx + su * (W / 2) * ux + sv * (H / 2) * vx, my + su * (W / 2) * uy + sv * (H / 2) * vy];
  });
}

// Axis-aligned rectangle: points hug the bbox border and cover all four sides. Returns 5 corners (flat) or null.
function rectVerts(pts, n, x0, y0, x1, y1, clockwise) {
  const bw = x1 - x0, bh = y1 - y0;
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
  const sx = pts[0], sy = pts[1];
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
  return verts;
}

// Douglas-Peucker on pts[a..b] (indices, both ends kept). Returns the kept indices in order.
function simplifyRange(pts, a, b, eps) {
  const keep = new Uint8Array(b - a + 1);
  keep[0] = 1;
  keep[b - a] = 1;
  const eps2 = eps * eps;
  const stack = [[a, b]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bestD = -1;
    for (let i = s + 1; i < e; i++) {
      const d2 = segDist2(pts[3 * i], pts[3 * i + 1], pts[3 * s], pts[3 * s + 1], pts[3 * e], pts[3 * e + 1]);
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (best >= 0 && bestD > eps2) {
      keep[best - a] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  const out = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(a + i);
  return out;
}

// Removes corners that (almost) coincide with the previous one, including the wrap-around.
function dropNear(P) {
  const out = [];
  for (const p of P) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > CORNER_MERGE) out.push(p);
  }
  while (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(l[0] - f[0], l[1] - f[1]) > CORNER_MERGE) break;
    out.pop();
  }
  return out;
}

// Shoelace sum of a closed vertex list (sign = orientation).
function polySigned(P) {
  let s = 0;
  const k = P.length;
  for (let i = 0; i < k; i++) {
    const a = P[i], b = P[(i + 1) % k];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
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
