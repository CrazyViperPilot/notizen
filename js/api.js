// HTTP client for api.php (same origin, session cookie + CSRF header).

const URL_API = new URL('../api.php', import.meta.url).href;
const TIMEOUT = 30000;
let csrf = '';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function setCsrf(token) {
  csrf = token || '';
}

async function request(method, route, params, body, retried = false) {
  if (method === 'POST' && !csrf && route !== 'login') {
    try { setCsrf((await send('GET', 'me', null, null)).csrf); } catch { /* the POST below reports the real error */ }
  }
  try {
    return await send(method, route, params, body);
  } catch (e) {
    // No/old CSRF token (e.g. app started offline-first before the session was checked): fetch it once and retry.
    if (!retried && method === 'POST' && e.status === 403 && e.code === 'bad_csrf') {
      const me = await send('GET', 'me', null, null);
      setCsrf(me.csrf);
      return request(method, route, params, body, true);
    }
    throw e;
  }
}

async function send(method, route, params, body) {
  const url = new URL(URL_API);
  url.searchParams.set('r', route);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : { 'X-CSRF-Token': csrf },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, 'network', 'Keine Verbindung zum Server.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON (proxy/HTML error page) */
  }
  if (res.ok && json && json.ok) return json;
  const err = json && json.error ? json.error : { code: 'server', message: 'Der Server antwortet nicht wie erwartet (' + res.status + ').' };
  if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('notizen:unauthorized'));
  throw new ApiError(res.status, err.code, err.message);
}

export const api = {
  get: (route, params) => request('GET', route, params, null),
  post: (route, body) => request('POST', route, null, body),
  setCsrf,
};
