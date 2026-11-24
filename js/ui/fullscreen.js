// Vollbild (Fullscreen API) mit Feature-Erkennung. Chrome/Edge unter Windows und Android können das ganze Dokument
// in Vollbild schalten; iPhone (alle Browser) und Chrome unter iOS melden fullscreenEnabled = false → Button bleibt
// verborgen. Als installierte App (Startbildschirm, display: standalone/fullscreen) gibt es ohnehin keine Adressleiste.

const d = document;

/** true, wenn der Browser das Dokument in Vollbild schalten kann. */
export function fullscreenSupported() {
  const root = d.documentElement;
  return !!((d.fullscreenEnabled && root.requestFullscreen) || (d.webkitFullscreenEnabled && root.webkitRequestFullscreen));
}

export function isFullscreen() {
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

/** Schaltet um. Muss aus einer Nutzergeste (Klick) heraus aufgerufen werden. */
export async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      if (d.exitFullscreen) await d.exitFullscreen();
      else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
    } else {
      const root = d.documentElement;
      // navigationUI 'hide': Android blendet zusätzlich die Systemleisten aus.
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    }
  } catch { /* abgelehnt (keine Geste, Richtlinie) – Zustand bleibt, Button zeigt ihn über das change-Ereignis */ }
}

/** cb() bei jedem Wechsel (auch Esc/F11/Zurück-Geste). Liefert eine Abmeldefunktion. */
export function onFullscreenChange(cb) {
  d.addEventListener('fullscreenchange', cb);
  d.addEventListener('webkitfullscreenchange', cb);
  return () => {
    d.removeEventListener('fullscreenchange', cb);
    d.removeEventListener('webkitfullscreenchange', cb);
  };
}
