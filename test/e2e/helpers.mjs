// Gemeinsame Helfer für die E2E-Tests (docs/ARCHITEKTUR.md 9 und 11.6). Gegen einen laufenden Server
// (php -S + MariaDB) mit Playwright. Konfiguration über Umgebungsvariablen:
//   E2E_BASE        Basis-URL der App (Standard http://127.0.0.1:8080/)
//   E2E_ADMIN_USER  Admin-Benutzername (Standard admin)
//   E2E_ADMIN_PASS  Admin-Passwort (Standard admin-passwort-1)
//
// Playwright wird per require geladen: ESM-Importe finden eine globale Installation (NODE_PATH) nicht, CJS-
// require schon. In der CI liegt playwright im Projekt (npm i --no-save playwright), dort greift dasselbe.
//
// Die Tests ändern lokale Daten nur über js/model.js (im Browser per import). Pencil-Ereignisse sind
// synthetische PointerEvents mit pointerType 'pen', wie es js/ink/surface.js erwartet.

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const pw = require('playwright');
export const { chromium, devices, request } = pw;

const rawBase = process.env.E2E_BASE || 'http://127.0.0.1:8080/';
export const BASE = rawBase.endsWith('/') ? rawBase : rawBase + '/';
export const ADMIN_USER = process.env.E2E_ADMIN_USER || 'admin';
export const ADMIN_PASS = process.env.E2E_ADMIN_PASS || 'admin-passwort-1';

/** Absolute URLs der Browser-Module (unabhängig vom Pfad, unter dem die App liegt). */
export const MODEL_URL = new URL('js/model.js', BASE).href;
export const API_JS_URL = new URL('js/api.js', BASE).href;
export const CODEC_URL = new URL('js/ink/codec.js', BASE).href;
export const API_URL = new URL('api.php', BASE).href;

/** URL relativ zur Basis, z. B. url('admin.html') oder url('#/shared'). */
export function url(path) {
  return new URL(path, BASE).href;
}

/** Zufällige Zeichenfolge (Kleinbuchstaben und Ziffern) für eindeutige Namen. */
export function rnd(len = 6) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

/** Wiederholt fn, bis der Rückgabewert truthy ist. Nach timeout ms: Fehler mit der Bezeichnung. */
export async function until(fn, { timeout = 20000, every = 150, what = 'Bedingung' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) {
      const detail = last instanceof Error ? ` (${last.message})` : '';
      throw new Error(`Zeitüberschreitung: ${what}${detail}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

/**
 * Neues Gerät: Kontext wie ein iPad Pro 11 (Safari-Maße), eigener Speicher (Cookies, IndexedDB).
 * Sammelt Seitenfehler und Serverfehler (5xx) in `errors`.
 */
export async function newDevice(browser) {
  const context = await browser.newContext({ ...devices['iPad Pro 11'], deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return { context, page, errors };
}

/** Fehlerliste muss leer sein (wird am Ende jedes Tests aufgerufen). */
export function assertNoErrors(errors) {
  assert.deepEqual(errors, [], 'Seiten- oder Serverfehler in der App');
}

/**
 * Anmeldung per API auf labor.html (eigene Seite derselben Herkunft): setzt das Sitzungs-Cookie des Kontexts,
 * das CSRF-Token der Seite und notizen:lastUser. Danach startet die App mit goto(BASE) direkt angemeldet.
 */
export async function loginApi(page, username, password) {
  await page.goto(url('labor.html'));
  return page.evaluate(async ({ apiJs, username, password }) => {
    const { api } = await import(apiJs);
    const r = await api.post('login', { username, password });
    api.setCsrf(r.csrf);
    const u = r.user;
    localStorage.setItem('notizen:lastUser', JSON.stringify({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }));
    return u;
  }, { apiJs: API_JS_URL, username, password });
}

/** Anmeldung über die Oberfläche (Anmeldeformular der App) bis zur Bibliothek. */
export async function uiLogin(page, username, password) {
  await page.goto(BASE);
  await page.locator('.nz-login input[autocomplete="username"]').fill(username);
  await page.locator('.nz-login input[autocomplete="current-password"]').fill(password);
  await page.locator('.nz-login button[type="submit"]').click();
  await page.locator('.lib').waitFor({ timeout: 20000 });
}

/** Wechselt den Hash der App (Router der App reagiert auf hashchange, ohne Neuladen). */
export async function gotoHash(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
}

/** Id der aktuell geöffneten Notiz aus dem Hash (#/n/<id>). */
export async function currentNoteId(page) {
  return (await page.evaluate(() => location.hash)).split('/').pop();
}

/**
 * Stift-Strich(e) auf der ersten sichtbaren Seite. points in Seiteneinheiten (0,1 mm, Ursprung oben links),
 * hochkant 2100 breit, quer 2970. Ablauf: pointerdown am ersten Punkt, pointermove über alle weiteren
 * (der letzte als pointerup an derselben Stelle). hold: ms Stillstand vor dem Abheben (Formen-Erkennung, docs 11.4).
 */
export async function pen(page, points, { hold = 0 } = {}) {
  await page.evaluate(async ({ points, hold }) => {
    const surf = document.querySelector('.nz-surface');
    if (!surf) throw new Error('Keine Zeichenfläche');
    const sr = surf.getBoundingClientRect();
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('.nz-page')) {
      const r = el.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, sr.right) - Math.max(r.left, sr.left));
      const iy = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
      if (ix * iy > bestArea) { bestArea = ix * iy; best = r; }
    }
    if (!best) throw new Error('Keine sichtbare Seite');
    const unitW = best.width > best.height ? 2970 : 2100;
    const k = best.width / unitW;
    const id = 100 + Math.floor(Math.random() * 800);
    const fire = (type, [ux, uy]) => surf.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'pen', pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1,
      clientX: best.left + ux * k, clientY: best.top + uy * k, bubbles: true, cancelable: true,
    }));
    const n = points.length;
    fire('pointerdown', points[0]);
    for (let i = 1; i < n; i++) fire('pointermove', points[i]);
    // Stift bleibt stehen und hebt an derselben Stelle ab (sonst zählt das Abheben als Bewegung).
    if (hold) await new Promise((r) => setTimeout(r, hold));
    fire('pointerup', points[n - 1]);
  }, { points, hold });
}

/** Punkte entlang einer Geraden, Abstand etwa `step` Einheiten. */
export function segment(x0, y0, x1, y1, step = 20) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(len / step));
  const out = [];
  for (let i = 0; i <= n; i++) out.push([Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n)]);
  return out;
}

/** Leicht geschwungene Linie von x0 nach x1 auf Höhe y. */
export function wave(x0, x1, y, amp = 12) {
  const out = [];
  const n = Math.round((x1 - x0) / 20);
  for (let i = 0; i <= n; i++) out.push([x0 + i * 20, Math.round(y + Math.sin(i / 2) * amp)]);
  return out;
}

/** Geschlossene Ellipse (Mittelpunkt cx, cy; Radien rx, ry), n Punkte. Ende nahe dem Start. */
export function ellipse(cx, cy, rx, ry, n = 32) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry)]);
  }
  return out;
}

/**
 * Seiten einer Notiz aus dem lokalen Speicher (js/model.js). strokes: decodierte Striche oder null, solange die
 * Striche noch nicht vom Server geladen sind.
 */
export function localPages(page, noteId) {
  return page.evaluate(async ({ modelUrl, codecUrl, noteId }) => {
    const m = await import(modelUrl);
    const { decodeStrokes } = await import(codecUrl);
    const rows = await m.listPages(noteId);
    return rows.map((p) => ({
      id: p.id,
      paper: p.paper,
      orient: p.orient,
      size: p.size || null,
      bg: p.bg || null,
      conflict: p.conflict || 0,
      rev: p.rev,
      strokes: typeof p.strokes === 'string'
        ? decodeStrokes(p.strokes).map((s) => ({ id: s.id, type: s.type, color: s.color, width: s.width, pts: Array.from(s.pts) }))
        : null,
    }));
  }, { modelUrl: MODEL_URL, codecUrl: CODEC_URL, noteId });
}

/** Striche einer Seite (Standard: erste Seite); [] wenn die Seite noch nicht geladen ist. */
export async function strokesOf(page, noteId, index = 0) {
  const pages = await localPages(page, noteId);
  const p = pages[index];
  return p && p.strokes ? p.strokes : [];
}

/** Ob ein Strich auf dem Seiten-Canvas sichtbar ist (dunkle Pixel; Papierlinien sind hell). */
export function inkVisible(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.nz-page canvas');
    if (!c || !c.width || !c.height) return 0;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 250) n++;
    return n;
  });
}

/**
 * Wartet, bis alle lokalen Änderungen auf dem Server sind und der Abgleich ruht. Stößt den Abgleich an.
 * Wirft bei Fehlerzustand (offline, error, auth) oder nach timeout.
 */
export function waitSync(page, { timeout = 40000 } = {}) {
  return page.evaluate(async ({ modelUrl, timeout }) => {
    const m = await import(modelUrl);
    const end = Date.now() + timeout;
    let last = null;
    while (Date.now() < end) {
      await m.syncNow();
      const s = m.syncStatus();
      last = s;
      if (s.state === 'idle' && (await m.pendingCount()) === 0) return s;
      if (s.state === 'auth' || s.state === 'error') throw new Error('Abgleich: ' + s.state + ' ' + (s.error || ''));
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Abgleich nicht abgeschlossen: ' + JSON.stringify(last));
  }, { modelUrl: MODEL_URL, timeout });
}

/** Erzeugt einen Benutzer per Admin-API und setzt ein eigenes Passwort (Einmal-Passwort → eigenes). */
export async function createUser(adminPage, prefix = 'e2e') {
  const username = (prefix + rnd(7)).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  // Admin-Sitzung auf der Admin-Seite; die Admin-API läuft über api.js dieser Seite (CSRF gesetzt).
  await loginApi(adminPage, ADMIN_USER, ADMIN_PASS);
  const created = await adminPage.evaluate(async ({ apiJs, username }) => {
    const { api } = await import(apiJs);
    return api.post('admin_user_create', { username, display_name: username, role: 'user', quota_mb: 200 });
  }, { apiJs: API_JS_URL, username });
  const password = 'eigenes-pw-' + rnd(8);
  // Eigene Sitzung (eigenes Cookie-Glas), damit die Sitzung der Admin-Seite unberührt bleibt.
  const rq = await request.newContext({ baseURL: BASE });
  try {
    const login = await rq.post('api.php?r=login', { data: { username, password: created.temp_password } });
    assert.equal(login.status(), 200, 'Anmeldung mit Einmal-Passwort');
    const body = await login.json();
    const change = await rq.post('api.php?r=password', {
      data: { new: password },
      headers: { 'X-CSRF-Token': body.csrf },
    });
    assert.equal(change.status(), 200, 'Eigenes Passwort setzen');
  } finally {
    await rq.dispose();
  }
  return { username, password, id: created.user.id };
}

/** Wartet, bis die App gestartet und die Bibliothek oder der Editor da ist. */
export async function waitApp(page) {
  await page.locator('.lib, .editor').first().waitFor({ timeout: 20000 });
}

/** Tippt in den offenen Dialog (erstes Eingabefeld) und bestätigt mit dem Knopf `okLabel`. */
export async function dialogText(page, text, okLabel) {
  const dlg = page.locator('.nz-dialog');
  await dlg.locator('input').first().fill(text);
  await dlg.getByRole('button', { name: okLabel, exact: true }).click();
}
