// Admin-Bereich (admin.html, nur online). Eigene Seite: lädt nur css/base.css und css/admin.css.
// Routen und Fehlercodes: backend/admin.php, Ein-/Ausgaben: docs/ARCHITEKTUR.md 4.
// Benutzerdaten nur per textContent/Attribut (h() aus ui/dom.js), nie per innerHTML.
// Schutzregeln (letzter Admin, Selbstsperre, Selbstlöschung) prüft der Server; hier wird nur das Ergebnis angezeigt.

import { api, ApiError } from '../api.js';
import { h, toast, dialog, confirmDialog, menu, relTime, formatBytes } from '../ui/dom.js';
import { createSurface } from '../ink/surface.js';

const MB = 1048576;
const LOG_PAGE = 50;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const ACTION_TEXT = {
  create_user: 'angelegt',
  update_user: 'geändert',
  reset_password: 'Passwort zurückgesetzt',
  lock_user: 'gesperrt',
  unlock_user: 'entsperrt',
  logout_user: 'abgemeldet',
  delete_user: 'gelöscht',
  view_tree: 'Notizen angesehen',
  view_note: 'Notiz geöffnet',
};

const root = document.getElementById('admin');
let me = null;          // angemeldeter Admin (user_public)
let whoEl = null;       // „angemeldet als …“ in der Kopfzeile
let mainEl = null;      // Inhaltsbereich unter den Reitern
let tabBtns = [];
let tab = 'users';
let leaveView = null;   // Aufräumfunktion der gerade gezeigten Ansicht (Surface.destroy o. Ä.)

// api.js meldet jedes 401, also auch Fehlversuche beim Anmelden. Reagiert wird nur, wenn eine Sitzung abgelaufen ist.
window.addEventListener('notizen:unauthorized', () => {
  if (!me) return;
  me = null;
  leave();
  showLogin('Die Sitzung ist abgelaufen. Bitte erneut anmelden.');
});

start();

async function start() {
  root.replaceChildren(h('p', { className: 'boot muted', text: 'Lade …' }));
  try {
    const res = await api.get('me');
    api.setCsrf(res.csrf);
    enter(res.user);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) showLogin();
    else showStartError(e);
  }
}

function showStartError(e) {
  root.replaceChildren(gatePage('Nicht erreichbar', msg(e), [retryButton()]));
}

function retryButton() {
  return h('button', { className: 'btn primary', type: 'button', text: 'Erneut versuchen', onclick: () => start() });
}

/** Nach erfolgreicher Anmeldung bzw. Sitzungsprüfung: Passwort-Hinweis und Rollenprüfung, sonst Admin-Oberfläche. */
function enter(user) {
  if (user.must_change_pw) {
    root.replaceChildren(gatePage('Erst ein eigenes Passwort', 'Bitte zuerst in der App ein eigenes Passwort setzen.'));
    return;
  }
  if (user.role !== 'admin') {
    root.replaceChildren(gatePage('Kein Zugriff', 'Dieser Bereich ist nur für Admins.'));
    return;
  }
  me = user;
  showApp();
}

/** Seite mit Text, Link zur App und Abmelden. */
function gatePage(title, text, extra = []) {
  return h('div', { className: 'login-wrap' },
    h('section', { className: 'login-card' },
      h('h1', { text: title }),
      h('p', { className: 'muted', text }),
      h('div', { className: 'login-links' },
        h('a', { className: 'btn primary', href: 'index.html', text: 'Zur App' }),
        ...extra,
        h('button', { className: 'btn ghost', type: 'button', text: 'Abmelden', onclick: logout }))));
}

function showLogin(message = '') {
  me = null;
  const user = h('input', { className: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, required: true, maxLength: 64 });
  const pw = h('input', { className: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxLength: 200 });
  const err = h('div', { className: 'error-text', role: 'alert', text: message });
  const btn = h('button', { className: 'btn primary login-submit', type: 'submit', text: 'Anmelden' });
  const form = h('form', {
    className: 'login-form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (btn.disabled) return;
      err.textContent = '';
      btn.disabled = true;
      try {
        const res = await api.post('login', { username: user.value.trim(), password: pw.value });
        api.setCsrf(res.csrf);
        enter(res.user);
      } catch (e) {
        err.textContent = msg(e);
        pw.value = '';
        pw.focus();
        btn.disabled = false;
      }
    },
  }, field('Benutzername', user), field('Passwort', pw), err, btn);
  root.replaceChildren(h('div', { className: 'login-wrap' },
    h('section', { className: 'login-card' },
      h('h1', { text: 'Notizen · Admin' }),
      h('p', { className: 'muted', text: 'Anmeldung mit Benutzername und Passwort.' }),
      form,
      h('div', { className: 'login-links' }, h('a', { className: 'btn ghost', href: 'index.html', text: 'Zur App' })))));
  user.focus();
}

async function logout() {
  try {
    await api.post('logout');
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) { showErr(e); return; }
  }
  location.reload();
}

// ───────────────────────── Grundgerüst ─────────────────────────

function showApp() {
  whoEl = h('span', { className: 'who' });
  mainEl = h('main', { className: 'admin-main' });
  tabBtns = [
    h('button', { className: 'tab', type: 'button', role: 'tab', dataset: { tab: 'users' }, text: 'Benutzer', onclick: () => setTab('users') }),
    h('button', { className: 'tab', type: 'button', role: 'tab', dataset: { tab: 'log' }, text: 'Protokoll', onclick: () => setTab('log') }),
  ];
  root.replaceChildren(
    h('header', { className: 'admin-bar' },
      h('div', { className: 'bar-inner' },
        h('h1', { className: 'brand' }, 'Notizen', h('span', { className: 'sep', 'aria-hidden': 'true', text: '·' }), 'Admin'),
        whoEl,
        h('div', { className: 'bar-actions' },
          h('a', { className: 'btn ghost', href: 'index.html', text: 'Zur App' }),
          h('button', { className: 'btn ghost', type: 'button', text: 'Abmelden', onclick: logout })))),
    h('div', { className: 'tabs-wrap' }, h('nav', { className: 'tabs', role: 'tablist', 'aria-label': 'Bereiche' }, tabBtns)),
    mainEl);
  updateWho();
  setTab(tab);
}

function updateWho() {
  if (whoEl && me) whoEl.textContent = 'angemeldet als ' + displayName(me);
}

function setTab(name) {
  tab = name;
  for (const b of tabBtns) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  if (name === 'users') renderUsers();
  else renderLog();
}

/** Beendet die gerade offene Ansicht (z. B. Notizansicht mit Surface). */
function leave() {
  const f = leaveView;
  leaveView = null;
  if (f) f();
}

// ───────────────────────── Benutzer ─────────────────────────

async function renderUsers() {
  leave();
  const count = h('span', { className: 'count muted' });
  const status = h('p', { className: 'muted', role: 'status', text: 'Lade Benutzer …' });
  const list = h('ul', { className: 'user-list' });
  mainEl.replaceChildren(
    h('div', { className: 'toolbar' },
      h('h2', { text: 'Benutzer' }),
      count,
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn ghost', type: 'button', text: 'Aktualisieren', onclick: () => renderUsers() }),
      h('button', { className: 'btn primary', type: 'button', text: '+ Benutzer anlegen', onclick: () => createUserDialog() })),
    h('div', { className: 'user-head', 'aria-hidden': 'true' },
      h('span', { text: 'Benutzer' }), h('span', { text: 'Rolle' }), h('span', { text: 'Status' }),
      h('span', { text: 'Letzte Anmeldung' }), h('span', { text: 'Speicher' }), h('span', { text: 'Notizen' }),
      h('span', { text: 'Sitzungen' }), h('span')),
    status,
    list);
  try {
    const res = await api.get('admin_users');
    status.remove();
    const users = res.users;
    count.textContent = users.length + (users.length === 1 ? ' Konto' : ' Konten');
    if (!users.length) list.replaceChildren(h('li', { className: 'muted', text: 'Noch keine Benutzer.' }));
    else list.replaceChildren(...users.map(userRow));
  } catch (e) {
    status.textContent = msg(e) + ' ';
    status.append(h('button', { className: 'btn', type: 'button', text: 'Erneut laden', onclick: () => renderUsers() }));
  }
}

function userRow(u) {
  const self = u.id === me.id;
  const name = displayName(u);
  const pct = u.quota_bytes > 0 ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;
  const active = u.status === 'active';
  return h('li', { className: 'user-row' + (active ? '' : ' is-locked') + (self ? ' is-self' : '') },
    cell('c-name', null,
      h('strong', { text: name + (self ? ' (du)' : '') }),
      h('span', { className: 'uname', text: u.username }),
      u.must_change_pw ? h('span', { className: 'badges' }, badge('Passwort offen', 'warn')) : null),
    cell('c-role', 'Rolle', badge(u.role === 'admin' ? 'Admin' : 'Benutzer', u.role === 'admin' ? 'admin' : '')),
    cell('c-status', 'Status', badge(active ? 'aktiv' : 'gesperrt', active ? 'ok' : 'danger')),
    cell('c-login', 'Letzte Anmeldung',
      h('span', { text: u.last_login_at ? relTime(u.last_login_at) : 'noch nie', title: u.last_login_at ? fullTime(u.last_login_at) : '' })),
    cell('c-storage', 'Speicher',
      h('span', { text: formatBytes(u.used_bytes) + ' von ' + formatBytes(u.quota_bytes) }),
      meter(pct)),
    cell('c-notes', 'Notizen', String(u.notes_count)),
    cell('c-sess', 'Sitzungen', String(u.sessions_count)),
    h('div', { className: 'cell c-actions' },
      h('button', {
        className: 'btn icon', type: 'button', text: '⋯', title: 'Aktionen',
        'aria-label': 'Aktionen für ' + name, 'aria-haspopup': 'menu',
        onclick: (e) => openUserMenu(e.currentTarget, u),
      })));
}

function openUserMenu(anchor, u) {
  const self = u.id === me.id;
  const active = u.status === 'active';
  const items = [
    { label: 'Bearbeiten', onSelect: () => editUserDialog(u) },
    { label: 'Passwort zurücksetzen', onSelect: () => resetPassword(u) },
  ];
  if (!self) items.push({ label: active ? 'Sperren' : 'Entsperren', onSelect: () => toggleLock(u) });
  items.push({ label: 'Überall abmelden', onSelect: () => logoutUser(u) });
  items.push({ label: 'Notizen ansehen', onSelect: () => showNotes(u) });
  if (!self) items.push('sep', { label: 'Löschen', danger: true, onSelect: () => deleteUser(u) });
  menu(anchor, items);
}

async function createUserDialog() {
  const user = h('input', { className: 'input', maxLength: 32, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, placeholder: 'z. B. anna.k' });
  const name = h('input', { className: 'input', maxLength: 64, autocomplete: 'off', placeholder: 'z. B. Anna Keller' });
  const role = h('select', { className: 'input' }, h('option', { value: 'user', text: 'Benutzer' }), h('option', { value: 'admin', text: 'Admin' }));
  const quota = h('input', { className: 'input', type: 'number', inputMode: 'numeric', min: 1, max: 100000, step: 1, value: '500' });
  const pw = h('input', { className: 'input', type: 'password', autocomplete: 'new-password', maxLength: 200, placeholder: 'leer lassen für Einmal-Passwort' });
  const err = h('div', { className: 'error-text', role: 'alert' });
  let created = null;

  const r = await dialog({
    title: 'Benutzer anlegen',
    body: h('div', {},
      field('Benutzername', user, 'a–z, 0–9, Punkt, Bindestrich und Unterstrich, 3 bis 32 Zeichen. Später nicht mehr änderbar.'),
      field('Anzeigename', name),
      field('Rolle', role),
      field('Speicherlimit (MB)', quota, 'Standard 500 MB.'),
      field('Eigenes Passwort (optional)', pw, 'Leer lassen: Die App erzeugt ein Einmal-Passwort. Sonst mindestens 10 Zeichen.'),
      err),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Anlegen', value: 'ok', primary: true }],
    onAction: async () => {
      const username = user.value.trim().toLowerCase();
      const mb = Number(quota.value);
      const password = pw.value;
      let problem = null;
      if (!USERNAME_RE.test(username)) problem = 'Der Benutzername muss 3 bis 32 Zeichen lang sein und darf nur a–z, 0–9, Punkt, Bindestrich und Unterstrich enthalten.';
      else if (!Number.isInteger(mb) || mb < 1 || mb > 100000) problem = 'Das Speicherlimit muss eine ganze Zahl von 1 bis 100000 MB sein.';
      else if (password !== '' && [...password].length < 10) problem = 'Das Passwort muss mindestens 10 Zeichen haben.';
      if (problem) { err.textContent = problem; return false; }
      const body = { username, display_name: name.value.trim(), role: role.value, quota_mb: mb };
      if (password !== '') body.password = password;
      try {
        created = await api.post('admin_user_create', body);
        return true;
      } catch (e) {
        err.textContent = msg(e);
        return false;
      }
    },
  });
  if (r !== 'ok' || !created) return;
  await showOnce('Benutzer angelegt', created.user.username, created.temp_password);
  renderUsers();
}

async function editUserDialog(u) {
  const name = h('input', { className: 'input', maxLength: 64, autocomplete: 'off', value: u.display_name });
  const role = h('select', { className: 'input' }, h('option', { value: 'user', text: 'Benutzer' }), h('option', { value: 'admin', text: 'Admin' }));
  role.value = u.role;
  const quota = h('input', { className: 'input', type: 'number', inputMode: 'numeric', min: 1, max: 100000, step: 1, value: String(Math.round(u.quota_bytes / MB)) });
  const err = h('div', { className: 'error-text', role: 'alert' });
  let saved = null;

  const r = await dialog({
    title: 'Benutzer bearbeiten',
    body: h('div', {},
      h('p', { className: 'hint', text: 'Benutzername: ' + u.username }),
      field('Anzeigename', name),
      field('Rolle', role),
      field('Speicherlimit (MB)', quota),
      err),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Speichern', value: 'ok', primary: true }],
    onAction: async () => {
      const n = name.value.trim();
      const mb = Number(quota.value);
      if (!n) { err.textContent = 'Bitte einen Anzeigenamen eingeben.'; return false; }
      if (!Number.isInteger(mb) || mb < 1 || mb > 100000) { err.textContent = 'Das Speicherlimit muss eine ganze Zahl von 1 bis 100000 MB sein.'; return false; }
      const body = { id: u.id };
      if (n !== u.display_name) body.display_name = n;
      if (role.value !== u.role) body.role = role.value;
      if (mb !== Math.round(u.quota_bytes / MB)) body.quota_mb = mb;
      try {
        saved = await api.post('admin_user_update', body);
        return true;
      } catch (e) {
        err.textContent = msg(e);
        return false;
      }
    },
  });
  if (r !== 'ok' || !saved) return;
  if (u.id === me.id) {
    // Eigene Rolle herabgestuft: die Oberfläche ist danach nicht mehr erlaubt.
    if (saved.user.role !== 'admin') { location.reload(); return; }
    me = { ...me, display_name: saved.user.display_name };
    updateWho();
  }
  toast('Gespeichert.', { type: 'ok' });
  renderUsers();
}

async function resetPassword(u) {
  const ok = await confirmDialog({
    title: 'Passwort zurücksetzen?',
    message: `Für „${displayName(u)}“ wird ein neues Einmal-Passwort erzeugt. Alle Sitzungen dieses Kontos enden sofort.`,
    okLabel: 'Zurücksetzen',
    danger: true,
  });
  if (!ok) return;
  let res;
  try {
    res = await api.post('admin_user_reset', { id: u.id });
  } catch (e) {
    showErr(e);
    return;
  }
  await showOnce('Passwort zurückgesetzt', u.username, res.temp_password);
  if (u.id === me.id) { location.reload(); return; }
  renderUsers();
}

async function toggleLock(u) {
  const lock = u.status === 'active';
  const ok = await confirmDialog({
    title: lock ? 'Konto sperren?' : 'Konto entsperren?',
    message: lock
      ? `„${displayName(u)}“ kann sich dann nicht mehr anmelden. Bestehende Sitzungen enden sofort.`
      : `„${displayName(u)}“ kann sich wieder anmelden.`,
    okLabel: lock ? 'Sperren' : 'Entsperren',
    danger: lock,
  });
  if (!ok) return;
  try {
    await api.post('admin_user_lock', { id: u.id, locked: lock });
    toast(lock ? 'Konto gesperrt.' : 'Konto entsperrt.', { type: 'ok' });
    renderUsers();
  } catch (e) {
    showErr(e);
  }
}

async function logoutUser(u) {
  const ok = await confirmDialog({
    title: 'Überall abmelden?',
    message: `Alle angemeldeten Geräte von „${displayName(u)}“ werden abgemeldet.`,
    okLabel: 'Abmelden',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post('admin_user_logout', { id: u.id });
  } catch (e) {
    showErr(e);
    return;
  }
  if (u.id === me.id) { location.reload(); return; }
  toast('Überall abgemeldet.', { type: 'ok' });
  renderUsers();
}

async function deleteUser(u) {
  const input = h('input', { className: 'input', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Benutzername zur Bestätigung' });
  const err = h('div', { className: 'error-text', role: 'alert' });
  const r = await dialog({
    title: 'Benutzer löschen?',
    body: h('div', {},
      h('p', { text: `Das Konto „${displayName(u)}“ wird mit allen Notizen und Freigaben endgültig gelöscht. Das lässt sich nicht rückgängig machen.` }),
      field('Zum Bestätigen den Benutzernamen eingeben', input, 'Benutzername: ' + u.username),
      err),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Endgültig löschen', value: 'ok', danger: true }],
    onAction: async () => {
      const typed = input.value.trim();
      if (typed !== u.username) { err.textContent = 'Der Benutzername stimmt nicht überein.'; return false; }
      try {
        await api.post('admin_user_delete', { id: u.id, confirm_username: typed });
        return true;
      } catch (e) {
        err.textContent = msg(e);
        return false;
      }
    },
  });
  if (r !== 'ok') return;
  toast('Konto gelöscht.', { type: 'ok' });
  renderUsers();
}

/** Zeigt ein Einmal-Passwort genau einmal an (nicht schließbar per Hintergrund oder Escape). */
async function showOnce(title, username, password) {
  const pwEl = h('div', { className: 'temp-pw', text: password });
  await dialog({
    title,
    dismissible: false,
    body: h('div', {},
      h('p', { className: 'hint', text: 'Benutzername' }),
      h('p', { className: 'dlg-name', text: username }),
      h('p', { className: 'hint', text: 'Einmal-Passwort' }),
      pwEl,
      h('div', { className: 'once-actions' },
        h('button', { className: 'btn', type: 'button', text: 'Kopieren', onclick: () => copyText(pwEl, password) })),
      h('p', { className: 'hint', text: 'Wird nur jetzt angezeigt. Beim ersten Anmelden muss ein eigenes Passwort gesetzt werden.' })),
    actions: [{ label: 'Fertig', value: 'ok', primary: true }],
  });
}

async function copyText(el, text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Passwort kopiert.', { type: 'ok' });
      return;
    } catch {
      /* Fallback unten */
    }
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  toast('Passwort markiert. Bitte manuell kopieren.');
}

// ───────────────────────── Notizen ansehen (nur lesen) ─────────────────────────

function showNotes(u) {
  leave();
  const treeEl = h('nav', { className: 'tree-pane', 'aria-label': 'Ordner und Notizen' }, h('p', { className: 'muted', text: 'Lade …' }));
  const viewer = h('section', { className: 'viewer', 'aria-live': 'polite' }, h('p', { className: 'viewer-empty muted', text: 'Links eine Notiz auswählen.' }));
  mainEl.replaceChildren(
    h('div', { className: 'toolbar' },
      h('button', { className: 'btn', type: 'button', text: '← Zurück', onclick: () => setTab('users') }),
      h('h2', { text: `Notizen von ${displayName(u)} (nur lesen)` })),
    h('p', { className: 'notice', text: 'Dieser Zugriff wird protokolliert.' }),
    h('div', { className: 'notes-layout' }, treeEl, viewer));

  let surface = null;
  let seq = 0;
  let current = null;

  const stop = () => {
    seq++;
    if (surface) { surface.destroy(); surface = null; }
  };
  leaveView = stop;

  const openNote = async (note) => {
    const my = ++seq;
    if (surface) { surface.destroy(); surface = null; }
    const host = h('div', { className: 'viewer-host' });
    viewer.replaceChildren(h('h3', { className: 'viewer-title', text: note.title || 'Ohne Titel' }), host);
    host.append(h('p', { className: 'viewer-empty muted', text: 'Lade Seiten …' }));
    try {
      const res = await api.get('admin_pages', { user: u.id, note: note.id });
      if (my !== seq) return;
      host.replaceChildren();
      if (!res.pages.length) {
        host.append(h('p', { className: 'viewer-empty muted', text: 'Diese Notiz hat keine Seiten.' }));
        return;
      }
      surface = createSurface(host, { readOnly: true });
      surface.setPages(res.pages);
    } catch (e) {
      if (my === seq) host.replaceChildren(h('p', { className: 'viewer-empty error-text', text: msg(e) }));
    }
  };

  const pick = (note, btn) => {
    if (current) current.removeAttribute('aria-current');
    current = btn;
    btn.setAttribute('aria-current', 'true');
    openNote(note);
  };

  (async () => {
    try {
      const data = await api.get('admin_tree', { user: u.id });
      if (leaveView !== stop) return; // Ansicht inzwischen verlassen
      treeEl.replaceChildren(buildTree(data, pick));
    } catch (e) {
      if (leaveView === stop) treeEl.replaceChildren(h('p', { className: 'notice', text: msg(e) }));
    }
  })();
}

/**
 * Ordnerbaum: oberste Ebene zuerst lose Notizen, dann Ordner (alphabetisch).
 * In einem Ordner: Unterordner, dann Notizen (neueste zuerst). Ordner sind aufklappbar.
 */
function buildTree(data, pick) {
  const folderIds = new Set(data.folders.map((f) => f.id));
  const keyOf = (id) => (folderIds.has(id) ? id : '');
  const folders = new Map();
  const notes = new Map();
  const add = (map, k, v) => {
    let list = map.get(k);
    if (!list) { list = []; map.set(k, list); }
    list.push(v);
  };
  for (const f of data.folders) add(folders, keyOf(f.parent_id), f);
  for (const n of data.notes) add(notes, keyOf(n.folder_id), n);
  for (const list of folders.values()) list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  for (const list of notes.values()) list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  const noteItem = (n) => h('li', {},
    h('button', { className: 'tree-item note', type: 'button', onclick: (e) => pick(n, e.currentTarget) },
      h('span', { className: 'note-title', text: n.title || 'Ohne Titel' }),
      h('small', { text: relTime(n.updated_at) })));

  const folderItem = (f) => {
    const subs = h('ul', { className: 'tree-sub' }, children(f.id));
    const toggle = h('button', {
      className: 'tree-item tree-folder', type: 'button', 'aria-expanded': 'true',
      onclick: () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        subs.hidden = !open;
        chev.textContent = open ? '▾' : '▸';
      },
    });
    const chev = h('span', { className: 'chev', 'aria-hidden': 'true', text: '▾' });
    toggle.append(chev, h('span', { className: 'folder-name', text: f.name || 'Ordner' }));
    return h('li', {}, toggle, subs);
  };

  const children = (k) => [
    ...(folders.get(k) || []).map(folderItem),
    ...(notes.get(k) || []).map(noteItem),
  ];

  const top = [
    ...(notes.get('') || []).map(noteItem),
    ...(folders.get('') || []).map(folderItem),
  ];
  if (!top.length) return h('p', { className: 'muted', text: 'Keine Ordner oder Notizen.' });
  return h('ul', { className: 'tree' }, top);
}

// ───────────────────────── Protokoll ─────────────────────────

function renderLog() {
  leave();
  const status = h('p', { className: 'muted', role: 'status', text: 'Lade …' });
  const list = h('ol', { className: 'log', 'aria-label': 'Protokoll' });
  const more = h('button', { className: 'btn', type: 'button', text: 'Ältere laden', hidden: true });
  const moreWrap = h('div', { className: 'more-wrap' }, more);
  let lastId = null;
  let busy = false;

  const load = async () => {
    if (busy) return;
    busy = true;
    more.disabled = true;
    try {
      const params = { limit: LOG_PAGE };
      if (lastId !== null) params.before = lastId;
      const res = await api.get('admin_log', params);
      for (const entry of res.entries) list.append(logRow(entry));
      if (res.entries.length) lastId = res.entries[res.entries.length - 1].id;
      more.hidden = res.entries.length < LOG_PAGE;
      status.textContent = list.children.length ? '' : 'Noch keine Einträge.';
    } catch (e) {
      status.textContent = msg(e);
    } finally {
      busy = false;
      more.disabled = false;
    }
  };
  more.onclick = load;

  mainEl.replaceChildren(
    h('div', { className: 'toolbar' },
      h('h2', { text: 'Protokoll' }),
      h('span', { className: 'spacer' }),
      h('button', { className: 'btn ghost', type: 'button', text: 'Aktualisieren', onclick: () => renderLog() })),
    status,
    list,
    moreWrap);
  load();
}

const DETAIL_FORMAT = {
  display_name: (v) => 'Anzeigename: ' + v,
  role: (v) => 'Rolle: ' + v,
  quota_mb: (v) => 'Speicher: ' + v + ' MB',
  note: (v) => 'Notiz: ' + v,
};

/** "username=x, role=user" → "Rolle: user" (der Benutzername steht schon als Ziel). */
function detailsText(d) {
  if (!d) return '';
  return d.split(', ')
    .filter((part) => !part.startsWith('username='))
    .map((part) => {
      const i = part.indexOf('=');
      const fmt = i > 0 ? DETAIL_FORMAT[part.slice(0, i)] : null;
      return fmt ? fmt(part.slice(i + 1)) : part;
    })
    .join(' · ');
}

function logRow(e) {
  const target = e.target_username || (e.target_user_id ? 'gelöschtes Konto' : '');
  const sub = [target ? 'Ziel: ' + target : '', detailsText(e.details)].filter(Boolean).join(' · ');
  return h('li', { className: 'log-row' },
    h('time', { className: 'log-time', dateTime: new Date(e.at).toISOString(), text: fullTime(e.at) }),
    h('div', { className: 'log-main' },
      h('p', { className: 'log-line' },
        h('strong', { text: e.admin_username || 'Admin' }),
        ' · ',
        ACTION_TEXT[e.action] || e.action),
      sub ? h('p', { className: 'log-sub', text: sub }) : null));
}

// ───────────────────────── Helfer ─────────────────────────

function field(label, control, hint = null) {
  return h('label', { className: 'field' },
    h('span', { text: label }),
    control,
    hint ? h('small', { className: 'hint', text: hint }) : null);
}

function cell(cls, label, ...children) {
  return h('div', { className: 'cell ' + cls, dataset: label ? { label } : {} }, ...children);
}

function badge(text, kind = '') {
  return h('span', { className: 'badge' + (kind ? ' ' + kind : ''), text });
}

function meter(pct) {
  return h('div', { className: 'meter' + (pct >= 90 ? ' high' : ''), role: 'img', 'aria-label': Math.round(pct) + ' % belegt' },
    h('i', { style: { width: pct.toFixed(1) + '%' } }));
}

function displayName(u) {
  return u.display_name || u.username;
}

function fullTime(ms) {
  return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function msg(e) {
  // Fehlt eine Route (noch nicht eingebaut), antwortet die API mit 404 „Unbekannte Aktion.“.
  if (e instanceof ApiError && e.status === 404 && e.message === 'Unbekannte Aktion.') return 'Noch nicht verfügbar.';
  return e && e.message ? e.message : 'Unbekannter Fehler.';
}

function showErr(e) {
  toast(msg(e), { type: 'error', ms: 4000 });
}
