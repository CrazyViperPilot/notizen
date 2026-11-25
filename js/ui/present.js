// Präsentationsmodus mit Laserpointer: Vollbild-Overlay, eine Seite auf einmal, eingepasst und zentriert.
// Blättern: Pfeiltasten, Bild auf/ab, Leertaste, Pos1/Ende, Wischen mit einem Finger (≥ 60 px), Tipp auf das linke/rechte Fünftel.
// Untere Leiste (blendet nach 2,5 s ohne Bewegung aus): ‹ › Seitenzähler, Laser (Taste L), Schließen (Esc).
// Laserpointer: Stift, Finger und Maus zeichnen eine verblassende rote Spur. Nichts wird gespeichert.
// Benutzertexte nur über textContent bzw. Attribute (kein innerHTML).

import { pageDims } from '../config.js';
import { decodeStrokes } from '../ink/codec.js';
import { drawPage, setPageTransform } from '../ink/render.js';
import { h } from './dom.js';
import { fullscreenSupported, isFullscreen, toggleFullscreen } from './fullscreen.js';

const LASER_COLOR = '#ff2d2d';
const LASER_WIDTH = 6;        // CSS px
const LASER_LIFE = 800;       // ms, danach ist ein Punkt der Spur unsichtbar
const LASER_GLOW = 12;        // CSS px Unschärfe
const DOT_R = 6;              // CSS px, Punkt an der aktuellen Position
const BAR_HIDE_MS = 2500;
const MAX_DPR = 3;
const PAGE_PAD = 12;          // CSS px Abstand der Seite zum Bildschirmrand
const SWIPE_MIN = 60;         // CSS px
const TAP_MOVE = 10;          // CSS px: weniger Bewegung zählt als Tipp
const TAP_MAX_MS = 700;       // länger gedrückt ist kein Tipp

/**
 * Einpassen (contain) eines Rechtecks pageW × pageH in boxW × boxH mit Rand pad, zentriert.
 * Liefert {x, y, w, h} in denselben Einheiten wie die Box.
 */
export function fitRect(pageW, pageH, boxW, boxH, pad = 0) {
  const aw = Math.max(0, boxW - 2 * pad);
  const ah = Math.max(0, boxH - 2 * pad);
  if (!(pageW > 0 && pageH > 0)) return { x: pad, y: pad, w: aw, h: ah };
  const s = Math.min(aw / pageW, ah / pageH);
  const w = pageW * s;
  const h = pageH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Deckkraft eines Spurpunkts nach `age` ms: 1 am Anfang, linear auf 0 nach `life` ms. Liefert 0..1. */
export function fadeAlpha(age, life = 800) {
  if (!(life > 0) || !Number.isFinite(age)) return 0;
  if (age <= 0) return 1;
  if (age >= life) return 0;
  return 1 - age / life;
}

/** Seitenindex um `delta` verschoben, auf 0 … n−1 geklemmt. Bei n = 0 ist das Ergebnis 0. */
export function nextIndex(i, delta, n) {
  if (!(n > 0)) return 0;
  const j = i + delta;
  return j < 0 ? 0 : j > n - 1 ? n - 1 : j;
}

/**
 * Richtung einer Wischbewegung: 1 = nach rechts, -1 = nach links, 0 = kein Wischen
 * (horizontale Strecke kürzer als `min` oder nicht überwiegend horizontal).
 */
export function swipeDir(dx, dy, min = 60) {
  const ax = Math.abs(dx);
  if (ax < min || ax <= Math.abs(dy)) return 0;
  return dx > 0 ? 1 : -1;
}

/**
 * Tipp-Zone: -1 = linkes Fünftel (zurück), 1 = rechtes Fünftel (weiter), 0 = Mitte.
 * Das Ergebnis ist direkt das Seiten-Delta für nextIndex().
 */
export function tapZone(x, width) {
  if (!(width > 0)) return 0;
  if (x < width / 5) return -1;
  if (x > (width * 4) / 5) return 1;
  return 0;
}

/**
 * Öffnet die Präsentation. Die Promise erfüllt sich beim Schließen (Esc, ✕).
 * pages: Model-Zeilen {id, paper, orient, size, strokes (String), bg}. getImage(assetId) → Promise<CanvasImageSource|null>.
 */
export function openPresentation({ title = '', pages = [], getImage = null, startIndex = 0 } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const n = list.length;
  if (!n) return Promise.resolve();

  return new Promise((resolve) => {
    let index = Math.min(n - 1, Math.max(0, Math.floor(Number(startIndex)) || 0));
    let laserOn = false;
    let done = false;
    let enteredFs = false;
    let nav = null;                  // laufende Zeigergeste {id, type, laser, x0, y0, x, y, t0, cancelled}
    let dot = null;                  // aktuelle Laserposition {x, y}
    const trail = [];                // Laserspur [{x, y, t, s}]; s = Strichanfang (keine Verbindung zum Vorgänger)
    let box = { w: 0, h: 0, dpr: 1 };
    let rafId = 0;
    let barTimer = 0;
    let resizeQueued = false;
    let ro = null;
    const prevFocus = document.activeElement;
    const imgCache = new Map();          // Asset-id → Bild oder null (fehlt)
    const imgPending = new Set();
    const strokeCache = new WeakMap();   // Seitenobjekt → dekodierte Striche

    // ───────── DOM ─────────
    const pageCanvas = h('canvas', { className: 'pres-canvas', 'aria-hidden': 'true' });
    const laserCanvas = h('canvas', { className: 'pres-laser', 'aria-hidden': 'true' });
    const stage = h('div', { className: 'pres-stage' }, pageCanvas, laserCanvas);
    const counter = h('span', { className: 'pres-count', 'aria-live': 'polite' });
    const prevBtn = h('button', { className: 'pres-btn', type: 'button', 'aria-label': 'Vorherige Seite', text: '‹', onclick: () => go(-1) });
    const nextBtn = h('button', { className: 'pres-btn', type: 'button', 'aria-label': 'Nächste Seite', text: '›', onclick: () => go(1) });
    const laserBtn = h('button', { className: 'pres-btn', type: 'button', 'aria-label': 'Laserpointer', 'aria-pressed': 'false', text: 'Laser', onclick: () => setLaser(!laserOn) });
    const closeBtn = h('button', { className: 'pres-btn', type: 'button', 'aria-label': 'Präsentation schließen', text: '✕', onclick: () => close() });
    const bar = h('div', { className: 'pres-bar' }, prevBtn, counter, nextBtn, laserBtn, closeBtn);
    const root = h('div', { className: 'pres', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Präsentation', tabIndex: -1 }, stage, bar);

    // ───────── Leiste ─────────
    function wake() {
      if (done) return;
      bar.classList.remove('is-hidden');
      clearTimeout(barTimer);
      barTimer = setTimeout(() => bar.classList.add('is-hidden'), BAR_HIDE_MS);
    }

    function updateBar() {
      counter.textContent = (index + 1) + ' / ' + n;
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === n - 1;
      laserBtn.setAttribute('aria-pressed', laserOn ? 'true' : 'false');
      laserBtn.classList.toggle('on', laserOn);
      root.classList.toggle('is-laser', laserOn);
    }

    // ───────── Seiten ─────────
    function strokesOf(page) {
      let s = strokeCache.get(page);
      if (!s) {
        s = decodeStrokes(page.strokes || '[]');
        strokeCache.set(page, s);
      }
      return s;
    }

    function loadImage(id) {
      if (!id || typeof getImage !== 'function' || imgCache.has(id) || imgPending.has(id)) return;
      imgPending.add(id);
      let req;
      try { req = Promise.resolve(getImage(id)); } catch (_) { req = Promise.resolve(null); }
      req.then((img) => (img && img.width > 0 && img.height > 0 ? img : null), () => null).then((img) => {
        imgPending.delete(id);
        if (done) return;
        imgCache.set(id, img);
        if (list[index] && list[index].bg === id) render();
      });
    }

    function imageOf(page) {
      if (!page.bg) return null;
      loadImage(page.bg);
      return imgCache.get(page.bg) || null;
    }

    function preloadAround() {
      for (let i = index - 1; i <= index + 1; i++) if (i >= 0 && i < n && list[i].bg) loadImage(list[i].bg);
    }

    function pruneImages() {
      const keep = new Set();
      for (let i = index - 2; i <= index + 2; i++) if (i >= 0 && i < n && list[i].bg) keep.add(list[i].bg);
      for (const id of imgCache.keys()) if (!keep.has(id)) imgCache.delete(id);
    }

    function render() {
      if (done) return;
      const page = list[index];
      const dims = pageDims(page.size, page.orient);
      const r = fitRect(dims.w, dims.h, box.w, box.h, PAGE_PAD);
      const pw = Math.max(1, Math.round(r.w * box.dpr));
      const ph = Math.max(1, Math.round(r.h * box.dpr));
      pageCanvas.style.left = r.x + 'px';
      pageCanvas.style.top = r.y + 'px';
      pageCanvas.style.width = r.w + 'px';
      pageCanvas.style.height = r.h + 'px';
      pageCanvas.width = pw;
      pageCanvas.height = ph;
      const ctx = pageCanvas.getContext('2d');
      const scale = pw / dims.w;
      setPageTransform(ctx, scale);
      drawPage(ctx, page, strokesOf(page), scale, null, imageOf(page));
      preloadAround();
    }

    function setIndex(j) {
      if (done || j === index) return;
      index = j;
      trail.length = 0;
      dot = null;
      pruneImages();
      render();
      updateBar();
      ensureLoop();
      wake();
    }

    function go(delta) {
      setIndex(nextIndex(index, delta, n));
    }

    function layout() {
      const w = root.clientWidth;
      const hh = root.clientHeight;
      box = { w, h: hh, dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR) };
      laserCanvas.width = Math.max(1, Math.round(w * box.dpr));
      laserCanvas.height = Math.max(1, Math.round(hh * box.dpr));
      render();
    }

    function onResize() {
      if (done || resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        if (!done) layout();
      });
    }

    // ───────── Laser ─────────
    function setLaser(on) {
      laserOn = !!on;
      if (!laserOn) {
        trail.length = 0;
        dot = null;
        if (nav) nav.laser = false;
      }
      updateBar();
      ensureLoop();
      wake();
    }

    function laserPoint(x, y, start = false) {
      trail.push({ x, y, t: performance.now(), s: start });
      dot = { x, y };
      ensureLoop();
    }

    function ensureLoop() {
      if (!rafId && !done) rafId = requestAnimationFrame(tick);
    }

    function tick() {
      rafId = 0;
      if (done) return;
      const now = performance.now();
      while (trail.length && now - trail[0].t >= LASER_LIFE) trail.shift();
      drawLaser(now);
      if (trail.length) ensureLoop();
    }

    function drawLaser(now) {
      const ctx = laserCanvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, laserCanvas.width, laserCanvas.height);
      if (!laserOn) return;
      const d = box.dpr;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = LASER_WIDTH;
      ctx.strokeStyle = LASER_COLOR;
      ctx.fillStyle = LASER_COLOR;
      ctx.shadowColor = LASER_COLOR;
      ctx.shadowBlur = LASER_GLOW * d; // shadowBlur wird nicht von der Transformation skaliert
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        if (b.s) continue;
        const alpha = fadeAlpha(now - b.t, LASER_LIFE);
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (dot) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // ───────── Zeiger ─────────
    function onPointerDown(e) {
      wake();
      if (e.target instanceof Element && e.target.closest('.pres-bar')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Ein Zeiger läuft schon: Der Stift verdrängt eine Berührung (Handballen), sonst wird die zweite Berührung ignoriert.
      if (nav && !(e.pointerType === 'pen' && nav.type !== 'pen')) {
        nav.cancelled = true;
        return;
      }
      e.preventDefault();
      const laser = laserOn;
      nav = {
        id: e.pointerId, type: e.pointerType, laser,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        t0: performance.now(), cancelled: false,
      };
      try { root.setPointerCapture(e.pointerId); } catch (_) { /* ohne Capture geht es auch */ }
      if (laser) laserPoint(e.clientX, e.clientY, true);
    }

    function onPointerMove(e) {
      if (nav && e.pointerId === nav.id) {
        nav.x = e.clientX;
        nav.y = e.clientY;
        if (nav.laser) {
          const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          if (events.length) for (const c of events) laserPoint(c.clientX, c.clientY);
          else laserPoint(e.clientX, e.clientY);
        }
        return;
      }
      if (laserOn && e.pointerType === 'mouse') {
        wake();
        dot = { x: e.clientX, y: e.clientY };
        ensureLoop();
      }
    }

    function onPointerEnd(e, cancelled) {
      if (!nav || e.pointerId !== nav.id) return;
      const g = nav;
      nav = null;
      if (g.laser) {
        if (e.pointerType !== 'mouse') dot = null; // bei der Maus bleibt der Punkt an der Position (Hover)
        ensureLoop();
        return;
      }
      if (cancelled || g.cancelled) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (Math.hypot(dx, dy) <= TAP_MOVE) {
        if (performance.now() - g.t0 <= TAP_MAX_MS) {
          const d = tapZone(e.clientX, root.clientWidth);
          if (d) go(d);
        }
        return;
      }
      const s = swipeDir(dx, dy, SWIPE_MIN);
      if (s) go(-s); // nach links wischen = weiter, nach rechts = zurück
    }

    const onUp = (e) => onPointerEnd(e, false);
    const onCancel = (e) => onPointerEnd(e, true);
    const onContext = (e) => e.preventDefault();

    // ───────── Tastatur ─────────
    function onKey(e) {
      if (done || e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': go(1); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': go(-1); break;
        case 'Home': setIndex(0); break;
        case 'End': setIndex(n - 1); break;
        case 'l': case 'L': setLaser(!laserOn); break;
        case 'Escape': close(); break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        wake();
      }
    }

    // ───────── Schließen ─────────
    function close() {
      if (done) return;
      done = true;
      clearTimeout(barTimer);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('lostpointercapture', onCancel);
      root.removeEventListener('contextmenu', onContext);
      root.remove();
      nav = null;
      dot = null;
      trail.length = 0;
      imgCache.clear();
      imgPending.clear();
      pageCanvas.width = 0;
      pageCanvas.height = 0;
      laserCanvas.width = 0;
      laserCanvas.height = 0;
      if (enteredFs && isFullscreen()) toggleFullscreen();
      if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus();
      resolve();
    }

    // ───────── Start ─────────
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
    root.addEventListener('lostpointercapture', onCancel);
    root.addEventListener('contextmenu', onContext);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(onResize);
      ro.observe(root);
    }
    document.body.append(root);
    if (fullscreenSupported() && !isFullscreen()) {
      enteredFs = true;
      toggleFullscreen();
    }
    layout();
    updateBar();
    wake();
    root.focus();
  });
}
