// node --test test/js/  (Lineal, Geometrie ohne DOM: js/ui/ruler-geom.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULER_MM, RULER_H, rulerCorners, rulerLength, hitRuler, gripCenter, hitGrip, edgeAt, projectToEdge,
  twist, snapAngle, ticks, normDeg,
} from '../../js/ui/ruler-geom.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearPt = (p, q) => { near(p.x, q.x); near(p.y, q.y); };

const S = 5;                                  // px pro mm (Test)
const R0 = { x: 1000, y: 500, angle: 0 };     // Lineal waagerecht, Mitte (1000, 500)

test('constants: 30 cm long, 70 px high', () => {
  assert.equal(RULER_MM, 300);
  assert.equal(RULER_H, 70);
  assert.equal(rulerLength(S), 1500);
});

test('rulerCorners at 0° lie on the axis-aligned rectangle', () => {
  const c = rulerCorners(R0, S);
  assert.equal(c.length, 4);
  nearPt(c[0], { x: 250, y: 465 });     // oben links
  nearPt(c[1], { x: 1750, y: 465 });    // oben rechts
  nearPt(c[2], { x: 1750, y: 535 });    // unten rechts
  nearPt(c[3], { x: 250, y: 535 });     // unten links
});

test('rulerCorners at 90° (clockwise on screen)', () => {
  const c = rulerCorners({ x: 0, y: 0, angle: 90 }, S);
  nearPt(c[0], { x: 35, y: -750 });
  nearPt(c[1], { x: 35, y: 750 });
  nearPt(c[2], { x: -35, y: 750 });
  nearPt(c[3], { x: -35, y: -750 });
});

test('hitRuler: inside, beyond the ends, beyond the edges', () => {
  assert.equal(hitRuler(R0, S, { x: 1000, y: 500 }), true);
  assert.equal(hitRuler(R0, S, { x: 1700, y: 500 }), true);
  assert.equal(hitRuler(R0, S, { x: 1760, y: 500 }), false);   // hinter dem rechten Ende
  assert.equal(hitRuler(R0, S, { x: 1000, y: 534 }), true);
  assert.equal(hitRuler(R0, S, { x: 1000, y: 536 }), false);
});

test('hitRuler follows the rotation', () => {
  const s = { x: 0, y: 0, angle: 45 };
  const d = (r) => ({ x: r * Math.SQRT1_2, y: r * Math.SQRT1_2 });
  assert.equal(hitRuler(s, S, d(700)), true);
  assert.equal(hitRuler(s, S, d(800)), false);
});

test('grip: center near the right end, radius 22 px', () => {
  nearPt(gripCenter(R0, S), { x: 1714, y: 500 });
  assert.equal(hitGrip(R0, S, { x: 1714, y: 500 }), true);
  assert.equal(hitGrip(R0, S, { x: 1714, y: 521 }), true);
  assert.equal(hitGrip(R0, S, { x: 1714, y: 523 }), false);
  assert.equal(hitGrip(R0, S, { x: 1000, y: 500 }), false);
});

test('edgeAt: outside above = 0, outside below = 1, inside or far = null', () => {
  assert.equal(edgeAt(R0, S, { x: 1000, y: 490 }), null);      // innen
  assert.equal(edgeAt(R0, S, { x: 1000, y: 465 }), 0);         // auf der oberen Kante
  assert.equal(edgeAt(R0, S, { x: 1000, y: 460 }), 0);         // 5 px außerhalb, oben
  assert.equal(edgeAt(R0, S, { x: 1000, y: 445 }), 0);         // 20 px, noch im Radius
  assert.equal(edgeAt(R0, S, { x: 1000, y: 440 }), null);      // 25 px, zu weit
  assert.equal(edgeAt(R0, S, { x: 1000, y: 540 }), 1);         // 5 px außerhalb, unten
  assert.equal(edgeAt(R0, S, { x: 1000, y: 530 }), null);      // innen unten
});

test('edgeAt: beyond the ends uses distance to the segment end', () => {
  assert.equal(edgeAt(R0, S, { x: 1760, y: 460 }), 0);         // ~11 px vom Ende
  assert.equal(edgeAt(R0, S, { x: 1770, y: 465 }), 0);         // 20 px
  assert.equal(edgeAt(R0, S, { x: 1780, y: 465 }), null);      // 30 px
});

test('edgeAt honours maxDist', () => {
  assert.equal(edgeAt(R0, S, { x: 1000, y: 445 }, 10), null);  // 20 px > 10
  assert.equal(edgeAt(R0, S, { x: 1000, y: 455 }, 10), 0);     // 10 px
});

test('projectToEdge: projects onto the line 1.5 px outside the edge, keeps the position along it', () => {
  nearPt(projectToEdge(R0, { x: 1200, y: 400 }, 0), { x: 1200, y: 463.5 });
  nearPt(projectToEdge(R0, { x: 1200, y: 600 }, 1), { x: 1200, y: 536.5 });
  // unbegrenzt entlang der Geraden: auch hinter dem Lineal
  nearPt(projectToEdge(R0, { x: 2500, y: 470 }, 0), { x: 2500, y: 463.5 });
});

test('projectToEdge at 90°', () => {
  nearPt(projectToEdge({ x: 0, y: 0, angle: 90 }, { x: 50, y: 200 }, 0), { x: 36.5, y: 200 });
});

test('twist: pure translation of the two-finger midpoint', () => {
  const t = twist({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 20 }, { x: 110, y: 20 });
  near(t.dx, 10); near(t.dy, 20); near(t.dAngle, 0);
});

test('twist: 90° rotation', () => {
  const t = twist({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 });
  near(t.dAngle, 90);
  near(t.dx, -50); near(t.dy, 50);       // Mittelpunkt wandert von (50, 0) nach (0, 50)
});

test('twist: wraps around ±180°', () => {
  const r = (deg) => ({ x: 100 * Math.cos((deg * Math.PI) / 180), y: 100 * Math.sin((deg * Math.PI) / 180) });
  const t = twist({ x: 0, y: 0 }, r(170), { x: 0, y: 0 }, r(190));
  near(t.dAngle, 20, 1e-6);
});

test('twist: identical fingers give no rotation', () => {
  const t = twist({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 9, y: 9 });
  assert.equal(t.dAngle, 0);
});

test('snapAngle: snaps to 45° multiples within 2°, normalises to (-180, 180]', () => {
  assert.equal(snapAngle(44), 45);
  assert.equal(snapAngle(43), 45);
  assert.equal(snapAngle(42), 42);        // 3° entfernt, kein Einrasten
  assert.equal(snapAngle(-89), -90);
  assert.equal(snapAngle(0), 0);
  assert.equal(snapAngle(22.5), 22.5);
  assert.equal(snapAngle(181), 180);      // -179° → nahe -180° = 180°
  assert.equal(snapAngle(360 + 1), 0);
});

test('normDeg maps to (-180, 180]', () => {
  assert.equal(normDeg(190), -170);
  assert.equal(normDeg(-180), 180);
  assert.equal(normDeg(180), 180);
  assert.equal(normDeg(360), 0);
  assert.equal(normDeg(-540), 180);
});

test('ticks: 1 mm ticks included at pxPerMm >= 2 (301 entries for 300 mm)', () => {
  const t = ticks(5, RULER_MM);
  assert.equal(t.length, 301);
  assert.equal(t.filter((x) => x.len === 'cm').length, 31);
  assert.equal(t.filter((x) => x.len === 'half').length, 30);
  assert.equal(t.filter((x) => x.len === 'mm').length, 240);
});

test('ticks: cm labels run from 0 to 30, first and last entries', () => {
  const t = ticks(5, RULER_MM);
  const labels = t.filter((x) => x.len === 'cm').map((x) => x.label);
  assert.equal(labels[0], '0');
  assert.equal(labels[labels.length - 1], '30');
  assert.equal(labels[5], '5');
  assert.deepEqual(t[0], { mm: 0, len: 'cm', label: '0' });
  const half = t.find((x) => x.mm === 5);
  assert.equal(half.len, 'half');
  assert.equal(half.label, undefined);
});

test('ticks: no 1 mm ticks below 2 px per mm', () => {
  const t = ticks(1.5, RULER_MM);
  assert.equal(t.length, 61);
  assert.equal(t.some((x) => x.len === 'mm'), false);
  assert.equal(t.filter((x) => x.len === 'cm').length, 31);
  assert.equal(t.filter((x) => x.len === 'half').length, 30);
});

import { measureLine } from '../../js/ui/ruler-geom.js';
test('measureLine: Länge in cm mit Komma, Winkel zur Waagerechten', () => {
  assert.equal(measureLine({ x: 0, y: 0 }, { x: 50, y: 0 }, 5), '1,0 cm');
  assert.equal(measureLine({ x: 0, y: 0 }, { x: 0, y: -100 }, 5), '2,0 cm · 90°');
  assert.equal(measureLine({ x: 0, y: 0 }, { x: 30, y: -30 }, 1), '4,2 cm · 45°');
  assert.equal(measureLine({ x: 0, y: 0 }, { x: -30, y: -30 }, 1), '4,2 cm · 135°');
});

import { setRulerMm, rulerLength as rLen, ticks as rTicks } from '../../js/ui/ruler-geom.js';
test('setRulerMm: 15/20/30 cm, sonst 30 cm; Länge und Skala folgen', () => {
  assert.equal(setRulerMm(150), 150);
  assert.equal(rLen(2), 300);
  assert.equal(setRulerMm(123), 300);
  assert.equal(setRulerMm(200), 200);
  assert.equal(rLen(1), 200);
  setRulerMm(300);
  assert.equal(rTicks(3, 150).filter((t) => t.label !== undefined).length, 16);
});
