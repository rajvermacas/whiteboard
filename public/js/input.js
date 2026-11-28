/* Whiteboard Teacher — pointer, wheel and keyboard on the board */
'use strict';
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
  // a right-click (or Ctrl+click on a Mac) opens the drawing's menu: it must not select, pan or draw
  if (e.button === 2 || (e.button === 0 && e.ctrlKey && IS_MAC)) return;
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
// the board on screen is about to change (another tab): drop whatever the pointer is doing, so it can never apply
// to the other board; a drag in progress snaps back on its own board, an unfinished stroke is discarded
function cancelGesture() {
  if (gesture && gesture.mode === 'drag' && gesture.dragIds) gesture.dragIds.forEach(id => { if (objs.has(id)) { setOffset(id, 0, 0); rebuildDependents(id); } });
  inkPreview.setAttribute('d', ''); svg.classList.remove('panning', 'dragging');
  gesture = null; lastTap = null; pointers.clear();
}
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
    // a double-tap on a touch screen (a mouse's double-click is the browser's dblclick below, which follows the
    // system's double-click speed)
    if (e.pointerType === 'touch') {
      const now = Date.now(), lt = lastTap;
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      if (lt && now - lt.t < 400 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 24) {
        lastTap = null; gesture = null; touchDouble = now; doubleTap(id, e); return;
      }
    }
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
  // ⌘ + scroll zooms the other way round from before (asked for): with the Mac's natural scrolling, moving the fingers
  // or wheel down (deltaY < 0) zooms out and up zooms in. A trackpad pinch (it arrives as ctrl + wheel) and Ctrl +
  // scroll are unchanged: pinching out zooms in
  if (e.metaKey) zoomAt(Math.exp(clamp(dy, -120, 120) * 0.013), e.clientX, e.clientY);
  else if (e.ctrlKey) zoomAt(Math.exp(-clamp(dy, -120, 120) * 0.013), e.clientX, e.clientY);
  else {
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    camera.x += dx / camera.scale; camera.y += dy / camera.scale; applyCamera();
  }
}, { passive: false });
// Safari trackpad pinch
let gScale = 1;
svg.addEventListener('gesturestart', e => { e.preventDefault(); gScale = 1; });
svg.addEventListener('gesturechange', e => { e.preventDefault(); lastUserCamera = Date.now(); zoomAt(Math.pow(e.scale / gScale, 2.2), e.clientX, e.clientY); gScale = e.scale; });
let lastTap = null, touchDouble = 0;
// double-click a drawing: the teacher opens it up; on the empty board: zoom
function doubleTap(id, e) {
  if (id && !penMode && objs.has(id)) drillInto(id); else if (!penMode) zoomTap(e.clientX, e.clientY, e.shiftKey);
}
svg.addEventListener('dblclick', e => {
  e.preventDefault();
  if (e.button !== 0 || e.ctrlKey || e.metaKey || Date.now() - touchDouble < 700) return;   // a touch double-tap was already taken (some browsers add a dblclick after it)
  doubleTap(hitTest(e.clientX, e.clientY), e);
});
// Open a drawing up: its exact internal structure (real shapes, numbers, the computation inside it), built next to it.
// While the teacher is answering this forks the answer, like a question asked while paused; it continues afterwards.
const drillQuestion = n => `Open up “${n}”: show exactly what is inside it, with real shapes and numbers (the actual vectors, matrices, tables or data structures) and the computation it does, step by step${MCP_MODE ? ', right next to it' : ''}.`;
function drillInto(id) {
  dlog('user: double-click', JSON.stringify(nameOf(id)), '· state:', scrub ? 'looking back at step ' + (scrub.i + 1) : isPaused() ? 'paused' : liveBusy() ? 'teaching' : 'idle', '· live:', lab(liveTurn));
  setSelection([id]);
  const q = drillQuestion(nameOf(id));
  const name = nameOf(id), topic = `what is inside “${name}”`;
  // the lesson is running: ask in the background and keep teaching; switch over once the answer is actually coming
  // (also while paused: it is answered in the background and takes over once the lesson is playing again)
  // looking back at an earlier step: the board stays on that step; it is answered in the background and plays once
  // the learner is back on the live board (releaseHeld waits while looking back)
  if (scrub || liveBusy() || (isPaused() && liveTurn)) send(q, { parallel: true, topic, pulse: pulseObj(id), intro: `Since you double-clicked “${name}”, here is what is inside it.`, newTab: { tab: activeTab, obj: id } });
  else send(q, { topic, newTab: { tab: activeTab, obj: id } });
}
// instant feedback that a double-click was taken: a pulsing ring around the drawing until its answer takes over
function pulseObj(id) {
  const o = objs.get(id); if (!o) return null;
  const b = bbOf(o), p = 12 / camera.scale;
  return el('rect', { 'data-tab': activeTab, class: 'drillPulse', x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p, rx: 8 / camera.scale, fill: 'none', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, layerOv);
}
function zoomTap(px, py, out) {
  lastUserCamera = Date.now();
  const r = svg.getBoundingClientRect(), f = out ? 1 / 3 : 3, sx = px - r.left, sy = py - r.top;
  const bx = camera.x + sx / camera.scale, by = camera.y + sy / camera.scale, s = clamp(camera.scale * f, 0.05, 12);
  animateCamera({ scale: s, x: bx - sx / s, y: by - sy / s }, 260);
}
