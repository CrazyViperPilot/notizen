// node --test test/js/  (PDF-Writer ohne DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildPdf, notePdf, jpegInfo } from '../../js/export/pdf.js';
import { encodeStrokes, decodeStrokes } from '../../js/ink/codec.js';
import { paperGeometry } from '../../js/ink/paper.js';

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

test('pdf: custom pen color is written as rgb', async () => {
  const { buildPdf } = await import('../../js/export/pdf.js');
  const strokes = JSON.stringify([{ i: 'x', t: 'p', c: '#ff8000', w: 1, p: [100, 100, 128, 50, 0, 0] }]);
  const pdf = new TextDecoder('latin1').decode(buildPdf([{ paper: 'blank', orient: 'p', strokes }], { title: 'Farbe' }));
  assert.ok(pdf.includes('1.000 0.502 0.000 rg'), 'Farbe #ff8000 im Content-Stream');
});

// ───────── Hintergrundbilder (ARCHITEKTUR 10.1) ─────────

// Echtes 1×1-Graustufen-JPEG
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const JPEG = new Uint8Array(Buffer.from(JPEG_B64, 'base64'));
const ASSET = 'a'.repeat(64);   // Asset-id (SHA-256-Form, für den PDF-Writer belanglos)
const ASSET2 = 'b'.repeat(64);

/** Minimaler JPEG-Kopf mit SOF0 (nur für jpegInfo und die PDF-Struktur, nicht dekodierbar). */
function fakeJpeg(w, h, comps) {
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * comps, 8, h >> 8, h & 255, w >> 8, w & 255, comps];
  for (let c = 1; c <= comps; c++) sof.push(c, 0x11, 0);
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, ...sof, 0xff, 0xd9]);
}

test('jpegInfo: Maße und Komponenten aus dem SOF-Segment, sonst null', () => {
  assert.deepEqual(jpegInfo(JPEG), { w: 1, h: 1, comps: 1 });
  assert.deepEqual(jpegInfo(fakeJpeg(640, 480, 3)), { w: 640, h: 480, comps: 3 });
  assert.deepEqual(jpegInfo(fakeJpeg(10, 20, 4)), { w: 10, h: 20, comps: 4 });
  assert.equal(jpegInfo(new Uint8Array([1, 2, 3, 4])), null, 'kein JPEG');
  assert.equal(jpegInfo(fakeJpeg(10, 20, 2)), null, 'Komponentenzahl 2 wird nicht unterstützt');
  assert.equal(jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null, 'SOS vor SOF');
});

test('buildPdf: Seite mit Hintergrundbild bettet das JPEG unverändert als DCTDecode-Bild ein', () => {
  const pages = [{ paper: 'lined', orient: 'p', strokes: null, bg: ASSET }];
  const bytes = buildPdf(pages, { title: 'Bild', images: new Map([[ASSET, JPEG]]) });
  const s = latin1(bytes);
  assert.match(s, /\/Subtype \/Image \/Width 1 \/Height 1 \/ColorSpace \/DeviceGray \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  assert.match(s, /\/XObject << \/Im1 7 0 R >>/);
  assert.match(s, /q 595\.28 0 0 595\.28 0 123\.31 cm \/Im1 Do Q/, 'contain: 1×1 → 2100 × 2100 (0,1 mm), zentriert');
  const offsets = checkXref(bytes);
  assert.equal(offsets.length - 1, 7, '4 Basis + 1 Seite (Page + Content) + 1 Bild');
  const img = streamOf(bytes, offsets, 7);
  assert.equal(img.data, Buffer.from(JPEG).toString('latin1'), 'JPEG-Bytes unverändert');
  // Reihenfolge: Weiß, Bild, Papierlinien
  const c = streamOf(bytes, offsets, 6).data;
  assert.ok(c.indexOf(' re f') < c.indexOf(' Do') && c.indexOf(' Do') < c.indexOf('0.35 w'), 'Weiß → Bild → Papier');
});

test('buildPdf: gleiches Asset auf zwei Seiten ergibt nur ein Bild-Objekt', () => {
  const pages = [
    { paper: 'blank', orient: 'p', strokes: null, bg: ASSET },
    { paper: 'blank', orient: 'l', strokes: null, bg: ASSET },
  ];
  const bytes = buildPdf(pages, { title: 'zwei', images: { [ASSET]: JPEG } });
  const s = latin1(bytes);
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 1, 'ein Image-XObject');
  assert.equal((s.match(/\/Im1 9 0 R/g) || []).length, 2, 'beide Seiten verweisen auf Objekt 9 (5 + 2 × 2 Seitenobjekte)');
  checkXref(bytes);
});

test('buildPdf: Seite ohne fehlendes Bild bleibt ohne Bild, zwei verschiedene Bilder je einmal', () => {
  const pages = [
    { paper: 'blank', orient: 'p', strokes: null, bg: ASSET },
    { paper: 'blank', orient: 'p', strokes: null, bg: ASSET2 },    // nicht übergeben
    { paper: 'blank', orient: 'p', strokes: null, bg: null },
    { paper: 'blank', orient: 'p', strokes: null, bg: ASSET },
  ];
  const bytes = buildPdf(pages, { title: 'x', images: new Map([[ASSET, JPEG]]) });
  const s = latin1(bytes);
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 1);
  assert.equal((s.match(/\/Resources 4 0 R/g) || []).length, 2, 'Seiten ohne Bild nutzen die gemeinsamen Ressourcen');
  checkXref(bytes);
});

test('buildPdf: CMYK- und RGB-JPEG bekommen den passenden Farbraum', () => {
  const cmyk = buildPdf([{ paper: 'blank', orient: 'p', strokes: null, bg: ASSET }], { images: { [ASSET]: fakeJpeg(64, 64, 4) } });
  const s = latin1(cmyk);
  assert.match(s, /\/ColorSpace \/DeviceCMYK \/BitsPerComponent 8 \/Decode \[1 0 1 0 1 0 1 0\] \/Filter \/DCTDecode/);
  checkXref(cmyk);
  const rgb = latin1(buildPdf([{ paper: 'blank', orient: 'p', strokes: null, bg: ASSET }], { images: { [ASSET]: fakeJpeg(64, 32, 3) } }));
  assert.match(rgb, /\/Width 64 \/Height 32 \/ColorSpace \/DeviceRGB/);
});

test('notePdf: Bild über getAssetBytes, jedes Asset nur einmal geholt, fehlendes Bild → Seite ohne Bild', async () => {
  const asked = [];
  const getAssetBytes = async (id) => { asked.push(id); return id === ASSET ? JPEG : null; };
  const pages = [
    { paper: 'lined', orient: 'p', strokes: encodeStrokes([penA]), bg: ASSET },
    { paper: 'lined', orient: 'p', strokes: null, bg: ASSET },
    { paper: 'lined', orient: 'p', strokes: null, bg: ASSET2 },
  ];
  const blob = await notePdf({ title: 'Bilder' }, pages, { getAssetBytes });
  assert.deepEqual(asked, [ASSET, ASSET2], 'je Asset einmal');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const s = latin1(bytes);
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 1);
  assert.match(s, /\/Count 3 /);
  assert.equal((s.match(/\/Resources 4 0 R/g) || []).length, 1, 'nur die Seite mit fehlendem Bild ohne Bild');
  const offsets = checkXref(bytes);
  const img = streamOf(bytes, offsets, 5 + 2 * 3);
  assert.equal(img.data, Buffer.from(JPEG).toString('latin1'));
});

test('notePdf: ohne getAssetBytes entstehen Seiten ohne Bild; Fehler beim Laden lässt die Seite ohne Bild', async () => {
  const plain = await notePdf({ title: 'x' }, [{ paper: 'blank', orient: 'p', strokes: null, bg: ASSET }]);
  assert.doesNotMatch(latin1(new Uint8Array(await plain.arrayBuffer())), /\/Subtype \/Image/);
  const failing = await notePdf({ title: 'x' }, [{ paper: 'blank', orient: 'p', strokes: null, bg: ASSET }], {
    getAssetBytes: async () => { throw new Error('offline'); },
  });
  assert.doesNotMatch(latin1(new Uint8Array(await failing.arrayBuffer())), /\/Subtype \/Image/);
});

test('buildPdf: Bild mit Querformat-Seite wird contain eingepasst', () => {
  // 1×1 auf Querformat (2970 × 2100): Quadrat 2100 × 2100, horizontal zentriert
  const bytes = buildPdf([{ paper: 'blank', orient: 'l', strokes: null, bg: ASSET }], { images: { [ASSET]: JPEG } });
  const s = latin1(bytes);
  // x = (2970 − 2100) / 2 = 435 (0,1 mm) → 123.31 pt; y von unten: (2100 − 2100) = 0
  assert.match(s, /q 595\.28 0 0 595\.28 123\.31 0 cm \/Im1 Do Q/);
  checkXref(bytes);
});

// ───────── Schul-Lineaturen (ARCHITEKTUR 11.1) ─────────

test('buildPdf: Lineatur 1 füllt je Mittelband ein Rechteck (re f) vor den Linien, Grundlinie 1,6-fach, xref gültig', () => {
  const bytes = buildPdf([{ paper: 'lin1', orient: 'p', strokes: null }], { title: 'Lineatur' });
  const offsets = checkXref(bytes);
  const c = streamOf(bytes, offsets, 6).data;
  const rows = paperGeometry('lin1', 'p').strongLines.length / 4;
  const rects = c.split('\n').filter((l) => / re f$/.test(l));
  assert.equal(rects.length, rows, 'ein Band je Zeile');
  assert.match(c, /0\.902 0\.957 0\.882 rg/, 'Bandfarbe #e6f4e1');
  assert.ok(c.indexOf(' re f') < c.indexOf('0.35 w'), 'Bänder vor den Linien');
  assert.match(c, /0\.56 w/, 'Grundlinie mit 1,6-facher Breite (0,35 × 1,6)');
});

test('buildPdf: Lineatur 3 (ohne Band), Lineatur 4 und Rechenkästchen ohne Bänder', () => {
  for (const paper of ['lin3', 'lin4', 'math']) {
    const bytes = buildPdf([{ paper, orient: 'l', strokes: null }], { title: paper });
    const offsets = checkXref(bytes);
    const c = streamOf(bytes, offsets, 6).data;
    assert.doesNotMatch(c, / re f$/m, `${paper}: keine Bänder`);
  }
});

test('notePdf: Lineaturen und Rechenkästchen ergeben gültige PDFs (xref)', async () => {
  for (const paper of ['lin1', 'lin2', 'lin3', 'lin4', 'math']) {
    for (const orient of ['p', 'l']) {
      const blob = await notePdf({ title: paper }, [{ paper, orient, strokes: null }]);
      checkXref(new Uint8Array(await blob.arrayBuffer()));
    }
  }
});
