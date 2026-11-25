// Bibliothek: Ordnerbaum, Raster aus Unterordnern und Notizen mit Vorschaubild, Suche, Neue Notiz,
// Verschieben, Umbenennen, Löschen. Einstieg: mountLibrary(el, {folderId}, ctx) → unmount.
// Daten ausschließlich über ctx.model (js/model.js). Gestaltung: css/library.css.

import { h, toast, promptText, confirmDialog, dialog, menu, relTime } from './dom.js';
import { noteThumb } from './thumbs.js';
import { PAGE, PAPERS, PAPER_NAMES, PAGE_SIZES, SIZE_NAMES, pageDims } from '../config.js';
import { drawPaper, setPageTransform } from '../ink/render.js';

const PREFS_KEY = 'notizen:prefs';
const RELOAD_MS = 150;
const SEARCH_MS = 120;
const LONG_PRESS_MS = 500;
const THUMB_WORKERS = 2;

// ───────────── Einstellungen (localStorage 'notizen:prefs', andere Schlüssel bleiben erhalten) ─────────────

function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

function writePrefs(patch) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch })); } catch { /* privater Modus */ }
}

// ───────────── optionale Module (Teilen, Statussymbol) ─────────────

// Teilen-Dialog: nur verfügbar, wenn js/ui/share.js eine Funktion openShareDialog liefert.
let shareProbe = null;
function loadShare() {
  if (!shareProbe) {
    shareProbe = import('./share.js').then(
      (m) => (typeof m.openShareDialog === 'function' ? m.openShareDialog : null),
      () => null);
  }
  return shareProbe;
}

async function loadBadge(model) {
  try {
    const m = await import('./status.js');
    if (typeof m.createStatusBadge !== 'function') return null;
    const b = await m.createStatusBadge(model);
    if (b instanceof Node) return { el: b, destroy: null };
    if (b && b.el instanceof Node) return { el: b.el, destroy: typeof b.destroy === 'function' ? b.destroy : null };
    return null;
  } catch { return null; }
}

// ───────────── reine Hilfsfunktionen ─────────────

const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** parent_id → Kinder (sortiert wie die Eingabeliste). Wurzel = Schlüssel ''. */
function childMap(list) {
  const m = new Map();
  for (const f of list) {
    const k = f.parent_id || '';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return m;
}

/** Ordner-IDs eines Teilbaums inklusive der Wurzel. */
function subtree(rootId, kids) {
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    out.add(id);
    for (const c of kids.get(id) || []) stack.push(c.id);
  }
  return out;
}

function sortNotes(list, sort) {
  const arr = list.slice();
  if (sort === 'name') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'de', { sensitivity: 'base', numeric: true }));
  else arr.sort((a, b) => b.updated_at - a.updated_at);
  return arr;
}

/** Vorschau eines Papiers (Muster wie im Editor) auf ein kleines Canvas. */
function drawPreview(cv, paper, orient, size = 'a4') {
  const dims = pageDims(size, orient);
  const L = 84;                                   // CSS-Länge der langen Seite
  const S = Math.round((L * PAGE.p.w) / PAGE.p.h); // kurze Seite (59)
  const cssW = orient === 'l' ? L : S;
  const cssH = orient === 'l' ? S : L;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cssW * dpr);
  const hPx = Math.round(cssH * dpr);
  cv.width = w;
  cv.height = hPx;
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  const scale = Math.min(w / dims.w, hPx / dims.h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  setPageTransform(ctx, scale);
  drawPaper(ctx, { paper, orient, size }, scale);
}

/** Lang gedrückt halten oder Rechtsklick. Tippen ruft onTap auf, sofern kein Langdruck stattfand. */
function attachGestures(tile, onLong, onTap) {
  let timer = 0;
  let sx = 0;
  let sy = 0;
  let long = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    long = false;
    sx = e.clientX;
    sy = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = 0;
      long = true;
      onLong(sx, sy);
    }, LONG_PRESS_MS);
  });
  tile.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) tile.addEventListener(ev, cancel);
  tile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (long) return;
    cancel();
    long = true;
    onLong(e.clientX, e.clientY);
  });
  tile.addEventListener('click', (e) => {
    if (long) { long = false; return; }
    onTap(e);
  });
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(e); }
  });
}

function fail(e) {
  console.error(e);
  toast(e && e.message ? e.message : 'Das hat nicht geklappt.', { type: 'error', ms: 4000 });
}

// ───────────── Ansicht ─────────────

export async function mountLibrary(el, params, ctx) {
  const model = ctx.model;
  const prefs = readPrefs();
  const st = {
    folderId: (params && params.folderId) || null,
    q: '',
    sort: prefs.sort === 'name' ? 'name' : 'modified',
    searching: false,
    folders: [],            // alle sichtbaren Ordner (model.listFolders)
    byId: new Map(),
  };
  let alive = true;
  let loadSeq = 0;          // verwirft veraltete Ladevorgänge
  let renderGen = 0;        // verwirft veraltete Vorschaubild-Füllungen
  let timer = 0;
  let shareFn = null;
  let badge = null;
  let treeScrolled = false;
  let expandedOnce = false; // Baum beim Öffnen des Ordners aufklappen, danach nicht mehr erzwingen
  const urlOf = new Map();  // noteId → Object-URL des angezeigten Vorschaubilds

  // ── Gerüst ──
  const crumbs = h('nav', { className: 'crumbs', 'aria-label': 'Pfad' });
  const search = h('input', { className: 'input search', type: 'search', placeholder: 'Suchen', autocomplete: 'off',
    'aria-label': 'Suchen', oninput: () => { st.q = search.value; scheduleLoad(SEARCH_MS); } });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { search.value = ''; st.q = ''; scheduleLoad(0); }
  });
  const sortSel = h('select', { className: 'input sort', 'aria-label': 'Sortierung', onchange: () => {
    st.sort = sortSel.value === 'name' ? 'name' : 'modified';
    writePrefs({ sort: st.sort });
    scheduleLoad(0);
  } },
  h('option', { value: 'modified', text: 'Zuletzt geändert' }),
  h('option', { value: 'name', text: 'Name' }));
  sortSel.value = st.sort;
  const statusSlot = h('div', { className: 'status-slot' });
  const content = h('div', { className: 'content' });
  const tree = h('div', { className: 'tree' });
  const drawerBtn = h('button', { className: 'btn icon menu-btn', type: 'button', text: '☰', title: 'Ordner',
    'aria-label': 'Ordner anzeigen', onclick: () => root.classList.toggle('drawer-open') });

  const side = h('aside', { className: 'side', 'aria-label': 'Ordner' },
    h('div', { className: 'side-top' },
      h('button', { className: 'side-item', type: 'button', onclick: () => ctx.navigate('#/') },
        h('span', { className: 'ico', text: '📝', 'aria-hidden': 'true' }), h('span', { text: 'Alle Notizen' }))),
    tree,
    h('div', { className: 'side-bottom' },
      h('button', { className: 'side-item', type: 'button', onclick: () => ctx.navigate('#/shared') },
        h('span', { className: 'ico', text: '👥', 'aria-hidden': 'true' }), h('span', { text: 'Mit mir geteilt' })),
      h('button', { className: 'side-item', type: 'button', onclick: () => ctx.navigate('#/trash') },
        h('span', { className: 'ico', text: '🗑️', 'aria-hidden': 'true' }), h('span', { text: 'Papierkorb' }))));
  const scrim = h('div', { className: 'scrim', onclick: () => root.classList.remove('drawer-open') });
  const bar = h('header', { className: 'bar' },
    drawerBtn,
    crumbs,
    h('div', { className: 'bar-tools' },
      search,
      sortSel,
      h('button', { className: 'btn primary', type: 'button', text: '+ Notiz', onclick: newNote }),
      h('button', { className: 'btn', type: 'button', text: '+ Ordner', onclick: newFolder }),
      statusSlot,
      h('button', { className: 'btn icon account', type: 'button', text: '👤', title: 'Konto', 'aria-label': 'Konto',
        onclick: () => ctx.navigate('#/account') })));
  const main = h('main', { className: 'main' }, bar, content);
  const root = h('div', { className: 'lib' }, side, scrim, main);
  el.append(root);

  // ── Ladevorgang ──
  function pathOf(id) {
    const out = [];
    for (let cur = id, i = 0; cur && i < 200; i++) {
      const f = st.byId.get(cur);
      if (!f) break;
      out.unshift(f);
      cur = f.parent_id;
    }
    return out;
  }

  function pathText(folderId) {
    const p = pathOf(folderId);
    return p.length ? p.map((f) => f.name).join(' › ') : 'Übersicht';
  }

  function scheduleLoad(ms = RELOAD_MS) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; load().catch(fail); }, ms);
  }

  async function load() {
    const seq = ++loadSeq;
    const folders = await model.listFolders();
    if (!alive || seq !== loadSeq) return;
    st.folders = folders;
    st.byId = new Map(folders.map((f) => [f.id, f]));
    if (st.folderId && !st.byId.has(st.folderId)) { ctx.navigate('#/'); return; }
    st.searching = st.q.trim() !== '';
    let subFolders;
    let notes;
    let pinned = null;   // Favoriten (nur oberste Ebene ohne Suche), sonst null
    let recent = null;   // Zuletzt geöffnet (wie pinned)
    if (st.searching) {
      const r = await model.search(st.q);
      if (!alive || seq !== loadSeq) return;
      subFolders = r.folders;
      notes = r.notes;
    } else {
      subFolders = folders.filter((f) => (f.parent_id || null) === st.folderId);
      const top = !st.folderId;
      const [list, pins, recs] = await Promise.all([
        model.listNotes(st.folderId),
        top ? model.listPinned() : null,
        top ? model.listRecent() : null,
      ]);
      if (!alive || seq !== loadSeq) return;
      notes = list;
      pinned = pins;
      recent = recs;
    }
    if (!expandedOnce) { expandedOnce = true; expandAncestors(); }
    renderBar();
    renderTree();
    renderContent(subFolders, sortNotes(notes, st.sort), pinned && sortNotes(pinned, st.sort), recent);
  }

  function renderBar() {
    const items = [crumb('Übersicht', '#/', !st.searching && !st.folderId)];
    if (st.searching) {
      items.push(sepNode(), h('span', { className: 'crumb cur', text: `Suche „${st.q.trim()}“`, 'aria-current': 'page' }));
    } else {
      for (const f of pathOf(st.folderId)) items.push(sepNode(), crumb(f.name, '#/f/' + f.id, f.id === st.folderId));
    }
    crumbs.replaceChildren(...items);
  }

  function crumb(label, hash, current) {
    return h('button', { className: 'crumb' + (current ? ' cur' : ''), type: 'button', text: label, title: label,
      'aria-current': current ? 'page' : null, onclick: () => ctx.navigate(hash) });
  }

  function sepNode() {
    return h('span', { className: 'crumb-sep', text: '›', 'aria-hidden': 'true' });
  }

  // ── Ordnerbaum ──
  // Aufgeklappte Ordner. Ausgeblendete (gelöschte) bleiben gemerkt, damit eine Wiederherstellung den Zustand behält.
  function openSet() {
    const list = readPrefs().open;
    return new Set(Array.isArray(list) ? list : []);
  }

  function saveOpen(set) {
    writePrefs({ open: [...set].slice(-500) });
  }

  /** Klappt den aktuellen Ordner und seine Vorfahren auf, damit Unterordner und Lage im Baum sichtbar sind. */
  function expandAncestors() {
    if (!st.folderId) return;
    const set = openSet();
    let changed = false;
    let cur = st.byId.get(st.folderId);
    for (let i = 0; cur && i < 200; i++) {
      if (!set.has(cur.id)) { set.add(cur.id); changed = true; }
      cur = cur.parent_id ? st.byId.get(cur.parent_id) : null;
    }
    if (changed) saveOpen(set);
  }

  function setOpen(id, on) {
    const set = openSet();
    if (on) set.add(id); else set.delete(id);
    saveOpen(set);
    renderTree();
  }

  function renderTree() {
    const open = openSet();
    const kids = childMap(st.folders);
    const rows = [];
    const walk = (key, depth) => {
      for (const f of kids.get(key) || []) {
        const has = kids.has(f.id);
        const isOpen = has && open.has(f.id);
        const current = f.id === st.folderId;
        rows.push(h('div', { className: 'tree-row' + (current ? ' on' : ''), style: { paddingLeft: (4 + depth * 18) + 'px' } },
          has
            ? h('button', { className: 'toggle', type: 'button', text: isOpen ? '▾' : '▸',
              'aria-label': isOpen ? 'Einklappen' : 'Ausklappen', 'aria-expanded': String(isOpen),
              onclick: (e) => { e.stopPropagation(); setOpen(f.id, !isOpen); } })
            : h('span', { className: 'toggle-gap', 'aria-hidden': 'true' }),
          h('button', { className: 'tree-name', type: 'button', text: f.name, title: f.name,
            'aria-current': current ? 'page' : null, onclick: () => ctx.navigate('#/f/' + f.id) })));
        if (isOpen) walk(f.id, depth + 1);
      }
    };
    walk('', 0);
    tree.replaceChildren(...rows);
    side.querySelector('.side-top .side-item').classList.toggle('on', !st.searching && !st.folderId);
    if (!treeScrolled) {
      treeScrolled = true;
      const cur = tree.querySelector('.tree-row.on');
      if (cur) tree.scrollTop = Math.max(0, cur.offsetTop - tree.clientHeight / 3);
    }
  }

  // ── Inhalt ──
  /** pinned/recent: Notizlisten für die Reihen oben (nur oberste Ebene ohne Suche), sonst null. */
  function renderContent(subFolders, notes, pinned, recent) {
    const g = ++renderGen;
    const slots = new Map();   // noteId → {note, imgs}: eine Notiz kann in mehreren Reihen vorkommen, Vorschau wird einmal geladen
    const searching = st.searching;
    const blocks = [];
    const hasShelf = (pinned && pinned.length) || (recent && recent.length);
    if (pinned && pinned.length) blocks.push(shelf('Favoriten', pinned, slots));
    if (recent && recent.length) blocks.push(shelf('Zuletzt geöffnet', recent, slots));
    if (subFolders.length) {
      blocks.push(h('section', { className: 'group' },
        searching ? h('h2', { className: 'group-title', text: 'Ordner' }) : null,
        h('div', { className: 'grid' }, subFolders.map((f) => folderTile(f)))));
    }
    if (notes.length) {
      blocks.push(h('section', { className: 'group' },
        searching ? h('h2', { className: 'group-title', text: 'Notizen' }) : null,
        h('div', { className: 'grid' }, notes.map((n) => noteTile(n, slots)))));
    }
    if (!subFolders.length && !notes.length && !hasShelf) {
      blocks.push(h('div', { className: 'empty' },
        h('div', { className: 'empty-ico', text: searching ? '🔍' : '✍️', 'aria-hidden': 'true' }),
        h('p', { text: searching ? `Keine Treffer für „${st.q.trim()}“.` : 'Noch keine Notizen – tippe auf + Notiz' })));
    }
    content.replaceChildren(...blocks);
    // Vorschaubilder, die nicht mehr angezeigt werden, freigeben.
    for (const [id, u] of urlOf) {
      if (!slots.has(id)) { URL.revokeObjectURL(u); urlOf.delete(id); }
    }
    fillThumbs([...slots.values()], g);
  }

  /** Horizontal scrollbare Reihe („Favoriten“, „Zuletzt geöffnet“) mit normalen Notiz-Kacheln. */
  function shelf(title, list, slots) {
    return h('section', { className: 'group shelf' },
      h('h2', { className: 'group-title', text: title }),
      h('div', { className: 'shelf-row' }, list.map((n) => noteTile(n, slots))));
  }

  function setThumbUrl(id, url) {
    const old = urlOf.get(id);
    urlOf.set(id, url);
    if (old && old !== url) URL.revokeObjectURL(old);
  }

  function fillThumbs(slots, g) {
    let idx = 0;
    const worker = async () => {
      while (alive && g === renderGen && idx < slots.length) {
        const { note, imgs } = slots[idx++];
        const url = await noteThumb(model, note);
        if (!url) continue;
        const live = imgs.filter((img) => img.isConnected);
        if (!alive || g !== renderGen || !live.length) { URL.revokeObjectURL(url); continue; }
        for (const img of live) img.src = url;
        setThumbUrl(note.id, url);
      }
    };
    for (let k = 0; k < THUMB_WORKERS; k++) worker();
  }

  function moreButton(kind, item) {
    return h('button', { className: 'more', type: 'button', title: 'Aktionen', text: '⋯', 'aria-label': 'Aktionen',
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, kind, item); } });
  }

  function folderTile(f) {
    const tile = h('div', { className: 'tile folder', role: 'button', tabIndex: 0, 'aria-label': 'Ordner ' + f.name },
      h('div', { className: 'ficon', text: '📁', 'aria-hidden': 'true' }),
      h('div', { className: 'body' },
        h('div', { className: 'title', text: f.name }),
        st.searching ? h('div', { className: 'where', text: pathText(f.parent_id) }) : null),
      moreButton('folder', f));
    attachGestures(tile, (x, y) => openMenu({ x, y }, 'folder', f), () => ctx.navigate('#/f/' + f.id));
    return tile;
  }

  function noteTile(note, slots) {
    // Querformat-Notizen bekommen einen Querformat-Rahmen (das Bild bestimmt das Verhältnis).
    const img = h('img', { className: 'thumb-img', alt: '', onload: (e) => {
      const box = e.currentTarget.parentElement;
      if (box && e.currentTarget.naturalWidth) box.style.aspectRatio = e.currentTarget.naturalWidth + ' / ' + e.currentTarget.naturalHeight;
    } });
    const reuse = urlOf.get(note.id);
    if (reuse) img.src = reuse;
    let slot = slots.get(note.id);
    if (!slot) { slot = { note, imgs: [] }; slots.set(note.id, slot); }
    slot.imgs.push(img);
    const tile = h('div', { className: 'tile note', role: 'button', tabIndex: 0, 'aria-label': 'Notiz ' + note.title },
      h('div', { className: 'thumb' }, img,
        note.pinned ? h('span', { className: 'fav-star', role: 'img', 'aria-label': 'Favorit', text: '★' }) : null,
        moreButton('note', note)),
      h('div', { className: 'meta' },
        h('div', { className: 'title', text: note.title }),
        h('div', { className: 'when', text: relTime(note.updated_at) }),
        st.searching ? h('div', { className: 'where', text: pathText(note.folder_id) }) : null));
    attachGestures(tile, (x, y) => openMenu({ x, y }, 'note', note), () => ctx.navigate('#/n/' + note.id));
    return tile;
  }

  // ── Aktionen ──
  function openMenu(anchor, kind, item) {
    const items = [
      { label: 'Umbenennen', icon: '✏️', onSelect: () => rename(kind, item) },
      { label: 'Verschieben…', icon: '📂', onSelect: () => move(kind, item) },
    ];
    if (kind === 'note') {
      items.push({ label: item.pinned ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: '★', onSelect: () => togglePin(item) });
    }
    if (shareFn) items.push({ label: 'Teilen…', icon: '👥', onSelect: () => share(kind, item) });
    items.push('sep', { label: 'Löschen', icon: '🗑️', danger: true, onSelect: () => remove(kind, item) });
    menu(anchor, items);
  }

  async function rename(kind, item) {
    const isFolder = kind === 'folder';
    const current = isFolder ? item.name : item.title;
    const name = await promptText({ title: isFolder ? 'Ordner umbenennen' : 'Notiz umbenennen', value: current,
      okLabel: 'Speichern', maxLength: 200 });
    if (!name || name === current) return;
    try {
      if (isFolder) await model.renameFolder(item.id, name);
      else await model.renameNote(item.id, name);
    } catch (e) { fail(e); }
  }

  async function move(kind, item) {
    const isFolder = kind === 'folder';
    const kids = childMap(st.folders);
    const banned = isFolder ? subtree(item.id, kids) : new Set();
    const original = isFolder ? (item.parent_id || null) : (item.folder_id || null);
    let selected = original;
    const entries = [];
    const paint = () => {
      for (const en of entries) {
        const on = en.id === selected;
        en.b.classList.toggle('on', on);
        en.b.setAttribute('aria-selected', String(on));
      }
    };
    const add = (id, label, depth) => {
      const dis = id !== null && banned.has(id);
      const b = h('button', { className: 'move-row' + (dis ? ' dis' : ''), type: 'button', role: 'option', text: label,
        title: label, disabled: dis, style: { paddingLeft: (12 + depth * 18) + 'px' },
        onclick: () => { if (dis) return; selected = id; paint(); } });
      entries.push({ id, b });
      return b;
    };
    const list = [add(null, 'Oberste Ebene', 0)];
    const walk = (key, depth) => {
      for (const f of kids.get(key) || []) {
        list.push(add(f.id, f.name, depth));
        walk(f.id, depth + 1);
      }
    };
    walk('', 0);
    paint();
    const body = h('div', { className: 'move-list', role: 'listbox' }, list);
    setTimeout(() => {
      // Gewählten Eintrag in die Mitte der Liste rollen.
      const en = entries.find((x) => x.id === selected);
      if (en) body.scrollTop = Math.max(0, en.b.offsetTop - body.clientHeight / 2);
    }, 50);
    const choice = await dialog({
      title: isFolder ? 'Ordner verschieben' : 'Notiz verschieben',
      body,
      actions: [{ label: 'Abbrechen', value: null }, { label: 'Verschieben', value: 'ok', primary: true }],
    });
    if (choice !== 'ok' || selected === original) return;
    try {
      if (isFolder) await model.moveFolder(item.id, selected);
      else await model.moveNote(item.id, selected);
      toast('Verschoben');
    } catch (e) { fail(e); }
  }

  async function togglePin(note) {
    const on = !note.pinned;
    try {
      await model.setPinned(note.id, on);
      toast(on ? 'Als Favorit markiert' : 'Aus Favoriten entfernt');
    } catch (e) { fail(e); }
  }

  async function remove(kind, item) {
    try {
      if (kind === 'folder') {
        const ok = await confirmDialog({
          title: 'Ordner löschen?',
          message: `„${item.name}“ kommt mit allen Unterordnern und Notizen in den Papierkorb.`,
          okLabel: 'In den Papierkorb',
          danger: true,
        });
        if (!ok) return;
        await model.deleteFolder(item.id);
      } else {
        await model.deleteNote(item.id);
      }
      toast('In den Papierkorb verschoben');
    } catch (e) { fail(e); }
  }

  async function share(kind, item) {
    const fn = shareFn || (await loadShare());
    if (!fn) { toast('Teilen kommt bald'); return; }
    try {
      await fn(kind, item.id, kind === 'folder' ? item.name : item.title, ctx);
    } catch (e) { fail(e); }
  }

  async function newFolder() {
    const name = await promptText({ title: 'Neuer Ordner', label: 'Name', placeholder: 'z. B. Schule',
      okLabel: 'Anlegen', maxLength: 200 });
    if (!name) return;
    try { await model.createFolder({ name, parentId: st.folderId }); } catch (e) { fail(e); }
  }

  async function newNote() {
    const prefs0 = readPrefs();
    const sel = {
      paper: PAPERS.includes(prefs0.paper) ? prefs0.paper : 'lined',
      orient: prefs0.orient === 'l' ? 'l' : 'p',
      size: PAGE_SIZES.includes(prefs0.size) ? prefs0.size : 'a4',
    };
    const input = h('input', { className: 'input', placeholder: today(), maxLength: 200, autocomplete: 'off',
      autocapitalize: 'sentences', 'aria-label': 'Titel' });
    const paperBtns = new Map();
    const orientBtns = new Map();
    const sizeBtns = new Map();
    const mark = () => {
      for (const [p, { b, cv }] of paperBtns) {
        const on = p === sel.paper;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        drawPreview(cv, p, sel.orient, sel.size);
      }
      for (const [z, b] of sizeBtns) {
        const on = z === sel.size;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      for (const [o, b] of orientBtns) {
        const on = o === sel.orient;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
    };
    const paperGrid = h('div', { className: 'paper-grid', role: 'radiogroup', 'aria-label': 'Papier' },
      PAPERS.map((p) => {
        const cv = h('canvas', { className: 'paper-canvas', 'aria-hidden': 'true' });
        const b = h('button', { className: 'paper-opt', type: 'button', role: 'radio', title: PAPER_NAMES[p],
          onclick: () => { sel.paper = p; mark(); } },
        cv, h('span', { text: PAPER_NAMES[p] }));
        paperBtns.set(p, { b, cv });
        return b;
      }));
    const orientSeg = h('div', { className: 'seg', role: 'radiogroup', 'aria-label': 'Ausrichtung' },
      [['p', 'Hoch'], ['l', 'Quer']].map(([o, label]) => {
        const b = h('button', { type: 'button', role: 'radio', text: label, onclick: () => { sel.orient = o; mark(); } });
        orientBtns.set(o, b);
        return b;
      }));
    const sizeSeg = h('div', { className: 'seg', role: 'radiogroup', 'aria-label': 'Format' },
      PAGE_SIZES.map((z) => {
        const b = h('button', { type: 'button', role: 'radio', text: SIZE_NAMES[z], onclick: () => { sel.size = z; mark(); } });
        sizeBtns.set(z, b);
        return b;
      }));
    mark();
    const choice = await dialog({
      title: 'Neue Notiz',
      body: h('div', { className: 'new-note' },
        h('label', { className: 'field' }, h('span', { text: 'Titel' }), input),
        h('div', { className: 'field' }, h('span', { text: 'Papier' }), paperGrid),
        h('div', { className: 'field' }, h('span', { text: 'Ausrichtung' }), orientSeg),
        h('div', { className: 'field' }, h('span', { text: 'Format' }), sizeSeg)),
      actions: [{ label: 'Abbrechen', value: null }, { label: 'Anlegen', value: 'ok', primary: true }],
    });
    if (choice !== 'ok') return;
    try {
      const note = await model.createNote({ title: input.value, folderId: st.folderId, paper: sel.paper, orient: sel.orient, size: sel.size });
      writePrefs({ paper: sel.paper, orient: sel.orient, size: sel.size });
      ctx.navigate('#/n/' + note.id);
    } catch (e) { fail(e); }
  }

  // ── Start ──
  model.on('change', onChange);
  function onChange() { if (alive) scheduleLoad(); }
  loadShare().then((fn) => { shareFn = fn; });
  loadBadge(model).then((b) => {
    if (!alive || !b) return;
    badge = b;
    statusSlot.append(b.el);
  });

  await load().catch((e) => {
    fail(e);
    content.replaceChildren(h('div', { className: 'empty' }, h('p', { text: 'Die Bibliothek konnte nicht geladen werden.' })));
  });

  return function unmount() {
    alive = false;
    loadSeq++;
    renderGen++;
    clearTimeout(timer);
    model.off('change', onChange);
    for (const u of urlOf.values()) URL.revokeObjectURL(u);
    urlOf.clear();
    if (badge && badge.destroy) { try { badge.destroy(); } catch { /* ignore */ } }
  };
}
