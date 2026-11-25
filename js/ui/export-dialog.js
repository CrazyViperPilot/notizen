// Dialoge für das Titelblatt und den PDF-Export. Gestaltung: css/export.css. Benutzertexte nur per textContent/Attribut.
//   openExportDialog({title, size, orient}) → Promise null | {pdfa, cover: null | {template, fields}, pageNumbers, outline}
//   openCoverDialog({title, size, orient}) → Promise null | {template, fields}   („Titelblatt einfügen“, nur das Titelblatt)
//   askPdfOptions(title, firstPage) → Promise null | {pdfa, cover: Cover-Objekt | null, pageNumbers, outline} für notePdf
// Die letzte Wahl steht in localStorage 'notizen:export' (ohne Titel und Datum).

import { h, dialog } from './dom.js';
import { SIZES, TEMPLATES, FIELD_LABELS, buildCover, drawCoverPreview, todayDe } from '../export/cover.js';

const KEY = 'notizen:export';
const PREVIEW_MS = 150;
const MAX_LEN = 200;
const CANVAS_PX = 480;   // Auflösung der Vorschau (Anzeige höchstens 240 px breit)

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

function readLast() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

function writeLast(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* privater Modus */ }
}

/** Größe und Ausrichtung absichern (unbekannt → A4, Hochformat). */
function pageOf(size, orient) {
  return { sz: has(SIZES, size) ? size : 'a4', o: orient === 'l' ? 'l' : 'p' };
}

/**
 * Titelblatt-Teil (Vorlagenwahl, Felder, Live-Vorschau), gemeinsam für beide Dialoge.
 * → {section, updatePreview, cancel(), result(), keep()}
 *   result(): {template, fields} mit den Feldern der gewählten Vorlage (getrimmt)
 *   keep():   Feldwerte ohne Titel und Datum (für die Merkliste)
 */
function createCoverPart({ title, sz, o, last, hidden }) {
  const base = SIZES[sz];
  const pageW = o === 'l' ? base.h : base.w;
  const pageH = o === 'l' ? base.w : base.h;

  const state = {
    template: TEMPLATES.some((t) => t.id === last.template) ? last.template : TEMPLATES[0].id,
  };

  // Feldwerte: Titel vom Notizen-Titel, Datum heute, übrige aus der letzten Wahl
  const saved = last.fields && typeof last.fields === 'object' ? last.fields : {};
  const vals = {};
  for (const k of Object.keys(FIELD_LABELS)) {
    if (k === 'title') vals[k] = String(title || '').slice(0, MAX_LEN);
    else if (k === 'date') vals[k] = todayDe();
    else vals[k] = typeof saved[k] === 'string' ? saved[k].slice(0, MAX_LEN) : '';
  }

  const tplOf = () => TEMPLATES.find((t) => t.id === state.template) || TEMPLATES[0];
  const fieldValues = () => {
    const fields = {};
    for (const k of tplOf().fields) fields[k] = (vals[k] || '').trim();
    return fields;
  };

  // ── Vorschau ──
  const canvas = h('canvas', {
    className: 'exp-preview', width: CANVAS_PX, height: Math.round(CANVAS_PX * pageH / pageW),
    role: 'img', 'aria-label': 'Vorschau des Titelblatts',
  });
  let timer = 0;
  function updatePreview() {
    try {
      drawCoverPreview(canvas, buildCover(state.template, fieldValues(), { size: sz, orient: o }));
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

  const section = h('div', { className: 'exp-cover', hidden }, tplGroup, canvas, fieldsBox);

  markTpl();
  renderFields();
  updatePreview();

  return {
    section,
    updatePreview,
    cancel() { clearTimeout(timer); },
    result() { return { template: state.template, fields: fieldValues() }; },
    keep() {
      const keep = {};
      for (const k of Object.keys(vals)) if (k !== 'title' && k !== 'date') keep[k] = vals[k];
      return keep;
    },
  };
}

/**
 * Export-Dialog „Als PDF exportieren“: Titelblatt (ein/aus), Seitenzahlen, Lesezeichen, PDF/A.
 * title: Notiztitel, wird als Titel des Titelblatts vorbelegt. → null (abgebrochen) oder
 * {pdfa, cover: null | {template, fields}, pageNumbers, outline}.
 */
export async function openExportDialog({ title = '', size = 'a4', orient = 'p' } = {}) {
  const { sz, o } = pageOf(size, orient);
  const last = readLast();
  const state = {
    cover: last.cover === true,
    pdfa: last.pdfa === true,
    pageNumbers: last.pageNumbers === true,
    outline: last.outline !== false,   // Standard: an
  };
  const part = createCoverPart({ title, sz, o, last, hidden: !state.cover });

  const coverBox = h('input', {
    type: 'checkbox', checked: state.cover,
    onchange: () => {
      state.cover = coverBox.checked;
      part.section.hidden = !state.cover;
      if (state.cover) part.updatePreview();
    },
  });
  const pageNumBox = h('input', {
    type: 'checkbox', checked: state.pageNumbers,
    onchange: () => { state.pageNumbers = pageNumBox.checked; },
  });
  const outlineBox = h('input', {
    type: 'checkbox', checked: state.outline,
    onchange: () => { state.outline = outlineBox.checked; },
  });
  const pdfaBox = h('input', {
    type: 'checkbox', checked: state.pdfa, 'aria-describedby': 'exp-pdfa-hint',
    onchange: () => { state.pdfa = pdfaBox.checked; },
  });

  const body = h('div', { className: 'exp' },
    h('label', { className: 'exp-check' }, coverBox, h('span', { text: 'Titelblatt voranstellen' })),
    part.section,
    h('label', { className: 'exp-check' }, pageNumBox, h('span', { text: 'Seitenzahlen' })),
    h('label', { className: 'exp-check' }, outlineBox, h('span', { text: 'Lesezeichen (Inhaltsverzeichnis)' })),
    h('label', { className: 'exp-check' }, pdfaBox, h('span', { text: 'PDF/A (Archivformat)' })),
    h('p', { className: 'exp-hint', id: 'exp-pdfa-hint', text: 'Für Langzeitarchivierung, z. B. Abgaben und Behörden.' }));

  const choice = await dialog({
    title: 'Als PDF exportieren',
    body,
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Exportieren', value: 'ok', primary: true }],
  });
  part.cancel();
  if (choice !== 'ok') return null;

  // Letzte Wahl merken: ohne Titel und Datum
  const sel = part.result();
  writeLast({
    ...last,
    cover: state.cover,
    template: sel.template,
    pdfa: state.pdfa,
    pageNumbers: state.pageNumbers,
    outline: state.outline,
    fields: part.keep(),
  });
  return {
    pdfa: state.pdfa,
    cover: state.cover ? sel : null,
    pageNumbers: state.pageNumbers,
    outline: state.outline,
  };
}

/**
 * Nur das Titelblatt („Titelblatt einfügen“): vorbelegter Titel, Vorlage, Felder, Live-Vorschau.
 * → null (abgebrochen) oder {template, fields} für buildCover(template, fields, {size, orient}).
 * Merkt Vorlage und Felder in 'notizen:export' (wie der Export-Dialog), die übrigen Werte bleiben.
 */
export async function openCoverDialog({ title = '', size = 'a4', orient = 'p' } = {}) {
  const { sz, o } = pageOf(size, orient);
  const last = readLast();
  const part = createCoverPart({ title, sz, o, last, hidden: false });

  const choice = await dialog({
    title: 'Titelblatt einfügen',
    body: h('div', { className: 'exp' }, part.section),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Einfügen', value: 'ok', primary: true }],
  });
  part.cancel();
  if (choice !== 'ok') return null;

  const sel = part.result();
  writeLast({ ...last, template: sel.template, fields: part.keep() });
  return sel;
}

/**
 * Fragt die Export-Optionen ab und baut das Titelblatt. firstPage: erste Seite der Notiz (Format und Ausrichtung des
 * Titelblatts). → null (abgebrochen) oder {pdfa, cover, pageNumbers, outline}; cover ist ein Cover-Objekt für notePdf
 * oder null.
 */
export async function askPdfOptions(title, firstPage = null) {
  const size = firstPage && has(SIZES, firstPage.size) ? firstPage.size : 'a4';
  const orient = firstPage && firstPage.orient === 'l' ? 'l' : 'p';
  const r = await openExportDialog({ title, size, orient });
  if (!r) return null;
  const cover = r.cover ? buildCover(r.cover.template, r.cover.fields, { size, orient }) : null;
  return { pdfa: !!r.pdfa, cover, pageNumbers: !!r.pageNumbers, outline: !!r.outline };
}
