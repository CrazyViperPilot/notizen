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

import { PAGE, PAGE_GAP, PAGE_PAD, ZOOM_MIN, ZOOM_MAX, ERASER_RADIUS, UNDO_LIMIT, SAVE_DELAY } from '../config.js';
import { decodeStrokes, encodeStrokes, strokeId } from './codec.js';
import { Smoother, normPressure, hitTestSegment, bbox } from './stroke.js';
import { drawPage, drawPen, drawHighlighter, setPageTransform } from './render.js';

const MAX_PAGE_CSS = 1100;      // max page width at zoom 1 (desktop)
const MAX_BASE_PX = 2400;       // max base canvas width in device px
const KEEP_RANGE = 1.0;         // keep canvases for pages within this many screen heights
const INERTIA_FRICTION = 0.94;  // per 16 ms
const DETAIL_DELAY = 120;       // ms after the last view change

export function createSurface(container, opts = {}) {
  return new Surface(container, opts);
}

class Surface extends EventTarget {
  constructor(container, { readOnly = false, fingerDraw = false } = {}) {
    super();
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
        // Changed elsewhere (sync). Local undo steps for this page no longer apply.
        P.strokes = decodeStrokes(raw);
        P.raw = raw;
        this._dropHistory(P.id);
        P.rendered = false;
      }
      if (P.paper !== row.paper || P.orient !== row.orient) P.rendered = false;
      P.paper = row.paper;
      P.orient = row.orient === 'l' ? 'l' : 'p';
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
    this.setPages(this.pages.map((P) => (P.id === row.id ? row : { id: P.id, paper: P.paper, orient: P.orient, strokes: P.raw })), { keepView: true });
  }

  setTool(tool) {
    this.tool = { ...this.tool, ...tool };
  }

  setFingerDraw(on) {
    this.fingerDraw = !!on;
  }

  undo() {
    const e = this.history.pop();
    if (!e) return;
    const P = this.byId.get(e.pageId);
    if (P) {
      if (e.type === 'add') P.strokes = P.strokes.filter((s) => s !== e.stroke);
      else for (const it of [...e.items].sort((a, b) => a.index - b.index)) P.strokes.splice(it.index, 0, it.stroke);
      this._pageChanged(P, true);
    }
    this.redoStack.push(e);
    this._emitHistory();
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    const P = this.byId.get(e.pageId);
    if (P) {
      if (e.type === 'add') P.strokes.push(e.stroke);
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
    this.el.append(this.layer, this.detail, this.live);
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
    let maxW = PAGE.p.w;
    for (const P of this.pages) maxW = Math.max(maxW, PAGE[P.orient].w);
    const avail = Math.max(100, this.W - 2 * PAGE_PAD);
    this.k = Math.min(avail, MAX_PAGE_CSS) / maxW;
    let y = PAGE_PAD;
    for (const P of this.pages) {
      const { w, h } = PAGE[P.orient];
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
    this._schedule();
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

  _sizeCanvas(P) {
    if (!P.canvas) return;
    const w = Math.min(MAX_BASE_PX, Math.round(P.cw * this.dpr));
    P.scale = w / P.w;  // device px per unit on the base canvas
    P.canvas.width = w;
    P.canvas.height = Math.round(P.h * P.scale);
  }

  _releasePage(P) {
    if (P.canvas) { P.canvas.width = 0; P.canvas.height = 0; }
    if (P.div) P.div.remove();
    P.div = null; P.canvas = null; P.rendered = false;
    this.renderQueue.delete(P);
  }

  _renderBase(P) {
    if (!P.canvas) return;
    const ctx = P.canvas.getContext('2d');
    setPageTransform(ctx, P.scale);
    drawPage(ctx, P, P.strokes, P.scale);
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
      drawPage(ctx, P, P.strokes, s, clip);
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
      drawPen(ctx, stroke);
    }
    const d = this.detailState;
    if (d && this.detail.style.display !== 'none') {
      const ctx = this.detail.getContext('2d');
      const s = this.dpr * d.z * this.k;
      ctx.save();
      setPageTransform(ctx, s, (P.x * d.z - d.ox) * this.dpr, (P.y * d.z - d.oy) * this.dpr);
      drawPen(ctx, stroke);
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
      } else return;
    }

    if (e.pointerType === 'touch' || e.pointerType === 'mouse' || (e.pointerType === 'pen' && this.readOnly)) {
      e.preventDefault();
      this._capture(e);
      this._stopInertia();
      this.touches.set(e.pointerId, pt);
      this._startGesture();
    }
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
    this.touches.set(e.pointerId, this._local(e));
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
        type: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.z,
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
    const kind = this.tool.kind;
    this.drawing = {
      pointerId: e.pointerId, pointerType: e.pointerType, P, kind,
      smoother: new Smoother(), drawn: 0, lastScreen: this._local(e),
      erased: [], lastU: null,
      stroke: kind === 'eraser' ? null : {
        id: strokeId(), type: kind === 'highlighter' ? 'h' : 'p',
        color: this.tool.color | 0, width: kind === 'highlighter' ? 0 : this.tool.width | 0, pts: null,
      },
    };
    this._addSample(e);
    this._schedule();
  }

  _addSample(e) {
    const d = this.drawing;
    const pt = this._local(e);
    d.lastScreen = pt;
    const hit = this._pageAt(pt.x, pt.y, d.P);
    const p = normPressure(e.pressure, e.pointerType);
    if (d.kind === 'eraser') {
      this._eraseAt(hit.ux, hit.uy);
      return;
    }
    d.smoother.push(hit.ux, hit.uy, p);
    d.lastRaw = { x: hit.ux, y: hit.uy, p };
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
    if (d.kind === 'eraser') {
      this._clearLive();
      if (d.erased.length) this._pushHistory({ type: 'erase', pageId: d.P.id, items: d.erased });
    } else {
      if (d.lastRaw) d.smoother.finish(d.lastRaw.x, d.lastRaw.y, d.lastRaw.p);
      const stroke = d.stroke;
      stroke.pts = d.smoother.points();
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
    this.drawing = null;
    this._clearLive();
  }
}
