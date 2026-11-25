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
    const count = page.locator('.quiz-count:not(.quiz-round)');
    await until(async () => (await count.textContent()) === 'gekonnt: 1 von 5 · Fächer 5·0·0·0·0', { what: 'Zähler „gekonnt: 1 von 5“ mit Fächern' });

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

    // Antwort „Gewusst“ (Lernkartei): Vokabel rückt in Fach 2, Häkchen erst in Fach 5; Runde zählt mit
    await page.getByRole('button', { name: '✓ Gewusst' }).click();
    await until(async () => (await count.textContent()) === 'gekonnt: 1 von 5 · Fächer 4·1·0·0·0', { what: 'Fach 2' });
    assert.equal(await page.locator('.nz-cover-row.known').count(), 1, 'noch kein neues Häkchen');
    assert.match(await page.locator('.quiz-round').textContent(), /1 ✓ · 0 ✗/);

    // Nächste offene Zeile aufdecken und „Nicht gewusst“: wieder zugedeckt, Zähler bleibt
    const open = async () => page.locator('.nz-cover-row:not(.known):not(.open)').count();
    await pen(page, [[1200, rowCenter(4)]]);
    await until(async () => (await page.locator('.nz-cover-row.open').count()) === 1, { what: 'Zeile 4 aufgedeckt' });
    await page.getByRole('button', { name: '✗ Nicht gewusst' }).click();
    await until(async () => (await page.locator('.nz-cover-row.open').count()) === 0, { what: 'wieder zugedeckt' });
    assert.equal(await count.textContent(), 'gekonnt: 1 von 5 · Fächer 4·1·0·0·0');
    assert.ok((await open()) >= 1);
    assert.match(await page.locator('.quiz-round').textContent(), /1 ✓ · 1 ✗/);

    // Der Lernstand ist in der Seite gespeichert (meta.learn, wird synchronisiert): Zeile 3 Fach 2, Zeile 4 Fach 1
    await until(async () => {
      const learn = await page.evaluate(async ({ modelUrl, noteId }) => {
        const m = await import(modelUrl);
        return m.pageMeta((await m.listPages(noteId))[0]).learn || null;
      }, { modelUrl: MODEL_URL, noteId });
      return learn && learn.rows && learn.rows[3] && learn.rows[3].b === 2 && learn.rows[4] && learn.rows[4].b === 1;
    }, { what: 'Lernstand gespeichert' });
    assert.equal((await strokesOf(page, noteId)).length, 6, 'kein zusätzlicher Haken');

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
