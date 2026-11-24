// Vektor-PDF einer Notiz (PRD 6.5, docs/ARCHITEKTUR.md 7.1). Eigener minimaler PDF-1.4-Writer ohne Bibliotheken.
// Die Reihenfolge entspricht ink/render.js: Papier, dann alle Textmarker, dann die Stifte (je Strich ein Pfad).
// Einheiten: Seiten in 0,1 mm (ink/*), PDF in Punkt (1 pt = 1/72 Zoll) mit Ursprung unten links.
// Stifte: die Vierecke und Kreise aus penShapes werden mit nonzero gefüllt. Die Kreise laufen hier im selben
// Drehsinn wie die Vierecke (gegen den Uhrzeigersinn im PDF), sonst heben sie sich an Gelenken gegenseitig auf.

import { PAGE, HL_WIDTH, HL_ALPHA, PAPER_STYLE, penColor, hlColor } from '../config.js';
import { paperGeometry } from '../ink/paper.js';
import { penShapes } from '../ink/stroke.js';
import { decodeStrokes } from '../ink/codec.js';

const K = 72 / 254;          // 0,1 mm → pt
const KAPPA = 0.5523;        // Bezier-Näherung für einen Viertelkreis
const RULE_W = 0.35;         // Linienbreite Papier in pt
const DOT_R = 0.45;          // Radius der Papierpunkte in pt
const HL_W = HL_WIDTH * K;   // Breite des Textmarkers in pt

/** Zahl für den Content-Stream: höchstens 2 Nachkommastellen, keine Exponentschreibweise. */
function num(v) {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 100) / 100;
  if (r === 0) return '0';
  return r.toFixed(2).replace(/\.?0+$/, '');
}

/** "#rrggbb" → "r g b op" mit 3 Nachkommastellen. op = 'rg' (Füllung) oder 'RG' (Linie). */
function rgb(hex, op) {
  const n = parseInt(hex.slice(1), 16);
  const f = (sh) => (((n >> sh) & 255) / 255).toFixed(3);
  return `${f(16)} ${f(8)} ${f(0)} ${op}`;
}

/** Kreis (Mittelpunkt und Radius in pt, PDF-Raum) als Bezier-Pfad, gegen den Uhrzeigersinn. */
function circle(cx, cy, r) {
  const k = r * KAPPA;
  return `${num(cx + r)} ${num(cy)} m `
    + `${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c `
    + `${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c `
    + `${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c `
    + `${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c h`;
}

/** Content-Stream einer Seite (Papier, Textmarker, Stifte). paper/orient sind bereits geprüft. */
function contentOf(paper, orient, strokes) {
  const { h } = PAGE[orient];
  const H = h * K;
  const X = (x) => num(x * K);
  const Y = (y) => num(H - y * K);
  const ops = ['/GS0 gs'];

  // Papier
  const g = paperGeometry(paper, orient);
  if (g.lines.length) {
    const L = g.lines;
    ops.push(rgb(PAPER_STYLE.lineColor, 'RG'), `${num(RULE_W)} w`);
    for (let i = 0; i < L.length; i += 4) ops.push(`${X(L[i])} ${Y(L[i + 1])} m ${X(L[i + 2])} ${Y(L[i + 3])} l`);
    ops.push('S');
  }
  if (g.dots.length) {
    const D = g.dots;
    ops.push(rgb(PAPER_STYLE.dotColor, 'rg'));
    for (let i = 0; i < D.length; i += 2) ops.push(circle(D[i] * K, H - D[i + 1] * K, DOT_R));
    ops.push('f');
  }
  if (g.margin) {
    const m = g.margin;
    ops.push(rgb(PAPER_STYLE.marginColor, 'RG'), `${num(RULE_W)} w`);
    for (let i = 0; i < m.length; i += 4) ops.push(`${X(m[i])} ${Y(m[i + 1])} m ${X(m[i + 2])} ${Y(m[i + 3])} l`);
    ops.push('S');
  }

  // Textmarker: Mittellinie, runder Strich, Transparenz und Multiplikation wie im Canvas
  const hl = strokes.filter((s) => s.type === 'h');
  if (hl.length) {
    ops.push('/GS1 gs', `1 J 1 j ${num(HL_W)} w`);
    for (const s of hl) {
      const p = s.pts;
      const n = p.length / 3;
      if (!n) continue;
      ops.push(rgb(hlColor(s.color), 'RG'), `${X(p[0])} ${Y(p[1])} m`);
      // Einzelner Punkt: winziges Segment, damit der runde Strich als Punkt erscheint
      if (n === 1) ops.push(`${num(p[0] * K + 0.01)} ${Y(p[1])} l`);
      for (let i = 3; i < p.length; i += 3) ops.push(`${X(p[i])} ${Y(p[i + 1])} l`);
      ops.push('S');
    }
  }

  // Stifte: je Strich ein Pfad (Vierecke + Kreise), nonzero füllen
  let penGs = false;
  for (const s of strokes) {
    if (s.type === 'h') continue;
    const { circles, quads } = penShapes(s);
    if (!quads.length && !circles.length) continue;
    if (!penGs) { ops.push('/GS0 gs'); penGs = true; }
    ops.push(rgb(penColor(s.color), 'rg'));
    for (let i = 0; i < quads.length; i += 8) {
      ops.push(`${X(quads[i])} ${Y(quads[i + 1])} m ${X(quads[i + 2])} ${Y(quads[i + 3])} l ${X(quads[i + 4])} ${Y(quads[i + 5])} l ${X(quads[i + 6])} ${Y(quads[i + 7])} l h`);
    }
    for (let i = 0; i < circles.length; i += 3) ops.push(circle(circles[i] * K, H - circles[i + 1] * K, circles[i + 2] * K));
    ops.push('f');
  }
  return ops.join('\n');
}

/** Seite (Model-Zeile oder null) → {w, h} in pt und Content-Stream als Text. */
function describePage(p) {
  const orient = p && p.orient === 'l' ? 'l' : 'p';
  const paper = p && typeof p.paper === 'string' ? p.paper : 'blank';
  let strokes = [];
  if (p && typeof p.strokes === 'string') strokes = decodeStrokes(p.strokes);
  else if (p && Array.isArray(p.strokes)) strokes = p.strokes;
  const { w, h } = PAGE[orient];
  return { w: w * K, h: h * K, content: contentOf(paper, orient, strokes) };
}

function ascii(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** UTF-16BE mit BOM als Hex-String (für /Title). */
function hexString(s) {
  let h = 'FEFF';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${h.toUpperCase()}>`;
}

/**
 * Schreibt die Datei. items: [{w, h, data: Uint8Array, flate}] in pt. Objekte:
 * 1 Catalog, 2 Pages, 3 Info, 4 Resources (ExtGStates), dann je Seite Page (5+2i) und Content (6+2i).
 */
function writePdf(items, title) {
  const objs = [];
  const n = items.length;
  const kids = items.map((_, i) => `${5 + 2 * i} 0 R`).join(' ');
  const t = String(title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim() || 'Notiz';
  objs.push(['<< /Type /Catalog /Pages 2 0 R >>']);
  objs.push([`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`]);
  objs.push([`<< /Title ${hexString(t)} /Producer (Notizen) >>`]);
  objs.push([`<< /ExtGState << `
    + `/GS0 << /Type /ExtGState /CA 1 /ca 1 /BM /Normal >> `
    + `/GS1 << /Type /ExtGState /CA ${num(HL_ALPHA)} /ca ${num(HL_ALPHA)} /BM /Multiply >> >> >>`]);
  items.forEach((it, i) => {
    objs.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(it.w)} ${num(it.h)}] /Resources 4 0 R /Contents ${6 + 2 * i} 0 R >>`]);
    const filter = it.flate ? ' /Filter /FlateDecode' : '';
    objs.push([`<< /Length ${it.data.length}${filter} >>\nstream\n`, it.data, '\nendstream']);
  });

  const chunks = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? ascii(x) : x; chunks.push(b); len += b.length; };
  const offsets = [0];
  put('%PDF-1.4\n%âãÏÓ\n');
  objs.forEach((parts, i) => {
    offsets.push(len);
    put(`${i + 1} 0 obj\n`);
    for (const p of parts) put(p);
    put('\nendobj\n');
  });
  const xref = len;
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n`;
  for (let i = 1; i <= objs.length; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n\r\n`;
  put(table);
  put(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(chunks, len);
}

/**
 * Synchrones PDF aus Seiten (unkomprimiert, ohne DOM). pages: Model-Seiten {paper, orient, strokes}
 * mit strokes als String (wie gespeichert), als Array von Strichen oder null (= leere Seite mit Papier).
 * Gibt Uint8Array zurück.
 */
export function buildPdf(pages, { title = '' } = {}) {
  const items = (pages || []).map((p) => {
    const d = describePage(p);
    return { w: d.w, h: d.h, data: ascii(d.content), flate: false };
  });
  return writePdf(items, title);
}

function canCompress() {
  return typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PDF einer Notiz als Blob (application/pdf). Content-Streams werden komprimiert, wenn CompressionStream vorhanden ist. */
export async function notePdf(note, pages) {
  const list = Array.isArray(pages) && pages.length ? pages : [null];
  const compress = canCompress();
  const items = [];
  for (const p of list) {
    const d = describePage(p);
    const raw = ascii(d.content);
    let data = raw;
    let flate = false;
    if (compress) {
      try { data = await deflate(raw); flate = true; } catch { data = raw; flate = false; }
    }
    items.push({ w: d.w, h: d.h, data, flate });
  }
  return new Blob([writePdf(items, note ? note.title : '')], { type: 'application/pdf' });
}
