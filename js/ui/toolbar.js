// Editor toolbar (PRD 6.1–6.2, ARCHITEKTUR 7.1). Tool, color and width are remembered per tool in
// localStorage 'notizen:prefs' (key `tool`). Keyboard shortcuts only work while no input has focus.
// Everything user-provided goes through textContent / attributes (no innerHTML).
// Bleistift (kind 'pencil') hat wie der Stift Farben und 3 Stärken; seine Striche werden als Typ 'b' gespeichert.

import { PEN_COLORS, PEN_COLOR_NAMES, PEN_WIDTHS, HL_COLORS, HL_COLOR_NAMES, PAPERS, PAPER_NAMES, PAGE_SIZES, SIZE_NAMES, isHexColor, DEFAULT_CUSTOM_COLOR, DEFAULT_CUSTOM_HL_COLOR } from '../config.js';
import { h, menu, promptText } from './dom.js';
import { fullscreenSupported, isFullscreen, toggleFullscreen, onFullscreenChange } from './fullscreen.js';

const PREFS_KEY = 'notizen:prefs';
const SVG_NS = 'http://www.w3.org/2000/svg';
const KINDS = ['pen', 'pencil', 'highlighter', 'eraser', 'lasso'];
const KIND_NAMES = { pen: 'Stift', pencil: 'Bleistift', highlighter: 'Textmarker', eraser: 'Radierer', lasso: 'Lasso (auswählen)' };
const COLOR_KINDS = ['pen', 'pencil', 'highlighter'];  // Werkzeuge mit Farbwahl
const WIDTH_DOTS = [7, 11, 17];   // dot diameter in px for PEN_WIDTHS (fein, mittel, dick)

const ICONS = {
  pen: [{ d: 'M4 20l1.1-4.4L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.4 19z' }, { d: 'M13.8 6.8l3.4 3.4' }],
  pencil: [{ d: 'M14.6 5.4l4 4L9.6 18.4 5.6 19.4l1-4z' }, { d: 'M4 21.2h7' }],
  highlighter: [{ d: 'M5 21h14', w: 5, o: 0.45 }, { d: 'M8 15l6.8-8.6 3.2 2.5L11.2 17.5z' }],
  eraser: [{ d: 'M4.5 16.5L12 9l5 5-5.5 5.5H8.5z' }, { d: 'M11 19.5h9' }],
  lasso: [{ d: 'M12 4c4.4 0 8 2.2 8 5s-3.6 5-8 5-8-2.2-8-5 3.6-5 8-5z', dash: true }, { d: 'M7 13c-1 2 0 4 2 4.5s2.5 2 1.5 3.5' }],
  fsOn: [{ d: 'M4 9V4h5' }, { d: 'M15 4h5v5' }, { d: 'M20 15v5h-5' }, { d: 'M9 20H4v-5' }],
  fsOff: [{ d: 'M9 4v5H4' }, { d: 'M15 4v5h5' }, { d: 'M20 15h-5v5' }, { d: 'M4 15h5v5' }],
  ruler: [{ d: 'M3 8.5h18v7H3z' }, { d: 'M6 15.5v-3M9 15.5v-2M12 15.5v-3M15 15.5v-2M18 15.5v-3' }],
  geo: [{ d: 'M2.5 18.5h19L12 9z' }, { d: 'M8 18.5a4 4 0 0 1 8 0' }, { d: 'M12 18.5v-2' }],
  compass: [{ d: 'M12 3v3' }, { d: 'M12 6L6.5 20' }, { d: 'M12 6l5.5 14' }, { d: 'M8.5 15h7', o: 0.6 }],
};

function icon(kind) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'tb-ico');
  s.setAttribute('aria-hidden', 'true');
  for (const p of ICONS[kind]) {
    const e = document.createElementNS(SVG_NS, 'path');
    e.setAttribute('d', p.d);
    e.setAttribute('fill', 'none');
    e.setAttribute('stroke', 'currentColor');
    e.setAttribute('stroke-width', String(p.w || 1.8));
    e.setAttribute('stroke-linecap', 'round');
    e.setAttribute('stroke-linejoin', 'round');
    if (p.o) e.setAttribute('stroke-opacity', String(p.o));
    if (p.dash) e.setAttribute('stroke-dasharray', '3 2.5');
    s.append(e);
  }
  return s;
}

function readPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* voll/privat */ }
}

const idx = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : 0);
/** Tool color: palette index or custom "#rrggbb". */
const colorOf = (v, n) => (isHexColor(v) ? v.toLowerCase() : idx(v, n));
const penColorOf = (v) => colorOf(v, PEN_COLORS.length);
const hlColorOf = (v) => colorOf(v, HL_COLORS.length);
const customOf = (o, fallback) => (o && isHexColor(o.custom) ? o.custom.toLowerCase() : fallback);

/**
 * createToolbar({onTool, onUndo, onRedo, onBack, onTitle, onPageMenu, onAddPage, onQuiz, onRuler})
 *   onTool({kind, color, width})   — tool, color index and width index changed
 *   onTitle(newTitle)              — user renamed the note (dialog already confirmed)
 *   onPageMenu(action, value)      — 'paper' (value: paper code), 'orient' ('p'|'l'), 'size' ('a4'|'a5'|'a3'), 'pdf', 'delete'
 *   onRuler()                      — Lineal-Knopf oder Taste r (Editor schaltet das Lineal um und ruft setRuler auf)
 *   onGeo()                        — Geodreieck-Knopf oder Taste g (Editor schaltet um und ruft setGeo auf)
 *   onCompass()                    — Zirkel-Knopf oder Taste z (Editor schaltet um und ruft setCompass auf)
 * Returns {el, setHistory(canUndo, canRedo), setTitle(t), setPageInfo(i, n, {paper, orient, size}?), setTool(tool),
 *          setQuiz(available, active), setRuler(on), setGeo(on), setCompass(on), getTool(), destroy()}
 */
export function createToolbar({ onTool, onUndo, onRedo, onBack, onTitle, onPageMenu, onAddPage, onQuiz = () => {}, onRuler = () => {}, onGeo = () => {}, onCompass = () => {} }) {
  const saved = readPrefs().tool || {};
  let kind = KINDS.includes(saved.kind) ? saved.kind : 'pen';
  const mem = {
    pen: {
      color: penColorOf(saved.pen && saved.pen.color),
      width: idx(saved.pen && saved.pen.width, PEN_WIDTHS.length),
      custom: customOf(saved.pen, DEFAULT_CUSTOM_COLOR),
    },
    // Bleistift: Standard Schwarz, Stärke „Mittel“. Ältere gespeicherte Einstellungen ohne pencil bekommen die Standards.
    pencil: {
      color: penColorOf(saved.pencil && saved.pencil.color),
      width: Number.isInteger(saved.pencil && saved.pencil.width) ? idx(saved.pencil.width, PEN_WIDTHS.length) : 1,
      custom: customOf(saved.pencil, DEFAULT_CUSTOM_COLOR),
    },
    highlighter: {
      color: hlColorOf(saved.highlighter && saved.highlighter.color),
      custom: customOf(saved.highlighter, DEFAULT_CUSTOM_HL_COLOR),
    },
    eraser: { mode: saved.eraser && saved.eraser.mode === 'part' ? 'part' : 'stroke' },
  };
  let pageInfo = { i: 0, n: 0, page: null };
  let titleText = '';

  const current = () => {
    if (kind === 'pen') return { kind, color: mem.pen.color, width: mem.pen.width };
    if (kind === 'pencil') return { kind, color: mem.pencil.color, width: mem.pencil.width };
    if (kind === 'highlighter') return { kind, color: mem.highlighter.color, width: 0 };
    if (kind === 'lasso') return { kind, color: 0, width: 0 };
    return { kind: 'eraser', color: 0, width: 0, mode: mem.eraser.mode };
  };

  const persist = () => {
    const p = readPrefs();
    p.tool = { kind, pen: { ...mem.pen }, pencil: { ...mem.pencil }, highlighter: { ...mem.highlighter }, eraser: { ...mem.eraser } };
    writePrefs(p);
  };

  const emit = () => { persist(); render(); onTool(current()); };

  const selectKind = (k) => {
    if (!KINDS.includes(k) || k === kind) return;
    kind = k;
    emit();
  };

  const setColor = (i) => {
    if (kind === 'pen') mem.pen.color = i;
    else if (kind === 'pencil') mem.pencil.color = i;
    else if (kind === 'highlighter') mem.highlighter.color = i;
    emit();
  };

  const setWidth = (i) => {
    if (kind !== 'pen' && kind !== 'pencil') return;
    mem[kind].width = i;
    emit();
  };

  // ───── DOM ─────
  const backBtn = h('button', {
    type: 'button', className: 'tb-btn tb-back', title: 'Zurück', 'aria-label': 'Zurück zur Übersicht',
    text: '‹', onclick: () => onBack(),
  });
  const titleBtn = h('button', { type: 'button', className: 'tb-title', title: 'Umbenennen', onclick: rename });
  const toolBtns = KINDS.map((k) => h('button', {
    type: 'button', className: 'tb-btn', title: KIND_NAMES[k], 'aria-label': KIND_NAMES[k],
    dataset: { kind: k }, onclick: () => selectKind(k),
  }, icon(k)));
  const undoBtn = h('button', {
    type: 'button', className: 'tb-btn tb-undo', title: 'Rückgängig (Cmd/Strg+Z)', 'aria-label': 'Rückgängig',
    text: '↶', disabled: true, onclick: () => onUndo(),
  });
  const redoBtn = h('button', {
    type: 'button', className: 'tb-btn tb-redo', title: 'Wiederholen (Cmd/Strg+Umschalt+Z)', 'aria-label': 'Wiederholen',
    text: '↷', disabled: true, onclick: () => onRedo(),
  });
  const addBtn = h('button', {
    type: 'button', className: 'tb-btn', title: 'Seite hinzufügen', 'aria-label': 'Seite nach dieser Seite hinzufügen',
    text: '+', onclick: () => onAddPage(),
  });
  const menuBtn = h('button', {
    type: 'button', className: 'tb-btn', title: 'Seitenmenü', 'aria-label': 'Seitenmenü',
    text: '⋯', onclick: () => openPageMenu(menuBtn),
  });
  const quizBtn = h('button', {
    type: 'button', className: 'tb-btn tb-quiz', title: 'Vokabeln abfragen', 'aria-label': 'Vokabeln abfragen',
    'aria-pressed': 'false', hidden: true, text: 'Abfragen', onclick: () => onQuiz(),
  });
  // Vollbild: nur wo der Browser es kann (Windows, Android); unter iOS bleibt der Button verborgen.
  const fsBtn = h('button', {
    type: 'button', className: 'tb-btn tb-fs', hidden: !fullscreenSupported(), 'aria-pressed': 'false',
    onclick: () => toggleFullscreen(),
  });
  // Messwerkzeuge (Lineal r, Geodreieck g, Zirkel z): ein Knopf mit Auswahlmenü, damit die Leiste im Hochformat Platz behält.
  // Zustand kommt vom Editor über setRuler/setGeo/setCompass.
  const instr = { ruler: false, geo: false, compass: false };
  const instrBtn = h('button', {
    type: 'button', className: 'tb-btn tb-instr', title: 'Messwerkzeuge: Lineal (R), Geodreieck (G), Zirkel (Z)',
    'aria-label': 'Messwerkzeuge', 'aria-haspopup': 'menu', onclick: () => menu(instrBtn, [
      { label: 'Lineal', icon: instr.ruler ? '✓' : ' ', onSelect: () => onRuler() },
      { label: 'Geodreieck', icon: instr.geo ? '✓' : ' ', onSelect: () => onGeo() },
      { label: 'Zirkel', icon: instr.compass ? '✓' : ' ', onSelect: () => onCompass() },
    ]),
  }, icon('ruler'));
  const renderInstr = () => {
    const any = instr.ruler || instr.geo || instr.compass;
    instrBtn.classList.toggle('on', any);
    instrBtn.replaceChildren(icon(instr.geo && !instr.ruler && !instr.compass ? 'geo' : instr.compass && !instr.ruler && !instr.geo ? 'compass' : 'ruler'));
  };
  const renderFs = () => {
    const on = isFullscreen();
    const label = on ? 'Vollbild beenden' : 'Vollbild';
    fsBtn.title = label;
    fsBtn.setAttribute('aria-label', label);
    fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    fsBtn.replaceChildren(icon(on ? 'fsOff' : 'fsOn'));
  };
  renderFs();
  const offFs = onFullscreenChange(renderFs);
  const infoEl = h('span', { className: 'tb-info', 'aria-live': 'polite' });
  const styleEl = h('div', { className: 'tb-group tb-style' });

  const el = h('div', { className: 'tb', role: 'toolbar', 'aria-label': 'Werkzeuge' },
    h('div', { className: 'tb-left' }, backBtn, titleBtn),
    h('div', { className: 'tb-group tb-tools' }, toolBtns),
    h('div', { className: 'tb-group tb-right' }, undoBtn, redoBtn, addBtn, quizBtn, fsBtn, instrBtn, menuBtn, infoEl),
    styleEl);

  function render() {
    for (const b of toolBtns) {
      const on = b.dataset.kind === kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    styleEl.replaceChildren();
    styleEl.hidden = kind === 'lasso';
    if (kind === 'lasso') return;
    if (kind === 'eraser') {
      // Eraser modes: whole strokes or only the touched part.
      for (const [mode, label] of [['stroke', 'Ganze Striche'], ['part', 'Teilweise']]) {
        const on = mem.eraser.mode === mode;
        styleEl.append(h('button', {
          type: 'button', className: 'tb-btn tb-mode' + (on ? ' on' : ''), text: label, 'aria-pressed': on ? 'true' : 'false',
          onclick: () => { mem.eraser.mode = mode; emit(); },
        }));
      }
      return;
    }
    const isInk = kind === 'pen' || kind === 'pencil';   // Stift und Bleistift: Stift-Palette und 3 Stärken
    const colors = isInk ? PEN_COLORS : HL_COLORS;
    const names = isInk ? PEN_COLOR_NAMES : HL_COLOR_NAMES;
    const cur = mem[kind].color;
    colors.forEach((c, i) => {
      const on = i === cur;
      styleEl.append(h('button', {
        type: 'button', className: 'tb-btn tb-sw' + (on ? ' on' : ''), title: names[i],
        'aria-label': 'Farbe ' + names[i], 'aria-pressed': on ? 'true' : 'false', onclick: () => setColor(i),
      }, h('span', { className: 'tb-dot', style: { background: c } })));
    });
    // After the palette: any color from the full RGB range (system color picker), per tool.
    const customOn = isHexColor(cur);
    styleEl.append(h('button', {
      type: 'button', className: 'tb-btn tb-sw tb-custom' + (customOn ? ' on' : ''), title: 'Eigene Farbe wählen',
      'aria-label': 'Eigene Farbe wählen', 'aria-pressed': customOn ? 'true' : 'false', onclick: openCustomColor,
    }, h('span', { className: 'tb-dot', style: { background: mem[kind].custom } })));
    if (isInk) {
      PEN_WIDTHS.forEach((_, i) => {
        const on = i === mem[kind].width;
        const d = WIDTH_DOTS[i];
        styleEl.append(h('button', {
          type: 'button', className: 'tb-btn tb-w' + (on ? ' on' : ''), title: ['Fein', 'Mittel', 'Dick'][i],
          'aria-label': 'Stärke ' + ['fein', 'mittel', 'dick'][i], 'aria-pressed': on ? 'true' : 'false',
          onclick: () => setWidth(i),
        }, h('span', { className: 'tb-dot', style: { width: d + 'px', height: d + 'px' } })));
      });
    }
  }

  // Native color input: kept in the DOM (invisible) because iOS only opens pickers of attached inputs.
  const colorInput = h('input', {
    type: 'color', className: 'tb-color-input', tabIndex: -1, 'aria-hidden': 'true',
    oninput: () => applyCustom(colorInput.value),
    onchange: () => applyCustom(colorInput.value),
  });
  el.append(colorInput);

  function applyCustom(v) {
    if (!isHexColor(v)) return;
    if (!COLOR_KINDS.includes(kind)) return;
    mem[kind].custom = v.toLowerCase();
    setColor(mem[kind].custom);
  }

  function openCustomColor() {
    if (!COLOR_KINDS.includes(kind)) return;
    setColor(mem[kind].custom);
    colorInput.value = mem[kind].custom;
    try {
      if (typeof colorInput.showPicker === 'function') colorInput.showPicker();
      else colorInput.click();
    } catch {
      colorInput.click();
    }
  }

  async function rename() {
    const t = await promptText({ title: 'Notiz umbenennen', label: 'Titel', value: titleText, okLabel: 'Speichern', maxLength: 200 });
    if (t && t !== titleText) onTitle(t);
  }

  function openPageMenu(anchor) {
    const p = pageInfo.page;
    const paperItems = PAPERS.map((code) => ({
      label: 'Papier: ' + PAPER_NAMES[code],
      icon: p && p.paper === code ? '✓' : ' ',
      onSelect: () => onPageMenu('paper', code),
    }));
    const orientItems = [['p', 'Hochformat'], ['l', 'Querformat']].map(([code, label]) => ({
      label,
      icon: p && p.orient === code ? '✓' : ' ',
      onSelect: () => onPageMenu('orient', code),
    }));
    const sizeItems = PAGE_SIZES.map((code) => ({
      label: 'Format: ' + SIZE_NAMES[code],
      icon: p && (p.size || 'a4') === code ? '✓' : ' ',
      onSelect: () => onPageMenu('size', code),
    }));
    const extra = [];
    if (p && p.canPaste) extra.push({ label: 'Einfügen', icon: '📋', onSelect: () => onPageMenu('paste') });
    extra.push({ label: p && p.label ? 'Lesezeichen ändern…' : 'Lesezeichen setzen…', icon: '🔖', onSelect: () => onPageMenu('bookmark') });
    if (p && p.hasBookmarks) extra.push({ label: 'Lesezeichen anzeigen…', icon: '☰', onSelect: () => onPageMenu('bookmarks') });
    if (p && p.hasCovers) extra.push({ label: 'Abdeckungen dieser Seite entfernen', icon: ' ', onSelect: () => onPageMenu('uncover') });
    if (p && p.hasCorrections) {
      extra.push({ label: p.showCorrections ? 'Korrekturen ausblenden' : 'Korrekturen anzeigen', icon: '✎', onSelect: () => onPageMenu('corrections') });
      extra.push({ label: 'Korrekturen dieser Seite entfernen', icon: ' ', onSelect: () => onPageMenu('clearCorrections') });
    }
    menu(anchor, [
      { label: 'Seitenübersicht', icon: '▦', onSelect: () => onPageMenu('overview') },
      { label: 'Präsentieren', icon: '▶', onSelect: () => onPageMenu('present') },
      { label: 'Foto oder PDF einfügen…', icon: '🖼', onSelect: () => onPageMenu('import') },
      { label: 'Titelblatt einfügen…', icon: ' ', onSelect: () => onPageMenu('cover') },
      ...extra,
      'sep',
      // Papier, Ausrichtung und Format in einem eigenen Menü (sonst wird die Liste auf dem iPad zu lang)
      { label: 'Papier und Format…', icon: '▤', onSelect: () => setTimeout(() => menu(anchor, [...paperItems, 'sep', ...orientItems, 'sep', ...sizeItems]), 0) },
      'sep',
      { label: 'Als PDF exportieren', icon: ' ', onSelect: () => onPageMenu('pdf') },
      { label: 'Seite duplizieren', icon: ' ', onSelect: () => onPageMenu('duplicate') },
      'sep',
      { label: 'Seite löschen', icon: ' ', danger: true, onSelect: () => onPageMenu('delete') },
    ]);
  }

  // ───── keyboard (iPad with keyboard) ─────
  function onKey(e) {
    if (e.altKey) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if (document.querySelector('.nz-backdrop')) return;
    const key = (e.key || '').toLowerCase();
    if (e.metaKey || e.ctrlKey) {
      if (key !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) onRedo(); else onUndo();
      return;
    }
    if (key === 'p') selectKind('pen');
    else if (key === 'b') selectKind('pencil');
    else if (key === 'h') selectKind('highlighter');
    else if (key === 'e') selectKind('eraser');
    else if (key === 'l') selectKind('lasso');
    else if (key === 'r') onRuler();
    else if (key === 'g') onGeo();
    else if (key === 'z') onCompass();
    else return;
    e.preventDefault();
  }
  document.addEventListener('keydown', onKey);

  render();

  return {
    el,
    /** Shows the "Abfragen" button (only for notes with vocabulary pages) and its on/off state. */
    setQuiz(available, active) {
      quizBtn.hidden = !available;
      quizBtn.classList.toggle('on', !!active);
      quizBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    },
    /** Messwerkzeuge an/aus (Knopf „Messwerkzeuge“ hervorgehoben, wenn eines sichtbar ist). */
    setRuler(on) { instr.ruler = !!on; renderInstr(); },
    setGeo(on) { instr.geo = !!on; renderInstr(); },
    setCompass(on) { instr.compass = !!on; renderInstr(); },
    setHistory(canUndo, canRedo) {
      undoBtn.disabled = !canUndo;
      redoBtn.disabled = !canRedo;
    },
    setTitle(t) {
      titleText = t || '';
      titleBtn.textContent = titleText || 'Ohne Titel';
    },
    setPageInfo(i, n, page = null) {
      pageInfo = { i, n, page };
      infoEl.textContent = n ? `${i} / ${n}` : '';
    },
    setTool(t) {
      if (!t || !KINDS.includes(t.kind)) return;
      kind = t.kind;
      if (kind === 'pen' || kind === 'pencil') {
        mem[kind].color = penColorOf(t.color);
        if (isHexColor(t.color)) mem[kind].custom = t.color.toLowerCase();
        mem[kind].width = idx(t.width, PEN_WIDTHS.length);
      } else if (kind === 'highlighter') {
        mem.highlighter.color = hlColorOf(t.color);
        if (isHexColor(t.color)) mem.highlighter.custom = t.color.toLowerCase();
      } else if (kind === 'eraser' && (t.mode === 'part' || t.mode === 'stroke')) {
        mem.eraser.mode = t.mode;
      }
      persist();
      render();
    },
    getTool: current,
    destroy() {
      document.removeEventListener('keydown', onKey);
      offFs();
    },
  };
}
