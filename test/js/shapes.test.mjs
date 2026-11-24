// node --test test/js/  (Formenerkennung, ARCHITEKTUR 11.4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape } from '../../js/ink/shapes.js';

// Deterministic pseudo-random noise, so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Samples fn(t) for t in [0, 1] into Int32Array x,y,p with optional noise (±amp) and pressure.
function sample(fn, n, { amp = 0, p = 128, seed = 7, pFn = null } = {}) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = fn(i / (n - 1));
    const jx = (rand() * 2 - 1) * amp, jy = (rand() * 2 - 1) * amp;
    out.push(Math.round(x + jx), Math.round(y + jy), pFn ? pFn(i) : p);
  }
  return Int32Array.from(out);
}

const xy = (pts, i) => [pts[3 * i], pts[3 * i + 1]];
const count = (pts) => pts.length / 3;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Shoelace sign of a point list (positive = clockwise on screen, y points down).
function area2(pts) {
  let s = 0;
  const n = count(pts);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[3 * i] * pts[3 * j + 1] - pts[3 * j] * pts[3 * i + 1];
  }
  return s;
}

// Output of every recognized shape: integer, dense (≤ 20 units), and closed exactly for closed kinds.
function assertDenseOutput(res) {
  assert.ok(res.pts instanceof Int32Array);
  assert.equal(res.pts.length % 3, 0);
  const n = count(res.pts);
  for (let i = 0; i < res.pts.length; i++) assert.ok(Number.isInteger(res.pts[i]));
  for (let i = 1; i < n; i++) {
    assert.ok(dist(xy(res.pts, i - 1), xy(res.pts, i)) <= 20, `Abstand Punkt ${i - 1}→${i} zu groß`);
  }
  const closed = res.kind !== 'line';
  const first = xy(res.pts, 0), last = xy(res.pts, n - 1);
  if (closed) assert.deepEqual(last, first, 'geschlossene Form endet am Startpunkt');
  else assert.ok(dist(first, last) > 20, 'Linie ist offen');
}

test('Linie: gezittert (±3) → line, Endpunkte nah am Original', () => {
  const pts = sample((t) => [100 + 400 * t, 200 + 60 * t], 60, { amp: 3, seed: 3 });
  const res = recognizeShape(pts);
  assert.ok(res, 'erkannt');
  assert.equal(res.kind, 'line');
  assert.ok(dist(xy(res.pts, 0), [100, 200]) <= 6, 'Startpunkt nah am Original');
  assert.ok(dist(xy(res.pts, count(res.pts) - 1), [500, 260]) <= 6, 'Endpunkt nah am Original');
  assertDenseOutput(res);
});

test('Linie: 2° schräg rastet waagerecht ein', () => {
  const a = (2 * Math.PI) / 180;
  const pts = sample((t) => [100 + 500 * t * Math.cos(a), 300 + 500 * t * Math.sin(a)], 60);
  const res = recognizeShape(pts);
  assert.equal(res.kind, 'line');
  const n = count(res.pts);
  const y0 = res.pts[1];
  for (let i = 0; i < n; i++) assert.equal(res.pts[3 * i + 1], y0, 'alle Punkte auf einer Höhe');
  assertDenseOutput(res);
});

test('Linie: 2° schräg zur Senkrechten rastet senkrecht ein', () => {
  const a = (2 * Math.PI) / 180;
  const pts = sample((t) => [300 + 400 * t * Math.sin(a), 100 + 400 * t * Math.cos(a)], 60);
  const res = recognizeShape(pts);
  assert.equal(res.kind, 'line');
  const x0 = res.pts[0];
  for (let i = 0; i < count(res.pts); i++) assert.equal(res.pts[3 * i], x0, 'alle Punkte auf einer Spalte');
});

test('Kreis mit Rauschen → circle, Radius ±5 %', () => {
  const R = 150;
  const pts = sample((t) => [400 + R * Math.cos(2 * Math.PI * t), 400 + R * Math.sin(2 * Math.PI * t)], 120, { amp: 3, seed: 11 });
  const res = recognizeShape(pts);
  assert.ok(res, 'erkannt');
  assert.equal(res.kind, 'circle');
  const n = count(res.pts) - 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = xy(res.pts, i);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const c = [(minX + maxX) / 2, (minY + maxY) / 2];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += dist(xy(res.pts, i), c);
  const meanR = sum / n;
  assert.ok(Math.abs(meanR - R) <= 0.05 * R, `Radius ${meanR.toFixed(1)} nicht ±5 % von ${R}`);
  assert.ok(Math.abs(c[0] - 400) <= 5 && Math.abs(c[1] - 400) <= 5, 'Mittelpunkt bleibt');
  assertDenseOutput(res);
});

test('Kreis gegen den Uhrzeigersinn: Drehrichtung wie gezeichnet, beginnt beim Winkel des ersten Punkts', () => {
  const R = 150;
  const ccw = sample((t) => [400 + R * Math.cos(-2 * Math.PI * t), 400 + R * Math.sin(-2 * Math.PI * t)], 120);
  const res = recognizeShape(ccw);
  assert.equal(res.kind, 'circle');
  assert.ok(area2(res.pts) < 0, 'gleiche Umlaufrichtung (gegen den Uhrzeigersinn)');
  // First input point is at angle 0 (right of center); the output starts there too.
  assert.ok(dist(xy(res.pts, 0), xy(ccw, 0)) <= 6, 'Startpunkt beim Winkel des ersten Eingabepunkts');
});

test('Ellipse 2:1 → ellipse', () => {
  const pts = sample((t) => [400 + 300 * Math.cos(2 * Math.PI * t), 400 + 150 * Math.sin(2 * Math.PI * t)], 120, { amp: 3, seed: 5 });
  const res = recognizeShape(pts);
  assert.ok(res, 'erkannt');
  assert.equal(res.kind, 'ellipse');
  const n = count(res.pts);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, res.pts[3 * i]); maxX = Math.max(maxX, res.pts[3 * i]); }
  assert.ok(Math.abs((maxX - minX) / 2 - 300) <= 0.05 * 300, 'rx bleibt');
  assertDenseOutput(res);
});

test('Rechteck mit Rauschen → rect, 4 Ecken an der bbox', () => {
  const corners = [[100, 100], [400, 100], [400, 300], [100, 300], [100, 100]];
  const rand = rng(21);
  const pts = [];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 20; i++) {
      const [ax, ay] = corners[s], [bx, by] = corners[s + 1];
      const t = i / 20;
      pts.push(Math.round(ax + (bx - ax) * t + (rand() * 2 - 1) * 3), Math.round(ay + (by - ay) * t + (rand() * 2 - 1) * 3), 128);
    }
  }
  pts.push(100, 100, 128);
  const res = recognizeShape(Int32Array.from(pts));
  assert.ok(res, 'erkannt');
  assert.equal(res.kind, 'rect');
  const out = res.pts;
  const want = [[100, 100], [400, 100], [400, 300], [100, 300]];
  for (const w of want) {
    let best = Infinity;
    for (let i = 0; i < count(out); i++) best = Math.min(best, dist(xy(out, i), w));
    assert.ok(best <= 6, `Ecke ${w} fehlt (Abstand ${best.toFixed(1)})`);
  }
  assertDenseOutput(res);
});

test('Rechteck gegen den Uhrzeigersinn: Start an der nächsten Ecke, gleiche Umlaufrichtung', () => {
  // Start at bottom-left, go right, up, left, down: counter-clockwise on screen (y points down).
  const corners = [[100, 300], [400, 300], [400, 100], [100, 100], [100, 300]];
  const pts = [];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 20; i++) {
      const [ax, ay] = corners[s], [bx, by] = corners[s + 1];
      pts.push(Math.round(ax + (bx - ax) * (i / 20)), Math.round(ay + (by - ay) * (i / 20)), 128);
    }
  }
  pts.push(100, 300, 128);
  const res = recognizeShape(Int32Array.from(pts));
  assert.equal(res.kind, 'rect');
  assert.deepEqual(xy(res.pts, 0), [100, 300], 'Start an der Ecke nahe dem ersten Punkt');
  assert.ok(area2(res.pts) < 0, 'gleiche Umlaufrichtung wie gezeichnet');
  assertDenseOutput(res);
});

test('Handschrift: „e“ (Balken plus offene Schleife) → null', () => {
  const pts = sample((t) => {
    if (t < 0.25) return [400 * (t / 0.25), 200];
    const a = -((t - 0.25) / 0.75) * 5.2;
    return [200 + 150 * Math.cos(a), 200 + 150 * Math.sin(a)];
  }, 150, { amp: 2 });
  assert.equal(recognizeShape(pts), null);
});

test('Handschrift: Zickzack → null', () => {
  const pts = sample((t) => [100 + 400 * t, 200 + 80 * (Math.floor(t * 8) % 2)], 80);
  assert.equal(recognizeShape(pts), null);
});

test('Handschrift: geschlossene Wackelschleife → null', () => {
  const pts = sample((t) => {
    const a = 2 * Math.PI * t;
    const r = 150 + 60 * Math.sin(3 * a);
    return [400 + r * Math.cos(a), 400 + r * Math.sin(a)];
  }, 150);
  assert.equal(recognizeShape(pts), null);
});

test('offener Bogen (Halbkreis) → null', () => {
  const pts = sample((t) => [400 + 150 * Math.cos(Math.PI * t), 400 - 150 * Math.sin(Math.PI * t)], 60);
  assert.equal(recognizeShape(pts), null);
});

test('zu kurz oder zu wenige Punkte → null', () => {
  const few = Int32Array.from([0, 0, 128, 100, 0, 128, 200, 0, 128, 300, 0, 128, 400, 0, 128]);
  assert.equal(recognizeShape(few), null, 'weniger als 6 Punkte');
  const short = sample((t) => [60 * t, 0], 6);
  assert.equal(recognizeShape(short), null, 'Gesamtlänge unter 80');
  assert.equal(recognizeShape(new Int32Array(0)), null);
});

test('Ausgabe: dicht, ganzzahlig, geschlossen (Linie, Kreis, Ellipse, Rechteck)', () => {
  const line = recognizeShape(sample((t) => [50 + 600 * t, 50 + 300 * t], 25, { amp: 2 }));
  const circle = recognizeShape(sample((t) => [300 + 200 * Math.cos(2 * Math.PI * t), 300 + 200 * Math.sin(2 * Math.PI * t)], 150, { amp: 2 }));
  const ellipse = recognizeShape(sample((t) => [300 + 300 * Math.cos(2 * Math.PI * t), 300 + 150 * Math.sin(2 * Math.PI * t)], 150, { amp: 2 }));
  const rect = recognizeShape(Int32Array.from([50, 50, 128, 500, 50, 128, 500, 300, 128, 50, 300, 128, 50, 50, 128, 200, 50, 128, 350, 50, 128, 500, 50, 128, 500, 150, 128, 500, 300, 128, 400, 300, 128, 200, 300, 128, 50, 300, 128, 50, 200, 128, 50, 50, 128]));
  for (const r of [line, circle, ellipse, rect]) {
    assert.ok(r, 'erkannt');
    assertDenseOutput(r);
  }
  assert.equal(rect.kind, 'rect');
});

test('Druck: Ausgabe trägt den gerundeten Mittelwert der Eingabedrücke', () => {
  const flat = recognizeShape(sample((t) => [100 + 400 * t, 100], 40, { p: 200 }));
  assert.equal(flat.kind, 'line');
  for (let i = 0; i < count(flat.pts); i++) assert.equal(flat.pts[3 * i + 2], 200);

  const mixed = sample((t) => [400 + 150 * Math.cos(2 * Math.PI * t), 400 + 150 * Math.sin(2 * Math.PI * t)], 100, { pFn: (i) => 100 + (i % 3) * 50 });
  let sum = 0;
  for (let i = 0; i < count(mixed); i++) sum += mixed[3 * i + 2];
  const want = Math.round(sum / count(mixed));
  const res = recognizeShape(mixed);
  assert.equal(res.kind, 'circle');
  for (let i = 0; i < count(res.pts); i++) assert.equal(res.pts[3 * i + 2], want);
});

test('Laufzeit: 500 Punkte grob unter 5 ms je Aufruf', () => {
  const pts = sample((t) => [400 + 150 * Math.cos(2 * Math.PI * t), 400 + 150 * Math.sin(2 * Math.PI * t)], 500, { amp: 3 });
  for (let i = 0; i < 5; i++) recognizeShape(pts); // warm-up
  const runs = 30;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) recognizeShape(pts);
  const per = (performance.now() - t0) / runs;
  assert.ok(per < 5, `${per.toFixed(2)} ms je Aufruf`);
});
