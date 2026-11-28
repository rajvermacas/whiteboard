/* Whiteboard Teacher — front end
 * An infinite SVG whiteboard plus a side chat. The LLM (via the local /api/chat proxy to OpenCode Go)
 * answers in JSON Lines: {"say": "..."} lines go to the chat, {"cmd": "..."} lines draw on the board.
 * Generated content is never executed: numbers are clamped, text goes in via textContent, lists are capped.
 */
/* Whiteboard Teacher front end, split into plain scripts that share one global scope and load in order
 * (see index.html): base → shapes → board → input → popup → timeline → chat → teacher → settings.
 * Top-level code runs in that order; functions can be called from any file once the page has loaded. */
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
// a short name for an answer in the log: #id “its question”
const lab = t => t ? `#${String(t.key || '').slice(-4)} “${String(t.q || '').replace(/\s+/g, ' ').slice(0, 40)}”` : '-';
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

const svg = $('#board'), layerOv = $('#layerOverlay'), defs = svg.querySelector('defs'), grid = $('#grid');
// the board on screen: tabs.js swaps these (and camera, steps) when another tab is shown
let layerObj = $('#layerObjects');
// ↗ badges are drawn by tabs.js, which loads later: camera moves during page load call this before it exists
const badgesSoon = () => { if (window.renderBadges) window.renderBadges(); };
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

let lesson = null;             // {topic, audience, example, notes, source, plan, session}
let objs = new Map();          // id -> {cmd, g, bb, off:[dx,dy]} (of the tab on screen)
let camera = { x: -60, y: -60, scale: 1 };
let chat = [];                 // [{role:'user'|'assistant'|'error'|'system', text, about?, drew?, meta?}]
const selection = new Set();
const pops = [];   // "Ask whiteboard" popups: { el, key, ids, names, thread: [{q, a}], abort, at: [bx, by], min, unread }
let popZ = 10;
let settings = { model: null, efforts: {}, voice: { mode: 'kokoro', voice: 'af_heart', speed: 0.85, engine: 'server' } };
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
// Lesson speed: the lesson clock runs lessonRate× real time (J / K / L), so the pen, the pacing, the typing and the
// breaths between lines all speed up or slow down together. A faster lesson speeds the voice up too (Voice.setRate); a
// slower one keeps the voice at its natural pace, so the teacher talks normally and then draws and pauses longer.
let lessonRate = 1, rateAt = { real: 0, virt: 0 };
const LESSON_SPEED_MIN = 0.5, LESSON_SPEED_MAX = 2, LESSON_SPEED_STEP = 0.1;
const realClock = () => (pausedAt ?? performance.now()) - pausedTotal;
const clock = () => rateAt.virt + (realClock() - rateAt.real) * lessonRate;
function setClockRate(r) { rateAt = { real: realClock(), virt: clock() }; lessonRate = r; }
// wait ms of lesson time: stands still while paused, and follows a speed change made while waiting
function lsleep(ms) { const until = clock() + ms; return new Promise(res => { const tick = () => clock() >= until ? res() : setTimeout(tick, 30); tick(); }); }
const isPaused = () => pausedAt != null;
const whilePaused = () => pausedAt == null ? Promise.resolve() : new Promise(r => pauseWaiters.push(r));
let activeStreams = 0;          // answers whose model stream is open (a paused, set-aside answer may keep streaming)
const pendingHeld = new Set();  // answers asked in the background (double-click while teaching), not shown yet
let switchReq = null;          // hand over to a background answer at the next sentence boundary
const forks = [];               // answers set aside (a question asked while paused, or a look back), innermost last
let parked = null;              // forks' top {turn, abort, say}: the answer the teacher goes back to next
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
  const sentences = String(t).match(/[^.!?।]+[.!?।]+(\s|$)/g) || [];
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
// The page is going away (reload, close, navigation). Safari aborts the open fetches BEFORE pagehide, so a stream's error
// and tidy-up paths would run first and overwrite the good checkpoint (inflight.js) with a worse one. This is set as
// early as beforeunload; the send / continue / tidy-up / popup error paths, the non-closing checkpoint saves and the
// hand-over of waiting side answers check it. If the page stays after all (a download, a bfcache round trip) the flag
// is released and what was held back runs then (afterUnload), so nothing is left "Teaching…" forever.
let unloading = false, unloadTimer = 0; const unloadWaiters = [];
const afterUnload = () => new Promise(r => unloadWaiters.push(r));   // never resolves if the page really goes away
function unloadEnd() {
  unloading = false; clearTimeout(unloadTimer);
  unloadWaiters.splice(0).forEach(f => f());
  if (typeof pendingHeld !== 'undefined') for (const t of pendingHeld) if (t.held && t.held.length) requestRelease(t);   // hand-overs held back meanwhile
}
window.addEventListener('beforeunload', () => { unloading = true; clearTimeout(unloadTimer); unloadTimer = setTimeout(unloadEnd, 5000); });
window.addEventListener('pagehide', () => { unloading = true; });
window.addEventListener('pageshow', () => { if (unloading) unloadEnd(); });
