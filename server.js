// Whiteboard Teacher — local server
// Serves the app from ./public and proxies LLM calls to OpenCode Go and/or OpenRouter, so the API keys never
// reach the browser.
// Zero dependencies: needs Node 18+ (uses built-in fetch). Run: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- .env loader (tiny, no dependency) ----------
function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* no .env file is fine */ }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.OPENCODE_API_KEY || '';
const API_BASE = (process.env.OPENCODE_GO_API_BASE || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
// OpenRouter (optional). Its models appear in the picker as "or:<slug>". OPENROUTER_PROVIDER pins which provider
// serves OPENROUTER_MODEL (comma list, tried in order); with OPENROUTER_ALLOW_FALLBACKS=false no other is used.
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_BASE = (process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const OR_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash';
const OR_PROVIDER = (process.env.OPENROUTER_PROVIDER ?? 'baidu/fp8').split(',').map(x => x.trim()).filter(Boolean);
const OR_FALLBACKS = /^(1|true|yes)$/i.test(process.env.OPENROUTER_ALLOW_FALLBACKS || 'false');
const OR_EXTRA = (process.env.OPENROUTER_MODELS || '').split(',').map(x => x.trim()).filter(Boolean);
const OR_PREFIX = 'or:';
const isOR = id => typeof id === 'string' && id.startsWith(OR_PREFIX);
// default: the OpenRouter model when an OpenRouter key is set, else OpenCode Go's DeepSeek V4.1 Flash
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || (OR_KEY ? OR_PREFIX + OR_MODEL : 'deepseek-v4.1-flash');
const USER_AGENT = 'whiteboard-teacher/1.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (typeof fetch !== 'function') {
  console.error(`\n✖  Node ${process.version} is too old: this app needs Node 18 or newer (built-in fetch).\n`);
  process.exit(1);
}
if (!API_KEY && !OR_KEY) {
  console.warn('\n⚠  No API key: set OPENCODE_API_KEY and/or OPENROUTER_API_KEY in .env (see .env.example).\n');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function upstreamHeaders(session) {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    // OpenCode Go requires a stable per-conversation session id.
    'x-opencode-session': session || crypto.randomUUID(),
  };
}

// ---------- /api/models (cached 10 min) ----------
let modelCache = null, modelCacheAt = 0;
async function getModels() {
  if (modelCache && Date.now() - modelCacheAt < 10 * 60_000) return modelCache;
  const [oc, or] = await Promise.allSettled([API_KEY ? openCodeModels() : Promise.resolve([]), OR_KEY ? openRouterModels() : Promise.resolve([])]);
  const list = [...(or.status === 'fulfilled' ? or.value : []), ...(oc.status === 'fulfilled' ? oc.value : [])];
  if (!list.length) throw new Error([oc, or].filter(x => x.status === 'rejected').map(x => x.reason && x.reason.message).join('; ') || 'no API key configured');
  modelCache = { models: list, default: list.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0].id };
  modelCacheAt = Date.now();
  return modelCache;
}
// OpenRouter: only the configured models (its catalogue has hundreds). Details come from its public model list.
async function openRouterModels() {
  const slugs = [OR_MODEL, ...OR_EXTRA.filter(x => x !== OR_MODEL)];
  let info = [];
  try { const r = await fetch(`${OR_BASE}/models`, { headers: { 'User-Agent': USER_AGENT } }); if (r.ok) info = (await r.json()).data || []; } catch {}
  return slugs.map(slug => {
    const m = info.find(x => x.id === slug) || {}, params = m.supported_parameters || [];
    const pinned = slug === OR_MODEL && OR_PROVIDER.length ? ` · ${OR_PROVIDER.join(', ')}` : '';
    return {
      id: OR_PREFIX + slug, name: `${m.name || slug}${pinned}`, provider: 'openrouter',
      efforts: !m.id || params.includes('reasoning') ? ['minimal', 'low', 'medium', 'high'] : [],
      defaultEffort: null,
      output: (m.top_provider && m.top_provider.max_completion_tokens) || 32000,
      api: 'chat', free: /:free$/.test(slug),
      vision: !!(m.architecture && Array.isArray(m.architecture.input_modalities) && m.architecture.input_modalities.includes('image')),
      featured: true,
    };
  });
}
async function openCodeModels() {
  const r = await fetch(`${API_BASE}/models`, { headers: upstreamHeaders('wbt-models') });
  if (!r.ok) throw new Error(`models ${r.status}`);
  const j = await r.json();
  const list = (j.data || [])
    // Every text model also works through Chat Completions (OpenCode translates), so list them all.
    .filter(m => (m.type || 'chat') === 'chat')
    .map(m => {
      const r = (m.capabilities && m.capabilities.reasoning) || {};
      return {
        id: m.id,
        name: m.name || m.id,
        efforts: Array.isArray(r.effort) ? r.effort : [],
        defaultEffort: r.default && r.default.type === 'effort' ? r.default.value : null,
        output: (m.limit && m.limit.output) || 32000,
        api: m.recommended_api || '',
        free: /free/i.test(m.id) || /free/i.test(m.name || ''),
        vision: !!(m.modalities && Array.isArray(m.modalities.input) && m.modalities.input.some(x => /image/.test(x))),
        featured: !!(m.go && m.go.featured),
        provider: 'opencode',
      };
    });
  return list;
}

// text, or (for a learner sketch) an array of text and image_url parts
function cleanContent(c) {
  if (!Array.isArray(c)) return String(c || '');
  const parts = [];
  for (const p of c.slice(0, 6)) {
    if (p && p.type === 'text') parts.push({ type: 'text', text: String(p.text || '') });
    else if (p && p.type === 'image_url' && p.image_url && /^data:image\/(png|jpeg|webp);base64,/.test(String(p.image_url.url || ''))) parts.push({ type: 'image_url', image_url: { url: String(p.image_url.url) } });
  }
  return parts.length ? parts : '';
}

async function maxTokensFor(model) {
  try { const m = (await getModels()).models.find(x => x.id === model); return Math.min((m && m.output) || 32000, 32000); }
  catch { return 32000; }
}

// ---------- /api/chat : streaming proxy ----------
async function handleChat(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 12_000_000)); } catch { return sendJSON(res, 400, { error: { code: 'invalid_request', message: 'Bad JSON' } }); }
  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL, viaOR = isOR(model);
  if (viaOR ? !OR_KEY : !API_KEY) return sendJSON(res, 500, { error: { code: 'no_api_key', message: `${viaOR ? 'OPENROUTER_API_KEY' : 'OPENCODE_API_KEY'} is not set on the server (.env).` } });

  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length) return sendJSON(res, 400, { error: { code: 'invalid_request', message: 'No messages' } });
  const payload = {
    model: viaOR ? model.slice(OR_PREFIX.length) : model,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: cleanContent(m.content) })),
    stream: true,
    // Reasoning models can spend thousands of tokens thinking before they write; leave room for both.
    max_tokens: await maxTokensFor(model),
    temperature: 0.6,
  };
  if (viaOR) {
    if (typeof body.effort === 'string' && body.effort) payload.reasoning = { effort: body.effort };
    if (payload.model === OR_MODEL && OR_PROVIDER.length) payload.provider = { only: OR_PROVIDER, allow_fallbacks: OR_FALLBACKS };
  } else if (typeof body.effort === 'string' && body.effort) payload.reasoning_effort = body.effort;

  const ac = new AbortController();
  res.on('close', () => ac.abort());   // browser pressed Stop / closed tab

  let up;
  try {
    up = await fetch(`${viaOR ? OR_BASE : API_BASE}/chat/completions`, {
      method: 'POST', headers: viaOR ? { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'X-Title': 'Whiteboard Teacher' } : upstreamHeaders(String(body.session || '').slice(0, 100)),
      body: JSON.stringify(payload), signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) return;
    return sendJSON(res, 502, { error: { code: 'upstream_unreachable', message: String(e.message || e) } });
  }

  if (!up.ok) {
    let text = await up.text().catch(() => '');
    let msg = text;
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type)) || text; } catch {}
    const code = up.status === 429 ? 'rate_limited' : up.status === 401 || up.status === 403 ? 'not_granted' : up.status === 400 ? 'invalid_request' : 'upstream_error';
    return sendJSON(res, up.status, { error: { code, message: String(msg).slice(0, 500) } });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Model': viaOR ? OR_PREFIX + payload.model : payload.model });
  try {
    for await (const chunk of up.body) {
      if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
    }
  } catch (e) {
    if (!ac.signal.aborted) res.write(`data: ${JSON.stringify({ error: { code: 'stream_error', message: String(e.message || e) } })}\n\n`);
  }
  res.end();
}

// ---------- sessions: auto-saved lessons on disk (./sessions/<id>.json) ----------
const SESS_DIR = path.join(__dirname, 'sessions');
const validId = id => /^[\w-]{1,80}$/.test(id);
function listSessions() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      out.push({ id: f.slice(0, -5), topic: (d.lesson && d.lesson.topic) || 'Untitled', source: (d.lesson && d.lesson.source) || '',
        createdAt: d.createdAt || null, updatedAt: d.updatedAt || null,
        objects: Array.isArray(d.objs) ? d.objs.length : 0, messages: Array.isArray(d.chat) ? d.chat.filter(m => m.role === 'user').length : 0 });
    } catch { /* skip broken file */ }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
async function handleSessions(req, res, url) {
  const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
  if (!id) {
    if (req.method === 'GET') return sendJSON(res, 200, { sessions: listSessions() });
    return sendJSON(res, 405, { error: { code: 'method' } });
  }
  if (!validId(id)) return sendJSON(res, 400, { error: { code: 'invalid_id' } });
  const file = path.join(SESS_DIR, id + '.json');
  if (req.method === 'GET') {
    fs.readFile(file, 'utf8', (err, txt) => err ? sendJSON(res, 404, { error: { code: 'not_found' } }) : (res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }), res.end(txt)));
    return;
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    let d; try { d = JSON.parse(await readBody(req, 8_000_000)); } catch { return sendJSON(res, 400, { error: { code: 'invalid_request' } }); }
    if (!d || typeof d !== 'object' || !d.lesson) return sendJSON(res, 400, { error: { code: 'invalid_request' } });
    let createdAt = d.createdAt;
    try { createdAt = JSON.parse(fs.readFileSync(file, 'utf8')).createdAt || createdAt; } catch {}
    const doc = { ...d, id, createdAt: createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.mkdirSync(SESS_DIR, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, file);
    return sendJSON(res, 200, { ok: true, updatedAt: doc.updatedAt });
  }
  if (req.method === 'DELETE') { try { fs.unlinkSync(file); } catch {} return sendJSON(res, 200, { ok: true }); }
  return sendJSON(res, 405, { error: { code: 'method' } });
}

// ---------- natural voice (Kokoro) generated natively on this computer ----------
// Much faster than running the model inside the browser (uses every CPU core), and it works in Safari.
// Needs the optional `kokoro-js` package (npm install). Without it, the browser falls back to its own engine.
const TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const tts = { state: 'idle', progress: 0, error: '', engine: null, chain: Promise.resolve(), cache: new Map() };
function ttsStatus() { return { state: tts.state, progress: tts.progress, error: tts.error }; }
function loadTTS() {
  if (tts.loading) return tts.loading;
  tts.state = 'loading';
  tts.loading = (async () => {
    let KokoroTTS;
    try { ({ KokoroTTS } = await import('kokoro-js')); }
    catch (e) { tts.state = 'unavailable'; tts.error = 'kokoro-js is not installed (run npm install)'; throw e; }
    const files = {};
    tts.engine = await KokoroTTS.from_pretrained(TTS_MODEL, {
      dtype: process.env.TTS_DTYPE || 'q8', device: 'cpu',
      progress_callback: p => {
        if (p.status === 'progress' && p.file) {
          files[p.file] = [p.loaded || 0, p.total || 0];
          let l = 0, t = 0; for (const [a, b] of Object.values(files)) { l += a; t += b; }
          tts.progress = t ? Math.min(99, Math.round(l / t * 100)) : 0;
        }
      },
    });
    tts.state = 'ready'; tts.progress = 100;
    console.log('  Voice: Kokoro ready (generated on this computer)');
  })().catch(e => {
    if (tts.state !== 'unavailable') { tts.state = 'error'; tts.error = String(e && e.message || e); console.warn('  Voice: Kokoro failed to load:', tts.error); }
    else console.log('  Voice: kokoro-js not installed; the browser will generate speech itself (slower). Run `npm install` for the fast voice.');
  });
  return tts.loading;
}
function sentenceChunks(text) {
  const parts = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [text];
  const out = []; let cur = '';
  for (const p of parts) { if ((cur + p).length > 280 && cur) { out.push(cur.trim()); cur = p; } else cur += p; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function wav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
async function handleTTS(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 20000)); } catch { return sendJSON(res, 400, { error: { code: 'invalid_request' } }); }
  const text = String(body.text || '').slice(0, 1500).trim();
  const voice = /^[a-z]{2}_[a-z]+$/.test(body.voice || '') ? body.voice : 'af_bella';
  const speed = Math.max(0.5, Math.min(2, Number(body.speed) || 1));
  if (!text) return sendJSON(res, 400, { error: { code: 'invalid_request', message: 'no text' } });
  loadTTS();
  if (tts.state === 'unavailable' || tts.state === 'error') return sendJSON(res, 501, { error: { code: 'tts_unavailable', message: tts.error } });
  const key = `${voice}|${speed}|${text}`;
  let job = tts.cache.get(key);
  if (!job) {
    // one generation at a time keeps each sentence as fast as possible
    job = tts.chain = tts.chain.catch(() => {}).then(async () => {
      await tts.loading;
      if (tts.state !== 'ready') throw new Error(tts.error || 'voice not ready');
      const t0 = Date.now(), pieces = []; let sr = 24000, len = 0;
      for (const c of sentenceChunks(text)) { const a = await tts.engine.generate(c, { voice, speed }); sr = a.sampling_rate; pieces.push(a.audio); len += a.audio.length; }
      const all = new Float32Array(len); let off = 0; for (const p of pieces) { all.set(p, off); off += p.length; }
      return { data: wav(all, sr), genMs: Date.now() - t0, seconds: len / sr };
    });
    job.catch(() => tts.cache.delete(key));
    tts.cache.set(key, job);
    if (tts.cache.size > 300) tts.cache.delete(tts.cache.keys().next().value);
  }
  try {
    const r = await job;
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': r.data.length, 'Cache-Control': 'no-store', 'X-Gen-Ms': String(r.genMs), 'X-Audio-Seconds': r.seconds.toFixed(2) });
    res.end(r.data);
  } catch (e) { if (!res.headersSent) sendJSON(res, 500, { error: { code: 'tts_failed', message: String(e.message || e) } }); }
}

// ---------- board bridge: lets another program (mcp.js, used by opencode) drive an open board page ----------
// The board page (/?mode=mcp) subscribes to /api/board/events. A caller POSTs {method, params} to /api/board/call;
// the call goes to the most recently connected board, preferring one embedded in opencode Desktop's Whiteboard tab
// (?embed=1) over a browser tab; that board runs it and POSTs the answer to /api/board/result.
const boards = [];                 // [{id, res, embed}] open board pages, newest last
const pendingCalls = new Map();    // call id -> {resolve, timer}
function handleBoardEvents(req, res, url) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
  const b = { id: crypto.randomUUID(), res, embed: url.searchParams.get('embed') === '1' };
  boards.push(b);
  res.write(`event: hello\ndata: ${JSON.stringify({ id: b.id })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); const i = boards.indexOf(b); if (i >= 0) boards.splice(i, 1); });
}
async function handleBoardCall(req, res) {
  // JSON only: a web page cannot send this content type cross-origin without a CORS preflight, which is never granted
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJSON(res, 415, { error: { code: 'json_only' } });
  let body; try { body = JSON.parse(await readBody(req, 4_000_000)); } catch { return sendJSON(res, 400, { error: { code: 'invalid_request', message: 'Bad JSON' } }); }
  const method = String(body.method || ''), timeout = Math.max(1000, Math.min(Number(body.timeout) || 60000, 300000));
  const b = boards.findLast(x => x.embed) || boards[boards.length - 1];
  if (!b) return sendJSON(res, 503, { error: { code: 'no_board', message: 'No board page is open.' } });
  const id = crypto.randomUUID();
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { pendingCalls.delete(id); resolve({ ok: false, error: `The board did not answer within ${Math.round(timeout / 1000)} s.` }); }, timeout);
    pendingCalls.set(id, { resolve, timer });
    b.res.write(`event: call\ndata: ${JSON.stringify({ id, method, params: body.params || {} })}\n\n`);
  });
  sendJSON(res, result.ok ? 200 : 500, result);
}
async function handleBoardResult(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 16_000_000)); } catch { return sendJSON(res, 400, { error: { code: 'invalid_request' } }); }
  const p = pendingCalls.get(body.id);
  if (p) { clearTimeout(p.timer); pendingCalls.delete(body.id); p.resolve({ ok: !!body.ok, result: body.result, error: body.error }); }
  sendJSON(res, 200, { ok: true });
}

// ---------- static files ----------
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      // cross-origin isolation lets the in-browser voice model use several CPU threads
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/models' && req.method === 'GET') {
      try { return sendJSON(res, 200, await getModels()); }
      catch (e) { return sendJSON(res, 502, { error: { code: 'upstream_error', message: String(e.message || e) }, models: [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL, efforts: [] }], default: DEFAULT_MODEL }); }
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
    if (url.pathname === '/api/tts' && req.method === 'POST') return handleTTS(req, res);
    if (url.pathname === '/api/tts/status' && req.method === 'GET') { loadTTS(); return sendJSON(res, 200, ttsStatus()); }
    if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) return handleSessions(req, res, url);
    if (url.pathname === '/api/board/events' && req.method === 'GET') return handleBoardEvents(req, res, url);
    if (url.pathname === '/api/board/status' && req.method === 'GET') return sendJSON(res, 200, { app: 'whiteboard-teacher', boards: boards.length, embedded: boards.filter(b => b.embed).length });
    if (url.pathname === '/api/board/call' && req.method === 'POST') return handleBoardCall(req, res);
    if (url.pathname === '/api/board/result' && req.method === 'POST') return handleBoardResult(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: { code: 'server_error', message: String(e.message || e) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Whiteboard Teacher → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n  LLM: OpenCode Go (${API_BASE}), default model ${DEFAULT_MODEL}\n`);
  if (process.env.TTS !== 'off') loadTTS(); // warm the voice up in the background
});
