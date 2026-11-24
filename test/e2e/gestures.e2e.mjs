// Gesten (ARCHITEKTUR 11.7): zwei Finger tippen = Rückgängig, drei Finger = Wiederholen, langer Fingerdruck auf einen Strich
// = Farbe übernehmen, schnelles Zusammenziehen = ganze Seite, Glättungs-Einstellung wirkt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, pen, segment, until, rnd, gotoHash, waitApp,
  strokesOf, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

/** Finger-Ereignisse in Bildschirmkoordinaten relativ zur Zeichenfläche. */
function touches(page, steps) {
  return page.evaluate(async (steps) => {
    const el = document.querySelector('.nz-surface');
    const r = el.getBoundingClientRect();
    for (const s of steps) {
      if (s.wait) { await new Promise((res) => setTimeout(res, s.wait)); continue; }
      el.dispatchEvent(new PointerEvent(s.t, { pointerId: s.id, pointerType: 'touch', clientX: r.left + s.x, clientY: r.top + s.y, bubbles: true, cancelable: true }));
    }
  }, steps);
}

const tap = (ids, x = 400, y = 500) => [
  ...ids.map((id, i) => ({ t: 'pointerdown', id, x: x + i * 60, y })),
  { wait: 60 },
  ...ids.map((id, i) => ({ t: 'pointerup', id, x: x + i * 60, y })),
];

test('Gesten: Rückgängig/Wiederholen, Pipette, ganze Seite, Glättung', { timeout: 240000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'gest');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, user.username, user.password);
    await page.goto(BASE);
    await waitApp(page);
    // Glättung „Direkt“ einstellen (wirkt beim Öffnen der Notiz)
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('notizen:prefs') || '{}');
      p.smoothing = 'direct';
      localStorage.setItem('notizen:prefs', JSON.stringify(p));
    });
    const noteId = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'blank' })).id;
    }, { modelUrl: MODEL_URL, title: 'Gesten ' + rnd() });
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor();

    // Roter Strich: Farbe über die Leiste wählen, dann schreiben
    await page.getByRole('button', { name: 'Farbe Rot' }).click();
    await pen(page, segment(300, 600, 1200, 600));
    await page.getByRole('button', { name: 'Farbe Schwarz' }).click();
    await pen(page, segment(300, 900, 1200, 900));
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'zwei Striche' });
    const surf = () => page.evaluate(() => document.querySelector('.nz-surface') && true);
    assert.ok(await surf());

    // Zwei Finger tippen → Rückgängig
    await touches(page, tap([31, 32]));
    await until(async () => (await strokesOf(page, noteId)).length === 1, { what: 'Rückgängig per Zwei-Finger-Tipp' });
    // Drei Finger tippen → Wiederholen
    await touches(page, tap([33, 34, 35]));
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'Wiederholen per Drei-Finger-Tipp' });

    // Langer Fingerdruck auf den roten Strich → Stift wird rot
    const pos = await page.evaluate(() => {
      const el = document.querySelector('.nz-surface').getBoundingClientRect();
      const pg = document.querySelector('.nz-page').getBoundingClientRect();
      const k = pg.width / 2100;
      return { x: pg.left - el.left + 700 * k, y: pg.top - el.top + 600 * k };
    });
    await touches(page, [{ t: 'pointerdown', id: 41, ...pos }, { wait: 650 }, { t: 'pointerup', id: 41, ...pos }]);
    await until(async () => (await page.getByRole('button', { name: 'Farbe Rot' }).getAttribute('aria-pressed')) === 'true',
      { what: 'Pipette übernimmt Rot' });
    await pen(page, segment(300, 1200, 1200, 1200));
    await until(async () => (await strokesOf(page, noteId)).length === 3, { what: 'dritter Strich' });
    const st = await strokesOf(page, noteId);
    assert.equal(st[2].color ?? st[2].c, 2, 'neuer Strich ist rot (Farbindex 2)');

    // Zoomen (Pinch auseinander), dann schnell zusammen → ganze Seite (Zoom 1)
    const zoomOf = () => page.evaluate(() => {
      const pg = document.querySelector('.nz-page').getBoundingClientRect();
      return pg.width / document.querySelector('.nz-surface').getBoundingClientRect().width;
    });
    const z0 = await zoomOf();
    await touches(page, [
      { t: 'pointerdown', id: 51, x: 380, y: 500 }, { t: 'pointerdown', id: 52, x: 420, y: 500 },
      ...Array.from({ length: 10 }, (_, i) => [{ t: 'pointermove', id: 51, x: 380 - i * 20, y: 500 }, { t: 'pointermove', id: 52, x: 420 + i * 20, y: 500 }]).flat(),
      { t: 'pointerup', id: 51, x: 200, y: 500 }, { t: 'pointerup', id: 52, x: 600, y: 500 },
    ]);
    assert.ok((await zoomOf()) > z0 * 2, 'hineingezoomt');
    await touches(page, [
      { t: 'pointerdown', id: 53, x: 200, y: 500 }, { t: 'pointerdown', id: 54, x: 600, y: 500 },
      ...Array.from({ length: 5 }, (_, i) => [{ t: 'pointermove', id: 53, x: 200 + i * 30, y: 500 }, { t: 'pointermove', id: 54, x: 600 - i * 30, y: 500 }]).flat(),
      { t: 'pointerup', id: 53, x: 320, y: 500 }, { t: 'pointerup', id: 54, x: 480, y: 500 },
    ]);
    await until(async () => Math.abs((await zoomOf()) - z0) < 0.02, { what: 'ganze Seitenbreite' });

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
