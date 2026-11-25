// Geodreieck im Editor: transparentes Geodreieck (Hypotenuse 16 cm, Winkelmesser) über der Schreibfläche, im Maßstab der Seite.
// Stift: an einer Kante ansetzen → gerade Linie (surface.addGuide, Projektion aus geodreieck-geom.js).
// Finger und Maus: verschieben; Dreh-Griff an der Spitze ziehen oder zwei Finger drehen (immer um den Nullpunkt);
// Doppeltipp auf das Geodreieck setzt den Winkel auf 0°. Der Stift schreibt immer, Pen-Ereignisse werden nie abgefangen.
// Geometrie in geodreieck-geom.js; hier nur DOM und Eingabe. Benutzertexte nur über textContent.

import { h } from './dom.js';
import {
  ARC_R_MM, GEO_GRIP_R, geoBox, geoGripDist, geoEdgeAt, geoProject, hitGeo, hitGeoGrip, degreeTicks, hypTicks,
  twist, snapAngle, normDeg,
} from './geodreieck-geom.js';

const KEY = 'notizen:geodreieck';
const MAX_CANVAS_PX = 4096;   // wie beim Lineal: Safari begrenzt die Kantenlänge von Canvas
const MARGIN = 22;            // der Nullpunkt bleibt im sichtbaren Bereich
const GUIDE_PX = 24;          // Abstand, bis zu dem der Stift an eine Kante rastet
const TAP_MS = 350;           // Doppeltipp: Zeitfenster …
const TAP_PX = 10;            //   … maximale Bewegung eines Tipps …
const TAP_DIST = 40;          //   … maximaler Abstand zwischen den Tipps
const LBL_OUTER_MM = 42;      // Radius der äußeren Gradzahlen
const LBL_INNER_MM = 30;      // Radius der inneren Gradzahlen
const LBL_CLEAR_MM = 13;      // Mindesthöhe der Gradzahlen über der langen Kante (darunter stehen die cm-Zahlen)
const LBL_HYP_MM = 9;         // Abstand der Skalen-Beschriftung von der Hypotenuse (nach oben, ins Dreieck)

const BG = 'rgba(240, 248, 255, 0.45)';
const EDGE = 'rgba(60, 80, 110, 0.55)';
const INK = 'rgba(29, 35, 43, 0.85)';
const PARALLEL = 'rgba(60, 80, 110, 0.2)';
const ACCENT = '#2f5fd0';
const FONT = '11px system-ui, -apple-system, sans-serif';
const FONT_SMALL = '10px system-ui, -apple-system, sans-serif';
const FONT_ZERO = 'bold 12px system-ui, -apple-system, sans-serif';

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

/** Zeichnet das Geodreieck in den Canvas. s = CSS-px pro mm. Koordinaten: mm → Canvas-px um den Nullpunkt (box.ox, box.oy). */
function drawGeodreieck(canvas, s) {
  const box = geoBox(s);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / Math.max(box.w, box.h));
  const w = Math.max(1, Math.round(box.w * dpr)), hh = Math.max(1, Math.round(box.h * dpr));
  canvas.style.width = box.w + 'px';
  canvas.style.height = box.h + 'px';
  canvas.width = w;
  canvas.height = hh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(w / box.w, 0, 0, hh / box.h, 0, 0);
  ctx.clearRect(0, 0, box.w, box.h);

  const K = 80;                                   // mm: halbe Hypotenuse = Höhe
  const X = (u) => box.ox + u * s;
  const Y = (n) => box.oy + n * s;
  const radial = (r, deg) => {                    // Punkt auf Radius r (mm) bei Winkel deg
    const a = (deg * Math.PI) / 180;
    return [X(r * Math.cos(a)), Y(-r * Math.sin(a))];
  };

  // Dreieck (nur die Fläche innerhalb ist gefüllt, der Außenbereich bleibt durchsichtig)
  ctx.beginPath();
  ctx.moveTo(X(-K), Y(0)); ctx.lineTo(X(K), Y(0)); ctx.lineTo(X(0), Y(-K)); ctx.closePath();
  ctx.fillStyle = BG;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = EDGE;
  ctx.stroke();

  // Dünne Parallelen zur Hypotenuse alle 5 mm, bis kurz vor die Spitze
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = PARALLEL;
  ctx.beginPath();
  for (let k = 1; k <= 16; k++) {
    const n = -5 * k;
    const r = K + n - 1;                          // halbe Breite des Dreiecks in dieser Höhe, 1 mm Abstand zu den Schenkeln
    if (r < 2) break;
    ctx.moveTo(X(-r), Y(n)); ctx.lineTo(X(r), Y(n));
  }
  ctx.stroke();

  // Winkelmesser: Bogen mit Radius 52 mm, Gradstriche vom Rand nach innen
  ctx.lineWidth = 0.75;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(X(0), Y(0), ARC_R_MM * s, -Math.PI, 0);
  ctx.stroke();
  const tickLen = { ten: 5, five: 3, one: 1.5 };
  const tickWidth = { ten: 1.2, five: 0.9, one: 0.6 };
  const degs = degreeTicks(s);
  for (const kind of ['one', 'five', 'ten']) {
    ctx.lineWidth = tickWidth[kind];
    ctx.beginPath();
    for (const t of degs) {
      if (t.len !== kind) continue;
      const [x1, y1] = radial(ARC_R_MM, t.deg);
      const [x2, y2] = radial(ARC_R_MM - tickLen[kind], t.deg);
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  // Gradzahlen: außen 0 … 180, innen 180 … 0 (gegenläufig), alle 10°
  ctx.fillStyle = INK;
  ctx.font = FONT_SMALL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of degs) {
    // Zahlen dicht über der langen Kante würden die cm-Beschriftung überdecken: erst ab LBL_CLEAR_MM Höhe
    const clear = (r) => r * Math.sin((t.deg * Math.PI) / 180) >= LBL_CLEAR_MM;
    if (t.outer !== undefined && clear(LBL_OUTER_MM)) { const [x, y] = radial(LBL_OUTER_MM, t.deg); ctx.fillText(t.outer, x, y); }
    if (t.inner !== undefined && clear(LBL_INNER_MM)) { const [x, y] = radial(LBL_INNER_MM, t.deg); ctx.fillText(t.inner, x, y); }
  }

  // Nullpunkt: kleine Senkrechte über dem Nullpunkt
  ctx.lineWidth = 1;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(0), Y(-12));
  ctx.stroke();

  // Skala auf der Hypotenuse, −70 … +70 mm (mm-Striche kurz, 5 mm mittel, cm lang)
  const hypLen = { cm: 5, half: 3, mm: 1.5 };
  for (const t of hypTicks(s)) {
    ctx.lineWidth = t.len === 'cm' ? 1.4 : 1;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.moveTo(X(t.mm), Y(0)); ctx.lineTo(X(t.mm), Y(-hypLen[t.len]));
    ctx.stroke();
    if (t.label !== undefined) {
      if (t.mm === 0) {                           // die 0 in der Mitte hervorheben
        ctx.font = FONT_ZERO; ctx.fillStyle = ACCENT; ctx.textAlign = 'left';
        ctx.fillText(t.label, X(2), Y(-LBL_HYP_MM));
      } else {
        ctx.font = FONT; ctx.fillStyle = INK; ctx.textAlign = 'center';
        ctx.fillText(t.label, X(t.mm), Y(-LBL_HYP_MM));
      }
    }
  }

  // Rechter Winkel an der Spitze: kleines Quadrat (5 mm) entlang der Schenkel
  const q = 5 / Math.SQRT2;
  const apexU = 0, apexN = -K;
  ctx.lineWidth = 0.75;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.moveTo(X(apexU - q), Y(apexN + q));
  ctx.lineTo(X(apexU), Y(apexN + 2 * q));
  ctx.lineTo(X(apexU + q), Y(apexN + q));
  ctx.stroke();

  // Dreh-Griff an der Spitze (wie beim Lineal)
  const gy = box.oy - geoGripDist(s);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(box.ox, gy, GEO_GRIP_R - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(box.ox, gy, 8, Math.PI * 0.15, Math.PI * 1.35);
  ctx.stroke();
}

/**
 * createGeodreieck(holder, surface) → { show(), hide(), toggle(), isVisible(), destroy() }
 * holder = .ed-surface (Container der Surface), surface = Surface aus js/ink/surface.js.
 */
export function createGeodreieck(holder, surface) {
  const body = holder.parentElement || holder;   // .ed-body: Capture-Listener, bevor die Surface Zeiger sieht
  const stored = loadState();
  let state = stored ? { x: stored.x, y: stored.y, angle: stored.angle } : { x: 0, y: 0, angle: 0 };
  let placed = !!stored;        // false = beim ersten Einblenden platzieren
  let visible = false;
  let drawnScale = 0;           // CSS-px pro mm, für die der Canvas gezeichnet ist
  let gesture = null;           // {mode:'move', ox, oy, sx, sy, t} | {mode:'rotate', a0, s0} | {mode:'twist', ids, a0, b0, s0}
  let lastTap = null;           // {t, x, y} des letzten Tipps auf das Geodreieck
  const ptrs = new Map();       // pointerId → {x, y} (eigene Zeiger auf dem Geodreieck)
  const swallow = new Set();    // pointerIds, die still geschluckt werden (Zweitfinger neben laufender Geste)

  const canvas = h('canvas', { className: 'geodreieck', 'aria-hidden': 'true', hidden: true });
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

  /** Position per transform: Drehung um den Nullpunkt; Winkeltext am Nullpunkt. */
  function place() {
    const box = geoBox(pxPerMm());
    canvas.style.transformOrigin = `${box.ox}px ${box.oy}px`;
    canvas.style.transform = `translate(${state.x - box.ox}px, ${state.y - box.oy}px) rotate(${state.angle}deg)`;
    label.style.transform = `translate(${state.x}px, ${state.y}px) translate(-50%, -50%)`;
    label.textContent = Math.round(state.angle) + '°';
  }

  function redraw() {
    const s = pxPerMm();
    if (!(s > 0)) return;       // Surface hat noch keine Seiten
    drawGeodreieck(canvas, s);
    drawnScale = s;
  }

  function save() {
    if (placed) saveState({ x: state.x, y: state.y, angle: state.angle, visible });
  }

  // ───── Stift: Kante als Führung ─────
  const guide = {
    start: (pt) => (visible ? geoEdgeAt(state, pxPerMm(), pt, GUIDE_PX) : null),
    project: (pt, edge) => geoProject(state, pxPerMm(), pt, edge),
  };

  // ───── Finger und Maus ─────
  function onDown(e) {
    if (!visible || e.pointerType === 'pen') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!holder.contains(e.target)) return;      // nur Schreibfläche, nicht Leisten und Dialoge
    const pt = toLocal(e);
    const s = pxPerMm();
    if (!hitGeo(state, s, pt)) {
      // Außerhalb: nur schlucken, wenn gerade eine Geodreieck-Geste läuft (sonst zoomt die Fläche mit)
      if (ptrs.size) { absorb(e); swallow.add(e.pointerId); }
      return;
    }
    absorb(e);
    if (ptrs.size >= 2) { swallow.add(e.pointerId); return; }   // dritter Finger
    const grip = hitGeoGrip(state, s, pt);
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
      // Doppeltipp auf das Geodreieck → Winkel 0°
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
      // Erstes Einblenden: Nullpunkt etwas unterhalb der Mitte, die Spitze bleibt sichtbar
      state = { x: holder.clientWidth / 2, y: holder.clientHeight * 0.55, angle: 0 };
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
      if (visible) surface.removeGuide(guide);
      visible = false;
      gesture = null;
      ptrs.clear();
      swallow.clear();
      canvas.remove();
      label.remove();
    },
  };
}
