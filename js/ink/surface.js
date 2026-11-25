// Editor surface: custom viewport (pan with inertia, pinch zoom), Apple Pencil input with palm rejection,
// low-latency live stroke, eraser, undo/redo, page virtualization. See docs/ARCHITEKTUR.md 7.2.
//
// Coordinate spaces:
//   page units (0.1 mm)  ──k──▶  doc px (zoom 1, CSS px)  ──z, o──▶  screen px (CSS, relative to container)
//   screen = doc * z - o           doc = page.x/y + unit * k
//
// Canvases:
//   - one base canvas per page near the viewport, rendered at zoom-1 resolution (CSS-scaled while zoomed),
//   - one "detail" canvas over the whole container, sharp at the current zoom (only when zoom > 1, after gestures),
//   - one "live" canvas on top for the stroke in progress and the eraser cursor.

import { isHexColor, PAGE, pageDims, PAGE_GAP, PAGE_PAD, ZOOM_MIN, ZOOM_MAX, ERASER_RADIUS, UNDO_LIMIT, SAVE_DELAY } from '../config.js';
import { decodeStrokes, encodeStrokes, strokeId } from './codec.js';
import { Smoother, SMOOTHING, normPressure, pencilP, altitudeOf, hitTest, hitTestSegment, bbox, eraseSplit } from './stroke.js';
import { drawPage, drawPen, drawInk, drawHighlighter, setPageTransform } from './render.js';
import { PENCIL_ALPHA } from '../config.js';
import { vocabLayout } from './paper.js';

const MAX_PAGE_CSS = 1100;      // max page width at zoom 1 (desktop)
const MAX_BASE_PX = 2400;       // max base canvas width in device px
const KEEP_RANGE = 1.0;         // keep canvases for pages within this many screen heights
const INERTIA_FRICTION = 0.94;  // per 16 ms
const DETAIL_DELAY = 120;       // ms after the last view change

/**
 * Stylus asks for erasing: eraser end (buttons bit 32 / button 5, e.g. Surface Pen) or side/barrel button
 * held while writing (buttons bit 2 / button 2, e.g. many Android pens). Apple Pencil reports neither.
 */
export function penEraser(e) {
  return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5 || (e.buttons & 2) !== 0 || e.button === 2);
}

/** Snapshot of a stroke (points copied) for undo entries that replace a whole page content. */
function snap(s) {
  return { id: s.id, type: s.type, color: s.color, width: s.width, pts: Int32Array.from(s.pts) };
}
const restore = (s) => snap(s);

/** Point in polygon (flat [x,y,…]), even-odd rule. */
function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function boundsOf(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const b = bbox(s);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  return [x0, y0, x1, y1];
}

const HANDLE = 22;  // CSS px, scale handle radius (hit area)
const e_isUp = (d) => d.ended === true;

export function createSurface(container, opts = {}) {
  return new Surface(container, opts);
}

class Surface extends EventTarget {
  constructor(container, { readOnly = false, fingerDraw = false, getImage = null, smoothing = 'normal' } = {}) {
    super();
    this.smoothing = smoothing;  // 'direct' | 'normal' | 'strong'
    this._mtap = null;           // two/three-finger tap (undo/redo) candidate
    this._lp = null;             // long press (color picker) candidate
    this.getImage = getImage;   // (assetId) → Promise<CanvasImageSource|null> for page backgrounds
    this.images = new Map();    // assetId → {img, loading}
    this._recognize = null;     // shape recognizer (js/ink/shapes.js), loaded lazily
    import('./shapes.js').then((m) => { this._recognize = m.recognizeShape; }, () => {});
    this.el = container;
    this.readOnly = readOnly;
    this.fingerDraw = fingerDraw;
    this.tool = { kind: 'pen', color: 0, width: 1 };
    this.pages = [];
    this.byId = new Map();
    this.z = 1; this.ox = 0; this.oy = 0;
    this.k = 1;
    this.W = 0; this.H = 0; this.docH = 0;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.history = []; this.redoStack = [];
    this.touches = new Map();   // pointerId → {x, y}
    this.gesture = null;        // {type: 'pan'|'pinch', …}
    this.drawing = null;        // active stroke / erase state
    this.inertia = null;
    this.renderQueue = new Set();
    this.currentId = null;
    this.saveTimers = new Map();
    this._raf = 0;
    this._detailTimer = 0;
    this.detailState = null;    // {z, ox, oy} the detail canvas was rendered with
    this.guides = new Set();    // ruler / set square straightedges (addGuide)
    this.quiz = null;           // vocab quiz: {side: 'right'|'left', open: Map<pageId, Set<rowIndex>>}
    this._tap = null;           // finger tap candidate on a quiz cover

    this._build();
    this._bind();
    this._resize();
  }

  // ───────────────────────── public API ─────────────────────────

  /** pages: [{id, paper, orient, strokes: string}] in display order. keepView keeps zoom/scroll. */
  setPages(pages, { keepView = false } = {}) {
    const old = this.byId;
    const anchor = keepView ? this._anchor() : null;
    this.pages = [];
    this.byId = new Map();
    for (const row of pages) {
      let P = old.get(row.id);
      const raw = typeof row.strokes === 'string' ? row.strokes : '[]';
      if (!P) {
        P = { id: row.id, strokes: decodeStrokes(raw), raw, div: null, canvas: null, rendered: false };
      } else if (raw !== P.raw && !this.saveTimers.has(P.id)) {
        // Changed elsewhere (sync). Local undo steps and a selection on this page no longer apply.
        if (this.sel && this.sel.P === P) this.clearSelection();
        P.strokes = decodeStrokes(raw);
        P.raw = raw;
        this._dropHistory(P.id);
        P.rendered = false;
      }
      if (P.paper !== row.paper || P.orient !== row.orient || P.size !== (row.size || 'a4') || (P.bg || null) !== (row.bg || null)) P.rendered = false;
      P.bg = row.bg || null;
      P.paper = row.paper;
      P.orient = row.orient === 'l' ? 'l' : 'p';
      P.size = ['a5', 'a3'].includes(row.size) ? row.size : 'a4';
      this.pages.push(P);
      this.byId.set(P.id, P);
    }
    for (const [id, P] of old) if (!this.byId.has(id)) { this._releasePage(P); this._dropHistory(id); }
    if (!keepView) { this.z = 1; this.ox = 0; this.oy = 0; this.history = []; this.redoStack = []; }
    this._layout();
    if (anchor) this._restoreAnchor(anchor);
    this._invalidateDetail();
    this._update();
    this._emitHistory();
  }

  /** Replace one page (e.g. after sync). */
  updatePage(row) {
    if (!this.byId.has(row.id)) return;
    this.setPages(this.pages.map((P) => (P.id === row.id ? row : { id: P.id, paper: P.paper, orient: P.orient, size: P.size, bg: P.bg, strokes: P.raw })), { keepView: true });
  }

  setTool(tool) {
    this.tool = { ...this.tool, ...tool };
    if (this.tool.kind !== 'lasso') this.clearSelection();
  }

  /**
   * Vocabulary quiz: covers one column of every vocab page; tapping a row reveals/hides it.
   * setQuiz({side: 'right'|'left'}) starts/changes it (all rows covered), setQuiz(null) ends it.
   */
  setQuiz(opts) {
    this.quiz = opts ? { side: opts.side === 'left' ? 'left' : 'right', open: new Map(), asked: new Set(), flash: null } : null;
    this._refreshCovers();
  }

  /** Reveal (true) or cover (false) all rows while quizzing. */
  quizAll(reveal) {
    if (!this.quiz) return;
    this.quiz.current = null;
    this.quiz.open = new Map();
    if (reveal) for (const P of this.pages) if (P.paper === 'vocab') this.quiz.open.set(P.id, new Set(vocabLayout(P.orient, P.size).rows.map((_, i) => i)));
    this._refreshCovers();
  }

  // ───── lasso selection (public) ─────

  /** {pageId, count, hasPen, hasHighlighter} or null */
  selectionInfo() {
    const s = this.sel;
    if (!s) return null;
    return { pageId: s.P.id, count: s.strokes.length, hasPen: s.strokes.some((x) => x.type !== 'h'), hasHighlighter: s.strokes.some((x) => x.type === 'h') };
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this._placeSelection();
    this.dispatchEvent(new CustomEvent('selection', { detail: null }));
  }

  /** Actions on the selection: 'delete' | 'duplicate' | 'color' (value: palette index or '#rrggbb'; type: 'p'|'h' strokes to recolor). */
  selectionAction(action, value, type = 'p') {
    const s = this.sel;
    if (!s) return;
    const P = s.P;
    const before = P.strokes.map(snap);
    if (action === 'delete') {
      const gone = new Set(s.strokes);
      P.strokes = P.strokes.filter((x) => !gone.has(x));
      this.sel = null;
    } else if (action === 'duplicate') {
      const off = 60; // 6 mm
      const copies = s.strokes.map((x) => {
        const c = snap(x);
        c.id = strokeId();
        for (let i = 0; i < c.pts.length; i += 3) { c.pts[i] += off; c.pts[i + 1] += off; }
        return c;
      });
      P.strokes.push(...copies);
      this.sel = { P, strokes: copies };
    } else if (action === 'color') {
      let n = 0;
      for (const x of s.strokes) if (type === 'h' ? x.type === 'h' : x.type !== 'h') { x.color = value; n++; } // 'p' = Stift und Bleistift
      if (!n) return;
    } else return;
    this._pushHistory({ type: 'replace', pageId: P.id, before, after: P.strokes.map(snap) });
    this._pageChanged(P, true);
    this._placeSelection();
    this._emitSelection();
  }

  /** Vocabulary progress over all vocab pages: rows with a word (filled) and rows ticked in the check column (known). */
  quizStats() {
    let known = 0, filled = 0;
    for (const P of this.pages) {
      if (P.paper !== 'vocab') continue;
      const s = this._vocabRows(P);
      for (let i = 0; i < s.filled.length; i++) if (s.filled[i]) { filled++; if (s.known[i]) known++; }
    }
    return { known, filled };
  }

  /**
   * Random quiz: jumps to a random filled, not ticked row not asked in this round, covers and highlights it.
   * Returns false when the round is complete (a new round starts with the next call).
   */
  /**
   * Answer for the revealed row (ARCHITEKTUR 11.2): knew → a check mark is written into the tick cell (saved, synced,
   * undoable; the row counts as known); did not know → the row is covered again and stays in the pool.
   * Returns false if no row is revealed.
   */
  quizAnswer(knew) {
    const q = this.quiz && this.quiz.current;
    if (!q) return false;
    this.quiz.current = null;
    const open = this.quiz.open.get(q.P.id);
    if (open) open.delete(q.row);
    if (knew && !this._vocabRows(q.P).known[q.row]) {
      const stroke = this._tickStroke(q.P, q.row);
      q.P.strokes.push(stroke);
      this._drawCommitted(q.P, stroke);
      this._pageChanged(q.P, false);
      this._pushHistory({ type: 'add', pageId: q.P.id, stroke });
    }
    this._removeCover(q.P);
    this._update();
    return true;
  }

  /** The currently revealed row, or null: {pageId, row}. */
  quizCurrent() {
    const q = this.quiz && this.quiz.current;
    return q ? { pageId: q.P.id, row: q.row } : null;
  }

  quizNext() {
    if (!this.quiz) return false;
    const cand = [];
    for (const P of this.pages) {
      if (P.paper !== 'vocab') continue;
      const s = this._vocabRows(P);
      s.filled.forEach((f, i) => { if (f && !s.known[i] && !this.quiz.asked.has(P.id + ':' + i)) cand.push({ P, i }); });
    }
    if (!cand.length) { this.quiz.asked.clear(); return false; }
    const { P, i } = cand[Math.floor(Math.random() * cand.length)];
    this.quiz.current = null;
    this.quiz.asked.add(P.id + ':' + i);
    const open = this.quiz.open.get(P.id);
    if (open) open.delete(i);
    const [y0] = vocabLayout(P.orient, P.size).rows[i];
    this._stopInertia();
    this.oy = (P.y + y0 * this.k) * this.z - this.H / 3;
    this._clamp();
    this.quiz.flash = P.id + ':' + i;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { if (this.quiz) { this.quiz.flash = null; this._removeCover(P); this._update(); } }, 1600);
    this._removeCover(P);
    this._invalidateDetail();
    this._update();
    return true;
  }

  hasVocab() {
    return this.pages.some((P) => P.paper === 'vocab');
  }

  setSmoothing(level) {
    this.smoothing = SMOOTHING[level] ? level : 'normal';
  }

  setFingerDraw(on) {
    this.fingerDraw = !!on;
  }

  undo() {
    this.clearSelection();
    const e = this.history.pop();
    if (!e) return;
    const P = this.byId.get(e.pageId);
    if (P) {
      if (e.type === 'add') P.strokes = P.strokes.filter((s) => s !== e.stroke);
      else if (e.type === 'replace') P.strokes = e.before.map(restore);
      else for (const it of [...e.items].sort((a, b) => a.index - b.index)) P.strokes.splice(it.index, 0, it.stroke);
      this._pageChanged(P, true);
    }
    this.redoStack.push(e);
    this._emitHistory();
  }

  redo() {
    this.clearSelection();
    const e = this.redoStack.pop();
    if (!e) return;
    const P = this.byId.get(e.pageId);
    if (P) {
      if (e.type === 'add') P.strokes.push(e.stroke);
      else if (e.type === 'replace') P.strokes = e.after.map(restore);
      else { const gone = new Set(e.items.map((i) => i.stroke)); P.strokes = P.strokes.filter((s) => !gone.has(s)); }
      this._pageChanged(P, true);
    }
    this.history.push(e);
    this._emitHistory();
  }

  canUndo() { return this.history.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  scrollToPage(id) {
    const P = this.byId.get(id);
    if (!P) return;
    this._stopInertia();
    this.oy = P.y * this.z - PAGE_PAD;
    this._clamp();
    this._invalidateDetail();
    this._update();
  }

  currentPageId() { return this.currentId; }

  zoom() { return this.z; }

  /** CSS px per page unit (0.1 mm) at the current zoom: 1 mm = 10 · viewScale() px. */
  viewScale() { return this.k * this.z; }

  /**
   * Straightedges for the pen (ruler, set square): guide = {start(pt) → edge|null, project(pt, edge) → {x, y}} with points
   * in CSS px relative to the container. A stroke that starts where a guide's start() returns an edge is projected onto it.
   * Several guides may be active; the first one that answers wins.
   */
  addGuide(guide) {
    if (guide && typeof guide.start === 'function' && typeof guide.project === 'function') this.guides.add(guide);
  }

  removeGuide(guide) { this.guides.delete(guide); }

  /** Emit pending 'strokes' events now (call before leaving the editor). */
  flush() {
    for (const [id, t] of this.saveTimers) { clearTimeout(t); this._emitStrokes(id); }
    this.saveTimers.clear();
  }

  destroy() {
    this.flush();
    cancelAnimationFrame(this._raf);
    clearTimeout(this._detailTimer);
    this._stopInertia();
    this._ro.disconnect();
    for (const [type, fn, target, o] of this._listeners) target.removeEventListener(type, fn, o);
    for (const P of this.pages) this._releasePage(P);
    this.el.replaceChildren();
  }

  // ───────────────────────── setup ─────────────────────────

  _build() {
    const s = this.el.style;
    s.position = 'relative';
    s.overflow = 'hidden';
    s.touchAction = 'none';
    s.userSelect = 'none';
    s.webkitUserSelect = 'none';
    s.webkitTouchCallout = 'none';
    this.el.classList.add('nz-surface');
    this.layer = document.createElement('div');
    this.layer.className = 'nz-pages';
    this.layer.style.cssText = 'position:absolute;inset:0;';
    this.detail = this._overlayCanvas('nz-detail');
    this.live = this._overlayCanvas('nz-live');
    // Quiz covers lie above the (sharp) detail canvas, below the live stroke.
    this.covers = document.createElement('div');
    this.covers.className = 'nz-covers';
    this.covers.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    this.el.append(this.layer, this.detail, this.covers, this.live);
    this.liveCtx = this.live.getContext('2d', { desynchronized: true }) || this.live.getContext('2d');
  }

  _overlayCanvas(cls) {
    const c = document.createElement('canvas');
    c.className = cls;
    c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0;';
    return c;
  }

  _bind() {
    this._listeners = [];
    const on = (target, type, fn, o) => {
      const f = fn.bind(this);
      target.addEventListener(type, f, o);
      this._listeners.push([type, f, target, o]);
    };
    on(this.el, 'pointerdown', this._down, { passive: false });
    on(this.el, 'pointermove', this._move, { passive: false });
    on(this.el, 'pointerup', this._up);
    on(this.el, 'pointercancel', this._up);
    on(this.el, 'lostpointercapture', this._lost);
    on(this.el, 'wheel', this._wheel, { passive: false });
    on(this.el, 'contextmenu', (e) => e.preventDefault());
    // iOS: keep the Pencil from scrolling/selecting even if a touch event slips through.
    on(this.el, 'touchstart', (e) => e.preventDefault(), { passive: false });
    on(document, 'visibilitychange', () => { if (document.hidden) this.flush(); });
    on(window, 'pagehide', () => this.flush());
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.el);
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const anchor = this.pages.length ? this._anchor() : null;
    this.W = r.width; this.H = r.height;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.detail, this.live]) {
      c.width = Math.round(this.W * this.dpr);
      c.height = Math.round(this.H * this.dpr);
      c.style.width = this.W + 'px';
      c.style.height = this.H + 'px';
    }
    const oldK = this.k;
    this._layout();
    if (anchor) this._restoreAnchor(anchor);
    if (oldK !== this.k) for (const P of this.pages) { P.rendered = false; this._sizeCanvas(P); }
    this._invalidateDetail();
    this._update();
  }

  // ───────────────────────── layout & view ─────────────────────────

  _layout() {
    // Die breiteste Seite füllt die Breite (eine reine A5-Notiz also ebenso wie eine A4-Notiz), gemischte Formate im echten Größenverhältnis.
    let maxW = 0;
    for (const P of this.pages) maxW = Math.max(maxW, pageDims(P.size, P.orient).w);
    if (!maxW) maxW = PAGE.p.w;
    const avail = Math.max(100, this.W - 2 * PAGE_PAD);
    this.k = Math.min(avail, MAX_PAGE_CSS) / maxW;
    let y = PAGE_PAD;
    for (const P of this.pages) {
      const { w, h } = pageDims(P.size, P.orient);
      P.w = w; P.h = h;
      P.cw = w * this.k; P.ch = h * this.k;
      P.x = (this.W - P.cw) / 2;
      P.y = y;
      y += P.ch + PAGE_GAP;
    }
    this.docH = y - PAGE_GAP + PAGE_PAD;
    this._clamp();
  }

  _clamp() {
    this.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.z));
    const maxX = Math.max(0, this.W * this.z - this.W);
    const maxY = Math.max(0, this.docH * this.z - this.H);
    this.ox = Math.min(maxX, Math.max(0, this.ox));
    this.oy = Math.min(maxY, Math.max(0, this.oy));
  }

  /** Position relative to the current page, to survive relayouts. */
  _anchor() {
    const P = this.byId.get(this.currentId) || this.pages[0];
    if (!P || P.ch === undefined) return null;
    return { id: P.id, f: (this.oy / this.z - P.y) / P.ch, fx: this.ox / Math.max(1, this.W * this.z) };
  }

  _restoreAnchor(a) {
    const P = this.byId.get(a.id);
    if (!P) return;
    this.oy = (P.y + a.f * P.ch) * this.z;
    this.ox = a.fx * this.W * this.z;
    this._clamp();
  }

  _screenRect(P) {
    return { x: P.x * this.z - this.ox, y: P.y * this.z - this.oy, w: P.cw * this.z, h: P.ch * this.z };
  }

  /** Screen point → {P, ux, uy} (page units) or null if not on a page. */
  _pageAt(sx, sy, clampToPage = null) {
    const dx = (sx + this.ox) / this.z, dy = (sy + this.oy) / this.z;
    const P = clampToPage || this.pages.find((p) => dx >= p.x && dx <= p.x + p.cw && dy >= p.y && dy <= p.y + p.ch);
    if (!P) return null;
    return { P, ux: (dx - P.x) / this.k, uy: (dy - P.y) / this.k };
  }

  _update() {
    const range = this.H * KEEP_RANGE;
    let best = null, bestVis = 0;
    for (const P of this.pages) {
      const r = this._screenRect(P);
      const near = r.y + r.h > -range && r.y < this.H + range;
      if (near) {
        if (!P.div) this._createPage(P);
        const st = P.div.style;
        st.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
        st.width = r.w + 'px';
        st.height = r.h + 'px';
        if (!P.rendered) this.renderQueue.add(P);
        this._placeCover(P, r);
      } else if (P.div) {
        this._releasePage(P);
      }
      const vis = Math.min(r.y + r.h, this.H) - Math.max(r.y, 0);
      if (vis > bestVis) { bestVis = vis; best = P; }
    }
    if (best && best.id !== this.currentId) {
      this.currentId = best.id;
      this.dispatchEvent(new CustomEvent('pagechange', { detail: { pageId: best.id } }));
    }
    this._placeDetail();
    this._placeSelection();
    this._schedule();
    this.dispatchEvent(new CustomEvent('view'));
  }

  _createPage(P) {
    const d = document.createElement('div');
    d.className = 'nz-page';
    d.style.cssText = 'position:absolute;left:0;top:0;background:#fff;transform-origin:0 0;box-shadow:0 1px 4px rgba(0,0,0,.18);';
    const c = document.createElement('canvas');
    c.style.cssText = 'display:block;width:100%;height:100%;';
    d.append(c);
    this.layer.append(d);
    P.div = d; P.canvas = c; P.rendered = false;
    this._sizeCanvas(P);
  }

  // ───── lasso selection (internal) ─────

  _selRect() {
    const s = this.sel;
    if (!s) return null;
    const b = boundsOf(s.strokes);
    const r = this._screenRect(s.P);
    const f = this.z * this.k;
    return { x: r.x + b[0] * f, y: r.y + b[1] * f, w: (b[2] - b[0]) * f, h: (b[3] - b[1]) * f, b };
  }

  _placeSelection() {
    const rr = this._selRect();
    if (!rr || !this.sel.strokes.length) {
      if (this.selEl) this.selEl.hidden = true;
      return;
    }
    if (!this.selEl) {
      this.selEl = document.createElement('div');
      this.selEl.className = 'nz-selection';
      this.selEl.style.cssText = 'position:absolute;left:0;top:0;border:1.5px dashed #2f5fd0;border-radius:4px;'
        + 'background:rgba(47,95,208,.06);pointer-events:none;box-sizing:border-box;';
      const handle = document.createElement('div');
      handle.className = 'nz-sel-handle';
      handle.style.cssText = 'position:absolute;right:-9px;bottom:-9px;width:16px;height:16px;border-radius:50%;'
        + 'background:#fff;border:2px solid #2f5fd0;box-shadow:0 1px 3px rgba(0,0,0,.25);';
      this.selEl.append(handle);
      this.covers.append(this.selEl);
    }
    const pad = 6;
    const st = this.selEl.style;
    this.selEl.hidden = false;
    st.transform = `translate3d(${rr.x - pad}px, ${rr.y - pad}px, 0)`;
    st.width = rr.w + 2 * pad + 'px';
    st.height = rr.h + 2 * pad + 'px';
  }

  _emitSelection() {
    const rr = this._selRect();
    this.dispatchEvent(new CustomEvent('selection', {
      detail: rr && this.sel.strokes.length ? { ...this.selectionInfo(), rect: { x: rr.x, y: rr.y, w: rr.w, h: rr.h } } : null,
    }));
  }

  /** What a lasso pointer-down at screen point does: 'scale' | 'move' | 'new'. */
  _lassoMode(pt, P) {
    const rr = this._selRect();
    if (!rr || this.sel.P !== P) return 'new';
    if (Math.hypot(pt.x - (rr.x + rr.w + 6), pt.y - (rr.y + rr.h + 6)) <= HANDLE) return 'scale';
    if (pt.x >= rr.x - 10 && pt.x <= rr.x + rr.w + 10 && pt.y >= rr.y - 10 && pt.y <= rr.y + rr.h + 10) return 'move';
    return 'new';
  }

  _lassoSample(ux, uy) {
    const d = this.drawing;
    const L = d.lasso;
    if (L.mode === 'new') { L.path.push(ux, uy); return; }
    let f = 1, dx = 0, dy = 0;
    if (L.mode === 'move') { dx = ux - L.sx; dy = uy - L.sy; }
    else {
      const [ax, ay, bx, by] = L.box;
      const denom = (bx - ax) + (by - ay);
      f = denom > 0 ? Math.max(0.1, Math.min(10, ((ux - ax) + (uy - ay)) / denom)) : 1;
    }
    const ax = L.box[0], ay = L.box[1];
    for (const [s, orig] of L.orig) {
      const pts = new Int32Array(orig.length);
      for (let i = 0; i < orig.length; i += 3) {
        pts[i] = Math.round(L.mode === 'move' ? orig[i] + dx : ax + (orig[i] - ax) * f);
        pts[i + 1] = Math.round(L.mode === 'move' ? orig[i + 1] + dy : ay + (orig[i + 1] - ay) * f);
        pts[i + 2] = orig[i + 2];
      }
      s.pts = pts;
      delete s._bb;
    }
    L.changed = true;
    d.P.rendered = false;
    if (d.P.canvas) this.renderQueue.add(d.P);
    if (this.detailState) this._renderDetailSoon();
    this._placeSelection();
  }

  _lassoEnd(d) {
    const L = d.lasso;
    if (L.mode === 'new') {
      const poly = L.path;
      if (poly.length < 6) { this.clearSelection(); return; }
      const hit = d.P.strokes.filter((s) => {
        let inside = 0;
        const n = s.pts.length / 3;
        for (let i = 0; i < s.pts.length; i += 3) if (inPolygon(poly, s.pts[i], s.pts[i + 1])) inside++;
        return inside * 2 >= n;
      });
      this.sel = hit.length ? { P: d.P, strokes: hit } : null;
      this._placeSelection();
      this._emitSelection();
      return;
    }
    if (L.changed) {
      this._pushHistory({ type: 'replace', pageId: d.P.id, before: L.before, after: d.P.strokes.map(snap) });
      this._pageChanged(d.P, true);
    }
    this._placeSelection();
    this._emitSelection();
  }

  // ───── background images ─────

  /** Decoded background of a page, or null (not set / still loading – then the page is redrawn when it arrives). */
  _img(P) {
    if (!P.bg || !this.getImage) return null;
    const e = this.images.get(P.bg);
    if (e) return e.img;
    const entry = { img: null };
    this.images.set(P.bg, entry);
    const id = P.bg;
    Promise.resolve(this.getImage(id)).then((img) => {
      if (!img || this.images.get(id) !== entry) return;
      entry.img = img;
      for (const Q of this.pages) if (Q.bg === id) { Q.rendered = false; if (Q.canvas) this.renderQueue.add(Q); }
      if (this.detailState) this._renderDetailSoon();
      this._schedule();
    }, () => {});
    return null;
  }

  // ───── quiz covers ─────

  _placeCover(P, r) {
    if (!this.quiz || P.paper !== 'vocab') { this._removeCover(P); return; }
    if (!P.coverEl || P.coverKey !== this._coverKey(P)) this._buildCover(P);
    const st = P.coverEl.style;
    st.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
    st.width = r.w + 'px';
    st.height = r.h + 'px';
  }

  /** Per row of a vocab page: does the word/translation area contain ink (filled), is the tick cell inked (known)? */
  _vocabRows(P) {
    if (P._vr && P._vr.strokes === P.strokes && P._vr.n === P.strokes.length && P._vr.ver === P._ver) return P._vr;
    const L = vocabLayout(P.orient, P.size);
    const n = L.rows.length;
    const filled = new Array(n).fill(false), known = new Array(n).fill(false);
    const tickX = L.right[1];
    const top = n ? L.rows[0][0] : 0, step = n ? L.rows[0][1] - L.rows[0][0] : 1;
    for (const s of P.strokes) {
      const p = s.pts;
      for (let k = 0; k < p.length; k += 3) {
        const x = p[k], y = p[k + 1];
        const i = Math.floor((y - top) / step); // rows are evenly spaced
        if (i < 0 || i >= n) continue;
        if (x >= tickX) known[i] = true;
        else filled[i] = true;
      }
    }
    P._vr = { strokes: P.strokes, n: P.strokes.length, ver: P._ver, filled, known };
    return P._vr;
  }

  _coverKey(P) {
    const open = this.quiz.open.get(P.id);
    const s = this._vocabRows(P);
    return this.quiz.side + P.orient + P.size + ':' + (open ? [...open].sort((a, b) => a - b).join(',') : '')
      + '|' + s.filled.map((f, i) => (s.known[i] ? 'k' : f ? 'f' : '-')).join('') + '|' + (this.quiz.flash || '');
  }

  _buildCover(P) {
    this._removeCover(P);
    const L = vocabLayout(P.orient, P.size);
    const [x0, x1] = L[this.quiz.side];
    const open = this.quiz.open.get(P.id) || new Set();
    const s = this._vocabRows(P);
    const box = document.createElement('div');
    box.className = 'nz-cover';
    box.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;';
    L.rows.forEach(([y0, y1], i) => {
      if (!s.filled[i]) return; // empty rows need no cover
      const row = document.createElement('div');
      row.className = 'nz-cover-row' + (s.known[i] ? ' known' : open.has(i) ? ' open' : '')
        + (this.quiz.flash === P.id + ':' + i ? ' flash' : '');
      row.style.cssText = `position:absolute;left:${(x0 / P.w) * 100}%;width:${((x1 - x0) / P.w) * 100}%;`
        + `top:${(y0 / P.h) * 100}%;height:${((y1 - y0) / P.h) * 100}%;`;
      box.append(row);
    });
    this.covers.append(box);
    P.coverEl = box;
    P.coverKey = this._coverKey(P);
  }

  _removeCover(P) {
    if (P.coverEl) P.coverEl.remove();
    P.coverEl = null;
    P.coverKey = null;
  }

  _refreshCovers() {
    for (const P of this.pages) this._removeCover(P);
    this._update();
  }

  /** Screen point on a covered quiz cell → {P, row} or null. */
  _quizHit(pt) {
    if (!this.quiz) return null;
    const hit = this._pageAt(pt.x, pt.y);
    if (!hit || hit.P.paper !== 'vocab') return null;
    const L = vocabLayout(hit.P.orient, hit.P.size);
    const [x0, x1] = L[this.quiz.side];
    if (hit.ux < x0 || hit.ux > x1) return null;
    const row = L.rows.findIndex(([y0, y1]) => hit.uy >= y0 && hit.uy < y1);
    if (row < 0) return null;
    const s = this._vocabRows(hit.P);
    return s.filled[row] && !s.known[row] ? { P: hit.P, row } : null;
  }

  _toggleRow(q) {
    let open = this.quiz.open.get(q.P.id);
    if (!open) this.quiz.open.set(q.P.id, (open = new Set()));
    if (open.has(q.row)) open.delete(q.row); else open.add(q.row);
    this.quiz.current = open.has(q.row) ? { P: q.P, row: q.row } : null;
    this._removeCover(q.P);
    this._update();
    this.dispatchEvent(new CustomEvent('quiz', { detail: { pageId: q.P.id, row: q.row, open: open.has(q.row) } }));
  }

  /** Green check mark in the tick cell of a vocab row (page units); same stroke format as handwriting. */
  _tickStroke(P, row) {
    const L = vocabLayout(P.orient, P.size);
    const [y0, y1] = L.rows[row];
    const x0 = L.right[1], x1 = P.w;
    const w = x1 - x0, h = y1 - y0;
    const corners = [[x0 + w * 0.22, y0 + h * 0.55], [x0 + w * 0.42, y0 + h * 0.8], [x0 + w * 0.78, y0 + h * 0.18]];
    const pts = [];
    for (let k = 0; k < corners.length - 1; k++) {
      const [ax, ay] = corners[k], [bx, by] = corners[k + 1];
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 8));
      for (let j = k ? 1 : 0; j <= n; j++) pts.push(Math.round(ax + ((bx - ax) * j) / n), Math.round(ay + ((by - ay) * j) / n), 150);
    }
    return { id: strokeId(), type: 'p', color: '#1e8449', width: 1, pts: Int32Array.from(pts) };
  }

  _sizeCanvas(P) {
    if (!P.canvas) return;
    const w = Math.min(MAX_BASE_PX, Math.round(P.cw * this.dpr));
    P.scale = w / P.w;  // device px per unit on the base canvas
    P.canvas.width = w;
    P.canvas.height = Math.round(P.h * P.scale);
  }

  _releasePage(P) {
    this._removeCover(P);
    if (P.canvas) { P.canvas.width = 0; P.canvas.height = 0; }
    if (P.div) P.div.remove();
    P.div = null; P.canvas = null; P.rendered = false;
    this.renderQueue.delete(P);
  }

  _renderBase(P) {
    if (!P.canvas) return;
    const ctx = P.canvas.getContext('2d');
    setPageTransform(ctx, P.scale);
    drawPage(ctx, P, P.strokes, P.scale, null, this._img(P));
    P.rendered = true;
  }

  // Detail canvas: sharp rendering of the visible area when zoomed in.
  _invalidateDetail() {
    clearTimeout(this._detailTimer);
    if (this.z <= 1.001) { this.detailState = null; this.detail.style.display = 'none'; return; }
    if (this.gesture || this.inertia || this.drawing) return; // re-armed when they end
    this._detailTimer = setTimeout(() => this._renderDetail(), DETAIL_DELAY);
  }

  _placeDetail() {
    const d = this.detailState;
    if (!d) return;
    const f = this.z / d.z;
    this.detail.style.transform = `translate(${d.ox * f - this.ox}px, ${d.oy * f - this.oy}px) scale(${f})`;
  }

  _renderDetail() {
    if (this.z <= 1.001) return;
    const ctx = this.detail.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.detail.width, this.detail.height);
    const s = this.dpr * this.z * this.k;
    for (const P of this.pages) {
      const r = this._screenRect(P);
      if (r.y + r.h < 0 || r.y > this.H || r.x + r.w < 0 || r.x > this.W) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x * this.dpr, r.y * this.dpr, r.w * this.dpr, r.h * this.dpr);
      ctx.clip();
      setPageTransform(ctx, s, r.x * this.dpr, r.y * this.dpr);
      const clip = [Math.max(0, -r.x) / (this.z * this.k), Math.max(0, -r.y) / (this.z * this.k),
        (this.W - r.x) / (this.z * this.k), (this.H - r.y) / (this.z * this.k)];
      drawPage(ctx, P, P.strokes, s, clip, this._img(P));
      ctx.restore();
    }
    this.detailState = { z: this.z, ox: this.ox, oy: this.oy };
    this.detail.style.display = 'block';
    this._placeDetail();
  }

  /** Draws one finished stroke onto the base canvas (and the detail canvas) without a full re-render. */
  _drawCommitted(P, stroke) {
    if (stroke.type === 'h') { P.rendered = false; return; } // highlighter must stay below the ink: full re-render
    if (P.canvas && P.rendered) {
      const ctx = P.canvas.getContext('2d');
      setPageTransform(ctx, P.scale);
      drawInk(ctx, stroke);
    }
    const d = this.detailState;
    if (d && this.detail.style.display !== 'none') {
      const ctx = this.detail.getContext('2d');
      const s = this.dpr * d.z * this.k;
      ctx.save();
      setPageTransform(ctx, s, (P.x * d.z - d.ox) * this.dpr, (P.y * d.z - d.oy) * this.dpr);
      drawInk(ctx, stroke);
      ctx.restore();
    }
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => this._frame());
  }

  _frame() {
    this._raf = 0;
    if (this.drawing) this._drawLive();
    // Render at most one page per frame, the most visible first.
    if (this.renderQueue.size) {
      let best = null, bestD = Infinity;
      for (const P of this.renderQueue) {
        const r = this._screenRect(P);
        const d = Math.abs(r.y + r.h / 2 - this.H / 2);
        if (d < bestD) { bestD = d; best = P; }
      }
      this.renderQueue.delete(best);
      if (best.canvas && !best.rendered) this._renderBase(best);
      if (this.renderQueue.size) this._schedule();
    }
  }

  // ───────────────────────── changes & history ─────────────────────────

  _pageChanged(P, rerender) {
    P._ver = (P._ver || 0) + 1;
    if (this.quiz && P.paper === 'vocab' && P.coverEl) { this._removeCover(P); this._update(); }
    if (rerender || !P.rendered) {
      P.rendered = false;
      if (P.canvas) this.renderQueue.add(P);
      if (this.detailState) this._renderDetailSoon();
    }
    clearTimeout(this.saveTimers.get(P.id));
    this.saveTimers.set(P.id, setTimeout(() => { this.saveTimers.delete(P.id); this._emitStrokes(P.id); }, SAVE_DELAY));
    this._schedule();
  }

  _renderDetailSoon() {
    clearTimeout(this._detailTimer);
    this._detailTimer = setTimeout(() => this._renderDetail(), 0);
  }

  _emitStrokes(id) {
    const P = this.byId.get(id);
    if (!P) return;
    P.raw = encodeStrokes(P.strokes);
    this.dispatchEvent(new CustomEvent('strokes', { detail: { pageId: id, strokes: P.raw } }));
  }

  _pushHistory(e) {
    this.history.push(e);
    if (this.history.length > UNDO_LIMIT) this.history.shift();
    this.redoStack = [];
    this._emitHistory();
  }

  _dropHistory(pageId) {
    this.history = this.history.filter((e) => e.pageId !== pageId);
    this.redoStack = this.redoStack.filter((e) => e.pageId !== pageId);
  }

  _emitHistory() {
    this.dispatchEvent(new CustomEvent('history', { detail: { canUndo: this.canUndo(), canRedo: this.canRedo() } }));
  }

  // ───────────────────────── input ─────────────────────────

  _local(e) {
    const r = this._rect || (this._rect = this.el.getBoundingClientRect());
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _isDrawPointer(e) {
    if (this.readOnly) return false;
    if (e.pointerType === 'pen') return true;
    return this.fingerDraw && (e.pointerType === 'mouse' || (e.pointerType === 'touch' && this.touches.size === 0));
  }

  _down(e) {
    this._rect = this.el.getBoundingClientRect();
    const pt = this._local(e);
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // Quiz: the pen (or the drawing finger/mouse) toggles a covered row instead of writing on it.
    const quizHit = this.drawing ? null : this._quizHit(pt);
    if (quizHit && this._isDrawPointer(e)) {
      e.preventDefault();
      this._toggleRow(quizHit);
      return;
    }
    if (this.touches.size > 0) this._tap = null; // second finger: pinch, no tap
    else if (quizHit) this._tap = { id: e.pointerId, x: pt.x, y: pt.y, t: e.timeStamp, q: quizHit };

    if (this._isDrawPointer(e) && !this.drawing) {
      const hit = this._pageAt(pt.x, pt.y);
      if (!hit) return;
      e.preventDefault();
      this._capture(e);
      // Palm rejection: a touch that was already down (hand resting) is no gesture.
      if (e.pointerType === 'pen') { this.touches.clear(); this.gesture = null; }
      this._stopInertia();
      clearTimeout(this._detailTimer);
      this._startDraw(e, hit);
      return;
    }

    // Pen while drawing with another pointer, or extra pointers during a pen stroke: ignore (palm).
    if (this.drawing && (this.drawing.pointerType === 'pen' || e.pointerType === 'pen')) return;

    if (this.drawing && this.drawing.pointerType !== 'pen' && e.pointerType === 'touch') {
      // Finger drawing: a second finger turns it into a pinch if the stroke just started.
      const first = this.drawing;
      if (first.smoother.out.length / 3 < 8) {
        this._abortDraw();
        this.touches.set(first.pointerId, first.lastScreen);
        this._mtap = { t0: e.timeStamp - 80, max: 1, moved: false, start: new Map([[first.pointerId, first.lastScreen]]), z: this.z, ox: this.ox, oy: this.oy };
      } else return;
    }

    if (e.pointerType === 'touch' || e.pointerType === 'mouse' || (e.pointerType === 'pen' && this.readOnly)) {
      e.preventDefault();
      this._capture(e);
      this._stopInertia();
      if (this.touches.size === 0) this._mtap = { t0: e.timeStamp, max: 0, moved: false, start: new Map(), z: this.z, ox: this.ox, oy: this.oy };
      this.touches.set(e.pointerId, pt);
      if (this._mtap) { this._mtap.start.set(e.pointerId, pt); this._mtap.max = Math.max(this._mtap.max, this.touches.size); }
      this._cancelLongPress();
      if (this.touches.size === 1 && e.pointerType === 'touch') this._armLongPress(e.pointerId, pt);
      this._startGesture();
    }
  }

  // ───── finger gestures: two/three-finger tap (undo/redo), long press (pick color) ─────

  _armLongPress(id, pt) {
    this._lp = { id, pt, timer: setTimeout(() => this._longPress(), 500) };
  }

  _cancelLongPress() {
    if (this._lp) clearTimeout(this._lp.timer);
    this._lp = null;
  }

  /** Long press with one finger on a stroke: take over its color (like the eyedropper in drawing apps). */
  _longPress() {
    const lp = this._lp;
    this._lp = null;
    if (!lp || this.touches.size !== 1 || !this.touches.has(lp.id)) return;
    const hit = this._pageAt(lp.pt.x, lp.pt.y);
    if (!hit) return;
    const r = 14 / (this.z * this.k);
    const strokes = hit.P.strokes;
    let found = null;
    for (let i = strokes.length - 1; i >= 0 && !found; i--) if (strokes[i].type !== 'h' && hitTest(strokes[i], hit.ux, hit.uy, r)) found = strokes[i];
    for (let i = strokes.length - 1; i >= 0 && !found; i--) if (strokes[i].type === 'h' && hitTest(strokes[i], hit.ux, hit.uy, r)) found = strokes[i];
    if (!found) return;
    // The finger stays down: no panning, no tap actions until it is lifted.
    this.gesture = null;
    this._mtap = null;
    this._tap = null;
    this._lpDone = true;
    this.dispatchEvent(new CustomEvent('pickcolor', { detail: { type: found.type, color: found.color } }));
  }

  /** Checks a finished finger tap with 2 or 3 fingers. Returns true if it was handled. */
  _multiTapEnd(t) {
    const tap = this._mtap;
    this._mtap = null;
    if (!tap || tap.moved || tap.max < 2 || tap.max > 3 || t - tap.t0 > 350) return false;
    // Undo any tiny zoom/pan the fingers caused.
    this.z = tap.z; this.ox = tap.ox; this.oy = tap.oy;
    this.gesture = null;
    this._clamp();
    this._update();
    if (tap.max === 2) this.undo(); else this.redo();
    this.dispatchEvent(new CustomEvent('gesture', { detail: { action: tap.max === 2 ? 'undo' : 'redo' } }));
    return true;
  }

  _capture(e) {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  _move(e) {
    if (this.drawing && e.pointerId === this.drawing.pointerId) {
      e.preventDefault();
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      for (const ev of evs && evs.length ? evs : [e]) this._addSample(ev);
      this._schedule();
      return;
    }
    if (!this.touches.has(e.pointerId)) return;
    e.preventDefault();
    const mp = this._local(e);
    this.touches.set(e.pointerId, mp);
    if (this._mtap) {
      const s0 = this._mtap.start.get(e.pointerId);
      if (s0 && Math.hypot(mp.x - s0.x, mp.y - s0.y) > 12) this._mtap.moved = true;
    }
    if (this._lp && this._lp.id === e.pointerId && Math.hypot(mp.x - this._lp.pt.x, mp.y - this._lp.pt.y) > 10) this._cancelLongPress();
    if (this._lpDone) return; // color picked: finger rests, no panning
    this._moveGesture(e.timeStamp);
  }

  _up(e) {
    if (this.drawing && e.pointerId === this.drawing.pointerId) {
      this._addSample(e);
      this._endDraw();
      return;
    }
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    this._cancelLongPress();
    if (this._lpDone) {
      if (!this.touches.size) { this._lpDone = false; this.gesture = null; this._tap = null; }
      return;
    }
    if (this.touches.size === 0 && e.type === 'pointerup' && this._multiTapEnd(e.timeStamp)) { this._tap = null; return; }
    const tap = this._tap;
    this._tap = null;
    if (tap && tap.id === e.pointerId && e.type === 'pointerup') {
      const pt = this._local(e);
      // A short tap (no panning) on a cover toggles the row.
      if (Math.hypot(pt.x - tap.x, pt.y - tap.y) < 10 && e.timeStamp - tap.t < 500) {
        this.gesture = null;
        this._toggleRow(tap.q);
        return;
      }
    }
    this._endGesture(e.timeStamp);
  }

  _lost(e) {
    if (this.drawing && e.pointerId === this.drawing.pointerId) this._endDraw();
    else if (this.touches.has(e.pointerId)) { this.touches.delete(e.pointerId); this._endGesture(e.timeStamp); }
  }

  _wheel(e) {
    e.preventDefault();
    this._stopInertia();
    this._rect = this.el.getBoundingClientRect();
    if (e.ctrlKey) {
      const p = this._local(e);
      this._zoomAt(this.z * Math.exp(-e.deltaY * 0.01), p.x, p.y);
    } else {
      const f = e.deltaMode === 1 ? 16 : 1;
      this.ox += e.deltaX * f;
      this.oy += e.deltaY * f;
      this._clamp();
    }
    this._update();
    this._invalidateDetail();
  }

  _zoomAt(z, sx, sy) {
    const dx = (sx + this.ox) / this.z, dy = (sy + this.oy) / this.z;
    this.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    this.ox = dx * this.z - sx;
    this.oy = dy * this.z - sy;
    this._clamp();
  }

  // Pan / pinch
  _startGesture() {
    const pts = [...this.touches.values()];
    if (pts.length === 1) {
      this.gesture = { type: 'pan', sx: pts[0].x, sy: pts[0].y, ox: this.ox, oy: this.oy, samples: [] };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.gesture = {
        type: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.z, t0: performance.now(),
        docX: (mx + this.ox) / this.z, docY: (my + this.oy) / this.z,
      };
    }
  }

  _moveGesture(t) {
    const g = this.gesture;
    if (!g) return;
    const pts = [...this.touches.values()];
    if (g.type === 'pan' && pts.length === 1) {
      this.ox = g.ox - (pts[0].x - g.sx);
      this.oy = g.oy - (pts[0].y - g.sy);
      g.samples.push({ t, x: pts[0].x, y: pts[0].y });
      if (g.samples.length > 6) g.samples.shift();
    } else if (g.type === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (g.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0));
      this.ox = g.docX * this.z - mx;
      this.oy = g.docY * this.z - my;
    }
    this._clamp();
    this._update();
  }

  _endGesture(t) {
    const g = this.gesture;
    // Quick pinch together while zoomed in: back to the whole page width.
    if (g && g.type === 'pinch' && g.z0 > 1.05 && this.z < g.z0 * 0.8 && performance.now() - g.t0 < 350) {
      const cy = (this.oy + this.H / 2) / this.z;
      this.z = 1;
      this.ox = 0;
      this.oy = cy - this.H / 2;
      this.gesture = null;
      this._clamp();
      this._update();
      this._invalidateDetail();
      if (this.touches.size > 0) this._startGesture();
      return;
    }
    if (this.touches.size > 0) { this._startGesture(); return; } // pinch → pan with the remaining finger
    this.gesture = null;
    if (g && g.type === 'pan' && g.samples.length >= 2) {
      const a = g.samples[0], b = g.samples[g.samples.length - 1];
      const dt = b.t - a.t;
      if (dt > 0 && t - b.t < 80) this._startInertia(-(b.x - a.x) / dt, -(b.y - a.y) / dt);
    }
    this._invalidateDetail();
  }

  _startInertia(vx, vy) {
    if (Math.hypot(vx, vy) < 0.1) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      this.ox += vx * dt;
      this.oy += vy * dt;
      const f = Math.pow(INERTIA_FRICTION, dt / 16);
      vx *= f; vy *= f;
      const bx = this.ox, by = this.oy;
      this._clamp();
      if (bx !== this.ox) vx = 0;
      if (by !== this.oy) vy = 0;
      this._update();
      if (Math.hypot(vx, vy) < 0.02) { this.inertia = null; this._invalidateDetail(); return; }
      this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  _stopInertia() {
    if (this.inertia) { cancelAnimationFrame(this.inertia); this.inertia = null; }
  }

  // Drawing / erasing
  _startDraw(e, hit) {
    const P = hit.P;
    const kind = penEraser(e) ? 'eraser' : this.tool.kind;
    const pt = this._local(e);
    let lasso = null;
    if (kind === 'lasso') {
      const mode = this._lassoMode(pt, P);
      if (mode === 'new') this.clearSelection();
      lasso = { mode, path: [], sx: hit.ux, sy: hit.uy, changed: false, before: null, orig: null, box: null };
      if (mode !== 'new') {
        lasso.before = P.strokes.map(snap);
        lasso.orig = new Map(this.sel.strokes.map((s) => [s, Int32Array.from(s.pts)]));
        lasso.box = boundsOf(this.sel.strokes);
        this.dispatchEvent(new CustomEvent('selection', { detail: null })); // hide action bar while dragging
      }
    }
    this.drawing = {
      pointerId: e.pointerId, pointerType: e.pointerType, P, kind, lasso,
      eraseMode: this.tool.mode === 'part' ? 'part' : 'stroke', before: kind === 'eraser' && this.tool.mode === 'part' ? P.strokes.map(snap) : null,
      smoother: new Smoother(SMOOTHING[this.smoothing] || SMOOTHING.normal), drawn: 0, lastScreen: pt,
      erased: [], lastU: null, splitChanged: false,
      edge: null, guide: null,
      holdPt: null, holdTimer: 0, snapped: null, snapDrawn: false,
      stroke: kind === 'eraser' || kind === 'lasso' ? null : {
        id: strokeId(), type: kind === 'highlighter' ? 'h' : kind === 'pencil' ? 'b' : 'p',
        color: isHexColor(this.tool.color) ? this.tool.color.toLowerCase() : this.tool.color | 0, width: kind === 'highlighter' ? 0 : this.tool.width | 0, pts: null,
      },
    };
    // Bleistift: live deckend zeichnen (schrittweise, schnell), die Live-Ebene als Ganzes halbtransparent anzeigen
    this.live.style.opacity = kind === 'pencil' ? String(PENCIL_ALPHA) : '';
    // Lineal: Stift-, Bleistift- und Textmarker-Striche, die an seiner Kante beginnen, laufen entlang der Kante.
    if (this.guides.size && this.drawing.stroke) {
      for (const g of this.guides) {
        let edge = null;
        try { edge = g.start(pt); } catch { edge = null; }
        if (edge != null) { this.drawing.edge = edge; this.drawing.guide = g; break; }
      }
    }
    this._addSample(e);
    this._schedule();
  }

  _addSample(e) {
    const d = this.drawing;
    let pt = this._local(e);
    if (d.guide && this.guides.has(d.guide)) {
      try { const q = d.guide.project(pt, d.edge); if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) pt = q; } catch { /* Lineal weg */ }
    }
    d.lastScreen = pt;
    const hit = this._pageAt(pt.x, pt.y, d.P);
    const p = normPressure(e.pressure, e.pointerType);
    if (d.kind === 'eraser') {
      this._eraseAt(hit.ux, hit.uy);
      return;
    }
    if (d.kind === 'lasso') {
      this._lassoSample(hit.ux, hit.uy);
      return;
    }
    const pv = d.stroke.type === 'b' ? pencilP(d.stroke.width, p, altitudeOf(e)) : p;
    d.smoother.push(hit.ux, hit.uy, pv);
    d.lastRaw = { x: hit.ux, y: hit.uy, p: pv };
    this._holdCheck(d, pt);
  }

  // ───── hold still to straighten a shape (ARCHITEKTUR 11.4) ─────

  _holdCheck(d, pt) {
    if (!this._recognize || e_isUp(d) || d.stroke.type === 'b') return; // Bleistift: Schraffieren ohne Formerkennung
    if (d.holdPt && Math.hypot(pt.x - d.holdPt.x, pt.y - d.holdPt.y) < 3) return; // still holding
    d.holdPt = { x: pt.x, y: pt.y };
    if (d.snapped) { d.snapped = null; d.drawn = 0; d.snapDrawn = false; this._clearLive(); } // moved on: freehand again
    clearTimeout(d.holdTimer);
    d.holdTimer = setTimeout(() => {
      if (this.drawing !== d || d.snapped) return;
      const res = this._recognize(Int32Array.from(d.smoother.out));
      if (!res) return;
      d.snapped = res;
      d.snapDrawn = false;
      this._schedule();
    }, 500);
  }

  _eraseAt(ux, uy) {
    const d = this.drawing;
    const P = d.P;
    const r = ERASER_RADIUS / (this.z * this.k);
    const a = d.lastU || { x: ux, y: uy };
    d.lastU = { x: ux, y: uy };
    const x0 = Math.min(a.x, ux) - r, x1 = Math.max(a.x, ux) + r, y0 = Math.min(a.y, uy) - r, y1 = Math.max(a.y, uy) + r;
    let removed = false;
    for (let i = P.strokes.length - 1; i >= 0; i--) {
      const s = P.strokes[i];
      const b = bbox(s);
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      if (d.eraseMode === 'part') {
        const pieces = eraseSplit(s, a.x, a.y, ux, uy, r);
        if (pieces) { P.strokes.splice(i, 1, ...pieces); removed = true; d.splitChanged = true; }
        continue;
      }
      if (hitTestSegment(s, a.x, a.y, ux, uy, r)) {
        d.erased.push({ stroke: s, index: i });
        P.strokes.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this._pageChanged(P, true);
  }

  _liveTransform(ctx, P) {
    const r = this._screenRect(P);
    setPageTransform(ctx, this.dpr * this.z * this.k, r.x * this.dpr, r.y * this.dpr);
  }

  _drawLive() {
    const d = this.drawing;
    const ctx = this.liveCtx;
    if (d.kind === 'lasso') {
      if (d.lasso.mode !== 'new') return;
      const path = d.lasso.path;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      if (path.length < 4) return;
      this._liveTransform(ctx, d.P);
      ctx.beginPath();
      ctx.moveTo(path[0], path[1]);
      for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
      const px = 1 / (this.z * this.k); // 1 CSS px in page units
      ctx.setLineDash([6 * px, 5 * px]);
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = '#2f5fd0';
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (d.kind === 'eraser') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      ctx.beginPath();
      ctx.arc(d.lastScreen.x * this.dpr, d.lastScreen.y * this.dpr, ERASER_RADIUS * this.dpr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = this.dpr;
      ctx.stroke();
      return;
    }
    if (d.snapped) {
      if (d.snapDrawn) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      this._liveTransform(ctx, d.P);
      const shape = { ...d.stroke, pts: d.snapped.pts };
      if (shape.type === 'h') drawHighlighter(ctx, shape); else drawPen(ctx, shape);
      d.snapDrawn = true;
      return;
    }
    const out = d.smoother.out;
    const n = out.length / 3;
    if (!n) return;
    d.stroke.pts = out;
    if (d.stroke.type === 'h') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      this._liveTransform(ctx, d.P);
      drawHighlighter(ctx, d.stroke);
    } else if (n > d.drawn) {
      this._liveTransform(ctx, d.P);
      drawPen(ctx, d.stroke, Math.max(0, d.drawn - 1));
      d.drawn = n;
    }
  }

  _clearLive() {
    this.liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.liveCtx.clearRect(0, 0, this.live.width, this.live.height);
  }

  _endDraw() {
    const d = this.drawing;
    if (!d) return;
    this.drawing = null;
    if (d.kind === 'lasso') {
      this._clearLive();
      this._lassoEnd(d);
    } else if (d.kind === 'eraser') {
      this._clearLive();
      if (d.eraseMode === 'part') {
        if (d.splitChanged) this._pushHistory({ type: 'replace', pageId: d.P.id, before: d.before, after: d.P.strokes.map(snap) });
      } else if (d.erased.length) this._pushHistory({ type: 'erase', pageId: d.P.id, items: d.erased });
    } else {
      clearTimeout(d.holdTimer);
      d.ended = true;
      if (d.lastRaw && !d.snapped) d.smoother.finish(d.lastRaw.x, d.lastRaw.y, d.lastRaw.p);
      const stroke = d.stroke;
      stroke.pts = d.snapped ? Int32Array.from(d.snapped.pts) : d.smoother.points();
      this._clearLive();
      if (stroke.pts.length >= 3) {
        d.P.strokes.push(stroke);
        this._drawCommitted(d.P, stroke);
        this._pageChanged(d.P, false);
        this._pushHistory({ type: 'add', pageId: d.P.id, stroke });
      }
    }
    this._invalidateDetail();
  }

  _abortDraw() {
    if (this.drawing) clearTimeout(this.drawing.holdTimer);
    this.drawing = null;
    this._clearLive();
  }
}
