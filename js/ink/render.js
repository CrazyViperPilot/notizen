// Canvas drawing. All functions expect ctx's transform to map page units (0.1 mm) to device pixels;
// `scale` = device pixels per page unit (used for minimum line widths).

import { PAGE, HL_WIDTH, HL_ALPHA, PAPER_STYLE, penColor, hlColor } from '../config.js';
import { paperGeometry } from './paper.js';
import { penShapes, bbox } from './stroke.js';

/** Sets ctx so that page units map to device pixels with origin (ox, oy) in device pixels. */
export function setPageTransform(ctx, scale, ox = 0, oy = 0) {
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
}

/** Where a background image of iw×ih pixels lies on the page ("contain", centered): [x, y, w, h] in page units. */
export function imageRect(page, iw, ih) {
  const { w, h } = PAGE[page.orient] || PAGE.p;
  if (!(iw > 0 && ih > 0)) return [0, 0, w, h];
  const f = Math.min(w / iw, h / ih);
  const rw = iw * f, rh = ih * f;
  return [(w - rw) / 2, (h - rh) / 2, rw, rh];
}

/** `img`: decoded background image (page.bg) or null. */
export function drawPaper(ctx, page, scale, clip = null, img = null) {
  const { w, h } = PAGE[page.orient] || PAGE.p;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (img) {
    const r = imageRect(page, img.width, img.height);
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, r[0], r[1], r[2], r[3]);
    ctx.restore();
  }
  const g = paperGeometry(page.paper, page.orient);
  const lw = Math.max(1.6, 0.9 / scale);
  if (g.lines.length) {
    ctx.beginPath();
    for (let i = 0; i < g.lines.length; i += 4) {
      const x1 = g.lines[i], y1 = g.lines[i + 1], x2 = g.lines[i + 2], y2 = g.lines[i + 3];
      if (clip && (Math.max(x1, x2) < clip[0] || Math.min(x1, x2) > clip[2] || Math.max(y1, y2) < clip[1] || Math.min(y1, y2) > clip[3])) continue;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.strokeStyle = PAPER_STYLE.lineColor;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  if (g.dots.length) {
    const r = Math.min(10, Math.max(3, 1.2 / scale)); // capped: tiny previews would turn into a grey area
    ctx.fillStyle = PAPER_STYLE.dotColor;
    ctx.beginPath();
    for (let i = 0; i < g.dots.length; i += 2) {
      const x = g.dots[i], y = g.dots[i + 1];
      if (clip && (x < clip[0] - r || x > clip[2] + r || y < clip[1] - r || y > clip[3] + r)) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  if (g.margin) {
    ctx.beginPath();
    for (let i = 0; i < g.margin.length; i += 4) {
      ctx.moveTo(g.margin[i], g.margin[i + 1]);
      ctx.lineTo(g.margin[i + 2], g.margin[i + 3]);
    }
    ctx.strokeStyle = PAPER_STYLE.marginColor;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

/** Adds pen shapes (from point index `from`) to the current path. */
export function tracePen(ctx, stroke, from = 0) {
  const { circles, quads } = penShapes(stroke, from);
  for (let i = 0; i < quads.length; i += 8) {
    ctx.moveTo(quads[i], quads[i + 1]);
    ctx.lineTo(quads[i + 2], quads[i + 3]);
    ctx.lineTo(quads[i + 4], quads[i + 5]);
    ctx.lineTo(quads[i + 6], quads[i + 7]);
    ctx.closePath();
  }
  for (let i = 0; i < circles.length; i += 3) {
    ctx.moveTo(circles[i] + circles[i + 2], circles[i + 1]);
    ctx.arc(circles[i], circles[i + 1], circles[i + 2], 0, Math.PI * 2, true); // same winding as the quads (nonzero union)
  }
}

export function drawPen(ctx, stroke, from = 0) {
  ctx.beginPath();
  tracePen(ctx, stroke, from);
  ctx.fillStyle = penColor(stroke.color);
  ctx.fill('nonzero');
}

export function drawHighlighter(ctx, stroke) {
  const p = stroke.pts;
  ctx.save();
  ctx.globalAlpha = HL_ALPHA;
  ctx.globalCompositeOperation = 'multiply';
  ctx.strokeStyle = hlColor(stroke.color);
  ctx.lineWidth = HL_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  if (p.length === 3) ctx.lineTo(p[0] + 0.01, p[1]);
  for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i], p[i + 1]);
  ctx.stroke();
  ctx.restore();
}

export function drawStroke(ctx, stroke) {
  if (stroke.type === 'h') drawHighlighter(ctx, stroke);
  else drawPen(ctx, stroke);
}

function visible(stroke, clip) {
  if (!clip) return true;
  const b = bbox(stroke);
  return !(b[2] < clip[0] || b[0] > clip[2] || b[3] < clip[1] || b[1] > clip[3]);
}

/** Paper, then all highlighters, then all pens. `clip` = [x0, y0, x1, y1] in page units to skip invisible strokes. */
export function drawPage(ctx, page, strokes, scale, clip = null, img = null) {
  drawPaper(ctx, page, scale, clip, img);
  for (const s of strokes) if (s.type === 'h' && visible(s, clip)) drawHighlighter(ctx, s);
  for (const s of strokes) if (s.type !== 'h' && visible(s, clip)) drawPen(ctx, s);
}
