// Statussymbol für den Abgleich (PRD 5). Zeigt model.syncStatus() und reagiert auf model.on('sync').
// Klick startet den Abgleich und zeigt den Status in Klartext.

import { h, toast } from './dom.js';

/** Anzeige-Zustand aus dem Sync-Status (state, pending, failed, error). */
function viewOf(s) {
  const pending = s.pending || 0;
  const failed = s.failed || 0;
  let v;
  switch (s.state) {
    case 'syncing':
      v = { cls: 'syncing', glyph: '⟳', title: 'Wird abgeglichen …', text: 'Abgleich läuft …', tone: '' };
      break;
    case 'offline':
      v = {
        cls: 'offline', label: `Offline · ${pending}`, title: `Offline – ${plural(pending)} warten auf Verbindung`,
        text: pending ? `${plural(pending)} warten auf Verbindung` : 'Offline. Keine Änderungen ausstehend.', tone: '',
      };
      break;
    case 'auth':
      v = {
        cls: 'auth', label: 'Anmelden nötig', title: 'Die Sitzung ist abgelaufen. Bitte neu anmelden.',
        text: 'Bitte neu anmelden, damit die Änderungen hochgeladen werden.', tone: 'error',
      };
      break;
    case 'error': {
      const msg = s.error || 'unbekannter Fehler';
      v = { cls: 'error', glyph: '⚠', title: s.error || 'Abgleich fehlgeschlagen', text: `Abgleich fehlgeschlagen: ${msg}`, tone: 'error' };
      break;
    }
    default:
      v = pending > 0
        ? { cls: 'pending', glyph: '…', title: `${plural(pending)} warten auf Abgleich`, text: `${plural(pending)} warten auf den Abgleich`, tone: '' }
        : { cls: 'ok', glyph: '✓', title: 'Alles gespeichert', text: 'Alles gespeichert.', tone: 'ok' };
  }
  if (failed > 0) {
    v.warn = true;
    v.title += `. ${plural(failed)} vom Server abgelehnt`;
    v.text += ` ${plural(failed)} wurden vom Server abgelehnt.`;
  }
  return v;
}

function plural(n) {
  return n === 1 ? '1 Änderung' : `${n} Änderungen`;
}

/**
 * createStatusBadge(model) → {el, destroy()}. el ist ein Knopf (min. 44 px).
 * destroy() meldet den Listener am Modell wieder ab.
 */
export function createStatusBadge(model) {
  const btn = h('button', {
    type: 'button',
    className: 'nz-status',
    onclick: () => {
      const v = viewOf(model.syncStatus());
      toast(v.text, { type: v.tone === 'error' ? 'error' : v.tone === 'ok' ? 'ok' : '', ms: 3200 });
      Promise.resolve(model.syncNow()).catch((e) => console.error(e));
    },
  });

  function render(s) {
    const v = viewOf(s);
    btn.className = `nz-status ${v.cls}${v.warn ? ' warn' : ''}`;
    btn.title = v.title;
    btn.setAttribute('aria-label', v.title);
    // replaceChildren() macht aus null den Text "null", daher nur echte Knoten übergeben.
    const parts = [];
    if (v.glyph) parts.push(h('span', { className: 'nz-status-glyph', text: v.glyph, 'aria-hidden': 'true' }));
    if (v.label) parts.push(h('span', { className: 'nz-status-label', text: v.label }));
    btn.replaceChildren(...parts);
  }

  const listener = (s) => render(s);
  model.on('sync', listener);
  render(model.syncStatus());

  return {
    el: btn,
    destroy() { model.off('sync', listener); },
  };
}
