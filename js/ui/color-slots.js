// Eigene Farbslots der Werkzeugleiste (js/ui/toolbar.js): reine Funktionen ohne DOM, getestet in test/js/color-slots.test.mjs.
// Pro Farb-Werkzeug (pen, pencil, highlighter) gibt es SLOT_COUNT Slots mit je einer Farbe "#rrggbb" (klein geschrieben),
// gespeichert in localStorage 'notizen:prefs' unter tool.<kind>.customs, der zuletzt aktive Slot unter tool.<kind>.slot.
// Ältere Einstellungen hatten nur eine eigene Farbe (tool.<kind>.custom); sie wird zu Slot 1.

import { isHexColor } from '../config.js';

export const SLOT_COUNT = 3;

const lower = (c) => c.toLowerCase();

/**
 * Slotfarben aus gespeicherten Werkzeug-Einstellungen ({customs?, custom?}) → Array mit genau SLOT_COUNT Hex-Farben.
 * Ungültige oder fehlende Einträge bekommen defaults[i]; steht diese Farbe schon in einem Slot, die erste noch freie Standardfarbe.
 */
export function normalizeSlots(saved, defaults) {
  const src = saved && Array.isArray(saved.customs) ? saved.customs
    : saved && isHexColor(saved.custom) ? [saved.custom] : [];
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) out.push(isHexColor(src[i]) ? lower(src[i]) : null);
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (out[i]) continue;
    const own = lower(defaults[i % defaults.length]);
    out[i] = !out.includes(own) ? own : defaults.map(lower).find((d) => !out.includes(d)) || own;
  }
  return out;
}

/** Gültiger Slot-Index (0 … SLOT_COUNT-1), sonst 0. */
export const slotIndex = (v) => (Number.isInteger(v) && v >= 0 && v < SLOT_COUNT ? v : 0);

/**
 * Aktiver Slot für eine Werkzeugfarbe: -1, wenn die Farbe ein Paletten-Index ist oder in keinem Slot steht.
 * Stehen mehrere Slots auf derselben Farbe, gewinnt `preferred` (der zuletzt aktive Slot).
 */
export function activeSlot(customs, color, preferred = 0) {
  if (!isHexColor(color)) return -1;
  const c = lower(color);
  if (customs[slotIndex(preferred)] === c) return slotIndex(preferred);
  return customs.indexOf(c);
}

/**
 * Hex-Farbe in die Slots übernehmen (z. B. Pipette): steht sie schon in einem Slot, wird dieser aktiv;
 * sonst wird sie in den zuletzt aktiven Slot `preferred` geschrieben. Liefert {customs (neues Array), slot}.
 */
export function placeColor(customs, color, preferred = 0) {
  const next = customs.slice();
  if (!isHexColor(color)) return { customs: next, slot: slotIndex(preferred) };
  const c = lower(color);
  const hit = activeSlot(next, c, preferred);
  if (hit >= 0) return { customs: next, slot: hit };
  const slot = slotIndex(preferred);
  next[slot] = c;
  return { customs: next, slot };
}
