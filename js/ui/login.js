// Vollbild-Anmeldung (PRD 4, docs/ARCHITEKTUR.md 6). Aufruf aus js/app.js:
//   showLogin({api, forceChange, user, reason}) → Promise<{user, csrf}>
// Das Overlay hängt am body und nutzt bewusst nicht dialog(). Benutzertexte nur über textContent/Attribute.

import { h } from './dom.js';
import { ApiError } from '../api.js';

const MIN_PW = 10;
const MSG_NET_LOGIN = 'Keine Verbindung. Anmelden geht nur online.';
const MSG_NET_PW = 'Keine Verbindung. Bitte erneut versuchen, sobald du online bist.';
const MSG_EXPIRED = 'Deine Sitzung ist abgelaufen. Deine Notizen auf diesem Gerät bleiben erhalten.';

/**
 * Zeigt die Anmeldung. Löst auf, wenn der Benutzer angemeldet ist und ein eigenes Passwort gesetzt hat.
 * - user + forceChange: Sitzung besteht schon (Aufrufer hat das CSRF-Token gesetzt), direkt der Passwort-Schritt.
 * - sonst: Anmeldeformular; bei must_change_pw oder forceChange danach der Passwort-Schritt.
 */
export function showLogin({ api, forceChange = false, user = null, reason = null } = {}) {
  return new Promise((resolve) => {
    let busy = false;
    let finished = false;
    const errBox = h('div', { className: 'error-text', role: 'alert' });
    const card = h('div', { className: 'nz-login-card' });
    const overlay = h('div', { className: 'nz-login', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Anmeldung' }, card);

    const setError = (msg) => { errBox.textContent = msg || ''; };
    const setBusy = (b) => {
      busy = b;
      for (const btn of overlay.querySelectorAll('button[type="submit"]')) btn.disabled = b;
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      overlay.remove();
      resolve(result);
    };
    const show = (nodes, focusEl) => {
      card.replaceChildren(h('h1', { className: 'nz-login-title', text: 'Notizen' }), ...nodes);
      setError('');
      if (focusEl) setTimeout(() => focusEl.focus(), 30);
    };

    // ── Schritt 1: Anmeldung ──
    function loginStep() {
      const userIn = makeInput('text', 'username', user && user.username ? user.username : '');
      const passIn = makeInput('password', 'current-password');
      const form = h('form', {
        className: 'nz-login-form',
        noValidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          const username = userIn.value.trim();
          const password = passIn.value;
          if (!username) { setError('Bitte Benutzernamen eingeben.'); userIn.focus(); return; }
          if (!password) { setError('Bitte Passwort eingeben.'); passIn.focus(); return; }
          setError('');
          setBusy(true);
          try {
            const res = await api.post('login', { username, password });
            api.setCsrf(res.csrf);
            if (res.user.must_change_pw || forceChange) {
              setBusy(false);
              passwordStep();
            } else {
              finish({ user: res.user, csrf: res.csrf });
            }
          } catch (err) {
            setBusy(false);
            setError(messageFor(err, MSG_NET_LOGIN));
            passIn.select();
            passIn.focus();
          }
        },
      },
        field('Benutzername', userIn),
        field('Passwort', passIn),
        errBox,
        h('button', { className: 'btn primary', type: 'submit', text: 'Anmelden' }));
      const nodes = [];
      if (reason === 'expired') nodes.push(h('p', { className: 'nz-login-note', text: MSG_EXPIRED }));
      nodes.push(form);
      show(nodes, user && user.username ? passIn : userIn);
    }

    // ── Schritt 2: eigenes Passwort festlegen ──
    function passwordStep() {
      let changed = false; // true, sobald der Server das neue Passwort angenommen hat (nur `me` fehlt noch)
      const newIn = makeInput('password', 'new-password');
      const repIn = makeInput('password', 'new-password');
      const form = h('form', {
        className: 'nz-login-form',
        noValidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          const a = newIn.value;
          const b = repIn.value;
          if (!changed) {
            if (Array.from(a).length < MIN_PW) { setError(`Das Passwort muss mindestens ${MIN_PW} Zeichen lang sein.`); newIn.focus(); return; }
            if (a !== b) { setError('Die beiden Eingaben stimmen nicht überein.'); repIn.focus(); return; }
          }
          setError('');
          setBusy(true);
          try {
            if (!changed) {
              await api.post('password', { new: a });
              changed = true;
            }
            const me = await api.get('me');
            api.setCsrf(me.csrf);
            finish({ user: me.user, csrf: me.csrf });
          } catch (err) {
            setBusy(false);
            setError(messageFor(err, MSG_NET_PW));
          }
        },
      },
        field('Neues Passwort', newIn),
        field('Wiederholung', repIn),
        errBox,
        h('button', { className: 'btn primary', type: 'submit', text: 'Passwort speichern' }));
      show([
        h('p', { className: 'nz-login-step', text: 'Eigenes Passwort festlegen' }),
        h('p', { className: 'nz-login-sub', text: `Dein Konto hat ein Einmal-Passwort. Lege jetzt dein eigenes fest (mindestens ${MIN_PW} Zeichen).` }),
        form,
      ], newIn);
    }

    document.body.append(overlay);
    if (forceChange && user) passwordStep();
    else loginStep();
  });
}

function makeInput(type, autocomplete, value = '') {
  const input = h('input', { className: 'input', type, value });
  input.setAttribute('autocomplete', autocomplete);
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  return input;
}

function field(label, input) {
  return h('label', { className: 'field' }, h('span', { text: label }), input);
}

function messageFor(err, netMsg) {
  if (err instanceof ApiError) {
    if (err.status === 0 || err.code === 'network') return netMsg;
    return err.message || 'Das hat nicht geklappt.';
  }
  console.error(err);
  return 'Unbekannter Fehler.';
}
