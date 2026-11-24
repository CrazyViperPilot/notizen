// Seitenübersicht (PRD 6.1, ARCHITEKTUR 10.4): Vollbild-Raster aller Seiten einer Notiz als Miniaturen.
// Antippen springt zur Seite. Langes Drücken (400 ms) und Ziehen sortiert um. Das Menü „⋯“ je Seite bietet
// Nach vorne / Nach hinten / Duplizieren / Löschen. Alle Änderungen laufen über js/model.js.
// Benutzertexte nur über textContent bzw. Attribute (kein innerHTML).

import { PAGE } from '../config.js';
import { decodeStrokes } from '../ink/codec.js';
import { drawPage, setPageTransform } from '../ink/render.js';
import { h, menu, confirmDialog, toast } from './dom.js';

const THUMB_CSS_W = 200;     // Miniatur-Breite in CSS-Pixeln; Canvas-Breite = THUMB_CSS_W × devicePixelRatio
const LONG_PRESS_MS = 400;   // langes Drücken startet das Ziehen
const MOVE_TOLERANCE = 8;    // CSS-Pixel: bewegt sich der Zeiger vorher weiter, ist es Scrollen, kein Ziehen
const RELOAD_MS = 150;       // entprellt, nach Änderungen von außen (Sync, andere Ansicht)
const EDGE_PX = 56;          // Randbereich oben/unten, in dem beim Ziehen automatisch gescrollt wird
const GAP_HALF = 7;          // halber Spaltenabstand des Rasters (CSS gap 14 px), Mitte der Einfügemarke
const SKIP_CLICK_MS = 400;   // nach einem Ziehen folgenden Klick ignorieren

const edgeSpeed = (d) => Math.min(24, 4 + d / 3);

/** Canvas-Maße einer Miniatur (Seitenverhältnis der Seite). */
function canvasSize(page) {
  const dims = PAGE[page.orient] || PAGE.p;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(THUMB_CSS_W * dpr);
  return { w, hPx: Math.round((w * dims.h) / dims.w), dims };
}

/** Zeichnet Papier, Hintergrundbild, Textmarker und Stifte in das Miniatur-Canvas. */
function paintPage(canvas, page, img) {
  const { w, hPx, dims } = canvasSize(page);
  canvas.width = w;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d');
  const scale = w / dims.w;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  setPageTransform(ctx, scale);
  // strokes === null: Die Striche sind noch nicht geladen, dann zeigt die Miniatur nur das Papier.
  const strokes = typeof page.strokes === 'string' ? decodeStrokes(page.strokes) : [];
  drawPage(ctx, page, strokes, scale, null, img);
}

/** Schlüssel für die Wiederverwendung einer gerenderten Miniatur. */
function cacheKey(page) {
  return [page.rev, page.lrev, page.paper, page.orient, page.bg || '',
    typeof page.strokes === 'string' ? 's' : '-', window.devicePixelRatio || 1].join('|');
}

/**
 * Öffnet die Seitenübersicht. Resolve, sobald sie geschlossen ist (Fertig, Escape oder Sprung zu einer Seite).
 * model: js/model.js · getImage(assetId) → Promise<image|null> · onJump(pageId) · currentPageId: aktuelle Seite
 */
export async function openPageOverview({ model, noteId, currentPageId = null, getImage = () => Promise.resolve(null), onJump = null }) {
  const prevFocus = document.activeElement;
  const thumbs = new Map();   // pageId → {key, canvas, ok}; gilt nur für diese Übersicht
  let pages = [];             // Page[] in Seitenreihenfolge (aus model.listPages)
  let tiles = new Map();      // pageId → Kachel (.pov-cell)
  let closed = false;
  let busy = false;           // läuft gerade eine Änderung (Verschieben, Duplizieren, Löschen)
  let loadSeq = 0;
  let reloadTimer = 0;
  let dragEndedAt = 0;
  let press = null;           // {id, pageId, cell, x, y, timer}: Zeiger liegt auf einer Kachel, Ziehen noch nicht gestartet
  let drag = null;            // {id, pageId, cell, marker, startX, startY, startScroll, x, y, origIndex, slot, beforeId, frame}
  let resolveDone = () => {};
  const done = new Promise((r) => { resolveDone = r; });

  // ───── Aufbau ─────
  const count = h('span', { className: 'pov-count', 'aria-live': 'polite' });
  const doneBtn = h('button', { type: 'button', className: 'btn primary pov-done', text: 'Fertig', onclick: () => close() });
  const grid = h('div', { className: 'pov-grid' });
  const scroller = h('div', { className: 'pov-scroll' }, grid);
  const root = h('div', { className: 'pov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Seiten' },
    h('header', { className: 'pov-head' },
      h('h2', { className: 'pov-title', text: 'Seiten' }),
      count,
      h('span', { className: 'pov-spacer' }),
      doneBtn),
    scroller);

  grid.addEventListener('pointerdown', onPointerDown);
  grid.addEventListener('pointermove', onPointerMove);
  grid.addEventListener('pointerup', onPointerUp);
  grid.addEventListener('pointercancel', onPointerCancel);
  grid.addEventListener('click', onGridClick);
  grid.addEventListener('keydown', onGridKey);
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
  // Während des Ziehens soll das Raster nicht mitscrollen (iOS hält sich an nicht-passive touchmove-Handler).
  scroller.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', onKey, true);
  if (typeof model.on === 'function') model.on('change', onChange);
  document.body.append(root);
  doneBtn.focus({ preventScroll: true });

  try {
    await load();
  } catch (e) {
    console.error(e);
    toast('Die Seiten konnten nicht geladen werden.', { type: 'error' });
    close();
    return;
  }
  const cur = tiles.get(currentPageId);
  if (cur) cur.scrollIntoView({ block: 'center' });
  await done;

  // ───── Schließen ─────
  function close() {
    if (closed) return;
    closed = true;
    cancelPress();
    if (drag) { cancelAnimationFrame(drag.frame); drag = null; }
    clearTimeout(reloadTimer);
    if (typeof model.off === 'function') model.off('change', onChange);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    thumbs.clear();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
    resolveDone();
  }

  function jump(pageId) {
    try { if (onJump) onJump(pageId); } catch (e) { console.error(e); }
    close();
  }

  function onKey(e) {
    if (closed) return;
    if (document.querySelector('.nz-backdrop, .nz-menu')) return;   // Dialog oder Menü zuerst
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') return;
    e.stopPropagation();   // Werkzeug-Tasten der Editor-Leiste nicht auslösen
  }

  // ───── Daten und Raster ─────
  function onChange(c) {
    if (closed || !c || c.kind !== 'page') return;
    model.getPage(c.id)
      .then((p) => { if (!closed && (!p || p.note_id === noteId)) scheduleReload(); })
      .catch((e) => console.error(e));
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { if (!drag && !busy) load().catch((e) => console.error(e)); }, RELOAD_MS);
  }

  /** Liste neu laden und Raster neu aufbauen. Ein Aufruf während Ziehen/Ändern wird unterdrückt; danach lädt er erneut. */
  async function load(focusId = null) {
    const seq = ++loadSeq;
    const list = await model.listPages(noteId);
    if (closed || seq !== loadSeq || drag || busy) return;
    pages = list;
    render();
    if (focusId && tiles.has(focusId)) tiles.get(focusId).scrollIntoView({ block: 'nearest' });
  }

  function render() {
    cancelPress();
    const cells = pages.map((page, i) => cellFor(page, i, thumbFor(page).canvas));
    const keep = new Set(pages.map((p) => p.id));
    for (const id of [...thumbs.keys()]) if (!keep.has(id)) thumbs.delete(id);
    tiles = new Map(pages.map((p, i) => [p.id, cells[i]]));
    grid.replaceChildren(...cells);
    count.textContent = pages.length + (pages.length === 1 ? ' Seite' : ' Seiten');
  }

  /** Liefert die Miniatur einer Seite: vorhandene wird wiederverwendet, solange rev/lrev und Aussehen gleich sind. */
  function thumbFor(page) {
    const key = cacheKey(page);
    const old = thumbs.get(page.id);
    if (old && old.key === key && old.ok) return old;
    const canvas = document.createElement('canvas');
    canvas.className = 'pov-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const { w, hPx } = canvasSize(page);     // Größe sofort setzen, damit das Raster nicht springt
    canvas.width = w;
    canvas.height = hPx;
    const entry = { key, canvas, ok: false };
    thumbs.set(page.id, entry);
    paintEntry(entry, page);
    return entry;
  }

  async function paintEntry(entry, page) {
    let img = null;
    if (page.bg) {
      try { img = (await getImage(page.bg)) || null; } catch (e) { console.warn('Bild', page.bg, e); img = null; }
      if (closed) return;
    }
    try {
      paintPage(entry.canvas, page, img);
      // Ohne Bild, obwohl eines gebraucht wird: nicht dauerhaft cachen, beim nächsten Aufbau erneut versuchen.
      entry.ok = !page.bg || !!img;
    } catch (e) {
      console.error(e);
    }
  }

  function cellFor(page, i, canvas) {
    const n = i + 1;
    const current = page.id === currentPageId;
    return h('div', { className: 'pov-cell' + (current ? ' current' : ''), dataset: { pageId: page.id } },
      h('div', {
        className: 'pov-tile', role: 'button', tabIndex: 0,
        'aria-label': `Seite ${n} öffnen`, 'aria-current': current ? 'true' : null,
      }, canvas),
      h('div', { className: 'pov-foot' },
        h('span', { className: 'pov-label', text: `Seite ${n}` }),
        h('button', { type: 'button', className: 'pov-more', text: '⋯', 'aria-label': `Menü für Seite ${n}`, title: 'Seitenmenü' })));
  }

  // ───── Tippen, Menü, Tastatur ─────
  function onGridClick(e) {
    const cell = e.target.closest('.pov-cell');
    if (!cell) return;
    const more = e.target.closest('.pov-more');
    if (more) { openTileMenu(cell.dataset.pageId, more); return; }
    if (Date.now() - dragEndedAt < SKIP_CLICK_MS) return;   // Klick nach dem Ziehen
    jump(cell.dataset.pageId);
  }

  function onGridKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('pov-tile')) {
      e.preventDefault();
      jump(e.target.closest('.pov-cell').dataset.pageId);
    }
  }

  function openTileMenu(pageId, anchor) {
    const i = pages.findIndex((p) => p.id === pageId);
    if (i < 0) return;
    const items = [];
    if (i > 0) items.push({ label: 'Nach vorne', onSelect: () => moveBy(pageId, -1) });
    if (i < pages.length - 1) items.push({ label: 'Nach hinten', onSelect: () => moveBy(pageId, 1) });
    items.push({ label: 'Duplizieren', onSelect: () => duplicate(pageId) });
    items.push({ label: 'Löschen', danger: true, onSelect: () => removePage(pageId) });
    menu(anchor, items);
  }

  /** Eine Änderung ausführen (fn liefert die Seite, die danach sichtbar sein soll), dann neu aufbauen. */
  async function act(fn) {
    if (busy || closed) return;
    busy = true;
    let focusId = null;
    try {
      focusId = (await fn()) || null;
    } catch (e) {
      console.error(e);
      toast('Aktion fehlgeschlagen', { type: 'error' });
    } finally {
      busy = false;
    }
    if (!closed) await load(focusId).catch((e) => console.error(e));
  }

  /** „Nach vorne“ = eine Position nach vorne, „Nach hinten“ = eine Position nach hinten. */
  function moveBy(pageId, delta) {
    const i = pages.findIndex((p) => p.id === pageId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= pages.length) return Promise.resolve();
    // movePage setzt die Seite vor beforePageId; null = ans Ende.
    const before = delta < 0 ? pages[j] : pages[i + 2];
    return act(async () => {
      await model.movePage(pageId, before ? before.id : null);
      return pageId;
    });
  }

  function duplicate(pageId) {
    return act(async () => {
      const copy = await model.duplicatePage(pageId);
      if (!copy) { toast('Die Seite wird noch geladen.'); return null; }
      return copy.id;
    });
  }

  async function removePage(pageId) {
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
    if (!ok || closed) return;
    return act(async () => {
      await model.deletePage(pageId);
      return null;
    });
  }

  // ───── Ziehen zum Umsortieren ─────
  function cancelPress() {
    if (press) { clearTimeout(press.timer); press = null; }
  }

  function onPointerDown(e) {
    if (busy || drag || press || closed || !e.isPrimary || e.button > 0) return;
    if (e.target.closest('.pov-more')) return;
    const cell = e.target.closest('.pov-cell');
    if (!cell || pages.length < 2) return;
    const p = { id: e.pointerId, pageId: cell.dataset.pageId, cell, x: e.clientX, y: e.clientY, timer: 0 };
    p.timer = setTimeout(() => beginDrag(p), LONG_PRESS_MS);
    press = p;
  }

  function onPointerMove(e) {
    if (drag) {
      if (e.pointerId === drag.id) { drag.x = e.clientX; drag.y = e.clientY; }
      return;
    }
    if (press && e.pointerId === press.id
      && (Math.abs(e.clientX - press.x) > MOVE_TOLERANCE || Math.abs(e.clientY - press.y) > MOVE_TOLERANCE)) {
      cancelPress();   // Wischen = Scrollen
    }
  }

  function onPointerUp(e) {
    if (drag && e.pointerId === drag.id) { endDrag(true); return; }
    if (press && e.pointerId === press.id) cancelPress();
  }

  function onPointerCancel(e) {
    if (drag && e.pointerId === drag.id) { endDrag(false); return; }
    if (press && e.pointerId === press.id) cancelPress();
  }

  function beginDrag(p) {
    if (press !== p || closed) return;
    press = null;
    if (!p.cell.isConnected) return;
    const origIndex = pages.findIndex((x) => x.id === p.pageId);
    if (origIndex < 0) return;
    try { p.cell.setPointerCapture(p.id); } catch (e) { /* synthetische Ereignisse haben keinen aktiven Zeiger */ }
    const marker = h('div', { className: 'pov-marker', 'aria-hidden': 'true' });
    grid.append(marker);
    drag = {
      id: p.id, pageId: p.pageId, cell: p.cell, marker,
      startX: p.x, startY: p.y, x: p.x, y: p.y,
      startScroll: scroller.scrollTop, origIndex, slot: origIndex, beforeId: null, frame: 0,
    };
    p.cell.classList.add('dragging');
    p.cell.style.touchAction = 'none';
    tick();
  }

  /** Pro Bild: Kachel dem Zeiger nachführen, bei Rand automatisch scrollen, Einfügemarke setzen. */
  function tick() {
    if (!drag) return;
    const sr = scroller.getBoundingClientRect();
    let dy = 0;
    if (drag.y < sr.top + EDGE_PX) dy = -edgeSpeed(sr.top + EDGE_PX - drag.y);
    else if (drag.y > sr.bottom - EDGE_PX) dy = edgeSpeed(drag.y - (sr.bottom - EDGE_PX));
    if (dy) scroller.scrollTop += dy;
    const ty = drag.y - drag.startY + (scroller.scrollTop - drag.startScroll);
    drag.cell.style.transform = `translate(${drag.x - drag.startX}px, ${ty}px) scale(1.04)`;
    updateSlot();
    drag.frame = requestAnimationFrame(tick);
  }

  /** Zielposition: vor der Kachel, deren Mitte dem Zeiger am nächsten ist (links/rechts davon je nach Zeigerposition). */
  function updateSlot() {
    const ids = pages.map((p) => p.id).filter((id) => id !== drag.pageId);
    const rects = ids.map((id) => tiles.get(id).getBoundingClientRect());
    let best = 0;
    let bestD = Infinity;
    rects.forEach((r, k) => {
      const d = Math.pow(r.left + r.width / 2 - drag.x, 2) + Math.pow(r.top + r.height / 2 - drag.y, 2);
      if (d < bestD) { bestD = d; best = k; }
    });
    const r = rects[best];
    const slot = drag.x < r.left + r.width / 2 ? best : best + 1;
    drag.slot = slot;
    drag.beforeId = slot < ids.length ? ids[slot] : null;

    const gr = grid.getBoundingClientRect();
    let x;
    let top;
    let height;
    if (slot < rects.length) {
      x = rects[slot].left - GAP_HALF; top = rects[slot].top; height = rects[slot].height;
    } else {
      const last = rects[rects.length - 1];
      x = last.right + GAP_HALF; top = last.top; height = last.height;
    }
    drag.marker.style.left = (x - gr.left - 2) + 'px';
    drag.marker.style.top = (top - gr.top) + 'px';
    drag.marker.style.height = height + 'px';
  }

  async function endDrag(commit) {
    const d = drag;
    if (!d) return;
    drag = null;
    cancelAnimationFrame(d.frame);
    d.marker.remove();
    d.cell.classList.remove('dragging');
    d.cell.style.transform = '';
    d.cell.style.touchAction = '';
    dragEndedAt = Date.now();
    const moved = commit && d.slot !== d.origIndex;
    if (moved) {
      busy = true;
      try {
        await model.movePage(d.pageId, d.beforeId);
      } catch (e) {
        console.error(e);
        toast('Verschieben fehlgeschlagen', { type: 'error' });
      } finally {
        busy = false;
      }
    }
    // Auch ohne Verschieben neu laden: Änderungen von außen wurden während des Ziehens zurückgehalten.
    if (!closed) await load(moved ? d.pageId : null);
  }
}
