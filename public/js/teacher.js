/* Whiteboard Teacher — the queue, the prompt, sending a question and streaming the answer */
'use strict';
// ======================================================================
// queue: say lines type while the commands after them draw
// ======================================================================
let queueBusy = false;       // a board command is being drawn right now
// sleep that only counts unpaused time, so a long pause never makes the queue give up and skip ahead
// wait for p, at most ms of playing time (the timer is cleared either way)
function within(p, ms) { const g = psleep(ms); return Promise.race([p, g]).finally(() => g.cancel()); }
function psleep(ms) { let id; const p = new Promise(res => { let left = ms, last = performance.now(); id = setInterval(() => { const now = performance.now(); if (!isPaused()) left -= now - last; last = now; if (left <= 0) { clearInterval(id); res(); } }, 100); }); p.cancel = () => clearInterval(id); return p; }
let currentItem = null, lastSay = null;
function enqueue(item) {
  if (item.turn && item.turn.held) { item.turn.held.push(item); requestRelease(item.turn); return; }   // asked in the background: wait to take over
  if (item.turn && item.turn.parkedQ) { item.turn.parkedQ.push(item); return; }   // its answer is set aside: keep for Continue
  queue.push(item); if (!queueRunning) runQueue();
}
async function runQueue() {
  queueRunning = true; updateSendBtn();
  for (;;) {
  while (queue.length) {
    await whilePaused();
    // a background answer is ready: let the current sentence finish, then hand over before the next one starts
    if (switchReq && queue[0] && queue[0].say != null) { await within(narrationDone, 8000); takeSwitch(); continue; }
    const it = queue.shift(); if (!it) continue;
    // the view follows the answer; an answer whose tab was closed is dropped (never drawn on another board), and
    // tidy-up fixes for a tab that is no longer on screen are left out
    if (it.turn && it.turn.tab && it.turn.tab !== activeTab) {
      if (!tabs.has(it.turn.tab) || it.fix) { dlog('dropped a line for a tab not on screen', it.fix ? '(tidy fix)' : '(tab closed)'); continue; }
      switchTabNow(it.turn.tab, 'follow');   // between items: nothing is animating
    }
    if (it.say != null && Voice.enabled()) Voice.prefetch(queue.filter(q => q.say != null && q.voice).slice(0, 2).map(q => q.voice));
    currentItem = it;
    try {
    if (it.say != null) {
      lastSay = it;
      if (!it.repeat) recordSay(it.turn, it.say);   // a sentence said again after coming back belongs to its step already
      if (EMBED) liveCaption(it.say);
      if (it.voice && Voice.enabled()) {
        // one narrated sentence at a time: wait until the previous one (and the drawing after it) is done
        const w0 = Date.now();
        await within(narrationDone, 45000);
        if (Date.now() - w0 > 44000 && !isPaused()) dlog('narration wait timed out; continuing');
        if (it.run && it.run.gen !== gen) continue;
        const guard = psleep(100000);
        const r = await Promise.race([Voice.play(it.voice), guard.then(() => { dlog('voice.play timed out'); return { duration: 0, done: Promise.resolve() }; })]);
        guard.cancel();
        if (it.run && it.run.gen !== gen) continue;
        dlog('say', r.duration ? r.duration.toFixed(1) + 's' : 'no audio', JSON.stringify(it.say.slice(0, 50)));
        beginPace(r.duration || it.say.length / SPEAK_CPS);
        if (!it.repeat) typeInto(it.turn, it.say, r.duration ? it.say.length / r.duration : null);
        narrationDone = r.done.then(() => sleep(250)); r.done.then(updateSendBtn);
        updateSendBtn();
      } else { beginPace(it.say.length / SPEAK_CPS); if (!it.repeat) typeInto(it.turn, it.say, SPEAK_CPS); }
      continue;
    }
    const run = it.run;
    dlog('draw', it.cmd.cmd, it.cmd.id || '', run.gen === gen ? '' : '(stale run)');
    if (it.turn.thinking) { const bd = it.turn.el.querySelector('.body'); bd.classList.remove('thinking'); bd.textContent = ''; it.turn.thinking = false; renderTeaching(); }
    const before = it.cmd.id;
    queueBusy = true;
    const nextSay = queue.findIndex(x => x.say != null);
    setPaceShare(1 + (nextSay < 0 ? queue.length : nextSay));
    await execCommand(it.cmd, run, true);
    badgesSoon();
    paceShare = null; queueBusy = false;
    if (run.gen === gen || it.keep) recordCmd(it.turn, it.cmd);   // keep: finished instantly when its answer was set aside
    if (before) it.turn.drew.add(before);
    if (it.cmd.cmd === 'erase') it.cmd.ids.forEach(i => it.turn.drew.add('erased ' + i));
    } catch (err) {
      dlog('skipped a queue item after an error:', String(err && err.stack || err).slice(0, 300), JSON.stringify(it.cmd || { say: it.say }).slice(0, 200));
      hideIcon(pen); hideIcon(eraser); queueBusy = false;
    }
  }
  // let the last sentence finish; more lines may stream in meanwhile, so check again before going idle
  await within(narrationDone, 45000);
  if (switchReq) takeSwitch();
  if (!queue.length) break;
  }
  queueRunning = false; currentItem = null; updateSendBtn(); renderResumeBar();
}

// ======================================================================
// the prompt
// ======================================================================
function boardSummary() {
  const b = allBounds(), v = viewRect(), r = n => Math.round(n);
  const lines = [];
  if (!b) lines.push('The board is empty. Start near (0, 0).');
  else {
    lines.push(`Everything drawn spans x ${r(b.x)}..${r(b.x + b.width)}, y ${r(b.y)}..${r(b.y + b.height)}.`);
    lines.push(`Free space: to the right starting at x=${r(b.x + b.width + 80)} (y from ${r(b.y)}), and below starting at y=${r(b.y + b.height + 80)} (x from ${r(b.x)}).`);
  }
  lines.push(`The learner is looking at x ${r(v.x)}..${r(v.x + v.width)}, y ${r(v.y)}..${r(v.y + v.height)}.`);
  const list = [...objs.values()].slice(-70);
  if (list.length) {
    lines.push(`Objects on the board (${objs.size} total${objs.size > 70 ? ', last 70 shown' : ''}):`);
    for (const o of list) lines.push('- ' + objLine(o));
  }
  return lines.join('\n');
}
// one drawing, in a line: id, kind, its words and numbers, where it is (`full` keeps longer text and values)
function objLine(o, full = false) {
  const c = o.cmd, bb = bbOf(o), r = n => Math.round(n), bits = [`${c.id} ${c.cmd}`, c.color], n = full ? 4 : 1;
  if (c.text) bits.push(JSON.stringify(c.text.slice(0, 60 * n)));
  if (c.label) bits.push('label ' + JSON.stringify(c.label));
  if (c.sub) bits.push('sub ' + JSON.stringify(c.sub));
  if (c.values) bits.push('values ' + JSON.stringify(c.values).slice(0, 80 * n));
  if (c.cmd === 'arrow') bits.push(`from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`);
  if (c.cmd === 'highlight') bits.push(`on ${c.target}`);
  if (c.cmd === 'flow') bits.push(`dots moving along ${c.on}`);
  if (c.cmd === 'ink') bits.push("the learner's own pen sketch");
  if (c.cmd === 'icon') bits.push('icon ' + c.name);
  if (c.cmd === 'tokens') bits.push('items ' + JSON.stringify(c.items.map(i => i.text)).slice(0, 90 * n));
  if (c.cmd === 'frame' || c.cmd === 'brace') bits.push('around ' + c.around.join(','));
  if (c.cmd === 'schedule') bits.push('rows ' + c.rows.map(rw => rw.label).join(',') + ` · ${c.steps} steps`);
  if (c.cmd === 'math') bits.push('tex ' + JSON.stringify(c.tex.slice(0, 60 * n)));
  if (c.cmd === 'graph') bits.push(`nodes ${c.nodes.map(n => n.id).join(',').slice(0, 80 * n)}`);
  if (c.cmd === 'network') bits.push(`layers ${c.layers.join('-')}`);
  bits.push(`box x${r(bb.x)} y${r(bb.y)} w${r(bb.width)} h${r(bb.height)}`);
  return bits.filter(Boolean).join(' · ');
}
function systemPrompt() {
  return `You are a great teacher at a whiteboard. The board SHOWS the idea (pictures, not text); your voice EXPLAINS it: the reasoning, the why, the cause and effect, while the pen draws. A learner should come away actually understanding, not just having seen a diagram.

BOARD (infinite; units are board units; x grows right, y grows down)
What is on the board right now (every drawing, where it is), the lesson in progress and what the learner selected come at the start of the learner's latest message, under "BOARD NOW". Always work from the latest BOARD NOW; older messages describe older boards.

OUTPUT: JSON Lines only, one object per line, nothing else (no markdown, no code fences, no prose outside JSON).
Spoken line: {"say":"one short sentence"}   It is spoken while the drawing commands right after it are drawn, so it must explain exactly those.
Board commands (each line has "cmd"). Place things with "near" instead of guessing coordinates: "near":{"of":"<id>","side":"right|left|below|above","gap":70}. Give x,y only for the very first object of a new area (use the free space listed above).

Pictures, best first:
{"cmd":"icon","id":"gpu","name":"gpu","label":"GPU","near":{"of":"q","side":"right"}}   icons: ${window.WB_ICONS ? WB_ICONS.names.join(', ') : 'gpu, server, database, person, document'} (plus common synonyms). Use them for every real-world thing.
{"cmd":"tokens","id":"r1","items":["The","cat","sat",""],"color":"#1d6fb8","highlight":[2],"label":"request A","near":{"of":"gpu","side":"below"}}   a row of chips: tokens, words, slots, packets, queue items, array cells ("" = empty slot); "vertical":true for a stack
{"cmd":"box","id":"b1","x":0,"y":0,"label":"Scheduler","sub":"every step","color":"#1d6fb8","fill":true}   a component
{"cmd":"circle","id":"c1","label":"x","color":"#2a8a3e","fill":true,"near":{"of":"b1","side":"right"}}
{"cmd":"arrow","id":"a1","from":"b1","to":"c1","label":"sends","curve":0.2,"dash":false,"color":"#1f2328"}   from/to = ids (or [x,y]); this is how anything moves or causes anything
{"cmd":"frame","id":"f1","around":["gpu","r1"],"label":"one batch"}   groups related things (icons, boxes, tokens) in a dashed box; not around arrows
{"cmd":"brace","id":"br1","around":["r1"],"side":"below","label":"4 tokens"}   measures or names a span
{"cmd":"schedule","id":"s1","x":0,"y":0,"label":"GPU slots over time","rows":[{"label":"slot 1","spans":[[0,4,"A","#1d6fb8"],[4,6,"D","#2a8a3e"]]},{"label":"slot 2","spans":[[0,2,"B","#c48a00"]]}],"steps":6,"markers":[{"at":2,"label":"B done"}]}   what happens when: time steps across, lanes down (from inclusive, to exclusive)
{"cmd":"sequence","id":"sq","actors":["Client","Server"],"messages":[["Client","Server","SYN seq=100"],["Server","Client","SYN-ACK"],["Client","Server","ACK",true]],"label":"handshake"}   who sends what to whom, in order (protocols, API calls, requests); true = dashed reply
{"cmd":"graph","id":"g1","nodes":["Client","API","DB"],"edges":[["Client","API","request"],["API","DB"]],"layout":"layered|circle|grid","near":{"of":"b1","side":"below"}}   flows, pipelines, state machines
{"cmd":"tree","id":"t1","root":{"label":"root","children":[{"label":"left"},{"label":"right"}]}}
{"cmd":"network","id":"nn","layers":[3,4,2],"labels":["in","hidden","out"]}
{"cmd":"bars","id":"p1","values":[0.1,0.6,0.3],"labels":["cat","sat","mat"],"label":"probability"}   compare amounts
{"cmd":"numberline","id":"n1","from":0,"to":10,"marks":[{"at":3,"label":"w"}]}   {"cmd":"timeline","id":"tl","events":[{"label":"v1","at":"2019"}]}
{"cmd":"vector","id":"v1","values":[0.2,0.7],"label":"q 2×1","orient":"column"}   a vector: "orient":"row" lays it across (a token's row, 1×N), "column" stands it up (N×1); the label's shape must match
{"cmd":"matrix","id":"m1","values":[[1,0],[0,1]],"label":"W 2×2","highlightRows":[1],"highlightCols":[0],"highlightCells":[[1,0]]}   tint the rows / columns / cells (0-based) the sentence is about; change them with update as the computation moves   {"cmd":"plot","id":"f","fn":"sigmoid|exp|tanh|relu|gelu|sin|log","label":"σ"}
{"cmd":"table","id":"tb","header":["Model","Params"],"rows":[["A","1B"]]}   only for real reference numbers, never for explaining
{"cmd":"math","id":"e1","x":0,"y":0,"tex":"E = mc^2"}   {"cmd":"code","id":"k1","code":"x = 1","lang":"python"}   {"cmd":"line","id":"l1","points":[[0,0],[100,40]]}
Changing the board:
{"cmd":"highlight","id":"h1","target":"r1","style":"circle|underline|box","color":"#e07800"}   point at what you are talking about
{"cmd":"update","id":"r1","items":["The","cat","sat","on"],"highlight":[3]}   redraw an object with new values: show change step by step
{"cmd":"move","id":"r1","dx":0,"dy":120}   {"cmd":"erase","ids":["a1"]}   {"cmd":"clear"}
Words on the board, sparingly:
{"cmd":"write","id":"h","x":0,"y":0,"text":"Continuous batching","size":34}   a heading, or a 1-4 word caption. Never a sentence.

Colours (dark markers on white): blue #1d6fb8, amber #c48a00, green #2a8a3e, red #d1382c, purple #7a48c2, orange #e07800, black #1f2328, grey #7d848c. Give each kind of thing one colour and keep it.

HOW TO TEACH HERE: SHOW IT ON THE BOARD, EXPLAIN IT IN YOUR VOICE
0. DECIDE THE DEPTH FIRST. Before anything else, work out what this learner actually needs from their question: its intent and meaning, what is already on the board, and what came before in the conversation. Never decide from the wording alone. Then start the answer with one hidden planning line (never shown):
   {"plan":{"depth":"quick|explain|deep","why":"<what the learner needs, max 15 words>","pictures":"<the pictures and the tool for each>","parts":["<deep only: 3-6 short part names>"],"now":[1]}}
   - quick: ONLY when they need one fact, a name, a yes/no, or a small correction, and nothing about it is confusing them. 1-2 sentences and the smallest drawing that makes it clear. Never use quick for a "why" or "how", or for something they have not understood yet.
   - explain: they want to understand one idea that has a real reason behind it. Build one worked picture step by step and explain the reasoning behind each step.
   - deep: understanding needs several connected ideas (a mechanism with stages, a trade-off, a derivation, a system with moving parts), or the learner is still confused after an earlier explanation. Split it into 3-6 parts in "parts" and teach the first two or three now ("now" = their numbers, starting at 1), each under its own short heading in fresh space. Stop at a natural checkpoint; the rest is taught when the learner continues.
   Answers stream live and the learner follows along as you draw and speak, so a long answer costs them nothing: when unsure between two depths, choose the fuller one. Only quick answers should be short.
   Read the conversation, not just the last message. If the learner asked about this before, says it is still unclear, or keeps asking "why" about the same thing, your last explanation did not land: go DEEPER, never shorter. Start again from the idea they are missing (often a more basic one), take a different angle (a new concrete example, real numbers carried through, an analogy drawn as a picture), and move in smaller steps. Do not repeat or summarise what you already said.
   What depth means: depth is understanding, not more pictures. A deep or explain answer makes the learner see WHY each step happens. Explain the cause behind each step, carry one concrete example with real values through every step, and say what would go wrong without it. Name the misconception the learner probably has and fix it. End on the one sentence that ties it together.
   When a lesson is in progress (see LESSON IN PROGRESS above) and the learner wants to go on, plan depth "deep" with the same "parts" and "now" = the next part numbers. A question about something else is answered on its own at its own depth; the lesson waits.
   Pick the tool that makes each idea obvious at a glance, e.g. protocol or request/response → sequence; anything over time → schedule; a system → icons + arrows inside frames.
1. Every idea becomes a picture. Ask "what does this look like?" and draw that: things → icons or boxes; sequences, tokens, slots, queues → tokens; what happens over time → schedule (or several snapshots side by side); cause and movement → arrows; parts of a whole → frame; sizes and counts → brace, bars; structure → graph, tree, network.
2. Draw the concrete example itself (the actual tokens, requests, numbers, names), never a description of it.
3. Board text is labels only: 1-4 words or a number. At most 3 write commands per answer (a heading and short captions); in deep, one heading per part plus 2 captions. The explaining happens in your voice, not in board text. No sentences, definitions, legends or bullet lists on the board.
4. Spoken lines: each is one sentence (at most 22 words) that explains the drawing that follows it: what it is AND why it works that way. Do not just name what is drawn ("this is the matrix"); say what it means and why it matters ("each row mixes all four inputs, so every output sees the whole token"). As many lines as the understanding needs: 1-2 for quick, about 8-14 for explain, about 8-12 per part for deep. Do not describe what the drawing already shows plainly; add the reasoning it cannot show. Narrate what the pen is drawing right now: each sentence explains the commands that follow it, up to the next sentence. Never talk ahead about something drawn later, or back about something drawn earlier without updating or highlighting it. The drawing that goes with a sentence must show exactly what that sentence says: a shape the sentence names (1×2, 3×4) is the shape drawn and highlighted with it, not a bigger picture it is part of (to point at one row of a matrix, tint that row with highlightRows, or draw the row on its own); the next idea's drawing goes after its own sentence.
5. Rhythm: say → 2-5 drawing commands → say → 2-5 drawing commands … The amount follows the depth: a few commands for quick, about 20-40 for explain, about 20-35 per part for deep. At least 85% of them pictures.
6. Layout: one clear diagram per idea, flowing left→right or top→bottom, laid out with near; keep 40+ units between things; put before/after or wrong/right side by side; frame what belongs together. Arrows join things that are next to each other; never draw an arrow across another drawing.
7. Build on the board: keep earlier drawings, extend and update them (update is how a picture changes over time). Erase only a wrong or outdated picture, and say why. A new subject starts with a heading in free space.
8. Objects of type ink are the learner's own pen sketches. When a picture of their sketch is attached, work out from the picture yourself what it shows (never ask them to describe it). Name what you see in one short spoken line, then answer their question about it; if they asked nothing specific, check it: highlight what is right and draw the corrected version next to their sketch. Never erase or move their ink.
9. End every answer with one line of 3 follow-up questions the learner would naturally ask next about what you just drew: {"next":["Why is the disk 10,000× slower?","What if two requests need one slot?","Show LRU vs FIFO eviction"]}. Each at most 8 words, specific to this board (name its actual things), not generic ("tell me more"). Mix: one deeper "why", one "what if", one new example or comparison.
10. THE LEARNER IS TECHNICAL: show the real internals, not just named boxes. When an idea has data inside it, draw that data with real (illustrative) numbers and shapes: tokens → their ids → the embedding vectors (a matrix, rows = tokens, labelled with its shape like "4×8"); a layer → its weight matrix; attention → Q, K, V matrices, the Q·Kᵀ score matrix, the softmax rows, the weighted sum. Show each computation as it happens: the input matrix, the weight matrix, the result matrix side by side with "×" / "=" between them, tint one row and one column and the cell they produce (highlightRows / highlightCols / highlightCells on the matrix), and state the shapes ((4×8)·(8×8) = 4×8). Keep matrices small (3-6 rows/cols) so the numbers stay readable. The numbers are mock values for illustration: pick simple ones (one decimal, like 0.2, 1.0, -0.5) and write a plausible result; never work out exact products or softmaxes in your head, and do not spend your thinking on arithmetic. What must be right are the shapes and which row meets which column. Say once that the numbers are illustrative.
11. LAYERED BOARD: the board is drawn in layers. The first layer is the big picture (the components and the flow). Give every component a specific label so it can be opened later. The learner double-clicks a drawing to open its next layer: when asked to "open up" something, build its insides in fresh space right next to it (a frame labelled with its name, joined to it by a dashed arrow "inside"), one level deeper, with the actual data, shapes and the computation it performs, step by step. Never repeat the big picture there; go down one level, and make the parts inside it specific enough to be opened again.
12. Language: reply in the language of the learner's latest message; that is English unless that message is in Hinglish or asks for Hinglish (then Hinglish in Latin script). Board labels and the "next" questions follow the same language. Say when numbers are only illustrative.
13. FRESH FACTS: when the learner's message carries WEB SEARCH CONTEXT or LINK CONTEXT, ground names, versions, numbers, dates and claims in it and prefer it over your memory when they disagree; say once, briefly, that you looked it up ("I checked the web: ..."). Put the key facts on the board (a small "from the web" note with the source's site name is fine). If it does not cover the question, say what is known and do not invent details. Without such context, if the question depends on something recent that you are unsure of, say that your knowledge may be out of date.

EXAMPLE of the balance wanted (a different topic; notice every spoken line gives a reason, not just a name):
{"plan":{"depth":"explain","why":"wants to know why a cache makes programs faster","pictures":"CPU, cache, disk icons with hit/miss arrows and their times; cache slots as tokens; update them to show eviction"}}
{"say":"The CPU can only work on data it has in hand, so where data lives decides the speed."}
{"cmd":"write","id":"hc","x":0,"y":0,"text":"Caching","size":34}
{"cmd":"icon","id":"cpu","name":"cpu","label":"CPU","near":{"of":"hc","side":"below","gap":50}}
{"cmd":"icon","id":"disk","name":"database","label":"disk","sub":"10 ms","near":{"of":"cpu","side":"right","gap":420}}
{"say":"Fetching from disk takes ten milliseconds: ten million CPU steps spent just waiting."}
{"cmd":"arrow","id":"slow","from":"cpu","to":"disk","label":"10 ms","dash":true,"color":"#d1382c"}
{"say":"So we keep a small, fast memory right beside the CPU for data we just used."}
{"cmd":"icon","id":"mem","name":"memory","label":"cache","sub":"1 ns","near":{"of":"cpu","side":"right","gap":160}}
{"cmd":"arrow","id":"hit","from":"cpu","to":"mem","label":"hit","color":"#2a8a3e"}
{"say":"This works because programs reuse the same data again and again within moments."}
{"cmd":"tokens","id":"slots","items":["user:7","post:3",""],"label":"cache slots","near":{"of":"mem","side":"below","gap":70}}
{"cmd":"brace","id":"cap","around":["slots"],"side":"below","label":"3 slots"}
{"say":"A hit costs one nanosecond; only a miss pays the full trip to disk."}
{"cmd":"erase","ids":["slow"]}
{"cmd":"arrow","id":"miss","from":"mem","to":"disk","label":"miss","dash":true,"color":"#d1382c"}
{"say":"The cache is tiny, so when it fills, the entry least likely to be reused must go."}
{"cmd":"update","id":"slots","items":["post:3","feed:1","user:9"],"highlight":[2]}
{"cmd":"highlight","id":"hl","target":"slots","style":"box","color":"#e07800"}
{"say":"So a cache is a bet on reuse: win it often, and slow storage feels fast."}
{"next":["Why is the disk so much slower?","What if two keys want one slot?","Compare LRU and FIFO eviction"]}`;
}
// The parts of the prompt that change between calls (board, outline, selection, session name) go at the start of the
// latest user message, not in the system prompt: providers cache a prompt by its unchanged beginning, so the long
// system prompt and the chat history stay cached across the answer, its side questions and its follow-ups.
function boardNow(selIds = []) {
  return `BOARD NOW (session "${lesson.topic}": just a label for this whiteboard; teach whatever the learner asks)
${boardSummary()}
${outlinePrompt()}${selIds.length ? `\nTHE LEARNER SELECTED: ${selIds.map(id => `${id} (${nameOf(id)})`).join(', ')}. Work on these directly: update them, build next to them, point at them.\n` : ''}
END OF BOARD NOW

`;
}
function buildMessages(question, selIds, inkIds = [], image = null, steer = false, aside = false) {
  const msgs = [{ role: 'system', content: systemPrompt() }];
  const hist = chat.filter(m => m.role === 'user' || m.role === 'assistant').slice(-8);
  for (const m of hist) {
    if (m.role === 'user') msgs.push({ role: 'user', content: (m.about && m.about.length ? `[About the selected drawings: ${m.about.join(', ')}] ` : '') + (m.sketch ? `[With my sketch: ${m.sketch.join(', ')}] ` : '') + m.text });
    else msgs.push({ role: 'assistant', content: (m.text || '(drew only)') + (m.interrupted ? '\n(The learner interrupted me here with their next message.)' : '') + (m.drew && m.drew.length ? `\n(On the board I drew or changed: ${m.drew.join(', ')})` : '') });
  }
  const text = boardNow(selIds) + (aside ? '[I asked this on the side while you were teaching. Answer just this question, building in free space next to what it is about; your earlier explanation continues by itself afterwards, so do not continue or repeat it here.] ' : '') + (steer ? '[I sent this while you were still answering, so you stopped after your current sentence. Take it into account now: answer or adjust as it asks, then carry on with whatever part of your previous answer still matters, without repeating what is already on the board.] ' : '') + (selIds.length ? `[I selected on the board: ${selIds.join(', ')}] ` : '') + (inkIds.length ? `[I drew a sketch on the board (${inkIds.join(', ')}). ${image ? 'A picture of it, with the drawings around it, is attached: work out what it shows from the picture.' : 'Its strokes are listed in the board summary.'}] ` : '') + question;
  msgs.push({ role: 'user', content: image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text });
  return msgs;
}

// ======================================================================
// sending a question: one streamed call that talks and draws
// ======================================================================
// ======================================================================
// look & tidy: after an answer is drawn, the teacher looks at a picture of it and fixes what is unclear
// ======================================================================
function regionAround(ids, grow) {
  const r = unionBox(ids); if (!r) return null;
  const area = { x: r.x - grow, y: r.y - grow, width: r.width + 2 * grow, height: r.height + 2 * grow };
  const near = [...objs.keys()].filter(k => overlaps(area, bbOf(objs.get(k)), 0));
  return unionBox(ids.concat(near));
}
// Cheap geometric checks the picture review is told about: overlaps, arrows through drawings, cut labels.
function layoutIssues(ids) {
  const out = [], mine = new Set(ids), solid = [...objs.values()].filter(o => BOXLIKE.has(o.cmd.cmd));
  const shrink = (b, m) => ({ x: b.x + m, y: b.y + m, width: Math.max(0, b.width - 2 * m), height: Math.max(0, b.height - 2 * m) });
  const inside = (p, b) => p[0] > b.x && p[0] < b.x + b.width && p[1] > b.y && p[1] < b.y + b.height;
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    if (!mine.has(a.cmd.id) && !mine.has(b.cmd.id)) continue;
    if (overlaps(shrink(bbOf(a), 2), shrink(bbOf(b), 2), 0)) out.push(`${a.cmd.id} (${nameOf(a.cmd.id)}) overlaps ${b.cmd.id} (${nameOf(b.cmd.id)})`);
  }
  for (const id of ids) {
    const o = objs.get(id); if (!o || o.cmd.cmd !== 'arrow') continue;
    const geo = arrowGeometry(o.cmd); if (!geo) continue;
    const [p1, q, p2] = geo, hit = new Set();
    for (let k = 2; k <= 18; k++) {
      const t = k / 20, u = 1 - t, p = [u * u * p1[0] + 2 * u * t * q[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * q[1] + t * t * p2[1]];
      for (const s of solid) if (s.cmd.id !== o.cmd.from && s.cmd.id !== o.cmd.to && inside(p, shrink(bbOf(s), 6))) hit.add(s.cmd.id);
    }
    if (hit.size) out.push(`arrow ${id} passes through ${[...hit].map(h => `${h} (${nameOf(h)})`).join(', ')}`);
  }
  for (const id of ids) {
    const c = objs.get(id) && objs.get(id).cmd; if (!c) continue;
    const texts = [c.label, c.sub, c.text, ...(c.items || []).map(x => x.text)].filter(Boolean);
    if (texts.some(t => /…$/.test(t))) out.push(`${id} has a label that was cut off (ends in …): give it a shorter label`);
  }
  return out.slice(0, 14);
}
async function waitForBoard(run, signal) {
  const t0 = Date.now();
  while ((queue.length || queueBusy) && run.gen === gen && !signal.aborted && Date.now() - t0 < 300000) await sleep(150);
}
async function tidyPass({ question, answer, model, run, turn, signal }) {
  await waitForBoard(run, signal);
  if (run.gen !== gen || signal.aborted) return;
  const offTab = () => turn.tab && turn.tab !== activeTab;
  if (offTab()) { dlog('tidy: skipped, its tab is not on screen'); return; }
  const ids = [...turn.drew].filter(id => objs.has(id) && objs.get(id).cmd.cmd !== 'ink');
  if (!ids.length) return;
  const issues = layoutIssues(ids);
  if (ids.length < 3 && !issues.length) return;           // a tiny edit: nothing worth reviewing
  const vm = (modelInfo(model) || {}).vision ? model : ((models.find(m => m.id === 'deepseek-v4.1-flash' && m.vision) || models.find(m => m.vision) || {}).id);
  if (!vm && !issues.length) return;
  const status = document.createElement('div'); status.className = 'tidy'; status.textContent = '👀 Checking the drawing…';
  turn.el.appendChild(status); scrollChat();
  const region = regionAround(ids, 120);
  let image = null;
  if (vm && region) { try { image = await boardImage(region); } catch (e) { dlog('tidy: picture failed', String(e)); } }
  if (offTab()) { status.remove(); dlog('tidy: skipped, the view moved to another tab'); return; }
  const r = n => Math.round(n);
  const text = boardNow() + `REVIEW YOUR BOARD. ${image ? `The attached picture shows what you just drew (board area x ${r(region.x)}..${r(region.x + region.width)}, y ${r(region.y)}..${r(region.y + region.height)}). Look at it the way the learner sees it.` : 'You cannot see a picture this time: use the checks below and the object list.'}
Objects you drew in this answer: ${ids.join(', ')}.
Automatic checks found:
${issues.length ? issues.map(s => '- ' + s).join('\n') : '- nothing obvious'}

Fix only real problems: drawings that overlap or touch, arrows that cross other drawings or point at the wrong thing, labels that are cut off or unreadable, a cramped or messy layout, something in the picture that is wrong or confusing, or a missing arrow or label the explanation needs.
Reply with JSON Lines of fix commands only:
- move: {"cmd":"move","id":"x","dx":0,"dy":120}  (arrows, frames, braces and highlights follow automatically)
- update: change fields of one object, e.g. a shorter "label", or "curve":0.4 to bend an arrow around something
- erase: a duplicate or wrong drawing
- at most 3 new small drawings (arrow, highlight, brace) if the explanation needs them
At most ${FIX_MAX} lines. No say lines, no plan, no write, no clear. Never touch ink objects (the learner's sketches). Leave what is fine alone.
If the board already looks clear, reply with exactly {"ok":true}`;
  const msgs = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: question },
    { role: 'assistant', content: answer.slice(0, 6000) || '(drew only)' },
    { role: 'user', content: image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text },
  ];
  const useModel = vm || model;
  const before = turn.fixes || 0;
  try {
    await streamAnswer(msgs, { model: useModel, effort: useModel === settings.model ? (currentEffort() === 'auto' ? null : currentEffort()) : (defaultEffort(useModel) === 'auto' ? null : defaultEffort(useModel)), run, turn, signal, fix: true });
    await waitForBoard(run, signal);
  } catch (e) {
    if (e.name !== 'AbortError' && !signal.aborted) dlog('tidy: review failed', e.code || '', e.message);
    status.remove(); return;
  }
  const n = (turn.fixes || 0) - before;
  dlog('tidy:', issues.length, 'issues found,', n, 'fixes applied');
  status.textContent = n ? `✨ Tidied ${n} thing${n === 1 ? '' : 's'} on the board` : '✓ Drawing checked';
  setTimeout(() => status.remove(), 4000);
}

// ======================================================================
// depth: the model decides from the meaning of the question how much to teach ({"plan":{"depth":…}}).
// The app never inspects the question's words; it only sizes its limits to the model's own decision.
// ======================================================================
const DEPTH_LIMITS = {
  quick:   { cmds: 30,  writes: 2, minPics: 0 },   // a crisp answer is never forced into a big drawing
  explain: { cmds: 90,  writes: 5, minPics: 4 },
  deep:    { cmds: 170, writes: 9, minPics: 6 },
};
const limitsOf = turn => DEPTH_LIMITS[turn.depth] || DEPTH_LIMITS.explain;
function applyPlan(turn, plan) {
  const depth = ['quick', 'explain', 'deep'].includes(plan.depth) ? plan.depth : 'explain';
  turn.depth = depth;
  dlog('plan:', depth, '·', str(plan.why, 120), '·', str(plan.pictures, 160));
  if (depth !== 'deep') return;
  const parts = (Array.isArray(plan.parts) ? plan.parts : []).map(x => clip(x, 48)).filter(Boolean).slice(0, 8);
  if (parts.length < 2) return;
  const now = (Array.isArray(plan.now) ? plan.now : [plan.now]).map(n => Math.round(num(n, 0, 0, 8))).filter(n => n >= 1 && n <= parts.length);
  const prev = lesson.outline, same = prev && prev.parts.length === parts.length && prev.parts.every((x, i) => x.toLowerCase() === parts[i].toLowerCase());
  lesson.outline = { parts, done: Math.max(same ? prev.done : 0, now.length ? Math.max(...now) : 1) };
  saveSoon();
}
function outlinePrompt() {
  const o = lesson && lesson.outline;
  if (!o || o.done >= o.parts.length) return '';
  return `\nLESSON IN PROGRESS (taught: ${o.done} of ${o.parts.length} parts):\n${o.parts.map((x, i) => `${i < o.done ? '✓' : '·'} ${i + 1}. ${x}`).join('\n')}\n`;
}

// Steering: a message sent mid-answer. The model stops writing, the board finishes the sentence it is on
// (voice and pen), the rest of that answer is dropped, and the new message is answered with that context.
let steering = false;
async function softStop() {
  steering = true;
  if (abortCtl) abortCtl.abort();
  const k = queue.findIndex(x => x.say != null);
  if (k >= 0) { dlog('steer: dropped', queue.length - k, 'queued lines'); if (queue[k].turn) queue[k].turn.msg.interrupted = true; queue.splice(k); }
  const t0 = Date.now();
  while ((streaming || queueRunning) && Date.now() - t0 < 25000) await sleep(80);
  if (streamingLive() || queueRunning) {
    dlog('steer: the sentence did not end, cutting just this answer short');
    gen++; queue.length = 0; Voice.stop(); narrationDone = Promise.resolve(); if (abortCtl) { abortCtl.abort(); abortCtl = null; }
    finishTyping(); hideIcon(pen); hideIcon(eraser);
    for (let i = 0; i < 40 && queueRunning; i++) await sleep(50);
  }
  steering = false;
}
async function send(q, opts = {}) {
  // until its stream opens, the teacher must not go back to a set-aside answer
  let open = false; const opened = () => { if (!open) { open = true; sendsPending = Math.max(0, sendsPending - 1); } };
  sendsPending++;
  try { return await sendQ(q, opts, opened); } finally { opened(); updateSendBtn(); }
}
// Reads the links in a question (server side, /api/links) while the thinking line says so, then notes under the
// learner's message what was read. Best effort: on any failure the answer goes ahead (/api/chat reads them itself).
async function readLinksFirst(q, ub, status, signal) {
  const urls = (String(q).match(/\bhttps?:\/\/[^\s<>"'`]+/gi) || []).slice(0, 3);
  if (!urls.length) return;
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  status(`🔗 Reading ${[...new Set(urls.map(host))].join(', ')}…`);
  try {
    const r = await fetch('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q }), signal });
    const j = r.ok ? await r.json() : null;
    if (!j || !j.links || !j.links.length) return;
    dlog('links:', j.links.map(l => `${l.host} ${l.ok ? 'ok via ' + l.source + ', ' + l.chars + ' chars' : 'failed: ' + l.error}`).join(' | '));
    const note = document.createElement('span'); note.className = 'about linknote';
    note.textContent = j.links.map(l => l.ok ? `🔗 read ${l.host}${/search/.test(l.source) && !/page|post|extract/.test(l.source) ? ' (web search only)' : ''}` : `⚠ couldn't read ${l.host}`).join(' · ');
    note.title = j.links.map(l => `${l.url}\n${l.ok ? `${l.title ? l.title + '\n' : ''}via ${l.source}` : l.error}`).join('\n\n');
    ub.appendChild(note); scrollChat();
  } catch (e) { if (signal.aborted) throw e; dlog('links: read failed', String(e)); }
}
// Web search when needed: the server asks the model (at low reasoning) whether the answer needs current information;
// if so it searches (Tavily, or DuckDuckGo) while the thinking line says so, and a note under the learner's message
// says what was searched. Returns true when the answer should get the results. Best effort: failures just skip it.
async function searchFirst(messages, model, ub, status, signal) {
  // always on in the app (the server's WEB_SEARCH=off still turns it off)
  const slim = messages.filter(m => m.role !== 'system').slice(-12).map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text') : m.content }));
  const post = step => fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model, session: lesson.session, messages: slim, step }) }).then(r => r.ok ? r.json() : null);
  try {
    const t0 = Date.now(), plan = await post('plan');
    dlog('web search plan:', plan ? `${plan.search ? 'search' : 'no search'} via ${plan.via || '-'} ${JSON.stringify(plan.queries || [])}` : 'failed', `${Date.now() - t0}ms`);
    if (!plan || !plan.search || !(plan.queries || []).length) return false;
    status(`🔎 Searching the web: “${plan.queries[0].slice(0, 60)}”…`);
    const r = await post('run');
    if (!r) return true;
    const hits = (r.results || []).flatMap(x => x.hits || []);
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    dlog('web search:', (r.results || []).map(x => `“${x.q}” ${x.engine || ''} ${x.error ? 'failed: ' + x.error : (x.hits || []).length + ' results'}`).join(' | '), `${Date.now() - t0}ms`);
    const note = document.createElement('span'); note.className = 'about linknote';
    note.textContent = hits.length ? `🔎 searched the web: ${[...new Set(hits.map(h => host(h.url)).filter(Boolean))].slice(0, 3).join(', ')}${hits.length > 3 ? ` (${hits.length} results)` : ''}` : '🔎 searched the web: nothing useful found';
    note.title = (r.results || []).map(x => `“${x.q}” (${x.engine || 'search'})\n${(x.hits || []).map(h => `• ${h.title}\n  ${h.url}`).join('\n')}`).join('\n\n');
    ub.appendChild(note); scrollChat();
    return hits.length > 0;
  } catch (e) { if (signal.aborted) throw e; dlog('web search failed', String(e)); return false; }
}
async function sendQ(q, opts, opened) {
  if (!lesson) newSession();
  const askedIn = liveTurn;                 // the answer this question was asked inside (named on the way back)
  if (!opts.parallel) tabAway = false;     // asked while looking at another tab: afterwards the set-aside answer is gone back to
  if (opts.parallel) { /* the lesson keeps going; see releaseHeld */ }
  else if (opts.side) parkLive('question');
  else if (opts.steer && (streamingLive() || queueRunning) && !scrub) {
    const um = { role: 'user', text: q, steer: true }; // shown right away; the answer follows once the sentence ends
    const pendingEl = bubble(um); pendingEl.classList.add('pending');
    await softStop();
    pendingEl.remove();
  } else if (streamingLive() || queueRunning || replaying || scrub) stopAll(false, 'new question replaces the answer');
  if (scrub) exitScrub();
  Voice.unlock();
  $('#modelPop').hidden = true;
  // opts.ids: the drawings a popup hand-off is about (used instead of the selection; a pending sketch is left alone)
  // a double-click or a popup's "draw it" opens the drawing in its own tab (or the tab it already has)
  const into = tabTarget(opts.newTab, opts.ids);
  const own = !!(opts.ids || opts.newTab);
  const selIds = into ? [] : (opts.ids || [...selection]).filter(id => objs.has(id));
  const inkIds = own ? [] : [...inkSinceAsk].filter(id => objs.has(id));
  const tabId = into ? into.tab : activeTab;
  let image = null;
  if (inkIds.length) { try { const reg = inkRegion(inkIds); if (reg) image = await boardImage(reg); } catch (e) { console.warn('sketch image failed', e); } }
  if (!own) { inkSinceAsk.clear(); $('#attach').hidden = true; input.placeholder = 'Ask about…'; }
  const messages = withTab(tabId, () => buildMessages(into ? into.note + q : q, selIds, inkIds, image, !!opts.steer, !!opts.aside));
  const tabTag = tabId !== TAB_MAIN ? { tab: tabId, tabTitle: tabTitle(tabId) } : {};
  const userMsg = { role: 'user', text: q, about: into ? into.about : selIds.map(nameOf), ...tabTag, sketch: inkIds.length ? inkIds : undefined, steer: opts.steer || undefined, via: opts.via || undefined };
  const held = !!opts.parallel;
  if (!held) chat.push(userMsg);
  const ub = bubble(userMsg);
  if (image) { const im = document.createElement('img'); im.src = image; im.className = 'thumb'; im.alt = 'your sketch'; ub.appendChild(im); }
  const am = { role: 'assistant', text: '', drew: [], meta: '', ...tabTag };
  if (!held) chat.push(am);
  const turn = { msg: am, q: opts.topic || q, from: held ? null : askedIn, text: '', drew: new Set(), el: bubble(am), thinking: true, cmds: 0, key: 't' + Date.now().toString(36), tab: tabId, ask: q, aside: !!opts.aside, intro: opts.intro || null, got: [] };
  am.key = turn.key;   // links the chat message to its answer (a reload finds it again)
  // its place in the order (order.js): a question belongs to the answer that was playing when it was asked; a steer
  // takes the place of the answer it steers (and the questions waiting inside that one move to it)
  turn.seq = ++askSeq;
  if (opts.steer && askedIn) { turn.parentTurn = askedIn.parentTurn || null; reparentQuestions(askedIn, turn); }
  else turn.parentTurn = held ? askedIn || null : null;
  addToTree(turn, q, opts, askedIn);
  const body = turn.el.querySelector('.body'); body.classList.add('thinking');
  // asked in the background: its lines are held (and its bubbles kept out of the chat) until it takes over
  if (held) {
    // the question shows at once, marked as waiting; the answer's bubble appears when it takes over
    turn.el.remove(); ub.classList.add('pending');
    const w = document.createElement('span'); w.className = 'wait'; w.textContent = opts.aside ? '⏳ Answering on the side… the lesson goes on until it is ready' : '⏳ Opening it up… the lesson goes on until it is ready'; ub.appendChild(w);
    turn.held = []; turn.heldUser = { msg: userMsg, el: ub, wait: w }; turn.intro = opts.intro; turn.pulse = opts.pulse || null; turn.askedIn = askedIn;
    pendingHeld.add(turn); renderPendingPill();
  }
  renderChips(); saveSoon();

  let model = settings.model || (models[0] && models[0].id);
  if (lesson.autoName) nameSession(q, model);   // in parallel with the answer, same model
  // a sketch needs a model that can see images
  if (image && !(modelInfo(model) || {}).vision) { const v = models.find(m => m.id === 'deepseek-v4.1-flash' && m.vision) || models.find(m => m.vision); if (v) model = v.id; }
  const eff = model === settings.model ? currentEffort() : defaultEffort(model);
  let effort = eff === 'auto' ? null : eff;
  const run = { gen };
  const myAbort = new AbortController();
  turn.run = run; turn.abort = myAbort;
  if (!held) { abortCtl = myAbort; liveTurn = turn; activeStreams++; turn.counted = true; streaming = true; }
  opened(); updateSendBtn();

  // live "thinking" indicator so a slow reasoning model never looks frozen
  const t0 = Date.now(); let reasoningChars = 0, linkStatus = '';
  const showThinking = () => { if (turn.thinking) body.textContent = linkStatus ? `${linkStatus} ${Math.round((Date.now() - t0) / 1000)}s` : `✎ Thinking… ${Math.round((Date.now() - t0) / 1000)}s${reasoningChars ? ` · reasoning ${reasoningChars > 999 ? Math.round(reasoningChars / 1000) + 'k' : reasoningChars} chars` : ''}`; };
  showThinking();
  const thinkTimer = setInterval(showThinking, 500);

  let modelApplied = null, failed = false;
  try {
    const opts = { model, effort, run, turn, signal: myAbort.signal, onReasoning: n => { reasoningChars += n; } };
    // links in the question: the server reads them first (the answer then gets them from its cache)
    await readLinksFirst(q, ub, s => { linkStatus = s; showThinking(); }, myAbort.signal);
    // could the web help? the server decides (leaning to yes) and searches; the answer then gets the results
    // (not for opening up a drawing: that is about the board, and it must start as fast as possible)
    const searched = /^what is inside /.test(turn.q || '') ? false : await searchFirst(messages, model, ub, s => { linkStatus = s; showThinking(); }, myAbort.signal);
    linkStatus = ''; showThinking();
    const first = { ...opts, search: searched };
    let r1;
    // a completely empty reply (no text, no thinking) is usually a provider hiccup: retry once quietly
    try { r1 = await streamAnswer(messages, first); }
    catch (e) {
      if (myAbort.signal.aborted || turn.cmds) throw e;
      if (e.code === 'empty') r1 = await streamAnswer(messages, first);
      else if (e.code === 'thinking_budget' && lowerEffort(model, effort)) {
        // it thought until the token limit without answering: try once more with the lowest reasoning level
        const low = lowerEffort(model, effort);
        dlog('thinking used the whole budget at', effort || 'auto', '· retrying at', low);
        if (turn.thinking) body.textContent = `✎ Thought too long, trying again with ${low} reasoning…`;
        effort = low; opts.effort = first.effort = low; reasoningChars = 0;
        r1 = await streamAnswer(messages, first);
      } else throw e;
    }
    modelApplied = r1.model;
    let answer = r1.content;
    // The teacher must teach by drawing. If the answer was mostly talk, ask once for the picture.
    if ((turn.pics || 0) < limitsOf(turn).minPics && !myAbort.signal.aborted && run.gen === gen) {
      dlog(`a ${turn.depth || 'explain'} answer had only`, turn.pics || 0, 'pictures: asking for a drawing');
      if (turn.thinking) { body.textContent = '✎ Drawing…'; }
      const follow = messages.concat(
        { role: 'assistant', content: r1.content.slice(0, 6000) || '(no answer)' },
        { role: 'user', content: withTab(turn.tab, () => boardNow()) + 'That was too wordy for a whiteboard. Now SHOW it: add 10-25 drawing commands (icons, tokens, boxes, arrows, frames, braces, schedule, graph…) laid out with "near" next to what is already on the board. Labels of 1-4 words, no write sentences, at most one short say line. Do not repeat what you already said.' });
      const r2 = await streamAnswer(follow, opts);
      modelApplied = r2.model || modelApplied;
      answer += '\n' + r2.content;
    }
    turn.answered = true;   // every line of the answer is in (the tidy-up below only adjusts the board)
    // look at what was drawn and fix what is unclear (best effort; never fails the answer)
    if (settings.tidy !== false && !myAbort.signal.aborted && run.gen === gen)
      await tidyPass({ question: q, answer, model, run, turn, signal: myAbort.signal });
  } catch (err) {
    failed = true;
    if (turn.held) { dropHeld(turn); if (err.name === 'AbortError' || myAbort.signal.aborted) return; }
    if (err.name === 'AbortError' || myAbort.signal.aborted) { if (steering) am.interrupted = true; if (turn.thinking) { body.classList.remove('thinking'); body.textContent = '(stopped)'; turn.thinking = false; } }
    else {
      const code = err.code || 'network';
      dlog('answer failed', code, err.message);
      if (turn.thinking && !turn.cmds && chat.includes(am)) { turn.el.remove(); chat.splice(chat.indexOf(am), 1); }
      const text = code === 'rate_limited' ? 'Rate limited by OpenCode Go. Wait a moment and ask again.'
        : code === 'thinking_budget' ? `${modelName(model)} used its whole token budget thinking and never wrote an answer. Pick a lower reasoning level (⚙ in the chat header) or another model, then ask again.`
        : code === 'not_granted' ? `The API key was rejected (${err.message}). Check ${keyNameFor(model)} in .env (just the key, nothing before it) and restart the server.`
        : code === 'no_api_key' ? `No API key on the server. Put ${keyNameFor(model)} in .env and restart.`
        : code === 'empty' ? `${modelName(model)} returned an empty answer. Try again, or pick another model.`
        : code === 'stalled' ? `${modelName(model)} stopped responding mid-answer. What arrived is shown; ask again or pick another model.`
        : code === 'network' || err instanceof TypeError ? 'Cannot reach the local server. Is `npm start` still running?'
        : `Something went wrong (${code})${err.message ? ': ' + err.message : ''}`;
      const em = { role: 'error', text }; chat.push(em); bubble(em);
    }
  } finally {
    clearInterval(thinkTimer);
    if (turn.counted) activeStreams = Math.max(0, activeStreams - 1);
    streaming = activeStreams > 0; turn.streamDone = true;
    if (turn.held) { if (failed || !turn.held.length) dropHeld(turn); else requestRelease(turn); }
    if (abortCtl === myAbort) abortCtl = null;
    updateSendBtn();
    const finalize = (final) => {
      am.text = turn.text.trim(); am.drew = [...turn.drew].slice(0, 80);
      if (turn.next) am.next = turn.next;
      if (turn.depth) am.depth = turn.depth;
      const st = turn.stats, speed = st && st.ms > 0 && st.tok > 0 ? `${st.est ? '≈' : ''}${Math.round(st.tok / (st.ms / 1000))} tok/s` : '';
      am.meta = `${modelApplied || model || 'model'}${effort ? ' · ' + effort : ''} · ${Math.round((Date.now() - t0) / 1000)}s${speed ? ' · ' + speed : ''}${turn.fixes ? ` · tidied ${turn.fixes}` : ''}`;
      const meta = turn.el.querySelector('.meta'); if (meta) meta.textContent = am.meta;
      if (final && turn.thinking && !failed) { body.classList.remove('thinking'); body.textContent = am.drew.length ? '(drew on the board)' : '(no answer)'; turn.thinking = false; }
      renderChips(); saveSoon();
    };
    const tEnd = Date.now();
    // an answer set aside (paused + a question) is finalized only once it is continued or dropped
    const waitDone = () => { if (turn.parkedQ || turn.held || ((queueRunning || typers.size || Voice.speaking()) && Date.now() - tEnd < 600000)) setTimeout(waitDone, 200); else finalize(true); };
    finalize(); waitDone();
  }
}

// One streamed Chat Completions call. Say lines and board commands are queued as each line completes.
// fix = true: a tidy-up pass. Only board edits are taken (no talking, no clear, never the learner's ink), at most FIX_MAX.
async function streamAnswer(messages, { model, effort, run, turn, signal, onReasoning, fix = false, search = false }) {
  let fixes = 0;
  let content = '', partial = '', jsonBuf = null, modelApplied = null, finish = null, reasoned = 0;
  let usage = null, firstT = 0;   // the provider's token count (last chunk) and when the reply started arriving
  // brace depth outside strings: >0 means the JSON object continues on the next line
  const depthOf = t => { let d = 0, q = false, esc = false; for (const ch of t) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') q = !q; else if (!q) { if (ch === '{' || ch === '[') d++; else if (ch === '}' || ch === ']') d--; } } return d; };
  const tryParse = t => {
    t = t.replace(/,\s*$/, '');
    try { return JSON.parse(t); } catch {}
    if (/}\s*,?\s*{/.test(t)) { try { return JSON.parse('[' + t.replace(/}\s*,?\s*{/g, '},{') + ']'); } catch {} } // {"say":..}{"cmd":..}
    try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch {}                                         // trailing commas
    const m = t.match(/^\{\s*"say"\s*:\s*"(.*)"\s*\}?$/s); if (m) return { say: m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') }; // a say line with a bad escape
    return undefined;
  };
  // the answer's lines so far: after a reload, a cut-off answer is continued from them
  const keepLine = l => { if (fix || !turn || !turn.got) return; turn.got.push(l); if (turn.got.length > INFLIGHT_LINES) turn.got.splice(0, turn.got.length - INFLIGHT_LINES); };
  const handleLine = rawLine => {
    let line = rawLine.trim();
    if (!line || /^```/.test(line)) return;
    if (jsonBuf != null) {
      // a fresh JSON line while a broken one is buffered: drop the broken one
      // (pretty-printed continuation lines never start with {"say"/{"cmd", so a line that does is a new object)
      if (/^\{\s*"(say|cmd|plan|type|op)"/.test(line)) { dlog('dropped unparsable line', jsonBuf.slice(0, 160)); jsonBuf = null; }
      else { jsonBuf += '\n' + line; line = jsonBuf; }
    }
    if (line.startsWith('{') || line.startsWith('[')) {
      let obj = tryParse(line);
      if (obj === undefined) {
        if (depthOf(line) > 0 && line.length < 8000) { jsonBuf = line; return; }  // continues on the next line
        dlog('dropped unparsable line', line.slice(0, 160)); jsonBuf = null; return;
      }
      jsonBuf = null;
      keepLine(line);
      const items = Array.isArray(obj) ? obj : [obj];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (typeof it.plan === 'string') dlog('plan:', it.plan.slice(0, 200));
        if (!fix && it.plan && typeof it.plan === 'object' && typeof it.plan.depth === 'string') applyPlan(turn, it.plan);
        if (!fix && Array.isArray(it.next)) { const nx = it.next.map(x => clip(x, 70)).filter(Boolean).slice(0, 4); if (nx.length) turn.next = nx; }
        if (it.plan && typeof it.plan === 'object' && !lesson.plan) { lesson.plan = { example: str(it.plan.example, 300), colors: it.plan.colors && typeof it.plan.colors === 'object' ? Object.fromEntries(Object.entries(it.plan.colors).slice(0, 8).map(([k, v]) => [str(k, 40), col(v)])) : {} }; saveSoon(); }
        if (it.say != null) {
          const t = trimSay(str(it.say, 1200)); if (t.length < String(it.say).trim().length) dlog('shortened a long spoken line');
          if (!fix) enqueue({ say: t, turn, run, voice: Voice.enabled() ? Voice.prepare(t) : null });
        }
        if (it.cmd || it.type || it.op) {
          if (fix) {
            const c = normalize(it);
            if (!c || c.cmd === 'clear' || c.cmd === 'wait' || c.cmd === 'write' || fixes >= FIX_MAX) { dlog('tidy: skipped', JSON.stringify(it).slice(0, 120)); continue; }
            const touches = c.cmd === 'erase' ? c.ids : ['move', 'update'].includes(c.cmd) ? [c.id] : [];
            const isInk = id => withTab(turn.tab || activeTab, () => !!(objs.get(id) && objs.get(id).cmd.cmd === 'ink'));   // the answer's own board
            if (touches.some(isInk)) { dlog('tidy: left the learner\'s ink alone', c.id); continue; }
            if (c.cmd === 'erase') c.ids = c.ids.filter(id => !isInk(id));
            fixes++; turn.fixes = (turn.fixes || 0) + 1; enqueue({ cmd: c, run, turn, fix: true }); continue;
          }
          if (turn.cmds >= limitsOf(turn).cmds) { dlog('over the per-answer command limit, skipped', it.cmd); continue; }
          const c = normalize(it); if (!c) { dlog('unknown or invalid command skipped', JSON.stringify(it).slice(0, 160)); continue; }
          if (c.cmd === 'write' && (turn.writes = (turn.writes || 0) + 1) > limitsOf(turn).writes) { dlog('too much writing: skipped', c.text); continue; }
          if (PICTURE.has(c.cmd)) turn.pics = (turn.pics || 0) + 1;
          turn.cmds++; enqueue({ cmd: c, run, turn });
        }
      }
    } else {
      jsonBuf = null;
      if (fix) return;
      const t = trimSay(line.replace(/^\s*(say:|assistant:)\s*/i, '').slice(0, 1200));
      keepLine(JSON.stringify({ say: t }));
      enqueue({ say: t, turn, run, voice: Voice.enabled() ? Voice.prepare(t) : null });
    }
  };

  const res = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model, effort, session: lesson.session, messages, search: search || undefined }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error((j.error && j.error.message) || res.statusText), { code: (j.error && j.error.code) || 'http_' + res.status });
  }
  modelApplied = res.headers.get('X-Model');
  const reader = res.body.getReader(), dec = new TextDecoder();
  let sse = '', bytes = 0;
  const t0 = Date.now();
  dlog('stream start', lab(turn), model, effort || 'auto', search ? '· with web search' : '', fix ? '· tidy' : '');
  for (;;) {
    // no bytes for 120 s means the model stalled (reasoning models still stream while thinking)
    let stallTimer;
    const stall = new Promise((_, rej) => { stallTimer = setTimeout(() => rej(Object.assign(new Error('The model stopped sending anything for 2 minutes.'), { code: 'stalled' })), window.__wbtStallMs || 120000); });
    let chunk;
    try { chunk = await Promise.race([reader.read(), stall]); }
    catch (e) { try { reader.cancel().catch(() => {}); } catch {} if (e.code === 'stalled') dlog('stream stalled after', bytes, 'bytes'); throw e; }
    finally { clearTimeout(stallTimer); }
    const { done, value } = chunk;
    if (done) { dlog('stream end', lab(turn), bytes, 'bytes in', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'finish', finish || '-'); break; }
    bytes += value.length;
    sse += dec.decode(value, { stream: true });
    let nl;
    while ((nl = sse.indexOf('\n')) >= 0) {
      const ln = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
      if (!ln.startsWith('data:')) continue;
      const data = ln.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw Object.assign(new Error(j.error.message || 'stream error'), { code: j.error.code || j.error.type || 'stream_error' });
      if (j.model) modelApplied = j.model;
      if (j.usage) usage = j.usage;   // final chunk, when the provider reports usage
      const ch = j.choices && j.choices[0]; if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const delta = ch.delta; if (!delta) continue;
      if (!firstT && (delta.content || delta.reasoning_content || delta.reasoning)) firstT = Date.now();
      const rz = delta.reasoning_content || delta.reasoning;
      if (typeof rz === 'string' && rz) { reasoned += rz.length; onReasoning && onReasoning(rz.length); }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content; partial += delta.content;
        let k;
        while ((k = partial.indexOf('\n')) >= 0) { handleLine(partial.slice(0, k)); partial = partial.slice(k + 1); }
      }
    }
  }
  if (partial.trim()) handleLine(partial);
  if (jsonBuf) { const b = jsonBuf; jsonBuf = null; try { handleLine(b); } catch {} }
  if (!content.trim()) {
    throw Object.assign(new Error(''), { code: reasoned && (finish === 'length' || !finish) ? 'thinking_budget' : 'empty' });
  }
  // tokens/second over this reply's streaming time (a turn can stream several replies: drawing follow-up, tidy-up)
  if (turn && firstT) {
    const exact = !!(usage && usage.completion_tokens != null);
    const st = turn.stats || (turn.stats = { tok: 0, ms: 0, est: false });
    st.tok += exact ? usage.completion_tokens : Math.round((reasoned + content.length) / 4);   // no count from the provider: about 4 characters a token
    st.ms += Date.now() - firstT;
    if (!exact) st.est = true;
  }
  return { content, model: modelApplied };
}
