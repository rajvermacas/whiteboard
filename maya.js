// Maya 2 Native, a natural Hindi / Hinglish voice, run by maya_server.py in a Python environment with mlx-audio
// (Apple Silicon only). Optional: without that environment, or with MAYA=off, Maya voices fall back to Kokoro's
// Hindi voice. The Python process starts on first use, loads the model once and stays up.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PY = process.env.MAYA_PYTHON || path.join(__dirname, '.venv-maya', 'bin', 'python');
const VOICES = new Set(['Ahana', 'Vaidehi', 'Malini', 'Charvi', 'Jahnavi', 'Anirban', 'Nakul', 'Vasant', 'Siddhant', 'Satvik', 'Abhay', 'Nivedita', 'Ishwari', 'Ritvik', 'Vrinda', 'Sreekar', 'Kayal', 'Shaunak', 'Akshat', 'Tanushree']);
const m = { state: 'idle', error: '', proc: null, ready: null, pending: new Map(), seq: 0 };

const nameOf = voice => [...VOICES].find(v => 'my_' + v.toLowerCase() === voice);
const hasVoice = voice => !!nameOf(voice);
const installed = () => process.env.MAYA !== 'off' && fs.existsSync(PY);
function status() {
  if (m.state === 'idle' && !installed()) return { state: 'unavailable', error: 'Maya is not installed (see README: Natural Hindi voice)' };
  return { state: m.state, error: m.error };
}
function start() {
  if (m.ready) return m.ready;
  if (!installed()) { m.state = 'unavailable'; m.error = 'Maya is not installed (see README: Natural Hindi voice)'; return Promise.reject(new Error(m.error)); }
  m.state = 'loading'; m.error = '';
  m.ready = new Promise((resolve, reject) => {
    const p = m.proc = spawn(PY, ['-I', path.join(__dirname, 'maya_server.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let tail = '';
    p.stderr.on('data', d => { tail = (tail + d).slice(-600); });
    readline.createInterface({ input: p.stdout }).on('line', line => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.ready) { m.state = 'ready'; console.log('  Voice: Maya 2 ready (natural Hindi, generated on this computer)'); return resolve(); }
      const job = m.pending.get(j.id); if (!job) return;
      m.pending.delete(j.id);
      if (j.error) return job.reject(new Error(j.error));
      const b = Buffer.from(j.pcm, 'base64');
      job.resolve({ audio: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), sampling_rate: j.sr });
    });
    p.on('error', e => { m.error = String(e.message || e); });
    p.on('exit', code => {
      // a crash (or a failed load) fails what was waiting; the next request starts it again
      const why = m.error || `Maya stopped (exit ${code}): ${tail.trim().split('\n').pop() || ''}`;
      console.warn('  Voice:', why);
      m.state = 'error'; m.error = why; m.proc = null; m.ready = null;
      for (const job of m.pending.values()) job.reject(new Error(why));
      m.pending.clear(); reject(new Error(why));
    });
  });
  m.ready.catch(() => {});
  return m.ready;
}
// voice: a Maya voice id from the app, "my_ishwari"; text: the line, Hindi in Devanagari
async function speak(text, voice) {
  await start();
  const name = nameOf(voice); if (!name) throw new Error('unknown Maya voice ' + voice);
  const id = ++m.seq;
  return new Promise((resolve, reject) => {
    m.pending.set(id, { resolve, reject });
    m.proc.stdin.write(JSON.stringify({ id, text, voice: name, lang: 'hi' }) + '\n');
  });
}
module.exports = { start, speak, status, installed, hasVoice };
