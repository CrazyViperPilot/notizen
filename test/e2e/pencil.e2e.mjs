// Bleistift (Werkzeug 'pencil'): Striche werden als Typ 'b' gespeichert. Die Breite folgt Druck und Neigung des
// Apple Pencil: flach gehalten breit und weich zum Schraffieren, senkrecht gehalten fein wie der Stift.
// Ablauf: Werkzeug wählen (Knopf und Tastenkürzel), zwei Striche mit unterschiedlicher Neigung, Langdruck übernimmt Werkzeug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, segment, until, rnd, gotoHash, waitApp,
  strokesOf, assertNoErrors, MODEL_URL,
} from './helpers.mjs';

/**
 * Stift-Ereignisse mit Neigung: tiltX in Grad (0 = senkrecht, 70 = flach). Der Höhenwinkel wird zusätzlich
 * als altitudeAngle mitgegeben, falls der Browser das Feld im Konstruktor übernimmt. Sonst leitet der Browser es ab.
 */
function penTilted(page, points, tiltX) {
  return page.evaluate(async ({ points, tiltX }) => {
    const surf = document.querySelector('.nz-surface');
    if (!surf) throw new Error('Keine Zeichenfläche');
    const sr = surf.getBoundingClientRect();
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('.nz-page')) {
      const r = el.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, sr.right) - Math.max(r.left, sr.left));
      const iy = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
      if (ix * iy > bestArea) { bestArea = ix * iy; best = r; }
    }
    if (!best) throw new Error('Keine sichtbare Seite');
    const unitW = best.width > best.height ? 2970 : 2100;
    const k = best.width / unitW;
    const id = 100 + Math.floor(Math.random() * 800);
    const altitudeAngle = tiltX ? Math.atan(1 / Math.tan((tiltX * Math.PI) / 180)) : Math.PI / 2;
    const fire = (type, [ux, uy]) => surf.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'pen', pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1,
      tiltX, tiltY: 0, altitudeAngle,
      clientX: best.left + ux * k, clientY: best.top + uy * k, bubbles: true, cancelable: true,
    }));
    const n = points.length;
    fire('pointerdown', points[0]);
    for (let i = 1; i < n; i++) fire('pointermove', points[i]);
    fire('pointerup', points[n - 1]);
  }, { points, tiltX });
}

/** Finger-Ereignisse in Bildschirmkoordinaten relativ zur Zeichenfläche (wie in gestures.e2e.mjs). */
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

/** Bildschirmposition (relativ zur Zeichenfläche) eines Punkts in Seiteneinheiten der ersten sichtbaren Seite. */
function screenPos(page, ux, uy) {
  return page.evaluate(({ ux, uy }) => {
    const el = document.querySelector('.nz-surface').getBoundingClientRect();
    const pg = document.querySelector('.nz-page').getBoundingClientRect();
    const k = pg.width / (pg.width > pg.height ? 2970 : 2100);
    return { x: pg.left - el.left + ux * k, y: pg.top - el.top + uy * k };
  }, { ux, uy });
}

/** Höchster Druck-/Radiuswert (dritter Wert je Punkt) eines Strichs. */
const maxP = (s) => Math.max(...s.pts.filter((_, i) => i % 3 === 2));

test('Bleistift: Neigung macht den Strich breit, Typ b wird gespeichert, Langdruck übernimmt das Werkzeug', { timeout: 240000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const user = await createUser(admin.page, 'bleist');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, user.username, user.password);
    await page.goto(BASE);
    await waitApp(page);
    const noteId = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      return (await m.createNote({ title, paper: 'blank' })).id;
    }, { modelUrl: MODEL_URL, title: 'Bleistift ' + rnd() });
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor();

    // Werkzeug über den Knopf wählen
    const pencilBtn = page.getByRole('button', { name: 'Bleistift', exact: true });
    await pencilBtn.click();
    await until(async () => (await pencilBtn.getAttribute('aria-pressed')) === 'true', { what: 'Bleistift gewählt' });

    // Senkrecht gehalten (fein), dann flach gehalten (70° Neigung, breit)
    await penTilted(page, segment(300, 500, 1200, 500), 0);
    await penTilted(page, segment(300, 1100, 1200, 1100), 70);
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'zwei Bleistift-Striche' });
    const [steil, flach] = await strokesOf(page, noteId);
    assert.equal(steil.type, 'b', 'senkrechter Strich ist ein Bleistift-Strich (Typ b)');
    assert.equal(flach.type, 'b', 'flacher Strich ist ein Bleistift-Strich (Typ b)');
    assert.ok(maxP(flach) > 3 * maxP(steil),
      `flacher Strich (p ${maxP(flach)}) soll deutlich breiter sein als senkrecht (p ${maxP(steil)})`);

    // Tastenkürzel: p = Stift, b = Bleistift
    await page.keyboard.press('p');
    const penBtn = page.getByRole('button', { name: 'Stift', exact: true });
    await until(async () => (await penBtn.getAttribute('aria-pressed')) === 'true', { what: 'Taste p wählt den Stift' });
    await page.keyboard.press('b');
    await until(async () => (await pencilBtn.getAttribute('aria-pressed')) === 'true', { what: 'Taste b wählt den Bleistift' });

    // Langer Fingerdruck auf den flachen Bleistift-Strich: Werkzeug wird übernommen (von Stift aus)
    await penBtn.click();
    await until(async () => (await penBtn.getAttribute('aria-pressed')) === 'true', { what: 'Stift gewählt' });
    const pos = await screenPos(page, 700, 1100);
    await touches(page, [{ t: 'pointerdown', id: 41, ...pos }, { wait: 650 }, { t: 'pointerup', id: 41, ...pos }]);
    await until(async () => (await pencilBtn.getAttribute('aria-pressed')) === 'true',
      { what: 'Pipette übernimmt den Bleistift' });

    assertNoErrors(dev.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
