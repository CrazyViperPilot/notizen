// node --test test/js/  (Präsentationsmodus, reine Hilfsfunktionen aus js/ui/present.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';

// present.js importiert fullscreen.js, das beim Laden `document` liest. In Node genügt dafür ein Stub.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { documentElement: {}, addEventListener() {}, removeEventListener() {} };
}
const { openPresentation, fitRect, fadeAlpha, nextIndex, swipeDir, tapZone } = await import('../../js/ui/present.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('openPresentation is exported and resolves at once without pages', async () => {
  assert.equal(typeof openPresentation, 'function');
  await openPresentation({ title: 'leer', pages: [] });
  await openPresentation({});
});

test('fitRect: landscape page centered in a square box', () => {
  // 2970 × 2100 (quer A4) in 1000 × 1000: Breite füllt, Höhe zentriert
  const r = fitRect(2970, 2100, 1000, 1000, 0);
  near(r.w, 1000);
  near(r.h, 2100 * 1000 / 2970);
  near(r.x, 0);
  near(r.y, (1000 - r.h) / 2);
});

test('fitRect: portrait page in a wide box is centered horizontally', () => {
  const r = fitRect(2100, 2970, 1000, 400, 0);
  near(r.h, 400);
  near(r.w, 2100 * 400 / 2970);
  near(r.x, (1000 - r.w) / 2);
  near(r.y, 0);
});

test('fitRect: padding shrinks the available area', () => {
  // Box 500 × 500, Rand 50 → 400 × 400 verfügbar, quadratische Seite 100 → Faktor 4
  const r = fitRect(100, 100, 500, 500, 50);
  near(r.w, 400);
  near(r.h, 400);
  near(r.x, 50);
  near(r.y, 50);
});

test('fitRect: result always fits inside the padded box', () => {
  const cases = [[2100, 2970], [2970, 2100], [4200, 2970], [1480, 2100]];
  for (const [pw, ph] of cases) {
    for (const [bw, bh] of [[800, 600], [390, 844], [1024, 1366], [300, 900]]) {
      const pad = 12;
      const r = fitRect(pw, ph, bw, bh, pad);
      assert.ok(r.w <= bw - 2 * pad + 1e-6, `w ${r.w} in ${bw}`);
      assert.ok(r.h <= bh - 2 * pad + 1e-6, `h ${r.h} in ${bh}`);
      near(r.w / r.h, pw / ph, 1e-9);
      near(r.x * 2 + r.w, bw, 1e-6);
      near(r.y * 2 + r.h, bh, 1e-6);
    }
  }
});

test('fitRect: degenerate page size does not produce NaN', () => {
  const r = fitRect(0, 0, 100, 100, 10);
  assert.deepEqual(r, { x: 10, y: 10, w: 80, h: 80 });
  const e = fitRect(100, 100, 5, 5, 10);
  assert.equal(e.w, 0);
  assert.equal(e.h, 0);
});

test('fadeAlpha: linear from 1 to 0 over the life time', () => {
  assert.equal(fadeAlpha(0), 1);
  near(fadeAlpha(400), 0.5);
  assert.equal(fadeAlpha(800), 0);
  assert.equal(fadeAlpha(1000), 0);
  assert.equal(fadeAlpha(-5), 1);
  near(fadeAlpha(50, 100), 0.5);
});

test('fadeAlpha: invalid input is invisible, result stays within 0..1', () => {
  assert.equal(fadeAlpha(NaN), 0);
  assert.equal(fadeAlpha(Infinity), 0);
  assert.equal(fadeAlpha(10, 0), 0);
  for (let age = 0; age <= 1200; age += 37) {
    const a = fadeAlpha(age);
    assert.ok(a >= 0 && a <= 1, `alpha ${a} at ${age}`);
  }
});

test('nextIndex: steps and clamps to the page range', () => {
  assert.equal(nextIndex(2, 1, 5), 3);
  assert.equal(nextIndex(2, -1, 5), 1);
  assert.equal(nextIndex(0, -1, 5), 0);
  assert.equal(nextIndex(4, 1, 5), 4);
  assert.equal(nextIndex(2, -2, 5), 0);
  assert.equal(nextIndex(2, 10, 5), 4);
  assert.equal(nextIndex(10, 0, 3), 2);
});

test('nextIndex: empty notebook stays at 0', () => {
  assert.equal(nextIndex(0, 1, 0), 0);
  assert.equal(nextIndex(0, -1, 0), 0);
});

test('swipeDir: horizontal swipes of at least 60 px', () => {
  assert.equal(swipeDir(80, 10), 1);
  assert.equal(swipeDir(-80, 5), -1);
  assert.equal(swipeDir(60, 0), 1);
  assert.equal(swipeDir(-60, 0), -1);
});

test('swipeDir: short, steep or empty moves are no swipe', () => {
  assert.equal(swipeDir(50, 0), 0);
  assert.equal(swipeDir(-59, 0), 0);
  assert.equal(swipeDir(60, 70), 0);
  assert.equal(swipeDir(-100, -100), 0);
  assert.equal(swipeDir(0, 0), 0);
  assert.equal(swipeDir(30, 0, 20), 1);
});

test('tapZone: left and right fifth navigate, middle does not', () => {
  assert.equal(tapZone(0, 1000), -1);
  assert.equal(tapZone(199, 1000), -1);
  assert.equal(tapZone(200, 1000), 0);
  assert.equal(tapZone(500, 1000), 0);
  assert.equal(tapZone(800, 1000), 0);
  assert.equal(tapZone(801, 1000), 1);
  assert.equal(tapZone(1000, 1000), 1);
  assert.equal(tapZone(500, 0), 0);
});
