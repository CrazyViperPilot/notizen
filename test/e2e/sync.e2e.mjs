// Sync zwischen zwei Geräten desselben Benutzers (ARCHITEKTUR 5): Gerät A schreibt offline, nach dem Online-Gehen
// sieht Gerät B den Strich. Gleichzeitige Änderung derselbe Seite auf beiden Geräten erzeugt eine Konfliktkopie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, pen, wave, until, rnd, gotoHash, waitApp,
  waitSync, localPages, strokesOf, inkVisible, MODEL_URL, assertNoErrors,
} from './helpers.mjs';

test('Offline schreiben, zweites Gerät sieht es; gleichzeitige Änderung erzeugt Konfliktkopie', { timeout: 300000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'sync');

    // Zwei Kontexte (eigene Cookies und IndexedDB) mit demselben Benutzer
    const A = await newDevice(browser);
    const B = await newDevice(browser);
    await loginApi(A.page, user.username, user.password);
    await A.page.goto(BASE);
    await loginApi(B.page, user.username, user.password);
    await B.page.goto(BASE);
    await waitApp(A.page);
    await waitApp(B.page);

    // Ordner und Notiz auf Gerät A anlegen, hochladen
    const folderName = 'Sync ' + rnd();
    const noteTitle = 'Protokoll ' + rnd();
    const ids = await A.page.evaluate(async ({ modelUrl, folderName, noteTitle }) => {
      const m = await import(modelUrl);
      const f = await m.createFolder({ name: folderName });
      const n = await m.createNote({ title: noteTitle, folderId: f.id, paper: 'lined' });
      return { folder: f.id, note: n.id };
    }, { modelUrl: MODEL_URL, folderName, noteTitle });
    await waitSync(A.page);

    // Gerät B holt den Stand (Ordner, Notiz, Seiten mit Strichen)
    await waitSync(B.page);
    await until(() => B.page.evaluate(async ({ modelUrl, id }) => {
      const m = await import(modelUrl);
      return !!(await m.getNote(id));
    }, { modelUrl: MODEL_URL, id: ids.note }), { what: 'Notiz auf Gerät B' });

    // Phase 1: Gerät A offline schreibt, danach online
    // Editor vorher online öffnen: die Ansichts-Module werden beim ersten Öffnen geladen
    // (ohne Service Worker auf http nicht offline nachladbar).
    await gotoHash(A.page, '#/n/' + ids.note);
    await A.page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    await A.context.setOffline(true);
    await pen(A.page, wave(300, 1500, 500));
    await until(async () => (await strokesOf(A.page, ids.note)).length === 1, { what: 'Offline-Strich lokal gespeichert' });
    const sentId = (await strokesOf(A.page, ids.note))[0].id;

    await A.context.setOffline(false);
    await waitSync(A.page);

    await gotoHash(B.page, '#/n/' + ids.note);
    await B.page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    await waitSync(B.page);
    await until(async () => {
      const s = await strokesOf(B.page, ids.note);
      return s.length === 1 && s[0].id === sentId;
    }, { what: 'Gerät B sieht den Strich von Gerät A' });
    await until(async () => (await inkVisible(B.page)) > 0, { what: 'Strich auf Gerät B sichtbar' });

    // Phase 2: gleichzeitige Änderung derselben Seite
    await A.context.setOffline(true);
    await pen(A.page, wave(300, 1500, 1200));
    await until(async () => (await strokesOf(A.page, ids.note)).length === 2, { what: 'Offline-Änderung auf A' });

    await pen(B.page, wave(300, 1500, 1600));
    await until(async () => (await strokesOf(B.page, ids.note)).length === 2, { what: 'Änderung auf B' });
    await waitSync(B.page);

    await A.context.setOffline(false);
    await waitSync(A.page);
    await waitSync(B.page);

    // Auf beiden Geräten: die Seite und eine Konfliktkopie daneben
    for (const dev of [A, B]) {
      await until(async () => {
        const pages = await localPages(dev.page, ids.note);
        return pages.length === 2 && pages.some((p) => p.conflict === 1 && p.strokes && p.strokes.length >= 1);
      }, { what: 'Konfliktkopie mit Strichen auf einem Gerät' });
    }
    for (const dev of [A, B]) {
      const pages = await localPages(dev.page, ids.note);
      const copy = pages.find((p) => p.conflict === 1);
      assert.ok(copy.strokes && copy.strokes.length >= 1, 'Konfliktkopie enthält Striche');
    }

    assertNoErrors(A.errors);
    assertNoErrors(B.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
