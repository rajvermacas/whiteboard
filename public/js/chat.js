/* Whiteboard Teacher — chat UI, suggestions, question tree, side questions and going back */
'use strict';
// ======================================================================
// chat UI
// ======================================================================
const msgBox = $('#messages'), input = $('#input'), sendBtn = $('#sendBtn');
// The chat follows the newest text only while the learner is at the bottom. Scrolling up (wheel, scrollbar, keys, touch)
// stops the follow so the typing can't yank the view back every frame; scrolling back to the bottom, or sending a
// message, turns it on again.
let chatFollow = true, chatSetTop = -1;
function scrollChat(force) {
  if (force) chatFollow = true;
  if (!chatFollow) return;
  msgBox.scrollTop = msgBox.scrollHeight; chatSetTop = msgBox.scrollTop;
}
msgBox.addEventListener('scroll', () => {
  if (msgBox.scrollTop === chatSetTop) return;   // our own scroll
  chatFollow = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 8;
}, { passive: true });
msgBox.addEventListener('wheel', e => { if (e.deltaY < 0) chatFollow = false; }, { passive: true });
function bubble(m) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  const body = document.createElement('span'); body.className = 'body'; body.textContent = m.text || ''; d.appendChild(body);
  if (m.role === 'user' && ((m.about && m.about.length) || m.sketch)) { const a = document.createElement('span'); a.className = 'about'; a.textContent = [m.about && m.about.length ? 'about ' + m.about.join(', ') : '', m.sketch ? 'with your sketch' : ''].filter(Boolean).join(' · '); d.appendChild(a); }
  if (m.role === 'user' && m.images && m.images.length) {   // pasted images: small thumbnails; a click opens the full picture
    const t = document.createElement('div'); t.className = 'thumbs';
    for (const th of m.images) { const im = document.createElement('img'); im.src = th; im.alt = 'your image'; im.onclick = () => showImage(fullImages.get(th) || th); t.appendChild(im); }
    d.appendChild(t);
  }
  if (m.role === 'user' && m.via === 'popup') { const a = document.createElement('span'); a.className = 'steer'; a.textContent = '💬 sent from an Ask whiteboard popup'; d.appendChild(a); }
  if (m.role === 'user' && m.steer) { const a = document.createElement('span'); a.className = 'steer'; a.textContent = '↪ sent while the teacher was answering'; d.appendChild(a); }
  if (m.tab && m.tab !== TAB_MAIN && (m.role === 'user' || m.role === 'assistant')) {
    const a = document.createElement('button'); a.type = 'button'; a.className = 'tabTag';
    a.textContent = '↗ ' + (tabTitle(m.tab) || m.tabTitle || 'tab'); a.title = tabs.has(m.tab) ? 'Show this tab' : 'This tab was closed';
    a.disabled = !tabs.has(m.tab); a.onclick = () => switchTab(m.tab); d.appendChild(a);
  }
  if (m.role === 'assistant') { const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = m.meta || ''; d.appendChild(meta); }
  msgBox.appendChild(d); scrollChat(m.role === 'user');
  return d;
}
function renderChat() {
  msgBox.textContent = '';
  if (!chat.length) {
    bubble({ role: 'system', text: MCP_MODE ? 'Connected to opencode. Ask your question there: its answer is drawn on this board, and the captions appear here.\nSelect things or sketch with ✏️ Draw; opencode can see both.' : lesson ? `Ask about anything; the teacher answers by drawing on the board.\nAnswers are generated live and can be wrong.` : 'Start a session to begin.' });
  }
  chat.forEach(bubble);
  renderChips();
}
// Suggested prompts are all written by the model for what is on the board right now; none are fixed. After an
// answer they are the "next" questions it gave; otherwise (a drawing selected, several selected, a sketch of yours,
// an empty board, an answer without them) a quick low-reasoning call writes them, cached per situation.
const suggestCache = new Map(); let suggestTimer = null, suggestAbort = null;
// the suggestion row scrolls sideways: a mouse wheel scrolls it too, and the edges fade where chips are hidden
const chipsBox = $('#chips');
function chipEdges() { const b = chipsBox, x = b.scrollLeft, max = b.scrollWidth - b.clientWidth; b.classList.toggle('moreL', x > 2); b.classList.toggle('moreR', x < max - 2); }
chipsBox.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && chipsBox.scrollWidth > chipsBox.clientWidth) { chipsBox.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
chipsBox.addEventListener('scroll', chipEdges, { passive: true });
new ResizeObserver(chipEdges).observe(chipsBox);
new MutationObserver(() => { chipsBox.scrollLeft = 0; chipEdges(); }).observe(chipsBox, { childList: true });
function renderChips() {
  const box = $('#chips'); box.textContent = '';
  const add = (label, q, primary) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = label; if (primary) b.className = 'primary'; b.onclick = () => ask(q || label); box.appendChild(b); };
  if (!lesson) { add('Choose a topic', null, true); box.lastChild.onclick = openTopic; return; }
  const ids = [...selection].filter(id => objs.has(id));
  const dynamic = (kind, names) => {
    const key = `${lesson.session}|${kind}|${names.join('|')}|${chat.length}`;
    const got = suggestCache.get(key);
    if (Array.isArray(got)) { got.forEach(q => add(q)); return; }
    const w = document.createElement('span'); w.className = 'chipWait'; w.textContent = '✨ suggesting questions…'; box.appendChild(w);
    if (got === 'pending') return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => { suggestCache.set(key, 'pending'); writeSuggestions(kind, names, key); }, 350);   // not on every click
  };
  if ([...inkSinceAsk].some(id => objs.has(id))) {
    // no "Check my drawing" chip here: the board's own button attaches the sketch and waits for the learner's words
    dynamic('sketch', [...objs.keys()].filter(id => !inkSinceAsk.has(id)).slice(-12).map(nameOf));
    return;
  }
  if (ids.length === 1) {
    const n = nameOf(ids[0]);
    add(`Open up “${n}”`, drillQuestion(n), true);       // the same as double-clicking it
    dynamic('one', [n]);
  } else if (ids.length > 1) {
    dynamic('many', ids.slice(0, 8).map(nameOf));
  } else if (!chat.some(m => m.role === 'user')) {
    if (!lesson.autoName) dynamic('start', [lesson.topic]);
  } else {
    const last = [...chat].reverse().find(m => m.role === 'assistant');
    const o = lesson.outline, more = o && o.done < o.parts.length;
    if (more) add(`Continue: ${o.done + 1}. ${o.parts[o.done]}`, `Continue the lesson with part ${o.done + 1}: ${o.parts[o.done]}.`, true);
    if (last && last.next && last.next.length) last.next.forEach((q, i) => add(q, null, i === 0 && !more));
    else if (last && last.text && !streamingLive()) dynamic('after', []);
  }
}
async function writeSuggestions(kind, names, key) {
  if (!lesson) return;   // e.g. a timer from a lesson that was deleted meanwhile
  if (suggestAbort) suggestAbort.abort();
  const ac = suggestAbort = new AbortController();
  const L = lesson, model = settings.model || (models[0] && models[0].id);
  const lastUser = [...chat].reverse().find(m => m.role === 'user'), lastA = [...chat].reverse().find(m => m.role === 'assistant' && m.text);
  const labels = [...new Set([...objs.keys()].map(nameOf).filter(Boolean))].slice(-30);
  const ask = {
    one: `The learner selected the drawing “${names[0]}” on the board. Write questions about it: what it is, why it is there or works that way, what it connects to, an example or a "what if".`,
    many: `The learner selected these drawings together: ${names.map(n => `“${n}”`).join(', ')}. Write questions about how they relate, compare or flow into each other.`,
    sketch: `The learner just drew their own sketch on the board (near: ${names.map(n => `“${n}”`).join(', ') || 'an empty board'}). Write questions they could ask about their sketch: to check it, improve it, or find what is missing. Their sketch is attached when they ask.`,
    start: `The lesson is called “${names[0]}” and nothing has been asked yet. Write good first questions to start it: the big picture, how it works inside, a concrete example.`,
    after: 'Write the follow-up questions the learner would naturally ask next about what was just explained and drawn.',
  }[kind];
  const ctx = [`Lesson: ${L.topic || ''}`, lastUser ? `Learner last asked: ${String(lastUser.text).slice(0, 300)}` : '', lastA ? `Teacher last said: ${String(lastA.text).slice(-600)}` : '', labels.length ? `On the board: ${labels.join(', ')}` : ''].filter(Boolean).join('\n');
  try {
    const out = await quickText(model, L.session + '-suggest', [
      { role: 'system', content: 'You write the suggested questions shown as buttons under a whiteboard lesson for a technical learner. Reply with only a JSON array of 3 questions, each at most 8 words, specific to this board (name its actual things), not generic ("tell me more"), and different from each other. Write them in the language of the learner\'s last message (English if there is none).' },
      { role: 'user', content: `${ctx}\n\n${ask}` }], ac.signal);
    const m = out.match(/\[[\s\S]*\]/); const list = m ? JSON.parse(m[0]) : [];
    const asText = x => typeof x === 'string' ? x : x && typeof x === 'object' ? (x.question || x.text || x.q || x.label || Object.values(x).find(v => typeof v === 'string') || '') : '';
    const qs = (Array.isArray(list) ? list : []).map(x => clip(asText(x).trim(), 70)).filter(Boolean).slice(0, 4);
    suggestCache.set(key, qs);
    dlog('suggested', kind, JSON.stringify(qs));
  } catch (e) { if (ac.signal.aborted) { suggestCache.delete(key); return; } suggestCache.set(key, []); dlog('suggestions failed', String(e)); }
  if (suggestCache.size > 60) suggestCache.delete(suggestCache.keys().next().value);
  if (lesson === L) renderChips();
}
// one short non-streamed answer from the model (titles, suggestions), read from the SSE stream
async function quickText(model, session, messages, signal) {
  const eff = defaultEffort(model);
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model, effort: eff === 'auto' ? null : eff, session, messages }) });
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
  return out;
}
// "Teaching…" at the end of the live answer, with animated dots, for as long as the teacher is working (while Stop
// shows). Not while it is still thinking (that line has its own timer) and it says "Paused" while paused.
const teachEl = document.createElement('span'); teachEl.className = 'teaching'; teachEl.setAttribute('aria-hidden', 'true');
function renderTeaching(working = liveWorking(), paused = isPaused()) {
  const t = liveTurn, host = t && !t.held && t.el && t.el.isConnected ? t.el : null;
  if (!working || scrub || !host || t.thinking) { teachEl.remove(); return; }
  const label = paused ? 'paused' : 'teaching';
  if (teachEl.dataset.label !== label) { teachEl.dataset.label = label; teachEl.innerHTML = paused ? 'Paused' : 'Teaching<i>.</i><i>.</i><i>.</i>'; }
  teachEl.classList.toggle('paused', paused);
  const meta = host.querySelector('.meta');
  if (teachEl.parentNode !== host || teachEl.nextSibling !== meta) { host.insertBefore(teachEl, meta); scrollChat(); }
}
// the composer's buttons share one icon set: drawn at the same size and line weight, so no emoji or font glyph sticks out
const COMPOSER_ICONS = {
  clip: '<path d="M20.5 11.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10.4-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.4" fill="currentColor" stroke="none"/>',
  steer: '<path d="M5 5v5.5a4 4 0 0 0 4 4h10"/><path d="M15 10.5l4 4-4 4"/>',
  send: '<path d="M4.5 11.3L19.4 4.6a.6.6 0 0 1 .8.8l-6.7 14.9a.6.6 0 0 1-1.1-.1l-1.8-5.8-5.8-1.8a.6.6 0 0 1-.1-1.1z" fill="currentColor"/>',
};
function setIcon(btn, name) {
  if (btn.dataset.icon === name) return;
  btn.dataset.icon = name;
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${COMPOSER_ICONS[name]}</svg>`;
}
[['imgBtn', 'clip'], ['pauseBtn', 'pause'], ['stopBtn', 'stop'], ['steerBtn', 'steer'], ['sendBtn', 'send']].forEach(([id, n]) => setIcon($('#' + id), n));
function updateSendBtn() {
  renderTreeSoon();
  const working = liveWorking(), p = isPaused();
  renderTeaching(working, p);
  const pb = $('#pauseBtn');
  if (scrub) {
    // a scrubbed lesson: this button pauses / resumes its playback, the same as the timeline's ⏸/▶
    const held = isPaused(); pb.hidden = !scrub.playing; setIcon(pb, held ? 'play' : 'pause'); pb.classList.toggle('on', held); tip(pb, held ? 'Resume the playback' : 'Pause the playback');
  } else {
    pb.hidden = !working && !p; setIcon(pb, p ? 'play' : 'pause'); pb.classList.toggle('on', p);
    tip(pb, (p ? 'Play' : 'Pause') + ' (Space or S)');
  }
  scheduleAutoBack();
  renderResumeBar();
  syncPlayButton();
  // while the teacher works you can still send: the message steers the answer (Stop is its own button)
  $('#stopBtn').hidden = !working;
  const teaching = working && !p && !scrub;
  $('#steerBtn').hidden = !(teaching || (p && !scrub));
  renderPendingPill();
  tip($('#steerBtn'), `Steer (${STEER_KEY})`);
  tip(sendBtn, teaching || (p && !scrub) ? 'Send as a side question (↵)' : 'Send (↵)');
  if (!(inkSinceAsk.size && !penMode)) input.placeholder = 'Ask about…';
}
$('#stopBtn').onclick = () => { dlog('user: ■ stop'); stopAll(true, 'stop button'); };
// icon buttons: the label shows on hover (and is what screen readers read)
function tip(el, text) { if (el.dataset.tip !== text) { el.dataset.tip = text; el.setAttribute('aria-label', text); el.removeAttribute('title'); } }
tip($('#stopBtn'), 'Stop');
$('#pauseBtn').onclick = () => { dlog('user:', scrub ? (isPaused() ? 'resume playback' : 'pause playback') : isPaused() ? '▶ play' : '⏸ pause'); if (scrub) { if (scrub.playing) setPaused(!isPaused()); return; } if (isPaused()) releasePauseHold('play'); setPaused(!isPaused()); };
$('#resumeGo').onclick = () => { dlog('user: ▶ continue set-aside answer'); releasePauseHold('continue'); continueParked(); };
$('#resumeX').onclick = () => { dlog('user: ✕ drop set-aside answer', lab(parked && parked.turn)); dropParked(); };

function setPaused(on) {
  if (on && pausedAt == null) { pausedAt = performance.now(); Voice.pause(); dlog('paused'); }
  else if (!on && pausedAt != null) { pausedTotal += performance.now() - pausedAt; pausedAt = null; Voice.resume(); pauseWaiters.splice(0).forEach(f => f()); dlog('resumed'); }
  document.body.classList.toggle('paused', isPaused());
  updateSendBtn();
}
// set-aside answers may still be streaming in the background: they do not count as "the teacher is answering"
function streamingLive() { return activeStreams - forks.filter(f => !f.turn.streamDone).length > 0; }
// A question asked while paused forks the lesson: the paused answer is set aside (what is left of it, plus the
// sentence that was cut short) on a stack, the question is answered, and then the teacher goes back to where it
// forked. A question during a side answer forks again, so nested questions unwind in order, like a teacher would.
// Looking back with ‹ / the slider sets the answer aside the same way; reaching the end of the recap picks it up.
let liveTurn = null;
function parkLive(why = 'look') {   // why: 'question' (a side question) or 'look' (looking back)
  const t = liveTurn, wasPaused = isPaused();
  const busy = t && !forks.some(f => f.turn === t) && (!t.streamDone || queue.length || queueBusy || Voice.speaking());
  if (!busy) { if (streamingLive() || queueRunning) stopAll(false, 'set aside: nothing left', true); setPaused(false); return; }   // keeps the answers waiting to come in
  t.parkedQ = queue.splice(0);
  const cut = lastSay && lastSay.turn === t && (queueBusy || Voice.speaking() || (t.parkedQ.length && t.parkedQ[0].say == null));
  // the sentence that was cut short is said again. Set aside by a question, from its start (after "back to …");
  // set aside by looking back, from where the voice stopped, and not at all if it had already been said in full
  if (cut) {
    const pos = Voice.position(), mine = pos && lastSay.voice && pos.h === lastSay.voice;
    if (why === 'look' && lastSay.voice && !mine && !Voice.speaking() && queueBusy) dlog('set aside after its sentence was said: it is not said again');
    else t.parkedQ.unshift({ ...lastSay, repeat: true, voice: Voice.enabled() ? (why === 'look' && mine ? lastSay.voice : Voice.prepare(lastSay.say)) : null, from: why === 'look' && mine ? Math.max(0, pos.at - 0.3) : 0 });
  }
  if (currentItem && currentItem.cmd && currentItem.turn === t) currentItem.keep = true;
  forks.push({ turn: t, why, wasPaused, abort: t.abort, say: lastSay && lastSay.turn === t ? lastSay.say : '' }); parked = forks[forks.length - 1];
  if (abortCtl === t.abort) abortCtl = null;          // Stop during the side answer must not cut the set-aside stream
  dlog('set aside', lab(t), '(' + why + '):', t.parkedQ.length, 'lines', t.streamDone ? '' : '(still streaming)', '· stack:', forkStack());
  gen++; Voice.stop(); narrationDone = Promise.resolve(); finishTyping(); hideIcon(pen); hideIcon(eraser);
  setPaused(false);
  renderResumeBar();
}
const forkStack = () => forks.length ? forks.map(f => lab(f.turn)).join(' > ') : 'empty';
const forkLeft = f => (f.turn.parkedQ && f.turn.parkedQ.length) || !f.turn.streamDone;
// questions asked while the lesson was paused hold it: it stays paused until their answers play (they do as soon as
// they are ready), and only goes back to the paused answer once they are answered. Pressing ▶ lets it go on meanwhile.
const pauseHeldFirst = () => [...pendingHeld].filter(t => t.pausedAsk && !t.dropped).sort((a, b) => (a.seq || 0) - (b.seq || 0))[0] || null;
const pauseHold = () => !!pauseHeldFirst();
function releasePauseHold(why) {
  const n = [...pendingHeld].filter(t => t.pausedAsk).length; if (!n) return;
  for (const t of pendingHeld) t.pausedAsk = false;
  dlog('▶ pressed:', n, 'question(s) asked while paused no longer hold the lesson (' + why + ')');
  if (waitingFor) { waitingFor = null; renderPendingPill(); }
}
function popFork() { const f = forks.pop(); parked = forks[forks.length - 1] || null; return f; }
function continueParked() {
  if (!parked || streamingLive() || queueRunning) return;
  tabAway = false; waitingFor = null;
  // a set-aside answer with nothing left (it finished in the background): close it and go one level further back
  while (parked && !forkLeft(parked)) { popFork().turn.parkedQ = null; }
  const p = parked; if (!p) { updateSendBtn(); return; }
  popFork();
  const t = p.turn, items = t.parkedQ || []; t.parkedQ = null;
  if (t.tab && t.tab !== activeTab && tabs.has(t.tab)) switchTabNow(t.tab, 'follow');   // back to the board that answer was drawing on
  t.run.gen = gen;                                   // its remaining lines animate again
  const side = liveTurn && liveTurn !== t ? liveTurn : null;   // the side answer that just finished
  liveTurn = t;                                      // pausing it again and asking forks it again
  if (!t.streamDone) abortCtl = t.abort;
  // nothing came in between (it was only set aside to look back, or to switch tabs): carry on in the same bubble.
  // Only when a side answer sits in between does it need a new bubble saying where it picks up again
  if (t.el && t.el.isConnected && t.el === msgBox.lastElementChild) dlog('back to', lab(t), ': same bubble (nothing in between)');
  else {
  t.el = bubble({ role: 'assistant', text: '', meta: '', tab: t.tab, tabTitle: tabTitle(t.tab) });
  const contEl = document.createElement('span'); contEl.className = 'cont'; contEl.textContent = `↩ back to where we left off${p.say ? `: “${p.say.slice(0, 60)}${p.say.length > 60 ? '…' : ''}”` : ''}`; t.el.insertBefore(contEl, t.el.firstChild);
  }
  dlog('back to', lab(t), 'from', lab(side), ':', items.length, 'lines · stack:', forkStack());
  Voice.unlock();
  // back from a side question: say so out loud, show it on the board, and look at where that answer was drawing
  // (any side answer counts: a question asked while paused, a double-click, or a question asked while looking back)
  if (p.why === 'question' || side) {
    const topic = shortTopic(t.q);
    const isDrill = x => /^what is inside /.test(x.q || '');
    const about = x => isDrill(x) ? x.q : shortTopic(x.q) || 'that side question';
    // side answers in between that already finished (a question asked inside them): name them too, innermost first
    const via = []; for (let x = side && side.from; x && x !== t && via.length < 5; x = x.from) via.push(x);
    const done = side ? (isDrill(side) ? `That is ${side.q}.` : 'That answers your question.') : 'That answers your question.';
    const also = via.length ? ` That also finishes ${via.map(about).join(', and then ')}.` : '';
    const line = `${done}${also} Now, back to ${topic || 'where we were'}.`;
    items.unshift({ say: line, turn: t, run: t.run, voice: Voice.enabled() ? Voice.prepare(line) : null });
    showBackBanner(topic || 'where we were', p.say, [side, ...via].filter(Boolean).map(about));
    const ids = [...t.drew].filter(id => objs.has(id)).slice(-6);
    if (ids.length) {
      const b = ids.map(id => bbOf(objs.get(id))).reduce((r, b) => ({ x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), width: Math.max(r.x + r.width, b.x + b.width) - Math.min(r.x, b.x), height: Math.max(r.y + r.height, b.y + b.height) - Math.min(r.y, b.y) }));
      lastUserCamera = 0; animateCamera(cameraFor(b, 120, camera.scale), 700);
    }
  }
  items.forEach(enqueue);
  updateSendBtn(); kickHeads();   // back on this tab: its next question, if ready, comes in at a sentence
}
// ---- answers asked in the background (double-click while the teacher is teaching) ----
// The lesson keeps going until the answer really starts arriving. Then, at the end of the current sentence, the
// lesson is set aside like a question asked while paused, the answer is shown and explained, and the teacher goes back.
function takeSwitch() { const f = switchReq; switchReq = null; if (f) f(); }
function requestRelease(t) {
  if (t.releasing || !t.held) return;
  if (!t.ready) { t.ready = true; t.readyAt = Date.now(); renderPendingPill(); }   // its answer is arriving
  // only the question at the front of the queue of the tab the teacher is in takes over (order.js); the others wait
  // their turn and are picked up when they reach it (kickHeads / scheduleAutoBack)
  if (!mayTakeOver(t)) { if (!t.loggedWait) { t.loggedWait = true; dlog('ready, waits its turn:', lab(t), '· asked in', lab(t.parentTurn), '· teacher in', lab(currentNode()), '· next there', lab(headOf(t.parentTurn || null))); } return; }
  dlog('ready, takes over at the next sentence:', lab(t));
  t.releasing = true;
  // voice its first lines now, so they are ready when the current sentence ends
  if (Voice.enabled()) {
    if (t.intro && !t.introVoice) t.introVoice = Voice.prepare(t.intro);
    Voice.prefetch([t.introVoice, ...t.held.filter(i => i.say != null && i.voice).slice(0, 1).map(i => i.voice)]);
  }
  const go = () => releaseHeld(t);
  // nothing is being said or drawn right now: take over at once; otherwise at the next sentence boundary
  // paused: nothing plays until it would end a sentence, so the paused answer is set aside now and this one plays
  if (!queueRunning || isPaused()) { go(); return; }
  // one handover per sentence boundary: after an earlier one takes over, this one is looked at again (it may now
  // have to wait for that sibling)
  const prev = switchReq; switchReq = prev ? () => { prev(); t.releasing = false; requestRelease(t); } : go;
  setTimeout(() => { if (t.held && switchReq) { dlog('no sentence boundary in time: switching anyway'); takeSwitch(); } }, 12000);
}
function releaseHeld(t, idle = false) {
  if (!t.held) return;
  if (!idle && !mayTakeOver(t)) { t.releasing = false; return; }   // no longer its turn (the teacher moved on): wait
  if (scrub || (tabAway && parked)) { t.releasing = false; setTimeout(() => requestRelease(t), 500); return; }   // looking back / at another tab: wait until live again
  // a side answer plays as soon as it is ready (in the order asked), whether the lesson is playing or paused, nested
  // ones too. Only answers brought back by a page reload wait for ▶: nothing may start talking on its own after a reload.
  if (isPaused() && t.restored) {
    t.releasing = false;
    if (!t.waitResume) { dlog('restored after a reload, waits for ▶:', lab(t)); t.waitResume = true; t.ready = true; renderPendingPill(); pauseWaiters.push(() => { t.waitResume = false; t.restored = false; if (t.held) requestRelease(t); }); }
    return;
  }
  if (isPaused()) dlog('ready while paused: plays now', lab(t));
  parkLive('question');                   // the running answer is set aside (if it is still going) and continues afterwards
  if (!t.held) return;                    // setting it aside woke a waiter that already took this answer over (or dropped it)
  pendingHeld.delete(t); if (waitingFor === t) waitingFor = null; renderPendingPill();
  chat.push(t.heldUser.msg, t.msg);
  const ub = t.heldUser.el; ub.classList.remove('pending'); t.heldUser.wait.remove(); if (t.pulse) { t.pulse.remove(); t.pulse = null; }
  if (!ub.isConnected) msgBox.appendChild(ub);
  ub.after(t.el); scrollChat();
  // from: the answer it was asked inside (for the way back); after a sibling, that is still the answer it was asked in
  t.from = t.askedIn && forks.some(f => f.turn === t.askedIn) ? t.askedIn : liveTurn; liveTurn = t; t.run.gen = gen;
  if (!t.streamDone) { abortCtl = t.abort; activeStreams++; t.counted = true; streaming = true; }
  const items = t.held; t.held = null;
  if (t.intro) items.unshift({ say: t.intro, turn: t, run: t.run, voice: Voice.enabled() ? t.introVoice || Voice.prepare(t.intro) : null });
  dlog('takes over:', lab(t), items.length, 'lines', '· asked in', lab(t.askedIn), '· stack:', forkStack());
  Voice.unlock();
  items.forEach(enqueue);
  saveSoon(); updateSendBtn(); kickHeads();
}
function dropHeld(t) {
  if (!pendingHeld.has(t)) return;
  dlog('background answer dropped:', lab(t)); t.dropped = true; if (waitingFor === t) waitingFor = null;
  pendingHeld.delete(t); t.held = null; renderPendingPill(); updateSendBtn(); kickHeads();   // the next in its queue may go now
  if (t.pulse) { t.pulse.remove(); t.pulse = null; }
  if (t.heldUser) { t.heldUser.el.classList.remove('pending'); t.heldUser.wait.textContent = '✕ not opened (stopped or failed)'; }
}
function renderPendingPill() {
  renderTreeSoon();
  const el = $('#pendingPill'); if (!el) return;
  const n = pendingHeld.size, first = (waitingFor && pendingHeld.has(waitingFor)) ? waitingFor : headOf(currentNode()) || [...pendingHeld][0];
  el.hidden = !n;
  if (n && waitingFor === first && !isPaused()) { el.textContent = `⏳ Waiting for the answer to “${clip(first.q.replace(/^what is inside /, ''), 50)}” (it is next)${n > 1 ? ` · then ${n - 1} more` : ''}`; return; }
  if (n && isPaused() && pauseHold()) { const h = pauseHeldFirst(); el.textContent = `⏸ Paused until the answer to “${clip(h.q.replace(/^what is inside /, ''), 50)}” is ready · ▶ carries on with the lesson meanwhile`; return; }
  if (n && isPaused()) { const q = clip(first.q.replace(/^what is inside /, ''), 50); el.textContent = first.waitResume ? `✓ The answer to “${q}” is ready: press ▶ to hear it` : first.ready ? `✓ The answer to “${q}” is ready: it plays next` : `⏳ Answering “${q}”… it plays as soon as it is ready`; return; }
  if (n) el.textContent = `⏳ ${/^what is inside /.test(first.q) ? 'Opening up ' + first.q.replace(/^what is inside /, '') : `Answering “${clip(first.q, 50)}”`}${n > 1 ? ` (+${n - 1})` : ''} … the lesson goes on meanwhile`;
}
// ---- the question tree (top of the chat): main question → side question → side question …, indented ----
// Each question is a node under the answer it was asked inside: a side question (Enter while teaching or paused),
// a double-click, or a question asked while an answer is set aside. A steer replaces the answer it steers, so it sits
// at that answer's level. A plain new question starts a new tree. The rows show where the lesson is right now and
// update as the inner answers finish and the teacher goes back out.
const qtree = [];                 // every node (a turn), in the order asked
let treeOpen = true; try { treeOpen = localStorage.getItem('wbt.treeOpen') !== '0'; } catch {}
function addToTree(t, q, opts, askedIn) {
  const drill = /^what is inside /.test(t.q);
  t.asked = q; t.kind = opts.steer ? 'steer' : drill ? 'drill' : (opts.parallel || opts.side || opts.aside) ? 'side' : 'main';
  const open = x => x && qtree.includes(x) && !x.dropped;
  if (t.kind === 'steer') { t.parent = askedIn ? askedIn.parent || null : null; if (askedIn) askedIn.steered = true; }
  else if (t.kind === 'side') t.parent = open(askedIn) ? askedIn : parked ? parked.turn : null;
  else if (t.kind === 'drill') t.parent = open(askedIn) ? askedIn : null;   // opening up a drawing of the answer on the board
  else t.parent = parked && open(parked.turn) ? parked.turn : null;          // a set-aside answer is still waiting: under it
  if (t.kind === 'side' && !t.parent) t.kind = 'main';
  if (t.kind === 'main' && t.parent) t.kind = 'side';     // asked while an answer waits to be gone back to
  t.level = t.parent ? (t.parent.level || 0) + 1 : 0;
  t.askedAt = Date.now();
  qtree.push(t);
  dlog('tree:', t.kind, lab(t), 'under', lab(t.parent), '· level', t.level);
  renderTreeSoon();
}
function resetTree() { qtree.length = 0; renderTreeSoon(); }
// what is happening to a question right now
function nodeState(t) {
  if (t.dropped) return { k: 'stopped', icon: '✕', text: 'not opened' };
  if (pendingHeld.has(t)) return t.ready ? { k: 'ready', icon: '●', text: t.waitResume ? 'ready · press ▶' : 'ready · comes in next' } : { k: 'bg', icon: '⏳', text: 'answering on the side' };
  if (forks.some(f => f.turn === t)) return { k: 'waiting', icon: '⏸', text: t === (parked && parked.turn) ? 'waits · goes back here next' : 'waits' };
  if (t === liveTurn) {
    if (t.steered) return { k: 'steered', icon: '↪', text: 'steered' };
    if (isPaused()) return { k: 'live', icon: '⏸', text: 'paused here' };
    if (liveWorking() || streamingLive()) return { k: 'live', icon: '▶', text: t.thinking ? 'thinking' : 'answering now' };
  }
  if (t.steered) return { k: 'steered', icon: '↪', text: 'steered' };
  if (t.msg && t.msg.interrupted || (t.abort && t.abort.signal.aborted && !t.streamDone)) return { k: 'stopped', icon: '■', text: 'stopped' };
  if (!t.streamDone) return { k: 'bg', icon: '⏳', text: 'answering' };
  return { k: 'done', icon: '✓', text: 'answered' };
}
const rootOf = t => { while (t && t.parent) t = t.parent; return t; };
let treeRaf = 0, treeHtml = '', treeTick = null;
function renderTreeSoon() { if (!treeRaf) treeRaf = requestAnimationFrame(() => { treeRaf = 0; renderTree(); }); }
function renderTree() {
  const el = $('#qtree'); if (!el) return;
  // the tree of where the lesson is now (the live answer, else the newest question)
  const here = liveTurn && qtree.includes(liveTurn) ? liveTurn : qtree[qtree.length - 1];
  const root = rootOf(here);
  if (!root) { el.hidden = true; treeHtml = ''; clearInterval(treeTick); treeTick = null; return; }
  const rows = [], walk = (t, d) => { rows.push([t, d]); qtree.filter(c => c.parent === t).forEach(c => walk(c, d + 1)); };
  walk(root, 0);
  const path = new Set(); for (let x = here; x; x = x.parent) path.add(x);
  const older = qtree.filter(t => !t.parent && t !== root).length;
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const label = t => t.kind === 'drill' ? 'Open up ' + t.q.replace(/^what is inside /, '') : t.asked || t.q;
  const states = rows.map(([t]) => nodeState(t));
  const active = states.filter(s => s.k !== 'done' && s.k !== 'stopped' && s.k !== 'steered').length;
  const html = `<button class="qtHead" type="button" aria-expanded="${treeOpen}" title="${treeOpen ? 'Hide' : 'Show'} the questions">` +
    `<span>Questions${rows.length > 1 ? ` · depth ${Math.max(...rows.map(r => r[1]))}` : ''}</span><span class="qtCaret">${treeOpen ? '▾' : '▸'}</span></button>` +
    (treeOpen ? `<ol class="qtList">${rows.map(([t, d], i) => {
      const s = states[i], tag = d === 0 ? 'main' : t.kind === 'drill' ? 'double-click' : t.kind === 'steer' ? 'steer' : 'side ' + d;
      return `<li class="qt ${s.k}${t === here ? ' here' : ''}${path.has(t) ? ' path' : ''}" style="--d:${d}" data-k="${esc(t.key)}" title="${esc(label(t))}\n${esc(s.text)}">` +
        `<span class="qtIcon">${s.icon}</span><span class="qtText"><span class="qtTag">${tag}</span>${esc(clip(label(t), 70))}</span>` +
        `<span class="qtState">${t === here && s.k === 'live' ? 'you are here · ' : ''}${esc(s.text)}</span></li>`;
    }).join('')}</ol>${older ? `<div class="qtOlder">${older} earlier question${older > 1 ? 's' : ''} in this chat</div>` : ''}` : '');
  el.hidden = false;
  el.classList.toggle('busy', active > 0);
  if (html !== treeHtml) { el.innerHTML = html; treeHtml = html; }
  // states also change without an event (thinking → answering, a stream ending): look again while something is open
  if (active && !treeTick) treeTick = setInterval(renderTreeSoon, 600);
  if (!active && treeTick) { clearInterval(treeTick); treeTick = null; }
}
$('#qtree').addEventListener('click', e => {
  if (e.target.closest('.qtHead')) { treeOpen = !treeOpen; try { localStorage.setItem('wbt.treeOpen', treeOpen ? '1' : '0'); } catch {} renderTree(); return; }
  const li = e.target.closest('.qt'); if (!li) return;
  const t = qtree.find(x => x.key === li.dataset.k);
  const b = t && (t.el && t.el.isConnected ? t.el : t.heldUser && t.heldUser.el.isConnected ? t.heldUser.el : null);
  if (b) { b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
});

// "how attention works" from "Explain how attention works, with an example." (the parent's own question)
function shortTopic(q) {
  let s = String(q || '').replace(/\s+/g, ' ').trim().replace(/^(please |can you |could you )?(explain|tell me about|teach me|describe|show( me)?|what is|what are|how does|how do)\b\s*/i, m => /^(how|what)/i.test(m.trim()) ? m : '');
  s = s.split(/[.?!:;]\s/)[0].replace(/[.?!:;]+$/, '');
  if (!s) return '';
  const w = s.split(' '); if (w.length > 9) s = w.slice(0, 9).join(' ') + '…';
  return /^(how|what|why|when|where)\b/i.test(s) ? s : `“${s}”`;
}
let bannerTimer = null;
function showBackBanner(topic, at, closed = []) {
  const el = $('#backBanner'); if (!el || scrub) return;
  el.innerHTML = ''; const a = document.createElement('b'); a.textContent = `↩ Back to ${topic.replace(/^“(.*)”$/, '$1')}`; el.appendChild(a);
  if (closed.length) { const c = document.createElement('span'); c.textContent = `done: ${closed.join(' ← ')}`; el.appendChild(c); }
  if (at) { const s = document.createElement('span'); s.textContent = `continuing from “${at.length > 70 ? at.slice(0, 70) + '…' : at}”`; el.appendChild(s); }
  el.hidden = false; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { el.hidden = true; }, 5000);
}
// ✕ on the bar drops the answer it names (the one we would go back to next); Stop / a new lesson drop them all
function dropParked(all = false) {
  while (parked) {
    const p = popFork();
    reparentQuestions(p.turn, p.turn.parentTurn);   // questions asked inside it now wait in the answer it was asked in
    if (p.abort && !p.turn.streamDone) p.abort.abort();
    p.turn.parkedQ = null; p.turn.msg.interrupted = true;
    if (!all) break;
  }
  if (!parked) tabAway = false;
  updateSendBtn();
}
function renderResumeBar() {
  const bar = $('#resumeBar'); if (!bar) return;
  const show = !!parked && !streamingLive() && !queueRunning && forkLeft(parked);
  bar.hidden = !show;
  if (show && waitingFor && pendingHeld.has(waitingFor)) { $('#resumeText').textContent = `⏳ Waiting for “${clip(waitingFor.q.replace(/^what is inside /, ''), 40)}” first · ▶ Continue goes back now to “${parked.say || 'the previous answer'}”`; return; }
  if (show) $('#resumeText').textContent = `${autoBack ? '↩ Going back to' : '⏸ Paused at'}: “${parked.say || 'the previous answer'}”${forks.length > 1 ? ` (+${forks.length - 1} more)` : ''}`;
}
// Once the side answer is done (and nothing is paused or being looked back at), go back to where it forked.
let autoBack = null, sendsPending = 0, waitingFor = null;   // waitingFor: the question the teacher waits on this tab for
function scheduleAutoBack() {
  // nothing playing and an answer set aside: a background answer that is ready goes first (one at a time, in the
  // order they became ready); otherwise go back. Answers still being written do not hold the lesson up: it goes back
  // and they come in at a sentence boundary once they are ready.
  // (order.js decides: the front question of this tab if ready, else this tab's current topic, else wait here; up a
  // level only when the tab has nothing left)
  const idle = () => !scrub && !(tabAway && parked) && !isPaused() && !sendsPending && !liveWorking() && !steering;
  let step = idle() ? nextStep() : null;
  if (step && step.resume && pauseHold()) step = { wait: pauseHeldFirst() };   // asked while paused: answered before going back
  if (!step || step.wait) { if (autoBack) { clearTimeout(autoBack); autoBack = null; } if (step && step.wait && waitingFor !== step.wait) { waitingFor = step.wait; dlog('waits on', tabTitle(tabOfTurnSafe(currentNode())) || 'Main', 'for', lab(step.wait)); renderPendingPill(); renderResumeBar(); } return; }
  if (waitingFor) { waitingFor = null; renderPendingPill(); }
  if (autoBack) return;
  autoBack = setTimeout(() => {
    autoBack = null;
    if (!idle()) { renderResumeBar(); return; }
    const s = nextStep(); if (!s) return;
    if (s.resume && pauseHold()) { scheduleAutoBack(); return; }
    if (s.release) { s.release.releasing = false; releaseHeld(s.release, true); }
    else if (s.resume) continueParked();
    else scheduleAutoBack();
  }, 900);
}
// The board is the default focus: the keys (Space or S ▶/⏸, ←/→ or A/D steps, F full screen, N new session, R rename, T fit, Delete) go to it. The chat box gets the
// focus only when the learner clicks into it. Clicking the board (a drawing or empty space) keeps the focus on the board;
// buttons, sliders and fields keep their own focus.
$('#boardWrap').tabIndex = -1;
const focusBoard = () => $('#boardWrap').focus({ preventScroll: true });
$('#boardWrap').addEventListener('click', e => {
  if (e.target.closest('button,input,select,textarea,a,label,.askPop,#ctxMenu')) return;
  focusBoard();
});
// While the teacher is teaching: Enter (or Send) asks on the side (a fork: answered in parallel, the lesson goes on and
// comes back after it); ⌘/Ctrl+Enter (or ↪ Steer) steers the lesson (it stops after its sentence and takes the message in).
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const STEER_KEY = IS_MAC ? '⌘↵' : 'Ctrl+↵';
let submitMode = 'fork';
input.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault(); submitMode = (e.metaKey || e.ctrlKey) ? 'steer' : 'fork'; $('#composer').requestSubmit();
});
$('#steerBtn').onclick = () => { submitMode = 'steer'; $('#composer').requestSubmit(); };
function fitInput() {
  input.style.height = '40px';
  // an empty box is one line high, the same as the buttons beside it: the browser measures a wrapped placeholder as content
  if (!input.value) { input.style.overflowY = 'hidden'; return; }
  const need = input.scrollHeight + (input.offsetHeight - input.clientHeight);   // content + borders
  const h = need > 41 ? Math.min(need, 140) : 40;
  input.style.height = h + 'px'; input.style.overflowY = need > 140 ? 'auto' : 'hidden';
}
input.addEventListener('input', fitInput);
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  let q = input.value.trim();
  if (!q && pastedImages.length) q = pastedImages.length > 1 ? 'Teach me what these images show.' : 'Teach me what this image shows.';
  if (!q && [...inkSinceAsk].some(id => objs.has(id))) q = 'Check my drawing.';
  if (!q) return;
  input.value = ''; fitInput();
  const mode = submitMode; submitMode = 'fork';
  const images = takeImages();
  ask(q, mode, images.length ? { images } : {});
  // once a message is sent the keys go to the board, so Space right after plays/pauses instead of typing a space
  input.blur(); focusBoard();
});
// one place that decides how a question goes in: while paused it is a side question (answered now, then back);
// while teaching it forks in the background (default) or steers (⌘/Ctrl+Enter); otherwise it is a new question
// Paused works the same as teaching: Enter forks in the background (the lesson stays paused; ▶ carries on with
// the current topic and the answer takes over once it is ready), ⌘/Ctrl+Enter resumes and steers.
// Where a message goes, given what the teacher is doing (used by ask() and by the popup hand-off to say what happens):
//   how 'side'  answered in its own request while the lesson goes on; comes in at the next sentence (at once when paused)
//   how 'steer' the teacher stops after its sentence and answers with the message taken in
//   how 'park'  paused with nothing live to go back to: asked as a normal answer
//   how 'new'   a normal answer (it replaces whatever is running)
// back: looking back at an earlier step while an answer is set aside: first back to the live board and that answer
function askRoute(mode = 'fork') {
  const paused = isPaused() && !scrub;
  const teaching = !scrub && (streamingLive() || queueRunning);
  const state = paused ? 'paused' : teaching ? 'teaching' : scrub ? 'looking back' : 'idle';
  if (scrub && parked && forkLeft(parked) && !streamingLive())
    return { how: mode === 'steer' ? 'steer' : 'side', back: true, waitsForPlay: mode !== 'steer' && (!!parked.wasPaused || isPaused()), state };
  if ((teaching || paused) && mode === 'steer') return { how: 'steer', state };
  if ((teaching || paused) && liveTurn) return { how: 'side', waitsForPlay: paused, state };
  if (paused) return { how: 'park', state };
  return { how: 'new', state };
}
function ask(q, mode = 'fork', extra = {}) {
  const r = askRoute(mode);
  dlog('user: asks', JSON.stringify(clip(q, 60)), '· key:', mode, '· state:', r.state, '· route:', r.how + (r.back ? ' (back to live)' : ''), '· live:', lab(liveTurn));
  // looking back: go back to the live board and pick the set-aside answer up where it was (still paused if it was
  // paused before looking back, or the look-back itself was paused), then treat the message as if it was typed there
  if (r.back) {
    const stayPaused = !!parked.wasPaused || (mode !== 'steer' && isPaused());
    dlog('user: asked while looking back: back to the live board,', stayPaused ? 'paused in' : 'carrying on with', lab(parked.turn));
    exitScrub(true); if (stayPaused) setPaused(true); continueParked();   // paused first: nothing of it plays meanwhile
  }
  const side = { parallel: true, aside: true, topic: q, intro: `You asked: “${clip(q, 90)}”.` };
  if (r.how === 'steer') { if (isPaused()) setPaused(false); return send(q, { ...extra, steer: true }); }
  if (r.how === 'side') return send(q, { ...extra, ...side });
  if (r.how === 'park') return send(q, { ...extra, side: true });
  return send(q, extra);
}
$('#clearChatBtn').onclick = () => { if (!chat.length) return; stopAll(true, 'clear chat'); chat = []; renderChat(); resetTree(); saveSoon(); };
$('#selAsk').onclick = () => input.focus();
$('#selErase').onclick = () => { if (!scrub) learnerErase([...selection]); };
function learnerErase(ids) { ids = ids.filter(id => objs.has(id) && !objs.get(id).erasing); if (!ids.length) return; recordEdit({ cmd: 'erase', ids: ids.slice() }); eraseIds(ids, { gen }, true, () => performance.now()); }
$('#selClear').onclick = () => setSelection([]);

// typewriter (~60 chars/s) — never blocks the pen
function typeInto(turn, text, cps) {
  const add = (turn.text ? '\n' : '') + text;
  turn.text += add;
  turn.pendingType = (turn.pendingType || '') + add;
  // with narration the sentence is typed while it is said, ending when the voice does: the time left (not paused) is
  // what the text still to type must fit in, so a late timer (a busy board) or text left from the sentence before
  // speeds the typing up instead of leaving the chat behind the voice
  turn.typeLeft = text.length / (cps ? clamp(cps, 8, 120) : 60);
  if (turn.typing || !turn.el) return;         // no bubble (an answer carried over a reload that was never continued)
  turn.typing = true; typers.add(turn); updateSendBtn();
  const body = turn.el.querySelector('.body');
  if (turn.thinking) { body.textContent = ''; body.classList.remove('thinking'); turn.thinking = false; renderTeaching(); }
  let acc = 0, last = performance.now();
  const tick = () => {
    if (!turn.pendingType) { turn.typing = false; typers.delete(turn); updateSendBtn(); return; }
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    if (isPaused()) { turn.timer = setTimeout(tick, 100); return; }
    turn.typeLeft -= dt;
    acc += turn.typeLeft > 0 ? turn.pendingType.length * Math.min(1, dt / (turn.typeLeft + dt)) : turn.pendingType.length;
    const n = Math.floor(acc); acc -= n;
    body.textContent += turn.pendingType.slice(0, n); turn.pendingType = turn.pendingType.slice(n);
    scrollChat(); turn.timer = setTimeout(tick, 33);
  };
  tick();
}
function finishTyping() {
  for (const t of typers) { clearTimeout(t.timer); const body = t.el.querySelector('.body'); body.textContent += t.pendingType || ''; t.pendingType = ''; t.typing = false; }
  typers.clear(); updateSendBtn();
}

function stopAll(dropPark = true, why = '', keepHeld = false) {
  if (queue.length || streaming || forks.length || pendingHeld.size) dlog('stopAll' + (why ? ` (${why})` : ''), queue.length, 'queued, streaming=' + streaming, dropPark && forks.length ? `· drops stack: ${forkStack()}` : '', pendingHeld.size ? `· drops ${pendingHeld.size} background` : '', why ? '' : (new Error().stack || '').split('\n').slice(1, 4).map(l => l.trim().replace(/^at /, '')).join(' < '));
  gen++;
  queue.length = 0;
  Voice.stop(); narrationDone = Promise.resolve();
  if (scrub) scrub.playing = false;
  if (abortCtl) { abortCtl.abort(); abortCtl = null; }
  if (dropPark) dropParked(true);
  if (!keepHeld) { switchReq = null; [...pendingHeld].forEach(t => { if (t.abort) t.abort.abort(); dropHeld(t); }); waitingFor = null; }
  // unpaused only after the side answers are dropped: un-pausing wakes the ones waiting for ▶, and one would take over
  // (and play, even in a new session after a reload) before it could be dropped
  if (isPaused()) setPaused(false);
  finishTyping();
  hideIcon(pen); hideIcon(eraser);
  updateSendBtn();
}
