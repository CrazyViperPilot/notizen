// Zirkel im Editor: Einstichpunkt und Radius in echten mm (1 … 150), Bleistiftspitze auf dem Kreis.
// Stift: setzt er auf den Kreis, läuft der Strich exakt auf dem Kreis (surface.addGuide, projectToCircle aus compass-geom.js).
// Finger und Maus: Einstich oder Schenkel ziehen verschiebt den ganzen Zirkel; Spitze ziehen ändert Radius und Winkel
// (Radius beim Loslassen auf ganze mm). Der Stift schreibt immer, Pen-Ereignisse werden nie abgefangen.
// Geometrie in compass-geom.js; hier nur DOM und Eingabe. Benutzertexte nur über textContent.

import { h } from './dom.js';
import {
  ZIRKEL_DEFAULT_MM, MAX_CANVAS_PX, normDeg,
  clampRadius, snapRadius, tipPoint, hingePoint, compassBox, circleEdgeAt, projectToCircle, sweepDeg,
  angleAt, radiusAtPoint, formatRadius, formatMeasure, hitCenter, hitTip, hitLegs,
} from './compass-geom.js';

const KEY = 'notizen:zirkel';
const MARGIN = 22;             // der Einstichpunkt bleibt im sichtbaren Bereich
const GUIDE_PX = 24;           // Abstand, bis zu dem der Stift auf den Kreis rastet
const LABEL_PX = 30;           // Abstand der Radius-Beschriftung von der Spitze (px, nach außen)
const ACCENT = '#2f5fd0';
const CIRCLE = 'rgba(47, 95, 208, 0.5)';
const LEG = 'rgba(60, 70, 90, 0.35)';
const LEG_DARK = 'rgba(60, 70, 90, 0.6)';

/** Gespeicherter Zustand {cx, cy, r, a, visible} oder null. */
function loadState() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (!v || typeof v !== 'object') return null;
    if (![v.cx, v.cy].every((n) => Number.isFinite(n))) return null;
    return {
      cx: v.cx,
      cy: v.cy,
      r: clampRadius(v.r),
      a: normDeg(Number.isFinite(v.a) ? v.a : 0),
      visible: v.visible === true,
    };
  } catch { return null; }
}

function saveState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* voll/privat */ }
}

/**
 * Zeichnet Kreis, Schenkel, Gelenk, Einstich und Spitze in den Canvas. st = Zustand, s = CSS-px pro mm.
 * Der Mittelpunkt liegt in der Box bei (box.ox, box.oy); die Verschiebung im Container setzt place().
 */
function drawCompass(canvas, st, s) {
  const box = compassBox(st, s);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / Math.max(box.w, box.h));
  const pw = Math.max(1, Math.round(box.w * dpr)), ph = Math.max(1, Math.round(box.h * dpr));
  canvas.style.width = box.w + 'px';
  canvas.style.height = box.h + 'px';
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(pw / box.w, 0, 0, ph / box.h, 0, 0);
  ctx.clearRect(0, 0, box.w, box.h);

  const local = { cx: box.ox, cy: box.oy, r: st.r, a: st.a, visible: true };
  const c = { x: local.cx, y: local.cy };
  const t = tipPoint(local, s);
  const g = hingePoint(local, s);
  const R = st.r * s;
  const PI2 = Math.PI * 2;

  // Kreis: gestrichelt, dünn, halbtransparent (Vorschau)
  ctx.beginPath();
  ctx.arc(c.x, c.y, R, 0, PI2);
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = CIRCLE;
  ctx.stroke();
  ctx.setLineDash([]);

  // Schenkel: Einstich → Gelenk → Spitze, als breite, halbtransparente Linie
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = LEG;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(g.x, g.y);
  ctx.lineTo(t.x, t.y);
  ctx.stroke();

  // Gelenk
  ctx.fillStyle = LEG_DARK;
  ctx.beginPath();
  ctx.arc(g.x, g.y, 5, 0, PI2);
  ctx.fill();

  // Einstichpunkt: Fadenkreuz mit Kreis
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 7, 0, PI2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(c.x - 12, c.y); ctx.lineTo(c.x + 12, c.y);
  ctx.moveTo(c.x, c.y - 12); ctx.lineTo(c.x, c.y + 12);
  ctx.stroke();
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 2, 0, PI2);
  ctx.fill();

  // Bleistiftspitze (Radius-Griff)
  ctx.fillStyle = ACCENT;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(t.x, t.y, 5, 0, PI2);
  ctx.fill();
  ctx.stroke();
}

/**
 * createCompass(holder, surface) → { show(), hide(), toggle(), isVisible(), destroy() }
 * holder = .ed-surface (Container der Surface), surface = Surface aus js/ink/surface.js.
 */
export function createCompass(holder, surface) {
  const body = holder.parentElement || holder;   // .ed-body: Capture-Listener, bevor die Surface Zeiger sieht
  const stored = loadState();
  let state = stored
    ? { cx: stored.cx, cy: stored.cy, r: stored.r, a: stored.a, visible: false }
    : { cx: 0, cy: 0, r: ZIRKEL_DEFAULT_MM, a: 0, visible: false };
  let placed = !!stored;        // false = beim ersten Einblenden platzieren
  let visible = false;
  let drag = null;              // {id, mode: 'move'|'tip', dx, dy}: laufender Zug mit einem Finger/Maus
  const swallow = new Set();    // pointerIds, die still geschluckt werden (weitere Finger neben laufendem Zug)
  let drawnKey = '';            // Schlüssel des zuletzt gezeichneten Canvas-Inhalts
  let frame = 0;                // rAF-Kennung für gebündeltes Aktualisieren

  const canvas = h('canvas', { className: 'zirkel', 'aria-hidden': 'true', hidden: true });
  const label = h('div', { className: 'zirkel-label', 'aria-hidden': 'true', hidden: true });
  holder.append(canvas, label);

  const pxPerMm = () => 10 * surface.viewScale();
  const toLocal = (e) => {
    const r = holder.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const absorb = (e) => { e.stopPropagation(); e.preventDefault(); };

  function clampState() {
    const W = holder.clientWidth, H = holder.clientHeight;
    if (!W || !H) return;       // noch kein Layout
    state.cx = Math.min(Math.max(state.cx, MARGIN), W - MARGIN);
    state.cy = Math.min(Math.max(state.cy, MARGIN), H - MARGIN);
  }

  /** Position des Canvas (transform) und Beschriftung neben der Spitze; sofort. */
  function place() {
    const s = pxPerMm();
    const box = compassBox(state, s);
    canvas.style.transform = `translate(${state.cx - box.ox}px, ${state.cy - box.oy}px)`;
    const t = tipPoint(state, s);
    const rad = (state.a * Math.PI) / 180;
    const lx = t.x + Math.cos(rad) * LABEL_PX, ly = t.y + Math.sin(rad) * LABEL_PX;
    label.style.transform = `translate(${lx}px, ${ly}px) translate(-50%, -50%)`;
    label.textContent = formatRadius(state.r);
  }

  /** Zeichnet den Canvas nur neu, wenn sich Größe, Auflösung, Radius oder Winkel geändert haben. */
  function update() {
    if (!visible) return;
    place();
    const s = pxPerMm();
    if (!(s > 0)) return;       // Surface hat noch keine Seiten
    const box = compassBox(state, s);
    const key = [box.w, box.h, window.devicePixelRatio || 1, state.r * s, state.a].join('|');
    if (key !== drawnKey) {
      drawCompass(canvas, state, s);
      drawnKey = key;
    }
  }

  /** Aktualisierung bündeln: höchstens einmal pro Bildwechsel (Ziehen liefert viele Ereignisse). */
  function scheduleUpdate() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; update(); });
  }

  function save() {
    if (placed) saveState({ cx: state.cx, cy: state.cy, r: state.r, a: state.a, visible });
  }

  // ───── Stift: Kreis als Führung ─────
  const guide = {
    start: (pt) => (visible ? circleEdgeAt(state, pxPerMm(), pt, GUIDE_PX) : null),
    project: (pt) => projectToCircle(state, pxPerMm(), pt),
    measure: (p0, p1) => formatMeasure(state.r, sweepDeg(state, p0, p1)),
  };

  // ───── Finger und Maus ─────
  function onDown(e) {
    if (!visible || e.pointerType === 'pen') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!holder.contains(e.target)) return;      // nur Schreibfläche, nicht Leisten und Dialoge
    const pt = toLocal(e);
    const s = pxPerMm();
    let mode = null;
    if (hitTip(state, s, pt)) mode = 'tip';
    else if (hitCenter(state, s, pt) || hitLegs(state, s, pt)) mode = 'move';
    if (!mode) {
      // Außerhalb: nur schlucken, wenn gerade eine Zirkel-Geste läuft (sonst zoomt die Fläche mit)
      if (drag) { absorb(e); swallow.add(e.pointerId); }
      return;
    }
    absorb(e);
    if (drag) { swallow.add(e.pointerId); return; }   // zweiter Finger auf dem Zirkel
    const ref = mode === 'tip' ? tipPoint(state, s) : { x: state.cx, y: state.cy };
    drag = { id: e.pointerId, mode, dx: pt.x - ref.x, dy: pt.y - ref.y };
    update();
  }

  function onMove(e) {
    if (swallow.has(e.pointerId)) { e.stopPropagation(); return; }
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const pt = toLocal(e);
    const s = pxPerMm();
    if (drag.mode === 'move') {
      state.cx = pt.x - drag.dx;
      state.cy = pt.y - drag.dy;
      clampState();
    } else {
      // Spitze: Radius = Abstand vom Einstich, Winkel = Richtung zum Finger (ungerundet, Anzeige live)
      const target = { x: pt.x - drag.dx, y: pt.y - drag.dy };
      if (Math.hypot(target.x - state.cx, target.y - state.cy) > 1e-6) state.a = angleAt(state, target);
      state.r = radiusAtPoint(state, s, target);
    }
    scheduleUpdate();
  }

  function onUp(e) {
    if (swallow.has(e.pointerId)) { swallow.delete(e.pointerId); e.stopPropagation(); return; }
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const was = drag;
    drag = null;
    if (was.mode === 'tip') state.r = snapRadius(state.r);   // Radius endet auf ganzen mm
    clampState();
    update();
    save();
  }

  function onView() {
    if (!visible) return;
    clampState();
    update();
  }

  body.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  surface.addEventListener('view', onView);

  function show() {
    if (visible) return;
    if (!placed) {
      // Erstes Einblenden: Einstich in der Mitte des sichtbaren Bereichs, r = 30 mm, Spitze rechts
      state = { cx: holder.clientWidth / 2, cy: holder.clientHeight / 2, r: ZIRKEL_DEFAULT_MM, a: 0, visible: false };
      placed = true;
    }
    visible = true;
    state.visible = true;
    clampState();
    canvas.hidden = false;
    label.hidden = false;
    surface.addGuide(guide);
    update();
    save();
  }

  function hide() {
    if (!visible) return;
    visible = false;
    state.visible = false;
    canvas.hidden = true;
    label.hidden = true;
    drag = null;
    swallow.clear();
    surface.removeGuide(guide);
    save();
  }

  // Beim Öffnen wieder so, wie beim letzten Mal (an/aus, Lage)
  if (stored && stored.visible) show();

  return {
    show,
    hide,
    toggle() { if (visible) hide(); else show(); },
    isVisible() { return visible; },
    destroy() {
      body.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      surface.removeEventListener('view', onView);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      save();                                  // Sichtbarkeit bleibt gespeichert
      if (visible) surface.removeGuide(guide);
      visible = false;
      state.visible = false;
      drag = null;
      swallow.clear();
      canvas.remove();
      label.remove();
    },
  };
}
