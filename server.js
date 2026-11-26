// Folio server: serves the app and stores uploaded PDFs, their metadata and
// reading positions on disk (a Fly volume in production). No dependencies.
//
//   FOLIO_PASSWORD  required; the single password that protects the library
//   DATA_DIR        where PDFs are kept (default ./data)
//   PORT            default 8080

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = +(process.env.PORT || 8080);
const PASSWORD = process.env.FOLIO_PASSWORD || '';
const MAX_PDF = 300 * 1024 * 1024;
const MAX_JSON = 512 * 1024;
const COOKIE = 'folio_session';
const TOKEN = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('folio-session-v1').digest('hex') : '';

fs.mkdirSync(DATA, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};
// Only the app shell is served; server code and data are never exposed.
const STATIC_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
const STATIC_DIRS = ['css/', 'js/', 'vendor/', 'icons/'];

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const send = (res, status, body, headers = {}) => {
  const json = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = json ? JSON.stringify(body) : body ?? '';
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
  });
  res.end(data);
};
const isAuthed = (req) => {
  if (!TOKEN) return false;
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return !!m && safeEqual(m[1], TOKEN);
};
async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const readJson = async (req) => JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
const file = (id, ext) => path.join(DATA, `${id}.${ext}`);
const exists = (p) => fsp.access(p).then(() => true, () => false);
const loadMeta = async (id) => { try { return JSON.parse(await fsp.readFile(file(id, 'json'), 'utf8')); } catch { return null; } };
const saveMeta = async (id, meta) => {
  const tmp = file(id, `json.${crypto.randomUUID()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, file(id, 'json'));
};

// Slow down password guessing: five wrong tries locks an address out for a minute.
const fails = new Map();
const clientIp = (req) => String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '');

async function api(req, res, url) {
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const m = req.method;

  if (parts[0] === 'session' && m === 'GET') {
    return send(res, 200, { app: 'folio', configured: !!TOKEN, auth: isAuthed(req) });
  }
  if (parts[0] === 'login' && m === 'POST') {
    if (!TOKEN) return send(res, 503, { error: 'Server has no password set (FOLIO_PASSWORD).' });
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.n >= 5 && Date.now() < f.until) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    const { password } = await readJson(req);
    if (!safeEqual(crypto.createHash('sha256').update(String(password || '')).digest('hex'),
      crypto.createHash('sha256').update(PASSWORD).digest('hex'))) {
      fails.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 60_000 });
      await new Promise((r) => setTimeout(r, 400));
      return send(res, 401, { error: 'Wrong password.' });
    }
    fails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, {
      'set-cookie': `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
    });
  }
  if (parts[0] === 'logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'Sign in required.' });
  if (parts[0] !== 'books') return send(res, 404, { error: 'Not found' });

  if (parts.length === 1 && m === 'GET') {
    const names = await fsp.readdir(DATA);
    const books = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      const meta = await loadMeta(id);
      if (meta && await exists(file(id, 'bin'))) books.push(meta);
    }
    const deleted = names.filter((n) => n.endsWith('.deleted')).map((n) => n.slice(0, -8));
    return send(res, 200, { books, deleted });
  }

  const id = parts[1];
  if (!/^[a-f0-9]{16,64}$/i.test(id || '')) return send(res, 400, { error: 'Bad id' });
  const sub = parts[2];

  if (!sub && m === 'PUT') {
    const b = await readJson(req);
    const old = (await loadMeta(id)) || {};
    await saveMeta(id, {
      id, kind: ['pdf', 'epub', 'md', 'html'].includes(b.kind) ? b.kind : old.kind || 'pdf',
      title: String(b.title || old.title || 'Untitled').slice(0, 300), name: String(b.name || old.name || '').slice(0, 300),
      size: +b.size || old.size || 0, numPages: +b.numPages || old.numPages || 0, added: +b.added || old.added || Date.now(),
      cover: typeof b.cover === 'string' && b.cover.startsWith('data:image/') ? b.cover.slice(0, 200_000) : old.cover || '',
      pos: old.pos || null,
    });
    return send(res, 200, { ok: true });
  }
  if (!sub && m === 'DELETE') {
    await Promise.all([fsp.rm(file(id, 'bin'), { force: true }), fsp.rm(file(id, 'json'), { force: true })]);
    await fsp.writeFile(file(id, 'deleted'), '');
    return send(res, 200, { ok: true });
  }
  if (sub === 'file' && m === 'PUT') {
    if (+req.headers['content-length'] > MAX_PDF) return send(res, 413, { error: 'File too large' });
    const tmp = file(id, `bin.${crypto.randomUUID()}.tmp`);
    let n = 0;
    try {
      await pipeline(req, async function* (src) {
        for await (const c of src) {
          n += c.length;
          if (n > MAX_PDF) throw Object.assign(new Error('too large'), { status: 413 });
          yield c;
        }
      }, fs.createWriteStream(tmp));
      const fd = await fsp.open(tmp);
      const head = Buffer.alloc(1024);
      // Accept PDF, EPUB (a zip) or text (Markdown, HTML); refuse other binaries.
      const { bytesRead } = await fd.read(head, 0, 1024, 0);
      const sample = head.subarray(0, bytesRead);
      const ok = sample.includes('%PDF-') || (sample[0] === 0x50 && sample[1] === 0x4b) || (bytesRead > 0 && !sample.includes(0));
      await fd.close();
      if (!ok) throw Object.assign(new Error('Unsupported file type'), { status: 415 });
      await fsp.rename(tmp, file(id, 'bin'));
      await fsp.rm(file(id, 'deleted'), { force: true });
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    return send(res, 200, { ok: true, size: n });
  }
  if (sub === 'file' && m === 'GET') {
    let st;
    try { st = await fsp.stat(file(id, 'bin')); } catch { return send(res, 404, { error: 'Not found' }); }
    // Always a download, never rendered: uploaded HTML must not run on this origin.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'content-length': st.size, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    return pipeline(fs.createReadStream(file(id, 'bin')), res);
  }
  if (sub === 'pos' && m === 'GET') {
    const meta = await loadMeta(id);
    return meta ? send(res, 200, { pos: meta.pos || null }) : send(res, 404, { error: 'Not found' });
  }
  if (sub === 'pos' && m === 'PUT') {
    const pos = await readJson(req);
    const meta = await loadMeta(id);
    if (!meta) return send(res, 404, { error: 'Not found' });
    // Last writer wins, judged by the time the reader recorded the position.
    if (!meta.pos || (+pos.t || 0) >= (+meta.pos.t || 0)) {
      meta.pos = {
        mode: pos.mode === 'pages' ? 'pages' : 'reflow', i: +pos.i || 0, f: +pos.f || 0,
        page: +pos.page || 1, pf: +pos.pf || 0, p: +pos.p || 0, t: +pos.t || Date.now(),
      };
      await saveMeta(id, meta);
    }
    return send(res, 200, { pos: meta.pos });
  }
  return send(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('..') || !(STATIC_FILES.has(norm) || STATIC_DIRS.some((d) => norm.startsWith(d)))) {
    return send(res, 404, 'Not found');
  }
  const full = path.join(ROOT, norm);
  let st;
  try { st = await fsp.stat(full); } catch { return send(res, 404, 'Not found'); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': TYPES[path.extname(full)] || 'application/octet-stream',
    'cache-control': 'no-cache', etag, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(full), res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return await serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.destroy();
    return send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.status ? e.message : 'Server error' });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Folio listening on :${PORT}, data in ${DATA}`);
  if (!PASSWORD) console.warn('FOLIO_PASSWORD is not set: uploads and sync are disabled until it is.');
});
