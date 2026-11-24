// Editor (ARCHITEKTUR 10.2–10.4, 11.4): Lasso mit Verschieben, Duplizieren, Farbe, Löschen und Rückgängig,
// Teil-Radierer, eigene Farbe, Formen-Halten (Kreis wird geschlossen), Seitenübersicht mit Duplizieren und
// „Nach hinten“. Alles mit synthetischen Pencil-Ereignissen auf der Zeichenfläche.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, pen, segment, ellipse, until, rnd, gotoHash, waitApp,
  strokesOf, localPages, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

/** Schließt ein Strich, d. h. erster und letzter Punkt liegen (fast) aufeinander. */
function isClosed(stroke) {
  const p = stroke.pts;
  const n = p.length;
  return Math.abs(p[0] - p[n - 3]) <= 2 && Math.abs(p[1] - p[n - 2]) <= 2;
}

test('Lasso, Teil-Radierer, eigene Farbe, Formen-Halten, Seitenübersicht', { timeout: 300000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'editor');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, user.username, user.password);
    await page.goto(BASE);
    await waitApp(page);

    const noteId = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'lined' })).id;
    }, { modelUrl: MODEL_URL, title: 'Editor ' + rnd() });
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });

    // Zwei Striche: oben (y 500) und unten (y 900)
    await pen(page, segment(300, 500, 880, 500));
    await pen(page, segment(300, 900, 900, 900));
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'zwei Striche gespeichert' });

    // ── Lasso: Striche oben auswählen, verschieben ──
    await page.getByRole('button', { name: 'Lasso (auswählen)', exact: true }).click();
    await pen(page, ellipse(600, 500, 420, 120, 32));
    await page.locator('.sel-bar').waitFor({ state: 'visible' });
    const before = (await strokesOf(page, noteId))[0].pts;
    await pen(page, [[600, 500], [600, 600], [600, 700]]);
    await until(async () => {
      const s = await strokesOf(page, noteId);
      return s[0] && Math.abs(s[0].pts[1] - (before[1] + 200)) <= 3;
    }, { what: 'Auswahl um 200 Einheiten nach unten verschoben' });
    assert.equal((await strokesOf(page, noteId)).length, 2, 'Verschieben ändert die Anzahl nicht');

    // Duplizieren, Farbe Rot (Index 2), Löschen, Rückgängig
    await page.getByRole('button', { name: 'Duplizieren', exact: true }).click();
    await until(async () => (await strokesOf(page, noteId)).length === 3, { what: 'Duplikat' });
    await page.getByRole('button', { name: 'Farbe', exact: true }).click();
    await page.getByRole('button', { name: 'Rot', exact: true }).click();
    await until(async () => (await strokesOf(page, noteId)).filter((s) => s.color === 2).length === 1, { what: 'Kopie rot' });
    await page.getByRole('button', { name: 'Löschen', exact: true }).click();
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'Auswahl gelöscht' });
    await page.locator('.tb-undo').click();
    await until(async () => (await strokesOf(page, noteId)).length === 3, { what: 'Rückgängig stellt die Kopie wieder her' });

    // ── Teil-Radierer: nur der Teil des unteren Strichs unter dem Radierer verschwindet ──
    await page.getByRole('button', { name: 'Radierer', exact: true }).click();
    await page.getByRole('button', { name: 'Teilweise', exact: true }).click();
    await pen(page, [[400, 850], [400, 900], [400, 950]]);
    await until(async () => (await strokesOf(page, noteId)).length === 4, { what: 'Strich geteilt' });

    // ── Eigene Farbe für den Stift (eigener Farbwähler-Dialog) ──
    await page.getByRole('button', { name: 'Stift', exact: true }).click();
    await page.locator('.tb-custom').click();
    await page.locator('.cp-hex').fill('#00aa55');
    await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    const countBeforeColor = (await strokesOf(page, noteId)).length;
    await pen(page, segment(300, 1300, 800, 1300));
    await until(async () => {
      const s = await strokesOf(page, noteId);
      return s.length === countBeforeColor + 1 && s[s.length - 1].color === '#00aa55';
    }, { what: 'Strich in eigener Farbe' });

    // ── Formen-Halten: ruhig halten, danach wird der Kreis geschlossen ──
    const countBeforeShape = (await strokesOf(page, noteId)).length;
    const circle = [];
    for (let a = 0; a <= 6.4; a += 0.15) {
      circle.push([Math.round(700 + Math.cos(a) * 300 + Math.sin(a * 10) * 8), Math.round(700 + Math.sin(a) * 300 + Math.sin(a * 7) * 8)]);
    }
    await pen(page, circle, { hold: 700 });
    await until(async () => (await strokesOf(page, noteId)).length === countBeforeShape + 1, { what: 'Kreis gespeichert' });
    const shape = (await strokesOf(page, noteId)).at(-1);
    assert.ok(isClosed(shape), 'Der gehaltene Kreis ist geschlossen');

    // ── Seitenübersicht: Duplizieren, dann „Nach hinten“ ──
    const firstId = (await localPages(page, noteId))[0].id;
    await page.locator('button[aria-label="Seitenmenü"]').click();
    await page.getByRole('menuitem', { name: 'Seitenübersicht', exact: true }).click();
    const cells = page.locator('.pov-cell');
    await until(async () => (await cells.count()) === 1, { what: 'Seitenübersicht mit einer Seite' });

    await page.locator('button[aria-label="Menü für Seite 1"]').click();
    await page.getByRole('menuitem', { name: 'Duplizieren', exact: true }).click();
    await until(async () => (await cells.count()) === 2, { what: 'Seite dupliziert' });

    await page.locator('button[aria-label="Menü für Seite 1"]').click();
    await page.getByRole('menuitem', { name: 'Nach hinten', exact: true }).click();
    await until(async () => {
      const pages = await localPages(page, noteId);
      return pages.length === 2 && pages[1].id === firstId;
    }, { what: 'Seite 1 steht nach hinten' });

    await page.locator('.pov-done').click();
    await page.locator('.pov').waitFor({ state: 'detached' });
    assert.equal((await localPages(page, noteId)).length, 2, 'Seiten nach der Übersicht');

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
