// Whiteboard Teacher — local server
// Serves the app from ./public and proxies LLM calls to OpenCode Go so the API key never reaches the browser.
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
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4.1-flash';
const USER_AGENT = 'whiteboard-teacher/1.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (typeof fetch !== 'function') {
  console.error(`\n✖  Node ${process.version} is too old: this app needs Node 18 or newer (built-in fetch).\n`);
  process.exit(1);
}
if (!API_KEY) {
  console.warn('\n⚠  OPENCODE_API_KEY is not set. Copy .env.example to .env and add your key.\n');
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
        featured: !!(m.go && m.go.featured),
      };
    });
  modelCache = { models: list, default: list.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : (list[0] && list[0].id) };
  modelCacheAt = Date.now();
  return modelCache;
}

async function maxTokensFor(model) {
  try { const m = (await getModels()).models.find(x => x.id === model); return Math.min((m && m.output) || 32000, 32000); }
  catch { return 32000; }
}

// ---------- /api/chat : streaming proxy ----------
async function handleChat(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: { code: 'invalid_request', message: 'Bad JSON' } }); }
  if (!API_KEY) return sendJSON(res, 500, { error: { code: 'no_api_key', message: 'OPENCODE_API_KEY is not set on the server (.env).' } });

  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length) return sendJSON(res, 400, { error: { code: 'invalid_request', message: 'No messages' } });
  const payload = {
    model: typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: String(m.content || '') })),
    stream: true,
    // Reasoning models can spend thousands of tokens thinking before they write; leave room for both.
    max_tokens: await maxTokensFor(body.model),
    temperature: 0.6,
  };
  if (typeof body.effort === 'string' && body.effort) payload.reasoning_effort = body.effort;

  const ac = new AbortController();
  res.on('close', () => ac.abort());   // browser pressed Stop / closed tab

  let up;
  try {
    up = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST', headers: upstreamHeaders(String(body.session || '').slice(0, 100)),
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

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Model': payload.model });
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
    if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) return handleSessions(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: { code: 'server_error', message: String(e.message || e) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Whiteboard Teacher → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n  LLM: OpenCode Go (${API_BASE}), default model ${DEFAULT_MODEL}\n`);
});
