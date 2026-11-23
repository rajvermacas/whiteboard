/* Whiteboard Teacher — command normalisation, animation, camera, board operations and selection */
'use strict';
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
    case 'vector': {
      c.values = (Array.isArray(raw.values) ? raw.values : [raw.values ?? '']).slice(0, 16); c.label = label; c.highlight = (Array.isArray(raw.highlight) ? raw.highlight : raw.highlight != null ? [raw.highlight] : []).slice(0, 16).map(v => num(v, -1));
      // a row vector (one token's row, 1×N) lies across; a column vector stands up. Not given: a label that says 1×N
      // (more than one value) means a row, otherwise a column, as before
      const o = String(raw.orient || raw.orientation || '').toLowerCase();
      c.orient = /^(row|horizontal|h)$/.test(o) ? 'row' : /^(col|column|vertical|v)$/.test(o) ? 'column'
        : (c.values.length > 1 && /(^|[^\d.])1\s*[×x*]\s*\d+/.test(String(label || ''))) ? 'row' : 'column';
      break;
    }
    case 'matrix': {
      c.values = (Array.isArray(raw.values) ? raw.values : [[raw.values ?? '']]).slice(0, 10); c.rowLabels = Array.isArray(raw.rowLabels) ? raw.rowLabels.slice(0, 10) : null; c.colLabels = Array.isArray(raw.colLabels) ? raw.colLabels.slice(0, 10) : null; c.label = label;
      // the part of the matrix a sentence is about: whole rows, whole columns or single cells (0-based), tinted
      const h = raw.highlight && typeof raw.highlight === 'object' && !Array.isArray(raw.highlight) ? raw.highlight : {};
      const ints = v => (Array.isArray(v) ? v : v != null ? [v] : []).slice(0, 10).map(x => Math.round(num(x, -1, -1, 99))).filter(x => x >= 0);
      c.highlightRows = ints(raw.highlightRows ?? h.rows); c.highlightCols = ints(raw.highlightCols ?? h.cols);
      c.highlightCells = (Array.isArray(raw.highlightCells ?? h.cells) ? (raw.highlightCells ?? h.cells) : []).slice(0, 20)
        .filter(p => Array.isArray(p) && p.length >= 2).map(p => [Math.round(num(p[0], -1, -1, 99)), Math.round(num(p[1], -1, -1, 99))]).filter(p => p[0] >= 0 && p[1] >= 0);
      break;
    }
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
  drawSelection(); if (pops.length) placePops(); badgesSoon();
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
  const from = { ...camera }, tab = activeTab;
  const lerp = (a, b, t) => a + (b - a) * t;
  return tween(ms, t => {
    if (activeTab !== tab) return;   // another tab is on screen now: never move its camera
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
  o.g.remove(); objs.delete(id); selection.delete(id); badgesSoon();
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
  o.off = [dx, dy]; o.g.setAttribute('transform', `translate(${f1(dx)} ${f1(dy)})`); badgesSoon();
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
