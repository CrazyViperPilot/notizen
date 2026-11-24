// Import (ARCHITEKTUR 10.1): PDF mit zwei Seiten über Seitenmenü → „Foto oder PDF einfügen…“ (Dateiauswahl).
// Danach zwei neue Seiten mit Hintergrundbild. Nach dem Abgleich ist das Bild auf dem zweiten Gerät ladbar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE, chromium, newDevice, createUser, loginApi, until, rnd, gotoHash, waitApp, waitSync,
  localPages, currentNoteId, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

test('PDF mit zwei Seiten importieren, auf zweitem Gerät als Bild laden', { timeout: 300000 }, async () => {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'notizen-e2e-'));
  try {
    // Test-PDF: zwei Seiten, im Browser aus HTML erzeugt
    const pdfPath = join(dir, 'arbeitsblatt.pdf');
    const pdfPage = await browser.newPage();
    await pdfPage.setContent(`<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
      section { break-after: page; height: 260mm; font: 40px sans-serif; padding: 20mm; box-sizing: border-box; }
      section:last-child { break-after: auto; }
    </style></head><body>
      <section><h1>Seite eins</h1><p>Aufgabe 1: 7 × 8 =</p></section>
      <section><h1>Seite zwei</h1><p>Aufgabe 2: 9 × 6 =</p></section>
    </body></html>`);
    await pdfPage.pdf({ path: pdfPath, format: 'A4', printBackground: true });
    await pdfPage.close();

    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'import');

    const A = await newDevice(browser);
    const B = await newDevice(browser);
    await loginApi(A.page, user.username, user.password);
    await A.page.goto(BASE);
    await loginApi(B.page, user.username, user.password);
    await B.page.goto(BASE);
    await waitApp(A.page);
    await waitApp(B.page);

    // Notiz mit einer leeren Seite auf Gerät A
    const noteTitle = 'Arbeitsblatt ' + rnd();
    const noteId = await A.page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'blank' })).id;
    }, { modelUrl: MODEL_URL, title: noteTitle });
    await gotoHash(A.page, '#/n/' + noteId);
    await A.page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    assert.equal(await currentNoteId(A.page), noteId);

    // Seitenmenü → Foto oder PDF einfügen… → Dateiauswahl
    await A.page.locator('button[aria-label="Seitenmenü"]').click();
    const [chooser] = await Promise.all([
      A.page.waitForEvent('filechooser', { timeout: 20000 }),
      A.page.getByRole('menuitem', { name: /Foto oder PDF einfügen/ }).click(),
    ]);
    await chooser.setFiles(pdfPath);

    // Zwei neue Seiten hinter der bisherigen (insgesamt drei), beide mit Hintergrundbild
    await until(async () => {
      const pages = await localPages(A.page, noteId);
      return pages.length === 3 && pages.filter((p) => p.bg).length === 2;
    }, { timeout: 60000, what: 'zwei importierte Seiten mit Hintergrundbild' });

    // Abgleich: Bilder hochladen, dann Seiten; danach auf Gerät B
    await waitSync(A.page);
    await waitSync(B.page);
    const bgIds = (await localPages(B.page, noteId)).filter((p) => p.bg).map((p) => p.bg);
    assert.equal((await localPages(B.page, noteId)).length, 3, 'Gerät B hat drei Seiten');
    assert.equal(bgIds.length, 2, 'Gerät B hat zwei Seiten mit Bild');

    const size = await B.page.evaluate(async ({ modelUrl, noteId, id }) => {
      const m = await import(modelUrl);
      const img = await m.getImage(id, { noteId });
      return img ? { w: img.width, h: img.height } : null;
    }, { modelUrl: MODEL_URL, noteId, id: bgIds[0] });
    assert.ok(size && size.w > 0 && size.h > 0, 'Bild auf Gerät B ladbar');

    assertNoErrors(A.errors);
    assertNoErrors(B.errors);
    assertNoErrors(admin.errors);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await browser.close();
  }
});
