// Paper geometry (page units), shared by canvas and PDF.

import { pageDims, PAPER_STYLE as S, LINEATUR } from '../config.js';

const cache = new Map();
const LIN_BOTTOM = 150; // Schreibzeilen enden mindestens 15 mm über dem unteren Rand

/** Segment der Geraden nx·x + ny·y = c (nx, ny Einheitsnormale) innerhalb [0,w]×[0,h]: [[x1,y1],[x2,y2]] oder null. */
function clipLine(nx, ny, c, w, h) {
  const e = 1e-6;
  const p = [];
  const add = (x, y) => {
    if (x >= -e && x <= w + e && y >= -e && y <= h + e) p.push([Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]);
  };
  if (Math.abs(ny) > 1e-9) { add(0, c / ny); add(w, (c - nx * w) / ny); }
  if (Math.abs(nx) > 1e-9) { add(c / nx, 0); add((c - ny * h) / nx, h); }
  let best = null, bd = 1e-6;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const d = Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]);
      if (d > bd) { bd = d; best = [p[i], p[j]]; }
    }
  }
  return best;
}

/**
 * {lines: Float32Array x1,y1,x2,y2,…, strongLines: Float32Array (wie lines, mit 1,6-facher Breite gezeichnet),
 *  dots: Float32Array x,y,…, bands: Float32Array x,y,w,h,… (getönte Flächen, PAPER_STYLE.bandColor),
 *  margin: [x1,y1,x2,y2, …] | null}
 * `margin` = accent segments (margin/column lines, drawn in PAPER_STYLE.marginColor); 4 numbers per segment.
 * strongLines und bands sind für alle Sorten vorhanden, außer bei den Sorten ohne Schreibzeilen leer.
 */
export function paperGeometry(paper, orient, size = 'a4') {
  const key = paper + orient + size;
  if (cache.has(key)) return cache.get(key);
  const { w, h } = pageDims(size, orient);
  const lines = [];
  const strong = [];
  const bands = [];
  const dots = [];
  let margin = null;
  if (paper === 'lined') {
    for (let y = S.linedTop; y <= h - S.lined; y += S.lined) lines.push(0, y, w, y);
    margin = [S.margin, 0, S.margin, h];
  } else if (paper === 'grid' || paper === 'math') {
    const ox = (w % S.grid) / 2, oy = (h % S.grid) / 2;
    for (let x = ox; x <= w; x += S.grid) lines.push(x, 0, x, h);
    for (let y = oy; y <= h; y += S.grid) lines.push(0, y, w, y);
    if (paper === 'math') {
      // Rechenkästchen mit Rand: rote Randlinien links und rechts über die volle Höhe
      const m = LINEATUR.mathMargin;
      margin = [m, 0, m, h, w - m, 0, w - m, h];
    }
  } else if (paper === 'vocab') {
    // Vocabulary: lines, divider word | translation, narrow tick column on the right.
    for (let y = S.vocabTop; y <= h - S.lined; y += S.lined) lines.push(0, y, w, y);
    const split = Math.round(w * S.vocabSplit), check = w - S.vocabCheck, top = S.vocabTop - S.lined;
    margin = [split, top, split, h, check, top, check, h];
  } else if (paper === 'dotted') {
    const ox = (w % S.dotted) / 2 || S.dotted, oy = (h % S.dotted) / 2 || S.dotted;
    for (let y = oy; y < h; y += S.dotted) for (let x = ox; x < w; x += S.dotted) dots.push(x, y);
  } else if (paper === 'lin1' || paper === 'lin2' || paper === 'lin3') {
    // Schulhefte: Schreibzeilen aus Oberlinie (y), Mittellinie (y+band), Grundlinie (y+2·band, kräftig), Unterlinie (y+3·band)
    const L = LINEATUR[paper];
    const b = L.band, pitch = 3 * b + L.gap;
    for (let y = LINEATUR.top; y + 3 * b <= h - LIN_BOTTOM; y += pitch) {
      lines.push(0, y, w, y, 0, y + b, w, y + b, 0, y + 3 * b, w, y + 3 * b);
      strong.push(0, y + 2 * b, w, y + 2 * b);
      if (L.tint) bands.push(0, y + b, w, b);
    }
    margin = [S.margin, 0, S.margin, h];
  } else if (paper === 'lin4') {
    const step = LINEATUR.lin4.line;
    for (let y = LINEATUR.top; y <= h - step; y += step) lines.push(0, y, w, y);
    margin = [S.margin, 0, S.margin, h];
  } else if (paper === 'coord') {
    // Koordinatensystem: Kästchen 5 mm wie „grid“; x- und y-Achse durch die Seitenmitte, auf einem Kästchenraster.
    const G = S.grid;
    const ox = (w % G) / 2, oy = (h % G) / 2;
    for (let x = ox; x <= w; x += G) lines.push(x, 0, x, h);
    for (let y = oy; y <= h; y += G) lines.push(0, y, w, y);
    const ax = ox + Math.round((w / 2 - ox) / G) * G; // x-Koordinate der y-Achse
    const ay = oy + Math.round((h / 2 - oy) / G) * G; // y-Koordinate der x-Achse
    strong.push(0, ay, w, ay, ax, 0, ax, h);
    // Teilstriche alle 1 cm, 2 mm lang (1 mm zu jeder Seite der Achse), ohne den Ursprung
    for (let x = ax + 100; x < w; x += 100) strong.push(x, ay - 10, x, ay + 10);
    for (let x = ax - 100; x > 0; x -= 100) strong.push(x, ay - 10, x, ay + 10);
    for (let y = ay + 100; y < h; y += 100) strong.push(ax - 10, y, ax + 10, y);
    for (let y = ay - 100; y > 0; y -= 100) strong.push(ax - 10, y, ax + 10, y);
    // Pfeilspitzen: je zwei 3-mm-Linien unter 45° am rechten Ende der x-Achse und am oberen Ende der y-Achse
    const a = 30 * Math.SQRT1_2;
    strong.push(w, ay, w - a, ay - a, w, ay, w - a, ay + a);
    strong.push(ax, 0, ax - a, a, ax, 0, ax + a, a);
  } else if (paper === 'mm') {
    // Millimeterpapier: Raster beginnt 10 mm vom linken/oberen Rand und endet mit vollen cm höchstens 10 mm vor
    // rechtem/unterem Rand. Alle 10 mm ein kräftiger Strich (strongLines), die übrigen mm-Linien normal (lines).
    const nx = Math.max(0, Math.floor((w - 200) / 100)), ny = Math.max(0, Math.floor((h - 200) / 100));
    const xe = 100 + nx * 100, ye = 100 + ny * 100;
    for (let i = 0; i <= nx * 10; i++) {
      const x = 100 + i * 10;
      if (i % 10 === 0) strong.push(x, 100, x, ye); else lines.push(x, 100, x, ye);
    }
    for (let j = 0; j <= ny * 10; j++) {
      const y = 100 + j * 10;
      if (j % 10 === 0) strong.push(100, y, xe, y); else lines.push(100, y, xe, y);
    }
  } else if (paper === 'music') {
    // Notenlinien: Systeme aus 5 Linien im Abstand 2 mm, erstes System bei 25 mm, Systemabstand 15 mm (Oberkante zu
    // Oberkante). Linien von 15 mm bis 15 mm vor dem rechten Rand; links je System eine Klammerlinie (margin).
    const x1 = 150, x2 = w - 150;
    const mg = [];
    for (let y = 250; y + 80 <= h - 150; y += 150) {
      for (let k = 0; k < 5; k++) lines.push(x1, y + 20 * k, x2, y + 20 * k);
      mg.push(x1, y, x1, y + 80);
    }
    margin = mg.length ? mg : null;
  } else if (paper === 'iso') {
    // Isometriepapier: gleichseitige Dreiecke mit Kante 5 mm. Drei Scharen: senkrecht und unter ±30° zur Waagerechten,
    // Abstand paralleler Linien 5 mm · cos 30°. Alle Segmente auf [0,w]×[0,h] abgeschnitten.
    const s = 50 * Math.sqrt(3) / 2, r3 = Math.sqrt(3) / 2;
    for (const [nx, ny] of [[1, 0], [-0.5, r3], [0.5, r3]]) {
      // Normalform nx·x + ny·y = k·s; Wertebereich über die vier Ecken bestimmen
      const v = [0, nx * w, ny * h, nx * w + ny * h];
      const kmin = Math.floor(Math.min(...v) / s), kmax = Math.ceil(Math.max(...v) / s);
      for (let k = kmin; k <= kmax; k++) {
        const seg = clipLine(nx, ny, k * s, w, h);
        if (seg) lines.push(seg[0][0], seg[0][1], seg[1][0], seg[1][1]);
      }
    }
  }
  const g = {
    lines: new Float32Array(lines),
    strongLines: new Float32Array(strong),
    dots: new Float32Array(dots),
    bands: new Float32Array(bands),
    margin,
  };
  cache.set(key, g);
  return g;
}

/**
 * Vocabulary layout for the quiz cover (page units, format `size`): columns {left: [x0, x1], right: [x0, x1]} and the writing rows
 * [[y0, y1], …] below the heading row (each row ends on a ruled line).
 */
export function vocabLayout(orient, size = 'a4') {
  const { w, h } = pageDims(size, orient);
  const split = Math.round(w * S.vocabSplit), check = w - S.vocabCheck;
  const rows = [];
  for (let y = S.vocabTop; y + S.lined <= h - S.lined; y += S.lined) rows.push([y, y + S.lined]);
  return { left: [0, split], right: [split, check], rows };
}
