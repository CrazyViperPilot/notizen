// Vektor-PDF einer Notiz (PRD 6.5, docs/ARCHITEKTUR.md 7.1 und 10.1). Eigener minimaler PDF-1.4-Writer ohne Bibliotheken.
// Die Reihenfolge entspricht ink/render.js: Weiß, Hintergrundbild (page.bg), Papier, dann alle Textmarker, dann die Stifte
// (je Strich ein Pfad). Einheiten: Seiten in 0,1 mm (ink/*), PDF in Punkt (1 pt = 1/72 Zoll) mit Ursprung unten links.
// Stifte: die Vierecke und Kreise aus penShapes werden mit nonzero gefüllt. Die Kreise laufen hier im selben
// Drehsinn wie die Vierecke (gegen den Uhrzeigersinn im PDF), sonst heben sie sich an Gelenken gegenseitig auf.
// Bleistift (Typ 'b'): wie Stift, aber mit /GS2 (Deckkraft PENCIL_ALPHA), in Zeichenreihenfolge zwischen den Stiften.
// Hintergrundbilder: JPEG-Bytes unverändert als Image-XObject (DCTDecode), ein Objekt je Asset.
// Seitenformate DIN A4/A5/A3 (page.size, Standard A4). Optional ein Titelblatt (cover, aus export/cover.js) als erste Seite:
// Flächen und Linien als Vektoren, Texte als Graustufenbilder (keine Schriften nötig).
// Optional PDF/A-2b (pdfa: true): PDF 1.7, XMP-Metadaten, sRGB-OutputIntent (ICC-Profil aus srgbIcc), Datei-ID im Trailer.
// CMYK-JPEGs passen nicht zum sRGB-OutputIntent und werden im PDF/A weggelassen (der Import erzeugt nur RGB-JPEGs).

import { pageDims, sizeOf, HL_WIDTH, HL_ALPHA, PENCIL_ALPHA, PAPER_STYLE, penColor, hlColor } from '../config.js';
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

/**
 * Ressourcen-Eintrag ExtGState: GS0 deckend (Stift), GS1 Textmarker (Multiplikation), GS2 Bleistift (halbtransparent,
 * Normal-Blend wie im Canvas). Gemeinsam für alle Seiten.
 */
const EXT_GS = `<< /GS0 << /Type /ExtGState /CA 1 /ca 1 /BM /Normal >> `
  + `/GS1 << /Type /ExtGState /CA ${num(HL_ALPHA)} /ca ${num(HL_ALPHA)} /BM /Multiply >> `
  + `/GS2 << /Type /ExtGState /CA ${num(PENCIL_ALPHA)} /ca ${num(PENCIL_ALPHA)} /BM /Normal >> >>`;

/**
 * Hintergrundbild nach ARCHITEKTUR 10.1 (contain, zentriert): erst Weiß, dann das Bild (Image-XObject /Im1).
 * img = {w, h} in Bildpixeln (aus jpegInfo). Die Lage kommt von imageRect (0,1 mm, Ursprung oben links) und
 * wird hier in pt mit Ursprung unten links umgerechnet.
 */
function bgOps(orient, size, img) {
  const { w, h } = pageDims(size, orient);
  const [x, y, rw, rh] = imageRect({ orient, size }, img.w, img.h);
  return [
    rgb('#ffffff', 'rg'),
    `0 0 ${num(w * K)} ${num(h * K)} re f`,
    `q ${num(rw * K)} 0 0 ${num(rh * K)} ${num(x * K)} ${num((h - y - rh) * K)} cm /Im1 Do Q`,
  ];
}

/** Content-Stream einer Seite (Hintergrund, Papier, Textmarker, Stifte). paper/orient sind bereits geprüft. img: jpegInfo-Ergebnis oder null. */
function contentOf(paper, orient, size, strokes, img = null) {
  const { h } = pageDims(size, orient);
  const H = h * K;
  const X = (x) => num(x * K);
  const Y = (y) => num(H - y * K);
  const ops = ['/GS0 gs'];

  // Hintergrundbild (vor dem Papier)
  if (img) ops.push(...bgOps(orient, size, img));

  // Papier
  const g = paperGeometry(paper, orient, size);
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

  // Stifte und Bleistifte: je Strich ein Pfad (Vierecke + Kreise), nonzero füllen. Der aktive Zustand ist nach den
  // Textmarkern GS1, sonst GS0 (Ausgangszustand des Streams); nur bei einem Wechsel wird /GS… neu gesetzt.
  let gsNow = hl.length ? '/GS1' : '/GS0';
  for (const s of strokes) {
    if (s.type === 'h') continue;
    const { circles, quads } = penShapes(s);
    if (!quads.length && !circles.length) continue;
    const gs = s.type === 'b' ? '/GS2' : '/GS0';
    if (gs !== gsNow) { ops.push(`${gs} gs`); gsNow = gs; }
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
  const size = sizeOf(p);
  const paper = p && typeof p.paper === 'string' ? p.paper : 'blank';
  let strokes = [];
  if (p && typeof p.strokes === 'string') strokes = decodeStrokes(p.strokes);
  else if (p && Array.isArray(p.strokes)) strokes = p.strokes;
  const { w, h } = pageDims(size, orient);
  return { w: w * K, h: h * K, content: contentOf(paper, orient, size, strokes, img) };
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
 * bytesOf(id) → Uint8Array|null. Fehlt das Bild oder ist es kein gültiges JPEG, bekommt die Seite keins
 * (im PDF/A auch nicht bei CMYK).
 * Rückgabe: {imgs: [{bytes, w, h, comps}], pages: [{p, no}]} mit no = Index in imgs oder null.
 */
function layout(list, bytesOf, pdfa = false) {
  const imgs = [];
  const index = new Map(); // asset id → Index in imgs, oder -1 (nicht verwendbar)
  const pages = list.map((p) => {
    const id = bgId(p);
    if (!id) return { p, no: null };
    if (!index.has(id)) {
      const bytes = bytesOf(id);
      const info = bytes ? jpegInfo(bytes) : null;
      if (info && !(pdfa && info.comps === 4)) {
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

/** Image-XObject (Kopf ohne /Length und Daten) eines Hintergrund-JPEGs. */
function jpegXObject(im) {
  const c = COLOR_SPACE[im.comps];
  return { head: `/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${c.cs} /BitsPerComponent 8${c.decode} /Filter /DCTDecode`, data: im.bytes };
}

// ───────────────────────── Titelblatt ─────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;
const fin = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Titelblatt (Cover-Objekt aus export/cover.js) → {w, h, content, texts: [{w, h, gray}]} in pt.
 * cover = {size, orient, boxes: [{x, y, w, h, color}], lines: [{x1, y1, x2, y2, width, color}],
 *          texts: [{x, y, w, h, img: {w, h, gray: Uint8Array}}]} in 0,1 mm, Ursprung oben links.
 * Text-Bilder mit falscher Pixelzahl werden übersprungen. Die Bilder heißen im Content-Stream /T0, /T1, …
 */
export function coverPage(cover, fallback = { size: 'a4', orient: 'p' }) {
  const orient = cover.orient === 'l' || cover.orient === 'p' ? cover.orient : fallback.orient === 'l' ? 'l' : 'p';
  const size = sizeOf({ size: cover.size || fallback.size });
  const { w, h } = pageDims(size, orient);
  const H = h * K;
  const X = (x) => num(fin(x) * K);
  const Y = (y) => num(H - fin(y) * K);
  const ops = ['/GS0 gs', rgb('#ffffff', 'rg'), `0 0 ${num(w * K)} ${num(H)} re f`];
  for (const b of Array.isArray(cover.boxes) ? cover.boxes : []) {
    if (!b || !(b.w > 0 && b.h > 0)) continue;
    ops.push(rgb(HEX.test(b.color) ? b.color : '#000000', 'rg'), `${X(b.x)} ${Y(fin(b.y) + b.h)} ${num(b.w * K)} ${num(b.h * K)} re f`);
  }
  for (const l of Array.isArray(cover.lines) ? cover.lines : []) {
    if (!l) continue;
    ops.push(rgb(HEX.test(l.color) ? l.color : '#000000', 'RG'), `${num(Math.max(0.1, fin(l.width) * K))} w 0 J`,
      `${X(l.x1)} ${Y(l.y1)} m ${X(l.x2)} ${Y(l.y2)} l S`);
  }
  const texts = [];
  for (const t of Array.isArray(cover.texts) ? cover.texts : []) {
    const im = t && t.img;
    if (!im || !(im.w > 0 && im.h > 0) || !(im.gray instanceof Uint8Array) || im.gray.length !== im.w * im.h) continue;
    if (!(t.w > 0 && t.h > 0)) continue;
    ops.push(`q ${num(t.w * K)} 0 0 ${num(t.h * K)} ${X(t.x)} ${Y(fin(t.y) + t.h)} cm /T${texts.length} Do Q`);
    texts.push({ w: im.w, h: im.h, gray: im.gray });
  }
  return { w: w * K, h: H, content: ops.join('\n'), texts };
}

/** Image-XObject eines Text-Bilds (DeviceGray, 8 Bit). data ggf. schon komprimiert (flate). */
function grayXObject(t, data, flate) {
  return { head: `/Type /XObject /Subtype /Image /Width ${t.w} /Height ${t.h} /ColorSpace /DeviceGray /BitsPerComponent 8${flate ? ' /Filter /FlateDecode' : ''}`, data };
}

// ───────────────────────── PDF/A ─────────────────────────

let iccCache = null;

/**
 * Kleines ICC-v2-Monitorprofil für sRGB (IEC 61966-2.1): Primärvalenzen nach D50 adaptiert (Bradford),
 * Tonwertkurve als Tabelle mit 256 Stützstellen. Für den OutputIntent von PDF/A.
 */
export function srgbIcc() {
  if (iccCache) return iccCache;
  const tags = [];
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = (v) => [(v >>> 8) & 255, v & 255];
  const sig = (s) => [...s].map((c) => c.charCodeAt(0));
  const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
  const xyz = (x, y, z) => [...sig('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const name = 'sRGB IEC61966-2.1';
  const desc = [...sig('desc'), 0, 0, 0, 0, ...u32(name.length + 1), ...sig(name), 0, ...u32(0), ...u32(0), ...u16(0), 0, ...new Array(67).fill(0)];
  const cprt = [...sig('text'), 0, 0, 0, 0, ...sig('No copyright, use freely'), 0];
  const curve = [...sig('curv'), 0, 0, 0, 0, ...u32(256)];
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    curve.push(...u16(Math.round(lin * 65535)));
  }
  tags.push(['desc', desc], ['cprt', cprt], ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)], ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', curve], ['gTRC', curve], ['bTRC', curve]);
  // Datenblöcke (4-Byte-ausgerichtet); gleiche Daten (die drei Kurven) nur einmal.
  const blocks = [];
  const at = new Map();
  let off = 128 + 4 + 12 * tags.length;
  const entries = tags.map(([t, d]) => {
    if (!at.has(d)) {
      at.set(d, off);
      const pad = (4 - (d.length % 4)) % 4;
      blocks.push(d, new Array(pad).fill(0));
      off += d.length + pad;
    }
    return [...sig(t), ...u32(at.get(d)), ...u32(d.length)];
  });
  const size = off;
  const head = [...u32(size), 0, 0, 0, 0, 2, 0x10, 0, 0, ...sig('mntr'), ...sig('RGB '), ...sig('XYZ '),
    ...u16(2026), ...u16(1), ...u16(1), 0, 0, 0, 0, 0, 0, ...sig('acsp'), ...new Array(4 + 4 + 4 + 4 + 8).fill(0),
    ...u32(0), ...s15(0.9642), ...s15(1), ...s15(0.8249), ...new Array(4 + 16 + 28).fill(0)];
  const out = new Uint8Array(size);
  let o = 0;
  for (const part of [head, u32(tags.length), ...entries, ...blocks]) { out.set(part, o); o += part.length; }
  iccCache = out;
  return out;
}

/** Datum → [PDF-Datum "D:YYYYMMDDHHmmSS+00'00'", XMP-Datum "YYYY-MM-DDTHH:mm:SS+00:00"] (UTC, beide gleich). */
function pdfDates(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const Y = p(d.getUTCFullYear(), 4), M = p(d.getUTCMonth() + 1), D = p(d.getUTCDate());
  const h = p(d.getUTCHours()), m = p(d.getUTCMinutes()), s = p(d.getUTCSeconds());
  return [`D:${Y}${M}${D}${h}${m}${s}+00'00'`, `${Y}-${M}-${D}T${h}:${m}:${s}+00:00`];
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** XMP-Paket für PDF/A-2b; Werte wie im Info-Dictionary. */
function xmpPacket(title, xmpDate) {
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
    + ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n'
    + '<dc:format>application/pdf</dc:format>\n'
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>\n`
    + `<xmp:CreateDate>${xmpDate}</xmp:CreateDate>\n<xmp:ModifyDate>${xmpDate}</xmp:ModifyDate>\n<xmp:MetadataDate>${xmpDate}</xmp:MetadataDate>\n`
    + '<xmp:CreatorTool>Notizen</xmp:CreatorTool>\n<pdf:Producer>Notizen</pdf:Producer>\n'
    + '<pdfaid:part>2</pdfaid:part>\n<pdfaid:conformance>B</pdfaid:conformance>\n'
    + '</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
}

function utf8(s) {
  return new TextEncoder().encode(s);
}

/** 16 Bytes als Hex (FNV-1a in vier Bahnen) über die Seiteninhalte, Titel und Datum: Datei-ID für den Trailer. */
function fileId(parts) {
  const h = [0x811c9dc5, 0x01000193 ^ 0x5bd1e995, 0x9e3779b9, 0x85ebca6b];
  for (const part of parts) {
    const b = typeof part === 'string' ? utf8(part) : part;
    for (let i = 0; i < b.length; i++) {
      for (let k = 0; k < 4; k++) h[k] = Math.imul(h[k] ^ (b[i] + k), 0x01000193) >>> 0;
    }
  }
  return h.map((v) => v.toString(16).padStart(8, '0')).join('').toUpperCase();
}

// ───────────────────────── Datei ─────────────────────────

/** Titel ohne Steuerzeichen und ohne einzelne Surrogate (sonst wichen Info und XMP voneinander ab). */
function cleanTitle(title) {
  return String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�').trim() || 'Notiz';
}

/**
 * Schreibt die Datei. items: [{w, h, data, flate, xo: [[name, index], …]}] in pt (xo = Bilder der Seite, Index in xobjs),
 * xobjs: [{head, data}] (Image-XObjects). opts: {pdfa, date}.
 * Objekte: 1 Catalog, 2 Pages, 3 Info, 4 Resources (ExtGStates), dann je Seite Page (5+2i) und Content (6+2i),
 * danach die Bild-XObjects (ab 5+2n), im PDF/A zuletzt Metadaten (XMP) und das ICC-Profil.
 */
function writePdf(items, title, xobjs = [], { pdfa = false, date = new Date() } = {}) {
  const objs = [];
  const n = items.length;
  const firstX = 5 + 2 * n;      // Objektnummer des ersten Bild-XObjects
  const metaNo = firstX + xobjs.length, iccNo = metaNo + 1;
  const kids = items.map((_, i) => `${5 + 2 * i} 0 R`).join(' ');
  const t = cleanTitle(title);
  const [pdfDate, xmpDate] = pdfDates(date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date());
  const pdfaCat = pdfa
    ? ` /Metadata ${metaNo} 0 R /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1)`
      + ` /RegistryName (http://www.color.org) /Info (sRGB IEC61966-2.1) /DestOutputProfile ${iccNo} 0 R >>]`
    : '';
  objs.push([`<< /Type /Catalog /Pages 2 0 R${pdfaCat} >>`]);
  objs.push([`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`]);
  objs.push([`<< /Title ${hexString(t)} /Producer (Notizen)${pdfa ? ` /Creator (Notizen) /CreationDate (${pdfDate}) /ModDate (${pdfDate})` : ''} >>`]);
  objs.push([`<< /ExtGState ${EXT_GS} >>`]);
  items.forEach((it, i) => {
    const xo = it.xo || [];
    const res = !xo.length
      ? '4 0 R'
      : `<< /ExtGState ${EXT_GS} /XObject << ${xo.map(([name, k]) => `/${name} ${firstX + k} 0 R`).join(' ')} >> >>`;
    objs.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(it.w)} ${num(it.h)}] /Resources ${res} /Contents ${6 + 2 * i} 0 R >>`]);
    const filter = it.flate ? ' /Filter /FlateDecode' : '';
    objs.push([`<< /Length ${it.data.length}${filter} >>\nstream\n`, it.data, '\nendstream']);
  });
  for (const x of xobjs) objs.push([`<< ${x.head} /Length ${x.data.length} >>\nstream\n`, x.data, '\nendstream']);
  if (pdfa) {
    const meta = utf8(xmpPacket(t, xmpDate));
    objs.push([`<< /Type /Metadata /Subtype /XML /Length ${meta.length} >>\nstream\n`, meta, '\nendstream']);
    const icc = srgbIcc();
    objs.push([`<< /N 3 /Length ${icc.length} >>\nstream\n`, icc, '\nendstream']);
  }

  const chunks = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? ascii(x) : x; chunks.push(b); len += b.length; };
  const offsets = [0];
  put(`%PDF-${pdfa ? '1.7' : '1.4'}\n%âãÏÓ\n`);
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
  const id = pdfa ? fileId([t, pdfDate, String(n), ...items.map((it) => it.data)]) : '';
  put(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R${pdfa ? ` /ID [<${id}> <${id}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(chunks, len);
}

/**
 * Seiten und Titelblatt → {items, xobjs} für writePdf. pack(bytes) → {data, flate} (komprimieren oder nicht).
 * Das Titelblatt bekommt Format und Ausrichtung der ersten Seite, wenn es selbst keine nennt.
 */
async function assemble(laid, imgs, cover, pack) {
  const xobjs = imgs.map(jpegXObject);
  const items = [];
  if (cover && typeof cover === 'object') {
    const first = laid.length ? laid[0].p : null;
    const c = coverPage(cover, { size: sizeOf(first), orient: first && first.orient === 'l' ? 'l' : 'p' });
    const xo = [];
    for (const t of c.texts) {
      const z = await pack(t.gray);
      xo.push([`T${xo.length}`, xobjs.length]);
      xobjs.push(grayXObject(t, z.data, z.flate));
    }
    items.push({ w: c.w, h: c.h, ...(await pack(ascii(c.content))), xo });
  }
  for (const { p, no } of laid) {
    const d = describePage(p, no == null ? null : imgs[no]);
    items.push({ w: d.w, h: d.h, ...(await pack(ascii(d.content))), xo: no == null ? [] : [['Im1', no]] });
  }
  return { items, xobjs };
}

/** Wie assemble, aber synchron und unkomprimiert (für buildPdf). */
function assembleSync(laid, imgs, cover) {
  const xobjs = imgs.map(jpegXObject);
  const items = [];
  if (cover && typeof cover === 'object') {
    const first = laid.length ? laid[0].p : null;
    const c = coverPage(cover, { size: sizeOf(first), orient: first && first.orient === 'l' ? 'l' : 'p' });
    const xo = c.texts.map((t, i) => {
      xobjs.push(grayXObject(t, t.gray, false));
      return [`T${i}`, xobjs.length - 1];
    });
    items.push({ w: c.w, h: c.h, data: ascii(c.content), flate: false, xo });
  }
  for (const { p, no } of laid) {
    const d = describePage(p, no == null ? null : imgs[no]);
    items.push({ w: d.w, h: d.h, data: ascii(d.content), flate: false, xo: no == null ? [] : [['Im1', no]] });
  }
  return { items, xobjs };
}

/**
 * Synchrones PDF aus Seiten (unkomprimiert, ohne DOM). pages: Model-Seiten {paper, orient, size, strokes, bg}
 * mit strokes als String (wie gespeichert), als Array von Strichen oder null (= leere Seite mit Papier).
 * images: Map oder Objekt assetId → JPEG-Bytes (Uint8Array) für die bg-Ids der Seiten. Fehlt ein Bild, bleibt die Seite ohne Bild.
 * cover: Titelblatt (siehe coverPage) oder null. pdfa: PDF/A-2b. date: Erstellungsdatum (Standard: jetzt).
 * Gibt Uint8Array zurück.
 */
export function buildPdf(pages, { title = '', images = null, cover = null, pdfa = false, date = new Date() } = {}) {
  const { imgs, pages: laid } = layout(pages || [], (id) => lookupBytes(images, id), pdfa);
  const { items, xobjs } = assembleSync(laid, imgs, cover);
  return writePdf(items, title, xobjs, { pdfa, date });
}

function canCompress() {
  return typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * PDF einer Notiz als Blob (application/pdf). Content-Streams und Text-Bilder werden komprimiert, wenn CompressionStream
 * vorhanden ist. opts.getAssetBytes(id) → Promise<Uint8Array|null>: JPEG-Bytes eines Hintergrundbilds (jedes Asset nur einmal).
 * opts.cover: Titelblatt (export/cover.js) oder null, opts.pdfa: PDF/A-2b.
 */
export async function notePdf(note, pages, { getAssetBytes = null, cover = null, pdfa = false, date = new Date() } = {}) {
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
  const { imgs, pages: laid } = layout(list, (id) => bytes.get(id) || null, pdfa);
  let compress = canCompress();
  const pack = async (raw) => {
    if (compress) {
      try { return { data: await deflate(raw), flate: true }; } catch { compress = false; }
    }
    return { data: raw, flate: false };
  };
  const { items, xobjs } = await assemble(laid, imgs, cover, pack);
  return new Blob([writePdf(items, note ? note.title : '', xobjs, { pdfa, date })], { type: 'application/pdf' });
}
