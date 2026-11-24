// Import of photos and PDFs as page backgrounds (ARCHITEKTUR 10.1). Everything is converted to JPEG in the browser:
// images are decoded (HEIC on the iPad too), PDF pages are rendered with the vendored pdf.js (js/vendor/pdfjs/,
// loaded only when a PDF is imported). The pages are written through model.addImagePages; the editor reloads on the
// model change events.
//
// pickAndImport must be called directly from a tap: the file input is clicked synchronously (no await before it),
// otherwise iOS refuses to open the picker.

import { h, dialog, toast } from '../ui/dom.js';

const ACCEPT = 'image/*,application/pdf';
const MAX_IMAGE_SIDE = 2400;
const PDF_PAGE_SIDE = 2000;
const JPEG_QUALITY = 0.85;
const MAX_PDF_PAGES = 50;
const FOCUS_FALLBACK_MS = 1000;

let pendingPick = null; // { input, abandon() } of the picker that is still open

/** true for PDF files (by MIME type or extension; iOS sometimes sends an empty type). */
export function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

/** Size scaled down so that the longest side is at most maxSide. Never enlarges. */
export function fitSize(w, h, maxSide = MAX_IMAGE_SIDE) {
  const f = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)) };
}

/**
 * Opens the file picker (images and PDFs, several files) and imports the chosen files after `afterPageId`.
 * Resolves with the new pages, or [] when nothing was chosen. Must be called directly from a tap.
 */
export function pickAndImport({ model, noteId, afterPageId = null }) {
  return new Promise((resolve) => {
    if (pendingPick) pendingPick.abandon();

    let settled = false;
    const finish = (pages) => {
      if (settled) return;
      settled = true;
      resolve(pages);
    };
    const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });

    const detach = () => {
      window.removeEventListener('focus', onBack);
      input.remove();
      if (pendingPick && pendingPick.input === input) pendingPick = null;
    };

    // iOS may send neither 'change' nor 'cancel' when the picker is dismissed. After the window has its focus back
    // we wait a moment; if nothing was chosen, we give up. The input stays attached, so a selection that still
    // arrives later is imported too (the model change events then update the note).
    const onBack = () => {
      window.removeEventListener('focus', onBack);
      setTimeout(() => {
        if (!input.files || !input.files.length) finish([]);
      }, FOCUS_FALLBACK_MS);
    };

    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      detach();
      if (!files.length) { finish([]); return; }
      runImport(files, { model, noteId, afterPageId }).then(finish, (e) => {
        console.error(e);
        toast('Import fehlgeschlagen', { type: 'error' });
        finish([]);
      });
    });
    input.addEventListener('cancel', () => { detach(); finish([]); });

    pendingPick = { input, abandon: () => { detach(); finish([]); } };
    document.body.append(input);
    window.addEventListener('focus', onBack);
    input.click();
  });
}

/**
 * Converts any image source (ImageBitmap, HTMLImageElement, HTMLCanvasElement) to a JPEG blob, longest side ≤ maxSide,
 * white background (transparent PNGs). Resolves { blob, w, h }.
 */
export async function imageToJpeg(source, maxSide = MAX_IMAGE_SIDE) {
  const { w: sw, h: sh } = sourceSize(source);
  if (!sw || !sh) throw new Error('Bild ohne Größe');
  const { w, h } = fitSize(sw, sh, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Kein Zeichenkontext');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG-Kodierung fehlgeschlagen'))), 'image/jpeg', JPEG_QUALITY);
    });
    return { blob, w, h };
  } finally {
    canvas.width = 0; // release the bitmap memory (iPad)
    canvas.height = 0;
  }
}

// ───────────────────────── internals ─────────────────────────

function sourceSize(src) {
  return { w: src.naturalWidth || src.width || 0, h: src.naturalHeight || src.height || 0 };
}

/** Images: ImageBitmap with EXIF orientation, fallback <img> with object URL (e.g. HEIC where createImageBitmap fails). */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, release: () => { if (bitmap.close) bitmap.close(); } };
    } catch (e) {
      console.warn('createImageBitmap fehlgeschlagen, nehme <img>', e);
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { source: img, release: () => URL.revokeObjectURL(url) };
}

let pdfjsReady = null;

/** pdf.js is loaded on first use only. */
function loadPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = import('../vendor/pdfjs/pdf.min.js').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return pdfjs;
    }).catch((e) => {
      pdfjsReady = null;
      throw e;
    });
  }
  return pdfjsReady;
}

async function readImage(file, images, progress, prefix) {
  progress.set(`${prefix}Bild wird importiert…`);
  const { source, release } = await decodeImage(file);
  try {
    images.push(await imageToJpeg(source));
  } finally {
    release();
  }
}

async function readPdf(file, images, progress, prefix) {
  progress.set(`${prefix}PDF wird geöffnet…`);
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: false }).promise;
  try {
    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    if (doc.numPages > MAX_PDF_PAGES) {
      toast(`„${file.name}“ hat ${doc.numPages} Seiten. Importiert werden die ersten ${MAX_PDF_PAGES}.`, { ms: 5000 });
    }
    for (let k = 1; k <= total && !progress.cancelled; k++) {
      progress.set(`${prefix}Seite ${k} von ${total} wird importiert…`);
      images.push(await renderPdfPage(doc, k));
    }
  } finally {
    doc.destroy();
  }
}

/** One PDF page as JPEG, longest side ≈ PDF_PAGE_SIDE, white background. The canvas is freed afterwards. */
async function renderPdfPage(doc, num) {
  const page = await doc.getPage(num);
  let canvas = null;
  try {
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: PDF_PAGE_SIDE / Math.max(base.width, base.height) });
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Kein Zeichenkontext');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return await imageToJpeg(canvas, PDF_PAGE_SIDE);
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    page.cleanup();
  }
}

/** Progress dialog that cannot be dismissed except through its "Abbrechen" button (stops after the current page). */
function openProgress() {
  const text = h('p', { role: 'status', text: 'Wird vorbereitet…' });
  const state = { cancelled: false, close: null };
  dialog({
    title: 'Import',
    dismissible: false,
    body: (close) => { state.close = close; return text; },
    actions: [{ label: 'Abbrechen', value: 'cancel' }],
    onAction: () => {
      state.cancelled = true;
      text.textContent = 'Wird nach dieser Seite abgebrochen…';
      return false; // keep the dialog open until the import has stopped
    },
  });
  return {
    set(msg) { text.textContent = msg; },
    get cancelled() { return state.cancelled; },
    done() { if (state.close) state.close(null); },
  };
}

/**
 * Imports the files one after another. Each file is read completely first and then added as one batch, so the pages
 * of one file stay in order. A file that cannot be read is reported and skipped. On cancel, the pages of the current
 * file are kept and the rest is not started.
 */
async function runImport(files, { model, noteId, afterPageId }) {
  const progress = openProgress();
  const added = [];
  let anchor = afterPageId ?? null;
  try {
    for (let i = 0; i < files.length; i++) {
      if (progress.cancelled) break;
      const file = files[i];
      const name = file.name || 'Datei';
      const prefix = files.length > 1 ? `Datei ${i + 1} von ${files.length} – ` : '';
      const images = [];
      try {
        if (isPdfFile(file)) await readPdf(file, images, progress, prefix);
        else await readImage(file, images, progress, prefix);
      } catch (e) {
        console.warn(e);
        toast(`„${name}“ kann nicht gelesen werden (beschädigt oder verschlüsselt?).`, { type: 'error', ms: 4000 });
        continue;
      }
      if (!images.length) continue;
      try {
        const pages = await model.addImagePages(noteId, anchor, images);
        if (pages.length) {
          added.push(...pages);
          anchor = pages[pages.length - 1].id;
        }
      } catch (e) {
        console.error(e);
        toast(`„${name}“ konnte nicht gespeichert werden.`, { type: 'error', ms: 4000 });
      }
    }
  } finally {
    progress.done();
  }
  return added;
}
