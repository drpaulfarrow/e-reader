import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { reflowDocument, PARSER_VERSION } from './reflow.js';
import * as store from './store.js';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const textOf = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const ANCHOR_Y = 84; // viewport line (px from top) used to remember the reading position

const S = {
  settings: store.getSettings(),
  book: null, model: null, pdf: null,
  blocks: [], mode: 'reflow', anchor: null,
  urls: [], canBack: false, quiet: 0, gen: 0,
};

function loadPdf(buf) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(buf.slice(0)),
    cMapUrl: VENDOR + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    isEvalSupported: false,
  }).promise;
}

/* ---------- small UI helpers ---------- */

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function busy(on, title, sub) {
  $('busy').hidden = !on;
  if (title) $('busy-title').textContent = title;
  $('busy-sub').textContent = sub || '';
  if (on) $('busy-meter').style.width = '0%';
}

function applySettings() {
  const s = S.settings;
  document.documentElement.dataset.theme = s.theme;
  $('content').style.setProperty('--fs', s.size + 'px');
  $('content').classList.toggle('sans', s.font === 'sans');
  $('size-val').textContent = s.size + ' px';
  for (const b of $('theme-seg').children) b.classList.toggle('on', b.dataset.v === s.theme);
  for (const b of $('font-seg').children) b.classList.toggle('on', b.dataset.v === s.font);
  for (const b of $('mode-seg').children) b.classList.toggle('on', b.dataset.v === S.mode);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').content = bg;
}

/* ---------- library ---------- */

async function showLibrary() {
  closeReader();
  $('reader').hidden = true;
  $('library').hidden = false;
  store.setOpen(null);
  document.title = 'Folio';
  let books = [];
  try { books = await store.listBooks(); } catch (e) { toast('Storage is unavailable in this browser mode.'); }
  const list = $('book-list');
  list.textContent = '';
  $('lib-empty').hidden = books.length > 0;
  $('add-btn').hidden = books.length === 0;
  for (const b of books) {
    const pos = store.getPos(b.id);
    const li = el('li', 'book');
    const cover = el('div', 'cover');
    if (b.cover) cover.style.backgroundImage = `url(${b.cover})`;
    const main = el('div', 'book-main');
    const title = el('div', 'book-title');
    title.textContent = b.title;
    const meta = el('div', 'book-meta');
    const pct = pos ? Math.round((pos.p || 0) * 100) : 0;
    meta.textContent = pos && (pos.p > 0.005 || pos.page > 1)
      ? `Page ${pos.page || 1} of ${b.numPages} · ${pct}% read`
      : `${b.numPages} page${b.numPages === 1 ? '' : 's'} · Not started`;
    const prog = el('div', 'book-prog');
    const bar = el('i');
    bar.style.width = pct + '%';
    prog.append(bar);
    main.append(title, meta, prog);
    const del = el('button', 'icon', '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>');
    del.setAttribute('aria-label', `Remove ${b.title}`);
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Remove “${b.title}” from this device?`)) return;
      await store.deleteBook(b.id);
      showLibrary();
    });
    li.append(cover, main, del);
    li.addEventListener('click', () => go(b.id));
    list.append(li);
  }
  window.scrollTo(0, 0);
}

async function renderCover(pdf) {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 220 / base.width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#fff' }).promise;
    return c.toDataURL('image/jpeg', 0.78);
  } catch { return ''; }
}

async function importFiles(files) {
  const pdfs = [...files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Please choose a PDF file.'); return; }
  let last = null;
  for (const file of pdfs) {
    busy(true, 'Preparing your PDF', file.name);
    let pdf = null;
    try {
      const buf = await file.arrayBuffer();
      pdf = await loadPdf(buf);
      const id = pdf.fingerprints?.[0] || `${file.name}:${buf.byteLength}`;
      if (await store.getBook(id)) { last = id; continue; }
      const model = await reflowDocument(pdf, pdfjsLib.OPS, (n, total) => {
        $('busy-meter').style.width = Math.round((n / total) * 100) + '%';
        $('busy-sub').textContent = `${file.name} · page ${n} of ${total}`;
        return new Promise((r) => setTimeout(r));
      });
      const cover = await renderCover(pdf);
      const book = {
        id, title: model.title || file.name.replace(/\.pdf$/i, ''), name: file.name,
        size: buf.byteLength, numPages: pdf.numPages, added: Date.now(), lastRead: 0, cover,
      };
      await store.addBook(book, buf, model);
      last = id;
    } catch (e) {
      console.error(e);
      toast(e?.name === 'PasswordException' ? `${file.name} is password-protected.`
        : e?.name === 'QuotaExceededError' ? 'Not enough storage space on this device.'
        : `Could not open ${file.name}.`);
    } finally {
      try { pdf?.destroy(); } catch { /* ignore */ }
    }
  }
  busy(false);
  store.persist();
  if (pdfs.length === 1 && last) go(last);
  else showLibrary();
}

/* ---------- routing ---------- */

function go(id) {
  S.canBack = true;
  location.hash = '#/b/' + encodeURIComponent(id);
}
function route() {
  const m = location.hash.match(/^#\/b\/(.+)$/);
  if (m) openBook(decodeURIComponent(m[1]));
  else showLibrary();
}

/* ---------- reader: rendering blocks ---------- */

function tilesEl(b) {
  const long = b.cells.some((parts) => textOf(parts.join(' ')).length > 60);
  if (long) return tableEl({ t: 'table', n: b.cells.length, head: null, rows: [b.cells.map((p, c) => ({ h: p.join('<br>'), c, n: textOf(p.join(' ')).length }))] });
  const wrap = el('div', 'tiles');
  for (const parts of b.cells) {
    const t = el('div', 'tile');
    t.append(el('div', 'v', parts[0]));
    if (parts.length > 1) t.append(el('div', 'k', parts.slice(1).join(' ')));
    wrap.append(t);
  }
  return wrap;
}

function tableEl(b) {
  const colMax = Array(b.n).fill(0);
  for (const row of b.rows) for (const c of row) if (!c.s) colMax[c.c] = Math.max(colMax[c.c], c.n);
  if (b.head) b.head.forEach((h, i) => { colMax[i] = Math.max(colMax[i], Math.min(10, textOf(h).length)); });
  if (b.n >= 2 && colMax.reduce((a, c) => a + c, 0) <= 34) {
    const wrap = el('div', 'grid-wrap');
    const table = el('table');
    if (b.head) {
      const tr = el('tr');
      for (const h of b.head) tr.append(el('th', '', h));
      table.append(tr);
    }
    for (const row of b.rows) {
      const tr = el('tr');
      for (const c of row) {
        const td = el('td', '', c.h);
        if (c.s) td.colSpan = c.s;
        tr.append(td);
      }
      table.append(tr);
    }
    wrap.append(table);
    return wrap;
  }
  const wrap = el('div', 'tbl');
  const labels = b.head && b.n >= 3;
  for (const row of b.rows) {
    const cells = row.filter((c) => c.h);
    if (!cells.length) continue;
    if (cells.length === 1 && b.n > 1 && (cells[0].s || 1) >= b.n) {
      wrap.append(el('div', 'tgroup', cells[0].h));
      continue;
    }
    const card = el('div', 'card');
    const top = el('div', 'top');
    top.append(el('div', 'ct', cells[0].h));
    card.append(top);
    for (const c of cells.slice(1)) {
      const chip = c.bg && c.n <= 40;
      if (chip && c.n <= 14 && top.children.length === 1) {
        const ch = el('span', 'chip', c.h);
        ch.style.background = c.bg;
        top.append(ch);
        continue;
      }
      const f = el('div', 'cf');
      if (labels && b.head[c.c]) f.append(el('span', 'lab', b.head[c.c]));
      if (chip) {
        const ch = el('span', 'chip wrap', c.h);
        ch.style.background = c.bg;
        f.append(ch);
      } else f.append(el('div', '', c.h));
      card.append(f);
    }
    wrap.append(card);
  }
  return wrap;
}

function figEl(b, pg) {
  const [x0, y0, x1, y1] = b.box;
  const w = x1 - x0, h = y1 - y0;
  const fig = el('figure', 'fig');
  const ph = el('div', 'ph');
  ph.style.aspectRatio = `${w} / ${h}`;
  const rel = w / (pg.w || 612);
  if (rel < 0.6) { ph.style.width = Math.round(Math.max(40, rel * 150)) + '%'; ph.style.margin = '0 auto'; }
  ph.setAttribute('role', 'button');
  ph.setAttribute('aria-label', b.alt ? 'Figure: ' + b.alt.slice(0, 120) : 'Figure');
  ph.dataset.p = b.p;
  ph.dataset.box = b.box.join(',');
  fig.append(ph);
  figObserver.observe(ph);
  return fig;
}

function blockEl(b, pg) {
  switch (b.t) {
    case 'h': return el('h' + b.l, '', b.h);
    case 'p': return el('p', b.s ? 'small' : '', b.h);
    case 'li': {
      const d = el('div', `li d${b.d || 0}${b.m.length > 2 ? ' wide' : ''}${b.s ? ' small' : ''}`);
      const mk = el('span', 'mk');
      mk.textContent = b.m;
      d.append(mk, el('div', '', b.h));
      return d;
    }
    case 'callout': {
      const d = el('div', 'callout');
      d.style.setProperty('--k', b.c);
      if (b.a) d.style.setProperty('--c', b.a);
      for (const x of b.b) d.append(blockEl(x, pg));
      return d;
    }
    case 'tiles': return tilesEl(b);
    case 'table': return tableEl(b);
    case 'fig': return figEl(b, pg);
    default: return el('p');
  }
}

function renderContent(model) {
  const root = $('content');
  root.textContent = '';
  const frag = document.createDocumentFragment();
  let i = 0;
  S.blocks = [];
  for (const pg of model.pages) {
    const sec = el('section');
    sec.dataset.page = pg.n;
    if (pg.n > 1) {
      const m = el('div', 'pgmark');
      m.textContent = pg.n;
      sec.append(m);
    }
    for (const b of pg.blocks) {
      const node = blockEl(b, pg);
      node.dataset.i = i++;
      S.blocks.push(node);
      sec.append(node);
    }
    frag.append(sec);
  }
  frag.append(el('div', 'endmark', '• • •'));
  root.append(frag);

  const toc = $('toc-list');
  toc.textContent = '';
  const heads = root.querySelectorAll('h1, h2, h3');
  for (const h of heads) {
    const li = el('li', 'l' + h.tagName[1]);
    li.textContent = h.textContent;
    li.addEventListener('click', () => {
      closeSheets();
      scrollToY(h.getBoundingClientRect().top + scrollY - ANCHOR_Y + 8);
      $('reader').classList.add('immersive');
    });
    li._h = h;
    toc.append(li);
  }
  $('toc-btn').hidden = heads.length < 2;
}

/* ---------- figures: lazy page crops ---------- */

const getPdf = () => (S.pdf ||= store.getFile(S.book.id).then(loadPdf));
let renderChain = Promise.resolve();
const queue = (fn) => (renderChain = renderChain.then(fn, fn));

async function renderCrop(n, box, maxW) {
  const pdf = await getPdf();
  const page = await pdf.getPage(n);
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  const scale = Math.min(maxW / w, Math.sqrt(7e6 / (w * h)), 8);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  await page.render({
    canvasContext: c.getContext('2d'), viewport: vp, background: '#fff',
    transform: [1, 0, 0, 1, -x0 * scale, -y0 * scale],
  }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  c.width = c.height = 0;
  const url = URL.createObjectURL(blob);
  S.urls.push(url);
  return url;
}

const figObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const ph = e.target;
    figObserver.unobserve(ph);
    const gen = S.gen;
    queue(async () => {
      if (gen !== S.gen) return;
      try {
        const url = await renderCrop(+ph.dataset.p, ph.dataset.box.split(',').map(Number), 2200);
        if (gen !== S.gen) return;
        const img = new Image();
        img.alt = ph.getAttribute('aria-label') || '';
        img.src = url;
        ph.append(img, el('span', 'zoom', 'Tap to zoom'));
      } catch (err) { console.warn('figure', err); }
    });
  }
}, { rootMargin: '900px 0px' });

/* ---------- original pages view ---------- */

const pageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const d = e.target;
    if (!e.isIntersecting) { d.textContent = ''; d._tok = null; continue; }
    if (d.firstChild) continue;
    const tok = (d._tok = {});
    const gen = S.gen;
    queue(async () => {
      if (gen !== S.gen || d._tok !== tok) return;
      try {
        const pdf = await getPdf();
        const page = await pdf.getPage(+d.dataset.n);
        const base = page.getViewport({ scale: 1 });
        const scale = (d.clientWidth * Math.min(window.devicePixelRatio || 1, 2.5)) / base.width;
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#fff' }).promise;
        if (gen === S.gen && d._tok === tok) d.append(c);
      } catch (err) { console.warn('page', err); }
    });
  }
}, { rootMargin: '120% 0px' });

function buildPages() {
  const root = $('pages');
  if (root.childElementCount) return;
  for (const pg of S.model.pages) {
    const d = el('div', 'opage');
    d.dataset.n = pg.n;
    d.style.aspectRatio = `${pg.w} / ${pg.h}`;
    d.addEventListener('click', async () => {
      try { openViewer(await renderCrop(pg.n, [0, 0, pg.w, pg.h], 2600)); } catch (err) { console.warn(err); }
    });
    root.append(d);
    pageObserver.observe(d);
  }
}

/* ---------- reading position ---------- */

function firstVisible(list) {
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].getBoundingClientRect().bottom > ANCHOR_Y) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function currentAnchor() {
  const max = document.documentElement.scrollHeight - innerHeight;
  const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  if (S.mode === 'pages') {
    const pages = [...$('pages').children];
    if (!pages.length) return null;
    const k = firstVisible(pages);
    const r = pages[k].getBoundingClientRect();
    const n = +pages[k].dataset.n;
    const first = $('content').querySelector(`section[data-page="${n}"] [data-i]`);
    return { mode: 'pages', page: n, pf: Math.min(1, Math.max(0, (ANCHOR_Y - r.top) / r.height)), i: first ? +first.dataset.i : 0, f: 0, p };
  }
  if (!S.blocks.length) return null;
  const k = firstVisible(S.blocks);
  const r = S.blocks[k].getBoundingClientRect();
  const f = r.height ? Math.min(1, Math.max(0, (ANCHOR_Y - r.top) / r.height)) : 0;
  const page = +(S.blocks[k].closest('section')?.dataset.page || 1);
  return { mode: 'reflow', i: k, f, page, pf: 0, p };
}

function scrollToY(y) {
  S.quiet = performance.now() + 250;
  window.scrollTo(0, Math.max(0, Math.round(y)));
}

function restore(a) {
  if (!a) { scrollToY(0); return; }
  if (S.mode === 'pages') {
    const d = $('pages').querySelector(`[data-n="${a.page || 1}"]`);
    if (!d) return scrollToY(0);
    const r = d.getBoundingClientRect();
    scrollToY(a.page <= 1 && !a.pf ? 0 : r.top + scrollY + (a.pf || 0) * r.height - ANCHOR_Y);
    return;
  }
  const b = S.blocks[Math.min(a.i || 0, S.blocks.length - 1)];
  if (!b) return scrollToY(0);
  const r = b.getBoundingClientRect();
  scrollToY(a.i === 0 && !a.f ? 0 : r.top + scrollY + (a.f || 0) * r.height - ANCHOR_Y);
}

function savePos() {
  if (!S.book || !$('busy').hidden) return;
  const a = currentAnchor();
  if (!a) return;
  S.anchor = a;
  store.setPos(S.book.id, { ...a, t: Date.now() });
  updateLabels(a);
}

function updateLabels(a) {
  $('page-label').textContent = `Page ${a.page} of ${S.model.numPages}`;
  $('pct-label').textContent = Math.round(a.p * 100) + '%';
  $('progress-bar').firstElementChild.style.width = (a.p * 100).toFixed(1) + '%';
}

let lastY = 0, ticking = false, saveTimer = 0;
function onScroll() {
  ticking = false;
  if (!S.book) return;
  const y = scrollY;
  if (performance.now() > S.quiet) {
    const r = $('reader').classList;
    const atEnd = y + innerHeight >= document.documentElement.scrollHeight - 40;
    if (y < 30 || atEnd) r.remove('immersive');
    else if (y > lastY + 8) r.add('immersive');
    else if (y < lastY - 24) r.remove('immersive');
  }
  lastY = y;
  const max = document.documentElement.scrollHeight - innerHeight;
  $('progress-bar').firstElementChild.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0).toFixed(1) + '%';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePos, 180);
}

/* ---------- reader: open / close / mode ---------- */

function setMode(mode, keep = true) {
  const a = keep ? currentAnchor() : null;
  S.mode = mode;
  $('content').hidden = mode !== 'reflow';
  $('pages').hidden = mode !== 'pages';
  if (mode === 'pages') buildPages();
  applySettings();
  if (a) {
    restore({ ...a, pf: a.mode === 'pages' ? a.pf : 0, f: 0, i: mode === 'reflow' ? firstBlockOfPage(a.page) : a.i });
    savePos();
  }
}
const firstBlockOfPage = (n) => {
  const b = $('content').querySelector(`section[data-page="${n}"] [data-i]`);
  return b ? +b.dataset.i : 0;
};

function closeReader() {
  // Don't measure the page here: when leaving via the browser's back gesture the
  // scroll position may already have changed. Keep the last position we recorded.
  clearTimeout(saveTimer);
  if (S.book && S.anchor) store.setPos(S.book.id, { ...S.anchor, t: Date.now() });
  S.gen++;
  S.book = null;
  S.model = null;
  S.blocks = [];
  S.anchor = null;
  const pdf = S.pdf;
  S.pdf = null;
  pdf?.then((p) => p.destroy()).catch(() => {});
  for (const u of S.urls) URL.revokeObjectURL(u);
  S.urls = [];
  figObserver.disconnect();
  pageObserver.disconnect();
  $('content').textContent = '';
  $('pages').textContent = '';
  closeSheets();
  $('viewer').hidden = true;
}

async function openBook(id) {
  closeReader();
  let book;
  try { book = await store.getBook(id); } catch { book = null; }
  if (!book) { history.replaceState(null, '', location.pathname + location.search); return showLibrary(); }
  S.book = book;
  let model = await store.getModel(id);
  if (!model || model.v !== PARSER_VERSION) {
    // The reflow engine was updated since this PDF was added: rebuild its layout.
    busy(true, 'Updating layout', book.title);
    try {
      const pdf = await getPdf();
      model = await reflowDocument(pdf, pdfjsLib.OPS, (n, t) => {
        $('busy-meter').style.width = Math.round((n / t) * 100) + '%';
        return new Promise((r) => setTimeout(r));
      });
      await store.putModel(id, model);
    } catch (e) {
      console.error(e);
      busy(false);
      toast('This PDF could not be opened.');
      return showLibrary();
    }
    busy(false);
  }
  if (S.book !== book) return;
  S.model = model;
  $('library').hidden = true;
  $('reader').hidden = false;
  $('reader').classList.remove('immersive');
  $('book-title').textContent = book.title;
  document.title = book.title;
  renderContent(model);
  const pos = store.getPos(id);
  setMode(pos?.mode === 'pages' ? 'pages' : 'reflow', false);
  restore(pos);
  lastY = scrollY;
  requestAnimationFrame(() => { restore(pos); savePos(); });
  store.setOpen(id);
  book.lastRead = Date.now();
  store.putBook(book).catch(() => {});
}

/* ---------- sheets ---------- */

function openSheet(id) {
  closeSheets();
  $(id).hidden = false;
  $('scrim').hidden = false;
  if (id === 'toc') {
    let cur = null;
    for (const li of $('toc-list').children) {
      li.classList.remove('cur');
      if (li._h.getBoundingClientRect().top < ANCHOR_Y + 40) cur = li;
    }
    cur?.classList.add('cur');
    cur?.scrollIntoView({ block: 'center' });
  }
}
function closeSheets() {
  $('settings').hidden = true;
  $('toc').hidden = true;
  $('scrim').hidden = true;
}

function changeSetting(patch) {
  const a = S.book ? currentAnchor() : null;
  Object.assign(S.settings, patch);
  store.setSettings(S.settings);
  applySettings();
  if (a) { restore(a); savePos(); }
}

/* ---------- image viewer (pinch, pan, double-tap) ---------- */

const V = { s: 1, x: 0, y: 0, min: 1, max: 4, iw: 1, ih: 1, pts: new Map(), last: null, tap: 0, moved: false };
function viewerApply() {
  const vw = innerWidth, vh = innerHeight;
  const w = V.iw * V.s, h = V.ih * V.s;
  V.x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, V.x));
  V.y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, V.y));
  $('viewer-img').style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.s})`;
}
function viewerZoom(s, cx, cy) {
  s = Math.min(V.max, Math.max(V.min, s));
  V.x = cx - ((cx - V.x) * s) / V.s;
  V.y = cy - ((cy - V.y) * s) / V.s;
  V.s = s;
  viewerApply();
}
function openViewer(src) {
  const img = $('viewer-img');
  img.onload = () => {
    V.iw = img.naturalWidth;
    V.ih = img.naturalHeight;
    img.style.width = V.iw + 'px';
    img.style.height = V.ih + 'px';
    V.min = Math.min(innerWidth / V.iw, innerHeight / V.ih);
    V.max = Math.max(V.min * 8, 1.5);
    V.s = V.min;
    V.x = V.y = 0;
    viewerApply();
  };
  img.src = src;
  V.pts.clear();
  $('viewer').hidden = false;
  $('viewer-hint').style.opacity = 1;
  setTimeout(() => { $('viewer-hint').style.opacity = 0; }, 2200);
}
function initViewer() {
  const v = $('viewer');
  const two = () => {
    const [a, b] = [...V.pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  v.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#viewer-close')) return;
    v.setPointerCapture(e.pointerId);
    V.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    V.moved = false;
    V.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (V.pts.size === 2) V.last = two();
  });
  v.addEventListener('pointermove', (e) => {
    const p = V.pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (V.down && Math.hypot(e.clientX - V.down.x, e.clientY - V.down.y) > 8) V.moved = true;
    if (V.pts.size === 1) { V.x += dx; V.y += dy; viewerApply(); }
    else if (V.pts.size === 2) {
      const t = two();
      V.x += t.cx - V.last.cx;
      V.y += t.cy - V.last.cy;
      viewerZoom(V.s * (t.d / Math.max(1, V.last.d)), t.cx, t.cy);
      V.last = t;
    }
  });
  const up = (e) => {
    if (!V.pts.delete(e.pointerId)) return;
    if (V.pts.size === 0 && !V.moved && V.down && performance.now() - V.down.t < 300) {
      const now = performance.now();
      if (now - V.tap < 320) {
        viewerZoom(V.s > V.min * 1.2 ? V.min : Math.min(V.max, V.min * 3), e.clientX, e.clientY);
        V.tap = 0;
      } else V.tap = now;
    }
  };
  v.addEventListener('pointerup', up);
  v.addEventListener('pointercancel', up);
  v.addEventListener('wheel', (e) => { e.preventDefault(); viewerZoom(V.s * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX, e.clientY); }, { passive: false });
  $('viewer-close').addEventListener('click', () => { v.hidden = true; });
}

/* ---------- wiring ---------- */

function init() {
  try { history.scrollRestoration = 'manual'; } catch { /* older browsers */ }
  applySettings();
  initViewer();

  const input = $('file-input');
  const pick = () => { input.value = ''; input.click(); };
  $('add-btn').addEventListener('click', pick);
  $('add-btn-2').addEventListener('click', pick);
  input.addEventListener('change', () => input.files.length && importFiles(input.files));

  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
  addEventListener('dragleave', () => document.body.classList.remove('drag'));
  addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('drag');
    if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
  });

  $('back-btn').addEventListener('click', () => {
    savePos();
    if (S.canBack) history.back();
    else { history.replaceState(null, '', location.pathname + location.search); route(); }
  });
  $('toc-btn').addEventListener('click', () => openSheet('toc'));
  $('aa-btn').addEventListener('click', () => openSheet('settings'));
  $('scrim').addEventListener('click', closeSheets);
  $('size-down').addEventListener('click', () => changeSetting({ size: Math.max(13, S.settings.size - 1) }));
  $('size-up').addEventListener('click', () => changeSetting({ size: Math.min(30, S.settings.size + 1) }));
  $('theme-seg').addEventListener('click', (e) => e.target.dataset.v && changeSetting({ theme: e.target.dataset.v }));
  $('font-seg').addEventListener('click', (e) => e.target.dataset.v && changeSetting({ font: e.target.dataset.v }));
  $('mode-seg').addEventListener('click', (e) => {
    if (!e.target.dataset.v || e.target.dataset.v === S.mode) return;
    setMode(e.target.dataset.v);
    closeSheets();
  });

  // Tap the text to show or hide the bars; tap a figure to zoom.
  $('content').addEventListener('click', (e) => {
    const ph = e.target.closest('.ph');
    if (ph) {
      const img = ph.querySelector('img');
      if (img) openViewer(img.src);
      return;
    }
    if (e.target.closest('a, button') || String(getSelection()).length) return;
    $('reader').classList.toggle('immersive');
  });

  addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  addEventListener('pagehide', savePos);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
  let lastW = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth === lastW) return;
    lastW = innerWidth;
    if (S.book && S.anchor) restore(S.anchor);
    if (!$('viewer').hidden) viewerApply();
  });
  addEventListener('hashchange', route);

  // Install hint
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const tip = $('install-tip');
  if (!standalone) {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    tip.textContent = ios
      ? 'Tip: tap the Share button, then “Add to Home Screen” to use Folio like an app.'
      : 'Tip: open your browser menu and choose “Add to Home screen” or “Install app”.';
    tip.hidden = false;
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      tip.textContent = '';
      const b = el('button', 'btn');
      b.textContent = 'Install Folio on this device';
      b.addEventListener('click', () => e.prompt());
      tip.append(b);
    });
    addEventListener('appinstalled', () => { tip.hidden = true; });
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Resume the book that was open last time.
  const open = store.getOpen();
  if (!location.hash && open) {
    history.replaceState(null, '', location.pathname + location.search);
    history.pushState(null, '', '#/b/' + encodeURIComponent(open));
    S.canBack = true;
  }
  route();
}

init();
