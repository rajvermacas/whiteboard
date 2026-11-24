/* Narration engine for Whiteboard Teacher.
 * One voice only: Kokoro, generated on this computer by the app's server (/api/tts). There is no fallback voice:
 * if Kokoro is not ready or fails, the line is silent (the lesson keeps its pace) and the status says why.
 * prepare(text) starts synthesis early so audio is ready when the pen reaches that step.
 * play(handle) resolves when audio starts, with {duration, done} so the caller can pace typing and drawing.
 */
window.Voice = (() => {
  'use strict';
  let cfg = { mode: 'kokoro', voice: 'af_bella', speed: 0.85, engine: 'server' };
  let serverState = 'unknown';         // unknown | loading | ready | unavailable
  let ctx = null, current = null, epoch = 0, speakingNow = false, lastSource = '';
  const cache = new Map(), listeners = new Set();
  let status = { state: 'idle', text: '' };
  // pause: the learner froze the lesson. Audio is suspended, and every timer below counts only unpaused time.
  let paused = false, resumeWaiters = [];
  const whenResumed = () => paused ? new Promise(r => resumeWaiters.push(r)) : Promise.resolve();
  function activeTimeout(ms, fn) {
    let left = ms, last = performance.now();
    const id = setInterval(() => { const now = performance.now(); if (!paused) left -= now - last; last = now; if (left <= 0) { clearInterval(id); fn(); } }, 100);
  }
  const log = (...a) => { try { window.wbtLog && window.wbtLog('voice', ...a); } catch {} };
  const setStatus = (state, text = '') => { status = { state, text }; listeners.forEach(f => { try { f(status); } catch {} }); };

  function speakable(t) {
    return String(t)
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[*_`#>]/g, '')
      .replace(/\s*(→|->|⟶)\s*/g, ' to ').replace(/\s*(←|<-)\s*/g, ' from ')
      .replace(/×/g, ' times ').replace(/÷/g, ' divided by ').replace(/≈/g, ' about ').replace(/≠/g, ' not equal to ')
      .replace(/≤/g, ' at most ').replace(/≥/g, ' at least ').replace(/±/g, ' plus or minus ').replace(/√/g, ' square root of ')
      .replace(/σ/g, 'sigma').replace(/η/g, 'eta').replace(/λ/g, 'lambda').replace(/θ/g, 'theta').replace(/α/g, 'alpha')
      .replace(/β/g, 'beta').replace(/μ/g, 'mu').replace(/π/g, 'pi').replace(/Δ/g, 'delta').replace(/∇/g, 'gradient of ').replace(/[Σ∑]/g, 'sum')
      .replace(/²/g, ' squared').replace(/³/g, ' cubed')
      .replace(/\s+/g, ' ').trim();
  }
  // Safari can hand a page a dead audio context (state 'suspended', or its own 'interrupted'), notably after a
  // reload. Anything started on it plays silently. So: rebuild it inside a user gesture, and check before playing.
  function newCtx() {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    if (ctx) { log('audio context rebuilt (was ' + ctx.state + ')'); try { ctx.close(); } catch {} }
    ctx = new AC(); return ctx;
  }
  // resume() settles a moment later: until then the context still reads 'suspended' and must not be taken for dead
  function resumeCtx(c) {
    c._resuming = true;
    c.resume().catch(() => {}).finally(() => { c._resuming = false; });
  }
  function ensureCtx() {
    if (!ctx || ctx.state === 'closed') newCtx();
    if (ctx && ctx.state !== 'running' && !paused && !ctx._resuming) resumeCtx(ctx);
    return ctx;
  }
  // inside a click or key press (the only moment Safari lets audio start)? Without the API, assume so.
  const inGesture = () => !navigator.userActivation || navigator.userActivation.isActive;
  // called from a click / key press, and also from code that runs later (a side answer taking over): only a real
  // gesture may replace a stuck context, since a context made outside one is born suspended and stays silent
  function unlockAudio() {
    if (paused) return;   // a click while paused must not restart the audio
    if (!inGesture()) { ensureCtx(); return; }
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && ctx._gestured && !ctx._resuming) newCtx();   // a resume in an earlier gesture didn't take
    const c = ensureCtx(); if (!c) return;
    c._gestured = true;
    try { const s = c.createBufferSource(); s.buffer = c.createBuffer(1, 1, 22050); s.connect(c.destination); s.start(0); } catch {}
  }
  // wait briefly for the context to run; false means sound would be silent
  async function running(c) {
    if (c.state === 'running') return true;
    try { await Promise.race([c.resume(), new Promise(r => setTimeout(r, 700))]); } catch {}
    return c.state === 'running';
  }
  // ---------- Kokoro on this computer (the app's server, /api/tts). There is no other voice: no fallback. ----------
  let polling = false;
  async function checkServer() {
    if (polling) return; polling = true;
    try {
      for (let i = 0; i < 900; i++) {
        const r = await fetch('/api/tts/status'); const j = await r.json();
        if (j.state === 'ready') { serverState = 'ready'; setStatus('ready', ''); break; }
        if (j.state === 'unavailable' || j.state === 'error') {
          serverState = 'unavailable'; log('server voice unavailable:', j.error);
          if (cfg.mode === 'kokoro') setStatus('error', j.state === 'unavailable'
            ? 'Kokoro is not installed: run npm install in the project folder, then restart the server. The lesson goes on without sound.'
            : 'Kokoro failed to load on this computer (' + (j.error || 'unknown error') + '). Restart the server to try again.');
          break;
        }
        serverState = 'loading';
        setStatus('loading', j.progress ? `Preparing the voice on this computer ${j.progress}% (first time only)` : 'Preparing the voice on this computer…');
        await new Promise(r2 => setTimeout(r2, 1000));
      }
    } catch (e) { log('status check failed', String(e)); }
    polling = false;
  }
  async function synth(text) {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: cfg.voice, speed: cfg.speed }) });
    if (r.status === 501) { serverState = 'unavailable'; checkServer(); throw new Error('Kokoro is not available on the server'); }
    if (!r.ok) throw new Error('server voice error ' + r.status);
    const genMs = Number(r.headers.get('X-Gen-Ms') || 0);
    const arr = await r.arrayBuffer();
    const c = ensureCtx();
    const buf = await new Promise((res, rej) => { const p = c.decodeAudioData(arr, res, rej); if (p && p.catch) p.catch(rej); });
    if (genMs && buf.duration > 0.8) log('kokoro generated', buf.duration.toFixed(1) + 's audio in', (genMs / 1000).toFixed(1) + 's');
    return buf;
  }
  function synthKokoro(text) {
    const key = `${cfg.voice}|${cfg.speed}|${text}`;
    if (cache.has(key)) return cache.get(key);
    const p = synth(text);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return p;
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms))]);
  // a line that cannot be spoken: no other voice steps in, the lesson keeps its pace in silence
  const silent = text => ({ duration: text.length / 14, done: Promise.resolve(), silent: true });

  // ---------- public API ----------
  function configure(next) {
    cfg = { ...cfg, ...next, engine: 'server' };
    if (cfg.mode !== 'kokoro') { cfg.mode = cfg.mode === 'off' ? 'off' : 'kokoro'; }
    if (cfg.mode === 'off') { setStatus('idle', ''); return; }
    if (serverState !== 'ready') checkServer();
  }
  const enabled = () => cfg.mode !== 'off';
  function unlock() { if (cfg.mode === 'kokoro') unlockAudio(); }

  // Lines are voiced on demand, not all at once: the server's Kokoro makes one line at a time, so voicing every
  // line as it streams in would put a long queue in front of anything said next (a double-click's answer, a side
  // question). Only the line about to play and the next few (prefetch) are made, and a line that must play now
  // jumps to the front.
  const wantQ = []; let inflight = 0; const MAX_INFLIGHT = 1;   // one at a time: a line that must play next waits for at most one other
  function prepare(text) {
    const clean = speakable(text);
    return { text: clean, raw: text, audio: null, started: false };
  }
  function want(h, urgent) {
    if (!h || !h.text || cfg.mode !== 'kokoro' || h.started) return;
    if (!h.audio) { h.audio = new Promise((res, rej) => { h.res = res; h.rej = rej; }); h.audio.catch(() => {}); }
    const i = wantQ.indexOf(h);
    if (i >= 0) { if (!urgent) return; wantQ.splice(i, 1); }
    if (urgent) wantQ.unshift(h); else wantQ.push(h);
    pump();
  }
  function pump() {
    while (inflight < MAX_INFLIGHT && wantQ.length) {
      const h = wantQ.shift(); h.started = true; inflight++;
      synthKokoro(h.text).then(h.res, h.rej).finally(() => { inflight--; pump(); });
    }
  }
  // the next lines in the order they will be said: voice them ahead (and before anything prefetched earlier)
  function prefetch(list) {
    const next = (list || []).filter(h => h && h.text && !h.started);
    for (let k = next.length - 1; k >= 0; k--) { const i = wantQ.indexOf(next[k]); if (i >= 0) wantQ.splice(i, 1); }
    for (const h of next) want(h, false);
    // move them in front of older prefetches (lines set aside or dropped)
    const mine = wantQ.filter(h => next.includes(h)), rest = wantQ.filter(h => !next.includes(h));
    wantQ.splice(0, wantQ.length, ...mine, ...rest);
  }

  async function play(h) {
    const myEpoch = epoch;
    const none = { duration: 0, done: Promise.resolve(), cancelled: true };
    if (!h || !h.text || cfg.mode === 'off') return none;
    if (!h.started) want(h, true);
    // wait for Kokoro (longer while the model is still loading); never switch to another voice
    const limit = status.state === 'loading' || serverState !== 'ready' ? 300000 : Math.max(60000, h.text.length * 400);
    let buf;
    try { buf = await withTimeout(h.audio, limit); }
    catch (e) {
      log(e.timeout ? 'kokoro audio not ready after ' + limit + 'ms: this line stays silent' : 'kokoro failed: ' + e.message + ' (this line stays silent)');
      return myEpoch === epoch ? silent(h.text) : none;
    }
    if (myEpoch !== epoch) return none;
    await whenResumed();
    if (myEpoch !== epoch) return none;
    let c = ensureCtx();
    let ok = await running(c);
    if (!ok && ctx !== c && ctx.state !== 'closed') { c = ctx; ok = await running(c); }   // rebuilt by a click meanwhile: use the new one
    if (!ok) {
      log('audio context is ' + c.state + ' (no sound possible until a click or key press): this line stays silent');
      setStatus('info', 'Click anywhere on the page to turn the sound on.');
      return myEpoch === epoch ? silent(h.text) : none;
    }
    if (status.state === 'info') setStatus('ready', '');
    if (myEpoch !== epoch) return none;
    const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    const finish = () => { if (current && current.src === src) { current = null; speakingNow = false; } doneResolve(); };
    src.onended = finish;
    current = { src, stop: () => { try { src.stop(); } catch {} speakingNow = false; doneResolve(); } };
    speakingNow = true;
    src.start();
    lastSource = 'kokoro-server';
    activeTimeout((buf.duration + 1.5) * 1000, finish);   // never wait forever for onended
    return { duration: buf.duration, done };
  }

  function pause() {
    if (paused) return; paused = true;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }
  function resume() {
    if (!paused) return; paused = false;
    if (ctx && ctx.state !== 'closed') resumeCtx(ctx);
    resumeWaiters.splice(0).forEach(f => f());
  }
  function stop() {
    epoch++;
    wantQ.length = 0;            // lines not started yet are voiced again when (if) they are played
    if (current) { const c = current; current = null; c.stop(); }
    speakingNow = false;
  }

  const VOICES = [
    ['af_bella', 'Bella (US, female)'], ['af_heart', 'Heart (US, female)'], ['af_nicole', 'Nicole (US, female, soft)'], ['af_sarah', 'Sarah (US, female)'],
    ['am_michael', 'Michael (US, male)'], ['am_fenrir', 'Fenrir (US, male)'], ['am_puck', 'Puck (US, male)'],
    ['bf_emma', 'Emma (UK, female)'], ['bf_isabella', 'Isabella (UK, female)'], ['bm_george', 'George (UK, male)'], ['bm_fable', 'Fable (UK, male)'],
  ];
  const voiceName = () => (VOICES.find(v => v[0] === cfg.voice) || [, cfg.voice])[1];

  // Which voice is (or will be) speaking, in plain words for the settings panel.
  function describe() {
    if (cfg.mode === 'off') return 'Narration is off.';
    if (serverState === 'unavailable') return `Kokoro · ${voiceName()} is not available on this computer, so the lesson has no sound.`;
    return serverState === 'ready' ? `Speaking with Kokoro · ${voiceName()}, generated on this computer.` : `Kokoro · ${voiceName()} on this computer, getting ready…`;
  }
  async function preview() {
    stop();
    return play(prepare(`Hi, I'm ${voiceName().split(' (')[0]}. Let's learn something together on the whiteboard.`));
  }

  return {
    configure, enabled, unlock, prepare, prefetch, play, stop, pause, resume, speakable, describe, preview,
    speaking: () => speakingNow,
    status: () => status,
    device: () => 'server',
    audioState: () => (ctx ? ctx.state : 'none'),
    source: () => lastSource,
    onStatus: f => { listeners.add(f); return () => listeners.delete(f); },
    VOICES,
  };
})();
