// Geodreieck: einblenden (Taste g), Stift an der langen Kante → waagerechte Linie, an der linken Kathete → 45°-Linie,
// gleichzeitig mit dem Lineal, Verschieben mit dem Finger, Ausblenden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, until, rnd, gotoHash, waitApp, strokesOf, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

/** Stift-Strich in Container-Koordinaten von (x0, y0) mit n Schritten (dx, dy) und Zittern quer dazu. */
function penLine(page, x0, y0, dx, dy, n = 20) {
  return page.evaluate(({ x0, y0, dx, dy, n }) => {
    const el = document.querySelector('.nz-surface');
    const r = el.getBoundingClientRect();
    const id = 300 + Math.floor(Math.random() * 300);
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'pen', pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', x0, y0);
    for (let i = 1; i <= n; i++) {
      const j = (i % 2 ? 3 : -3);   // Zittern quer zur Richtung
      fire('pointermove', x0 + i * dx - j * dy / Math.hypot(dx, dy), y0 + i * dy + j * dx / Math.hypot(dx, dy));
    }
    fire('pointerup', x0 + n * dx, y0 + n * dy);
  }, { x0, y0, dx, dy, n });
}

const xy = (s) => {
  const out = [];
  for (let i = 0; i < s.pts.length; i += 3) out.push([s.pts[i], s.pts[i + 1]]);
  return out;
};

test('Geodreieck: Stiftführung an langer Kante und Kathete, mit Lineal, verschieben', { timeout: 300000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'geo');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, user.username, user.password);
    await page.goto(BASE);
    await waitApp(page);
    await page.evaluate(() => { localStorage.removeItem('notizen:geodreieck'); localStorage.removeItem('notizen:ruler'); });

    const noteId = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'grid' })).id;
    }, { modelUrl: MODEL_URL, title: 'Geo ' + rnd() });
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });

    await page.keyboard.press('g');
    await page.locator('canvas.geodreieck').waitFor({ state: 'visible' });
    assert.ok(await page.locator('.tb-instr.on').count(), 'Knopf „Messwerkzeuge“ hervorgehoben');
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('notizen:geodreieck')));
    const s = await page.evaluate(() => {
      // px pro mm aus der Seitenbreite (Rasterpapier, A4 = 210 mm)
      const r = document.querySelector('.nz-page').getBoundingClientRect();
      return r.width / 210;
    });

    // ── Lange Kante: knapp darunter, schräg gezogen → waagerecht ──
    await penLine(page, st.x - 50 * s, st.y + 8, 5 * s, 0.8 * s);
    await until(async () => (await strokesOf(page, noteId)).length === 1, { what: 'Linie an der langen Kante' });
    let pts = xy((await strokesOf(page, noteId))[0]);
    const ys = pts.map((p) => p[1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) <= 2, 'waagerecht');

    // ── Linke Kathete: von außen (links oben) entlang nach rechts oben → Steigung 45° ──
    const mx = st.x - 40 * s, my = st.y - 40 * s;          // Mitte der linken Kathete
    await penLine(page, mx - 6 - 20 * s, my - 6 + 20 * s, 2 * s, -2 * s);
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'Linie an der Kathete' });
    pts = xy((await strokesOf(page, noteId))[1]);
    const [a, b] = [pts[0], pts[pts.length - 1]];
    assert.ok(b[0] - a[0] > 100, 'Linie hat Länge');
    assert.ok(Math.abs((a[1] - b[1]) - (b[0] - a[0])) <= 4, `45° (dx ${b[0] - a[0]}, dy ${a[1] - b[1]})`);
    for (const p of pts) assert.ok(Math.abs((a[1] - p[1]) - (p[0] - a[0])) <= 3, 'alle Punkte auf der Kathete');

    // ── Lineal dazu: beide sichtbar, die Geodreieck-Führung bleibt ──
    await page.keyboard.press('r');
    await page.locator('canvas.ruler').waitFor({ state: 'visible' });
    await penLine(page, st.x - 50 * s, st.y + 8, 5 * s, 0.8 * s, 10);
    await until(async () => (await strokesOf(page, noteId)).length === 3, { what: 'dritte Linie' });
    const ys3 = xy((await strokesOf(page, noteId))[2]).map((p) => p[1]);
    assert.ok(Math.max(...ys3) - Math.min(...ys3) <= 2, 'mit Lineal sichtbar weiterhin geführt');
    await page.keyboard.press('r');

    // ── Verschieben mit der Maus (in der Fläche, nicht auf dem Griff) ──
    const sr = await page.locator('.ed-surface').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const gx = sr.x + st.x - 40 * s, gy = sr.y + st.y - 10 * s;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx + 60, gy + 40, { steps: 5 });
    await page.mouse.up();
    const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('notizen:geodreieck')));
    assert.ok(Math.abs(st2.x - st.x - 60) < 2 && Math.abs(st2.y - st.y - 40) < 2, 'verschoben');
    assert.equal((await strokesOf(page, noteId)).length, 3, 'Verschieben zeichnet nicht');

    await page.getByRole('button', { name: 'Messwerkzeuge', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Geodreieck' }).click();
    await page.locator('canvas.geodreieck').waitFor({ state: 'hidden' });

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
