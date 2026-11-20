# Whiteboard Teacher (local)

An AI teacher that explains **any topic** by drawing on an infinite whiteboard. You ask in the side chat; the teacher answers with short caption lines in the chat while a pen draws the explanation on the board: icons, token rows, message diagrams, time charts and labelled arrows rather than paragraphs. It is modelled on Claude's *whiteboard-teacher* artifact and uses **OpenCode Go** and/or **OpenRouter** as the LLM.

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
| `math`, `code` | typeset LaTeX (KaTeX), syntax-highlighted code |
| `update`, `move`, `erase`, `clear` | change the board step by step |

Objects are placed relative to each other (`"near":{"of":"gpu","side":"right"}`) instead of at guessed coordinates, and overlapping objects are pushed apart.

**👀 Looks at its own drawing and tidies it.** After each answer the app checks the new drawings (overlaps, arrows running through other drawings, cut-off labels). It then sends a picture of that area to a model that can see images, which replies only with fixes (`move`, `update`, `erase`, or up to 3 small additions such as an arrow or highlight; never the learner's ink), or `{"ok":true}` if the board is clear. The fixes animate on the board and the answer shows *"Tidied N things"*. It costs one extra quick call per answer. Turn it off in ⚙ → *Check and tidy each drawing*.

**⏯ Steps and timeline.** Every caption line, plus the drawing that goes with it, is a step. The bar under the board lets you:
- step back and forward with ‹ › or the ← → keys,
- drag the slider to any step,
- press ▶ to replay from there,
- press **Live** to return to the current board.

**Suggested questions.** Each answer ends with 3 follow-up questions about what was just drawn. They appear as chips above the input, next to *Quiz me on this* and *Hinglish mein samjhao*.

**Talk while it teaches.** You can send a message while an answer is still being drawn, for example "simpler please" or "wait, why 4×?". The teacher finishes the sentence it is on (voice and pen), drops the rest of that answer, and responds to you, knowing it was interrupted and where. **Stop** is a separate button.

**Replay** plays the whole lesson. Your own moves, erases and sketches are recorded too, so replays match the board.

**✏️ Draw back.** Press **Draw** and sketch (4 colours, undo), then press **Check my drawing**. The sketch is attached to your next message, with a thumbnail above the input. Type a question about it, or just press Send. The teacher works out from the picture what you drew, so you never have to describe it. It says what it sees, answers or checks it, and draws the corrected version next to your sketch. ✕ removes the attachment. If the selected model can't see images, DeepSeek V4.1 Flash checks the sketch for that question.

**Sessions.** **＋ New** (top left of the toolbar) starts a session at once, named "New session". When you ask your first question, the selected model also picks a short title (2–5 words) in parallel, and the session renames itself. A name you set yourself (click the title) is never replaced. Sessions save automatically to `sessions/` once you have asked something. 🗂 **Sessions** lists them so you can resume or delete one; reopening the page resumes the last one.

**🔊 Narration (off by default).** Turn it on in ⚙ → Narration; 🔊 in the toolbar mutes it.
- **Voice:** it uses **Kokoro**, generated by the local server, which needs `npm install` once. The voice model (~90 MB) downloads the first time the server starts.
- **Voices:** Heart (default), Bella, Nicole, Sarah, Michael, Fenrir, Puck, Emma, Isabella, George and Fable. **▶ Preview voice** plays one before you use it.
- **Pacing:** each sentence's drawing is slowed down or sped up to last as long as the sentence takes to say, so the pen draws what the teacher is talking about. The next sentence waits until both are done. With narration off, drawing and captions follow a normal speaking pace.
- **Fallback:** without `npm install`, or if the voice can't keep up, the browser's built-in voice is used instead, which sounds robotic. The settings panel always says which voice is speaking and why.

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
| Draw yourself | **✏️ Draw** → sketch → **Check my drawing** → ask (optional) → Send |
| Erase your sketch | **✏️ Draw** → **🧽 Rubber** → drag over your strokes (only your own sketches are erased) |
| Pause | **⏸** next to Send freezes the voice, pen and typing; **▶** resumes exactly there. Ask something while paused: the teacher answers it, then **▶ Continue** goes back to where the lesson was |
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
| `OPENCODE_API_KEY` | OpenCode Go key (this and/or `OPENROUTER_API_KEY`) |
| `OPENROUTER_API_KEY` | OpenRouter key. When set, the OpenRouter model becomes the default (switched to once in the picker) |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4.1-flash` |
| `OPENROUTER_PROVIDER` | `baidu/fp8`: the provider(s) that serve `OPENROUTER_MODEL`, comma list; empty lets OpenRouter choose |
| `OPENROUTER_ALLOW_FALLBACKS` | `false`: no other provider is used if the pinned one is down |
| `OPENROUTER_MODELS` | extra OpenRouter models for the picker, comma list (not provider-pinned) |
| `DEFAULT_MODEL` | the OpenRouter model if its key is set, else `deepseek-v4.1-flash`; OpenRouter ids are written `or:<slug>` |
| `PORT` / `HOST` | `5173` / `127.0.0.1` |
| `OPENCODE_GO_API_BASE` | `https://opencode.ai/zen/go/v1` |
| `TTS` | set to `off` to disable the server voice |
| `TTS_DTYPE` | voice model precision: `q8` (default), `fp16`, `fp32` |

`.env` and `sessions/` are git-ignored, so your key and lessons never leave your computer.

## Files

```
server.js             Node server: OpenCode Go proxy, sessions, Kokoro voice (optional kokoro-js dependency), board bridge for mcp.js
mcp.js                MCP server (stdio) that lets opencode or another MCP client teach on the board
launch.cjs            finds or starts the board server (used by mcp.js and the plugin)
opencode-plugin/      opencode Desktop plugin: the Whiteboard side tab (gui.cjs) and board-server start (server.js)
public/index.html     layout
public/style.css      styles
public/app.js         board engine, pen, drawing tools, layout, timeline, chat, prompt, sessions
public/icons.js       hand-drawn icon library
public/voice.js       narration engine (server Kokoro → in-browser Kokoro → browser voice)
public/tts-worker.js  in-browser Kokoro (fallback when the server has no voice)
sessions/             auto-saved lessons (created on first use, git-ignored)
```

## Troubleshooting

- **The teacher talks but barely draws:** try another model or a different reasoning level in ⚙. DeepSeek V4.1 Flash at Low is the tested default.
- **"Used its whole token budget thinking":** pick a lower reasoning level in ⚙, or another model.
- **Robotic voice:** run `npm install` and restart the server. ⚙ → Narration should then say *"generated on this computer (fast)"*.
- **An answer seems stuck:** open ⚙, press **Copy debug log** and share it. It records what the app was waiting on.
- **opencode says the board server "has no board bridge":** an older `npm start` is still running. Stop it (Ctrl+C) and run `npm start` again.
- **opencode's whiteboard tools time out:** make sure a board is open: the Whiteboard tab in opencode Desktop, or `/?mode=mcp` in a browser. With several open, the Desktop tab gets the drawings, otherwise the newest browser tab.
- **`git pull` complains about a `.lock` file:** a git command was interrupted. Delete the named `.git/*.lock` file and run `git pull` again.
