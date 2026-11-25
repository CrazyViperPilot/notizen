// node --test test/js/paper.test.mjs — neue Papiersorten (Koordinatensystem, Millimeterpapier, Notenlinien, Isometrie)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperGeometry } from '../../js/ink/paper.js';
import { pageDims, PAPERS, PAPER_NAMES } from '../../js/config.js';

const NEW = ['coord', 'mm', 'music', 'iso'];
const SIZES = ['a5', 'a4', 'a3'];
const ORIENTS = ['p', 'l'];
const EPS = 0.5;

/** Float32Array (x1,y1,x2,y2,…) → Liste von [x1,y1,x2,y2]. */
const segs = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += 4) out.push([arr[i], arr[i + 1], arr[i + 2], arr[i + 3]]);
  return out;
};
const len = ([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1);
/** Winkel der Strecke gegen die Waagerechte, 0 ≤ a < 180 (Grad). */
const angle = ([x1, y1, x2, y2]) => (((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) % 180 + 180) % 180;
const inside = (list, w, h) => list.every(([x1, y1, x2, y2]) =>
  [x1, x2].every((x) => x >= -EPS && x <= w + EPS) && [y1, y2].every((y) => y >= -EPS && y <= h + EPS));
const onEdge = ([x, y], w, h) => Math.abs(x) < EPS || Math.abs(x - w) < EPS || Math.abs(y) < EPS || Math.abs(y - h) < EPS;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≈ ${b}`);

test('PAPERS und PAPER_NAMES: vier neue Sorten hinten angehängt, alle benannt, keine Dubletten', () => {
  assert.deepEqual(PAPERS.slice(-4), NEW);
  assert.equal(new Set(PAPERS).size, PAPERS.length, 'keine doppelten Codes');
  for (const p of PAPERS) assert.equal(typeof PAPER_NAMES[p], 'string', `Name für ${p}`);
  assert.equal(PAPER_NAMES.coord, 'Koordinatensystem');
  assert.equal(PAPER_NAMES.mm, 'Millimeterpapier');
  assert.equal(PAPER_NAMES.music, 'Notenlinien');
  assert.equal(PAPER_NAMES.iso, 'Isometriepapier');
});

test('alle Sorten: Typen, Cache, Koordinaten innerhalb der Seite', () => {
  for (const paper of PAPERS) {
    for (const size of SIZES) {
      for (const o of ORIENTS) {
        const { w, h } = pageDims(size, o);
        const g = paperGeometry(paper, o, size);
        assert.ok(g.lines instanceof Float32Array && g.strongLines instanceof Float32Array, paper);
        assert.ok(g.dots instanceof Float32Array && g.bands instanceof Float32Array, paper);
        assert.equal(g.lines.length % 4, 0, `${paper} ${size}${o} lines`);
        assert.equal(g.strongLines.length % 4, 0, `${paper} ${size}${o} strongLines`);
        assert.ok(inside(segs(g.lines), w, h), `${paper} ${size}${o}: lines innen`);
        assert.ok(inside(segs(g.strongLines), w, h), `${paper} ${size}${o}: strongLines innen`);
        if (g.margin) assert.ok(inside(segs(Float32Array.from(g.margin)), w, h), `${paper} ${size}${o}: margin innen`);
        assert.equal(paperGeometry(paper, o, size), g, `${paper} ${size}${o}: Cache`);
      }
    }
  }
});

test('coord: Kästchen 5 mm wie grid, Achsen auf Kästchenraster nahe der Mitte, Teilstriche und Pfeile', () => {
  for (const size of SIZES) {
    for (const o of ORIENTS) {
      const { w, h } = pageDims(size, o);
      const ox = (w % 50) / 2, oy = (h % 50) / 2;
      const g = paperGeometry('coord', o, size);
      assert.equal(g.margin, null, 'kein Rand');
      assert.equal(g.bands.length, 0);
      // Kästchen: vertikale und horizontale Linien auf dem Raster (Ursprung ox/oy, Abstand 50)
      const L = segs(g.lines);
      assert.ok(L.length > 0);
      for (const s of L) {
        if (s[0] === s[2]) assert.ok((s[0] - ox) % 50 === 0, `${size}${o} vertikal auf Raster`);
        else assert.ok((s[1] - oy) % 50 === 0, `${size}${o} horizontal auf Raster`);
      }
      const S = segs(g.strongLines);
      const xAxis = S.find((s) => s[1] === s[3] && s[0] === 0 && s[2] === w);
      const yAxis = S.find((s) => s[0] === s[2] && s[1] === 0 && s[3] === h);
      assert.ok(xAxis, `${size}${o}: x-Achse über die volle Breite`);
      assert.ok(yAxis, `${size}${o}: y-Achse über die volle Höhe`);
      const ay = xAxis[1], ax = yAxis[0];
      assert.ok((ay - oy) % 50 === 0, `${size}${o}: x-Achse auf Kästchenraster`);
      assert.ok((ax - ox) % 50 === 0, `${size}${o}: y-Achse auf Kästchenraster`);
      assert.ok(Math.abs(ay - h / 2) <= 25, `${size}${o}: x-Achse nahe der Mitte`);
      assert.ok(Math.abs(ax - w / 2) <= 25, `${size}${o}: y-Achse nahe der Mitte`);
      // Teilstriche alle 1 cm, 2 mm lang, ohne Ursprung
      let expX = 0, expY = 0;
      for (let m = -60; m <= 60; m++) {
        if (m === 0) continue;
        if (ax + 100 * m > 0 && ax + 100 * m < w) expX++;
        if (ay + 100 * m > 0 && ay + 100 * m < h) expY++;
      }
      const ticks = S.filter((s) => Math.abs(len(s) - 20) < 1e-3);
      assert.equal(ticks.length, expX + expY, `${size}${o}: Teilstriche`);
      for (const t of ticks) {
        if (t[0] === t[2]) { assert.equal(t[1], ay - 10); assert.equal(t[3], ay + 10); assert.ok((t[0] - ax) % 100 === 0); }
        else { assert.equal(t[0], ax - 10); assert.equal(t[2], ax + 10); assert.ok((t[1] - ay) % 100 === 0); }
      }
      // Pfeilspitzen: je zwei 3-mm-Linien an (w, ay) und an (ax, 0)
      const arms = S.filter((s) => Math.abs(len(s) - 30) < 1e-3);
      assert.equal(arms.length, 4, `${size}${o}: vier Pfeilarme`);
      const atTipX = arms.filter((s) => (s[0] === w && s[1] === ay) || (s[2] === w && s[3] === ay));
      const atTipY = arms.filter((s) => (s[0] === ax && s[1] === 0) || (s[2] === ax && s[3] === 0));
      assert.equal(atTipX.length, 2, 'rechter Pfeil');
      assert.equal(atTipY.length, 2, 'oberer Pfeil');
      assert.equal(S.length, 2 + ticks.length + 4, `${size}${o}: keine weiteren Striche`);
    }
  }
});

test('mm: volle cm ab 10 mm Rand, cm-Linien kräftig, mm-Linien normal, keine Doppelungen', () => {
  for (const size of SIZES) {
    for (const o of ORIENTS) {
      const { w, h } = pageDims(size, o);
      const nx = Math.floor((w - 200) / 100), ny = Math.floor((h - 200) / 100);
      const g = paperGeometry('mm', o, size);
      assert.equal(g.margin, null);
      const S = segs(g.strongLines), L = segs(g.lines);
      const sv = S.filter((s) => s[0] === s[2]).map((s) => s[0]);
      const sh = S.filter((s) => s[1] === s[3]).map((s) => s[1]);
      const lv = L.filter((s) => s[0] === s[2]).map((s) => s[0]);
      const lh = L.filter((s) => s[1] === s[3]).map((s) => s[1]);
      assert.equal(sv.length, nx + 1, `${size}${o}: cm-Linien senkrecht`);
      assert.equal(sh.length, ny + 1, `${size}${o}: cm-Linien waagerecht`);
      assert.equal(lv.length, 9 * nx, `${size}${o}: 9 mm-Linien je cm (senkrecht)`);
      assert.equal(lh.length, 9 * ny, `${size}${o}: 9 mm-Linien je cm (waagerecht)`);
      // volle cm vom Rand 10 mm, letzte cm-Linie höchstens 10 mm vor dem Rand, und kein weiteres cm-Feld passt
      assert.equal(Math.min(...sv), 100);
      assert.equal(Math.max(...sv), 100 + 100 * nx);
      assert.ok(w - 100 - Math.max(...sv) < 100, `${size}${o}: keine weitere volle cm-Spalte`);
      assert.equal(Math.min(...sh), 100);
      assert.equal(Math.max(...sh), 100 + 100 * ny);
      assert.ok(h - 100 - Math.max(...sh) < 100, `${size}${o}: keine weitere volle cm-Zeile`);
      // Positionen: cm-Linien auf ganzen cm, mm-Linien dazwischen, nie an einer cm-Position doppelt
      for (const x of sv) assert.ok((x - 100) % 100 === 0);
      for (const y of sh) assert.ok((y - 100) % 100 === 0);
      for (const x of lv) assert.equal((x - 100) % 100 === 0, false, 'mm-Linie nicht auf cm');
      for (const y of lh) assert.equal((y - 100) % 100 === 0, false, 'mm-Linie nicht auf cm');
      assert.equal(new Set([...lv, ...sv]).size, lv.length + sv.length, 'keine doppelte Vertikale');
      assert.equal(new Set([...lh, ...sh]).size, lh.length + sh.length, 'keine doppelte Horizontale');
      for (const x of lv) assert.ok((x - 100) % 10 === 0, 'mm-Raster 1 mm');
      // Linienlängen: vertikal von 10 mm bis zur letzten vollen cm-Zeile, horizontal analog
      for (const s of S.filter((s) => s[0] === s[2])) { assert.equal(s[1], 100); assert.equal(s[3], 100 + 100 * ny); }
      for (const s of S.filter((s) => s[1] === s[3])) { assert.equal(s[0], 100); assert.equal(s[2], 100 + 100 * nx); }
    }
  }
});

test('mm: A3 quer 40 × 27 volle cm-Felder (41 × 28 cm-Linien), A4 hoch 19 × 27 Felder (20 × 28 Linien)', () => {
  const a3l = paperGeometry('mm', 'l', 'a3');
  assert.equal(segs(a3l.strongLines).filter((s) => s[0] === s[2]).length, 41);
  assert.equal(segs(a3l.strongLines).filter((s) => s[1] === s[3]).length, 28);
  const a4p = paperGeometry('mm', 'p', 'a4');
  assert.equal(segs(a4p.strongLines).filter((s) => s[0] === s[2]).length, 20);
  assert.equal(segs(a4p.strongLines).filter((s) => s[1] === s[3]).length, 28);
});

test('music: Systeme aus 5 Linien im Abstand 20, erstes bei 250, Systemabstand 150, Linien 150…w−150', () => {
  for (const size of SIZES) {
    for (const o of ORIENTS) {
      const { w, h } = pageDims(size, o);
      const ys = [];
      for (let y = 250; y + 80 <= h - 150; y += 150) ys.push(y);
      const g = paperGeometry('music', o, size);
      const L = segs(g.lines);
      assert.equal(L.length, 5 * ys.length, `${size}${o}: 5 Linien je System`);
      assert.equal(g.strongLines.length, 0);
      assert.equal(g.bands.length, 0);
      ys.forEach((y0, i) => {
        for (let k = 0; k < 5; k++) {
          assert.deepEqual(L[5 * i + k], [150, y0 + 20 * k, w - 150, y0 + 20 * k], `${size}${o} System ${i} Linie ${k}`);
        }
      });
      // Klammerlinie je System links, 4 Werte je Segment
      assert.ok(g.margin, 'Klammern vorhanden');
      const M = segs(Float32Array.from(g.margin));
      assert.equal(M.length, ys.length);
      ys.forEach((y0, i) => assert.deepEqual(M[i], [150, y0, 150, y0 + 80]));
      // Ende: letztes System endet ≥ 15 mm über dem Rand, das nächste passt nicht mehr
      const last = ys[ys.length - 1];
      assert.ok(last + 80 <= h - 150);
      assert.ok(last + 150 + 80 > h - 150);
    }
  }
  assert.equal(segs(paperGeometry('music', 'p', 'a4').lines).length, 85, 'A4 hoch: 17 Systeme');
});

test('iso: Scharen 90° und ±30°, Abstand 5 mm · cos 30°, Endpunkte am Rand', () => {
  const d = 50 * Math.cos(Math.PI / 6);
  for (const size of SIZES) {
    for (const o of ORIENTS) {
      const { w, h } = pageDims(size, o);
      const L = segs(paperGeometry('iso', o, size).lines);
      assert.ok(L.length > 0);
      const seen = new Set();
      for (const s of L) {
        const a = angle(s);
        const dev = Math.min(Math.abs(a - 30), Math.abs(a - 90), Math.abs(a - 150));
        assert.ok(dev < 0.01, `${size}${o}: Winkel ${a}`);
        seen.add(Math.round(a));
        assert.ok(onEdge([s[0], s[1]], w, h) && onEdge([s[2], s[3]], w, h), `${size}${o}: Endpunkte am Rand`);
        assert.ok(len(s) > 0);
      }
      assert.deepEqual([...seen].sort((x, y) => x - y), [30, 90, 150], `${size}${o}: alle drei Scharen`);
      // Senkrechte Linien: benachbarte x-Abstände = 5 mm · cos 30°
      const xs = [...new Set(L.filter((s) => s[0] === s[2]).map((s) => s[0]))].sort((x, y) => x - y);
      assert.ok(xs.length > 2);
      for (let i = 1; i < xs.length; i++) close(xs[i] - xs[i - 1], d, 0.01, `${size}${o} Abstand`);
    }
  }
});

test('iso: 30°- und 150°-Schar liegen im Abstand 5 mm · cos 30° (Dreiecksgitter, Kante 5 mm)', () => {
  const d = 50 * Math.cos(Math.PI / 6);
  const L = segs(paperGeometry('iso', 'p', 'a4').lines);
  for (const deg of [30, 150]) {
    const t = (deg * Math.PI) / 180;
    const n = [-Math.sin(t), Math.cos(t)]; // Normale der Schar
    const offs = [...new Set(L.filter((s) => Math.abs(angle(s) - deg) < 0.01)
      .map(([x1, y1]) => Math.round((n[0] * x1 + n[1] * y1) * 100) / 100))].sort((a, b) => a - b);
    assert.ok(offs.length > 10, `Schar ${deg}°`);
    for (let i = 1; i < offs.length; i++) close(offs[i] - offs[i - 1], d, 0.05, `Schar ${deg}° Abstand ${i}`);
  }
});

test('iso: Segmente entlang Seitenkante abgeschnitten, Muster bei A5 quer', () => {
  const g = paperGeometry('iso', 'l', 'a5');
  const { w, h } = pageDims('a5', 'l');
  assert.ok(inside(segs(g.lines), w, h));
  assert.equal(g.strongLines.length, 0);
  assert.equal(g.margin, null);
});
