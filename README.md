# Whiteboard Teacher (local)

An AI teacher that explains **any topic** on an infinite whiteboard. You ask in the side chat; the teacher answers there and, at the same time, writes, sketches, highlights, moves and erases on the board with an animated pen. It is modelled on Claude's *whiteboard-teacher* artifact and uses **OpenCode Go** as the LLM.

## Run it

Requires **Node.js 18+**. No `npm install` needed: the project has zero dependencies.

```bash
cd ~/Projects/whiteboard
cp .env.example .env      # skip if .env already exists; put your key in it
npm start                 # → http://127.0.0.1:5173
```

Open the URL, type a topic (plus optional audience, worked example and reference notes), then tap **Start the lesson**.

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

## Files

```
server.js          Node server + OpenCode Go proxy (no deps)
public/index.html  layout
public/style.css   styles
public/app.js      board engine, pen animation, camera, chat, prompt, sessions
sessions/          auto-saved lessons (created on first use, git-ignored)
```
