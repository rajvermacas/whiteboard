// GUI half of the opencode plugin (opencode Desktop's experimental `./gui-experimental` bundle).
// Adds a "Whiteboard" tab to the session's side panel that shows the live board, opens it from the + menu or the
// command palette, and opens it by itself when the model starts using the whiteboard MCP tools.
// Plain CommonJS against the modules the app shares (solid-js, @opencode/plugin/gui), so it needs no build step.
'use strict';
const { createEffect, onCleanup } = require('solid-js');
const { Panel, MenuItem, Command } = require('@opencode/plugin/gui');

const TAB = 'board';
const POLL_MS = 2000;

function setup(ctx) {
  const options = ctx.options || {};
  const base = String(options.url || 'http://127.0.0.1:5173').replace(/\/+$/, '');
  const boardUrl = base + '/?mode=mcp&embed=1';
  const key = `${ctx.id}:${TAB}`;

  const open = session => { if (session && session.id) ctx.layout.open(key, session, { tab: 'select' }); };
  const toggle = session => { if (session && session.id) ctx.layout.toggle(key, session); };

  // One tab object for every session, so a session switch does not render its trigger again.
  const tab = { id: TAB, title: 'Whiteboard', draggable: true };

  ctx.add(Panel, {
    id: TAB,
    region: 'side',
    width: 720,
    list: input => (input.open.includes(TAB) ? [tab] : []),
    closed: () => ({ icon: 'pencil-line' }),
    // One board for all sessions: it stays mounted across session switches.
    render: () => boardView(base, boardUrl),
  });

  ctx.add(MenuItem, () => ({
    menu: 'session.panel',
    id: 'open',
    title: 'Whiteboard',
    icon: 'pencil-line',
    description: 'live board',
    order: 60,
    run: () => open(ctx.sessions.current()),
  }));

  ctx.add(Command, () => ({
    id: 'toggle',
    title: 'Toggle whiteboard',
    description: 'Show or hide the live whiteboard next to the conversation',
    keywords: 'board draw teach diagram',
    section: 'session',
    run: () => toggle(ctx.sessions.current()),
  }));

  // Open the tab as soon as the model starts a whiteboard call in the session on screen (once per call, so a
  // closed tab stays closed until the next one). Direct calls are named whiteboard_*; in Code Mode they are an
  // `execute` call whose code uses tools.whiteboard.
  const seen = new Set();
  createEffect(() => {
    const session = ctx.sessions.current();
    if (!session || !session.id) return;
    let messages;
    try { messages = session.server.data.session.message.list(session.id) || []; } catch { return; }
    for (let i = messages.length - 1, n = 0; i >= 0 && n < 4; i--) {
      const m = messages[i];
      if (!m || m.type !== 'assistant' || !Array.isArray(m.content)) continue;
      n++;
      for (const c of m.content) {
        if (!c || c.type !== 'tool' || !c.state || !['pending', 'running'].includes(c.state.status)) continue;
        if (seen.has(c.id) || !usesWhiteboard(c)) continue;
        seen.add(c.id);
        if (ctx.layout.state(key, session) !== 'open') open(session);
      }
    }
  });
}

function usesWhiteboard(c) {
  if (/^whiteboard_/.test(c.name || '')) return true;
  const input = c.state && c.state.input;
  return c.name === 'execute' && !!input && typeof input.code === 'string' && /tools\.whiteboard\b/.test(input.code);
}

// The board page in an iframe, once its server answers. Until then: a short note, checked again every 2 s.
function boardView(base, boardUrl) {
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;flex:1 1 auto;min-height:0;height:100%;width:100%;display:flex;background:#fff;';
  const note = document.createElement('div');
  note.style.cssText = 'margin:auto;max-width:340px;padding:24px;text-align:center;color:#7d848c;font:14px/1.5 system-ui,sans-serif;';
  note.textContent = 'Starting the whiteboard…';
  root.appendChild(note);

  let frame = null, timer = null, misses = 0, stopped = false;
  const check = async () => {
    if (stopped) return;
    try {
      // no-cors: the answer is opaque, but it only resolves when the server is up
      await fetch(base + '/api/board/status', { mode: 'no-cors', cache: 'no-store' });
      if (!frame) {
        frame = document.createElement('iframe');
        frame.src = boardUrl;
        frame.title = 'Whiteboard';
        frame.allow = 'autoplay; clipboard-write; fullscreen';
        frame.style.cssText = 'border:0;flex:1 1 auto;width:100%;height:100%;';
        root.replaceChildren(frame);
      }
    } catch {
      if (frame) { frame.remove(); frame = null; root.appendChild(note); }
      if (++misses > 3) note.textContent = `The whiteboard server is not running at ${base}. It starts with opencode (or on the first whiteboard drawing); you can also run \`npm start\` in the whiteboard folder.`;
    }
    timer = setTimeout(check, frame ? POLL_MS * 5 : POLL_MS);
  };
  check();
  onCleanup(() => { stopped = true; clearTimeout(timer); });
  return root;
}

module.exports = { default: { setup } };
