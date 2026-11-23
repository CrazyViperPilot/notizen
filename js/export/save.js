// Gibt eine Datei heraus: Teilen-Menü (navigator.share mit Datei) oder Download als Ausweichlösung.

const FORBIDDEN = /[\/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** Dateiname ohne / \ : * ? " < > | und Steuerzeichen, ohne führende Punkte, höchstens 120 Zeichen. */
export function safeFilename(name) {
  const s = String(name ?? '')
    .replace(FORBIDDEN, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  return s || 'Notizen';
}

function canShareFile(file) {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Sofortiges Widerrufen bricht den Download in manchen Safari-Versionen ab.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Teilen-Menü, falls Dateien teilbar sind (AbortError = abgebrochen, nichts weiter tun), sonst Download.
 * Schlägt das Teilen aus anderen Gründen fehl, wird ebenfalls heruntergeladen.
 */
export async function saveFile(blob, filename) {
  const name = safeFilename(filename);
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  download(blob, name);
}
