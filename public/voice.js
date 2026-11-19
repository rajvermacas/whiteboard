/* Narration engine for Whiteboard Teacher.
 * Modes: 'kokoro' (Kokoro-82M in a Web Worker, default voice af_bella), 'browser' (speechSynthesis), 'off'.
 * prepare(text) starts synthesis early so audio is ready when the pen reaches that step.
 * play(handle) resolves when audio starts, with {duration, done} so the caller can pace typing and drawing.
 */
window.Voice = (() => {
  'use strict';
  let cfg = { mode: 'kokoro', voice: 'af_bella', speed: 1, device: 'wasm' };
  let worker = null, workerReady = null, workerDevice = null, loadFailed = false;
  let ctx = null, current = null, epoch = 0, speakingNow = false, reqId = 0, slowCount = 0, tooSlow = false;
  const log = (...a) => { try { window.wbtLog && window.wbtLog('voice', ...a); } catch {} };
  const pending = new Map();      // id -> {resolve, reject}
  const cache = new Map();        // key -> Promise<AudioBuffer>
  const listeners = new Set();
  let status = { state: 'idle', text: '' };

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

  function ensureCtx() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function startWorker() {
    if (worker || loadFailed) return workerReady;
    try { worker = new Worker('tts-worker.js', { type: 'module' }); }
    catch (e) { loadFailed = true; setStatus('error', 'Voice model cannot run in this browser'); return Promise.reject(e); }
    setStatus('loading', 'Loading voice…');
    workerReady = new Promise((resolve, reject) => {
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress') {
          const pct = m.total ? Math.min(99, Math.round(m.loaded / m.total * 100)) : 0;
          setStatus('loading', `Downloading voice ${pct}% (first time only)`);
        } else if (m.type === 'ready') { workerDevice = m.device; setStatus('ready', ''); resolve(); }
        else if (m.type === 'error') { loadFailed = true; setStatus('error', 'Voice model failed to load: ' + m.message); reject(new Error(m.message)); }
        else if (m.type === 'audio' || m.type === 'audio-error') {
          const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
          if (m.type === 'audio') p.resolve(m); else p.reject(new Error(m.message));
        }
      };
      worker.onerror = e => {
        loadFailed = true; log('worker error', e.message);
        setStatus('error', 'Voice worker error: ' + (e.message || 'unknown'));
        for (const [, p] of pending) p.reject(new Error('voice worker crashed'));
        pending.clear(); reject(new Error(e.message));
      };
    });
    worker.postMessage({ type: 'load', device: cfg.device });
    return workerReady;
  }

  function synthKokoro(text) {
    const key = `${cfg.voice}|${cfg.speed}|${text}`;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      await startWorker();
      const id = ++reqId;
      const m = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'speak', id, text, voice: cfg.voice, speed: cfg.speed, device: cfg.device });
      });
      const c = ensureCtx();
      const dur = m.audio.length / m.sr;
      if (m.genMs && dur > 0.8) {
        slowCount = m.genMs / 1000 > dur * 1.1 ? slowCount + 1 : Math.max(0, slowCount - 1);
        log('generated', dur.toFixed(1) + 's audio in', (m.genMs / 1000).toFixed(1) + 's');
        if (slowCount >= 2 && workerDevice !== 'webgpu') markTooSlow();
      }
      const buf = c.createBuffer(1, m.audio.length, m.sr);
      buf.copyToChannel(m.audio, 0);
      return buf;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return p;
  }

  // Kokoro slower than real time would stall the lesson: switch to the browser voice for now.
  function markTooSlow() {
    if (tooSlow) return;
    tooSlow = true; log('kokoro too slow, using browser voice');
    setStatus('slow', 'The natural voice is too slow in this browser, so the browser\u2019s built-in voice is speaking instead. For the Kokoro voice, tick GPU in \u2699 (one-time 310 MB download), or use Chrome.');
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms))]);

  // ---- public API ----
  function configure(next) {
    const old = cfg; cfg = { ...cfg, ...next };
    if (old.device !== cfg.device && worker) {
      worker.terminate(); worker = null; workerReady = null; loadFailed = false; cache.clear();
      for (const [, p] of pending) p.reject(new Error('voice restarted')); pending.clear();
    }
    if (old.device !== cfg.device || old.mode !== cfg.mode) { tooSlow = false; slowCount = 0; }
    if (cfg.mode === 'kokoro') startWorker().catch(() => {});
    else setStatus('idle', '');
  }
  const enabled = () => cfg.mode !== 'off';
  function unlock() { if (cfg.mode === 'kokoro') ensureCtx(); }

  function prepare(text) {
    const clean = speakable(text);
    const h = { text: clean, raw: text, audio: null };
    if (!clean || cfg.mode !== 'kokoro' || loadFailed || tooSlow) return h;
    h.audio = synthKokoro(clean);
    h.audio.catch(() => {});
    return h;
  }

  function browserSpeak(text, myEpoch) {
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
      // some browsers drop onend: finish by an estimate so the lesson never stalls
      setTimeout(() => { speakingNow = false; doneResolve(); }, (text.length / (11 * u.rate) + 4) * 1000);
      current = { stop: () => { speechSynthesis.cancel(); doneResolve(); } };
      speakingNow = true;
      if (myEpoch !== epoch) { speakingNow = false; doneResolve(); return start(); }
      speechSynthesis.speak(u);
      setTimeout(start, 600); // some browsers never fire onstart
    });
  }

  // Resolves when the audio starts: {duration, done, cancelled?}
  async function play(h) {
    const myEpoch = epoch;
    const none = { duration: 0, done: Promise.resolve(), cancelled: true };
    if (!h || !h.text || cfg.mode === 'off') return none;
    if (cfg.mode === 'browser' || (cfg.mode === 'kokoro' && (loadFailed || tooSlow || !h.audio))) {
      if (cfg.mode === 'kokoro' && !loadFailed && !tooSlow && !h.audio) h.audio = synthKokoro(h.text);
      else return browserSpeak(h.text, myEpoch);
    }
    let buf;
    // wait a bounded time for the audio: longer while the model is still downloading
    const limit = status.state === 'loading' ? 90000 : Math.max(12000, h.text.length * 120);
    const t0 = performance.now();
    try { buf = await withTimeout(h.audio, limit); }
    catch (e) {
      log(e.timeout ? 'audio not ready after ' + limit + 'ms' : 'synthesis failed: ' + e.message);
      if (e.timeout) markTooSlow();
      return myEpoch === epoch ? browserSpeak(h.text, myEpoch) : none;
    }
    if (performance.now() - t0 > 8000 && status.state !== 'loading') slowCount++;
    if (myEpoch !== epoch) return none;
    const c = ensureCtx();
    const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    const finish = () => { if (current && current.src === src) { current = null; speakingNow = false; } doneResolve(); };
    src.onended = finish;
    current = { src, stop: () => { try { src.stop(); } catch {} speakingNow = false; doneResolve(); } };
    speakingNow = true;
    if (c.state !== 'running') { c.resume().catch(() => {}); log('audio context was', c.state); }
    src.start();
    // safety net: if the browser never reports the end (e.g. audio blocked), move on anyway
    setTimeout(finish, (buf.duration + 1.5) * 1000);
    return { duration: buf.duration, done };
  }

  function stop() {
    epoch++;
    if (current) { const c = current; current = null; c.stop(); }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    speakingNow = false;
  }

  return {
    configure, enabled, unlock, prepare, play, stop, speakable,
    speaking: () => speakingNow,
    status: () => status,
    device: () => workerDevice,
    onStatus: f => { listeners.add(f); return () => listeners.delete(f); },
    VOICES: [
      ['af_bella', 'Bella (US, female)'], ['af_heart', 'Heart (US, female)'], ['af_nicole', 'Nicole (US, female)'],
      ['am_michael', 'Michael (US, male)'], ['am_fenrir', 'Fenrir (US, male)'], ['bf_emma', 'Emma (UK, female)'], ['bm_george', 'George (UK, male)'],
    ],
  };
})();
