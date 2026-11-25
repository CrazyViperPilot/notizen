// Vorschaubild einer Notiz (erste Seite) als Object-URL. Cache in model.thumbs (IndexedDB, nur lokal).
// Der Aufrufer gibt die URL mit URL.revokeObjectURL frei. Siehe docs/ARCHITEKTUR.md 3.4 und 7.1.

import { pageDims } from '../config.js';
import { decodeStrokes } from '../ink/codec.js';
import { drawPage, setPageTransform } from '../ink/render.js';

const THUMB_W = 240;   // Pixel-Breite des Vorschaubilds
let canvas = null;     // ein wiederverwendetes Offscreen-Canvas (Zeichnen und toBlob laufen synchron nacheinander)

/** Rendert eine Seite als PNG-Blob. Ohne Striche (strokes === null) nur das Papier. img: Hintergrundbild oder null. */
function renderPage(page, img) {
  const dims = pageDims(page.size, page.orient);
  const w = THUMB_W;
  const hPx = Math.round((THUMB_W * dims.h) / dims.w);
  if (!canvas) canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d');
  const scale = w / dims.w;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  setPageTransform(ctx, scale);
  const strokes = typeof page.strokes === 'string' ? decodeStrokes(page.strokes) : [];
  drawPage(ctx, page, strokes, scale, null, img);
  // toBlob übernimmt die Bitmap synchron; danach darf das Canvas wiederverwendet werden.
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Object-URL des Vorschaubilds der ersten Seite, oder null (keine Seite, Fehler). */
export async function noteThumb(model, note) {
  try {
    const pages = await model.listPages(note.id);
    const page = pages[0];
    if (!page) return null;
    const key = page.id + ':' + page.rev + ':' + page.lrev + ':' + page.paper + ':' + (page.bg || '');
    const cached = await model.thumbs.get(note.id);
    if (cached && cached.page_rev === key && cached.blob) return URL.createObjectURL(cached.blob);
    // Hintergrundbild (ARCHITEKTUR 10.1). Lokal oder per Server; nicht ladbar → Vorschau ohne Bild, dann nicht cachen.
    const img = page.bg ? await model.getImage(page.bg, { noteId: note.id }) : null;
    const blob = await renderPage(page, img);
    if (!blob) return null;
    // Seiten ohne geladene Striche zeigen nur das Papier: nicht cachen, sonst bliebe das Bild leer.
    // Dasselbe gilt für ein Hintergrundbild, das (noch) nicht geladen werden konnte.
    if (page.strokes !== null && (!page.bg || img)) await model.thumbs.put(note.id, key, blob);
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error(e);
    return null;
  }
}
