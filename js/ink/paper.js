// Paper geometry (page units), shared by canvas and PDF.

import { PAGE, PAPER_STYLE as S } from '../config.js';

const cache = new Map();

/**
 * {lines: Float32Array x1,y1,x2,y2,…, dots: Float32Array x,y,…, margin: [x1,y1,x2,y2, …] | null}
 * `margin` = accent segments (margin/column lines, drawn in PAPER_STYLE.marginColor); 4 numbers per segment.
 */
export function paperGeometry(paper, orient) {
  const key = paper + orient;
  if (cache.has(key)) return cache.get(key);
  const { w, h } = PAGE[orient] || PAGE.p;
  const lines = [];
  const dots = [];
  let margin = null;
  if (paper === 'lined') {
    for (let y = S.linedTop; y <= h - S.lined; y += S.lined) lines.push(0, y, w, y);
    margin = [S.margin, 0, S.margin, h];
  } else if (paper === 'grid') {
    const ox = (w % S.grid) / 2, oy = (h % S.grid) / 2;
    for (let x = ox; x <= w; x += S.grid) lines.push(x, 0, x, h);
    for (let y = oy; y <= h; y += S.grid) lines.push(0, y, w, y);
  } else if (paper === 'vocab') {
    // Vocabulary: lines, divider word | translation, narrow tick column on the right.
    for (let y = S.vocabTop; y <= h - S.lined; y += S.lined) lines.push(0, y, w, y);
    const split = Math.round(w * S.vocabSplit), check = w - S.vocabCheck, top = S.vocabTop - S.lined;
    margin = [split, top, split, h, check, top, check, h];
  } else if (paper === 'dotted') {
    const ox = (w % S.dotted) / 2 || S.dotted, oy = (h % S.dotted) / 2 || S.dotted;
    for (let y = oy; y < h; y += S.dotted) for (let x = ox; x < w; x += S.dotted) dots.push(x, y);
  }
  const g = { lines: new Float32Array(lines), dots: new Float32Array(dots), margin };
  cache.set(key, g);
  return g;
}
