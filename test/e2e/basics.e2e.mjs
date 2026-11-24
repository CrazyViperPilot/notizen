// Grundablauf (PRD 4–6): Anmeldung über die Oberfläche, Ordner und Notiz, Pencil-Strich, Neuladen,
// Papierkorb und Wiederherstellen. Jeder Test nutzt eigene Namen und einen eigenen Browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromium, newDevice, createUser, uiLogin, pen, wave, until, rnd, inkVisible, strokesOf,
  currentNoteId, dialogText, gotoHash, assertNoErrors,
} from './helpers.mjs';

test('Anmelden, Ordner und Notiz anlegen, Strich, Neuladen, Papierkorb', { timeout: 240000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'basics');

    const dev = await newDevice(browser);
    const { page } = dev;
    await uiLogin(page, user.username, user.password);

    // Ordner anlegen und öffnen
    const folder = 'Schule ' + rnd();
    await page.getByRole('button', { name: '+ Ordner', exact: true }).click();
    await dialogText(page, folder, 'Anlegen');
    await page.locator(`.tile.folder[aria-label="Ordner ${folder}"]`).click();
    await page.waitForURL(/#\/f\//);

    // Notiz anlegen (Titel, Papier aus dem Dialog)
    const title = 'Mathe ' + rnd();
    await page.getByRole('button', { name: '+ Notiz', exact: true }).click();
    await dialogText(page, title, 'Anlegen');
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    const noteId = await currentNoteId(page);
    assert.match(noteId, /^[0-9a-f-]{36}$/);

    // Pencil-Strich auf der ersten Seite, Speichern abwarten
    await pen(page, wave(300, 1800, 700));
    await until(async () => (await strokesOf(page, noteId)).length === 1, { what: 'Strich gespeichert' });
    await until(async () => (await inkVisible(page)) > 0, { what: 'Strich sichtbar' });

    // Neuladen: Strich ist noch da (lokal gespeichert, auf der Seite gezeichnet)
    await page.reload();
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    assert.equal((await strokesOf(page, noteId)).length, 1, 'Strich nach dem Neuladen im Speicher');
    await until(async () => (await inkVisible(page)) > 0, { what: 'Strich nach dem Neuladen sichtbar' });

    // Papierkorb: Notiz in den Papierkorb, dann wiederherstellen
    await page.locator('button[aria-label="Zurück zur Übersicht"]').click();
    const tile = page.locator(`.tile.note[aria-label="Notiz ${title}"]`);
    await tile.waitFor();
    await tile.locator('button.more').click();
    await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
    await tile.waitFor({ state: 'detached' });

    await page.locator('.side-item', { hasText: 'Papierkorb' }).click();
    const row = page.locator('.trash-row', { hasText: title });
    await row.waitFor();
    await row.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
    await row.waitFor({ state: 'detached' });

    await gotoHash(page, '#/');
    await page.locator(`.tile.folder[aria-label="Ordner ${folder}"]`).click();
    await page.locator(`.tile.note[aria-label="Notiz ${title}"]`).waitFor();

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
