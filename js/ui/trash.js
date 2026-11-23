// Papierkorb: gelöschte Ordner und Notizen wiederherstellen oder endgültig löschen.
// Einstieg: mountTrash(el, {}, ctx) → unmount. Daten ausschließlich über ctx.model. Gestaltung: css/library.css.

import { h, toast, confirmDialog } from './dom.js';

const RELOAD_MS = 150;

const dateStr = (ms) => new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function fail(e) {
  console.error(e);
  toast(e && e.message ? e.message : 'Das hat nicht geklappt.', { type: 'error', ms: 4000 });
}

export async function mountTrash(el, params, ctx) {
  const model = ctx.model;
  let alive = true;
  let loadSeq = 0;
  let timer = 0;

  const list = h('div', { className: 'trash-list' });
  const emptyBtn = h('button', { className: 'btn danger', type: 'button', text: 'Papierkorb leeren', onclick: emptyTrash });
  const root = h('div', { className: 'trash' },
    h('header', { className: 'trash-bar' },
      h('button', { className: 'btn ghost', type: 'button', text: '‹ Zurück', onclick: () => ctx.navigate('#/') }),
      h('h1', { className: 'trash-title', text: 'Papierkorb' }),
      emptyBtn),
    h('p', { className: 'trash-hint muted', text: 'Gelöschtes wird nach 30 Tagen endgültig entfernt.' }),
    list);
  el.append(root);

  function scheduleLoad() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; load().catch(fail); }, RELOAD_MS);
  }

  function onChange() { if (alive) scheduleLoad(); }

  async function load() {
    const seq = ++loadSeq;
    const t = await model.listTrash();
    if (!alive || seq !== loadSeq) return;
    const rows = [
      ...t.folders.map((f) => row('folder', f, f.name)),
      ...t.notes.map((n) => row('note', n, n.title)),
    ];
    emptyBtn.disabled = rows.length === 0;
    if (rows.length) {
      list.replaceChildren(...rows);
    } else {
      list.replaceChildren(h('div', { className: 'empty' },
        h('div', { className: 'empty-ico', text: '🗑️', 'aria-hidden': 'true' }),
        h('p', { text: 'Der Papierkorb ist leer.' })));
    }
  }

  function row(kind, item, name) {
    const isFolder = kind === 'folder';
    return h('div', { className: 'trash-row' },
      h('div', { className: 'trash-ico', text: isFolder ? '📁' : '📝', 'aria-hidden': 'true' }),
      h('div', { className: 'trash-info' },
        h('div', { className: 'title', text: name }),
        h('div', { className: 'when', text: (isFolder ? 'Ordner · ' : 'Notiz · ') + 'gelöscht am ' + dateStr(item.deleted_at) })),
      h('div', { className: 'trash-actions' },
        h('button', { className: 'btn', type: 'button', text: 'Wiederherstellen', onclick: () => restore(kind, item) }),
        h('button', { className: 'btn quiet-danger', type: 'button', text: 'Endgültig löschen', onclick: () => purge(kind, item, name) })));
  }

  async function restore(kind, item) {
    try {
      if (kind === 'folder') await model.restoreFolder(item.id);
      else await model.restoreNote(item.id);
      toast('Wiederhergestellt');
    } catch (e) { fail(e); }
  }

  async function purge(kind, item, name) {
    const ok = await confirmDialog({
      title: 'Endgültig löschen?',
      message: kind === 'folder'
        ? `„${name}“ und alle Notizen darin werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.`
        : `„${name}“ wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`,
      okLabel: 'Endgültig löschen',
      danger: true,
    });
    if (!ok) return;
    try {
      await model.purge(kind, item.id);
      toast('Endgültig gelöscht');
    } catch (e) { fail(e); }
  }

  async function emptyTrash() {
    const ok = await confirmDialog({
      title: 'Papierkorb leeren?',
      message: 'Alle Notizen und Ordner im Papierkorb werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.',
      okLabel: 'Leeren',
      danger: true,
    });
    if (!ok) return;
    try {
      await model.emptyTrash();
      toast('Papierkorb geleert');
    } catch (e) { fail(e); }
  }

  model.on('change', onChange);
  await load().catch((e) => {
    fail(e);
    list.replaceChildren(h('div', { className: 'empty' }, h('p', { text: 'Der Papierkorb konnte nicht geladen werden.' })));
  });

  return function unmount() {
    alive = false;
    loadSeq++;
    clearTimeout(timer);
    model.off('change', onChange);
  };
}
