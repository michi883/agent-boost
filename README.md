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

- `server.js` — zero-dependency Node static server confined to `public/` (never serves `.env` or dotfiles); runs Gemma and Neon for the browser and reports progress via `GET /api/status`
- `gemma-generate.js` — Gemma's harness; `--tools` offers it every tool installed in `tools/`
- `tools/` — tools Gemma can discover (not web-served)
- `public/index.html`, `public/styles.css`, `public/app.js` — single-screen viewer
- `.gitignore` — prevents `.env` from being committed

## Demo Flow (all from the browser)

Run `node server.js` (with the Gemma server up) and open `http://127.0.0.1:3000`. Three steps, each a button with live status:

1. **Gemma creates slide.** Runs `node gemma-generate.js` (baseline, no tools). Left panel: `public/gemma-slide.html`. Starting step 1 also removes the previous tool and result, so every demo builds the tool live.
2. **Gemini builds tool.** Drives agy through its Agent Client Protocol server (`agy acp`, model `gemini-4-hydrogen-medium`) with the prompt plus Gemma's slide. Per `AGENTS.md`, Gemini replies with a one-sentence plan and the code (no tool use; any tool request is refused). The server runs the code once on a different topic, renders the returned page in headless Chrome, and installs it as `tools/make_3d_slide.js` only if the page shows a 3D canvas with no uncaught errors. On a failure, the exact error goes back to Gemini in the same session (at most 2 repairs). Set `CHROME_BIN` if Chrome is elsewhere. Set `GEMINI_MODEL` (for example `gemini-4-hydrogen-high` or `gemini-4-neon-xhigh`; `agy models` lists them) or `AGY_BIN` to override.
3. **Gemma uses tool.** Runs `node gemma-generate.js --tools`: the same request, continuing the conversation that produced the original slide (Gemma is asked to keep exactly the same text), with every installed tool offered (`tool_choice: auto`; the prompt never names a tool). Gemma decides whether to call one; the harness runs the call and writes the returned page to `public/gemma-tool/index.html` (right panel). Gemma's raw tool calls, timings, and any text differences from the original slide go to `public/gemma-tool/run.json`.

While a step runs, its panel shows live milestones taken from real output: Gemma's title and themes as it generates them (thinking stays off for speed), and Gemini's latest thought heading, plan, the features its code adds as it streams, the test and the install. Runs are accepted only from the page itself (same-origin JSON POST). Panels reload automatically when their files change.

## Tools

A tool is two files in `tools/`; both must exist for Gemma to see it:

- `<name>.json` — OpenAI function schema (`name`, `description`, `parameters`)
- `<name>.js` — `module.exports = (args) => '<!DOCTYPE html>…'`, returning a complete page

`tools/make_3d_slide.json` defines the interface for the 3D tool: `title`, `subtitle`, and `milestones`, each one flat string `"Q1 | Theme | point | point | point"` (flat strings keep Gemma's tool-call arguments short and avoid nested-list parsing issues). Its implementation, `tools/make_3d_slide.js`, is written by Gemini during the demo.
