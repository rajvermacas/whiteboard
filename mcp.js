#!/usr/bin/env node
// Whiteboard Teacher — MCP server (stdio). Lets an MCP client such as opencode teach on the whiteboard:
// its model calls draw / look / get_board / new_board, and this forwards each call to the board page through
// server.js (/api/board/*). Starts server.js and opens the board page itself when they are not running.
// Zero dependencies: Node 18+. Logs go to stderr; stdout carries only the protocol.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { boardStatus, ensureBoardServer } = require('./launch.cjs');

const BASE = (process.env.WHITEBOARD_URL || `http://127.0.0.1:${process.env.PORT || 5173}`).replace(/\/+$/, '');
const BOARD_URL = BASE + '/?mode=mcp';
const AUTO_OPEN = !/^(0|false|no)$/i.test(process.env.WHITEBOARD_OPEN || '');
const log = (...a) => process.stderr.write('[whiteboard-mcp] ' + a.join(' ') + '\n');

// icon names, read from the board's own icon library
let ICONS = 'gpu, cpu, server, database, person, document, cloud, brain, clock, lock, memory, queue';
try {
  const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'icons.js'), 'utf8'), ctx);
  ICONS = ctx.window.WB_ICONS.names.join(', ');
} catch (e) { log('could not read icon names:', e.message); }

// ---------------------------------------------------------------------------------------------------------------
// what the model is told
// ---------------------------------------------------------------------------------------------------------------
const TEACHING = `You teach at a live whiteboard (the "whiteboard" tools). The board SHOWS the idea with pictures; your sentences EXPLAIN it: the reasoning, the why, cause and effect.

How to answer when the learner wants something explained:
1. Decide the depth from what they need, not the wording: quick (one fact, a yes/no: 1-2 sentences, the smallest drawing), explain (one idea with a real reason behind it: one worked picture built step by step), or deep (several connected ideas: 3-6 parts, teach the first 2-3, then stop at a checkpoint and offer to continue). When unsure, choose the fuller one. If they are still confused after an earlier answer, go deeper from a more basic idea with a new example, never shorter.
2. Call whiteboard_get_board first when you have not seen the board in this conversation, or the learner refers to something on it ("this", "my drawing", "the arrow"). A new subject on a busy board: whiteboard_new_board with a 2-5 word title.
3. Teach with whiteboard_draw. Each step = one spoken sentence ("say", at most 22 words, explaining exactly the drawing in that step and why it works that way) + 2-5 drawing commands. Send 3-6 steps per call and a few calls per answer, writing one short line in the chat between calls so the learner can follow. The board shows each "say" as a caption and reads it aloud while the pen draws.
4. Every idea becomes a picture: things → icons or boxes; sequences, slots, queues → tokens; over time → schedule; who sends what to whom → sequence; cause and movement → arrows; parts of a whole → frame; sizes → brace or bars; structure → graph, tree, network. Draw the concrete example itself (real tokens, numbers, names). At least 85% of commands are pictures.
5. Board text is labels only (1-4 words or a number, at most 30 characters; arrow labels 22, a sub line 26, a token 14; longer text is cut off with …). At most 3 write commands per answer (a heading and short captions). Never sentences, definitions or bullet lists on the board.
6. Build on the board: keep earlier drawings and change them with update/move/highlight; erase only what is wrong or outdated. A new subject starts with a heading in free space (whiteboard_draw tells you where that is).
7. Read each whiteboard_draw result: fix every listed issue (overlaps, arrows through drawings, cut-off labels) and error with a short follow-up draw of move/update commands. Use whiteboard_look to see the board as a picture when a layout is complex.
8. The learner can sketch on the board (objects of type ink) and select objects. When they ask about their drawing, call whiteboard_look with area "sketch", work out what it shows from the picture yourself (never ask them to describe it), say what you see, then answer or check it: highlight what is right and draw the corrected version next to their sketch. Never erase or move their ink.
9. End an explanation with one line offering 2-3 specific follow-up questions about what you drew.
10. Reply in the learner's language (Hinglish if they write Hinglish). Say when numbers are only illustrative.`;

const COMMANDS = `Commands (one JSON object each; give every object a short unique "id" so you can refer to it later).
Place things with "near" instead of guessing coordinates: "near":{"of":"<id>","side":"right|left|below|above","gap":70}. Give x,y only for the first object of a new area (use the free space from the last result or get_board). Units: board units, x grows right, y grows down.
Pictures, best first:
{"cmd":"icon","id":"gpu","name":"gpu","label":"GPU","sub":"80 GB","near":{"of":"q","side":"right"}}   icons: ${ICONS} (plus common synonyms). Use them for every real-world thing.
{"cmd":"tokens","id":"r1","items":["The","cat","sat",""],"color":"#1d6fb8","highlight":[2],"label":"request A","near":{"of":"gpu","side":"below"}}   a row of chips: tokens, words, slots, packets, queue items, array cells ("" = empty slot); "vertical":true for a stack
{"cmd":"box","id":"b1","x":0,"y":0,"label":"Scheduler","sub":"every step","color":"#1d6fb8","fill":true}   a component
{"cmd":"circle","id":"c1","label":"x","color":"#2a8a3e","fill":true,"near":{"of":"b1","side":"right"}}
{"cmd":"arrow","id":"a1","from":"b1","to":"c1","label":"sends","curve":0.2,"dash":false,"color":"#1f2328"}   from/to = ids (or [x,y]); how anything moves or causes anything
{"cmd":"frame","id":"f1","around":["gpu","r1"],"label":"one batch"}   groups related things in a dashed box; not around arrows
{"cmd":"brace","id":"br1","around":["r1"],"side":"below","label":"4 tokens"}   measures or names a span
{"cmd":"schedule","id":"s1","x":0,"y":0,"label":"GPU slots over time","rows":[{"label":"slot 1","spans":[[0,4,"A","#1d6fb8"],[4,6,"D","#2a8a3e"]]},{"label":"slot 2","spans":[[0,2,"B","#c48a00"]]}],"steps":6,"markers":[{"at":2,"label":"B done"}]}   lanes against time steps (from inclusive, to exclusive)
{"cmd":"sequence","id":"sq","actors":["Client","Server"],"messages":[["Client","Server","SYN seq=100"],["Server","Client","SYN-ACK"],["Client","Server","ACK",true]],"label":"handshake"}   who sends what to whom, in order; true = dashed reply
{"cmd":"graph","id":"g1","nodes":["Client","API","DB"],"edges":[["Client","API","request"],["API","DB"]],"layout":"layered|circle|grid","near":{"of":"b1","side":"below"}}   flows, pipelines, state machines
{"cmd":"tree","id":"t1","root":{"label":"root","children":[{"label":"left"},{"label":"right"}]}}
{"cmd":"network","id":"nn","layers":[3,4,2],"labels":["in","hidden","out"]}
{"cmd":"bars","id":"p1","values":[0.1,0.6,0.3],"labels":["cat","sat","mat"],"label":"probability"}
{"cmd":"numberline","id":"n1","from":0,"to":10,"marks":[{"at":3,"label":"w"}]}   {"cmd":"timeline","id":"tl","events":[{"label":"v1","at":"2019"}]}
{"cmd":"vector","id":"v1","values":[0.2,0.7],"label":"q"}   {"cmd":"matrix","id":"m1","values":[[1,0],[0,1]],"label":"W"}   {"cmd":"plot","id":"f","fn":"sigmoid|exp|tanh|relu|gelu|sin|cos|log|linear|square","label":"σ"}
{"cmd":"table","id":"tb","header":["Model","Params"],"rows":[["A","1B"]]}   only for real reference numbers
{"cmd":"math","id":"e1","x":0,"y":0,"tex":"E = mc^2"}   {"cmd":"code","id":"k1","code":"x = 1","lang":"python"}   {"cmd":"line","id":"l1","points":[[0,0],[100,40]]}
Changing the board:
{"cmd":"highlight","id":"h1","target":"r1","style":"circle|underline|box","color":"#e07800"}   point at what you are talking about
{"cmd":"update","id":"r1","items":["The","cat","sat","on"],"highlight":[3]}   redraw an existing object with new fields (show change step by step; "curve":0.4 bends an arrow)
{"cmd":"move","id":"r1","dx":0,"dy":120}   (arrows, frames and highlights follow)   {"cmd":"erase","ids":["a1"]}   {"cmd":"clear"}   {"cmd":"wait","ms":600}
Words, sparingly: {"cmd":"write","id":"h","x":0,"y":0,"text":"Continuous batching","size":34}   a heading or a 1-4 word caption, never a sentence.
Colours (dark markers on white): blue #1d6fb8, amber #c48a00, green #2a8a3e, red #d1382c, purple #7a48c2, orange #e07800, black #1f2328, grey #7d848c. Give each kind of thing one colour and keep it.
Layout: one clear diagram per idea, flowing left→right or top→bottom; 40+ units between things; before/after side by side; frame what belongs together; arrows join neighbours and never cross other drawings.

Example call (a different topic):
{"steps":[
 {"say":"The CPU can only work on data it has in hand, so where data lives decides the speed.","commands":[{"cmd":"write","id":"hc","x":0,"y":0,"text":"Caching","size":34},{"cmd":"icon","id":"cpu","name":"cpu","label":"CPU","near":{"of":"hc","side":"below","gap":50}},{"cmd":"icon","id":"disk","name":"database","label":"disk","sub":"10 ms","near":{"of":"cpu","side":"right","gap":420}}]},
 {"say":"Fetching from disk takes ten milliseconds: ten million CPU steps spent just waiting.","commands":[{"cmd":"arrow","id":"slow","from":"cpu","to":"disk","label":"10 ms","dash":true,"color":"#d1382c"}]},
 {"say":"So we keep a small, fast memory right beside the CPU for data we just used.","commands":[{"cmd":"icon","id":"mem","name":"memory","label":"cache","sub":"1 ns","near":{"of":"cpu","side":"right","gap":160}},{"cmd":"arrow","id":"hit","from":"cpu","to":"mem","label":"hit","color":"#2a8a3e"}]}
]}`;

const TOOLS = [
  {
    name: 'draw',
    title: 'Draw on the whiteboard',
    description: `Teach on the live whiteboard: each step is one spoken sentence ("say") plus the drawing commands it explains. The board draws them with a pen, shows "say" as a caption and reads it aloud, pacing the pen to the voice. Returns what was drawn (ids and boxes), layout issues to fix, errors, and where free space is.

${TEACHING}

${COMMANDS}`,
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array', minItems: 1,
          description: 'In order. Each: one sentence explaining the drawing, then the 2-5 commands it explains.',
          items: {
            type: 'object',
            properties: {
              say: { type: 'string', description: 'One spoken sentence (max 22 words) explaining exactly these commands and why.' },
              commands: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Board commands (see the tool description).' },
            },
            required: ['commands'],
          },
        },
        wait_seconds: { type: 'number', description: 'How long to wait for the pen to finish before returning (default 20, max 110). Layout issues are only checked once drawing finished.' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'get_board',
    title: 'Read the whiteboard',
    description: 'What is on the whiteboard now: every object with its id, kind, labels and box, free space, what the learner is looking at, what they selected, and their pen sketches (ink). Call it before building on a board you have not seen, or when the learner refers to something on it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'look',
    title: 'Look at the whiteboard',
    description: 'A picture (PNG) of the whiteboard, to check a layout the way the learner sees it, or to read the learner\'s own sketch. area: "all" (default), "view" (what the learner is looking at) or "sketch" (the learner\'s latest pen drawing and what is around it). Or pass ids to look at those objects and their surroundings.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', enum: ['all', 'view', 'sketch'] },
        ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'new_board',
    title: 'Start a new whiteboard',
    description: 'Start a fresh, empty whiteboard session for a new subject (the current one is saved and stays in the board\'s Sessions list).',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: '2-5 word title, e.g. "TCP Handshake".' } } },
  },
];

const PROMPTS = [{
  name: 'teach',
  title: 'Teach on the whiteboard',
  description: 'Explain something by drawing it on the whiteboard.',
  arguments: [{ name: 'question', description: 'What to explain', required: false }],
}];

// ---------------------------------------------------------------------------------------------------------------
// reaching the board: server.js, then an open board page
// ---------------------------------------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A board inside opencode Desktop's side panel (opencode-plugin) connects on its own once a whiteboard tool runs;
// give it this long before opening a browser tab instead.
const OPEN_DELAY = Math.max(0, Number(process.env.WHITEBOARD_OPEN_DELAY_MS ?? 5000) || 0);
let openedAt = 0;
async function ensureBoard() {
  let st = await ensureBoardServer(BASE, { log });
  if (!st.reachable) throw new Error(`The whiteboard server is not running and could not be started. Run \`npm start\` in ${__dirname}.`);
  if (!st.ours) throw new Error(`${BASE} answers but has no board bridge: either an older Whiteboard Teacher server is still running (stop it and run \`npm start\` again in ${__dirname}) or another program uses that port (then set WHITEBOARD_URL for the whiteboard MCP server).`);
  if (st.boards) return;
  for (let t = 0; t < OPEN_DELAY; t += 250) { await sleep(250); if ((st = await boardStatus(BASE)).boards) { await sleep(400); return; } }
  if (AUTO_OPEN && Date.now() - openedAt > 30000) {
    openedAt = Date.now();
    const opener = process.platform === 'darwin' ? ['open', [BOARD_URL]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', BOARD_URL]] : ['xdg-open', [BOARD_URL]];
    try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); log('opened', BOARD_URL); } catch (e) { log('could not open a browser:', e.message); }
  }
  for (let i = 0; i < 60; i++) { await sleep(250); st = await boardStatus(BASE); if (st.boards) { await sleep(400); return; } }
  throw new Error(`No whiteboard is open. Open the Whiteboard tab in opencode Desktop (+ in the side panel), or ${BOARD_URL} in a browser, then try again.`);
}
async function boardCall(method, params, timeoutMs) {
  await ensureBoard();
  const r = await fetch(BASE + '/api/board/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, timeout: timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error((j.error && (j.error.message || j.error)) || `board error ${r.status}`);
  return j.result;
}

// ---------------------------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------------------------
const text = t => ({ type: 'text', text: t });
async function callTool(name, args) {
  args = args && typeof args === 'object' ? args : {};
  if (name === 'draw') {
    if (!Array.isArray(args.steps) || !args.steps.length) throw new Error('steps must be a non-empty array of {say, commands}');
    const wait = Math.max(0, Math.min(Number(args.wait_seconds ?? 20) || 0, 110));
    const r = await boardCall('draw', { steps: args.steps, wait_seconds: wait }, (wait + 20) * 1000);
    const out = [`${r.done ? 'Drawn.' : 'Queued: the board is still drawing.'} ${r.note || ''}`.trim()];
    if (r.drawn && r.drawn.length) out.push('Objects:\n' + r.drawn.map(x => '- ' + x).join('\n'));
    if (r.issues && r.issues.length) out.push('Layout issues to fix (with move/update):\n' + r.issues.map(x => '- ' + x).join('\n'));
    if (r.errors && r.errors.length) out.push('Errors:\n' + r.errors.map(x => '- ' + x).join('\n'));
    out.push(r.free);
    return [text(out.join('\n\n'))];
  }
  if (name === 'get_board') {
    const r = await boardCall('get_board', {}, 15000);
    const out = [`Board: "${r.topic}"${r.drawing ? ' (still drawing)' : ''}`, r.summary];
    if (r.selected.length) out.push('The learner selected: ' + r.selected.join(', ') + '. Work on these directly.');
    if (r.newSketches.length) out.push(`The learner just sketched (${r.newSketches.join(', ')}): call look with area "sketch" to see it.`);
    else if (r.sketches.length) out.push(`Learner sketches on the board: ${r.sketches.join(', ')}.`);
    return [text(out.join('\n\n'))];
  }
  if (name === 'look') {
    const r = await boardCall('look', { area: args.area, ids: args.ids }, 40000);
    if (r.empty) return [text(r.note)];
    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(r.image || '');
    if (!m) throw new Error('the board returned no picture');
    return [text(`The whiteboard, board area ${r.region}:`), { type: 'image', data: m[2], mimeType: m[1] }];
  }
  if (name === 'new_board') {
    const r = await boardCall('new_board', { title: args.title }, 15000);
    return [text(`New board "${r.topic}" is open and empty: start near (0, 0).`)];
  }
  throw Object.assign(new Error('Unknown tool: ' + name), { rpc: -32602 });
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited)
// ---------------------------------------------------------------------------------------------------------------
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
async function handle(msg) {
  const { id, method, params = {} } = msg;
  const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'whiteboard', title: 'Whiteboard Teacher', version: '1.0.0' },
        instructions: TEACHING,
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'prompts/list': return reply({ prompts: PROMPTS });
    case 'prompts/get': {
      if (params.name !== 'teach') return fail(-32602, 'Unknown prompt: ' + params.name);
      const q = String((params.arguments && params.arguments.question) || '').trim();
      return reply({ description: 'Teach on the whiteboard', messages: [{ role: 'user', content: text(`${TEACHING}\n\nTeach me this on the whiteboard${q ? `: ${q}` : ' (ask me what I want to learn if I have not said)'}.`) }] });
    }
    case 'tools/call':
      try { return reply({ content: await callTool(params.name, params.arguments) }); }
      catch (e) {
        if (e.rpc) return fail(e.rpc, e.message);
        log(params.name, 'failed:', e.message);
        return reply({ content: [text('Whiteboard error: ' + e.message)], isError: true });
      }
    default:
      if (method && method.startsWith('notifications/')) return;
      return fail(-32601, 'Method not found: ' + method);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch(e => log('handler error:', e.stack || e));
  }
});
process.stdin.on('end', () => process.exit(0));
log('ready; board at', BOARD_URL);
