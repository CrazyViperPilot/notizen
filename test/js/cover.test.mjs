// node --test test/js/cover.test.mjs  (Titelblatt-Layout ohne DOM; renderText wird durch einen Fake ersetzt)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZES, TEMPLATES, FIELD_LABELS, buildCover, drawCoverPreview, todayDe, cleanText,
} from '../../js/export/cover.js';

// Fake-Renderer: Zeichenbreite und Zeilenhöhe proportional zur Schriftgröße, Umbruch bis 3 Zeilen.
// Bild ist 1/10 der Einheiten groß, damit die Tests schnell bleiben.
function fakeRender(calls) {
  return (text, opts) => {
    calls.push({ text, ...opts });
    const perChar = (opts.bold ? 6 : 5.5) * opts.sizeMm;
    const lineH = 12 * opts.sizeMm;
    const total = Array.from(text).length * perChar;
    const lines = Math.min(3, Math.max(1, Math.ceil(total / opts.maxWidth)));
    const w = Math.max(1, Math.round(Math.min(total, opts.maxWidth)));
    const h = Math.max(1, Math.round(lines * lineH));
    const iw = Math.max(1, Math.round(w / 10));
    const ih = Math.max(1, Math.round(h / 10));
    return { w, h, img: { w: iw, h: ih, gray: new Uint8Array(iw * ih).fill(255) } };
  };
}

const PAGE = (size, orient) => {
  const b = SIZES[size];
  return orient === 'l' ? { W: b.h, H: b.w } : { W: b.w, H: b.h };
};

function lineRect(l) {
  const e = l.width / 2;
  return {
    x: Math.min(l.x1, l.x2) - e, y: Math.min(l.y1, l.y2) - e,
    w: Math.abs(l.x2 - l.x1) + 2 * e, h: Math.abs(l.y2 - l.y1) + 2 * e,
  };
}

function overlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const FULL = {
  title: 'Physik Zusammenfassung Kapitel 3 mit einem etwas längeren Titel',
  subtitle: 'Mechanik und Wärmelehre',
  author: 'Max Mustermann',
  date: '25.11.2026',
  subject: 'Physik',
  class: '9b',
  year: '2026/2027',
};
const LONG = Object.fromEntries(Object.keys(FULL).map((k) => [k, 'Lorem ipsum dolor sit amet '.repeat(20)]));
const EMPTY = {};
const SETS = { full: FULL, long: LONG, empty: EMPTY };

test('SIZES, TEMPLATES und FIELD_LABELS entsprechen der Vorgabe', () => {
  assert.deepEqual(SIZES, { a4: { w: 2100, h: 2970 }, a5: { w: 1480, h: 2100 }, a3: { w: 2970, h: 4200 } });
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['klassisch', 'schule', 'schlicht']);
  for (const t of TEMPLATES) assert.equal(typeof t.name, 'string');
  assert.deepEqual(TEMPLATES.find((t) => t.id === 'klassisch').fields, ['title', 'subtitle', 'author', 'date']);
  assert.deepEqual(TEMPLATES.find((t) => t.id === 'schule').fields, ['title', 'subject', 'author', 'class', 'year']);
  assert.deepEqual(TEMPLATES.find((t) => t.id === 'schlicht').fields, ['title', 'date']);
  assert.equal(FIELD_LABELS.class, 'Klasse');
  assert.equal(FIELD_LABELS.year, 'Schuljahr');
  assert.equal(FIELD_LABELS.author, 'Name');
});

for (const tpl of TEMPLATES) {
  for (const size of ['a4', 'a5', 'a3']) {
    for (const orient of ['p', 'l']) {
      for (const [setName, set] of Object.entries(SETS)) {
        test(`${tpl.id} ${size} ${orient} (${setName}): Anordnung ist gültig`, () => {
          const cover = buildCover(tpl.id, set, { size, orient }, fakeRender([]));
          const { W, H } = PAGE(size, orient);
          assert.equal(cover.size, size);
          assert.equal(cover.orient, orient);
          const lines = cover.lines.map(lineRect);
          // Alles innerhalb der Seite
          for (const r of [...cover.boxes, ...lines, ...cover.texts]) {
            assert.ok(r.x >= 0 && r.y >= 0, 'links/oben im Papier');
            assert.ok(r.x + r.w <= W && r.y + r.h <= H, 'rechts/unten im Papier');
          }
          // Text überlappt weder Linie, Box noch anderen Text
          for (let i = 0; i < cover.texts.length; i++) {
            const t = cover.texts[i];
            for (const l of lines) assert.equal(overlap(t, l), false, 'Text berührt Linie');
            for (const b of cover.boxes) assert.equal(overlap(t, b), false, 'Text berührt Box');
            for (let j = i + 1; j < cover.texts.length; j++) {
              assert.equal(overlap(t, cover.texts[j]), false, 'Texte überlappen');
            }
          }
          // Boxen und Linien: Farben als Hex
          for (const b of cover.boxes) assert.match(b.color, /^#[0-9a-f]{6}$/i);
          for (const l of cover.lines) assert.match(l.color, /^#[0-9a-f]{6}$/i);
          // Text-Bilder: Format
          for (const t of cover.texts) {
            assert.ok(Number.isInteger(t.w) && t.w > 0 && Number.isInteger(t.h) && t.h > 0);
            assert.ok(Number.isInteger(t.img.w) && t.img.w > 0 && Number.isInteger(t.img.h) && t.img.h > 0);
            assert.ok(t.img.gray instanceof Uint8Array);
            assert.equal(t.img.gray.length, t.img.w * t.img.h);
          }
        });
      }
    }
  }
}

test('leere Felder werden weggelassen', () => {
  const klassisch = buildCover('klassisch', { title: 'Nur Titel' }, {}, fakeRender([]));
  assert.equal(klassisch.texts.length, 1);
  assert.equal(klassisch.lines.length, 0);

  const leer = buildCover('klassisch', {}, {}, fakeRender([]));
  assert.equal(leer.texts.length, 0);

  const schlicht = buildCover('schlicht', { title: '', date: '' }, {}, fakeRender([]));
  assert.equal(schlicht.texts.length, 0);
  assert.equal(schlicht.boxes.length, 0);
});

test('Schulheft: Beschriftungen bleiben auch bei leeren Werten', () => {
  const calls = [];
  const cover = buildCover('schule', {}, {}, fakeRender(calls));
  // 'Ag' ist nur die Messprobe für leere Werte, keine Beschriftung
  const labels = calls.map((c) => c.text).filter((t) => t !== 'Ag').sort();
  assert.deepEqual(labels, ['Fach', 'Klasse', 'Name', 'Schuljahr']);
  assert.equal(cover.texts.length, 4);            // nur die Beschriftungen, keine Werte
  assert.equal(cover.lines.length, 8);            // Rahmen (4) + Linie je Zeile (4)
});

test('Schlicht: Akzentstreifen liegt links neben dem Text', () => {
  const cover = buildCover('schlicht', FULL, { size: 'a4', orient: 'p' }, fakeRender([]));
  assert.equal(cover.boxes.length, 1);
  const box = cover.boxes[0];
  assert.ok(cover.texts.length >= 2);
  for (const t of cover.texts) assert.ok(t.x >= box.x + box.w, 'Text steht rechts vom Streifen');
});

test('unbekannte Vorlage fällt auf klassisch zurück', () => {
  const a = buildCover('gibt-es-nicht', FULL, { size: 'a5', orient: 'l' }, fakeRender([]));
  const b = buildCover('klassisch', FULL, { size: 'a5', orient: 'l' }, fakeRender([]));
  assert.deepEqual(a, b);
  const c = buildCover(undefined, FULL, {}, fakeRender([]));
  assert.deepEqual(c, buildCover('klassisch', FULL, {}, fakeRender([])));
});

test('unbekannte Größe fällt auf A4 zurück, Ausrichtung auf Hochformat', () => {
  const cover = buildCover('klassisch', {}, { size: 'b9', orient: 'x' }, fakeRender([]));
  assert.equal(cover.size, 'a4');
  assert.equal(cover.orient, 'p');
});

test('Steuerzeichen und Länge werden bereinigt', () => {
  const calls = [];
  buildCover('schlicht', { title: 'A\u0007B\nC\t' + 'x'.repeat(300), date: '' }, {}, fakeRender(calls));
  const t = calls[0].text;
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\n\t]/.test(t), 'keine Steuerzeichen');
  assert.equal(t.slice(0, 4), 'AB C');
  assert.equal(Array.from(t).length, 200);
  // Zeichen über 200 Code-Punkte hinaus werden gekürzt, Surrogate bleiben ganz
  assert.equal(Array.from(cleanText('𝄞'.repeat(250))).length, 200);
  assert.equal(cleanText('  a \u0000 b c  '), 'a b c');
  assert.equal(cleanText(null), '');
});

test('renderText bekommt sinnvolle Optionen', () => {
  const calls = [];
  buildCover('klassisch', FULL, { size: 'a4', orient: 'p' }, fakeRender(calls));
  assert.ok(calls.length >= 4);
  for (const c of calls) {
    assert.ok(c.sizeMm > 0);
    assert.ok(c.maxWidth > 0);
    assert.ok(['left', 'center'].includes(c.align));
    assert.match(c.color, /^#[0-9a-f]{6}$/i);
  }
});

test('Schriftgrößen skalieren mit der Papiergröße', () => {
  const a5 = [];
  const a3 = [];
  buildCover('klassisch', { title: 'Titel' }, { size: 'a5' }, fakeRender(a5));
  buildCover('klassisch', { title: 'Titel' }, { size: 'a3' }, fakeRender(a3));
  assert.ok(a3[0].sizeMm > a5[0].sizeMm, 'A3 größer als A5');
});

test('todayDe liefert TT.MM.JJJJ', () => {
  assert.equal(todayDe(new Date(2026, 10, 25)), '25.11.2026');
  assert.equal(todayDe(new Date(2026, 0, 5)), '05.01.2026');
  assert.match(todayDe(), /^\d{2}\.\d{2}\.\d{4}$/);
});

test('drawCoverPreview zeichnet Boxen und Linien innerhalb des Canvas', () => {
  const ops = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, imageSmoothingEnabled: false,
    fillRect: (...a) => ops.push(['fillRect', ...a]),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...a) => ops.push(['moveTo', ...a]),
    lineTo: (...a) => ops.push(['lineTo', ...a]),
    stroke: () => ops.push(['stroke']),
  };
  const canvas = { width: 210, height: 297, getContext: () => ctx };
  // Ohne Texte, weil Text-Bilder ein Canvas zum Rendern brauchen (nur im Browser)
  const full = buildCover('schule', {}, { size: 'a4', orient: 'p' }, fakeRender([]));
  const cover = { ...full, texts: [] };
  drawCoverPreview(canvas, cover);
  const fills = ops.filter((o) => o[0] === 'fillRect');
  assert.equal(fills[0][1], 0);                       // erster Füllrechteck = weißer Grund
  assert.equal(fills[0][3], 210);
  assert.equal(ops.filter((o) => o[0] === 'stroke').length, cover.lines.length);
  for (const o of ops.filter((o) => o[0] === 'moveTo' || o[0] === 'lineTo')) {
    assert.ok(o[1] >= 0 && o[1] <= 210 && o[2] >= 0 && o[2] <= 297);
  }
});
