// Vokabeltrainer (ARCHITEKTUR 11.2): Vokabel-Notiz mit Wörtern und einem Häkchen, Abfragen → Zähler
// „gekonnt: 1 von 5“, abgedeckte Zeilen, „Nächste“ hebt eine Zeile hervor, Antippen deckt auf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, pen, segment, until, rnd, gotoHash, waitApp,
  strokesOf, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

// Vokabelseite (Hochformat): erste Zeile bei y 300, Zeilenhöhe 80; Wort-Spalte x 0–987, Übersetzung 987–1930,
// Abhak-Spalte ab x 1930. Zeilen-Mitte = 300 + 80·i + 40.
const rowCenter = (i) => 300 + 80 * i + 40;

test('Vokabel-Abfrage: Zähler, Abdeckung, Nächste, Antippen', { timeout: 240000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'vocab');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, user.username, user.password);
    await page.goto(BASE);
    await waitApp(page);

    const noteId = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'vocab' })).id;
    }, { modelUrl: MODEL_URL, title: 'Vokabeln ' + rnd() });
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });

    // Fünf Wörter in der Wort-Spalte (Zeilen 0–4)
    for (let i = 0; i < 5; i++) {
      await pen(page, segment(150, rowCenter(i), 450, rowCenter(i)));
    }
    // Ein Häkchen in der Abhak-Spalte von Zeile 1 (= gekonnt)
    await pen(page, segment(1950, rowCenter(1), 2030, rowCenter(1)));
    await until(async () => {
      const s = await strokesOf(page, noteId);
      return s.length === 6;
    }, { what: 'Wörter und Häkchen gespeichert' });

    // Abfragen einschalten
    await page.locator('.tb-quiz').click();
    await page.locator('.quiz-bar').waitFor({ state: 'visible' });
    const count = page.locator('.quiz-count');
    await until(async () => (await count.textContent()) === 'gekonnt: 1 von 5', { what: 'Zähler „gekonnt: 1 von 5“' });

    // Abdeckungen: eine pro belegter Zeile, die gekonnte ist grün (known) und bleibt offen
    const rows = page.locator('.nz-cover-row');
    await until(async () => (await rows.count()) === 5, { what: 'fünf Abdeckungen' });
    assert.equal(await page.locator('.nz-cover-row.known').count(), 1, 'eine gekonnte Zeile');
    assert.equal(await page.locator('.nz-cover-row:not(.known)').count(), 4, 'vier offene Zeilen');

    // „Nächste“ hebt eine offene Zeile hervor
    await page.getByRole('button', { name: 'Nächste', exact: true }).click();
    await until(async () => (await page.locator('.nz-cover-row.flash').count()) === 1, { what: 'hervorgehobene Zeile' });

    // Antippen deckt eine abgedeckte Zeile auf (Zeile 3: belegt, nicht gekonnt)
    await pen(page, [[1200, rowCenter(3)]]);
    await until(async () => (await page.locator('.nz-cover-row.open').count()) === 1, { what: 'aufgedeckte Zeile' });
    assert.equal(await page.locator('.nz-cover-row.known').count(), 1, 'Häkchen bleibt unverändert');

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
