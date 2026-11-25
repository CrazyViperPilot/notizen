// Dialog „Als PDF exportieren“: Titelblatt (Vorlage, Felder, Live-Vorschau) und PDF/A. Einstieg: openExportDialog(opts)
// → Promise: null (abgebrochen) oder {pdfa, cover: null | {template, fields}}. Gestaltung: css/export.css.
// Die letzte Wahl steht in localStorage 'notizen:export' (ohne Titel und Datum). Benutzertexte nur per textContent/Attribut.

import { h, dialog } from './dom.js';
import { SIZES, TEMPLATES, FIELD_LABELS, buildCover, drawCoverPreview, todayDe } from '../export/cover.js';

const KEY = 'notizen:export';
const PREVIEW_MS = 150;
const MAX_LEN = 200;
const CANVAS_PX = 480;   // Auflösung der Vorschau (Anzeige höchstens 240 px breit)

function readLast() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

function writeLast(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* privater Modus */ }
}

/**
 * openExportDialog({title, size = 'a4', orient = 'p'}) → Promise<null | {pdfa, cover}>
 * title: Notiztitel, wird als Titel des Titelblatts vorbelegt.
 */
export async function openExportDialog({ title = '', size = 'a4', orient = 'p' } = {}) {
  const sz = Object.prototype.hasOwnProperty.call(SIZES, size) ? size : 'a4';
  const o = orient === 'l' ? 'l' : 'p';
  const base = SIZES[sz];
  const pageW = o === 'l' ? base.h : base.w;
  const pageH = o === 'l' ? base.w : base.h;

  const last = readLast();
  const state = {
    cover: last.cover === true,
    template: TEMPLATES.some((t) => t.id === last.template) ? last.template : TEMPLATES[0].id,
    pdfa: last.pdfa === true,
  };

  // Feldwerte: Titel vom Notizen-Titel, Datum heute, übrige aus dem letzten Export
  const saved = last.fields && typeof last.fields === 'object' ? last.fields : {};
  const vals = {};
  for (const k of Object.keys(FIELD_LABELS)) {
    if (k === 'title') vals[k] = String(title || '').slice(0, MAX_LEN);
    else if (k === 'date') vals[k] = todayDe();
    else vals[k] = typeof saved[k] === 'string' ? saved[k].slice(0, MAX_LEN) : '';
  }

  const tplOf = () => TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];

  // ── Vorschau ──
  const canvas = h('canvas', {
    className: 'exp-preview', width: CANVAS_PX, height: Math.round(CANVAS_PX * pageH / pageW),
    role: 'img', 'aria-label': 'Vorschau des Titelblatts',
  });
  let timer = 0;
  function updatePreview() {
    try {
      const fields = {};
      for (const k of tplOf().fields) fields[k] = (vals[k] || '').trim();
      drawCoverPreview(canvas, buildCover(state.template, fields, { size: sz, orient: o }));
    } catch { /* Vorschau ist nur Hilfe */ }
  }
  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(updatePreview, PREVIEW_MS);
  }

  // ── Felder der gewählten Vorlage ──
  const fieldsBox = h('div', { className: 'exp-fields' });
  function renderFields() {
    fieldsBox.replaceChildren(...tplOf().fields.map((k) => {
      const inp = h('input', {
        className: 'input', type: 'text', value: vals[k], maxLength: MAX_LEN,
        autocomplete: 'off', autocapitalize: 'sentences',
        oninput: () => { vals[k] = inp.value; schedulePreview(); },
      });
      return h('label', { className: 'field' }, h('span', { text: FIELD_LABELS[k] }), inp);
    }));
  }

  // ── Vorlagenwahl (Segmente) ──
  const tplBtns = new Map();
  function markTpl() {
    for (const [id, b] of tplBtns) {
      const on = id === state.template;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  const tplGroup = h('div', { className: 'exp-seg', role: 'radiogroup', 'aria-label': 'Vorlage' },
    TEMPLATES.map((t) => {
      const b = h('button', {
        type: 'button', role: 'radio', text: t.name,
        onclick: () => { state.template = t.id; markTpl(); renderFields(); schedulePreview(); },
      });
      tplBtns.set(t.id, b);
      return b;
    }));

  // ── Schalter ──
  const coverSection = h('div', { className: 'exp-cover', hidden: !state.cover },
    tplGroup, canvas, fieldsBox);
  const coverBox = h('input', {
    type: 'checkbox', checked: state.cover,
    onchange: () => {
      state.cover = coverBox.checked;
      coverSection.hidden = !state.cover;
      if (state.cover) updatePreview();
    },
  });
  const pdfaBox = h('input', {
    type: 'checkbox', checked: state.pdfa, 'aria-describedby': 'exp-pdfa-hint',
    onchange: () => { state.pdfa = pdfaBox.checked; },
  });

  markTpl();
  renderFields();
  updatePreview();

  const body = h('div', { className: 'exp' },
    h('label', { className: 'exp-check' }, coverBox, h('span', { text: 'Titelblatt voranstellen' })),
    coverSection,
    h('label', { className: 'exp-check' }, pdfaBox, h('span', { text: 'PDF/A (Archivformat)' })),
    h('p', { className: 'exp-hint', id: 'exp-pdfa-hint', text: 'Für Langzeitarchivierung, z. B. Abgaben und Behörden.' }));

  const choice = await dialog({
    title: 'Als PDF exportieren',
    body,
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Exportieren', value: 'ok', primary: true }],
  });
  clearTimeout(timer);
  if (choice !== 'ok') return null;

  // Letzte Wahl merken: ohne Titel und Datum
  const keep = {};
  for (const k of Object.keys(vals)) if (k !== 'title' && k !== 'date') keep[k] = vals[k];
  writeLast({ cover: state.cover, template: state.template, pdfa: state.pdfa, fields: keep });

  let cover = null;
  if (state.cover) {
    const fields = {};
    for (const k of tplOf().fields) fields[k] = (vals[k] || '').trim();
    cover = { template: state.template, fields };
  }
  return { pdfa: state.pdfa, cover };
}

/**
 * Fragt die Export-Optionen ab und baut das Titelblatt. firstPage: erste Seite der Notiz (Format und Ausrichtung des
 * Titelblatts). → null (abgebrochen) oder {pdfa, cover} mit cover als Cover-Objekt für notePdf oder null.
 */
export async function askPdfOptions(title, firstPage = null) {
  const size = firstPage && Object.prototype.hasOwnProperty.call(SIZES, firstPage.size) ? firstPage.size : 'a4';
  const orient = firstPage && firstPage.orient === 'l' ? 'l' : 'p';
  const r = await openExportDialog({ title, size, orient });
  if (!r) return null;
  const cover = r.cover ? buildCover(r.cover.template, r.cover.fields, { size, orient }) : null;
  return { pdfa: !!r.pdfa, cover };
}
