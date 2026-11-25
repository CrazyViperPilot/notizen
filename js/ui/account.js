// Konto-Ansicht (#/account): Profil, Speicher, Synchronisation, Passwort, Sitzungen, Einstellungen.
// PRD 4, docs/ARCHITEKTUR.md 4. Mount-Signatur wie in js/app.js beschrieben.

import { api, ApiError } from '../api.js';
import { h, toast, confirmDialog, formatBytes, relTime } from './dom.js';
import { createStatusBadge } from './status.js';

const PREFS_KEY = 'notizen:prefs';
const MIN_PW = 10;
const MSG_OFFLINE = 'Keine Verbindung. Das geht nur online.';

export async function mountAccount(el, params, ctx) {
  const user = ctx.user || {};
  let alive = true;

  // ── Profil ──
  const nameEl = h('span', { className: 'acc-val', text: user.display_name || '' });
  const userEl = h('span', { className: 'acc-val', text: user.username || '' });
  const roleEl = h('span', { className: 'acc-val', text: roleLabel(user.role) });

  // ── Speicher ──
  const fill = h('div', { className: 'acc-bar-fill' });
  const bar = h('div', { className: 'acc-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const storageText = h('p', { className: 'muted acc-hint', text: 'Wird geladen …' });
  const adminNote = h('p', { className: 'acc-note', text: 'Admins können deine Notizen einsehen.', hidden: true });

  // ── Synchronisation ──
  const badge = createStatusBadge(ctx.model);
  const syncLine = h('p', { className: 'muted acc-hint' });
  const updateSyncLine = (s) => {
    const st = s || ctx.model.syncStatus();
    syncLine.textContent = st.lastSync ? 'Zuletzt abgeglichen: ' + relTime(st.lastSync) : 'Noch nicht abgeglichen.';
  };
  const onSync = (s) => updateSyncLine(s);
  ctx.model.on('sync', onSync);
  updateSyncLine();

  // ── Datensicherung (ARCHITEKTUR 11.5): Datei erstellen bzw. einspielen ──
  let backupBusy = false;
  let restoreBusy = false;
  // Die Datei-Auswahl wird im Klick geöffnet (iPad): kein await davor.
  const restoreInput = h('input', {
    type: 'file',
    hidden: true,
    accept: '.notizen,.json,.gz,application/json,application/gzip',
    onchange: (e) => run(restoreFromFile(e.target)),
  });
  const backupBtn = h('button', { className: 'btn primary', type: 'button', text: 'Backup herunterladen', onclick: () => run(downloadBackup()) });
  const restoreBtn = h('button', { className: 'btn', type: 'button', text: 'Backup einspielen…', onclick: () => restoreInput.click() });

  // ── Passwort ändern ──
  const oldIn = makeInput('current-password', 'Passwort');
  const newIn = makeInput('new-password', 'Neues Passwort');
  const repIn = makeInput('new-password', 'Neues Passwort wiederholen');
  const pwErr = h('div', { className: 'error-text', role: 'alert' });
  const pwBtn = h('button', { className: 'btn primary', type: 'submit', text: 'Passwort ändern' });
  let pwBusy = false;
  const pwForm = h('form', { className: 'acc-form', noValidate: true, onsubmit: changePassword },
    field('Bisheriges Passwort', oldIn),
    field('Neues Passwort', newIn),
    field('Neues Passwort wiederholen', repIn),
    pwErr,
    pwBtn);

  // ── Sitzung ──
  const logoutAllBtn = h('button', { className: 'btn', type: 'button', text: 'Auf allen Geräten abmelden', onclick: () => run(logoutAll()) });
  const logoutBtn = h('button', { className: 'btn', type: 'button', text: 'Abmelden', onclick: () => run(ctx.logout()) });

  // ── Einstellungen ──
  const prefs = readPrefs();
  const drawInput = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: prefs.fingerDraw === true,
    onchange: (e) => {
      const p = readPrefs();
      p.fingerDraw = e.target.checked;
      writePrefs(p);
    },
  });

  const smoothLevels = [['direct', 'Direkt'], ['normal', 'Normal'], ['strong', 'Stark']];
  const smoothNow = ['direct', 'normal', 'strong'].includes(prefs.smoothing) ? prefs.smoothing : 'normal';
  const smoothBtns = smoothLevels.map(([lvl, label]) => h('button', {
    type: 'button', className: 'btn' + (lvl === smoothNow ? ' on' : ''), text: label, 'aria-pressed': lvl === smoothNow ? 'true' : 'false',
    onclick: () => {
      const p = readPrefs();
      p.smoothing = lvl;
      writePrefs(p);
      smoothBtns.forEach((b, i) => { const on = smoothLevels[i][0] === lvl; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    },
  }));

  // Lineal-Länge (15, 20 oder 30 cm), gilt beim nächsten Öffnen einer Notiz
  const rulerLens = [[150, '15 cm'], [200, '20 cm'], [300, '30 cm']];
  const rulerNow = [150, 200, 300].includes(prefs.rulerMm) ? prefs.rulerMm : 300;
  const rulerBtns = rulerLens.map(([mm, label]) => h('button', {
    type: 'button', className: 'btn' + (mm === rulerNow ? ' on' : ''), text: label, 'aria-pressed': mm === rulerNow ? 'true' : 'false',
    onclick: () => {
      const p = readPrefs();
      p.rulerMm = mm;
      writePrefs(p);
      rulerBtns.forEach((b, i) => { const on = rulerLens[i][0] === mm; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    },
  }));

  const root = h('div', { className: 'acc' },
    h('header', { className: 'acc-head' },
      h('button', { className: 'btn ghost acc-back', type: 'button', text: '‹ Übersicht', onclick: () => ctx.navigate('#/') }),
      h('h1', { className: 'acc-title', text: 'Konto' })),
    h('main', { className: 'acc-main' },
      section(null,
        row('Anzeigename', nameEl),
        row('Benutzername', userEl),
        row('Rolle', roleEl)),
      section('Speicher',
        bar,
        storageText,
        adminNote),
      section('Synchronisation',
        row('Status', badge.el),
        syncLine),
      section('Datensicherung',
        h('p', { className: 'muted acc-hint', text: 'Eine Sicherung ist eine Datei mit allen deinen Notizen, Seiten und Bildern. Sie wird auf diesem Gerät erstellt bzw. eingespielt.' }),
        h('div', { className: 'acc-actions acc-backup' }, backupBtn, restoreBtn),
        h('p', { className: 'muted acc-hint', text: 'Beim Einspielen landen die Notizen als Kopie in einem neuen Ordner „Import …“. Vorhandene Notizen bleiben unverändert.' }),
        restoreInput),
      section('Passwort ändern', pwForm),
      section('Sitzung',
        h('div', { className: 'acc-actions' }, logoutAllBtn, logoutBtn),
        h('p', { className: 'muted acc-hint', text: 'Abmelden lässt die Notizen auf diesem Gerät liegen. Ob sie gelöscht werden, wird vorher gefragt.' })),
      section('Einstellungen',
        h('label', { className: 'acc-switch' },
          h('span', { text: 'Mit Finger zeichnen' }),
          drawInput),
        h('p', { className: 'muted acc-hint', text: 'Für Geräte ohne Apple Pencil. Dann scrollst du mit zwei Fingern.' }),
        h('div', { className: 'acc-row' }, h('span', { text: 'Glättung der Schrift' }), h('div', { className: 'acc-seg', role: 'group', 'aria-label': 'Glättung' }, smoothBtns)),
        h('div', { className: 'acc-row' }, h('span', { text: 'Länge des Lineals' }), h('div', { className: 'acc-seg', role: 'group', 'aria-label': 'Länge des Lineals' }, rulerBtns)),
        h('p', { className: 'muted acc-hint', text: '„Direkt“ folgt dem Stift ganz genau, „Stark“ macht zittrige Linien ruhiger. Gilt beim nächsten Öffnen einer Notiz.' }),
        h('p', { className: 'muted acc-hint', text: 'Gesten: mit zwei Fingern tippen = Rückgängig, mit drei Fingern = Wiederholen, lange mit dem Finger auf einen Strich drücken = dessen Farbe übernehmen, schnell mit zwei Fingern zusammenziehen = ganze Seite. Bleistift: Apple Pencil schräg halten = breiter, weicher Strich zum Schraffieren.' })),
      user.role === 'admin'
        ? h('a', { className: 'btn acc-admin', href: 'admin.html', text: 'Admin-Bereich öffnen' })
        : null));

  el.append(root);

  // ── Daten vom Server (Speicher). Offline: Hinweis statt Fehler. ──
  api.get('account').then((r) => {
    if (!alive) return;
    if (r.user) {
      nameEl.textContent = r.user.display_name || '';
      userEl.textContent = r.user.username || '';
      roleEl.textContent = roleLabel(r.user.role);
    }
    const used = r.used_bytes || 0;
    const quota = r.quota_bytes || 0;
    const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
    fill.style.width = pct.toFixed(1) + '%';
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    storageText.textContent = `${formatBytes(used)} von ${formatBytes(quota)} belegt`;
    adminNote.hidden = !r.admins_can_read;
  }).catch((err) => {
    if (!alive) return;
    if (isNetwork(err)) {
      storageText.textContent = 'Offline. Der Speicherverbrauch wird angezeigt, sobald du online bist.';
    } else {
      storageText.textContent = 'Speicher konnte nicht geladen werden: ' + errText(err);
    }
  });

  return () => {
    alive = false;
    ctx.model.off('sync', onSync);
    badge.destroy();
  };

  // ── Aktionen ──
  async function changePassword(e) {
    e.preventDefault();
    if (pwBusy) return;
    const oldPw = oldIn.value;
    const newPw = newIn.value;
    const rep = repIn.value;
    pwErr.textContent = '';
    if (!oldPw) { pwErr.textContent = 'Bitte dein bisheriges Passwort eingeben.'; oldIn.focus(); return; }
    if (Array.from(newPw).length < MIN_PW) { pwErr.textContent = `Das neue Passwort muss mindestens ${MIN_PW} Zeichen lang sein.`; newIn.focus(); return; }
    if (newPw !== rep) { pwErr.textContent = 'Die Wiederholung stimmt nicht überein.'; repIn.focus(); return; }
    pwBusy = true;
    pwBtn.disabled = true;
    try {
      const res = await api.post('password', { old: oldPw, new: newPw });
      api.setCsrf(res.csrf);
      if (!alive) return;
      oldIn.value = '';
      newIn.value = '';
      repIn.value = '';
      toast('Passwort geändert. Andere Geräte sind abgemeldet.', { type: 'ok', ms: 3500 });
    } catch (err) {
      if (alive) pwErr.textContent = errText(err);
    } finally {
      pwBusy = false;
      pwBtn.disabled = false;
    }
  }

  async function downloadBackup() {
    if (backupBusy) return;
    backupBusy = true;
    backupBtn.disabled = true;
    backupBtn.textContent = 'Sicherung wird erstellt …';
    try {
      const { exportAllWithInfo } = await import('../export/backup.js');
      const { saveFile } = await import('../export/save.js');
      const { blob, skipped } = await exportAllWithInfo(ctx.model);
      await saveFile(blob, `notizen-backup-${isoDay(new Date())}.notizen`);
      if (skipped > 0) toast(`${skipped} Seiten/Bilder waren noch nicht geladen und fehlen.`, { ms: 6000 });
    } catch (e) {
      console.error(e);
      toast(plainMessage(e, 'Die Sicherung ist fehlgeschlagen.'), { type: 'error', ms: 5000 });
    } finally {
      backupBusy = false;
      backupBtn.disabled = false;
      backupBtn.textContent = 'Backup herunterladen';
    }
  }

  async function restoreFromFile(input) {
    // Datei sofort übernehmen (Auswahl wird zurückgesetzt, damit dieselbe Datei erneut gewählt werden kann).
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || restoreBusy) return;
    restoreBusy = true;
    restoreBtn.disabled = true;
    restoreBtn.textContent = 'Wird eingespielt …';
    const day = dayText(new Date());
    try {
      const { importBackup } = await import('../export/backup.js');
      const r = await importBackup(ctx.model, file);
      const parts = [count(r.folders, 'Ordner', 'Ordner'), count(r.notes, 'Notiz', 'Notizen'), count(r.pages, 'Seite', 'Seiten')];
      if (r.assets > 0) parts.push(count(r.assets, 'Bild', 'Bilder'));
      toast(`${parts.join(', ')} eingespielt – im Ordner „Import ${day}“`, { type: 'ok', ms: 6000 });
    } catch (e) {
      toast(plainMessage(e, 'Das Backup konnte nicht eingespielt werden.'), { type: 'error', ms: 6000 });
    } finally {
      restoreBusy = false;
      restoreBtn.disabled = false;
      restoreBtn.textContent = 'Backup einspielen…';
    }
  }

  async function logoutAll() {
    const pending = await ctx.model.pendingCount().catch(() => 0);
    const ok = await confirmDialog({
      title: 'Auf allen Geräten abmelden',
      message: (pending > 0 ? `Achtung: ${pending} Änderung(en) sind noch nicht auf dem Server. ` : '')
        + 'Alle Sitzungen werden beendet, auch auf diesem Gerät. Die Notizen bleiben auf diesem Gerät erhalten.',
      okLabel: 'Überall abmelden',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post('logout_all');
    } catch (err) {
      toast(isNetwork(err) ? MSG_OFFLINE : errText(err), { type: 'error', ms: 4000 });
      return;
    }
    location.reload();
  }
}

// ───────────── Helfer ─────────────

function section(title, ...children) {
  return h('section', { className: 'acc-card' }, title ? h('h2', { text: title }) : null, ...children);
}

function row(label, value) {
  return h('div', { className: 'acc-row' }, h('span', { className: 'muted', text: label }), value);
}

function field(label, input) {
  return h('label', { className: 'field' }, h('span', { text: label }), input);
}

function makeInput(autocomplete, label) {
  const input = h('input', { className: 'input', type: 'password', 'aria-label': label });
  input.setAttribute('autocomplete', autocomplete);
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  return input;
}

function roleLabel(role) {
  return role === 'admin' ? 'Admin' : 'Benutzer';
}

/** Dateiname-Datum JJJJ-MM-TT (Ortszeit). */
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Anzeige-Datum wie der Importordner „Import <Datum>“ in js/export/backup.js. */
function dayText(d) {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Fehlertext für Toasts: die Meldung der Ausnahme, sonst ein Standardtext. */
function plainMessage(e, fallback) {
  return e && typeof e.message === 'string' && e.message ? e.message : fallback;
}

function isNetwork(err) {
  return err instanceof ApiError && (err.status === 0 || err.code === 'network');
}

function errText(err) {
  if (isNetwork(err)) return MSG_OFFLINE;
  if (err instanceof ApiError) return err.message || 'Das hat nicht geklappt.';
  console.error(err);
  return 'Unbekannter Fehler.';
}

function run(p) {
  Promise.resolve(p).catch((err) => {
    console.error(err);
    toast('Das hat nicht geklappt.', { type: 'error', ms: 4000 });
  });
}

function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function writePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}
