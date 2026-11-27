/* Whiteboard Teacher — toolbar, steps & timeline, sessions (persistence) */
'use strict';
// ======================================================================
// toolbar
// ======================================================================
$('#zoomIn').onclick = () => { const r = svg.getBoundingClientRect(); lastUserCamera = Date.now(); zoomAt(2.2, r.left + r.width / 2, r.top + r.height / 2); };
$('#zoomOut').onclick = () => { const r = svg.getBoundingClientRect(); lastUserCamera = Date.now(); zoomAt(1 / 2.2, r.left + r.width / 2, r.top + r.height / 2); };
$('#zoomPct').onclick = () => {
  const { W, H } = viewSize(), s = defaultScale(), cx = camera.x + W / camera.scale / 2, cy = camera.y + H / camera.scale / 2;
  animateCamera({ scale: s, x: cx - W / s / 2, y: cy - H / s / 2 }, 300);
};
$('#fitBtn').onclick = () => { dlog('fit: show the whole board', isPaused() ? '(paused)' : '', scrub ? `(looking back at step ${scrub.i})` : ''); fit(true); };
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
  const nav = navSteps(); if (!nav.length) return;
  if (liveBusy()) parkLive();
  Voice.unlock();
  // playFrom shows the first step itself, after it has set the play button to ⏸
  enterScrub();
  playFrom(nav[0]);
}
// The drawing goes with the next question; the learner can type one, or send nothing and get it checked.
async function showAttach() {
  const ids = [...inkSinceAsk].filter(id => objs.has(id));
  const box = $('#attach');
  if (!ids.length || penMode) { box.hidden = true; input.placeholder = 'Ask about…'; return; }
  box.hidden = false; input.placeholder = 'Ask about your drawing…';
  try { const reg = inkRegion(ids); if (reg) $('#attachImg').src = await boardImage(reg); } catch (e) { dlog('thumbnail failed', String(e)); }
}
$('#attachX').onclick = () => { inkSinceAsk.clear(); showAttach(false); renderChips(); };
function setPen(on) {
  penMode = on; svg.classList.toggle('penMode', on); if (!on) showAttach(); else $('#attach').hidden = true;
  $('#penBtn').setAttribute('aria-pressed', on); $('#penBar').hidden = !on;
  if (on) setSelection([]); else setRubber(false);
}
$('#penRubber').onclick = () => setRubber(!rubber);
svg.addEventListener('pointerleave', () => rubberRing.setAttribute('visibility', 'hidden'));
// looking back at earlier steps: Draw goes back to the live board first (like Live ●, the view stays where it is), so
// the button never silently does nothing; the learner draws on the live board
$('#penBtn').onclick = () => { if (scrub) { dlog('draw: back to the live board first'); exitScrub(true); } setPen(!penMode); };
$('#penDone').onclick = () => setPen(false);
// the sketch waits by the chat box: the keys go there so the learner can type a question (or just press ↵)
$('#penCheck').onclick = () => { setPen(false); showAttach(false); input.focus({ preventScroll: true }); };
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
  clone.querySelector('#layerOverlay')?.remove(); clone.querySelector('#grid')?.remove(); clone.querySelectorAll('[data-off]').forEach(g => g.remove());   // other tabs
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

function updateEmpty() { $('#emptyHint').style.display = objs.size || scrub ? 'none' : ''; }   // not while looking back: the board is only empty until its step is drawn

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
  resetBoard();   // the live objects are saved above; showStep builds the board of the step from nothing (else later steps' drawings stay on it)
  document.body.classList.add('scrubbing');
}
function exitScrub(keepCamera = false) {
  if (!scrub) return;
  const live = scrub.live; scrub = null;
  // an answer set aside to look back keeps going (Continue in the bar picks it up); anything else is stopped
  if (parked) { gen++; Voice.stop(); narrationDone = Promise.resolve(); updateSendBtn(); }
  else stopAll();
  if (isPaused()) setPaused(false);   // a look-back playback held on ⏸ is not the live lesson's pause
  resetBoard();
  for (const c of live.objs) { const cc = cloneCmd(c); cc._placed = true; drawObject(cc, { gen }, false); }
  if (!keepCamera) { camera = { ...live.camera }; applyCamera(); }
  document.body.classList.remove('scrubbing');
  showCaption(''); updateEmpty(); updateTimeline();
}
// Show step i. animate=false: the board as it is after step i. animate=true: everything before i, then draw i with narration.
async function showStep(i, animate) {
  if (i < 0 || i >= steps.length) return;
  enterScrub();
  gen++; if (isPaused()) setPaused(false); Voice.stop(); narrationDone = Promise.resolve(); finishTyping();
  const run = { gen }, token = ++scrub.token;
  // the last step also shows the learner's own edits that came after it, so it matches the live board
  const last = navSteps().pop(), reach = j => j === last ? steps.length - 1 : j;
  const target = animate ? i - 1 : reach(i);
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
  if (run.gen === gen) { if (started) await started.done; for (let j = i + 1; j <= reach(i); j++) for (const c of steps[j].cmds) await execCommand(cloneCmd(c), run, false); scrub.applied = reach(i); }
  else { // stopped mid-step: finish the step instantly so the board is consistent
    const r2 = { gen };
    resetBoard(); scrub.applied = -1;
    for (let j = 0; j <= reach(i); j++) for (const c of steps[j].cmds) await execCommand(cloneCmd(c), r2, false);
    scrub.applied = reach(i);
  }
  replaying = false; updateSendBtn();
}
// Play from step i to the last step (then back to live), until stopped. Each run has an id: a newer play or step
// takes over, and an older run that is still waiting stops itself.
async function playFrom(i, fromReplay = false) {
  if (!scrub) return;
  const id = scrub.playId = (scrub.playId || 0) + 1;
  const playing = () => scrub && scrub.playId === id && scrub.playing;
  scrub.playing = true; updateTimeline();
  const nav = navSteps();
  let k = nav.indexOf(i); if (k < 0) k = 0;
  if (cutStep(nav[k])) { backToCutStep(); return; }
  if (!fromReplay) await showStep(nav[k], true);
  while (playing() && k + 1 < nav.length) {
    k++;
    if (cutStep(nav[k])) { backToCutStep(); return; }
    // apply 'you' steps between teacher steps instantly, then animate the next teacher step
    await showStep(nav[k], true);
  }
  if (playing()) { await psleep(600); if (playing() && k === nav.length - 1) exitScrub(true); }
  if (scrub && scrub.playId === id) { scrub.playing = false; updateTimeline(); }
}
// The step the set-aside answer was cut in (paused, or ‹ pressed, in the middle of it): the last step, of that answer,
// with what is left of it waiting. Playing back up to it does not play it again: the live board already shows it as
// far as it got, so the answer carries on from there (the voice from where it stopped), paused if it was.
function cutStep(i) {
  const nav = navSteps(), q = parked && parked.why === 'look' && parked.turn.parkedQ;
  return !!(q && q.length && (q[0].repeat || q[0].say == null) && i === nav[nav.length - 1] && steps[i].t === parked.turn.key);
}
function backToCutStep() {
  const stay = !!parked.wasPaused;
  dlog('look back reached the step it was cut in: back to the live answer where it stopped', stay ? '(paused, as it was)' : '');
  exitScrub(true); if (stay) setPaused(true); continueParked();
}
// stop playback where it is (the board stays on the current step)
function stopPlayback() {
  if (!scrub) return;
  scrub.playing = false; scrub.playId = (scrub.playId || 0) + 1;
  gen++; if (isPaused()) setPaused(false); Voice.stop(); narrationDone = Promise.resolve();
  updateTimeline();
}
// the live answer is busy: its text is still streaming (a set-aside answer does not count) or its drawing is still running
const liveBusy = () => streamingLive() || (queueRunning && !scrub);
// ‹ / › (and ←/→): go to the previous or next step and play on from there to the last step, until paused
function stepBy(d) {
  const nav = navSteps(); if (!nav.length) return;
  dlog('step', d > 0 ? '›' : '‹', scrub ? `from step ${scrub.i}` : 'from the live board', '· live:', lab(liveTurn));
  Voice.unlock();
  if (!scrub) {
    if (d > 0) return;   // the live end is already here
    // going back while the teacher is answering (or paused) sets that answer aside, as a question does; Continue picks it up
    if (liveBusy()) parkLive();
    // the live board is at the newest step, so "previous" is the step before it
    enterScrub();
    playFrom(nav[Math.max(0, nav.length - 2)]);
    return;
  }
  const k = nav.indexOf(scrub.i);
  const nk = k + d;
  if (nk >= nav.length) { exitScrub(true); return; }
  if (nk < 0) return;
  playFrom(nav[nk]);
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
  updateSendBtn();   // the chat's pause button and the timeline's ▶/⏸ follow the same state
}
// the lesson is working: streaming, drawing, typing or narrating
function liveWorking() { return streamingLive() || queueRunning || replaying || typers.size > 0 || Voice.speaking(); }
// The timeline's ▶/⏸ follows the same state as the chat's pause button: while the lesson runs it shows ⏸ (pauses it),
// while paused it shows ▶ (resumes it). A scrubbed lesson shows ⏸ while it plays from the step to the end.
function syncPlayButton() {
  const p = isPaused(), playing = scrub ? !!scrub.playing && !p : liveWorking() && !p;
  const b = $('#tlPlay');
  b.textContent = playing ? '⏸' : '▶';
  document.body.classList.toggle('teaching', playing && !scrub);
  document.body.classList.toggle('recapping', playing && !!scrub);
  b.title = (playing ? 'Pause' : parked ? 'Continue the answer where it was left off' : p ? 'Resume the lesson' : scrub ? 'Play from this step to the end, with narration' : 'Play the lesson from the start, with narration') + ' (Space or S)';
}
// the board border (yellow: the lesson is teaching, red: a recap is playing) follows the play state; a light tick catches the moments no button update runs for
// (the voice finishing its last line, for one)
setInterval(() => { const p = isPaused(), on = scrub ? !!scrub.playing && !p : liveWorking() && !p; if (document.body.classList.contains(scrub ? 'recapping' : 'teaching') !== on || document.body.classList.contains(scrub ? 'teaching' : 'recapping')) syncPlayButton(); }, 300);
$('#tlPrev').onclick = () => stepBy(-1);
$('#tlNext').onclick = () => stepBy(1);
$('#tlLive').onclick = () => exitScrub();
$('#tlPlay').onclick = () => {
  Voice.unlock();
  const say = what => dlog('timeline ▶/⏸:', what, '· live:', lab(liveTurn), '· stack:', forkStack());
  // looking back: ⏸ freezes the playback mid-step (pen, narration, pacing) and ▶ carries on from exactly there
  if (scrub && scrub.playing) { say((isPaused() ? 'resume' : 'pause') + ' the look-back playback at step ' + scrub.i); setPaused(!isPaused()); return; }
  const nav = navSteps(); if (!nav.length) return;
  const atEnd = !scrub || nav.indexOf(scrub.i) === nav.length - 1;
  // an answer that is set aside (paused, or a question came in while it was paused) continues where it left off
  // (while a side answer is still running, the button pauses/resumes that instead)
  if (parked && atEnd && (scrub || (!liveWorking() && !isPaused()))) { say('continue the set-aside answer'); releasePauseHold('continue'); if (scrub) exitScrub(true); continueParked(); return; }
  if (!scrub) {
    // the live lesson: the same as the chat's pause button
    if (isPaused()) { say('resume'); releasePauseHold('play'); setPaused(false); return; }
    if (liveWorking()) { say('pause'); setPaused(true); return; }
    say('replay the lesson'); replay();   // a completed answer: play it from the beginning
    return;
  }
  // at the last step of a completed answer: play it again from the beginning; otherwise from this step to the end
  if (atEnd) { say('replay the lesson'); replay(); return; }
  say(`look back: play from step ${scrub.i} to the end${parked ? ', then continue the set-aside answer' : ''}`);
  playFrom(scrub.i);
};
let rangeTimer = null;
$('#tlRange').addEventListener('input', e => {
  const nav = navSteps(), k = Number(e.target.value);
  clearTimeout(rangeTimer);
  // dragging back from the live end sets the busy answer aside, like the step buttons do
  if (!scrub && liveBusy()) { if (k >= nav.length - 1) return; parkLive(); }
  stopPlayback();
  rangeTimer = setTimeout(() => showStep(nav[k], false), 40);
});

// ======================================================================
// persistence: every lesson is a session, auto-saved to the server (sessions/<id>.json)
// with a localStorage copy as a fallback. No save button.
// ======================================================================
const LS_CURRENT = 'wbt.current.v1';
let saveTimer = null, serverTimer = null, sessionCreatedAt = null, dirty = false;
function snapshot() {
  // an answer still playing (or set aside) has its words so far in its chat message, so a reload shows them
  for (const x of [liveTurn, ...forks.map(f => f.turn)]) if (x && x.msg && x.text && chat.includes(x.msg)) { x.msg.text = x.text.trim(); x.msg.drew = [...x.drew].slice(0, 80); }
  // the main board stays in objs / camera / steps (older sessions open as just that); other tabs go in tabs
  const t = tabsSnapshot();
  return { lesson, camera: t.main.camera, createdAt: sessionCreatedAt, chat: chat.slice(-300), objs: t.main.objs, steps: t.main.steps, tabs: t.tabs, activeTab: t.activeTab };
}
function saveSoon() {
  if (!lesson) return;
  dirty = true;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300);
  clearTimeout(serverTimer); serverTimer = setTimeout(saveToServer, 1200);
}
let localSaved = true;   // did the last browser-side write fit? (an 8 MB+ session usually busts the localStorage quota)
function saveNow() {
  if (!lesson || untouched()) return;
  try {
    localStorage.setItem(LS_CURRENT, lesson.session);
    localStorage.setItem('wbt.s.' + lesson.session, JSON.stringify(snapshot()));
    localSaved = true;
  } catch { localSaved = false; /* storage full or blocked: the server copy still works */ }
}
const untouched = () => lesson && lesson.autoName && !chat.some(m => m.role === 'user') && !objs.size;
async function saveToServer(keepalive = false) {
  if (!lesson || !dirty || untouched()) return;
  dirty = false;
  const st = $('#saveState');
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(lesson.session), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()), keepalive });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(r.status), { status: r.status, limit: j.error && j.error.limit }); }
    st.textContent = 'saved'; st.title = 'Auto-saved ' + new Date().toLocaleTimeString();
  } catch (e) {
    dirty = true;
    const big = e.status === 413, mb = e.limit ? ` (${+(e.limit / 1e6).toFixed(2)} MB limit)` : '';
    if (localSaved) { st.textContent = 'saved in browser only'; st.title = big ? 'This session is too big for the server to keep' + mb + '; kept in this browser only.' : 'Could not reach the server; kept in this browser for now.'; }
    else { st.textContent = 'not saved'; st.title = big ? 'Not saved: this session is too big for the server' + mb + ' and for this browser\'s storage. Clear some of it (delete messages or drawings) to save again.' : 'Not saved: could not reach the server and this browser\'s storage is full.'; }
  }
}
window.addEventListener('pagehide', () => { saveNow(); if (dirty) saveToServer(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveNow(); saveToServer(true); } });
function saveSettings() { try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} }

function resetBoard() {
  for (const o of objs.values()) o.g.remove();
  objs.clear(); selection.clear(); updateEmpty(); drawSelection(); updateSelectionUI();
}
function applySession(d) {
  if (lesson && d.lesson && lesson.session !== d.lesson.session) inflightDrop(lesson.session);   // leaving it: nothing in progress any more
  closeAllPops();
  stopAll(); liveTurn = null; scrub = null; document.body.classList.remove('scrubbing'); resetTabs(); resetBoard(); resetTree();
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
  restoreTabs(d.tabs, d.activeTab);
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
  if (!settings.voice || typeof settings.voice !== 'object') settings.voice = { mode: 'kokoro', voice: 'af_heart', speed: 0.85, engine: 'server' };
  // default speaking speed is 0.85× (v1): move the old 1× default over once; a speed picked later is kept
  if (!settings.speedV1) { if (!settings.voice.speed || settings.voice.speed === 1) settings.voice.speed = 0.85; settings.speedV1 = true; try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} }
  // narration is on by default (v4): switch it on once for everyone (Kokoro, Bella); 🔊 / ⚙ turn it off and that is kept
  if (!settings.voiceV4) { settings.voice = { ...settings.voice, mode: 'kokoro', voice: settings.voice.voice || 'af_heart' }; settings.voiceV3 = settings.voiceV4 = true; try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} }
  if (!settings.efforts || typeof settings.efforts !== 'object') settings.efforts = {};
  // new defaults (v5): the Heart voice, and GLM 5.3 at low reasoning; applied once, later picks are kept
  if (!settings.defaultsV5) { settings.voice = { ...settings.voice, voice: 'af_heart' }; settings.model = 'glm-5.3'; settings.efforts['glm-5.3'] = 'low'; settings.defaultsV5 = true; try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch {} }
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
      sessPick = Math.max(0, [...ul.children].indexOf(li) - 1);   // after deleting, the one above it is picked
      if (!confirm(`Delete “${it.topic}”? This cannot be undone.`)) return;
      try { await fetch('/api/sessions/' + encodeURIComponent(it.id), { method: 'DELETE' }); } catch {}
      try { localStorage.removeItem('wbt.s.' + it.id); } catch {}
      if (lesson && it.id === lesson.session) { stopAll(); resetTabs(); resetBoard(); lesson = null; chat = []; try { localStorage.removeItem(LS_CURRENT); } catch {} renderTitle(); renderChat(); }
      openSessions();
    };
    li.append(info, open, del); li.dataset.id = it.id; ul.appendChild(li);
  }
  if (!sessDlg.open) { sessDlg.showModal(); sessPick = Math.max(0, list.findIndex(it => lesson && it.id === lesson.session)); }
  pickSession(sessPick);
  $('#sessDlg .sessWrap').focus({ preventScroll: true });   // no button holds the keys, so Space opens the picked lesson
}
// the keys in the list: ↑/↓ pick a lesson, Space (or ↵) opens it, Delete/Backspace deletes it (↵ confirms)
let sessPick = 0;
function pickSession(k) {
  const lis = [...$('#sessList').children].filter(li => li.dataset.id); if (!lis.length) return;
  sessPick = clamp(k, 0, lis.length - 1);
  lis.forEach((li, j) => li.classList.toggle('picked', j === sessPick));
  lis[sessPick].scrollIntoView({ block: 'nearest' });
}
sessDlg.addEventListener('keydown', e => {
  const lis = [...$('#sessList').children].filter(li => li.dataset.id), li = lis[sessPick];
  if (e.metaKey || e.ctrlKey || e.altKey || !lis.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pickSession(sessPick + (e.key === 'ArrowDown' ? 1 : -1)); return; }
  if (!li) return;
  if (e.key === ' ' || (e.key === 'Enter' && !e.target.closest('button'))) { e.preventDefault(); dlog('user: sessions list', e.key === ' ' ? 'Space' : '↵', '→ open', li.dataset.id); li.querySelector('.info').click(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); dlog('user: sessions list', e.key, '→ delete?', li.dataset.id); li.querySelector('button:last-child').click(); }
});
$('#sessionsBtn').onclick = openSessions;
$('#sessClose').onclick = () => { sessDlg.close(); if (!lesson) newSession(); };
$('#sessNew').onclick = async () => { sessDlg.close(); await newSession(); input.focus(); };
