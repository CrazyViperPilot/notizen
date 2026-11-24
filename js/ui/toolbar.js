// Editor toolbar (PRD 6.1–6.2, ARCHITEKTUR 7.1). Tool, color and width are remembered per tool in
// localStorage 'notizen:prefs' (key `tool`). Keyboard shortcuts only work while no input has focus.
// Everything user-provided goes through textContent / attributes (no innerHTML).

import { PEN_COLORS, PEN_COLOR_NAMES, PEN_WIDTHS, HL_COLORS, HL_COLOR_NAMES, PAPERS, PAPER_NAMES, isHexColor, DEFAULT_CUSTOM_COLOR, DEFAULT_CUSTOM_HL_COLOR } from '../config.js';
import { h, menu, promptText } from './dom.js';

const PREFS_KEY = 'notizen:prefs';
const SVG_NS = 'http://www.w3.org/2000/svg';
const KINDS = ['pen', 'highlighter', 'eraser'];
const KIND_NAMES = { pen: 'Stift', highlighter: 'Textmarker', eraser: 'Radierer' };
const WIDTH_DOTS = [7, 11, 17];   // dot diameter in px for PEN_WIDTHS (fein, mittel, dick)

const ICONS = {
  pen: [{ d: 'M4 20l1.1-4.4L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.4 19z' }, { d: 'M13.8 6.8l3.4 3.4' }],
  highlighter: [{ d: 'M5 21h14', w: 5, o: 0.45 }, { d: 'M8 15l6.8-8.6 3.2 2.5L11.2 17.5z' }],
  eraser: [{ d: 'M4.5 16.5L12 9l5 5-5.5 5.5H8.5z' }, { d: 'M11 19.5h9' }],
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
 * createToolbar({onTool, onUndo, onRedo, onBack, onTitle, onPageMenu, onAddPage})
 *   onTool({kind, color, width})   — tool, color index and width index changed
 *   onTitle(newTitle)              — user renamed the note (dialog already confirmed)
 *   onPageMenu(action, value)      — 'paper' (value: paper code), 'orient' ('p'|'l'), 'pdf', 'delete'
 * Returns {el, setHistory(canUndo, canRedo), setTitle(t), setPageInfo(i, n, {paper, orient}?), setTool(tool),
 *          getTool(), destroy()}
 */
export function createToolbar({ onTool, onUndo, onRedo, onBack, onTitle, onPageMenu, onAddPage }) {
  const saved = readPrefs().tool || {};
  let kind = KINDS.includes(saved.kind) ? saved.kind : 'pen';
  const mem = {
    pen: {
      color: penColorOf(saved.pen && saved.pen.color),
      width: idx(saved.pen && saved.pen.width, PEN_WIDTHS.length),
      custom: customOf(saved.pen, DEFAULT_CUSTOM_COLOR),
    },
    highlighter: {
      color: hlColorOf(saved.highlighter && saved.highlighter.color),
      custom: customOf(saved.highlighter, DEFAULT_CUSTOM_HL_COLOR),
    },
  };
  let pageInfo = { i: 0, n: 0, page: null };
  let titleText = '';

  const current = () => {
    if (kind === 'pen') return { kind, color: mem.pen.color, width: mem.pen.width };
    if (kind === 'highlighter') return { kind, color: mem.highlighter.color, width: 0 };
    return { kind: 'eraser', color: 0, width: 0 };
  };

  const persist = () => {
    const p = readPrefs();
    p.tool = { kind, pen: { ...mem.pen }, highlighter: { ...mem.highlighter } };
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
    else if (kind === 'highlighter') mem.highlighter.color = i;
    emit();
  };

  const setWidth = (i) => {
    if (kind !== 'pen') return;
    mem.pen.width = i;
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
  const infoEl = h('span', { className: 'tb-info', 'aria-live': 'polite' });
  const styleEl = h('div', { className: 'tb-group tb-style' });

  const el = h('div', { className: 'tb', role: 'toolbar', 'aria-label': 'Werkzeuge' },
    h('div', { className: 'tb-left' }, backBtn, titleBtn),
    h('div', { className: 'tb-group tb-tools' }, toolBtns),
    h('div', { className: 'tb-group tb-right' }, undoBtn, redoBtn, addBtn, menuBtn, infoEl),
    styleEl);

  function render() {
    for (const b of toolBtns) {
      const on = b.dataset.kind === kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    styleEl.replaceChildren();
    styleEl.hidden = kind === 'eraser';
    if (kind === 'eraser') return;
    const isPen = kind === 'pen';
    const colors = isPen ? PEN_COLORS : HL_COLORS;
    const names = isPen ? PEN_COLOR_NAMES : HL_COLOR_NAMES;
    const cur = isPen ? mem.pen.color : mem.highlighter.color;
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
    if (isPen) {
      PEN_WIDTHS.forEach((_, i) => {
        const on = i === mem.pen.width;
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
    if (kind === 'eraser') return;
    mem[kind].custom = v.toLowerCase();
    setColor(mem[kind].custom);
  }

  function openCustomColor() {
    if (kind === 'eraser') return;
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
    menu(anchor, [
      ...paperItems,
      'sep',
      ...orientItems,
      'sep',
      { label: 'Als PDF exportieren', icon: ' ', onSelect: () => onPageMenu('pdf') },
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
    else if (key === 'h') selectKind('highlighter');
    else if (key === 'e') selectKind('eraser');
    else return;
    e.preventDefault();
  }
  document.addEventListener('keydown', onKey);

  render();

  return {
    el,
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
      if (kind === 'pen') {
        mem.pen.color = penColorOf(t.color);
        mem.pen.width = idx(t.width, PEN_WIDTHS.length);
      } else if (kind === 'highlighter') {
        mem.highlighter.color = hlColorOf(t.color);
      }
      persist();
      render();
    },
    getTool: current,
    destroy() {
      document.removeEventListener('keydown', onKey);
    },
  };
}
