// Eigener Farbwähler (ganzer RGB-Raum) als Dialog: Farbfeld (Sättigung/Helligkeit), Farbton-Regler, Hex-Feld.
// Ersetzt <input type="color">, dessen Systemdialog sich unter iOS/iPadOS (WebKit, auch Chrome) aus einem
// unsichtbaren Feld heraus nicht zuverlässig öffnen lässt. Bedienbar mit Stift, Finger und Maus (Pointer Events).
// Aufruf: pickColor({title, value: '#rrggbb'}) → Promise<'#rrggbb' | null> (null = abgebrochen).

import { h, dialog } from './dom.js';
import { isHexColor } from '../config.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** h 0..360, s/v 0..1 → '#rrggbb' */
export function hsvToHex(hue, s, v) {
  const f = (n) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

/** '#rrggbb' → {h 0..360, s 0..1, v 0..1} */
export function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { h: hue, s: max ? d / max : 0, v: max };
}

/** Pointer-Ziehen auf el: cb(x 0..1, y 0..1) bei Druck und Bewegung. */
function drag(el, cb) {
  const at = (e) => {
    const r = el.getBoundingClientRect();
    cb(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
  };
  // Scrollen und Markieren verhindern touch-action/user-select in css/editor.css.
  let active = null;
  el.addEventListener('pointerdown', (e) => {
    active = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    at(e);
  });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === active) at(e); });
  const end = (e) => { if (e.pointerId === active) active = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

export async function pickColor({ title = 'Eigene Farbe', value = '#0a8f8f' } = {}) {
  let hsv = hexToHsv(isHexColor(value) ? value.toLowerCase() : '#0a8f8f');
  let hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  const svThumb = h('div', { className: 'cp-thumb' });
  const sv = h('div', { className: 'cp-sv', role: 'slider', 'aria-label': 'Sättigung und Helligkeit' }, svThumb);
  const hueThumb = h('div', { className: 'cp-thumb' });
  const hue = h('div', { className: 'cp-hue', role: 'slider', 'aria-label': 'Farbton' }, hueThumb);
  const preview = h('div', { className: 'cp-preview', 'aria-hidden': 'true' });
  const hexInput = h('input', {
    className: 'input cp-hex', value: hex, maxLength: 7, autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    'aria-label': 'Farbwert (Hex)',
    oninput: () => {
      let t = hexInput.value.trim().toLowerCase();
      if (!t.startsWith('#')) t = '#' + t;
      if (isHexColor(t)) { hsv = hexToHsv(t); hex = t; render(false); }
    },
  });

  function render(updateField = true) {
    sv.style.backgroundColor = hsvToHex(hsv.h, 1, 1);
    svThumb.style.left = hsv.s * 100 + '%';
    svThumb.style.top = (1 - hsv.v) * 100 + '%';
    svThumb.style.background = hex;
    hueThumb.style.left = hsv.h / 360 * 100 + '%';
    hueThumb.style.background = hsvToHex(hsv.h, 1, 1);
    preview.style.background = hex;
    sv.setAttribute('aria-valuetext', hex);
    hue.setAttribute('aria-valuetext', Math.round(hsv.h) + '°');
    if (updateField) hexInput.value = hex;
  }

  drag(sv, (x, y) => { hsv = { h: hsv.h, s: x, v: 1 - y }; hex = hsvToHex(hsv.h, hsv.s, hsv.v); render(); });
  drag(hue, (x) => { hsv = { ...hsv, h: Math.min(x * 360, 359.9) }; hex = hsvToHex(hsv.h, hsv.s, hsv.v); render(); });
  render();

  const r = await dialog({
    title,
    body: h('div', { className: 'cp' }, sv, hue, h('div', { className: 'cp-row' }, preview, hexInput)),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Übernehmen', value: 'ok', primary: true }],
    autofocus: false,
  });
  return r === 'ok' ? hex : null;
}
