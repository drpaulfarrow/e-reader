// Reflow engine: turns PDF pages (via pdf.js) into a list of simple blocks
// (headings, paragraphs, list items, callouts, tables, figures) that can be
// laid out at any width. It has no DOM dependencies so it can run in tests.

export const PARSER_VERSION = 3;

/* ---------- small helpers ---------- */

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const inBox = (b, x, y, pad = 0) => x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;

function parseColor(a) {
  if (!a) return null;
  if (typeof a[0] === 'string') {
    const h = a[0].replace('#', '');
    if (h.length < 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (typeof a[0] !== 'number') return null;
  return [a[0], a[1], a[2]];
}

function unionFind(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  };
  return { find, union: (a, b) => { p[find(a)] = find(b); } };
}

function groupsOf(n, uf) {
  const g = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!g.has(r)) g.set(r, []);
    g.get(r).push(i);
  }
  return [...g.values()];
}

// Union boxes that come within `pad` of each other. Sweep on x keeps this fast.
function clusterBoxes(boxes, pad) {
  const n = boxes.length;
  const uf = unionFind(n);
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].x0 - boxes[b].x0);
  for (let a = 0; a < n; a++) {
    const A = boxes[order[a]];
    for (let b = a + 1; b < n; b++) {
      const B = boxes[order[b]];
      if (B.x0 > A.x1 + pad) break;
      if (B.y0 <= A.y1 + pad && A.y0 <= B.y1 + pad) uf.union(order[a], order[b]);
    }
  }
  return groupsOf(n, uf).map((g) => g.map((i) => boxes[i]));
}

const bboxOf = (els) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    if (e.x0 < x0) x0 = e.x0;
    if (e.y0 < y0) y0 = e.y0;
    if (e.x1 > x1) x1 = e.x1;
    if (e.y1 > y1) y1 = e.y1;
  }
  return { x0, y0, x1, y1 };
};

/* ---------- drawing primitives (rules, fills, images) ---------- */

function extractPrims(ol, OPS, vt, W, H) {
  const prims = [];
  let ctm = vt.slice();
  let fill = [0, 0, 0];
  let stroke = [0, 0, 0];
  let lw = 1;
  const stack = [];
  let pend = [];
  const push = () => stack.push([ctm, fill, stroke, lw]);
  const pop = () => { if (stack.length) [ctm, fill, stroke, lw] = stack.pop(); };
  const N = { [OPS.moveTo]: 2, [OPS.lineTo]: 2, [OPS.curveTo]: 6, [OPS.curveTo2]: 4, [OPS.curveTo3]: 4, [OPS.closePath]: 0 };
  const imgOps = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup,
    OPS.paintSolidColorImageMask, OPS.paintJpegXObject,
  ].filter((v) => v !== undefined));
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke]);

  const shape = (pts, rect, curves) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      const [px, py] = pt(ctm, x, y);
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
    }
    return { x0, y0, x1, y1, rect, curves };
  };

  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i];
    const a = ol.argsArray[i];
    if (f === OPS.save) push();
    else if (f === OPS.restore) pop();
    else if (f === OPS.transform) ctm = mul(ctm, a);
    else if (f === OPS.paintFormXObjectBegin) { push(); if (a && a[0]) ctm = mul(ctm, a[0]); }
    else if (f === OPS.paintFormXObjectEnd) pop();
    else if (f === OPS.setFillRGBColor) fill = parseColor(a) || fill;
    else if (f === OPS.setStrokeRGBColor) stroke = parseColor(a) || stroke;
    else if (f === OPS.setLineWidth) lw = a[0];
    else if (f === OPS.constructPath) {
      const ops = a[0], c = a[1];
      if (!ops || !c || typeof ops.length !== 'number') continue;
      let k = 0, cur = null;
      const flush = () => { if (cur && cur.pts.length > 1) pend.push(shape(cur.pts, !cur.curves && cur.pts.length <= 5, cur.curves)); cur = null; };
      for (const op of ops) {
        if (op === OPS.rectangle) {
          flush();
          const x = c[k], y = c[k + 1], w = c[k + 2], h = c[k + 3];
          k += 4;
          pend.push(shape([[x, y], [x + w, y], [x, y + h], [x + w, y + h]], true, false));
        } else {
          const n = N[op] ?? 0;
          if (op === OPS.moveTo) { flush(); cur = { pts: [], curves: false }; }
          if (!cur) cur = { pts: [], curves: false };
          for (let j = 0; j + 1 < n; j += 2) cur.pts.push([c[k + j], c[k + j + 1]]);
          if (n > 2) cur.curves = true;
          k += n;
        }
      }
      flush();
    } else if (fillOps.has(f) || strokeOps.has(f)) {
      const isStroke = strokeOps.has(f);
      const pad = isStroke ? (lw || 1) * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) / 2 : 0;
      for (const s of pend) {
        prims.push({ ...s, x0: s.x0 - pad, y0: s.y0 - pad, x1: s.x1 + pad, y1: s.y1 + pad, kind: isStroke ? 'stroke' : 'fill', color: isStroke ? stroke : fill });
      }
      pend = [];
    } else if (f === OPS.endPath) pend = [];
    else if (imgOps.has(f)) {
      const s = shape([[0, 0], [1, 0], [0, 1], [1, 1]], true, false);
      prims.push({ ...s, kind: 'image', color: null });
    }
  }

  const out = [];
  for (const p of prims) {
    p.x0 = Math.max(0, p.x0); p.y0 = Math.max(0, p.y0);
    p.x1 = Math.min(W, p.x1); p.y1 = Math.min(H, p.y1);
    const w = p.x1 - p.x0, h = p.y1 - p.y0;
    if (w <= 0 && h <= 0) continue;
    if (w < 0 || h < 0) continue;
    if (p.kind === 'fill' && p.color && p.color[0] >= 250 && p.color[1] >= 250 && p.color[2] >= 250) continue;
    p.big = w > 0.85 * W && h > 0.85 * H;
    out.push(p);
  }
  return out;
}

/* ---------- text items ---------- */

function extractItems(tc, vt, page) {
  const fonts = new Map();
  const fontInfo = (name) => {
    if (fonts.has(name)) return fonts.get(name);
    let n = '';
    try { n = page.commonObjs.get(name)?.name || ''; } catch { /* font not resolved */ }
    const st = tc.styles?.[name];
    const info = {
      bold: /bold|black|heavy|semibold|demi/i.test(n),
      italic: /italic|oblique/i.test(n),
      sym: /symbol|wingdings|dingbat/i.test(n),
      mono: /mono|courier|consolas|menlo/i.test(n) || st?.fontFamily === 'monospace',
    };
    fonts.set(name, info);
    return info;
  };
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const m = mul(vt, it.transform);
    const fs = Math.hypot(m[2], m[3]);
    if (!fs || fs < 1) continue;
    if (Math.abs(m[1]) > 0.2 * Math.abs(m[0]) || m[0] <= 0) continue; // rotated text
    const fi = fontInfo(it.fontName);
    items.push({
      x: m[4], y: m[5], w: Math.abs(it.width), fs, str: it.str,
      sp: !it.str.trim(), bold: fi.bold, italic: fi.italic, sym: fi.sym,
    });
  }
  return items;
}

/* ---------- lines ---------- */

// Split a row of items into segments at wide horizontal gaps (column gutters, tabs).
function makeSegments(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let row = null;
  for (const it of sorted) {
    if (row && Math.abs(it.y - row.y) <= 0.4 * Math.max(it.fs, row.fs)) {
      row.items.push(it);
      if (!it.sp && it.fs > row.fs) row.fs = it.fs;
    } else {
      row = { y: it.y, fs: it.fs, items: [it] };
      rows.push(row);
    }
  }
  const segs = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let seg = null, spaced = false;
    for (const it of r.items) {
      if (it.sp) { spaced = true; continue; }
      const gap = seg ? it.x - seg.x1 : 0;
      if (!seg || gap > Math.max(6, 1.0 * Math.max(it.fs, seg.lastFs))) {
        seg = { x0: it.x, x1: it.x + it.w, y: it.y, fs: it.fs, lastFs: it.fs, parts: [], chars: 0 };
        segs.push(seg);
      } else {
        const needSp = spaced || gap > 0.2 * it.fs;
        if (needSp) seg.parts.push({ s: ' ', b: it.bold && seg.parts.at(-1)?.b, i: false });
      }
      seg.parts.push({ s: it.str, b: it.bold, i: it.italic, sym: it.sym, n: it.str.length, fs: it.fs });
      seg.x1 = Math.max(seg.x1, it.x + it.w);
      seg.lastFs = it.fs;
      seg.chars += it.str.trim().length;
      spaced = false;
    }
  }
  for (const s of segs) {
    // dominant font size by character count
    const by = new Map();
    for (const p of s.parts) if (p.fs) by.set(p.fs, (by.get(p.fs) || 0) + p.n);
    let best = s.fs, bn = -1;
    for (const [k, v] of by) if (v > bn) { best = k; bn = v; }
    s.fs = best;
    s.y0 = s.y - 0.8 * s.fs;
    s.y1 = s.y + 0.25 * s.fs;
    s.text = s.parts.map((p) => p.s).join('');
  }
  return segs;
}

function gaps(els, lo, hi) {
  const iv = els.map((e) => [e[lo], e[hi]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let end = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] > end) out.push({ pos: (end + iv[i][0]) / 2, size: iv[i][0] - end });
    if (iv[i][1] > end) end = iv[i][1];
  }
  return out;
}

// Recursive XY-cut: orders elements for reading, handling multi-column pages.
function xyCut(els, fs, out) {
  if (els.length <= 1) { if (els.length) out.push(els); return; }
  const sideOk = (side) => {
    if (side.some((e) => e.box)) return true;
    const lens = side.map((e) => e.chars);
    return side.length >= 3 && lens.reduce((a, b) => a + b, 0) >= 80 && median(lens) >= 12;
  };
  const vg = gaps(els, 'x0', 'x1').filter((g) => g.size >= Math.max(8, fs)).sort((a, b) => b.size - a.size);
  for (const g of vg) {
    const L = els.filter((e) => e.x1 <= g.pos), R = els.filter((e) => e.x0 >= g.pos);
    if (L.length + R.length === els.length && sideOk(L) && sideOk(R)) {
      xyCut(L, fs, out);
      xyCut(R, fs, out);
      return;
    }
  }
  const hg = gaps(els, 'y0', 'y1').sort((a, b) => b.size - a.size)[0];
  if (hg && hg.size >= 0.45 * fs) {
    xyCut(els.filter((e) => e.y1 <= hg.pos), fs, out);
    xyCut(els.filter((e) => e.y0 >= hg.pos), fs, out);
    return;
  }
  out.push(els);
}

// Turn one XY-cut leaf into a top-to-bottom sequence of text lines and boxes.
function leafToFlow(leaf) {
  const boxes = leaf.filter((e) => e.box);
  const segs = leaf.filter((e) => !e.box).sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  let cur = null;
  for (const s of segs) {
    if (cur && Math.abs(s.y - cur.y) <= 0.4 * Math.max(s.fs, cur.fs)) cur.segs.push(s);
    else { cur = { y: s.y, fs: s.fs, segs: [s] }; lines.push(cur); }
  }
  for (const ln of lines) {
    ln.segs.sort((a, b) => a.x0 - b.x0);
    ln.x0 = ln.segs[0].x0;
    ln.x1 = ln.segs.at(-1).x1;
    let best = ln.segs[0];
    for (const s of ln.segs) if (s.chars > best.chars) best = s;
    ln.fs = best.fs;
    ln.y = best.y;
    ln.runs = [];
    ln.segs.forEach((s, i) => {
      if (i) ln.runs.push({ s: ' ', b: false, i: false });
      for (const p of s.parts) ln.runs.push({ s: p.s, b: !!p.b, i: !!p.i });
    });
    ln.text = ln.runs.map((r) => r.s).join('');
    const vis = ln.runs.filter((r) => r.s.trim());
    ln.allBold = vis.length > 0 && vis.every((r) => r.b);
  }
  const flow = [...lines, ...boxes.map((b) => ({ ...b, y: b.y0 }))];
  flow.sort((a, b) => (a.box ? a.y0 : a.y - a.fs * 0.8) - (b.box ? b.y0 : b.y - b.fs * 0.8));
  return flow;
}

function itemsToFlow(items, boxes = []) {
  const segs = makeSegments(items);
  const els = [...segs, ...boxes];
  if (!els.length) return [];
  const fs = median(segs.map((s) => s.fs)) || 10;
  const leaves = [];
  xyCut(els, fs, leaves);
  return leaves.flatMap(leafToFlow);
}

/* ---------- paragraphs, lists ---------- */

// A hyphen at a line end is either a real hyphen ("pay-as-" / "you-go") or a
// typesetter's word break ("infor-" / "mation"). We mark them with HY and decide
// per document: only heavily hyphenated documents get their hyphens removed.
const HY = '\u0001';
const stats = { joins: 0, hyph: 0 };

const MARK = /^\s*([\u2022\u25E6\u25AA\u25AB\u25A0\u25A1\u25CF\u25CB\u2219\u2023\u2043\u27A2\u27A4\u25BA\u25B6\u2713\u2714\u2794\uF0A7\uF0B7\uF0D8\uF076\uF0FC]|[-\u2013\u2014*]|\(?\d{1,3}[.)]|\(?[a-zA-Z]\)|\(?[ivxIVX]{1,4}\))\s+(?=\S)/;

function markerOf(ln) {
  const first = ln.segs[0];
  if (ln.segs.length > 1 && first.parts.every((p) => p.sym || !p.s.trim()) && first.text.trim().length === 1) {
    return { len: first.text.length + 1, label: '•', sep: true, textX: ln.segs[1].x0 };
  }
  const m = MARK.exec(ln.text);
  if (!m) return null;
  const sep = ln.segs.length > 1 && first.text.trim() === m[1];
  const numbered = /[\w)]/.test(m[1]);
  const dash = /^[-–—*]$/.test(m[1]);
  return { len: m[0].length, label: numbered ? m[1] : dash ? '–' : '•', sep, numbered, textX: sep ? ln.segs[1].x0 : null };
}

const endsSentence = (t) => /[.!?:;”"')\]]\s*$/.test(t);

function buildBlocks(flow) {
  const blocks = [];
  let cur = null;
  const close = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (const el of flow) {
    if (el.box) { close(); blocks.push(el); continue; }
    const ln = el;
    if (!ln.text.trim()) continue;
    const mk = markerOf(ln);
    let brk = !cur;
    if (cur) {
      const prev = cur.lines.at(-1);
      const dy = ln.y - prev.y;
      if (Math.abs(ln.fs - cur.fs) > 0.08 * cur.fs) brk = true;
      else if (dy < -0.5 * ln.fs) brk = endsSentence(prev.text) || !/^[a-z]/.test(ln.text.trim()) || !!mk;
      else if (dy > 1.9 * cur.fs) brk = true;
      else if (cur.lead && dy > cur.lead * 1.3 + 0.5) brk = true;
      else if (mk && (mk.sep || ln.x0 < prev.x0 - 2 || (cur.mk && Math.abs(ln.x0 - cur.lines[0].x0) < 2))) brk = true;
      else if (cur.allBold && !ln.allBold && cur.text.length < 120 && !ln.runs.find((r) => r.s.trim())?.b) brk = true;
      else if (!cur.allBold && ln.allBold && Math.abs(ln.x0 - cur.x0) < 2 && endsSentence(prev.text)) brk = true;
      else if (!cur.mk && ln.x0 > prev.x0 + 0.8 * ln.fs && cur.lines.length >= 2) brk = true;
      else if (cur.lines.length >= 2 && prev.x1 < cur.maxX1 - 3 * cur.fs && /[.!?]\s*$/.test(prev.text) && /^[A-Z\d“"(]/.test(ln.text.trim())) brk = true;
    }
    if (brk) {
      close();
      cur = { lines: [ln], fs: ln.fs, x0: ln.x0, maxX1: ln.x1, allBold: ln.allBold, mk, text: ln.text, y0: ln.y - ln.fs, lead: 0 };
    } else {
      if (!cur.lead) cur.lead = ln.y - cur.lines.at(-1).y;
      cur.lines.push(ln);
      cur.x0 = Math.min(cur.x0, ln.x0);
      cur.maxX1 = Math.max(cur.maxX1, ln.x1);
      cur.allBold = cur.allBold && ln.allBold;
      cur.text += ' ' + ln.text;
    }
  }
  close();
  return blocks;
}

// Join a block's lines into inline HTML, removing line-break hyphenation.
function blockHtml(b, plain) {
  const runs = [];
  b.lines.forEach((ln, li) => {
    let rs = ln.runs.map((r) => ({ ...r }));
    if (li === 0 && b.mk) {
      let n = b.mk.len;
      while (n > 0 && rs.length) {
        if (rs[0].s.length <= n) { n -= rs[0].s.length; rs.shift(); } else { rs[0].s = rs[0].s.slice(n); n = 0; }
      }
    }
    if (li > 0 && runs.length && rs.length) {
      while (runs.length > 1 && !runs.at(-1).s.trim()) runs.pop();
      const last = runs.at(-1);
      last.s = last.s.trimEnd();
      const next = rs.find((r) => r.s.trim());
      stats.joins++;
      const soft = /[a-z][\u2010\u00AD]$/.test(last.s);
      if ((soft || /[a-z]-$/.test(runs.slice(-3).map((r) => r.s).join(''))) && next && /^[a-z]/.test(next.s.trimStart())) {
        if (!soft) stats.hyph++;
        last.s = last.s.slice(0, -1) + (soft ? '' : HY);
        while (rs.length && !rs[0].s.trim()) rs.shift();
        rs[0].s = rs[0].s.trimStart();
      } else if (!/[\u3000-\u9FFF]$/.test(last.s)) {
        runs.push({ s: ' ', b: last.b && rs[0].b, i: last.i && rs[0].i });
      }
    }
    runs.push(...rs);
  });
  // merge same-style runs and collapse whitespace
  const merged = [];
  for (const r of runs) {
    const key = plain ? '' : (r.b ? 'b' : '') + (r.i ? 'i' : '');
    const s = r.s.replace(/[\uF0A7\uF0B7\uF0D8\uF076\uF0FC]/g, '\u2022');
    if (merged.length && (merged.at(-1).key === key || !s.trim())) merged.at(-1).s += s;
    else merged.push({ key, s });
  }
  let html = '';
  let text = '';
  for (const m of merged) {
    let s = m.s.replace(/\s+/g, ' ');
    s = s.replace(/([a-z]) -([a-z])/g, '$1-$2'); // stray space before a hyphen (kerning artefact)
    if (!text || text.endsWith(' ')) s = s.trimStart();
    if (!s) continue;
    text += s;
    let h = esc(s);
    if (m.key.includes('i')) h = `<i>${h}</i>`;
    if (m.key.includes('b')) h = `<b>${h}</b>`;
    html += h;
  }
  return { html: html.trim(), text: text.trim() };
}

function finishBlocks(raw, body) {
  const out = [];
  const lis = raw.filter((b) => !b.box && b.mk);
  const liBase = lis.length ? Math.min(...lis.map((b) => b.lines[0].x0)) : 0;
  for (const b of raw) {
    if (b.box) { out.push(b.block); continue; }
    const r = body ? b.fs / body : 1;
    const head = body && r >= 1.15 && b.text.length < 220 && b.lines.length <= 4;
    const minor = body && !head && !b.mk && b.allBold && b.lines.length <= 2 && b.text.length <= 100 && r >= 0.95 && !/[.,;]\s*$/.test(b.text);
    if (head || minor) {
      const { html } = blockHtml({ ...b, mk: null }, true);
      if (html) out.push({ t: 'h', l: head ? (r >= 1.9 ? 1 : r >= 1.35 ? 2 : 3) : 4, h: html });
      continue;
    }
    const { html, text } = blockHtml(b, false);
    if (!html) continue;
    const blk = b.mk
      ? { t: 'li', m: b.mk.label, d: Math.max(0, Math.min(3, Math.round((b.lines[0].x0 - liBase) / 16))), h: html }
      : { t: 'p', h: html };
    if (body && r <= 0.87) blk.s = 1;
    blk.x = text; // plain text, used for cross-page joins; stripped before saving
    out.push(blk);
  }
  return out;
}

/* ---------- tables ---------- */

function cluster1d(vals, tol) {
  const s = [...vals].sort((a, b) => a - b);
  const out = [];
  let grp = [];
  for (const v of s) {
    if (grp.length && v - grp.at(-1) > tol) { out.push(grp); grp = []; }
    grp.push(v);
  }
  if (grp.length) out.push(grp);
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

function findTables(prims, items) {
  const lines = [];
  const T = 2.0;
  for (const p of prims) {
    if (p.kind === 'image' || p.curves) continue;
    const w = p.x1 - p.x0, h = p.y1 - p.y0;
    if (h <= T && w >= 2.5) lines.push({ hz: true, pos: (p.y0 + p.y1) / 2, a: p.x0, b: p.x1, x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 });
    else if (w <= T && h >= 2.5) lines.push({ hz: false, pos: (p.x0 + p.x1) / 2, a: p.y0, b: p.y1, x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 });
    else if (p.kind === 'stroke' && p.rect && w > 6 && h > 6) {
      lines.push({ hz: true, pos: p.y0, a: p.x0, b: p.x1, x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y0 });
      lines.push({ hz: true, pos: p.y1, a: p.x0, b: p.x1, x0: p.x0, x1: p.x1, y0: p.y1, y1: p.y1 });
      lines.push({ hz: false, pos: p.x0, a: p.y0, b: p.y1, x0: p.x0, x1: p.x0, y0: p.y0, y1: p.y1 });
      lines.push({ hz: false, pos: p.x1, a: p.y0, b: p.y1, x0: p.x1, x1: p.x1, y0: p.y0, y1: p.y1 });
    }
  }
  if (lines.length < 4) return [];
  const tables = [];
  for (const comp of clusterBoxes(lines, 3.2)) {
    const Hl = comp.filter((l) => l.hz), Vl = comp.filter((l) => !l.hz);
    if (Hl.length < 2 || Vl.length < 2) continue;
    const ys = cluster1d(Hl.map((l) => l.pos), 2.5), xs = cluster1d(Vl.map((l) => l.pos), 2.5);
    if (ys.length < 2 || xs.length < 2) continue;
    const R = ys.length - 1, C = xs.length - 1;
    const box = { x0: xs[0], x1: xs[C], y0: ys[0], y1: ys[R] };
    if (box.x1 - box.x0 < 60 || box.y1 - box.y0 < 8) continue;
    const cover = (set, pos, a, b) => {
      let s = 0;
      for (const l of set) if (Math.abs(l.pos - pos) <= 2.5) s += Math.max(0, Math.min(l.b, b) - Math.max(l.a, a));
      return s / Math.max(1e-6, b - a);
    };
    let hc = 0;
    for (const y of ys) hc += Math.min(1, cover(Hl, y, box.x0, box.x1));
    if (hc / ys.length < 0.5) continue;

    const uf = unionFind(R * C);
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (c + 1 < C && cover(Vl, xs[c + 1], ys[r], ys[r + 1]) < 0.5) uf.union(r * C + c, r * C + c + 1);
        if (r + 1 < R && cover(Hl, ys[r + 1], xs[c], xs[c + 1]) < 0.5) uf.union(r * C + c, (r + 1) * C + c);
      }
    }
    const cells = new Map();
    const cellAt = (r, c) => {
      const k = uf.find(r * C + c);
      if (!cells.has(k)) cells.set(k, { items: [], r0: r, r1: r, c0: c, c1: c });
      const cell = cells.get(k);
      cell.r0 = Math.min(cell.r0, r); cell.r1 = Math.max(cell.r1, r);
      cell.c0 = Math.min(cell.c0, c); cell.c1 = Math.max(cell.c1, c);
      return cell;
    };
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cellAt(r, c);
    const locate = (arr, v) => { for (let i = 0; i < arr.length - 1; i++) if (v >= arr[i] - 1 && v < arr[i + 1] + (i === arr.length - 2 ? 1 : 0)) return i; return -1; };
    tables.push({ ...box, xs, ys, R, C, cellAt, locate, cells, chars: 0 });
  }
  // assign text
  for (const t of tables) {
    for (const it of items) {
      if (it.table) continue;
      const px = it.x + Math.min(it.w / 2, 2), py = it.y - it.fs * 0.3;
      if (!inBox(t, px, py, 1)) continue;
      const r = t.locate(t.ys, py), c = t.locate(t.xs, px);
      if (r < 0 || c < 0) continue;
      it.table = t;
      t.cellAt(r, c).items.push(it);
      if (!it.sp) t.chars += it.str.length;
    }
  }
  const good = tables.filter((t) => t.chars > 0 && [...t.cells.values()].filter((c) => c.items.some((i) => !i.sp)).length >= 2);
  for (const it of items) if (it.table && !good.includes(it.table)) it.table = null;
  return good;
}

function buildTable(t, prims) {
  const fills = prims.filter((p) => p.kind === 'fill' && p.color && p.x1 - p.x0 > 3 && p.y1 - p.y0 > 3 && inBox(t, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, 2));
  for (const cell of t.cells.values()) {
    const raw = buildBlocks(itemsToFlow(cell.items));
    const fin = finishBlocks(raw, null);
    cell.parts = fin.map((b) => (b.t === 'li' ? `${esc(b.m)} ${b.h}` : b.h));
    cell.bold = raw.length > 0 && raw.every((b) => b.allBold);
    cell.len = fin.reduce((n, b) => n + (b.x || '').length, 0);
    const bx = { x0: t.xs[cell.c0], x1: t.xs[cell.c1 + 1], y0: t.ys[cell.r0], y1: t.ys[cell.r1 + 1] };
    const area = (bx.x1 - bx.x0) * (bx.y1 - bx.y0);
    const by = new Map();
    for (const f of fills) {
      const ow = Math.min(f.x1, bx.x1) - Math.max(f.x0, bx.x0), oh = Math.min(f.y1, bx.y1) - Math.max(f.y0, bx.y0);
      if (ow > 0 && oh > 0) { const k = hex(f.color); by.set(k, (by.get(k) || 0) + ow * oh); }
    }
    let best = null, ba = 0;
    for (const [k, v] of by) if (v > ba) { best = k; ba = v; }
    if (best && ba >= 0.3 * area) cell.bg = best;
  }
  const rows = [];
  for (let r = 0; r < t.R; r++) {
    const row = [];
    const seen = new Set();
    for (let c = 0; c < t.C; c++) {
      const cell = t.cellAt(r, c);
      if (seen.has(cell)) continue;
      seen.add(cell);
      row.push(cell);
    }
    if (row.some((c) => c.parts.length)) rows.push(row);
  }
  if (!rows.length) return null;
  const dark = (c) => c.bg && lum([1, 3, 5].map((i) => parseInt(c.bg.slice(i, i + 2), 16))) < 0.5;
  if (rows.length === 1) {
    return { t: 'tiles', cells: rows[0].filter((c) => c.parts.length).map((c) => c.parts) };
  }
  let head = null;
  const first = rows[0].filter((c) => c.parts.length);
  if (rows[0].length > 1 && first.length && first.every((c) => c.bold || dark(c))) {
    head = [];
    for (const c of rows[0]) { head.push(c.parts.join(' ').replace(/<\/?b>/g, '')); for (let k = c.c0; k < c.c1; k++) head.push(''); }
    rows.shift();
  }
  return {
    t: 'table', n: t.C, head,
    rows: rows.map((row) => row.map((c) => {
      const o = { h: c.parts.join('<br>'), c: c.c0, n: c.len };
      if (c.c1 > c.c0) o.s = c.c1 - c.c0 + 1;
      if (c.bg && !dark(c)) o.bg = c.bg;
      return o;
    })),
  };
}

/* ---------- callouts and figures ---------- */

function findRegions(prims, items, W, H) {
  const figs = [], callouts = [];
  for (const g of clusterBoxes(prims, 3.5)) {
    const b = bboxOf(g);
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (w < 4 || h < 4) continue;
    const area = w * h;
    const inside = items.filter((it) => !it.table && !it.sp && inBox(b, it.x + Math.min(it.w / 2, 2), it.y - it.fs * 0.3));
    const chars = inside.reduce((n, it) => n + it.str.length, 0);
    const textArea = inside.reduce((n, it) => n + it.w * it.fs, 0);
    const img = g.some((p) => p.kind === 'image' && p.x1 - p.x0 >= 16 && p.y1 - p.y0 >= 16);
    if (img) {
      if (chars > 400 && textArea / area > 0.3) continue; // image is a text backdrop
      figs.push({ ...b, items: inside });
      continue;
    }
    const rectFills = g.every((p) => p.kind === 'fill' && p.rect);
    const fillArea = g.reduce((n, p) => n + (p.x1 - p.x0) * (p.y1 - p.y0), 0);
    if (rectFills && chars > 0 && w >= 80 && fillArea / area >= 0.6) {
      const by = new Map();
      for (const p of g) { const k = hex(p.color); by.set(k, (by.get(k) || 0) + (p.x1 - p.x0) * (p.y1 - p.y0)); }
      const bg = [...by].sort((a, c) => c[1] - a[1])[0][0];
      const bar = g.find((p) => p.x1 - p.x0 <= 5 && p.y1 - p.y0 >= 6 && hex(p.color) !== bg);
      callouts.push({ ...b, items: inside, color: bg, accent: bar ? hex(bar.color) : null });
      continue;
    }
    const curves = g.filter((p) => p.curves).length;
    if ((g.length >= 6 || curves >= 2) && w >= 40 && h >= 40 && textArea / area < 0.35 && area < 0.9 * W * H) {
      figs.push({ ...b, items: inside });
    }
  }
  return { figs, callouts };
}

/* ---------- page + document ---------- */

async function analyzePage(page, OPS, n) {
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height, vt = vp.transform;
  const ol = await page.getOperatorList();
  const tc = await page.getTextContent();
  const items = extractItems(tc, vt, page);
  const chars = items.reduce((s, it) => s + (it.sp ? 0 : it.str.length), 0);
  let prims = extractPrims(ol, OPS, vt, W, H);
  prims = prims.filter((p) => !p.big || (p.kind === 'image' && chars < 100));

  const tables = findTables(prims, items);
  const rest = prims.filter((p) => !tables.some((t) => inBox(t, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, 3)));
  const { figs, callouts } = findRegions(rest, items, W, H);

  const free = [];
  for (const it of items) {
    if (it.table) continue;
    const px = it.x + Math.min(it.w / 2, 2), py = it.y - it.fs * 0.3;
    if (figs.some((f) => inBox(f, px, py))) continue;
    const co = callouts.find((c) => inBox(c, px, py));
    if (co) continue; // already collected in co.items
    free.push(it);
  }

  const boxes = [];
  for (const t of tables) {
    const block = buildTable(t, prims);
    if (block) boxes.push({ box: true, x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1, block });
  }
  for (const f of figs) {
    const pad = 2;
    const bx = [Math.max(0, f.x0 - pad), Math.max(0, f.y0 - pad), Math.min(W, f.x1 + pad), Math.min(H, f.y1 + pad)].map((v) => Math.round(v * 10) / 10);
    const alt = f.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').slice(0, 600);
    boxes.push({ box: true, x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, block: { t: 'fig', p: n, box: bx, alt } });
  }
  for (const c of callouts) {
    const inner = finishBlocks(buildBlocks(itemsToFlow(c.items)), null);
    if (!inner.length) continue;
    const block = { t: 'callout', c: c.color, b: inner };
    if (c.accent) block.a = c.accent;
    boxes.push({ box: true, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, block });
  }
  return { n, W, H, flow: itemsToFlow(free, boxes) };
}

const strip = (blocks) => {
  for (const b of blocks) {
    delete b.x;
    if (b.b) strip(b.b);
  }
};

function finalize(pages, title) {
  // Running headers and footers: same text (digits aside) in the page margins.
  const sig = (ln) => ln.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const inMargin = (ln, pg) => ln.y < 0.08 * pg.H || ln.y - ln.fs > 0.89 * pg.H;
  const counts = new Map();
  for (const pg of pages) {
    const seen = new Set();
    for (const el of pg.flow) {
      if (el.box || !inMargin(el, pg)) continue;
      const s = sig(el);
      if (!seen.has(s)) { seen.add(s); counts.set(s, (counts.get(s) || 0) + 1); }
    }
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.4));
  for (const pg of pages) {
    // first and last lines count as margin text too (pages with unusual scaling)
    const textLines = pg.flow.filter((el) => !el.box);
    const edge = new Set([textLines[0], textLines.at(-1)]);
    pg.flow = pg.flow.filter((el) => {
      if (el.box) return true;
      if (!inMargin(el, pg)) return !(edge.has(el) && pages.length >= 3 && counts.get(sig(el)) >= need);
      const s = sig(el);
      if (/^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–—]\s*#\s*[-–—]$/.test(s)) return false;
      return !(pages.length >= 3 && counts.get(s) >= need);
    });
  }
  // Body text size: the most common size by character count.
  const sizes = new Map();
  for (const pg of pages) for (const el of pg.flow) {
    if (el.box) continue;
    const k = Math.round(el.fs * 2) / 2;
    sizes.set(k, (sizes.get(k) || 0) + el.text.length);
  }
  let body = 10, bn = -1;
  for (const [k, v] of sizes) if (v > bn) { body = k; bn = v; }

  const out = [];
  for (const pg of pages) out.push({ n: pg.n, w: Math.round(pg.W), h: Math.round(pg.H), blocks: finishBlocks(buildBlocks(pg.flow), body) });

  const dehyph = stats.hyph >= 5 && stats.hyph / Math.max(1, stats.joins) > 0.03;
  const fix = (v) => (typeof v === 'string' ? v.replaceAll(HY, dehyph ? '' : '-')
    : Array.isArray(v) ? v.map(fix)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
    : v);
  for (const pg of out) pg.blocks = fix(pg.blocks);

  // Join paragraphs that continue across a page break.
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i].blocks.at(-1), b = out[i + 1].blocks[0];
    if (a && b && a.t === 'p' && b.t === 'p' && !a.s === !b.s && a.x && b.x && !endsSentence(a.x) && /^[a-z]/.test(b.x)) {
      if (/[a-z]-$/.test(a.x)) a.h = (dehyph ? a.h.replace(/-((<\/\w>)*)$/, '$1') : a.h) + b.h;
      else a.h += ' ' + b.h;
      out[i + 1].blocks.shift();
    }
  }
  // Numbered section headings ("3. Methods") should share one level even when
  // a page was scaled differently.
  const numbered = out.flatMap((p) => p.blocks).filter((b) => b.t === 'h' && /^\d{1,2}\.?\s+\S/.test(b.h));
  if (numbered.length >= 3) {
    const tally = new Map();
    for (const b of numbered) tally.set(b.l, (tally.get(b.l) || 0) + 1);
    const lvl = [...tally].sort((x, y) => y[1] - x[1])[0][0];
    for (const b of numbered) b.l = lvl;
  }
  let t = (title || '').trim();
  if (!t || /^(untitled|microsoft word|document\d*)/i.test(t) || /\.(docx?|pdf|indd|tex)$/i.test(t)) {
    const h = out.flatMap((p) => p.blocks).find((b) => b.t === 'h' && b.l <= 2);
    t = h ? h.h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
  }
  for (const pg of out) strip(pg.blocks);
  return { v: PARSER_VERSION, title: t, numPages: out.length, pages: out };
}

export async function reflowDocument(pdf, OPS, onProgress) {
  const pages = [];
  stats.joins = stats.hyph = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    try {
      pages.push(await analyzePage(page, OPS, n));
    } catch (err) {
      console.warn('reflow: page', n, err);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ n, W: vp.width, H: vp.height, flow: [{ box: true, x0: 0, y0: 0, x1: vp.width, y1: vp.height, block: { t: 'fig', p: n, box: [0, 0, Math.round(vp.width), Math.round(vp.height)], alt: '' } }] });
    }
    page.cleanup();
    if (onProgress) await onProgress(n, pdf.numPages);
  }
  let title = '';
  try { title = (await pdf.getMetadata())?.info?.Title || ''; } catch { /* no metadata */ }
  return finalize(pages, title);
}
