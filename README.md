# Agent Boost

Gemini builds a reusable tool that makes Gemma better: Gemma 31B (local) makes a slide, Gemini builds and tests a slide-enhancement tool from your request, and Gemma discovers and calls it on its own.

## Run Locally

```bash
npm install      # Three.js 0.170.0, served locally at /vendor/three/ (tools render offline)
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

- `server.js` — zero-dependency Node server: static files confined to `public/` (never `.env` or dotfiles), the three steps, the evaluation, and progress via `GET /api/status`. It reads `GEMINI_API_KEY` from `.env`; the browser never sees it.
- `gemma-generate.js` — Gemma's harness; `--tools` offers it every tool installed in `tools/`; `--out=<dir>` writes elsewhere than `public/`
- `page-check.js` — loads a page in headless Chrome (DevTools protocol, offline) and measures it: errors, every expected text shown, cards and 3D objects cut off or covering each other, colors, motion, and whether real hover and drag input change it
- `AGENTS.md` — instructions for Gemini 4 Hydrogen, which writes the tools
- `tools/` — generated tools Gemma can discover (gitignored; not web-served)
- `public/index.html`, `public/styles.css`, `public/app.js` — single-screen viewer

## Workflow (all from the browser)

Add `GEMINI_API_KEY=…` to `.env`, run `npm install` once, then `node server.js` (with the Gemma server up) and open `http://127.0.0.1:3000`. The page shows three compact progress indicators, one action area with the current step's input and button, and the Original and Improved slides side by side. Gemma is always teal (●), Gemini and the tools it builds violet (✦).

1. **Create slide.** Enter a slide request (default "Create a 2027 go-to-market roadmap slide"). Runs `node gemma-generate.js <request>` (no tools) and shows Gemma's slide on the left. This starts a new run: the previous tool and results are removed.
2. **Build tool.** Enter a capability request (default "Add interactive 3D visualization to slides"). Everything goes through the Gemini API (no agent CLI):
   1. **Decide** — one Gemini Decisions API call (`gemini-decision-1`, ~0.3 s): is the request supported (calibrated choice with confidence), and which measurable capabilities does it ask for (3D, Interactive, Colorful, Animated)? Unsupported requests (new or translated text, data, media, network; URLs are rejected deterministically) stop here.
   2. **Design & code** — `gemini-4-hydrogen`, thinking low, streamed, with `AGENTS.md` as its system instructions: designs and writes the tool in one pass (thought headings and code milestones show as progress).
   3. **Name & describe** — at the same time, `gemini-4-neon`, thinking low: the tool's snake_case name and the one-sentence description Gemma sees, from the request and the capabilities to be verified.
   4. **Test** — the code runs on Gemma's slide and on a different topic; both pages are measured in headless Chrome served only by this app: no errors, every text shown exactly, nothing cut off or covered (cards, and 3D objects tagged `userData.milestone`), plus each requested capability (a 3D scene; a real drag or hover changes the page; at least 4 vivid hues on 8% of the slide; motion). A failure goes back to Hydrogen with the exact problem (at most 2 repairs).
   5. **Install** — only after both pages pass: `tools/<name>.js` and `tools/<name>.json` (the fixed interface with Neon's name and description). A name or description that claims a capability the test did not verify is replaced by one built from the verified capabilities.

   Each stage shows its model and measured time. Override models with `CODE_MODEL`, `CODE_THINKING`, `NAME_MODEL`, `NAME_THINKING`, and the browser with `CHROME_BIN`.
3. **Try with new tool.** Runs `node gemma-generate.js --tools <same request>`: it continues the conversation that produced the original slide (Gemma is asked to keep exactly the same text), with every installed tool offered (`tool_choice: auto`; the prompt never names a tool). Gemma decides whether to call one; the harness runs the call and writes the returned page to `public/gemma-tool/index.html` (right). Gemma's raw tool calls, timings, and any text differences from the original slide go to `public/gemma-tool/run.json`, and the result line reports them.
4. **Test on unseen requests** (optional, after step 3; ~45 s). The new tool on the original request plus 3 unseen slide requests: for each, Gemma writes the slide alone, then again with the tool available (`public/eval/`), and both pages are measured in the browser. A table compares Gemma alone vs. Gemma + tool per request: tool called, text (all shown and identical to Gemma's own slide), in frame, no errors, each requested capability, and time. Cells show only checks that ran.

While a step runs, the action area shows its elapsed time and current stage, and the panel shows brief milestones from real output. **Details** on each panel opens the full log (requests, models, decision scores, stage times, test measurements, Gemma's tool call and the content check).

- **Refresh:** a step in progress keeps going on the server and the page reconnects to it; when nothing is running, a refresh shows a clean starting screen.
- **New run** (`POST /api/reset`) stops whatever runs, deletes everything the run generated (Gemma's slides, the tool, its output, the evaluation), and returns to step 1.
- Runs are accepted only from the page itself (same-origin JSON POST).

## Tools

A tool is two files in `tools/`; both must exist for Gemma to see it:

- `<name>.json` — OpenAI function schema (`name`, `description`, `parameters`)
- `<name>.js` — `module.exports = (args) => '<!DOCTYPE html>…'`, returning a complete page

Every tool shares one interface (`TOOL_PARAMETERS` in `server.js`): `title`, `subtitle`, and `milestones`, each one flat string `"Q1 | Theme | point | point | point"` (flat strings keep Gemma's tool-call arguments short and avoid nested-list parsing issues). Only the name, description and implementation differ; all three are generated live in step 2, so every run builds its own tool.
