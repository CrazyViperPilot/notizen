// Backup (PRD 6.5): alle eigenen Ordner, Notizen und Seiten als eine Datei; Import legt eine Kopie in einem neuen Ordner an.
// Format {format:'notizen-backup', version:2, exported_at, folders, notes, pages, assets}. Mit CompressionStream gzip-komprimiert.
// Striche bleiben als gespeicherter String (JSON-Text wie in pages.strokes), damit der Export exakt ist.
// Version 2 (ARCHITEKTUR 10.1): Seiten haben `bg` (Asset-id oder null); `assets` enthält die JPEG-Hintergrundbilder als
// {id, mime, w, h, data: base64}. Version 1 (ohne Bilder) wird weiterhin gelesen.

import { PAPERS } from '../config.js';
import { api } from '../api.js';
import { jpegInfo } from './pdf.js';

const FORMAT = 'notizen-backup';
const VERSION = 2;
const VERSIONS = [1, 2];
const BAD = 'Die Datei ist kein gültiges Notizen-Backup.';

function canGzip() {
  return typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';
}

async function gzip(text) {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function' || typeof Response !== 'function') {
    throw new Error('Dieses Gerät kann die komprimierte Backup-Datei nicht öffnen.');
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error(BAD);
  }
}

/** Bytes → Base64 (in Stücken, damit große Bilder die Aufrufkette nicht sprengen). */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Base64 → Bytes. Wirft bei ungültiger Eingabe. */
function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hintergrundbild für den Export: lokal (model.getAsset), sonst vom Server (asset_get, eigenes Asset).
 * Gibt {id, mime, w, h, data} zurück oder null, wenn es nicht ladbar oder kein JPEG ist. Die Maße kommen aus dem JPEG selbst.
 */
async function exportAsset(model, id) {
  let blob = null;
  try {
    const rec = await model.getAsset(id);
    if (rec && rec.blob) blob = rec.blob;
  } catch { blob = null; }
  if (!blob) {
    try { blob = await api.blob('asset_get', { id }); } catch { return null; }
  }
  let bytes;
  try { bytes = new Uint8Array(await blob.arrayBuffer()); } catch { return null; }
  const info = jpegInfo(bytes);
  if (!info) return null;
  return { id, mime: 'image/jpeg', w: info.w, h: info.h, data: toBase64(bytes) };
}

/**
 * Alle sichtbaren Ordner, Notizen und Seiten. Seiten ohne geladene Striche (strokes === null) werden
 * übersprungen und gezählt. Ein Hintergrundbild, das nicht geladen werden kann, wird weggelassen (die Seite
 * bekommt bg = null) und zählt ebenfalls in `skipped` (je Bild einmal). Rückgabe: {blob, skipped}.
 */
export async function exportAllWithInfo(model) {
  const folders = await model.listFolders();
  const noteMap = new Map();
  for (const n of await model.listNotes(null)) noteMap.set(n.id, n);
  for (const f of folders) for (const n of await model.listNotes(f.id)) noteMap.set(n.id, n);
  const notes = [...noteMap.values()];

  const pages = [];
  const assets = [];
  const assetResult = new Map(); // Asset-id → Eintrag oder null (nicht ladbar), je Bild nur einmal geholt
  let skipped = 0;
  for (const n of notes) {
    for (const p of await model.listPages(n.id)) {
      if (typeof p.strokes !== 'string') { skipped++; continue; }
      let bg = null;
      if (typeof p.bg === 'string' && p.bg) {
        if (!assetResult.has(p.bg)) {
          const a = await exportAsset(model, p.bg);
          assetResult.set(p.bg, a);
          if (a) assets.push(a);
          else skipped++;
        }
        if (assetResult.get(p.bg)) bg = p.bg;
      }
      pages.push({
        id: p.id, note_id: p.note_id, pos: p.pos, paper: p.paper, orient: p.orient,
        strokes: p.strokes, bg, created_at: p.created_at, updated_at: p.updated_at,
      });
    }
  }

  const doc = {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    folders: folders.map((f) => ({
      id: f.id, parent_id: f.parent_id || null, name: f.name, created_at: f.created_at, updated_at: f.updated_at,
    })),
    notes: notes.map((n) => ({
      id: n.id, folder_id: n.folder_id || null, title: n.title, created_at: n.created_at, updated_at: n.updated_at,
    })),
    pages,
    assets,
  };
  const json = JSON.stringify(doc);
  if (canGzip()) {
    return { blob: new Blob([await gzip(json)], { type: 'application/gzip' }), skipped };
  }
  return { blob: new Blob([json], { type: 'application/json' }), skipped };
}

/** Nur der Blob (siehe exportAllWithInfo für die Anzahl übersprungener Seiten und Bilder). */
export async function exportAll(model) {
  return (await exportAllWithInfo(model)).blob;
}

async function readBackup(file) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error('Die Datei konnte nicht gelesen werden.');
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  let doc;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(BAD);
  }
  if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) throw new Error(BAD);
  if (!VERSIONS.includes(doc.version)) throw new Error('Diese Backup-Version wird nicht unterstützt.');
  const folders = Array.isArray(doc.folders) ? doc.folders : null;
  const notes = Array.isArray(doc.notes) ? doc.notes : null;
  const pages = Array.isArray(doc.pages) ? doc.pages : null;
  if (!folders || !notes || !pages) throw new Error(BAD);
  const assets = doc.assets === undefined || doc.assets === null ? [] : doc.assets;
  if (!Array.isArray(assets)) throw new Error(BAD);
  for (const f of folders) if (!f || typeof f.id !== 'string') throw new Error(BAD);
  for (const n of notes) if (!n || typeof n.id !== 'string') throw new Error(BAD);
  for (const a of assets) if (!a || typeof a.id !== 'string' || typeof a.data !== 'string') throw new Error(BAD);
  for (const p of pages) {
    if (!p || typeof p.id !== 'string' || typeof p.note_id !== 'string' || typeof p.strokes !== 'string') throw new Error(BAD);
    if (p.bg !== undefined && p.bg !== null && typeof p.bg !== 'string') throw new Error(BAD);
    let parsed;
    try { parsed = JSON.parse(p.strokes); } catch { throw new Error(BAD); }
    if (!Array.isArray(parsed)) throw new Error(BAD);
  }
  return { folders, notes, pages, assets };
}

/**
 * Legt die Hintergrundbilder lokal an (model.putAsset, Hash = id). Ungültige Einträge (kein JPEG, schlechtes Base64)
 * werden übersprungen. Rückgabe: Map Datei-id → id im Client (gleicher Hash bei unveränderter Datei).
 */
async function importAssets(model, assets) {
  const ids = new Map();
  for (const a of assets) {
    if (ids.has(a.id)) continue;
    let bytes;
    try { bytes = fromBase64(a.data); } catch { continue; }
    const info = jpegInfo(bytes);
    if (!info) continue;
    ids.set(a.id, await model.putAsset(new Blob([bytes], { type: 'image/jpeg' }), info.w, info.h));
  }
  return ids;
}

const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Legt die Datei als Kopie in einen neuen Ordner „Import <Datum>“ (neue IDs). Zählt die importierten
 * Ordner (ohne den Import-Ordner selbst), Notizen, Seiten und Hintergrundbilder.
 */
export async function importBackup(model, file) {
  const { folders, notes, pages, assets } = await readBackup(file);
  const counts = { folders: 0, notes: 0, pages: 0, assets: 0 };
  const root = await model.createFolder({ name: `Import ${today()}`, parentId: null });
  const assetIds = await importAssets(model, assets);
  counts.assets = assetIds.size;

  // Ordner von oben nach unten anlegen. Ordner in einem Zyklus oder mit unbekanntem Elternteil hängen unter dem Import-Ordner.
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map();
  const roots = [];
  for (const f of folders) {
    if (f.parent_id && f.parent_id !== f.id && byId.has(f.parent_id)) {
      if (!children.has(f.parent_id)) children.set(f.parent_id, []);
      children.get(f.parent_id).push(f);
    } else roots.push(f);
  }
  const newId = new Map();
  const place = async (startList, parentNew) => {
    const queue = startList.map((f) => [f, parentNew]);
    for (let i = 0; i < queue.length; i++) {
      const [f, parent] = queue[i];
      if (newId.has(f.id)) continue;
      const nf = await model.createFolder({ name: typeof f.name === 'string' ? f.name : '', parentId: parent });
      newId.set(f.id, nf.id);
      counts.folders++;
      for (const c of children.get(f.id) || []) queue.push([c, nf.id]);
    }
  };
  await place(roots, root.id);
  await place(folders.filter((f) => !newId.has(f.id)), root.id);

  // Seiten je Notiz, nach pos sortiert
  const pagesByNote = new Map();
  for (const p of pages) {
    if (!pagesByNote.has(p.note_id)) pagesByNote.set(p.note_id, []);
    pagesByNote.get(p.note_id).push(p);
  }
  for (const list of pagesByNote.values()) list.sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));

  for (const n of notes) {
    const folderId = n.folder_id && newId.has(n.folder_id) ? newId.get(n.folder_id) : root.id;
    const list = pagesByNote.get(n.id) || [];
    const note = await model.createNote({
      title: typeof n.title === 'string' ? n.title : '',
      folderId,
    });
    counts.notes++;
    // createNote legt bereits eine leere Seite an: deren Papier setzen, weitere Seiten anhängen.
    let last = (await model.listPages(note.id))[0];
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      const paper = PAPERS.includes(sp.paper) ? sp.paper : 'lined';
      const orient = sp.orient === 'l' ? 'l' : 'p';
      let page;
      if (i === 0) {
        page = last;
        await model.setPaper(page.id, paper, orient);
      } else {
        page = await model.addPage(note.id, last.id, { paper, orient });
        last = page;
      }
      await model.saveStrokes(page.id, sp.strokes);
      // Hintergrundbild erst nach den Strichen setzen (setPageBackground braucht die Seite mit Strichen)
      if (typeof sp.bg === 'string' && assetIds.has(sp.bg)) await model.setPageBackground(page.id, assetIds.get(sp.bg));
      counts.pages++;
    }
  }
  return counts;
}
