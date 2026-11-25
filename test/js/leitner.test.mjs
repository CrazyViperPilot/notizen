// node --test test/js/  (Lernkartei nach Leitner, Vokabeltrainer)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOXES, INTERVAL_DAYS, emptyLearn, cleanLearn, answer, isDue, pickNext, stats, boxOf, serializeLearn,
} from '../../js/ink/leitner.js';

const DAY = 86400000;
const NOW = 1_800_000_000_000;

// Deterministischer Zufall (Park-Miller-artiger LCG), damit Fehlschläge reproduzierbar sind.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Erzeugt eine Folge von Zufallswerten, die nacheinander zurückgegeben werden (letzter Wert wiederholt sich).
function seq(...vals) {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
}

function entry(b, t = NOW - 1000, n = 1, k = 0) {
  return { b, t, n, k };
}

test('Konstanten: 5 Fächer und Intervalle in Tagen', () => {
  assert.equal(BOXES, 5);
  assert.deepEqual(INTERVAL_DAYS, [0, 1, 3, 7, 21]);
});

test('emptyLearn liefert einen leeren Lernstand und jedes Mal ein neues Objekt', () => {
  const a = emptyLearn();
  assert.deepEqual(a, { v: 1, rows: {} });
  a.rows[3] = entry(2);
  assert.deepEqual(emptyLearn(), { v: 1, rows: {} });
});

test('cleanLearn verwirft Müll und liefert immer einen gültigen Stand', () => {
  for (const junk of [null, undefined, 0, 1, NaN, 'abc', '{"v":1,"rows":{}}', true, [], [1, 2], () => 1]) {
    assert.deepEqual(cleanLearn(junk), emptyLearn(), `Eingabe ${String(junk)}`);
  }
  assert.deepEqual(cleanLearn({ v: 9, rows: null }), emptyLearn());
  assert.deepEqual(cleanLearn({ v: 1, rows: [entry(1)] }), emptyLearn());
});

test('cleanLearn behält gültige Einträge und setzt v auf 1', () => {
  const x = { v: 7, rows: { 0: entry(1, 5, 2, 1), 17: entry(5, NOW, 40, 30) }, extra: 'weg' };
  const c = cleanLearn(x);
  assert.deepEqual(c, { v: 1, rows: { 0: { b: 1, t: 5, n: 2, k: 1 }, 17: { b: 5, t: NOW, n: 40, k: 30 } } });
});

test('cleanLearn verwirft ungültige Zeilenschlüssel', () => {
  const good = entry(2);
  const x = {
    rows: {
      '-1': good, '01': good, '1.5': good, '1e2': good, ' 2': good, abc: good, '': good,
      '200': good, '199': good, '99999999999999999999999': good,
    },
  };
  assert.deepEqual(Object.keys(cleanLearn(x).rows), ['199']);
});

test('cleanLearn verwirft Zeilen außerhalb 0…maxRows−1', () => {
  const x = { rows: { 0: entry(1), 4: entry(1), 5: entry(1), 9: entry(1) } };
  assert.deepEqual(Object.keys(cleanLearn(x, 5).rows), ['0', '4']);
  assert.deepEqual(Object.keys(cleanLearn(x, 0).rows), []);
  assert.deepEqual(Object.keys(cleanLearn(x, 1000).rows), ['0', '4', '5', '9']);
});

test('cleanLearn hat ein Standard-Limit von 200 Zeilen', () => {
  const rows = {};
  for (let i = 0; i < 260; i++) rows[i] = entry(1);
  const keys = Object.keys(cleanLearn({ rows }).rows);
  assert.equal(keys.length, 200);
  assert.equal(keys[0], '0');
  assert.equal(keys[199], '199');
});

test('cleanLearn verwirft Einträge mit ungültigen Werten', () => {
  const bad = [
    null, undefined, 'x', 3, [], [1, 2, 3, 4], {},
    { b: 0, t: 1, n: 0, k: 0 }, { b: 6, t: 1, n: 0, k: 0 }, { b: 1.5, t: 1, n: 0, k: 0 }, { b: '2', t: 1, n: 0, k: 0 },
    { b: null, t: 1, n: 0, k: 0 }, { b: 1, t: -1, n: 0, k: 0 }, { b: 1, t: 1.5, n: 0, k: 0 },
    { b: 1, t: NaN, n: 0, k: 0 }, { b: 1, t: Infinity, n: 0, k: 0 }, { b: 1, t: 1, n: -1, k: 0 },
    { b: 1, t: 1, n: 0, k: '1' }, { b: 1, t: 1, n: 0 }, { b: 1, t: 1, n: 0, k: 0.5 },
  ];
  const rows = {};
  bad.forEach((e, i) => { rows[i] = e; });
  rows[30] = entry(3, 10, 4, 2);
  assert.deepEqual(cleanLearn({ rows }).rows, { 30: { b: 3, t: 10, n: 4, k: 2 } });
});

test('cleanLearn kopiert nur b, t, n, k in neue Einträge', () => {
  const c = cleanLearn({ rows: { 2: { b: 2, t: 3, n: 4, k: 1, evil: 'x' } } });
  assert.deepEqual(c.rows[2], { b: 2, t: 3, n: 4, k: 1 });
});

test('cleanLearn verändert die Eingabe nicht', () => {
  const x = { v: 1, rows: { 0: entry(1), 'bad': entry(2) } };
  const before = structuredClone(x);
  const c = cleanLearn(x);
  assert.deepEqual(x, before);
  assert.notEqual(c.rows[0], x.rows[0]);
});

test('answer: gewusst schiebt ins nächste Fach, nicht gewusst zurück auf 1', () => {
  let s = emptyLearn();
  s = answer(s, 4, true, NOW);
  assert.equal(boxOf(s, 4), 2, 'neue Zeile startet in Fach 1, gewusst → 2');
  s = answer(s, 4, true, NOW);
  assert.equal(boxOf(s, 4), 3);
  s = answer(s, 4, false, NOW);
  assert.equal(boxOf(s, 4), 1);
});

test('answer: nicht gewusst bei neuer Zeile bleibt in Fach 1', () => {
  const s = answer(emptyLearn(), 0, false, NOW);
  assert.equal(boxOf(s, 0), 1);
  assert.deepEqual(s.rows[0], { b: 1, t: NOW, n: 1, k: 0 });
});

test('answer: Fach 5 bleibt bei gewusst auf 5, Zähler laufen weiter', () => {
  let s = { v: 1, rows: { 1: entry(5, NOW - DAY * 30, 10, 9) } };
  s = answer(s, 1, true, NOW);
  assert.deepEqual(s.rows[1], { b: 5, t: NOW, n: 11, k: 10 });
  s = answer(s, 1, false, NOW + 5);
  assert.deepEqual(s.rows[1], { b: 1, t: NOW + 5, n: 12, k: 10 });
});

test('answer: setzt t, erhöht n und k (nur bei gewusst)', () => {
  const s0 = { v: 1, rows: { 7: entry(2, 100, 3, 1) } };
  const s1 = answer(s0, 7, false, 500);
  assert.deepEqual(s1.rows[7], { b: 1, t: 500, n: 4, k: 1 });
  const s2 = answer(s0, 7, true, 500);
  assert.deepEqual(s2.rows[7], { b: 3, t: 500, n: 4, k: 2 });
});

test('answer verändert den Eingabe-Lernstand nicht', () => {
  const s0 = { v: 1, rows: { 2: entry(2, 100, 3, 1) } };
  const before = structuredClone(s0);
  const s1 = answer(s0, 2, true, NOW);
  const s2 = answer(s0, 9, false, NOW);
  assert.deepEqual(s0, before);
  assert.notEqual(s1, s0);
  assert.notEqual(s1.rows, s0.rows);
  assert.notEqual(s1.rows[2], s0.rows[2]);
  assert.equal(s2.rows[2].b, 2);
  assert.equal(s2.rows[9].b, 1);
  assert.equal(s0.rows[9], undefined);
});

test('answer mit ungültiger Zeile liefert nur eine bereinigte Kopie', () => {
  const s0 = { v: 1, rows: { 2: entry(2) } };
  for (const row of [-1, 1.5, '3', NaN, null]) {
    assert.deepEqual(answer(s0, row, true, NOW), { v: 1, rows: { 2: entry(2) } }, `Zeile ${String(row)}`);
  }
});

test('isDue: neue Zeile ist fällig, Fach 1 immer', () => {
  assert.equal(isDue(undefined, NOW), true);
  assert.equal(isDue(null, NOW), true);
  assert.equal(isDue(entry(1, NOW), NOW), true);
});

test('isDue: Fälligkeit nach INTERVAL_DAYS Tagen', () => {
  for (let b = 1; b <= BOXES; b++) {
    const days = INTERVAL_DAYS[b - 1];
    const e = entry(b, NOW);
    assert.equal(isDue(e, NOW + days * DAY), true, `Fach ${b} nach ${days} Tagen`);
    if (days > 0) {
      assert.equal(isDue(e, NOW + days * DAY - 1), false, `Fach ${b} eine Millisekunde vorher`);
      assert.equal(isDue(e, NOW + DAY - 1), false, `Fach ${b} kurz nach der Antwort`);
    }
  }
});

test('isDue: Fach 2 nach genau einem Tag, Fach 5 erst nach 21 Tagen', () => {
  assert.equal(isDue(entry(2, NOW), NOW + DAY - 1), false);
  assert.equal(isDue(entry(2, NOW), NOW + DAY), true);
  assert.equal(isDue(entry(5, NOW), NOW + 20 * DAY), false);
  assert.equal(isDue(entry(5, NOW), NOW + 21 * DAY), true);
});

test('isDue: Zeitpunkt in der Zukunft ist nicht fällig', () => {
  assert.equal(isDue(entry(2, NOW + DAY), NOW), false);
});

test('pickNext: leere Liste ergibt null', () => {
  assert.equal(pickNext(emptyLearn(), [], NOW), null);
  assert.equal(pickNext(emptyLearn(), null, NOW), null);
});

test('pickNext: einzelne Zeile wird immer gewählt', () => {
  assert.equal(pickNext(emptyLearn(), [7], NOW, () => 0.99), 7);
});

test('pickNext: fällige Zeilen werden bevorzugt', () => {
  const learn = { v: 1, rows: { 0: entry(5, NOW), 1: entry(1, NOW - DAY * 5) } };
  // Zeile 0 ist in Fach 5 frisch (nicht fällig), Zeile 1 in Fach 1 ist immer fällig.
  for (const r of [0, 0.3, 0.9999]) {
    assert.equal(pickNext(learn, [0, 1], NOW, () => r), 1);
  }
});

test('pickNext: nicht fällige Zeilen nur, wenn keine fällige da ist (gewichtet)', () => {
  const learn = { v: 1, rows: { 0: entry(2, NOW), 1: entry(5, NOW) } };
  // Gewicht 8 (Fach 2) und 1 (Fach 5), Summe 9. x = r·9.
  assert.equal(pickNext(learn, [0, 1], NOW, () => 0), 0);
  assert.equal(pickNext(learn, [0, 1], NOW, () => 0.8), 0);   // x = 7.2 < 8
  assert.equal(pickNext(learn, [0, 1], NOW, () => 0.95), 1);  // x = 8.55 ≥ 8
});

test('pickNext: gewichtete Auswahl nach Fach (Grenzen)', () => {
  // Zeilen 0 (neu, Fach 1, Gewicht 16) und 1 (Fach 2, Gewicht 8): Summe 24.
  const learn = { v: 1, rows: { 1: entry(2, NOW - 2 * DAY) } };
  assert.equal(pickNext(learn, [0, 1], NOW, seq(0.66)), 0, 'x = 15.84 liegt in Fach 1');
  assert.equal(pickNext(learn, [0, 1], NOW, seq(0.67)), 1, 'x = 16.08 liegt in Fach 2');
  assert.equal(pickNext(learn, [0, 1], NOW, seq(0.9999)), 1);
});

test('pickNext: Folge deterministischer Zufallswerte', () => {
  const learn = { v: 1, rows: { 10: entry(2, 0), 11: entry(3, 0), 12: entry(4, 0) } };
  // Alle fällig (t = 0). Gewichte: 0 → 16, 10 → 8, 11 → 4, 12 → 2; Summe 30.
  const rows = [0, 10, 11, 12];
  const picks = [0, 0.5, 0.8, 0.9, 0.99].map((r) => pickNext(learn, rows, NOW, () => r));
  // x = r·30: 0 → Zeile 0 (Fach 1 reicht bis 16) | 15 → 0 | 24 → 11 (Fach 2 liegt bei 16…24, 11 bei 24…28)
  // | 27 → 11 | 29.7 → 12 (Fach 4 bei 28…30)
  assert.deepEqual(picks, [0, 0, 11, 11, 12]);
});

test('pickNext: Verteilung folgt den Gewichten', () => {
  const learn = { v: 1, rows: { 1: entry(2, 0), 2: entry(5, 0) } };
  const rows = [0, 1, 2];
  const rand = rng(42);
  const counts = { 0: 0, 1: 0, 2: 0 };
  const N = 20000;
  for (let i = 0; i < N; i++) counts[pickNext(learn, rows, NOW, rand)] += 1;
  // Gewichte 16, 8, 1 (Summe 25): erwartete Anteile 0.64, 0.32, 0.04.
  assert.ok(Math.abs(counts[0] / N - 0.64) < 0.02, `Fach 1: ${counts[0] / N}`);
  assert.ok(Math.abs(counts[1] / N - 0.32) < 0.02, `Fach 2: ${counts[1] / N}`);
  assert.ok(Math.abs(counts[2] / N - 0.04) < 0.01, `Fach 5: ${counts[2] / N}`);
});

test('pickNext: rand-Wert nahe 1 oder NaN wählt die letzte Zeile statt abzubrechen', () => {
  const learn = { v: 1, rows: {} };
  assert.equal(pickNext(learn, [3, 4], NOW, () => 1), 4);
  assert.equal(pickNext(learn, [3, 4], NOW, () => NaN), 4);
});

test('pickNext: Standard-Zufall (Math.random) liefert eine Zeile aus der Liste', () => {
  const r = pickNext(emptyLearn(), [5, 6, 7], NOW);
  assert.ok([5, 6, 7].includes(r));
});

test('pickNext: exclude wird ausgeschlossen, wenn andere Kandidaten bleiben', () => {
  const learn = emptyLearn();
  // rand 0 wählte sonst Zeile 5 (erste im Kreis).
  assert.equal(pickNext(learn, [5, 6], NOW, () => 0, 5), 6);
  assert.equal(pickNext(learn, [5, 6], NOW, () => 0, 6), 5);
});

test('pickNext: exclude ist die einzige Kandidatin, dann wird sie trotzdem gewählt', () => {
  assert.equal(pickNext(emptyLearn(), [5], NOW, () => 0, 5), 5);
});

test('pickNext: exclude greift innerhalb des fälligen Kreises, Fälligkeit geht vor', () => {
  // Zeile 5 ist fällig, Zeile 6 nicht. Mit exclude 5 bleibt nur 5 im fälligen Kreis, also wird 5 gewählt.
  const learn = { v: 1, rows: { 5: entry(1, 0), 6: entry(5, NOW) } };
  assert.equal(pickNext(learn, [5, 6], NOW, () => 0, 5), 5);
});

test('pickNext: exclude null oder undefined ist ohne Wirkung', () => {
  assert.equal(pickNext(emptyLearn(), [5, 6], NOW, () => 0, null), 5);
  assert.equal(pickNext(emptyLearn(), [5, 6], NOW, () => 0, undefined), 5);
});

test('stats: Zählung nach Fach, fällig und gemeistert', () => {
  const learn = {
    v: 1,
    rows: {
      1: entry(1, NOW),          // fällig (Fach 1)
      2: entry(2, NOW),          // nicht fällig
      3: entry(2, NOW - DAY),    // fällig
      4: entry(5, NOW),          // gemeistert, nicht fällig
      5: entry(5, NOW - 30 * DAY), // gemeistert, fällig
    },
  };
  const s = stats(learn, [0, 1, 2, 3, 4, 5], NOW);
  assert.deepEqual(s, { total: 6, boxes: [2, 2, 0, 0, 2], due: 4, mastered: 2 });
});

test('stats: neue und unbekannte Zeilen zählen in Fach 1 und sind fällig', () => {
  const s = stats(emptyLearn(), [0, 1, 2], NOW);
  assert.deepEqual(s, { total: 3, boxes: [3, 0, 0, 0, 0], due: 3, mastered: 0 });
  assert.deepEqual(stats(null, [], NOW), { total: 0, boxes: [0, 0, 0, 0, 0], due: 0, mastered: 0 });
});

test('stats: Einträge außerhalb der Zeilenliste zählen nicht', () => {
  const learn = { v: 1, rows: { 9: entry(5, NOW) } };
  assert.deepEqual(stats(learn, [0], NOW), { total: 1, boxes: [1, 0, 0, 0, 0], due: 1, mastered: 0 });
});

test('boxOf: Fach einer Zeile, neue Zeilen in Fach 1', () => {
  const learn = { v: 1, rows: { 3: entry(4) } };
  assert.equal(boxOf(learn, 3), 4);
  assert.equal(boxOf(learn, 0), 1);
  assert.equal(boxOf(null, 3), 1);
  assert.equal(boxOf(learn, '3'), 4);
  assert.equal(boxOf({ v: 1, rows: { 3: { b: 9, t: 0, n: 0, k: 0 } } }, 3), 1, 'ungültiges Fach gilt als neu');
});

test('serializeLearn: kompaktes JSON, das wieder gelesen werden kann', () => {
  const learn = {
    v: 1,
    rows: { 0: entry(1, 5, 2, 1), 12: entry(5, NOW, 40, 30) },
  };
  const json = serializeLearn(learn);
  assert.equal(typeof json, 'string');
  assert.ok(!/\s/.test(json), 'ohne Leerzeichen');
  assert.deepEqual(JSON.parse(json), learn);
  assert.deepEqual(cleanLearn(JSON.parse(json)), learn);
});

test('serializeLearn: ungültige Eingabe ergibt den leeren Stand', () => {
  assert.equal(serializeLearn(null), '{"v":1,"rows":{}}');
  assert.equal(serializeLearn('Müll'), '{"v":1,"rows":{}}');
  assert.equal(serializeLearn({ rows: { 0: 'x', 1: entry(2) } }), '{"v":1,"rows":{"1":{"b":2,"t":' + (NOW - 1000) + ',"n":1,"k":0}}}');
});

test('serializeLearn: Größe bleibt unter 16 KB, auch bei 200 Zeilen mit größten Zahlen', () => {
  const big = Number.MAX_SAFE_INTEGER;
  const rows = {};
  for (let i = 0; i < 200; i++) rows[i] = { b: 5, t: big - i, n: big, k: big };
  const json = serializeLearn({ v: 1, rows });
  assert.ok(json.length <= 16384, `Länge ${json.length}`);
  assert.equal(Object.keys(JSON.parse(json).rows).length, 200);
});

test('serializeLearn verändert die Eingabe nicht', () => {
  const learn = { v: 1, rows: { 0: entry(3) } };
  const before = structuredClone(learn);
  serializeLearn(learn);
  assert.deepEqual(learn, before);
});
