# Whiteboard Teacher (local)

An AI teacher that explains **any topic** by drawing on an infinite whiteboard. You ask in the side chat; the teacher answers with short caption lines in the chat while a pen draws the explanation on the board: icons, token rows, message diagrams, time charts and labelled arrows rather than paragraphs. It is modelled on Claude's *whiteboard-teacher* artifact and uses **OpenCode Go**, **OpenRouter** and/or **OpenGateway** as the LLM. Each enabled provider's models show in the picker, labelled with the provider.

## Run it

Requires **Node.js 18+**.

```bash
cd ~/Projects/whiteboard
cp .env.example .env      # skip if .env already exists; put your OpenCode Go and/or OpenRouter key in it
npm install               # optional: the natural voice for narration (see below)
npm start                 # → http://127.0.0.1:5173
```

Open the URL and ask anything. A new session starts straight away and names itself from your first question.

To get the latest version: `git pull`, then restart the server.

## What the teacher does

**Decides how deep to go.** Before answering, the teacher works out what you need from the meaning of your question, the board and the conversation, not from keywords. It picks one of three depths:
- **quick:** a crisp sentence or two and the smallest drawing that makes it clear.
- **explain:** one idea, built up as a worked picture.
- **deep:** a lesson in 3–6 parts. It teaches the first part or two, then stops at a checkpoint, and a **Continue: next part** chip carries on. The outline is saved with the session, so the teacher always knows where the lesson is. Off-topic questions are answered on their own, and the lesson waits.

The app sizes its limits to the depth the teacher chose (how much it may draw, and whether a short answer is sent back for more drawing). It never inspects your words itself.

**Draws first, talks little.** Every idea becomes a picture. Spoken lines are one short sentence each, shown in the chat like captions (at most 6 per answer, about 12 words each). Board text is limited to labels of a few words. The app enforces this: it trims long lines and over-wordy board text, and if an answer comes back with fewer than 4 pictures, it asks the model once to draw it.

**Drawing tools.** The model describes the structure and the app lays it out neatly:

| Tool | Used for |
|---|---|
| `icon` | about 45 hand-drawn icons: gpu, server, database, person, document, cloud, brain, clock, lock, memory, queue… |
| `tokens` | a row (or stack) of chips: tokens, words, slots, queues, array cells |
| `sequence` | who sends what to whom, in order: protocols, API calls, requests |
| `schedule` | lanes against time steps: batching, CPU scheduling, pipelines |
| `frame` / `brace` | group related things / measure or name a span |
| `arrow`, `box`, `circle`, `line`, `highlight` | connections, components, pointing at things |
| `graph`, `tree`, `network` | flowcharts and state machines, hierarchies, neural-network layers |
| `bars`, `numberline`, `timeline`, `vector`, `matrix`, `plot`, `table` | amounts, positions, history, numbers, functions |
| `vector` `"orient":"row"`, `matrix` `highlightRows` / `highlightCols` / `highlightCells` | a token's 1×N row lying across (a label that says 1×N does the same), and tinting the row, column or cell a sentence is about, so what is said and what is drawn have the same shape |
| `math`, `code` | typeset LaTeX (KaTeX), syntax-highlighted code |
| `update`, `move`, `erase`, `clear` | change the board step by step |

Objects are placed relative to each other (`"near":{"of":"gpu","side":"right"}`) instead of at guessed coordinates, and overlapping objects are pushed apart.

**👀 Looks at its own drawing and tidies it.** After each answer the app checks the new drawings (overlaps, arrows running through other drawings, cut-off labels). It then sends a picture of that area to a model that can see images, which replies only with fixes (`move`, `update`, `erase`, or up to 3 small additions such as an arrow or highlight; never the learner's ink), or `{"ok":true}` if the board is clear. The fixes animate on the board and the answer shows *"Tidied N things"*. It costs one extra quick call per answer. Turn it off in ⚙ → *Check and tidy each drawing*.

**⏯ Steps and timeline.** Every caption line, plus the drawing that goes with it, is a step. The bar under the board lets you:
- step back and forward with ‹ › or the ← → keys,
- drag the slider to any step,
- press ▶ to replay from there,
- press **Live** to return to the current board.

**The order questions are answered in.** Every question (a side question, a double-click or a popup *draw it*) belongs to the answer that was playing when you asked it, so questions form a tree that is answered depth first. Questions asked during the same answer are answered **first asked, first answered**, even when a later one's answer is ready first. **Going deeper is eager:** the next question takes over at the next sentence as soon as its answer is ready (a double-click or *draw it* then goes down into its own tab, and whatever you ask there belongs to it); until it is ready the teacher carries on with the current topic, or waits there (*⏳ Waiting for the answer to …*). **Coming back is lazy:** the teacher goes back up ("Now, back to …", to the parent tab for a tab) only when that answer and everything asked inside it are answered. Example: during the lesson you ask S, then double-click A, then *draw it* on B → S, then A's tab (and everything asked there), then B's tab, then back to the lesson. A question asked *while* S is being answered belongs to S and comes in before A. **Steer** (⌘↵) replaces only the answer playing now; the questions waiting, and the answers set aside, keep their places.

**Asking while the teacher teaches.** Press **Enter** (or Send) to ask on the side: the question goes to the model at once in its own request, the lesson keeps going, and when the answer is ready the teacher finishes its sentence, says "You asked: …", teaches it, then says "Now, back to …" and carries on where it stopped. Questions inside side answers nest and unwind in order. Press **⌘↵** (Mac) / **Ctrl+↵** (Windows), or ↪, to steer instead: the teacher finishes its sentence, drops the rest of that answer and answers with your message taken in. Paused: a question asked while paused (typed, a double-click, or an Ask whiteboard "draw it"), whether the live lesson or a look-back was paused, keeps the lesson paused: nothing more of it plays. The answer plays by itself as soon as it is ready, and once it (and any other question asked in the pause, in the order asked) is answered, the lesson goes on from where it was paused. Pressing ▶ before then carries on with the lesson meanwhile, and the answer comes in at the next sentence once it is ready (the bar on the board says which is happening). The composer buttons are icons (⏸/▶ pause and play, ■ stop, ↪ steer, ➤ send); hover one to see its name.

**Prompt caching.** The long system prompt is the same for every call; what changes (the board, the lesson outline, the selection) goes at the start of the latest message. Providers that cache by prompt prefix (GLM on OpenGateway, for example) then reuse the system prompt and chat history across an answer, its side questions and follow-ups: a side question measured 4,096 of 4,596 prompt tokens cached.

**Suggested questions.** Every suggested question is written by the model for what is on the board right now; none are fixed. Each answer ends with 3 follow-up questions about what was just drawn. When you select a drawing (or several), sketch something yourself, open a named lesson before asking anything, or an answer came without follow-ups, a quick low-reasoning call writes them (*✨ suggesting questions…* shows meanwhile). They follow the language of your last message. They sit in one row above the chat box that scrolls sideways (trackpad, mouse wheel or drag; the edges fade where more are hidden; hover a cut-off one to read all of it), so they never push the chat up. Two buttons are actions rather than suggestions: *Open up “…”* (the same as double-clicking the drawing) and *Check my drawing* (sends your sketch).

**Talk while it teaches.** You can send a message while an answer is still being drawn, for example "simpler please" or "wait, why 4×?". The teacher finishes the sentence it is on (voice and pen), drops the rest of that answer, and responds to you, knowing it was interrupted and where. **Stop** is a separate button.

**Reload-proof.** Reloading the page (or the browser closing it) in the middle of a lesson loses nothing that had already arrived. The lesson in progress is saved on the server next to the session (`sessions/<id>.inflight.json`) a few times a second and as the page closes: the sentences and drawings the teacher was about to play, side answers waiting to come in, answers set aside, and open Ask whiteboard popups with their threads (the open tab and every tab's camera are saved with the session). After the reload the lesson comes back **paused** with a note in the chat; ▶ (or Continue) plays the saved lines exactly as they would have played, and only an answer that was still arriving asks the model for the rest of it. The file is removed once nothing is in progress, on ■ Stop, clearing the chat, a new session or deleting the session.

**Replay** plays the whole lesson. Your own moves, erases and sketches are recorded too, so replays match the board.

**✏️ Draw back.** Press **Draw** and sketch (4 colours, undo), then press **Check my drawing**. The sketch is attached to your next message, with a thumbnail above the input. Type a question about it, or just press Send. The teacher works out from the picture what you drew, so you never have to describe it. It says what it sees, answers or checks it, and draws the corrected version next to your sketch. ✕ removes the attachment. If the selected model can't see images, DeepSeek V4.1 Flash checks the sketch for that question.

**Sessions.** **＋ New** (top left of the toolbar) starts a session at once, named "New session". When you ask your first question, the selected model also picks a short title (2–5 words) in parallel, and the session renames itself. A name you set yourself (click the title) is never replaced. Sessions save automatically to `sessions/` once you have asked something. 🗂 **Sessions** lists them so you can resume or delete one; reopening the page resumes the last one.

**🔊 Narration (on by default, Heart).** 🔊 in the toolbar or ⚙ → Narration turns it off, and that choice is remembered.
- **Voice:** it uses **Kokoro**, generated by the local server, which needs `npm install` once. The voice model (~90 MB) downloads the first time the server starts.
- **Voices:** Heart (default), Bella, Nicole, Sarah, Michael, Fenrir, Puck, Emma, Isabella, George and Fable. **▶ Preview voice** plays one before you use it.
- **Pacing:** each sentence's drawing is slowed down or sped up to last as long as the sentence takes to say, so the pen draws what the teacher is talking about. The next sentence waits until both are done. With narration off, drawing and captions follow a normal speaking pace.
- **No fallback voice:** only Kokoro on this computer is used. If it isn't installed, is still loading, or fails, that line is silent (the lesson keeps its pace) and the narration bar says why.

## Using the board

| Action | How |
|---|---|
| Pan | drag empty space · mouse wheel (Shift = sideways) |
| Zoom | Ctrl/⌘ + wheel · trackpad / two-finger pinch · double-click (Shift = out) · − / + buttons |
| Select | tap an object · Shift/Ctrl/⌘-tap to add more · tap empty space to clear |
| Move | drag a selected object (its arrows, frames and highlights follow) |
| Erase | Delete/Backspace, or **Erase** in the "Selected" line |
| Ask about it | select, then use the chips or type ("What is X?", "Change X to another example", Hinglish…) |
| Steps | timeline bar under the board · ← → keys · ▶ replays · **Live** returns |
| Quick question about a drawing | **right-click** it (Ctrl+click on a Mac) → **Ask whiteboard**: a small popup next to it answers briefly, using the drawing, what it connects to, what is near it and what the teacher said while drawing it. Ask follow-ups in the same popup. Right-click one of several selected drawings to ask about them all. It only talks: nothing is drawn, spoken, added to the chat or saved, and the lesson carries on. Ask it to **draw it** or **explain it with a diagram** and it hands the question to the teacher instead, with those drawings attached: while the teacher teaches it becomes a side question (answered in parallel, it comes in after the current sentence with "You asked: …", then the lesson goes on); when paused the lesson stays paused and it plays as soon as it is ready; when idle it is drawn straight away. The popup says which happened. Answers render as Markdown. Clicking elsewhere (or Esc, or –) folds it into a small pill by its drawings that moves with the board (a ● means an answer arrived); click the pill to open it again. Only ✕ closes it. Several can be open at once. Uses the model and reasoning picked in ⚙. Enter asks, Shift+Enter new line |
| Tabs | **double-clicking** a drawing, or asking its **Ask whiteboard** popup to *draw it*, draws the answer on its own **tab** instead of next to the drawing. The drawing gets a **↗** badge that opens its tab, and the tab bar (top left of the board) lists every tab under the one it was opened from (Main › Self-attention › Softmax); ✕ closes a tab and the tabs opened from it. Asking again about the same drawing draws on its existing tab. While the teacher teaches, the view follows the answer: a side answer on a tab switches to it and, after "Now, back to …", back again. Looking at another tab while the teacher is drawing pauses the lesson; coming back (or ▶) carries on there. Side questions you type are drawn on the tab you are looking at. The chat stays one conversation: answers drawn on a tab are tagged **↗ tab name** (click to open it). Tabs are saved with the session |
| Where am I? | the **Questions** panel (top of the chat) shows the main question and every side question / double-click under the answer it was asked in, indented: ▶ answering now (*you are here*), ⏸ waits to be gone back to, ⏳ answering on the side, ● ready, ✓ answered. It updates as inner answers finish and the teacher goes back out. Click a row to find it in the chat; click the header to fold it |
| Keyboard focus | click an empty part of the board to put the keys on the board (then **Space** plays/pauses, ← → step) · click a drawing to type a question about it in the chat box |
| Play / pause | **Space** (or **S**) with the board focused, same as the timeline's ▶/⏸; while the teacher is still thinking, before the timeline appears, it is the chat's ⏸/▶ |
| Draw yourself | **✏️ Draw** → sketch → **Check my drawing** → ask (optional) → Send |
| Erase your sketch | **✏️ Draw** → **🧽 Rubber** → drag over your strokes (only your own sketches are erased) |
| Pause | **⏸** next to Send freezes the voice, pen and typing; **▶** resumes exactly there. Ask something while paused: the lesson stays paused until the answer is ready, the teacher answers it, then goes back to where the lesson was |
| Interrupt the teacher | type while it answers and press Send: it finishes its sentence, then takes your message into account · **Stop** ends the answer |
| Replay / Wipe / Fit / Full screen | toolbar |
| New session / rename | **＋ New** · click the session's name to rename it |

**Model picker** (⚙ in the chat header):
- **Models:** every model on your OpenCode Go plan, grouped as Featured, Free and All others. Models whose native format isn't Chat Completions (Muse Spark, GPT, Grok, Claude, Qwen, MiniMax M3, Gemini) work too, because OpenCode translates the request.
- **Reasoning:** the buttons show only the levels the model supports (None, Minimal, Low, Medium, High, X-High, Max), plus Auto. The choice is remembered per model. Lower levels start drawing sooner.
- **Slow models:** free models without a reasoning setting (LongCat, Iceman, MiMo, Kimi Code) can think for 1–2 minutes before drawing.

## How it works

```
browser (public/)  ──POST /api/chat──▶  server.js  ──stream──▶  OpenCode Go /v1/chat/completions
     ▲  JSON Lines: {"say":…} → chat caption        (adds the API key and
     └─ {"cmd":"icon"|"tokens"|…} → board            an x-opencode-session id)
```

* **The server:** `server.js` serves the app and proxies to OpenCode Go, so **the API key stays on the server** and never reaches the browser.
  - `/api/sessions` stores lessons on disk.
  - `/api/tts` generates narration with Kokoro, when installed.
* **Each request** gets a fresh prompt containing:
  - the session name,
  - a summary of the board (bounds, free space, up to 70 objects),
  - your selection or sketch,
  - the last 8 turns.

  The model first writes one hidden planning line (which pictures, which tools), then alternates caption lines with drawing commands.
* **Generated content is never executed:**
  - numbers are clamped and text is inserted as text,
  - lists are capped (90 commands and 5 `write`s per answer, 600 objects on the board),
  - a malformed line or a failing drawing is skipped and logged, never left to stall the answer.

## Use it from opencode (MCP)

opencode can teach on this board: you ask in opencode (desktop or terminal), its model draws here, and the captions, voice, timeline, replay and sessions all work as usual. `mcp.js` is a small MCP server (no dependencies) that gives opencode's model four tools:

| Tool | What it does |
|---|---|
| `whiteboard_draw` | steps of `{say, commands}`: one spoken sentence plus the drawing commands it explains. Returns the ids and boxes drawn, layout problems to fix, errors and free space |
| `whiteboard_get_board` | everything on the board, what you selected and your sketches |
| `whiteboard_look` | a picture of the board (`all`, `view`, `sketch`, or given ids), so the model can check its layout or read your sketch |
| `whiteboard_new_board` | a fresh board for a new subject |

The teaching rules and the drawing language are in the tool descriptions, so any model opencode uses gets them. There is also a `teach` MCP prompt.

**Set up** by adding this to `~/.config/opencode/opencode.json` (use the full path to `node` from `which node`, because the desktop app does not see your shell's PATH):

```json
{
  "mcp": {
    "servers": {
      "whiteboard": {
        "type": "local",
        "command": ["/full/path/to/node", "/full/path/to/whiteboard/mcp.js"],
        "timeout": { "execution": 150000 }
      }
    }
  }
}
```

`opencode mcp list` should then show `whiteboard  connected`.

**Use:**
1. Ask opencode something like *"explain on the whiteboard how a TCP handshake works"*.
2. On the first tool call, `mcp.js` starts `server.js` if it is not running (it keeps running afterwards) and opens the board at `http://127.0.0.1:5173/?mode=mcp`. You can also open that page yourself.
3. In this mode the board's own chat box is hidden: you ask in opencode, and the chat panel shows the teacher's captions.
4. Select things, or sketch with ✏️ **Draw**, then ask opencode about them (*"check my drawing"*). It reads your selection and looks at your sketch.
5. For narration, turn it on in ⚙ and click the board once (browsers only play sound after a click).

How it fits together:

```
opencode ─stdio─▶ mcp.js ─POST /api/board/call─▶ server.js ─SSE─▶ board page (/?mode=mcp)
                    ▲                                                   │ runs it, then
                    └──────────── result (ids, issues, PNG) ◀── POST /api/board/result
```

Options (set in the server entry's `"environment"`): `WHITEBOARD_URL` (default `http://127.0.0.1:5173`), `WHITEBOARD_OPEN=0` to never open a browser, `WHITEBOARD_OPEN_DELAY_MS` (default 5000) to wait for the Desktop tab before opening one.

## The Whiteboard tab in opencode Desktop (plugin)

`opencode-plugin/` puts the board inside opencode Desktop, as a **Whiteboard** tab in the session's side panel, next to the conversation. It uses opencode's experimental GUI plugin API (`./gui-experimental`), so an opencode update may break it.

- **Opening the tab:** it opens by itself when the model starts drawing (a whiteboard tool call). You can also open it from **+** in the side panel → *Whiteboard*, or with *Toggle whiteboard* in the command palette.
- **What the tab shows:** the board in embedded mode (`/?mode=mcp&embed=1`). There's no chat column, since opencode's chat is right beside it, and each spoken line shows as a caption over the board. Draw, select, replay, sessions and 🔊 narration all work as in the browser.
- **The board server:** the plugin's server half starts `server.js` when opencode starts, if it isn't already running. So the tab has a board even before the first drawing.
- **Drawing:** the plugin only shows the board. Drawing still goes through the MCP server above, so set up both.

**Set up** by adding this next to `"mcp"` in `~/.config/opencode/opencode.json`. `node` is the Node.js binary that runs the board server (the full path from `which node`); `url` is optional (default `http://127.0.0.1:5173`).

```json
"plugins": [
  { "package": "/full/path/to/whiteboard/opencode-plugin", "options": { "node": "/full/path/to/node" } }
]
```

Then quit and reopen opencode Desktop. *Settings → Extensions → Plugins* should list `whiteboard` as active, and **+** in the side panel offers *Whiteboard*.

When the tab is open, the MCP server draws there and doesn't open a browser tab. Drawings always go to the Desktop tab, even if a browser board was opened after it; a browser board only gets them when no Desktop tab is open. It waits `WHITEBOARD_OPEN_DELAY_MS` (default 5000) for the tab to connect before falling back to the browser.

## Config (.env)

| Var | Default |
|---|---|
| `OPENCODE_API_KEY` | OpenCode Go key (any mix of the three keys is fine) |
| `OPENGATEWAY_API_KEY` | OpenGateway key. When set, its model becomes the default (switched to once in the picker); all its active chat models are listed |
| `OPENGATEWAY_MODEL` | `deepseek/deepseek-v4.1-flash-eco`: the OpenGateway default model; OpenGateway ids are written `og:<slug>` |
| `OPENGATEWAY_API_BASE` | `https://apis.opengateway.ai/v1` |
| `OPENROUTER_API_KEY` | OpenRouter key. When set (and no OpenGateway key), the OpenRouter model becomes the default (switched to once in the picker) |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4.1-flash` |
| `OPENROUTER_PROVIDER` | `baidu/fp8`: the provider(s) that serve `OPENROUTER_MODEL`, comma list; empty lets OpenRouter choose |
| `OPENROUTER_ALLOW_FALLBACKS` | `false`: no other provider is used if the pinned one is down |
| `OPENROUTER_MODELS` | extra OpenRouter models for the picker, comma list (not provider-pinned) |
| `DEFAULT_MODEL` | `glm-5.3` (OpenCode Go, started at low reasoning); OpenRouter ids are written `or:<slug>` |
| `PORT` / `HOST` | `5173` / `127.0.0.1` |
| `OPENCODE_GO_API_BASE` | `https://opencode.ai/zen/go/v1` |
| `TAVILY_API_KEY` | optional [Tavily](https://tavily.com) key: used to extract pages the server can't read itself and to search the web for links; without it, the free DuckDuckGo HTML search is used |
| `LINK_FETCH` | set to `off` to stop reading links in your messages (also stops web search) |
| `WEB_SEARCH` | set to `off` to stop the proactive web search before answers |
| `TTS` | set to `off` to disable the server voice |
| `TTS_DTYPE` | voice model precision: `q8` (default), `fp16`, `fp32` |

**Links:** when your message contains links (up to 3), the server reads them before the teacher answers, so it knows what they say: the page's title, description and main text; X/Twitter posts through public post APIs (fxtwitter, then X's embed endpoints); and, when a page can't be read or says too little, Tavily extract and a web search for the link. What was read is added to your message as untrusted context, and a note under your message says what was read. Only public http(s) addresses are fetched (private and local addresses are refused, also after redirects), results are cached for 10 minutes, and `LINK_FETCH=off` turns it off.

**Web search:** not every answer searches. Before each answer, a quick call to the same model (low reasoning) decides whether it needs current or latest information: the newest version or release of something, news, prices, benchmarks or leaderboards, recent events or products, details that change between versions, or when you ask it to look something up. Concepts and fundamentals (how attention works, what a hash map is), arithmetic, small talk and opening up a drawing never search. If that call fails, keyword rules ("latest", "current", "price", a recent year…) decide. The search uses Tavily when `TAVILY_API_KEY` is set (DuckDuckGo otherwise); the results go to the teacher as untrusted context, the thinking line shows *🔎 Searching the web…*, and a note under your message says which sites were found (hover for the titles). The check adds about half a second. It is always on in the app; `WEB_SEARCH=off` in `.env` turns it off.

`.env` and `sessions/` are git-ignored, so your key and lessons never leave your computer.

## Files

```
server.js             Node server: OpenCode Go proxy, sessions, Kokoro voice (optional kokoro-js dependency), board bridge for mcp.js
links.js              reads the links in a message (page text, X posts, web search) for the teacher's context
mcp.js                MCP server (stdio) that lets opencode or another MCP client teach on the board
launch.cjs            finds or starts the board server (used by mcp.js and the plugin)
opencode-plugin/      opencode Desktop plugin: the Whiteboard side tab (gui.cjs) and board-server start (server.js)
public/index.html     layout
public/style.css      styles
public/js/            the front end, as plain scripts loaded in order (they share one scope; each stays under 1,000 lines):
  base.js             constants, shared state, utils, hand-drawn geometry
  shapes.js           how each drawing is built (boxes, icons, tokens, graphs, maths…)
  board.js            command normalisation, animation, camera, board operations, selection
  input.js            pointer, wheel and keyboard on the board
  popup.js            right-click → Ask whiteboard popups and their hand-off to the teacher
  timeline.js         toolbar, steps & timeline, sessions
  chat.js             chat UI, suggestions, question tree, side questions and going back
  teacher.js          the queue, the prompt, sending a question, streaming the answer
  tabs.js             tabs: a board per opened-up drawing, ↗ badges, the tab bar, saving tabs
  inflight.js         the lesson in progress, saved on the server so a reload carries on
  settings.js         model picker, narration, topic dialog, opencode mode, boot
public/icons.js       hand-drawn icon library
public/voice.js       narration engine (Kokoro on the local server only)
sessions/             auto-saved lessons, plus <id>.inflight.json while a lesson is in progress (git-ignored)
```

## Troubleshooting

- **The teacher talks but barely draws:** try another model or a different reasoning level in ⚙. DeepSeek V4.1 Flash at Low is the tested default.
- **"Used its whole token budget thinking":** pick a lower reasoning level in ⚙, or another model.
- **Robotic voice:** run `npm install` and restart the server. ⚙ → Narration should then say *"generated on this computer (fast)"*.
- **An answer seems stuck:** open ⚙, press **Copy debug log** and share it. It records what the app was waiting on.
- **opencode says the board server "has no board bridge":** an older `npm start` is still running. Stop it (Ctrl+C) and run `npm start` again.
- **opencode's whiteboard tools time out:** make sure a board is open: the Whiteboard tab in opencode Desktop, or `/?mode=mcp` in a browser. With several open, the Desktop tab gets the drawings, otherwise the newest browser tab.
- **`git pull` complains about a `.lock` file:** a git command was interrupted. Delete the named `.git/*.lock` file and run `git pull` again.
