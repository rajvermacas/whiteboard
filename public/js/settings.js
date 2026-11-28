/* Whiteboard Teacher — model picker, narration, topic dialog, opencode mode and boot */
'use strict';
// ======================================================================
// model picker
// ======================================================================
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL = { auto: 'Auto', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };
function modelInfo(id) { return models.find(x => x.id === id); }
function modelName(id) { const m = modelInfo(id); return m ? m.name : id; }
// the lowest reasoning level this model offers, when it is lower than `effort` (null = the model's own default)
function lowerEffort(id, effort) { const ef = effortsOf(id); if (!ef.length) return null; const low = ef[0]; return low !== effort ? low : null; }
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
// the provider a model is served by, shown next to it: OpenCode Go, OpenRouter or OpenGateway
function providerName(id) { const m = modelInfo(id); return m ? (m.providerName || 'OpenCode Go') : ''; }
// the env var that holds the key for a model (used in error messages)
function keyNameFor(id) { const s = String(id); return s.startsWith('og:') ? 'OPENGATEWAY_API_KEY' : s.startsWith('or:') ? 'OPENROUTER_API_KEY' : 'OPENCODE_API_KEY'; }
// header chip: provider · model · reasoning level
function renderModelLabel() { const e = currentEffort(); $('#modelLabel').textContent = [providerName(settings.model), modelName(settings.model) || '…', EFFORT_LABEL[e] || e].filter(Boolean).join(' · '); }
function renderEffort() {
  const seg = $('#effortSeg'); seg.textContent = '';
  const ef = effortsOf(settings.model), cur = currentEffort();
  for (const e of ['auto', ...ef]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = EFFORT_LABEL[e] || e; b.dataset.e = e;
    b.classList.toggle('on', e === cur);
    b.onclick = () => { settings.efforts[settings.model] = e; saveSettings(); renderEffort(); renderModelLabel(); };
    seg.appendChild(b);
  }
  $('#providerNote').textContent = providerName(settings.model) ? `Provider: ${providerName(settings.model)}` : '';
  $('#effortNote').textContent = ef.length
    ? 'Lower reasoning starts drawing sooner. Auto = the model’s own default (often slow to start).'
    : 'This model has no adjustable reasoning level.';
}
async function loadModels() {
  try {
    const r = await fetch('/api/models'); const j = await r.json();
    models = j.models || [];
    if (!settings.model || !models.some(m => m.id === settings.model)) {
      settings.model = j.default || (models[0] && models[0].id);
      if (effortsOf(settings.model).includes('low')) settings.efforts[settings.model] = 'low';   // the default model starts at low reasoning
      saveSettings();
    }
    // the first time a non-OpenCode default is available (OpenGateway or OpenRouter), switch to it once; later choices are kept
    if (j.default && /^(og|or):/.test(j.default) && !settings.remoteDefaultApplied && models.some(m => m.id === j.default)) { settings.model = j.default; settings.remoteDefaultApplied = true; saveSettings(); }
    if (j.error) bubble({ role: 'error', text: `Could not list models (${j.error.code}): ${j.error.message}` });
  } catch { models = []; bubble({ role: 'error', text: 'Cannot reach the local server. Start it with `npm start`.' }); }
  fillModelSelect();
  renderEffort(); renderModelLabel();
}
// the picker: a search box over an in-page list (a native <select> opens the system's own grey menu), grouped by
// provider; every word typed must appear in a model's provider, name or id (case-insensitive). ↑/↓ move, ↵ picks.
let modelQuery = '', modelActive = -1;
const modelRows = () => [...$('#modelList').querySelectorAll('.mRow')];
function pickModel(id) {
  if (!id) return;
  settings.model = id; saveSettings(); renderEffort(); renderModelLabel();
  $('#modelSearch').value = ''; modelQuery = ''; fillModelSelect(); showCurrentModel();
}
function setModelActive(i, scroll = true) {
  const rows = modelRows(); if (!rows.length) { modelActive = -1; return; }
  modelActive = clamp(i, 0, rows.length - 1);
  rows.forEach((r, k) => r.classList.toggle('active', k === modelActive));
  $('#modelSearch').setAttribute('aria-activedescendant', rows[modelActive].id);
  if (scroll) rows[modelActive].scrollIntoView({ block: 'nearest' });
}
// opened: the chosen model in view, and the keys ready for searching
function showCurrentModel() {
  const rows = modelRows(), i = rows.findIndex(r => r.dataset.id === settings.model);
  setModelActive(i < 0 ? 0 : i, false);
  const r = rows[i < 0 ? 0 : i], list = $('#modelList');
  if (r) list.scrollTop = r.offsetTop - list.clientHeight / 2 + r.offsetHeight / 2;
}
function fillModelSelect() {
  const sel = $('#modelList'); sel.textContent = '';
  const words = modelQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = m => { const hay = `${m.providerName || 'OpenCode Go'} ${m.name} ${m.id}`.toLowerCase(); return words.every(w => hay.includes(w)); };
  const oc = m => m.provider !== 'openrouter' && m.provider !== 'opengateway';
  const groups = [['OpenGateway', m => m.provider === 'opengateway'], ['OpenRouter', m => m.provider === 'openrouter'], ['OpenCode Go · Featured', m => oc(m) && m.featured && !m.free], ['OpenCode Go · Free', m => oc(m) && m.free], ['OpenCode Go · All other models', m => oc(m) && !m.featured && !m.free]];
  let shown = 0;
  for (const [label, test] of groups) {
    const list = models.filter(test).filter(hit).sort((a, b) => a.name.localeCompare(b.name)); if (!list.length) continue;
    const h = document.createElement('div'); h.className = 'mGroup'; h.textContent = label; sel.appendChild(h);
    for (const m of list) {
      const o = document.createElement('div'); o.className = 'mRow'; o.id = 'm-' + shown; o.setAttribute('role', 'option'); o.dataset.id = m.id;
      const on = m.id === settings.model; o.setAttribute('aria-selected', on); if (on) o.classList.add('on');
      const n = document.createElement('span'); n.className = 'mName'; n.textContent = m.name;
      const k = document.createElement('span'); k.className = 'mId'; k.textContent = oc(m) ? m.id : '';
      o.append(n, k); o.title = `${m.providerName || 'OpenCode Go'} · ${m.name}${oc(m) ? ` (${m.id})` : ''}`;
      o.onpointerdown = e => e.preventDefault();   // the search box keeps the keys
      o.onclick = () => pickModel(m.id);
      o.onpointermove = () => { const i = modelRows().indexOf(o); if (i !== modelActive) setModelActive(i, false); };
      sel.appendChild(o); shown++;
    }
  }
  if (!shown) { const o = document.createElement('div'); o.className = 'mNone'; o.textContent = `No model matches “${modelQuery.trim()}”`; sel.appendChild(o); }
  modelActive = -1; if (shown) setModelActive(0, false);
}
$('#modelSearch').oninput = e => { modelQuery = e.target.value; fillModelSelect(); $('#modelList').scrollTop = 0; };
$('#modelSearch').onkeydown = e => {
  const rows = modelRows();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setModelActive(modelActive + (e.key === 'ArrowDown' ? 1 : -1)); }
  else if (e.key === 'Enter') { e.preventDefault(); if (rows[modelActive]) pickModel(rows[modelActive].dataset.id); }
  else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (e.target.value) { e.target.value = ''; modelQuery = ''; fillModelSelect(); showCurrentModel(); }
    else { $('#modelPop').hidden = true; focusBoard(); }
  }
};
$('#copyLogBtn').onclick = async () => {
  const info = [`Whiteboard Teacher debug log`, `browser: ${navigator.userAgent}`, `isolated: ${self.crossOriginIsolated}, cores: ${navigator.hardwareConcurrency}, webgpu: ${!!navigator.gpu}`,
    `model: ${settings.model} · ${currentEffort()} · voice: ${JSON.stringify(voiceCfg())} · voice status: ${JSON.stringify(Voice.status())} (${Voice.device() || '-'})`,
    `queue: ${queue.length} waiting, running=${queueRunning}, streaming=${streaming}, speaking=${Voice.speaking()}, audio: ${Voice.audioState()}, last voice used: ${Voice.source() || '-'}`,
    `session: ${lesson ? `${lesson.session} “${lesson.topic}”` : '-'} · chat messages: ${chat.length} · board objects: ${objs.size} · steps: ${steps.length}`,
    `state: ${isPaused() ? 'paused' : 'not paused'}${scrub ? ', looking back' : ''}${steering ? ', steering' : ''} · live answer: ${lab(liveTurn)} · fork stack (bottom > top): ${forkStack()}`,
    `background answers: ${pendingHeld.size ? [...pendingHeld].map(t => `${lab(t)} ${t.ready ? 'ready' : 'writing'}${t.waitResume ? ', waits for ▶' : ''}`).join(' | ') : 'none'}`,
    `question tree: ${qtree.length ? qtree.map(t => `${'  '.repeat(t.level || 0)}${lab(t)} [${t.kind}] ${nodeState(t).text}`).join(' | ') : 'empty'}`,
    `page loaded ${new Date(performance.timeOrigin).toISOString()} · now ${new Date().toISOString()}`, '', ...debugLog].join('\n');
  try { await navigator.clipboard.writeText(info); $('#copyLogBtn').textContent = 'Copied ✓'; }
  catch { const w = window.open('', '_blank'); if (w) { w.document.body.innerText = info; } }
  setTimeout(() => { $('#copyLogBtn').textContent = 'Copy debug log'; }, 2000);
};
$('#modelBtn').onclick = e => {
  e.stopPropagation(); const pop = $('#modelPop'); pop.hidden = !pop.hidden;
  if (!pop.hidden) showCurrentVoice();
  if (!pop.hidden && !MCP_MODE) { showCurrentModel(); $('#modelSearch').focus({ preventScroll: true }); }
};
document.addEventListener('pointerdown', e => { if (!$('#modelPop').hidden && !e.target.closest('#modelPop') && !e.target.closest('#modelBtn')) $('#modelPop').hidden = true; });

// ======================================================================
// narration settings
// ======================================================================
// one voice: Kokoro on this computer (an old 'browser' setting becomes Kokoro)
function voiceCfg() { const v = settings.voice || (settings.voice = {}); const mode = v.mode === 'off' ? 'off' : 'kokoro'; return { mode, voice: v.voice || 'af_heart', speed: v.speed || 0.85, engine: 'server', lastMode: 'kokoro', enVoice: v.enVoice, hiVoice: v.hiVoice }; }
const teachLang = () => settings.lang === 'hinglish' ? 'hinglish' : 'en';
const isHindiVoice = id => /^h[fm]_/.test(id || '');
function applyVoice() {
  const v = voiceCfg();
  // the language follows the voice family (a Hindi voice saved before the Language setting, or with it out of step,
  // would otherwise get Roman Hinglish read with English sounds, since the prompt would not ask for the hi copy)
  if (isHindiVoice(v.voice) !== (teachLang() === 'hinglish')) { settings.lang = isHindiVoice(v.voice) ? 'hinglish' : 'en'; saveSettings(); dlog('language set to', settings.lang, 'to match the voice', v.voice); }
  Voice.configure({ mode: v.mode, voice: v.voice, speed: v.speed, engine: v.engine });
  $('#voiceModeSeg').querySelectorAll('button').forEach(b => { const on = b.dataset.m === v.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  fillVoiceList();
  $('#langSeg').querySelectorAll('button').forEach(b => { const on = b.dataset.l === teachLang(); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('#voiceSpeed').value = String(v.speed); $('#voiceSpeedVal').textContent = v.speed.toFixed(2) + '×';
  $('#kokoroRow').hidden = v.mode !== 'kokoro';
  $('#muteBtn').textContent = v.mode === 'off' ? '🔇' : '🔊';
  $('#muteBtn').setAttribute('aria-pressed', v.mode !== 'off');
  renderVoiceStatus(Voice.status());
}
// teaching language: Hinglish lessons are read by a Hindi voice, so switching picks one (and switching back
// returns to the English voice used before)
function setLang(l) {
  if (l === teachLang()) return;
  const v = voiceCfg(); settings.lang = l;
  if (l === 'hinglish' && !isHindiVoice(v.voice)) setVoice({ voice: v.hiVoice || 'hf_alpha', enVoice: v.voice });
  else if (l === 'en' && isHindiVoice(v.voice)) setVoice({ voice: v.enVoice || 'af_heart', hiVoice: v.voice });
  else { saveSettings(); applyVoice(); }
}
// a voice picked from the other family switches the language with it, so the prompt and the voice always match
function pickVoice(id) { settings.lang = isHindiVoice(id) ? 'hinglish' : 'en'; setVoice({ voice: id }); }
function setVoice(patch) { settings.voice = { ...voiceCfg(), ...patch }; saveSettings(); applyVoice(); }
function renderVoiceStatus(st) {
  const v = voiceCfg(), bar = $('#voiceBar');
  const msg = v.mode !== 'kokoro' ? '' : st.state === 'loading' ? '🔊 ' + st.text : st.state === 'error' ? '🔇 ' + st.text : st.state === 'info' ? 'ℹ️ ' + st.text : '';
  bar.textContent = msg; bar.hidden = !msg;
  $('#voiceStatus').textContent = Voice.describe();
}
Voice.onStatus(renderVoiceStatus);
// the voice list: the same in-page list as the model picker, grouped by accent; ↑/↓ pick, ↵ or Space plays a preview
const voiceRows = () => [...$('#voiceList').querySelectorAll('.mRow')];
function fillVoiceList() {
  const box = $('#voiceList'), cur = voiceCfg().voice; box.textContent = '';
  const groups = [['American', 'US'], ['British', 'UK'], ['Hindi · for Hinglish', 'Hindi']];
  for (const [label, tag] of groups) {
    const list = Voice.VOICES.map(([id, l]) => { const m = /^(.*?) \((US|UK|Hindi), (.*)\)$/.exec(l) || [, l, 'US', '']; return { id, name: m[1], acc: m[2], kind: m[3].replace(/, /g, ' · ') }; }).filter(v => v.acc === tag);
    if (!list.length) continue;
    const h = document.createElement('div'); h.className = 'mGroup'; h.textContent = label; box.appendChild(h);
    for (const v of list) {
      const o = document.createElement('div'); o.className = 'mRow'; o.id = 'v-' + v.id; o.setAttribute('role', 'option'); o.dataset.id = v.id;
      const on = v.id === cur; o.setAttribute('aria-selected', on); o.classList.toggle('on', on); o.classList.toggle('active', on);
      const n = document.createElement('span'); n.className = 'mName'; n.textContent = v.name;
      const k = document.createElement('span'); k.className = 'mId'; k.textContent = v.kind;
      o.append(n, k); o.title = `${v.name} (${label}, ${v.kind.replace(/ · /g, ', ')})`;
      o.onclick = () => { pickVoice(v.id); box.focus({ preventScroll: true }); };
      box.appendChild(o);
    }
  }
  box.setAttribute('aria-activedescendant', 'v-' + cur);
}
function showCurrentVoice() {
  const box = $('#voiceList'), r = box.querySelector('.mRow.on');
  if (r) box.scrollTop = r.offsetTop - box.clientHeight / 2 + r.offsetHeight / 2;
}
$('#voiceList').onkeydown = e => {
  const rows = voiceRows(), i = rows.findIndex(r => r.classList.contains('on'));
  const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
  if (to !== null) { e.preventDefault(); e.stopPropagation(); const r = rows[clamp(to, 0, rows.length - 1)]; pickVoice(r.dataset.id); voiceRows().find(x => x.dataset.id === r.dataset.id).scrollIntoView({ block: 'nearest' }); return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); $('#voicePreview').click(); }
};
(() => {
  $('#voiceModeSeg').querySelectorAll('button').forEach(b => { b.onclick = () => { const m = b.dataset.m; setVoice({ mode: m, lastMode: m === 'off' ? voiceCfg().lastMode : m }); }; });
  $('#voicePreview').onclick = async () => {
    const b = $('#voicePreview'); Voice.unlock(); b.textContent = '… generating';
    try { const r = await Voice.preview(); b.textContent = '🔊 playing'; await r.done; } catch (e) { dlog('preview failed', String(e)); }
    b.textContent = '▶ Preview voice'; renderVoiceStatus(Voice.status());
  };
  $('#langSeg').querySelectorAll('button').forEach(b => { b.onclick = () => setLang(b.dataset.l); });
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
  if (lesson) inflightDrop(lesson.session);
  closeAllPops();
  if (lesson && !untouched()) { saveNow(); await saveToServer(); }
  clearLesson();
  lesson = { topic: 'New session', autoName: true, plan: null, session: 'wbt-' + uuid() };
  sessionCreatedAt = new Date().toISOString();
  camera = { x: 0, y: 0, scale: defaultScale() }; fit(false);
  renderTitle(); renderChat(); focusBoard();
}
// Started by the user (button or N): put the cursor in the chat box, ready for the first question.
$('#newBtn').onclick = async () => { await newSession(); input.focus(); };
// Ask the selected model, in parallel with the answer, for a short title from the first question.
async function nameSession(q, model) {
  const L = lesson; if (!L || !L.autoName || L.naming) return;
  L.naming = true;
  try {
    const out = await quickText(model, L.session + '-title', [
      { role: 'system', content: 'You name whiteboard lessons. Reply with only a short title of 2-5 words for a lesson that starts with the learner question below: the subject, in Title Case, in the language of the question, no quotes, no trailing punctuation.' },
      { role: 'user', content: q.slice(0, 800) }]);
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
$('#topicBtn').title = 'Rename this session (R)';
dlg.addEventListener('close', () => { if (!lesson && dlg.returnValue !== 'ok') setTimeout(openSessions, 0); });
$('#topicForm').addEventListener('submit', async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const topic = $('#tTopic').value.trim(); if (!topic) { e.preventDefault(); return; }
  const next = { topic: topic.slice(0, 120) };
  if (topicIsNew || !lesson) {
    // the current lesson is already auto-saved; start a fresh one
    if (lesson) { saveNow(); await saveToServer(); }
    clearLesson();
    lesson = { ...next, plan: null, session: 'wbt-' + uuid() };
    sessionCreatedAt = new Date().toISOString();
    camera = { x: 0, y: 0, scale: defaultScale() }; fit(false);
  } else lesson = { ...lesson, ...next, autoName: false };   // renaming keeps the board and chat; a name you chose is never replaced
  renderTitle(); renderChat(); saveSoon();
});
function renderTitle() {
  const t = $('#titleText'); t.textContent = lesson ? lesson.topic : 'Whiteboard Teacher';
  if (lesson && lesson.session !== renderTitle.last) { renderTitle.last = lesson.session; dlog('session', lesson.session, JSON.stringify(lesson.topic)); }
  $('#topicBtn').title = lesson ? `${lesson.session}\n(click or press R to rename)` : 'Start a session';
  document.title = lesson ? `${lesson.topic} — Whiteboard Teacher` : 'Whiteboard Teacher';
}

// ======================================================================
// opencode mode (/?mode=mcp): opencode's model drives this board through mcp.js and the server's board bridge
// (/api/board/*). Questions are asked in opencode; the chat here shows the teacher's captions.
// ======================================================================
const MCP_MODE = new URLSearchParams(location.search).get('mode') === 'mcp';
// embed=1: shown inside opencode Desktop's side panel, next to opencode's own chat, so the chat column is hidden
// and each spoken line shows as a caption over the board instead.
const EMBED = MCP_MODE && new URLSearchParams(location.search).get('embed') === '1';
let captionTimer = null;
function liveCaption(text) {
  if (scrub) return;
  const c = $('#caption'); c.textContent = text; c.hidden = false;
  clearTimeout(captionTimer); captionTimer = setTimeout(() => { if (!scrub) c.hidden = true; }, Math.max(4000, text.length / SPEAK_CPS * 1000 + 1500));
}
let mcpTurn = null;
// Draw calls that come in close together belong to one answer (one chat bubble, one answer on the timeline).
function mcpTurnNow() {
  if (mcpTurn && chat.includes(mcpTurn.msg) && Date.now() - mcpTurn.last < 60000) { mcpTurn.last = Date.now(); return mcpTurn; }
  const am = { role: 'assistant', text: '', drew: [], meta: 'opencode' };
  chat.push(am);
  mcpTurn = { msg: am, text: '', drew: new Set(), el: bubble(am), thinking: false, cmds: 0, key: 't' + Date.now().toString(36), last: Date.now() };
  return mcpTurn;
}
const rnd = n => Math.round(n);
const boxText = id => { const o = objs.get(id), b = bbOf(o); return `${id} ${o.cmd.cmd} · box x${rnd(b.x)} y${rnd(b.y)} w${rnd(b.width)} h${rnd(b.height)}`; };
function freeSpace() {
  const b = allBounds();
  return b ? `Free space: to the right from x=${rnd(b.x + b.width + 80)} (y from ${rnd(b.y)}), below from y=${rnd(b.y + b.height + 80)} (x from ${rnd(b.x)}).` : 'The board is empty: start near (0, 0).';
}
const runBusy = run => queue.some(it => it.run === run) || (queueBusy && currentItem && currentItem.run === run);
async function boardIdle(ms) { const t0 = Date.now(); while ((queue.length || queueBusy) && Date.now() - t0 < ms) await sleep(120); }

const MCP_METHODS = {
  async draw(p) {
    if (scrub) exitScrub();
    if (!lesson) await newSession();
    const parts = Array.isArray(p.steps) ? p.steps : [{ say: p.say, commands: p.commands }];
    const run = { gen }, turn = mcpTurnNow(), errors = [], touched = [];
    const onTab = activeTab; turn.tab = onTab;   // this call draws on the tab on screen now (the view follows it)
    let n = 0;
    for (const st of parts.slice(0, 40)) {
      if (!st || typeof st !== 'object') continue;
      if (st.say) { const t = trimSay(str(st.say, 1200)), hi = typeof st.hi === 'string' ? trimSay(str(st.hi, 1500)) : undefined; enqueue({ say: t, hi, turn, run, voice: Voice.enabled() ? Voice.prepare(t, hi) : null }); }
      for (const raw of Array.isArray(st.commands) ? st.commands : []) {
        if (++n > 300) { errors.push('more than 300 commands in one call: the rest were skipped'); break; }
        const c = normalize(raw);
        if (!c) { errors.push(`unknown or invalid command skipped: ${JSON.stringify(raw).slice(0, 140)}`); continue; }
        // a session the model never named takes its first heading as its name
        if (c.cmd === 'write' && lesson.autoName && c.text) { lesson.topic = clip(c.text, 60); lesson.autoName = false; renderTitle(); }
        touched.push(c);
        enqueue({ cmd: c, run, turn });
      }
    }
    const t0 = Date.now(), maxWait = num(p.wait_seconds, 20, 0, 110) * 1000;
    while (runBusy(run) && run.gen === gen && Date.now() - t0 < maxWait) await sleep(120);
    const done = !runBusy(run);
    return withTab(onTab, () => {   // the board this call drew on, even if the learner switched tabs meanwhile
    const drawn = [];
    for (const c of touched) {
      if (c.cmd === 'erase' || c.cmd === 'clear' || c.cmd === 'wait') continue;
      if (objs.has(c.id)) { if (!drawn.includes(c.id)) drawn.push(c.id); }
      else if (done) errors.push(c.cmd === 'update' || c.cmd === 'move' ? `${c.cmd}: there is no object "${c.id}" on the board` : `${c.id} (${c.cmd}) could not be drawn: check its fields`);
    }
    turn.msg.text = turn.text.trim(); turn.msg.drew = [...turn.drew].slice(0, 80); saveSoon();
    return {
      done, drawn: drawn.map(boxText), errors,
      issues: done ? layoutIssues(drawn.filter(id => objs.get(id).cmd.cmd !== 'ink')) : [],
      free: freeSpace(),
      note: done ? undefined : 'Still drawing (the board paces the pen to the captions). Later calls queue up after it.',
    };
    });
  },
  async get_board() {
    const ink = [...objs.values()].filter(o => o.cmd.cmd === 'ink').map(o => o.cmd.id);
    return {
      topic: lesson ? lesson.topic : '', summary: boardSummary(),
      selected: [...selection].filter(id => objs.has(id)).map(id => `${id} (${nameOf(id)})`),
      sketches: ink, newSketches: [...inkSinceAsk].filter(id => objs.has(id)),
      lessonSteps: navSteps().length, drawing: !!(queue.length || queueBusy),
    };
  },
  async look(p) {
    await boardIdle(20000);
    const ids = (Array.isArray(p.ids) ? p.ids : []).map(x => str(x, 40)).filter(id => objs.has(id));
    let region = null;
    if (ids.length) region = regionAround(ids, 60);
    else if (p.area === 'view') region = viewRect();
    else if (p.area === 'sketch') {
      let ink = [...inkSinceAsk].filter(id => objs.has(id));
      if (!ink.length) ink = [...objs.values()].filter(o => o.cmd.cmd === 'ink').map(o => o.cmd.id);
      if (!ink.length) return { empty: true, note: 'The learner has not sketched anything. They can press ✏️ Draw on the board.' };
      region = inkRegion(ink);
      inkSinceAsk.clear(); showAttach(false);
    } else region = allBounds();
    if (!region) return { empty: true, note: 'The board is empty.' };
    const image = await boardImage(region);
    return { image, region: `x ${rnd(region.x)}..${rnd(region.x + region.width)}, y ${rnd(region.y)}..${rnd(region.y + region.height)}` };
  },
  async new_board(p) {
    await newSession();
    mcpTurn = null;
    if (p.title) { lesson.topic = clip(p.title, 120); lesson.autoName = false; }
    renderTitle(); renderChat(); saveSoon();
    return { topic: lesson.topic };
  },
};

function mcpConnect() {
  const status = $('#saveState');
  const es = new EventSource('/api/board/events' + (EMBED ? '?embed=1' : ''));
  es.addEventListener('hello', () => { $('#modelLabel').textContent = '● opencode'; dlog('mcp: connected'); });
  es.onerror = () => { $('#modelLabel').textContent = '○ reconnecting…'; };
  es.addEventListener('call', async e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    let out;
    try {
      const fn = MCP_METHODS[msg.method];
      if (!fn) throw new Error('unknown method ' + msg.method);
      dlog('mcp:', msg.method);
      out = { id: msg.id, ok: true, result: await fn(msg.params || {}) };
    } catch (err) { dlog('mcp: call failed', msg.method, String(err && err.stack || err).slice(0, 300)); out = { id: msg.id, ok: false, error: String(err && err.message || err) }; }
    try { await fetch('/api/board/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) }); }
    catch { status.textContent = 'cannot reach the server'; }
  });
}
function mcpSetup() {
  document.body.classList.add('mcpMode');
  if (EMBED) document.body.classList.add('embed');
  $('#modelPick').hidden = true;
  $('#emptyHint').textContent = 'Ask in opencode → its answer is drawn here';
  $('#attach span').textContent = 'Your drawing is ready. In opencode, ask "check my drawing".';
  $('#penCheck').textContent = 'Done: check it in opencode';
  // browsers only play sound after the page has been clicked once
  document.addEventListener('pointerdown', () => Voice.unlock(), { once: true });
  mcpConnect();
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
  applyVoice(); updateTimeline();
  renderTitle(); renderChat(); applyCamera();
  if (MCP_MODE) mcpSetup(); else await loadModels();
  if (!had) newSession();
  focusBoard();
  await restoreInflight();   // a reload in the middle of the lesson: carry on where it was (paused until ▶)
  // test hook (used by the automated check only)
  window.__wbt = { objs, camera: () => camera, execCommand: (raw, animate = true) => { const c = normalize(raw); return c && execCommand(c, { gen }, animate); }, selection, stopAll, send, lesson: () => lesson, steps: () => steps, scrub: () => scrub, showStep, stepBy, exitScrub };
})();
