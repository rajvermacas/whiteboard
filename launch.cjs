// Finds or starts the Whiteboard Teacher server. Shared by mcp.js (the MCP server) and the opencode plugin
// (opencode-plugin/server.js), so whichever runs first starts it. No dependencies.
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// reachable: something answers at base · ours: it is this app with the board bridge · boards: open board pages
async function boardStatus(base) {
  try {
    const r = await fetch(base + '/api/board/status', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { reachable: true, ours: false, boards: 0 };
    const j = await r.json();
    return { reachable: true, ours: j.app === 'whiteboard-teacher', boards: j.boards || 0 };
  } catch { return { reachable: false, ours: false, boards: 0 }; }
}

// Starts server.js when nothing answers at base, then waits up to 10 s for it. Detached, so the board keeps
// running when the caller exits. node: the Node.js binary to run it with (default: this process's own).
async function ensureBoardServer(base, { node = process.execPath, log = () => {} } = {}) {
  let st = await boardStatus(base);
  if (st.reachable) return st;
  const port = new URL(base).port || '80';
  log(`starting the board server on port ${port}`);
  const child = spawn(node, [path.join(__dirname, 'server.js')], { cwd: __dirname, detached: true, stdio: 'ignore', env: { ...process.env, PORT: port } });
  child.on('error', e => log('could not start the board server: ' + e.message));
  child.unref();
  for (let i = 0; i < 40 && !st.reachable; i++) { await sleep(250); st = await boardStatus(base); }
  return st;
}

module.exports = { boardStatus, ensureBoardServer };
