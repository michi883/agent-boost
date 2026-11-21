# Agent Boost

Minimal local web app with a single 16:9 slide viewport ready for Gemma-generated HTML slides.

## Run Locally

```bash
node server.js
```

Open `http://127.0.0.1:3000` in your browser. Set `PORT` to use a different port (for example, `PORT=8080 node server.js`).

## Generate the Gemma Slide (~6.5 s warm)

Start Gemma 31B with the E2B model as a speculative draft (tuned for short HTML output):

```bash
llama-server -m ~/models/gemma-4/gemma-4-31B_q4_0-it.gguf --host 127.0.0.1 --port 8099 \
  --jinja --reasoning off -np 1 -c 4096 -ngl 99 --flash-attn on \
  --spec-type draft-simple -md ~/models/gemma-4/gemma-4-E2B_q4_0-it.gguf -ngld 99 \
  --spec-draft-n-max 5 --spec-draft-p-min 0.8
```

Then run `node gemma-generate.js`. Gemma writes the slide body; the script wraps it in a fixed CSS shell and saves `public/gemma-slide.html` (plus Gemma's unmodified output in `public/gemma-raw.html`).

## Structure

- `server.js` — zero-dependency Node static server confined to `public/` (never serves `.env` or dotfiles); `GET /api/status` returns a change signature for each slide
- `public/index.html`, `public/styles.css`, `public/app.js` — single-screen before/after viewer
- `.gitignore` — prevents `.env` from being committed

## Before / After Viewer

Two side-by-side 16:9 panels, each rendered at 1280×720 and scaled to fit:

- **Original (Gemma 31B)** shows `public/gemma-slide.html`.
- **Improved (Gemini Neon)** shows `public/gemini/index.html` and stays empty until that file exists. Any change to a file under `public/gemini/` reloads it.

The page polls `/api/status` every 400 ms and reloads a panel only when its files change, with no browser refresh needed.

## Live Gemini Improvement

From the repo root (agy loads `AGENTS.md` automatically):

```bash
rm -rf public/gemini   # reset; the right panel shows "Waiting for Gemini"
agy --model gemini-4-neon-xhigh --mode accept-edits
```

Then enter `Integrate 3D visualization`. Neon reads `public/gemma-slide.html` and writes `public/gemini/index.html`, which appears in the right panel. `--mode accept-edits` lets it write without an approval prompt.
