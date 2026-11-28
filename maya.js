// Maya 2 Native, a natural Hindi / Hinglish voice, run by maya_server.py in a Python environment with mlx-audio
// (Apple Silicon only). Optional: without that environment, or with MAYA=off, Maya voices are unavailable and their
// lines fail (no other voice stands in). The Python process starts on first use, loads the model once and stays up.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PY = process.env.MAYA_PYTHON || path.join(__dirname, '.venv-maya', 'bin', 'python');
// all of Maya's voices are accepted; the settings list offers six of them
const VOICES = new Set(['Ahana', 'Vaidehi', 'Malini', 'Charvi', 'Jahnavi', 'Anirban', 'Nakul', 'Vasant', 'Siddhant', 'Satvik', 'Abhay', 'Nivedita', 'Ishwari', 'Ritvik', 'Vrinda', 'Sreekar', 'Kayal', 'Shaunak', 'Akshat', 'Tanushree']);
const m = { state: 'idle', error: '', proc: null, ready: null, pending: new Map(), seq: 0 };

const nameOf = voice => [...VOICES].find(v => 'my_' + v.toLowerCase() === voice);
const hasVoice = voice => !!nameOf(voice);
const installed = () => process.env.MAYA !== 'off' && fs.existsSync(PY);
function status() {
  if (m.state === 'idle' && !installed()) return { state: 'unavailable', error: 'Maya is not installed (see README: Natural Hindi voice)' };
  return { state: m.state, error: m.error };
}
const LOAD_MS = Number(process.env.MAYA_LOAD_TIMEOUT_MS) || 300000;   // first run downloads ~3 GB
const LINE_MS = 120000;   // one spoken line; longer means Maya is stuck
// the process is gone or stuck: fail everything waiting, and let the next request start it again
function fail(why) {
  if (!m.proc && !m.ready) return;
  console.warn('  Voice:', why);
  const p = m.proc; m.state = 'error'; m.error = why; m.proc = null; m.ready = null;
  for (const job of m.pending.values()) job.reject(new Error(why));
  m.pending.clear();
  if (m.rejectReady) m.rejectReady(new Error(why));
  if (p) try { p.kill('SIGKILL'); } catch {}
}
function start() {
  if (m.ready) return m.ready;
  if (!installed()) { m.state = 'unavailable'; m.error = 'Maya is not installed (see README: Natural Hindi voice)'; return Promise.reject(new Error(m.error)); }
  m.state = 'loading'; m.error = '';
  m.ready = new Promise((resolve, reject) => {
    m.rejectReady = reject;
    const p = m.proc = spawn(PY, ['-I', path.join(__dirname, 'maya_server.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let tail = '';
    const loading = setTimeout(() => fail(`Maya did not finish loading in ${LOAD_MS / 1000}s`), LOAD_MS);
    p.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
    p.stdin.on('error', e => fail('Maya stopped taking lines: ' + e.message));
    readline.createInterface({ input: p.stdout }).on('line', line => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.ready) { clearTimeout(loading); m.state = 'ready'; m.rejectReady = null; console.log('  Voice: Maya 2 ready (natural Hindi, generated on this computer)'); return resolve(); }
      const job = m.pending.get(j.id); if (!job) return;
      m.pending.delete(j.id); clearTimeout(job.timer);
      if (j.error) return job.reject(new Error(j.error));
      const b = Buffer.from(j.pcm, 'base64');
      job.resolve({ audio: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), sampling_rate: j.sr });
    });
    // a spawn failure emits 'error' and then 'close' (never 'exit'); a crash emits 'close' too
    p.on('error', e => { clearTimeout(loading); fail('Maya could not start: ' + e.message); });
    p.on('close', (code, signal) => {
      clearTimeout(loading);
      if (m.proc !== p) return;   // already failed (and killed) on purpose
      const last = tail.split(/[\r\n]/).filter(l => l.trim() && !/warning|unauthenticated|fetching|it\/s/i.test(l)).pop() || '';
      fail(`Maya stopped (${signal || 'exit ' + code})${last ? ': ' + last.slice(0, 200) : ''}`);
    });
  });
  m.ready.catch(() => {});
  return m.ready;
}
// voice: a Maya voice id from the app, "my_ishwari"; text: the line as written (Roman Hinglish, English or Hindi)
async function speak(text, voice) {
  const name = nameOf(voice); if (!name) throw new Error('unknown Maya voice ' + voice);
  await start();
  const id = ++m.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(`Maya took over ${LINE_MS / 1000}s for one line`), LINE_MS);
    m.pending.set(id, { resolve, reject, timer });
    // a line with Devanagari is read as Hindi (its English words included); Roman text (Hinglish or English) as English
    try { m.proc.stdin.write(JSON.stringify({ id, text, voice: name, lang: /[\u0900-\u097F]/.test(text) ? 'hi' : 'en' }) + '\n'); }
    catch (e) { m.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}
module.exports = { start, speak, status, installed, hasVoice };
