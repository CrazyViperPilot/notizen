// node --test test/js/  (Zirkel, Geometrie ohne DOM: js/ui/compass-geom.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZIRKEL_MIN_MM, ZIRKEL_MAX_MM, ZIRKEL_DEFAULT_MM, TIP_R, CENTER_R, MAX_CANVAS_PX,
  clampRadius, snapRadius, tipPoint, hingePoint, compassBox, circleEdgeAt, projectToCircle, sweepDeg,
  angleAt, radiusAtPoint, formatRadius, formatMeasure, hitCenter, hitTip, hitLegs, normDeg,
} from '../../js/ui/compass-geom.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearPt = (p, q, eps = 1e-6) => { near(p.x, q.x, eps); near(p.y, q.y, eps); };

const S = 5;                                              // px pro mm (Test)
const Z = { cx: 500, cy: 400, r: 10, a: 0, visible: true };   // Radius 10 mm = 50 px, Spitze rechts
const at = (deg, rPx = 50, c = Z) => ({ x: c.cx + rPx * Math.cos((deg * Math.PI) / 180), y: c.cy + rPx * Math.sin((deg * Math.PI) / 180) });

test('constants: radius 1 … 150 mm, default 30 mm, 44 px touch targets', () => {
  assert.equal(ZIRKEL_MIN_MM, 1);
  assert.equal(ZIRKEL_MAX_MM, 150);
  assert.equal(ZIRKEL_DEFAULT_MM, 30);
  assert.equal(2 * TIP_R, 44);
  assert.equal(2 * CENTER_R, 44);
  assert.equal(MAX_CANVAS_PX, 4096);
});

test('re-exported normDeg works', () => {
  assert.equal(normDeg(190), -170);
});

test('clampRadius keeps 1 … 150 mm and does not round', () => {
  assert.equal(clampRadius(0), 1);
  assert.equal(clampRadius(200), 150);
  assert.equal(clampRadius(3.4), 3.4);
  assert.equal(clampRadius(NaN), ZIRKEL_DEFAULT_MM);
});

test('snapRadius rounds to whole mm and stays in range', () => {
  assert.equal(snapRadius(3.4), 3);
  assert.equal(snapRadius(3.5), 4);
  assert.equal(snapRadius(0.2), 1);
  assert.equal(snapRadius(200), 150);
});

test('formatRadius: centimetres with one decimal and a German comma', () => {
  assert.equal(formatRadius(35), 'r = 3,5 cm');
  assert.equal(formatRadius(10), 'r = 1,0 cm');
  assert.equal(formatRadius(150), 'r = 15,0 cm');
  assert.equal(formatRadius(5), 'r = 0,5 cm');
  assert.equal(formatRadius(1), 'r = 0,1 cm');
  assert.ok(!formatRadius(35).includes('mm'), 'unter 1 cm keine mm-Angabe');
});

test('formatMeasure: radius and swept angle', () => {
  assert.equal(formatMeasure(35, 72), 'r = 3,5 cm · 72°');
  assert.equal(formatMeasure(10, 0), 'r = 1,0 cm · 0°');
});

test('tipPoint: angle 0 is right, 90 is down, −90 is up, 180 is left (screen coordinates)', () => {
  nearPt(tipPoint(Z, S), { x: 550, y: 400 });
  nearPt(tipPoint({ ...Z, a: 90 }, S), { x: 500, y: 450 });
  nearPt(tipPoint({ ...Z, a: -90 }, S), { x: 500, y: 350 });
  nearPt(tipPoint({ ...Z, a: 180 }, S), { x: 450, y: 400 });
});

test('hingePoint: 40 px from the midpoint, perpendicular to the legs, on the upper side', () => {
  // a = 0: Spitze rechts → Gelenk über der Mitte (525, 400) bei (525, 360)
  nearPt(hingePoint(Z, S), { x: 525, y: 360 });
  // a = 180: Spitze links → Gelenk ebenfalls oben
  nearPt(hingePoint({ ...Z, a: 180 }, S), { x: 475, y: 360 });
  // senkrechte Verbindung: Gelenk links der Mitte
  nearPt(hingePoint({ ...Z, a: 90 }, S), { x: 460, y: 425 });
  nearPt(hingePoint({ ...Z, a: -90 }, S), { x: 460, y: 375 });
  for (const a of [0, 30, 45, 90, 135, 180, -20, -90, -150]) {
    const st = { ...Z, a };
    const t = tipPoint(st, S);
    const mid = { x: (st.cx + t.x) / 2, y: (st.cy + t.y) / 2 };
    const g = hingePoint(st, S);
    near(Math.hypot(g.x - mid.x, g.y - mid.y), 40, 1e-6);
    // Abstand zu Einstich und Spitze gleich (das Gelenk liegt auf der Mittelsenkrechten)
    near(Math.hypot(g.x - st.cx, g.y - st.cy), Math.hypot(g.x - t.x, g.y - t.y), 1e-6);
  }
});

test('compassBox: circle plus padding, centre at (ox, oy), never above 4096 px', () => {
  const b = compassBox(Z, S);                             // R = 50 px → half = 50 + 70
  assert.equal(b.w, 240);
  assert.equal(b.h, 240);
  assert.equal(b.ox, 120);
  assert.equal(b.oy, 120);
  const tiny = compassBox({ ...Z, r: 1 }, 1);            // R = 1 px
  assert.equal(tiny.w, 2 * (1 + 70));
  const huge = compassBox({ ...Z, r: 150 }, 100);        // R = 15000 px → auf die Canvas-Grenze gekappt
  assert.ok(huge.w <= MAX_CANVAS_PX && huge.h <= MAX_CANVAS_PX, `${huge.w} × ${huge.h}`);
  assert.equal(huge.ox, huge.w / 2);
});

test('circleEdgeAt: within 24 px of the circle line → 0, otherwise null', () => {
  assert.equal(circleEdgeAt(Z, S, { x: 550, y: 400 }), 0);          // genau auf dem Kreis
  assert.equal(circleEdgeAt(Z, S, { x: 574, y: 400 }), 0);          // 24 px außen
  assert.equal(circleEdgeAt(Z, S, { x: 575, y: 400 }), null);       // 25 px außen
  assert.equal(circleEdgeAt(Z, S, { x: 526, y: 400 }), 0);          // 24 px innen
  assert.equal(circleEdgeAt(Z, S, { x: 525, y: 400 }), null);       // 25 px innen
  assert.equal(circleEdgeAt(Z, S, { x: 500, y: 400 }), null);       // im Einstich, Kreis weit weg
  assert.equal(circleEdgeAt(Z, S, at(45)), 0);                      // schräg
});

test('circleEdgeAt: custom maxDist and hidden compass', () => {
  assert.equal(circleEdgeAt(Z, S, { x: 560, y: 400 }), 0);          // 10 px außen, Standard 24
  assert.equal(circleEdgeAt(Z, S, { x: 560, y: 400 }, 5), null);    // mit 5 px Toleranz nicht mehr
  assert.equal(circleEdgeAt({ ...Z, visible: false }, S, { x: 550, y: 400 }), null);
});

test('projectToCircle: point on the circle in the direction of the pen', () => {
  nearPt(projectToCircle(Z, S, { x: 600, y: 400 }), { x: 550, y: 400 });
  nearPt(projectToCircle(Z, S, { x: 500, y: 300 }), { x: 500, y: 350 });
  const k = 50 / Math.SQRT2;                              // Richtung (−1, +1) vom Einstich
  nearPt(projectToCircle(Z, S, { x: 400, y: 500 }), { x: 500 - k, y: 400 + k });
});

test('projectToCircle: diagonal lands at distance r on the circle', () => {
  const p = projectToCircle(Z, S, { x: 600, y: 500 });
  near(Math.hypot(p.x - Z.cx, p.y - Z.cy), 50, 1e-6);
  near((p.x - Z.cx) / (p.y - Z.cy), 100 / 100, 1e-6);   // gleiche Richtung wie der Stift
});

test('projectToCircle: at the centre the tip is returned', () => {
  nearPt(projectToCircle(Z, S, { x: 500, y: 400 }), { x: 550, y: 400 });
  nearPt(projectToCircle({ ...Z, a: 90 }, S, { x: 500, y: 400 }), { x: 500, y: 450 });
});

test('sweepDeg: simple sweep, integer, sign ignored', () => {
  assert.equal(sweepDeg(Z, at(0), at(90)), 90);
  assert.equal(sweepDeg(Z, at(90), at(0)), 90);        // gegen den Uhrzeigersinn: gleicher Betrag
  assert.equal(sweepDeg(Z, at(0), at(180)), 180);
  assert.equal(sweepDeg(Z, at(40), at(40)), 0);
  const s72 = sweepDeg(Z, at(0), at(72));
  assert.equal(s72, 72);
  assert.ok(Number.isInteger(s72));
});

test('sweepDeg: across the 0°/360° boundary takes the short way round', () => {
  assert.equal(sweepDeg(Z, at(350), at(10)), 20);
  assert.equal(sweepDeg(Z, at(10), at(350)), 20);
  assert.equal(sweepDeg(Z, at(-170), at(170)), 20);
});

test('angleAt: screen angle of a point around the centre, normalised', () => {
  near(angleAt(Z, { x: 550, y: 400 }), 0);
  near(angleAt(Z, { x: 500, y: 450 }), 90);
  near(angleAt(Z, { x: 450, y: 400 }), 180);
  near(angleAt(Z, { x: 500, y: 350 }), -90);
});

test('radiusAtPoint: distance / pxPerMm, clamped to 1 … 150 mm, not rounded', () => {
  near(radiusAtPoint(Z, S, { x: 550, y: 400 }), 10);
  near(radiusAtPoint(Z, S, { x: 600, y: 400 }), 20);
  near(radiusAtPoint(Z, S, { x: 500 + 3.7 * S, y: 400 }), 3.7, 1e-9);   // ungerundet
  assert.equal(radiusAtPoint(Z, S, { x: 500, y: 400 }), 1);            // Einstich → min 1 mm
  assert.equal(radiusAtPoint(Z, S, { x: 500 + 5000, y: 400 }), 150);   // weit weg → max 150 mm
  assert.equal(radiusAtPoint(Z, 0, { x: 600, y: 400 }), 10);           // noch kein Layout: alter Radius
});

test('hitCenter: 22 px radius (44 px target)', () => {
  assert.equal(hitCenter(Z, S, { x: 521, y: 400 }), true);
  assert.equal(hitCenter(Z, S, { x: 523, y: 400 }), false);
});

test('hitTip: 22 px radius around the pencil tip', () => {
  assert.equal(hitTip(Z, S, { x: 571, y: 400 }), true);
  assert.equal(hitTip(Z, S, { x: 550, y: 422 }), true);
  assert.equal(hitTip(Z, S, { x: 573, y: 400 }), false);
  assert.equal(hitTip(Z, S, { x: 500, y: 400 }), false);   // Einstich ist nicht die Spitze
});

test('hitLegs: 15 px either side of the legs; far away misses', () => {
  // Punkt 10 px neben dem Schenkel Einstich → Gelenk (Mitte (512.5, 380), Senkrechte (0.848, 0.530))
  assert.equal(hitLegs(Z, S, { x: 520.98, y: 385.3 }), true);
  // am Gelenk selbst
  assert.equal(hitLegs(Z, S, { x: 525, y: 370 }), true);
  // am zweiten Schenkel (Gelenk → Spitze)
  assert.equal(hitLegs(Z, S, { x: 545.98, y: 374.7 }), true);
  // weit weg vom Zirkel
  assert.equal(hitLegs(Z, S, { x: 480, y: 420 }), false);
});

test('circleEdgeAt and hitTip use the same pixel scale', () => {
  const t = tipPoint(Z, 10);                              // doppelt so große Skala
  assert.equal(circleEdgeAt(Z, 10, t), 0);
  assert.equal(circleEdgeAt(Z, S, t), null);              // bei 5 px/mm liegt der Kreis woanders
  assert.equal(hitTip(Z, 10, t), true);
});
