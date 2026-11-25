// Seitenformate, Lineal und PDF-Export mit Titelblatt/PDF-A: A5-Notiz anlegen, Lineal einblenden, verschieben,
// mit dem Stift an der Kante entlang zeichnen (gerade Linie), Format über das Seitenmenü auf A3 stellen,
// als PDF mit Titelblatt (Vorlage „Schulheft“) und PDF/A exportieren und die Datei prüfen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, until, rnd, gotoHash, waitApp, strokesOf, localPages,
  assertNoErrors, MODEL_URL,
} from './helpers.mjs';

/** Rechteck eines Elements (CSS-px, Viewport). */
const rect = (page, sel) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

test('A5-Seite, Lineal mit Stiftführung, Format A3, PDF mit Titelblatt und PDF/A', { timeout: 300000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'ruler');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, user.username, user.password);
    await page.goto(BASE);
    await waitApp(page);
    await page.evaluate(() => { localStorage.removeItem('notizen:ruler'); localStorage.removeItem('notizen:export'); });

    const title = 'Lineal ' + rnd();
    const noteId = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'grid', size: 'a5' })).id;
    }, { modelUrl: MODEL_URL, title });
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    assert.equal((await localPages(page, noteId))[0].size, 'a5');

    // A5 hochkant: Seitenverhältnis √2, die einzige Seite füllt die Breite wie eine A4-Seite
    const pg = await rect(page, '.nz-page');
    assert.ok(Math.abs(pg.h / pg.w - 2100 / 1480) < 0.01, 'A5-Seitenverhältnis');

    // ── Lineal einblenden ──
    await page.getByRole('button', { name: 'Lineal', exact: true }).click();
    const rulerEl = page.locator('canvas.ruler');
    await rulerEl.waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Lineal', exact: true }).getAttribute('aria-pressed'), 'true');
    // 30 cm im Seitenmaßstab: Breite der A5-Seite (148 mm) mal 300/148
    const rulerW = await rulerEl.evaluate((el) => parseFloat(el.style.width));
    assert.ok(Math.abs(rulerW - (pg.w * 300) / 148) < 2, `Lineal 30 cm lang (${rulerW} px)`);

    // ── Mit dem Finger (Maus) verschieben: nach oben auf die Seite ──
    const surf = await rect(page, '.ed-surface');
    const st0 = await page.evaluate(() => JSON.parse(localStorage.getItem('notizen:ruler')));
    const sx = surf.x + st0.x - 100, sy = surf.y + st0.y;   // nicht auf dem Dreh-Griff (rechtes Ende)
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx, sy - 80, { steps: 5 });
    await page.mouse.up();
    const st1 = await page.evaluate(() => JSON.parse(localStorage.getItem('notizen:ruler')));
    assert.ok(Math.abs(st1.y - (st0.y - 80)) < 2 && Math.abs(st1.x - st0.x) < 2, 'Lineal verschoben');
    assert.equal(st1.angle, 0);
    assert.equal((await strokesOf(page, noteId)).length, 0, 'Verschieben zeichnet nicht');

    // ── Stift an der unteren Kante: schräge Bewegung wird zur waagerechten Linie ──
    const edgeY = surf.y + st1.y + 35 + 6;     // RULER_H/2 = 35, knapp unterhalb der Kante
    await page.evaluate(({ x0, y0 }) => {
      const el = document.querySelector('.nz-surface');
      const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 77, pointerType: 'pen', pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      fire('pointerdown', x0, y0);
      for (let i = 1; i <= 20; i++) fire('pointermove', x0 + i * 10, y0 + i * 1.5);   // zittrig schräg
      fire('pointerup', x0 + 200, y0 + 30);
    }, { x0: surf.x + st1.x - 150, y0: edgeY });
    await until(async () => (await strokesOf(page, noteId)).length === 1, { what: 'Linie am Lineal gespeichert' });
    const s = (await strokesOf(page, noteId))[0];
    const ys = [];
    for (let i = 1; i < s.pts.length; i += 3) ys.push(s.pts[i]);
    assert.ok(Math.max(...ys) - Math.min(...ys) <= 2, `Linie folgt der Kante (y ${Math.min(...ys)}…${Math.max(...ys)})`);
    assert.ok(s.pts[s.pts.length - 3] - s.pts[0] > 300, 'Linie hat Länge');

    // Ausblenden per Taste r
    await page.keyboard.press('r');
    await rulerEl.waitFor({ state: 'hidden' });

    // ── Format über das Seitenmenü: A3 ──
    await page.getByRole('button', { name: 'Seitenmenü', exact: true }).click();
    await page.getByText('Format: DIN A3', { exact: true }).click();
    await until(async () => (await localPages(page, noteId))[0].size === 'a3', { what: 'Format A3 gespeichert' });

    // ── PDF-Export mit Titelblatt (Schulheft) und PDF/A ──
    await page.getByRole('button', { name: 'Seitenmenü', exact: true }).click();
    await page.getByText('Als PDF exportieren', { exact: true }).click();
    const dlg = page.locator('.nz-dialog');
    await dlg.getByText('Titelblatt voranstellen', { exact: true }).click();
    await dlg.getByRole('radio', { name: 'Schulheft', exact: true }).click();
    await dlg.getByLabel('Fach', { exact: true }).fill('Mathematik');
    await dlg.getByLabel('Name', { exact: true }).fill('Kim Muster');
    await dlg.getByText('PDF/A (Archivformat)', { exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      dlg.getByRole('button', { name: 'Exportieren', exact: true }).click(),
    ]);
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    const pdf = Buffer.concat(chunks).toString('latin1');
    assert.ok(pdf.startsWith('%PDF-1.7'), 'PDF/A-Kopf');
    assert.match(pdf, /\/Count 2 /, 'Titelblatt + 1 Seite');
    assert.match(pdf, /\/OutputIntents/);
    assert.match(pdf, /<pdfaid:part>2<\/pdfaid:part>/);
    const boxes = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Math.round(m[1] / 72 * 25.4), Math.round(m[2] / 72 * 25.4)]);
    assert.deepEqual(boxes, [[297, 420], [297, 420]], 'Titelblatt und Seite in A3');
    assert.ok((pdf.match(/\/ColorSpace \/DeviceGray/g) || []).length >= 3, 'Texte des Titelblatts als Graustufenbilder');
    // Die Wahl wird gemerkt (ohne Titel und Datum)
    const last = await page.evaluate(() => JSON.parse(localStorage.getItem('notizen:export')));
    assert.equal(last.template, 'schule');
    assert.equal(last.pdfa, true);
    assert.equal(last.fields.subject, 'Mathematik');

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
