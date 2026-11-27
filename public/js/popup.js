/* Whiteboard Teacher — right-click → Ask whiteboard popups (quick Q&A, hand-off to the teacher) */
'use strict';
// ======================================================================
// right-click a drawing → "Ask whiteboard": a small popup for quick Q&A about it (one drawing or the selection).
// It only talks: nothing is drawn, said aloud, added to the chat or saved, and the lesson carries on untouched.
// Each popup stays until its ✕: clicking elsewhere (or Esc) folds it into a small pill that stays by its drawings,
// moving with the board; click the pill to open it again. A new session closes them all.
// ======================================================================
const ctxMenu = document.createElement('div'); ctxMenu.id = 'ctxMenu'; ctxMenu.hidden = true; ctxMenu.setAttribute('role', 'menu');
$('#boardWrap').append(ctxMenu);

svg.addEventListener('contextmenu', e => {
  if (penMode) { hideCtxMenu(); return; }
  e.preventDefault();
  const id = hitTest(e.clientX, e.clientY), onDrawing = !!id && objs.has(id);
  // right-clicking one of several selected drawings asks about them all; otherwise just this one;
  // right-clicking empty board asks about the whole board (everything on it, not one drawing)
  const ids = !onDrawing ? [] : selection.has(id) && selection.size > 1 ? [...selection].filter(x => objs.has(x)) : [id];
  if (ids.length === 1 && !selection.has(id)) setSelection([id]);
  const names = ids.map(nameOf);
  const at = boardPoint(e.clientX, e.clientY);
  ctxMenu.innerHTML = '';
  const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
  b.innerHTML = `<span>💬 Ask whiteboard</span><small></small>`;
  b.querySelector('small').textContent = !ids.length ? 'about the whole board' : ids.length > 1 ? `about ${ids.length} drawings` : `about “${names[0]}”`;
  b.onclick = () => { hideCtxMenu(); openAskPop(ids, ids.length ? null : at); };
  ctxMenu.appendChild(b);
  const r = $('#boardWrap').getBoundingClientRect();
  ctxMenu.hidden = false;
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left = clamp(e.clientX - r.left, 6, r.width - w - 6) + 'px';
  ctxMenu.style.top = clamp(e.clientY - r.top, 6, r.height - h - 6) + 'px';
  b.focus({ preventScroll: true });
  dlog('user: right-click', ids.length ? ids.map(x => JSON.stringify(nameOf(x))).join(', ') : 'empty board');
});
// a screen point as a board position
function boardPoint(cx, cy) {
  const sv = svg.getBoundingClientRect();
  return [camera.x + (cx - sv.left) / camera.scale, camera.y + (cy - sv.top) / camera.scale];
}
function hideCtxMenu() { ctxMenu.hidden = true; }
// a click anywhere outside a popup folds it (it never closes by itself)
document.addEventListener('pointerdown', e => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideCtxMenu();
  for (const p of pops) if (!p.min && !p.el.contains(e.target)) minimisePop(p);
}, true);

// ids: the drawings it is about; none = the whole board (one such popup per tab, opened at `at`, a board position)
function openAskPop(ids, at) {
  const board = !ids.length;
  const key = activeTab + ':' + (board ? '*board*' : [...ids].sort().join(','));   // ids are per tab
  const had = pops.find(p => p.key === key);
  if (had) { expandPop(had); return; }
  const names = ids.map(nameOf);
  const el = document.createElement('div'); el.className = 'askPop'; el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="apHead"><button type="button" class="apTitle"></button><button type="button" class="apMin" title="Minimise (Esc)" aria-label="Minimise">–</button><button type="button" class="apX" title="Close" aria-label="Close">✕</button></div>
<div class="apLog" aria-live="polite" hidden></div>
<form class="apForm"><textarea rows="1" placeholder="Ask a quick question…" aria-label="Your question"></textarea><button type="submit" class="apSend" title="Ask (↵)" aria-label="Ask">➤</button></form>`;
  const p = { el, key, ids, names, board, thread: [], abort: null, at: [0, 0], min: false, unread: false, tab: activeTab };
  const title = el.querySelector('.apTitle');
  title.textContent = board ? '💬 The whole board' : ids.length > 1 ? `💬 ${ids.length} drawings: ${names.map(n => `“${n}”`).join(', ')}` : `💬 “${names[0]}”`;
  title.title = board ? 'Ask about everything on this board' : 'Ask about ' + names.join(', ');
  if (board) { el.classList.add('board'); el.querySelector('textarea').placeholder = 'Ask about anything on the board…'; }
  title.onclick = () => p.min ? expandPop(p) : minimisePop(p);
  el.querySelector('.apMin').onclick = () => minimisePop(p, true);
  el.querySelector('.apX').onclick = () => closePop(p);
  const input = el.querySelector('textarea');
  // border-box: the height has to include the border, or the text is cut and scrolls
  const fit = () => { input.style.height = ''; const h = Math.min(input.scrollHeight + 2, 120); input.style.height = Math.max(36, h) + 'px'; input.style.overflowY = input.scrollHeight + 2 > 120 ? 'auto' : 'hidden'; };
  input.addEventListener('input', fit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.querySelector('.apForm').requestSubmit(); } });
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); minimisePop(p, true); } });
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++popZ; });
  el.querySelector('.apForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim(); if (!q || p.abort) return;
    input.value = ''; fit(); askQuick(p, q);
  });
  $('#boardWrap').appendChild(el); pops.push(p);
  el.style.zIndex = ++popZ;
  if (board) { p.at = at || boardPoint(...popSpot($('#boardWrap'))); placePop(p); } else anchorPop(p);
  input.focus({ preventScroll: true });
  dlog('ask popup: open about', board ? 'the whole board' : names.map(n => JSON.stringify(n)).join(', '), '·', pops.length, 'popup(s)');
}
// where it opens: next to the drawings (right if there is room, else left, else below); kept as a board position
function anchorPop(p) {
  const wrap = $('#boardWrap').getBoundingClientRect(), sv = svg.getBoundingClientRect();
  const bs = p.ids.filter(id => objs.has(id)).map(id => bbOf(objs.get(id)));
  const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y)), x1 = Math.max(...bs.map(b => b.x + b.width)), y1 = Math.max(...bs.map(b => b.y + b.height));
  const toX = bx => sv.left - wrap.left + (bx - camera.x) * camera.scale, toY = by => sv.top - wrap.top + (by - camera.y) * camera.scale;
  const L = toX(x0), R = toX(x1), T = toY(y0), B = toY(y1), w = p.el.offsetWidth, h = Math.max(p.el.offsetHeight, 180), gap = 14;
  const below = !(R + gap <= wrap.width - w - 8) && !(L - gap - w >= 8);
  const left = clamp(below ? (L + R) / 2 - w / 2 : R + gap <= wrap.width - w - 8 ? R + gap : L - gap - w, 8, Math.max(8, wrap.width - w - 8));
  const top = clamp(below ? B + gap : T, 8, Math.max(8, wrap.height - h - 8));
  p.at = [camera.x + (left - (sv.left - wrap.left)) / camera.scale, camera.y + (top - (sv.top - wrap.top)) / camera.scale];
  placePop(p);
}
// on screen at its board position (it moves with the board), but never lost off the edge
function placePop(p) {
  const wrap = $('#boardWrap').getBoundingClientRect(), sv = svg.getBoundingClientRect();
  const x = sv.left - wrap.left + (p.at[0] - camera.x) * camera.scale, y = sv.top - wrap.top + (p.at[1] - camera.y) * camera.scale;
  const w = p.el.offsetWidth, h = p.el.offsetHeight;
  p.el.style.left = clamp(x, 6, Math.max(6, wrap.width - w - 6)) + 'px';
  p.el.style.top = clamp(y, 6, Math.max(6, wrap.height - h - 6)) + 'px';
}
const popSpot = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 3, r.top + r.height / 4]; };
function placePops() { for (const p of pops) placePop(p); }
function minimisePop(p, focusBoard) {
  if (p.min) return;
  p.min = true; p.el.classList.add('min'); placePop(p);
  if (focusBoard) $('#boardWrap').focus({ preventScroll: true });
  dlog('ask popup: minimised', p.board ? 'whole board' : JSON.stringify(p.names.join(', ')));
}
function expandPop(p) {
  p.min = false; p.unread = false; p.el.classList.remove('min', 'unread'); p.el.style.zIndex = ++popZ;
  placePop(p);
  const log = p.el.querySelector('.apLog'); log.scrollTop = log.scrollHeight;
  p.el.querySelector('textarea').focus({ preventScroll: true });
}
function closePop(p) {
  if (p.abort) p.abort.abort();
  p.el.remove(); pops.splice(pops.indexOf(p), 1);
  dlog('ask popup: closed after', p.thread.length, 'question(s)');
  $('#boardWrap').focus({ preventScroll: true });
}
function closeAllPops() { while (pops.length) { const p = pops.pop(); if (p.abort) p.abort.abort(); p.el.remove(); } }

// what the model gets: the drawings themselves, what touches or sits around them, what the teacher said while
// drawing them, the lesson and the last few chat messages, then this popup's own thread
function askContext(ids) {
  const set = new Set(ids), lines = [];
  lines.push(`Lesson: ${lesson ? lesson.topic : ''}`);
  lines.push(`\nTHE DRAWING${ids.length > 1 ? 'S' : ''} THE LEARNER IS ASKING ABOUT:`);
  ids.forEach(id => lines.push('- ' + objLine(objs.get(id), true)));
  // connected: arrows to or from them, frames, braces and highlights on them, and what those arrows point at
  const linked = new Set();
  for (const [id, o] of objs) {
    if (set.has(id)) continue; const c = o.cmd;
    const touches = (c.cmd === 'arrow' && (set.has(c.from) || set.has(c.to))) || ((c.cmd === 'frame' || c.cmd === 'brace') && c.around.some(x => set.has(x))) || (c.cmd === 'highlight' && set.has(c.target)) || (c.cmd === 'flow' && set.has(c.on));
    if (touches) { linked.add(id); if (c.cmd === 'arrow') [c.from, c.to].forEach(x => typeof x === 'string' && objs.has(x) && !set.has(x) && linked.add(x)); }
  }
  ids.forEach(id => { const c = objs.get(id).cmd; if (c.cmd === 'arrow') [c.from, c.to].forEach(x => typeof x === 'string' && objs.has(x) && !set.has(x) && linked.add(x)); if (c.around) c.around.forEach(x => objs.has(x) && !set.has(x) && linked.add(x)); if (c.target && objs.has(c.target) && !set.has(c.target)) linked.add(c.target); });
  if (linked.size) { lines.push('\nCONNECTED TO THEM:'); [...linked].slice(0, 20).forEach(id => lines.push('- ' + objLine(objs.get(id)))); }
  // nearby: the closest other drawings around them
  const bs = ids.map(id => bbOf(objs.get(id))), cx = b => b.x + b.width / 2, cy = b => b.y + b.height / 2;
  const dist = b => Math.min(...bs.map(a => Math.max(0, Math.abs(cx(a) - cx(b)) - (a.width + b.width) / 2) + Math.max(0, Math.abs(cy(a) - cy(b)) - (a.height + b.height) / 2)));
  const near = [...objs.entries()].filter(([id]) => !set.has(id) && !linked.has(id)).map(([id, o]) => [id, dist(bbOf(o))]).filter(([, d]) => d < 260).sort((a, b) => a[1] - b[1]).slice(0, 12);
  if (near.length) { lines.push('\nNEARBY ON THE BOARD:'); near.forEach(([id]) => lines.push('- ' + objLine(objs.get(id)))); }
  // what the teacher was saying when they were drawn (the step that drew each one, and the one before it)
  const said = [];
  steps.forEach((st, i) => {
    if (st.by !== 'teacher' || !st.cmds.some(c => set.has(c.id) || (c.ids && c.ids.some(x => set.has(x))))) return;
    for (let j = Math.max(0, i - 1); j <= i; j++) { const s = steps[j]; if (s.by === 'teacher' && s.say && !said.includes(s.say)) said.push(s.say); }
  });
  if (said.length) { lines.push('\nWHAT THE TEACHER SAID WHILE DRAWING THEM:'); said.slice(-8).forEach(s => lines.push('- ' + clip(s, 300))); }
  const recent = chat.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text).slice(-4);
  if (recent.length) { lines.push('\nTHE LESSON CHAT, LATEST MESSAGES:'); recent.forEach(m => lines.push(`${m.role === 'user' ? 'Learner' : 'Teacher'}: ${clip(m.text, 500)}`)); }
  lines.push('\nTHE WHOLE BOARD, FOR REFERENCE:\n' + boardSummary());
  return lines.join('\n');
}
// the whole board: every drawing (in full), what the teacher said through the lesson, and the chat
function boardAskContext() {
  const lines = [`Lesson: ${lesson ? lesson.topic : ''}`];
  const list = [...objs.values()];
  if (!list.length) lines.push('\nTHE BOARD IS EMPTY.');
  else {
    lines.push(`\nEVERYTHING ON THE BOARD (${list.length} drawing${list.length > 1 ? 's' : ''}${list.length > 150 ? ', last 150 shown' : ''}), in the order drawn:`);
    list.slice(-150).forEach(o => lines.push('- ' + objLine(o, true)));
  }
  const said = steps.filter(s => s.by === 'teacher' && s.say).map(s => s.say);
  if (said.length) { lines.push(`\nWHAT THE TEACHER SAID WHILE DRAWING IT, IN ORDER${said.length > 60 ? ' (latest 60)' : ''}:`); said.slice(-60).forEach(s => lines.push('- ' + clip(s, 300))); }
  const recent = chat.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text).slice(-8);
  if (recent.length) { lines.push('\nTHE LESSON CHAT, LATEST MESSAGES:'); recent.forEach(m => lines.push(`${m.role === 'user' ? 'Learner' : 'Teacher'}: ${clip(m.text, 500)}`)); }
  const sel = [...selection].filter(id => objs.has(id));
  if (sel.length) lines.push('\nSELECTED RIGHT NOW (only a hint; the question is about the whole board): ' + sel.map(id => `${id} (${nameOf(id)})`).join(', '));
  lines.push('\nLAYOUT:\n' + boardSummary().split('\n').filter(l => !l.startsWith('- ') && !l.startsWith('Objects on the board')).join('\n'));
  return lines.join('\n');
}
const BOARD_ASK_SYSTEM = `You answer a learner's quick question about a teaching whiteboard as a whole, in a small popup they opened on an empty part of the board. Everything drawn on the board, what the teacher said while drawing it and the latest chat are given below. The question can be about any of it: the big picture, how the parts connect, what to look at first, a summary, or any one drawing; refer to the drawings by their own names, numbers and labels so the learner can find them.
Answer short and direct: usually 2 to 6 sentences, a short list only when it truly helps (for example a walk through the parts in order). Lead with the answer itself, no preamble, no restating the question. Use Markdown where it helps (**bold** for the key term, short - lists); no tables or images. For maths use inline LaTeX between single dollar signs, like $W_1 x + b$.
You cannot draw here, but the teacher can. When the learner asks for a drawing, diagram, picture, visual or worked explanation on the board (for example "draw it", "show me with a diagram", "explain it on the board", "visualise this"), do not answer it yourself: hand it to the teacher by replying with exactly one JSON line and nothing else:
{"handoff":"<the question for the teacher, as the learner asking it in the first person (\"Draw …\", \"Show me …\"), written to stand on its own: name the drawings it is about and what the learner wants explained or drawn, including anything from this popup's thread it depends on>","note":"<one short sentence to the learner saying what the teacher will draw>"}
Write both in the language of the learner's question. Hand off only when the learner asks for something to be drawn or shown on the board. Otherwise answer in text, never write drawing commands or board code, and if the question really needs a full drawn explanation, give the short answer and add one line saying they can ask "draw it" here to have the teacher draw it.
If the board is empty, say so briefly and answer from the lesson and chat if you can. Follow-up questions in this popup continue the same thread. Answer in the language of the learner's question.`;
const ASK_SYSTEM = `You answer a learner's quick question about one or more drawings on a teaching whiteboard, in a small popup next to them. The drawings, what they connect to, what is near them and what the teacher said while drawing them are given below; use them to know exactly what the learner is pointing at, and use the drawing's own names, numbers and labels.
Answer short and direct: usually 2 to 5 sentences, a short list only when it truly helps. Lead with the answer itself, no preamble, no restating the question. Use Markdown where it helps (**bold** for the key term, short - lists); no tables or images. For maths use inline LaTeX between single dollar signs, like $W_1 x + b$.
You cannot draw here, but the teacher can. When the learner asks for a drawing, diagram, picture, visual or worked explanation on the board (for example "draw it", "show me with a diagram", "explain it on the board", "visualise this"), do not answer it yourself: hand it to the teacher by replying with exactly one JSON line and nothing else:
{"handoff":"<the question for the teacher, as the learner asking it in the first person (\"Draw …\", \"Show me …\"), written to stand on its own: name the drawings and what the learner wants explained or drawn, including anything from this popup's thread it depends on>","note":"<one short sentence to the learner saying what the teacher will draw>"}
Write both in the language of the learner's question. Hand off only when the learner asks for something to be drawn or shown on the board. Otherwise answer in text, never write drawing commands or board code, and if the question really needs a full drawn explanation, give the short answer and add one line saying they can ask "draw it" here to have the teacher draw it.
Follow-up questions in this popup continue the same thread about the same drawings. Answer in the language of the learner's question.`;

// the popup model's hand-off: {"handoff": "...", "note": "..."} (optionally in a code fence); null when it answered
function parseHandoff(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!t.startsWith('{')) return null;
  try { const j = JSON.parse(t); return j && typeof j.handoff === 'string' && j.handoff.trim() ? { q: clip(j.handoff, 600), note: clip(j.note || '', 200) } : null; } catch { return null; }
}
// a hand-off looks like JSON from its first characters: hold painting until it is clear which it is
const maybeHandoff = text => /^\s*(```(json)?\s*)?\{/i.test(text) || /^\s*`{1,3}$/.test(text);
// the popup hands the question to the teacher: the same path as Enter in the chat, so while the teacher teaches it
// is answered on the side (asked now, comes in at the next sentence, "You asked…", then back to the lesson), when
// paused it plays as soon as it is ready, and when idle it is a normal answer. The popup's drawings go with it as the selection.
function handToTeacher(p, item, h, ad, ids) {
  // in opencode mode opencode's model draws on this board; the app's own teacher is not running
  const viaOpencode = MCP_MODE;
  const r = viaOpencode ? null : askRoute('fork');
  item.a = viaOpencode ? `(Asked to draw it; in opencode mode the learner has to ask opencode: ${h.q})` : `(Handed to the teacher to draw on the board: ${h.q})`;
  ad.classList.remove('thinking'); ad.classList.add('handoff'); ad.textContent = '';
  const head = document.createElement('div'); head.className = 'apHandHead';
  head.textContent = viaOpencode ? '✎ This board is drawn by opencode: ask it there to draw this.'
    : r.how === 'side' && r.waitsForPlay ? `✎ Sent to the teacher as a side question${r.back ? ' (back to the live board)' : ''}: the lesson stays paused and the answer plays as soon as it is ready (▶ carries on meanwhile).`
    : r.how === 'side' ? `✎ Sent to the teacher as a side question${r.back ? ' (back to the live board)' : ''}: it comes in after the current sentence.`
    : '✎ Sent to the teacher: drawing it on the board now.';
  ad.appendChild(head);
  if (h.note) { const n = document.createElement('div'); n.className = 'apHandNote'; n.textContent = h.note; ad.appendChild(n); }
  const qd = document.createElement('div'); qd.className = 'apHandQ'; qd.textContent = '“' + h.q + '”'; ad.appendChild(qd);
  if (viaOpencode) { dlog('ask popup: hand-off not sent (opencode mode)', JSON.stringify(clip(h.q, 120))); return; }
  dlog('ask popup: handed to the teacher', JSON.stringify(clip(h.q, 120)), '· route', r.how, r.waitsForPlay ? '(paused until it is ready)' : '', '· about', p.board ? 'the whole board' : ids.join(','));
  // about the whole board: drawn on this board (no drawing to open a tab from); about drawings: in their own tab
  if (p.board) ask(h.q, 'fork', { ids: [], via: 'popup' });
  else ask(h.q, 'fork', { ids, via: 'popup', newTab: { tab: p.tab, obj: ids[0] } });
}

async function askQuick(p, q) {
  const log = p.el.querySelector('.apLog'), send = p.el.querySelector('.apSend');
  const note = text => { log.hidden = false; const d = document.createElement('div'); d.className = 'apA err'; d.textContent = text; log.appendChild(d); };
  const ids = p.ids.filter(id => objs.has(id));
  if (!p.board && !ids.length) { note('Those drawings are no longer on the board.'); return; }
  const item = { q, a: '' }; p.thread.push(item);
  log.hidden = false;
  const qd = document.createElement('div'); qd.className = 'apQ'; qd.textContent = q; log.appendChild(qd);
  const ad = document.createElement('div'); ad.className = 'apA thinking'; ad.innerHTML = '<span class="apDots">thinking<i>.</i><i>.</i><i>.</i></span>'; log.appendChild(ad);
  log.scrollTop = log.scrollHeight; placePop(p);
  const ac = p.abort = new AbortController(); send.disabled = true; p.el.classList.add('busy');
  const model = settings.model || (models[0] && models[0].id), eff = currentEffort();
  const messages = [{ role: 'system', content: p.board ? BOARD_ASK_SYSTEM + '\n\n' + boardAskContext() : ASK_SYSTEM + '\n\n' + askContext(ids) }];
  p.thread.slice(0, -1).forEach(t => { messages.push({ role: 'user', content: t.q }); messages.push({ role: 'assistant', content: t.a || '(no answer)' }); });
  messages.push({ role: 'user', content: q });
  dlog('ask popup: asking', JSON.stringify(clip(q, 120)), '· about', p.board ? 'the whole board' : ids.join(','), '· model', model, eff, '· follow-up', p.thread.length - 1);
  const t0 = performance.now();
  let painted = 0;
  const paint = () => { if (maybeHandoff(item.a)) return; painted = item.a.length; ad.classList.remove('thinking'); ad.innerHTML = mdToHtml(item.a); const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40; if (nearEnd) log.scrollTop = log.scrollHeight; };
  try {
    await streamText(model, eff === 'auto' ? null : eff, (lesson ? lesson.session : 'wbt') + '-ask', messages, ac.signal, delta => {
      item.a += delta; if (item.a.length - painted > 6 || /[\s$.*]$/.test(delta)) paint();
    });
    const h = parseHandoff(item.a);
    if (h) handToTeacher(p, item, h, ad, ids);
    else if (!item.a.trim()) { item.a = ''; ad.classList.remove('thinking'); ad.classList.add('err'); ad.textContent = 'No answer came back. Try asking again.'; }
    else { if (maybeHandoff(item.a)) { painted = item.a.length; ad.classList.remove('thinking'); ad.innerHTML = mdToHtml(item.a); } else paint(); }
    dlog('ask popup: answered in', Math.round(performance.now() - t0), 'ms,', item.a.length, 'chars');
  } catch (e) {
    if (ac.signal.aborted) return;
    ad.classList.remove('thinking'); ad.classList.add('err'); ad.textContent = 'Could not answer: ' + (e.message || e);
    dlog('ask popup: failed', String(e.message || e));
  } finally {
    if (p.abort === ac) { p.abort = null; send.disabled = false; p.el.classList.remove('busy'); }
    if (pops.includes(p)) { if (p.min) { p.unread = true; p.el.classList.add('unread'); } else p.el.querySelector('textarea').focus({ preventScroll: true }); }
  }
}
// a small, safe Markdown renderer for the popup: **bold**, *italic*, `code`, ``` blocks, # headings, - / 1. lists,
// [links](https://…) and $…$ / $$…$$ maths (KaTeX). Everything is escaped first, so no HTML from the model gets in.
function mdToHtml(src) {
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const keep = [];   // code and maths, kept out of the Markdown rules and put back at the end
  const hold = html => '\u0000' + (keep.push(html) - 1) + '\u0000';
  const tex = (t, display) => { if (!window.katex) return esc(display ? `$$${t}$$` : `$${t}$`); try { return window.katex.renderToString(t, { throwOnError: false, displayMode: display }); } catch { return esc(t); } };
  let s = String(src || '').replace(/\r/g, '');
  s = s.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (m, code) => '\n' + hold(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`) + '\n');
  s = s.replace(/`([^`\n]+)`/g, (m, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\$\$([^$]+)\$\$/g, (m, t) => hold(tex(t, true))).replace(/\$([^$\n]+)\$/g, (m, t) => hold(tex(t, false)));
  const inline = t => esc(t)
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*|__(?=\S)([^_]*?\S)__/g, (m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = []; let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const line of s.split('\n')) {
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^\u0000\d+\u0000$/.test(line.trim()) && /^<pre/.test(keep[+line.trim().slice(1, -1)])) { flushPara(); flushList(); out.push(line.trim()); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<h4>${inline(m[2])}</h4>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((m = /^\s*(?:[-*+•])\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      flushPara(); if (list && list.tag !== tag) flushList(); if (!list) list = { tag, items: [] };
      list.items.push(m[1]); continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]);
}
// a streamed answer from /api/chat, handing each piece of text to onDelta (thinking is not shown)
async function streamText(model, effort, session, messages, signal, onDelta) {
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model, effort, session, messages }) });
  if (!res.ok || !res.body) { let msg = 'HTTP ' + res.status; try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch {} throw new Error(msg); }
  const reader = res.body.getReader(), dec = new TextDecoder(); let sse = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    sse += dec.decode(value, { stream: true }); let nl;
    while ((nl = sse.indexOf('\n')) >= 0) {
      const ln = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
      if (!ln.startsWith('data:')) continue; const d = ln.slice(5).trim(); if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'stream error');
      const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (typeof c === 'string' && c) onDelta(c);
    }
  }
}

// the shortcuts card (⌨ in the top bar, or ?): one list, so the card and the keys below stay in step
const KEYS = [
  ['Lesson', [['Play / pause', ['Space'], ['S']], ['Previous step', ['←'], ['A']], ['Next step', ['→'], ['D']]]],
  ['Board', [['Draw on the board yourself (on / off)', ['W']], ['Zoom to fit everything', ['T']], ['Full screen', ['F']], ['Erase the selected drawing', ['Delete']], ['Clear the selection', ['Esc']]]],
  ['Session', [['New session', ['N']], ['Open sessions', ['O']], ['Rename this session', ['R']], ['Jump to the chat box', ['Tab']], ['Back to the board from chat', ['Esc']]]],
  ['Mouse', [['Pan', ['Scroll']], ['Zoom', [/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl', 'Scroll']], ['Explain what is inside a drawing', ['Double-click']], ['Ask about a drawing, or the whole board', ['Right-click']]]],
  ['Help', [['Show these shortcuts', ['?']]]],
];
function openKeys() {
  const kbd = ks => ks.map(k => /^(Scroll|Double-click|Right-click)$/.test(k) ? `<span class="kMouse">${k}</span>` : `<kbd>${k}</kbd>`).join('<span>+</span>');
  $('#keysList').innerHTML = KEYS.map(([g, rows]) => `<section class="kGroup"><h3>${g}</h3>${rows.map(([what, a, b]) =>
    `<div class="kRow"><span>${what}</span><span class="kKeys">${kbd(a)}${b ? `<span>or</span>${kbd(b)}` : ''}</span></div>`).join('')}</section>`).join('');
  if (!$('#keysDlg').open) { $('#keysDlg').showModal(); $('#keysDlg .keysWrap').focus({ preventScroll: true }); }
  dlog('user: shortcuts card');
}
$('#keysBtn').onclick = openKeys;
$('#keysClose').onclick = () => $('#keysDlg').close();
$('#keysDlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });   // a click on the backdrop closes it
$('#keysDlg').addEventListener('close', () => focusBoard());

document.addEventListener('keydown', e => {
  // the shortcuts work everywhere except where text is typed (the chat box, the popup, the model search, dialogs' fields);
  // a focused button, checkbox or slider does not count, so clicking ⛶ or ✏️ Draw leaves Space, A/S/D, F, N, O, R, T, W and the arrows working
  const ae = document.activeElement, tag = ae && ae.tagName;
  const typing = !!ae && (tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable || (tag === 'INPUT' && !/^(button|checkbox|radio|range|color|file|submit|reset)$/.test(ae.type)) || !!ae.closest('dialog[open]')) || !!(e.target.closest && e.target.closest('dialog[open]'));   // (the key's own target counts too: a dialog that closes on the key has moved the focus by now)
  // a key a dialog or field already handled (Space opening the picked lesson in Sessions, say) is not a shortcut as well
  if (e.defaultPrevented) return;
  if (e.key === 'Escape' && !ctxMenu.hidden) { e.preventDefault(); hideCtxMenu(); return; }
  if (document.activeElement && document.activeElement.closest('.askPop')) return;   // keys typed in the popup stay in the popup
  if (e.key === 'Escape' && document.activeElement === input) { e.preventDefault(); focusBoard(); return; }
  if (e.key === 'Escape') {
    if (selection.size) { setSelection([]); return; }
    if ($('#app').classList.contains('fs')) exitFullscreen();
    $('#modelPop').hidden = true;
    return;
  }
  // Delete erases the selected drawing; with the chat box focused and empty only Delete does, so Backspace keeps editing text
  const inChat = document.activeElement === input;
  if ((!typing || (inChat && e.key === 'Delete' && !input.value)) && (e.key === 'Delete' || e.key === 'Backspace') && selection.size && !scrub) { e.preventDefault(); learnerErase([...selection]); }
  // Space (anywhere but a text field) is the timeline's ▶/⏸, and so is S; a focused button gives up the focus so it is not pressed too
  // Shift+letter / Shift+arrow is not the shortcut (Caps Lock gives an uppercase e.key but no shiftKey, so it still works); only ? takes Shift, as it needs it on most layouts
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  // (before the first step exists the timeline is hidden, e.g. while the teacher is still thinking: then it is the chat's ⏸/▶, when that shows)
  const keyBtn = !$('#timeline').hidden ? $('#tlPlay') : !$('#pauseBtn').hidden ? $('#pauseBtn') : null;
  if ((k === ' ' || k === 's') && !typing && plain && !e.repeat && keyBtn) {
    e.preventDefault(); if (ae && ae !== document.body && !ae.closest('#boardWrap')) focusBoard(); dlog(`user: ${k === ' ' ? 'space' : 'S'} on the board → ${keyBtn.id === 'tlPlay' ? 'timeline' : 'chat pause'}`, keyBtn.id === 'tlPlay' ? keyBtn.textContent : isPaused() ? '▶' : '⏸'); keyBtn.click(); return;
  }
  // Tab (outside the text fields) jumps to the chat box; Escape in the (empty or not) chat box hands the keys back to the board
  if (e.key === 'Tab' && !typing && plain) { e.preventDefault(); input.focus({ preventScroll: true }); return; }
  // F toggles full screen (not while typing in the chat box or a field)
  if (!typing && plain && !e.repeat && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault(); dlog('user: F → full screen', !$('#app').classList.contains('fs')); $('#fsBtn').click(); return;
  }
  // N starts a new session, the same as ＋ New
  if (k === 'n' && !typing && plain && !e.repeat) { e.preventDefault(); dlog('user: N → new session'); $('#newBtn').click(); return; }
  // O opens the sessions list, the same as the Sessions button
  if (k === 'o' && !typing && plain && !e.repeat) { e.preventDefault(); dlog('user: O → open sessions'); $('#sessionsBtn').click(); return; }
  // R renames this session (the same as clicking its title)
  if (k === 'r' && !typing && plain && !e.repeat && lesson) { e.preventDefault(); dlog('user: R → rename session'); $('#topicBtn').click(); return; }
  // T zooms to fit everything on the board, the same as ⤢ Fit
  // W: the learner's pen on / off (the ✏️ Draw button)
  if (k === 'w' && !typing && plain && !e.repeat) { e.preventDefault(); dlog('user: W → draw', penMode ? 'off' : 'on'); $('#penBtn').click(); return; }
  if (k === 't' && !typing && plain && !e.repeat) { e.preventDefault(); dlog('user: T → fit'); $('#fitBtn').click(); return; }
  // ? shows the shortcuts card
  if (e.key === '?' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) { e.preventDefault(); openKeys(); return; }
  // ← / A go back a step, → / D go forward one
  const back = k === 'ArrowLeft' || k === 'a', fwd = k === 'ArrowRight' || k === 'd';
  if (!typing && plain && (back || fwd) && navSteps().length) { e.preventDefault(); stepBy(back ? -1 : 1); }
});
