// Runde 5 (ARCHITEKTUR 14): neue Papiersorten und Ordnerfarbe im Sync, Zirkel mit Stiftführung, Lasso drehen,
// Kopieren/Einfügen, Abdecken und Lernen, Lesezeichen, Format mit Skalieren, Titelblatt als Seite, Präsentation,
// PDF mit Lesezeichen und Seitenzahlen, Abgabe und Korrektur zwischen zwei Benutzern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, chromium, newDevice, createUser, loginApi, until, rnd, gotoHash, waitApp, strokesOf, assertNoErrors, MODEL_URL,
  waitSync, url,
} from './helpers.mjs';

/** Stift-Ereignisse in Container-Koordinaten der Zeichenfläche (CSS-px). */
function penAt(page, pts) {
  return page.evaluate(({ pts }) => {
    const el = document.querySelector('.nz-surface');
    const r = el.getBoundingClientRect();
    const id = 500 + Math.floor(Math.random() * 300);
    const fire = (type, [x, y]) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'pen', pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', pts[0]);
    for (let i = 1; i < pts.length; i++) fire('pointermove', pts[i]);
    fire('pointerup', pts[pts.length - 1]);
  }, { pts });
}

/** Seite 1 in Container-px: {x, y, k} mit k = px pro Seiteneinheit. */
async function pageBox(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.nz-surface').getBoundingClientRect();
    const p = document.querySelector('.nz-page').getBoundingClientRect();
    return { x: p.left - s.left, y: p.top - s.top, w: p.width };
  });
}

const line = (x0, y0, x1, y1, n = 16) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

async function rows(page, noteId) {
  return page.evaluate(async ({ modelUrl, noteId }) => {
    const m = await import(modelUrl);
    return (await m.listPages(noteId)).map((p) => ({ id: p.id, size: p.size, bg: p.bg, meta: m.pageMeta(p), strokes: p.strokes }));
  }, { modelUrl: MODEL_URL, noteId });
}

async function menuItem(page, text) {
  await page.getByRole('button', { name: 'Seitenmenü', exact: true }).click();
  await page.getByText(text, { exact: true }).click();
}

test('Runde 5: Werkzeuge, Lernen, Lesezeichen, Titelblatt, Präsentation, PDF, Korrektur', { timeout: 600000 }, async () => {
  const browser = await chromium.launch();
  try {
    const admin = await newDevice(browser);
    const anna = await createUser(admin.page, 'anna');
    const bert = await createUser(admin.page, 'bert');
    const dev = await newDevice(browser);
    const { page } = dev;
    await loginApi(page, anna.username, anna.password);
    await page.goto(BASE);
    await waitApp(page);
    await page.evaluate(() => { for (const k of ['notizen:ruler', 'notizen:geodreieck', 'notizen:zirkel', 'notizen:clipboard', 'notizen:export']) localStorage.removeItem(k); });

    // ── Papiersorten und Ordnerfarbe synchronisieren ──
    const ids = await page.evaluate(async ({ modelUrl, title }) => {
      const m = await import(modelUrl);
      const f = await m.createFolder({ name: 'Mathe' });
      await m.setFolderColor(f.id, '#2F5FD0');
      const n = await m.createNote({ title, folderId: f.id, paper: 'coord' });
      for (const paper of ['mm', 'music', 'iso']) await m.addPage(n.id, null, { paper, orient: 'p' });
      return { folder: f.id, note: n.id };
    }, { modelUrl: MODEL_URL, title: 'Runde5 ' + rnd() });
    await waitSync(page);
    const errs = await page.evaluate(async (modelUrl) => {
      const m = await import(modelUrl);
      return m.syncStatus().error;
    }, MODEL_URL);
    assert.equal(errs, null, 'Sync ohne Fehler (neue Papiersorten, Farbe)');
    await gotoHash(page, '#/f/' + ids.folder);
    await gotoHash(page, '#/');
    await until(async () => (await page.locator('.has-color').count()) > 0, { what: 'Ordnerfarbe in der Übersicht' });

    // Notiz öffnen
    const noteId = ids.note;
    await gotoHash(page, '#/n/' + noteId);
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    const pb = await pageBox(page);
    const k = pb.w / 2100;

    // ── Zirkel: Stift am Kreis → alle Punkte auf dem Radius ──
    await page.keyboard.press('z');
    await page.locator('canvas.zirkel').waitFor({ state: 'visible' });
    const z = await page.evaluate(() => JSON.parse(localStorage.getItem('notizen:zirkel')));
    const rpx = z.r * 10 * k;
    await penAt(page, Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * Math.PI;                    // Halbkreis, leicht daneben
      return [z.cx + Math.cos(a) * (rpx + (i % 2 ? 6 : -6)), z.cy + Math.sin(a) * (rpx + (i % 2 ? 6 : -6))];
    }));
    await until(async () => (await strokesOf(page, noteId)).length === 1, { what: 'Kreisbogen gespeichert' });
    const arc = (await strokesOf(page, noteId))[0].pts;
    const cu = (z.cx - pb.x) / k, cv = (z.cy - pb.y) / k;
    for (let i = 0; i < arc.length; i += 3) {
      const d = Math.hypot(arc[i] - cu, arc[i + 1] - cv);
      assert.ok(Math.abs(d - z.r * 10) <= 4, `Punkt auf dem Kreis (r ${d} statt ${z.r * 10})`);
    }
    await page.keyboard.press('z');
    await page.locator('canvas.zirkel').waitFor({ state: 'hidden' });

    // ── Lasso: waagerechte Linie zeichnen, auswählen, um 90° drehen ──
    await page.evaluate(async ({ modelUrl, noteId }) => { const m = await import(modelUrl); const p = (await m.listPages(noteId))[0]; await m.saveStrokes(p.id, '[]'); }, { modelUrl: MODEL_URL, noteId });
    await until(async () => (await strokesOf(page, noteId)).length === 0, { what: 'Seite leer' });
    await page.waitForTimeout(900);   // die Zeichenfläche übernimmt die geleerte Seite nach dem Neuladen (300 ms)
    const X = (u) => pb.x + u * k, Y = (v) => pb.y + v * k;
    await penAt(page, line(X(600), Y(800), X(1400), Y(800)));
    await until(async () => (await strokesOf(page, noteId)).length === 1, { what: 'Linie' });
    await page.getByRole('button', { name: 'Lasso (auswählen)', exact: true }).click();
    await penAt(page, Array.from({ length: 33 }, (_, i) => { const a = (i / 32) * 2 * Math.PI; return [X(1000 + 520 * Math.cos(a)), Y(800 + 150 * Math.sin(a))]; }));
    await page.locator('.sel-bar').waitFor({ state: 'visible' });
    const sel = await page.locator('.nz-selection').evaluate((el) => {
      const r = el.getBoundingClientRect(), s = document.querySelector('.nz-surface').getBoundingClientRect();
      return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
    });
    const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2, hx = cx, hy = sel.y - 25;
    // Griff oben → nach rechts auf Höhe der Mitte ziehen: +90°
    await penAt(page, Array.from({ length: 13 }, (_, i) => { const a = -Math.PI / 2 + (i / 12) * (Math.PI / 2); const R = cy - hy; return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; }));
    await until(async () => {
      const s = (await strokesOf(page, noteId))[0];
      if (!s) return false;
      const n = s.pts.length;
      return Math.abs(s.pts[0] - s.pts[n - 3]) <= 3 && Math.abs(s.pts[1] - s.pts[n - 2]) > 700;
    }, { what: 'Linie senkrecht gedreht' });

    // ── Kopieren und Einfügen (Cmd/Strg+C, Cmd/Strg+V) ──
    await page.keyboard.press('Control+c');
    await until(async () => !!(await page.evaluate(() => localStorage.getItem('notizen:clipboard'))), { what: 'Zwischenablage' });
    await page.keyboard.press('Control+v');
    await until(async () => (await strokesOf(page, noteId)).length === 2, { what: 'eingefügt' });

    // ── Abdecken → Lernen ──
    await page.getByRole('button', { name: 'Abdecken', exact: true }).click();
    await until(async () => ((await rows(page, noteId))[0].meta.covers || []).length === 1, { what: 'Abdeckung gespeichert' });
    await page.locator('.tb-quiz').waitFor({ state: 'visible' });
    await page.locator('.tb-quiz').click();
    await page.locator('.nz-cover-area').waitFor({ state: 'visible' });
    const ca = await page.locator('.nz-cover-area').evaluate((el) => {
      const r = el.getBoundingClientRect(), s = document.querySelector('.nz-surface').getBoundingClientRect();
      return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
    });
    await penAt(page, [[ca.x, ca.y]]);
    await page.locator('.nz-cover-area.open').waitFor();
    await page.getByRole('button', { name: 'Fertig', exact: true }).click();
    await page.getByRole('button', { name: 'Stift', exact: true }).click();

    // ── Lesezeichen ──
    await menuItem(page, 'Lesezeichen setzen…');
    await page.locator('.nz-dialog input').fill('Kapitel 1');
    await page.locator('.nz-dialog').getByRole('button', { name: 'Speichern', exact: true }).click();
    await until(async () => (await rows(page, noteId))[0].meta.label === 'Kapitel 1', { what: 'Lesezeichen gespeichert' });
    await page.waitForTimeout(700);   // Editor lädt die Seiten neu (Menü kennt dann das Lesezeichen)
    await menuItem(page, 'Lesezeichen anzeigen…');
    await page.getByText('Kapitel 1 · S. 1', { exact: true }).click();

    // ── Format A5 mit Skalieren ──
    const before = (await strokesOf(page, noteId))[0].pts[1];
    await menuItem(page, 'Papier und Format…');
    await page.getByText('Format: DIN A5', { exact: true }).click();
    await page.locator('.nz-dialog').getByRole('button', { name: 'Mitskalieren', exact: true }).click();
    await until(async () => (await rows(page, noteId))[0].size === 'a5', { what: 'A5' });
    const after = (await strokesOf(page, noteId))[0].pts[1];
    assert.ok(Math.abs(after - Math.round(before * (1480 / 2100))) <= 1, `skaliert (${before} → ${after})`);

    // ── Titelblatt als Seite ──
    await menuItem(page, 'Titelblatt einfügen…');
    await page.locator('.nz-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click();
    await until(async () => { const r = await rows(page, noteId); return r.length === 5 && !!r[0].bg && r[0].size === 'a5'; }, { what: 'Titelblatt-Seite vorne' });

    // ── Präsentation ──
    await menuItem(page, 'Präsentieren');
    await page.locator('.pres').waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowRight');
    await until(async () => (await page.locator('.pres-count').textContent()).trim().startsWith('2'), { what: 'Seite 2' });
    await page.keyboard.press('Escape');
    await page.locator('.pres').waitFor({ state: 'detached' });

    // ── PDF mit Lesezeichen und Seitenzahlen ──
    await menuItem(page, 'Als PDF exportieren');
    const dlg = page.locator('.nz-dialog');
    await dlg.getByText('Seitenzahlen', { exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      dlg.getByRole('button', { name: 'Exportieren', exact: true }).click(),
    ]);
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    const pdf = Buffer.concat(chunks).toString('latin1');
    assert.match(pdf, /\/Count 5 /);
    assert.match(pdf, /\/Outlines \d+ 0 R/, 'Lesezeichen');
    assert.equal((pdf.match(/\/ImageMask true/g) || []).length, 5, 'Seitenzahl auf jeder Seite');

    // ── Abgabe: Notiz mit „Korrigieren“ an bert geben ──
    await page.evaluate(async ({ apiJs, noteId, target }) => {
      const { api } = await import(apiJs);
      await api.post('share', { kind: 'note', id: noteId, target_ids: [target], review: true });
    }, { apiJs: url('js/api.js'), noteId, target: bert.id });
    await waitSync(page);

    const dev2 = await newDevice(browser);
    const p2 = dev2.page;
    await loginApi(p2, bert.username, bert.password);
    await p2.goto(BASE);
    await waitApp(p2);
    await gotoHash(p2, '#/shared/n/' + noteId);
    await p2.locator('.nz-page').first().waitFor({ timeout: 20000 });
    await p2.getByRole('button', { name: 'Korrigieren', exact: true }).click();
    await p2.locator('.shared-review-bar').waitFor({ state: 'visible' });
    const box2 = await p2.evaluate(() => {
      const s = document.querySelector('.nz-surface').getBoundingClientRect();
      const r = document.querySelector('.nz-page').getBoundingClientRect();
      return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: Math.min(r.height, s.height - (r.top - s.top)) };
    });
    await penAt(p2, line(box2.x + box2.w * 0.2, box2.y + box2.h * 0.5, box2.x + box2.w * 0.7, box2.y + box2.h * 0.55));
    await until(async () => {
      const r = await p2.evaluate(async ({ apiJs, noteId }) => (await (await import(apiJs)).api.get('correction_get', { note: noteId })).corrections.length, { apiJs: url('js/api.js'), noteId });
      return r === 1;
    }, { what: 'Korrektur gespeichert', timeout: 30000 });
    await p2.getByRole('button', { name: 'Fertig', exact: true }).click();

    // anna sieht die Korrektur (Menü „Korrekturen ausblenden“) und behält ihre eigene Schrift unverändert
    const own = (await rows(page, noteId)).map((r) => r.strokes);
    await page.reload();
    await page.locator('.nz-page').first().waitFor({ timeout: 20000 });
    await until(async () => {
      await page.getByRole('button', { name: 'Seitenmenü', exact: true }).click();
      const n = await page.getByText('Korrekturen ausblenden', { exact: true }).count();
      await page.keyboard.press('Escape');
      return n > 0;
    }, { what: 'Korrekturen sichtbar (Seitenmenü)', timeout: 20000, every: 700 });
    assert.deepEqual((await rows(page, noteId)).map((r) => r.strokes), own, 'eigene Schrift unverändert');

    assertNoErrors(dev.errors);
    assertNoErrors(dev2.errors);
    assertNoErrors(admin.errors);
  } finally {
    await browser.close();
  }
});
