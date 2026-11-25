// Paper geometry (page units), shared by canvas and PDF.

import { pageDims, PAPER_STYLE as S, LINEATUR } from '../config.js';

const cache = new Map();
const LIN_BOTTOM = 150; // Schreibzeilen enden mindestens 15 mm über dem unteren Rand

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
