/* Whiteboard Teacher — the lesson in progress survives a reload. Saved on the server next to the session
 * (sessions/<id>.inflight.json, via /api/sessions/<id>/inflight), like a checkpoint: what the teacher was about to say
 * and draw (lines that already arrived but had not played), side answers waiting, answers set aside, the paused state
 * and the open Ask whiteboard popups. Which tab was open and each tab's camera are already in the session itself.
 * After a reload the lesson comes back paused (browsers only play sound after a click): ▶ / Continue carries on, the
 * saved lines play exactly as they would have, and only answers that were still arriving ask the model for the rest. */
'use strict';
const INFLIGHT_LINES = 400;      // lines of an answer kept so a cut-off answer can be continued
let inflightLast = '', inflightReady = false, inflightSent = 0;
const inflightUrl = id => '/api/sessions/' + encodeURIComponent(id) + '/inflight';

// ---- what is saved ----
const itemOut = it => it.say != null ? { say: it.say, repeat: it.repeat || undefined } : it.cmd ? { cmd: it.cmd, fix: it.fix || undefined } : null;
// the answer's latest lines, whole lines only, at most `max` characters
function lastLines(lines, max) {
  const out = []; let n = 0;
  for (let i = (lines || []).length - 1; i >= 0; i--) { const l = String(lines[i]); if (l.length > 4000) continue; if (n + l.length > max) break; out.unshift(l); n += l.length + 1; }
  return out;
}
function turnOut(t) {
  return { key: t.key, q: t.q, ask: clip(t.ask || t.q, 2000), tab: t.tab || TAB_MAIN, intro: t.intro || null, aside: !!t.aside, streamDone: !!(t.streamDone || t.answered),
    parent: t.parentTurn ? t.parentTurn.key : null, seq: t.seq || 0, got: t.streamDone || t.answered ? [] : lastLines(t.got, 12000), text: String(t.text || '').slice(-6000), drew: [...(t.drew || [])].slice(-200), depth: t.depth || null };
}
function inflightSnapshot() {
  if (!lesson || MCP_MODE) return null;
  const out = { session: lesson.session, live: null, forks: [], held: [], pops: [] };
  const lt = liveTurn;
  if (lt && lt.key && !forks.some(f => f.turn === lt)) {
    const items = [];
    // the sentence being said (or the drawing being drawn) when the page went away is said / drawn again
    if (lastSay && lastSay.turn === lt && (queueBusy || Voice.speaking() || typers.size)) items.push({ say: lastSay.say, repeat: true });
    if (currentItem && currentItem.turn === lt && currentItem.cmd && queueBusy) items.push(itemOut(currentItem));
    for (const it of queue) if (it.turn === lt) items.push(itemOut(it));
    if (items.length || !lt.streamDone) out.live = { turn: turnOut(lt), items: items.filter(Boolean), say: lastSay && lastSay.turn === lt ? lastSay.say : '' };
  }
  for (const f of forks) if (forkLeft(f)) out.forks.push({ turn: turnOut(f.turn), items: (f.turn.parkedQ || []).map(itemOut).filter(Boolean), why: f.why, wasPaused: !!f.wasPaused, say: f.say || '' });
  for (const t of pendingHeld) if (t.heldUser) out.held.push({ turn: turnOut(t), items: (t.held || []).map(itemOut).filter(Boolean), user: t.heldUser.msg, am: t.msg });
  for (const p of pops) out.pops.push({ tab: p.tab || TAB_MAIN, ids: p.ids, board: p.board || undefined, thread: p.thread.map(x => ({ q: x.q, a: x.a })), min: p.min, at: p.at });
  return out.live || out.forks.length || out.held.length || out.pops.length ? out : null;
}
// saved when it changes (checked a few times a second) and once more as the page closes
function inflightSave(closing = false) {
  if (!inflightReady || !lesson || MCP_MODE) return;
  const snap = inflightSnapshot(), body = snap ? JSON.stringify(snap) : '';
  if (!closing && body === inflightLast) return;
  inflightLast = body;
  const at = Math.max(Date.now(), inflightSent + 1); inflightSent = at;   // never goes back, even if the clock does
  const payload = snap ? `{"at":${at},${body.slice(1)}` : JSON.stringify({ at, empty: true });
  if (closing && navigator.sendBeacon && navigator.sendBeacon(inflightUrl(lesson.session), new Blob([payload], { type: 'application/json' }))) return;
  fetch(inflightUrl(lesson.session), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: payload.length < 60000 })
    .catch(() => { inflightLast = null; });   // try again on the next check
}
setInterval(() => inflightSave(), 400);
window.addEventListener('pagehide', () => inflightSave(true));
// another session is opened (or a new one starts): the one being left has nothing in progress any more
function inflightDrop(session) {
  if (!session || MCP_MODE) return;
  const at = Math.max(Date.now(), inflightSent + 1); inflightSent = at; inflightLast = '';
  fetch(inflightUrl(session), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at, empty: true }), keepalive: true }).catch(() => {});
}

// ---- after a reload ----
function turnIn(s, msg) {
  if (msg && s.text && s.text.trim().length > String(msg.text || '').length) msg.text = s.text.trim();
  return { msg: msg || { role: 'assistant', text: '', drew: [], meta: '', key: s.key }, q: s.q, ask: s.ask || s.q, tab: tabs.has(s.tab) ? s.tab : TAB_MAIN,
    intro: s.intro || null, aside: !!s.aside, text: s.text || '', drew: new Set(s.drew || []), el: null, thinking: false, cmds: 0,
    key: s.key || 't' + Date.now().toString(36), run: { gen }, streamDone: true, parentKey: s.parent || null, seq: (askSeq = Math.max(askSeq, s.seq || 0), s.seq || 0), got: Array.isArray(s.got) ? s.got.slice() : [], depth: s.depth || null, restored: true };
}
const itemsIn = (t, list) => (Array.isArray(list) ? list : []).map(x => !x ? null
  : x.say != null ? { say: String(x.say), repeat: !!x.repeat, turn: t, run: t.run, voice: Voice.enabled() ? Voice.prepare(String(x.say)) : null }
  : x.cmd && typeof x.cmd === 'object' && x.cmd.cmd ? { cmd: x.cmd, turn: t, run: t.run, fix: !!x.fix } : null).filter(Boolean);
async function restoreInflight() {
  try {
    if (!lesson || MCP_MODE) return;
    const r = await fetch(inflightUrl(lesson.session)); if (!r.ok) return;
    const d = await r.json();
    if (!d || d.empty || d.session !== lesson.session) return;
    inflightSent = Math.max(inflightSent, d.at || 0);
    const findMsg = key => key && chat.find(m => m.role === 'assistant' && m.key === key);
    // paused first: nothing restored may start playing before the learner presses ▶
    if (d.live || (d.forks || []).length || (d.held || []).length) setPaused(true);
    const resume = [];
    // answers set aside, oldest first, then the answer that was playing on top: it is the one ▶ carries on with
    const parkIt = (s, why, say, wasPaused) => {
      const t = turnIn(s.turn, findMsg(s.turn.key));
      t.parkedQ = itemsIn(t, s.items);
      t.streamDone = !!s.turn.streamDone;
      forks.push({ turn: t, why, wasPaused, abort: null, say: say || '' });
      try { addToTree(t, t.ask, { aside: t.aside }, null); } catch {}
      if (!t.streamDone) resume.push(t);
    };
    for (const f of d.forks || []) parkIt(f, f.why || 'look', f.say, !!f.wasPaused);
    if (d.live) parkIt(d.live, 'reload', d.live.say, true);
    parked = forks[forks.length - 1] || null;
    if (parked) liveTurn = parked.turn;
    renderChat();   // with the words the restored answers had said
    // side answers that were waiting: they come in at a sentence once the lesson plays again
    for (const h of d.held || []) {
      if (!h.user) continue;
      const t = turnIn(h.turn, h.am);
      t.held = itemsIn(t, h.items); t.streamDone = !!h.turn.streamDone;
      const ub = bubble(h.user); ub.classList.add('pending');
      const w = document.createElement('span'); w.className = 'wait'; w.textContent = '⏳ Answering on the side… (carried over from before the reload)'; ub.appendChild(w);
      t.heldUser = { msg: h.user, el: ub, wait: w }; t.el = bubble(t.msg); t.el.remove();
      pendingHeld.add(t);
      try { addToTree(t, t.ask, { aside: true }, null); } catch {}
      if (!t.streamDone) resume.push(t);
    }
    // the questions' places in the order: each under the answer it was asked in (if that came back too)
    const byKey = new Map([...forks.map(f => f.turn), ...pendingHeld].map(t => [t.key, t]));
    for (const t of byKey.values()) t.parentTurn = (t.parentKey && byKey.get(t.parentKey)) || null;
    for (const t of pendingHeld) if (t.held && t.held.length) requestRelease(t);   // now that each knows its place
    renderPendingPill();
    for (const s of d.pops || []) restorePop(s);
    showTabPops();
    if (forks.length + pendingHeld.size) {
      const note = bubble({ role: 'system', text: '⟳ The page was reloaded in the middle of the lesson. Press ▶ (or Continue) to carry on where the teacher was.' });
      note.classList.add('reloadNote');
    }
    dlog('reload: restored', forks.length, 'set-aside answer(s),', pendingHeld.size, 'waiting side answer(s),', (d.pops || []).length, 'popup(s); continuing', resume.length, 'cut-off answer(s)');
    renderResumeBar(); updateSendBtn(); renderTreeSoon();
    resume.forEach(t => continueStream(t));
  } catch (e) { dlog('reload: could not restore the lesson in progress', String(e && e.message || e)); }
  finally { inflightReady = true; }
}
// an answer that was still arriving when the page went away: ask the model for the rest of it
async function continueStream(t) {
  t.streamDone = false;
  const ac = new AbortController(); t.abort = ac;
  const f = forks.find(x => x.turn === t); if (f) f.abort = ac;   // ✕ on the bar, or ■, drops it like any set-aside answer
  if (!t.held) { activeStreams++; t.counted = true; streaming = true; }
  const model = settings.model || (models[0] && models[0].id), eff = currentEffort();
  const sofar = lastLines(t.got, 12000).join('\n') || '(nothing yet)';
  const messages = withTab(t.tab, () => buildMessages(t.ask, [], [], null, false, t.aside));
  messages.push({ role: 'assistant', content: sofar },
    { role: 'user', content: '[The page was reloaded while you were answering, so your answer above was cut off there. Continue it from exactly where it stopped, in the same JSON Lines format. Do not repeat any line above and do not start over. If it was already complete, reply with just {"ok":true}.]' });
  dlog('reload: asking for the rest of', lab(t), '·', t.got.length, 'lines arrived before');
  try { await streamAnswer(messages, { model, effort: eff === 'auto' ? null : eff, run: t.run, turn: t, signal: ac.signal }); }
  catch (e) { if (!ac.signal.aborted) dlog('reload: could not get the rest of', lab(t), e.code || '', e.message || ''); }
  finally {
    if (t.counted) { activeStreams = Math.max(0, activeStreams - 1); t.counted = false; }
    streaming = activeStreams > 0; t.streamDone = true;
    if (t.held) { if (!t.held.length) dropHeld(t); else requestRelease(t); }
    updateSendBtn(); renderResumeBar();
  }
}
function restorePop(s) {
  if (!s || !tabs.has(s.tab) || !Array.isArray(s.ids)) return;
  const ids = s.board ? [] : withTab(s.tab, () => s.ids.filter(id => objs.has(id)));
  if (!s.board && !ids.length) return;
  withTab(s.tab, () => openAskPop(ids, s.board && Array.isArray(s.at) ? s.at : null));   // synchronous: builds it against its own tab's drawings
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.askPop')) document.activeElement.blur();
  const p = pops[pops.length - 1]; if (!p || p.tab !== s.tab) return;
  const log = p.el.querySelector('.apLog');
  for (const x of (Array.isArray(s.thread) ? s.thread : []).slice(-20)) {
    const item = { q: String(x.q || ''), a: String(x.a || '') }; p.thread.push(item);
    const qd = document.createElement('div'); qd.className = 'apQ'; qd.textContent = item.q;
    const ad = document.createElement('div'); ad.className = 'apA';
    if (!item.a) { ad.classList.add('err'); ad.textContent = 'Interrupted by the reload. Ask again.'; }
    else if (/^\(Handed to the teacher/.test(item.a) || /^\(Asked to draw it/.test(item.a)) { ad.classList.add('handoff'); ad.textContent = item.a.replace(/^\(|\)$/g, ''); }
    else ad.innerHTML = mdToHtml(item.a);
    log.append(qd, ad); log.hidden = false;
  }
  if (Array.isArray(s.at) && s.at.length === 2) p.at = [num(s.at[0], p.at[0]), num(s.at[1], p.at[1])];
  placePop(p);
  if (s.min) minimisePop(p);
}
