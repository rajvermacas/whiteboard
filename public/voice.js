/* Narration engine for Whiteboard Teacher.
 * Modes: 'kokoro' (Kokoro-82M in a Web Worker, default voice af_bella), 'browser' (speechSynthesis), 'off'.
 * prepare(text) starts synthesis early so audio is ready when the pen reaches that step.
 * play(handle) resolves when audio starts, with {duration, done} so the caller can pace typing and drawing.
 */
window.Voice = (() => {
  'use strict';
  let cfg = { mode: 'kokoro', voice: 'af_bella', speed: 1, device: 'wasm' };
  let worker = null, workerReady = null, workerDevice = null, loadFailed = false;
  let ctx = null, current = null, epoch = 0, speakingNow = false, reqId = 0, slowCount = 0;
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
      worker.onerror = e => { loadFailed = true; setStatus('error', 'Voice worker error: ' + (e.message || 'unknown')); reject(new Error(e.message)); };
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
        if (slowCount >= 2 && workerDevice !== 'webgpu' && status.state !== 'slow') setStatus('slow', 'The voice is generating slower than it speaks on this computer, so the lesson will pause between sentences. For smooth narration, tick GPU in ⚙ (one-time 310 MB download).');
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

  // ---- public API ----
  function configure(next) {
    const old = cfg; cfg = { ...cfg, ...next };
    if (old.device !== cfg.device && worker) { worker.terminate(); worker = null; workerReady = null; loadFailed = false; cache.clear(); }
    if (cfg.mode === 'kokoro') startWorker().catch(() => {});
    else setStatus('idle', '');
  }
  const enabled = () => cfg.mode !== 'off';
  function unlock() { if (cfg.mode === 'kokoro') ensureCtx(); }

  function prepare(text) {
    const clean = speakable(text);
    const h = { text: clean, raw: text, audio: null };
    if (!clean || cfg.mode !== 'kokoro' || loadFailed) return h;
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
    if (cfg.mode === 'browser' || (cfg.mode === 'kokoro' && (loadFailed || !h.audio))) {
      if (cfg.mode === 'kokoro' && !loadFailed && !h.audio) h.audio = synthKokoro(h.text);
      else return browserSpeak(h.text, myEpoch);
    }
    let buf;
    try { buf = await h.audio; }
    catch { return myEpoch === epoch ? browserSpeak(h.text, myEpoch) : none; }
    if (myEpoch !== epoch) return none;
    const c = ensureCtx();
    const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    src.onended = () => { if (current && current.src === src) { current = null; speakingNow = false; } doneResolve(); };
    current = { src, stop: () => { try { src.stop(); } catch {} doneResolve(); } };
    speakingNow = true;
    src.start();
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
