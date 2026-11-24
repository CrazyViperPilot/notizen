// Editor view: loads one note, connects the ink surface (js/ink/surface.js) with the local model
// (js/model.js) and keeps the pages in sync with changes from sync or other views. See PRD 6, ARCHITEKTUR 7.1/7.2.
//
// Pages whose strokes are not downloaded yet (strokes === null) show as blank with a hint. Strokes drawn on such a
// page are kept as a draft and merged with the server strokes once the page arrives (never overwrite server data).

import * as model from '../model.js';
import { api } from '../api.js';
import { createSurface } from '../ink/surface.js';
import { decodeStrokes, encodeStrokes } from '../ink/codec.js';
import { createToolbar } from './toolbar.js';
import { h, toast, confirmDialog, dialog } from './dom.js';
import { pickColor } from './colorpicker.js';
import { PEN_COLORS, PEN_COLOR_NAMES, HL_COLORS, HL_COLOR_NAMES, DEFAULT_CUSTOM_COLOR, DEFAULT_CUSTOM_HL_COLOR } from '../config.js';

const PREFS_KEY = 'notizen:prefs';
const RELOAD_MS = 300;

function smoothingPref() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    return p && ['direct', 'normal', 'strong'].includes(p.smoothing) ? p.smoothing : 'normal';
  } catch { return 'normal'; }
}

function fingerDrawPref() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    return !!(p && p.fingerDraw);
  } catch { return false; }
}

/** true if the note is missing, deleted, or inside a deleted folder. */
async function isGone(n) {
  if (!n || n.deleted_at || n.purged) return true;
  let fid = n.folder_id;
  for (let i = 0; fid && i < 100; i++) {
    const f = await model.getFolder(fid);
    if (!f) break;            // unknown folder: treated as top level (like the library)
    if (f.deleted_at) return true;
    fid = f.parent_id;
  }
  return false;
}

function fileName(title) {
  const base = String(title || 'Notiz').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 100) || 'Notiz';
  return base + '.pdf';
}

/** mountEditor(el, {noteId}, ctx) → unmount */
export async function mountEditor(el, { noteId }, ctx) {
  let note = await model.getNote(noteId);
  if (await isGone(note)) {
    toast('Diese Notiz ist nicht mehr vorhanden.', { type: 'error' });
    ctx.navigate('#/');
    return () => {};
  }

  // ───── layout ─────
  // The callbacks below only run on user action, so `surface` may be declared after the toolbar.
  el.classList.add('editor');
  const toolbar = createToolbar({
    onTool: (tool) => surface.setTool(tool),
    onUndo: () => surface.undo(),
    onRedo: () => surface.redo(),
    onBack: () => ctx.navigate(note && note.folder_id ? '#/f/' + note.folder_id : '#/'),
    onTitle: async (t) => {
      try { await model.renameNote(noteId, t); } catch (e) { console.error(e); toast('Umbenennen fehlgeschlagen', { type: 'error' }); }
    },
    onPageMenu: (action, value) => pageMenu(action, value),
    onAddPage: () => addPage(),
    onQuiz: () => (quizSide ? stopQuiz() : startQuiz('right')),
  });
  const holder = h('div', { className: 'ed-surface' });
  const hint = h('div', { className: 'ed-hint', role: 'status', hidden: true, text: 'Seite wird geladen…' });
  // Vocabulary quiz: covers one column of the vocab pages, tapping a row reveals it.
  let quizSide = null;
  const quizSwap = h('button', { type: 'button', className: 'btn', onclick: () => startQuiz(quizSide === 'right' ? 'left' : 'right') });
  const quizCount = h('span', { className: 'quiz-count', 'aria-live': 'polite' });
  const quizRound = h('span', { className: 'quiz-count quiz-round' });
  let roundRight = 0, roundWrong = 0;
  // Shown while a row is revealed: did she know it?
  const quizAnswer = h('div', { className: 'quiz-answer', hidden: true },
    h('button', { type: 'button', className: 'btn quiz-yes', text: '✓ Gewusst', onclick: () => answer(true) }),
    h('button', { type: 'button', className: 'btn quiz-no', text: '✗ Nicht gewusst', onclick: () => answer(false) }));
  const quizBar = h('div', { className: 'quiz-bar', role: 'toolbar', 'aria-label': 'Abfragen', hidden: true },
    h('span', { className: 'quiz-title', text: 'Abfragen' }),
    quizCount,
    quizRound,
    quizAnswer,
    h('button', { type: 'button', className: 'btn primary', text: 'Nächste', title: 'Zufällige Vokabel abfragen', onclick: () => quizNext() }),
    quizSwap,
    h('button', { type: 'button', className: 'btn', text: 'Alle aufdecken', onclick: () => { quizAnswer.hidden = true; surface.quizAll(true); } }),
    h('button', { type: 'button', className: 'btn', text: 'Alle zudecken', onclick: () => { quizAnswer.hidden = true; surface.quizAll(false); } }),
    h('button', { type: 'button', className: 'btn primary', text: 'Fertig', onclick: () => stopQuiz() }));
  el.replaceChildren(toolbar.el, h('div', { className: 'ed-body' }, holder, hint, quizBar));

  // ───── lasso selection: action bar above the selection ─────
  const selBar = h('div', { className: 'sel-bar', role: 'toolbar', 'aria-label': 'Auswahl', hidden: true });
  el.querySelector('.ed-body').append(selBar);
  let selInfo = null;

  function renderSelBar(info) {
    selInfo = info;
    if (!info) { selBar.hidden = true; return; }
    selBar.replaceChildren(
      h('button', { type: 'button', className: 'btn', text: 'Farbe', onclick: () => pickSelColor() }),
      h('button', { type: 'button', className: 'btn', text: 'Duplizieren', onclick: () => surface.selectionAction('duplicate') }),
      h('button', { type: 'button', className: 'btn', text: 'Löschen', onclick: () => surface.selectionAction('delete') }));
    selBar.hidden = false;
    const r = info.rect;
    const bodyW = holder.clientWidth;
    selBar.style.left = Math.max(130, Math.min(bodyW - 130, r.x + r.w / 2)) + 'px';
    selBar.style.top = Math.max(56, r.y - 12) + 'px';
  }

  async function pickSelColor() {
    if (!selInfo) return;
    const type = selInfo.hasPen ? 'p' : 'h';
    const list = type === 'p' ? PEN_COLORS : HL_COLORS;
    const names = type === 'p' ? PEN_COLOR_NAMES : HL_COLOR_NAMES;
    const r = await dialog({
      title: type === 'p' ? 'Farbe der Auswahl' : 'Farbe der Markierung',
      body: (close) => h('div', { className: 'sel-colors' },
        list.map((c, i) => h('button', { type: 'button', className: 'sw', title: names[i], 'aria-label': names[i], style: { background: c }, onclick: () => close(i) })),
        h('button', { type: 'button', className: 'sw', title: 'Eigene Farbe', 'aria-label': 'Eigene Farbe',
          style: { background: 'conic-gradient(#ff3b30, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30)' },
          onclick: () => close('custom') })),
      actions: [{ label: 'Abbrechen', value: null }],
    });
    if (r === null || r === undefined) return;
    if (r !== 'custom') { surface.selectionAction('color', r, type); return; }
    const hex = await pickColor({ title: 'Eigene Farbe der Auswahl', value: type === 'p' ? DEFAULT_CUSTOM_COLOR : DEFAULT_CUSTOM_HL_COLOR });
    if (hex && selInfo) surface.selectionAction('color', hex, type);
  }


  function onSelKey(ev) {
    if (!selInfo || (ev.key !== 'Backspace' && ev.key !== 'Delete')) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    ev.preventDefault();
    surface.selectionAction('delete');
  }

  function updateQuizCount() {
    if (!quizSide) return;
    const s = surface.quizStats();
    quizCount.textContent = s.filled ? `gekonnt: ${s.known} von ${s.filled}` : 'noch keine Vokabeln';
    quizRound.textContent = roundRight + roundWrong ? `Runde: ${roundRight} ✓ · ${roundWrong} ✗` : '';
  }

  function answer(knew) {
    if (!surface.quizAnswer(knew)) return;
    if (knew) roundRight++; else roundWrong++;
    quizAnswer.hidden = true;
    updateQuizCount();
    quizNext();
  }

  function quizNext() {
    quizAnswer.hidden = true;
    if (!surface.quizNext()) {
      toast('Runde fertig – alle offenen Vokabeln wurden gefragt.', { type: 'ok' });
      surface.quizNext(); // starts the next round right away
    }
  }

  function startQuiz(side) {
    quizSide = side;
    roundRight = 0;
    roundWrong = 0;
    quizAnswer.hidden = true;
    surface.setQuiz({ side });
    updateQuizCount();
    quizSwap.textContent = side === 'right' ? 'Wörter abdecken' : 'Übersetzung abdecken';
    quizBar.hidden = false;
    toolbar.setQuiz(true, true);
  }

  function stopQuiz() {
    quizSide = null;
    surface.setQuiz(null);
    quizBar.hidden = true;
    toolbar.setQuiz(surface.hasVocab(), false);
  }

  const surface = createSurface(holder, { fingerDraw: fingerDrawPref(), smoothing: smoothingPref(), getImage: (id) => model.getImage(id, { noteId }) });
  // Finger gestures: two/three-finger tap = undo/redo, long press on a stroke = take its color.
  surface.addEventListener('gesture', (e) => toast(e.detail.action === 'undo' ? '↶ Rückgängig' : '↷ Wiederholen', { ms: 900 }));
  surface.addEventListener('pickcolor', (e) => {
    const cur = toolbar.getTool();
    const kind = e.detail.type === 'h' ? 'highlighter' : 'pen';
    toolbar.setTool({ kind, color: e.detail.color, width: kind === 'pen' ? (cur.kind === 'pen' ? cur.width : 1) : 0 });
    surface.setTool(toolbar.getTool());
    toast('Farbe übernommen', { ms: 1200 });
  });
  surface.addEventListener('selection', (e) => renderSelBar(e.detail));
  surface.addEventListener('quiz', (e) => { quizAnswer.hidden = !(quizSide && e.detail && e.detail.open); });
  document.addEventListener('keydown', onSelKey);
  toolbar.setTitle(note.title);
  model.noteOpened(noteId);
  surface.setTool(toolbar.getTool());

  // ───── state ─────
  let pages = [];                       // model rows in page order
  let known = new Set();                // ids of pages in `pages`
  let unloaded = new Set();             // ids whose strokes are not downloaded yet
  const drafts = new Map();             // pageId → strokes string drawn while the page was unloaded
  const saves = new Set();              // running saveStrokes calls
  let closed = false;
  let leaving = false;
  let reloadTimer = 0;
  let reloadSeq = 0;

  // ───── surface → model ─────
  surface.addEventListener('strokes', (e) => {
    const { pageId, strokes } = e.detail;
    if (unloaded.has(pageId)) { drafts.set(pageId, strokes); return; }
    track(model.saveStrokes(pageId, strokes));
  });

  surface.addEventListener('pagechange', () => refreshPageInfo());
  surface.addEventListener('strokes', () => updateQuizCount()); // ticks while quizzing update the counter
  surface.addEventListener('history', (e) => toolbar.setHistory(e.detail.canUndo, e.detail.canRedo));

  function track(promise) {
    const p = promise.catch((err) => { console.error(err); toast('Speichern fehlgeschlagen', { type: 'error' }); });
    saves.add(p);
    p.then(() => saves.delete(p));
    return p;
  }

  /** Emits pending strokes now and waits until all saves are written (before changing pages in the model). */
  async function settle() {
    surface.flush();
    await Promise.all([...saves]);
  }

  // ───── model → view ─────
  function currentPage() {
    const id = surface.currentPageId();
    return pages.find((p) => p.id === id) || null;
  }

  function refreshPageInfo() {
    if (quizSide && !surface.hasVocab()) stopQuiz();
    else toolbar.setQuiz(surface.hasVocab(), !!quizSide);
    const id = surface.currentPageId();
    const i = pages.findIndex((p) => p.id === id);
    toolbar.setPageInfo(i < 0 ? 0 : i + 1, pages.length, i < 0 ? null : { paper: pages[i].paper, orient: pages[i].orient });
  }

  async function reloadPages(initial = false) {
    const seq = ++reloadSeq;
    const list = await model.listPages(noteId);
    if (closed || seq !== reloadSeq) return;

    // Pages that just arrived: merge what was drawn on them meanwhile (flush first, so drafts are complete).
    const arrived = list.filter((p) => typeof p.strokes === 'string' && unloaded.has(p.id));
    if (arrived.some((p) => drafts.has(p.id))) surface.flush();
    const merged = new Map();
    for (const p of arrived) {
      const draft = drafts.get(p.id);
      if (draft === undefined) continue;
      drafts.delete(p.id);
      const s = encodeStrokes([...decodeStrokes(p.strokes), ...decodeStrokes(draft)]);
      merged.set(p.id, s);
      track(model.saveStrokes(p.id, s));
    }

    pages = list;
    known = new Set(list.map((p) => p.id));
    unloaded = new Set(list.filter((p) => typeof p.strokes !== 'string').map((p) => p.id));
    const view = list.map((p) => ({
      id: p.id,
      paper: p.paper,
      orient: p.orient,
      bg: p.bg || null,
      strokes: merged.has(p.id) ? merged.get(p.id) : (typeof p.strokes === 'string' ? p.strokes : '[]'),
    }));
    // keepView: the surface keeps unsaved local changes itself.
    surface.setPages(view, { keepView: !initial });
    hint.hidden = unloaded.size === 0;
    refreshPageInfo();
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadPages().catch((e) => console.error(e)); }, RELOAD_MS);
  }

  function leaveGone() {
    if (leaving || closed) return;
    leaving = true;
    toast('Diese Notiz wurde gelöscht.', { type: 'error' });
    ctx.navigate('#/');
  }

  async function onModelChange(c) {
    if (closed || leaving) return;
    try {
      if (c.kind === 'note' || c.kind === 'folder') {
        if (c.kind === 'note' && c.id !== noteId) return;
        const n = await model.getNote(noteId);
        if (closed) return;
        if (await isGone(n)) return leaveGone();
        note = n;
        toolbar.setTitle(n.title);
        return;
      }
      if (c.kind === 'page') {
        if (known.has(c.id)) return scheduleReload();
        const p = await model.getPage(c.id);
        if (p && p.note_id === noteId) scheduleReload();
      }
    } catch (e) {
      console.error(e);
    }
  }
  model.on('change', onModelChange);

  // ───── page actions ─────
  async function addPage() {
    try {
      await settle();
      const cur = currentPage();
      const page = await model.addPage(noteId, cur ? cur.id : null, {
        paper: cur ? cur.paper : 'lined',
        orient: cur ? cur.orient : 'p',
      });
      await reloadPages();
      surface.scrollToPage(page.id);
      refreshPageInfo();
    } catch (e) {
      console.error(e);
      toast('Seite konnte nicht hinzugefügt werden', { type: 'error' });
    }
  }

  async function pageMenu(action, value) {
    if (action === 'pdf') return exportPdf();
    if (action === 'overview') return openOverview();
    if (action === 'import') return importFiles();
    const cur = currentPage();
    if (!cur) return;
    try {
      if (action === 'duplicate') {
        if (typeof cur.strokes !== 'string') { toast('Die Seite wird noch geladen.'); return; }
        await settle();
        const copy = await model.duplicatePage(cur.id);
        await reloadPages();
        if (copy) surface.scrollToPage(copy.id);
        return;
      }
      if (action === 'paper' || action === 'orient') {
        if (typeof cur.strokes !== 'string') { toast('Die Seite wird noch geladen.'); return; }
        const paper = action === 'paper' ? value : cur.paper;
        const orient = action === 'orient' ? value : cur.orient;
        if (paper === cur.paper && orient === cur.orient) return;
        await settle();
        await model.setPaper(cur.id, paper, orient);
        await reloadPages();
        return;
      }
      if (action === 'delete') return deletePage(cur);
    } catch (e) {
      console.error(e);
      toast('Aktion fehlgeschlagen', { type: 'error' });
    }
  }

  async function openOverview() {
    let mod;
    try { mod = await import('./pages.js'); } catch (e) { console.warn(e); toast('Seitenübersicht kommt bald'); return; }
    await settle();
    await mod.openPageOverview({
      model, noteId, currentPageId: surface.currentPageId(),
      getImage: (id) => model.getImage(id, { noteId }),
      onJump: (pageId) => surface.scrollToPage(pageId),
    });
    await reloadPages();
    refreshPageInfo();
  }

  // Loaded ahead: iPad Safari opens the file picker only directly inside the tap, so no await before pickAndImport.
  let importer = null;
  import('../import/importer.js').then((m) => { importer = m; }, (e) => console.warn(e));

  async function importFiles() {
    if (!importer) { toast('Import wird geladen – bitte gleich nochmal.'); return; }
    const picking = importer.pickAndImport({ model, noteId, afterPageId: surface.currentPageId() });
    await settle();
    try {
      const added = await picking;
      if (!added || !added.length) return;
      await reloadPages();
      surface.scrollToPage(added[0].id);
      toast(added.length === 1 ? '1 Seite eingefügt' : `${added.length} Seiten eingefügt`, { type: 'ok' });
    } catch (e) {
      console.error(e);
      toast(e.message || 'Import fehlgeschlagen', { type: 'error' });
    }
  }

  async function deletePage(cur) {
    if (pages.length <= 1) {
      toast('Die letzte Seite kann nicht gelöscht werden.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Seite löschen',
      message: 'Diese Seite mit allem, was darauf steht, entfernen?',
      okLabel: 'Löschen',
      danger: true,
    });
    if (!ok) return;
    await settle();
    const idx = Math.max(0, pages.findIndex((p) => p.id === cur.id));
    await model.deletePage(cur.id);
    await reloadPages();
    const next = pages[Math.min(idx, pages.length - 1)];
    if (next) surface.scrollToPage(next.id);
    refreshPageInfo();
  }

  async function exportPdf() {
    let pdf, save;
    try {
      [pdf, save] = await Promise.all([import('../export/pdf.js'), import('../export/save.js')]);
    } catch (e) {
      console.warn(e);
      toast('PDF-Export kommt bald');
      return;
    }
    try {
      await settle();
      const list = await model.listPages(noteId);
      if (list.some((p) => typeof p.strokes !== 'string')) {
        toast('Bitte warten, bis alle Seiten geladen sind.');
        return;
      }
      const n = await model.getNote(noteId);
      // Hintergrundbilder: lokal, sonst vom Server; nicht ladbar → Seite ohne Bild
      const getAssetBytes = async (id) => {
        const a = await model.getAsset(id);
        if (a) return new Uint8Array(await a.blob.arrayBuffer());
        try {
          const b = await api.blob('asset_get', { id, note: noteId });
          return new Uint8Array(await b.arrayBuffer());
        } catch {
          return null;
        }
      };
      const blob = await pdf.notePdf(n, list, { getAssetBytes });
      await save.saveFile(blob, fileName(n.title));
    } catch (e) {
      console.error(e);
      toast('PDF-Export fehlgeschlagen', { type: 'error' });
    }
  }

  // ───── start ─────
  try {
    await reloadPages(true);
  } catch (e) {
    console.error(e);
    model.off('change', onModelChange);
    document.removeEventListener('keydown', onSelKey);
    toolbar.destroy();
    surface.destroy();
    el.replaceChildren(h('div', { style: { padding: '24px' } },
      h('h2', { text: 'Die Notiz konnte nicht geöffnet werden.' }),
      h('button', { className: 'btn', text: 'Zur Übersicht', onclick: () => ctx.navigate('#/') })));
    return () => {};
  }

  return function unmount() {
    if (closed) return;
    surface.flush();                 // last strokes go to the model
    closed = true;
    clearTimeout(reloadTimer);
    model.off('change', onModelChange);
    document.removeEventListener('keydown', onSelKey);
    toolbar.destroy();
    surface.destroy();
    el.replaceChildren();
  };
}
