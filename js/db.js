// IndexedDB layer, one database per user: notizen-u<userId>. See docs/ARCHITEKTUR.md 3.4.

const VERSION = 1;
const name = (userId) => 'notizen-u' + userId;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(userId) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name(userId), VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      const folders = d.createObjectStore('folders', { keyPath: 'id' });
      folders.createIndex('parent_id', 'parent_id');
      folders.createIndex('dirty', 'dirty');
      const notes = d.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('folder_id', 'folder_id');
      notes.createIndex('dirty', 'dirty');
      const pages = d.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('note_id', 'note_id');
      pages.createIndex('dirty', 'dirty');
      pages.createIndex('need', 'need');
      d.createObjectStore('meta', { keyPath: 'k' });
      d.createObjectStore('thumbs', { keyPath: 'note_id' });
      d.createObjectStore('shared', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => d.close();
      resolve(new Db(d));
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Datenbank ist in einem anderen Tab geöffnet.'));
  });
}

export function deleteDb(userId) {
  return req(indexedDB.deleteDatabase(name(userId)));
}

/** Promise wrapper around one object store inside a transaction. */
class StoreHandle {
  constructor(store) { this.s = store; }
  get(key) { return req(this.s.get(key)); }
  put(obj) { return req(this.s.put(obj)); }
  del(key) { return req(this.s.delete(key)); }
  all() { return req(this.s.getAll()); }
  byIndex(index, value) { return req(this.s.index(index).getAll(value)); }
  count(index, value) { return req(index ? this.s.index(index).count(value) : this.s.count()); }
}

export class Db {
  constructor(d) { this.d = d; }

  /** Runs fn({store: StoreHandle, …}) in one transaction; resolves with fn's result after commit. */
  tx(stores, mode, fn) {
    const list = Array.isArray(stores) ? stores : [stores];
    return new Promise((resolve, reject) => {
      const t = this.d.transaction(list, mode);
      const handles = {};
      for (const s of list) handles[s] = new StoreHandle(t.objectStore(s));
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
      Promise.resolve()
        .then(() => fn(handles))
        .then((r) => { result = r; }, (e) => { try { t.abort(); } catch { /* already done */ } reject(e); });
    });
  }

  get(store, key) { return this.tx(store, 'readonly', (h) => h[store].get(key)); }
  put(store, obj) { return this.tx(store, 'readwrite', (h) => h[store].put(obj)); }
  del(store, key) { return this.tx(store, 'readwrite', (h) => h[store].del(key)); }
  all(store) { return this.tx(store, 'readonly', (h) => h[store].all()); }
  byIndex(store, index, value) { return this.tx(store, 'readonly', (h) => h[store].byIndex(index, value)); }
  count(store, index, value) { return this.tx(store, 'readonly', (h) => h[store].count(index, value)); }
  close() { this.d.close(); }
}
