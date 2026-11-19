// Kokoro TTS in a Web Worker so speech synthesis never blocks the pen animation.
// The model (~90 MB for q8 on CPU, ~310 MB for fp32 on WebGPU) is downloaded once and cached by the browser.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null, loading = null, chain = Promise.resolve();

function load(device) {
  if (loading) return loading;
  const files = {};
  const progress = p => {
    if (p.status === 'progress' && p.file) {
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      let l = 0, t = 0; for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
      self.postMessage({ type: 'progress', loaded: l, total: t });
    }
  };
  const tryLoad = (dev, dtype) => KokoroTTS.from_pretrained(MODEL, { dtype, device: dev, progress_callback: progress });
  loading = (async () => {
    if (device === 'webgpu' && self.navigator && self.navigator.gpu) {
      try { tts = await tryLoad('webgpu', 'fp32'); return 'webgpu'; } catch (e) { /* fall back to CPU */ }
    }
    tts = await tryLoad('wasm', 'q8');
    return 'wasm';
  })();
  return loading;
}

// Kokoro works best on short inputs: split long text into sentence-sized chunks and join the audio.
function chunks(text) {
  const parts = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [text];
  const out = []; let cur = '';
  for (const p of parts) { if ((cur + p).length > 280 && cur) { out.push(cur.trim()); cur = p; } else cur += p; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    load(m.device).then(dev => self.postMessage({ type: 'ready', device: dev }))
      .catch(err => self.postMessage({ type: 'error', message: String(err && err.message || err) }));
  } else if (m.type === 'speak') {
    chain = chain.then(async () => {
      try {
        await load(m.device);
        const t0 = performance.now();
        const pieces = []; let sr = 24000, len = 0;
        for (const c of chunks(m.text)) {
          const a = await tts.generate(c, { voice: m.voice || 'af_bella', speed: m.speed || 1 });
          sr = a.sampling_rate; pieces.push(a.audio); len += a.audio.length;
        }
        const audio = new Float32Array(len); let off = 0;
        for (const p of pieces) { audio.set(p, off); off += p.length; }
        self.postMessage({ type: 'audio', id: m.id, audio, sr, genMs: performance.now() - t0 }, [audio.buffer]);
      } catch (err) {
        self.postMessage({ type: 'audio-error', id: m.id, message: String(err && err.message || err) });
      }
    });
  }
};
