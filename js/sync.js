// Client sync engine (docs/ARCHITEKTUR.md 5.4). Local rows carry:
//   dirty: 0 = in sync, 1 = local change to push, 2 = rejected by the server (kept, shown as error)
//   lrev:  local change counter (detects edits made while a push was in flight)
//   need:  pages only, 1 = strokes outdated/missing, fetch via sync_pages
// The pure functions mergePulled() and applyPushResult() hold the merge rules and are unit-tested.

import { ApiError } from './api.js';

const KINDS = ['folder', 'note', 'page'];
const STORE = { folder: 'folders', note: 'notes', page: 'pages' };
const LOCAL_FIELDS = ['dirty', 'lrev', 'need', 'error', 'rev', 'seq', 'user_id'];
const PUSH_MAX = 50;
const PUSH_MAX_BYTES = 6 * 1024 * 1024;
const PAGES_MAX_BYTES = 3 * 1024 * 1024;
const PERIOD = 60000;
const BACKOFF = [5000, 15000, 30000, 60000, 120000, 300000];

// ───────────────────────── pure merge rules ─────────────────────────

/** A row from sync_pull meets the local row. Returns {action: 'put', row} | {action: 'delete'} | {action: 'keep'}. */
export function mergePulled(kind, local, row) {
  if (row.purged) return local && local.dirty === 1 && !local.purged ? { action: 'keep' } : { action: 'delete' };
  if (local && local.dirty >= 1) return { action: 'keep' }; // our change wins or conflicts at the next push
  const lrev = local ? local.lrev || 0 : 0;
  if (kind !== 'page') return { action: 'put', row: { ...row, dirty: 0, lrev } };
  const have = local && typeof local.strokes === 'string';
  const same = have && local.rev === row.rev && !local.need;
  return { action: 'put', row: { ...row, dirty: 0, lrev, strokes: have ? local.strokes : null, need: same ? 0 : 1 } };
}

/** Server answer to one pushed change. `sentLrev` = local lrev at send time. */
export function applyPushResult(kind, local, sentLrev, result) {
  if (!local) return { action: 'none' };
  const changedSince = (local.lrev || 0) !== sentLrev;
  if (result.status === 'rejected') {
    if (changedSince) return { action: 'none' };
    return { action: 'put', row: { ...local, dirty: 2, error: result.code || 'rejected' } };
  }
  const row = result.row;
  if (!row || row.purged) return changedSince && !local.purged ? { action: 'none' } : { action: 'delete' };
  if (changedSince) {
    // Newer local edits: keep them. Only adopt the new base rev if the server took our version as is;
    // after a conflict the old base makes the next push conflict again (server keeps both versions).
    return result.status === 'ok' ? { action: 'put', row: { ...local, rev: row.rev, seq: row.seq } } : { action: 'none' };
  }
  const merged = { ...local, ...row, dirty: 0, error: undefined };
  if (kind === 'page') {
    merged.strokes = typeof row.strokes === 'string' ? row.strokes : local.strokes;
    merged.need = 0;
  }
  return { action: 'put', row: merged };
}

/** Change payload for sync_push. */
export function toChange(kind, row) {
  const data = {};
  for (const [k, v] of Object.entries(row)) if (!LOCAL_FIELDS.includes(k) && k !== 'id') data[k] = v;
  return { kind, id: row.id, base_rev: row.rev || 0, data };
}

// ───────────────────────── engine ─────────────────────────

export function createSync({ db, api, onStatus = () => {}, onChange = () => {} }) {
  return new SyncEngine(db, api, onStatus, onChange);
}

class SyncEngine {
  constructor(db, api, onStatus, onChange) {
    this.db = db; this.api = api; this.onStatus = onStatus; this.onChange = onChange;
    this.status = { state: 'idle', pending: 0, lastSync: 0, error: null };
    this.running = false; this.again = false; this.stopped = false;
    this.timer = 0; this.failures = 0;
    this._onOnline = () => this.now();
    this._onVisible = () => { if (!document.hidden) this.now(); };
  }

  start() {
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', this._onVisible);
    this.interval = setInterval(() => this.now(), PERIOD);
    this.now();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    window.removeEventListener('online', this._onOnline);
    document.removeEventListener('visibilitychange', this._onVisible);
  }

  /** After a local change: sync in a few seconds (debounced). */
  schedule(delay = 3000) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.now(), delay);
    this._countPending();
  }

  async now() {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    clearTimeout(this.timer);
    this.running = true;
    try {
      do {
        this.again = false;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError(0, 'network', 'Offline');
        this._set({ state: 'syncing' });
        await this._push();
        await this._pull();
        await this._fetchStrokes();
      } while (this.again && !this.stopped);
      this.failures = 0;
      await this._countPending();
      this._set({ state: 'idle', lastSync: Date.now(), error: null });
    } catch (e) {
      await this._countPending().catch(() => {});
      this._fail(e);
    } finally {
      this.running = false;
    }
  }

  _fail(e) {
    const status = e instanceof ApiError ? e.status : -1;
    if (status === 401) { this._set({ state: 'auth', error: e.message }); return; }
    this._set({ state: status === 0 ? 'offline' : 'error', error: e.message || String(e) });
    const wait = BACKOFF[Math.min(this.failures++, BACKOFF.length - 1)];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.now(), wait);
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  async _countPending() {
    const n = await this.db.tx(['folders', 'notes', 'pages'], 'readonly', async (h) =>
      (await h.folders.count('dirty', 1)) + (await h.notes.count('dirty', 1)) + (await h.pages.count('dirty', 1)));
    const failed = await this.db.tx(['folders', 'notes', 'pages'], 'readonly', async (h) =>
      (await h.folders.count('dirty', 2)) + (await h.notes.count('dirty', 2)) + (await h.pages.count('dirty', 2)));
    if (n !== this.status.pending || failed !== this.status.failed) this._set({ pending: n, failed });
  }

  async _dirtyRows() {
    return this.db.tx(['folders', 'notes', 'pages'], 'readonly', async (h) => {
      const out = [];
      for (const kind of KINDS) {
        for (const row of await h[STORE[kind]].byIndex('dirty', 1)) {
          if (kind === 'page' && typeof row.strokes !== 'string') continue; // not loaded yet: never push blank ink
          out.push({ kind, row });
        }
      }
      return out;
    });
  }

  async _push() {
    for (let round = 0; round < 1000; round++) {
      const rows = await this._dirtyRows();
      if (!rows.length) return;
      const batch = [];
      let bytes = 0;
      for (const r of rows) {
        const b = r.kind === 'page' ? r.row.strokes.length + 300 : 300;
        if (batch.length && (batch.length >= PUSH_MAX || bytes + b > PUSH_MAX_BYTES)) break;
        batch.push(r);
        bytes += b;
      }
      const sent = batch.map((r) => ({ kind: r.kind, id: r.row.id, lrev: r.row.lrev || 0 }));
      const res = await this.api.post('sync_push', { changes: batch.map((r) => toChange(r.kind, r.row)) });
      const changed = [];
      await this.db.tx(['folders', 'notes', 'pages', 'thumbs'], 'readwrite', async (h) => {
        for (let i = 0; i < sent.length; i++) {
          const s = sent[i];
          const result = res.results[i];
          if (!result) continue;
          const store = h[STORE[s.kind]];
          const local = await store.get(s.id);
          const a = applyPushResult(s.kind, local, s.lrev, result);
          if (a.action === 'put') await store.put(a.row);
          if (a.action === 'delete') await this._deleteLocal(h, s.kind, s.id);
          if (a.action !== 'none') changed.push({ kind: s.kind, id: s.id });
        }
      });
      for (const c of changed) this.onChange(c);
      // Rows that stay dirty (edited meanwhile) are pushed in the next round; stop if nothing progressed.
      if (!changed.length) return;
    }
  }

  async _deleteLocal(h, kind, id) {
    await h[STORE[kind]].del(id);
    if (kind === 'note') await h.thumbs.del(id);
  }

  async _pull() {
    const meta = await this.db.get('meta', 'cursor');
    let since = meta ? meta.v : 0;
    let seen = null; // Set of ids during a reset (full re-download)
    for (let round = 0; round < 10000; round++) {
      const res = await this.api.get('sync_pull', { since, limit: 200 });
      if (res.reset && !seen) { seen = new Set(); since = 0; continue; }
      const changed = [];
      await this.db.tx(['folders', 'notes', 'pages', 'thumbs', 'meta'], 'readwrite', async (h) => {
        for (const it of res.items) {
          if (!STORE[it.kind]) continue;
          if (seen) seen.add(it.kind + ':' + it.row.id);
          const store = h[STORE[it.kind]];
          const local = await store.get(it.row.id);
          const a = mergePulled(it.kind, local, it.row);
          if (a.action === 'put') await store.put(a.row);
          if (a.action === 'delete' && local) await this._deleteLocal(h, it.kind, it.row.id);
          if (a.action !== 'keep') changed.push({ kind: it.kind, id: it.row.id });
        }
        await h.meta.put({ k: 'cursor', v: res.cursor });
      });
      since = res.cursor;
      for (const c of changed) this.onChange(c);
      if (!res.more) break;
    }
    if (seen) await this._sweep(seen);
  }

  /** After a reset: drop clean local rows the server no longer has. */
  async _sweep(seen) {
    const removed = [];
    await this.db.tx(['folders', 'notes', 'pages', 'thumbs'], 'readwrite', async (h) => {
      for (const kind of KINDS) {
        for (const row of await h[STORE[kind]].all()) {
          if (!row.dirty && !seen.has(kind + ':' + row.id)) { await this._deleteLocal(h, kind, row.id); removed.push({ kind, id: row.id }); }
        }
      }
    });
    for (const c of removed) this.onChange(c);
  }

  async _fetchStrokes() {
    const need = (await this.db.byIndex('pages', 'need', 1)).filter((p) => !p.dirty);
    while (need.length) {
      const batch = [];
      let bytes = 0;
      while (need.length && batch.length < 100 && (bytes === 0 || bytes + (need[0].bytes || 0) <= PAGES_MAX_BYTES)) {
        const p = need.shift();
        batch.push(p.id);
        bytes += p.bytes || 0;
      }
      const res = await this.api.post('sync_pages', { ids: batch });
      const changed = [];
      await this.db.tx('pages', 'readwrite', async (h) => {
        for (const row of res.pages) {
          const local = await h.pages.get(row.id);
          if (!local || local.dirty || local.rev > row.rev) continue;
          await h.pages.put({ ...local, ...row, need: 0, dirty: 0 });
          changed.push({ kind: 'page', id: row.id });
        }
      });
      for (const c of changed) this.onChange(c);
      // Ids the server did not return (byte cap or page gone) keep need = 1 and come again next cycle.
    }
  }
}
