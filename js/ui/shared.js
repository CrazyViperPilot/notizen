// „Mit mir geteilt“ (Übersicht) und Leseansicht einer geteilten Notiz. Schnittstellen: docs/ARCHITEKTUR.md 4 (shared_tree,
// shared_pages) und 7.1 (surface readOnly). Zwischenspeicher: model.sharedCache (Store `shared`, nur lesen, kein Sync-Ziel).

import { api, ApiError } from '../api.js';
import { h, toast, relTime } from './dom.js';
import { createSurface } from '../ink/surface.js';

const ID_RE = /^[0-9a-f-]{36}$/;            // wie der Router in app.js
const OFFLINE_HINT = 'Offline – zuletzt geladener Stand';

/** Reads the cache; never throws (the database may not be open). */
async function cacheGet(ctx, key) {
  try { return (await ctx.model.sharedCache.get(key)) || null; } catch { return null; }
}

/** Writes the cache in the background; never throws. */
function cachePut(ctx, key, value) {
  try { ctx.model.sharedCache.put(key, value).catch(() => {}); } catch { /* ignore */ }
}

function errorText(e) {
  if (e instanceof ApiError && e.message) return e.message;
  return 'Das hat nicht geklappt. Bitte später noch einmal versuchen.';
}

// ───────────── Übersicht „Mit mir geteilt“ ─────────────

/** Mounts the list of everything shared with the user. Returns the unmount function. */
export async function mountShared(el, params, ctx) {
  let alive = true;
  const hint = h('p', { className: 'shared-hint' });
  hint.hidden = true;
  const body = h('div', { className: 'shared-body' }, h('p', { className: 'muted', text: 'Lade …' }));
  el.replaceChildren(
    h('header', { className: 'shared-head' },
      h('button', { className: 'btn ghost', type: 'button', text: '‹ Übersicht', onclick: () => ctx.navigate('#/') }),
      h('h1', { text: 'Mit mir geteilt' })),
    hint,
    body);

  load();
  return () => { alive = false; };

  async function load() {
    let owners = null;
    try {
      const r = await api.get('shared_tree');
      owners = Array.isArray(r.owners) ? r.owners : [];
      cachePut(ctx, 'tree', { owners });
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 0) {
        const cached = await cacheGet(ctx, 'tree');
        if (!alive) return;
        if (cached && Array.isArray(cached.owners)) {
          owners = cached.owners;
          hint.textContent = OFFLINE_HINT;
          hint.hidden = false;
        } else {
          body.replaceChildren(h('p', { className: 'error-text', text: 'Offline – und noch nichts zwischengespeichert.' }));
          return;
        }
      } else {
        body.replaceChildren(h('p', { className: 'error-text', text: errorText(e) }));
        return;
      }
    }
    if (!alive) return;
    render(owners);
  }

  function render(owners) {
    const groups = owners.map(ownerGroup).filter(Boolean);
    if (!groups.length) {
      body.replaceChildren(h('p', { className: 'shared-empty muted', text: 'Noch nichts mit dir geteilt.' }));
      return;
    }
    body.replaceChildren(...groups);
  }
}

/** One group per owner, or null if nothing of the owner is visible. */
function ownerGroup(o) {
  const folders = Array.isArray(o.folders) ? o.folders : [];
  const notes = Array.isArray(o.notes) ? o.notes : [];
  if (!folders.length && !notes.length) return null;
  const idx = indexTree(folders, notes);
  const name = o.owner && o.owner.display_name ? o.owner.display_name : 'unbekannt';
  return h('section', { className: 'shared-group' },
    h('h2', { className: 'shared-owner', text: 'von ' + name }),
    childrenNode(idx, '', new Set()));
}

/**
 * Groups folders and notes by parent. Parents that are not in the list count as root (key '').
 * Folders sorted by name, notes by last change (newest first).
 */
function indexTree(folders, notes) {
  const ids = new Set(folders.map((f) => f.id));
  const key = (parent) => (parent && ids.has(parent) ? parent : '');
  const folderKids = new Map();
  const noteKids = new Map();
  for (const f of folders) push(folderKids, key(f.parent_id), f);
  for (const n of notes) push(noteKids, key(n.folder_id), n);
  for (const list of folderKids.values()) list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de'));
  for (const list of noteKids.values()) list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return { folderKids, noteKids };
}

function push(map, k, v) {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

/** Folders (collapsible, recursive) and notes below parentKey. seen guards against cycles in the data. */
function childrenNode(idx, parentKey, seen) {
  const out = [];
  for (const f of idx.folderKids.get(parentKey) || []) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(h('details', { className: 'shared-folder', open: true },
      h('summary', { text: f.name || 'Ohne Name' }),
      childrenNode(idx, f.id, seen)));
  }
  for (const n of idx.noteKids.get(parentKey) || []) out.push(noteLink(n));
  return h('div', { className: 'shared-children' }, out);
}

function noteLink(n) {
  if (typeof n.id !== 'string' || !ID_RE.test(n.id)) return null;
  return h('a', { className: 'shared-note', href: '#/shared/n/' + n.id },
    h('span', { className: 'shared-note-title', text: n.title || 'Ohne Titel' }),
    h('span', { className: 'shared-note-meta', text: relTime(n.updated_at) }));
}

// ───────────── Leseansicht einer geteilten Notiz ─────────────

/** Read-only view of one shared note. Returns the unmount function (destroys the surface). */
export async function mountSharedNote(el, { noteId }, ctx) {
  let alive = true;
  let note = null;
  let pages = [];
  let busy = false;
  // Abgabe/Korrektur: wer mit „Korrigieren“ freigegeben bekam, schreibt in eine eigene Ebene (correction_save).
  let canReview = false;
  let reviewing = false;
  let corr = new Map();                 // pageId → eigene Korrektur-Striche (String)

  const title = h('h1', { className: 'shared-title', text: 'Notiz' });
  const counter = h('span', { className: 'shared-count muted', text: '' });
  const pdfBtn = h('button', { className: 'btn', type: 'button', text: 'PDF', disabled: true, onclick: exportPdf });
  const hint = h('p', { className: 'shared-hint' });
  hint.hidden = true;
  const msg = h('div', { className: 'shared-message' });
  msg.hidden = true;
  const canvas = h('div', { className: 'shared-canvas' });
  const badge = h('span', { className: 'shared-badge', text: 'Nur lesen' });
  const reviewBtn = h('button', { className: 'btn', type: 'button', text: 'Korrigieren', hidden: true, 'aria-pressed': 'false', onclick: () => setReview(!reviewing) });
  // Korrektur-Werkzeuge: Rotstift, Grün, Textmarker, Radierer (nur die eigene Korrektur-Ebene)
  const TOOLS = [
    ['Rotstift', { kind: 'pen', color: '#d0342c', width: 1 }],
    ['Grün', { kind: 'pen', color: '#1e8449', width: 1 }],
    ['Markieren', { kind: 'highlighter', color: 0, width: 0 }],
    ['Radierer', { kind: 'eraser', mode: 'stroke' }],
  ];
  const toolBtns = TOOLS.map(([label, tool], i) => h('button', {
    className: 'btn' + (i === 0 ? ' on' : ''), type: 'button', text: label, 'aria-pressed': i === 0 ? 'true' : 'false',
    onclick: () => pickTool(i),
  }));
  const reviewBar = h('div', { className: 'shared-review-bar', role: 'toolbar', 'aria-label': 'Korrigieren', hidden: true },
    ...toolBtns,
    h('button', { className: 'btn', type: 'button', text: '↶', title: 'Rückgängig', 'aria-label': 'Rückgängig', onclick: () => surface.undo() }));

  el.replaceChildren(
    h('header', { className: 'shared-head' },
      h('button', { className: 'btn ghost', type: 'button', text: '‹ Zurück', onclick: () => ctx.navigate('#/shared') }),
      title,
      badge,
      counter,
      reviewBtn,
      pdfBtn),
    reviewBar,
    hint,
    msg,
    canvas);

  // Hintergrundbilder (ARCHITEKTUR 10.1): lokal bzw. per asset_get mit note (Lesezugriff auf die geteilte Notiz)
  let fingerDraw = false;   // wie im Editor (Konto-Einstellung „Mit Finger/Maus zeichnen“), wirkt nur beim Korrigieren
  try { const p = JSON.parse(localStorage.getItem('notizen:prefs')); fingerDraw = !!(p && p.fingerDraw); } catch { /* keine */ }
  const surface = createSurface(canvas, { readOnly: true, fingerDraw, getImage: (id) => ctx.model.getImage(id, { noteId, store: false }) });
  surface.addEventListener('pagechange', onPage);
  surface.addEventListener('strokes', onStrokes);

  load();
  return () => {
    alive = false;
    surface.removeEventListener('pagechange', onPage);
    surface.removeEventListener('strokes', onStrokes);
    surface.flush();
    surface.destroy();
  };

  function pickTool(i) {
    toolBtns.forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-pressed', k === i ? 'true' : 'false'); });
    surface.setTool(TOOLS[i][1]);
  }

  /** Korrektur einer Seite speichern (nur online). */
  function onStrokes(e) {
    if (!reviewing) return;
    const { pageId, strokes } = e.detail;
    corr.set(pageId, strokes);
    api.post('correction_save', { note: noteId, page: pageId, strokes })
      .catch((err) => toast(err instanceof ApiError && err.status === 0 ? 'Offline – Korrektur nicht gespeichert.' : errorText(err), { type: 'error' }));
  }

  async function loadCorrections() {
    try {
      const r = await api.get('correction_get', { note: noteId });
      canReview = !!r.can_review;
      corr = new Map((r.corrections || []).map((c) => [c.page_id, c.strokes]));
    } catch { /* offline: ohne Korrekturen */ }
  }

  /** Seiten für die Fläche: lesen = Seite + eigene Korrektur obenauf; korrigieren = Korrektur editierbar, Seite darunter. */
  function viewPages() {
    return pages.map((p) => (reviewing
      ? { ...p, strokes: corr.get(p.id) || '[]', under: p.strokes }
      : { ...p, over: corr.get(p.id) || '' }));
  }

  function setReview(on) {
    if (on && !canReview) return;
    surface.flush();
    reviewing = !!on;
    reviewBtn.setAttribute('aria-pressed', reviewing ? 'true' : 'false');
    reviewBtn.classList.toggle('on', reviewing);
    reviewBtn.textContent = reviewing ? 'Fertig' : 'Korrigieren';
    badge.textContent = reviewing ? 'Korrigieren' : 'Nur lesen';
    reviewBar.hidden = !reviewing;
    surface.setReadOnly(!reviewing);
    if (reviewing) pickTool(0);
    surface.setPages(viewPages(), { keepView: true });
  }

  function onPage(e) {
    showCount(e.detail && e.detail.pageId);
  }

  function showCount(pageId) {
    if (!pages.length) { counter.textContent = '0 / 0'; return; }
    const i = Math.max(0, pages.findIndex((p) => p.id === pageId));
    counter.textContent = (i + 1) + ' / ' + pages.length;
  }

  async function load() {
    try {
      const data = await api.get('shared_pages', { note: noteId });
      if (!alive) return;
      cachePut(ctx, 'note:' + noteId, data);
      show(data, null);
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 0) {
        const cached = await cacheGet(ctx, 'note:' + noteId);
        if (!alive) return;
        if (cached && cached.note) show(cached, OFFLINE_HINT);
        else showMessage('Offline – diese Notiz ist noch nicht zwischengespeichert.');
      } else if (e instanceof ApiError && e.status === 404) {
        showMessage('Diese Notiz ist nicht mehr geteilt.');
      } else {
        showMessage(errorText(e));
      }
    }
  }

  function show(data, hintText) {
    note = data.note || {};
    pages = Array.isArray(data.pages) ? data.pages : [];
    title.textContent = note.title || 'Ohne Titel';
    msg.hidden = true;
    canvas.hidden = false;
    canReview = !!data.can_review;
    reviewBtn.hidden = !canReview;
    surface.setPages(viewPages());
    pdfBtn.disabled = false;
    loadCorrections().then(() => {
      if (!alive) return;
      reviewBtn.hidden = !canReview;
      if (!canReview && reviewing) setReview(false);
      else surface.setPages(viewPages(), { keepView: true });
    });
    showCount(pages.length ? pages[0].id : null);
    hint.textContent = hintText || '';
    hint.hidden = !hintText;
  }

  function showMessage(text) {
    note = null;
    pages = [];
    title.textContent = 'Notiz';
    counter.textContent = '';
    msg.replaceChildren(h('p', { className: 'error-text', text }));
    msg.hidden = false;
    canvas.hidden = true;
    pdfBtn.disabled = true;
    hint.hidden = true;
  }

  async function exportPdf() {
    if (busy || !note) return;
    busy = true;
    pdfBtn.disabled = true;
    try {
      let pdf;
      let save;
      let exp;
      try {
        pdf = await import('../export/pdf.js');
        save = await import('../export/save.js');
        exp = await import('./export-dialog.js');
      } catch {
        toast('PDF-Export kommt bald');
        return;
      }
      try {
        // Hintergrundbilder immer über den Server mit note (Lesezugriff); nicht ladbar → Seite ohne Bild
        const getAssetBytes = async (id) => {
          try {
            const local = await ctx.model.getAsset(id); // cached by getImage → also works offline
            if (local && local.blob) return new Uint8Array(await local.blob.arrayBuffer());
            const b = await api.blob('asset_get', { id, note: noteId });
            return new Uint8Array(await b.arrayBuffer());
          } catch {
            return null;
          }
        };
        const opts = await exp.askPdfOptions(note.title, pages[0] || null);   // Titelblatt, PDF/A
        if (!opts) return;
        surface.flush();
        const rows = pages.map((p) => ({ ...p, over: corr.get(p.id) || '' }));
        let numberImage = null;
        if (opts.pageNumbers) {
          const cov = await import('../export/cover.js');
          numberImage = (text) => cov.pageNumberImage(text);
        }
        const blob = await pdf.notePdf(note, rows, {
          getAssetBytes, cover: opts.cover, pdfa: opts.pdfa, outline: opts.outline !== false, numberImage,
        });
        await save.saveFile(blob, fileName(note.title) + '.pdf');
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // Teilen-Menü abgebrochen
        console.error(e);
        toast('PDF konnte nicht erstellt werden.', { type: 'error' });
      }
    } finally {
      busy = false;
      if (alive && note) pdfBtn.disabled = false;
    }
  }
}

/** Dateiname ohne Zeichen, die Dateisysteme nicht mögen. */
function fileName(title) {
  const t = String(title || '').replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return t || 'Notiz';
}
