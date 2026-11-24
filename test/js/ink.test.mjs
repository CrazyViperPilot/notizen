// node --test test/js/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeStrokes, decodeStrokes, strokeId } from '../../js/ink/codec.js';
import { Smoother, smoothPoints, penShapes, penRadius, hitTest, hitTestSegment, bbox, normPressure } from '../../js/ink/stroke.js';
import { paperGeometry } from '../../js/ink/paper.js';
import { PAGE, PAPER_STYLE } from '../../js/config.js';

const line = (x0, y0, x1, y1, n = 10, p = 128) => {
  const a = [];
  for (let i = 0; i < n; i++) a.push(x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1), p);
  return Int32Array.from(a.map(Math.round));
};

test('codec: round trip keeps points, type, color, width', () => {
  const s = [
    { id: 'abc12345', type: 'p', color: 2, width: 0, pts: Int32Array.from([100, 200, 50, 103, 210, 60, 90, 190, 255]) },
    { id: 'hl000001', type: 'h', color: 1, width: 2, pts: Int32Array.from([5, 5, 128]) },
  ];
  const str = encodeStrokes(s);
  assert.match(str, /"p":\[100,200,50,3,10,10,-13,-20,195\]/);
  const back = decodeStrokes(str);
  assert.equal(back.length, 2);
  assert.deepEqual(Array.from(back[0].pts), Array.from(s[0].pts));
  assert.equal(back[0].color, 2);
  assert.equal(back[1].type, 'h');
  assert.equal(back[1].width, 0);
});

test('codec: tolerant to garbage', () => {
  assert.deepEqual(decodeStrokes('kaputt'), []);
  assert.deepEqual(decodeStrokes(''), []);
  assert.deepEqual(decodeStrokes('{"a":1}'), []);
  const r = decodeStrokes('[null, {"p":[1,2]}, {"p":[1,2,3,"x",0,0]}, {"t":"p","p":[1,2,3]}]');
  assert.equal(r.length, 1);
  assert.equal(r[0].id.length, 8);
});

test('codec: ids are 8 chars', () => {
  assert.match(strokeId(), /^[a-z0-9]{8}$/);
});

test('smoother: drops tiny moves, ends at the pen-up point', () => {
  const s = new Smoother();
  s.push(0, 0, 0.5);
  s.push(1, 0, 0.5);           // < 0.3 mm → dropped
  for (let x = 10; x <= 100; x += 10) s.push(x, 0, 0.5);
  s.finish(100, 0, 0.5);
  const p = s.points();
  assert.equal(p[0], 0);
  assert.equal(p[p.length - 3], 100);
  for (let i = 3; i < p.length; i += 3) assert.ok(p[i] - p[i - 3] >= 3);
});

test('smoothPoints: same result as streaming', () => {
  const raw = [];
  for (let i = 0; i < 50; i++) raw.push({ x: i * 7, y: Math.sin(i / 5) * 40, p: 0.4 });
  const a = smoothPoints(raw);
  const s = new Smoother();
  raw.forEach((r) => s.push(r.x, r.y, r.p));
  s.finish(raw[49].x, raw[49].y, raw[49].p);
  assert.deepEqual(Array.from(a), Array.from(s.points()));
});

test('pressure: mouse/finger = 0.5, pen passes through', () => {
  assert.equal(normPressure(0, 'pen'), 0.5);
  assert.equal(normPressure(0.3, 'pen'), 0.3);
  assert.equal(normPressure(1, 'mouse'), 0.5);
});

test('penShapes: straight line has only end circles, one quad per segment', () => {
  const st = { type: 'p', width: 1, pts: line(0, 0, 900, 0, 10) };
  const { circles, quads } = penShapes(st);
  assert.equal(circles.length / 3, 2);
  assert.equal(quads.length / 8, 9);
  const r = penRadius(1, 128);
  assert.ok(Math.abs(quads[1] - r) < 1e-6 || Math.abs(quads[1] + r) < 1e-6);
});

test('penShapes: corner gets a joint circle', () => {
  const st = { type: 'p', width: 1, pts: Int32Array.from([0, 0, 128, 100, 0, 128, 100, 100, 128]) };
  assert.equal(penShapes(st).circles.length / 3, 3);
});

test('penRadius grows with pressure, bounded', () => {
  assert.ok(penRadius(1, 255) > penRadius(1, 50));
  assert.ok(penRadius(1, 1) > 0);
  assert.ok(penRadius(2, 128) > penRadius(0, 128));
});

test('hitTest and bbox', () => {
  const st = { type: 'p', width: 1, pts: line(100, 100, 500, 100, 5) };
  assert.ok(hitTest(st, 300, 105, 2));
  assert.ok(!hitTest(st, 300, 160, 10));
  assert.ok(hitTest(st, 300, 160, 60));
  const b = bbox(st);
  assert.ok(b[0] < 100 && b[2] > 500 && b[1] < 100 && b[3] > 100);
  // Fast eraser movement across the line between two samples.
  assert.ok(hitTestSegment(st, 300, 0, 300, 300, 5));
  assert.ok(!hitTestSegment(st, 600, 0, 600, 300, 5));
});

test('paper geometry', () => {
  const lined = paperGeometry('lined', 'p');
  assert.ok(lined.margin);
  assert.equal(lined.lines[1], PAPER_STYLE.linedTop);
  assert.equal(lined.lines[5] - lined.lines[1], PAPER_STYLE.lined);
  const grid = paperGeometry('grid', 'l');
  assert.ok(grid.lines.length / 4 > (PAGE.l.w / 50) + (PAGE.l.h / 50) - 2);
  const dots = paperGeometry('dotted', 'p');
  assert.ok(dots.dots.length / 2 > 2000);
  for (let i = 0; i < dots.dots.length; i += 2) {
    assert.ok(dots.dots[i] > 0 && dots.dots[i] < PAGE.p.w && dots.dots[i + 1] > 0 && dots.dots[i + 1] < PAGE.p.h);
  }
  const blank = paperGeometry('blank', 'p');
  assert.equal(blank.lines.length + blank.dots.length, 0);
});

test('codec: custom hex colors survive, invalid ones fall back', () => {
  const s = [{ id: 'cust0001', type: 'p', color: '#A1B2C3', width: 1, pts: Int32Array.from([1, 2, 3]) }];
  const back = decodeStrokes(encodeStrokes(s));
  assert.equal(back[0].color, '#a1b2c3');
  assert.equal(decodeStrokes('[{"c":"red","p":[1,2,3]}]')[0].color, 0);
  assert.equal(decodeStrokes('[{"c":"#12345","p":[1,2,3]}]')[0].color, 0);
});

test('stylus eraser end / side button erase, Apple Pencil and fingers do not', async () => {
  globalThis.window ??= {}; // surface.js only needs DOM when a surface is created
  const { penEraser } = await import('../../js/ink/surface.js');
  assert.equal(penEraser({ pointerType: 'pen', buttons: 1, button: 0 }), false);
  assert.equal(penEraser({ pointerType: 'pen', buttons: 3, button: 0 }), true);   // side button held
  assert.equal(penEraser({ pointerType: 'pen', buttons: 2, button: 2 }), true);
  assert.equal(penEraser({ pointerType: 'pen', buttons: 32, button: 5 }), true);  // eraser end
  assert.equal(penEraser({ pointerType: 'touch', buttons: 2, button: 2 }), false);
  assert.equal(penEraser({ pointerType: 'mouse', buttons: 2, button: 2 }), false);
});

test('paper: vocab has lines, divider and tick column', () => {
  for (const o of ['p', 'l']) {
    const g = paperGeometry('vocab', o);
    const { w, h } = PAGE[o];
    assert.equal(g.margin.length, 8);
    assert.ok(g.margin[0] > w * 0.4 && g.margin[0] < w * 0.55, 'Trennlinie etwa mittig');
    assert.equal(g.margin[4], w - PAPER_STYLE.vocabCheck);
    assert.equal(g.margin[3], h);
    assert.ok(g.lines.length / 4 > 20);
  }
});
