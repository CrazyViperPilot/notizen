// node --test test/js/  (Bleistift: Druck und Neigung, Codec, Radius, PDF-Transparenz)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pencilP, altitudeOf, radiusAt, PENCIL_P_SCALE, penShapes, maxRadius, bbox } from '../../js/ink/stroke.js';
import { encodeStrokes, decodeStrokes } from '../../js/ink/codec.js';
import { buildPdf } from '../../js/export/pdf.js';
import { PENCIL_ALPHA } from '../../js/config.js';

const DEG = Math.PI / 180;
const SENKRECHT = Math.PI / 2;
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

test('pencilP: senkrecht gehalten schmal, flach gehalten breit', () => {
  const steil = pencilP(1, 0.5, SENKRECHT);
  const flach = pencilP(1, 0.5, 20 * DEG);
  assert.ok(flach > steil * 5, `flach (${flach}) soll deutlich breiter sein als senkrecht (${steil})`);
  // Senkrecht: Radius = Grundbreite (Mittel = 3,5 Einheiten) × 4 Skalierung
  assert.ok(Math.abs(steil * 255 - 3.5 * PENCIL_P_SCALE) < 0.6, 'senkrecht ≈ Stiftbreite');
});

test('pencilP: monoton, je flacher desto breiter', () => {
  const angles = [90, 70, 50, 40, 30, 20, 15, 10, 5].map((d) => d * DEG);
  const vals = angles.map((a) => pencilP(2, 0.5, a));
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1], `Winkel ${angles[i]} schmaler als ${angles[i - 1]}`);
  assert.ok(vals[vals.length - 1] > vals[0], 'flach ist echt breiter');
});

test('pencilP: mehr Druck = breiter', () => {
  for (const a of [SENKRECHT, 25 * DEG]) {
    assert.ok(pencilP(1, 1, a) > pencilP(1, 0.2, a), `Druck wirkt bei ${a}`);
  }
});

test('pencilP: Ergebnis liegt in (0, 1] für alle Stärken, Drücke und Winkel', () => {
  for (const width of [0, 1, 2]) {
    for (const pressure of [0, 0.01, 0.5, 1]) {
      for (const a of [0, 0.01, 10 * DEG, SENKRECHT, Math.PI]) {
        const v = pencilP(width, pressure, a);
        assert.ok(v > 0 && v <= 1, `pencilP(${width}, ${pressure}, ${a}) = ${v}`);
      }
    }
  }
  // Ohne Winkel wird senkrecht angenommen
  assert.equal(pencilP(1, 0.5, undefined), pencilP(1, 0.5, SENKRECHT));
});

test('altitudeOf: altitudeAngle hat Vorrang, sonst aus tiltX/tiltY, Finger → π/2', () => {
  assert.equal(altitudeOf({ pointerType: 'pen', altitudeAngle: 0.5, tiltX: 70, tiltY: 0 }), 0.5);
  // tiltX 70° (Stift flach, nach einer Seite geneigt): Höhenwinkel 20°
  assert.ok(Math.abs(altitudeOf({ pointerType: 'pen', tiltX: 70, tiltY: 0 }) - 20 * DEG) < 1e-9);
  // tiltX = tiltY = 45°: atan(1/√2)
  assert.ok(Math.abs(altitudeOf({ pointerType: 'pen', tiltX: 45, tiltY: 45 }) - Math.atan(1 / Math.SQRT2)) < 1e-9);
  // Stift ohne Neigung = senkrecht
  assert.equal(altitudeOf({ pointerType: 'pen', tiltX: 0, tiltY: 0 }), SENKRECHT);
  assert.equal(altitudeOf({ pointerType: 'pen' }), SENKRECHT);
  // Finger und Maus: immer senkrecht, auch wenn Werte gesetzt sind
  assert.equal(altitudeOf({ pointerType: 'touch', altitudeAngle: 0.2, tiltX: 70 }), SENKRECHT);
  assert.equal(altitudeOf({ pointerType: 'mouse', tiltX: 70, tiltY: 10 }), SENKRECHT);
});

test('codec: Bleistift-Strich (Typ b) übersteht die Rundreise', () => {
  const s = [{ id: 'pencil01', type: 'b', color: '#1f3a93', width: 2, pts: Int32Array.from([10, 20, 50, 30, 40, 60, 90, 10, 200]) }];
  const str = encodeStrokes(s);
  assert.match(str, /"t":"b"/);
  assert.match(str, /"w":2/, 'Stärke bleibt erhalten');
  const back = decodeStrokes(str);
  assert.equal(back.length, 1);
  assert.equal(back[0].type, 'b');
  assert.equal(back[0].width, 2);
  assert.equal(back[0].color, '#1f3a93');
  assert.deepEqual(Array.from(back[0].pts), Array.from(s[0].pts));
});

test('codec: Typ b mit Farbindex und Stärke 0; unbekannte Typen bleiben Stift', () => {
  const back = decodeStrokes('[{"i":"x","t":"b","c":3,"w":0,"p":[1,2,3]},{"i":"y","t":"z","c":0,"w":1,"p":[1,2,3]}]');
  assert.equal(back[0].type, 'b');
  assert.equal(back[0].color, 3);
  assert.equal(back[0].width, 0);
  assert.equal(back[1].type, 'p');
});

test('Bleistift: Radius = p / 4, maxRadius und bbox berücksichtigen ihn', () => {
  const st = { type: 'b', width: 1, pts: Int32Array.from([100, 100, 128, 900, 100, 128]) };
  assert.equal(radiusAt(st, 128), 32);
  assert.equal(maxRadius(st), 32);
  assert.deepEqual(bbox({ ...st, pts: Int32Array.from(st.pts) }), [68, 68, 932, 132]);
  const { circles, quads } = penShapes(st);
  assert.equal(circles.length / 3, 2, 'zwei Endkreise');
  assert.equal(circles[2], 32, 'Endkreis hat den Radius p/4');
  assert.equal(quads.length / 8, 1, 'ein Viereck für das Segment');
});

test('PDF: Bleistift-Strich füllt mit /GS2 (halbtransparent), Ressource GS2 vorhanden', () => {
  const pencil = { id: 'pen00003', type: 'b', color: 1, width: 1, pts: Int32Array.from([300, 300, 200, 900, 300, 200]) };
  const bytes = buildPdf([{ paper: 'blank', orient: 'p', strokes: encodeStrokes([pencil]) }], { title: 'Bleistift' });
  const s = latin1(bytes);
  assert.match(s, /\/GS2 << \/Type \/ExtGState \/CA 0\.45 \/ca 0\.45 \/BM \/Normal >>/, 'ExtGState GS2 mit Deckkraft 0,45');
  assert.match(s, /\/GS2 gs/, 'Inhalt setzt GS2');
  // Farbindex 1 = Dunkelblau #1f3a93 (wie im Stift)
  assert.ok(s.includes('0.122 0.227 0.576 rg'), 'Füllfarbe Dunkelblau');
});

test('PDF: Zustandswechsel zwischen Stift, Bleistift und Textmarker in Zeichenreihenfolge', () => {
  const pen = (id, x) => ({ id, type: 'p', color: 0, width: 1, pts: Int32Array.from([x, 100, 128, x + 300, 100, 128]) });
  const pencil = { id: 'pencil1', type: 'b', color: 0, width: 1, pts: Int32Array.from([100, 500, 200, 400, 500, 200]) };
  const hl = { id: 'hl000001', type: 'h', color: 0, width: 0, pts: Int32Array.from([100, 900, 128]) };
  const strokes = [pen('pen00001', 100), pencil, pen('pen00002', 600), hl];
  const bytes = buildPdf([{ paper: 'blank', orient: 'p', strokes: encodeStrokes(strokes) }], { title: 'x' });
  const gs = latin1(bytes).match(/\/GS\d gs/g);
  // Seitenstart GS0, dann alle Textmarker (GS1, vor den Stiften), dann Stift (GS0), Bleistift (GS2), Stift (GS0)
  assert.deepEqual(gs, ['/GS0 gs', '/GS1 gs', '/GS0 gs', '/GS2 gs', '/GS0 gs']);
});

test('PDF: Seite ohne Bleistift hat kein GS2 im Inhalt; Stift nach Textmarker setzt GS0', () => {
  const hl = { id: 'hl000002', type: 'h', color: 0, width: 0, pts: Int32Array.from([100, 900, 128]) };
  const pen = { id: 'pen00004', type: 'p', color: 0, width: 1, pts: Int32Array.from([100, 100, 128, 400, 100, 128]) };
  const bytes = buildPdf([{ paper: 'blank', orient: 'p', strokes: encodeStrokes([hl, pen]) }], { title: 'x' });
  const c = latin1(bytes);
  assert.deepEqual(c.match(/\/GS\d gs/g), ['/GS0 gs', '/GS1 gs', '/GS0 gs']);
  assert.doesNotMatch(c, /\/GS2 gs/);
});

test('PDF: nur Bleistift ohne Textmarker startet mit GS0 und wechselt auf GS2', () => {
  const pencil = { id: 'pencil2', type: 'b', color: 0, width: 2, pts: Int32Array.from([100, 100, 128, 400, 100, 128]) };
  const bytes = buildPdf([{ paper: 'blank', orient: 'p', strokes: encodeStrokes([pencil]) }], { title: 'x' });
  assert.deepEqual(latin1(bytes).match(/\/GS\d gs/g), ['/GS0 gs', '/GS2 gs']);
});

test('PENCIL_ALPHA ist die Deckkraft aus der Konfiguration', () => {
  assert.equal(PENCIL_ALPHA, 0.45);
});
