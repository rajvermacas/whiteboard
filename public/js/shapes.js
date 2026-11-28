/* Whiteboard Teacher — building drawings: every object is one <g> made of parts */
'use strict';
// ======================================================================
// building objects: every object is one <g> made of parts {el, kind: stroke|text|fade}
// ======================================================================
function addText(g, parts, x, y, text, o = {}) {
  const size = o.size || 26;
  const t = el('text', {
    x: f1(x), y: f1(y), 'font-size': size, fill: o.color || '#1f2328', 'text-anchor': o.anchor || 'start',
    class: o.font === 'math' ? 'math' : 'hand', 'font-weight': o.weight || null,
  }, g);
  const lines = String(text).split('\n').slice(0, 12);
  lines.forEach((ln, i) => { const ts = el('tspan', { x: f1(x), dy: i ? f1(size * 1.12) : 0 }, t); ts.textContent = ln; });
  if (o.dominant) t.setAttribute('dominant-baseline', o.dominant);
  parts.push({ el: t, kind: 'text', chars: String(text).length, color: o.color });
  return t;
}
function addStroke(g, parts, d, color, o = {}) {
  const p = el('path', { d, fill: 'none', stroke: color, 'stroke-width': o.width || 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': o.dash ? '10 8' : null }, g);
  parts.push({ el: p, kind: 'stroke', color, dashed: !!o.dash });
  return p;
}
function addFill(g, parts, d, color, opacity = 0.13) {
  const p = el('path', { d, fill: color, 'fill-opacity': opacity, stroke: 'none' }, g);
  parts.push({ el: p, kind: 'fade' });
  return p;
}
function measureW(g, text, size, font) {
  const t = el('text', { 'font-size': size, class: font === 'math' ? 'math' : 'hand', x: 0, y: 0, opacity: 0 }, g);
  let w = 0; for (const ln of String(text).split('\n')) { t.textContent = ln; w = Math.max(w, t.getComputedTextLength()); }
  t.remove(); return w;
}
function fillColor(c, color) {
  if (c.fill === true || c.fill === 'true') return color;
  if (typeof c.fill === 'string' && c.fill !== 'none' && c.fill !== 'false') return col(c.fill, color);
  return null;
}

const PLOT_FN = { exp: Math.exp, sigmoid: x => 1 / (1 + Math.exp(-x)), tanh: Math.tanh, relu: x => Math.max(0, x), gelu: x => 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x ** 3))), linear: x => x, square: x => x * x, sin: Math.sin, cos: Math.cos, log: x => Math.log(Math.max(x, 1e-6)) };
function samplePlot(c) {
  if (c.points && c.points.length) return { pts: c.points, fn: null };
  const key = String(c.fn || 'sigmoid').toLowerCase(), fn = PLOT_FN[key] || PLOT_FN.sigmoid;
  const [a, b] = Array.isArray(c.domain) ? [num(c.domain[0], -4), num(c.domain[1], 4)] : key === 'exp' ? [-2, 2] : key === 'log' ? [0.05, 5] : key === 'sin' || key === 'cos' ? [-6.3, 6.3] : [-4, 4];
  const pts = []; for (let i = 0; i <= 80; i++) { const x = a + (b - a) * i / 80; pts.push([x, fn(x)]); }
  return { pts, fn };
}

function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))), m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
const col_ = v => col(v, '#1d6fb8');
const CODE_KW = /^(?:def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|lambda|yield|pass|break|continue|function|const|let|var|new|this|async|await|of|switch|case|default|public|private|static|void|int|float|double|bool|boolean|string|struct|fn|pub|impl|use|mod|match|SELECT|FROM|WHERE|JOIN|GROUP|BY|ORDER|INSERT|UPDATE|DELETE|None|True|False|null|true|false|undefined)$/;
function highlightCode(line, lang) {
  const out = [], re = /(#.*$|\/\/.*$|--.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)|(\s+)|([^\sA-Za-z_\d"'`#]+)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) out.push([m[1], '#7d848c']);
    else if (m[2]) out.push([m[2], '#2a8a3e']);
    else if (m[3]) out.push([m[3], '#c48a00']);
    else if (m[4]) out.push([m[4], CODE_KW.test(m[4]) ? '#7a48c2' : /^[A-Z]/.test(m[4]) ? '#1d6fb8' : '#1f2328']);
    else out.push([m[0], '#1f2328']);
    if (m[0] === '') re.lastIndex++;
  }
  return out.length ? out : [[' ', '#1f2328']];
}

function rrPath(x, y, w, h, rad) {
  const q = Math.max(0, Math.min(rad, w / 2, h / 2));
  return `M${f1(x + q)} ${f1(y)} H${f1(x + w - q)} Q${f1(x + w)} ${f1(y)} ${f1(x + w)} ${f1(y + q)} V${f1(y + h - q)} Q${f1(x + w)} ${f1(y + h)} ${f1(x + w - q)} ${f1(y + h)} H${f1(x + q)} Q${f1(x)} ${f1(y + h)} ${f1(x)} ${f1(y + h - q)} V${f1(y + q)} Q${f1(x)} ${f1(y)} ${f1(x + q)} ${f1(y)} Z`;
}
// Safari/WebKit paints positioned HTML inside an SVG <foreignObject> in page coordinates, ignoring the board's
// pan and zoom (KaTeX's HTML is full of position:relative), so formulas stayed pinned to the screen. There,
// formulas are rendered as native MathML, which has no positioned boxes. Chrome/Firefox keep KaTeX's HTML.
const IS_WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(navigator.userAgent);
const MATH_OUTPUT = IS_WEBKIT ? 'mathml' : 'html';
function unionBox(ids) {
  let b = null;
  for (const id of ids) { const o = objs.get(id); if (!o) continue; const q = bbOf(o); b = b ? { x: Math.min(b.x, q.x), y: Math.min(b.y, q.y), width: Math.max(b.x + b.width, q.x + q.width) - Math.min(b.x, q.x), height: Math.max(b.y + b.height, q.y + q.height) - Math.min(b.y, q.y) } : q; }
  return b;
}

const builders = {
  write(c, g, parts) {
    addText(g, parts, c.x, c.y, c.text, { size: c.size, color: c.color, anchor: c.align === 'center' ? 'middle' : 'start', font: c.font });
  },
  box(c, g, parts, r) {
    const ls = c.size || 26, ss = Math.round(ls * 0.72);
    const lw = c.label ? measureW(g, c.label, ls) : 0, sw = c.sub ? measureW(g, c.sub, ss) : 0;
    const w = c.w || Math.max(90, Math.max(lw, sw) + 44), h = c.h || (c.sub ? 92 : 66);
    const fc = fillColor(c, c.color);
    if (fc) addFill(g, parts, `M${c.x} ${c.y} h${w} v${h} h${-w} Z`, fc);
    addStroke(g, parts, roughRect(c.x, c.y, w, h, r), c.color);
    const cx = c.x + w / 2, nLines = c.label ? c.label.split('\n').length : 0;
    let ly = c.y + h / 2 + ls * 0.33 - (c.sub ? ss * 0.6 : 0) - (nLines - 1) * ls * 0.56;
    if (c.label) addText(g, parts, cx, ly, c.label, { size: ls, color: c.color, anchor: 'middle', weight: 700 });
    if (c.sub) addText(g, parts, cx, ly + ls * 0.56 * (nLines - 1) * 2 + ss * 1.15, c.sub, { size: ss, color: '#5b636b', anchor: 'middle' });
  },
  circle(c, g, parts, r) {
    const ls = c.size || 26, lw = c.label ? measureW(g, c.label, ls) : 0;
    const rx = c.rx || c.r || Math.max(44, lw / 2 + 20), ry = c.ry || c.r || Math.max(44, rx * 0.8);
    const fc = fillColor(c, c.color);
    if (fc) parts.push({ el: el('ellipse', { cx: c.x, cy: c.y, rx, ry, fill: fc, 'fill-opacity': .13 }, g), kind: 'fade' });
    addStroke(g, parts, roughEllipse(c.x, c.y, rx, ry, r), c.color);
    if (c.label) addText(g, parts, c.x, c.y + ls * 0.33 - (c.label.split('\n').length - 1) * ls * 0.56, c.label, { size: ls, color: c.color, anchor: 'middle', weight: 700 });
  },
  vector(c, g, parts, r) {
    const vals = c.values.map(v => str(v, 14)), size = 22;
    const cw = Math.max(58, ...vals.map(v => measureW(g, v, size) + 24)), ch = 40, n = vals.length;
    if (c.orient === 'row') {   // 1×N: the cells side by side
      if (c.label) addText(g, parts, c.x + (cw * n) / 2, c.y - 14, c.label, { size: 24, color: c.color, anchor: 'middle', weight: 700 });
      (c.highlight || []).forEach(i => { if (i >= 0 && i < n) addFill(g, parts, `M${c.x + i * cw} ${c.y} h${cw} v${ch} h${-cw} Z`, c.color, 0.22); });
      let d = roughRect(c.x, c.y, cw * n, ch, r);
      for (let i = 1; i < n; i++) d += ' ' + roughSeg(c.x + i * cw, c.y, c.x + i * cw, c.y + ch, r, 0.6);
      addStroke(g, parts, d, c.color, { width: 2.5 });
      vals.forEach((v, i) => addText(g, parts, c.x + i * cw + cw / 2, c.y + ch / 2 + 8, v, { size, color: '#1f2328', anchor: 'middle' }));
      return;
    }
    if (c.label) addText(g, parts, c.x + cw / 2, c.y - 14, c.label, { size: 24, color: c.color, anchor: 'middle', weight: 700 });
    (c.highlight || []).forEach(i => { if (i >= 0 && i < n) addFill(g, parts, `M${c.x} ${c.y + i * ch} h${cw} v${ch} h${-cw} Z`, c.color, 0.22); });
    let d = roughRect(c.x, c.y, cw, ch * n, r);
    for (let i = 1; i < n; i++) d += ' ' + roughSeg(c.x, c.y + i * ch, c.x + cw, c.y + i * ch, r, 0.6);
    addStroke(g, parts, d, c.color, { width: 2.5 });
    vals.forEach((v, i) => addText(g, parts, c.x + cw / 2, c.y + i * ch + ch / 2 + 8, v, { size, color: '#1f2328', anchor: 'middle' }));
  },
  matrix(c, g, parts, r) {
    const rows = c.values.map(row => (Array.isArray(row) ? row : [row]).slice(0, 10).map(v => str(v, 12)));
    const nr = rows.length, nc = Math.max(1, ...rows.map(r => r.length)), size = 21;
    const cw = Math.max(54, ...rows.flat().map(v => measureW(g, v, size) + 22)), ch = 38;
    const rl = (c.rowLabels || []).map(v => str(v, 16)), cl = (c.colLabels || []).map(v => str(v, 16));
    const rlw = rl.length ? Math.max(...rl.map(v => measureW(g, v, 20))) + 14 : 0;
    const x0 = c.x + rlw, y0 = c.y + (cl.length ? 30 : 0);
    if (c.label) addText(g, parts, x0 + (cw * nc) / 2, c.y - 14, c.label, { size: 24, color: c.color, anchor: 'middle', weight: 700 });
    const tint = (x, y, w, h) => addFill(g, parts, `M${x} ${y} h${w} v${h} h${-w} Z`, c.color, 0.2);
    (c.highlightRows || []).forEach(i => { if (i < nr) tint(x0, y0 + i * ch, cw * nc, ch); });
    (c.highlightCols || []).forEach(j => { if (j < nc) tint(x0 + j * cw, y0, cw, ch * nr); });
    (c.highlightCells || []).forEach(([i, j]) => { if (i < nr && j < nc) { tint(x0 + j * cw, y0 + i * ch, cw, ch); addStroke(g, parts, roughRect(x0 + j * cw + 3, y0 + i * ch + 3, cw - 6, ch - 6, r), c.color, { width: 2.2 }); } });
    let d = roughRect(x0, y0, cw * nc, ch * nr, r);
    for (let i = 1; i < nr; i++) d += ' ' + roughSeg(x0, y0 + i * ch, x0 + cw * nc, y0 + i * ch, r, 0.5);
    for (let j = 1; j < nc; j++) d += ' ' + roughSeg(x0 + j * cw, y0, x0 + j * cw, y0 + ch * nr, r, 0.5);
    addStroke(g, parts, d, c.color, { width: 2.5 });
    cl.forEach((v, j) => j < nc && addText(g, parts, x0 + j * cw + cw / 2, y0 - 10, v, { size: 19, color: '#7d848c', anchor: 'middle' }));
    rl.forEach((v, i) => i < nr && addText(g, parts, x0 - 8, y0 + i * ch + ch / 2 + 7, v, { size: 20, color: '#7d848c', anchor: 'end' }));
    rows.forEach((row, i) => row.forEach((v, j) => addText(g, parts, x0 + j * cw + cw / 2, y0 + i * ch + ch / 2 + 7, v, { size, anchor: 'middle' })));
  },
  bars(c, g, parts, r) {
    const raw = c.values.map(v => num(v, 0, -1e9, 1e9)), n = raw.length;
    const mx = Math.max(...raw.map(Math.abs), 1e-9), norm = mx > 1;
    const w = c.w || Math.max(200, n * 62), h = c.h || 150, slot = w / n, bw = slot * 0.62;
    if (c.label) addText(g, parts, c.x + w / 2, c.y - 16, c.label, { size: 24, color: c.color, anchor: 'middle', weight: 700 });
    addStroke(g, parts, roughSeg(c.x, c.y + h, c.x + w, c.y + h, r) + ' ' + roughSeg(c.x, c.y + h, c.x, c.y, r), '#1f2328', { width: 2.2 });
    raw.forEach((v, i) => {
      const fr = clamp(norm ? Math.abs(v) / mx : Math.abs(v), 0, 1), bh = Math.max(2, fr * (h - 24)), bx = c.x + i * slot + (slot - bw) / 2, by = c.y + h - bh;
      addFill(g, parts, `M${bx} ${by} h${bw} v${bh} h${-bw} Z`, c.color, 0.25);
      addStroke(g, parts, roughRect(bx, by, bw, bh, r), c.color, { width: 2.2 });
      addText(g, parts, bx + bw / 2, by - 6, norm ? String(+v.toFixed(2)) : Math.round(v * 100) + '%', { size: 18, color: '#5b636b', anchor: 'middle' });
      if (c.labels && c.labels[i] != null) addText(g, parts, bx + bw / 2, c.y + h + 22, str(c.labels[i], 14), { size: 19, anchor: 'middle' });
    });
  },
  plot(c, g, parts, r) {
    const w = c.w || 280, h = c.h || 170, x0 = c.x, y0 = c.y;
    const { pts, fn } = samplePlot(c);
    let xa = Math.min(...pts.map(p => p[0])), xb = Math.max(...pts.map(p => p[0])), ya = Math.min(...pts.map(p => p[1])), yb = Math.max(...pts.map(p => p[1]));
    if (xb - xa < 1e-9) xb = xa + 1; if (yb - ya < 1e-9) yb = ya + 1;
    const pad = (yb - ya) * 0.08; ya -= pad; yb += pad;
    const X = x => x0 + (x - xa) / (xb - xa) * w, Y = y => y0 + h - (y - ya) / (yb - ya) * h;
    const axY = ya <= 0 && yb >= 0 ? Y(0) : y0 + h, axX = xa <= 0 && xb >= 0 ? X(0) : x0;
    addStroke(g, parts, roughSeg(x0 - 8, axY, x0 + w + 10, axY, r) + ` M${x0 + w + 2} ${axY - 6} L${x0 + w + 10} ${axY} L${x0 + w + 2} ${axY + 6}` + ' ' + roughSeg(axX, y0 + h + 8, axX, y0 - 10, r) + ` M${axX - 6} ${y0 - 2} L${axX} ${y0 - 10} L${axX + 6} ${y0 - 2}`, '#1f2328', { width: 2 });
    addStroke(g, parts, smoothPath(pts.map(p => [X(p[0]), Y(p[1])])), c.color, { width: 3.2 });
    if (c.label) addText(g, parts, x0 + w / 2, y0 - 18, c.label, { size: 24, color: c.color, anchor: 'middle', weight: 700 });
    (c.marks || []).forEach(m => {
      const mxv = typeof m === 'object' ? num(m.x, 0) : num(m, 0), myv = typeof m === 'object' && m.y != null ? num(m.y, 0) : fn ? fn(mxv) : 0;
      const px = X(mxv), py = Y(myv);
      const dot = el('circle', { cx: f1(px), cy: f1(py), r: 5, fill: c.color }, g); parts.push({ el: dot, kind: 'fade' });
      const lab = typeof m === 'object' && m.label ? str(m.label, 30) : `(${+mxv.toFixed(2)}, ${+myv.toFixed(2)})`;
      addText(g, parts, px + 8, py - 8, lab, { size: 18, color: '#5b636b' });
    });
  },
  line(c, g, parts, r) {
    const pts = c.points;
    const d = c.smooth ? smoothPath(pts) : pts.slice(1).map((p, i) => roughSeg(pts[i][0], pts[i][1], p[0], p[1], r, 0.8)).join(' ');
    addStroke(g, parts, d, c.color, { width: c.width, dash: c.dash });
  },
  arrow(c, g, parts) {
    const geo = arrowGeometry(c); if (!geo) return false;
    const [p1, q, p2] = geo;
    addStroke(g, parts, `M${f1(p1[0])} ${f1(p1[1])} Q${f1(q[0])} ${f1(q[1])} ${f1(p2[0])} ${f1(p2[1])}`, c.color, { width: c.width || 2.8, dash: c.dash });
    const ang = Math.atan2(p2[1] - q[1], p2[0] - q[0]), L = 15;
    const h1 = [p2[0] - L * Math.cos(ang - 0.45), p2[1] - L * Math.sin(ang - 0.45)], h2 = [p2[0] - L * Math.cos(ang + 0.45), p2[1] - L * Math.sin(ang + 0.45)];
    addStroke(g, parts, `M${f1(h1[0])} ${f1(h1[1])} L${f1(p2[0])} ${f1(p2[1])} L${f1(h2[0])} ${f1(h2[1])}`, c.color, { width: c.width || 2.8 });
    if (c.label) {
      const mx = 0.25 * p1[0] + 0.5 * q[0] + 0.25 * p2[0], my = 0.25 * p1[1] + 0.5 * q[1] + 0.25 * p2[1];
      if (geo.loop) { addText(g, parts, mx + 12, my + 7, c.label, { size: 20, color: c.color, anchor: 'start' }); return; }
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1], len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; if (ny > 0) { nx = -nx; ny = -ny; }
      addText(g, parts, mx + nx * 14, my + ny * 14, c.label, { size: 20, color: c.color, anchor: Math.abs(dy) > Math.abs(dx) ? 'start' : 'middle' });
    }
  },
  // ---- feature 4: real maths (KaTeX) and code blocks ----
  math(c, g, parts) {
    const size = c.size, output = MATH_OUTPUT;
    let w, h, node;
    if (window.katex) {
      const holder = document.createElement('div');
      holder.style.cssText = `position:absolute;left:-9999px;top:0;font-size:${size}px;color:${c.color};white-space:nowrap;`;
      try { window.katex.render(c.tex, holder, { throwOnError: false, displayMode: false, output }); } catch { holder.textContent = c.tex; }
      document.body.appendChild(holder); const r = holder.getBoundingClientRect(); w = Math.ceil(r.width) + 8; h = Math.ceil(r.height) + 8; holder.remove();
      const fo = el('foreignObject', { x: c.x, y: c.y - h * 0.72, width: w, height: h }, g);
      node = document.createElement('div'); node.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      node.style.cssText = `font-size:${size}px;color:${c.color};white-space:nowrap;padding:4px;line-height:1.2;`;
      try { window.katex.render(c.tex, node, { throwOnError: false, displayMode: false, output }); } catch { node.textContent = c.tex; }
      fo.appendChild(node);
      parts.push({ el: fo, kind: 'text', chars: Math.min(50, c.tex.length), color: c.color });
    } else addText(g, parts, c.x, c.y, c.tex.replace(/\\[a-zA-Z]+/g, m => ({ '\\alpha': 'α', '\\beta': 'β', '\\sigma': 'σ', '\\theta': 'θ', '\\eta': 'η', '\\lambda': 'λ', '\\sum': 'Σ', '\\cdot': '·', '\\times': '×', '\\nabla': '∇', '\\partial': '∂', '\\sqrt': '√', '\\pi': 'π' })[m] || '').replace(/[{}]/g, ''), { size, color: c.color, font: 'math' });
    if (c.label) addText(g, parts, c.x, c.y - (h ? h * 0.72 : size) - 10, c.label, { size: 20, color: '#7d848c' });
  },
  code(c, g, parts, r) {
    const size = c.size, lh = Math.round(size * 1.45), lines = c.code.split('\n');
    const t = el('text', { 'font-size': size, class: 'mono', x: 0, y: 0, opacity: 0 }, g);
    let maxW = 0; for (const ln of lines) { t.textContent = ln || ' '; maxW = Math.max(maxW, t.getComputedTextLength()); } t.remove();
    const pad = 14, top = c.title ? 30 : 0, w = Math.max(160, maxW + pad * 2 + 30), h = lines.length * lh + pad * 2 + top;
    addFill(g, parts, `M${c.x} ${c.y} h${w} v${h} h${-w} Z`, '#f6f8fa', 1);
    addStroke(g, parts, roughRect(c.x, c.y, w, h, r), '#7d848c', { width: 1.6 });
    if (c.title) addText(g, parts, c.x + pad, c.y + 22, c.title, { size: 18, color: '#5b636b' });
    lines.forEach((ln, i) => {
      const y = c.y + top + pad + lh * i + size;
      const num = el('text', { x: c.x + pad + 14, y, 'font-size': size * 0.8, class: 'mono', fill: '#b3b9c0', 'text-anchor': 'end' }, g); num.textContent = String(i + 1);
      parts.push({ el: num, kind: 'fade' });
      const tx = el('text', { x: c.x + pad + 26, y, 'font-size': size, class: 'mono', 'xml:space': 'preserve' }, g);
      for (const [tok, color] of highlightCode(ln, c.lang)) { const sp = el('tspan', { fill: color }, tx); sp.textContent = tok; }
      parts.push({ el: tx, kind: 'text', chars: Math.min(ln.length, 40), color: '#1f2328' });
    });
  },

  // ---- feature 5: components the app lays out from structure ----
  network(c, g, parts, r) {
    const L = c.layers, maxN = Math.max(...L.map(n => Math.min(n, 8))), gapX = c.gap || 150, gapY = 54, R = 17;
    const H = (maxN - 1) * gapY, pos = [];
    L.forEach((n, li) => {
      const shown = Math.min(n, 8), col = [];
      for (let k = 0; k < shown; k++) col.push([c.x + li * gapX, c.y + 40 + H / 2 - (shown - 1) * gapY / 2 + k * gapY]);
      pos.push(col);
    });
    let d = '';
    for (let li = 0; li + 1 < pos.length; li++) for (const a of pos[li]) for (const b of pos[li + 1]) d += `M${f1(a[0] + R)} ${f1(a[1])} L${f1(b[0] - R)} ${f1(b[1])} `;
    if (d) { const p = el('path', { d, fill: 'none', stroke: '#9aa1a9', 'stroke-width': 1.1, 'stroke-opacity': 0.55 }, g); parts.push({ el: p, kind: 'fade' }); }
    pos.forEach((col, li) => {
      const colr = li === c.active ? '#e07800' : li === 0 ? c.color : li === pos.length - 1 ? '#2a8a3e' : '#7a48c2';
      const fills = col.map(([x, y]) => `M${x - R} ${y} a${R} ${R} 0 1 0 ${2 * R} 0 a${R} ${R} 0 1 0 ${-2 * R} 0`).join(' ');
      addFill(g, parts, fills, colr, 0.16);
      addStroke(g, parts, col.map(([x, y]) => roughEllipse(x, y, R, R, r, 1.02)).join(' '), colr, { width: 2.4 });
      if (L[li] > 8) addText(g, parts, col[0][0], col[col.length - 1][1] + 34, `… ${L[li]}`, { size: 18, color: '#7d848c', anchor: 'middle' });
      if (c.labels && c.labels[li]) addText(g, parts, col[0][0], c.y + 16, str(c.labels[li], 24), { size: 20, color: colr, anchor: 'middle', weight: 700 });
      (c.nodeLabels && c.nodeLabels[li] || []).slice(0, col.length).forEach((t, k) => addText(g, parts, col[k][0], col[k][1] + 6, str(t, 4), { size: 15, anchor: 'middle' }));
    });
  },
  tree(c, g, parts, r) {
    const levelGap = 96, nodeGap = 26, sizeT = 20;
    const nodes = [];
    const walk = (n, depth) => {
      const node = { label: str(n.label ?? n.name ?? n, 30), depth, kids: [] };
      nodes.push(node);
      if (depth < 6 && nodes.length < 40) for (const ch of (Array.isArray(n.children) ? n.children : []).slice(0, 8)) node.kids.push(walk(ch, depth + 1));
      return node;
    };
    const root = walk(c.root, 0);
    nodes.forEach(n => { n.w = Math.max(70, measureW(g, n.label, sizeT) + 26); });
    const span = n => n.kids.length ? Math.max(n.w, n.kids.reduce((s2, k) => s2 + span(k), 0) + nodeGap * (n.kids.length - 1)) : n.w;
    const place = (n, left) => {
      const sp = span(n); n.cx = left + sp / 2; n.cy = c.y + n.depth * levelGap + 22;
      let x = left + (sp - (n.kids.reduce((s2, k) => s2 + span(k), 0) + nodeGap * Math.max(0, n.kids.length - 1))) / 2;
      for (const k of n.kids) { place(k, x); x += span(k) + nodeGap; }
    };
    place(root, c.x);
    let d = ''; for (const n of nodes) for (const k of n.kids) d += roughSeg(n.cx, n.cy + 22, k.cx, k.cy - 22, r, 0.6) + ' ';
    if (d) addStroke(g, parts, d, '#7d848c', { width: 2 });
    for (const n of nodes) {
      const col = n.depth === 0 ? c.color : n.kids.length ? '#7a48c2' : '#2a8a3e';
      addFill(g, parts, `M${n.cx - n.w / 2} ${n.cy - 22} h${n.w} v44 h${-n.w} Z`, col, 0.12);
      addStroke(g, parts, roughRect(n.cx - n.w / 2, n.cy - 22, n.w, 44, r), col, { width: 2.2 });
      addText(g, parts, n.cx, n.cy + 7, n.label, { size: sizeT, color: col, anchor: 'middle', weight: 700 });
    }
  },
  graph(c, g, parts, r) {
    const sizeT = 20, ids = c.nodes.map(n => n.id), byId = new Map();
    c.nodes.forEach(n => { n.w = Math.max(64, measureW(g, n.label, sizeT) + 26); byId.set(n.id, n); });
    const N = c.nodes.length;
    if (c.layout === 'circle') {
      const R = Math.max(110, N * 34);
      c.nodes.forEach((n, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / N; n.cx = c.x + R + Math.cos(a) * R; n.cy = c.y + R + Math.sin(a) * R; });
    } else if (c.layout === 'grid') {
      const cols = Math.ceil(Math.sqrt(N)), cw = Math.max(...c.nodes.map(n => n.w)) + 70;
      c.nodes.forEach((n, i) => { n.cx = c.x + (i % cols) * cw + cw / 2; n.cy = c.y + Math.floor(i / cols) * 110 + 30; });
    } else { // layered: longest-path layering, left to right (good for flows and DAGs)
      // drop back edges (found by DFS) so cycles don't scramble the columns, then longest-path layering
      const out = new Map(ids.map(i => [i, []])); for (const [a, b] of c.edges) if (out.has(a) && out.has(b) && a !== b) out.get(a).push(b);
      const state = new Map(), forward = [];
      const dfs = u => { state.set(u, 1); for (const v of out.get(u)) { if (state.get(v) === 1) continue; forward.push([u, v]); if (!state.get(v)) dfs(v); } state.set(u, 2); };
      for (const i of ids) if (!state.get(i)) dfs(i);
      const level = new Map(ids.map(i => [i, 0]));
      for (let it = 0; it < N; it++) for (const [a, b] of forward) if (level.get(b) < level.get(a) + 1) level.set(b, level.get(a) + 1);
      const cols = []; for (const n of c.nodes) { const l = level.get(n.id); (cols[l] = cols[l] || []).push(n); }
      let x = c.x; const tallest = Math.max(...cols.filter(Boolean).map(cc => cc.length));
      cols.forEach(col => { if (!col) return; const cw = Math.max(...col.map(n => n.w)); col.forEach((n, k) => { n.cx = x + cw / 2; n.cy = c.y + 30 + (k + (tallest - col.length) / 2) * 100; }); x += cw + 110; });
    }
    let d = '', heads = '';
    const edgeLabels = [], pairCount = new Map();
    for (const [a, b, lab] of c.edges) {
      const A = byId.get(a), B = byId.get(b); if (!A || !B || A === B) continue;
      const bx = n => ({ x: n.cx - n.w / 2, y: n.cy - 22, width: n.w, height: 44 });
      // curve edges that would cut through other nodes: back edges, long skips, and the 2nd edge of a pair
      const key = [a, b].sort().join('\u0000'), dup = pairCount.get(key) || 0; pairCount.set(key, dup + 1);
      const between = c.nodes.some(n => n !== A && n !== B && Math.abs(n.cy - A.cy) < 30 && Math.abs(n.cy - B.cy) < 30 && (n.cx - A.cx) * (n.cx - B.cx) < 0);
      const back = c.layout === 'layered' && B.cx <= A.cx;
      const bend = between || back || dup ? (back ? 1 : -1) * (60 + Math.hypot(B.cx - A.cx, B.cy - A.cy) * 0.18) * (dup ? -1 : 1) : 0;
      const mx = (A.cx + B.cx) / 2, my = (A.cy + B.cy) / 2, len = Math.hypot(B.cx - A.cx, B.cy - A.cy) || 1;
      const ctl = [mx - (B.cy - A.cy) / len * bend, my + (B.cx - A.cx) / len * bend];
      const p1 = edgePoint(bx(A), bend ? ctl : [B.cx, B.cy]), p2 = edgePoint(bx(B), bend ? ctl : [A.cx, A.cy]);
      d += bend ? `M${f1(p1[0])} ${f1(p1[1])} Q${f1(ctl[0])} ${f1(ctl[1])} ${f1(p2[0])} ${f1(p2[1])} ` : `M${f1(p1[0])} ${f1(p1[1])} L${f1(p2[0])} ${f1(p2[1])} `;
      const from = bend ? ctl : p1, ang = Math.atan2(p2[1] - from[1], p2[0] - from[0]);
      if (c.directed) heads += `M${f1(p2[0] - 13 * Math.cos(ang - 0.45))} ${f1(p2[1] - 13 * Math.sin(ang - 0.45))} L${f1(p2[0])} ${f1(p2[1])} L${f1(p2[0] - 13 * Math.cos(ang + 0.45))} ${f1(p2[1] - 13 * Math.sin(ang + 0.45))} `;
      if (lab) { const lx = bend ? 0.25 * p1[0] + 0.5 * ctl[0] + 0.25 * p2[0] : (p1[0] + p2[0]) / 2, ly = bend ? 0.25 * p1[1] + 0.5 * ctl[1] + 0.25 * p2[1] : (p1[1] + p2[1]) / 2; edgeLabels.push([lx, ly - 8, str(lab, 20)]); }
    }
    if (d) addStroke(g, parts, d + heads, '#5b636b', { width: 2.2 });
    for (const [x, y, t] of edgeLabels) addText(g, parts, x, y, t, { size: 17, color: '#7d848c', anchor: 'middle' });
    for (const n of c.nodes) {
      const col = n.color ? col_(n.color) : c.color;
      addFill(g, parts, `M${n.cx - n.w / 2} ${n.cy - 22} h${n.w} v44 h${-n.w} Z`, col, 0.12);
      addStroke(g, parts, roughRect(n.cx - n.w / 2, n.cy - 22, n.w, 44, r), col, { width: 2.2 });
      addText(g, parts, n.cx, n.cy + 7, n.label, { size: sizeT, color: col, anchor: 'middle', weight: 700 });
    }
  },
  numberline(c, g, parts, r) {
    const w = c.w, a = c.from, b = c.to, X = v => c.x + (v - a) / (b - a || 1) * w, y = c.y;
    let d = roughSeg(c.x - 10, y, c.x + w + 14, y, r) + ` M${c.x + w + 4} ${y - 7} L${c.x + w + 14} ${y} L${c.x + w + 4} ${y + 7}`;
    const step = c.step || niceStep((b - a) / 10), ticks = [];
    for (let v = Math.ceil(a / step) * step, k = 0; v <= b + 1e-9 && k < 60; v += step, k++) ticks.push(+v.toFixed(6));
    for (const v of ticks) d += ` M${f1(X(v))} ${y - 7} L${f1(X(v))} ${y + 7}`;
    addStroke(g, parts, d, '#1f2328', { width: 2.2 });
    for (const v of ticks) addText(g, parts, X(v), y + 30, String(v), { size: 17, color: '#5b636b', anchor: 'middle' });
    if (c.label) addText(g, parts, c.x + w / 2, y - 46, c.label, { size: 22, color: c.color, anchor: 'middle', weight: 700 });
    for (const m of c.marks) {
      const dot = el('circle', { cx: f1(X(m.at)), cy: y, r: 7, fill: m.color || c.color }, g); parts.push({ el: dot, kind: 'fade' });
      if (m.label) addText(g, parts, X(m.at), y - 16, m.label, { size: 19, color: m.color || c.color, anchor: 'middle' });
    }
  },
  timeline(c, g, parts, r) {
    const ev = c.events, w = c.w || Math.max(300, ev.length * 150), y = c.y + 60;
    addStroke(g, parts, roughSeg(c.x, y, c.x + w, y, r) + ` M${c.x + w - 10} ${y - 7} L${c.x + w} ${y} L${c.x + w - 10} ${y + 7}`, '#1f2328', { width: 2.4 });
    if (c.label) addText(g, parts, c.x, c.y, c.label, { size: 24, color: c.color, weight: 700 });
    ev.forEach((e, i) => {
      const x = c.x + 30 + (ev.length === 1 ? 0 : i * (w - 70) / (ev.length - 1)), up = i % 2 === 0;
      const dot = el('circle', { cx: f1(x), cy: y, r: 7, fill: c.color }, g); parts.push({ el: dot, kind: 'fade' });
      if (e.at) addText(g, parts, x, up ? y + 28 : y - 16, e.at, { size: 17, color: '#7d848c', anchor: 'middle' });
      addText(g, parts, x, up ? y - 18 : y + 34, e.label, { size: 20, color: '#1f2328', anchor: 'middle' });
    });
  },
  table(c, g, parts, r) {
    const size = 19, rows = [c.header, ...c.rows].filter(Boolean), nc = Math.max(...rows.map(rw => rw.length)), rh = 38;
    const cw = []; for (let j = 0; j < nc; j++) cw[j] = Math.max(60, ...rows.map(rw => measureW(g, str(rw[j] ?? '', 30), size) + 24));
    const W = cw.reduce((a2, b2) => a2 + b2, 0), H = rows.length * rh, x0 = c.x, y0 = c.y + (c.label ? 30 : 0);
    if (c.label) addText(g, parts, x0, c.y + 18, c.label, { size: 22, color: c.color, weight: 700 });
    if (c.header) addFill(g, parts, `M${x0} ${y0} h${W} v${rh} h${-W} Z`, c.color, 0.15);
    let d = roughRect(x0, y0, W, H, r), xx = x0;
    for (let i = 1; i < rows.length; i++) d += ' ' + roughSeg(x0, y0 + i * rh, x0 + W, y0 + i * rh, r, 0.4);
    for (let j = 0; j < nc - 1; j++) { xx += cw[j]; d += ' ' + roughSeg(xx, y0, xx, y0 + H, r, 0.4); }
    addStroke(g, parts, d, c.color, { width: 2 });
    rows.forEach((rw, i) => { let x = x0; for (let j = 0; j < nc; j++) { const v = str(rw[j] ?? '', 30); if (v) addText(g, parts, x + cw[j] / 2, y0 + i * rh + rh / 2 + 7, v, { size, anchor: 'middle', weight: i === 0 && c.header ? 700 : null, color: i === 0 && c.header ? c.color : '#1f2328' }); x += cw[j]; } });
  },
  // ---- pictures that carry the explanation ----
  icon(c, g, parts, r) {
    const key = window.WB_ICONS && WB_ICONS.resolve(c.name), S = c.size, k = S / 100, X = v => c.x + v * k, Y = v => c.y + v * k;
    if (!key) { // unknown icon: a labelled rounded tile with the initials, never a blank
      addFill(g, parts, rrPath(c.x, c.y, S, S, S * 0.18), c.color, 0.1);
      addStroke(g, parts, roughRect(c.x, c.y, S, S, r), c.color, { width: 2.6 });
      addText(g, parts, c.x + S / 2, c.y + S / 2 + S * 0.12, (c.name || '?').slice(0, 3).toUpperCase(), { size: S * 0.32, color: c.color, anchor: 'middle', weight: 700 });
    } else {
      let d = '', fills = '';
      for (const sh of WB_ICONS.shapes[key]) {
        const fill = sh[sh.length - 1] === 'fill'; let part = '';
        if (sh[0] === 'r') part = rrPath(X(sh[1]), Y(sh[2]), sh[3] * k, sh[4] * k, (sh[5] || 0) * k);
        else if (sh[0] === 'c') part = roughEllipse(X(sh[1]), Y(sh[2]), sh[3] * k, sh[3] * k, r, 1.02);
        else if (sh[0] === 'e') part = roughEllipse(X(sh[1]), Y(sh[2]), sh[3] * k, sh[4] * k, r, 1.02);
        else if (sh[0] === 'l') part = `M${f1(X(sh[1]))} ${f1(Y(sh[2]))} L${f1(X(sh[3]))} ${f1(Y(sh[4]))}`;
        else if (sh[0] === 'p') { const pts = sh[1]; part = 'M' + pts.map((v, i) => f1(i % 2 ? Y(v) : X(v))).join(' ').replace(/^(\S+ \S+)/, '$1 L') + (sh[2] === true ? ' Z' : ''); }
        else if (sh[0] === 'q') { let n = 0; part = sh[1].replace(/-?\d*\.?\d+/g, m => f1((n++ % 2 ? Y : X)(Number(m)))); }
        d += part + ' '; if (fill) fills += part + ' ';
      }
      if (fills) addFill(g, parts, fills, c.color, 0.18);
      addStroke(g, parts, d, c.color, { width: clamp(S / 24, 2, 5) });
    }
    if (c.label) addText(g, parts, c.x + S / 2, c.y + S + 24, c.label, { size: 20, color: '#1f2328', anchor: 'middle', weight: 700 });
    if (c.sub) addText(g, parts, c.x + S / 2, c.y + S + (c.label ? 46 : 24), c.sub, { size: 16, color: '#7d848c', anchor: 'middle' });
  },
  tokens(c, g, parts, r) {
    const size = c.size, h = Math.round(size * 1.7), top = c.label ? size * 1.5 : 0;
    if (c.label) addText(g, parts, c.x, c.y + size, c.label, { size: size, color: '#5b636b', weight: 700 });
    let x = c.x, y = c.y + top;
    c.items.forEach((it, i) => {
      const t = it.text, w = c.vertical ? Math.max(h * 1.6, ...c.items.map(z => measureW(g, z.text || ' ', size) + 20)) : Math.max(h, measureW(g, t || ' ', size) + 20);
      const color = it.color || (c.colors && c.colors[i]) || c.color, hl = c.highlight.includes(i);
      if (!t) addStroke(g, parts, roughRect(x, y, w, h, r), '#9aa1a9', { width: 1.6, dash: true });  // an empty slot
      else {
        addFill(g, parts, rrPath(x, y, w, h, 6), color, hl ? 0.38 : 0.14);
        addStroke(g, parts, roughRect(x, y, w, h, r), color, { width: hl ? 3.2 : 2 });
        addText(g, parts, x + w / 2, y + h / 2 + size * 0.34, t, { size, color: '#1f2328', anchor: 'middle' });
      }
      if (c.index) addText(g, parts, x + w / 2, y + h + 16, String(i), { size: 13, color: '#9aa1a9', anchor: 'middle' });
      if (c.vertical) y += h + c.gap; else x += w + c.gap;
    });
  },
  frame(c, g, parts, r) {
    let b = null;
    if (c.around.length) {
      // arrows are left out (they reach other things), except a loop from a drawing back to itself, which is part of it
      const isLoop = o => o.cmd.cmd === 'arrow' && !Array.isArray(o.cmd.from) && String(o.cmd.from) === String(o.cmd.to);
      const things = c.around.filter(id => objs.has(id) && (isLoop(objs.get(id)) || !['arrow', 'line', 'highlight', 'brace', 'frame'].includes(objs.get(id).cmd.cmd)));
      b = unionBox(things.length ? things : c.around); if (!b) return false;
    } else b = { x: c.x, y: c.y, width: c.w, height: c.h };
    const p = c.pad, x = b.x - p, w = b.width + 2 * p;
    // the label goes just above the frame unless something is already there; then inside
    const lw = c.label ? measureW(g, c.label, 21) + 8 : 0, above = { x: x + 10, y: b.y - p - 30, width: lw, height: 26 };
    const inside = c.label && [...objs.entries()].some(([k, o]) => k !== c.id && !c.around.includes(k) && overlaps(above, bbOf(o), 4));
    const top = inside ? 30 : 0, y = b.y - p - top, h = b.height + 2 * p + top;
    addStroke(g, parts, roughRect(x, y, w, h, r), c.color, { width: 2, dash: c.dash });
    if (c.label) addText(g, parts, x + 14, inside ? y + 26 : y - 9, c.label, { size: 21, color: c.color, weight: 700 });
    layerObj.insertBefore(g, layerObj.firstChild);   // frames sit behind what they group
  },
  brace(c, g, parts, r) {
    const b = unionBox(c.around); if (!b) return false;
    const d = 14, horiz = c.side === 'below' || c.side === 'above', sign = c.side === 'below' || c.side === 'right' ? 1 : -1;
    const a0 = horiz ? b.x : b.y, a1 = horiz ? b.x + b.width : b.y + b.height, mid = (a0 + a1) / 2;
    const base = c.side === 'below' ? b.y + b.height + 10 : c.side === 'above' ? b.y - 10 : c.side === 'right' ? b.x + b.width + 10 : b.x - 10;
    const P = (along, off) => horiz ? `${f1(along)} ${f1(base + sign * off)}` : `${f1(base + sign * off)} ${f1(along)}`;
    const path = `M${P(a0, 0)} Q${P(a0, d)} ${P(a0 + d, d)} L${P(mid - d, d)} Q${P(mid, d)} ${P(mid, 2 * d)} Q${P(mid, d)} ${P(mid + d, d)} L${P(a1 - d, d)} Q${P(a1, d)} ${P(a1, 0)}`;
    addStroke(g, parts, path, c.color, { width: 2.4 });
    if (c.label) {
      if (horiz) addText(g, parts, mid, c.side === 'below' ? base + 2 * d + 24 : base - 2 * d - 10, c.label, { size: 21, color: c.color, anchor: 'middle', weight: 700 });
      else addText(g, parts, c.side === 'right' ? base + 2 * d + 10 : base - 2 * d - 10, mid + 7, c.label, { size: 21, color: c.color, anchor: c.side === 'right' ? 'start' : 'end', weight: 700 });
    }
  },
  sequence(c, g, parts, r) {
    const A = c.actors, gap = c.gap, top = c.y + (c.label ? 40 : 0), boxH = 50, step = 64;
    if (c.label) addText(g, parts, c.x, c.y + 24, c.label, { size: 24, color: c.color, weight: 700 });
    const xs = A.map((a, i) => c.x + i * gap), bottom = top + boxH + 30 + c.messages.length * step;
    A.forEach((a, i) => {
      const w = Math.max(110, measureW(g, a.name, 22) + 30), x = xs[i] - w / 2 + 55;
      a.cx = xs[i] + 55;
      addFill(g, parts, rrPath(x, top, w, boxH, 8), c.color, 0.12);
      addStroke(g, parts, roughRect(x, top, w, boxH, r), c.color, { width: 2.4 });
      addText(g, parts, a.cx, top + boxH / 2 + 8, a.name, { size: 22, color: c.color, anchor: 'middle', weight: 700 });
    });
    addStroke(g, parts, A.map(a => `M${f1(a.cx)} ${top + boxH} L${f1(a.cx)} ${f1(bottom)}`).join(' '), '#9aa1a9', { width: 1.6, dash: true });
    c.messages.forEach((m, i) => {
      const fa = A.find(a => a.name === m.from), ta = A.find(a => a.name === m.to); if (!fa || !ta) return;
      const y = top + boxH + 40 + i * step, color = m.dash ? '#7d848c' : '#1f2328';
      if (fa === ta) { // a message to itself: a small loop
        addStroke(g, parts, `M${f1(fa.cx)} ${y} h40 v22 h-36 M${f1(fa.cx + 10)} ${y + 15} L${f1(fa.cx + 2)} ${y + 22} L${f1(fa.cx + 10)} ${y + 29}`, color, { width: 2.4, dash: m.dash });
        if (m.label) addText(g, parts, fa.cx + 48, y + 16, m.label, { size: 19, color });
        return;
      }
      const dir = ta.cx > fa.cx ? 1 : -1, x1 = fa.cx + dir * 4, x2 = ta.cx - dir * 4;
      addStroke(g, parts, `M${f1(x1)} ${y} L${f1(x2)} ${y} M${f1(x2 - dir * 13)} ${y - 7} L${f1(x2)} ${y} L${f1(x2 - dir * 13)} ${y + 7}`, color, { width: 2.4, dash: m.dash });
      if (m.label) addText(g, parts, (x1 + x2) / 2, y - 9, m.label, { size: 19, color: '#1d6fb8', anchor: 'middle' });
    });
  },
  schedule(c, g, parts, r) {
    const cw = c.cell, rh = 42, size = 18;
    const lw = Math.max(40, ...c.rows.map(rw => measureW(g, rw.label || ' ', size) + 18));
    const x0 = c.x + lw, y0 = c.y + (c.label ? 36 : 0) + 30, W = c.steps * cw, H = c.rows.length * rh;
    if (c.label) addText(g, parts, c.x, c.y + 22, c.label, { size: 24, color: c.color, weight: 700 });
    addText(g, parts, x0 - 8, y0 - 10, c.stepLabel, { size: 14, color: '#9aa1a9', anchor: 'end' });
    for (let t = 0; t < c.steps; t++) addText(g, parts, x0 + t * cw + cw / 2, y0 - 10, String(t + 1), { size: 15, color: '#7d848c', anchor: 'middle' });
    let gd = `M${x0} ${y0} H${x0 + W} V${y0 + H} H${x0} Z`;
    for (let i = 1; i < c.rows.length; i++) gd += ` M${x0} ${y0 + i * rh} H${x0 + W}`;
    for (let t = 1; t < c.steps; t++) gd += ` M${x0 + t * cw} ${y0} V${y0 + H}`;
    const grid = el('path', { d: gd, fill: 'none', stroke: '#d5d9de', 'stroke-width': 1.2 }, g); parts.push({ el: grid, kind: 'fade' });
    c.rows.forEach((rw, i) => {
      addText(g, parts, x0 - 10, y0 + i * rh + rh / 2 + 6, rw.label, { size, anchor: 'end', weight: 700 });
      for (const sp of rw.spans) {
        const bx = x0 + Math.min(sp.from, c.steps) * cw + 3, bw = (Math.min(sp.to, c.steps) - Math.min(sp.from, c.steps)) * cw - 6, by = y0 + i * rh + 6, bh = rh - 12;
        if (bw <= 0) continue;
        const color = sp.color || c.color;
        addFill(g, parts, rrPath(bx, by, bw, bh, 6), color, 0.3);
        addStroke(g, parts, roughRect(bx, by, bw, bh, r), color, { width: 2 });
        if (sp.label) { // fit the label inside its bar: shrink, then shorten
          let fs = 16, t = sp.label;
          while (fs > 11 && measureW(g, t, fs) > bw - 6) fs--;
          while (t.length > 1 && measureW(g, t, fs) > bw - 6) t = t.slice(0, -2) + '…';
          if (measureW(g, t, fs) <= bw - 2) addText(g, parts, bx + bw / 2, by + bh / 2 + fs * 0.35, t, { size: fs, color: '#1f2328', anchor: 'middle' });
        }
      }
    });
    for (const m of c.markers) {
      const mx = x0 + Math.min(m.at, c.steps) * cw;
      addStroke(g, parts, `M${f1(mx)} ${y0 - 4} L${f1(mx)} ${y0 + H + 10}`, '#d1382c', { width: 2, dash: true });
      if (m.label) addText(g, parts, mx, y0 + H + 30, m.label, { size: 16, color: '#d1382c', anchor: 'middle' });
    }
  },

  // ---- feature 6: the learner's own pen strokes ----
  ink(c, g, parts) {
    const p = el('path', { d: smoothPath(c.points), fill: 'none', stroke: c.color, 'stroke-width': c.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    parts.push({ el: p, kind: 'stroke', color: c.color });
  },

  highlight(c, g, parts, r) {
    const t = objs.get(c.target); if (!t) return false;
    const b = bbOf(t), p = 10;
    if (c.style === 'underline') addStroke(g, parts, roughSeg(b.x - 4, b.y + b.height + 8, b.x + b.width + 4, b.y + b.height + 6, r, 2), c.color, { width: 4 });
    else if (c.style === 'box') addStroke(g, parts, roughRect(b.x - p, b.y - p, b.width + 2 * p, b.height + 2 * p, r), c.color, { width: 3.5 });
    else addStroke(g, parts, roughEllipse(b.x + b.width / 2, b.y + b.height / 2, b.width / 2 + p + 12, b.height / 2 + p + 8, r, 1.12), c.color, { width: 3.5 });
  },
};

function endRef(ref) {
  if (Array.isArray(ref)) return { pt: [num(ref[0], 0), num(ref[1], 0)] };
  const o = objs.get(String(ref)); if (!o) return null;
  return { box: bbOf(o) };
}
const centerOf = e => e.pt || [e.box.x + e.box.width / 2, e.box.y + e.box.height / 2];
function edgePoint(box, toward) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, dx = toward[0] - cx, dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const hw = box.width / 2 + 9, hh = box.height / 2 + 9;
  const t = Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9), 1);
  return [cx + dx * t, cy + dy * t];
}
function arrowGeometry(c) {
  const a = endRef(c.from), b = endRef(c.to); if (!a || !b) return null;
  // an arrow from a drawing back to itself ("repeat"): a loop out of its right side, not a dot at its centre
  if (!Array.isArray(c.from) && String(c.from) === String(c.to)) {
    const bx = a.box, x = bx.x + bx.width + 9, cy = bx.y + bx.height / 2, s = Math.min(bx.height * 0.25, 40);
    return Object.assign([[x, cy - s], [x + 120, cy], [x, cy + s]], { loop: true });
  }
  const ca = centerOf(a), cb = centerOf(b);
  const p1 = a.box ? edgePoint(a.box, cb) : ca, p2 = b.box ? edgePoint(b.box, ca) : cb;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], len = Math.hypot(dx, dy) || 1, k = clamp(num(c.curve, 0), -1, 1) * len * 0.5;
  return [p1, [(p1[0] + p2[0]) / 2 - dy / len * k, (p1[1] + p2[1]) / 2 + dx / len * k], p2];
}

function buildGroup(c) {
  const g = el('g', { 'data-id': c.id });
  layerObj.appendChild(g); // must be in the DOM to measure text
  const parts = [], r = rng(hashStr(c.id + (c._seed || '')));
  const ok = builders[c.cmd](c, g, parts, r);
  if (ok === false) { g.remove(); return null; }
  return { g, parts };
}
function bbOf(o) { return { x: o.bb.x + o.off[0], y: o.bb.y + o.off[1], width: o.bb.width, height: o.bb.height }; }
function measure(g) { const b = g.getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }
