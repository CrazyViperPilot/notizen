// node --test test/js/  (import helpers without DOM; the canvas and picker path is covered by the browser test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitSize, isPdfFile, pickAndImport, imageToJpeg } from '../../js/import/importer.js';

const root = new URL('../../', import.meta.url).pathname;

test('fitSize: longest side is limited, aspect ratio kept', () => {
  const r = fitSize(2480, 3508, 2400);
  assert.equal(r.h, 2400);
  assert.ok(Math.abs(r.w - (2480 * 2400) / 3508) <= 0.5, 'w = ' + r.w);
  const wide = fitSize(4000, 1000, 2400);
  assert.deepEqual(wide, { w: 2400, h: 600 });
});

test('fitSize: never enlarges', () => {
  assert.deepEqual(fitSize(800, 600, 2400), { w: 800, h: 600 });
  assert.deepEqual(fitSize(800, 600), { w: 800, h: 600 });
});

test('fitSize: degenerate sizes stay at least 1 px', () => {
  assert.deepEqual(fitSize(0, 0), { w: 1, h: 1 });
});

test('isPdfFile: by MIME type or extension', () => {
  assert.equal(isPdfFile({ type: 'application/pdf', name: 'x.bin' }), true);
  assert.equal(isPdfFile({ type: '', name: 'Scan.PDF' }), true);
  assert.equal(isPdfFile({ type: 'image/heic', name: 'IMG_0001.HEIC' }), false);
  assert.equal(isPdfFile({ name: 'ohne-typ' }), false);
});

test('exports: pickAndImport and imageToJpeg are functions', () => {
  assert.equal(typeof pickAndImport, 'function');
  assert.equal(typeof imageToJpeg, 'function');
});

test('pdf.js is vendored with its license (no npm dependency)', () => {
  for (const f of ['js/vendor/pdfjs/pdf.min.js', 'js/vendor/pdfjs/pdf.worker.min.js', 'js/vendor/pdfjs/LICENSE', 'js/vendor/pdfjs/README.md']) {
    assert.ok(existsSync(join(root, f)), 'fehlt: ' + f);
  }
  assert.match(readFileSync(join(root, 'js/vendor/pdfjs/LICENSE'), 'utf8'), /Apache License/);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies && pkg.dependencies['pdfjs-dist'], undefined);
});
