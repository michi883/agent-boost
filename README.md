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

- `server.js` — zero-dependency Node static server confined to `public/` (never serves `.env` or dotfiles)
- `public/index.html`, `public/styles.css`, `public/app.js` — plain HTML/CSS/JS single-screen 16:9 viewport
- `.gitignore` — prevents `.env` from being committed

## Rendering Slides (Ready for Step 2)

`window.AgentBoost` exposes:

- `renderSlideHtml(html)` — renders Gemma-generated HTML into the 16:9 iframe via `srcdoc`
- `renderSlideUrl(url)` — loads a saved slide URL into the 16:9 iframe
- `clearSlide()` — restores the `Ready for Gemma` state
