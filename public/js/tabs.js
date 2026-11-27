/* Whiteboard Teacher — tabs: a drawing opened up (double-click) or asked to be drawn from an Ask whiteboard popup
 * gets its own board. Each tab keeps its drawings (its own <g> layer), camera and steps; the globals objs, layerObj,
 * camera and steps always point at the tab on screen, so the rest of the app works on "the board" unchanged.
 * The drawing it came from gets a ↗ badge that opens it. The chat stays one conversation; answers drawn on a tab are
 * tagged with it. While the teacher teaches, the view follows the answer that is playing; leaving that tab sets the
 * answer aside (like looking back), and ▶ / Continue (or coming back) carries on there. */
'use strict';
const TAB_MAIN = 'main';
const tabs = new Map();   // id -> { id, title, parent, from: {tab, obj} | null, objs, layer, camera, steps }
let activeTab = TAB_MAIN, tabSwitching = false;
layerObj.classList.add('objLayer');
tabs.set(TAB_MAIN, { id: TAB_MAIN, title: 'Main', parent: null, from: null, objs, layer: layerObj, camera, steps });

const tabOf = id => tabs.get(id) || tabs.get(TAB_MAIN);
const tabTitle = id => tabs.has(id) ? tabs.get(id).title : '';
function stashActive() { const t = tabs.get(activeTab); if (t) { t.objs = objs; t.layer = layerObj; t.camera = camera; t.steps = steps; } }
function loadTab(t) { objs = t.objs; layerObj = t.layer; camera = t.camera; steps = t.steps; activeTab = t.id; }
function showLayer(g, on) {
  // opacity, not display:none: hidden drawings must still measure (getBBox) when a tab is built in the background
  if (on) { g.removeAttribute('opacity'); g.removeAttribute('pointer-events'); g.removeAttribute('data-off'); }
  else { g.setAttribute('opacity', '0'); g.setAttribute('pointer-events', 'none'); g.setAttribute('data-off', '1'); }
}
// run fn (synchronous only) with another tab's board in the globals, e.g. to describe it for the model
function withTab(id, fn) {
  if (!tabs.has(id) || id === activeTab) return fn();
  const back = tabs.get(activeTab); stashActive(); loadTab(tabs.get(id));
  try { return fn(); } finally { stashActive(); loadTab(back); }
}
// the tab a drawing opens into: the one it already has, or a new one (not switched to)
function tabFor(fromTab, obj, title) {
  const had = [...tabs.values()].find(t => t.from && t.from.tab === fromTab && t.from.obj === obj);
  if (had) return had;
  const layer = document.createElementNS(NS, 'g'); layer.setAttribute('class', 'objLayer');
  svg.insertBefore(layer, layerOv); showLayer(layer, false);
  const t = { id: 'tab-' + uuid().replace(/-/g, '').slice(0, 10), title: clip(title || 'Drawing', 40), parent: fromTab, from: { tab: fromTab, obj }, objs: new Map(), layer, camera: { x: -60, y: -60, scale: defaultScale() }, steps: [] };
  tabs.set(t.id, t);
  dlog('tab: new', JSON.stringify(t.title), 'from', fromTab + '/' + obj);
  renderTabs(); renderBadges(); saveSoon();
  return t;
}
// the tab of the answer that is playing (or about to)
function playingTab() {
  const t = (currentItem && currentItem.turn) || (queue[0] && queue[0].turn) || liveTurn || null;
  return t && t.tab ? t.tab : null;
}
// Swap the board on screen. Synchronous: only call it between board operations (runQueue between items, or once
// nothing is animating). why: 'user' (via switchTab), 'follow' (the playing answer moved), 'restore', 'close'
function switchTabNow(id, why) {
  if (!tabs.has(id) || id === activeTab || tabSwitching) return;
  tabSwitching = true;
  try {
    if (scrub) exitScrub(true);
    if (penMode) setPen(false);
    cancelGesture(); setSelection([]); hideCtxMenu();
    // a sketch waiting to be sent belongs to its tab (ink ids repeat across tabs)
    tabs.get(activeTab).ink = [...inkSinceAsk]; inkSinceAsk.clear(); (tabs.get(id).ink || []).forEach(x => inkSinceAsk.add(x));
    stashActive();
    showLayer(layerObj, false);
    loadTab(tabs.get(id));
    showLayer(layerObj, true);
    applyCamera(); updateEmpty(); updateTimeline(); renderTabs(); renderBadges(); showTabPops(); renderChips(); showAttach(false);
    layerOv.querySelectorAll('.drillPulse').forEach(r => { r.style.display = (r.dataset.tab || TAB_MAIN) === id ? '' : 'none'; });
    dlog('tab: show', JSON.stringify(tabTitle(id)), '(' + why + ')');
  } finally { tabSwitching = false; }
}
// The learner picks a tab (tab bar, ↗ badge, chat tag). Leaving the board the teacher is drawing on sets its answer
// aside, exactly like looking back on the timeline: the stroke in flight finishes on its own board first (so no
// animation ever writes into another tab), and ▶ / Continue, or coming back to that tab, picks it up where it was.
let tabAway = false, switchToken = 0;
async function switchTab(id, why = 'user') {
  if (!tabs.has(id) || id === activeTab || tabSwitching) return;
  if (why !== 'user') return switchTabNow(id, why);
  const token = ++switchToken;
  // (opencode mode has no set-aside answers: its drawing just carries on, and the view follows it back)
  if (!MCP_MODE && liveBusy() && playingTab() === activeTab) {
    dlog('tab: left the tab the teacher is drawing on: the answer is set aside');
    parkLive('look');   // finishes the stroke in flight at once (its own run), on this board
  }
  // while an answer waits to be continued, the teacher does not go back to it by itself: the learner is browsing
  tabAway = !!parked; renderResumeBar();
  // let the board operation in flight end on this board before it is swapped out
  for (let i = 0; i < 120 && queueBusy; i++) await sleep(25);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (token !== switchToken) return;   // another tab was picked meanwhile
  if (queueBusy) { dlog('tab: still drawing, switch skipped'); return; }
  switchTabNow(id, why);
  // back on the tab of the answer that was set aside by leaving it: carry on there
  if (tabAway && parked && parked.turn.tab === id && !liveWorking()) {
    const wasPaused = !!parked.wasPaused, step = nextStep();
    tabAway = false;
    // carry on there only if that is what comes next; questions still waiting deeper go first (scheduleAutoBack)
    if (step && step.resume) { dlog('tab: back on the set-aside answer\'s tab: carrying on'); continueParked(); if (wasPaused) setPaused(true); }
    else { dlog('tab: back on the set-aside answer\'s tab: questions inside come first'); updateSendBtn(); }
  }
}
function showTabPops() { for (const p of pops) { p.el.style.display = (p.tab || TAB_MAIN) === activeTab ? '' : 'none'; if (p.tab === activeTab) placePop(p); } }

// ---- tab bar: every tab, nested under the tab it was opened from ----
const tabBar = document.createElement('nav'); tabBar.id = 'tabBar'; tabBar.hidden = true; tabBar.setAttribute('aria-label', 'Boards');
$('#boardWrap').appendChild(tabBar);
function tabTree() {
  const out = [], walk = (id, d) => { out.push([tabs.get(id), d]); for (const t of tabs.values()) if (t.parent === id) walk(t.id, d + 1); };
  walk(TAB_MAIN, 0); return out;
}
function renderTabs() {
  tabBar.hidden = tabs.size < 2; tabBar.textContent = '';
  if (tabBar.hidden) return;
  for (const [t, d] of tabTree()) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tab' + (t.id === activeTab ? ' on' : '');
    b.textContent = (d ? '›'.repeat(d) + ' ' : '') + t.title;
    b.title = t.id === TAB_MAIN ? 'The main board' : `Opened from “${nameIn(t.from.tab, t.from.obj)}” on ${tabTitle(t.from.tab) || 'Main'}`;
    b.onclick = () => switchTab(t.id);
    const row = document.createElement('span'); row.className = 'tabRow'; row.appendChild(b);
    if (t.id !== TAB_MAIN) {
      const x = document.createElement('button'); x.type = 'button'; x.className = 'tabX'; x.textContent = '✕'; x.title = 'Close this tab (and the tabs opened from it)';
      x.onclick = () => closeTab(t.id); row.appendChild(x);
    }
    tabBar.appendChild(row);
  }
}
const nameIn = (tabId, obj) => withTab(tabId, () => objs.has(obj) ? nameOf(obj) : obj);
function closeTab(id) {
  const gone = new Set([id]); let grew = true;
  while (grew) { grew = false; for (const t of tabs.values()) if (t.parent && gone.has(t.parent) && !gone.has(t.id)) { gone.add(t.id); grew = true; } }
  // an answer still being written for it (before its first line arrives, or its follow-up / tidy call) counts too
  const busy = [...queue, currentItem].some(it => it && it.turn && gone.has(it.turn.tab)) || forks.some(f => gone.has(f.turn.tab))
    || (liveTurn && gone.has(liveTurn.tab) && (!liveTurn.streamDone || liveWorking()));
  if (busy) { alert('The teacher is still teaching on this tab. Stop it first (■), then close the tab.'); return; }
  if (!confirm(`Close the tab “${tabTitle(id)}”${gone.size > 1 ? ` and the ${gone.size - 1} tab${gone.size > 2 ? 's' : ''} opened from it` : ''}? Its drawings are removed.`)) return;
  if (gone.has(activeTab)) switchTabNow(tabs.get(id).parent || TAB_MAIN, 'close');
  for (const t of [...pendingHeld]) if (gone.has(t.tab)) { if (t.abort) t.abort.abort(); dropHeld(t); }
  for (const p of pops.slice()) if (gone.has(p.tab)) closePop(p);
  for (const gid of gone) { tabs.get(gid).layer.remove(); tabs.delete(gid); }
  dlog('tab: closed', gone.size, 'tab(s)');
  renderTabs(); renderBadges(); renderChat(); saveSoon();
}

// ---- ↗ badges on drawings that have a tab ----
let badgeRaf = 0;
function renderBadges() { if (!badgeRaf) badgeRaf = requestAnimationFrame(() => { badgeRaf = 0; drawBadges(); }); }
function drawBadges() {
  const wrap = $('#boardWrap'), wr = wrap.getBoundingClientRect(), sv = svg.getBoundingClientRect();
  wrap.querySelectorAll('.tabBadge').forEach(b => b.remove());
  for (const t of tabs.values()) {
    if (!t.from || t.from.tab !== activeTab || !objs.has(t.from.obj)) continue;
    const b = bbOf(objs.get(t.from.obj));
    const x = sv.left - wr.left + (b.x + b.width - camera.x) * camera.scale, y = sv.top - wr.top + (b.y - camera.y) * camera.scale;
    const el = document.createElement('button'); el.type = 'button'; el.className = 'tabBadge';
    el.textContent = '↗ ' + clip(t.title, 22); el.title = `Open the “${t.title}” tab`;
    el.style.left = clamp(x - 8, 4, wr.width - 60) + 'px'; el.style.top = clamp(y - 12, 4, wr.height - 24) + 'px';
    el.onclick = e => { e.stopPropagation(); switchTab(t.id); };
    el.addEventListener('pointerdown', e => e.stopPropagation());
    wrap.appendChild(el);
  }
}

// ---- sending into a tab: what the model is told about the board it draws on and where it came from ----
// returns {tab, note, about} for an answer that opens a tab, or null (MCP mode, or the drawings are gone)
function tabTarget(newTab, ids) {
  if (!newTab || MCP_MODE) return null;
  const fromTab = tabs.has(newTab.tab) ? newTab.tab : activeTab;
  const got = withTab(fromTab, () => {
    const keep = (ids && ids.length ? ids : [newTab.obj]).filter(id => objs.has(id));
    return keep.length ? { ids: keep, names: keep.map(nameOf), ctx: clip(askContext(keep), 6000).replace(/…$/, '') } : null;
  });
  if (!got) return null;
  const t = tabFor(fromTab, got.ids[0], got.names[0]);
  const had = t.objs.size > 0;
  const note = `[THIS ANSWER IS DRAWN ON ITS OWN BOARD: a tab named “${t.title}”, opened from ${got.names.map(n => `“${n}”`).join(', ')} on the “${tabTitle(fromTab) || 'Main'}” board. BOARD NOW above is this tab's board${had ? ' (with what was drawn here before: build on it)' : ' (empty)'}. Draw the explanation here, big and clear, starting at the top-left. Do not redraw the original drawing and do not draw an "inside" arrow back to it: it is on the other board. What it is, and what is around it on that board:\n${got.ctx}\n] `;
  return { tab: t.id, note, about: got.names };
}

// ---- saving and loading ----
function tabData(t) {
  const act = t.id === activeTab;
  return {
    objs: act && scrub ? scrub.live.objs : [...(act ? objs : t.objs).values()].filter(o => !o.erasing).map(o => o.cmd),
    camera: act ? (scrub ? scrub.live.camera : camera) : t.camera,
    steps: act ? steps : t.steps,
  };
}
function tabsSnapshot() {
  return { main: tabData(tabs.get(TAB_MAIN)), tabs: [...tabs.values()].filter(t => t.id !== TAB_MAIN).map(t => ({ id: t.id, title: t.title, parent: t.parent, from: t.from, ...tabData(t) })), activeTab };
}
// back to just the main tab, on screen (before a session is loaded or a new one starts)
function resetTabs() {
  if (activeTab !== TAB_MAIN) { if (scrub) exitScrub(true); stashActive(); showLayer(layerObj, false); loadTab(tabs.get(TAB_MAIN)); showLayer(layerObj, true); }
  for (const t of [...tabs.values()]) if (t.id !== TAB_MAIN) { t.layer.remove(); tabs.delete(t.id); }
  tabAway = false; renderTabs(); renderBadges();
}
// rebuild the saved tabs (after the main board was loaded); parents come before the tabs opened from them
function restoreTabs(saved, active) {
  if (!Array.isArray(saved)) return;
  for (const s of saved) {
    if (!s || typeof s.id !== 'string' || tabs.has(s.id) || !s.from || !tabs.has(s.parent)) continue;
    const layer = document.createElementNS(NS, 'g'); layer.setAttribute('class', 'objLayer');
    svg.insertBefore(layer, layerOv); showLayer(layer, false);
    const cam = s.camera && Number.isFinite(s.camera.scale) ? { x: num(s.camera.x, 0), y: num(s.camera.y, 0), scale: clamp(s.camera.scale, 0.05, 12) } : { x: -60, y: -60, scale: defaultScale() };
    const t = { id: s.id, title: clip(s.title || 'Drawing', 40), parent: s.parent, from: { tab: String(s.from.tab), obj: String(s.from.obj) }, objs: new Map(), layer, camera: cam, steps: Array.isArray(s.steps) ? s.steps : [] };
    tabs.set(t.id, t);
    withTab(t.id, () => {
      for (const raw of s.objs || []) {
        if (!raw || !builders[raw.cmd]) continue;
        const c = normalizeShape(raw.cmd, raw, { cmd: raw.cmd, id: raw.id });
        if (c) { c.id = raw.id; c._placed = true; drawObject(c, { gen }, false); }   // synchronous when not animated
      }
    });
  }
  renderTabs();
  if (active && tabs.has(active)) switchTabNow(active, 'restore'); else renderBadges();
}
