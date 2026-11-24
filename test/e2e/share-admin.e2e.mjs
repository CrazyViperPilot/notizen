// Teilen und Admin (PRD 8, ARCHITEKTUR 4, 11.5): Empfänger sieht die geteilte Notiz nur lesend unter „Mit mir
// geteilt“. Admin: Benutzerliste, Notizen eines Benutzers ansehen (Protokoll „Notiz geöffnet“), Gesamtsicherung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import {
  BASE, url, chromium, newDevice, createUser, loginApi, pen, segment, until, rnd, gotoHash, waitApp,
  waitSync, inkVisible, strokesOf, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

test('Notiz teilen (nur lesen), Admin-Ansicht, Gesamtsicherung', { timeout: 300000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const owner = await createUser(admin.page, 'owner');
    const reader = await createUser(admin.page, 'reader');

    // Besitzer: Notiz mit einem Strich, hochladen
    const O = await newDevice(browser);
    await loginApi(O.page, owner.username, owner.password);
    await O.page.goto(BASE);
    await waitApp(O.page);
    const noteTitle = 'Geteilt ' + rnd();
    const noteId = await O.page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'lined' })).id;
    }, { modelUrl: MODEL_URL, title: noteTitle });
    await gotoHash(O.page, '#/n/' + noteId);
    await O.page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    await pen(O.page, segment(300, 600, 1500, 600));
    await until(async () => (await strokesOf(O.page, noteId)).length === 1, { what: 'Strich auf dem Besitzer-Gerät' });
    await waitSync(O.page);

    // Teilen über die Bibliothek: Kachelmenü → Teilen… → Empfänger ankreuzen → Speichern
    await gotoHash(O.page, '#/');
    // Im Raster (die Reihe „Zuletzt geöffnet“ zeigt dieselbe Notiz ebenfalls)
    const tile = O.page.locator(`.grid .tile.note[aria-label="Notiz ${noteTitle}"]`);
    await tile.waitFor();
    await tile.locator('button.more').click();
    await O.page.getByRole('menuitem', { name: 'Teilen…' }).click();
    const dlg = O.page.locator('.nz-dialog');
    await dlg.locator('.share-row', { hasText: reader.username }).click();
    await dlg.getByRole('button', { name: 'Speichern', exact: true }).click();
    await O.page.locator('.nz-backdrop').waitFor({ state: 'detached', timeout: 30000 });

    // Empfänger: „Mit mir geteilt“, Notiz nur lesend
    const R = await newDevice(browser);
    await loginApi(R.page, reader.username, reader.password);
    await R.page.goto(url('#/shared'));
    const link = R.page.locator('a.shared-note', { hasText: noteTitle });
    await link.waitFor({ timeout: 30000 });
    await link.click();
    await R.page.locator('.shared-badge', { hasText: 'Nur lesen' }).waitFor();
    await until(async () => (await R.page.locator('.shared-count').textContent()) === '1 / 1', { what: 'Seite der geteilten Notiz' });
    await until(async () => (await inkVisible(R.page)) > 0, { what: 'Strich der geteilten Notiz sichtbar' });
    assert.equal(await R.page.locator('.tb').count(), 0, 'Keine Werkzeugleiste in der Leseansicht');

    // Admin-Bereich: Benutzerliste, Notizen des Besitzers ansehen
    await admin.page.goto(url('admin.html'));
    const row = admin.page.locator('li.user-row', { has: admin.page.locator('.uname', { hasText: owner.username }) });
    await row.waitFor({ timeout: 30000 });
    await row.locator('button[aria-label^="Aktionen für"]').click();
    await admin.page.getByRole('menuitem', { name: 'Notizen ansehen', exact: true }).click();
    await admin.page.locator('.tree-item.note', { hasText: noteTitle }).click();
    await admin.page.locator('.viewer-title', { hasText: noteTitle }).waitFor({ timeout: 30000 });

    // Protokoll enthält „Notiz geöffnet“
    await admin.page.getByRole('tab', { name: 'Protokoll', exact: true }).click();
    await until(async () => (await admin.page.locator('ol.log').textContent()).includes('Notiz geöffnet'), {
      timeout: 30000, what: 'Protokolleintrag view_note',
    });

    // Gesamtsicherung: Datei mit users[] (gzip oder JSON)
    await admin.page.getByRole('tab', { name: 'Benutzer', exact: true }).click();
    const [download] = await Promise.all([
      admin.page.waitForEvent('download', { timeout: 60000 }),
      admin.page.getByRole('button', { name: 'Gesamtsicherung herunterladen', exact: true }).click(),
    ]);
    const name = download.suggestedFilename();
    assert.match(name, /^notizen-sicherung-.*\.json(\.gz)?$/);
    const tmp = await download.path();
    const raw = await readFile(tmp);
    const text = name.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const doc = JSON.parse(text);
    assert.equal(doc.format, 'notizen-admin-backup');
    assert.ok(Array.isArray(doc.users), 'users ist eine Liste');
    assert.ok(doc.users.some((u) => u.user && u.user.username === owner.username), 'Besitzer in der Sicherung');

    assertNoErrors(O.errors);
    assertNoErrors(R.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
