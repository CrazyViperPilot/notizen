// App data model on top of IndexedDB. The only place that writes local data; every write marks the row dirty
// and schedules a sync. See docs/ARCHITEKTUR.md 7.1.
//
// Events: on('change', fn({kind, id}))  ·  on('sync', fn(status))

import { openDb, deleteDb } from './db.js';
import { createSync } from './sync.js';
import { api } from './api.js';

const STORE = { folder: 'folders', note: 'notes', page: 'pages' };
const NOTE_TOUCH_MS = 60000;

let db = null;
let sync = null;
let user = null;
const listeners = { change: new Set(), sync: new Set() };

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function on(ev, fn) { listeners[ev].add(fn); }
export function off(ev, fn) { listeners[ev].delete(fn); }
function emit(ev, data) { for (const fn of [...listeners[ev]]) { try { fn(data); } catch (e) { console.error(e); } } }

export async function init(u) {
  if (db) await close();
  user = u;
  db = await openDb(u.id);
  sync = createSync({ db, api, onStatus: (s) => emit('sync', s), onChange: (c) => emit('change', c) });
  sync.start();
}

export async function close() {
  imageCache.clear();
  if (sync) sync.stop();
  if (db) db.close();
  db = null; sync = null; user = null;
}

/** Removes all local data of a user (logout with "delete data on this device"). */
export async function wipe(userId) {
  if (user && user.id === userId) await close();
  await deleteDb(userId);
}

export function currentUser() { return user; }
export function syncStatus() { return sync ? sync.status : { state: 'idle', pending: 0, lastSync: 0, error: null }; }
export function syncNow() { return sync ? sync.now() : Promise.resolve(); }
/** Number of local changes not yet on the server (incl. rejected ones). */
export async function pendingCount() {
  if (!db) return 0;
  return db.tx(['folders', 'notes', 'pages'], 'readonly', async (h) => {
    let n = 0;
    for (const s of ['folders', 'notes', 'pages']) n += (await h[s].count('dirty', 1)) + (await h[s].count('dirty', 2));
    return n;
  });
}

function need() {
  if (!db) throw new Error('Nicht angemeldet');
  return db;
}

/** Writes a changed row (sets updated_at, dirty, lrev) and schedules a sync. */
async function write(kind, row, { touch = true } = {}) {
  const now = Date.now();
  const r = { ...row, dirty: 1, lrev: (row.lrev || 0) + 1 };
  if (touch) r.updated_at = Math.max(now, (row.updated_at || 0) + 1);
  delete r.error;
  await need().put(STORE[kind], r);
  emit('change', { kind, id: r.id });
  if (sync) sync.schedule();
  return r;
}

function base(now) {
  return { created_at: now, updated_at: now, deleted_at: null, purged: 0, rev: 0, lrev: 0, dirty: 1 };
}

// ───────────────────────── folders ─────────────────────────

async function folderMap() {
  // Includes purged rows (tombstones) so that their contents count as deleted until the server confirms.
  return new Map((await need().all('folders')).map((f) => [f.id, f]));
}

/** true if the folder or one of its ancestors is deleted (or missing in a chain = treated as top level). */
function folderGone(map, id) {
  for (let i = 0, cur = id; cur && i < 200; i++) {
    const f = map.get(cur);
    if (!f) return false;
    if (f.deleted_at || f.purged) return true;
    cur = f.parent_id;
  }
  return false;
}

const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'de', { sensitivity: 'base' });

/** All visible folders (not deleted, no deleted ancestor), sorted by name. parent_id of orphans → null. */
export async function listFolders() {
  const map = await folderMap();
  return [...map.values()]
    .filter((f) => !f.purged && !folderGone(map, f.id))
    .map((f) => (f.parent_id && !map.has(f.parent_id) ? { ...f, parent_id: null } : f))
    .sort(byName);
}

export async function getFolder(id) {
  const f = await need().get('folders', id);
  return f && !f.purged ? f : null;
}

export async function createFolder({ name, parentId = null }) {
  const now = Date.now();
  return write('folder', { id: uuid(), parent_id: parentId, name: cleanName(name, 'Neuer Ordner'), ...base(now) }, { touch: false });
}

export async function renameFolder(id, name) {
  const f = await getFolder(id);
  if (f) return write('folder', { ...f, name: cleanName(name, f.name) });
}

export async function moveFolder(id, parentId) {
  const map = await folderMap();
  for (let cur = parentId, i = 0; cur && i < 200; i++) {
    if (cur === id) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden.');
    cur = map.get(cur) ? map.get(cur).parent_id : null;
  }
  const f = map.get(id);
  if (f && !f.purged) return write('folder', { ...f, parent_id: parentId || null });
}

export async function deleteFolder(id) {
  const f = await getFolder(id);
  if (f) { const now = Date.now(); return write('folder', { ...f, deleted_at: now, updated_at: now }, { touch: false }); }
}

export async function restoreFolder(id) {
  const f = await getFolder(id);
  if (f) return write('folder', { ...f, deleted_at: null });
}

// ───────────────────────── notes ─────────────────────────

/** Visible notes in a folder (null = top level, including notes whose folder is unknown). Newest first. */
export async function listNotes(folderId = null) {
  const map = await folderMap();
  const notes = folderId ? await need().byIndex('notes', 'folder_id', folderId) : await need().all('notes');
  return notes
    .filter((n) => !n.purged && !n.deleted_at && !folderGone(map, n.folder_id))
    .filter((n) => (folderId ? true : !n.folder_id || !map.has(n.folder_id)))
    .sort((a, b) => b.updated_at - a.updated_at);
}

export async function getNote(id) {
  const n = await need().get('notes', id);
  return n && !n.purged ? n : null;
}

export async function createNote({ title, folderId = null, paper = 'lined', orient = 'p' }) {
  const now = Date.now();
  const note = await write('note', { id: uuid(), folder_id: folderId, title: cleanName(title, defaultTitle()), ...base(now) }, { touch: false });
  await write('page', newPage(note.id, 1, paper, orient, now), { touch: false });
  return note;
}

export async function renameNote(id, title) {
  const n = await getNote(id);
  if (n) return write('note', { ...n, title: cleanName(title, n.title) });
}

export async function moveNote(id, folderId) {
  const n = await getNote(id);
  if (n) return write('note', { ...n, folder_id: folderId || null });
}

export async function deleteNote(id) {
  const n = await getNote(id);
  if (n) { const now = Date.now(); return write('note', { ...n, deleted_at: now, updated_at: now }, { touch: false }); }
}

export async function restoreNote(id) {
  const n = await getNote(id);
  if (!n) return;
  // A note restored from a deleted folder goes to the top level.
  const map = await folderMap();
  const folder_id = folderGone(map, n.folder_id) ? null : n.folder_id;
  return write('note', { ...n, deleted_at: null, folder_id });
}

// ───────────────────────── pages ─────────────────────────

function newPage(noteId, pos, paper, orient, now = Date.now()) {
  return { id: uuid(), note_id: noteId, pos, paper, orient, bg: null, strokes: '[]', bytes: 2, conflict: 0, need: 0, ...base(now) };
}

/** Visible pages of a note, by pos. Pages whose strokes are not downloaded yet have strokes === null. */
export async function listPages(noteId) {
  return (await need().byIndex('pages', 'note_id', noteId))
    .filter((p) => !p.purged && !p.deleted_at)
    .sort((a, b) => a.pos - b.pos);
}

export async function getPage(id) {
  const p = await need().get('pages', id);
  return p && !p.purged ? p : null;
}

/** pos for a new page right after `afterPageId` (null/unknown = at the end); renumbers the note if needed. */
async function posAfter(noteId, afterPageId) {
  let pages = await listPages(noteId);
  const i = afterPageId ? pages.findIndex((p) => p.id === afterPageId) : -1;
  if (i < 0 || i === pages.length - 1) return (pages.length ? pages[pages.length - 1].pos : 0) + 1;
  if (pages[i + 1].pos - pages[i].pos < 1e-9) {
    for (let k = 0; k < pages.length; k++) if (pages[k].pos !== k + 1) await write('page', { ...pages[k], pos: k + 1 });
    pages = await listPages(noteId);
  }
  return (pages[i].pos + pages[i + 1].pos) / 2;
}

/** Moves a page before `beforePageId` (null = to the end). */
export async function movePage(pageId, beforePageId) {
  const p = await getPage(pageId);
  if (!p || pageId === beforePageId) return;
  const others = (await listPages(p.note_id)).filter((x) => x.id !== pageId);
  const j = beforePageId ? others.findIndex((x) => x.id === beforePageId) : -1;
  let pos;
  if (j < 0) pos = (others.length ? others[others.length - 1].pos : 0) + 1;
  else if (j === 0) pos = others[0].pos - 1;
  else pos = (others[j - 1].pos + others[j].pos) / 2;
  if (j > 0 && others[j].pos - others[j - 1].pos < 1e-9) {
    // Renumber all pages with the moved one in place.
    const order = [...others.slice(0, j), p, ...others.slice(j)];
    for (let k = 0; k < order.length; k++) if (order[k].pos !== k + 1) await write('page', { ...(await getPage(order[k].id)), pos: k + 1 });
  } else {
    await write('page', { ...p, pos });
  }
  await touchNote(p.note_id, true);
}

/** Copy of a page (paper, background, strokes) right after it. */
export async function duplicatePage(pageId) {
  const p = await getPage(pageId);
  if (!p || typeof p.strokes !== 'string') return null;
  const pos = await posAfter(p.note_id, pageId);
  const copy = { ...newPage(p.note_id, pos, p.paper, p.orient), bg: p.bg || null, strokes: p.strokes, bytes: p.strokes.length };
  const r = await write('page', copy, { touch: false });
  await touchNote(p.note_id, true);
  return r;
}

// ───────────────────────── page background images (assets) ─────────────────────────

async function sha256hex(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stores a JPEG as local asset (to be uploaded) and returns its id. Same bytes → same id. */
export async function putAsset(blob, w, h) {
  const id = await sha256hex(blob);
  if (!(await need().get('assets', id))) {
    await need().put('assets', { id, blob, mime: 'image/jpeg', w, h, uploaded: 0, at: Date.now() });
  }
  return id;
}

/** Sets or removes a page's background image (asset id from putAsset, or null). */
export async function setPageBackground(pageId, assetId) {
  const p = await getPage(pageId);
  if (p && typeof p.strokes === 'string') return write('page', { ...p, bg: assetId || null });
}

/**
 * New pages with a background image each, after `afterPageId` (in order). images: [{blob (JPEG), w, h}].
 * Paper 'blank', orientation from the image. Returns the new pages.
 */
export async function addImagePages(noteId, afterPageId, images) {
  const out = [];
  let after = afterPageId;
  for (const im of images) {
    const id = await sha256hex(im.blob);
    if (!(await need().get('assets', id))) {
      await need().put('assets', { id, blob: im.blob, mime: 'image/jpeg', w: im.w, h: im.h, uploaded: 0, at: Date.now() });
    }
    const pos = await posAfter(noteId, after);
    const page = await write('page', { ...newPage(noteId, pos, 'blank', im.w > im.h ? 'l' : 'p'), bg: id }, { touch: false });
    out.push(page);
    after = page.id;
  }
  if (out.length) await touchNote(noteId, true);
  return out;
}

const imageCache = new Map(); // assetId → Promise<image|null>

function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')); };
    img.src = url;
  });
}

/** Local asset record or null. */
export async function getAsset(id) {
  return db ? (await need().get('assets', id)) || null : null;
}

/**
 * Decoded background image (cached). Missing locally → downloaded (own image, or via `noteId` for shared/admin views)
 * and stored. Resolves null when it cannot be loaded (offline, no access).
 */
export function getImage(id, { noteId = null, store = true } = {}) {
  if (!id) return Promise.resolve(null);
  if (imageCache.has(id)) return imageCache.get(id);
  const p = (async () => {
    let rec = db ? await need().get('assets', id) : null;
    if (!rec) {
      const blob = await api.blob('asset_get', { id, note: noteId || undefined });
      if (store && db) {
        rec = { id, blob, mime: blob.type || 'image/jpeg', w: 0, h: 0, uploaded: 1, at: Date.now() };
        await need().put('assets', rec);
      } else rec = { blob };
    }
    return decodeImage(rec.blob);
  })().catch((e) => { imageCache.delete(id); console.warn('Bild', id, e); return null; });
  imageCache.set(id, p);
  return p;
}

export async function addPage(noteId, afterPageId, { paper, orient }) {
  let pages = await listPages(noteId);
  let pos;
  const i = afterPageId ? pages.findIndex((p) => p.id === afterPageId) : -1;
  if (i < 0 || i === pages.length - 1) pos = (pages.length ? pages[pages.length - 1].pos : 0) + 1;
  else {
    pos = (pages[i].pos + pages[i + 1].pos) / 2;
    if (pages[i + 1].pos - pages[i].pos < 1e-9) {
      // Renumber 1, 2, 3 … (rare)
      for (let k = 0; k < pages.length; k++) if (pages[k].pos !== k + 1) await write('page', { ...pages[k], pos: k + 1 });
      pages = await listPages(noteId);
      pos = pages[i].pos + 0.5;
    }
  }
  const page = await write('page', newPage(noteId, pos, paper, orient), { touch: false });
  await touchNote(noteId, true);
  return page;
}

export async function deletePage(id) {
  const p = await getPage(id);
  if (!p) return;
  const now = Date.now();
  await write('page', { ...p, deleted_at: now, updated_at: now }, { touch: false });
  await touchNote(p.note_id, true);
}

export async function setPaper(id, paper, orient) {
  const p = await getPage(id);
  if (p && typeof p.strokes === 'string') return write('page', { ...p, paper, orient: orient || p.orient });
}

export async function saveStrokes(pageId, strokes) {
  const p = await getPage(pageId);
  if (!p || p.strokes === strokes) return p;
  const r = await write('page', { ...p, strokes, bytes: strokes.length, need: 0 });
  await touchNote(p.note_id, false);
  return r;
}

/** Keeps note.updated_at roughly current for "last changed" sorting (at most once a minute while writing). */
async function touchNote(noteId, force) {
  const n = await getNote(noteId);
  if (n && (force || Date.now() - n.updated_at > NOTE_TOUCH_MS)) await write('note', n);
}

// ───────────────────────── favorites & recently opened ─────────────────────────

const RECENT_KEY = 'notizen:recent';
const RECENT_MAX = 8;

export async function setPinned(noteId, pinned) {
  const n = await getNote(noteId);
  if (n && !!n.pinned !== !!pinned) return write('note', { ...n, pinned: pinned ? 1 : 0 }, { touch: false });
}

/** Visible pinned notes, most recently changed first. */
export async function listPinned() {
  const map = await folderMap();
  return (await need().all('notes'))
    .filter((n) => n.pinned && !n.purged && !n.deleted_at && !folderGone(map, n.folder_id))
    .sort((a, b) => b.updated_at - a.updated_at);
}

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string') : [];
  } catch { return []; }
}

/** Remembers that a note was opened on this device (called by the editor). */
export function noteOpened(noteId) {
  const list = [{ id: noteId, at: Date.now() }, ...readRecent().filter((x) => x.id !== noteId)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

/** Recently opened notes on this device that still exist (newest first). */
export async function listRecent() {
  const map = await folderMap();
  const out = [];
  for (const r of readRecent()) {
    const n = await need().get('notes', r.id);
    if (n && !n.purged && !n.deleted_at && !folderGone(map, n.folder_id)) out.push(n);
  }
  return out;
}

// ───────────────────────── trash & search ─────────────────────────

/** Deleted items whose parents are not deleted (the "top" of each deleted subtree). */
export async function listTrash() {
  const map = await folderMap();
  const folders = [...map.values()].filter((f) => !f.purged && f.deleted_at && !folderGone(map, f.parent_id));
  const notes = (await need().all('notes')).filter((n) => !n.purged && n.deleted_at && !folderGone(map, n.folder_id));
  return { folders: folders.sort(byName), notes: notes.sort((a, b) => b.deleted_at - a.deleted_at) };
}

/** Delete permanently (also everything inside). */
export async function purge(kind, id) {
  const store = STORE[kind];
  const row = await need().get(store, id);
  if (!row) return;
  const now = Date.now();
  await write(kind, { ...row, purged: 1, deleted_at: row.deleted_at || now, updated_at: now }, { touch: false });
}

export async function emptyTrash() {
  const t = await listTrash();
  for (const f of t.folders) await purge('folder', f.id);
  for (const n of t.notes) await purge('note', n.id);
}

export async function search(q) {
  const s = (q || '').trim().toLocaleLowerCase('de');
  if (!s) return { folders: [], notes: [] };
  const folders = (await listFolders()).filter((f) => f.name.toLocaleLowerCase('de').includes(s));
  const map = await folderMap();
  const notes = (await need().all('notes'))
    .filter((n) => !n.purged && !n.deleted_at && !folderGone(map, n.folder_id) && n.title.toLocaleLowerCase('de').includes(s))
    .sort((a, b) => b.updated_at - a.updated_at);
  return { folders, notes };
}

// ───────────────────────── thumbnails & shared cache (local only) ─────────────────────────

export const thumbs = {
  get: (noteId) => need().get('thumbs', noteId),
  put: (noteId, key, blob) => need().put('thumbs', { note_id: noteId, page_rev: key, blob }),
};

export const sharedCache = {
  get: (key) => need().get('shared', key).then((r) => (r ? r.v : null)),
  put: (key, v) => need().put('shared', { key, v, at: Date.now() }),
};

// ───────────────────────── helpers ─────────────────────────

function cleanName(s, fallback) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return t || fallback;
}

function defaultTitle() {
  return new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
