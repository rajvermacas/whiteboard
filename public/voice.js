/* Narration engine for Whiteboard Teacher.
 * Two engines, both generated on this computer by the app's server (/api/tts): Kokoro, and Maya 2 (natural Hindi,
 * for Hinglish; voices my_…). There is no fallback voice: if the chosen engine is not ready or fails, the line is
 * silent (the lesson keeps its pace) and the status says why.
 * prepare(text) starts synthesis early so audio is ready when the pen reaches that step.
 * play(handle) resolves when audio starts, with {duration, done} so the caller can pace typing and drawing.
 */
window.Voice = (() => {
  'use strict';
  let cfg = { mode: 'kokoro', voice: 'my_vrinda', engine: 'server' };
  // Lesson speed: at 1× Kokoro speaks at BASE_SPEED. A faster lesson speeds the voice up: a new line is made at
  // BASE_SPEED × rate (Kokoro's own pace sounds most natural); a line made at another rate, a Maya line (one speed only),
  // or a sentence the speed changes in the middle of is time-stretched (pitch kept) so it plays at that rate.
  // A slower lesson never slows the voice (drawn-out speech sounds mechanical): the teacher talks at the natural pace
  // and the lesson clock gives the extra time to the pen and the pauses, so `rate` here is never below 1.
  const BASE_SPEED = 0.85;
  let rate = 1;
  let serverState = 'unknown';         // unknown | loading | ready | unavailable
  let ctx = null, current = null, epoch = 0, speakingNow = false, lastSource = '';
  const cache = new Map(), listeners = new Set();
  let status = { state: 'idle', text: '' };
  let failStreak = 0, narrErr = false;   // lines in a row that failed to synthesize; narrErr: the status shows that failure
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
        const r = await fetch('/api/tts/status?voice=' + encodeURIComponent(cfg.voice)); const j = await r.json();
        if (j.state === 'ready') { serverState = 'ready'; failStreak = 0; narrErr = false; setStatus('ready', ''); break; }   // a healthy server check also clears a narration error
        if (j.state === 'unavailable' || j.state === 'error') {
          serverState = 'unavailable'; log('server voice unavailable:', j.error);
          if (cfg.mode === 'kokoro') setStatus('error', isMaya()
            ? (j.state === 'unavailable' ? 'Maya is not installed on this computer (see the README, "Natural Hindi voice"). The lesson goes on without sound.' : 'Maya failed (' + (j.error || 'unknown error') + '). The lesson goes on without sound.')
            : j.state === 'unavailable'
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
  async function synth(text, speed) {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: cfg.voice, speed }) });
    if (r.status === 501) { serverState = 'unavailable'; checkServer(); throw new Error(engine() + ' is not available on the server'); }
    if (!r.ok) throw new Error('server voice error ' + r.status);
    const genMs = Number(r.headers.get('X-Gen-Ms') || 0);
    const arr = await r.arrayBuffer();
    const c = ensureCtx();
    const buf = await new Promise((res, rej) => { const p = c.decodeAudioData(arr, res, rej); if (p && p.catch) p.catch(rej); });
    if (genMs && buf.duration > 0.8) log(engine() + ' generated', buf.duration.toFixed(1) + 's audio in', (genMs / 1000).toFixed(1) + 's');
    return buf;
  }
  // resolves to {buf, g}: g is the lesson rate the audio was made for (its length at 1× is buf.duration × g)
  function synthKokoro(text) {
    const speed = isMaya() ? 1 : Math.round(Math.min(2, Math.max(0.5, BASE_SPEED * rate)) * 1000) / 1000;   // the server's range
    const g = isMaya() ? 1 : speed / BASE_SPEED;
    const key = `${cfg.voice}|${speed}|${text}`;
    if (cache.has(key)) return cache.get(key);
    const p = synth(text, speed).then(buf => ({ buf, g }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return p;
  }
  // WSOLA time-stretch: play buf `factor`× faster (factor < 1 slower) without changing its pitch. Each 32 ms frame is
  // taken near where it should be, at the offset that lines up best with where the previous frame would carry on.
  const stretched = new WeakMap();
  function stretchBuf(buf, factor) {
    if (Math.abs(factor - 1) < 0.01) return buf;
    const key = Math.round(factor * 1000);
    let m = stretched.get(buf); if (!m) stretched.set(buf, m = new Map());
    if (m.has(key)) return m.get(key);
    const sr = buf.sampleRate, N = Math.round(sr * 0.032) & ~1, Hs = N >> 1, Ha = Hs * factor, tol = Math.round(sr * 0.008);
    const inLen = buf.length, outLen = Math.max(1, Math.ceil(inLen / factor));
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: outLen, sampleRate: sr });
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const x = buf.getChannelData(0), last = Math.max(0, inLen - N);
    const chans = Array.from({ length: buf.numberOfChannels }, (_, k) => [buf.getChannelData(k), out.getChannelData(k)]);
    let prev = 0;
    for (let k = 0, o = 0; o < outLen; k++, o += Hs) {
      let pos = Math.min(last, Math.round(k * Ha));
      if (k > 0) {
        const nat = prev + Hs, lo = Math.max(0, pos - tol), hi = Math.min(last, pos + tol), n = Math.min(N, inLen - nat);
        let best = -Infinity;
        for (let d = lo; d <= hi; d += 2) { let s = 0; for (let i = 0; i < n; i += 4) s += x[d + i] * x[nat + i]; if (s > best) { best = s; pos = d; } }
      }
      const n = Math.min(N, outLen - o, inLen - pos);
      for (const [src, dst] of chans) for (let i = 0; i < n; i++) dst[o + i] += win[i] * src[pos + i];
      prev = pos;
    }
    m.set(key, out);
    return out;
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms))]);
  // a line that cannot be spoken: no other voice steps in, the lesson keeps its pace in silence
  const silent = text => ({ duration: text.length / 14, done: Promise.resolve(), silent: true });

  // ---------- public API ----------
  function configure(next) {
    const was = engine();
    cfg = { ...cfg, ...next, engine: 'server' };
    if (engine() !== was) { serverState = 'unknown'; failStreak = 0; narrErr = false; }   // the other engine has its own state
    if (cfg.mode !== 'kokoro') { cfg.mode = cfg.mode === 'off' ? 'off' : 'kokoro'; }
    if (cfg.mode === 'off') { stop(); failStreak = 0; narrErr = false; setStatus('idle', ''); return; }   // Off silences the sentence being said, like the 🔊 button
    if (serverState !== 'ready') checkServer();
  }
  const enabled = () => cfg.mode !== 'off';
  function unlock() { if (cfg.mode === 'kokoro') unlockAudio(); }

  // Lines are voiced on demand, not all at once: the server's Kokoro makes one line at a time, so voicing every
  // line as it streams in would put a long queue in front of anything said next (a double-click's answer, a side
  // question). Only the line about to play and the next few (prefetch) are made, and a line that must play now
  // jumps to the front.
  const wantQ = []; let inflight = 0; const MAX_INFLIGHT = 1;   // one at a time: a line that must play next waits for at most one other
  const isMaya = () => cfg.voice.startsWith('my_');
  const engine = () => isMaya() ? 'Maya 2' : 'Kokoro';
  function prepare(text) {
    return { text: speakable(text), raw: text, audio: null, started: false };
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

  // from: start this many seconds into the line (a sentence cut short by looking back carries on where it stopped)
  async function play(h, from = 0) {
    const myEpoch = epoch;
    const none = { duration: 0, done: Promise.resolve(), cancelled: true };
    if (!h || !h.text || cfg.mode === 'off') return none;
    if (!h.started) want(h, true);
    // wait for Kokoro (longer while the model is still loading); never switch to another voice
    const limit = status.state === 'loading' || serverState !== 'ready' ? 300000 : Math.max(60000, h.text.length * 400);
    let buf, g;
    try { ({ buf, g } = await withTimeout(h.audio, limit)); }
    catch (e) {
      log(e.timeout ? 'kokoro audio not ready after ' + limit + 'ms: this line stays silent' : 'kokoro failed: ' + e.message + ' (this line stays silent)');
      if (myEpoch !== epoch) return none;   // stopped, Off or replaced meanwhile: a cancelled line is not a failure
      // one failure may be a blip; two in a row say the voice is down, so say so (the lesson still goes on in silence)
      if (++failStreak >= 2 && !narrErr) { narrErr = true; setStatus('error', e.timeout ? 'Narration failed: the voice is taking too long to make audio. The lesson goes on without sound.' : 'Narration failed: could not make audio for recent lines (' + e.message + '). The lesson goes on without sound.'); }
      return silent(h.text);
    }
    if (myEpoch !== epoch) return none;
    failStreak = 0; if (narrErr || serverState === 'unavailable') { narrErr = false; serverState = 'ready'; setStatus('ready', ''); }   // it spoke again: clear the error
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
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    from = Math.min(Math.max(0, from || 0), Math.max(0, buf.duration - 0.05));
    current = { h, c, buf, g, done: doneResolve, stop() { try { this.src.stop(); } catch {} speakingNow = false; doneResolve(); } };
    speakingNow = true;
    startAt(current, from);
    lastSource = isMaya() ? 'maya-server' : 'kokoro-server';
    // the duration is in lesson time (its length at 1×): the caller paces drawing and typing on the lesson clock
    return { duration: (buf.duration - from) * g, done };
  }
  // (re)start the current line at `from` seconds into its audio, at the lesson rate
  function startAt(cur, from) {
    const k = rate / cur.g, src = cur.c.createBufferSource();
    src.buffer = stretchBuf(cur.buf, k); src.connect(cur.c.destination);
    const finish = () => { if (current === cur && cur.src === src) { current = null; speakingNow = false; cur.done(); } };
    src.onended = finish;
    Object.assign(cur, { src, k, from, t0: cur.c.currentTime });
    src.start(0, from / k);
    activeTimeout(((cur.buf.duration - from) / k + 1.5) * 1000, finish);   // never wait forever for onended
  }
  // how far into its audio the current line is (the audio clock stands still while paused)
  const at = cur => cur.from + (cur.c.currentTime - cur.t0) * cur.k;
  // a held J / L sends a step every ~30 ms: the line is restarted (and stretched) once the steps stop for a moment
  let rateTimer = null;
  function setRate(lessonRate) {
    const r = Math.max(1, lessonRate);
    if (r === rate) return;
    rate = r;
    clearTimeout(rateTimer); rateTimer = setTimeout(restartAtRate, 120);
  }
  function restartAtRate() {
    const cur = current;
    if (!cur || cur.k === rate / cur.g) return;
    // its audio context was closed (Safari rebuilt it): that line cannot play on, so it ends here
    if (cur.c.state === 'closed') { log('speed change: the line\'s audio context is closed, it ends here'); current = null; speakingNow = false; cur.done(); return; }
    const pos = at(cur), old = cur.src;
    old.onended = null; try { old.stop(); } catch {}
    if (pos >= cur.buf.duration - 0.02) { current = null; speakingNow = false; cur.done(); return; }
    startAt(cur, pos);
    // the drawing of this line keeps to where the voice really is (the clock changed speed up to 120 ms earlier)
    resyncers.forEach(f => f((cur.buf.duration - pos) * cur.g));
  }
  const resyncers = new Set();

  function pause() {
    if (paused) return; paused = true;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }
  function resume() {
    if (!paused) return; paused = false;
    if (ctx && ctx.state !== 'closed') resumeCtx(ctx);
    resumeWaiters.splice(0).forEach(f => f());
  }
  // how far into its line the voice is (the clock stands still while paused)
  function position() { return current && current.h ? { h: current.h, at: at(current) } : null; }
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
    ['my_ishwari', 'Ishwari (Maya, female)'], ['my_vrinda', 'Vrinda (Maya, female)'], ['my_nivedita', 'Nivedita (Maya, female)'],
    ['my_ritvik', 'Ritvik (Maya, male)'], ['my_abhay', 'Abhay (Maya, male)'], ['my_shaunak', 'Shaunak (Maya, male)'],
  ];
  const voiceName = () => (VOICES.find(v => v[0] === cfg.voice) || [, cfg.voice])[1];

  // Which voice is (or will be) speaking, in plain words for the settings panel.
  function describe() {
    if (cfg.mode === 'off') return 'Narration is off.';
    const e = engine();
    if (serverState === 'unavailable') return `${e} · ${voiceName()} is not available on this computer, so the lesson has no sound.`;
    if (narrErr) return `${e} · ${voiceName()} had no sound for recent lines.`;
    return serverState === 'ready' ? `Speaking with ${e} · ${voiceName()}, generated on this computer.` : `${e} · ${voiceName()} on this computer, getting ready…`;
  }
  // The preview plays on its own audio context: a paused lesson holds every line on the lesson's context until it
  // goes on (so a preview would wait forever), and the paused sentence must stay as it is. Call it from the click
  // itself: Safari only lets a context start inside a gesture.
  let pv = null, pvSrc = null;
  async function preview() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!pv || pv.state === 'closed') pv = new AC();
    pv.resume().catch(() => {});
    if (pvSrc) { try { pvSrc.stop(); } catch {} pvSrc = null; }
    if (!paused) stop();   // a lesson that is talking makes way; a paused one keeps its sentence
    const name = voiceName().split(' (')[0];
    const text = speakable(isMaya() ? `Namaste, main ${name} hoon. Chaliye whiteboard pe saath mein kuch naya seekhte hain.` : `Hi, I'm ${name}. Let's learn something together on the whiteboard.`);
    const got = await withTimeout(synthKokoro(text), 120000), buf = stretchBuf(got.buf, rate / got.g);   // at the lesson speed
    const src = pvSrc = pv.createBufferSource(); src.buffer = buf; src.connect(pv.destination);
    const done = new Promise(r => { src.onended = r; setTimeout(r, (buf.duration + 1.5) * 1000); });
    src.start(0);
    return { duration: buf.duration, done };
  }

  return {
    configure, enabled, unlock, prepare, prefetch, play, stop, position, pause, resume, speakable, describe, preview, setRate,
    speaking: () => speakingNow,
    status: () => status,
    device: () => 'server',
    audioState: () => (ctx ? ctx.state : 'none'),
    source: () => lastSource,
    onStatus: f => { listeners.add(f); return () => listeners.delete(f); },
    onResync: f => { resyncers.add(f); return () => resyncers.delete(f); },   // f(lesson seconds left in the line being said)
    VOICES,
  };
})();
