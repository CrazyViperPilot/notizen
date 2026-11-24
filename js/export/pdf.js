// Vektor-PDF einer Notiz (PRD 6.5, docs/ARCHITEKTUR.md 7.1 und 10.1). Eigener minimaler PDF-1.4-Writer ohne Bibliotheken.
// Die Reihenfolge entspricht ink/render.js: Weiß, Hintergrundbild (page.bg), Papier, dann alle Textmarker, dann die Stifte
// (je Strich ein Pfad). Einheiten: Seiten in 0,1 mm (ink/*), PDF in Punkt (1 pt = 1/72 Zoll) mit Ursprung unten links.
// Stifte: die Vierecke und Kreise aus penShapes werden mit nonzero gefüllt. Die Kreise laufen hier im selben
// Drehsinn wie die Vierecke (gegen den Uhrzeigersinn im PDF), sonst heben sie sich an Gelenken gegenseitig auf.
// Hintergrundbilder: JPEG-Bytes unverändert als Image-XObject (DCTDecode), ein Objekt je Asset.

import { PAGE, HL_WIDTH, HL_ALPHA, PAPER_STYLE, penColor, hlColor } from '../config.js';
import { paperGeometry } from '../ink/paper.js';
import { penShapes } from '../ink/stroke.js';
import { decodeStrokes } from '../ink/codec.js';
import { imageRect } from '../ink/render.js';

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

/** Ressourcen-Eintrag ExtGState (Transparenz und Multiplikation für den Textmarker). Gemeinsam für alle Seiten. */
const EXT_GS = `<< /GS0 << /Type /ExtGState /CA 1 /ca 1 /BM /Normal >> `
  + `/GS1 << /Type /ExtGState /CA ${num(HL_ALPHA)} /ca ${num(HL_ALPHA)} /BM /Multiply >> >>`;

/**
 * Hintergrundbild nach ARCHITEKTUR 10.1 (contain, zentriert): erst Weiß, dann das Bild (Image-XObject /Im1).
 * img = {w, h} in Bildpixeln (aus jpegInfo). Die Lage kommt von imageRect (0,1 mm, Ursprung oben links) und
 * wird hier in pt mit Ursprung unten links umgerechnet.
 */
function bgOps(orient, img) {
  const { w, h } = PAGE[orient];
  const [x, y, rw, rh] = imageRect({ orient }, img.w, img.h);
  return [
    rgb('#ffffff', 'rg'),
    `0 0 ${num(w * K)} ${num(h * K)} re f`,
    `q ${num(rw * K)} 0 0 ${num(rh * K)} ${num(x * K)} ${num((h - y - rh) * K)} cm /Im1 Do Q`,
  ];
}

/** Content-Stream einer Seite (Hintergrund, Papier, Textmarker, Stifte). paper/orient sind bereits geprüft. img: jpegInfo-Ergebnis oder null. */
function contentOf(paper, orient, strokes, img = null) {
  const { h } = PAGE[orient];
  const H = h * K;
  const X = (x) => num(x * K);
  const Y = (y) => num(H - y * K);
  const ops = ['/GS0 gs'];

  // Hintergrundbild (vor dem Papier)
  if (img) ops.push(...bgOps(orient, img));

  // Papier
  const g = paperGeometry(paper, orient);
  // Getönte Schreibbänder vor den Linien: x y w h re f (Ursprung unten links → Unterkante = y + h)
  if (g.bands.length) {
    const B = g.bands;
    ops.push(rgb(PAPER_STYLE.bandColor, 'rg'));
    for (let i = 0; i < B.length; i += 4) ops.push(`${X(B[i])} ${Y(B[i + 1] + B[i + 3])} ${num(B[i + 2] * K)} ${num(B[i + 3] * K)} re f`);
  }
  if (g.lines.length) {
    const L = g.lines;
    ops.push(rgb(PAPER_STYLE.lineColor, 'RG'), `${num(RULE_W)} w`);
    for (let i = 0; i < L.length; i += 4) ops.push(`${X(L[i])} ${Y(L[i + 1])} m ${X(L[i + 2])} ${Y(L[i + 3])} l`);
    ops.push('S');
  }
  // Kräftigere Grundlinien (1,6-fache Breite)
  if (g.strongLines.length) {
    const T = g.strongLines;
    ops.push(rgb(PAPER_STYLE.lineColor, 'RG'), `${num(RULE_W * 1.6)} w`);
    for (let i = 0; i < T.length; i += 4) ops.push(`${X(T[i])} ${Y(T[i + 1])} m ${X(T[i + 2])} ${Y(T[i + 3])} l`);
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

/** Seite (Model-Zeile oder null) → {w, h} in pt und Content-Stream als Text. img: jpegInfo-Ergebnis oder null. */
function describePage(p, img = null) {
  const orient = p && p.orient === 'l' ? 'l' : 'p';
  const paper = p && typeof p.paper === 'string' ? p.paper : 'blank';
  let strokes = [];
  if (p && typeof p.strokes === 'string') strokes = decodeStrokes(p.strokes);
  else if (p && Array.isArray(p.strokes)) strokes = p.strokes;
  const { w, h } = PAGE[orient];
  return { w: w * K, h: h * K, content: contentOf(paper, orient, strokes, img) };
}

/**
 * Liest Breite, Höhe, Komponentenzahl und Bit-Tiefe aus einem JPEG (SOF0/SOF1/SOF2-Segment).
 * Gibt {w, h, comps} zurück, sonst null (kein JPEG, keine 8 Bit, Komponentenzahl ≠ 1, 3, 4).
 */
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const m = bytes[i + 1];
    if (m === 0xff) { i++; continue; }          // Füllbyte
    i += 2;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // SOI, TEM, RSTn: ohne Länge
    if (m === 0xd9 || m === 0xda) return null;  // EOI oder SOS vor einem SOF
    if (i + 2 > bytes.length) return null;
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      const p = i + 2;
      if (p + 6 > bytes.length) return null;
      const precision = bytes[p];
      const h = (bytes[p + 1] << 8) | bytes[p + 2];
      const w = (bytes[p + 3] << 8) | bytes[p + 4];
      const comps = bytes[p + 5];
      if (precision !== 8 || !(w > 0 && h > 0)) return null;
      if (comps !== 1 && comps !== 3 && comps !== 4) return null;
      return { w, h, comps };
    }
    i += len;
  }
  return null;
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

/** Farbraum je Komponentenzahl. CMYK-JPEGs mit /Decode wie vorgegeben. */
const COLOR_SPACE = {
  1: { cs: '/DeviceGray', decode: '' },
  3: { cs: '/DeviceRGB', decode: '' },
  4: { cs: '/DeviceCMYK', decode: ' /Decode [1 0 1 0 1 0 1 0]' },
};

/** Bytes (Uint8Array oder ArrayBuffer) → Uint8Array, sonst null. */
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

/** Asset-id eines Seitenhintergrunds oder null. */
function bgId(p) {
  return p && typeof p.bg === 'string' && p.bg ? p.bg : null;
}

/**
 * Ordnet jeder Seite ihr Hintergrundbild zu. Gleiches Asset → ein Eintrag in imgs (= ein Bild-Objekt).
 * bytesOf(id) → Uint8Array|null. Fehlt das Bild oder ist es kein gültiges JPEG, bekommt die Seite keins.
 * Rückgabe: {imgs: [{bytes, w, h, comps}], pages: [{p, no}]} mit no = Index in imgs oder null.
 */
function layout(list, bytesOf) {
  const imgs = [];
  const index = new Map(); // asset id → Index in imgs, oder -1 (nicht verwendbar)
  const pages = list.map((p) => {
    const id = bgId(p);
    if (!id) return { p, no: null };
    if (!index.has(id)) {
      const bytes = bytesOf(id);
      const info = bytes ? jpegInfo(bytes) : null;
      if (info) {
        index.set(id, imgs.length);
        imgs.push({ bytes, w: info.w, h: info.h, comps: info.comps });
      } else {
        index.set(id, -1);
      }
    }
    const no = index.get(id);
    return { p, no: no >= 0 ? no : null };
  });
  return { imgs, pages };
}

/** Bild aus buildPdf-Option images (Map oder Objekt assetId → Bytes). */
function lookupBytes(images, id) {
  if (!images) return null;
  const v = images instanceof Map ? images.get(id) : (Object.prototype.hasOwnProperty.call(images, id) ? images[id] : null);
  return toBytes(v);
}

/**
 * Schreibt die Datei. items: [{w, h, data, flate, img}] in pt (img = Index in imgs oder null), imgs: [{bytes, w, h, comps}].
 * Objekte: 1 Catalog, 2 Pages, 3 Info, 4 Resources (ExtGStates), dann je Seite Page (5+2i) und Content (6+2i),
 * danach je Bild ein Image-XObject (ab 5+2n).
 */
function writePdf(items, title, imgs = []) {
  const objs = [];
  const n = items.length;
  const firstImg = 5 + 2 * n;   // Objektnummer des ersten Bild-XObjects
  const kids = items.map((_, i) => `${5 + 2 * i} 0 R`).join(' ');
  const t = String(title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim() || 'Notiz';
  objs.push(['<< /Type /Catalog /Pages 2 0 R >>']);
  objs.push([`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`]);
  objs.push([`<< /Title ${hexString(t)} /Producer (Notizen) >>`]);
  objs.push([`<< /ExtGState ${EXT_GS} >>`]);
  items.forEach((it, i) => {
    const res = it.img == null
      ? '4 0 R'
      : `<< /ExtGState ${EXT_GS} /XObject << /Im1 ${firstImg + it.img} 0 R >> >>`;
    objs.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(it.w)} ${num(it.h)}] /Resources ${res} /Contents ${6 + 2 * i} 0 R >>`]);
    const filter = it.flate ? ' /Filter /FlateDecode' : '';
    objs.push([`<< /Length ${it.data.length}${filter} >>\nstream\n`, it.data, '\nendstream']);
  });
  for (const im of imgs) {
    const c = COLOR_SPACE[im.comps];
    objs.push([`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${c.cs} /BitsPerComponent 8${c.decode} `
      + `/Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream']);
  }

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
 * Synchrones PDF aus Seiten (unkomprimiert, ohne DOM). pages: Model-Seiten {paper, orient, strokes, bg}
 * mit strokes als String (wie gespeichert), als Array von Strichen oder null (= leere Seite mit Papier).
 * images: Map oder Objekt assetId → JPEG-Bytes (Uint8Array) für die bg-Ids der Seiten. Fehlt ein Bild, bleibt die Seite ohne Bild.
 * Gibt Uint8Array zurück.
 */
export function buildPdf(pages, { title = '', images = null } = {}) {
  const { imgs, pages: laid } = layout(pages || [], (id) => lookupBytes(images, id));
  const items = laid.map(({ p, no }) => {
    const d = describePage(p, no == null ? null : imgs[no]);
    return { w: d.w, h: d.h, data: ascii(d.content), flate: false, img: no };
  });
  return writePdf(items, title, imgs);
}

function canCompress() {
  return typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * PDF einer Notiz als Blob (application/pdf). Content-Streams werden komprimiert, wenn CompressionStream vorhanden ist.
 * opts.getAssetBytes(id) → Promise<Uint8Array|null>: JPEG-Bytes eines Hintergrundbilds. Jedes Asset wird nur einmal geholt.
 */
export async function notePdf(note, pages, { getAssetBytes = null } = {}) {
  const list = Array.isArray(pages) && pages.length ? pages : [null];
  const bytes = new Map();
  if (typeof getAssetBytes === 'function') {
    for (const p of list) {
      const id = bgId(p);
      if (!id || bytes.has(id)) continue;
      let b = null;
      try { b = await getAssetBytes(id); } catch { b = null; }
      bytes.set(id, toBytes(b));
    }
  }
  const { imgs, pages: laid } = layout(list, (id) => bytes.get(id) || null);
  const compress = canCompress();
  const items = [];
  for (const { p, no } of laid) {
    const d = describePage(p, no == null ? null : imgs[no]);
    const raw = ascii(d.content);
    let data = raw;
    let flate = false;
    if (compress) {
      try { data = await deflate(raw); flate = true; } catch { data = raw; flate = false; }
    }
    items.push({ w: d.w, h: d.h, data, flate, img: no });
  }
  return new Blob([writePdf(items, note ? note.title : '', imgs)], { type: 'application/pdf' });
}
