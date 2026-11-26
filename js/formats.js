// Non-PDF inputs: Markdown, HTML and EPUB. These formats already describe
// their structure, so they are converted straight into the reader's block
// model (see reflow.js for the PDF route) with no layout guessing.

import { PARSER_VERSION } from './reflow.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const Z = String.fromCharCode(1); // placeholder delimiter used while parsing inline Markdown

export function kindOf(file) {
  const n = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (file.type === 'application/epub+zip' || n.endsWith('.epub')) return 'epub';
  if (/\.(md|markdown|mdown|mkd|txt)$/.test(n) || file.type === 'text/markdown') return 'md';
  if (/\.x?html?$/.test(n) || file.type === 'text/html') return 'html';
  return null;
}

/* ---------- Markdown to HTML ---------- */

function mdInline(src) {
  const stash = [];
  const keep = (h) => { stash.push(h); return Z + (stash.length - 1) + Z; };
  let s = src;
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, t, c) => keep('<code>' + esc(c.trim()) + '</code>'));
  s = s.replace(/\\\n/g, () => keep('<br>'));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, c) => keep(esc(c)));
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (_, u) => keep(`<a href="${escAttr(u)}">${esc(u.replace(/^mailto:/, ''))}</a>`));
  s = s.replace(/<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->/g, (t) => keep(t)); // raw HTML passes through (sanitised later)
  s = esc(s).replace(/&amp;(#?\w+;)/g, '&$1');
  s = s.replace(/!\[([^\]]*)\]\(\s*(\S+?)(?:\s+(?:&quot;|"|')[^)]*)?\s*\)/g, (_, alt, u) => keep(`<img src="${u.replace(/"/g, '&quot;')}" alt="${alt.replace(/"/g, '&quot;')}">`));
  s = s.replace(/\[([^\]]+)\]\(\s*(\S+?)(?:\s+(?:&quot;|"|')[^)]*)?\s*\)/g, (_, text, u) => keep(`<a href="${u.replace(/"/g, '&quot;')}">`) + text + keep('</a>'));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, (_, pre, u) => pre + keep(`<a href="${u.replace(/"/g, '&quot;')}">${u}</a>`));
  s = s.replace(/\*\*(?=\S)([\s\S]+?\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/(?<![\w])__(?=\S)([\s\S]+?\S)__(?![\w])/g, '<b>$1</b>');
  s = s.replace(/(?<![*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '<i>$1</i>');
  s = s.replace(/(?<![\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '<i>$1</i>');
  s = s.replace(/~~(?=\S)([\s\S]+?\S)~~/g, '<s>$1</s>');
  s = s.replace(/ {2,}\n/g, '<br>');
  const re = new RegExp(Z + '(\\d+)' + Z, 'g');
  for (let k = 0; k < 3 && s.includes(Z); k++) s = s.replace(re, (_, i) => stash[+i]);
  return s;
}

const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const HR = /^ {0,3}([-*_])( *\1){2,} *$/;
const TABLE_SEP = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}<(?:\/?(?:div|table|details|summary|p|img|figure|figcaption|h[1-6]|ul|ol|pre|blockquote|section|article|aside|center|hr|br|dl)\b|!--)/i;
const indentOf = (l) => l.length - l.trimStart().length;
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function mdBlocks(lines) {
  let out = '';
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out += '<p>' + mdInline(para.join('\n')) + '</p>\n'; para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^ {0,3}(`{3,}|~{3,})/.exec(line))) {
      flush();
      const close = new RegExp('^ {0,3}' + m[1][0] + '{' + m[1].length + ',}\\s*$');
      const code = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
      i++;
      out += '<pre>' + esc(code.join('\n')) + '</pre>\n';
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      out += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>\n`;
      i++;
      continue;
    }
    if (para.length && /^ {0,3}(=+|-+) *$/.test(line)) { // setext heading
      const lvl = line.trim()[0] === '=' ? 1 : 2;
      out += `<h${lvl}>${mdInline(para.join(' '))}</h${lvl}>\n`;
      para = [];
      i++;
      continue;
    }
    if (HR.test(line)) { flush(); out += '<hr>\n'; i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out += '<blockquote>' + mdBlocks(q) + '</blockquote>\n';
      continue;
    }
    if ((m = LIST.exec(line)) && !(para.length && /\d/.test(m[2]) && parseInt(m[2], 10) !== 1)) {
      flush();
      const ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const mm = LIST.exec(lines[i]);
        if (!mm || /\d/.test(mm[2]) !== ordered || HR.test(lines[i])) break;
        const indent = mm[1].length;
        const content = indent + mm[2].length + Math.max(1, Math.min(mm[3].length, 4));
        const nest = Math.min(content, indent + 2);
        const item = [mm[4]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && indentOf(lines[j]) >= nest) { item.push(''); i++; continue; }
            break;
          }
          const ind = indentOf(l);
          if (ind >= nest) { item.push(l.slice(Math.min(ind, content))); i++; continue; }
          if (LIST.test(l) || HR.test(l) || /^ {0,3}(#{1,6}\s|>|`{3}|~{3})/.test(l)) break;
          item.push(l.trim()); // lazy continuation of the item's paragraph
          i++;
        }
        items.push(item);
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j > i && j < lines.length && LIST.test(lines[j]) && !HR.test(lines[j])) i = j;
      }
      const tag = ordered ? 'ol' : 'ul';
      out += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` + items.map((it) => '<li>' + mdBlocks(it) + '</li>').join('') + `</${tag}>\n`;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = splitRow(line);
      i += 2;
      let t = '<table><thead><tr>' + head.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i++]);
        t += '<tr>' + head.map((_, k) => `<td>${mdInline(cells[k] || '')}</td>`).join('') + '</tr>';
      }
      out += t + '</tbody></table>\n';
      continue;
    }
    if (!para.length && HTML_BLOCK.test(line)) {
      const raw = [];
      while (i < lines.length && lines[i].trim()) raw.push(lines[i++]);
      out += raw.join('\n') + '\n';
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

/* ---------- HTML (DOM) to blocks ---------- */

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'ul']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'template', 'iframe', 'object', 'embed',
  'form', 'input', 'button', 'select', 'textarea', 'audio', 'video', 'canvas', 'math']);
const BLOCK_SEL = [...BLOCK].join(',') + ',img,svg';
const INLINE = { b: 'b', strong: 'b', i: 'i', em: 'i', cite: 'i', dfn: 'i', var: 'i', code: 'code', kbd: 'code', samp: 'code', tt: 'code',
  sub: 'sub', sup: 'sup', u: 'u', s: 's', del: 's', strike: 's', mark: 'mark' };
const tagOf = (n) => (n.localName || '').toLowerCase();

function inlineHtml(nodes, ctx) {
  let h = '';
  for (const n of nodes) {
    if (n.nodeType === 3) { h += esc(n.nodeValue.replace(/\s+/g, ' ')); continue; }
    if (n.nodeType !== 1) continue;
    const tag = tagOf(n);
    if (SKIP.has(tag)) continue;
    if (tag === 'br') { h += '<br>'; continue; }
    if (tag === 'img') { const alt = n.getAttribute('alt'); if (alt) h += esc(alt); continue; }
    let inner = inlineHtml(n.childNodes, ctx);
    if (!inner) continue;
    let wrap = INLINE[tag];
    if (!wrap && tag === 'span') {
      const st = n.getAttribute('style') || '';
      const cls = (n.getAttribute('class') || '').split(/\s+/);
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st) || cls.some((c) => ctx.bold?.has(c))) wrap = 'b';
      if (/font-style\s*:\s*italic/i.test(st) || cls.some((c) => ctx.italic?.has(c))) inner = `<i>${inner}</i>`;
    }
    if (tag === 'a') {
      const href = (n.getAttribute('href') || '').trim();
      if (/^(https?:|mailto:)/i.test(href)) inner = `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    h += wrap ? `<${wrap}>${inner}</${wrap}>` : inner;
  }
  return h;
}
const cleanInline = (h) => h.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
const plainLen = (h) => h.replace(/<[^>]+>/g, '').length;

function imageBlock(n, ctx, out) {
  const src = n.getAttribute('src') || n.getAttribute('href') || n.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || '';
  const alt = (n.getAttribute('alt') || '').slice(0, 300);
  const ref = ctx.image(src.trim());
  if (ref) out.push({ t: 'img', ...ref, alt });
  else if (alt) out.push({ t: 'p', s: 1, h: `<i>[Image: ${esc(alt)}]</i>` });
}

function listBlocks(listEl, ctx, out, depth) {
  const ordered = tagOf(listEl) === 'ol';
  let num = parseInt(listEl.getAttribute('start') || '1', 10) || 1;
  for (const li of listEl.children) {
    if (tagOf(li) !== 'li') { flow(li, ctx, out, depth); continue; }
    let marker = ordered ? `${num++}.` : '•';
    let first = true;
    let inl = [];
    const flush = () => {
      let h = cleanInline(inlineHtml(inl, ctx));
      inl = [];
      if (!h) return;
      if (first) {
        const task = /^\[([ xX])\]\s+/.exec(h);
        if (task) { marker = task[1] === ' ' ? '☐' : '☑'; h = h.slice(task[0].length); }
      }
      out.push({ t: 'li', m: first ? marker : '', d: Math.min(depth, 3), h });
      first = false;
    };
    for (const c of li.childNodes) {
      const tag = c.nodeType === 1 ? tagOf(c) : '';
      if (tag === 'ul' || tag === 'ol') { flush(); if (first) { out.push({ t: 'li', m: marker, d: Math.min(depth, 3), h: '' }); first = false; } listBlocks(c, ctx, out, depth + 1); }
      else if (tag === 'p' && !c.querySelector(BLOCK_SEL)) { flush(); inl = [...c.childNodes]; flush(); }
      else if (tag && (BLOCK.has(tag) || tag === 'img' || c.querySelector(BLOCK_SEL))) { flush(); first = false; flow({ childNodes: [c] }, ctx, out, depth + 1); }
      else inl.push(c);
    }
    flush();
  }
}

function tableBlock(t, ctx, out) {
  const rows = [...t.querySelectorAll('tr')].filter((r) => r.closest('table') === t);
  if (!rows.length) return;
  const cellsOf = (r) => [...r.children].filter((c) => /^t[dh]$/.test(tagOf(c)));
  let head = null;
  const firstCells = cellsOf(rows[0]);
  if (rows.length > 1 && firstCells.length && firstCells.every((c) => tagOf(c) === 'th')) {
    head = [];
    for (const c of firstCells) { head.push(cleanInline(inlineHtml(c.childNodes, ctx)).replace(/<\/?b>/g, '')); for (let k = 1; k < (+c.getAttribute('colspan') || 1); k++) head.push(''); }
    rows.shift();
  }
  let n = head ? head.length : 0;
  const body = [];
  for (const r of rows) {
    let col = 0;
    const row = [];
    for (const c of cellsOf(r)) {
      // cells can hold lists and paragraphs: flatten them to lines
      const inner = [];
      flow(c, ctx, inner, 0);
      const h = inner.map((b) => (b.t === 'li' ? `${b.m} ${b.h}` : b.t === 'h' ? `<b>${b.h}</b>` : b.h || '')).filter(Boolean).join('<br>');
      const span = +c.getAttribute('colspan') || 1;
      const cell = { h, c: col, n: plainLen(h) };
      if (span > 1) cell.s = span;
      row.push(cell);
      col += span;
    }
    n = Math.max(n, col);
    if (row.some((c) => c.h)) body.push(row);
  }
  if (body.length) out.push({ t: 'table', n, head, rows: body });
}

function flow(el, ctx, out, depth) {
  let inl = [];
  const flush = () => {
    const h = cleanInline(inlineHtml(inl, ctx));
    inl = [];
    if (h) out.push({ t: 'p', h });
  };
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { inl.push(n); continue; }
    if (n.nodeType !== 1) continue;
    const tag = tagOf(n);
    if (SKIP.has(tag)) continue;
    if (tag === 'img' || tag === 'image') { flush(); imageBlock(n, ctx, out); continue; }
    if (!BLOCK.has(tag) && !n.querySelector(BLOCK_SEL)) { inl.push(n); continue; }
    flush();
    const m = /^h([1-6])$/.exec(tag);
    if (m) {
      const h = cleanInline(inlineHtml(n.childNodes, ctx)).replace(/<\/?b>/g, '');
      if (h) out.push({ t: 'h', l: Math.min(4, +m[1]), h });
    } else if (tag === 'ul' || tag === 'ol') listBlocks(n, ctx, out, depth);
    else if (tag === 'blockquote' || tag === 'aside') {
      const inner = [];
      flow(n, ctx, inner, 0);
      if (inner.length) out.push({ t: 'callout', b: inner });
    } else if (tag === 'pre') {
      const x = n.textContent.replace(/\n+$/, '');
      if (x.trim()) out.push({ t: 'pre', x });
    } else if (tag === 'table') tableBlock(n, ctx, out);
    else if (tag === 'hr') out.push({ t: 'hr' });
    else if (tag === 'figcaption') {
      const h = cleanInline(inlineHtml(n.childNodes, ctx));
      if (h) out.push({ t: 'p', s: 1, h });
    } else if (tag === 'dt') {
      const h = cleanInline(inlineHtml(n.childNodes, ctx));
      if (h) out.push({ t: 'p', h: `<b>${h}</b>` });
    } else flow(n, ctx, out, depth);
  }
  flush();
}

// Markdown and HTML have no pages: split into sections at the top-level headings.
function sectionize(blocks) {
  const count = (l) => blocks.filter((b) => b.t === 'h' && b.l === l).length;
  const lvl = count(1) >= 2 ? 1 : count(2) >= 2 ? 2 : 0;
  const pages = [];
  let cur = [];
  for (const b of blocks) {
    if (lvl && b.t === 'h' && b.l <= lvl && cur.length) { pages.push(cur); cur = []; }
    cur.push(b);
  }
  if (cur.length) pages.push(cur);
  return pages.map((bl, i) => ({ n: i + 1, blocks: bl }));
}

const webImage = (src) => (/^https?:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(src) ? { u: src } : null);
const firstHeading = (pages) => {
  const h = pages.flatMap((p) => p.blocks).find((b) => b.t === 'h' && b.l <= 2);
  return h ? new DOMParser().parseFromString(h.h, 'text/html').body.textContent.trim() : '';
};
const model = (kind, title, pages, extra = {}) => ({ v: PARSER_VERSION, kind, title, numPages: pages.length, pages, ...extra });

function fromHtmlDoc(doc, kind, fallbackTitle, title) {
  const blocks = [];
  flow(doc.body, { image: webImage }, blocks, 0);
  if (!blocks.length) throw new Error('Nothing readable was found in this file.');
  const pages = sectionize(blocks);
  return model(kind, title || firstHeading(pages) || fallbackTitle, pages);
}

function parseMarkdown(text, name) {
  let src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  let title = '';
  const fm = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\n/.exec(src);
  if (fm) {
    title = (/^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]) || [])[1] || '';
    src = src.slice(fm[0].length);
  }
  const doc = new DOMParser().parseFromString(mdBlocks(src.split('\n')), 'text/html');
  return fromHtmlDoc(doc, 'md', name, title);
}

function parseHtml(text, name) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return fromHtmlDoc(doc, 'html', name, (doc.querySelector('title')?.textContent || '').trim());
}

/* ---------- EPUB ---------- */

async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let e = buf.byteLength - 22;
  const stop = Math.max(0, e - 65535);
  while (e >= stop && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < stop) throw new Error('This file is not a valid EPUB.');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let k = 0; k < count && p + 46 <= buf.byteLength; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true);
    entries.set(dec.decode(u8.subarray(p + 46, p + 46 + nameLen)), {
      method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const read = async (name) => {
    const en = entries.get(name);
    if (!en) return null;
    const start = en.off + 30 + dv.getUint16(en.off + 26, true) + dv.getUint16(en.off + 28, true);
    const raw = u8.subarray(start, start + en.size);
    if (en.method === 0) return raw.slice().buffer;
    if (en.method !== 8) throw new Error('Unsupported compression in this EPUB.');
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open EPUB files.');
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer();
  };
  return { has: (n) => entries.has(n), read, text: async (n) => { const b = await read(n); return b ? dec.decode(b) : ''; } };
}

function resolvePath(base, rel) {
  const clean = decodeURIComponent(rel.split('#')[0].split('?')[0]);
  const parts = (clean.startsWith('/') ? clean.slice(1) : base + clean).split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const els = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

async function coverFrom(asset) {
  try {
    const bmp = await createImageBitmap(new Blob([asset.data], { type: asset.type }));
    const c = document.createElement('canvas');
    c.width = 220;
    c.height = Math.round((220 * bmp.height) / bmp.width);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } catch { return ''; }
}

async function parseEpub(buf, name, onProgress) {
  const zip = await unzip(buf);
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await zip.text('META-INF/container.xml'));
  const opfPath = els(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('This file is not a valid EPUB.');
  const opf = xml(await zip.text(opfPath));
  const base = dirOf(opfPath);
  const manifest = new Map();
  for (const it of els(opf, 'item')) {
    manifest.set(it.getAttribute('id'), {
      path: resolvePath(base, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '',
    });
  }
  // Books usually mark italics and bold through CSS classes: pick up the simple cases.
  const ctx = { bold: new Set(), italic: new Set() };
  for (const it of manifest.values()) {
    if (it.type !== 'text/css') continue;
    const css = (await zip.text(it.path)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const cls = [...m[1].matchAll(/\.([\w-]+)\s*(?:,|$)/g)].map((x) => x[1]);
      if (/font-style\s*:\s*italic/i.test(m[2])) cls.forEach((c) => ctx.italic.add(c));
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(m[2])) cls.forEach((c) => ctx.bold.add(c));
    }
  }
  const assets = {};
  const loadAsset = async (path) => {
    if (path in assets) return assets[path];
    const data = await zip.read(path);
    if (!data) return (assets[path] = null);
    const a = { type: MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream', data };
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: a.type }));
      a.w = bmp.width;
      a.h = bmp.height;
      bmp.close?.();
    } catch { /* size unknown (e.g. SVG) */ }
    return (assets[path] = a);
  };

  const spine = els(opf, 'itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter((it) => it && /html|xml/.test(it.type));
  if (!spine.length) throw new Error('This EPUB has no readable chapters.');
  const pages = [];
  for (let s = 0; s < spine.length; s++) {
    const path = spine[s].path;
    const src = await zip.text(path);
    let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    const body = doc.body || els(doc, 'body')[0];
    if (body) {
      const here = dirOf(path);
      // Images are loaded up front so the converter itself can stay synchronous.
      const found = new Map();
      for (const im of [...els(doc, 'img'), ...els(doc, 'image')]) {
        const ref = im.getAttribute('src') || im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
        if (!ref || /^(data:|https?:)/i.test(ref)) continue;
        const p = resolvePath(here, ref);
        const a = await loadAsset(p);
        if (a) found.set(ref.trim(), { k: p, ...(a.w ? { w: a.w, h: a.h } : {}) });
      }
      const blocks = [];
      flow(body, { ...ctx, image: (ref) => found.get(ref) || webImage(ref) }, blocks, 0);
      if (blocks.length) pages.push({ n: pages.length + 1, blocks });
    }
    if (onProgress) await onProgress(s + 1, spine.length);
  }
  if (!pages.length) throw new Error('This EPUB has no readable text (it may be copy-protected).');
  for (const k of Object.keys(assets)) if (!assets[k]) delete assets[k];

  const title = (els(opf, 'title')[0]?.textContent || '').trim() || firstHeading(pages) || name;
  const author = (els(opf, 'creator')[0]?.textContent || '').trim();
  let coverItem = [...manifest.values()].find((it) => /\bcover-image\b/.test(it.props));
  if (!coverItem) {
    const id = els(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    coverItem = manifest.get(id);
  }
  const coverAsset = coverItem && coverItem.type.startsWith('image/') ? await loadAsset(coverItem.path) : null;
  if (coverAsset && !pages.some((p) => p.blocks.some((b) => b.k === coverItem.path))) delete assets[coverItem.path];
  return model('epub', title, pages, { author, assets, cover: coverAsset ? await coverFrom(coverAsset) : '' });
}

/* ---------- entry points ---------- */

// A simple typographic cover for documents that have none.
export function textCover(title, kind) {
  const c = document.createElement('canvas');
  c.width = 220;
  c.height = 293;
  const g = c.getContext('2d');
  g.fillStyle = '#0f6f7c';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(255,255,255,.16)';
  g.fillRect(18, 22, 44, 5);
  g.fillStyle = '#fff';
  g.font = '600 22px Georgia, serif';
  g.textBaseline = 'top';
  const words = String(title).split(/\s+/);
  let line = '', y = 44;
  for (const w of words) {
    if (g.measureText(line + ' ' + w).width > 184 && line) { g.fillText(line, 18, y); y += 27; line = w; if (y > 200) { line += '…'; break; } } else line = line ? line + ' ' + w : w;
  }
  g.fillText(line, 18, y);
  g.font = '600 11px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.fillText({ md: 'MARKDOWN', html: 'HTML', epub: 'EPUB' }[kind] || '', 18, 262);
  return c.toDataURL('image/jpeg', 0.85);
}

// Returns the block model for a non-PDF file. `model.cover` (a data URL) is set
// for the caller to move onto the library entry.
export async function parse(kind, buf, name, onProgress) {
  const base = String(name || 'Untitled').replace(/\.[^.]+$/, '');
  let m;
  if (kind === 'epub') m = await parseEpub(buf, base, onProgress);
  else {
    const text = new TextDecoder().decode(buf);
    m = kind === 'html' ? parseHtml(text, base) : parseMarkdown(text, base);
  }
  if (!m.cover) m.cover = textCover(m.title, kind);
  return m;
}
