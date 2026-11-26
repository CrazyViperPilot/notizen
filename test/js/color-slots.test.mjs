// Eigene Farbslots der Werkzeugleiste (js/ui/color-slots.js): Migration custom → customs, Normalisierung, aktiver Slot, Pipette.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_COUNT, normalizeSlots, slotIndex, activeSlot, placeColor } from '../../js/ui/color-slots.js';
import { DEFAULT_CUSTOM_COLORS, DEFAULT_CUSTOM_HL_COLORS, PEN_COLORS, HL_COLORS, isHexColor } from '../../js/config.js';

const D = DEFAULT_CUSTOM_COLORS;

test('Standardfarben: je 3, gültig, verschieden, nicht in der Palette', () => {
  assert.equal(SLOT_COUNT, 3);
  for (const [defs, pal] of [[DEFAULT_CUSTOM_COLORS, PEN_COLORS], [DEFAULT_CUSTOM_HL_COLORS, HL_COLORS]]) {
    assert.equal(defs.length, 3);
    assert.ok(defs.every(isHexColor));
    assert.equal(new Set(defs).size, 3);
    assert.ok(defs.every((c) => !pal.includes(c)));
  }
});

test('ohne gespeicherte Daten: Standardfarben', () => {
  assert.deepEqual(normalizeSlots(undefined, D), D);
  assert.deepEqual(normalizeSlots({}, D), D);
  assert.deepEqual(normalizeSlots({ customs: 'x' }, D), D);
});

test('Migration: alte eigene Farbe wird Slot 1, Rest mit Standardfarben', () => {
  assert.deepEqual(normalizeSlots({ custom: '#00AA55' }, D), ['#00aa55', D[1], D[2]]);
  // alte Farbe gleich einer Standardfarbe: keine doppelten Slots
  assert.deepEqual(normalizeSlots({ custom: D[1] }, D), [D[1], D[0], D[2]]);
  // ungültige alte Farbe wird ignoriert
  assert.deepEqual(normalizeSlots({ custom: 'red' }, D), D);
  // customs hat Vorrang vor custom
  assert.deepEqual(normalizeSlots({ custom: '#123456', customs: ['#abcdef', '#fedcba', '#111111'] }, D), ['#abcdef', '#fedcba', '#111111']);
});

test('Normalisierung: ungültige/fehlende Einträge auffüllen, Kleinschreibung, genau 3', () => {
  assert.deepEqual(normalizeSlots({ customs: ['#ABCDEF'] }, D), ['#abcdef', D[1], D[2]]);
  assert.deepEqual(normalizeSlots({ customs: [null, 5, '#112233', '#445566'] }, D), [D[0], D[1], '#112233']);
  assert.deepEqual(normalizeSlots({ customs: [D[2], D[0], D[1]] }, D), [D[2], D[0], D[1]]);
  // gleiche Farben, die der Nutzer selbst gewählt hat, bleiben erhalten
  assert.deepEqual(normalizeSlots({ customs: ['#000000', '#000000', '#000000'] }, D), ['#000000', '#000000', '#000000']);
});

test('slotIndex', () => {
  assert.equal(slotIndex(2), 2);
  assert.equal(slotIndex(3), 0);
  assert.equal(slotIndex(-1), 0);
  assert.equal(slotIndex('1'), 0);
  assert.equal(slotIndex(undefined), 0);
});

test('aktiver Slot: Hex-Farbe im Slot, bevorzugter Slot bei Gleichstand, Paletten-Index → keiner', () => {
  const c = ['#111111', '#222222', '#111111'];
  assert.equal(activeSlot(c, '#222222'), 1);
  assert.equal(activeSlot(c, '#111111', 2), 2);
  assert.equal(activeSlot(c, '#111111', 1), 0);
  assert.equal(activeSlot(c, '#333333', 0), -1);
  assert.equal(activeSlot(c, 0, 0), -1);
  assert.equal(activeSlot(['#abcdef', D[1], D[2]], '#ABCDEF'), 0);
});

test('Pipette: vorhandene Farbe wählt ihren Slot, neue Farbe kommt in den zuletzt aktiven Slot', () => {
  const c = ['#111111', '#222222', '#333333'];
  assert.deepEqual(placeColor(c, '#333333', 0), { customs: c, slot: 2 });
  assert.deepEqual(placeColor(c, '#ABCDEF', 1), { customs: ['#111111', '#abcdef', '#333333'], slot: 1 });
  assert.deepEqual(placeColor(c, '#abcdef', 7), { customs: ['#abcdef', '#222222', '#333333'], slot: 0 });
  assert.deepEqual(placeColor(c, 2, 1), { customs: c, slot: 1 });
  assert.deepEqual(c, ['#111111', '#222222', '#333333'], 'Eingabe bleibt unverändert');
});
