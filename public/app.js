/* Whiteboard Teacher — front end
 * An infinite SVG whiteboard plus a side chat. The LLM (via the local /api/chat proxy to OpenCode Go)
 * answers in JSON Lines: {"say": "..."} lines go to the chat, {"cmd": "..."} lines draw on the board.
 * Generated content is never executed: numbers are clamped, text goes in via textContent, lists are capped.
 */
(() => {
'use strict';

// ======================================================================
// constants & state
// ======================================================================
const $ = s => document.querySelector(s);
// ring buffer of recent events; ⚙ → "Copy debug log" puts it on the clipboard
const debugLog = window.__debugLog = [];
window.wbtLog = (area, ...a) => {
  const line = `${new Date().toISOString().slice(11, 23)} [${area}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`.slice(0, 600);
  debugLog.push(line); if (debugLog.length > 400) debugLog.shift();
  if (/error|fail|stall|timeout|skip/i.test(line)) console.warn(line); else console.debug(line);
};
const dlog = (...a) => window.wbtLog('app', ...a);
window.addEventListener('error', e => dlog('page error', e.message, (e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => dlog('unhandled rejection', String(e.reason && e.reason.stack || e.reason).slice(0, 300)));
const NS = 'http://www.w3.org/2000/svg';
const LS_SET = 'wbt.settings.v2';
const FIX_MAX = 12, MAX_OBJECTS = 600, MAX_SAY_WORDS = 26;
const PALETTE = { blue: '#1d6fb8', amber: '#c48a00', yellow: '#c48a00', green: '#2a8a3e', red: '#d1382c', purple: '#7a48c2', orange: '#e07800', black: '#1f2328', grey: '#7d848c', gray: '#7d848c' };
const BOXLIKE = new Set(['write', 'box', 'circle', 'vector', 'matrix', 'bars', 'plot', 'math', 'code', 'network', 'tree', 'graph', 'numberline', 'timeline', 'table', 'icon', 'tokens', 'schedule', 'sequence']);
// what counts as drawing (vs. writing) when judging an answer
const PICTURE = new Set(['sequence', 'box', 'circle', 'vector', 'matrix', 'bars', 'plot', 'network', 'tree', 'graph', 'numberline', 'timeline', 'table', 'icon', 'tokens', 'schedule', 'frame', 'brace', 'arrow', 'line', 'highlight', 'math']);
const TYPES = new Set(['sequence', 'icon', 'tokens', 'frame', 'brace', 'schedule', 'math', 'code', 'network', 'tree', 'graph', 'numberline', 'timeline', 'table', 'ink', 'write', 'box', 'circle', 'vector', 'matrix', 'bars', 'plot', 'line', 'arrow', 'highlight', 'update', 'move', 'erase', 'clear', 'wait']);
const ALIASES = { animate: 'update', sequencediagram: 'sequence', messages: 'sequence', protocol: 'sequence', symbol: 'icon', pictogram: 'icon', row: 'tokens', chips: 'tokens', group: 'frame', container: 'frame', bracket: 'brace', gantt: 'schedule', latex: 'math', equation: 'math', formula: 'math', nn: 'network', neuralnet: 'network', flowchart: 'graph', diagram: 'graph', 'number_line': 'numberline', numline: 'numberline', grid: 'table', text: 'write', label: 'write', rect: 'box', rectangle: 'box', ellipse: 'circle', path: 'line', chart: 'bars', circle_highlight: 'highlight', delete: 'erase', remove: 'erase', wipe: 'clear' };

const svg = $('#board'), layerObj = $('#layerObjects'), layerOv = $('#layerOverlay'), defs = svg.querySelector('defs'), grid = $('#grid');
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

let lesson = null;             // {topic, audience, example, notes, source, plan, session}
const objs = new Map();        // id -> {cmd, g, bb, off:[dx,dy]}
let camera = { x: -60, y: -60, scale: 1 };
let chat = [];                 // [{role:'user'|'assistant'|'error'|'system', text, about?, drew?, meta?}]
const selection = new Set();
let settings = { model: null, efforts: {}, voice: { mode: 'off', voice: 'af_heart', speed: 1, engine: 'server' } };
let models = [];
let gen = 0;                   // animation generation: bump to finish every running tween at once
let streaming = false, queueRunning = false, replaying = false;
let steps = [];               // lesson history: [{say, by:'teacher'|'you', cmds:[normalized cmds], t}]
let scrub = null;             // null = live board; otherwise {i, applied, live:{objs, camera}, playing}
let narrationDone = Promise.resolve();
let abortCtl = null, lastUserCamera = 0, autoId = 0;
// Pause: a lesson clock that stops while paused. Pen tweens, pacing and typing run on it, so a paused
// lesson freezes mid-stroke and resumes exactly there. The model's text keeps arriving in the background.
let pausedAt = null, pausedTotal = 0;
const pauseWaiters = [];
const clock = () => (pausedAt ?? performance.now()) - pausedTotal;
const isPaused = () => pausedAt != null;
const whilePaused = () => pausedAt == null ? Promise.resolve() : new Promise(r => pauseWaiters.push(r));
let activeStreams = 0;          // answers whose model stream is open (a paused, set-aside answer may keep streaming)
let parked = null;              // {turn, abort, say}: an answer set aside to answer a question asked while paused
const queue = [];
const typers = new Set();

// ======================================================================
// small utils
// ======================================================================
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f1 = n => Math.round(n * 10) / 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function num(v, d, lo = -1e5, hi = 1e5) { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : d; }
function str(v, max = 300) { return v == null ? '' : String(v).slice(0, max); }
// short labels only: cut at a word boundary and mark the cut
function clip(v, n) { const t = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; const k = t.lastIndexOf(' ', n - 1); return (k > n * 0.5 ? t.slice(0, k) : t.slice(0, n - 1)) + '…'; }
function clipLines(v, lines, n) { return String(v ?? '').split('\n').slice(0, lines).map(l => clip(l, n)).join('\n'); }
// spoken / chat lines: keep whole sentences up to a word budget
function trimSay(t) {
  const words = String(t).trim().split(/\s+/); if (words.length <= MAX_SAY_WORDS) return String(t).trim();
  const sentences = String(t).match(/[^.!?]+[.!?]+(\s|$)/g) || [];
  let out = ''; for (const sn of sentences) { if ((out + sn).trim().split(/\s+/).length > MAX_SAY_WORDS) break; out += sn; }
  return out.trim() || words.slice(0, MAX_SAY_WORDS).join(' ') + '…';
}
function col(v, d = '#1f2328') {
  if (typeof v !== 'string') return d;
  const s = v.trim().toLowerCase();
  if (PALETTE[s]) return PALETTE[s];
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : d;
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function uuid() { return (crypto.randomUUID && crypto.randomUUID()) || 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function speed() { return 0.6; }        // the pen draws at a calm, hand-drawn pace
function instantMode() { return reduceMotion; }

// ======================================================================
// hand-drawn geometry
// ======================================================================
function roughSeg(x1, y1, x2, y2, r, amt = 1) {
  const len = Math.hypot(x2 - x1, y2 - y1), w = Math.min(2.6, len * 0.012) * amt;
  const j = () => (r() - 0.5) * 2 * w;
  const mx = (x1 + x2) / 2 + j(), my = (y1 + y2) / 2 + j();
  return `M${f1(x1 + j())} ${f1(y1 + j())} Q${f1(mx)} ${f1(my)} ${f1(x2 + j())} ${f1(y2 + j())}`;
}
function roughRect(x, y, w, h, r) {
  return [roughSeg(x, y, x + w, y, r), roughSeg(x + w, y, x + w, y + h, r), roughSeg(x + w, y + h, x, y + h, r), roughSeg(x, y + h, x, y, r)].join(' ');
}
function smoothPath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${f1(pts[0][0])} ${f1(pts[0][1])} L${f1(pts[1][0])} ${f1(pts[1][1])}`;
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
}
function roughEllipse(cx, cy, rx, ry, r, overshoot = 1.06) {
  const n = 26, start = r() * Math.PI * 2, pts = [];
  for (let i = 0; i <= n * overshoot; i++) {
    const a = start + (i / n) * Math.PI * 2, k = 1 + (r() - 0.5) * 0.04;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return smoothPath(pts);
}

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
      const things = c.around.filter(id => objs.has(id) && !['arrow', 'line', 'highlight', 'brace', 'frame'].includes(objs.get(id).cmd.cmd));
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

// ======================================================================
// command normalisation (never trust generated input)
// ======================================================================
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let t = String(raw.cmd || raw.type || raw.op || '').toLowerCase().trim();
  t = ALIASES[t] || t;
  if (!TYPES.has(t)) return null;
  const c = { cmd: t };
  const id = str(raw.id, 40).replace(/[^\w\-:.]/g, '_');
  c.id = id || (t === 'clear' || t === 'wait' || t === 'erase' ? '' : `${t}${++autoId}`);
  const pt = v => Array.isArray(v) ? [num(v[0], 0), num(v[1], 0)] : str(v, 40);
  switch (t) {
    case 'clear': return c;
    case 'wait': c.ms = num(raw.ms, 400, 0, 1500); return c;
    case 'erase':
      c.ids = (Array.isArray(raw.ids) ? raw.ids : raw.id ? [raw.id] : []).slice(0, 80).map(v => str(v, 40));
      if (Array.isArray(raw.area)) c.area = raw.area.slice(0, 4).map(v => num(v, 0));
      return c;
    case 'update': { const rest = { ...raw }; delete rest.cmd; delete rest.type; return { cmd: 'update', id: c.id, fields: rest }; }
    case 'move':
      c.x = raw.x != null ? num(raw.x, 0) : null; c.y = raw.y != null ? num(raw.y, 0) : null;
      c.dx = num(raw.dx, 0); c.dy = num(raw.dy, 0); return c;
  }
  return normalizeShape(t, raw, c);
}
function normalizeShape(t, raw, c = { cmd: t, id: str(raw.id, 40) }) {
  c.color = col(raw.color, t === 'highlight' ? '#e07800' : t === 'arrow' ? '#1f2328' : '#1d6fb8');
  if (raw._placed) c._placed = true;
  if (raw._seed) c._seed = str(raw._seed, 12);
  if (BOXLIKE.has(t)) {
    c.x = raw.x != null ? num(raw.x, 0) : null; c.y = raw.y != null ? num(raw.y, 0) : null;
    // relative placement: {"near":{"of":"b1","side":"right"}} or the shorthand {"rightOf":"b1"} / {"below":"b1"} ...
    let n = raw.near; const sh = raw.rightOf ? ['right', raw.rightOf] : raw.leftOf ? ['left', raw.leftOf] : raw.below ? ['below', raw.below] : raw.above ? ['above', raw.above] : null;
    if (typeof n === 'string') n = { of: n };
    if (!n && sh) n = { of: sh[1], side: sh[0], gap: raw.gap };
    if (n && typeof n === 'object' && n.of && !raw._placed) c.near = { of: str(n.of, 40), side: ['right', 'left', 'below', 'above'].includes(n.side) ? n.side : 'right', gap: num(n.gap, 70, 0, 800), align: ['start', 'center', 'end'].includes(n.align) ? n.align : null };
  }
  const label = clip(raw.label, t === 'arrow' ? 22 : 30) || null;
  switch (t) {
    case 'write': c.text = clipLines(raw.text ?? raw.label, 2, 42) || '…'; c.size = num(raw.size, 28, 12, 90); c.align = raw.align === 'center' || raw.align === 'middle' ? 'center' : 'start'; c.font = raw.font === 'math' ? 'math' : 'hand'; c.color = col(raw.color, '#1f2328'); break;
    case 'box': c.w = raw.w != null ? num(raw.w, 0, 20, 3000) : null; c.h = raw.h != null ? num(raw.h, 0, 20, 3000) : null; c.label = label; c.sub = clip(raw.sub, 34) || null; c.fill = raw.fill ?? null; c.size = raw.size != null ? num(raw.size, 26, 14, 60) : null; break;
    case 'circle': c.r = raw.r != null ? num(raw.r, 50, 6, 1500) : null; c.rx = raw.rx != null ? num(raw.rx, 50, 6, 1500) : null; c.ry = raw.ry != null ? num(raw.ry, 50, 6, 1500) : null; c.label = label; c.fill = raw.fill ?? null; c.size = raw.size != null ? num(raw.size, 26, 14, 60) : null; break;
    case 'vector': c.values = (Array.isArray(raw.values) ? raw.values : [raw.values ?? '']).slice(0, 16); c.label = label; c.highlight = (Array.isArray(raw.highlight) ? raw.highlight : raw.highlight != null ? [raw.highlight] : []).slice(0, 16).map(v => num(v, -1)); break;
    case 'matrix': c.values = (Array.isArray(raw.values) ? raw.values : [[raw.values ?? '']]).slice(0, 10); c.rowLabels = Array.isArray(raw.rowLabels) ? raw.rowLabels.slice(0, 10) : null; c.colLabels = Array.isArray(raw.colLabels) ? raw.colLabels.slice(0, 10) : null; c.label = label; break;
    case 'bars': c.values = (Array.isArray(raw.values) ? raw.values : [0]).slice(0, 14); c.labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 14) : null; c.w = raw.w != null ? num(raw.w, 240, 60, 2000) : null; c.h = raw.h != null ? num(raw.h, 150, 40, 1200) : null; c.label = label; break;
    case 'plot': c.w = raw.w != null ? num(raw.w, 280, 60, 2000) : null; c.h = raw.h != null ? num(raw.h, 170, 40, 1200) : null; c.fn = str(raw.fn, 20) || null; c.points = Array.isArray(raw.points) ? raw.points.slice(0, 200).filter(Array.isArray).map(p => [num(p[0], 0), num(p[1], 0)]) : null; c.marks = Array.isArray(raw.marks) ? raw.marks.slice(0, 10) : null; c.domain = Array.isArray(raw.domain) ? raw.domain.slice(0, 2) : null; c.label = label; break;
    case 'line': c.points = (Array.isArray(raw.points) ? raw.points : []).slice(0, 120).filter(Array.isArray).map(p => [num(p[0], 0), num(p[1], 0)]); if (c.points.length < 2) return null; c.smooth = !!raw.smooth; c.width = num(raw.width, 3, 1, 14); c.dash = !!raw.dash; c.color = col(raw.color, '#1f2328'); break;
    case 'arrow': c.from = Array.isArray(raw.from) ? [num(raw.from[0], 0), num(raw.from[1], 0)] : str(raw.from, 40); c.to = Array.isArray(raw.to) ? [num(raw.to[0], 0), num(raw.to[1], 0)] : str(raw.to, 40); c.label = label; c.curve = num(raw.curve, 0, -1, 1); c.dash = !!raw.dash; c.width = raw.width != null ? num(raw.width, 2.8, 1, 10) : null; break;
    case 'sequence': {
      c.actors = (Array.isArray(raw.actors) ? raw.actors : []).slice(0, 6).map(a => a && typeof a === 'object' ? { name: clip(a.name ?? a.label, 18), icon: a.icon ? str(a.icon, 20) : null } : { name: clip(a, 18), icon: null });
      c.messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(0, 20).map(m => Array.isArray(m) ? { from: clip(m[0], 18), to: clip(m[1], 18), label: clip(m[2], 26) || null, dash: !!m[3] } : m && typeof m === 'object' ? { from: clip(m.from, 18), to: clip(m.to, 18), label: clip(m.label, 26) || null, dash: !!m.dash } : null).filter(Boolean);
      for (const m of c.messages) for (const n of [m.from, m.to]) if (n && !c.actors.some(a => a.name === n) && c.actors.length < 6) c.actors.push({ name: n, icon: null });
      c.gap = num(raw.gap, 230, 120, 600); c.label = label; break;
    }
    case 'icon': c.name = str(raw.name ?? raw.icon ?? raw.kind, 30).toLowerCase() || 'box'; c.size = num(raw.size, 76, 32, 240); c.label = label; c.sub = clip(raw.sub, 26) || null; c.color = col(raw.color, '#1f2328'); break;
    case 'tokens': {
      const items = (Array.isArray(raw.items) ? raw.items : Array.isArray(raw.values) ? raw.values : String(raw.items ?? raw.text ?? '').split(/\s+/)).slice(0, 24);
      c.items = items.map(it => it && typeof it === 'object' ? { text: clip(it.text ?? it.label ?? '', 14), color: it.color ? col(it.color) : null } : { text: clip(it, 14), color: null });
      c.colors = Array.isArray(raw.colors) ? raw.colors.slice(0, 24).map(v => v ? col(v) : null) : null;
      c.highlight = (Array.isArray(raw.highlight) ? raw.highlight : raw.highlight != null ? [raw.highlight] : []).slice(0, 24).map(v => num(v, -1));
      c.size = num(raw.size, 20, 12, 40); c.gap = num(raw.gap, 6, 0, 60); c.index = !!raw.index; c.label = label; c.vertical = !!raw.vertical; break;
    }
    case 'frame': c.around = (Array.isArray(raw.around) ? raw.around : raw.around ? [raw.around] : []).slice(0, 40).map(v => str(v, 40)); c.label = label; c.pad = num(raw.pad, 26, 6, 120);
      if (!c.around.length) { c.x = num(raw.x, 0); c.y = num(raw.y, 0); c.w = num(raw.w, 300, 20, 5000); c.h = num(raw.h, 200, 20, 5000); }
      c.dash = raw.dash !== false; c.color = col(raw.color, '#7d848c'); break;
    case 'brace': c.around = (Array.isArray(raw.around) ? raw.around : raw.around ? [raw.around] : []).slice(0, 40).map(v => str(v, 40)); c.side = ['below', 'above', 'left', 'right'].includes(raw.side) ? raw.side : 'below'; c.label = label; c.color = col(raw.color, '#1f2328'); break;
    case 'schedule': {
      c.rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 12).map(rw => ({
        label: clip(rw && (rw.label ?? rw.name), 16),
        spans: (rw && Array.isArray(rw.spans) ? rw.spans : []).slice(0, 30).map(sp => Array.isArray(sp) ? { from: num(sp[0], 0, 0, 200), to: num(sp[1], 1, 0, 200), label: clip(sp[2], 10) || null, color: sp[3] ? col(sp[3]) : null } : sp && typeof sp === 'object' ? { from: num(sp.from, 0, 0, 200), to: num(sp.to, 1, 0, 200), label: clip(sp.label, 10) || null, color: sp.color ? col(sp.color) : null } : null).filter(sp => sp && sp.to > sp.from),
      }));
      const maxTo = Math.max(1, ...c.rows.flatMap(rw => rw.spans.map(sp => sp.to)));
      c.steps = Math.round(num(raw.steps, maxTo, 1, 60)); c.cell = num(raw.cell, 46, 24, 120); c.stepLabel = clip(raw.stepLabel ?? 'step', 10); c.label = label;
      c.markers = (Array.isArray(raw.markers) ? raw.markers : []).slice(0, 8).map(m => ({ at: num(m && m.at, 0, 0, 200), label: clip(m && m.label, 16) || null })); break;
    }
    case 'math': c.tex = str(raw.tex ?? raw.latex ?? raw.text, 400) || 'x'; c.size = num(raw.size, 30, 14, 80); c.color = col(raw.color, '#1f2328'); c.label = label; break;
    case 'code': c.code = str(raw.code ?? raw.text, 4000).split('\n').slice(0, 40).map(l => l.slice(0, 100).replace(/\t/g, '  ')).join('\n'); c.lang = str(raw.lang, 20) || null; c.title = str(raw.title ?? raw.label, 60) || null; c.size = num(raw.size, 17, 11, 30); break;
    case 'network': c.layers = (Array.isArray(raw.layers) ? raw.layers : [3, 4, 2]).slice(0, 8).map(n => Math.round(num(n, 1, 1, 512))); c.labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 8) : null; c.nodeLabels = Array.isArray(raw.nodeLabels) ? raw.nodeLabels.slice(0, 8).map(l => Array.isArray(l) ? l.slice(0, 8) : []) : null; c.active = raw.active != null ? num(raw.active, -1, -1, 8) : null; c.gap = raw.gap != null ? num(raw.gap, 150, 70, 400) : null; break;
    case 'tree': { let count = 0; const san = (n, d) => { count++; const o = { label: str(n && typeof n === 'object' ? (n.label ?? n.name ?? '') : n, 30) }; const ch = n && typeof n === 'object' && Array.isArray(n.children) ? n.children : []; o.children = d < 6 ? ch.slice(0, 8).filter(() => count < 40).map(k => san(k, d + 1)) : []; return o; }; c.root = san(raw.root && typeof raw.root === 'object' ? raw.root : { label: raw.label || 'root', children: raw.children }, 0); break; }
    case 'graph': {
      const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, 30).map(n => typeof n === 'object' && n ? { id: str(n.id ?? n.label, 30), label: str(n.label ?? n.id, 30), color: n.color || null } : { id: str(n, 30), label: str(n, 30), color: null });
      const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, 60).map(e => Array.isArray(e) ? [str(e[0], 30), str(e[1], 30), e[2] != null ? str(e[2], 20) : null] : e && typeof e === 'object' ? [str(e.from, 30), str(e.to, 30), e.label != null ? str(e.label, 20) : null] : null).filter(Boolean);
      for (const [a, b] of edges) for (const id of [a, b]) if (!nodes.some(n => n.id === id) && nodes.length < 30) nodes.push({ id, label: id, color: null });
      c.nodes = nodes; c.edges = edges; c.layout = ['circle', 'grid', 'layered'].includes(raw.layout) ? raw.layout : 'layered'; c.directed = raw.directed !== false; break;
    }
    case 'numberline': c.from = num(raw.from, 0); c.to = num(raw.to, 10); if (c.to <= c.from) c.to = c.from + 1; c.step = raw.step != null ? num(raw.step, 1, 1e-6, 1e6) : null; c.w = num(raw.w, 420, 100, 3000); c.label = label; c.marks = (Array.isArray(raw.marks) ? raw.marks : []).slice(0, 20).map(m => typeof m === 'object' && m ? { at: num(m.at ?? m.x, 0), label: str(m.label, 24) || null, color: m.color ? col(m.color) : null } : { at: num(m, 0), label: null, color: null }); break;
    case 'timeline': c.events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 12).map(e => typeof e === 'object' && e ? { label: str(e.label ?? e.text, 28), at: str(e.at ?? e.date ?? e.time, 16) || null } : { label: str(e, 28), at: null }); c.w = raw.w != null ? num(raw.w, 600, 150, 3000) : null; c.label = label; break;
    case 'table': c.header = Array.isArray(raw.header) ? raw.header.slice(0, 8) : null; c.rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 14).map(rw => (Array.isArray(rw) ? rw : [rw]).slice(0, 8)); c.label = label; if (!c.header && !c.rows.length) c.rows = [['']]; break;
    case 'ink': c.points = (Array.isArray(raw.points) ? raw.points : []).slice(0, 2000).filter(Array.isArray).map(p => [num(p[0], 0), num(p[1], 0)]); if (c.points.length < 2) return null; c.width = num(raw.width, 3.5, 1, 20); c.color = col(raw.color, '#1f2328'); c.by = 'you'; break;
    case 'highlight': c.target = str(raw.target ?? raw.on, 40); c.style = ['circle', 'underline', 'box'].includes(raw.style) ? raw.style : 'circle'; break;
  }
  return c;
}

// ======================================================================
// animation primitives
// ======================================================================
function tween(ms, fn, run, ease) {
  return new Promise(res => {
    if (instantMode() || !run || run.gen !== gen || ms <= 0 || document.hidden) { fn(1); return res(); }
    const t0 = clock();
    const step = () => {
      if (run.gen !== gen || document.hidden) { fn(1); return res(); }
      const t = clamp((clock() - t0) / ms, 0, 1);
      fn(ease ? ease(t) : t);
      if (t < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}
const easeInOut = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// pen + eraser icons (constant on-screen size)
const pen = el('g', { visibility: 'hidden', 'pointer-events': 'none' }, layerOv);
const penBody = el('path', { d: 'M0 0 L5 -15 L23 -33 L33 -23 L15 -5 Z', fill: '#fff', stroke: '#1d6fb8', 'stroke-width': 2, 'stroke-linejoin': 'round' }, pen);
el('path', { d: 'M0 0 L5 -15 L15 -5 Z', fill: '#1d6fb8' }, pen);
const eraser = el('g', { visibility: 'hidden', 'pointer-events': 'none' }, layerOv);
el('rect', { x: -16, y: -11, width: 32, height: 22, rx: 4, fill: '#f6d2cc', stroke: '#7d848c', 'stroke-width': 1.5 }, eraser);
el('rect', { x: -16, y: 3, width: 32, height: 8, rx: 2, fill: '#7d848c' }, eraser);
const selLayer = el('g', { 'pointer-events': 'none' }, layerOv);
function placeIcon(icon, x, y) { icon.setAttribute('transform', `translate(${f1(x)} ${f1(y)}) scale(${(1 / camera.scale).toFixed(4)})`); icon.setAttribute('visibility', 'visible'); }
function hideIcon(icon) { icon.setAttribute('visibility', 'hidden'); }


function hideParts(parts) {
  for (const p of parts) {
    if (p.kind === 'stroke') { const L = p.el.getTotalLength(); p.len = L; p.el.style.strokeDasharray = `${L} ${L}`; p.el.style.strokeDashoffset = L; }
    else if (p.kind === 'text') {
      const b = p.el.getBBox(); p.bb = b;
      const cid = 'clip' + Math.random().toString(36).slice(2, 9);
      const cp = el('clipPath', { id: cid }, defs); p.clipRect = el('rect', { x: b.x - 6, y: b.y - 8, width: 0, height: b.height + 16 }, cp); p.clipPath = cp;
      p.el.setAttribute('clip-path', `url(#${cid})`);
      // WebKit ignores a zero-width clip and shows the whole text early: keep it hidden until the pen reaches it
      p.el.style.visibility = 'hidden';
    } else p.el.style.opacity = 0;
  }
}
function showPart(p) {
  if (p.kind === 'stroke') { p.el.style.strokeDasharray = p.dashed ? '' : ''; p.el.style.strokeDashoffset = ''; }
  else if (p.kind === 'text') { p.el.removeAttribute('clip-path'); if (p.clipPath) p.clipPath.remove(); p.el.style.visibility = ''; }
  else p.el.style.opacity = '';
}
// Pacing: the drawing for a sentence takes as long as the sentence takes to say, so the pen moves while the
// teacher talks about it. beginPace(seconds) starts a sentence's time window; each command gets an equal share
// of what is left, and its strokes are slowed down or sped up (within limits) to fill that share.
let pace = null, paceShare = null;
const SPEAK_CPS = 14;                     // speaking pace used when narration is off (characters per second)
function beginPace(seconds) { pace = seconds > 0.3 ? { until: clock() + seconds * 1000 } : null; }
function setPaceShare(remainingCmds) {
  const left = pace ? pace.until - clock() : 0;
  paceShare = left > 200 ? left / Math.max(1, remainingCmds) : null;
}
const naturalMs = p => p.kind === 'stroke' ? Math.min(1400, Math.max(200, p.len * 1.3)) : p.kind === 'text' ? Math.min(2200, Math.max(220, p.chars * 55)) : 200;
async function animateParts(parts, run) {
  hideParts(parts);
  // scale this drawing to its share of the sentence (0.5× = up to twice as fast, 3× = up to three times slower)
  const natural = parts.reduce((t, p) => t + naturalMs(p), 0);
  // a paced drawing keeps the sentence's timing; otherwise the calm default pen speed applies
  const scale = paceShare && natural ? clamp(paceShare / natural, 0.5, 3) : 1, sp = paceShare ? 1 : speed();
  paceShare = null;
  for (const p of parts) {
    if (run.gen !== gen || instantMode()) { showPart(p); continue; }
    if (p.kind === 'stroke') {
      penBody.setAttribute('stroke', p.color || '#1f2328');
      const L = p.len, ms = naturalMs(p) * scale / sp;
      await tween(ms, t => { p.el.style.strokeDashoffset = L * (1 - t); const pt = p.el.getPointAtLength(L * t); placeIcon(pen, pt.x, pt.y); }, run);
    } else if (p.kind === 'text') {
      penBody.setAttribute('stroke', p.color || '#1f2328');
      const b = p.bb, ms = naturalMs(p) * scale / sp;
      p.clipRect.setAttribute('width', 0.01); p.el.style.visibility = '';
      await tween(ms, t => { const w = (b.width + 12) * t; p.clipRect.setAttribute('width', w); placeIcon(pen, b.x - 6 + w, b.y + b.height * (0.55 + 0.25 * Math.sin(t * 40))); }, run);
    } else await tween(naturalMs(p) * scale / sp, t => { p.el.style.opacity = t; }, run);
    showPart(p);
  }
  hideIcon(pen);
}

// ======================================================================
// camera
// ======================================================================
function viewSize() { const r = svg.getBoundingClientRect(); return { W: Math.max(1, r.width), H: Math.max(1, r.height) }; }
function defaultScale() { const { W } = viewSize(); return W / clamp(W * 1.35, 560, 1150); }
function applyCamera() {
  const { W, H } = viewSize(), vw = W / camera.scale, vh = H / camera.scale;
  svg.setAttribute('viewBox', `${camera.x} ${camera.y} ${vw} ${vh}`);
  grid.setAttribute('x', camera.x - 64); grid.setAttribute('y', camera.y - 64); grid.setAttribute('width', vw + 128); grid.setAttribute('height', vh + 128);
  $('#zoomPct').textContent = Math.round(camera.scale / defaultScale() * 100) + '%';
  drawSelection();
  saveSoon();
}
function viewRect() { const { W, H } = viewSize(); return { x: camera.x, y: camera.y, width: W / camera.scale, height: H / camera.scale }; }
function screenToBoard(px, py) { const r = svg.getBoundingClientRect(); return [camera.x + (px - r.left) / camera.scale, camera.y + (py - r.top) / camera.scale]; }
function zoomAt(factor, px, py) {
  const r = svg.getBoundingClientRect(); const sx = px - r.left, sy = py - r.top;
  const bx = camera.x + sx / camera.scale, by = camera.y + sy / camera.scale;
  camera.scale = clamp(camera.scale * factor, 0.05, 12);
  camera.x = bx - sx / camera.scale; camera.y = by - sy / camera.scale;
  applyCamera();
}
function animateCamera(target, ms, run) {
  const from = { ...camera };
  const lerp = (a, b, t) => a + (b - a) * t;
  return tween(ms, t => {
    // interpolate scale geometrically for a smooth zoom feel
    camera.scale = from.scale * Math.pow(target.scale / from.scale, t);
    camera.x = lerp(from.x, target.x, t); camera.y = lerp(from.y, target.y, t); applyCamera();
  }, run || { gen }, easeInOut);
}
function cameraFor(b, pad = 60, maxScale = null) {
  const { W, H } = viewSize();
  let s = Math.min(W / (b.width + pad * 2), H / (b.height + pad * 2));
  s = clamp(s, 0.05, maxScale || defaultScale() * 1.6);
  return { scale: s, x: b.x + b.width / 2 - W / s / 2, y: b.y + b.height / 2 - H / s / 2 };
}
async function ensureVisible(b, run) {
  if (Date.now() - lastUserCamera < 2500 || instantMode() || run.gen !== gen) return;
  const v = viewRect(), m = 30 / camera.scale;
  if (b.x >= v.x + m && b.y >= v.y + m && b.x + b.width <= v.x + v.width - m && b.y + b.height <= v.y + v.height - m) return;
  let s = camera.scale;
  const { W, H } = viewSize();
  if (b.width + 80 / s > v.width || b.height + 80 / s > v.height) s = clamp(Math.min(W / (b.width + 120), H / (b.height + 120)), 0.05, 12);
  const vw = W / s, vh = H / s, mm = 40 / s;
  let x = camera.x, y = camera.y;
  if (s !== camera.scale) { x = b.x + b.width / 2 - vw / 2; y = b.y + b.height / 2 - vh / 2; }
  else {
    if (b.x < x + mm) x = b.x - mm; else if (b.x + b.width > x + vw - mm) x = b.x + b.width - vw + mm;
    if (b.y < y + mm) y = b.y - mm; else if (b.y + b.height > y + vh - mm) y = b.y + b.height - vh + mm;
  }
  await animateCamera({ x, y, scale: s }, 420, run);
}
function allBounds() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const o of objs.values()) { const b = bbOf(o); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height); }
  return x1 === Infinity ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function fit(animate = true) {
  const b = allBounds();
  const target = b ? cameraFor({ ...b, height: b.height + (navSteps().length ? 70 / Math.max(0.2, camera.scale) : 0) }, 50, 12) : { scale: defaultScale(), x: -60, y: -60 };
  lastUserCamera = 0;
  if (animate) animateCamera(target, 450); else { Object.assign(camera, target); applyCamera(); }
}

// ======================================================================
// board operations
// ======================================================================
function overlaps(a, b, m = 30) { return a.x < b.x + b.width + m && a.x + a.width + m > b.x && a.y < b.y + b.height + m && a.y + a.height + m > b.y; }
const wraps = (o, id) => Array.isArray(o.cmd.around) && o.cmd.around.includes(id);
function dependentsOf(id) { const out = []; for (const [k, o] of objs) if (o.cmd.from === id || o.cmd.to === id || o.cmd.target === id || o.cmd.on === id || wraps(o, id)) out.push(k); return out; }
// arrows and highlights go away with their object; frames and braces just re-fit around what is left
function hardDependentsOf(id) { return dependentsOf(id).filter(k => !['frame', 'brace'].includes(objs.get(k).cmd.cmd)); }
function rebuildDependents(id, seen = new Set()) {
  for (const k of dependentsOf(id)) { if (seen.has(k)) continue; seen.add(k); rebuild(k); rebuildDependents(k, seen); }
}
function rebuild(id) {
  const o = objs.get(id); if (!o) return;
  const built = buildGroup(o.cmd);
  if (!built) { o.g.remove(); objs.delete(id); return; }
  layerObj.insertBefore(built.g, o.g); o.g.remove();
  o.g = built.g; o.off = [0, 0]; o.bb = measure(built.g);
}

async function drawObject(c, run, animate) {
  if (!builders[c.cmd]) return;
  if (objs.has(c.id)) removeNow(c.id, false);
  else if (objs.size >= MAX_OBJECTS) return;
  if (BOXLIKE.has(c.cmd) && c.near) {
    const tgt = objs.get(c.near.of), n = c.near; delete c.near;
    if (tgt) {
      c.x = 0; c.y = 0;
      const probe = buildGroup(c);
      if (probe) {
        const b0 = measure(probe.g); probe.g.remove();
        const tb = bbOf(tgt), al = n.align || (n.side === 'right' || n.side === 'left' ? 'center' : 'start');
        let X, Y;
        if (n.side === 'right' || n.side === 'left') {
          X = n.side === 'right' ? tb.x + tb.width + n.gap : tb.x - n.gap - b0.width;
          Y = al === 'start' ? tb.y : al === 'end' ? tb.y + tb.height - b0.height : tb.y + (tb.height - b0.height) / 2;
        } else {
          Y = n.side === 'below' ? tb.y + tb.height + n.gap : tb.y - n.gap - b0.height;
          X = al === 'center' ? tb.x + (tb.width - b0.width) / 2 : al === 'end' ? tb.x + tb.width - b0.width : tb.x;
        }
        c.x = X - b0.x; c.y = Y - b0.y;
      } else { c.x = null; c.y = null; }
    } else { c.x = null; c.y = null; }
  }
  if (BOXLIKE.has(c.cmd) && (c.x == null || c.y == null)) {
    const b = allBounds(); c.x = c.x ?? (b ? b.x : 0); c.y = c.y ?? (b ? b.y + b.height + 70 : 0); c._placed = false;
  }
  let built = buildGroup(c); if (!built) return;
  if (BOXLIKE.has(c.cmd) && !c._placed) {
    // shift right or down (whichever is shorter) until it no longer overlaps anything
    for (let i = 0; i < 25; i++) {
      const bb = measure(built.g); let hit = null;
      for (const o of objs.values()) if ((BOXLIKE.has(o.cmd.cmd) || o.cmd.cmd === 'brace') && overlaps(bb, bbOf(o))) { hit = bbOf(o); break; }
      if (!hit) break;
      const dx = hit.x + hit.width + 34 - bb.x, dy = hit.y + hit.height + 34 - bb.y;
      if (dx <= dy) c.x += dx; else c.y += dy;
      built.g.remove(); built = buildGroup(c);
    }
    c._placed = true;
  }
  const o = { cmd: c, g: built.g, bb: measure(built.g), off: [0, 0] };
  objs.set(c.id, o);
  updateEmpty();
  if (animate) { built.g.style.opacity = 0; await ensureVisible(bbOf(o), run); built.g.style.opacity = ''; await animateParts(built.parts, run); }
  saveSoon();
}
function removeNow(id, withDeps = true) {
  const o = objs.get(id); if (!o) return;
  o.g.remove(); objs.delete(id); selection.delete(id);
  if (withDeps) for (const k of hardDependentsOf(id)) removeNow(k, true);
}
async function eraseIds(ids, run, animate) {
  const all = new Set();
  const add = id => { if (!objs.has(id) || all.has(id)) return; all.add(id); hardDependentsOf(id).forEach(add); };
  ids.forEach(add);
  if (!all.size) return;
  if (animate && !instantMode() && run.gen === gen) {
    let b = null;
    for (const id of all) { const x = bbOf(objs.get(id)); b = b ? { x: Math.min(b.x, x.x), y: Math.min(b.y, x.y), width: Math.max(b.x + b.width, x.x + x.width) - Math.min(b.x, x.x), height: Math.max(b.y + b.height, x.y + x.height) - Math.min(b.y, x.y) } : x; }
    await ensureVisible(b, run);
    const gs = [...all].map(id => objs.get(id).g);
    await tween(Math.min(900, 380 + b.width) / speed(), t => {
      const zig = Math.abs(((t * 3) % 2) - 1); // zigzag across the width
      placeIcon(eraser, b.x + b.width * (t * 3 % 2 < 1 ? zig : zig), b.y + b.height * t);
      gs.forEach(g => g.style.opacity = 1 - t);
    }, run);
    hideIcon(eraser);
  }
  const refit = new Set(); for (const id of all) for (const k of dependentsOf(id)) if (!all.has(k)) refit.add(k);
  for (const id of all) removeNow(id, false);
  for (const k of refit) if (objs.has(k)) rebuild(k);
  updateEmpty(); drawSelection(); updateSelectionUI(); saveSoon();
}
async function clearBoard(run, animate) {
  if (animate && !instantMode() && objs.size && run.gen === gen) {
    const v = viewRect(), gs = [...objs.values()].map(o => o.g);
    await tween(800 / speed(), t => {
      const zig = Math.abs(((t * 4) % 2) - 1);
      placeIcon(eraser, v.x + v.width * t, v.y + v.height * (0.15 + 0.7 * zig));
      gs.forEach(g => g.style.opacity = 1 - t);
    }, run);
    hideIcon(eraser);
  }
  for (const o of objs.values()) o.g.remove();
  objs.clear(); selection.clear();
  updateEmpty(); drawSelection(); updateSelectionUI(); saveSoon();
}
function anchorShift(c, dx, dy) {
  if (c.x != null && BOXLIKE.has(c.cmd)) { c.x += dx; c.y += dy; }
  if (c.cmd === 'line' || c.cmd === 'ink') c.points = c.points.map(p => [p[0] + dx, p[1] + dy]);
  if (c.cmd === 'arrow') { if (Array.isArray(c.from)) c.from = [c.from[0] + dx, c.from[1] + dy]; if (Array.isArray(c.to)) c.to = [c.to[0] + dx, c.to[1] + dy]; }
}
function anchorOf(c) {
  if (BOXLIKE.has(c.cmd)) return [c.x, c.y];
  if (c.cmd === 'line' || c.cmd === 'ink') return c.points[0];
  if (c.cmd === 'arrow') return Array.isArray(c.from) ? c.from : Array.isArray(c.to) ? c.to : null;
  return null;
}
function commitMove(id, dx, dy) {
  const o = objs.get(id); if (!o) return;
  anchorShift(o.cmd, dx, dy); rebuild(id); rebuildDependents(id);
}
function setOffset(id, dx, dy) {
  const o = objs.get(id); if (!o) return;
  o.off = [dx, dy]; o.g.setAttribute('transform', `translate(${f1(dx)} ${f1(dy)})`);
}
async function moveCmd(c, run, animate) {
  const o = objs.get(c.id); if (!o) return;
  const a = anchorOf(o.cmd); if (!a) return;
  const dx = c.x != null ? c.x - a[0] : c.dx, dy = c.y != null ? c.y - a[1] : c.dy;
  if (!dx && !dy) return;
  if (animate) {
    const b = bbOf(o); await ensureVisible({ x: Math.min(b.x, b.x + dx), y: Math.min(b.y, b.y + dy), width: b.width + Math.abs(dx), height: b.height + Math.abs(dy) }, run);
    await tween(650 / speed(), t => { setOffset(c.id, dx * t, dy * t); rebuildDependents(c.id); drawSelection(); }, run, easeInOut);
  }
  commitMove(c.id, dx, dy); drawSelection(); saveSoon();
}
async function updateCmd(c, run, animate) {
  const o = objs.get(c.id); if (!o) return;
  const fields = { ...c.fields }; delete fields.id;
  const merged = normalizeShape(o.cmd.cmd, { ...o.cmd, ...fields, cmd: o.cmd.cmd, id: c.id, _placed: true, _seed: hashStr(JSON.stringify(fields)).toString(36).slice(0, 6) });
  if (!merged) return;
  merged.id = c.id;
  if (animate && !instantMode() && run.gen === gen) { await ensureVisible(bbOf(o), run); await tween(220 / speed(), t => { o.g.style.opacity = 1 - t; }, run); }
  const built = buildGroup(merged); if (!built) return;
  layerObj.insertBefore(built.g, o.g); o.g.remove();
  o.cmd = merged; o.g = built.g; o.off = [0, 0]; o.bb = measure(built.g);
  rebuildDependents(c.id);
  if (animate) await animateParts(built.parts, run);
  drawSelection(); saveSoon();
}

async function execCommand(c, run, animate) {
  switch (c.cmd) {
    case 'clear': return clearBoard(run, animate);
    case 'wait': if (animate && run.gen === gen) await sleep(c.ms / speed()); return;
    case 'erase': {
      let ids = c.ids.slice();
      if (c.area && c.area.length === 4) { const [x, y, w, h] = c.area, a = { x, y, width: w, height: h }; for (const [k, o] of objs) if (overlaps(a, bbOf(o), 0)) ids.push(k); }
      return eraseIds(ids, run, animate);
    }
    case 'update': return updateCmd(c, run, animate);
    case 'move': return moveCmd(c, run, animate);
    case 'animate': return updateCmd({ cmd: 'update', id: c.id, fields: c.fields || {} }, run, animate); // older lessons
    case 'pulse': return;                                                                                  // older lessons
    default: return drawObject(c, run, animate);
  }
}

// ======================================================================
// selection
// ======================================================================
function drawSelection() {
  selLayer.textContent = '';
  for (const id of selection) {
    const o = objs.get(id); if (!o) continue;
    const b = bbOf(o), p = 7 / camera.scale;
    el('rect', { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p, fill: 'none', stroke: '#1d6fb8', 'stroke-width': 1.6, 'stroke-dasharray': '6 4', 'vector-effect': 'non-scaling-stroke', rx: 4 / camera.scale }, selLayer);
  }
}
function nameOf(id) {
  const o = objs.get(id); if (!o) return id;
  const c = o.cmd, t = c.label || c.text || (c.cmd === 'icon' ? c.name : c.cmd === 'tokens' ? c.items.map(i => i.text).join(' ') : c.cmd === 'highlight' ? `highlight on ${c.target}` : c.cmd === 'arrow' ? `arrow ${typeof c.from === 'string' ? c.from : '·'}→${typeof c.to === 'string' ? c.to : '·'}` : c.id);
  return String(t).replace(/\n/g, ' ').slice(0, 28);
}
function updateSelectionUI() {
  const ids = [...selection].filter(id => objs.has(id));
  $('#selLine').hidden = !ids.length;
  if (ids.length) $('#selText').textContent = 'Selected: ' + ids.map(nameOf).join(', ');
  renderChips();
}
function setSelection(ids) { selection.clear(); ids.forEach(i => selection.add(i)); drawSelection(); updateSelectionUI(); }
function hitTest(px, py) {
  const [bx, by] = screenToBoard(px, py), tol = 6 / camera.scale;
  let best = null, bestA = Infinity;
  for (const [id, o] of objs) {
    const b = bbOf(o);
    if (bx >= b.x - tol && bx <= b.x + b.width + tol && by >= b.y - tol && by <= b.y + b.height + tol) {
      const a = Math.max(1, b.width * b.height); if (a < bestA) { bestA = a; best = id; }
    }
  }
  return best;
}

// ======================================================================
// pointer / wheel / keyboard
// ======================================================================
const pointers = new Map();
let gesture = null;
let penMode = false, penColor = '#d1382c', rubber = false;
// rubber: erases the learner's own strokes (ink) it passes over; never the teacher's drawings
const rubberRing = el('circle', { r: 12, fill: 'rgba(209,56,44,.08)', stroke: '#d1382c', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden', 'pointer-events': 'none' }, layerOv);
const RUB_PX = 12;
function setRubber(on) {
  rubber = on; $('#penRubber').classList.toggle('on', on); svg.classList.toggle('rubberMode', on && penMode);
  if (!on) rubberRing.setAttribute('visibility', 'hidden');
}
function moveRubberRing(bx, by) { rubberRing.setAttribute('cx', f1(bx)); rubberRing.setAttribute('cy', f1(by)); rubberRing.setAttribute('r', f1(RUB_PX / camera.scale)); rubberRing.setAttribute('visibility', 'visible'); }
// distance from a point to a polyline, cheap enough per pointer move
function nearInk(o, bx, by, rad) {
  const b = bbOf(o); if (bx < b.x - rad || bx > b.x + b.width + rad || by < b.y - rad || by > b.y + b.height + rad) return false;
  const pts = o.cmd.points, [ox, oy] = o.off, r2 = (rad + (o.cmd.width || 3) / 2) ** 2;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], c = pts[Math.min(i + 1, pts.length - 1)], ax = a[0] + ox, ay = a[1] + oy, dx = c[0] - a[0], dy = c[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? clamp(((bx - ax) * dx + (by - ay) * dy) / L, 0, 1) : 0, px = ax + t * dx - bx, py = ay + t * dy - by;
    if (px * px + py * py <= r2) return true;
  }
  return false;
}
function rubAt(bx, by) {
  const rad = RUB_PX / camera.scale, hit = [];
  for (const [id, o] of objs) if (o.cmd.cmd === 'ink' && nearInk(o, bx, by, rad)) hit.push(id);
  if (!hit.length) return;
  hit.forEach(id => inkSinceAsk.delete(id));
  recordEdit({ cmd: 'erase', ids: hit.slice() }); eraseIds(hit, { gen }, false); renderChips();
}
const inkSinceAsk = new Set();
const inkPreview = el('path', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }, layerOv);
svg.addEventListener('pointerdown', e => {
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid0: [(a.x + b.x) / 2, (a.y + b.y) / 2], cam0: { ...camera } };
    inkPreview.setAttribute('d', '');
    return;
  }
  if (pointers.size > 2) return;
  if (penMode && !scrub && rubber) {
    const [bx, by] = screenToBoard(e.clientX, e.clientY);
    gesture = { mode: 'rub' }; moveRubberRing(bx, by); rubAt(bx, by);
    return;
  }
  if (penMode && !scrub) {
    const [bx, by] = screenToBoard(e.clientX, e.clientY);
    gesture = { mode: 'ink', pts: [[bx, by]], width: clamp(3.5 / camera.scale, 0.8, 30) };
    inkPreview.setAttribute('stroke', penColor); inkPreview.setAttribute('stroke-width', gesture.width); inkPreview.setAttribute('d', '');
    return;
  }
  gesture = { mode: 'pending', x0: e.clientX, y0: e.clientY, hit: hitTest(e.clientX, e.clientY), cam0: { ...camera }, mods: e.shiftKey || e.ctrlKey || e.metaKey };
});
svg.addEventListener('pointermove', e => {
  if (penMode && rubber) { const [bx, by] = screenToBoard(e.clientX, e.clientY); moveRubberRing(bx, by); if (gesture && gesture.mode === 'rub' && pointers.has(e.pointerId)) { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); rubAt(bx, by); return; } }
  if (!pointers.has(e.pointerId)) { svg.classList.toggle('overObj', !!hitTest(e.clientX, e.clientY)); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.mode === 'ink') {
    const [bx, by] = screenToBoard(e.clientX, e.clientY), last = gesture.pts[gesture.pts.length - 1];
    if (Math.hypot(bx - last[0], by - last[1]) * camera.scale > 2 && gesture.pts.length < 2000) { gesture.pts.push([bx, by]); inkPreview.setAttribute('d', smoothPath(gesture.pts)); }
    return;
  }
  if (gesture.mode === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const r = svg.getBoundingClientRect(), c0 = gesture.cam0;
    const s = clamp(c0.scale * Math.pow(d / gesture.d0, 2.2), 0.05, 12);
    const bx = c0.x + (gesture.mid0[0] - r.left) / c0.scale, by = c0.y + (gesture.mid0[1] - r.top) / c0.scale;
    camera.scale = s; camera.x = bx - (mid[0] - r.left) / s; camera.y = by - (mid[1] - r.top) / s;
    lastUserCamera = Date.now(); applyCamera(); return;
  }
  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
  if (gesture.mode === 'pending' && Math.hypot(dx, dy) > 5) {
    if (gesture.hit && selection.has(gesture.hit) && !scrub) { gesture.mode = 'drag'; gesture.dragIds = [...selection]; svg.classList.add('dragging'); }
    else { gesture.mode = 'pan'; svg.classList.add('panning'); }
  }
  if (gesture.mode === 'pan') {
    camera.x = gesture.cam0.x - dx / camera.scale; camera.y = gesture.cam0.y - dy / camera.scale; lastUserCamera = Date.now(); applyCamera();
  } else if (gesture.mode === 'drag') {
    const bdx = dx / camera.scale, bdy = dy / camera.scale;
    gesture.dragIds.forEach(id => { setOffset(id, bdx, bdy); });
    gesture.dragIds.forEach(id => rebuildDependents(id));
    gesture.last = [bdx, bdy]; drawSelection();
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.mode === 'pinch') { if (pointers.size === 0) gesture = null; else gesture = { mode: 'none' }; return; }
  if (gesture.mode === 'rub') { gesture = null; showAttach(false); return; }
  if (gesture.mode === 'ink') {
    inkPreview.setAttribute('d', '');
    const pts = gesture.pts.map(p => [f1(p[0]), f1(p[1])]);
    if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5]); // a dot
    let n = objs.size; while (objs.has('ink' + n)) n++;
    const c = normalizeShape('ink', { cmd: 'ink', id: 'ink' + n, points: pts, color: penColor, width: gesture.width });
    if (c) { c.id = 'ink' + n; c._placed = true; drawObject(c, { gen }, false); recordEdit(c); inkSinceAsk.add(c.id); renderChips(); }
    gesture = null; return;
  }
  if (gesture.mode === 'pending' && e.type === 'pointerup') {
    const id = gesture.hit;
    const now = Date.now(), lt = lastTap;
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (lt && now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 24) { lastTap = null; zoomTap(e.clientX, e.clientY, e.shiftKey); gesture = null; return; }
    if (id) { if (gesture.mods) { selection.has(id) ? selection.delete(id) : selection.add(id); drawSelection(); updateSelectionUI(); } else setSelection([id]); }
    else if (selection.size) setSelection([]);
  } else if (gesture.mode === 'drag' && gesture.last) {
    const [dx, dy] = gesture.last;
    gesture.dragIds.forEach(id => { const o = objs.get(id); if (!o) return; if (anchorOf(o.cmd)) { commitMove(id, dx, dy); recordEdit({ cmd: 'move', id, x: null, y: null, dx, dy }); } else { setOffset(id, 0, 0); rebuildDependents(id); } });
    drawSelection(); saveSoon();
  }
  svg.classList.remove('panning', 'dragging');
  gesture = null;
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

svg.addEventListener('wheel', e => {
  e.preventDefault();
  let dy = e.deltaY, dx = e.deltaX;
  if (e.deltaMode === 1) { dy *= 16; dx *= 16; } else if (e.deltaMode === 2) { dy *= 400; dx *= 400; }
  lastUserCamera = Date.now();
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-clamp(dy, -120, 120) * 0.013), e.clientX, e.clientY);
  else {
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    camera.x += dx / camera.scale; camera.y += dy / camera.scale; applyCamera();
  }
}, { passive: false });
// Safari trackpad pinch
let gScale = 1;
svg.addEventListener('gesturestart', e => { e.preventDefault(); gScale = 1; });
svg.addEventListener('gesturechange', e => { e.preventDefault(); lastUserCamera = Date.now(); zoomAt(Math.pow(e.scale / gScale, 2.2), e.clientX, e.clientY); gScale = e.scale; });
let lastTap = null;
svg.addEventListener('dblclick', e => e.preventDefault());
function zoomTap(px, py, out) {
  lastUserCamera = Date.now();
  const r = svg.getBoundingClientRect(), f = out ? 1 / 3 : 3, sx = px - r.left, sy = py - r.top;
  const bx = camera.x + sx / camera.scale, by = camera.y + sy / camera.scale, s = clamp(camera.scale * f, 0.05, 12);
  animateCamera({ scale: s, x: bx - sx / s, y: by - sy / s }, 260);
}

document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (selection.size) { setSelection([]); return; }
    if ($('#app').classList.contains('fs')) exitFullscreen();
    $('#modelPop').hidden = true;
    return;
  }
  if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selection.size && !scrub) { e.preventDefault(); learnerErase([...selection]); }
  if (!typing && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && navSteps().length) { e.preventDefault(); stepBy(e.key === 'ArrowLeft' ? -1 : 1); }
});

// ======================================================================
// toolbar
// ======================================================================
$('#zoomIn').onclick = () => { const r = svg.getBoundingClientRect(); lastUserCamera = Date.now(); zoomAt(2.2, r.left + r.width / 2, r.top + r.height / 2); };
$('#zoomOut').onclick = () => { const r = svg.getBoundingClientRect(); lastUserCamera = Date.now(); zoomAt(1 / 2.2, r.left + r.width / 2, r.top + r.height / 2); };
$('#zoomPct').onclick = () => {
  const { W, H } = viewSize(), s = defaultScale(), cx = camera.x + W / camera.scale / 2, cy = camera.y + H / camera.scale / 2;
  animateCamera({ scale: s, x: cx - W / s / 2, y: cy - H / s / 2 }, 300);
};
$('#fitBtn').onclick = () => fit(true);
$('#wipeBtn').onclick = () => { if (!objs.size || scrub) return; if (confirm('Wipe the whole board? (The chat and the step history stay.)')) { stopAll(); recordEdit({ cmd: 'clear' }); clearBoard({ gen }, true); } };
$('#replayBtn').onclick = replay;
$('#fsBtn').onclick = () => { $('#app').classList.contains('fs') ? exitFullscreen() : enterFullscreen(); };
function enterFullscreen() {
  $('#app').classList.add('fs');
  const p = $('#app').requestFullscreen && $('#app').requestFullscreen();
  if (p && p.catch) p.catch(() => {});
  setTimeout(applyCamera, 60);
}
function exitFullscreen() {
  $('#app').classList.remove('fs');
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  setTimeout(applyCamera, 60);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('#app').classList.remove('fs'); setTimeout(applyCamera, 60); });
new ResizeObserver(() => applyCamera()).observe(svg);

async function replay() {
  const nav = navSteps(); if (!nav.length || liveBusy()) return;
  Voice.unlock();
  await showStep(nav[0], true);
  playFrom(nav[0], true);
}
// The drawing goes with the next question; the learner can type one, or send nothing and get it checked.
async function showAttach(focus) {
  const ids = [...inkSinceAsk].filter(id => objs.has(id));
  const box = $('#attach');
  if (!ids.length || penMode) { box.hidden = true; input.placeholder = 'Ask the teacher…'; return; }
  box.hidden = false; input.placeholder = 'Ask about your drawing (optional)…';
  try { const reg = inkRegion(ids); if (reg) $('#attachImg').src = await boardImage(reg); } catch (e) { dlog('thumbnail failed', String(e)); }
  if (focus) input.focus();
}
$('#attachX').onclick = () => { inkSinceAsk.clear(); showAttach(false); renderChips(); };
function setPen(on) {
  penMode = on; svg.classList.toggle('penMode', on); if (!on) showAttach(false); else $('#attach').hidden = true;
  $('#penBtn').setAttribute('aria-pressed', on); $('#penBar').hidden = !on;
  if (on) setSelection([]); else setRubber(false);
}
$('#penRubber').onclick = () => setRubber(!rubber);
svg.addEventListener('pointerleave', () => rubberRing.setAttribute('visibility', 'hidden'));
$('#penBtn').onclick = () => { if (!scrub) setPen(!penMode); };
$('#penDone').onclick = () => setPen(false);
$('#penCheck').onclick = () => { setPen(false); showAttach(true); };
$('#penUndo').onclick = () => {
  const last = [...inkSinceAsk].pop() || [...objs.keys()].reverse().find(k => objs.get(k).cmd.cmd === 'ink');
  if (!last) return; inkSinceAsk.delete(last); recordEdit({ cmd: 'erase', ids: [last] }); eraseIds([last], { gen }, false); renderChips();
};
document.querySelectorAll('#penBar .sw').forEach(b => b.onclick = () => { penColor = b.dataset.c; setRubber(false); document.querySelectorAll('#penBar .sw').forEach(x => x.classList.toggle('on', x === b)); });

// Render part of the board to a PNG (for image-capable models). Fonts/maths are approximated; the content is what matters.
async function boardImage(region) {
  const pad = 40, b = { x: region.x - pad, y: region.y - pad, width: region.width + 2 * pad, height: region.height + 2 * pad };
  const scale = clamp(1024 / Math.max(b.width, b.height), 0.25, 3);
  const W = Math.round(b.width * scale), H = Math.round(b.height * scale);
  const clone = svg.cloneNode(true);
  clone.querySelector('#layerOverlay')?.remove(); clone.querySelector('#grid')?.remove();
  clone.querySelectorAll('foreignObject').forEach(fo => { // KaTeX html would taint the canvas: swap for its source text
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', fo.getAttribute('x')); t.setAttribute('y', +fo.getAttribute('y') + (+fo.getAttribute('height')) * 0.72);
    t.setAttribute('font-size', 24); t.setAttribute('class', 'math'); t.textContent = fo.textContent.slice(0, 120); fo.replaceWith(t);
  });
  clone.querySelectorAll('animateMotion').forEach(a => a.remove());
  clone.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`); clone.setAttribute('width', W); clone.setAttribute('height', H);
  const style = document.createElementNS(NS, 'style');
  style.textContent = `.hand{font-family:Caveat,'Comic Sans MS',cursive}.math{font-family:'Times New Roman',serif;font-style:italic}.mono{font-family:Menlo,Consolas,monospace}`;
  clone.insertBefore(style, clone.firstChild);
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H);
  return cv.toDataURL('image/png');
}
function inkRegion(ids) {
  let r = null;
  for (const id of ids) { const o = objs.get(id); if (!o) continue; const b = bbOf(o); r = r ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), width: Math.max(r.x + r.width, b.x + b.width) - Math.min(r.x, b.x), height: Math.max(r.y + r.height, b.y + b.height) - Math.min(r.y, b.y) } : b; }
  if (!r) return null;
  // include nearby teacher drawings for context
  const grow = 260;
  const area = { x: r.x - grow, y: r.y - grow, width: r.width + 2 * grow, height: r.height + 2 * grow };
  for (const o of objs.values()) { const b = bbOf(o); if (overlaps(area, b, 0)) r = { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), width: Math.max(r.x + r.width, b.x + b.width) - Math.min(r.x, b.x), height: Math.max(r.y + r.height, b.y + b.height) - Math.min(r.y, b.y) }; }
  return r;
}

function updateEmpty() { $('#emptyHint').style.display = objs.size ? 'none' : ''; }

// ======================================================================
// steps & timeline: every say line starts a step; its drawing commands belong to it.
// Learner edits are recorded as 'you' steps so playback always matches the live board.
// ======================================================================
const cloneCmd = c => JSON.parse(JSON.stringify(c));
function trimSteps() {
  let total = steps.reduce((n, st) => n + st.cmds.length, 0);
  while (total > 5000 && steps.length > 2) { const a = steps.shift(); steps[0].cmds = a.cmds.concat(steps[0].cmds); total = steps.reduce((n, st) => n + st.cmds.length, 0); }
}
function recordSay(turn, say) { steps.push({ say, by: 'teacher', cmds: [], t: turn.key }); trimSteps(); updateTimeline(); }
function recordCmd(turn, c) {
  let st = steps[steps.length - 1];
  if (!st || st.by !== 'teacher' || st.t !== turn.key) { st = { say: '', by: 'teacher', cmds: [], t: turn.key }; steps.push(st); }
  st.cmds.push(cloneCmd(c)); updateTimeline(); saveSoon();
}
function recordEdit(c) {
  let st = steps[steps.length - 1];
  if (!st || st.by !== 'you') { st = { say: '', by: 'you', cmds: [] }; steps.push(st); }
  st.cmds.push(cloneCmd(c)); saveSoon();
}
const navSteps = () => steps.map((st, i) => st.by === 'teacher' && (st.say || st.cmds.length) ? i : -1).filter(i => i >= 0);
function answerNo(i) { const keys = []; for (let j = 0; j <= i; j++) { const t = steps[j].t; if (steps[j].by === 'teacher' && t && keys[keys.length - 1] !== t) keys.push(t); } return keys.length; }

function enterScrub() {
  if (scrub) return;
  scrub = { i: -1, applied: -1, token: 0, live: { objs: [...objs.values()].map(o => cloneCmd(o.cmd)), camera: { ...camera } }, playing: false };
  setSelection([]);
  document.body.classList.add('scrubbing');
}
function exitScrub(keepCamera = false) {
  if (!scrub) return;
  const live = scrub.live; scrub = null;
  stopAll(); resetBoard();
  for (const c of live.objs) { const cc = cloneCmd(c); cc._placed = true; drawObject(cc, { gen }, false); }
  if (!keepCamera) { camera = { ...live.camera }; applyCamera(); }
  document.body.classList.remove('scrubbing');
  showCaption(''); updateEmpty(); updateTimeline();
}
// Show step i. animate=false: the board as it is after step i. animate=true: everything before i, then draw i with narration.
async function showStep(i, animate) {
  if (i < 0 || i >= steps.length) return;
  enterScrub();
  gen++; Voice.stop(); narrationDone = Promise.resolve(); finishTyping();
  const run = { gen }, token = ++scrub.token;
  const target = animate ? i - 1 : i;
  if (target < scrub.applied) { resetBoard(); scrub.applied = -1; }
  for (let j = scrub.applied + 1; j <= target; j++) for (const c of steps[j].cmds) await execCommand(cloneCmd(c), run, false);
  scrub.applied = target; scrub.i = i;
  updateEmpty(); updateTimeline(); showCaption(steps[i].say);
  if (!animate) return;
  lastUserCamera = 0; replaying = true; updateSendBtn();
  let narration = null;
  if (steps[i].say && Voice.enabled()) narration = Voice.play(Voice.prepare(steps[i].say));
  const started = narration ? await narration : null;
  beginPace(started && started.duration ? started.duration : steps[i].say.length / SPEAK_CPS);
  const cmds = steps[i].cmds;
  for (let j = 0; j < cmds.length; j++) { if (run.gen !== gen) break; setPaceShare(cmds.length - j); await execCommand(cloneCmd(cmds[j]), run, true); paceShare = null; }
  if (!scrub || scrub.token !== token) { replaying = false; updateSendBtn(); return; } // a newer jump took over
  if (run.gen === gen) { if (started) await started.done; scrub.applied = i; }
  else { // stopped mid-step: finish the step instantly so the board is consistent
    const r2 = { gen };
    resetBoard(); scrub.applied = -1;
    for (let j = 0; j <= i; j++) for (const c of steps[j].cmds) await execCommand(cloneCmd(c), r2, false);
    scrub.applied = i;
  }
  replaying = false; updateSendBtn();
}
async function playFrom(i, fromReplay = false) {
  if (!scrub) return;
  scrub.playing = true; updateTimeline();
  const nav = navSteps();
  let k = nav.indexOf(i); if (k < 0) k = 0;
  if (!fromReplay) await showStep(nav[k], true);
  while (scrub && scrub.playing && k + 1 < nav.length) {
    k++;
    // apply 'you' steps between teacher steps instantly, then animate the next teacher step
    await showStep(nav[k], true);
  }
  if (scrub && scrub.playing) { await sleep(600); if (scrub && scrub.playing && k === nav.length - 1) exitScrub(true); }
  if (scrub) { scrub.playing = false; updateTimeline(); }
}
const liveBusy = () => streaming || (queueRunning && !scrub);
function stepBy(d) {
  const nav = navSteps(); if (!nav.length || liveBusy()) return;
  if (scrub) scrub.playing = false;
  Voice.unlock();
  if (!scrub) { if (d < 0) showStep(nav[nav.length - 1], true); return; }
  const k = nav.indexOf(scrub.i);
  const nk = k + d;
  if (nk >= nav.length) { exitScrub(true); return; }
  if (nk < 0) return;
  showStep(nav[nk], true);
}
function showCaption(text) {
  const c = $('#caption');
  c.textContent = text || ''; c.hidden = !text || !scrub;
}
function updateTimeline() {
  const nav = navSteps(), bar = $('#timeline');
  bar.hidden = !nav.length;
  if (!nav.length) return;
  const range = $('#tlRange');
  range.max = String(nav.length - 1);
  const k = scrub ? Math.max(0, nav.indexOf(scrub.i)) : nav.length - 1;
  if (document.activeElement !== range) range.value = String(k);
  $('#tlLabel').textContent = scrub ? `Step ${k + 1} / ${nav.length} · answer ${answerNo(scrub.i)}` : `${nav.length} step${nav.length === 1 ? '' : 's'} · live`;
  $('#tlLive').hidden = !scrub;
  $('#tlPlay').textContent = scrub && scrub.playing ? '⏸' : '▶';
  $('#tlPlay').title = scrub && scrub.playing ? 'Pause' : 'Play the lesson from this step, with narration';
}
$('#tlPrev').onclick = () => stepBy(-1);
$('#tlNext').onclick = () => stepBy(1);
$('#tlLive').onclick = () => exitScrub();
$('#tlPlay').onclick = () => {
  Voice.unlock();
  const nav = navSteps(); if (!nav.length) return;
  if (scrub && scrub.playing) { stopAll(); scrub.playing = false; updateTimeline(); return; }
  if (!scrub) { replay(); return; }
  playFrom(scrub.i);
};
let rangeTimer = null;
$('#tlRange').addEventListener('input', e => {
  const nav = navSteps(), k = Number(e.target.value);
  clearTimeout(rangeTimer);
  if (liveBusy()) return;
  if (scrub) scrub.playing = false;
  rangeTimer = setTimeout(() => showStep(nav[k], false), 40);
});

// ======================================================================
// persistence: every lesson is a session, auto-saved to the server (sessions/<id>.json)
// with a localStorage copy as a fallback. No save button.
// ======================================================================
const LS_CURRENT = 'wbt.current.v1';
let saveTimer = null, serverTimer = null, sessionCreatedAt = null, dirty = false;
function snapshot() {
  const liveObjs = scrub ? scrub.live.objs : [...objs.values()].map(o => o.cmd);
  return { lesson, camera: scrub ? scrub.live.camera : camera, createdAt: sessionCreatedAt, chat: chat.slice(-300), objs: liveObjs, steps };
}
function saveSoon() {
  if (!lesson) return;
  dirty = true;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300);
  clearTimeout(serverTimer); serverTimer = setTimeout(saveToServer, 1200);
}
function saveNow() {
  if (!lesson || untouched()) return;
  try {
    localStorage.setItem(LS_CURRENT, lesson.session);
    localStorage.setItem('wbt.s.' + lesson.session, JSON.stringify(snapshot()));
  } catch { /* storage full or blocked: the server copy still works */ }
}
const untouched = () => lesson && lesson.autoName && !chat.some(m => m.role === 'user') && !objs.size;
async function saveToServer(keepalive = false) {
  if (!lesson || !dirty || untouched()) return;
  dirty = false;
  const st = $('#saveState');
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(lesson.session), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()), keepalive });
    if (!r.ok) throw new Error(r.status);
    st.textContent = 'saved'; st.title = 'Auto-saved ' + new Date().toLocaleTimeString();
  } catch { dirty = true; st.textContent = 'saved in browser only'; st.title = 'Could not reach the server; kept in this browser for now.'; }
}
window.addEventListener('pagehide', () => { saveNow(); if (dirty) saveToServer(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveNow(); saveToServer(true); } });
function saveSettings() { try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} }

function resetBoard() {
  for (const o of objs.values()) o.g.remove();
  objs.clear(); selection.clear(); updateEmpty(); drawSelection(); updateSelectionUI();
}
function applySession(d) {
  stopAll(); scrub = null; resetBoard();
  steps = Array.isArray(d.steps) ? d.steps : (d.objs && d.objs.length ? [{ say: '', by: 'teacher', cmds: d.objs.map(c => ({ ...c, _placed: true })), t: 'base' }] : []);
  lesson = d.lesson; sessionCreatedAt = d.createdAt || new Date().toISOString();
  chat = Array.isArray(d.chat) ? d.chat : [];
  for (const raw of d.objs || []) {
    if (!raw || !builders[raw.cmd]) continue;
    const c = normalizeShape(raw.cmd, raw, { cmd: raw.cmd, id: raw.id });
    if (c) { c.id = raw.id; c._placed = true; drawObject(c, { gen }, false); }
  }
  if (d.camera && Number.isFinite(d.camera.scale)) { camera = { x: num(d.camera.x, 0), y: num(d.camera.y, 0), scale: clamp(d.camera.scale, 0.05, 12) }; applyCamera(); }
  else fit(false);
  renderTitle(); renderChat(); updateEmpty(); updateTimeline();
  saveNow();
}
async function fetchSession(id) {
  try { const r = await fetch('/api/sessions/' + encodeURIComponent(id)); if (r.ok) return await r.json(); } catch {}
  try { const d = JSON.parse(localStorage.getItem('wbt.s.' + id) || 'null'); if (d && d.lesson) return d; } catch {}
  return null;
}
async function listSessions() {
  let list = [];
  try { const r = await fetch('/api/sessions'); if (r.ok) list = (await r.json()).sessions || []; } catch {}
  // include browser-only copies the server does not have (e.g. saved while it was offline)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith('wbt.s.')) continue;
      const id = k.slice(6); if (list.some(s => s.id === id)) continue;
      const d = JSON.parse(localStorage.getItem(k) || 'null'); if (!d || !d.lesson) continue;
      list.push({ id, topic: d.lesson.topic, createdAt: d.createdAt, updatedAt: null, objects: (d.objs || []).length, messages: (d.chat || []).filter(m => m.role === 'user').length, local: true });
    }
  } catch {}
  return list;
}
async function resumeSession(id) {
  if (lesson && lesson.session === id) { sessDlg.close(); return; }
  saveNow(); await saveToServer();
  const d = await fetchSession(id);
  if (!d) { alert('Could not open that lesson.'); return; }
  applySession(d); sessDlg.close();
}
async function loadAll() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_SET) || '{}')); } catch {}
  if (!settings.voice || typeof settings.voice !== 'object') settings.voice = { mode: 'off', voice: 'af_heart', speed: 1, engine: 'server' };
  // narration became opt-in (v3): switch it off once for everyone; the learner can turn it back on in ⚙
  if (!settings.voiceV3) { settings.voice = { ...settings.voice, mode: 'off', lastMode: 'kokoro' }; settings.voiceV3 = true; try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} }
  if (!settings.efforts || typeof settings.efforts !== 'object') settings.efforts = {};
  // migrate the single-board save from the first version
  try {
    const old = JSON.parse(localStorage.getItem('wbt.data.v1') || 'null');
    if (old && old.lesson && old.lesson.session && !localStorage.getItem('wbt.s.' + old.lesson.session)) { localStorage.setItem('wbt.s.' + old.lesson.session, JSON.stringify(old)); localStorage.setItem(LS_CURRENT, old.lesson.session); }
    localStorage.removeItem('wbt.data.v1');
  } catch {}
  let id = null; try { id = localStorage.getItem(LS_CURRENT); } catch {}
  if (!id) return false;
  const d = await fetchSession(id);
  if (!d || !d.lesson) return false;
  applySession(d);
  return true;
}

// sessions dialog
const sessDlg = $('#sessDlg');
function ago(iso) {
  if (!iso) return 'not yet on disk';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString();
}
async function openSessions() {
  saveNow(); await saveToServer();
  const ul = $('#sessList'); ul.textContent = '';
  const list = await listSessions();
  if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No saved lessons yet.'; ul.appendChild(li); }
  for (const it of list) {
    const li = document.createElement('li'); if (lesson && it.id === lesson.session) li.className = 'current';
    const info = document.createElement('div'); info.className = 'info';
    const t = document.createElement('div'); t.className = 't'; t.textContent = it.topic;
    const m = document.createElement('div'); m.className = 'm';
    m.textContent = `${lesson && it.id === lesson.session ? 'open now · ' : ''}${ago(it.updatedAt)} · ${it.messages} question${it.messages === 1 ? '' : 's'} · ${it.objects} drawing${it.objects === 1 ? '' : 's'}${it.local ? ' · browser only' : ''}`;
    info.append(t, m); info.onclick = () => resumeSession(it.id);
    const open = document.createElement('button'); open.textContent = lesson && it.id === lesson.session ? 'Open' : 'Resume'; open.onclick = () => resumeSession(it.id);
    const del = document.createElement('button'); del.textContent = 'Delete'; del.title = 'Delete this lesson';
    del.onclick = async () => {
      if (!confirm(`Delete “${it.topic}”? This cannot be undone.`)) return;
      try { await fetch('/api/sessions/' + encodeURIComponent(it.id), { method: 'DELETE' }); } catch {}
      try { localStorage.removeItem('wbt.s.' + it.id); } catch {}
      if (lesson && it.id === lesson.session) { stopAll(); resetBoard(); lesson = null; chat = []; try { localStorage.removeItem(LS_CURRENT); } catch {} renderTitle(); renderChat(); }
      openSessions();
    };
    li.append(info, open, del); ul.appendChild(li);
  }
  if (!sessDlg.open) sessDlg.showModal();
}
$('#sessionsBtn').onclick = openSessions;
$('#sessClose').onclick = () => { sessDlg.close(); if (!lesson) newSession(); };
$('#sessNew').onclick = () => { sessDlg.close(); newSession(); };

// ======================================================================
// chat UI
// ======================================================================
const msgBox = $('#messages'), input = $('#input'), sendBtn = $('#sendBtn');
function scrollChat() { msgBox.scrollTop = msgBox.scrollHeight; }
function bubble(m) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  const body = document.createElement('span'); body.className = 'body'; body.textContent = m.text || ''; d.appendChild(body);
  if (m.role === 'user' && ((m.about && m.about.length) || m.sketch)) { const a = document.createElement('span'); a.className = 'about'; a.textContent = [m.about && m.about.length ? 'about ' + m.about.join(', ') : '', m.sketch ? 'with your sketch' : ''].filter(Boolean).join(' · '); d.appendChild(a); }
  if (m.role === 'user' && m.steer) { const a = document.createElement('span'); a.className = 'steer'; a.textContent = '↪ sent while the teacher was answering'; d.appendChild(a); }
  if (m.role === 'assistant') { const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = m.meta || ''; d.appendChild(meta); }
  msgBox.appendChild(d); scrollChat();
  return d;
}
function renderChat() {
  msgBox.textContent = '';
  if (!chat.length) {
    bubble({ role: 'system', text: lesson ? `Ask about anything; the teacher answers by drawing on the board.\nAnswers are generated live and can be wrong.` : 'Start a session to begin.' });
  }
  chat.forEach(bubble);
  renderChips();
}
function renderChips() {
  const box = $('#chips'); box.textContent = '';
  const add = (label, q, primary) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (primary) b.className = 'primary'; b.onclick = () => send(q || label); box.appendChild(b); };
  if (!lesson) { add('Choose a topic', null, true); box.lastChild.onclick = openTopic; return; }
  const ids = [...selection].filter(id => objs.has(id));
  if ([...inkSinceAsk].some(id => objs.has(id))) {
    add('Check my drawing', 'Check my drawing.', true);
    add('Turn my sketch into a clean diagram'); add('What is missing in my drawing?'); add('Mera drawing check karo (Hinglish)');
    return;
  }
  if (ids.length === 1) {
    const n = nameOf(ids[0]);
    add(`What is “${n}”?`); add(`Why is “${n}” drawn like this?`); add(`Change “${n}” to another example`); add(`Hinglish mein samjhao: “${n}”`);
  } else if (ids.length > 1) {
    add('How are these connected?'); add('Compare these'); add('Hinglish mein samjhao ye kaise jude hain');
  } else if (!chat.some(m => m.role === 'user')) {
    if (!lesson.autoName) add(`Explain ${lesson.topic}`, `Explain ${lesson.topic}, starting from the big picture, with one concrete example.`, true);
  } else {
    // follow-ups the teacher suggested for what it just drew; the generic ones otherwise
    const last = [...chat].reverse().find(m => m.role === 'assistant');
    const o = lesson.outline, more = o && o.done < o.parts.length;
    if (more) add(`Continue: ${o.done + 1}. ${o.parts[o.done]}`, `Continue the lesson with part ${o.done + 1}: ${o.parts[o.done]}.`, true);
    if (last && last.next && last.next.length) { last.next.forEach((q, i) => add(q, null, i === 0 && !more)); add('Quiz me on this'); add('Hinglish mein samjhao'); }
    else { add('Go one level deeper'); add('Show a worked example with numbers'); add('What is a common mistake?'); add('Summarise the board'); add('Quiz me on this'); add('Hinglish mein samjhao'); }
  }
}
function updateSendBtn() {
  const working = streamingLive() || queueRunning || replaying || typers.size > 0 || Voice.speaking(), p = isPaused();
  const pb = $('#pauseBtn'); pb.hidden = !working && !p; pb.textContent = p ? '▶' : '⏸'; pb.classList.toggle('on', p);
  pb.title = p ? 'Resume the lesson' : 'Pause the lesson (you can ask something while paused)';
  renderResumeBar();
  // while the teacher works you can still send: the message steers the answer (Stop is its own button)
  $('#stopBtn').hidden = !working;
  sendBtn.title = working ? 'Send now: the teacher finishes its sentence, then takes your message into account' : '';
  input.placeholder = p ? 'Ask about it while paused… (▶ to resume)' : working ? 'Add something while the teacher answers…' : (inkSinceAsk.size && !penMode ? input.placeholder : 'Ask the teacher…');
}
$('#stopBtn').onclick = () => stopAll();
$('#pauseBtn').onclick = () => setPaused(!isPaused());
$('#resumeGo').onclick = () => continueParked();
$('#resumeX').onclick = () => dropParked();

function setPaused(on) {
  if (on && pausedAt == null) { pausedAt = performance.now(); Voice.pause(); dlog('paused'); }
  else if (!on && pausedAt != null) { pausedTotal += performance.now() - pausedAt; pausedAt = null; Voice.resume(); pauseWaiters.splice(0).forEach(f => f()); dlog('resumed'); }
  document.body.classList.toggle('paused', isPaused());
  updateSendBtn();
}
// a parked answer may still be streaming in the background: it does not count as "the teacher is answering"
function streamingLive() { return activeStreams - (parked && !parked.turn.streamDone ? 1 : 0) > 0; }
// A question asked while paused: set the paused answer aside (what is left of it, plus the sentence that was
// cut short), answer the question, and offer to continue from there.
let liveTurn = null;
function parkLive() {
  // already holding an answer to continue (this is a question about a side answer): keep the original lesson,
  // just stop the side answer
  if (parked) { stopAll(false); return; }
  const t = liveTurn;
  const busy = t && (!t.streamDone || queue.length || queueBusy || Voice.speaking());
  if (!busy) { setPaused(false); return; }
  t.parkedQ = queue.splice(0);
  const cut = lastSay && lastSay.turn === t && (queueBusy || Voice.speaking() || (t.parkedQ.length && t.parkedQ[0].say == null));
  if (cut) t.parkedQ.unshift({ ...lastSay, repeat: true, voice: Voice.enabled() ? Voice.prepare(lastSay.say) : null });
  if (currentItem && currentItem.cmd && currentItem.turn === t) currentItem.keep = true;
  parked = { turn: t, abort: t.abort, say: lastSay && lastSay.turn === t ? lastSay.say : '' };
  dlog('set aside the paused answer:', t.parkedQ.length, 'lines', t.streamDone ? '' : '(still streaming)');
  gen++; Voice.stop(); narrationDone = Promise.resolve(); finishTyping(); hideIcon(pen); hideIcon(eraser);
  setPaused(false);
}
function continueParked() {
  const p = parked; if (!p || streamingLive() || queueRunning) return;
  parked = null;
  const t = p.turn, items = t.parkedQ || []; t.parkedQ = null;
  t.run.gen = gen;                                   // its remaining lines animate again
  t.el = bubble({ role: 'assistant', text: '', meta: '' });
  const lab = document.createElement('span'); lab.className = 'cont'; lab.textContent = '↩ continuing where we left off'; t.el.insertBefore(lab, t.el.firstChild);
  Voice.unlock();
  items.forEach(enqueue);
  updateSendBtn();
}
function dropParked() {
  const p = parked; if (!p) return;
  parked = null;
  if (p.abort && !p.turn.streamDone) p.abort.abort();
  p.turn.parkedQ = null; p.turn.msg.interrupted = true;
  updateSendBtn();
}
function renderResumeBar() {
  const bar = $('#resumeBar'); if (!bar) return;
  const show = !!parked && !streamingLive() && !queueRunning && ((parked.turn.parkedQ && parked.turn.parkedQ.length) || !parked.turn.streamDone);
  bar.hidden = !show;
  if (show) $('#resumeText').textContent = `⏸ Paused at: “${parked.say || 'the previous answer'}”`;
}
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  let q = input.value.trim();
  if (!q && [...inkSinceAsk].some(id => objs.has(id))) q = 'Check my drawing.';
  if (!q) return;
  input.value = ''; input.style.height = 'auto';
  if (isPaused() && !scrub) send(q, { side: true });
  else send(q, { steer: !scrub && (streamingLive() || queueRunning) });
});
$('#clearChatBtn').onclick = () => { if (!chat.length) return; stopAll(); chat = []; renderChat(); saveSoon(); };
$('#selAsk').onclick = () => input.focus();
$('#selErase').onclick = () => { if (!scrub) learnerErase([...selection]); };
function learnerErase(ids) { recordEdit({ cmd: 'erase', ids: ids.slice() }); eraseIds(ids, { gen }, true); }
$('#selClear').onclick = () => setSelection([]);

// typewriter (~60 chars/s) — never blocks the pen
function typeInto(turn, text, cps) {
  const add = (turn.text ? '\n' : '') + text;
  turn.text += add;
  turn.pendingType = (turn.pendingType || '') + add;
  turn.cps = cps ? clamp(cps, 8, 120) : 60;   // with narration, type at the speaking rate
  if (turn.typing) return;
  turn.typing = true; typers.add(turn); updateSendBtn();
  const body = turn.el.querySelector('.body');
  if (turn.thinking) { body.textContent = ''; body.classList.remove('thinking'); turn.thinking = false; }
  let acc = 0;
  const tick = () => {
    if (!turn.pendingType) { turn.typing = false; typers.delete(turn); updateSendBtn(); return; }
    if (isPaused()) { turn.timer = setTimeout(tick, 100); return; }
    acc += turn.cps * 0.033; const n = Math.floor(acc); acc -= n;
    body.textContent += turn.pendingType.slice(0, n); turn.pendingType = turn.pendingType.slice(n);
    scrollChat(); turn.timer = setTimeout(tick, 33);
  };
  tick();
}
function finishTyping() {
  for (const t of typers) { clearTimeout(t.timer); const body = t.el.querySelector('.body'); body.textContent += t.pendingType || ''; t.pendingType = ''; t.typing = false; }
  typers.clear(); updateSendBtn();
}

function stopAll(dropPark = true) {
  if (queue.length || streaming) dlog('stopAll with', queue.length, 'queued, streaming=' + streaming, (new Error().stack || '').split('\n').slice(2, 5).map(l => l.trim().replace(/^at /, '')).join(' < '));
  gen++;
  queue.length = 0;
  Voice.stop(); narrationDone = Promise.resolve();
  if (scrub) scrub.playing = false;
  if (abortCtl) { abortCtl.abort(); abortCtl = null; }
  if (isPaused()) setPaused(false);
  if (dropPark) dropParked();
  finishTyping();
  hideIcon(pen); hideIcon(eraser);
  updateSendBtn();
}

// ======================================================================
// queue: say lines type while the commands after them draw
// ======================================================================
let queueBusy = false;       // a board command is being drawn right now
// sleep that only counts unpaused time, so a long pause never makes the queue give up and skip ahead
function psleep(ms) { return new Promise(res => { let left = ms, last = performance.now(); const id = setInterval(() => { const now = performance.now(); if (!isPaused()) left -= now - last; last = now; if (left <= 0) { clearInterval(id); res(); } }, 100); }); }
let currentItem = null, lastSay = null;
function enqueue(item) {
  if (item.turn && item.turn.parkedQ) { item.turn.parkedQ.push(item); return; }   // its answer is set aside: keep for Continue
  queue.push(item); if (!queueRunning) runQueue();
}
async function runQueue() {
  queueRunning = true; updateSendBtn();
  for (;;) {
  while (queue.length) {
    await whilePaused();
    const it = queue.shift(); if (!it) continue;
    currentItem = it;
    try {
    if (it.say != null) {
      lastSay = it;
      recordSay(it.turn, it.say);
      if (it.voice && Voice.enabled()) {
        // one narrated sentence at a time: wait until the previous one (and the drawing after it) is done
        const w0 = Date.now();
        await Promise.race([narrationDone, psleep(45000)]);
        if (Date.now() - w0 > 44000 && !isPaused()) dlog('narration wait timed out; continuing');
        if (it.run && it.run.gen !== gen) continue;
        const r = await Promise.race([Voice.play(it.voice), psleep(100000).then(() => { dlog('voice.play timed out'); return { duration: 0, done: Promise.resolve() }; })]);
        if (it.run && it.run.gen !== gen) continue;
        dlog('say', r.duration ? r.duration.toFixed(1) + 's' : 'no audio', JSON.stringify(it.say.slice(0, 50)));
        beginPace(r.duration || it.say.length / SPEAK_CPS);
        if (!it.repeat) typeInto(it.turn, it.say, r.duration ? it.say.length / r.duration : null);
        narrationDone = r.done.then(() => sleep(250)); r.done.then(updateSendBtn);
        updateSendBtn();
      } else { beginPace(it.say.length / SPEAK_CPS); if (!it.repeat) typeInto(it.turn, it.say, SPEAK_CPS); }
      continue;
    }
    const run = it.run;
    dlog('draw', it.cmd.cmd, it.cmd.id || '', run.gen === gen ? '' : '(stale run)');
    if (it.turn.thinking) { const bd = it.turn.el.querySelector('.body'); bd.classList.remove('thinking'); bd.textContent = ''; it.turn.thinking = false; }
    const before = it.cmd.id;
    queueBusy = true;
    const nextSay = queue.findIndex(x => x.say != null);
    setPaceShare(1 + (nextSay < 0 ? queue.length : nextSay));
    await execCommand(it.cmd, run, true);
    paceShare = null; queueBusy = false;
    if (run.gen === gen || it.keep) recordCmd(it.turn, it.cmd);   // keep: finished instantly when its answer was set aside
    if (before) it.turn.drew.add(before);
    if (it.cmd.cmd === 'erase') it.cmd.ids.forEach(i => it.turn.drew.add('erased ' + i));
    } catch (err) {
      dlog('skipped a queue item after an error:', String(err && err.stack || err).slice(0, 300), JSON.stringify(it.cmd || { say: it.say }).slice(0, 200));
      hideIcon(pen); hideIcon(eraser); queueBusy = false;
    }
  }
  // let the last sentence finish; more lines may stream in meanwhile, so check again before going idle
  await Promise.race([narrationDone, psleep(45000)]);
  if (!queue.length) break;
  }
  queueRunning = false; currentItem = null; updateSendBtn(); renderResumeBar();
}

// ======================================================================
// the prompt
// ======================================================================
function boardSummary() {
  const b = allBounds(), v = viewRect(), r = n => Math.round(n);
  const lines = [];
  if (!b) lines.push('The board is empty. Start near (0, 0).');
  else {
    lines.push(`Everything drawn spans x ${r(b.x)}..${r(b.x + b.width)}, y ${r(b.y)}..${r(b.y + b.height)}.`);
    lines.push(`Free space: to the right starting at x=${r(b.x + b.width + 80)} (y from ${r(b.y)}), and below starting at y=${r(b.y + b.height + 80)} (x from ${r(b.x)}).`);
  }
  lines.push(`The learner is looking at x ${r(v.x)}..${r(v.x + v.width)}, y ${r(v.y)}..${r(v.y + v.height)}.`);
  const list = [...objs.values()].slice(-70);
  if (list.length) {
    lines.push(`Objects on the board (${objs.size} total${objs.size > 70 ? ', last 70 shown' : ''}):`);
    for (const o of list) {
      const c = o.cmd, bb = bbOf(o), bits = [`${c.id} ${c.cmd}`, c.color];
      if (c.text) bits.push(JSON.stringify(c.text.slice(0, 60)));
      if (c.label) bits.push('label ' + JSON.stringify(c.label));
      if (c.sub) bits.push('sub ' + JSON.stringify(c.sub));
      if (c.values) bits.push('values ' + JSON.stringify(c.values).slice(0, 80));
      if (c.cmd === 'arrow') bits.push(`from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`);
      if (c.cmd === 'highlight') bits.push(`on ${c.target}`);
      if (c.cmd === 'flow') bits.push(`dots moving along ${c.on}`);
      if (c.cmd === 'ink') bits.push("the learner's own pen sketch");
      if (c.cmd === 'icon') bits.push('icon ' + c.name);
      if (c.cmd === 'tokens') bits.push('items ' + JSON.stringify(c.items.map(i => i.text)).slice(0, 90));
      if (c.cmd === 'frame' || c.cmd === 'brace') bits.push('around ' + c.around.join(','));
      if (c.cmd === 'schedule') bits.push('rows ' + c.rows.map(rw => rw.label).join(',') + ` · ${c.steps} steps`);
      if (c.cmd === 'math') bits.push('tex ' + JSON.stringify(c.tex.slice(0, 60)));
      if (c.cmd === 'graph') bits.push(`nodes ${c.nodes.map(n => n.id).join(',').slice(0, 80)}`);
      if (c.cmd === 'network') bits.push(`layers ${c.layers.join('-')}`);
      bits.push(`box x${r(bb.x)} y${r(bb.y)} w${r(bb.width)} h${r(bb.height)}`);
      lines.push('- ' + bits.join(' · '));
    }
  }
  return lines.join('\n');
}
function systemPrompt(selIds) {
  return `You are a great teacher at a whiteboard. The board SHOWS the idea (pictures, not text); your voice EXPLAINS it: the reasoning, the why, the cause and effect, while the pen draws. A learner should come away actually understanding, not just having seen a diagram.

Session name: "${lesson.topic}" (just a label for this whiteboard; teach whatever the learner asks, on any subject).

BOARD (infinite; units are board units; x grows right, y grows down)
${boardSummary()}
${outlinePrompt()}${selIds.length ? `\nTHE LEARNER SELECTED: ${selIds.map(id => `${id} (${nameOf(id)})`).join(', ')}. Work on these directly: update them, build next to them, point at them.\n` : ''}
OUTPUT: JSON Lines only, one object per line, nothing else (no markdown, no code fences, no prose outside JSON).
Spoken line: {"say":"one short sentence"}   It is spoken while the drawing commands right after it are drawn, so it must explain exactly those.
Board commands (each line has "cmd"). Place things with "near" instead of guessing coordinates: "near":{"of":"<id>","side":"right|left|below|above","gap":70}. Give x,y only for the very first object of a new area (use the free space listed above).

Pictures, best first:
{"cmd":"icon","id":"gpu","name":"gpu","label":"GPU","near":{"of":"q","side":"right"}}   icons: ${window.WB_ICONS ? WB_ICONS.names.join(', ') : 'gpu, server, database, person, document'} (plus common synonyms). Use them for every real-world thing.
{"cmd":"tokens","id":"r1","items":["The","cat","sat",""],"color":"#1d6fb8","highlight":[2],"label":"request A","near":{"of":"gpu","side":"below"}}   a row of chips: tokens, words, slots, packets, queue items, array cells ("" = empty slot); "vertical":true for a stack
{"cmd":"box","id":"b1","x":0,"y":0,"label":"Scheduler","sub":"every step","color":"#1d6fb8","fill":true}   a component
{"cmd":"circle","id":"c1","label":"x","color":"#2a8a3e","fill":true,"near":{"of":"b1","side":"right"}}
{"cmd":"arrow","id":"a1","from":"b1","to":"c1","label":"sends","curve":0.2,"dash":false,"color":"#1f2328"}   from/to = ids (or [x,y]); this is how anything moves or causes anything
{"cmd":"frame","id":"f1","around":["gpu","r1"],"label":"one batch"}   groups related things (icons, boxes, tokens) in a dashed box; not around arrows
{"cmd":"brace","id":"br1","around":["r1"],"side":"below","label":"4 tokens"}   measures or names a span
{"cmd":"schedule","id":"s1","x":0,"y":0,"label":"GPU slots over time","rows":[{"label":"slot 1","spans":[[0,4,"A","#1d6fb8"],[4,6,"D","#2a8a3e"]]},{"label":"slot 2","spans":[[0,2,"B","#c48a00"]]}],"steps":6,"markers":[{"at":2,"label":"B done"}]}   what happens when: time steps across, lanes down (from inclusive, to exclusive)
{"cmd":"sequence","id":"sq","actors":["Client","Server"],"messages":[["Client","Server","SYN seq=100"],["Server","Client","SYN-ACK"],["Client","Server","ACK",true]],"label":"handshake"}   who sends what to whom, in order (protocols, API calls, requests); true = dashed reply
{"cmd":"graph","id":"g1","nodes":["Client","API","DB"],"edges":[["Client","API","request"],["API","DB"]],"layout":"layered|circle|grid","near":{"of":"b1","side":"below"}}   flows, pipelines, state machines
{"cmd":"tree","id":"t1","root":{"label":"root","children":[{"label":"left"},{"label":"right"}]}}
{"cmd":"network","id":"nn","layers":[3,4,2],"labels":["in","hidden","out"]}
{"cmd":"bars","id":"p1","values":[0.1,0.6,0.3],"labels":["cat","sat","mat"],"label":"probability"}   compare amounts
{"cmd":"numberline","id":"n1","from":0,"to":10,"marks":[{"at":3,"label":"w"}]}   {"cmd":"timeline","id":"tl","events":[{"label":"v1","at":"2019"}]}
{"cmd":"vector","id":"v1","values":[0.2,0.7],"label":"q"}   {"cmd":"matrix","id":"m1","values":[[1,0],[0,1]],"label":"W"}   {"cmd":"plot","id":"f","fn":"sigmoid|exp|tanh|relu|gelu|sin|log","label":"σ"}
{"cmd":"table","id":"tb","header":["Model","Params"],"rows":[["A","1B"]]}   only for real reference numbers, never for explaining
{"cmd":"math","id":"e1","x":0,"y":0,"tex":"E = mc^2"}   {"cmd":"code","id":"k1","code":"x = 1","lang":"python"}   {"cmd":"line","id":"l1","points":[[0,0],[100,40]]}
Changing the board:
{"cmd":"highlight","id":"h1","target":"r1","style":"circle|underline|box","color":"#e07800"}   point at what you are talking about
{"cmd":"update","id":"r1","items":["The","cat","sat","on"],"highlight":[3]}   redraw an object with new values: show change step by step
{"cmd":"move","id":"r1","dx":0,"dy":120}   {"cmd":"erase","ids":["a1"]}   {"cmd":"clear"}
Words on the board, sparingly:
{"cmd":"write","id":"h","x":0,"y":0,"text":"Continuous batching","size":34}   a heading, or a 1-4 word caption. Never a sentence.

Colours (dark markers on white): blue #1d6fb8, amber #c48a00, green #2a8a3e, red #d1382c, purple #7a48c2, orange #e07800, black #1f2328, grey #7d848c. Give each kind of thing one colour and keep it.

HOW TO TEACH HERE: SHOW IT ON THE BOARD, EXPLAIN IT IN YOUR VOICE
0. DECIDE THE DEPTH FIRST. Before anything else, work out what this learner actually needs from their question: its intent and meaning, what is already on the board, and what came before in the conversation. Never decide from the wording alone. Then start the answer with one hidden planning line (never shown):
   {"plan":{"depth":"quick|explain|deep","why":"<what the learner needs, max 15 words>","pictures":"<the pictures and the tool for each>","parts":["<deep only: 3-6 short part names>"],"now":[1]}}
   - quick: ONLY when they need one fact, a name, a yes/no, or a small correction, and nothing about it is confusing them. 1-2 sentences and the smallest drawing that makes it clear. Never use quick for a "why" or "how", or for something they have not understood yet.
   - explain: they want to understand one idea that has a real reason behind it. Build one worked picture step by step and explain the reasoning behind each step.
   - deep: understanding needs several connected ideas (a mechanism with stages, a trade-off, a derivation, a system with moving parts), or the learner is still confused after an earlier explanation. Split it into 3-6 parts in "parts" and teach the first two or three now ("now" = their numbers, starting at 1), each under its own short heading in fresh space. Stop at a natural checkpoint; the rest is taught when the learner continues.
   Answers stream live and the learner follows along as you draw and speak, so a long answer costs them nothing: when unsure between two depths, choose the fuller one. Only quick answers should be short.
   Read the conversation, not just the last message. If the learner asked about this before, says it is still unclear, or keeps asking "why" about the same thing, your last explanation did not land: go DEEPER, never shorter. Start again from the idea they are missing (often a more basic one), take a different angle (a new concrete example, real numbers carried through, an analogy drawn as a picture), and move in smaller steps. Do not repeat or summarise what you already said.
   What depth means: depth is understanding, not more pictures. A deep or explain answer makes the learner see WHY each step happens. Explain the cause behind each step, carry one concrete example with real values through every step, and say what would go wrong without it. Name the misconception the learner probably has and fix it. End on the one sentence that ties it together.
   When a lesson is in progress (see LESSON IN PROGRESS above) and the learner wants to go on, plan depth "deep" with the same "parts" and "now" = the next part numbers. A question about something else is answered on its own at its own depth; the lesson waits.
   Pick the tool that makes each idea obvious at a glance, e.g. protocol or request/response → sequence; anything over time → schedule; a system → icons + arrows inside frames.
1. Every idea becomes a picture. Ask "what does this look like?" and draw that: things → icons or boxes; sequences, tokens, slots, queues → tokens; what happens over time → schedule (or several snapshots side by side); cause and movement → arrows; parts of a whole → frame; sizes and counts → brace, bars; structure → graph, tree, network.
2. Draw the concrete example itself (the actual tokens, requests, numbers, names), never a description of it.
3. Board text is labels only: 1-4 words or a number. At most 3 write commands per answer (a heading and short captions); in deep, one heading per part plus 2 captions. The explaining happens in your voice, not in board text. No sentences, definitions, legends or bullet lists on the board.
4. Spoken lines: each is one sentence (at most 22 words) that explains the drawing that follows it: what it is AND why it works that way. Do not just name what is drawn ("this is the matrix"); say what it means and why it matters ("each row mixes all four inputs, so every output sees the whole token"). As many lines as the understanding needs: 1-2 for quick, about 8-14 for explain, about 8-12 per part for deep. Do not describe what the drawing already shows plainly; add the reasoning it cannot show. Narrate what the pen is drawing right now: each sentence explains the commands that follow it, up to the next sentence. Never talk ahead about something drawn later, or back about something drawn earlier without updating or highlighting it.
5. Rhythm: say → 2-5 drawing commands → say → 2-5 drawing commands … The amount follows the depth: a few commands for quick, about 20-40 for explain, about 20-35 per part for deep. At least 85% of them pictures.
6. Layout: one clear diagram per idea, flowing left→right or top→bottom, laid out with near; keep 40+ units between things; put before/after or wrong/right side by side; frame what belongs together. Arrows join things that are next to each other; never draw an arrow across another drawing.
7. Build on the board: keep earlier drawings, extend and update them (update is how a picture changes over time). Erase only a wrong or outdated picture, and say why. A new subject starts with a heading in free space.
8. Objects of type ink are the learner's own pen sketches. When a picture of their sketch is attached, work out from the picture yourself what it shows (never ask them to describe it). Name what you see in one short spoken line, then answer their question about it; if they asked nothing specific, check it: highlight what is right and draw the corrected version next to their sketch. Never erase or move their ink.
9. End every answer with one line of 3 follow-up questions the learner would naturally ask next about what you just drew: {"next":["Why is the disk 10,000× slower?","What if two requests need one slot?","Show LRU vs FIFO eviction"]}. Each at most 8 words, specific to this board (name its actual things), not generic ("tell me more"). Mix: one deeper "why", one "what if", one new example or comparison.
10. Language: reply in the language of the learner's latest message; that is English unless that message is in Hinglish or asks for Hinglish (then Hinglish in Latin script). Board labels and the "next" questions follow the same language. Say when numbers are only illustrative.

EXAMPLE of the balance wanted (a different topic; notice every spoken line gives a reason, not just a name):
{"plan":{"depth":"explain","why":"wants to know why a cache makes programs faster","pictures":"CPU, cache, disk icons with hit/miss arrows and their times; cache slots as tokens; update them to show eviction"}}
{"say":"The CPU can only work on data it has in hand, so where data lives decides the speed."}
{"cmd":"write","id":"hc","x":0,"y":0,"text":"Caching","size":34}
{"cmd":"icon","id":"cpu","name":"cpu","label":"CPU","near":{"of":"hc","side":"below","gap":50}}
{"cmd":"icon","id":"disk","name":"database","label":"disk","sub":"10 ms","near":{"of":"cpu","side":"right","gap":420}}
{"say":"Fetching from disk takes ten milliseconds: ten million CPU steps spent just waiting."}
{"cmd":"arrow","id":"slow","from":"cpu","to":"disk","label":"10 ms","dash":true,"color":"#d1382c"}
{"say":"So we keep a small, fast memory right beside the CPU for data we just used."}
{"cmd":"icon","id":"mem","name":"memory","label":"cache","sub":"1 ns","near":{"of":"cpu","side":"right","gap":160}}
{"cmd":"arrow","id":"hit","from":"cpu","to":"mem","label":"hit","color":"#2a8a3e"}
{"say":"This works because programs reuse the same data again and again within moments."}
{"cmd":"tokens","id":"slots","items":["user:7","post:3",""],"label":"cache slots","near":{"of":"mem","side":"below","gap":70}}
{"cmd":"brace","id":"cap","around":["slots"],"side":"below","label":"3 slots"}
{"say":"A hit costs one nanosecond; only a miss pays the full trip to disk."}
{"cmd":"erase","ids":["slow"]}
{"cmd":"arrow","id":"miss","from":"mem","to":"disk","label":"miss","dash":true,"color":"#d1382c"}
{"say":"The cache is tiny, so when it fills, the entry least likely to be reused must go."}
{"cmd":"update","id":"slots","items":["post:3","feed:1","user:9"],"highlight":[2]}
{"cmd":"highlight","id":"hl","target":"slots","style":"box","color":"#e07800"}
{"say":"So a cache is a bet on reuse: win it often, and slow storage feels fast."}
{"next":["Why is the disk so much slower?","What if two keys want one slot?","Compare LRU and FIFO eviction"]}`;
}
function buildMessages(question, selIds, inkIds = [], image = null, steer = false) {
  const msgs = [{ role: 'system', content: systemPrompt(selIds) }];
  const hist = chat.filter(m => m.role === 'user' || m.role === 'assistant').slice(-8);
  for (const m of hist) {
    if (m.role === 'user') msgs.push({ role: 'user', content: (m.about && m.about.length ? `[About the selected drawings: ${m.about.join(', ')}] ` : '') + (m.sketch ? `[With my sketch: ${m.sketch.join(', ')}] ` : '') + m.text });
    else msgs.push({ role: 'assistant', content: (m.text || '(drew only)') + (m.interrupted ? '\n(The learner interrupted me here with their next message.)' : '') + (m.drew && m.drew.length ? `\n(On the board I drew or changed: ${m.drew.join(', ')})` : '') });
  }
  const text = (steer ? '[I sent this while you were still answering, so you stopped after your current sentence. Take it into account now: answer or adjust as it asks, then carry on with whatever part of your previous answer still matters, without repeating what is already on the board.] ' : '') + (selIds.length ? `[I selected on the board: ${selIds.join(', ')}] ` : '') + (inkIds.length ? `[I drew a sketch on the board (${inkIds.join(', ')}). ${image ? 'A picture of it, with the drawings around it, is attached: work out what it shows from the picture.' : 'Its strokes are listed in the board summary.'}] ` : '') + question;
  msgs.push({ role: 'user', content: image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text });
  return msgs;
}

// ======================================================================
// sending a question: one streamed call that talks and draws
// ======================================================================
// ======================================================================
// look & tidy: after an answer is drawn, the teacher looks at a picture of it and fixes what is unclear
// ======================================================================
function regionAround(ids, grow) {
  const r = unionBox(ids); if (!r) return null;
  const area = { x: r.x - grow, y: r.y - grow, width: r.width + 2 * grow, height: r.height + 2 * grow };
  const near = [...objs.keys()].filter(k => overlaps(area, bbOf(objs.get(k)), 0));
  return unionBox(ids.concat(near));
}
// Cheap geometric checks the picture review is told about: overlaps, arrows through drawings, cut labels.
function layoutIssues(ids) {
  const out = [], mine = new Set(ids), solid = [...objs.values()].filter(o => BOXLIKE.has(o.cmd.cmd));
  const shrink = (b, m) => ({ x: b.x + m, y: b.y + m, width: Math.max(0, b.width - 2 * m), height: Math.max(0, b.height - 2 * m) });
  const inside = (p, b) => p[0] > b.x && p[0] < b.x + b.width && p[1] > b.y && p[1] < b.y + b.height;
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    if (!mine.has(a.cmd.id) && !mine.has(b.cmd.id)) continue;
    if (overlaps(shrink(bbOf(a), 2), shrink(bbOf(b), 2), 0)) out.push(`${a.cmd.id} (${nameOf(a.cmd.id)}) overlaps ${b.cmd.id} (${nameOf(b.cmd.id)})`);
  }
  for (const id of ids) {
    const o = objs.get(id); if (!o || o.cmd.cmd !== 'arrow') continue;
    const geo = arrowGeometry(o.cmd); if (!geo) continue;
    const [p1, q, p2] = geo, hit = new Set();
    for (let k = 2; k <= 18; k++) {
      const t = k / 20, u = 1 - t, p = [u * u * p1[0] + 2 * u * t * q[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * q[1] + t * t * p2[1]];
      for (const s of solid) if (s.cmd.id !== o.cmd.from && s.cmd.id !== o.cmd.to && inside(p, shrink(bbOf(s), 6))) hit.add(s.cmd.id);
    }
    if (hit.size) out.push(`arrow ${id} passes through ${[...hit].map(h => `${h} (${nameOf(h)})`).join(', ')}`);
  }
  for (const id of ids) {
    const c = objs.get(id) && objs.get(id).cmd; if (!c) continue;
    const texts = [c.label, c.sub, c.text, ...(c.items || []).map(x => x.text)].filter(Boolean);
    if (texts.some(t => /…$/.test(t))) out.push(`${id} has a label that was cut off (ends in …): give it a shorter label`);
  }
  return out.slice(0, 14);
}
async function waitForBoard(run, signal) {
  const t0 = Date.now();
  while ((queue.length || queueBusy) && run.gen === gen && !signal.aborted && Date.now() - t0 < 300000) await sleep(150);
}
async function tidyPass({ question, answer, model, run, turn, signal }) {
  await waitForBoard(run, signal);
  if (run.gen !== gen || signal.aborted) return;
  const ids = [...turn.drew].filter(id => objs.has(id) && objs.get(id).cmd.cmd !== 'ink');
  if (!ids.length) return;
  const issues = layoutIssues(ids);
  if (ids.length < 3 && !issues.length) return;           // a tiny edit: nothing worth reviewing
  const vm = (modelInfo(model) || {}).vision ? model : ((models.find(m => m.id === 'deepseek-v4.1-flash' && m.vision) || models.find(m => m.vision) || {}).id);
  if (!vm && !issues.length) return;
  const status = document.createElement('div'); status.className = 'tidy'; status.textContent = '👀 Checking the drawing…';
  turn.el.appendChild(status); scrollChat();
  const region = regionAround(ids, 120);
  let image = null;
  if (vm && region) { try { image = await boardImage(region); } catch (e) { dlog('tidy: picture failed', String(e)); } }
  const r = n => Math.round(n);
  const text = `REVIEW YOUR BOARD. ${image ? `The attached picture shows what you just drew (board area x ${r(region.x)}..${r(region.x + region.width)}, y ${r(region.y)}..${r(region.y + region.height)}). Look at it the way the learner sees it.` : 'You cannot see a picture this time: use the checks below and the object list.'}
Objects you drew in this answer: ${ids.join(', ')}.
Automatic checks found:
${issues.length ? issues.map(s => '- ' + s).join('\n') : '- nothing obvious'}

Fix only real problems: drawings that overlap or touch, arrows that cross other drawings or point at the wrong thing, labels that are cut off or unreadable, a cramped or messy layout, something in the picture that is wrong or confusing, or a missing arrow or label the explanation needs.
Reply with JSON Lines of fix commands only:
- move: {"cmd":"move","id":"x","dx":0,"dy":120}  (arrows, frames, braces and highlights follow automatically)
- update: change fields of one object, e.g. a shorter "label", or "curve":0.4 to bend an arrow around something
- erase: a duplicate or wrong drawing
- at most 3 new small drawings (arrow, highlight, brace) if the explanation needs them
At most ${FIX_MAX} lines. No say lines, no plan, no write, no clear. Never touch ink objects (the learner's sketches). Leave what is fine alone.
If the board already looks clear, reply with exactly {"ok":true}`;
  const msgs = [
    { role: 'system', content: systemPrompt([]) },
    { role: 'user', content: question },
    { role: 'assistant', content: answer.slice(0, 6000) || '(drew only)' },
    { role: 'user', content: image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text },
  ];
  const useModel = vm || model;
  const before = turn.fixes || 0;
  try {
    await streamAnswer(msgs, { model: useModel, effort: useModel === settings.model ? (currentEffort() === 'auto' ? null : currentEffort()) : (defaultEffort(useModel) === 'auto' ? null : defaultEffort(useModel)), run, turn, signal, fix: true });
    await waitForBoard(run, signal);
  } catch (e) {
    if (e.name !== 'AbortError' && !signal.aborted) dlog('tidy: review failed', e.code || '', e.message);
    status.remove(); return;
  }
  const n = (turn.fixes || 0) - before;
  dlog('tidy:', issues.length, 'issues found,', n, 'fixes applied');
  status.textContent = n ? `✨ Tidied ${n} thing${n === 1 ? '' : 's'} on the board` : '✓ Drawing checked';
  setTimeout(() => status.remove(), 4000);
}

// ======================================================================
// depth: the model decides from the meaning of the question how much to teach ({"plan":{"depth":…}}).
// The app never inspects the question's words; it only sizes its limits to the model's own decision.
// ======================================================================
const DEPTH_LIMITS = {
  quick:   { cmds: 30,  writes: 2, minPics: 0 },   // a crisp answer is never forced into a big drawing
  explain: { cmds: 90,  writes: 5, minPics: 4 },
  deep:    { cmds: 170, writes: 9, minPics: 6 },
};
const limitsOf = turn => DEPTH_LIMITS[turn.depth] || DEPTH_LIMITS.explain;
function applyPlan(turn, plan) {
  const depth = ['quick', 'explain', 'deep'].includes(plan.depth) ? plan.depth : 'explain';
  turn.depth = depth;
  dlog('plan:', depth, '·', str(plan.why, 120), '·', str(plan.pictures, 160));
  if (depth !== 'deep') return;
  const parts = (Array.isArray(plan.parts) ? plan.parts : []).map(x => clip(x, 48)).filter(Boolean).slice(0, 8);
  if (parts.length < 2) return;
  const now = (Array.isArray(plan.now) ? plan.now : [plan.now]).map(n => Math.round(num(n, 0, 0, 8))).filter(n => n >= 1 && n <= parts.length);
  const prev = lesson.outline, same = prev && prev.parts.length === parts.length && prev.parts.every((x, i) => x.toLowerCase() === parts[i].toLowerCase());
  lesson.outline = { parts, done: Math.max(same ? prev.done : 0, now.length ? Math.max(...now) : 1) };
  saveSoon();
}
function outlinePrompt() {
  const o = lesson && lesson.outline;
  if (!o || o.done >= o.parts.length) return '';
  return `\nLESSON IN PROGRESS (taught: ${o.done} of ${o.parts.length} parts):\n${o.parts.map((x, i) => `${i < o.done ? '✓' : '·'} ${i + 1}. ${x}`).join('\n')}\n`;
}

// Steering: a message sent mid-answer. The model stops writing, the board finishes the sentence it is on
// (voice and pen), the rest of that answer is dropped, and the new message is answered with that context.
let steering = false;
async function softStop() {
  steering = true;
  if (abortCtl) abortCtl.abort();
  const k = queue.findIndex(x => x.say != null);
  if (k >= 0) { dlog('steer: dropped', queue.length - k, 'queued lines'); if (queue[k].turn) queue[k].turn.msg.interrupted = true; queue.splice(k); }
  const t0 = Date.now();
  while ((streaming || queueRunning) && Date.now() - t0 < 25000) await sleep(80);
  if (streamingLive() || queueRunning) stopAll(false);
  steering = false;
}
async function send(q, opts = {}) {
  if (!lesson) newSession();
  if (opts.side) parkLive();
  else if (opts.steer && (streamingLive() || queueRunning) && !scrub) {
    const um = { role: 'user', text: q, steer: true }; // shown right away; the answer follows once the sentence ends
    const pendingEl = bubble(um); pendingEl.classList.add('pending');
    await softStop();
    pendingEl.remove();
  } else if (streamingLive() || queueRunning || replaying || scrub) stopAll(false);
  if (scrub) exitScrub();
  Voice.unlock();
  $('#modelPop').hidden = true;
  const selIds = [...selection].filter(id => objs.has(id));
  const inkIds = [...inkSinceAsk].filter(id => objs.has(id));
  let image = null;
  if (inkIds.length) { try { const reg = inkRegion(inkIds); if (reg) image = await boardImage(reg); } catch (e) { console.warn('sketch image failed', e); } }
  inkSinceAsk.clear(); $('#attach').hidden = true; input.placeholder = 'Ask the teacher…';
  const messages = buildMessages(q, selIds, inkIds, image, !!opts.steer);
  const userMsg = { role: 'user', text: q, about: selIds.map(nameOf), sketch: inkIds.length ? inkIds : undefined, steer: opts.steer || undefined };
  chat.push(userMsg); const ub = bubble(userMsg);
  if (image) { const im = document.createElement('img'); im.src = image; im.className = 'thumb'; im.alt = 'your sketch'; ub.appendChild(im); }
  const am = { role: 'assistant', text: '', drew: [], meta: '' };
  chat.push(am);
  const turn = { msg: am, text: '', drew: new Set(), el: bubble(am), thinking: true, cmds: 0, key: 't' + Date.now().toString(36) };
  const body = turn.el.querySelector('.body'); body.classList.add('thinking');
  renderChips(); saveSoon();

  let model = settings.model || (models[0] && models[0].id);
  if (lesson.autoName) nameSession(q, model);   // in parallel with the answer, same model
  // a sketch needs a model that can see images
  if (image && !(modelInfo(model) || {}).vision) { const v = models.find(m => m.id === 'deepseek-v4.1-flash' && m.vision) || models.find(m => m.vision); if (v) model = v.id; }
  const eff = model === settings.model ? currentEffort() : defaultEffort(model);
  const effort = eff === 'auto' ? null : eff;
  const run = { gen };
  abortCtl = new AbortController(); const myAbort = abortCtl;
  turn.run = run; turn.abort = myAbort; liveTurn = turn;
  activeStreams++; streaming = true; updateSendBtn();

  // live "thinking" indicator so a slow reasoning model never looks frozen
  const t0 = Date.now(); let reasoningChars = 0;
  const showThinking = () => { if (turn.thinking) body.textContent = `✎ Thinking… ${Math.round((Date.now() - t0) / 1000)}s${reasoningChars ? ` · reasoning ${reasoningChars > 999 ? Math.round(reasoningChars / 1000) + 'k' : reasoningChars} chars` : ''}`; };
  showThinking();
  const thinkTimer = setInterval(showThinking, 500);

  let modelApplied = null, failed = false;
  try {
    const opts = { model, effort, run, turn, signal: myAbort.signal, onReasoning: n => { reasoningChars += n; } };
    let r1;
    // a completely empty reply (no text, no thinking) is usually a provider hiccup: retry once quietly
    try { r1 = await streamAnswer(messages, opts); }
    catch (e) { if (e.code === 'empty' && !myAbort.signal.aborted && !turn.cmds) r1 = await streamAnswer(messages, opts); else throw e; }
    modelApplied = r1.model;
    let answer = r1.content;
    // The teacher must teach by drawing. If the answer was mostly talk, ask once for the picture.
    if ((turn.pics || 0) < limitsOf(turn).minPics && !myAbort.signal.aborted && run.gen === gen) {
      dlog(`a ${turn.depth || 'explain'} answer had only`, turn.pics || 0, 'pictures: asking for a drawing');
      if (turn.thinking) { body.textContent = '✎ Drawing…'; }
      const follow = messages.concat(
        { role: 'assistant', content: r1.content.slice(0, 6000) || '(no answer)' },
        { role: 'user', content: 'That was too wordy for a whiteboard. Now SHOW it: add 10-25 drawing commands (icons, tokens, boxes, arrows, frames, braces, schedule, graph…) laid out with "near" next to what is already on the board. Labels of 1-4 words, no write sentences, at most one short say line. Do not repeat what you already said.' });
      const r2 = await streamAnswer(follow, opts);
      modelApplied = r2.model || modelApplied;
      answer += '\n' + r2.content;
    }
    // look at what was drawn and fix what is unclear (best effort; never fails the answer)
    if (settings.tidy !== false && !myAbort.signal.aborted && run.gen === gen)
      await tidyPass({ question: q, answer, model, run, turn, signal: myAbort.signal });
  } catch (err) {
    failed = true;
    if (err.name === 'AbortError' || myAbort.signal.aborted) { if (steering) am.interrupted = true; if (turn.thinking) { body.classList.remove('thinking'); body.textContent = '(stopped)'; turn.thinking = false; } }
    else {
      const code = err.code || 'network';
      dlog('answer failed', code, err.message);
      if (turn.thinking && !turn.cmds) { turn.el.remove(); chat.splice(chat.indexOf(am), 1); }
      const text = code === 'rate_limited' ? 'Rate limited by OpenCode Go. Wait a moment and ask again.'
        : code === 'thinking_budget' ? `${modelName(model)} used its whole token budget thinking and never wrote an answer. Pick a lower reasoning level (⚙ in the chat header) or another model, then ask again.`
        : code === 'not_granted' ? `The API key was rejected (${err.message}). Check OPENCODE_API_KEY in .env and restart the server.`
        : code === 'no_api_key' ? 'No API key on the server. Put OPENCODE_API_KEY in .env and restart.'
        : code === 'empty' ? `${modelName(model)} returned an empty answer. Try again, or pick another model.`
        : code === 'stalled' ? `${modelName(model)} stopped responding mid-answer. What arrived is shown; ask again or pick another model.`
        : code === 'network' || err instanceof TypeError ? 'Cannot reach the local server. Is `npm start` still running?'
        : `Something went wrong (${code})${err.message ? ': ' + err.message : ''}`;
      const em = { role: 'error', text }; chat.push(em); bubble(em);
    }
  } finally {
    clearInterval(thinkTimer);
    activeStreams = Math.max(0, activeStreams - 1); streaming = activeStreams > 0; turn.streamDone = true;
    if (abortCtl === myAbort) abortCtl = null;
    updateSendBtn();
    const finalize = (final) => {
      am.text = turn.text.trim(); am.drew = [...turn.drew].slice(0, 80);
      if (turn.next) am.next = turn.next;
      if (turn.depth) am.depth = turn.depth;
      am.meta = `${modelApplied || model || 'model'}${effort ? ' · ' + effort : ''} · ${Math.round((Date.now() - t0) / 1000)}s${turn.fixes ? ` · tidied ${turn.fixes}` : ''}`;
      const meta = turn.el.querySelector('.meta'); if (meta) meta.textContent = am.meta;
      if (final && turn.thinking && !failed) { body.classList.remove('thinking'); body.textContent = am.drew.length ? '(drew on the board)' : '(no answer)'; turn.thinking = false; }
      renderChips(); saveSoon();
    };
    const tEnd = Date.now();
    // an answer set aside (paused + a question) is finalized only once it is continued or dropped
    const waitDone = () => { if (turn.parkedQ || ((queueRunning || typers.size || Voice.speaking()) && Date.now() - tEnd < 600000)) setTimeout(waitDone, 200); else finalize(true); };
    finalize(); waitDone();
  }
}

// One streamed Chat Completions call. Say lines and board commands are queued as each line completes.
// fix = true: a tidy-up pass. Only board edits are taken (no talking, no clear, never the learner's ink), at most FIX_MAX.
async function streamAnswer(messages, { model, effort, run, turn, signal, onReasoning, fix = false }) {
  let fixes = 0;
  let content = '', partial = '', jsonBuf = null, modelApplied = null, finish = null, reasoned = 0;
  // brace depth outside strings: >0 means the JSON object continues on the next line
  const depthOf = t => { let d = 0, q = false, esc = false; for (const ch of t) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') q = !q; else if (!q) { if (ch === '{' || ch === '[') d++; else if (ch === '}' || ch === ']') d--; } } return d; };
  const tryParse = t => {
    t = t.replace(/,\s*$/, '');
    try { return JSON.parse(t); } catch {}
    if (/}\s*,?\s*{/.test(t)) { try { return JSON.parse('[' + t.replace(/}\s*,?\s*{/g, '},{') + ']'); } catch {} } // {"say":..}{"cmd":..}
    try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch {}                                         // trailing commas
    const m = t.match(/^\{\s*"say"\s*:\s*"(.*)"\s*\}?$/s); if (m) return { say: m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') }; // a say line with a bad escape
    return undefined;
  };
  const handleLine = rawLine => {
    let line = rawLine.trim();
    if (!line || /^```/.test(line)) return;
    if (jsonBuf != null) {
      // a fresh JSON line while a broken one is buffered: drop the broken one
      // (pretty-printed continuation lines never start with {"say"/{"cmd", so a line that does is a new object)
      if (/^\{\s*"(say|cmd|plan|type|op)"/.test(line)) { dlog('dropped unparsable line', jsonBuf.slice(0, 160)); jsonBuf = null; }
      else { jsonBuf += '\n' + line; line = jsonBuf; }
    }
    if (line.startsWith('{') || line.startsWith('[')) {
      let obj = tryParse(line);
      if (obj === undefined) {
        if (depthOf(line) > 0 && line.length < 8000) { jsonBuf = line; return; }  // continues on the next line
        dlog('dropped unparsable line', line.slice(0, 160)); jsonBuf = null; return;
      }
      jsonBuf = null;
      const items = Array.isArray(obj) ? obj : [obj];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (typeof it.plan === 'string') dlog('plan:', it.plan.slice(0, 200));
        if (!fix && it.plan && typeof it.plan === 'object' && typeof it.plan.depth === 'string') applyPlan(turn, it.plan);
        if (!fix && Array.isArray(it.next)) { const nx = it.next.map(x => clip(x, 70)).filter(Boolean).slice(0, 4); if (nx.length) turn.next = nx; }
        if (it.plan && typeof it.plan === 'object' && !lesson.plan) { lesson.plan = { example: str(it.plan.example, 300), colors: it.plan.colors && typeof it.plan.colors === 'object' ? Object.fromEntries(Object.entries(it.plan.colors).slice(0, 8).map(([k, v]) => [str(k, 40), col(v)])) : {} }; saveSoon(); }
        if (it.say != null) {
          const t = trimSay(str(it.say, 1200)); if (t.length < String(it.say).trim().length) dlog('shortened a long spoken line');
          if (!fix) enqueue({ say: t, turn, run, voice: Voice.enabled() ? Voice.prepare(t) : null });
        }
        if (it.cmd || it.type || it.op) {
          if (fix) {
            const c = normalize(it);
            if (!c || c.cmd === 'clear' || c.cmd === 'wait' || c.cmd === 'write' || fixes >= FIX_MAX) { dlog('tidy: skipped', JSON.stringify(it).slice(0, 120)); continue; }
            const touches = c.cmd === 'erase' ? c.ids : ['move', 'update'].includes(c.cmd) ? [c.id] : [];
            if (touches.some(id => objs.get(id) && objs.get(id).cmd.cmd === 'ink')) { dlog('tidy: left the learner\'s ink alone', c.id); continue; }
            if (c.cmd === 'erase') c.ids = c.ids.filter(id => !objs.get(id) || objs.get(id).cmd.cmd !== 'ink');
            fixes++; turn.fixes = (turn.fixes || 0) + 1; enqueue({ cmd: c, run, turn }); continue;
          }
          if (turn.cmds >= limitsOf(turn).cmds) { dlog('over the per-answer command limit, skipped', it.cmd); continue; }
          const c = normalize(it); if (!c) { dlog('unknown or invalid command skipped', JSON.stringify(it).slice(0, 160)); continue; }
          if (c.cmd === 'write' && (turn.writes = (turn.writes || 0) + 1) > limitsOf(turn).writes) { dlog('too much writing: skipped', c.text); continue; }
          if (PICTURE.has(c.cmd)) turn.pics = (turn.pics || 0) + 1;
          turn.cmds++; enqueue({ cmd: c, run, turn });
        }
      }
    } else {
      jsonBuf = null;
      if (fix) return;
      const t = trimSay(line.replace(/^\s*(say:|assistant:)\s*/i, '').slice(0, 1200));
      enqueue({ say: t, turn, run, voice: Voice.enabled() ? Voice.prepare(t) : null });
    }
  };

  const res = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model, effort, session: lesson.session, messages }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error((j.error && j.error.message) || res.statusText), { code: (j.error && j.error.code) || 'http_' + res.status });
  }
  modelApplied = res.headers.get('X-Model');
  const reader = res.body.getReader(), dec = new TextDecoder();
  let sse = '', bytes = 0;
  const t0 = Date.now();
  dlog('stream start', model, effort || 'auto');
  for (;;) {
    // no bytes for 120 s means the model stalled (reasoning models still stream while thinking)
    let stallTimer;
    const stall = new Promise((_, rej) => { stallTimer = setTimeout(() => rej(Object.assign(new Error('The model stopped sending anything for 2 minutes.'), { code: 'stalled' })), window.__wbtStallMs || 120000); });
    let chunk;
    try { chunk = await Promise.race([reader.read(), stall]); }
    catch (e) { try { reader.cancel().catch(() => {}); } catch {} if (e.code === 'stalled') dlog('stream stalled after', bytes, 'bytes'); throw e; }
    finally { clearTimeout(stallTimer); }
    const { done, value } = chunk;
    if (done) { dlog('stream end', bytes, 'bytes in', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'finish', finish || '-'); break; }
    bytes += value.length;
    sse += dec.decode(value, { stream: true });
    let nl;
    while ((nl = sse.indexOf('\n')) >= 0) {
      const ln = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
      if (!ln.startsWith('data:')) continue;
      const data = ln.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw Object.assign(new Error(j.error.message || 'stream error'), { code: j.error.code || j.error.type || 'stream_error' });
      if (j.model) modelApplied = j.model;
      const ch = j.choices && j.choices[0]; if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const delta = ch.delta; if (!delta) continue;
      const rz = delta.reasoning_content || delta.reasoning;
      if (typeof rz === 'string' && rz) { reasoned += rz.length; onReasoning && onReasoning(rz.length); }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content; partial += delta.content;
        let k;
        while ((k = partial.indexOf('\n')) >= 0) { handleLine(partial.slice(0, k)); partial = partial.slice(k + 1); }
      }
    }
  }
  if (partial.trim()) handleLine(partial);
  if (jsonBuf) { const b = jsonBuf; jsonBuf = null; try { handleLine(b); } catch {} }
  if (!content.trim()) {
    throw Object.assign(new Error(''), { code: reasoned && (finish === 'length' || !finish) ? 'thinking_budget' : 'empty' });
  }
  return { content, model: modelApplied };
}

// ======================================================================
// model picker
// ======================================================================
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL = { auto: 'Auto', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };
function modelInfo(id) { return models.find(x => x.id === id); }
function modelName(id) { const m = modelInfo(id); return m ? m.name : id; }
function effortsOf(id) { const m = modelInfo(id); return m ? EFFORT_ORDER.filter(e => m.efforts.includes(e)).concat(m.efforts.filter(e => !EFFORT_ORDER.includes(e))) : []; }
// fastest sensible default: the lowest level that still reasons a little, else the lowest offered
function defaultEffort(id) {
  const ef = effortsOf(id);
  for (const e of ['low', 'minimal', 'none', 'medium']) if (ef.includes(e)) return e;
  return ef[0] || 'auto';
}
function currentEffort() {
  const id = settings.model, ef = effortsOf(id), saved = settings.efforts[id];
  if (saved === 'auto' || (saved && ef.includes(saved))) return saved;
  return defaultEffort(id);
}
function renderModelLabel() { const e = currentEffort(); $('#modelLabel').textContent = `${modelName(settings.model) || '…'} · ${EFFORT_LABEL[e] || e}`; }
function renderEffort() {
  const seg = $('#effortSeg'); seg.textContent = '';
  const ef = effortsOf(settings.model), cur = currentEffort();
  for (const e of ['auto', ...ef]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = EFFORT_LABEL[e] || e; b.dataset.e = e;
    b.classList.toggle('on', e === cur);
    b.onclick = () => { settings.efforts[settings.model] = e; saveSettings(); renderEffort(); renderModelLabel(); };
    seg.appendChild(b);
  }
  $('#effortNote').textContent = ef.length
    ? 'Lower reasoning starts drawing sooner. Auto = the model’s own default (often slow to start).'
    : 'This model has no adjustable reasoning level.';
}
async function loadModels() {
  try {
    const r = await fetch('/api/models'); const j = await r.json();
    models = j.models || [];
    if (!settings.model || !models.some(m => m.id === settings.model)) { settings.model = j.default || (models[0] && models[0].id); saveSettings(); }
    if (j.error) bubble({ role: 'error', text: `Could not list models (${j.error.code}): ${j.error.message}` });
  } catch { models = []; bubble({ role: 'error', text: 'Cannot reach the local server. Start it with `npm start`.' }); }
  const sel = $('#modelSelect'); sel.textContent = '';
  const groups = [['Featured', m => m.featured && !m.free], ['Free', m => m.free], ['All other models', m => !m.featured && !m.free]];
  for (const [label, test] of groups) {
    const list = models.filter(test).sort((a, b) => a.name.localeCompare(b.name)); if (!list.length) continue;
    const og = document.createElement('optgroup'); og.label = label;
    for (const m of list) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name}  (${m.id})`; og.appendChild(o); }
    sel.appendChild(og);
  }
  sel.value = settings.model || '';
  renderEffort(); renderModelLabel();
}
$('#tidyChk').onchange = e => { settings.tidy = e.target.checked; saveSettings(); };
$('#copyLogBtn').onclick = async () => {
  const info = [`Whiteboard Teacher debug log`, `browser: ${navigator.userAgent}`, `isolated: ${self.crossOriginIsolated}, cores: ${navigator.hardwareConcurrency}, webgpu: ${!!navigator.gpu}`,
    `model: ${settings.model} · ${currentEffort()} · voice: ${JSON.stringify(voiceCfg())} · voice status: ${JSON.stringify(Voice.status())} (${Voice.device() || '-'})`,
    `queue: ${queue.length} waiting, running=${queueRunning}, streaming=${streaming}, speaking=${Voice.speaking()}, audio: ${Voice.audioState()}, last voice used: ${Voice.source() || '-'}`, '', ...debugLog].join('\n');
  try { await navigator.clipboard.writeText(info); $('#copyLogBtn').textContent = 'Copied ✓'; }
  catch { const w = window.open('', '_blank'); if (w) { w.document.body.innerText = info; } }
  setTimeout(() => { $('#copyLogBtn').textContent = 'Copy debug log'; }, 2000);
};
$('#modelBtn').onclick = e => { e.stopPropagation(); $('#modelPop').hidden = !$('#modelPop').hidden; };
$('#modelSelect').onchange = e => { settings.model = e.target.value; saveSettings(); renderEffort(); renderModelLabel(); };
document.addEventListener('pointerdown', e => { if (!$('#modelPop').hidden && !e.target.closest('#modelPop') && !e.target.closest('#modelBtn')) $('#modelPop').hidden = true; });

// ======================================================================
// narration settings
// ======================================================================
function voiceCfg() { const v = settings.voice || (settings.voice = {}); return { mode: v.mode || 'off', voice: v.voice || 'af_bella', speed: v.speed || 1, engine: v.engine || (v.gpu ? 'webgpu' : 'server'), lastMode: v.lastMode || 'kokoro' }; }
function applyVoice() {
  const v = voiceCfg();
  Voice.configure({ mode: v.mode, voice: v.voice, speed: v.speed, engine: v.engine });
  $('#voiceMode').value = v.mode; $('#voiceName').value = v.voice; $('#voiceEngine').value = v.engine;
  $('#voiceSpeed').value = String(v.speed); $('#voiceSpeedVal').textContent = v.speed.toFixed(2) + '×';
  $('#kokoroRow').hidden = v.mode !== 'kokoro';
  $('#muteBtn').textContent = v.mode === 'off' ? '🔇' : '🔊';
  $('#muteBtn').setAttribute('aria-pressed', v.mode !== 'off');
  renderVoiceStatus(Voice.status());
}
function setVoice(patch) { settings.voice = { ...voiceCfg(), ...patch }; saveSettings(); applyVoice(); }
function renderVoiceStatus(st) {
  const v = voiceCfg(), bar = $('#voiceBar');
  const msg = v.mode !== 'kokoro' ? '' : st.state === 'loading' ? '🔊 ' + st.text : st.state === 'error' ? '🔊 ' + st.text + ' (using the browser voice instead)' : st.state === 'slow' ? '🐢 ' + st.text : st.state === 'info' ? 'ℹ️ ' + st.text : '';
  bar.textContent = msg; bar.hidden = !msg;
  $('#voiceStatus').textContent = Voice.describe();
}
Voice.onStatus(renderVoiceStatus);
(() => {
  const sel = $('#voiceName');
  for (const [id, label] of Voice.VOICES) { const o = document.createElement('option'); o.value = id; o.textContent = label; sel.appendChild(o); }
  $('#voiceMode').onchange = e => setVoice({ mode: e.target.value, lastMode: e.target.value === 'off' ? voiceCfg().lastMode : e.target.value });
  sel.onchange = e => setVoice({ voice: e.target.value });
  $('#voiceEngine').onchange = e => setVoice({ engine: e.target.value });
  $('#voicePreview').onclick = async () => {
    const b = $('#voicePreview'); Voice.unlock(); b.textContent = '… generating';
    try { const r = await Voice.preview(); b.textContent = '🔊 playing'; await r.done; } catch (e) { dlog('preview failed', String(e)); }
    b.textContent = '▶ Preview voice'; renderVoiceStatus(Voice.status());
  };
  $('#voiceSpeed').oninput = e => setVoice({ speed: Number(e.target.value) });
  $('#muteBtn').onclick = () => { const v = voiceCfg(); if (v.mode === 'off') setVoice({ mode: v.lastMode || 'kokoro' }); else { Voice.stop(); setVoice({ mode: 'off', lastMode: v.mode }); } };
  document.addEventListener('pointerdown', () => Voice.unlock(), { capture: true });
})();

// ======================================================================
// topic dialog
// ======================================================================
const dlg = $('#topicDlg');
let topicIsNew = false;
// New session: starts at once with a default name; the first question names it (see nameSession).
async function newSession() {
  if (lesson && !untouched()) { saveNow(); await saveToServer(); }
  stopAll(); if (scrub) exitScrub(); resetBoard(); chat = []; steps = []; updateTimeline();
  lesson = { topic: 'New session', autoName: true, plan: null, session: 'wbt-' + uuid() };
  sessionCreatedAt = new Date().toISOString();
  camera = { x: 0, y: 0, scale: defaultScale() }; fit(false);
  renderTitle(); renderChat(); input.focus();
}
$('#newBtn').onclick = () => newSession();
// Ask the selected model, in parallel with the answer, for a short title from the first question.
async function nameSession(q, model) {
  const L = lesson; if (!L || !L.autoName || L.naming) return;
  L.naming = true;
  try {
    const eff = defaultEffort(model);
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, effort: eff === 'auto' ? null : eff, session: L.session + '-title', messages: [
      { role: 'system', content: 'You name whiteboard lessons. Reply with only a short title of 2-5 words for a lesson that starts with the learner question below: the subject, in Title Case, in the language of the question, no quotes, no trailing punctuation.' },
      { role: 'user', content: q.slice(0, 800) }] }) });
    if (!res.ok || !res.body) throw new Error('http ' + res.status);
    const reader = res.body.getReader(), dec = new TextDecoder(); let sse = '', out = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      sse += dec.decode(value, { stream: true }); let nl;
      while ((nl = sse.indexOf('\n')) >= 0) {
        const ln = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
        if (!ln.startsWith('data:')) continue; const d = ln.slice(5).trim(); if (!d || d === '[DONE]') continue;
        try { const j = JSON.parse(d), c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (typeof c === 'string') out += c; } catch {}
      }
    }
    const title = (out.split('\n').map(x => x.trim()).find(Boolean) || '').replace(/^(title|name)\s*:\s*/i, '').replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, '').slice(0, 60);
    if (title && lesson === L && L.autoName) { L.topic = title; L.autoName = false; renderTitle(); saveSoon(); dlog('session named', JSON.stringify(title)); }
  } catch (e) { dlog('naming the session failed', String(e)); }
  L.naming = false;
}
function openTopic(forceNew = false) {
  topicIsNew = forceNew === true || !lesson;
  const L = topicIsNew ? null : lesson;
  $('#tTopic').value = L ? L.topic : '';
  $('#tCancel').hidden = false;
  $('#tOk').textContent = topicIsNew ? 'Start' : 'Rename';
  dlg.querySelector('h2').textContent = topicIsNew ? 'New session' : 'Rename session';
  dlg.showModal(); setTimeout(() => $('#tTopic').focus(), 30);
}
$('#topicBtn').onclick = () => openTopic(false);
$('#tCancel').onclick = () => dlg.close('cancel');
$('#topicBtn').title = 'Rename this session';
dlg.addEventListener('close', () => { if (!lesson && dlg.returnValue !== 'ok') setTimeout(openSessions, 0); });
$('#topicForm').addEventListener('submit', async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const topic = $('#tTopic').value.trim(); if (!topic) { e.preventDefault(); return; }
  const next = { topic: topic.slice(0, 120) };
  if (topicIsNew || !lesson) {
    // the current lesson is already auto-saved; start a fresh one
    if (lesson) { saveNow(); await saveToServer(); }
    stopAll(); if (scrub) exitScrub(); resetBoard(); chat = []; steps = []; updateTimeline();
    lesson = { ...next, plan: null, session: 'wbt-' + uuid() };
    sessionCreatedAt = new Date().toISOString();
    camera = { x: 0, y: 0, scale: defaultScale() }; fit(false);
  } else lesson = { ...lesson, ...next, autoName: false };   // renaming keeps the board and chat; a name you chose is never replaced
  renderTitle(); renderChat(); saveSoon();
});
function renderTitle() {
  const t = $('#titleText'); t.textContent = lesson ? lesson.topic : 'Whiteboard Teacher';
  document.title = lesson ? `${lesson.topic} — Whiteboard Teacher` : 'Whiteboard Teacher';
}

// ======================================================================
// boot
// ======================================================================
(async function boot() {
  try { await document.fonts.load('28px Caveat'); await document.fonts.ready; } catch {}
  camera.scale = defaultScale();
  applyCamera();
  const had = await loadAll();
  updateEmpty();
  $('#tidyChk').checked = settings.tidy !== false;
  applyVoice(); updateTimeline();
  renderTitle(); renderChat(); applyCamera();
  await loadModels();
  if (!had) newSession();
  // test hook (used by the automated check only)
  window.__wbt = { objs, camera: () => camera, execCommand: (raw, animate = true) => { const c = normalize(raw); return c && execCommand(c, { gen }, animate); }, selection, stopAll, send, lesson: () => lesson, steps: () => steps, scrub: () => scrub, showStep, stepBy, exitScrub };
})();
})();
