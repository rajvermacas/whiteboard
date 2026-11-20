// Server half of the opencode plugin. It runs inside opencode's server and only makes sure the board server
// (../server.js) is running, so the Whiteboard tab in opencode Desktop has a board to show. Drawing itself goes
// through the whiteboard MCP server (../mcp.js); the GUI half (gui.cjs) shows the board.
//
// Options (from the plugin's entry in opencode.json): url (default http://127.0.0.1:5173), node (the Node.js
// binary that runs the board server; default: the first `node` on PATH).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureBoardServer } = require('../launch.cjs');

function findNode() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

let started = false;
export default {
  id: 'whiteboard',
  setup(ctx, maybeOptions) {
    if (started) return;   // one board server for every project opencode opens
    started = true;
    const options = (ctx && ctx.options) || maybeOptions || {};
    const base = String(options.url || 'http://127.0.0.1:5173').replace(/\/+$/, '');
    const node = options.node || findNode();
    const log = msg => console.error('[whiteboard plugin] ' + msg);
    if (!node) { log('no Node.js found: set the plugin option "node"; the board server starts on the first whiteboard tool call instead'); return; }
    // in the background: never hold up opencode's startup
    ensureBoardServer(base, { node, log }).then(st => { if (!st.reachable) log('the board server did not start'); }, e => log(String(e)));
  },
};
