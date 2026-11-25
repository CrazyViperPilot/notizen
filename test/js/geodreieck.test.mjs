// node --test test/js/  (Geodreieck, Geometrie ohne DOM: js/ui/geodreieck-geom.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEO_HYP_MM, GEO_H_MM, ARC_R_MM, geoCorners, hitGeo, geoEdgeAt, geoProject, hitGeoGrip, geoGripDist, geoBox,
  degreeTicks, hypTicks, snapAngle, normDeg,
} from '../../js/ui/geodreieck-geom.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearPt = (p, q, eps = 1e-6) => { near(p.x, q.x, eps); near(p.y, q.y, eps); };

const S = 5;                                   // px pro mm (Test): Hypotenuse 800 px, Spitze 400 px über dem Nullpunkt
const R0 = { x: 500, y: 400, angle: 0 };       // Nullpunkt (Mitte der Hypotenuse) bei (500, 400), 0°

test('constants: 160 mm hypotenuse, 80 mm height, 52 mm protractor radius', () => {
  assert.equal(GEO_HYP_MM, 160);
  assert.equal(GEO_H_MM, 80);
  assert.equal(ARC_R_MM, 52);
});

test('re-exported ruler helpers work (snapAngle, normDeg)', () => {
  assert.equal(snapAngle(44), 45);
  assert.equal(normDeg(190), -170);
});

test('geoBox: 160 × 80 mm plus a few px rim, origin at the bottom centre', () => {
  const b = geoBox(S);
  assert.equal(b.w, 160 * S + 8);
  assert.equal(b.h, 80 * S + 8);
  assert.equal(b.ox, b.w / 2);
  assert.equal(b.oy, b.h - 4);
});

test('geoCorners at 0°: left, right, apex (apex points up)', () => {
  const [l, r, a] = geoCorners(R0, S);
  nearPt(l, { x: 100, y: 400 });
  nearPt(r, { x: 900, y: 400 });
  nearPt(a, { x: 500, y: 0 });
});

test('geoCorners at 90°: apex points right', () => {
  const [l, r, a] = geoCorners({ x: 0, y: 0, angle: 90 }, S);
  nearPt(l, { x: 0, y: -400 });
  nearPt(r, { x: 0, y: 400 });
  nearPt(a, { x: 400, y: 0 });
});

test('geoCorners at 180°: apex points down', () => {
  const [, , a] = geoCorners({ x: 0, y: 0, angle: 180 }, S);
  nearPt(a, { x: 0, y: 400 });
});

test('hitGeo: inside; corners and edges count as inside; outside is false', () => {
  assert.equal(hitGeo(R0, S, { x: 500, y: 380 }), true);
  assert.equal(hitGeo(R0, S, { x: 500, y: 100 }), true);
  assert.equal(hitGeo(R0, S, { x: 500, y: 0 }), true);          // Spitze
  assert.equal(hitGeo(R0, S, { x: 100, y: 400 }), true);        // linke Ecke
  assert.equal(hitGeo(R0, S, { x: 500, y: 410 }), false);       // unter der Hypotenuse
  assert.equal(hitGeo(R0, S, { x: 500, y: -10 }), false);       // über der Spitze
  assert.equal(hitGeo(R0, S, { x: 99, y: 400 }), false);        // links der Ecke
  assert.equal(hitGeo(R0, S, { x: 100, y: 300 }), false);       // außerhalb der linken Kathete
});

test('hitGeo follows the rotation (apex to the right at 90°)', () => {
  const s = { x: 0, y: 0, angle: 90 };
  assert.equal(hitGeo(s, S, { x: 300, y: 0 }), true);
  assert.equal(hitGeo(s, S, { x: -300, y: 0 }), false);
});

test('geoEdgeAt: hypotenuse = 0 (outside, within 24 px)', () => {
  assert.equal(geoEdgeAt(R0, S, { x: 500, y: 410 }), 0);        // 10 px außen
  assert.equal(geoEdgeAt(R0, S, { x: 500, y: 420 }), 0);        // 20 px
  assert.equal(geoEdgeAt(R0, S, { x: 500, y: 430 }), null);     // 30 px, zu weit
});

test('geoEdgeAt: inside or far away = null', () => {
  assert.equal(geoEdgeAt(R0, S, { x: 500, y: 380 }), null);     // innen, 20 px von der Hypotenuse
  assert.equal(geoEdgeAt(R0, S, { x: 303.5, y: 203.5 }), null); // 5 px innen an der linken Kathete
  assert.equal(geoEdgeAt(R0, S, { x: 1000, y: 1000 }), null);   // weit weg
});

test('geoEdgeAt: left (1) and right (2) Katheten, 10 px outside', () => {
  const c = Math.SQRT1_2;
  assert.equal(geoEdgeAt(R0, S, { x: 300 - 10 * c, y: 200 - 10 * c }), 1);   // Mitte links, oben links
  assert.equal(geoEdgeAt(R0, S, { x: 700 + 10 * c, y: 200 - 10 * c }), 2);   // Mitte rechts, oben rechts
});

test('geoEdgeAt honours maxDist', () => {
  assert.equal(geoEdgeAt(R0, S, { x: 500, y: 410 }, 5), null);  // 10 px > 5
  assert.equal(geoEdgeAt(R0, S, { x: 500, y: 405 }, 5), 0);     // 5 px
});

test('geoEdgeAt: beyond the end of the hypotenuse uses the distance to the segment end', () => {
  // (95, 408): 8 px unter der Hypotenuse, 5 px jenseits der Ecke → 9.4 px vom Segment; die linke Kathete ist zu weit
  assert.equal(geoEdgeAt(R0, S, { x: 95, y: 408 }), 0);
});

test('geoEdgeAt: with two candidates near the apex the nearer edge wins', () => {
  // Spitze bei (500, 0). Punkt (496, −3): linke Kante 4.95 px, rechte Kante 5.0 px vom Segment
  assert.equal(geoEdgeAt(R0, S, { x: 496, y: -3 }), 1);
  assert.equal(geoEdgeAt(R0, S, { x: 504, y: -3 }), 2);
});

test('geoProject: hypotenuse → onto the line, 1.5 px outside, position along it kept', () => {
  nearPt(geoProject(R0, S, { x: 200, y: 380 }, 0), { x: 200, y: 401.5 });
  nearPt(geoProject(R0, S, { x: 800, y: 450 }, 0), { x: 800, y: 401.5 });   // auch hinter dem Ende
});

test('geoProject: left Kathete → 1.5 px outside its line', () => {
  const r = geoProject(R0, S, { x: 400, y: 300 }, 1);      // innen, (u, n) = (−100, −100)
  // Abstand zur Geraden u + n + 400 = 0 (in px, normiert), außen negativ: −1.5
  const g = ((r.x - 500) + (r.y - 400) + 400) / Math.SQRT2;
  near(g, -1.5, 1e-6);
});

test('geoProject: right Kathete → 1.5 px outside its line', () => {
  const r = geoProject(R0, S, { x: 600, y: 300 }, 2);      // innen, (u, n) = (100, −100)
  const g = (-(r.x - 500) + (r.y - 400) + 400) / Math.SQRT2;
  near(g, -1.5, 1e-6);
});

test('geoProject at 90°: the outside of the hypotenuse is the left side', () => {
  nearPt(geoProject({ x: 0, y: 0, angle: 90 }, S, { x: 50, y: 200 }, 0), { x: -1.5, y: 200 });
});

test('geoProject with an unknown edge returns the point unchanged', () => {
  nearPt(geoProject(R0, S, { x: 123, y: 456 }, 7), { x: 123, y: 456 });
});

test('hitGeoGrip: radius 22 px around 62 mm (18 mm below the apex)', () => {
  assert.equal(hitGeoGrip(R0, S, { x: 500, y: 90 }), true);     // Mitte des Griffs
  assert.equal(hitGeoGrip(R0, S, { x: 500, y: 112 }), true);    // 22 px
  assert.equal(hitGeoGrip(R0, S, { x: 500, y: 113 }), false);
  assert.equal(hitGeoGrip(R0, S, { x: 500, y: 400 }), false);   // Nullpunkt
});

test('geoGripDist: 62 mm, but at least 30 px from the origin', () => {
  assert.equal(geoGripDist(5), 310);
  assert.equal(geoGripDist(1), 62);
  assert.equal(geoGripDist(0.3), 30);
});

test('degreeTicks: 181 entries at pxPerMm >= 2, labels 0 and 180 mirrored', () => {
  const t = degreeTicks(5);
  assert.equal(t.length, 181);
  assert.deepEqual(t[0], { deg: 0, len: 'ten', outer: '0', inner: '180' });
  assert.deepEqual(t[180], { deg: 180, len: 'ten', outer: '180', inner: '0' });
  assert.equal(t.filter((x) => x.len === 'ten').length, 19);
  assert.equal(t.filter((x) => x.len === 'five').length, 18);
  assert.equal(t.filter((x) => x.len === 'one').length, 144);
  assert.equal(t.filter((x) => x.outer !== undefined).length, 19);   // Beschriftung nur alle 10°
});

test('degreeTicks: no 1° ticks below 2 px per mm', () => {
  const t = degreeTicks(1.5);
  assert.equal(t.length, 37);
  assert.equal(t.some((x) => x.len === 'one'), false);
  assert.equal(t.filter((x) => x.len === 'ten').length, 19);
});

test('hypTicks: −70 … +70 mm, labels |cm|, 0 in the middle', () => {
  const t = hypTicks(5);
  assert.equal(t.length, 141);
  assert.deepEqual(t[0], { mm: -70, len: 'cm', label: '7' });
  assert.deepEqual(t[140], { mm: 70, len: 'cm', label: '7' });
  assert.equal(t.find((x) => x.mm === 0).label, '0');
  assert.equal(t.filter((x) => x.len === 'cm').length, 15);
  assert.equal(t.filter((x) => x.len === 'half').length, 14);
  assert.equal(t.filter((x) => x.len === 'mm').length, 112);
});

test('hypTicks: no 1 mm ticks below 2 px per mm', () => {
  const t = hypTicks(1.5);
  assert.equal(t.length, 29);
  assert.equal(t.some((x) => x.len === 'mm'), false);
});

test('all protractor ticks (radius 52 mm) and the arc up to 56 mm lie inside the triangle', () => {
  for (const d of degreeTicks(S)) {
    const a = (d.deg * Math.PI) / 180;
    const p = { x: R0.x + S * ARC_R_MM * Math.cos(a), y: R0.y - S * ARC_R_MM * Math.sin(a) };
    assert.equal(hitGeo(R0, S, p), true, `Gradstrich ${d.deg}° liegt außerhalb`);
  }
  for (let deg = 0; deg <= 180; deg++) {
    const a = (deg * Math.PI) / 180;
    const p = { x: R0.x + S * 56 * Math.cos(a), y: R0.y - S * 56 * Math.sin(a) };
    assert.equal(hitGeo(R0, S, p), true, `Halbkreis 56 mm bei ${deg}° außerhalb`);
  }
});
