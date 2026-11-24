// Schreib-Labor: die Editor-Fläche ohne Backend ausprobieren. Striche bleiben in localStorage (notizen:labor).
import { createSurface } from './ink/surface.js';
import { PEN_COLORS, PEN_WIDTHS, HL_COLORS, PAPERS, PAPER_NAMES } from './config.js';

const KEY = 'notizen:labor';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const save = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* voll/privat */ } };

let data = load() || { pages: ['lined', 'grid', 'dotted', 'blank'].map((paper, i) => ({ id: 'p' + i, paper, orient: 'p', strokes: '[]' })) };
const surface = createSurface(document.getElementById('surface'));
surface.setPages(data.pages);

let tool = { kind: 'pen', color: 0, width: 1 };
const $ = (s) => document.querySelector(s);

function el(tag, props = {}, ...kids) { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; }

function renderPalette() {
  const colors = $('#colors');
  colors.replaceChildren();
  const list = tool.kind === 'highlighter' ? HL_COLORS : PEN_COLORS;
  list.forEach((c, i) => {
    const sw = el('span', { className: 'swatch' });
    sw.style.background = c;
    const b = el('button', { className: tool.color === i ? 'on' : '', title: 'Farbe' }, sw);
    b.onclick = () => { tool.color = i; apply(); };
    colors.append(b);
  });
  const widths = $('#widths');
  widths.replaceChildren();
  if (tool.kind === 'pen') PEN_WIDTHS.forEach((w, i) => {
    const d = el('span', { className: 'dot' });
    d.style.width = d.style.height = (4 + w) + 'px';
    const b = el('button', { className: tool.width === i ? 'on' : '', title: 'Stärke' }, d);
    b.onclick = () => { tool.width = i; apply(); };
    widths.append(b);
  });
}

function apply() {
  if (tool.kind === 'highlighter' && tool.color >= HL_COLORS.length) tool.color = 0;
  surface.setTool(tool);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool.kind));
  renderPalette();
}

document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { tool.kind = b.dataset.tool; tool.color = 0; apply(); }));
$('#undo').onclick = () => surface.undo();
$('#redo').onclick = () => surface.redo();
surface.addEventListener('history', (e) => { $('#undo').disabled = !e.detail.canUndo; $('#redo').disabled = !e.detail.canRedo; });

const sel = $('#paper');
PAPERS.forEach((p) => sel.append(el('option', { value: p, textContent: PAPER_NAMES[p] })));
surface.addEventListener('pagechange', (e) => {
  const p = data.pages.find((x) => x.id === e.detail.pageId);
  if (p) sel.value = p.paper;
  $('#info').textContent = 'Seite ' + (data.pages.indexOf(p) + 1) + '/' + data.pages.length;
});
sel.onchange = () => {
  const p = data.pages.find((x) => x.id === surface.currentPageId());
  if (!p) return;
  surface.flush();
  p.paper = sel.value;
  save(data);
  surface.setPages(data.pages, { keepView: true });
};

let finger = false;
$('#finger').onclick = () => { finger = !finger; surface.setFingerDraw(finger); $('#finger').classList.toggle('on', finger); };
$('#clear').onclick = () => {
  if (!confirm('Alle Labor-Seiten leeren?')) return;
  data.pages.forEach((p) => (p.strokes = '[]'));
  save(data);
  surface.setPages(data.pages);
};

surface.addEventListener('strokes', (e) => {
  const p = data.pages.find((x) => x.id === e.detail.pageId);
  if (p) { p.strokes = e.detail.strokes; save(data); }
});
apply();
sel.value = (data.pages.find((x) => x.id === surface.currentPageId()) || data.pages[0]).paper;
// Zeigt, was das Gerät meldet (Stift? Druck? Tasten?) – hilfreich auf neuen Tablets.
const probe = document.getElementById('probe');
const kindName = { pen: 'Stift', touch: 'Finger', mouse: 'Maus' };
const showProbe = (e) => {
  if (!probe) return;
  const keys = [];
  if (e.buttons & 2) keys.push('Seitentaste');
  if (e.buttons & 32) keys.push('Radier-Ende');
  probe.textContent = `${kindName[e.pointerType] || e.pointerType} · Druck ${e.pressure.toFixed(2)}`
    + (e.tiltX || e.tiltY ? ` · Neigung ${e.tiltX}°/${e.tiltY}°` : '') + (keys.length ? ' · ' + keys.join(', ') + ' (radiert)' : '');
};
const surfEl = document.getElementById('surface');
surfEl.addEventListener('pointerdown', showProbe);
surfEl.addEventListener('pointermove', (e) => { if (e.buttons) showProbe(e); });
window.nzSurface = surface; // für Tests
