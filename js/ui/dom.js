// Small DOM helpers shared by all views. User content only via textContent/attributes (never innerHTML).

/**
 * h('button', {className: 'btn', onclick: fn, title: 'x', dataset: {id: 1}, style: {width: '10px'}}, 'Text', child)
 * Props starting with "on" are event listeners; `text` sets textContent; others are set as properties
 * (or attributes for aria- and data- names). Children: strings (as text), nodes, arrays, null/false (skipped).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for') el.setAttribute(k, v === true ? '' : v);
    else el[k] = v;
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// ───────────── toasts ─────────────
let toastBox = null;
/** toast('Gespeichert', {type: 'ok'|'error', ms: 2500}) */
export function toast(message, { type = '', ms = 2600 } = {}) {
  if (!toastBox) { toastBox = h('div', { className: 'nz-toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { className: 'nz-toast ' + type, text: message });
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

// ───────────── dialogs ─────────────
/**
 * Modal dialog. body: Node | (closeFn) => Node. actions: [{label, value, primary, danger}].
 * Resolves with the chosen action value, or null (Escape/backdrop/Abbrechen).
 * `onAction(value)` may return false (or a Promise of false) to keep the dialog open (e.g. validation).
 * `autofocus: false` keeps the focus off inputs (no on-screen keyboard popping up on tablets).
 */
export function dialog({ title, body, actions = [{ label: 'OK', value: true, primary: true }], onAction = null, dismissible = true, autofocus = true }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) { e.preventDefault(); close(null); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const primary = actions.find((a) => a.primary);
        if (primary) { e.preventDefault(); choose(primary.value); }
      }
    };
    const choose = async (v) => {
      if (onAction && v !== null) {
        const ok = await onAction(v);
        if (ok === false) return;
      }
      close(v);
    };
    const content = typeof body === 'function' ? body(close) : body;
    const footer = h('footer', {}, actions.map((a) =>
      h('button', { className: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), type: 'button', text: a.label, onclick: () => choose(a.value) })));
    const box = h('div', { className: 'nz-dialog', role: 'dialog', 'aria-modal': 'true' },
      title ? h('header', { text: title }) : null,
      h('div', { className: 'body' }, content || null),
      footer);
    const backdrop = h('div', { className: 'nz-backdrop', onclick: (e) => { if (e.target === backdrop && dismissible) close(null); } }, box);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    const first = (autofocus && box.querySelector('input, select, textarea')) || footer.querySelector('.primary') || footer.lastChild;
    if (first) setTimeout(() => first.focus(), 30);
  });
}

/** Asks for a text. Resolves with the trimmed string or null. */
export async function promptText({ title, label = '', value = '', okLabel = 'OK', placeholder = '', maxLength = 200 }) {
  const input = h('input', { className: 'input', value, placeholder, maxLength, autocomplete: 'off', autocapitalize: 'sentences' });
  const err = h('div', { className: 'error-text' });
  const r = await dialog({
    title,
    body: h('label', { className: 'field' }, label ? h('span', { text: label }) : null, input, err),
    actions: [{ label: 'Abbrechen', value: null }, { label: okLabel, value: 'ok', primary: true }],
    onAction: () => { if (!input.value.trim()) { err.textContent = 'Bitte etwas eingeben.'; return false; } return true; },
  });
  return r === 'ok' ? input.value.trim() : null;
}

/** Yes/no question. Resolves true/false. */
export async function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
  const r = await dialog({
    title,
    body: h('p', { text: message }),
    actions: [{ label: 'Abbrechen', value: null }, { label: okLabel, value: 'ok', primary: !danger, danger }],
  });
  return r === 'ok';
}

/**
 * Popup menu at an element or point. items: [{label, icon?, danger?, onSelect}] or 'sep'.
 */
export function menu(anchor, items) {
  const close = () => { backdrop.remove(); m.remove(); };
  const m = h('div', { className: 'nz-menu', role: 'menu' }, items.map((it) => it === 'sep'
    ? h('hr')
    : h('button', { type: 'button', role: 'menuitem', className: it.danger ? 'danger' : '', onclick: () => { close(); it.onSelect(); } },
      it.icon ? h('span', { text: it.icon, 'aria-hidden': 'true' }) : null, h('span', { text: it.label }))));
  const backdrop = h('div', { style: { position: 'fixed', inset: '0', zIndex: '140' }, onclick: close });
  document.body.append(backdrop, m);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = Math.min(r.left, window.innerWidth - mw - 8);
  let y = r.bottom + 4;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = y + 'px';
  return close;
}

/** "vor 5 Min." / "gestern" / "12.03.2026" */
export function relTime(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60000) return 'gerade eben';
  if (d < 3600000) return 'vor ' + Math.floor(d / 60000) + ' Min.';
  if (d < 86400000) return 'vor ' + Math.floor(d / 3600000) + ' Std.';
  if (d < 172800000) return 'gestern';
  return new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
}
