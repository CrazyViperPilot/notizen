// Titelblatt für den PDF-Export: Vorlagen, Layout und Vorschau. Kein DOM beim Laden (Tests laufen ohne Browser);
// document/OffscreenCanvas werden erst beim Rendern benutzt.
//
// Cover-Objekt (Einheit 0,1 mm, Ursprung oben links, wie ink/*):
//   { size, orient, boxes: [{x,y,w,h,color}], lines: [{x1,y1,x2,y2,width,color}],
//     texts: [{x,y,w,h,img:{w,h,gray}}] }
// img: w×h Pixel, 1 Byte je Pixel (0 = schwarz, 255 = weiß), zeilenweise von oben. Text ist Graustufen-Bild,
// damit PDF/A ohne eingebettete Schrift auskommt. Text-Bilder haben weißen Hintergrund und überlappen keine Linien/Boxen.

export const SIZES = { a4: { w: 2100, h: 2970 }, a5: { w: 1480, h: 2100 }, a3: { w: 2970, h: 4200 } };

export const TEMPLATES = [
  { id: 'klassisch', name: 'Klassisch', fields: ['title', 'subtitle', 'author', 'date'] },
  { id: 'schule', name: 'Schulheft', fields: ['title', 'subject', 'author', 'class', 'year'] },
  { id: 'schlicht', name: 'Schlicht', fields: ['title', 'date'] },
];

export const FIELD_LABELS = {
  title: 'Titel', subtitle: 'Untertitel', author: 'Name', date: 'Datum',
  subject: 'Fach', class: 'Klasse', year: 'Schuljahr',
};

const DEFAULT_TEMPLATE = 'klassisch';
const MAX_TEXT = 200;          // Zeichen (Code-Punkte) je Feld
const MAX_LINES = 3;           // Zeilen je Text, danach „…“
const MIN_SCALE = 0.6;         // Schrift schrumpft höchstens auf 60 %
const PX_PER_MM = 300 / 25.4;  // 300 dpi
const PX_PER_UNIT = 300 / 254; // 1 Einheit (0,1 mm) in Pixel
const UNIT_PER_PX = 254 / 300;
const FAMILY = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const INK_DARK = '#1d232b';
const RULE = '#333333';
const GREY = '#555555';
const ACCENT = '#2f5fd0';

// ───────────── Text ─────────────

/** Feldtext bereinigen: Steuerzeichen raus, Leerraum zusammenfassen, höchstens 200 Zeichen. */
export function cleanText(v) {
  const s = v === undefined || v === null ? '' : String(v);
  const t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, MAX_TEXT).join('').trim();
}

/** Zeilen umbrechen (bevorzugt an Leerzeichen), höchstens MAX_LINES; der Rest wird mit „…“ gekürzt. */
function wrapLines(text, fits) {
  const out = [];
  let rest = Array.from(text);
  while (rest.length && out.length < MAX_LINES) {
    const all = rest.join('');
    if (fits(all)) { out.push(all); rest = []; break; }
    let n = 1;
    while (n < rest.length && fits(rest.slice(0, n + 1).join(''))) n++;
    const sp = rest.lastIndexOf(' ', n);
    const cut = sp > 0 ? sp : n;
    out.push(rest.slice(0, cut).join('').trim());
    let k = cut;
    while (k < rest.length && rest[k] === ' ') k++;
    rest = rest.slice(k);
  }
  if (rest.length) {
    const last = Array.from(out.pop() || '');
    while (last.length && !fits(last.join('') + '…')) last.pop();
    out.push(last.join('').trimEnd() + '…');
  }
  return out;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Standard-Renderer: Text auf Canvas bei 300 dpi, Graustufen. sizeMm = Schriftgröße in mm, maxWidth in 0,1 mm.
 * Zu lang → Schrift bis 60 % verkleinern, danach höchstens 3 Zeilen mit „…“.
 * → {w, h, img: {w, h, gray}} (w/h in 0,1 mm, img in Pixeln).
 */
export function canvasText(text, { sizeMm, bold = false, maxWidth, align = 'left', color = '#000000' } = {}) {
  const probe = makeCanvas(1, 1).getContext('2d');
  const font = (p) => `${bold ? 'bold ' : ''}${p.toFixed(2)}px ${FAMILY}`;
  const widthAt = (s, p) => { probe.font = font(p); return probe.measureText(s).width; };
  const maxPx = Math.max(20, maxWidth * PX_PER_UNIT);
  const base = sizeMm * PX_PER_MM;
  let p = base;
  while (widthAt(text, p) > maxPx && p > base * MIN_SCALE) p = Math.max(base * MIN_SCALE, p * 0.92);
  const fits = (s) => widthAt(s, p) <= maxPx;
  const lines = fits(text) ? [text] : wrapLines(text, fits);

  const lh = Math.ceil(p * 1.2);
  const pad = Math.ceil(p * 0.15);
  probe.font = font(p);
  const lw = lines.map((s) => probe.measureText(s).width);
  const innerW = Math.max(1, Math.ceil(Math.max(...lw)));
  const cw = innerW + 2 * pad;
  const ch = lines.length * lh + 2 * pad;
  const g = makeCanvas(cw, ch).getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, cw, ch);
  g.font = font(p);
  g.textBaseline = 'top';
  g.fillStyle = color;
  lines.forEach((s, i) => {
    const x = pad + (align === 'center' ? (innerW - lw[i]) / 2 : 0);
    g.fillText(s, x, pad + i * lh);
  });
  const px = g.getImageData(0, 0, cw, ch).data;
  const gray = new Uint8Array(cw * ch);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
  }
  return {
    w: Math.max(1, Math.round(cw * UNIT_PER_PX)),
    h: Math.max(1, Math.round(ch * UNIT_PER_PX)),
    img: { w: cw, h: ch, gray },
  };
}

// ───────────── Layout ─────────────
// L = {W, H, u, k, renderText, boxes, lines, texts}: W/H in 0,1 mm (Ausrichtung schon angewendet),
// u = Skalierung (1 bei A4), k = Schrumpffaktor für Schriftgrößen (wird bei Überlauf verkleinert).

function measure(L, text, opts) {
  if (!text) return null;
  const r = L.renderText(text, { color: '#000000', ...opts });
  if (!r || !r.img || !(r.w > 0) || !(r.h > 0)) return null;
  const { w: iw, h: ih, gray } = r.img;
  if (!(iw > 0) || !(ih > 0) || !gray || gray.length !== iw * ih) return null;
  return { w: Math.round(r.w), h: Math.round(r.h), img: r.img };
}

function put(L, m, x, y) {
  if (!m) return null;
  const t = { x: Math.round(x), y: Math.round(y), w: m.w, h: m.h, img: m.img };
  L.texts.push(t);
  return t;
}

/** x für Text, der auf der ganzen Seitenbreite zentriert ist. */
function centre(W, m) {
  return Math.max(0, Math.round((W - m.w) / 2));
}

function layoutKlassisch(L, v) {
  const { W, H, u, k } = L;
  const fs = (n) => n * u * k;
  const g = (n) => Math.round(n * u);
  const maxW = W - 2 * g(170);
  const title = measure(L, v.title, { sizeMm: fs(15), bold: true, maxWidth: maxW, align: 'center' });
  const sub = measure(L, v.subtitle, { sizeMm: fs(6.5), maxWidth: maxW, align: 'center', color: RULE });
  const author = measure(L, v.author, { sizeMm: fs(6), maxWidth: maxW, align: 'center' });
  const date = measure(L, v.date, { sizeMm: fs(4.5), maxWidth: maxW, align: 'center', color: GREY });

  // Oberes Drittel: Titel, darunter Untertitel
  let y = Math.round(H * 0.2);
  let topEnd = y;
  if (title) { put(L, title, centre(W, title), y); topEnd = y + title.h; y = topEnd + g(50); }
  if (sub) { put(L, sub, centre(W, sub), y); topEnd = y + sub.h; }

  // Unten: Name, darunter Datum (von unten nach oben gesetzt)
  let yb = H - Math.round(H * 0.1);
  if (date) { yb -= date.h; put(L, date, centre(W, date), yb); }
  if (author) { yb -= (date ? g(40) : 0) + author.h; put(L, author, centre(W, author), yb); }
  if (author || date) {
    // feine Linie in der Mitte zwischen oberem und unterem Block
    const ly = Math.round((topEnd + yb) / 2);
    L.lines.push({ x1: Math.round(W * 0.3), y1: ly, x2: Math.round(W * 0.7), y2: ly, width: Math.max(2, g(3)), color: RULE });
  }
}

function layoutSchule(L, v) {
  const { W, H, u, k } = L;
  const fs = (n) => n * u * k;
  const g = (n) => Math.round(n * u);
  const title = measure(L, v.title, { sizeMm: fs(12), bold: true, maxWidth: W - 2 * g(170), align: 'center' });
  const fw = Math.round(W * 0.72);           // Breite des Etikett-Rahmens
  const pad = g(70);                         // Innenabstand
  const inner = fw - 2 * pad;
  const lw = Math.max(2, g(3));              // Linie unter jedem Wert
  const fl = Math.max(6, g(8));              // Rahmenlinie
  const gLV = g(10), gVL = g(6), rowGap = g(60), titleGap = g(90);
  const sample = measure(L, 'Ag', { sizeMm: fs(7.5), bold: true, maxWidth: inner });
  const sampleH = sample ? sample.h : g(60);
  const rows = ['subject', 'author', 'class', 'year'].map((key) => {
    const label = measure(L, FIELD_LABELS[key], { sizeMm: fs(3.8), maxWidth: inner, color: GREY });
    const value = measure(L, v[key], { sizeMm: fs(7.5), bold: true, maxWidth: inner });
    const labelH = label ? label.h : 0;
    const valH = value ? value.h : sampleH;
    return { label, value, labelH, valH, step: labelH + gLV + valH + gVL };
  });
  const rowsH = rows.reduce((s, r) => s + r.step, 0) + (rows.length - 1) * rowGap;
  const fh = 2 * pad + lw + rowsH;
  const blockH = (title ? title.h + titleGap : 0) + fh;

  // Titel und Rahmen gemeinsam vertikal mittig
  let y = Math.max(g(40), Math.round((H - blockH) / 2));
  if (title) { put(L, title, centre(W, title), y); y += title.h + titleGap; }
  const fx = Math.round((W - fw) / 2);
  const fy = y;
  const edge = { width: fl, color: INK_DARK };
  L.lines.push(
    { x1: fx, y1: fy, x2: fx + fw, y2: fy, ...edge },
    { x1: fx, y1: fy + fh, x2: fx + fw, y2: fy + fh, ...edge },
    { x1: fx, y1: fy, x2: fx, y2: fy + fh, ...edge },
    { x1: fx + fw, y1: fy, x2: fx + fw, y2: fy + fh, ...edge },
  );

  // Zeilen: Beschriftung klein grau, Wert groß, Linie darunter
  let ry = fy + pad;
  for (const r of rows) {
    const x = fx + pad;
    if (r.label) put(L, r.label, x, ry);
    const vy = ry + r.labelH + gLV;
    if (r.value) put(L, r.value, x, vy);
    const ln = vy + r.valH + gVL;
    L.lines.push({ x1: x, y1: ln, x2: fx + fw - pad, y2: ln, width: lw, color: RULE });
    ry = ln + rowGap;
  }
}

function layoutSchlicht(L, v) {
  const { W, H, u, k } = L;
  const fs = (n) => n * u * k;
  const g = (n) => Math.round(n * u);
  const sx = g(170), sw = g(40);           // Akzentstreifen links
  const tx = sx + sw + g(110);             // Textspalte rechts davon
  const maxW = W - tx - g(170);
  const title = measure(L, v.title, { sizeMm: fs(13), bold: true, maxWidth: maxW, align: 'left' });
  const date = measure(L, v.date, { sizeMm: fs(5), maxWidth: maxW, align: 'left', color: GREY });
  const top = Math.round(H * 0.12);
  let end = top;
  if (title) { put(L, title, tx, top); end = top + title.h; }
  if (date) {
    const dy = title ? end + g(70) : top;
    put(L, date, tx, dy);
    end = dy + date.h;
  }
  if (title || date) L.boxes.push({ x: sx, y: top, w: sw, h: end - top, color: ACCENT });
}

const LAYOUT = { klassisch: layoutKlassisch, schule: layoutSchule, schlicht: layoutSchlicht };

// ───────────── Prüfung der Anordnung ─────────────

function lineRect(l) {
  const e = l.width / 2;
  return {
    x: Math.min(l.x1, l.x2) - e, y: Math.min(l.y1, l.y2) - e,
    w: Math.abs(l.x2 - l.x1) + 2 * e, h: Math.abs(l.y2 - l.y1) + 2 * e,
  };
}

function overlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Alles innerhalb der Seite, Texte überlappen weder Texte, Linien noch Boxen. */
function fitsPage(L) {
  const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= L.W && r.y + r.h <= L.H;
  const lines = L.lines.map(lineRect);
  if (![...L.texts, ...L.boxes, ...lines].every(inside)) return false;
  for (let i = 0; i < L.texts.length; i++) {
    for (let j = i + 1; j < L.texts.length; j++) if (overlap(L.texts[i], L.texts[j])) return false;
    for (const r of [...L.boxes, ...lines]) if (overlap(L.texts[i], r)) return false;
  }
  return true;
}

// ───────────── Öffentliche API ─────────────

/**
 * buildCover(templateId, fields, {size, orient}, renderText) → Cover-Objekt (synchron).
 * Unbekannte Vorlage → klassisch. Leere Felder fehlen (Schulheft: Beschriftung bleibt). renderText ist für Tests austauschbar.
 */
export function buildCover(templateId, fields, { size = 'a4', orient = 'p' } = {}, renderText = canvasText) {
  const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE);
  const src = fields && typeof fields === 'object' ? fields : {};
  const sz = Object.prototype.hasOwnProperty.call(SIZES, size) ? size : 'a4';
  const o = orient === 'l' ? 'l' : 'p';
  const base = SIZES[sz];
  const W = o === 'l' ? base.h : base.w;
  const H = o === 'l' ? base.w : base.h;
  const u = base.w / 2100;               // Skalierung über die Papierbreite (A4 = 1)
  const v = {};
  for (const f of tpl.fields) v[f] = cleanText(src[f]);

  let L = null;
  let k = 1;
  for (let i = 0; i < 6; i++) {
    L = { W, H, u, k, renderText, boxes: [], lines: [], texts: [] };
    LAYOUT[tpl.id](L, v);
    if (fitsPage(L)) break;
    k *= 0.85;                           // zu hoch: Schrift verkleinern und neu anordnen
  }
  return { size: sz, orient: o, boxes: L.boxes, lines: L.lines, texts: L.texts };
}

// ───────────── Zeichnen (Vorschau und Bild) ─────────────

/** Seitenmaße in 0,1 mm. Unbekannte Größe → A4, Ausrichtung 'l' sonst Hochformat. */
function pageUnits(size, orient) {
  const sz = Object.prototype.hasOwnProperty.call(SIZES, size) ? size : 'a4';
  const b = SIZES[sz];
  return orient === 'l' ? { W: b.h, H: b.w } : { W: b.w, H: b.h };
}

/** Graustufen-Textbild → Canvas mit RGB-Pixeln. */
function grayCanvas(im) {
  const tmp = makeCanvas(im.w, im.h);
  const tc = tmp.getContext('2d');
  const id = tc.createImageData(im.w, im.h);
  const d = id.data;
  for (let i = 0, j = 0; i < im.gray.length; i++, j += 4) {
    d[j] = d[j + 1] = d[j + 2] = im.gray[i];
    d[j + 3] = 255;
  }
  tc.putImageData(id, 0, 0);
  return tmp;
}

/**
 * Zeichnet Boxen, Linien und Texte (ohne Grund) mit `scale` Pixel je 0,1 mm, verschoben um (ox, oy).
 * Gemeinsamer Zeichencode für Vorschau (drawCoverPreview) und Bildexport (renderCoverImage).
 */
function paintCover(ctx, cover, scale, ox = 0, oy = 0) {
  const s = scale;
  for (const b of cover.boxes || []) {
    ctx.fillStyle = b.color;
    ctx.fillRect(ox + b.x * s, oy + b.y * s, b.w * s, b.h * s);
  }
  for (const l of cover.lines || []) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = Math.max(1, l.width * s);
    ctx.beginPath();
    ctx.moveTo(ox + l.x1 * s, oy + l.y1 * s);
    ctx.lineTo(ox + l.x2 * s, oy + l.y2 * s);
    ctx.stroke();
  }
  for (const t of cover.texts || []) {
    const im = t.img;
    if (!im || !im.gray || im.gray.length !== im.w * im.h) continue;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(grayCanvas(im), ox + t.x * s, oy + t.y * s, t.w * s, t.h * s);
  }
}

/** Zeichnet ein Cover verkleinert auf ein Canvas (Seite zentriert, weißer Grund). Für die Vorschau im Dialog. */
export function drawCoverPreview(canvas, cover) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx || !cover) return;
  const { W, H } = pageUnits(cover.size, cover.orient);
  const cw = canvas.width, ch = canvas.height;
  if (!cw || !ch) return;
  const s = Math.min(cw / W, ch / H);
  const ox = (cw - W * s) / 2, oy = (ch - H * s) / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  paintCover(ctx, cover, s, ox, oy);
}

/**
 * Pixelmaß des Titelblatts als Bild: 1 mm = dpi/25,4 px, gerundet.
 * coverPixelSize('a4', 'p', 200) → {w: 1654, h: 2339}; quer vertauscht. Ungültiges dpi → 200.
 */
export function coverPixelSize(size, orient, dpi = 200) {
  const d = Number.isFinite(dpi) && dpi > 0 ? dpi : 200;
  const { W, H } = pageUnits(size, orient);
  const px = (units) => Math.round((units / 10) * d / 25.4);
  return { w: px(W), h: px(H) };
}

function toJpeg(canvas, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG-Erzeugung fehlgeschlagen'))), 'image/jpeg', quality);
  });
}

/**
 * Titelblatt als JPEG (weißer Grund, Pixelmaß wie coverPixelSize) → Promise<{blob, w, h}>.
 * Standard: 200 dpi, Qualität 0,9. Die Seite mit dem Bild als Hintergrund legt der Aufrufer an.
 */
export async function renderCoverImage(cover, { dpi = 200, quality = 0.9 } = {}) {
  if (!cover || typeof cover !== 'object') throw new Error('Kein Titelblatt');
  const { W } = pageUnits(cover.size, cover.orient);
  const { w, h } = coverPixelSize(cover.size, cover.orient, dpi);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  paintCover(ctx, cover, w / W);
  const q = quality > 0 && quality <= 1 ? quality : 0.9;
  const blob = await toJpeg(canvas, q);
  return { blob, w, h };
}

const PAGE_NUMBER_MM = 3.2;     // Schriftgröße der Seitenzahl
const PAGE_NUMBER_MAX_W = 1000; // 100 mm Textbreite (weit mehr als jede Seitenzahl)

/**
 * Seitenzahl als Graustufen-Bild für den PDF-Writer (unten mittig): renderText wie canvasText, grau #555, zentriert.
 * → {w, h, img} (w/h in 0,1 mm) oder null bei leerem Text oder fehlgeschlagenem Rendern.
 */
export function pageNumberImage(text, { sizeMm = PAGE_NUMBER_MM } = {}, renderText = canvasText) {
  const t = cleanText(text);
  if (!t) return null;
  const r = renderText(t, {
    sizeMm: sizeMm > 0 ? sizeMm : PAGE_NUMBER_MM, color: GREY, align: 'center', maxWidth: PAGE_NUMBER_MAX_W,
  });
  if (!r || !r.img || !(r.w > 0) || !(r.h > 0)) return null;
  const { w: iw, h: ih, gray } = r.img;
  if (!(iw > 0) || !(ih > 0) || !gray || gray.length !== iw * ih) return null;
  return { w: Math.round(r.w), h: Math.round(r.h), img: r.img };
}

/** Heutiges Datum als „25.11.2026“. */
export function todayDe(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}
