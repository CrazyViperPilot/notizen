// Lineal im Editor: transparentes 30-cm-Lineal über der Schreibfläche (nur im Editor, nicht in shared.js).
// Stift: an einer Längskante ansetzen → gerade Linie (die Surface nutzt addGuide, Projektion aus ruler-geom.js).
// Finger und Maus: verschieben; Dreh-Griff am rechten Ende ziehen; zwei Finger auf dem Lineal drehen und verschieben;
// Doppeltipp auf das Lineal setzt den Winkel auf 0°. Der Stift schreibt immer, Pen-Ereignisse werden nie abgefangen.
// Geometrie in ruler-geom.js; hier nur DOM und Eingabe. Benutzertexte nur über textContent.

import { h } from './dom.js';
import {
  RULER_MM, RULER_H, measureLine, setRulerMm, GRIP_R, GRIP_INSET, rulerLength, edgeAt, projectToEdge, hitRuler, hitGrip, twist, snapAngle, normDeg, ticks,
} from './ruler-geom.js';

const KEY = 'notizen:ruler';
const MAX_CANVAS_PX = 4096;   // Safari begrenzt die Kantenlänge von Canvas; bei langen Linealen sinkt dann die Auflösung
const MARGIN = 22;            // das Lineal bleibt mit einem Stück im sichtbaren Bereich
const GUIDE_PX = 24;          // Abstand, bis zu dem der Stift an eine Kante rastet (ARCHITEKTUR-Vorgabe des Auftrags)
const TAP_MS = 350;           // Doppeltipp: Zeitfenster …
const TAP_PX = 10;            //   … maximale Bewegung eines Tipps …
const TAP_DIST = 40;          //   … maximaler Abstand zwischen den Tipps

const BG = 'rgba(240, 248, 255, 0.45)';
const EDGE = 'rgba(60, 80, 110, 0.55)';
const INK = 'rgba(29, 35, 43, 0.85)';
const ACCENT = '#2f5fd0';

/** Gespeicherter Zustand {x, y, angle, visible} oder null. */
function loadState() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (!v || typeof v !== 'object') return null;
    if (![v.x, v.y, v.angle].every((n) => Number.isFinite(n))) return null;
    return { x: v.x, y: v.y, angle: normDeg(v.angle), visible: v.visible === true };
  } catch { return null; }
}

function saveState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* voll/privat */ }
}

/** Zeichnet das Lineal in den Canvas. s = CSS-px pro mm. */
function drawRuler(canvas, s) {
  const L = rulerLength(s), H = RULER_H;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / L);
  const w = Math.max(1, Math.round(L * dpr)), hh = Math.max(1, Math.round(H * dpr));
  canvas.style.width = L + 'px';
  canvas.style.height = H + 'px';
  canvas.width = w;
  canvas.height = hh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(w / L, 0, 0, hh / H, 0, 0);
  ctx.clearRect(0, 0, L, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, L, H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = EDGE;
  ctx.strokeRect(0.5, 0.5, L - 1, H - 1);

  // Skala: oben von der oberen Kante nach unten, unten von der unteren Kante nach oben
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  const gx = L - GRIP_INSET;   // Mitte des Dreh-Griffs (Canvas-Koordinaten)
  for (const t of ticks(s, RULER_MM)) {
    const x = t.mm * s;
    const len = t.len === 'cm' ? 20 : t.len === 'half' ? 11 : 6;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, len);
    ctx.moveTo(x, H); ctx.lineTo(x, H - len);
    ctx.stroke();
    if (t.label !== undefined && Math.abs(x - gx) > GRIP_R + 6) {
      const tx = t.mm === 0 ? 2 : t.mm === RULER_MM ? L - 2 : x;
      ctx.textAlign = t.mm === 0 ? 'left' : t.mm === RULER_MM ? 'right' : 'center';
      ctx.fillText(t.label, tx, 28);
      ctx.fillText(t.label, tx, H - 28);
    }
  }
  ctx.textAlign = 'left';
  ctx.fillText('cm', 10, H / 2);

  // Dreh-Griff
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(gx, H / 2, GRIP_R - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(gx, H / 2, 8, Math.PI * 0.15, Math.PI * 1.35);
  ctx.stroke();
}

/**
 * createRuler(holder, surface) → { show(), hide(), toggle(), isVisible(), destroy() }
 * holder = .ed-surface (Container der Surface), surface = Surface aus js/ink/surface.js.
 */
export function createRuler(holder, surface) {
  try { const p = JSON.parse(localStorage.getItem('notizen:prefs')); setRulerMm(p && p.rulerMm); } catch { setRulerMm(300); }
  const body = holder.parentElement || holder;   // .ed-body: Capture-Listener, bevor die Surface Zeiger sieht
  const stored = loadState();
  let state = stored ? { x: stored.x, y: stored.y, angle: stored.angle } : { x: 0, y: 0, angle: 0 };
  let placed = !!stored;        // false = beim ersten Einblenden mittig platzieren
  let visible = false;
  let drawnScale = 0;           // CSS-px pro mm, für die der Canvas gezeichnet ist
  let gesture = null;           // {mode:'move', ox, oy, sx, sy, t} | {mode:'rotate', a0, s0} | {mode:'twist', ids, a0, b0, s0}
  let lastTap = null;           // {t, x, y} des letzten Tipps auf das Lineal
  const ptrs = new Map();       // pointerId → {x, y} (eigene Zeiger auf dem Lineal)
  const swallow = new Set();    // pointerIds, die wir stillschweigend schlucken (Zweitfinger neben laufender Geste)

  const canvas = h('canvas', { className: 'ruler', 'aria-hidden': 'true', hidden: true });
  const label = h('div', { className: 'ruler-angle', 'aria-hidden': 'true', hidden: true });
  holder.append(canvas, label);

  const pxPerMm = () => 10 * surface.viewScale();
  const toLocal = (e) => {
    const r = holder.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const angleTo = (p) => (Math.atan2(p.y - state.y, p.x - state.x) * 180) / Math.PI;
  const absorb = (e) => { e.stopPropagation(); e.preventDefault(); };
  const showAngle = (on) => { label.hidden = !on; };

  function clampState() {
    const W = holder.clientWidth, H = holder.clientHeight;
    if (!W || !H) return;       // noch kein Layout
    state.x = Math.min(Math.max(state.x, MARGIN), W - MARGIN);
    state.y = Math.min(Math.max(state.y, MARGIN), H - MARGIN);
  }

  /** Position per transform (Drehung um den Mittelpunkt); Winkeltext mittig. */
  function place() {
    const L = rulerLength(pxPerMm());
    canvas.style.transform = `translate(${state.x - L / 2}px, ${state.y - RULER_H / 2}px) rotate(${state.angle}deg)`;
    label.style.transform = `translate(${state.x}px, ${state.y}px) translate(-50%, -50%)`;
    label.textContent = Math.round(state.angle) + '°';
  }

  function redraw() {
    const s = pxPerMm();
    if (!(s > 0)) return;       // Surface hat noch keine Seiten
    drawRuler(canvas, s);
    drawnScale = s;
  }

  function save() {
    if (placed) saveState({ x: state.x, y: state.y, angle: state.angle, visible });
  }

  // ───── Stift: Kante als Führung ─────
  const guide = {
    start: (pt) => (visible ? edgeAt(state, pxPerMm(), pt, GUIDE_PX) : null),
    project: (pt, edge) => projectToEdge(state, pt, edge),

    measure: (p0, p1) => measureLine(p0, p1, pxPerMm()),
  };

  // ───── Finger und Maus ─────
  function onDown(e) {
    if (!visible || e.pointerType === 'pen') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!holder.contains(e.target)) return;      // nur Schreibfläche, nicht Leisten und Dialoge
    const pt = toLocal(e);
    const s = pxPerMm();
    if (!hitRuler(state, s, pt)) {
      // Außerhalb des Lineals: nur schlucken, wenn gerade eine Lineal-Geste läuft (sonst zoomt die Fläche mit)
      if (ptrs.size) { absorb(e); swallow.add(e.pointerId); }
      return;
    }
    absorb(e);
    if (ptrs.size >= 2) { swallow.add(e.pointerId); return; }   // dritter Finger
    const grip = hitGrip(state, s, pt);
    ptrs.set(e.pointerId, { x: pt.x, y: pt.y });
    if (ptrs.size === 1) {
      gesture = grip
        ? { mode: 'rotate', a0: angleTo(pt), s0: state.angle }
        : { mode: 'move', ox: pt.x - state.x, oy: pt.y - state.y, sx: pt.x, sy: pt.y, t: e.timeStamp };
      showAngle(grip);
    } else {
      const ids = [...ptrs.keys()];
      const a = ptrs.get(ids[0]), b = ptrs.get(ids[1]);
      gesture = {
        mode: 'twist', ids, a0: { x: a.x, y: a.y }, b0: { x: b.x, y: b.y },
        s0: { x: state.x, y: state.y, angle: state.angle },
      };
      showAngle(true);
    }
    place();
  }

  function onMove(e) {
    if (swallow.has(e.pointerId)) { e.stopPropagation(); return; }
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    e.stopPropagation();
    const pt = toLocal(e);
    p.x = pt.x;
    p.y = pt.y;
    if (!gesture) return;
    if (gesture.mode === 'move') {
      state.x = pt.x - gesture.ox;
      state.y = pt.y - gesture.oy;
    } else if (gesture.mode === 'rotate') {
      state.angle = normDeg(gesture.s0 + normDeg(angleTo(pt) - gesture.a0));
    } else {
      const A = ptrs.get(gesture.ids[0]), B = ptrs.get(gesture.ids[1]);
      if (!A || !B) return;
      const tw = twist(gesture.a0, gesture.b0, A, B);
      state.x = gesture.s0.x + tw.dx;
      state.y = gesture.s0.y + tw.dy;
      state.angle = normDeg(gesture.s0.angle + tw.dAngle);
    }
    clampState();
    place();
  }

  function onUp(e) {
    if (swallow.has(e.pointerId)) { swallow.delete(e.pointerId); e.stopPropagation(); return; }
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    e.stopPropagation();
    ptrs.delete(e.pointerId);
    const was = gesture;
    gesture = null;
    if (was && was.mode !== 'move') {
      // Drehen (Griff oder zwei Finger) endet auf dem 45°-Raster
      state.angle = snapAngle(state.angle);
      showAngle(false);
      if (ptrs.size === 1) {
        const [q] = ptrs.values();
        gesture = { mode: 'move', ox: q.x - state.x, oy: q.y - state.y, sx: q.x, sy: q.y, t: e.timeStamp };
      }
    } else if (was && !ptrs.size) {
      // Doppeltipp auf das Lineal → Winkel 0°
      const tap = e.type === 'pointerup' && Math.hypot(p.x - was.sx, p.y - was.sy) < TAP_PX && e.timeStamp - was.t < TAP_MS;
      if (tap && lastTap && e.timeStamp - lastTap.t < TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < TAP_DIST) {
        state.angle = 0;
        lastTap = null;
      } else {
        lastTap = tap ? { t: e.timeStamp, x: p.x, y: p.y } : null;
      }
    }
    if (!ptrs.size) save();
    clampState();
    place();
  }

  function onView() {
    if (!visible) return;
    if (pxPerMm() !== drawnScale) redraw();
    if (!gesture) clampState();
    place();
  }

  body.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  surface.addEventListener('view', onView);

  function show() {
    if (visible) return;
    if (!placed) {
      state = { x: holder.clientWidth / 2, y: holder.clientHeight / 2, angle: 0 };
      placed = true;
    }
    visible = true;
    clampState();
    canvas.hidden = false;
    redraw();
    place();
    surface.addGuide(guide);
    save();
  }

  function hide() {
    if (!visible) return;
    visible = false;
    canvas.hidden = true;
    label.hidden = true;
    gesture = null;
    lastTap = null;
    ptrs.clear();
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
      save();                                  // Sichtbarkeit bleibt gespeichert
      surface.removeGuide(guide);
      visible = false;
      gesture = null;
      ptrs.clear();
      swallow.clear();
      canvas.remove();
      label.remove();
    },
  };
}
