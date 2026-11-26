// Optional server sync. When the app is served by server.js (for example on
// Fly), PDFs, the library and reading positions are stored there too, so they
// follow you across devices. On a plain static host this stays inactive.

const BASE = new URL('../api/', import.meta.url).href;
export const state = { available: false, configured: false, auth: false };

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store', ...opts });
  if (res.status === 401) state.auth = false;
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res;
}
const json = (body) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function init() {
  try {
    const res = await fetch(BASE + 'session', { credentials: 'same-origin', cache: 'no-store' });
    const j = res.ok ? await res.json() : null;
    if (j?.app === 'folio') Object.assign(state, { available: true, configured: !!j.configured, auth: !!j.auth });
  } catch { /* offline or static host */ }
  return state;
}

export async function login(password) {
  await call('login', { method: 'POST', ...json({ password }) });
  state.auth = true;
}

export const list = async () => (await call('books')).json();
export const download = async (id) => (await call(`books/${id}/file`)).arrayBuffer();
export const remove = (id) => call(`books/${id}`, { method: 'DELETE' });

export async function upload(book, buf) {
  await call(`books/${book.id}/file`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf });
  const { id, kind, title, name, size, numPages, added, cover } = book;
  await call(`books/${id}`, { method: 'PUT', ...json({ id, kind, title, name, size, numPages, added, cover }) });
}

export async function getPos(id, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return (await (await call(`books/${id}/pos`, { signal: ctl.signal })).json()).pos; }
  catch { return null; }
  finally { clearTimeout(timer); }
}

export function pushPos(id, pos, keepalive = false) {
  if (!state.auth) return;
  call(`books/${id}/pos`, { method: 'PUT', keepalive, ...json(pos) }).catch(() => {});
}
