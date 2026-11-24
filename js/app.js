// Entry point of index.html: login state, offline start, hash router. See docs/ARCHITEKTUR.md 7.
//
// Views are modules with a mount function: mount(el, params, ctx) → unmount function (optional).
//   #/              library.js  mountLibrary   {folderId: null}
//   #/f/<id>        library.js  mountLibrary   {folderId}
//   #/n/<id>        editor.js   mountEditor    {noteId}
//   #/trash         trash.js    mountTrash     {}
//   #/shared        shared.js   mountShared    {}
//   #/shared/n/<id> shared.js   mountSharedNote {noteId}
//   #/account       account.js  mountAccount   {}
// ctx = {user, model, api, navigate(hash), logout(), refreshUser()}

import * as model from './model.js';
import { api, ApiError } from './api.js';
import { h, toast, dialog } from './ui/dom.js';

const LAST_USER = 'notizen:lastUser';
const ROUTES = [
  [/^#?\/?$/, 'library', 'mountLibrary', () => ({ folderId: null })],
  [/^#\/f\/([0-9a-f-]{36})$/, 'library', 'mountLibrary', (m) => ({ folderId: m[1] })],
  [/^#\/n\/([0-9a-f-]{36})$/, 'editor', 'mountEditor', (m) => ({ noteId: m[1] })],
  [/^#\/trash$/, 'trash', 'mountTrash', () => ({})],
  [/^#\/shared$/, 'shared', 'mountShared', () => ({})],
  [/^#\/shared\/n\/([0-9a-f-]{36})$/, 'shared', 'mountSharedNote', (m) => ({ noteId: m[1] })],
  [/^#\/account$/, 'account', 'mountAccount', () => ({})],
];

const root = document.getElementById('app');
let user = null;
let unmount = null;
let routeSeq = 0;
let loginOpen = null;

const ctx = {
  get user() { return user; },
  model,
  api,
  navigate: (hash) => { if (location.hash === hash) route(); else location.hash = hash; },
  logout,
  refreshUser: verifySession,
};

function readLastUser() {
  try { return JSON.parse(localStorage.getItem(LAST_USER)); } catch { return null; }
}

function writeLastUser(u) {
  try {
    if (u) localStorage.setItem(LAST_USER, JSON.stringify({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }));
    else localStorage.removeItem(LAST_USER);
  } catch { /* private mode */ }
}

async function login(opts = {}) {
  if (loginOpen) return loginOpen;
  loginOpen = (async () => {
    const { showLogin } = await import('./ui/login.js');
    const res = await showLogin({ ...opts, api });
    api.setCsrf(res.csrf);
    return res.user;
  })();
  try { return await loginOpen; } finally { loginOpen = null; }
}

async function startAs(u) {
  if (!user || user.id !== u.id) {
    await model.init(u);
  }
  user = u;
  writeLastUser(u);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

/** Checks the session online; repairs CSRF, user data, forced password change. Offline: keeps going. */
async function verifySession() {
  try {
    const r = await api.get('me');
    api.setCsrf(r.csrf);
    if (r.user.must_change_pw) {
      const u = await login({ forceChange: true, user: r.user });
      await switchUser(u);
      return;
    }
    if (user && r.user.id !== user.id) { await switchUser(r.user); return; }
    user = r.user;
    writeLastUser(user);
    model.syncNow();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) await reauth();
    // status 0 = offline: carry on with local data
  }
}

/** Session gone (expired, logged out elsewhere, locked): local data stays, sync waits for a new login. */
async function reauth() {
  const u = await login({ reason: 'expired', user });
  await switchUser(u);
}

async function switchUser(u) {
  const changed = !user || user.id !== u.id;
  await startAs(u);
  model.syncNow();
  if (changed) { ctx.navigate('#/'); }
}

async function logout() {
  const pending = await model.pendingCount().catch(() => 0);
  const choice = await dialog({
    title: 'Abmelden',
    body: h('div', {},
      pending > 0
        ? h('p', { className: 'error-text', text: `Achtung: ${pending} Änderung(en) sind noch nicht auf dem Server. Wenn du die Daten auf diesem Gerät löschst, gehen sie verloren.` })
        : h('p', { text: 'Alle Änderungen sind auf dem Server gespeichert.' }),
      h('p', { className: 'muted', text: 'Die Notizen bleiben für die nächste Anmeldung auf diesem Gerät, außer du löschst sie hier.' })),
    actions: [
      { label: 'Abbrechen', value: null },
      { label: 'Abmelden und Daten löschen', value: 'wipe', danger: true },
      { label: 'Abmelden', value: 'keep', primary: true },
    ],
  });
  if (!choice) return;
  try { await api.post('logout', { wipe: choice === 'wipe' }); } catch { /* offline: cookie stays, harmless */ }
  const id = user.id;
  if (unmount) { try { unmount(); } catch { /* ignore */ } unmount = null; }
  if (choice === 'wipe') await model.wipe(id); else await model.close();
  user = null;
  writeLastUser(null);
  root.replaceChildren();
  const u = await login();
  await startAs(u);
  ctx.navigate('#/');
}

async function route() {
  if (!user) return;
  const seq = ++routeSeq;
  const hash = location.hash || '#/';
  let target = null;
  for (const [re, mod, fn, params] of ROUTES) {
    const m = hash.match(re);
    if (m) { target = { mod, fn, params: params(m) }; break; }
  }
  if (!target) { ctx.navigate('#/'); return; }
  if (unmount) { try { unmount(); } catch (e) { console.error(e); } unmount = null; }
  root.replaceChildren();
  const el = h('div', { className: 'view view-' + target.mod });
  root.append(el);
  try {
    const m = await import(`./ui/${target.mod}.js`);
    if (seq !== routeSeq) return;
    const r = await m[target.fn](el, target.params, ctx);
    if (seq !== routeSeq) { if (typeof r === 'function') r(); return; }
    unmount = typeof r === 'function' ? r : null;
  } catch (e) {
    console.error(e);
    el.replaceChildren(h('div', { style: { padding: '24px' } },
      h('h2', { text: 'Diese Ansicht ist noch nicht verfügbar.' }),
      h('p', { className: 'muted', text: String(e && e.message ? e.message : e) }),
      h('button', { className: 'btn', text: 'Zur Übersicht', onclick: () => ctx.navigate('#/') })));
  }
}

async function boot() {
  window.addEventListener('notizen:unauthorized', () => { if (user && !loginOpen) reauth(); });
  window.addEventListener('hashchange', route);
  model.on('sync', (s) => { if (s.state === 'auth' && user && !loginOpen) reauth(); });

  const last = readLastUser();
  if (last) {
    // Offline-first: open the local data right away, check the session in the background.
    await startAs(last);
    route();
    verifySession();
  } else {
    const u = await login();
    await startAs(u);
    route();
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot().catch((e) => {
  console.error(e);
  toast('Start fehlgeschlagen: ' + (e.message || e), { type: 'error', ms: 8000 });
});
