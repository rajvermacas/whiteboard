/* Narration engine for Whiteboard Teacher.
 * Voice sources, best first:
 *   1. Kokoro on the local server (/api/tts): native, uses every CPU core, works in every browser.
 *   2. Kokoro in the browser (Web Worker, CPU or WebGPU): used when the server has no voice installed.
 *   3. The browser's built-in speech: used when Kokoro is unavailable or too slow to keep up.
 * prepare(text) starts synthesis early so audio is ready when the pen reaches that step.
 * play(handle) resolves when audio starts, with {duration, done} so the caller can pace typing and drawing.
 */
window.Voice = (() => {
  'use strict';
  let cfg = { mode: 'kokoro', voice: 'af_bella', speed: 1, engine: 'server' };
  let serverState = 'unknown';         // unknown | loading | ready | unavailable
  let worker = null, workerReady = null, workerDevice = null, loadFailed = false;
  let ctx = null, current = null, epoch = 0, speakingNow = false, reqId = 0, slowCount = 0, tooSlow = false, lastSource = '';
  const pending = new Map(), cache = new Map(), listeners = new Set();
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
  function ensureCtx() {
    if (!ctx || ctx.state === 'closed') newCtx();
    if (ctx && ctx.state !== 'running' && !paused) ctx.resume().catch(() => {});
    return ctx;
  }
  // called from a click / key press: the only moment Safari lets audio start
  function unlockAudio() {
    if (paused) return;   // a click while paused must not restart the audio
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && ctx._gestured) newCtx();   // a resume in an earlier gesture didn't take
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
  const INSTALL_HINT = 'The fast voice isn’t installed yet: run npm install in the project folder, then restart the server. Using the slower in-browser voice for now.';
  const useServer = () => cfg.engine === 'server' && serverState !== 'unavailable';

  // ---------- 1. Kokoro on the local server ----------
  let polling = false;
  async function checkServer() {
    if (polling) return; polling = true;
    try {
      for (let i = 0; i < 900; i++) {
        const r = await fetch('/api/tts/status'); const j = await r.json();
        if (j.state === 'ready') { serverState = 'ready'; if (cfg.engine === 'server' && status.state !== 'slow') setStatus('ready', ''); break; }
        if (j.state === 'unavailable' || j.state === 'error') {
          serverState = 'unavailable'; log('server voice unavailable:', j.error);
          if (cfg.engine === 'server' && cfg.mode === 'kokoro') { setStatus('info', INSTALL_HINT); startWorker().catch(() => {}); }
          break;
        }
        serverState = 'loading';
        if (cfg.engine === 'server') setStatus('loading', j.progress ? `Preparing the voice on this computer ${j.progress}% (first time only)` : 'Preparing the voice on this computer…');
        await new Promise(r2 => setTimeout(r2, 1000));
      }
    } catch (e) { log('status check failed', String(e)); }
    polling = false;
  }
  async function synthServer(text) {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: cfg.voice, speed: cfg.speed }) });
    if (r.status === 501) { serverState = 'unavailable'; checkServer(); throw Object.assign(new Error('server voice unavailable'), { fallback: true }); }
    if (!r.ok) throw new Error('server voice error ' + r.status);
    const genMs = Number(r.headers.get('X-Gen-Ms') || 0);
    const arr = await r.arrayBuffer();
    const c = ensureCtx();
    const buf = await new Promise((res, rej) => { const p = c.decodeAudioData(arr, res, rej); if (p && p.catch) p.catch(rej); });
    trackSpeed(genMs, buf.duration, 'server');
    return buf;
  }

  // ---------- 2. Kokoro in the browser ----------
  function startWorker() {
    if (worker || loadFailed) return workerReady || Promise.reject(new Error('no worker'));
    try { worker = new Worker('tts-worker.js', { type: 'module' }); }
    catch (e) { loadFailed = true; setStatus('error', 'The voice model cannot run in this browser.'); return Promise.reject(e); }
    if (!useServer() && status.state !== 'info') setStatus('loading', 'Loading voice…');
    workerReady = new Promise((resolve, reject) => {
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress') {
          const pct = m.total ? Math.min(99, Math.round(m.loaded / m.total * 100)) : 0;
          if (status.state === 'info') setStatus('info', INSTALL_HINT + ` Downloading it into the browser: ${pct}%.`);
          else if (!useServer()) setStatus('loading', `Downloading voice into the browser ${pct}% (first time only)`);
        } else if (m.type === 'ready') { workerDevice = m.device; if (status.state === 'info') setStatus('info', INSTALL_HINT); else if (!useServer()) setStatus('ready', ''); resolve(); }
        else if (m.type === 'error') { loadFailed = true; setStatus('error', 'The voice model failed to load: ' + m.message); reject(new Error(m.message)); }
        else if (m.type === 'audio' || m.type === 'audio-error') {
          const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
          if (m.type === 'audio') p.resolve(m); else p.reject(new Error(m.message));
        }
      };
      worker.onerror = e => {
        loadFailed = true; log('worker error', e.message);
        setStatus('error', 'The voice worker crashed: ' + (e.message || 'unknown'));
        for (const [, p] of pending) p.reject(new Error('voice worker crashed'));
        pending.clear(); reject(new Error(e.message));
      };
    });
    worker.postMessage({ type: 'load', device: cfg.engine === 'webgpu' ? 'webgpu' : 'wasm' });
    return workerReady;
  }
  async function synthWorker(text) {
    await startWorker();
    const id = ++reqId;
    const m = await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ type: 'speak', id, text, voice: cfg.voice, speed: cfg.speed, device: cfg.engine === 'webgpu' ? 'webgpu' : 'wasm' }); });
    const c = ensureCtx();
    const buf = c.createBuffer(1, m.audio.length, m.sr); buf.copyToChannel(m.audio, 0);
    trackSpeed(m.genMs, buf.duration, 'browser');
    return buf;
  }

  function trackSpeed(genMs, dur, where) {
    if (!genMs || dur < 0.8) return;
    log(where, 'generated', dur.toFixed(1) + 's audio in', (genMs / 1000).toFixed(1) + 's');
    slowCount = genMs / 1000 > dur * 1.1 ? slowCount + 1 : Math.max(0, slowCount - 1);
    if (slowCount >= 2) markTooSlow(where);
  }
  function markTooSlow(where) {
    if (tooSlow) return;
    tooSlow = true; log('kokoro too slow (' + where + '), using the browser voice');
    setStatus('slow', where === 'server'
      ? 'The natural voice is generating slower than it speaks on this computer, so the browser’s built-in voice is speaking instead. Press Preview in ⚙ to try the natural voice again.'
      : 'The natural voice is too slow inside this browser, so the browser’s built-in voice is speaking instead. For the fast natural voice, run npm install in the project folder and restart the server.');
  }

  function synthKokoro(text) {
    const key = `${useServer() ? 'server' : cfg.engine}|${cfg.voice}|${cfg.speed}|${text}`;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      if (useServer()) {
        try { return await synthServer(text); }
        catch (e) { if (!e.fallback) throw e; }
      }
      return synthWorker(text);
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return p;
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms))]);

  // ---------- 3. the browser's built-in voice ----------
  function browserSpeak(text, myEpoch) {
    lastSource = 'browser';
    return new Promise(resolveStart => {
      if (!('speechSynthesis' in window)) return resolveStart({ duration: text.length / 14, done: Promise.resolve() });
      const u = new SpeechSynthesisUtterance(text);
      const vs = speechSynthesis.getVoices();
      const pick = vs.find(v => /samantha|ava|allison|zira|jenny|aria/i.test(v.name) && /^en/i.test(v.lang)) || vs.find(v => /^en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang));
      if (pick) u.voice = pick;
      u.rate = Math.max(0.6, Math.min(1.6, cfg.speed));
      let doneResolve; const done = new Promise(r => { doneResolve = r; });
      let started = false;
      const start = () => { if (started) return; started = true; resolveStart({ duration: text.length / (14 * u.rate), done }); };
      u.onstart = start;
      u.onend = u.onerror = () => { speakingNow = false; doneResolve(); start(); };
      activeTimeout((text.length / (11 * u.rate) + 4) * 1000, () => { speakingNow = false; doneResolve(); });
      current = { stop: () => { speechSynthesis.cancel(); doneResolve(); } };
      speakingNow = true;
      if (myEpoch !== epoch) { speakingNow = false; doneResolve(); return start(); }
      speechSynthesis.speak(u);
      setTimeout(start, 600);
    });
  }

  // ---------- public API ----------
  function configure(next) {
    const old = cfg; cfg = { ...cfg, ...next };
    if (!['server', 'wasm', 'webgpu'].includes(cfg.engine)) cfg.engine = 'server';
    const changed = Object.keys(cfg).some(k => cfg[k] !== old[k]);
    if (changed) { tooSlow = false; slowCount = 0; }                       // any change gives the natural voice another chance
    if (old.engine !== cfg.engine && worker && ((old.engine === 'webgpu') !== (cfg.engine === 'webgpu'))) {
      worker.terminate(); worker = null; workerReady = null; loadFailed = false;
      for (const [, p] of pending) p.reject(new Error('voice restarted')); pending.clear();
    }
    if (cfg.mode !== 'kokoro') { setStatus('idle', ''); return; }
    if (changed && status.state === 'slow') setStatus('idle', '');
    if (cfg.engine === 'server') {
      if (serverState === 'unavailable') { setStatus('info', INSTALL_HINT); startWorker().catch(() => {}); }
      else checkServer();
    } else startWorker().catch(() => {});
  }
  const enabled = () => cfg.mode !== 'off';
  function unlock() { if (cfg.mode === 'kokoro') unlockAudio(); }

  function prepare(text) {
    const clean = speakable(text);
    const h = { text: clean, raw: text, audio: null };
    if (!clean || cfg.mode !== 'kokoro' || tooSlow || (loadFailed && !useServer())) return h;
    h.audio = synthKokoro(clean); h.audio.catch(() => {});
    return h;
  }

  async function play(h) {
    const myEpoch = epoch;
    const none = { duration: 0, done: Promise.resolve(), cancelled: true };
    if (!h || !h.text || cfg.mode === 'off') return none;
    if (cfg.mode === 'browser' || tooSlow || (loadFailed && !useServer())) return browserSpeak(h.text, myEpoch);
    if (!h.audio) h.audio = synthKokoro(h.text);
    // bounded wait: longer while a model is still downloading
    const limit = status.state === 'loading' ? 120000 : Math.max(12000, h.text.length * 120);
    const t0 = performance.now();
    let buf;
    try { buf = await withTimeout(h.audio, limit); }
    catch (e) {
      log(e.timeout ? 'audio not ready after ' + limit + 'ms' : 'synthesis failed: ' + e.message);
      if (e.timeout) markTooSlow(useServer() ? 'server' : 'browser');
      return myEpoch === epoch ? browserSpeak(h.text, myEpoch) : none;
    }
    if (performance.now() - t0 > 8000 && status.state !== 'loading') { slowCount++; if (slowCount >= 2) markTooSlow(useServer() ? 'server' : 'browser'); }
    if (myEpoch !== epoch) return none;
    await whenResumed();
    if (myEpoch !== epoch) return none;
    const c = ensureCtx();
    if (!(await running(c))) {
      // never "play" into a muted context: speak with the browser voice and say why in the log
      log('audio context is ' + c.state + ' (no sound possible until a click or key press): using the browser voice for this line');
      return myEpoch === epoch ? browserSpeak(h.text, myEpoch) : none;
    }
    if (myEpoch !== epoch) return none;
    const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    const finish = () => { if (current && current.src === src) { current = null; speakingNow = false; } doneResolve(); };
    src.onended = finish;
    current = { src, stop: () => { try { src.stop(); } catch {} speakingNow = false; doneResolve(); } };
    speakingNow = true;
    src.start();
    lastSource = useServer() ? 'kokoro-server' : 'kokoro-browser';
    activeTimeout((buf.duration + 1.5) * 1000, finish);   // never wait forever for onended
    return { duration: buf.duration, done };
  }

  function pause() {
    if (paused) return; paused = true;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.pause();
  }
  function resume() {
    if (!paused) return; paused = false;
    if (ctx && ctx.state !== 'closed') ctx.resume().catch(() => {});
    if ('speechSynthesis' in window) speechSynthesis.resume();
    resumeWaiters.splice(0).forEach(f => f());
  }
  function stop() {
    epoch++;
    if (current) { const c = current; current = null; c.stop(); }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
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
    if (cfg.mode === 'browser') return 'Speaking with the browser’s built-in voice.';
    if (tooSlow) return `Using the browser’s built-in voice for now (Kokoro was too slow). Press Preview or change a setting to try ${voiceName()} again.`;
    if (useServer()) return serverState === 'ready' ? `Speaking with Kokoro · ${voiceName()}, generated on this computer (fast).` : `Kokoro · ${voiceName()} on this computer, getting ready…`;
    return `Speaking with Kokoro · ${voiceName()} inside the browser (${cfg.engine === 'webgpu' ? 'GPU' : 'CPU'}${loadFailed ? ', failed to load' : ''}).`;
  }
  async function preview() {
    stop(); tooSlow = false; slowCount = 0;
    if (status.state === 'slow') setStatus(useServer() && serverState === 'ready' ? 'ready' : 'idle', '');
    return play(prepare(`Hi, I'm ${voiceName().split(' (')[0]}. Let's learn something together on the whiteboard.`));
  }

  return {
    configure, enabled, unlock, prepare, play, stop, pause, resume, speakable, describe, preview,
    speaking: () => speakingNow,
    status: () => status,
    device: () => (useServer() ? 'server' : workerDevice),
    audioState: () => (ctx ? ctx.state : 'none'),
    source: () => lastSource,
    onStatus: f => { listeners.add(f); return () => listeners.delete(f); },
    VOICES,
  };
})();
