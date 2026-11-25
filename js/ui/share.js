// Teilen-Dialog für Ordner und Notizen (nur lesen). Schnittstellen: docs/ARCHITEKTUR.md 4 (directory, shares_of, share, unshare).
// Ohne Netz geht nichts; Server-Fehler (z. B. 404, weil die Notiz noch nicht abgeglichen ist) lösen einen Abgleich aus
// und einen erneuten Versuch.

import { api, ApiError } from '../api.js';
import { h, dialog, toast } from './dom.js';

const SYNC_WAIT_MS = 8000;

/** Runs fn. On a server-side miss (404) or 5xx: one sync, then one retry. Offline and other errors are thrown as they are. */
async function withSync(ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!retryable(e)) throw e;
    await syncOnce(ctx);
    return fn();
  }
}

function retryable(e) {
  return e instanceof ApiError && (e.status === 404 || e.status >= 500);
}

/** Starts a sync and waits for it, but at most SYNC_WAIT_MS. Never throws. */
function syncOnce(ctx) {
  let timer = 0;
  const wait = new Promise((resolve) => { timer = setTimeout(resolve, SYNC_WAIT_MS); });
  const sync = Promise.resolve().then(() => ctx.model.syncNow()).catch(() => {});
  return Promise.race([sync, wait]).finally(() => clearTimeout(timer));
}

/** Text for the user. Server texts (400, 403, …) are shown as they are. */
function message(e, kind) {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Teilen geht nur online.';
    if (e.status === 401) return 'Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.';
    if (retryable(e) || !e.message) {
      return 'Bitte warten, bis ' + (kind === 'folder' ? 'der Ordner' : 'die Notiz') + ' mit dem Server abgeglichen ist.';
    }
    return e.message;
  }
  return 'Das hat nicht geklappt. Bitte später noch einmal versuchen.';
}

/**
 * Opens the share dialog for a folder or note. Resolves true if the shares were saved, otherwise false.
 * kind: 'folder' | 'note'; id: UUID; name: shown in the title.
 */
export async function openShareDialog(kind, id, name, ctx) {
  const folder = kind === 'folder';
  const list = h('div', { className: 'share-list' }, h('p', { className: 'muted', text: 'Lade Benutzer …' }));
  const err = h('div', { className: 'error-text', role: 'alert' });
  const inputs = new Map();                              // target user id → checkbox
  const state = { ready: false, busy: false, shared: new Map(), review: new Map() }; // shared: target id → share id, review: target id → 0/1
  const reviews = new Map();                             // target user id → checkbox „darf korrigieren“

  const explain = 'Ausgewählte Personen können lesen, aber nichts ändern. Mit „Korrigieren“ (Abgabe) dürfen sie zusätzlich'
    + ' mit dem Rotstift korrigieren – ihre Korrekturen liegen in einer eigenen Ebene, deine Schrift bleibt unverändert.'
    + (folder ? ' Bei Ordnern gilt das inklusive aller Unterordner und Notizen, auch künftiger.' : '');
  const body = h('div', { className: 'share-dialog' }, h('p', { className: 'share-explain', text: explain }), list, err);

  const done = dialog({
    title: `„${name}“ teilen`,
    body,
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Speichern', value: 'save', primary: true }],
    onAction: () => save(),
  });
  load();
  return (await done) === 'save';

  async function load() {
    try {
      const [dir, mine] = await withSync(ctx, () => Promise.all([
        api.get('directory'),
        api.get('shares_of', { kind, id }),
      ]));
      renderList(dir.users || [], mine.shares || []);
    } catch (e) {
      list.replaceChildren();
      err.textContent = message(e, kind);
    }
  }

  function renderList(users, shares) {
    const names = new Map();
    for (const u of users) names.set(u.id, u.display_name);
    // Bestehende Freigaben an Personen, die nicht (mehr) in der Liste stehen (z. B. gesperrt), trotzdem zeigen.
    for (const s of shares) if (!names.has(s.target_id)) names.set(s.target_id, s.display_name);
    state.shared = new Map(shares.map((s) => [s.target_id, s.id]));
    state.review = new Map(shares.map((s) => [s.target_id, s.review ? 1 : 0]));
    inputs.clear();
    reviews.clear();
    list.replaceChildren();
    if (names.size === 0) {
      list.append(h('p', { className: 'muted', text: 'Keine anderen Benutzer vorhanden.' }));
    }
    const entries = [...names].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'de'));
    for (const [targetId, label] of entries) {
      const input = h('input', { type: 'checkbox', checked: state.shared.has(targetId) });
      const rv = h('input', { type: 'checkbox', checked: state.review.get(targetId) === 1, 'aria-label': 'darf korrigieren: ' + label });
      rv.onchange = () => { if (rv.checked) input.checked = true; };
      input.addEventListener('change', () => { if (!input.checked) rv.checked = false; });
      inputs.set(targetId, input);
      reviews.set(targetId, rv);
      list.append(h('div', { className: 'share-row-wrap' },
        h('label', { className: 'share-row' }, input, h('span', { text: label })),
        h('label', { className: 'share-review' }, rv, h('span', { text: 'Korrigieren' }))));
    }
    state.ready = true;
  }

  /** Speichern: neue Häkchen → share, entfernte → unshare je Freigabe. Keeps the dialog open on error. */
  async function save() {
    if (state.busy) return false;
    if (!state.ready) {
      err.textContent = '';
      list.replaceChildren(h('p', { className: 'muted', text: 'Lade Benutzer …' }));
      await load();
      return false;
    }
    const want = new Set();
    for (const [targetId, input] of inputs) if (input.checked) want.add(targetId);
    const wantReview = (t) => (reviews.get(t) && reviews.get(t).checked ? 1 : 0);
    // Neu oder mit geänderter Korrektur-Erlaubnis → share (setzt review bei bestehenden Freigaben)
    const add = [...want].filter((t) => !state.shared.has(t) || state.review.get(t) !== wantReview(t));
    const remove = [...state.shared.keys()].filter((t) => !want.has(t));
    if (!add.length && !remove.length) {
      toast('Keine Änderungen.');
      return true;
    }

    state.busy = true;
    err.textContent = '';
    try {
      for (const rv of [0, 1]) {
        const group = add.filter((t) => wantReview(t) === rv);
        if (!group.length) continue;
        const r = await withSync(ctx, () => api.post('share', { kind, id, target_ids: group, review: rv === 1 }));
        state.shared = new Map((r.shares || []).map((s) => [s.target_id, s.id]));
        state.review = new Map((r.shares || []).map((s) => [s.target_id, s.review ? 1 : 0]));
      }
      for (const targetId of remove) {
        const shareId = state.shared.get(targetId);
        try {
          await withSync(ctx, () => api.post('unshare', { share_id: shareId }));
        } catch (e) {
          // 404: die Freigabe gibt es schon nicht mehr – das Ziel ist erreicht.
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
        state.shared.delete(targetId);
      }
      toast('Freigaben gespeichert.', { type: 'ok' });
      return true;
    } catch (e) {
      err.textContent = message(e, kind);
      return false;
    } finally {
      state.busy = false;
    }
  }
}
