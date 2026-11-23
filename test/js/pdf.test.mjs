// node --test test/js/  (PDF-Writer ohne DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildPdf, notePdf } from '../../js/export/pdf.js';
import { encodeStrokes, decodeStrokes } from '../../js/ink/codec.js';

const TITLE = 'Übung Größe ÄÖÜ ß 𝄞';

const stroke = (id, type, color, width, pts) => ({ id, type, color, width, pts: Int32Array.from(pts) });
const penA = stroke('pen00001', 'p', 2, 1, [100, 100, 200, 300, 150, 220, 500, 120, 255, 600, 300, 128]);
const hlA = stroke('hl000001', 'h', 0, 0, [200, 400, 128, 900, 420, 128]);
const penB = stroke('pen00002', 'p', 3, 2, [500, 500, 200, 900, 700, 200, 1200, 500, 200]);
const hlB = stroke('hl000002', 'h', 2, 0, [100, 100, 128]); // einzelner Punkt

const PAGES = [
  { paper: 'lined', orient: 'p', strokes: encodeStrokes([penA, hlA]) },
  { paper: 'dotted', orient: 'l', strokes: decodeStrokes(encodeStrokes([penB, hlB])) },
];

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

/** Byte offsets of all objects from the xref table; checks the table itself. Returns offsets[] (index = object number). */
function checkXref(bytes) {
  const s = latin1(bytes);
  const sx = s.lastIndexOf('startxref\n');
  assert.ok(sx > 0, 'startxref fehlt');
  const xrefPos = Number(s.slice(sx + 'startxref\n'.length).split('\n')[0]);
  assert.equal(s.slice(xrefPos, xrefPos + 4), 'xref', 'startxref zeigt nicht auf "xref"');
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefPos));
  assert.ok(head, 'xref-Kopf fehlt');
  const count = Number(head[1]);
  const start = xrefPos + head[0].length;
  assert.equal(s.indexOf('trailer', start), start + 20 * count, 'xref-Tabelle hat falsche Länge');
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const entry = s.substr(start + 20 * i, 20);
    assert.match(entry, /^\d{10} \d{5} [nf]\r\n$/, `xref-Eintrag ${i}`);
    if (i === 0) { assert.equal(entry, '0000000000 65535 f\r\n'); continue; }
    const off = Number(entry.slice(0, 10));
    assert.equal(s.slice(off, off + `${i} 0 obj`.length), `${i} 0 obj`, `xref-Eintrag ${i} zeigt ins Leere`);
    offsets[i] = off;
  }
  return offsets;
}

/** Decoded (if needed) stream bytes of object n. */
function streamOf(bytes, offsets, n) {
  const s = latin1(bytes);
  const dictStart = offsets[n];
  const dataStart = s.indexOf('stream\n', dictStart) + 'stream\n'.length;
  const dict = s.slice(dictStart, dataStart);
  const dataEnd = s.indexOf('\nendstream', dataStart);
  const raw = Buffer.from(bytes.subarray(dataStart, dataEnd));
  return { dict, data: dict.includes('/FlateDecode') ? inflateSync(raw).toString('latin1') : raw.toString('latin1') };
}

function hasTool(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
const HAS_QPDF = hasTool('qpdf', ['--version']);
const HAS_PDFTOTEXT = hasTool('pdftotext', ['-v']);

test('buildPdf: Grundstruktur, Seitengrößen, Anzahl, Titel', () => {
  const bytes = buildPdf(PAGES, { title: TITLE });
  const s = latin1(bytes);
  assert.ok(s.startsWith('%PDF-1.4\n'), 'Header');
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'Ende %%EOF');
  assert.match(s, /\/Type \/Pages \/Kids \[5 0 R 7 0 R\] \/Count 2 /);
  // Hochformat 210 × 297 mm, Querformat umgekehrt (0,1 mm → pt: × 72/254)
  const boxes = [...s.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(boxes, [['595.28', '841.89'], ['841.89', '595.28']]);
  // Titel als UTF-16BE mit BOM, Umlaute und Surrogate-Paar bleiben erhalten
  const m = /\/Title <([0-9A-F]+)>/.exec(s);
  assert.ok(m, 'Title fehlt');
  assert.ok(m[1].startsWith('FEFF'), 'BOM fehlt');
  const units = [];
  for (let i = 4; i < m[1].length; i += 4) units.push(parseInt(m[1].slice(i, i + 4), 16));
  assert.equal(String.fromCharCode(...units), TITLE);
  assert.match(s, /\/Producer \(Notizen\)/);
  assert.match(s, /\/Root 1 0 R \/Info 3 0 R/);
});

test('buildPdf: xref-Tabelle zeigt auf die richtigen Objekte', () => {
  const bytes = buildPdf(PAGES, { title: TITLE });
  const offsets = checkXref(bytes);
  assert.equal(offsets.length - 1, 8, '4 Basisobjekte + 2 × (Page + Content)');
});

test('buildPdf: Inhalt unkomprimiert, Striche und Papier vorhanden, Zahlen ohne Exponent', () => {
  const bytes = buildPdf(PAGES, { title: TITLE });
  const offsets = checkXref(bytes);
  const s1 = streamOf(bytes, offsets, 6);
  const s2 = streamOf(bytes, offsets, 8);
  assert.ok(!s1.dict.includes('FlateDecode'), 'buildPdf bleibt unkomprimiert');
  // Seite 1: liniert (Linien + Rand), Stift, Textmarker
  assert.match(s1.data, /0\.35 w/);
  assert.match(s1.data, /1 J 1 j/);
  assert.match(s1.data, /\/GS1 gs/);
  // Seite 2: gepunktet (Kreise als Bezier), Stift, Textmarker mit Einzelpunkt
  assert.match(s2.data, / c h/);
  assert.match(s2.data, /\/GS1 gs/);
  for (const d of [s1.data, s2.data]) {
    assert.doesNotMatch(d, /\d[eE][+-]?\d/, 'Exponentschreibweise');
    for (const line of d.split('\n')) {
      if (/(rg|RG)$/.test(line)) continue; // Farben: 3 Nachkommastellen
      assert.doesNotMatch(line, /\d\.\d{3}/, `zu viele Nachkommastellen: ${line}`);
    }
  }
  // Reihenfolge: Papier, Textmarker, Stifte
  assert.ok(s1.data.indexOf('/GS1 gs') < s1.data.indexOf('\nf'), 'Textmarker vor den Stiften');
  assert.ok(s1.data.indexOf('0.35 w') < s1.data.indexOf('/GS1 gs'), 'Papier vor den Textmarkern');
});

test('buildPdf: Seite mit strokes === null ist leeres Papier', () => {
  const bytes = buildPdf([{ paper: 'grid', orient: 'p', strokes: null }], { title: 'leer' });
  const offsets = checkXref(bytes);
  const c = streamOf(bytes, offsets, 6).data;
  assert.match(c, /\nS\n|S$/);
  assert.doesNotMatch(c, /\bf\b/);
  assert.doesNotMatch(c, /\/GS1 gs/);
});

test('notePdf: Blob application/pdf, komprimierte Seiten ergeben denselben Inhalt', async () => {
  const blob = await notePdf({ title: TITLE }, PAGES);
  assert.equal(blob.type, 'application/pdf');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const s = latin1(bytes);
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const offsets = checkXref(bytes);
  const plain = checkXref(buildPdf(PAGES, { title: TITLE }));
  assert.equal(offsets.length, plain.length);
  if (typeof CompressionStream === 'function') {
    assert.match(streamOf(bytes, offsets, 6).dict, /\/FlateDecode/);
  }
  const packed = streamOf(bytes, offsets, 6).data;
  const unpacked = streamOf(buildPdf(PAGES, { title: TITLE }), plain, 6).data;
  assert.equal(packed, unpacked);
});

test('notePdf: leere Seitenliste ergibt eine Papierseite', async () => {
  const blob = await notePdf({ title: 'x' }, []);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.match(latin1(bytes), /\/Count 1 /);
});

const withTempPdf = (bytes, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'notizen-pdf-'));
  const file = join(dir, 'test.pdf');
  try {
    writeFileSync(file, bytes);
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('PDF ist mit qpdf gültig', { skip: !HAS_QPDF && 'qpdf nicht installiert' }, () => {
  withTempPdf(buildPdf(PAGES, { title: TITLE }), (file) => {
    const r = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

test('PDF lässt sich mit pdftotext öffnen', { skip: !HAS_PDFTOTEXT && 'pdftotext nicht installiert' }, () => {
  withTempPdf(buildPdf(PAGES, { title: TITLE }), (file) => {
    const r = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});
