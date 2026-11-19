# Whiteboard Teacher (local)

An AI teacher that explains **any topic** on an infinite whiteboard. You ask in the side chat; the teacher answers there and, at the same time, writes, sketches, highlights, moves and erases on the board with an animated pen. It is modelled on Claude's *whiteboard-teacher* artifact and uses **OpenCode Go** as the LLM.

## Run it

Requires **Node.js 18+**.

```bash
cd ~/Projects/whiteboard
npm install               # once: installs the natural voice (Kokoro) for the server
cp .env.example .env      # skip if .env already exists; put your key in it
npm start                 # → http://127.0.0.1:5173
```

Open the URL, type a topic (plus optional audience, worked example and reference notes), then tap **Start the lesson**.

The first time the server starts after `npm install`, it downloads the voice model (~90 MB, once). The app also works without `npm install`, but the voice is then generated inside the browser, which is slow (especially in Safari) and often falls back to the browser's robotic voice.

## How it works

```
browser (public/)  ──POST /api/chat──▶  server.js  ──stream──▶  OpenCode Go /v1/chat/completions
     ▲  JSON Lines: {"say":…} → chat         (adds API key,
     └─ {"cmd":"box"|"arrow"|…} → board        x-opencode-session)
```

* `server.js` is a tiny Node server. It serves the app and proxies to OpenCode Go, so **the API key stays on the server** and never reaches the browser. It sends a stable `x-opencode-session` per lesson, which OpenCode Go requires.
* The model replies in JSON Lines. `say` lines type into the chat while the board commands that follow are drawn by the pen. The board commands are write, box, circle, vector, matrix, bars, plot, line, arrow, highlight, update, move, erase, clear and wait.
* Each request gets a fresh prompt containing the lesson, the colour code, a summary of the board (bounds, free space, up to 70 objects), your selection and the last 8 turns.
* Generated content is never executed: numbers are clamped, text is inserted as text, and lists are capped (60 commands per answer, 400 objects on the board).

## What the teacher can do

**🔊 Narration.** The teacher speaks each line aloud with **Kokoro** (default voice **Bella**, af_bella) while the pen draws that line's picture. The chat text types at the speaking pace, and the next sentence waits until the current one is spoken and drawn.
- **Where the voice is made:** by default the local server generates it natively on your computer, using every CPU core. It's fast and works the same in Safari and Chrome. ⚙ → Narration → *Run the voice on* can switch to generating it inside the browser instead (CPU, or GPU with a one-time 310 MB download).
- **Voices:** Bella, Heart, Nicole, Sarah, Michael, Fenrir, Puck (US), Emma, Isabella, George and Fable (UK). Pick one and press **▶ Preview voice** to hear it. The line under it tells you which voice is actually speaking and why.
- **When Kokoro can't keep up** (e.g. in-browser on a slow CPU), the app switches to the browser's built-in voice instead of stalling and says so. Changing any voice setting or pressing Preview tries Kokoro again.
- **Muting:** 🔊 in the toolbar mutes narration.

**⏯ Steps and timeline.** Every spoken line, plus the drawing that goes with it, is recorded as a step. Your own moves, erases and sketches are recorded too. The bar at the bottom of the board lets you:
- step back and forward with ‹ › or the ← → keys,
- drag the slider to any step,
- press ▶ to replay the lesson from that step with narration,
- press **Live** to return to the current board.

**Replay** plays the whole lesson. Steps are saved with the session.

**🎞 Motion.** Movement is used only where it explains something:
- `flow`: dots travelling along an arrow or line (data, signal, gradient),
- `animate`: smoothly change numbers, positions, sizes, colours or a plot's curve (e.g. sigmoid → tanh),
- `pulse`: a brief bounce to point at something.

**∑ Maths and code.** `math` typesets LaTeX with KaTeX. `code` draws a syntax-highlighted code block with line numbers.

**🧩 Components.** You give the structure and the app lays it out without overlaps:
- `network`: neural-network layers,
- `tree`,
- `graph`: flowcharts and pipelines, laid out in columns, in a circle or in a grid; feedback loops are drawn as curves,
- `numberline`,
- `timeline`,
- `table`.

**✏️ Draw back.** Press **Draw** to sketch on the board yourself (4 colours, undo). Then press **Check my drawing**, or just ask a question. A picture of your sketch and the drawings around it is sent to the model, and the teacher says what's right or wrong and draws the correction next to your sketch. If the selected model can't see images, DeepSeek V4.1 Flash checks it for that question.

## Using the board

| Action | How |
|---|---|
| Pan | drag empty space · mouse wheel (Shift = sideways) |
| Zoom | Ctrl/⌘ + wheel · trackpad / two-finger pinch · double-click (Shift = out) · − / + buttons |
| Select | tap an object · Shift/Ctrl/⌘-tap to add more · tap empty space to clear |
| Move | drag a selected object (its arrows and highlights follow) |
| Erase | Delete/Backspace, or **Erase** in the "Selected" line |
| Ask about it | select, then use the chips or type ("What is X?", "Change X to another example", Hinglish…) |
| Replay / Wipe / Fit / Full screen | toolbar · 🐢 slows the pen |
| Steps | timeline bar at the bottom · ← → keys · ▶ replays with narration · **Live** returns |
| Draw yourself | **✏️ Draw** → sketch → **Check my drawing** |

**Model picker** (⚙ in the chat header): every model on your OpenCode Go plan, grouped as Featured, Free and All others, with the exact name and id from the API. Models whose native format isn't Chat Completions (Muse Spark, GPT, Grok, Claude, Qwen, MiniMax M3, Gemini) work too, because OpenCode translates the request. The **reasoning** buttons show only the levels that model supports (None, Minimal, Low, Medium, High, X-High, **Max**), plus Auto (the model's own default). The choice is remembered per model. Lower levels start drawing sooner. Free models with no adjustable level (LongCat, Iceman, MiMo, Kimi Code) can take 1–2 minutes to think before they draw.

If a model spends its whole token budget thinking and never writes an answer, the chat tells you to pick a lower reasoning level. If an answer comes back empty, it is retried once.

**The teacher always draws.** You never need to ask for the board. If a model answers with talk only, the app automatically asks it once to put that explanation on the board.

## Sessions (auto-saved)

There's no save button. Every lesson (topic, board, camera position and chat) is saved automatically as you go to `sessions/<id>.json` next to the app, with a copy in the browser as a backup. Reopening the page resumes the lesson you last had open. **🗂 Sessions** lists all lessons with when they were last used and how much is in them, so you can **Resume** any of them or **Delete** it. **＋ New lesson** (or changing the topic) starts a fresh lesson and keeps the old one. Because the sessions live on disk, any browser on this machine sees them.

## Config (.env)

| Var | Default |
|---|---|
| `OPENCODE_API_KEY` | required |
| `DEFAULT_MODEL` | `deepseek-v4.1-flash` |
| `PORT` / `HOST` | `5173` / `127.0.0.1` |
| `OPENCODE_GO_API_BASE` | `https://opencode.ai/zen/go/v1` |
| `TTS` | set to `off` to disable the server voice |
| `TTS_DTYPE` | voice model precision: `q8` (default), `fp16`, `fp32` |

## Files

```
server.js          Node server + OpenCode Go proxy (no deps)
public/index.html  layout
public/style.css   styles
public/app.js      board engine, pen animation, components, motion, timeline, chat, prompt, sessions
public/voice.js    narration engine (Kokoro / browser voice), paced with the pen
public/tts-worker.js  Kokoro TTS in a Web Worker (fallback when the server has no voice)
sessions/          auto-saved lessons (created on first use, git-ignored)
```

## Troubleshooting

- **Robotic voice:** run `npm install` and restart the server. ⚙ → Narration should then say *"generated on this computer (fast)"*.
- **An answer seems stuck:** open ⚙, press **Copy debug log** and share it. It records what the app was waiting on.
