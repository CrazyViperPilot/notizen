// Lernkartei nach dem Leitner-Prinzip (Vokabeltrainer, Lernstand als JSON im Seitenfeld meta.learn).
// Rein und DOM-frei, ohne Importe. Alle Funktionen ändern ihre Eingaben nicht; sie liefern neue Objekte.
// Ein Lernstand hat die Form {v: 1, rows: {"<Zeilenindex>": {b, t, n, k}}} mit
//   b = Fach 1…5, t = Zeitpunkt der letzten Antwort (ms), n = Antworten gesamt, k = davon gewusst.

export const BOXES = 5;
// Fach 1…5: frühestens nach so vielen Tagen wieder fällig.
export const INTERVAL_DAYS = [0, 1, 3, 7, 21];

const DAY_MS = 86400000;
// Auswahlgewicht je Fach (Fach 1 wird am häufigsten abgefragt).
const WEIGHTS = [16, 8, 4, 2, 1];
const DEFAULT_MAX_ROWS = 200;
// Obergrenze für die gespeicherte JSON-Zeichenkette (der JSON-Text ist reines ASCII, Zeichen = Bytes).
const MAX_BYTES = 16384;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
// Nur kanonische Ganzzahl-Schlüssel wie "0", "17"; "01", "-1", "1.5" oder "1e2" werden verworfen.
const ROW_KEY = /^(0|[1-9][0-9]*)$/;

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isBox(v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= BOXES;
}

// Prüft einen Eintrag und gibt eine frische Kopie zurück, oder null bei Unsinn.
function cleanEntry(e) {
  if (!isObject(e) || !isBox(e.b) || !isCount(e.t) || !isCount(e.n) || !isCount(e.k)) return null;
  return { b: e.b, t: e.t, n: e.n, k: e.k };
}

function cleanRows(rows, maxRows) {
  const out = {};
  if (!isObject(rows)) return out;
  for (const key of Object.keys(rows)) {
    if (!ROW_KEY.test(key)) continue;
    const idx = Number(key);
    if (!(idx < maxRows)) continue;
    const entry = cleanEntry(rows[key]);
    if (entry) out[key] = entry;
  }
  return out;
}

function limitOf(maxRows) {
  return Number.isSafeInteger(maxRows) && maxRows >= 0 ? maxRows : DEFAULT_MAX_ROWS;
}

// Liest den Eintrag einer Zeile aus einem Lernstand (nur eigene Schlüssel, bereinigt), sonst null.
function entryOf(learn, row) {
  if (!isObject(learn) || !isObject(learn.rows)) return null;
  const key = String(row);
  if (!Object.prototype.hasOwnProperty.call(learn.rows, key)) return null;
  return cleanEntry(learn.rows[key]);
}

/** Leerer Lernstand. */
export function emptyLearn() {
  return { v: 1, rows: {} };
}

/**
 * Macht aus einem beliebigen Wert einen gültigen Lernstand. Behalten werden nur Zeilen 0…maxRows−1 mit gültigen
 * Einträgen; alles andere wird verworfen. Ungültige Eingaben (null, Arrays, Strings, Zahlen) ergeben emptyLearn().
 */
export function cleanLearn(x, maxRows = DEFAULT_MAX_ROWS) {
  if (!isObject(x)) return emptyLearn();
  return { v: 1, rows: cleanRows(x.rows, limitOf(maxRows)) };
}

/**
 * Verarbeitet eine Antwort zu Zeile `row` und liefert einen NEUEN Lernstand.
 * gewusst: Fach +1 (höchstens 5); nicht gewusst: Fach 1. Eine neue Zeile startet in Fach 1.
 * t = now, n + 1, k + 1 bei gewusst. Ist `row` keine gültige Zeilennummer, kommt eine bereinigte Kopie zurück.
 */
export function answer(learn, row, known, now) {
  const next = cleanLearn(learn, NO_LIMIT);
  if (!isCount(row)) return next;
  const key = String(row);
  const prev = next.rows[key] || { b: 1, t: 0, n: 0, k: 0 };
  const got = Boolean(known);
  next.rows[key] = {
    b: got ? Math.min(BOXES, prev.b + 1) : 1,
    t: isCount(now) ? now : 0,
    n: prev.n + 1,
    k: prev.k + (got ? 1 : 0),
  };
  return next;
}

/**
 * Ist ein Eintrag fällig? Ohne Eintrag (neue Zeile) immer. Sonst, wenn seit t mindestens INTERVAL_DAYS[b−1] Tage
 * vergangen sind (1 Tag = 86 400 000 ms).
 */
export function isDue(entry, now) {
  const e = cleanEntry(entry);
  if (!e) return true;
  const days = INTERVAL_DAYS[e.b - 1];
  return now - e.t >= days * DAY_MS;
}

/**
 * Wählt die nächste Zeile. `rows` ist die Liste der Zeilenindizes mit Inhalt. Bevorzugt werden fällige Zeilen; sind
 * keine fällig, kommen alle in Frage. Die Auswahl ist nach Fach gewichtet (16, 8, 4, 2, 1). `rand` liefert Werte in
 * [0, 1). `exclude` wird nur ausgeschlossen, wenn im Auswahlkreis noch andere Zeilen übrig bleiben.
 * Ohne Zeilen → null.
 */
export function pickNext(learn, rows, now, rand = Math.random, exclude = null) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let pool = rows.filter((r) => isDue(entryOf(learn, r), now));
  if (pool.length === 0) pool = rows.slice();
  if (exclude !== null && exclude !== undefined) {
    const rest = pool.filter((r) => r !== exclude);
    if (rest.length > 0) pool = rest;
  }
  const weights = pool.map((r) => WEIGHTS[boxOf(learn, r) - 1]);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < pool.length; i++) {
    x -= weights[i];
    if (x < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * Zählt die Zeilen in `rows`: total, boxes [Fach 1…5] (neue Zeilen zählen in Fach 1), due (fällige),
 * mastered (Fach 5).
 */
export function stats(learn, rows, now) {
  const out = { total: 0, boxes: [0, 0, 0, 0, 0], due: 0, mastered: 0 };
  if (!Array.isArray(rows)) return out;
  out.total = rows.length;
  for (const r of rows) {
    out.boxes[boxOf(learn, r) - 1] += 1;
    if (isDue(entryOf(learn, r), now)) out.due += 1;
  }
  out.mastered = out.boxes[BOXES - 1];
  return out;
}

/** Fach (1…5) einer Zeile. Unbekannte oder neue Zeilen liegen in Fach 1. */
export function boxOf(learn, row) {
  const e = entryOf(learn, row);
  return e ? e.b : 1;
}

function toJson(rows) {
  const parts = Object.keys(rows).map((key) => {
    const e = rows[key];
    return JSON.stringify(key) + ':' + JSON.stringify({ b: e.b, t: e.t, n: e.n, k: e.k });
  });
  return '{"v":1,"rows":{' + parts.join(',') + '}}';
}

/**
 * Kompaktes JSON (String) des bereinigten Lernstands, höchstens 16 KB. Ist es zu groß, werden die ältesten
 * Einträge (nach t) verworfen, bis es passt.
 */
export function serializeLearn(learn) {
  const rows = cleanLearn(learn).rows;
  let json = toJson(rows);
  if (json.length > MAX_BYTES) {
    const oldest = Object.keys(rows).sort((a, b) => rows[a].t - rows[b].t || Number(a) - Number(b));
    for (let i = 0; i < oldest.length && json.length > MAX_BYTES; i++) {
      delete rows[oldest[i]];
      json = toJson(rows);
    }
  }
  return json;
}
